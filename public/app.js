'use strict';
/* global KilnGeom */

/* ================= 状态 ================= */
const state = {
  kiln: { width: 600, height: 450, startTemp: 20, targetTemp: 1300 },
  bodies: [],
  selectedId: null,
  previewTemp: null // null → 跟随目标温度
};
let currentPlan = null;
let nextId = 1;
let analysis = { contacts: [], earliest: null, involved: new Set(), wallContact: false, atStart: false };

const DEG = Math.PI / 180;
const uid = () => 'b' + nextId++;
const round1 = (v) => Math.round(v * 10) / 10;
const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const $ = (id) => document.getElementById(id);

/** 首次启动的示例方案：A↔B 约 934°C 接触，C 约 909°C 触窑壁 */
function samplePlan() {
  return {
    kiln: { width: 600, height: 450, startTemp: 20, targetTemp: 1300 },
    bodies: [
      { id: uid(), name: '茶碗 A', x: 150, y: 120, w: 120, h: 90, angle: 12, alpha: 6 },
      { id: uid(), name: '茶碗 B', x: 284.5, y: 125, w: 120, h: 110, angle: -8, alpha: 6 },
      { id: uid(), name: '花瓶 C', x: 554.7, y: 300, w: 90, h: 160, angle: 0, alpha: 7.5 },
      { id: uid(), name: '盘子 D', x: 200, y: 330, w: 150, h: 150, angle: 30, alpha: 5 }
    ]
  };
}

const selectedBody = () => state.bodies.find((b) => b.id === state.selectedId) || null;
const byId = (id) => state.bodies.find((b) => b.id === id) || null;
const bodyName = (id) => { const b = byId(id); return b ? b.name : '?'; };
const previewTemp = () => (state.previewTemp === null ? state.kiln.targetTemp : state.previewTemp);

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
const toMm = (px, py) => [(px - view.ox) / view.scale, (py - view.oy) / view.scale];

/* ================= 渲染 ================= */
function render() {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.w, view.h);
  ctx.fillStyle = '#0e1320';
  ctx.fillRect(0, 0, view.w, view.h);
  drawKiln();
  for (const b of state.bodies) drawBody(b);
  drawEarliestMarker();
  drawHandle();
}

function drawKiln() {
  const [kx, ky] = toPx(0, 0);
  const kw = state.kiln.width * view.scale;
  const kh = state.kiln.height * view.scale;

  ctx.fillStyle = '#161d2e';
  ctx.fillRect(kx, ky, kw, kh);

  // 100mm 网格
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

  // 窑壁：有触壁风险时高亮
  ctx.lineWidth = analysis.wallContact ? 3 : 2;
  ctx.strokeStyle = analysis.wallContact ? '#ff5252' : '#3a4a75';
  ctx.strokeRect(kx, ky, kw, kh);

  // 尺寸标注
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
  const selected = state.selectedId === b.id;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(b.angle * DEG);

  // 升温膨胀后的外廓（虚线）
  if (Math.abs(s - 1) > 1e-9) {
    ctx.strokeStyle = inEarliest ? 'rgba(255,82,82,0.9)' : 'rgba(255,209,102,0.55)';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect((-w * s) / 2, (-h * s) / 2, w * s, h * s);
    ctx.setLineDash([]);
  }

  // 起始温度下的坯体本体
  ctx.fillStyle = inEarliest ? 'rgba(255,82,82,0.85)'
    : involved ? 'rgba(255,152,0,0.8)'
      : 'rgba(79,140,255,0.72)';
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.lineWidth = selected ? 2.5 : 1.2;
  ctx.strokeStyle = selected ? '#ffd166' : 'rgba(255,255,255,0.6)';
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.restore();

  // 名称标签
  ctx.fillStyle = '#e8ecf5';
  ctx.font = '12px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(b.name, cx, cy);
}

/** 最早接触的提示连线：坯体间连中心线，触壁连到最近窑壁 */
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

