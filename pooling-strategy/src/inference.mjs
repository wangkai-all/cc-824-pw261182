// inference.mjs — 基于台账已生效池结果的后验推断。
//
// 不假设样品独立：后验在“潜在事件 + 个体真值”的联合状态空间上更新。
//   - 小样本：对 enumerateJointStates 的精确联合分布做贝叶斯加权；
//   - 大样本：对先验抽样的粒子做似然再加权（序贯重要性采样），并报告有效样本量。
// 池结果的似然考虑池大小依赖的灵敏度/特异性与污染标记。

import { enumerateJointStates, sampleEventState, sampleTruth } from './risk-model.mjs';
import { positiveProb } from './assay.mjs';
import { deriveEffectiveTests } from './ledger.mjs';
import { makeRng } from './rng.mjs';

/**
 * 单个池结果在给定真值下的似然。
 * @param {object} t 生效检测记录（含 memberIds/result/contaminated）
 * @param {Record<string, boolean>} truth
 * @param {import('./assay.mjs').AssayConfig} assay
 */
export function testLikelihood(t, truth, assay) {
  const anyPositive = t.memberIds.some((id) => truth[id]);
  const pPos = positiveProb(assay, t.memberIds.length, anyPositive, t.contaminated);
  return t.result === 1 ? pPos : 1 - pPos;
}

/**
 * 精确后验（枚举法）。返回每个样品的阳性后验概率、事件后验概率与联合状态权重。
 * @param {import('./risk-model.mjs').BatchConfig} batch
 * @param {import('./assay.mjs').AssayConfig} assay
 * @param {object} ledger
 */
export function exactPosterior(batch, assay, ledger) {
  const tests = deriveEffectiveTests(ledger);
  const states = enumerateJointStates(batch);

  const weighted = states.map((st) => {
    let likelihood = 1;
    for (const t of tests) likelihood *= testLikelihood(t, st.truth, assay);
    return { ...st, weight: st.prob * likelihood };
  });
  const evidence = weighted.reduce((s, x) => s + x.weight, 0);
  if (evidence <= 0) {
    throw new Error('观测结果在当前模型下似然为 0，请检查风险/检测参数或结果更正是否互相矛盾');
  }
  for (const x of weighted) x.weight /= evidence;

  return summarize(batch, weighted, evidence, tests.length, 'exact');
}

/**
 * 粒子后验（蒙特卡洛）。先验抽样 P 个粒子，按池结果似然加权。
 * @param {import('./risk-model.mjs').BatchConfig} batch
 * @param {import('./assay.mjs').AssayConfig} assay
 * @param {object} ledger
 * @param {number} [particles=4000]
 * @param {number} [seed=12345]
 */
export function particlePosterior(batch, assay, ledger, particles = 4000, seed = 12345) {
  const tests = deriveEffectiveTests(ledger);
  const rng = makeRng(seed);
  const weighted = [];
  let evidence = 0;

  for (let i = 0; i < particles; i++) {
    const eventState = sampleEventState(batch.events, rng);
    const truth = sampleTruth(batch, eventState, rng);
    // 粒子本身已按先验抽样，重要性权重只取观测似然（SIS），不再乘先验密度
    let likelihood = 1;
    for (const t of tests) likelihood *= testLikelihood(t, truth, assay);
    evidence += likelihood;
    weighted.push({ eventState, truth, weight: likelihood });
  }
  if (evidence <= 0) {
    throw new Error('粒子似然全部为 0，观测与模型严重不一致，请检查参数或台账更正');
  }
  for (const x of weighted) x.weight /= evidence;

  return summarize(batch, weighted, evidence / particles, tests.length, 'particle', particles);
}

function summarize(batch, weighted, evidence, nTests, method, particles = null) {
  const posterior = {};
  for (const s of batch.samples) {
    posterior[s.id] = weighted.filter((x) => x.truth[s.id]).reduce((a, x) => a + x.weight, 0);
  }
  const eventPosterior = {};
  for (const e of batch.events) {
    eventPosterior[e.id] = weighted
      .filter((x) => x.eventState[e.id])
      .reduce((a, x) => a + x.weight, 0);
  }
  const ess = 1 / weighted.reduce((a, x) => a + x.weight * x.weight, 0);
  return {
    method,
    particles,
    evidence,
    ess,
    nTests,
    posterior,
    eventPosterior,
    states: weighted,
  };
}

/**
 * 自动选择推断方式：N+K 小用精确枚举，否则用粒子。
 */
export function posterior(batch, assay, ledger, opts = {}) {
  const nStates = 2 ** (batch.samples.length + batch.events.length);
  if (nStates <= (opts.enumCap ?? 4096)) return exactPosterior(batch, assay, ledger);
  return particlePosterior(batch, assay, ledger, opts.particles ?? 4000, opts.seed ?? 12345);
}

/**
 * 任意候选池在当前后验下的阳性概率（执行检测前的预测）。
 * @param {object[]} states summarize().states
 * @param {string[]} memberIds
 */
export function poolPositiveProb(states, memberIds) {
  return states
    .filter((x) => memberIds.some((id) => x.truth[id]))
    .reduce((a, x) => a + x.weight, 0);
}
