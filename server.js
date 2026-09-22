'use strict';
/*
 * 装窑预检服务端
 *  - 静态托管 public/ 下的单页应用
 *  - /api/plans 系列接口：方案增删查改，持久化到本地 data/plans.json
 *  - /api/autosave：画布任何修改后自动保存当前方案
 *  - /api/shares：只读分享令牌的生成 / 列出 / 撤销（仅保存令牌哈希）
 *  - /api/share/:token：令牌只读取方案，每次请求校验哈希、所属方案、撤销与过期
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
  let j = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.plans && typeof parsed.plans === 'object') j = parsed;
  } catch (e) {
    console.error('读取 plans.json 失败，使用空存储：', e.message);
  }
  if (!j) j = { current: null, plans: {} };
  // 旧版数据文件没有 shares 字段，直接补空数组，历史方案照常载入
  if (!Array.isArray(j.shares)) j.shares = [];
  return j;
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

/* ---------- 只读分享令牌 ---------- */
// 令牌仅保存 SHA-256 哈希；32 字节随机数经 base64url 编码后作为明文一次性返回
const TOKEN_BYTES = 32;
const MIN_EXPIRE_MIN = 1;
const MAX_EXPIRE_MIN = 525600; // 365 天；null 表示永不过期

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function shareState(rec, now) {
  if (rec.revoked) return 'revoked';
  if (rec.expiresAt !== null && rec.expiresAt <= now) return 'expired';
  return 'active';
}

/** 对外的分享元数据（绝不包含哈希） */
function shareInfo(rec, now) {
  return {
    id: rec.id,
    plan: rec.plan,
    createdAt: rec.createdAt,
    expiresAt: rec.expiresAt,
    revoked: !!rec.revoked,
    revokedAt: rec.revokedAt || null,
    state: shareState(rec, now)
  };
}

/**
 * 令牌校验：每次请求都重新比对哈希、所属方案、撤销状态与过期时间。
 * 通过返回 { plan, name }，否则按失败原因返回对应 HTTP 状态码。
 */
function resolveShareToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) {
    return { status: 404, error: '分享链接无效' };
  }
  const digest = hashToken(token);
  const rec = store.shares.find((s) => s.hash === digest);
  if (!rec) return { status: 404, error: '分享链接无效' };
  const now = Date.now();
  if (rec.revoked) return { status: 410, error: '该分享链接已被撤销' };
  if (rec.expiresAt !== null && rec.expiresAt <= now) {
    return { status: 410, error: '该分享链接已过期' };
  }
  const plan = store.plans[rec.plan];
  if (!plan) return { status: 410, error: '该分享对应的方案已删除' };
  return { plan, name: rec.plan };
}

app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* 分享页（/s/:token）：静态目录下无对应文件，静态中间件会放行到此路由 */
app.get('/s/:token', (req, res, next) => {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(req.params.token)) return next();
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

/* ---------- API ---------- */

/* 只读分享访问：令牌本身即凭证，任何非 GET 方法一律拒绝，令牌无法调用写入接口 */
app.all('/api/share/:token', (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: '分享链接只读，不支持写入' });
  }
  const result = resolveShareToken(req.params.token);
  if (result.error) return res.status(result.status).json({ error: result.error });
  // 直接返回 store 中最新方案数据：原方案被修改后，分享页下次请求即可看到
  res.json({ name: result.name, kiln: result.plan.kiln, bodies: result.plan.bodies });
});

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

/* ---------- 只读分享管理 ---------- */
/* 列出分享令牌元数据，可按 ?plan=方案名 过滤 */
app.get('/api/shares', (req, res) => {
  const now = Date.now();
  let list = store.shares;
  if (typeof req.query.plan === 'string' && req.query.plan) {
    if (!validName(req.query.plan)) return res.status(400).json({ error: '方案名不合法' });
    list = list.filter((s) => s.plan === req.query.plan);
  }
  res.json({ shares: list.map((s) => shareInfo(s, now)) });
});

/* 为指定方案生成分享令牌；明文令牌仅此一次返回，存储中只保留哈希 */
app.post('/api/shares', (req, res) => {
  const body = req.body;
  const plan = body && body.plan;
  if (!validName(plan) || !(plan in store.plans)) {
    return res.status(400).json({ error: '方案不存在或名称不合法' });
  }
  let expiresAt = null;
  if (body.expireMinutes !== null && body.expireMinutes !== undefined) {
    const m = Number(body.expireMinutes);
    if (!Number.isFinite(m) || m < MIN_EXPIRE_MIN || m > MAX_EXPIRE_MIN) {
      return res.status(400).json({ error: `有效期需为 ${MIN_EXPIRE_MIN}–${MAX_EXPIRE_MIN} 分钟` });
    }
    expiresAt = Date.now() + Math.round(m * 60000);
  }
  const token = newToken();
  const rec = {
    id: crypto.randomUUID(),
    plan,
    hash: hashToken(token),
    createdAt: Date.now(),
    expiresAt,
    revoked: false,
    revokedAt: null
  };
  store.shares.push(rec);
  persist();
  res.status(201).json({ token, url: `/s/${token}`, share: shareInfo(rec, Date.now()) });
});

/* 主动撤销分享（幂等：重复撤销已撤销的令牌也返回成功） */
app.delete('/api/shares/:id', (req, res) => {
  const rec = store.shares.find((s) => s.id === req.params.id);
  if (!rec) return res.status(404).json({ error: '分享不存在' });
  if (!rec.revoked) {
    rec.revoked = true;
    rec.revokedAt = Date.now();
    persist();
  }
  res.json({ ok: true });
});

/* 供测试使用：require 本文件不自动监听，直接启动时才拉起服务 */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`装窑预检已启动: http://localhost:${PORT}`);
    console.log(`方案数据文件: ${DATA_FILE}`);
  });
}

module.exports = app;
