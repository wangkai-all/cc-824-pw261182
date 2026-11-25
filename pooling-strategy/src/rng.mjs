// rng.mjs — 可播种随机数（mulberry32），保证演示与测试可复现。
// 浏览器与 Node 同构，无外部依赖。

/**
 * mulberry32 PRNG 工厂。
 * @param {number} seed 整数种子
 * @returns {() => number} 返回 [0,1) 均匀随机数的函数
 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 按给定概率抽取伯努利事件。
 */
export function bernoulli(rng, p) {
  return rng() < p;
}

/**
 * 从离散分布 {value: weight} 中抽样，返回被抽中的 key。
 */
export function sampleCategorical(rng, weighted) {
  const entries = Object.entries(weighted);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r <= 0) return Number.isNaN(Number(k)) ? k : Number(k);
  }
  return entries[entries.length - 1][0];
}

/**
 * 无放回洗牌（Fisher–Yates），返回新数组。
 */
export function shuffled(rng, arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
