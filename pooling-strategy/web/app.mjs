// app.mjs — 演练台前端逻辑。所有分析都调用 ../src 引擎，前端只做交互与渲染；
// 唯一事实来源是 ledger（不可变事件流），页面状态均可由台账重建。

import { demoBatch, demoSmallBatch, demoParams } from '../data/demo-data.mjs';
import { makeRng } from '../src/rng.mjs';
import { marginalRisk, sampleEventState, sampleTruth } from '../src/risk-model.mjs';
import {
  defaultAssay, sensitivityAt, specificityAt, simulateTest,
} from '../src/assay.mjs';
import {
  createLedger, recordTest, recordContamination, recordCorrection,
  deriveVolume, deriveEffectiveTests, deriveSpend, deriveRounds, audit,
} from '../src/ledger.mjs';
import { recommendNext } from '../src/policy.mjs';
import { posterior, poolPositiveProb } from '../src/inference.mjs';
import { evaluateStrategies, sensitivityAnalysis } from '../src/simulation.mjs';
import { exactOptimalPolicy } from '../src/policy.mjs';
import { horizontalBars, groupedBars, lineChart, statTile, fmt, catColor } from './charts.mjs';

const params = demoParams();
const batch = demoBatch();
const assay = defaultAssay();
const EVENT_COLOR = { E1: 'var(--c1)', E2: 'var(--c2)' };
const SEED = params.seed;

// ---- 运行期状态 ----
let ledger = createLedger(assay, batch.samples.map((s) => ({ id: s.id, initialVolume: s.initialVolume })));
let rng = makeRng(SEED);
let truth = null; // 首轮检测时才抽样生成；策略路径从不读取它
let roundNo = 0;
let board = { unassigned: batch.samples.map((s) => s.id), pools: [] }; // pools: string[][]
let selectedChip = null;
let lastRecommendation = null;
let frozen = false;

const $ = (id) => document.getElementById(id);
const clonePools = (pools) => pools.map((p) => [...p]);

function ensureTruth() {
  if (!truth) {
    const es = sampleEventState(batch.events, rng);
    truth = sampleTruth(batch, es, rng);
  }
}

// ================= 初始化 =================
function init() {
  $('capHint').textContent = `maxPoolSize=${assay.maxPoolSize} · 单轮并行≤${assay.maxParallelPools} · 等分样=${assay.aliquotVolume}`;
  $('seedLabel').textContent = `随机种子 ${SEED}（合成检测可复现）`;
  $('replicationsInput').value = params.replications;
  $('contamInput').value = params.contaminationProb;
  $('missBoundInput').value = params.missBound;
  bindStaticEvents();
  addPool(); addPool(); // 两个空池起步
  renderAll();
}

function bindStaticEvents() {
  $('themeBtn').addEventListener('click', toggleTheme);
  $('resetBtn').addEventListener('click', resetAll);
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => switchTab(t.dataset.tab)));
  document.querySelectorAll('.table-toggle button').forEach((b) =>
    b.addEventListener('click', () => {
      const table = $(b.dataset.table);
      table.hidden = !table.hidden;
      b.textContent = table.hidden ? '查看数据表' : '收起数据表';
    }));

  $('applyRecBtn').addEventListener('click', applyRecommendation);
  $('clearBoardBtn').addEventListener('click', () => {
    board = { unassigned: allSampleIds(), pools: [] };
    addPool(); addPool();
    renderBoard();
  });
  $('runRoundBtn').addEventListener('click', runRound);
  $('freezeBtn').addEventListener('click', runEvaluation);
  $('sensBtn').addEventListener('click', runSensitivity);
}

function allSampleIds() { return batch.samples.map((s) => s.id); }

function toggleTheme() {
  const body = document.body;
  const dark = body.dataset.theme === 'dark';
  body.dataset.theme = dark ? 'light' : 'dark';
  $('themeBtn').textContent = dark ? '切换深色' : '切换浅色';
  $('themeBtn').setAttribute('aria-pressed', String(!dark));
  renderCharts(); // 颜色 token 变化后重绘
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  renderCharts();
}

