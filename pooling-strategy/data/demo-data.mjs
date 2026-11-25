// demo-data.mjs — 全套虚构演示数据（无真实样品、无真实患者）。
//
// 场景：某监测实验室收到同一采样班次的 10 份样品，分属 3 个潜在相关来源：
//   - E1 共同冷链异常（低概率高抬升，关联 S01–S06）
//   - E2 同一采样点环境暴露（中概率，关联 S07–S10）
// 样品基线风险不同，初始样量分两档（部分样品仅够 2–3 次检测，体现重复拆检的样量约束）。

import { defaultAssay } from '../src/assay.mjs';

/** @returns {import('../src/risk-model.mjs').BatchConfig} */
export function demoBatch() {
  const events = [
    { id: 'E1', probability: 0.12, lift: 0.55 },
    { id: 'E2', probability: 0.2, lift: 0.35 },
  ];
  const samples = [
    { id: 'S01', baseRisk: 0.03, events: ['E1'], initialVolume: 60 },
    { id: 'S02', baseRisk: 0.04, events: ['E1'], initialVolume: 60 },
    { id: 'S03', baseRisk: 0.05, events: ['E1'], initialVolume: 30 },
    { id: 'S04', baseRisk: 0.02, events: ['E1'], initialVolume: 30 },
    { id: 'S05', baseRisk: 0.06, events: ['E1'], initialVolume: 20 },
    { id: 'S06', baseRisk: 0.03, events: ['E1'], initialVolume: 20 },
    { id: 'S07', baseRisk: 0.08, events: ['E2'], initialVolume: 60 },
    { id: 'S08', baseRisk: 0.1, events: ['E2'], initialVolume: 60 },
    { id: 'S09', baseRisk: 0.07, events: ['E2'], initialVolume: 30 },
    { id: 'S10', baseRisk: 0.09, events: ['E2'], initialVolume: 30 },
  ];
  return { samples, events };
}

/** 小样本精确核对场景（N=4，供动态规划枚举） */
export function demoSmallBatch() {
  const events = [{ id: 'E1', probability: 0.15, lift: 0.6 }];
  const samples = [
    { id: 'A1', baseRisk: 0.04, events: ['E1'], initialVolume: 40 },
    { id: 'A2', baseRisk: 0.05, events: ['E1'], initialVolume: 40 },
    { id: 'A3', baseRisk: 0.06, events: ['E1'], initialVolume: 20 },
    { id: 'A4', baseRisk: 0.03, events: ['E1'], initialVolume: 20 },
  ];
  return { samples, events };
}

export { defaultAssay };

/**
 * 可编辑的参数模板（网页“参数设置”区的初始值）。
 */
export function demoParams() {
  return {
    assay: defaultAssay(),
    missBound: 0.15,
    replications: 400,
    contaminationProb: 0.05,
    seed: 20261125,
  };
}
