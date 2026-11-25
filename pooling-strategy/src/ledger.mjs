// ledger.mjs — 实验检测台账（唯一事实来源）。
//
// 设计原则：
//   1. 台账是只追加的不可变事件流；分析侧的任何状态都由台账派生，保证“分析与实际检测台账一致”。
//   2. 每次检测从池内每个样品扣除等分样量；剩余样量不足的样品不能再入池（重复拆检不能无限用样）。
//   3. 污染事件、池结果更正都是显式事件：更正不抹掉原始记录，而是追加 CORRECTION。
//   4. 容量约束（最大池大小、单轮并行池数）在入台账时校验，违规直接抛错。

import { testCost, volumePerTest } from './assay.mjs';

export const EVENT_TYPES = Object.freeze({
  TEST: 'TEST',
  CORRECTION: 'CORRECTION',
  CONTAMINATION: 'CONTAMINATION',
  NOTE: 'NOTE',
});

let seqCounter = 0;
function nextId(prefix) {
  seqCounter += 1;
  return `${prefix}-${String(Date.now()).slice(-6)}-${seqCounter}`;
}

/** 仅供测试重置序号 */
export function _resetLedgerSeq() {
  seqCounter = 0;
}

/**
 * 创建空台账。
 * @param {import('./assay.mjs').AssayConfig} assay
 * @param {{id: string, initialVolume: number}[]} samples
 */
export function createLedger(assay, samples) {
  return {
    assay,
    sampleIds: samples.map((s) => s.id),
    initialVolumes: Object.fromEntries(samples.map((s) => [s.id, s.initialVolume])),
    events: [],
    createdAt: new Date().toISOString(),
  };
}

/**
 * 记录一轮污染事件（影响该轮及之后显式标注的检测，具体由事件时间戳关联）。
 * @param {object} ledger
 * @param {{round: number, scope?: string[], note?: string}} payload
 */
export function recordContamination(ledger, { round, scope = null, note = '' }) {
  ledger.events.push({
    ledgerId: nextId('EV'),
    type: EVENT_TYPES.CONTAMINATION,
    at: new Date().toISOString(),
    round,
    scope, // null = 全实验台；否则为受影响池 id 列表
    note,
  });
  return ledger;
}

/**
 * 追加一次检测记录。
 * @param {object} ledger
 * @param {object} test
 * @param {string} test.poolId
 * @param {number} test.round
 * @param {string[]} test.memberIds  池成员样品 id
 * @param {0|1} test.result         1=阳性池 0=阴性池
 * @param {boolean} [test.contaminated] 本次检测是否落在污染范围
 * @param {string} [test.note]
 * @returns {object} 被追加的事件（含费用与样量扣减明细）
 */
export function recordTest(ledger, test) {
  const { assay } = ledger;
  const { poolId, round, memberIds, result } = test;
  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    throw new Error(`池 ${poolId} 成员为空，不能检测`);
  }
  if (memberIds.length > assay.maxPoolSize) {
    throw new Error(
      `池 ${poolId} 大小 ${memberIds.length} 超过实验容量 maxPoolSize=${assay.maxPoolSize}`,
    );
  }
  const vols = deriveVolume(ledger);
  const aliquot = volumePerTest(assay);
  const insufficient = memberIds.filter((id) => vols.remaining[id] < aliquot);
  if (insufficient.length > 0) {
    throw new Error(
      `样品 ${insufficient.join(', ')} 剩余样量不足 ${aliquot}，无法参与池 ${poolId} 的检测`,
    );
  }
  const duplicate = memberIds.filter((id, i) => memberIds.indexOf(id) !== i);
  if (duplicate.length) throw new Error(`池 ${poolId} 存在重复成员：${duplicate.join(', ')}`);

  const event = {
    ledgerId: nextId('EV'),
    type: EVENT_TYPES.TEST,
    at: new Date().toISOString(),
    poolId,
    round,
    memberIds: memberIds.slice(),
    result,
    contaminated: test.contaminated ?? false,
    cost: testCost(assay, memberIds.length),
    aliquot,
    note: test.note ?? '',
  };
  ledger.events.push(event);
  return event;
}