/* ---- 旋转手柄 ---- */
function handlePos(b) {
  const a = b.angle * DEG;
  const r = (b.h / 2) * view.scale + 26;
  const [cx, cy] = toPx(b.x, b.y);
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

function drawHandle() {
  const b = selectedBody();
  if (!b) return;
  const [cx, cy] = toPx(b.x, b.y);
  const [hx, hy] = handlePos(b);
  ctx.strokeStyle = '#ffd166';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  ctx.fillStyle = '#ffd166';
  ctx.beginPath();
  ctx.arc(hx, hy, 6, 0, Math.PI * 2);
  ctx.fill();
}

/* ================= 交互 ================= */
function hitBody(b, mx, my) {
  const a = -b.angle * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = mx - b.x;
  const dy = my - b.y;
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
}

function normDeg(d) {
  d = ((d % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
}

let drag = null; // { mode:'move'|'rotate', id, dx, dy }

function eventPos(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

canvas.addEventListener('pointerdown', (e) => {
  const [px, py] = eventPos(e);
  const [mx, my] = toMm(px, py);
  const sel = selectedBody();
  if (sel) {
    const [hx, hy] = handlePos(sel);
    if (Math.hypot(px - hx, py - hy) <= 10) {
      drag = { mode: 'rotate', id: sel.id };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
  }
  for (let i = state.bodies.length - 1; i >= 0; i--) {
    const b = state.bodies[i];
    if (hitBody(b, mx, my)) {
      state.selectedId = b.id;
      drag = { mode: 'move', id: b.id, dx: b.x - mx, dy: b.y - my };
      canvas.setPointerCapture(e.pointerId);
      update();
      return;
    }
  }
  state.selectedId = null;
  update();
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const [px, py] = eventPos(e);
  const [mx, my] = toMm(px, py);
  const b = byId(drag.id);
  if (!b) return;
  if (drag.mode === 'move') {
    b.x = round1(mx + drag.dx);
    b.y = round1(my + drag.dy);
  } else {
    let deg = Math.atan2(mx - b.x, -(my - b.y)) / DEG;
    deg = e.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg * 10) / 10;
    b.angle = normDeg(deg);
  }
  update();
});

window.addEventListener('pointerup', () => { drag = null; });

canvas.addEventListener('wheel', (e) => {
  const b = selectedBody();
  if (!b) return;
  e.preventDefault();
  const step = e.shiftKey ? 0.5 : 5;
  b.angle = normDeg(round1(b.angle + (e.deltaY < 0 ? step : -step)));
  update();
}, { passive: false });

canvas.addEventListener('dblclick', (e) => {
  const [px, py] = eventPos(e);
  const [mx, my] = toMm(px, py);
  addBody({ x: round1(mx), y: round1(my) });
});

window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const b = selectedBody();
  if (!b) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    removeBody(b.id);
  } else if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') b.x = round1(b.x - step);
    if (e.key === 'ArrowRight') b.x = round1(b.x + step);
    if (e.key === 'ArrowUp') b.y = round1(b.y - step);
    if (e.key === 'ArrowDown') b.y = round1(b.y + step);
    update();
  }
});

/* ================= 坯体增删 ================= */
function addBody(props) {
  const b = Object.assign({
    id: uid(),
    name: '坯体 ' + (state.bodies.length + 1),
    x: round1(state.kiln.width / 2),
    y: round1(state.kiln.height / 2),
    w: 100,
    h: 80,
    angle: 0,
    alpha: 6
  }, props || {});
  state.bodies.push(b);
  state.selectedId = b.id;
  update();
}

function removeBody(id) {
  state.bodies = state.bodies.filter((b) => b.id !== id);
  if (state.selectedId === id) state.selectedId = null;
  update();
}

/* ================= 面板 ================= */
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

function contactLabel(c) {
  return c.type === 'wall'
    ? `${bodyName(c.a)} ↔ 窑壁`
    : `${bodyName(c.a)} ↔ ${bodyName(c.b)}`;
}

