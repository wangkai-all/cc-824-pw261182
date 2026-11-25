// risk-model.mjs — 样品风险模型。
//
// 关键设计：同批样品的风险可以相关，不套用独立同分布的固定公式。
// 采用“潜在批次事件 + 个体条件风险”的结构：
//   每个批次可挂多个潜在事件（如共同污染源、采样班次），事件以概率 pi 发生；
//   事件发生后，关联样品的条件阳性概率从基线 pi_i 提升到 lift 后的水平。
//   事件之间相互独立；未发生任何关联事件时，样品以基线概率独立阳性。
//
// 该结构同时支持：
//   - 小样本：枚举全部 2^(N+K) 种状态，得到精确联合分布（供枚举核对最优路径）；
//   - 大样本：按模型抽样做蒙特卡洛（供整批评估与敏感性分析）。

/**
 * @typedef {Object} Sample
 * @property {string} id            样品编号
 * @property {number} baseRisk      基线阳性概率（无关联事件发生时），[0,1]
 * @property {string[]} events      关联的潜在事件 id 列表
 * @property {number} initialVolume 初始可用样量（任意一致单位，如 μL）
 */

/**
 * @typedef {Object} LatentEvent
 * @property {string} id
 * @property {number} probability   事件发生概率 pi
 * @property {number} lift          事件发生时，关联样品的条件阳性概率（0..1）
 */

/**
 * @typedef {Object} BatchConfig
 * @property {Sample[]} samples
 * @property {LatentEvent[]} events
 */

/**
 * 计算条件阳性概率（带事件参数表）。
 * 任一关联事件发生即取“提升后风险”，多事件取最大 lift（保守上界）。
 * @param {Sample} s
 * @param {Record<string, boolean>} eventState
 * @param {Record<string, LatentEvent>} eventMap
 */
export function condP(s, eventState, eventMap) {
  let p = s.baseRisk;
  for (const eid of s.events) {
    if (eventState[eid]) {
      p = Math.max(p, eventMap[eid].lift);
    }
  }
  return p;
}

/**
 * 样品边际阳性概率（对潜在事件边缘化后的结果）。
 * 对独立事件：P(阳性) = 1 - Π组合 (1 - p|e)·P(e)，这里用条件事件概率直接展开：
 * P(阳性) = Σ_eventState P(eventState) · [1 - Π_i? …]
 * 单样品只关心自身关联事件：P(阳性)=1-Σ P(事件组合)·(1-p|组合)。
 * @param {Sample} s
 * @param {LatentEvent[]} events
 */
export function marginalRisk(s, events) {
  const related = events.filter((e) => s.events.includes(e.id));
  const eventMap = Object.fromEntries(events.map((e) => [e.id, e]));
  // 枚举关联事件的 2^k 种发生组合
  let negativeProb = 0;
  for (let mask = 0; mask < 1 << related.length; mask++) {
    const state = {};
    let stateProb = 1;
    related.forEach((e, j) => {
      const on = ((mask >> j) & 1) === 1;
      state[e.id] = on;
      stateProb *= on ? e.probability : 1 - e.probability;
    });
    const p = condP(s, state, eventMap);
    negativeProb += stateProb * (1 - p);
  }
  return 1 - negativeProb;
}

/**
 * 抽样一组合格的潜在事件状态。
 * @param {LatentEvent[]} events
 * @param {() => number} rng
 * @returns {Record<string, boolean>}
 */
export function sampleEventState(events, rng) {
  const state = {};
  for (const e of events) state[e.id] = rng() < e.probability;
  return state;
}

/**
 * 在给定事件状态下抽样一批样品的真实阳性状态（虚构真值，仅用于模拟）。
 * @param {BatchConfig} batch
 * @param {Record<string, boolean>} eventState
 * @param {() => number} rng
 * @returns {Record<string, boolean>} sampleId -> 真实是否阳性
 */
