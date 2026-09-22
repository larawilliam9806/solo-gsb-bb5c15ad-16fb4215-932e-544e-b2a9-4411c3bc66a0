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
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'plans.json');

/* ---------- 初始化：数据目录与 JSON 文件不存在则创建 ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ current: null, plans: {}, shares: [] }, null, 2));
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (j && typeof j === 'object' && j.plans && typeof j.plans === 'object') {
      if (!Array.isArray(j.shares)) j.shares = [];
      return j;
    }
  } catch (e) {
    console.error('读取 plans.json 失败，使用空存储：', e.message);
  }
  return { current: null, plans: {}, shares: [] };
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

/* ---------- 只读分享令牌 ----------
 * 令牌只在创建时以明文返回一次，存储中仅保留 SHA-256 哈希；
 * 每条记录：{ id, plan, hash, createdAt, expiresAt(null=永不过期), revoked }
 */
const TOKEN_TTL_MIN = 1 / 60;      // 最短约 1 秒（管理界面仅提供分钟级选项）
const TOKEN_TTL_MAX = 525600;    // 最长 365 天
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
/** 生成 32 字节随机令牌（URL 安全 base64url）与 8 字节短 ID（管理页展示/撤销用） */
function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function newShareId() {
  return crypto.randomBytes(8).toString('hex');
}
/** 对外可展示的令牌信息（绝不包含哈希） */
function sharePublic(s) {
  return {
    id: s.id,
    plan: s.plan,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    revoked: !!s.revoked
  };
}
function findActiveShare(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const hash = hashToken(token);
  const a = Buffer.from(hash, 'hex');
  for (const s of store.shares) {
    if (s.hash.length !== 64) continue;
    const b = Buffer.from(s.hash, 'hex');
    if (b.length === a.length && crypto.timingSafeEqual(a, b)) return s;
  }
  return null;
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
  // 方案删除后，其全部分享令牌立即失效（保留记录用于审计，访问时返回 410）
  for (const s of store.shares) {
    if (s.plan === req.params.name) s.revoked = true;
  }
  persist();
  res.json({ ok: true });
});

/* ---------- 只读分享：管理端（创建 / 列出 / 撤销） ---------- */

/* 为指定方案创建分享令牌。body: { ttlMinutes }，省略或 null 表示永不过期 */
app.post('/api/plans/:name/shares', (req, res) => {
  const name = req.params.name;
  if (!validName(name)) return res.status(400).json({ error: '方案名不合法' });
  if (!(name in store.plans)) return res.status(404).json({ error: '方案不存在' });

  let ttlMinutes = null;
  if (req.body && req.body.ttlMinutes !== undefined && req.body.ttlMinutes !== null) {
    ttlMinutes = Number(req.body.ttlMinutes);
    if (!Number.isFinite(ttlMinutes) || ttlMinutes < TOKEN_TTL_MIN || ttlMinutes > TOKEN_TTL_MAX) {
      return res.status(400).json({ error: `过期分钟数需在 1 分钟 ~ ${TOKEN_TTL_MAX} 分钟（365 天）之间` });
    }
  }

  const now = Date.now();
  const token = newToken();
  const share = {
    id: newShareId(),
    plan: name,
    hash: hashToken(token),
    createdAt: now,
    expiresAt: ttlMinutes === null ? null : now + Math.round(ttlMinutes * 60000),
    revoked: false
  };
  store.shares.push(share);
  persist();
  res.status(201).json({
    share: sharePublic(share),
    token, // 明文令牌仅此一次返回
    url: `/share/${token}`
  });
});

/* 列出某方案的全部令牌（仅元信息，不含哈希与明文） */
app.get('/api/plans/:name/shares', (req, res) => {
  const name = req.params.name;
  if (!(name in store.plans)) return res.status(404).json({ error: '方案不存在' });
  const shares = store.shares
    .filter((s) => s.plan === name)
    .map(sharePublic)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ shares });
});

/* 撤销令牌（已撤销也返回成功，操作幂等） */
app.delete('/api/shares/:id', (req, res) => {
  const s = store.shares.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '分享不存在' });
  if (!s.revoked) { s.revoked = true; persist(); }
  res.json({ ok: true });
});

/* ---------- 只读分享：公开访问（无需登录，仅可只读） ---------- */

/* 每次请求都重新校验：哈希匹配 → 所属方案存在 → 未撤销 → 未过期 */
app.get('/api/shared/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const s = findActiveShare(req.params.token);
  if (!s) return res.status(404).json({ error: '分享链接无效' });
  if (s.revoked) return res.status(410).json({ error: '该分享链接已被撤销' });
  if (s.expiresAt !== null && Date.now() > s.expiresAt) {
    return res.status(410).json({ error: '该分享链接已过期' });
  }
  const plan = store.plans[s.plan];
  if (!plan) return res.status(410).json({ error: '方案已被删除' });
  // 返回方案当前内容——原方案被修改后，分享页轮询即可实时反映
  res.json({ plan: s.plan, kiln: plan.kiln, bodies: plan.bodies, serverTime: Date.now() });
});

/* 分享令牌不允许调用任何写入接口（PUT/POST/DELETE/PATCH） */
app.all('/api/shared/:token', (req, res) => {
  res.status(405).json({ error: '分享链接仅支持只读访问' });
});

/* 分享页（share.html 为纯静态页面，令牌校验全部在加载后走 /api/shared/:token） */
app.get('/share/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`装窑预检已启动: http://localhost:${PORT}`);
    console.log(`方案数据文件: ${DATA_FILE}`);
  });
}

module.exports = app;