function renderBodyList() {
  const ul = $('bodyList');
  ul.innerHTML = '';
  for (const b of state.bodies) {
    const li = document.createElement('li');
    if (b.id === state.selectedId) li.classList.add('selected');

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

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = '删除';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeBody(b.id); });

    li.append(dot, name, dims, del);
    li.addEventListener('click', () => { state.selectedId = b.id; update(); });
    ul.appendChild(li);
  }
}

/* ---- 选中坯体编辑器 ---- */
const edFields = { name: $('edName'), x: $('edX'), y: $('edY'), w: $('edW'), h: $('edH'), angle: $('edAngle'), alpha: $('edAlpha') };

function syncEditor() {
  const b = selectedBody();
  $('editor').classList.toggle('hidden', !b);
  $('editorEmpty').style.display = b ? 'none' : '';
  if (!b) return;
  for (const [key, input] of Object.entries(edFields)) {
    if (document.activeElement !== input) input.value = b[key];
  }
}

function wireEditor() {
  edFields.name.addEventListener('input', () => {
    const b = selectedBody();
    if (b) { b.name = edFields.name.value; update(); }
  });
  for (const key of ['x', 'y', 'w', 'h', 'angle', 'alpha']) {
    edFields[key].addEventListener('input', () => {
      const b = selectedBody();
      if (!b) return;
      const v = parseFloat(edFields[key].value);
      if (!Number.isFinite(v)) return;
      if ((key === 'w' || key === 'h') && v <= 0) return;
      if (key === 'alpha' && v < 0) return;
      b[key] = key === 'angle' ? normDeg(v) : v;
      update();
    });
  }
  $('deleteBodyBtn').addEventListener('click', () => {
    const b = selectedBody();
    if (b) removeBody(b.id);
  });
}

/* ---- 窑室与温度 ---- */
function syncKilnInputs() {
  $('kilnWidth').value = state.kiln.width;
  $('kilnHeight').value = state.kiln.height;
  $('startTemp').value = state.kiln.startTemp;
  $('targetTemp').value = state.kiln.targetTemp;
}

function wireKiln() {
  const bind = (id, key, resize) => {
    $(id).addEventListener('input', () => {
      const v = parseFloat($(id).value);
      if (!Number.isFinite(v) || v <= 0) return;
      state.kiln[key] = v;
      if (resize) fitView();
      update();
    });
  };
  bind('kilnWidth', 'width', true);
  bind('kilnHeight', 'height', true);
  $('startTemp').addEventListener('input', () => {
    const v = parseFloat($('startTemp').value);
    if (Number.isFinite(v)) { state.kiln.startTemp = v; update(); }
  });
  $('targetTemp').addEventListener('input', () => {
    const v = parseFloat($('targetTemp').value);
    if (Number.isFinite(v)) { state.kiln.targetTemp = v; update(); }
  });
}

/* ---- 预览温度滑块 ---- */
function syncPreview() {
  const s = $('previewSlider');
  s.min = state.kiln.startTemp;
  s.max = state.kiln.targetTemp;
  s.step = 1;
  const v = Math.min(Math.max(previewTemp(), state.kiln.startTemp), state.kiln.targetTemp);
  if (document.activeElement !== s) s.value = v;
  $('previewLabel').textContent = `${fmt1(v)}°C`;
}

function wirePreview() {
  $('previewSlider').addEventListener('input', () => {
    state.previewTemp = parseFloat($('previewSlider').value);
    update();
  });
}

/* ================= 持久化 ================= */
let saveTimer = null;
function scheduleAutosave() {
  $('saveState').textContent = '未保存…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const res = await fetch('/api/autosave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: currentPlan || 'default', kiln: state.kiln, bodies: state.bodies })
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.status);
      currentPlan = j.name;
      $('saveState').textContent = '已自动保存 · ' + new Date().toLocaleTimeString();
      refreshPlanList();
    } catch (e) {
      $('saveState').textContent = '保存失败：' + e.message;
    }
  }, 500);
}

