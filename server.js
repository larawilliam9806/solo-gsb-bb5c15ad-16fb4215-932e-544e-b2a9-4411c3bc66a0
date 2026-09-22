'use strict';
/*
 * 装窑预检服务端
 *  - 静态托管 public/ 下的单页应用
 *  - /api/plans 系列接口：方案增删查改，持久化到本地 data/plans.json
 *  - /api/autosave：画布任何修改后自动保存当前方案
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'plans.json');

/* ---------- 初始化：数据目录与 JSON 文件不存在则创建 ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ current: null, plans: {} }, null, 2));
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (j && typeof j === 'object' && j.plans && typeof j.plans === 'object') return j;
  } catch (e) {
    console.error('读取 plans.json 失败，使用空存储：', e.message);
  }
  return { current: null, plans: {} };
}
let store = load();

/* ---------- 防抖落盘（写临时文件后原子替换） ---------- */
let timer = null;
function persist() {
  clearTimeout(timer);
  timer = setTimeout(flush, 200);
}
function flush() {
  clearTimeout(timer);
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('写入 plans.json 失败：', e.message);
  }
}
process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });

/* ---------- 校验 ---------- */
const NAME_RE = /^[\w一-龥][\w一-龥 .\-]{0,39}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
function validName(n) {
  return typeof n === 'string' && NAME_RE.test(n) && !RESERVED.has(n);
}
function validBody(b) {
  return b && typeof b === 'object'
    && typeof b.id === 'string' && typeof b.name === 'string'
    && Number.isFinite(b.x) && Number.isFinite(b.y)
    && Number.isFinite(b.w) && b.w > 0
    && Number.isFinite(b.h) && b.h > 0
    && Number.isFinite(b.angle) && Number.isFinite(b.alpha);
}
function validPlan(p) {
  return p && typeof p === 'object'
    && p.kiln && typeof p.kiln === 'object'
    && Number.isFinite(p.kiln.width) && p.kiln.width > 0
    && Number.isFinite(p.kiln.height) && p.kiln.height > 0
    && Number.isFinite(p.kiln.startTemp) && Number.isFinite(p.kiln.targetTemp)
    && Array.isArray(p.bodies) && p.bodies.every(validBody);
}

app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- API ---------- */
app.get('/api/plans', (req, res) => {
  res.json({ current: store.current, plans: Object.keys(store.plans) });
});

app.get('/api/plans/:name', (req, res) => {
  const p = store.plans[req.params.name];
  if (!p) return res.status(404).json({ error: '方案不存在' });
  res.json(p);
});

app.put('/api/plans/:name', (req, res) => {
  if (!validName(req.params.name)) return res.status(400).json({ error: '方案名不合法' });
  if (!validPlan(req.body)) return res.status(400).json({ error: '方案数据不合法' });
  store.plans[req.params.name] = { kiln: req.body.kiln, bodies: req.body.bodies };
  store.current = req.params.name;
  persist();
  res.json({ ok: true, name: req.params.name });
});

app.delete('/api/plans/:name', (req, res) => {
  if (!(req.params.name in store.plans)) return res.status(404).json({ error: '方案不存在' });
  delete store.plans[req.params.name];
  if (store.current === req.params.name) store.current = null;
  persist();
  res.json({ ok: true });
});

/* 自动保存：客户端每次修改后调用，name 缺省写入 default */
app.post('/api/autosave', (req, res) => {
  if (!validPlan(req.body)) return res.status(400).json({ error: '方案数据不合法' });
  const name = validName(req.body.name) ? req.body.name : 'default';
  store.plans[name] = { kiln: req.body.kiln, bodies: req.body.bodies };
  store.current = name;
  persist();
  res.json({ ok: true, name });
});

app.listen(PORT, () => {
  console.log(`装窑预检已启动: http://localhost:${PORT}`);
  console.log(`方案数据文件: ${DATA_FILE}`);
});
