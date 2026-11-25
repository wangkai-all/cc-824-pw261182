// policy.mjs — 分池/拆检决策。
//
// 策略只根据“已得到的池结果”分支（台账中的生效记录），不偷看虚构真值。
// 两种目标：
//   - cost-min   ：最小化 期望检测费用 + λ·期望漏检数（λ = 漏检折算代价）
//   - miss-bound ：在期望漏检数 ≤ 约束 的策略中选期望检测费用最低者
// 小样本（N≤6）用全历史动态规划枚举“检测→按结果分支”的完整策略树核对最优路径；
// 大样本用一步前瞻的贪婪启发式，并由 simulation.mjs 做整批蒙特卡洛评估。

import { sensitivityAt, specificityAt, positiveProb, testCost, volumePerTest } from './assay.mjs';
import { deriveVolume, deriveEffectiveTests } from './ledger.mjs';
import { posterior } from './inference.mjs';
import { enumerateJointStates } from './risk-model.mjs';

/**
 * 枚举一个集合的所有划分（set partitions），供测试与小场景核对使用。
 * @param {any[]} items
 * @returns {any[][][]} 每个元素是一种划分（若干池，每池是成员数组）
 */
export function allPartitions(items) {
  if (items.length === 0) return [[]];
  const [first, ...rest] = items;
  const sub = allPartitions(rest);
  const out = [];
  for (const partition of sub) {
    for (let i = 0; i < partition.length; i++) {
      const next = partition.map((block, j) => (j === i ? [first, ...block] : block));
      out.push(next);
    }
    out.push([[first], ...partition]);
  }
  return out;
}

/** 当前可继续参与检测的样品（剩余样量够一次等分样） */
export function availableSamples(batch, ledger, assay) {
  const { remaining } = deriveVolume(ledger);
  const aliquot = volumePerTest(assay);
  return batch.samples.filter((s) => remaining[s.id] >= aliquot);
}

/** 每个样品参与过的检测轮次与最近一次池结果 */
export function testedHistory(ledger) {
  const tests = deriveEffectiveTests(ledger);
  const bySample = {};
  for (const t of tests) {
    for (const id of t.memberIds) {
      bySample[id] = bySample[id] || { rounds: 0, lastPoolResult: null };
      bySample[id].rounds += 1;
      bySample[id].lastPoolResult = t.result;
    }
  }
  return bySample;
}

/**
 * 一步前瞻推荐（网页“查看下一步”使用）。
 * @returns {{recommendation: object, bestScore: number, posterior: object, candidates: object[], note?: string}}
 */
export function recommendNext(batch, assay, ledger, opts = {}) {
  const lambda = opts.lambda ?? assay.falseNegativePenalty;
  const post = posterior(batch, assay, ledger, opts);
  const avail = availableSamples(batch, ledger, assay);

  const expectedResidual = batch.samples.reduce(
    (a, s) => a + (post.posterior[s.id] ?? 0),
    0,
  );
  const candidates = [
    { action: { kind: 'stop' }, expectedCost: lambda * expectedResidual, detail: { expectedResidual } },
  ];

  if (avail.length === 0) {
    return {
      ...pickBest(candidates),
      posterior: post,
      candidates,
      note: '所有样品剩余样量均不足以再检测，只能终止；终止时的期望漏检见费用项',
    };
  }

  const plans = candidatePlans(avail.map((s) => s.id), assay, post, ledger);
  const { remaining } = deriveVolume(ledger);
  for (const pools of plans) {
    if (pools.length > assay.maxParallelPools) continue;
    const evalResult = evaluateTwoStage(post.states, pools, assay, remaining, lambda);
    candidates.push({
      action: { kind: 'test', pools },
      expectedCost: evalResult.expectedCost,
      detail: {
        runCost: evalResult.runCost,
        expectedFollowupCost: evalResult.expectedFollowupCost,
        expectedResidualAfter: evalResult.expectedMisses,
      },
    });
  }

  return { ...pickBest(candidates), posterior: post, candidates };
}

/**
 * 两阶段（Dorfman 式）方案评估：本轮池检后，阳性池的成员在下一轮做单样品拆检。
 * 在后验联合状态上逐状态计算——不假设样品独立，相关性由 states 的权重天然携带。
 *
 * 对每个联合状态（含虚构真值）与每个池：
 *   池检为阳（概率 pPos）→ 对可拆检成员逐个单检，阳性成员以 (1-Se1) 概率漏检；
 *   池检为阴（概率 1-pPos）→ 池内阳性成员被整体漏掉（阴性池不拆检）。
 * 样量不足的成员无法拆检，池阳时也计为漏检。
 *
 * @returns {{runCost: number, expectedFollowupCost: number, expectedMisses: number, expectedCost: number}}
 */