function resetAll() {
  ledger = createLedger(assay, batch.samples.map((s) => ({ id: s.id, initialVolume: s.initialVolume })));
  rng = makeRng(SEED);
  truth = null;
  roundNo = 0;
  board = { unassigned: allSampleIds(), pools: [] };
  selectedChip = null;
  lastRecommendation = null;
  frozen = false;
  $('contamChk').checked = false;
  $('evalSummary').innerHTML = '';
  $('evalChart').innerHTML = '';
  $('evalTable').innerHTML = '';
  $('sensPanel').innerHTML = '';
  $('evalProgress').hidden = true;
  addPool(); addPool();
  setBoardMsg('');
  renderAll();
}

// ================= 分池板（拖拽 + 点击） =================
function addPool() {
  if (board.pools.length >= assay.maxParallelPools) return;
  board.pools.push([]);
}

function findLocation(id) {
  if (board.unassigned.includes(id)) return { zone: 'unassigned', index: board.unassigned.indexOf(id) };
  for (let pi = 0; pi < board.pools.length; pi++) {
    const i = board.pools[pi].indexOf(id);
    if (i >= 0) return { zone: 'pool', pool: pi, index: i };
  }
  return null;
}

function removeId(id) {
  const loc = findLocation(id);
  if (!loc) return;
  if (loc.zone === 'unassigned') board.unassigned.splice(loc.index, 1);
  else board.pools[loc.pool].splice(loc.index, 1);
}

function moveSample(id, target) {
  const { remaining } = deriveVolume(ledger);
  if (remaining[id] < assay.aliquotVolume) {
    setBoardMsg(`${id} 剩余样量不足 ${assay.aliquotVolume}，不能再入池`);
    return false;
  }
  if (target.zone === 'pool') {
    const pool = board.pools[target.pool];
    if (pool.length >= assay.maxPoolSize) {
      setBoardMsg(`池 ${target.pool + 1} 已达容量上限 ${assay.maxPoolSize}`);
      return false;
    }
  }
  removeId(id);
  if (target.zone === 'unassigned') board.unassigned.push(id);
  else board.pools[target.pool].push(id);
  setBoardMsg('');
  return true;
}

function renderBoard() {
  const { remaining } = deriveVolume(ledger);
  const ua = $('unassigned');
  ua.innerHTML = `<div class="pool-head"><span class="pool-name">未分池（${board.unassigned.length}）</span><span class="pool-meta">拖到右侧池或点选后点池</span></div>`;
  const chips = document.createElement('div');
  chips.className = 'chips';
  board.unassigned.forEach((id) => chips.appendChild(chipNode(id, remaining)));
  ua.appendChild(chips);

  const wrap = $('pools');
  wrap.innerHTML = '';
  board.pools.forEach((pool, pi) => {
    const box = document.createElement('div');
    box.className = 'pool';
    box.dataset.poolIdx = String(pi);
    const over = pool.length > assay.maxPoolSize;
    box.innerHTML = `
      <div class="pool-head">
        <span class="pool-name">池 P${pi + 1}</span>
        <span class="pool-meta ${over ? 'over-cap' : ''}">${pool.length}/${assay.maxPoolSize} · 检测费 ${pool.length ? (pool.length === 1 ? assay.individualCost : assay.poolCost) : 0}</span>
        <button class="remove-pool" title="删除该池" type="button">✕</button>
      </div>`;
    box.querySelector('.remove-pool').addEventListener('click', () => {
      board.unassigned.push(...board.pools[pi]);
      board.pools.splice(pi, 1);
      renderBoard();
    });
    const cw = document.createElement('div');
    cw.className = 'chips';
    pool.forEach((id) => cw.appendChild(chipNode(id, remaining)));
    box.appendChild(cw);
    bindDropZone(box, { zone: 'pool', pool: pi });
    box.addEventListener('click', (e) => {
      if (e.target.closest('.sample-chip') || e.target.closest('.remove-pool')) return;
      if (selectedChip) { moveSample(selectedChip, { zone: 'pool', pool: pi }); selectedChip = null; renderBoard(); }
    });
    wrap.appendChild(box);
  });

  if (board.pools.length < assay.maxParallelPools) {
    const add = document.createElement('button');
    add.className = 'btn btn-ghost btn-sm add-pool-btn';
    add.type = 'button';
    add.textContent = '+ 新增空池';
    add.addEventListener('click', () => { addPool(); renderBoard(); });
    wrap.appendChild(add);
  }
  bindDropZone(ua, { zone: 'unassigned' });
}

