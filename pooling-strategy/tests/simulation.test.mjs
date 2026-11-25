// tests/simulation.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAdaptiveBatch, evaluateStrategies, sensitivityAnalysis } from '../src/simulation.mjs';
import { sampleEventState, sampleTruth } from '../src/risk-model.mjs';
import { makeRng } from '../src/rng.mjs';
import { defaultAssay, demoBatch, demoSmallBatch } from '../data/demo-data.mjs';

test('单次自适应批次：台账审计通过、费用为正、样量不出现负值', () => {
  const batch = demoBatch();
  const assay = defaultAssay();
  const rng = makeRng(123);
  const truth = sampleTruth(batch, sampleEventState(batch.events, rng), rng);
  const out = runAdaptiveBatch({ batch, assay, rng, truth, maxRounds: 6 });
  assert.equal(out.audit.ok, true, JSON.stringify(out.audit.errors));
  assert.ok(out.spend > 0);
  for (const id of Object.keys(out.remaining)) assert.ok(out.remaining[id] >= 0);
});

test('高污染概率下仍能跑完且指标有界', () => {
  const batch = demoBatch();
  const assay = defaultAssay();
  const rng = makeRng(456);
  const truth = sampleTruth(batch, sampleEventState(batch.events, rng), rng);
  const out = runAdaptiveBatch({
    batch,
    assay,
    rng,
    truth,
    contaminationProb: 0.5,
    maxRounds: 6,
  });
  assert.equal(out.audit.ok, true);
  assert.ok(out.falsePositiveSingles >= 0);
});

test('evaluateStrategies: 两策略指标齐全且数值在合法区间', () => {
  const batch = demoBatch();
  const assay = defaultAssay();
  const res = evaluateStrategies(batch, assay, { replications: 40, particles: 600 });
  for (const key of ['costMin', 'missBound']) {
    const a = res[key];
    assert.ok(a.meanSpend > 0);
    assert.ok(a.missRate >= 0 && a.missRate <= 1);
    assert.ok(a.falsePositiveRate >= 0 && a.falsePositiveRate <= 1);
    assert.ok(a.exhaustionRate >= 0 && a.exhaustionRate <= 1);
    assert.ok(a.abortRate >= 0 && a.abortRate <= 1);
    assert.ok(a.p95Spend >= a.meanSpend - 1e-9);
  }
});

test('漏检受限策略的漏检率不高于费用最小策略（统计趋势，容差内）', () => {
  const batch = demoBatch();
  const assay = defaultAssay();
  const res = evaluateStrategies(batch, assay, { replications: 80, particles: 600 });
  // 启发式用 5 倍 λ 驱动多拆检：允许 0.03 的蒙特卡洛噪声容差
  assert.ok(
    res.missBound.missRate <= res.costMin.missRate + 0.03,
    `bound=${res.missBound.missRate}, min=${res.costMin.missRate}`,
  );
  // 漏检受限通常花费更多（同样给容差）
  assert.ok(res.missBound.meanSpend >= res.costMin.meanSpend * 0.9);
});

test('sensitivityAnalysis: 返回 9 个情景与区间，且附带免责声明', () => {
  const batch = demoSmallBatch();
  const assay = defaultAssay();
  const sa = sensitivityAnalysis(batch, assay, { replications: 20, particles: 500 });
  assert.equal(sa.rows.length, 9);
  assert.ok(sa.costMinRanges.meanSpend.max >= sa.costMinRanges.meanSpend.min);
  assert.match(sa.disclaimer, /不宣称/);
});