export function evaluateTwoStage(states, pools, assay, remainingVolumes, lambda) {
  const aliquot = volumePerTest(assay);
  const se1 = sensitivityAt(assay, 1);
  const runCost = pools.reduce((a, p) => a + testCost(assay, p.length), 0);
  let expectedFollowupCost = 0;
  let expectedMisses = 0;

  for (const st of states) {
    const w = st.weight;
    const inPools = new Set(pools.flat());
    for (const pool of pools) {
      const k = pool.length;
      const anyPos = pool.some((id) => st.truth[id]);
      const pPos = positiveProb(assay, k, anyPos, false); // 该状态下池检为阳的概率
      const followable = pool.filter((id) => remainingVolumes[id] >= aliquot);

      if (k === 1) {
        // 单样品检测即终局确认：无后续拆检费用；阳性成员以 (1-Se1) 假阴性漏检
        const id = pool[0];
        if (st.truth[id]) {
          expectedMisses += w * (remainingVolumes[id] >= aliquot ? 1 - se1 : 1);
        }
        continue;
      }

      // 多成员池：阳性池结果 → 对可拆检成员下一轮逐个单检
      expectedFollowupCost += w * pPos * followable.length * testCost(assay, 1);
      for (const id of pool) {
        if (!st.truth[id]) continue;
        const canFollow = remainingVolumes[id] >= aliquot;
        if (!canFollow) {
          // 无样拆检：无论池结果如何都无法确认 → 必漏
          expectedMisses += w;
        } else {
          // 池阳（pPos）后单检漏检 (1-Se1)；池阴 (1-pPos) 整体漏检
          expectedMisses += w * (pPos * (1 - se1) + (1 - pPos));
        }
      }
    }
    // 不在任何本轮池中的阳性样品：维持后验期望，终止即漏
    for (const id of Object.keys(st.truth)) {
      if (!inPools.has(id) && st.truth[id]) expectedMisses += w;
    }
  }

  return {
    runCost,
    expectedFollowupCost,
    expectedMisses,
    expectedCost: runCost + expectedFollowupCost + lambda * expectedMisses,
  };
}

function pickBest(candidates) {
  let best = candidates[0];
  for (const c of candidates) if (c.expectedCost < best.expectedCost) best = c;
  return { recommendation: best.action, bestScore: best.expectedCost };
}

/**
 * 构造有限个合规的单轮候选分池：
 *   1. 可测样品按后验风险降序，在池大小网格上定长切分；
 *   2. 对最近一个阳性池给 全单检 / 二分拆检 / 整体复测 三种方案。
 */
export function candidatePlans(availIds, assay, post, ledger) {
  const maxK = Math.min(assay.maxPoolSize, availIds.length);
  const sizeGrid = [...new Set([1, 2, 3, 4, 6, 8].filter((k) => k <= maxK))];
  const plans = [];
  const seen = new Set();
  const push = (pools) => {
    const key = JSON.stringify(pools.map((p) => [...p].sort()).sort());
    if (!seen.has(key)) {
      seen.add(key);
      plans.push(pools);
    }
  };

  const sorted = availIds.slice().sort((a, b) => (post.posterior[b] ?? 0) - (post.posterior[a] ?? 0));
  for (const k of sizeGrid) push(chunk(sorted, k));

  const tests = deriveEffectiveTests(ledger);
  const positivePools = tests.filter((t) => t.result === 1);
  if (positivePools.length > 0) {
    const target = positivePools[positivePools.length - 1];
    const members = target.memberIds.filter((id) => availIds.includes(id));
    if (members.length > 1) {
      push(members.map((id) => [id]));
      const half = Math.ceil(members.length / 2);
      push([members.slice(0, half), members.slice(half)]);
      push([members]);
    }
  }
  return plans.filter((pools) => pools.every((p) => p.length >= 1 && p.length <= assay.maxPoolSize));
}

function chunk(arr, k) {
  const out = [];
  for (let i = 0; i < arr.length; i += k) out.push(arr.slice(i, i + k));
  return out;
}

