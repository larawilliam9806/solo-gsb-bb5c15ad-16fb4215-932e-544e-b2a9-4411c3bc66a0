'use strict';
/*
 * 只读分享令牌的端到端测试（启动内存中的 Express 实例，使用独立临时数据目录）
 * 运行：node test/shares.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// 必须在 require server.js 之前设置独立数据目录
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-share-'));
process.env.DATA_DIR = DATA_DIR;
process.env.PORT = '0';
process.env.NODE_ENV = 'test';

const http = require('http');
const app = require('../server.js');

const KILN = { width: 600, height: 450, startTemp: 20, targetTemp: 1300 };
const bodies = [
  { id: 'b1', name: '茶碗 A', x: 150, y: 120, w: 120, h: 90, angle: 12, alpha: 6 }
];

let server;
let base;

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(base + urlPath, {
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {}
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (e) { /* 非 JSON（如 HTML） */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text: data });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function restart() {
  return new Promise((resolve) => {
    server.close(() => {
      delete require.cache[require.resolve('../server.js')];
      const app2 = require('../server.js');
      server = app2.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });
}

(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  /* 1. 先保存一个方案 */
  let r = await req('PUT', '/api/plans/demo', { kiln: KILN, bodies });
  assert.strictEqual(r.status, 200, '保存方案应成功');

  /* 2. 生成分享链接（有效期 60 分钟），明文令牌只返回一次 */
  r = await req('POST', '/api/shares', { plan: 'demo', expireMinutes: 60 });
  assert.strictEqual(r.status, 201, '应返回 201');
  assert(typeof r.json.token === 'string' && r.json.token.length >= 32, '应返回随机令牌');
  assert.strictEqual(r.json.url, `/s/${r.json.token}`, '应返回分享路径');
  assert.strictEqual(r.json.share.plan, 'demo');
  assert.strictEqual(r.json.share.revoked, false);
  assert(typeof r.json.share.expiresAt === 'number', '应有过期时间');
  assert.ok(!('hash' in r.json.share), '元数据不得包含哈希');
  const token = r.json.token;
  const shareId = r.json.share.id;

  /* 3. 落盘文件中只保存哈希，不保存明文令牌 */
  await sleep(300); // 越过服务端落盘防抖窗口
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'plans.json'), 'utf8'));
  assert(Array.isArray(raw.shares) && raw.shares.length === 1, 'shares 应持久化');
  assert.strictEqual(raw.shares[0].hash, crypto.createHash('sha256').update(token).digest('hex'),
    '存储的应为令牌的 SHA-256 哈希');
  assert.ok(!JSON.stringify(raw).includes(token), '数据文件中不得出现明文令牌');

  /* 4. 令牌只读 GET：可查看方案当前数据 */
  r = await req('GET', `/api/share/${token}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.name, 'demo');
  assert.deepStrictEqual(r.json.kiln, KILN);
  assert.deepStrictEqual(r.json.bodies, bodies);

  /* 5. 令牌不能调用任何写入接口：PUT/POST/DELETE/PATCH 一律 405 */
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const wr = await req(m, `/api/share/${token}`, { kiln: KILN, bodies });
    assert.strictEqual(wr.status, 405, `${m} 应被拒绝`);
    assert(/只读/.test(wr.json.error), '应提示只读');
  }

  /* 6. 原方案修改后，分享链接下次请求即反映最新内容 */
  const bodies2 = [{ id: 'b1', name: '茶碗 A（改）', x: 200, y: 200, w: 120, h: 90, angle: 12, alpha: 6 }];
  r = await req('PUT', '/api/plans/demo', { kiln: KILN, bodies: bodies2 });
  assert.strictEqual(r.status, 200);
  r = await req('GET', `/api/share/${token}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.bodies[0].name, '茶碗 A（改）', '分享应实时反映方案修改');

  /* 7. 列出分享（按方案过滤），元数据不含哈希 */
  r = await req('GET', '/api/shares?plan=demo');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.shares.length, 1);
  assert.strictEqual(r.json.shares[0].state, 'active');
  assert.ok(!('hash' in r.json.shares[0]), '列表不得泄露哈希');
  r = await req('GET', '/api/shares?plan=other');
  assert.strictEqual(r.json.shares.length, 0, '按方案过滤应正确');

  /* 8. 主动撤销后令牌立即失效（410） */
  r = await req('DELETE', `/api/shares/${shareId}`);
  assert.strictEqual(r.status, 200);
  r = await req('GET', `/api/share/${token}`);
  assert.strictEqual(r.status, 410, '撤销后应 410');
  assert(/撤销/.test(r.json.error));
  r = await req('GET', '/api/shares?plan=demo');
  assert.strictEqual(r.json.shares[0].state, 'revoked');
  // 撤销幂等
  r = await req('DELETE', `/api/shares/${shareId}`);
  assert.strictEqual(r.status, 200);

  /* 9. 过期校验：把磁盘上该令牌改为已过期，重启服务后应 410（每次请求都校验过期时间） */
  r = await req('POST', '/api/shares', { plan: 'demo', expireMinutes: 1 });
  assert.strictEqual(r.status, 201);
  const token2 = r.json.token;
  await sleep(300);
  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'plans.json'), 'utf8'));
  onDisk.shares.find((s) => s.hash === crypto.createHash('sha256').update(token2).digest('hex'))
    .expiresAt = Date.now() - 1000;
  fs.writeFileSync(path.join(DATA_DIR, 'plans.json'), JSON.stringify(onDisk));
  await restart();
  r = await req('GET', `/api/share/${token2}`);
  assert.strictEqual(r.status, 410, '过期链接应 410');
  assert(/过期/.test(r.json.error));

  /* 10. 永不过期：expireMinutes = null */
  r = await req('POST', '/api/shares', { plan: 'demo', expireMinutes: null });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.share.expiresAt, null);
  r = await req('GET', `/api/share/${r.json.token}`);
  assert.strictEqual(r.status, 200, '永久链接应可访问');

  /* 11. 非法有效期与非法方案名 */
  r = await req('POST', '/api/shares', { plan: 'demo', expireMinutes: 0 });
  assert.strictEqual(r.status, 400);
  r = await req('POST', '/api/shares', { plan: 'demo', expireMinutes: 999999 });
  assert.strictEqual(r.status, 400);
  r = await req('POST', '/api/shares', { plan: 'nope', expireMinutes: 60 });
  assert.strictEqual(r.status, 400, '不存在的方案不能创建分享');
  r = await req('POST', '/api/shares', { plan: '../evil', expireMinutes: 60 });
  assert.strictEqual(r.status, 400);

  /* 12. 随机伪造的令牌、格式异常的令牌均 404 */
  r = await req('GET', `/api/share/${crypto.randomBytes(32).toString('base64url')}`);
  assert.strictEqual(r.status, 404);
  r = await req('GET', '/api/share/short');
  assert.strictEqual(r.status, 404);

  /* 13. 方案被删除后，其分享链接 410 */
  r = await req('POST', '/api/shares', { plan: 'demo', expireMinutes: 60 });
  const token3 = r.json.token;
  r = await req('DELETE', '/api/plans/demo');
  assert.strictEqual(r.status, 200);
  r = await req('GET', `/api/share/${token3}`);
  assert.strictEqual(r.status, 410, '方案删除后分享应 410');

  /* 14. 分享页 HTML 可正常返回，且未知令牌不影响静态页访问 */
  r = await req('GET', `/s/${token3}`);
  assert.strictEqual(r.status, 200);
  assert(/<!DOCTYPE html>/.test(r.text), '应返回分享页 HTML');
  r = await req('GET', '/s/ab');
  assert.strictEqual(r.status, 404, '格式非法的分享路径不应返回分享页');

  /* 15. 旧版数据文件（无 shares 字段）载入不报错，历史方案可分享 */
  await sleep(300);
  fs.writeFileSync(path.join(DATA_DIR, 'plans.json'),
    JSON.stringify({ current: 'legacy', plans: { legacy: { kiln: KILN, bodies } } }));
  await restart();
  r = await req('GET', '/api/plans/legacy');
  assert.strictEqual(r.status, 200, '旧方案应正常载入');
  r = await req('GET', '/api/shares');
  assert.strictEqual(r.status, 200);
  assert(Array.isArray(r.json.shares) && r.json.shares.length === 0, '旧数据 shares 应补为空数组');
  r = await req('POST', '/api/shares', { plan: 'legacy', expireMinutes: 60 });
  assert.strictEqual(r.status, 201, '旧方案也可创建分享');

  await new Promise((resolve) => server.close(resolve));
  console.log('share tests: all passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
