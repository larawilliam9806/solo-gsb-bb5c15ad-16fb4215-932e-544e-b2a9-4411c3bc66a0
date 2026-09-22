/*
 * 装窑预检几何核心（浏览器全局 KilnGeom / Node module 双端可用）
 *
 * 模型约定：
 *  - 坐标系：毫米(mm)，原点在窑室左上角，x 向右、y 向下；
 *  - 坯体：矩形，中心 (x, y)，起始温度下的宽 w、高 h，旋转角 angle(度，顺时针为正)；
 *  - 线膨胀：尺寸(T) = 尺寸(T0) × (1 + α·(T − T0))，α 以 1e-6/K 录入；
 *  - 膨胀绕坯体中心进行，坯体位置与角度不随温度变化。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KilnGeom = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEG = Math.PI / 180;

  /** 温度 T 下相对起始温度 T0 的线膨胀倍率 */
  function scaleAt(alpha, T, T0) {
    return 1 + alpha * 1e-6 * (T - T0);
  }

  /** 坯体在温度 T 下的四个角点（世界坐标，mm） */
  function cornersOf(body, T, T0) {
    var s = scaleAt(body.alpha, T, T0);
    var hw = (body.w * s) / 2;
    var hh = (body.h * s) / 2;
    var a = body.angle * DEG;
    var c = Math.cos(a);
    var sn = Math.sin(a);
    var offs = [[hw, hh], [-hw, hh], [-hw, -hh], [hw, -hh]];
    var pts = [];
    for (var i = 0; i < 4; i++) {
      var dx = offs[i][0];
      var dy = offs[i][1];
      pts.push([body.x + dx * c - dy * sn, body.y + dx * sn + dy * c]);
    }
    return pts;
  }

  /** 矩形的两条边法向（SAT 投影轴） */
  function axesOf(pts) {
    var axes = [];
    var edges = [[0, 1], [1, 2]];
    for (var k = 0; k < 2; k++) {
      var i = edges[k][0];
      var j = edges[k][1];
      var ex = pts[j][0] - pts[i][0];
      var ey = pts[j][1] - pts[i][1];
      var len = Math.hypot(ex, ey) || 1;
      axes.push([-ey / len, ex / len]);
    }
    return axes;
  }

  function project(pts, axis) {
    var mn = Infinity;
    var mx = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var d = pts[i][0] * axis[0] + pts[i][1] * axis[1];
      if (d < mn) mn = d;
      if (d > mx) mx = d;
    }
    return [mn, mx];
  }

  /** 旋转矩形分离轴(SAT)重叠检测：4 条轴上投影均有交叠则相交 */
  function rectsOverlap(p1, p2) {
    var axes = axesOf(p1).concat(axesOf(p2));
    for (var i = 0; i < axes.length; i++) {
      var a = project(p1, axes[i]);
      var b = project(p2, axes[i]);
      if (a[1] < b[0] || b[1] < a[0]) return false;
    }
    return true;
  }

  /** 所有角点均在窑室内部（含边界） */
  function insideKiln(pts, kiln) {
    for (var i = 0; i < pts.length; i++) {
      var x = pts[i][0];
      var y = pts[i][1];
      if (x < 0 || x > kiln.width || y < 0 || y > kiln.height) return false;
    }
    return true;
  }

  /**
   * 在 [T0, T1] 上二分 predicate 由 false 转为 true 的最早温度。
   * 膨胀关于温度单调（坯体只长不缩），故“接触/越界”谓词单调，二分有效。
   * 返回 null 表示整段温度内均未触发；返回 T0 表示起始温度下已触发。
   */
  function bisect(T0, T1, predicate) {
    if (!predicate(T1)) return null;
    if (predicate(T0)) return T0;
    var lo = T0;
    var hi = T1;
    for (var i = 0; i < 64; i++) {
      var mid = (lo + hi) / 2;
      if (predicate(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  /** 两坯体在 (T0, T1] 内的最早接触温度 */
  function contactTempPair(a, b, T0, T1) {
    return bisect(T0, T1, function (T) {
      return rectsOverlap(cornersOf(a, T, T0), cornersOf(b, T, T0));
    });
  }

  /** 坯体在 (T0, T1] 内最早触碰/越过窑壁的温度 */
  function contactTempWall(body, kiln, T0, T1) {
    return bisect(T0, T1, function (T) {
      return !insideKiln(cornersOf(body, T, T0), kiln);
    });
  }

  /**
   * 全量分析：坯体两两 + 各坯体对窑壁。
   * 返回 { contacts, earliest, involved, wallContact, atStart }
   * contacts 按接触温度升序；involved 为涉事坯体 id 集合。
   */
  function analyze(kiln, bodies) {
    var T0 = kiln.startTemp;
    var T1 = kiln.targetTemp;
    var contacts = [];
    var i;
    var j;
    if (T1 >= T0) {
      for (i = 0; i < bodies.length; i++) {
        for (j = i + 1; j < bodies.length; j++) {
          var t = contactTempPair(bodies[i], bodies[j], T0, T1);
          if (t !== null && t <= T1) {
            contacts.push({ type: 'body', a: bodies[i].id, b: bodies[j].id, temp: t });
          }
        }
        var tw = contactTempWall(bodies[i], kiln, T0, T1);
        if (tw !== null && tw <= T1) {
          contacts.push({ type: 'wall', a: bodies[i].id, temp: tw });
        }
      }
    }
    contacts.sort(function (x, y) { return x.temp - y.temp; });
    var involved = new Set();
    for (i = 0; i < contacts.length; i++) {
      involved.add(contacts[i].a);
      if (contacts[i].b) involved.add(contacts[i].b);
    }
    return {
      contacts: contacts,
      earliest: contacts.length ? contacts[0] : null,
      involved: involved,
      wallContact: contacts.some(function (c) { return c.type === 'wall'; }),
      atStart: contacts.some(function (c) { return c.temp <= T0; })
    };
  }

  return {
    scaleAt: scaleAt,
    cornersOf: cornersOf,
    rectsOverlap: rectsOverlap,
    insideKiln: insideKiln,
    contactTempPair: contactTempPair,
    contactTempWall: contactTempWall,
    analyze: analyze
  };
});
