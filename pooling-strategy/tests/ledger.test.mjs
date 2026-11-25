// tests/ledger.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLedger,
  recordTest,
  recordCorrection,
  recordContamination,
  deriveVolume,
  deriveEffectiveTests,
  deriveSpend,
  audit,
  _resetLedgerSeq,
} from '../src/ledger.mjs';
import { defaultAssay, demoBatch } from '../data/demo-data.mjs';

function freshLedger() {
  _resetLedgerSeq();
  const batch = demoBatch();
  return createLedger(
    defaultAssay(),
    batch.samples.map((s) => ({ id: s.id, initialVolume: s.initialVolume })),
  );
}

test('检测后样量从原样品账上扣除，剩余量正确', () => {
  const ledger = freshLedger();
  const assay = defaultAssay();
  recordTest(ledger, { poolId: 'P1', round: 1, memberIds: ['S01', 'S02'], result: 1 });
  const { remaining, used } = deriveVolume(ledger);
  assert.equal(used.S01, assay.aliquotVolume);
  assert.equal(remaining.S01, 60 - assay.aliquotVolume);
  assert.equal(remaining.S03, 30);
});

test('剩余样量不足时拒绝入池（重复拆检不能无限用样）', () => {
  const ledger = freshLedger();
  // S05 初始 20，每次 10 → 仅够 2 次
  recordTest(ledger, { poolId: 'P1', round: 1, memberIds: ['S05'], result: 0 });
  recordTest(ledger, { poolId: 'P2', round: 2, memberIds: ['S05'], result: 0 });
  assert.throws(
    () => recordTest(ledger, { poolId: 'P3', round: 3, memberIds: ['S05'], result: 0 }),
    /剩余样量不足/,
  );
});

test('超过最大池大小被容量约束拦截', () => {
  const ledger = freshLedger();
  const tooBig = ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09'];
  assert.throws(
    () => recordTest(ledger, { poolId: 'BIG', round: 1, memberIds: tooBig, result: 1 }),
    /maxPoolSize/,
  );
});

test('结果更正保留原始记录，生效结果取更正值', () => {
  const ledger = freshLedger();
  const ev = recordTest(ledger, { poolId: 'P1', round: 1, memberIds: ['S01', 'S02'], result: 1 });
  recordCorrection(ledger, ev.ledgerId, 0, '复检确认阴性，原结果受污染影响');
  const eff = deriveEffectiveTests(ledger);
  assert.equal(eff.length, 1);
  assert.equal(eff[0].result, 0);
  assert.equal(eff[0].originalResult, 1);
  assert.equal(eff[0].corrected, true);
  // 原始事件仍在台账中
  assert.ok(ledger.events.some((e) => e.ledgerId === ev.ledgerId && e.result === 1));
});

test('污染事件可登记，审计通过', () => {
  const ledger = freshLedger();
  recordContamination(ledger, { round: 1, note: '台面污染演练' });
  recordTest(ledger, {
    poolId: 'P1',
    round: 1,
    memberIds: ['S01'],
    result: 1,
    contaminated: true,
  });
  const check = audit(ledger);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  assert.ok(deriveSpend(ledger) > 0);
});

test('重复成员入池报错', () => {
  const ledger = freshLedger();
  assert.throws(
    () => recordTest(ledger, { poolId: 'P1', round: 1, memberIds: ['S01', 'S01'], result: 0 }),
    /重复成员/,
  );
});