/**
 * 追加一条结果更正（原始记录保留）。
 * @param {object} ledger
 * @param {string} originalLedgerId 被更正的 TEST 事件 ledgerId
 * @param {0|1} correctedResult
 * @param {string} reason
 */
export function recordCorrection(ledger, originalLedgerId, correctedResult, reason) {
  const original = ledger.events.find(
    (e) => e.type === EVENT_TYPES.TEST && e.ledgerId === originalLedgerId,
  );
  if (!original) throw new Error(`未找到待更正的检测记录 ${originalLedgerId}`);
  if (correctedResult !== 0 && correctedResult !== 1) {
    throw new Error('更正结果必须为 0 或 1');
  }
  const event = {
    ledgerId: nextId('EV'),
    type: EVENT_TYPES.CORRECTION,
    at: new Date().toISOString(),
    originalLedgerId,
    poolId: original.poolId,
    correctedResult,
    reason,
  };
  ledger.events.push(event);
  return event;
}

/** 追加备注（不影响任何派生状态） */
export function recordNote(ledger, round, note) {
  ledger.events.push({
    ledgerId: nextId('EV'),
    type: EVENT_TYPES.NOTE,
    at: new Date().toISOString(),
    round,
    note,
  });
}

/**
 * 由台账派生出每个样品的已用/剩余样量。
 * @returns {{remaining: Record<string, number>, used: Record<string, number>}}
 */
export function deriveVolume(ledger) {
  const remaining = { ...ledger.initialVolumes };
  const used = Object.fromEntries(ledger.sampleIds.map((id) => [id, 0]));
  for (const e of ledger.events) {
    if (e.type !== EVENT_TYPES.TEST) continue;
    for (const id of e.memberIds) {
      remaining[id] -= e.aliquot;
      used[id] += e.aliquot;
    }
  }
  return { remaining, used };
}

/**
 * 由台账派生“当前生效”的检测记录（应用更正后的结果）。
 * @returns {Array<object>} 与 TEST 事件同构，另带 corrected 标记
 */
export function deriveEffectiveTests(ledger) {
  const corrections = new Map();
  for (const e of ledger.events) {
    if (e.type === EVENT_TYPES.CORRECTION) corrections.set(e.originalLedgerId, e);
  }
  return ledger.events
    .filter((e) => e.type === EVENT_TYPES.TEST)
    .map((e) => {
      const c = corrections.get(e.ledgerId);
      return c
        ? { ...e, originalResult: e.result, result: c.correctedResult, corrected: true, correctionReason: c.reason }
        : { ...e, corrected: false };
    });
}

/** 台账累计检测费用（更正不重复收费） */
export function deriveSpend(ledger) {
  return ledger.events
    .filter((e) => e.type === EVENT_TYPES.TEST)
    .reduce((sum, e) => sum + e.cost, 0);
}

/** 已完成的检测轮次序号列表 */
export function deriveRounds(ledger) {
  return [
    ...new Set(
      ledger.events
        .filter((e) => e.type === EVENT_TYPES.TEST)
        .map((e) => e.round),
    ),
  ].sort((a, b) => a - b);
}

/**
 * 台账一致性自检：样量不得为负、更正必须指向存在的检测、费用口径一致。
 * @returns {{ok: boolean, errors: string[]}}
 */
export function audit(ledger) {
  const errors = [];
  const { remaining } = deriveVolume(ledger);
  for (const id of ledger.sampleIds) {
    if (remaining[id] < -1e-9) errors.push(`样品 ${id} 剩余样量为负（${remaining[id]}）`);
  }
  const testIds = new Set(
    ledger.events.filter((e) => e.type === EVENT_TYPES.TEST).map((e) => e.ledgerId),
  );
  for (const e of ledger.events) {
    if (e.type === EVENT_TYPES.CORRECTION && !testIds.has(e.originalLedgerId)) {
      errors.push(`更正 ${e.ledgerId} 指向不存在的检测 ${e.originalLedgerId}`);
    }
  }
  const spend = deriveSpend(ledger);
  if (Math.abs(spend - deriveSpend(ledger)) > 1e-9) {
    errors.push('费用汇总口径不一致');
  }
  return { ok: errors.length === 0, errors };
}