function chipNode(id, remaining) {
  const sample = batch.samples.find((s) => s.id === id);
  const node = document.createElement('div');
  const exhausted = remaining[id] < assay.aliquotVolume;
  node.className = `sample-chip ${exhausted ? 'exhausted' : ''} ${selectedChip === id ? 'selected' : ''}`;
  node.draggable = !exhausted;
  node.dataset.id = id;
  const ev = sample.events[0] ?? '';
  node.style.borderLeftColor = EVENT_COLOR[ev] ?? 'var(--line-strong)';
  node.innerHTML = `
    <span class="sid">${id}</span>
    <span class="svol">余 ${remaining[id]}</span>
    <span class="spost">边际 ${(marginalRisk(sample, batch.events) * 100).toFixed(1)}%</span>`;
  node.title = `${id}：初始样量 ${sample.initialVolume}，剩余 ${remaining[id]}，边际风险 ${(marginalRisk(sample, batch.events) * 100).toFixed(2)}%`;
  node.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
  });
  node.addEventListener('click', () => {
    if (exhausted) return;
    selectedChip = selectedChip === id ? null : id;
    renderBoard();
  });
  return node;
}

function bindDropZone(node, target) {
  node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('drag-over'); });
  node.addEventListener('dragleave', () => node.classList.remove('drag-over'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('drag-over');
    const id = e.dataTransfer.getData('text/plain');
    if (id && moveSample(id, target)) renderBoard();
  });
}

function setBoardMsg(msg) { $('boardMsg').textContent = msg; }

// ================= 推荐下一步 =================
function computeRecommendation() {
  try {
    lastRecommendation = recommendNext(batch, assay, ledger, { enumCap: 4096 });
  } catch (err) {
    lastRecommendation = { error: err.message };
  }
  return lastRecommendation;
}

function applyRecommendation() {
  const rec = computeRecommendation();
  if (rec.error) { setBoardMsg(rec.error); return; }
  if (rec.recommendation.kind === 'stop') {
    setBoardMsg('引擎建议终止：继续检测的期望代价已高于停止的期望漏检代价');
    return;
  }
  const pools = rec.recommendation.pools;
  board = { unassigned: allSampleIds(), pools: clonePools(pools) };
  while (board.pools.length < 2) addPool();
  selectedChip = null;
  setBoardMsg('已采用引擎推荐分池（可继续拖动调整后再执行）');
  renderBoard();
  renderRecommendation();
}

