// tests/assay.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sensitivityAt,
  specificityAt,
  positiveProb,
  simulateTest,
  testCost,
} from '../src/assay.mjs';
import { defaultAssay } from '../data/demo-data.mjs';
import { makeRng } from '../src/rng.mjs';

test('灵敏度随池大小单调下降（稀释效应）', () => {
  const assay = defaultAssay();
  const seq = [1, 2, 4, 8].map((k) => sensitivityAt(assay, k));
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] < seq[i - 1]);
  assert.equal(seq[0], assay.maxSensitivity);
});

test('特异性随池大小与污染下降', () => {
  const assay = defaultAssay();
  assert.ok(specificityAt(assay, 8) < specificityAt(assay, 1));
  assert.ok(specificityAt(assay, 4, true) < specificityAt(assay, 4, false));
});

test('阳性池/阴性池的阳性结果概率分别对应灵敏度与 1-特异性', () => {
  const assay = defaultAssay();
  assert.equal(positiveProb(assay, 4, true), sensitivityAt(assay, 4));
  assert.equal(positiveProb(assay, 4, false), 1 - specificityAt(assay, 4));
});

test('simulateTest: 大样本频率逼近理论概率', () => {
  const assay = defaultAssay();
  const rng = makeRng(99);
  let hits = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) hits += simulateTest(rng, assay, 4, true);
  const freq = hits / n;
  assert.ok(Math.abs(freq - sensitivityAt(assay, 4)) < 0.02);
});

test('单样品按单检费用，池按池检费用', () => {
  const assay = defaultAssay();
  assert.equal(testCost(assay, 1), assay.individualCost);
  assert.equal(testCost(assay, 4), assay.poolCost);
});