export function sampleTruth(batch, eventState, rng) {
  const eventMap = Object.fromEntries(batch.events.map((e) => [e.id, e]));
  const truth = {};
  for (const s of batch.samples) {
    truth[s.id] = rng() < condP(s, eventState, eventMap);
  }
  return truth;
}

/**
 * 枚举整批样品的精确联合分布（小样本用）。
 * 返回 [{ eventState, truth, prob }]，prob 之和为 1（浮点误差内）。
 *
 * 复杂度 O(2^K · 2^N)，仅适用于 N+K 较小的场景（建议 N<=8、K<=3）。
 * @param {BatchConfig} batch
 * @param {number} [cap=4096] 状态数保护上限
 */
export function enumerateJointStates(batch, cap = 4096) {
  const { samples, events } = batch;
  const nStates = 2 ** (events.length + samples.length);
  if (nStates > cap) {
    throw new Error(
      `联合状态数 ${nStates} 超过枚举上限 ${cap}（N=${samples.length}, K=${events.length}）；请改用蒙特卡洛。`,
    );
  }
  const eventMap = Object.fromEntries(events.map((e) => [e.id, e]));
  const out = [];
  const K = events.length;
  const N = samples.length;

  for (let em = 0; em < 1 << K; em++) {
    const eventState = {};
    let eProb = 1;
    events.forEach((e, j) => {
      const on = ((em >> j) & 1) === 1;
      eventState[e.id] = on;
      eProb *= on ? e.probability : 1 - e.probability;
    });
    const condProbs = samples.map((s) => condP(s, eventState, eventMap));

    for (let tm = 0; tm < 1 << N; tm++) {
      const truth = {};
      let tProb = 1;
      samples.forEach((s, j) => {
        const pos = ((tm >> j) & 1) === 1;
        truth[s.id] = pos;
        tProb *= pos ? condProbs[j] : 1 - condProbs[j];
      });
      out.push({ eventState: { ...eventState }, truth, prob: eProb * tProb });
    }
  }
  return out;
}

/**
 * 联合状态的对数概率（用于粒子加权）。
 * @param {BatchConfig} batch
 * @param {Record<string, boolean>} eventState
 * @param {Record<string, boolean>} truth
 */
export function logStateProb(batch, eventState, truth) {
  const eventMap = Object.fromEntries(batch.events.map((e) => [e.id, e]));
  let lp = 0;
  for (const e of batch.events) {
    lp += Math.log(eventState[e.id] ? e.probability : 1 - e.probability);
  }
  for (const s of batch.samples) {
    const p = condP(s, eventState, eventMap);
    lp += Math.log(truth[s.id] ? p : 1 - p);
  }
  return lp;
}

/**
 * 风险参数缺乏证据时的敏感性区间构造。
 * 对基线风险与事件概率分别乘以 low/high 倍数（截断到 [0,1]），
 * 返回若干组可整体替换的 BatchConfig，供策略在不同假设下重复评估。
 *
 * 注意：本函数只产生“假设情景”，不产生任何保证；区间宽本身反映证据不足。
 *
 * @param {BatchConfig} batch
 * @param {number[]} riskMultipliers  基线风险倍数序列，如 [0.5, 1, 2]
 * @param {number[]} eventMultipliers 事件概率倍数序列，如 [0.5, 1, 2]
 * @returns {{label: string, batch: BatchConfig}[]}
 */
export function sensitivityScenarios(batch, riskMultipliers, eventMultipliers) {
  const out = [];
  for (const rm of riskMultipliers) {
    for (const em of eventMultipliers) {
      out.push({
        label: `基线风险×${rm} / 事件概率×${em}`,
        batch: {
          samples: batch.samples.map((s) => ({
            ...s,
            baseRisk: Math.min(1, Math.max(0, s.baseRisk * rm)),
          })),
          events: batch.events.map((e) => ({
            ...e,
            probability: Math.min(1, Math.max(0, e.probability * em)),
          })),
        },
      });
    }
  }
  return out;
}