async function refreshPlanList() {
  try {
    const j = await fetch('/api/plans').then((r) => r.json());
    const sel = $('planSelect');
    sel.innerHTML = '';
    for (const name of j.plans) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      if (name === currentPlan) o.selected = true;
      sel.appendChild(o);
    }
  } catch (e) { /* 离线时忽略 */ }
}

function wirePlans() {
  $('loadPlanBtn').addEventListener('click', async () => {
    const name = $('planSelect').value;
    if (!name) return;
    const res = await fetch('/api/plans/' + encodeURIComponent(name));
    if (!res.ok) { alert('载入失败'); return; }
    currentPlan = name;
    $('planName').value = name;
    applyPlan(await res.json());
  });

  $('savePlanBtn').addEventListener('click', async () => {
    const name = ($('planName').value || currentPlan || '').trim();
    if (!name) { alert('请输入方案名称'); return; }
    const res = await fetch('/api/plans/' + encodeURIComponent(name), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kiln: state.kiln, bodies: state.bodies })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { alert('保存失败：' + (j.error || res.status)); return; }
    currentPlan = name;
    $('planName').value = name;
    refreshPlanList();
    scheduleAutosave();
  });

  $('newPlanBtn').addEventListener('click', () => {
    currentPlan = null;
    $('planName').value = '';
    applyPlan({ kiln: { width: 600, height: 450, startTemp: 20, targetTemp: 1300 }, bodies: [] });
  });

  $('deletePlanBtn').addEventListener('click', async () => {
    const name = $('planSelect').value;
    if (!name) return;
    if (!confirm(`删除方案「${name}」？`)) return;
    await fetch('/api/plans/' + encodeURIComponent(name), { method: 'DELETE' });
    if (currentPlan === name) currentPlan = null;
    refreshPlanList();
  });

  $('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ kiln: state.kiln, bodies: state.bodies }, null, 2)],
      { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (currentPlan || 'kiln-plan') + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!j.kiln || !Array.isArray(j.bodies)) throw new Error('bad format');
      applyPlan(j);
    } catch (err) {
      alert('JSON 格式不正确');
    }
  });
}

/* ================= 应用方案 / 主更新 ================= */
function applyPlan(plan) {
  state.kiln = Object.assign({}, plan.kiln);
  state.bodies = plan.bodies.map((b) => Object.assign({}, b));
  state.selectedId = null;
  state.previewTemp = null;
  nextId = state.bodies.reduce((m, b) => {
    const n = parseInt(String(b.id).slice(1), 10);
    return Number.isFinite(n) ? Math.max(m, n + 1) : m;
  }, 1);
  syncKilnInputs();
  fitView();
  update();
}

/** 任何参数修改后调用：立即重算 + 重绘 + 自动保存 */
function update() {
  analysis = KilnGeom.analyze(state.kiln, state.bodies);
  renderResults();
  renderBodyList();
  syncEditor();
  syncPreview();
  render();
  scheduleAutosave();
}

/* ================= 启动 ================= */
async function boot() {
  wireEditor();
  wireKiln();
  wirePreview();
  wirePlans();
  $('addBodyBtn').addEventListener('click', () => addBody());

  new ResizeObserver(resize).observe($('stage'));
  resize();

  let loaded = false;
  try {
    const j = await fetch('/api/plans').then((r) => r.json());
    if (j.current && j.plans.includes(j.current)) {
      const res = await fetch('/api/plans/' + encodeURIComponent(j.current));
      if (res.ok) {
        currentPlan = j.current;
        $('planName').value = j.current;
        applyPlan(await res.json());
        loaded = true;
      }
    }
  } catch (e) { /* 首次启动无数据 */ }
  if (!loaded) applyPlan(samplePlan());
  refreshPlanList();
}

boot();