/**
 * 小样本精确动态规划。
 *
 * 联合状态空间上枚举“选一个池检测 → 按阴/阳结果分支”的完整策略树；
 * 每个节点同时计算：
 *   expectedSpend  期望检测费用
 *   expectedMisses 终止时期望漏检数（受灵敏度<1 影响，即使全部单检也可能 >0）
 * 于是：
 *   - 费用最小目标：最小化 expectedSpend + λ·expectedMisses
 *   - 漏检受限目标：在 expectedMisses ≤ missBound 的节点中选 expectedSpend 最小
 *
 * 样量约束通过每样品检测次数上限 floor(initialVolume / aliquot) 强制。
 *
 * @param {import('./risk-model.mjs').BatchConfig} batch
 * @param {import('./assay.mjs').AssayConfig} assay
 * @param {object} [opts]
 * @param {number} [opts.maxDepth=4]
 * @param {number} [opts.lambda]
 * @param {number} [opts.missBound] 期望漏检数上限（绝对数，如 0.2）
 */
export function exactOptimalPolicy(batch, assay, opts = {}) {
  const maxDepth = opts.maxDepth ?? 4;
  const lambda = opts.lambda ?? assay.falseNegativePenalty;
  const missBound = opts.missBound ?? null;
  const ids = batch.samples.map((s) => s.id);
  if (ids.length > 6) throw new Error('精确枚举仅支持 N<=6 的小样本核对场景');

  const joint = enumerateJointStates(batch);
  const aliquot = volumePerTest(assay);
  const maxRunsPerSample = Object.fromEntries(
    batch.samples.map((s) => [s.id, Math.floor(s.initialVolume / aliquot)]),
  );
  const subsets = nonEmptySubsets(ids).filter((p) => p.length <= assay.maxPoolSize);
  const costMemo = new Map();
  const boundMemo = new Map();
  const minMemo = new Map();
  // 费用最小目标：最小化 expectedSpend + λ·expectedMisses
  function dpCost(obs, runs, belief, depth) {
    const key = obsKey(obs) + '|r:' + ids.map((id) => runs[id]).join(',') + '|d:' + depth;
    const cached = costMemo.get(key);
    if (cached) return cached;

    const expectedPositives = belief.reduce(
      (a, b) => a + b.w * countPos(b.state.truth, ids),
      0,
    );
    let best = {
      action: { kind: 'stop' },
      expectedSpend: 0,
      expectedMisses: expectedPositives,
      expectedCost: lambda * expectedPositives,
      branches: null,
    };

    if (depth < maxDepth) {
      for (const pool of feasiblePools(runs)) {
        const { pResult, nextRuns, nextBelief, cost } = branchOutcomes(pool, runs, belief);
        const branches = {};
        let expSpend = cost;
        let expMiss = 0;
        for (const r of [0, 1]) {
          if (pResult[r] <= 1e-12) continue;
          const child = dpCost(
            [...obs, { pool: [...pool].sort(), result: r }],
            nextRuns,
            nextBelief[r],
            depth + 1,
          );
          branches[r] = child;
          expSpend += pResult[r] * child.expectedSpend;
          expMiss += pResult[r] * child.expectedMisses;
        }
        const node = makeNode(pool, branches, pResult, cost, expSpend, expMiss);
        if (node.expectedCost < best.expectedCost) best = node;
      }
    }
    costMemo.set(key, best);
    return best;
  }

  // 给定信念/样量/剩余深度下，不考虑费用时可达到的最小条件期望漏检。
  //
  // 递归结构与 dpBound 同构（仅最小化漏检）：
  //   非叶子 = min(停止, 候选池检测后按结果分支的加权最小漏检)；
  //   叶子（最后一个可用深度）= 在该层执行一次最优检测后的期望漏检，
  //     即对每个联合状态按检测灵敏度计算假阴性——这是漏检真正下降的地方。
  function minMiss(obs, runs, belief, depth) {
    const key = 'M:' + obsKey(obs) + '|r:' + ids.map((id) => runs[id]).join(',') + '|d:' + depth;
    const cached = minMemo.get(key);
    if (cached !== undefined) return cached;
    const expectedPositives = belief.reduce(
      (a, b) => a + b.w * countPos(b.state.truth, ids),
      0,
    );
    let best = expectedPositives;
    if (depth < maxDepth) {
      for (const pool of feasiblePools(runs)) {
        const { pResult, nextRuns, nextBelief } = branchOutcomes(pool, runs, belief);
        let val = 0;
        for (const r of [0, 1]) {
          if (pResult[r] <= 1e-12) continue;
          // depth+1 === maxDepth：下一层是最后一次检测机会，用 leafMiss 计假阴性
          const child =
            depth + 1 === maxDepth
              ? leafMiss(nextBelief[r], nextRuns)
              : minMiss(
                  [...obs, { pool: [...pool].sort(), result: r }],
                  nextRuns,
                  nextBelief[r],
                  depth + 1,
                );
          val += pResult[r] * child;
        }
        best = Math.min(best, val);
      }
    }
    minMemo.set(key, best);
    return best;
  }

  // 叶子层：对每个仍可检测的阳性样品执行一次单样品检测（灵敏度最高），
  // 漏检 = 假阴性概率；无样可测的阳性样品必漏。
  function leafMiss(belief, runs) {
    const se1 = sensitivityAt(assay, 1);
    let total = 0;
    for (const b of belief) {
      let stateMiss = 0;
      for (const id of ids) {
        if (!b.state.truth[id]) continue;
        const canTest = runs[id] < maxRunsPerSample[id];
        stateMiss += canTest ? 1 - se1 : 1;
      }
      total += b.w * stateMiss;
    }
    return total;
  }

  // 漏检受限目标：在“本节点期望漏检 ≤ budget”的策略中选期望检测费最低。
  //
  // 标准约束动态规划。对候选池 p，两分支 r 的条件最小漏检 m_r 由 minMiss 给出
  // （含叶子层检测的假阴性）。节点可达的最小总漏检 = Σ p_r·m_r。
  // 若该值 ≤ budget，则池 p 可行：给每个分支分配条件预算 b_r，
  //   要求 Σ p_r·b_r ≤ budget 且 b_r ≥ m_r；子递归在 b_r 下求最小费用。
  // 预算网格扫描阳分支的 slack 占比，费用最小选择会自动落在最省的分配上。
  function dpBound(obs, runs, belief, depth, budget) {
    const key =
      obsKey(obs) + '|r:' + ids.map((id) => runs[id]).join(',') + '|d:' + depth + '|b:' + budget.toFixed(6);
    const cached = boundMemo.get(key);
    if (cached) return cached;

    const expectedPositives = belief.reduce(
      (a, b) => a + b.w * countPos(b.state.truth, ids),
      0,
    );
    let best = null;
    if (expectedPositives <= budget + 1e-9) {
      best = {
        action: { kind: 'stop' },
        expectedSpend: 0,
        expectedMisses: expectedPositives,
        expectedCost: lambda * expectedPositives,
        branches: null,
      };
    }

    if (depth < maxDepth) {
      for (const pool of feasiblePools(runs)) {
        const { pResult, nextRuns, nextBelief, cost } = branchOutcomes(pool, runs, belief);
        const active = [0, 1].filter((r) => pResult[r] > 1e-12);
        const floorMiss = [0, 0];
        for (const r of active) {
          floorMiss[r] = minMiss(
            [...obs, { pool: [...pool].sort(), result: r }],
            nextRuns,
            nextBelief[r],
            depth + 1,
          );
        }
        const weightedFloor = active.reduce((a, r) => a + pResult[r] * floorMiss[r], 0);
        if (weightedFloor > budget + 1e-9) continue;

        // 最后一个可用深度（depth+1 === maxDepth）：叶子层执行检测，用 leafMiss 算漏检，不再下递归
        if (depth + 1 === maxDepth) {
          const leafMisses = active.map((r) => leafMiss(nextBelief[r], nextRuns));
          const expMiss = active.reduce((a, r) => a + pResult[r] * leafMisses[r], 0);
          if (expMiss > budget + 1e-9) continue;
          const node = {
            action: { kind: 'test', pool: [...pool].sort() },
            expectedSpend: cost,
            expectedMisses: expMiss,
            expectedCost: cost + lambda * expMiss,
            branches: null,
            branchProbs: { 0: pResult[0], 1: pResult[1] },
            spend: cost,
          };
          if (best === null || node.expectedSpend < best.expectedSpend) best = node;
          continue;
        }

        const slack = budget - weightedFloor;

        const fractions = active.length === 2 ? [0, 0.5, 1] : [1];
        for (const frac of fractions) {
          const branchBudget = [0, 0];
          if (active.length === 2) {
            const [r0, r1] = active;
            branchBudget[r1] = floorMiss[r1] + (frac * slack) / pResult[r1];
            branchBudget[r0] = floorMiss[r0] + ((1 - frac) * slack) / pResult[r0];
          } else {
            // 单分支：节点期望漏检 = p_r·条件漏检，条件预算 = budget / p_r，
            // 且不低于该分支的可达下界 floorMiss
            const r = active[0];
            branchBudget[r] = Math.max(floorMiss[r], budget / pResult[r]);
          }
          const bs = {};
          let expSpend = cost;
          let expMiss = 0;
          let ok = true;
          for (const r of active) {
            // 下一层即叶子：直接用 leafMiss 构造终局子节点，不再递归
            if (depth + 1 === maxDepth - 1) {
              const lm = leafMiss(nextBelief[r], nextRuns);
              if (lm > branchBudget[r] + 1e-9) {
                ok = false;
                break;
              }
              bs[r] = {
                action: { kind: 'test', pool: [...pool].sort() },
                expectedSpend: 0,
                expectedMisses: lm,
                expectedCost: lambda * lm,
                branches: null,
              };
              expMiss += pResult[r] * lm;
              continue;
            }
            const child = dpBound(
              [...obs, { pool: [...pool].sort(), result: r }],
              nextRuns,
              nextBelief[r],
              depth + 1,
              branchBudget[r],
            );
            if (!child) {
              ok = false;
              break;
            }
            bs[r] = child;
            expSpend += pResult[r] * child.expectedSpend;
            expMiss += pResult[r] * child.expectedMisses;
          }
          if (!ok || expMiss > budget + 1e-9) continue;
          const node = makeNode(pool, bs, pResult, cost, expSpend, expMiss);
          if (best === null || node.expectedSpend < best.expectedSpend) best = node;
        }
      }
    }
    if (best !== null) boundMemo.set(key, best);
    return best;
  }

  function feasiblePools(runs) {
    return subsets.filter((pool) => pool.every((id) => runs[id] < maxRunsPerSample[id]));
  }

  function branchOutcomes(pool, runs, belief) {
    const k = pool.length;
    const cost = testCost(assay, k);
    const se = sensitivityAt(assay, k);
    const sp = specificityAt(assay, k, false);
    const pResult = [0, 0];
    for (const b of belief) {
      const anyPos = pool.some((id) => b.state.truth[id]);
      const pPos = anyPos ? se : 1 - sp;
      pResult[1] += b.w * pPos;
      pResult[0] += b.w * (1 - pPos);
    }
    const nextRuns = { ...runs };
    for (const id of pool) nextRuns[id] += 1;
    const nextBelief = [[], []];
    for (const r of [0, 1]) {
      if (pResult[r] <= 1e-12) continue;
      for (const b of belief) {
        const anyPos = pool.some((id) => b.state.truth[id]);
        const lik = r === 1 ? (anyPos ? se : 1 - sp) : anyPos ? 1 - se : sp;
        nextBelief[r].push({ state: b.state, w: (b.w * lik) / pResult[r] });
      }
    }
    return { pResult, nextRuns, nextBelief, cost };
  }

  function makeNode(pool, branches, pResult, cost, expSpend, expMiss) {
    return {
      action: { kind: 'test', pool: [...pool].sort() },
      expectedSpend: expSpend,
      expectedMisses: expMiss,
      expectedCost: expSpend + lambda * expMiss,
      branches,
      branchProbs: { 0: pResult[0], 1: pResult[1] },
      spend: cost,
    };
  }

  const initBelief = joint.map((state) => ({ state, w: state.prob }));
  const initRuns = Object.fromEntries(ids.map((id) => [id, 0]));
  const costRoot = dpCost([], initRuns, initBelief, 0);
  const boundRoot = missBound === null ? null : dpBound([], initRuns, initBelief, 0, missBound);

  return {
    costMinTree: costRoot,
    // 约束可达时给出最小费用受限树；受深度/样量限制不可达时为 null
    missBoundTree: boundRoot,
    boundFeasible: boundRoot !== null,
    statesVisited: costMemo.size + boundMemo.size + minMemo.size,
    nSamples: ids.length,
    lambda,
    missBound,
    note: '精确枚举结果仅在给定风险与检测参数假设下成立，不构成对发现全部阳性的保证',
  };
}

function nonEmptySubsets(items) {
  const out = [];
  for (let mask = 1; mask < 1 << items.length; mask++) {
    out.push(items.filter((_, j) => (mask >> j) & 1));
  }
  return out;
}

function countPos(truth, ids) {
  return ids.reduce((a, id) => a + (truth[id] ? 1 : 0), 0);
}

function obsKey(obs) {
  return obs
    .map((o) => `${o.pool.join('|')}->${o.result}`)
    .sort()
    .join(';;');
}
