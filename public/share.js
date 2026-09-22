'use strict';
/* global KilnGeom */
/*
 * 只读分享页：
 *  - 从地址栏 /share/:token 取令牌，拉取 /api/shared/:token
 *  - 无任何写入调用；所有交互（拖拽/编辑/自动保存）均不存在
 *  - 每 4 秒轮询一次，页面重新可见时立即拉取，原方案修改实时反映
 */

const state = {
  kiln: { width: 600, height: 450, startTemp: 20, targetTemp: 1300 },
  bodies: [],
  previewTemp: null
};
let analysis = { contacts: [], earliest: null, involved: new Set(), wallContact: false, atStart: false };

const DEG = Math.PI / 180;
const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const $ = (id) => document.getElementById(id);
const previewTemp = () => (state.previewTemp === null ? state.kiln.targetTemp : state.previewTemp);
const byId = (id) => state.bodies.find((b) => b.id === id) || null;
const bodyName = (id) => { const b = byId(id); return b ? b.name : '?'; };

const token = decodeURIComponent(location.pathname.replace(/^\/share\//, ''));

/* ================= 画布视图 ================= */
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const view = { scale: 1, ox: 0, oy: 0, w: 0, h: 0, dpr: 1 };

function fitView() {
  const pad = 70;
  const s = Math.min((view.w - pad * 2) / state.kiln.width, (view.h - pad * 2) / state.kiln.height);
  view.scale = Math.max(s, 0.01);
  view.ox = (view.w - state.kiln.width * view.scale) / 2;
  view.oy = (view.h - state.kiln.height * view.scale) / 2;
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  view.w = r.width;
  view.h = r.height;
  view.dpr = dpr;
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  fitView();
  render();
}

const toPx = (x, y) => [view.ox + x * view.scale, view.oy + y * view.scale];

/* ================= 渲染（只读，无选中/手柄） ================= */
function render() {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.w, view.h);
  ctx.fillStyle = '#0e1320';
  ctx.fillRect(0, 0, view.w, view.h);
  drawKiln();
  for (const b of state.bodies) drawBody(b);
  drawEarliestMarker();
}

function drawKiln() {
  const [kx, ky] = toPx(0, 0);
  const kw = state.kiln.width * view.scale;
  const kh = state.kiln.height * view.scale;

  ctx.fillStyle = '#161d2e';
  ctx.fillRect(kx, ky, kw, kh);

  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 100; x < state.kiln.width; x += 100) {
    const [px] = toPx(x, 0);
    ctx.moveTo(px, ky);
    ctx.lineTo(px, ky + kh);
  }
  for (let y = 100; y < state.kiln.height; y += 100) {
    const [, py] = toPx(0, y);
    ctx.moveTo(kx, py);
    ctx.lineTo(kx + kw, py);
  }
  ctx.stroke();

  ctx.lineWidth = analysis.wallContact ? 3 : 2;
  ctx.strokeStyle = analysis.wallContact ? '#ff5252' : '#3a4a75';
  ctx.strokeRect(kx, ky, kw, kh);

  ctx.fillStyle = '#8fa0c5';
  ctx.font = '12px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${state.kiln.width} mm`, kx + kw / 2, ky - 6);
  ctx.save();
  ctx.translate(kx - 10, ky + kh / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = 'top';
  ctx.fillText(`${state.kiln.height} mm`, 0, 0);
  ctx.restore();
}

function drawBody(b) {
  const T = previewTemp();
  const s = KilnGeom.scaleAt(b.alpha, T, state.kiln.startTemp);
  const [cx, cy] = toPx(b.x, b.y);
  const w = b.w * view.scale;
  const h = b.h * view.scale;
  const involved = analysis.involved.has(b.id);
  const inEarliest = analysis.earliest &&
    (analysis.earliest.a === b.id || analysis.earliest.b === b.id);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(b.angle * DEG);

  if (Math.abs(s - 1) > 1e-9) {
    ctx.strokeStyle = inEarliest ? 'rgba(255,82,82,0.9)' : 'rgba(255,209,102,0.55)';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect((-w * s) / 2, (-h * s) / 2, w * s, h * s);
    ctx.setLineDash([]);
  }

  ctx.fillStyle = inEarliest ? 'rgba(255,82,82,0.85)'
    : involved ? 'rgba(255,152,0,0.8)'
      : 'rgba(79,140,255,0.72)';
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.restore();

  ctx.fillStyle = '#e8ecf5';
  ctx.font = '12px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(b.name, cx, cy);
}

function drawEarliestMarker() {
  const c = analysis.earliest;
  if (!c) return;
  const a = byId(c.a);
  if (!a) return;
  const [ax, ay] = toPx(a.x, a.y);
  let tx;
  let ty;
  if (c.type === 'body') {
    const b = byId(c.b);
    if (!b) return;
    [tx, ty] = toPx(b.x, b.y);
  } else {
    const d = [a.x, state.kiln.width - a.x, a.y, state.kiln.height - a.y];
    const m = Math.min(...d);
    let wx = a.x;
    let wy = a.y;
    if (m === d[0]) wx = 0;
    else if (m === d[1]) wx = state.kiln.width;
    else if (m === d[2]) wy = 0;
    else wy = state.kiln.height;
    [tx, ty] = toPx(wx, wy);
  }
  ctx.strokeStyle = '#ff5252';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  ctx.setLineDash([]);
}

/* ================= 面板 ================= */
function contactLabel(c) {
  return c.type === 'wall'
    ? `${bodyName(c.a)} ↔ 窑壁`
    : `${bodyName(c.a)} ↔ ${bodyName(c.b)}`;
}

function renderKilnInfo() {
  const k = state.kiln;
  $('kilnInfo').innerHTML =
    `<div class="ro-row"><span>窑室宽度</span><span>${k.width} mm</span></div>` +
    `<div class="ro-row"><span>窑室高度</span><span>${k.height} mm</span></div>` +
    `<div class="ro-row"><span>起始温度</span><span>${fmt1(k.startTemp)} °C</span></div>` +
    `<div class="ro-row"><span>目标温度</span><span>${fmt1(k.targetTemp)} °C</span></div>`;
}

function renderResults() {
  const verdict = $('verdict');
  const list = $('contactList');
  const T0 = state.kiln.startTemp;
  const T1 = state.kiln.targetTemp;
  list.innerHTML = '';

  if (T1 <= T0) {
    verdict.className = 'verdict bad';
    verdict.textContent = '⚠ 目标温度需高于起始温度';
    return;
  }
  if (!analysis.earliest) {
    verdict.className = 'verdict ok';
    verdict.textContent = `✓ 升至目标温度 ${fmt1(T1)}°C 全程无接触`;
    return;
  }
  verdict.className = 'verdict bad';
  verdict.textContent = `✗ 最早接触温度 ${fmt1(analysis.earliest.temp)}°C — ${contactLabel(analysis.earliest)}`;

  analysis.contacts.forEach((c, i) => {
    const li = document.createElement('li');
    if (c.temp <= T0) li.className = 'at-start';
    else if (i === 0) li.className = 'earliest';
    li.textContent = `${c.temp <= T0 ? '⚠ 初始已接触 ' : ''}${contactLabel(c)} · ${fmt1(c.temp)}°C`;
    list.appendChild(li);
  });
}

function renderBodyList() {
  const ul = $('bodyList');
  ul.classList.add('ro');
  ul.innerHTML = '';
  for (const b of state.bodies) {
    const li = document.createElement('li');

    const dot = document.createElement('span');
    const inEarliest = analysis.earliest &&
      (analysis.earliest.a === b.id || analysis.earliest.b === b.id);
    dot.className = 'dot ' + (inEarliest ? 'bad' : analysis.involved.has(b.id) ? 'warn' : 'ok');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = b.name;

    const dims = document.createElement('span');
    dims.className = 'dims';
    dims.textContent = `${b.w}×${b.h} ∠${b.angle}°`;

    li.append(dot, name, dims);
    ul.appendChild(li);
  }
}

/* ---- 预览温度滑块：纯本地，不触发任何网络请求 ---- */
function syncPreview() {
  const s = $('previewSlider');
  s.min = state.kiln.startTemp;
  s.max = state.kiln.targetTemp;
  s.step = 1;
  const v = Math.min(Math.max(previewTemp(), state.kiln.startTemp), state.kiln.targetTemp);
  if (document.activeElement !== s) s.value = v;
  $('previewLabel').textContent = `${fmt1(v)}°C`;
}
$('previewSlider').addEventListener('input', () => {
  state.previewTemp = parseFloat($('previewSlider').value);
  syncPreview();
  render();
});

function applyData(data) {
  state.kiln = Object.assign({}, data.kiln);
  state.bodies = data.bodies.map((b) => Object.assign({}, b));
  state.previewTemp = null;
  $('sharePlanName').textContent = data.plan;
  document.title = `${data.plan} · 装窑方案只读分享`;
  analysis = KilnGeom.analyze(state.kiln, state.bodies);
  renderKilnInfo();
  renderResults();
  renderBodyList();
  syncPreview();
  fitView();
  render();
  $('updatedAt').textContent = '更新于 ' + new Date().toLocaleTimeString();
}

/* ================= 轮询拉取（只读） ================= */
const POLL_MS = 4000;
let alive = true;
let lastErrorAt = 0;

function setLiveState(kind) {
  const el = $('liveState');
  if (kind === 'live') {
    el.innerHTML = '<span class="dot-pulse"></span>实时同步中';
  } else if (kind === 'stale') {
    el.innerHTML = '<span class="dot-pulse stale"></span>连接中断，重试中…';
  } else {
    el.innerHTML = '<span class="dot-pulse dead"></span>已停止';
  }
}

function showFatal(msg) {
  alive = false;
  $('fatalMsg').textContent = msg;
  $('fatal').classList.remove('hidden');
  setLiveState('dead');
}

async function pull() {
  if (!alive) return;
  try {
    const res = await fetch('/api/shared/' + encodeURIComponent(token), { cache: 'no-store' });
    if (res.status === 404) { showFatal('分享链接无效'); return; }
    if (res.status === 410) {
      const j = await res.json().catch(() => ({}));
      showFatal(j.error || '该分享链接已不可用');
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    applyData(data);
    setLiveState('live');
    lastErrorAt = 0;
  } catch (e) {
    // 网络抖动：保留当前画面，标记重试
    if (!lastErrorAt) lastErrorAt = Date.now();
    setLiveState('stale');
  }
}

new ResizeObserver(resize).observe($('stage'));
resize();
setLiveState('stale');
pull();
setInterval(pull, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') pull();
});
