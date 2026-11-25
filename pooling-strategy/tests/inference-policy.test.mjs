// tests/inference-policy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exactPosterior, particlePosterior, poolPositiveProb } from '../src/inference.mjs';
import { exactOptimalPolicy, recommendNext, allPartitions } from '../src/policy.mjs';
import { marginalRisk } from '../src/risk-model.mjs';
import { createLedger, recordTest, _resetLedgerSeq } from '../src/ledger.mjs';
import { defaultAssay, demoSmallBatch, demoBatch } from '../data/demo-data.mjs';

function ledgerFor(samples, assay) {
  _resetLedgerSeq();
  return createLedger(
    assay,
    samples.map((s) => ({ id: s.id, initialVolume: s.initialVolume })),
  );
}

test('无观测时后验等于先验边际风险', () => {
  const batch = demoSmallBatch();
  const assay = defaultAssay();
  const ledger = ledgerFor(batch.samples, assay);
  const post = exactPosterior(batch, assay, ledger);
  for (const s of batch.samples) {
    // 与枚举直接计算的边际一致
    const marginal = post.states.filter((x) => x.truth[s.id]).reduce((a, x) => a + x.weight, 0);
    assert.ok(Math.abs(post.posterior[s.id] - marginal) < 1e-12);
    assert.ok(post.posterior[s.id] > 0 && post.posterior[s.id] < 1);
  }
});

test('阴性池结果降低成员后验，阳性池结果升高成员后验', () => {
  const batch = demoSmallBatch();
  const assay = defaultAssay();
  const ledger0 = ledgerFor(batch.samples, assay);
  const before = exactPosterior(batch, assay, ledger0).posterior.A1;

  const ledgerNeg = ledgerFor(batch.samples, assay);
  recordTest(ledgerNeg, { poolId: 'P', round: 1, memberIds: ['A1', 'A2'], result: 0 });
  const afterNeg = exactPosterior(batch, assay, ledgerNeg).posterior.A1;
  assert.ok(afterNeg < before);

  const ledgerPos = ledgerFor(batch.samples, assay);
  recordTest(ledgerPos, { poolId: 'P', round: 1, memberIds: ['A1', 'A2'], result: 1 });
  const afterPos = exactPosterior(batch, assay, ledgerPos).posterior.A1;
  assert.ok(afterPos > before);
});

test('粒子后验与精确后验在小样本上接近', () => {
  const batch = demoSmallBatch();
  const assay = defaultAssay();
  const ledger = ledgerFor(batch.samples, assay);
  recordTest(ledger, { poolId: 'P', round: 1, memberIds: ['A1', 'A2', 'A3'], result: 1 });
  const exact = exactPosterior(batch, assay, ledger);
  const particle = particlePosterior(batch, assay, ledger, 8000, 42);
  for (const s of batch.samples) {
    assert.ok(Math.abs(exact.posterior[s.id] - particle.posterior[s.id]) < 0.06);
  }
});

test('poolPositiveProb 与成员边际之和方向一致且不超过 1', () => {
  const batch = demoSmallBatch();
  const assay = defaultAssay();
  const ledger = ledgerFor(batch.samples, assay);
  const post = exactPosterior(batch, assay, ledger);
  const p = poolPositiveProb(post.states, ['A1', 'A2']);
  assert.ok(p >= Math.max(post.posterior.A1, post.posterior.A2));
  assert.ok(p <= 1);
});

test('allPartitions: Bell 数正确（B3=5, B4=15）', () => {
  assert.equal(allPartitions([1, 2, 3]).length, 5);
  assert.equal(allPartitions([1, 2, 3, 4]).length, 15);
});

test('精确 DP：费用最小树的期望代价不劣于“全部直接单检”', () => {
  const batch = demoSmallBatch();
  const assay = defaultAssay();
  const res = exactOptimalPolicy(batch, assay, { maxDepth: 4 });
  // 全部直接单检的期望费用 = N·单检费 + λ·期望漏检（单检灵敏度<1）
  const allSingle =
    batch.samples.length * assay.individualCost +
    assay.falseNegativePenalty *
      batch.samples.reduce(
        (a, s) => a + marginalRisk(s, batch.events) * (1 - assay.maxSensitivity),
        0,
      );
  assert.ok(res.costMinTree.expectedCost <= allSingle + 1e-9);
  assert.ok(res.statesVisited > 0);
});

test('精确 DP：漏检受限树的期望漏检不超过约束', () => {
  const batch = demoSmallBatch();
  const assay = defaultAssay();
  const res = exactOptimalPolicy(batch, assay, { maxDepth: 4, missBound: 0.02 });
  assert.ok(res.missBoundTree !== null);
  assert.ok(res.missBoundTree.expectedMisses <= 0.02 + 1e-9);
  // 受限方案费用不应低于费用最小方案的检测费用
  assert.ok(res.missBoundTree.expectedSpend >= res.costMinTree.expectedSpend - 1e-9);
});

test('recommendNext: 无样可测时返回 stop 并给出说明', () => {
  const batch = demoSmallBatch();
  const assay = { ...defaultAssay(), aliquotVolume: 1000 };
  const ledger = ledgerFor(batch.samples, assay);
  const rec = recommendNext(batch, assay, ledger);
  assert.equal(rec.recommendation.kind, 'stop');
  assert.match(rec.note, /样量/);
});

test('recommendNext: 初始推荐为合规检测动作且池大小不超容量', () => {
  const batch = demoBatch();
  const assay = defaultAssay();
  const ledger = ledgerFor(batch.samples, assay);
  const rec = recommendNext(batch, assay, ledger);
  if (rec.recommendation.kind === 'test') {
    for (const pool of rec.recommendation.pools) {
      assert.ok(pool.length <= assay.maxPoolSize);
      assert.ok(pool.length >= 1);
    }
  }
});
