// charts.mjs — 纯 SVG 图表（零依赖）。每个图只使用一条数值轴；悬停有 tooltip；
// 颜色取 styles.css 中的分类/顺序 token，文本一律用文本色而非系列色。

const NS = 'http://www.w3.org/2000/svg';
const PALETTE = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'];

function cssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}
function catColor(i) {
  return cssVar(PALETTE[i % PALETTE.length]);
}
// SVG presentation 属性不支持 var()，这里把 "var(--token)" 解析成实际色值；
// 已是具体色值（hex 等）则原样返回。
function resolveColor(c) {
  if (!c) return c;
  const m = /^var\((--[\w-]+)\)$/.exec(c);
  return m ? cssVar(m[1]) : c;
}
function ink() { return cssVar('--ink'); }
function inkMuted() { return cssVar('--ink-muted'); }
function lineColor() { return cssVar('--line'); }

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  if (parent) parent.appendChild(node);
  return node;
}

function fmt(v, d = 3) {
  if (!Number.isFinite(v)) return '—';
  return Number(v).toFixed(d);
}

/** 全局 tooltip（页面中唯一的 #tooltip） */
const tooltip = () => document.getElementById('tooltip');
function showTip(evt, rows, title) {
  const tip = tooltip();
  tip.innerHTML =
    (title ? `<div class="tt-title">${title}</div>` : '') +
    rows.map(([k, v]) => `<div class="tt-row"><span>${k}</span><b>${v}</b></div>`).join('');
  tip.hidden = false;
  const pad = 14;
  const rect = tip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
function hideTip() { tooltip().hidden = true; }

/**
 * 水平条形图：单条数值轴（0..max），用于后验概率。
 * @param {HTMLElement} mount
 * @param {{label:string, value:number, color?:string, sub?:string}[]} rows
 * @param {{max?:number, title?:string, valueFmt?:(v:number)=>string}} [opts]
 */
export function horizontalBars(mount, rows, opts = {}) {
  mount.innerHTML = '';
  const max = opts.max ?? Math.max(0.0001, ...rows.map((r) => r.value)) * 1.08;
  const labelW = 64;
  const valueW = 52;
  const rowH = 30;
  const barH = 15;
  const width = Math.max(520, mount.clientWidth || 640);
  const height = rows.length * rowH + 28;
  const plotW = width - labelW - valueW - 24;
  const svg = el('svg', { width: '100%', viewBox: `0 0 ${width} ${height}`, role: 'img' }, mount);

  //  recessive 网格（0、0.25、0.5、0.75、1 风格的相对刻度）
  for (let t = 0; t <= 4; t++) {
    const x = labelW + (plotW * t) / 4;
    el('line', { x1: x, y1: 14, x2: x, y2: height - 18, class: 'grid-line' }, svg);
    el('text', { x, y: height - 4, 'text-anchor': 'middle', class: 'axis', text: fmt((max * t) / 4, 2) }, svg);
  }

  rows.forEach((r, i) => {
    const y = 12 + i * rowH;
    const w = Math.max(2, (r.value / max) * plotW);
    el('text', { x: labelW - 8, y: y + barH - 2, 'text-anchor': 'end', class: 'axis', style: `fill:${ink()}`, text: r.label }, svg);
    // 2px 表面间隙：条与条之间天然留 rowH-barH；条端圆角
    const rect = el('rect', {
      x: labelW, y, width: w, height: barH, rx: 4, ry: 4,
      fill: resolveColor(r.color ?? catColor(i)), class: 'bar-rect',
    }, svg);
    el('text', {
      x: labelW + w + 6, y: y + barH - 2, class: 'direct-label',
      text: opts.valueFmt ? opts.valueFmt(r.value) : fmt(r.value),
    }, svg);
    rect.addEventListener('mousemove', (e) =>
      showTip(e, [
        ['后验概率', fmt(r.value, 4)],
        ...(r.sub ? [['说明', r.sub]] : []),
      ], r.label));
    rect.addEventListener('mouseleave', hideTip);
  });
}

/**
 * 分组/多系列垂直条形图（单一数值轴）。用于策略对比、事件后验。
 * @param {HTMLElement} mount
 * @param {{group:string, values:number[], label?:string}[]} groups
 * @param {{series:string[], colors?:string[], valueFmt?:(v:number)=>string, unit?:string}} [opts]
 */
export function groupedBars(mount, groups, opts = {}) {
  mount.innerHTML = '';
  const series = opts.series;
  const colors = (opts.colors ?? series.map((_, i) => catColor(i))).map(resolveColor);
  const max = Math.max(0.0001, ...groups.flatMap((g) => g.values)) * 1.12;
  const width = Math.max(520, mount.clientWidth || 640);
  const groupW = Math.max(70, (width - 60) / groups.length);
  const height = 300;
  const m = { top: 18, right: 14, bottom: 46, left: 52 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const svg = el('svg', { width: '100%', viewBox: `0 0 ${width} ${height}`, role: 'img' }, mount);

  // 图例（>=2 系列恒显示）
  if (series.length >= 2) {
    const legend = el('g', { class: 'legend' }, svg);
    series.forEach((s, i) => {
      const lx = m.left + i * 132;
      el('rect', { x: lx, y: 2, width: 11, height: 11, rx: 2, fill: colors[i] }, legend);
      el('text', { x: lx + 16, y: 11, class: 'axis', style: `fill:${inkMuted()}`, text: s }, legend);
    });
  }

  for (let t = 0; t <= 4; t++) {
    const y = m.top + plotH - (plotH * t) / 4;
    el('line', { x1: m.left, y1: y, x2: width - m.right, y2: y, class: 'grid-line' }, svg);
    el('text', { x: m.left - 7, y: y + 3.5, 'text-anchor': 'end', class: 'axis', text: fmt((max * t) / 4, 2) }, svg);
  }
  el('line', { x1: m.left, y1: m.top, x2: m.left, y2: m.top + plotH, class: 'grid-line' }, svg);
  el('line', { x1: m.left, y1: m.top + plotH, x2: width - m.right, y2: m.top + plotH, class: 'grid-line' }, svg);

  const innerW = groupW * 0.66;
  const barW = Math.max(6, (innerW / series.length) - 2); // 2px 表面间隙
  groups.forEach((g, gi) => {
    const gx = m.left + gi * groupW + (groupW - innerW) / 2;
    g.values.forEach((v, si) => {
      const h = Math.max(0, (v / max) * plotH);
      const x = gx + si * (barW + 2);
      const y = m.top + plotH - h;
      const rect = el('rect', { x, y, width: barW, height: Math.max(1.5, h), rx: 4, ry: 4, fill: colors[si] }, svg);
      rect.addEventListener('mousemove', (e) =>
        showTip(e, [
          [series[si], opts.valueFmt ? opts.valueFmt(v) : fmt(v)],
          ...(g.label ? [['分组', g.label]] : []),
        ], g.group));
      rect.addEventListener('mouseleave', hideTip);
    });
    el('text', {
      x: gx + innerW / 2, y: m.top + plotH + 17, 'text-anchor': 'middle',
      class: 'axis', style: `fill:${inkMuted()}`, text: g.group,
    }, svg);
  });
}

/**
 * 折线图（单数值轴），用于检测性能 Se/Sp 随池大小变化。
 * @param {HTMLElement} mount
 * @param {{x:number, label?:string}[]} xs
 * @param {{name:string, color?:string, values:number[]}[]} series
 */
export function lineChart(mount, xs, series) {
  mount.innerHTML = '';
  const width = Math.max(520, mount.clientWidth || 640);
  const height = 300;
  const m = { top: 20, right: 16, bottom: 44, left: 52 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const yMin = Math.min(0.85, ...series.flatMap((s) => s.values)) - 0.01;
  const yMax = 1.0;
  const xAt = (i) => m.left + (plotW * i) / Math.max(1, xs.length - 1);
  const yAt = (v) => m.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  const svg = el('svg', { width: '100%', viewBox: `0 0 ${width} ${height}`, role: 'img' }, mount);

  const legend = el('g', { class: 'legend' }, svg);
  series.forEach((s, i) => {
    const lx = m.left + i * 175;
    el('rect', { x: lx, y: 4, width: 11, height: 11, rx: 2, fill: resolveColor(s.color ?? catColor(i)) }, legend);
    el('text', { x: lx + 16, y: 13, class: 'axis', style: `fill:${inkMuted()}`, text: s.name }, legend);
  });

  for (let t = 0; t <= 4; t++) {
    const v = yMin + ((yMax - yMin) * t) / 4;
    const y = yAt(v);
    el('line', { x1: m.left, y1: y, x2: width - m.right, y2: y, class: 'grid-line' }, svg);
    el('text', { x: m.left - 7, y: y + 3.5, 'text-anchor': 'end', class: 'axis', text: v.toFixed(3) }, svg);
  }
  el('line', { x1: m.left, y1: m.top, x2: m.left, y2: m.top + plotH, class: 'grid-line' }, svg);
  el('line', { x1: m.left, y1: m.top + plotH, x2: width - m.right, y2: m.top + plotH, class: 'grid-line' }, svg);
  xs.forEach((x, i) =>
    el('text', { x: xAt(i), y: m.top + plotH + 17, 'text-anchor': 'middle', class: 'axis', text: x.label ?? String(x.x) }, svg));

  series.forEach((s, si) => {
    const color = resolveColor(s.color ?? catColor(si));
    const d = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${yAt(v)}`).join(' ');
    el('path', { d, fill: 'none', stroke: color, 'stroke-width': 2 }, svg); // 2px 细线
    s.values.forEach((v, i) => {
      const c = el('circle', { cx: xAt(i), cy: yAt(v), r: 4.5, fill: color, stroke: cssVar('--surface'), 'stroke-width': 2 }, svg);
      c.addEventListener('mousemove', (e) =>
        showTip(e, [
          ['池大小', String(xs[i].x)],
          [s.name, fmt(v, 4)],
        ]));
      c.addEventListener('mouseleave', hideTip);
    });
  });
}

/** 简易 KPI 磁贴（不是图表，无 tooltip 要求） */
export function statTile(container, cls, label, value, sub = '') {
  const tile = document.createElement('div');
  tile.className = `stat-tile ${cls}`;
  tile.innerHTML = `<div class="t-label">${label}</div><div class="t-value">${value}</div>${sub ? `<div class="t-sub">${sub}</div>` : ''}`;
  container.appendChild(tile);
}

export { fmt, catColor };