function renderRecommendation() {
  const rec = lastRecommendation ?? computeRecommendation();
  const panel = $('recoPanel');
  if (rec.error) {
    panel.innerHTML = `<div class="board-msg">后验推断失败：${esc(rec.error)}</div>`;
    return;
  }
  const { recommendation, posterior: post, candidates } = rec;
  const isStop = recommendation.kind === 'stop';
  let html = `
    <div class="reco-head">
      <span class="pill ${isStop ? 'stop' : 'test'}">${isStop ? '建议终止' : '建议检测'}</span>
      <span class="hint" style="margin:0">推断方式：${post.method === 'exact' ? `精确枚举（${post.states.length} 个联合状态）` : `粒子（ESS ${fmt(post.ess, 0)}）`}</span>
    </div>`;

  if (!isStop) {
    html += '<div class="reco-pools">';
    recommendation.pools.forEach((pool, i) => {
      const pPos = poolPositiveProb(post.states, pool);
      html += `<div class="reco-pool">
        <span class="members">池 ${i + 1}（${pool.length}）：${pool.join('、')}</span>
        <span class="pprob">预测池阳概率 ${(pPos * 100).toFixed(1)}%</span>
      </div>`;
    });
    html += '</div>';
  } else {
    const residual = candidates[0]?.detail?.expectedResidual ?? 0;
    html += `<p class="hint">当前期望残余阳性数 ${fmt(residual, 3)}；停止的期望漏检代价 ${fmt(candidates[0]?.expectedCost ?? 0, 1)}。</p>`;
  }

  // 候选方案对比表（含分数，体现“为何选它”）
  const rows = candidates.slice(0, 8).map((c, i) => {
    const kind = c.action.kind;
    const desc = kind === 'stop'
      ? '停止检测'
      : c.action.pools.map((p) => `[${p.join('/')}]`).join(' ');
    return `<tr class="${c === pickMin(candidates) ? 'best' : ''}">
      <td title="${desc}">${kind === 'stop' ? '停止' : `${c.action.pools.length} 池`}</td>
      <td class="num">${fmt(c.expectedCost, 1)}</td>
    </tr>`;
  }).join('');
  html += `<div class="cand-list"><table>
      <thead><tr><th>候选动作</th><th class="num">期望总代价（检测+λ漏检）</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  panel.innerHTML = html;
}

function pickMin(candidates) {
  let best = candidates[0];
  for (const c of candidates) if (c.expectedCost < best.expectedCost) best = c;
  return best;
}

// ================= 执行一轮合成检测 =================
function runRound() {
  if (frozen) { setBoardMsg('方案已冻结并完成整批评估；如需继续演练请先重置'); return; }
  const pools = board.pools.filter((p) => p.length > 0);
  if (pools.length === 0) { setBoardMsg('请先分池（至少一个非空池）再执行检测'); return; }
  if (pools.length > assay.maxParallelPools) { setBoardMsg(`单轮并行池数超过 ${assay.maxParallelPools}`); return; }

  ensureTruth();
  roundNo += 1;
  const contaminated = $('contamChk').checked;
  if (contaminated) recordContamination(ledger, { round: roundNo, note: '演练台手动标记污染轮' });

  const executed = [];
  for (let i = 0; i < pools.length; i++) {
    const memberIds = pools[i];
    const anyPositive = memberIds.some((id) => truth[id]);
    const result = simulateTest(rng, assay, memberIds.length, anyPositive, contaminated);
    try {
      recordTest(ledger, { poolId: `R${roundNo}-P${i + 1}`, round: roundNo, memberIds, result, contaminated });
      executed.push({ memberIds, result });
    } catch (err) {
      setBoardMsg(`检测中止：${err.message}`);
      renderAll();
      return;
    }
  }
  // 已检测的样品回到未分池，保留空池供下一轮拆检
  board = { unassigned: allSampleIds(), pools: [[]] };
  while (board.pools.length < 2) addPool();
  $('contamChk').checked = false;
  setBoardMsg(`第 ${roundNo} 轮完成：${executed.map((e) => `${e.memberIds.length}人池${e.result ? '阳' : '阴'}`).join('，')}（真值未对策略可见）`);
  lastRecommendation = null;
  renderAll();
}

// ================= 剩余样量 =================
function renderVolume() {
  const { remaining, used } = deriveVolume(ledger);
  const panel = $('volumePanel');
  panel.innerHTML = '';
  batch.samples.forEach((s) => {
    const rem = remaining[s.id];
    const ratio = rem / s.initialVolume;
    const cls = rem < assay.aliquotVolume ? 'empty' : ratio < 0.4 ? 'low' : '';
    const card = document.createElement('div');
    card.className = `vol-card ${cls}`;
    card.innerHTML = `
      <div class="v-top"><span class="v-id">${s.id}</span><span>${used[s.id]}/${s.initialVolume}</span></div>
      <div class="vol-bar"><div class="fill" style="width:${(ratio * 100).toFixed(1)}%"></div></div>
      <div class="v-num">剩余 ${rem}${rem < assay.aliquotVolume ? ' · 不可再测' : ` · 可再测 ${Math.floor(rem / assay.aliquotVolume)} 次`}</div>`;
    panel.appendChild(card);
  });
}

// ================= 台账 =================
function renderLedger() {
  const tests = deriveEffectiveTests(ledger);
  const spend = deriveSpend(ledger);
  const rounds = deriveRounds(ledger);
  const auditResult = audit(ledger);
  const contamEvents = ledger.events.filter((e) => e.type === 'CONTAMINATION');
  const corrEvents = ledger.events.filter((e) => e.type === 'CORRECTION');

  $('ledgerMeta').innerHTML = `
    <span>累计检测 <b>${tests.length}</b> 次</span>
    <span>检测轮次 <b>${rounds.length}</b>（${rounds.length ? rounds.join('、') : '—'}）</span>
    <span>累计费用 <b>${fmt(spend, 0)}</b></span>
    <span>污染事件 <b>${contamEvents.length}</b></span>
    <span>更正事件 <b>${corrEvents.length}</b></span>
    <span>台账审计 <b style="color:${auditResult.ok ? 'var(--good)' : 'var(--critical)'}">${auditResult.ok ? '通过' : '异常'}</b></span>`;

  const head = `<tr><th>事件</th><th>轮次</th><th>池成员</th><th>大小</th><th>生效结果</th><th>污染</th><th>费用</th><th>操作</th></tr>`;
  const body = tests.map((t) => `
    <tr>
      <td>${t.poolId}</td>
      <td class="num">${t.round}</td>
      <td>${t.memberIds.join('、')}</td>
      <td class="num">${t.memberIds.length}</td>
      <td>${t.result === 1
        ? `<span class="badge pos">阳性${t.corrected ? '（已更正）' : ''}</span>`
        : `<span class="badge neg">阴性${t.corrected ? '（已更正）' : ''}</span>`}
        ${t.corrected ? `<div class="hint" style="margin:2px 0 0">原值 ${t.originalResult}：${esc(t.correctionReason)}</div>` : ''}</td>
      <td>${t.contaminated ? '<span class="badge contam">污染轮</span>' : '—'}</td>
      <td class="num">${t.cost}</td>
      <td class="row-actions">
        <button class="btn btn-ghost btn-sm" data-correct="${t.ledgerId}" data-result="${t.result}" type="button">更正为${t.result === 1 ? '阴' : '阳'}</button>
      </td>
    </tr>`).join('');
  const corrRows = corrEvents.map((c) => `
    <tr><td>${esc(c.ledgerId.slice(0, 12))}</td><td colspan="7"><span class="badge corr">CORRECTION</span> 指向 ${esc(c.poolId)}，更正结果=${c.correctedResult}，原因：${esc(c.reason)}</td></tr>`).join('');
  $('ledgerTable').innerHTML = `<table><thead>${head}</thead><tbody>${body || '<tr><td colspan="8">暂无检测记录</td></tr>'}${corrRows}</tbody></table>`;

  $('ledgerTable').querySelectorAll('[data-correct]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const origId = btn.dataset.correct;
      const newResult = btn.dataset.result === '1' ? 0 : 1;
      const reason = prompt('请输入结果更正原因（原始记录将保留并追加 CORRECTION 事件）', '复检发现原结果判读错误');
      if (!reason) return;
      recordCorrection(ledger, origId, newResult, reason);
      lastRecommendation = null;
      renderAll();
    });
  });
}

// ================= 后验与性能图表 =================
function renderCharts() {
  if (document.getElementById('tab-posterior').classList.contains('active')) renderPosteriorCharts();
  if (document.getElementById('tab-evaluate').classList.contains('active')) {
    // 评估图表已在完成时渲染；主题切换需要重绘，缓存上次结果
    if (lastEval) renderEvalChart(lastEval);
    renderDpPanel(lastDp);
  }
}

let lastPost = null;
function renderPosteriorCharts() {
  let post;
  try {
    post = posterior(batch, assay, ledger, { enumCap: 4096, particles: 4000 });
  } catch (err) {
    $('posteriorChart').innerHTML = `<div class="board-msg">${esc(err.message)}</div>`;
    return;
  }
  lastPost = post;
  $('postMethodHint').textContent = post.method === 'exact'
    ? `精确贝叶斯后验，联合状态数 ${post.states.length}；相关性由潜在事件联合分布携带，未做独立同分布假设。`
    : `粒子后验（SIS），有效样本量 ESS=${fmt(post.ess, 0)} / ${post.particles}；相关性同样保留。`;

  const rows = batch.samples.map((s, i) => ({
    label: s.id,
    value: post.posterior[s.id],
    color: catColor(i),
    sub: `边际先验 ${(marginalRisk(s, batch.events) * 100).toFixed(2)}%`,
  }));
  horizontalBars($('posteriorChart'), rows, { max: 1, valueFmt: (v) => `${(v * 100).toFixed(1)}%` });
  $('posteriorTable').innerHTML = tableHtml(
    ['样品', '边际先验风险', '后验阳性概率', '剩余样量'],
    batch.samples.map((s) => [
      s.id,
      pct(marginalRisk(s, batch.events)),
      pct(post.posterior[s.id]),
      String(deriveVolume(ledger).remaining[s.id]),
    ]),
  );

  // 检测性能曲线（单数值轴，三条系列共用 0..1 概率轴，非双轴）
  const sizes = [1, 2, 3, 4, 6, 8].filter((k) => k <= assay.maxPoolSize);
  lineChart($('perfChart'), sizes.map((k) => ({ x: k, label: String(k) })), [
    { name: '灵敏度 Se(k)', color: 'var(--c1)', values: sizes.map((k) => sensitivityAt(assay, k)) },
    { name: '特异性 Sp(k) 清洁', color: 'var(--c3)', values: sizes.map((k) => specificityAt(assay, k, false)) },
    { name: '特异性 Sp(k) 污染轮', color: 'var(--c2)', values: sizes.map((k) => specificityAt(assay, k, true)) },
  ]);
  $('perfTable').innerHTML = tableHtml(
    ['池大小', '灵敏度', '特异性(清洁)', '特异性(污染)'],
    sizes.map((k) => [String(k), fmt(sensitivityAt(assay, k), 4), fmt(specificityAt(assay, k), 4), fmt(specificityAt(assay, k, true), 4)]),
  );

  const evRows = batch.events.map((e, i) => ({
    label: e.id, value: post.eventPosterior[e.id], color: catColor(i),
    sub: `先验概率 ${(e.probability * 100).toFixed(1)}%`,
  }));
  horizontalBars($('eventChart'), evRows, { max: 1, valueFmt: (v) => `${(v * 100).toFixed(1)}%` });
  $('eventTable').innerHTML = tableHtml(
    ['潜在事件', '先验概率', '后验概率', '抬升 lift'],
    batch.events.map((e) => [e.id, pct(e.probability), pct(post.eventPosterior[e.id]), fmt(e.lift, 2)]),
  );
}

// ================= 整批评估 =================
let lastEval = null;
let lastDp = null;

async function runEvaluation() {
  const replications = clampInt($('replicationsInput').value, 40, 2000, params.replications);
  const contaminationProb = clampNum($('contamInput').value, 0, 1, params.contaminationProb);
  const missBound = clampNum($('missBoundInput').value, 0.01, 2, params.missBound);
  frozen = true;
  const progress = $('evalProgress');
  progress.hidden = false;
  progress.innerHTML = `冻结当前风险/检测参数，正在重演 ${replications} 个虚构批次…<div class="progress-track"><div class="pfill"></div></div>`;
  await nextFrame();

  // 分块让出主线程，保留进度条响应；评估本身在引擎内同步完成
  const t0 = performance.now();
  const result = evaluateStrategies(batch, assay, {
    replications, contaminationProb, missBound, particles: 1200, seed: SEED,
  });
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  progress.innerHTML = `完成 ${replications} 次重演，用时 ${secs}s（种子 ${result.seed}）。${result.note}`;
  lastEval = result;
  renderEvalSummary(result);
  renderEvalChart(result);
  renderEvalTable(result);
  renderDpPanel(computeDp());
}

function renderEvalSummary(r) {
  const wrap = $('evalSummary');
  wrap.innerHTML = '';
  statTile(wrap, 'costmin', '费用最小 · 均费', fmt(r.costMin.meanSpend, 0), `P95 ${fmt(r.costMin.p95Spend, 0)}`);
  statTile(wrap, 'costmin', '费用最小 · 漏检率', pct(r.costMin.missRate), `每批 ${fmt(r.costMin.missPerBatch, 3)} 个`);
  statTile(wrap, 'costmin', '费用最小 · 样量耗尽率', pct(r.costMin.exhaustionRate), `误报率 ${pct(r.costMin.falsePositiveRate)}`);
  statTile(wrap, 'missbound', '漏检受限 · 均费', fmt(r.missBound.meanSpend, 0), `P95 ${fmt(r.missBound.p95Spend, 0)}`);
  statTile(wrap, 'missbound', '漏检受限 · 漏检率', pct(r.missBound.missRate), `每批 ${fmt(r.missBound.missPerBatch, 3)} 个`);
  statTile(wrap, 'missbound', '漏检受限 · 样量耗尽率', pct(r.missBound.exhaustionRate), `误报率 ${pct(r.missBound.falsePositiveRate)}`);
}

function renderEvalChart(r) {
  const groups = [
    { group: '均费', values: [r.costMin.meanSpend, r.missBound.meanSpend] },
    { group: 'P95费用', values: [r.costMin.p95Spend, r.missBound.p95Spend] },
    { group: '漏检率×100', label: '百分比刻度', values: [r.costMin.missRate * 100, r.missBound.missRate * 100] },
    { group: '耗尽率×100', label: '百分比刻度', values: [r.costMin.exhaustionRate * 100, r.missBound.exhaustionRate * 100] },
    { group: '误报率×100', label: '百分比刻度', values: [r.costMin.falsePositiveRate * 100, r.missBound.falsePositiveRate * 100] },
  ];
  // 费用与比率量纲不同 → 拆成两张图，杜绝双轴
  groupedBars($('evalChart'), groups.slice(0, 2), {
    series: ['费用最小', '漏检受限'],
    colors: ['var(--c1)', 'var(--c2)'],
    valueFmt: (v) => fmt(v, 0),
  });
  const second = document.createElement('div');
  second.className = 'chart';
  $('evalChart').appendChild(second);
  groupedBars(second, groups.slice(2), {
    series: ['费用最小', '漏检受限'],
    colors: ['var(--c1)', 'var(--c2)'],
    valueFmt: (v) => `${fmt(v, 1)}%`,
  });
}

function renderEvalTable(r) {
  $('evalTable').innerHTML = tableHtml(
    ['指标', '费用最小', '漏检受限'],
    [
      ['平均检测费', fmt(r.costMin.meanSpend, 1), fmt(r.missBound.meanSpend, 1)],
      ['P95 检测费', fmt(r.costMin.p95Spend, 1), fmt(r.missBound.p95Spend, 1)],
      ['平均检测次数', fmt(r.costMin.meanTests, 2), fmt(r.missBound.meanTests, 2)],
      ['漏检率', pct(r.costMin.missRate), pct(r.missBound.missRate)],
      ['每批漏检数', fmt(r.costMin.missPerBatch, 3), fmt(r.missBound.missPerBatch, 3)],
      ['单检误报率', pct(r.costMin.falsePositiveRate), pct(r.missBound.falsePositiveRate)],
      ['样量耗尽率', pct(r.costMin.exhaustionRate), pct(r.missBound.exhaustionRate)],
      ['中止率', pct(r.costMin.abortRate), pct(r.missBound.abortRate)],
    ],
  );
}

function computeDp() {
  if (lastDp) return lastDp;
  try {
    lastDp = exactOptimalPolicy(demoSmallBatch(), assay, { maxDepth: 4, missBound: 0.02 });
  } catch (err) {
    lastDp = { error: err.message };
  }
  return lastDp;
}

function renderDpPanel(dp) {
  if (!dp) { $('dpPanel').innerHTML = '<p class="hint">冻结评估后在此展示小样本枚举核对。</p>'; return; }
  if (dp.error) { $('dpPanel').innerHTML = `<div class="board-msg">${esc(dp.error)}</div>`; return; }
  const c = dp.costMinTree;
  const b = dp.missBoundTree;
  $('dpPanel').innerHTML = `
    <div class="dp-tree">
      <div class="kv"><span>访问信念状态数</span><b>${dp.statesVisited}</b></div>
      <div class="kv"><span>费用最小树 · 期望总代价</span><b>${fmt(c.expectedCost, 2)}</b></div>
      <div class="kv"><span>费用最小树 · 期望检测费</span><b>${fmt(c.expectedSpend, 2)}</b></div>
      <div class="kv"><span>费用最小树 · 期望漏检数</span><b>${fmt(c.expectedMisses, 4)}</b></div>
    </div>
    <div class="dp-tree">
      <div class="kv"><span>漏检受限约束</span><b>≤ ${dp.missBound}</b></div>
      <div class="kv"><span>受限树是否可行</span><b>${dp.boundFeasible ? '可行' : '受深度/样量限制不可达'}</b></div>
      ${b ? `<div class="kv"><span>受限树 · 期望检测费</span><b>${fmt(b.expectedSpend, 2)}</b></div>
             <div class="kv"><span>受限树 · 期望漏检数</span><b>${fmt(b.expectedMisses, 4)}</b></div>` : ''}
    </div>
    <p class="hint" style="margin-top:8px">${dp.note}</p>`;
}

async function runSensitivity() {
  const panel = $('sensPanel');
  panel.innerHTML = '<p class="hint">运行 9 个风险/事件情景（每情景重演次数较少，约需数秒）…</p>';
  await nextFrame();
  const sa = sensitivityAnalysis(demoSmallBatch(), assay, { replications: 40, particles: 600, seed: SEED });
  const ranges = [
    ['平均费用', sa.costMinRanges.meanSpend, (v) => fmt(v, 0)],
    ['漏检率', sa.costMinRanges.missRate, (v) => pct(v)],
    ['每批漏检数', sa.costMinRanges.missPerBatch, (v) => fmt(v, 3)],
    ['样量耗尽率', sa.costMinRanges.exhaustionRate, (v) => pct(v)],
  ];
  const globalMax = Math.max(...ranges.map(([, r]) => r.max));
  panel.innerHTML = `<div class="sens-range">${ranges.map(([label, r, f]) => {
    const left = (r.min / globalMax) * 100;
    const width = Math.max(3, ((r.max - r.min) / globalMax) * 100);
    return `<div class="sens-row"><span>${label}</span>
      <div class="sens-track"><div class="sens-range-mark" style="left:${left}%;width:${width}%"></div></div>
      <span class="sval">${f(r.min)} ~ ${f(r.max)}</span></div>`;
  }).join('')}</div>
  <p class="hint" style="margin-top:10px">${sa.disclaimer}。情景数：${sa.rows.length}（风险 0.5×/1×/2× × 事件 0.5×/1×/2×）。</p>`;
}

// ================= 通用渲染辅助 =================
function renderAll() {
  renderBoard();
  renderRecommendation();
  renderVolume();
  renderLedger();
  if (document.getElementById('tab-posterior').classList.contains('active')) renderPosteriorCharts();
  if (document.getElementById('tab-evaluate').classList.contains('active')) renderDpPanel(lastDp);
}

function tableHtml(headers, rows) {
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function esc(v) {
  return String(v).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function pct(v) { return `${(v * 100).toFixed(2)}%`; }
function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}
function clampNum(v, min, max, dflt) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}
function nextFrame() { return new Promise((res) => requestAnimationFrame(() => setTimeout(res, 30))); }

init();
