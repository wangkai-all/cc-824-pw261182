// simulation.mjs — 冻结方案的完整批次蒙特卡洛评估。
//
// 流程（每个虚构批次）：
//   1. 按风险模型抽样潜在事件状态与样品真值；
//   2. 按指定策略逐轮决定分池/拆检，检测结果由 assay 模型抽样（含可选污染轮）；
//   3. 每轮检测写入独立台账，样量不足的样品自动退出候选；
//   4. 策略终止后，对照真值统计费用、漏检、误报、样量耗尽次数。
// 策略只通过台账观测结果，真值仅用于抽样检测与最终评分。

import { sampleEventState, sampleTruth, sensitivityScenarios } from './risk-model.mjs';
import { simulateTest } from './assay.mjs';
import {
  createLedger,
  recordTest,
  recordContamination,
  deriveSpend,
  deriveVolume,
  deriveEffectiveTests,
  audit,
} from './ledger.mjs';
import { recommendNext } from './policy.mjs';
import { makeRng } from './rng.mjs';

/**
 * 自适应策略：每轮调用 recommendNext，直至 stop 或无样可用。
 * @param {object} args
 * @param {import('./risk-model.mjs').BatchConfig} args.batch
 * @param {import('./assay.mjs').AssayConfig} args.assay
 * @param {() => number} args.rng
 * @param {Record<string, boolean>} args.truth
 * @param {object} [args.policyOpts]
 * @param {number} [args.contaminationProb=0] 每轮发生实验台污染的概率
 * @param {number} [args.maxRounds=10]
 */
export function runAdaptiveBatch({
  batch,
  assay,
  rng,
  truth,
  policyOpts = {},
  contaminationProb = 0,
  maxRounds = 10,
}) {
  const ledger = createLedger(
    assay,
    batch.samples.map((s) => ({ id: s.id, initialVolume: s.initialVolume })),
  );
  const trace = [];
  // 大样本自适应模拟用粒子后验（精确枚举仅用于小样本核对），控制单轮开销
  const inferOpts = {
    enumCap: policyOpts.enumCap ?? 1024,
    particles: policyOpts.particles ?? 1200,
    ...policyOpts,
  };

  for (let round = 1; round <= maxRounds; round++) {
    const rec = recommendNext(batch, assay, ledger, inferOpts);
    if (rec.recommendation.kind === 'stop') {
      trace.push({ round, action: 'stop', detail: rec.candidates[0]?.detail ?? null });
      break;
    }
    const contaminated = rng() < contaminationProb;
    if (contaminated) recordContamination(ledger, { round, note: '模拟实验台污染' });

    for (const pool of rec.recommendation.pools) {
      const anyPositive = pool.some((id) => truth[id]);
      const result = simulateTest(rng, assay, pool.length, anyPositive, contaminated);
      try {
        recordTest(ledger, {
          poolId: `R${round}-P${trace.length + 1}`,
          round,
          memberIds: pool,
          result,
          contaminated,
        });
      } catch (err) {
        // 样量不足等约束冲突：记录为终止原因，避免静默丢样
        trace.push({ round, action: 'abort', reason: err.message });
        return finish(ledger, truth, batch, trace, true);
      }
    }
    trace.push({ round, action: 'test', pools: rec.recommendation.pools });
  }

  return finish(ledger, truth, batch, trace, false);
}

function finish(ledger, truth, batch, trace, aborted) {
  const tests = deriveEffectiveTests(ledger);
  const { remaining, used } = deriveVolume(ledger);
  const positiveSamples = batch.samples.filter((s) => truth[s.id]).map((s) => s.id);

  // 判定规则：样品在任一单样品检测（池大小 1）中结果为阳 → 判阳；
  // 从未被单检确认的阳性样品计为漏检。
  const confirmedPositive = new Set();
  let falsePositiveSingles = 0;
  let singleTestsOnNegatives = 0;
  for (const t of tests) {
    if (t.memberIds.length === 1) {
      const id = t.memberIds[0];
      if (t.result === 1) confirmedPositive.add(id);
      if (!truth[id]) singleTestsOnNegatives += 1;
      if (t.result === 1 && !truth[id]) falsePositiveSingles += 1;
    }
  }
  const missed = positiveSamples.filter((id) => !confirmedPositive.has(id));
  const exhausted = batch.samples.filter((s) => remaining[s.id] < assay_minAliquot(ledger)).map((s) => s.id);
  const auditResult = audit(ledger);

  return {
    trace,
    aborted,
    spend: deriveSpend(ledger),
    nTests: tests.length,
    nRounds: new Set(tests.map((t) => t.round)).size,
    truePositives: positiveSamples.length,
    confirmedPositives: [...confirmedPositive],
    missed,
    falsePositiveSingles,
    singleTestsOnNegatives,
    exhaustedSamples: exhausted,
    remaining,
    used,
    ledger,
    audit: auditResult,
  };
}

