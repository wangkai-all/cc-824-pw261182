// assay.mjs — 混池检测性能模型。
//
// 检测灵敏度随池大小变化（稀释效应），特异性受批次污染影响：
//   灵敏度 Se(k) = maxSe · decay^log2(k)          （k 加倍一次，灵敏度乘 decay）
//   特异性 Sp(k) = baseSp · (1 - contamination)^(k-1)
// 污染是实验台层面的加性风险：参与同一污染批次的池，假阳性概率额外上浮。
//
// 一次检测从池内每个样品抽取等量等分样，占用样量从原样品账上扣除；
// 剩余样量不足以支付等分样的样品不能入池（容量约束在 ledger 层强制）。

/**
 * @typedef {Object} AssayConfig
 * @property {number} maxSensitivity     单样品检测灵敏度（k=1 时）
 * @property {number} dilutionDecay      池每翻倍一次的灵敏度乘子（0,1]
 * @property {number} baseSpecificity    无污染时单样品特异性
 * @property {number} contamination      每个额外池成员带来的污染概率增量，[0,1)
 * @property {number} aliquotVolume      一次检测每个样品被抽取的样量
 * @property {number} poolCost           单次池检测费用
 * @property {number} individualCost     单次单样品检测费用
 * @property {number} maxPoolSize        实验容量：最大池大小
 * @property {number} maxParallelPools   实验容量：单轮可并行检测的池数上限
 * @property {number} falseNegativePenalty  漏检一个阳性样品的折算代价（用于代价最优目标）
 */

/** @returns {AssayConfig} 一套可复现的演示默认参数（虚构） */
export function defaultAssay() {
  return {
    maxSensitivity: 0.98,
    dilutionDecay: 0.92,
    baseSpecificity: 0.995,
    contamination: 0.004,
    maxPoolSize: 8,
    maxParallelPools: 12,
    aliquotVolume: 10,
    poolCost: 30,
    individualCost: 80,
    falseNegativePenalty: 400,
  };
}

/**
 * 池大小为 k 时的检测灵敏度。
 * @param {AssayConfig} assay
 * @param {number} k 池大小（>=1）
 */
export function sensitivityAt(assay, k) {
  if (k <= 1) return assay.maxSensitivity;
  const se = assay.maxSensitivity * Math.pow(assay.dilutionDecay, Math.log2(k));
  return Math.min(assay.maxSensitivity, Math.max(0, se));
}

/**
 * 池大小为 k、污染轮次标记为 contaminated 时的特异性。
 * @param {AssayConfig} assay
 * @param {number} k
 * @param {boolean} [contaminated=false] 该轮实验台是否发生污染事件
 */
export function specificityAt(assay, k, contaminated = false) {
  let sp = assay.baseSpecificity * Math.pow(1 - assay.contamination, k - 1);
  if (contaminated) {
    // 污染轮：假阳性率额外 +3 个百分点（演示设定，可在台账中逐轮覆盖）
    sp = Math.max(0, sp - 0.03);
  }
  return Math.min(1, Math.max(0, sp));
}

/**
 * 给定池内是否含真实阳性，计算阳性检测结果的概率。
 * @param {AssayConfig} assay
 * @param {number} poolSize
 * @param {boolean} anyPositive 池中是否至少一个真实阳性样品
 * @param {boolean} [contaminated=false]
 */
export function positiveProb(assay, poolSize, anyPositive, contaminated = false) {
  if (anyPositive) return sensitivityAt(assay, poolSize);
  return 1 - specificityAt(assay, poolSize, contaminated);
}

/**
 * 按检测模型抽样一次合成检测结果（虚构实验，用于网页演练）。
 * @param {() => number} rng
 * @param {AssayConfig} assay
 * @param {number} poolSize
 * @param {boolean} anyPositive
 * @param {boolean} [contaminated=false]
 * @returns {0|1} 1 = 阳性池，0 = 阴性池
 */
export function simulateTest(rng, assay, poolSize, anyPositive, contaminated = false) {
  return rng() < positiveProb(assay, poolSize, anyPositive, contaminated) ? 1 : 0;
}

/**
 * 单次检测的费用：池大小 1 按单样品计费，其余按池计费。
 */
export function testCost(assay, poolSize) {
  return poolSize === 1 ? assay.individualCost : assay.poolCost;
}

/**
 * 一次检测需要从每个成员样品扣除的样量。
 */
export function volumePerTest(assay) {
  return assay.aliquotVolume;
}
