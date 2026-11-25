// tests/risk-model.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  marginalRisk,
  condP,
  enumerateJointStates,
  sampleTruth,
  sampleEventState,
  sensitivityScenarios,
} from '../src/risk-model.mjs';
import { demoBatch, demoSmallBatch } from '../data/demo-data.mjs';
import { makeRng } from '../src/rng.mjs';

test('condP: 事件发生时取 lift，未发生时取基线', () => {
  const batch = demoBatch();
  const map = Object.fromEntries(batch.events.map((e) => [e.id, e]));
  const s = batch.samples[0];
  assert.equal(condP(s, { E1: false, E2: false }, map), s.baseRisk);
  assert.equal(condP(s, { E1: true, E2: false }, map), 0.55);
});

test('marginalRisk: 边缘化潜在事件后介于基线与 lift 之间', () => {
  const batch = demoBatch();
  const s = batch.samples[0]; // base 0.03, E1 pi=0.12 lift=0.55
  const m = marginalRisk(s, batch.events);
  assert.ok(m > s.baseRisk && m < 0.55);
  // 手算：(1-0.12)*0.03 + 0.12*0.55
  const expected = 0.88 * 0.03 + 0.12 * 0.55;
  assert.ok(Math.abs(m - expected) < 1e-12);
});

test('enumerateJointStates: 概率归一且状态数=2^(N+K)', () => {
  const batch = demoSmallBatch();
  const states = enumerateJointStates(batch);
  assert.equal(states.length, 2 ** 5);
  const total = states.reduce((a, x) => a + x.prob, 0);
  assert.ok(Math.abs(total - 1) < 1e-12);
});

test('联合分布体现相关性：E1 发生时阳性共现率高于独立假设', () => {
  const batch = demoSmallBatch();
  const states = enumerateJointStates(batch);
  const both = states.filter((x) => x.truth.A1 && x.truth.A2).reduce((a, x) => a + x.prob, 0);
  const m1 = marginalRisk(batch.samples[0], batch.events);
  const m2 = marginalRisk(batch.samples[1], batch.events);
  // 正相关 → 联合概率 > 独立假设乘积
  assert.ok(both > m1 * m2, `both=${both}, independent=${m1 * m2}`);
});

test('sampleTruth: 可复现且取值为布尔', () => {
  const batch = demoSmallBatch();
  const rng1 = makeRng(7);
  const rng2 = makeRng(7);
  const st1 = sampleEventState(batch.events, rng1);
  const t1 = sampleTruth(batch, st1, rng1);
  const st2 = sampleEventState(batch.events, rng2);
  const t2 = sampleTruth(batch, st2, rng2);
  assert.deepEqual(t1, t2);
  assert.deepEqual(st1, st2);
});

test('sensitivityScenarios: 倍数截断到 [0,1] 且保持结构', () => {
  const batch = demoBatch();
  const scenarios = sensitivityScenarios(batch, [0.5, 2], [1]);
  assert.equal(scenarios.length, 2);
  for (const sc of scenarios) {
    for (const s of sc.batch.samples) assert.ok(s.baseRisk >= 0 && s.baseRisk <= 1);
    assert.equal(sc.batch.samples.length, batch.samples.length);
  }
});