function assay_minAliquot(ledger) {
  return ledger.assay.aliquotVolume;
}

/**
 * 蒙特卡洛评估两种目标策略并对比。
 * @returns {{costMin: Aggregate, missBound: Aggregate, replications: number}}
 */
export function evaluateStrategies(batch, assay, opts = {}) {
  const replications = opts.replications ?? 500;
  const seed = opts.seed ?? 20261125;
  const contaminationProb = opts.contaminationProb ?? 0;
  const missBound = opts.missBound ?? 0.15; // 期望漏检“数”上限（演示默认 0.15 个/批）
  const rng = makeRng(seed);

  const runs = { costMin: [], missBound: [] };
  for (let i = 0; i < replications; i++) {
    const eventState = sampleEventState(batch.events, rng);
    const truth = sampleTruth(batch, eventState, rng);

    runs.costMin.push(
      runAdaptiveBatch({
        batch,
        assay,
        rng,
        truth,
        contaminationProb,
        policyOpts: { lambda: assay.falseNegativePenalty },
      }),
    );
    // 漏检受限：用更高的漏检惩罚 λ 驱动策略偏向多拆检（启发式实现；
    // 精确约束解见 policy.exactOptimalPolicy 的 missBound 树）
    runs.missBound.push(
      runAdaptiveBatch({
        batch,
        assay,
        rng,
        truth,
        contaminationProb,
        policyOpts: { lambda: assay.falseNegativePenalty * 5, missBound },
      }),
    );
  }
  return {
    costMin: aggregate(runs.costMin, batch),
    missBound: aggregate(runs.missBound, batch),
    replications,
    seed,
    note: '蒙特卡洛指标依赖风险假设与检测参数；参数缺乏证据时请同时查看敏感性范围，结果不保证发现全部阳性',
  };
}

/**
 * @typedef {Object} Aggregate
 * @property {number} meanSpend
 * @property {number} p95Spend
 * @property {number} meanTests
 * @property {number} missRate       漏检数 / 真实阳性数（无阳性批次按 0 计）
 * @property {number} missPerBatch   每批平均漏检个数
 * @property {number} falsePositiveRate
 * @property {number} exhaustionRate 样量耗尽样品占比
 * @property {number} abortRate
 */
function aggregate(runs, batch) {
  const n = runs.length;
  const spends = runs.map((r) => r.spend).sort((a, b) => a - b);
  const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const totalTrue = runs.reduce((a, r) => a + r.truePositives, 0);
  const totalMissed = runs.reduce((a, r) => a + r.missed.length, 0);
  const totalNegSingles = runs.reduce((a, r) => a + r.singleTestsOnNegatives, 0);
  const totalFP = runs.reduce((a, r) => a + r.falsePositiveSingles, 0);
  const totalExhausted = runs.reduce((a, r) => a + r.exhaustedSamples.length, 0);
  return {
    meanSpend: mean(spends),
    p95Spend: spends[Math.floor(0.95 * (n - 1))],
    meanTests: mean(runs.map((r) => r.nTests)),
    missRate: totalTrue > 0 ? totalMissed / totalTrue : 0,
    missPerBatch: totalMissed / n,
    falsePositiveRate: totalNegSingles > 0 ? totalFP / totalNegSingles : 0,
    exhaustionRate: totalExhausted / (n * batch.samples.length),
    abortRate: runs.filter((r) => r.aborted).length / n,
  };
}

/**
 * 敏感性分析：在风险参数的多个情景下重复评估，返回指标区间。
 * @param {import('./risk-model.mjs').BatchConfig} batch
 * @param {import('./assay.mjs').AssayConfig} assay
 * @param {object} [opts]
 */
export function sensitivityAnalysis(batch, assay, opts = {}) {
  const scenarios = sensitivityScenarios(
    batch,
    opts.riskMultipliers ?? [0.5, 1, 2],
    opts.eventMultipliers ?? [0.5, 1, 2],
  );
  const rows = scenarios.map((sc) => ({
    label: sc.label,
    ...evaluateStrategies(sc.batch, assay, {
      ...opts,
      seed: (opts.seed ?? 20261125) + hashString(sc.label),
    }),
  }));
  const range = (key) => {
    const vals = rows.map((r) => r.costMin[key]).filter((v) => Number.isFinite(v));
    return { min: Math.min(...vals), max: Math.max(...vals) };
  };
  return {
    rows,
    costMinRanges: {
      meanSpend: range('meanSpend'),
      missRate: range('missRate'),
      missPerBatch: range('missPerBatch'),
      exhaustionRate: range('exhaustionRate'),
    },
    disclaimer:
      '区间宽度反映风险假设的证据不足；任何情景下系统都不宣称保证发现所有异常样品',
  };
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 100000;
}
