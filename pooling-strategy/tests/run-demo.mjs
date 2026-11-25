// tests/run-demo.mjs — 命令行端到端演示（node tests/run-demo.mjs）
import { demoBatch, demoSmallBatch, demoParams } from '../data/demo-data.mjs';
import { marginalRisk } from '../src/risk-model.mjs';
import { exactOptimalPolicy } from '../src/policy.mjs';
import { evaluateStrategies, sensitivityAnalysis } from '../src/simulation.mjs';
import { sensitivityAt, specificityAt } from '../src/assay.mjs';

const params = demoParams();
const batch = demoBatch();
const small = demoSmallBatch();

console.log('=== 混池策略分析系统 · 命令行演示（全部数据为虚构）===\n');

console.log('1) 样品边际风险（已对潜在相关事件边缘化）');
for (const s of batch.samples) {
  console.log(`   ${s.id}: 基线 ${s.baseRisk.toFixed(3)} → 边际 ${marginalRisk(s, batch.events).toFixed(4)}，初始样量 ${s.initialVolume}`);
}

console.log('\n2) 检测性能随池大小变化（稀释/污染）');
for (const k of [1, 2, 4, 8]) {
  console.log(
    `   池大小 ${k}: Se=${sensitivityAt(params.assay, k).toFixed(4)}, Sp(清洁)=${specificityAt(params.assay, k).toFixed(4)}, Sp(污染)=${specificityAt(params.assay, k, true).toFixed(4)}`,
  );
}

console.log('\n3) 小样本精确枚举核对（N=4）');
const dp = exactOptimalPolicy(small, params.assay, { maxDepth: 4, missBound: 0.02 });
console.log(`   访问信念状态数: ${dp.statesVisited}`);
console.log(
  `   费用最小树: 期望总代价=${dp.costMinTree.expectedCost.toFixed(2)}, 期望检测费=${dp.costMinTree.expectedSpend.toFixed(2)}, 期望漏检数=${dp.costMinTree.expectedMisses.toFixed(4)}`,
);
console.log(
  `   漏检受限树: 期望检测费=${dp.missBoundTree.expectedSpend.toFixed(2)}, 期望漏检数=${dp.missBoundTree.expectedMisses.toFixed(4)}`,
);
console.log(`   提示: ${dp.note}`);

console.log('\n4) 整批蒙特卡洛对比（N=10）');
const ev = evaluateStrategies(batch, params.assay, {
  replications: params.replications,
  contaminationProb: params.contaminationProb,
  missBound: params.missBound,
});
for (const [key, label] of [
  ['costMin', '费用最小'],
  ['missBound', '漏检受限'],
]) {
  const a = ev[key];
  console.log(
    `   ${label}: 均费=${a.meanSpend.toFixed(1)} (P95=${a.p95Spend.toFixed(1)}), 均检测次数=${a.meanTests.toFixed(2)}, 漏检率=${(a.missRate * 100).toFixed(2)}%, 样量耗尽率=${(a.exhaustionRate * 100).toFixed(2)}%`,
  );
}

console.log('\n5) 敏感性范围（风险假设缺乏证据时）');
const sa = sensitivityAnalysis(batch, params.assay, { replications: 120 });
console.log(
  `   均费区间: [${sa.costMinRanges.meanSpend.min.toFixed(1)}, ${sa.costMinRanges.meanSpend.max.toFixed(1)}]`,
);
console.log(
  `   漏检率区间: [${(sa.costMinRanges.missRate.min * 100).toFixed(2)}%, ${(sa.costMinRanges.missRate.max * 100).toFixed(2)}%]`,
);
console.log(`   ${sa.disclaimer}`);
