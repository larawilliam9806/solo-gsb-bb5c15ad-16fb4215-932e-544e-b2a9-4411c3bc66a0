'use strict';
const assert = require('assert');
const G = require('../public/geometry.js');

const kiln = { width: 600, height: 450, startTemp: 20, targetTemp: 1300 };

// 1. 相距很远的两个坯体：全程不接触
{
  const a = { id: 'a', x: 100, y: 100, w: 100, h: 100, angle: 30, alpha: 6 };
  const b = { id: 'b', x: 400, y: 300, w: 100, h: 100, angle: -15, alpha: 6 };
  assert.strictEqual(G.contactTempPair(a, b, 20, 1300), null, '远距坯体不应接触');
}

// 2. 起始温度下已重叠：接触温度 = 起始温度
{
  const a = { id: 'a', x: 100, y: 100, w: 100, h: 100, angle: 0, alpha: 6 };
  const b = { id: 'b', x: 150, y: 100, w: 100, h: 100, angle: 0, alpha: 6 };
  assert.strictEqual(G.contactTempPair(a, b, 20, 1300), 20, '初始重叠应返回起始温度');
}

// 3. 解析可验证的接触温度：两个 100mm 坯体，中心间距 200mm，α=100e-6/K
//    接触条件：50·(1+1e-4·ΔT)·2 = 200 → ΔT = 10000 → T = 10020 °C
{
  const a = { id: 'a', x: 100, y: 100, w: 100, h: 100, angle: 0, alpha: 100 };
  const b = { id: 'b', x: 300, y: 100, w: 100, h: 100, angle: 0, alpha: 100 };
  const t = G.contactTempPair(a, b, 20, 20000);
  assert(Math.abs(t - 10020) < 0.01, `接触温度应≈10020，实际 ${t}`);
}

// 4. 窑壁接触：100mm 坯体右边距窑壁 0.1mm，α=100e-6/K
//    50·(1+1e-4·ΔT) = 50.1 → ΔT = 20 → T = 40 °C
{
  const body = { id: 'w', x: 949.9, y: 225, w: 100, h: 100, angle: 0, alpha: 100 };
  const t = G.contactTempWall(body, { width: 1000, height: 450 }, 20, 1300);
  assert(Math.abs(t - 40) < 0.01, `窑壁接触温度应≈40，实际 ${t}`);
}

// 5. 旋转 45° 的正方形角点距中心应为半对角线
{
  const body = { id: 'r', x: 0, y: 0, w: 100, h: 100, angle: 45, alpha: 0 };
  const pts = G.cornersOf(body, 20, 20);
  const r = Math.hypot(pts[0][0], pts[0][1]);
  assert(Math.abs(r - Math.SQRT2 * 50) < 1e-9, '角点半径错误');
}

// 6. analyze 汇总：最早接触排序与涉事集合
{
  const bodies = [
    { id: 'a', x: 100, y: 100, w: 100, h: 100, angle: 0, alpha: 100 },
    { id: 'b', x: 300, y: 100, w: 100, h: 100, angle: 0, alpha: 100 },
    { id: 'c', x: 500, y: 350, w: 60, h: 60, angle: 10, alpha: 6 }
  ];
  const res = G.analyze({ width: 600, height: 450, startTemp: 20, targetTemp: 20000 }, bodies);
  assert(res.earliest && res.earliest.type === 'body', '最早接触应为坯体间');
  assert(res.involved.has('a') && res.involved.has('b') && !res.involved.has('c'), '涉事集合错误');
}

console.log('geometry tests: all passed');
