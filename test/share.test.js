'use strict';
/*
 * 只读分享令牌集成测试（启动真实 HTTP 服务，使用临时 DATA_DIR 隔离数据）
 * 运行：node test/share.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-share-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '0';

const app = require('../server.js');

const kiln = () => ({ width: 600, height: 450, startTemp: 20, targetTemp: 1300 });
const body = (id, x) => ({ id, name: id, x, y: 100, w: 100, h: 100, angle: 0, alpha: 6 });
const plan = (x = 100) => ({ kiln: kiln(), bodies: [body('b1', x)] });

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ✓ ' + name);
}
// 服务端防抖 200ms 落盘，读文件前等待其完成
const waitFlush = () => new Promise((r) => setTimeout(r, 260));

async function main() {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = (p, opts) => fetch(base + p, opts);
  const json = (p, opts) => api(p, opts).then(async (r) => ({ res: r, body: await r.json().catch(() => ({})) }));

  /* 先准备一个方案 */
  {
    const { res } = await json('/api/plans/分享测试方案', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(plan(100))
    });
    assert.strictEqual(res.status, 200, '准备方案应成功');
  }

  await test('创建分享：返回明文令牌与 /share/ 链接，列表不含哈希', async () => {
    const { res, body: b } = await json('/api/plans/分享测试方案/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttlMinutes: 60 })
    });
    assert.strictEqual(res.status, 201);
    assert.ok(typeof b.token === 'string' && b.token.length >= 32, '应返回随机令牌');
    assert.strictEqual(b.url, '/share/' + b.token);
    assert.ok(b.share && b.share.id, '应返回分享元信息');
    assert.ok(b.share.expiresAt > Date.now(), '过期时间应在未来');
    assert.ok(!('hash' in b.share), '元信息中不应包含哈希');

    const list = await json('/api/plans/分享测试方案/shares').then((r) => r.body);
    assert.strictEqual(list.shares.length, 1);
    assert.ok(!('hash' in list.shares[0]), '列表不应泄露哈希');
    assert.ok(!('token' in list.shares[0]), '列表不应泄露令牌');

    // 落盘文件中也只能看到哈希，看不到明文令牌
    await waitFlush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'plans.json'), 'utf8'));
    assert.ok(onDisk.shares[0].hash, '落盘应保存哈希');
    assert.ok(!JSON.stringify(onDisk).includes(b.token), '落盘文件不得包含明文令牌');
  });

  let token;
  await test('公开只读端点：无需登录读取方案当前内容', async () => {
    const { body: b } = await json('/api/plans/分享测试方案/shares');
    // 通过重新创建一个拿明文令牌
    const created = await json('/api/plans/分享测试方案/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    token = created.body.token;

    const { res, body: sb } = await json('/api/shared/' + token);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(sb.plan, '分享测试方案');
    assert.strictEqual(sb.bodies[0].x, 100);
    assert.ok(!('shares' in sb) && !('hash' in sb), '只读响应不得携带分享记录');
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  });

  await test('实时反映：原方案修改后，同一令牌立即返回新内容', async () => {
    const { res } = await json('/api/plans/分享测试方案', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(plan(222))
    });
    assert.strictEqual(res.status, 200);
    const sb = await json('/api/shared/' + token).then((r) => r.body);
    assert.strictEqual(sb.bodies[0].x, 222, '应读到修改后的方案');
  });

  await test('写入方法一律 405：令牌不能调用任何写入接口', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await api('/api/shared/' + token, { method });
      assert.strictEqual(res.status, 405, method + ' 应被拒绝');
    }
  });

  await test('未知 / 篡改令牌返回 404', async () => {
    const r1 = await api('/api/shared/not-a-real-token-xxxxxxxxxxxx');
    assert.strictEqual(r1.status, 404);
    const r2 = await api('/api/shared/' + token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A'));
    assert.strictEqual(r2.status, 404);
  });

  await test('撤销后立即 410，管理端可在列表看到撤销状态', async () => {
    const list = await json('/api/plans/分享测试方案/shares').then((r) => r.body);
    const mine = list.shares.find((s) => s.expiresAt === null);
    const { res } = await json('/api/shares/' + mine.id, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
    const after = await api('/api/shared/' + token);
    assert.strictEqual(after.status, 410, '撤销后应 410 Gone');
    const list2 = await json('/api/plans/分享测试方案/shares').then((r) => r.body);
    assert.strictEqual(list2.shares.find((s) => s.id === mine.id).revoked, true);
  });

  await test('过期令牌返回 410（分钟级 TTL 校验 + 短 TTL 用例）', async () => {
    const created = await json('/api/plans/分享测试方案/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttlMinutes: 0.02 }) // 1.2 秒
    });
    assert.strictEqual(created.res.status, 201);
    const shortToken = created.body.token;
    assert.strictEqual((await api('/api/shared/' + shortToken)).status, 200, '未过期前可访问');
    await new Promise((r) => setTimeout(r, 1400));
    assert.strictEqual((await api('/api/shared/' + shortToken)).status, 410, '过期后 410');

    // 非法 TTL
    const bad = await json('/api/plans/分享测试方案/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttlMinutes: 0 })
    });
    assert.strictEqual(bad.res.status, 400);
  });

  await test('删除方案：其分享令牌立即失效，公开访问 410', async () => {
    const created = await json('/api/plans/分享测试方案/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const t = created.body.token;
    assert.strictEqual((await api('/api/shared/' + t)).status, 200);
    const del = await api('/api/plans/分享测试方案', { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await api('/api/shared/' + t)).status, 410);
    await waitFlush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'plans.json'), 'utf8'));
    assert.ok(
      onDisk.shares.filter((s) => s.plan === '分享测试方案').every((s) => s.revoked),
      '方案的令牌应全部标记撤销'
    );
  });

  await test('分享页与静态资源可访问', async () => {
    const page = await api('/share/abc123');
    assert.strictEqual(page.status, 200);
    assert.ok((await page.text()).includes('只读分享'));
    const css = await api('/share.css');
    assert.strictEqual(css.status, 200);
  });

  server.close();
  console.log(`\n分享测试全部通过：${passed} 项`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
