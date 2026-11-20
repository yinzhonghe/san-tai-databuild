/* 缠论核心版：中枢 + MACD面积背驰 + 一二三买卖点
 * ---------------------------------------------------------------
 * 按用户定义（去掉笔/线段/区间套，保留缠论精髓）：
 *   · 段：相邻反向分型直接连接（不做新笔老笔的间隔要求）
 *   · 中枢：三段重叠区间（ZG/ZD）
 *   · 一买：下跌创新低但 MACD 绿柱面积背驰（后段面积 < 前段）
 *   · 二买：一买后回调不破一买低点
 *   · 三买：上涨离开中枢后回调不破中枢上沿 ZG
 *
 * 数据：bars = [[date, open, close, high, low], ...]
 */
(function (root) {
  'use strict';

  /* ---------- MACD ---------- */
  function ema(a, n) {
    var k = 2 / (n + 1), o = [], p = a[0];
    for (var i = 0; i < a.length; i++) { p = i === 0 ? a[0] : a[i] * k + p * (1 - k); o.push(p); }
    return o;
  }
  function macd(cl) {
    var ef = ema(cl, 12), es = ema(cl, 26);
    var dif = ef.map(function (v, i) { return v - es[i]; });
    var dea = ema(dif, 9);
    var hist = dif.map(function (v, i) { return (v - dea[i]) * 2; });
    return { dif: dif, dea: dea, hist: hist };
  }

  /* ---------- 1. K线包含处理 ---------- */
  function mergeK(bars) {
    if (!bars || !bars.length) return [];
    var out = [{ h: bars[0][3], l: bars[0][4], k: 0, date: bars[0][0], c: bars[0][2] }];
    var dir = 1;
    for (var i = 1; i < bars.length; i++) {
      var h = bars[i][3], l = bars[i][4], last = out[out.length - 1];
      var inc = (h <= last.h && l >= last.l) || (h >= last.h && l <= last.l);
      if (inc) {
        if (out.length >= 2) dir = out[out.length - 1].c >= out[out.length - 2].c ? 1 : -1;
        if (dir > 0) { last.h = Math.max(last.h, h); last.l = Math.max(last.l, l); }
        else { last.h = Math.min(last.h, h); last.l = Math.min(last.l, l); }
        last.c = bars[i][2]; last.k = i; last.date = bars[i][0];
      } else {
        out.push({ h: h, l: l, k: i, date: bars[i][0], c: bars[i][2] });
      }
    }
    return out;
  }

  /* ---------- 2. 分型 ---------- */
  function fractals(mk) {
    var out = [];
    for (var i = 1; i < mk.length - 1; i++) {
      var a = mk[i - 1], b = mk[i], c = mk[i + 1];
      if (b.h > a.h && b.h > c.h && b.l > a.l && b.l > c.l) out.push({ t: 1, i: i, k: b.k, d: b.date, p: b.h });
      else if (b.h < a.h && b.h < c.h && b.l < a.l && b.l < c.l) out.push({ t: -1, i: i, k: b.k, d: b.date, p: b.l });
    }
    // 相邻同类型只留极端的
    var m = [];
    out.forEach(function (f) {
      if (m.length && m[m.length - 1].t === f.t) {
        var p = m[m.length - 1];
        if ((f.t === 1 && f.p > p.p) || (f.t === -1 && f.p < p.p)) m[m.length - 1] = f;
      } else m.push(f);
    });
    return m;
  }

  /* ---------- 3. 段（相邻反向分型直接连） ---------- */
  function segs(fs) {
    var out = [];
    for (var i = 1; i < fs.length; i++) {
      var a = fs[i - 1], b = fs[i];
      if (a.t === b.t) continue;
      if (a.t === -1 && b.p <= a.p) continue;   // 底到顶必须涨
      if (a.t === 1 && b.p >= a.p) continue;    // 顶到底必须跌
      out.push({
        dir: a.t === -1 ? 1 : -1,
        i0: a.i, i1: b.i, k0: a.k, k1: b.k,
        d0: a.d, d1: b.d, p0: a.p, p1: b.p
      });
    }
    return out;
  }

  /* ---------- 4. 中枢 ---------- */
  function centers(sg) {
    var out = [];
    for (var i = 0; i + 2 < sg.length; i++) {
      var a = sg[i], b = sg[i + 1], c = sg[i + 2];
      var zg = Math.min(Math.max(a.p0, a.p1), Math.max(b.p0, b.p1), Math.max(c.p0, c.p1));
      var zd = Math.max(Math.min(a.p0, a.p1), Math.min(b.p0, b.p1), Math.min(c.p0, c.p1));
      if (zg > zd) out.push({ ZG: zg, ZD: zd, i0: a.i0, i1: c.i1, k0: a.k0, k1: c.k1, d0: a.d0, d1: c.d1 });
    }
    /* 不做跨中枢合并：每三个连续段的重叠就是一个独立中枢。
       跨区间合并会把不同时间、不同级别的走势硬捏成一个，失去意义。
       相邻且真实重叠的算同一中枢的延伸（区间取并集），仅此而已。 */
    var m = [];
    out.forEach(function (c) {
      var last = m[m.length - 1];
      // 仅当与上一个中枢「时间连续 且 价格区间真实重叠」才算延伸
      if (last && c.i0 <= last.i1 && c.ZD < last.ZG && c.ZG > last.ZD) {
        last.ZG = Math.max(last.ZG, c.ZG); last.ZD = Math.min(last.ZD, c.ZD);
        last.i1 = c.i1; last.k1 = c.k1; last.d1 = c.d1;
      } else m.push(c);
    });
    return m;
  }

  /* ---------- 5. MACD 面积 ---------- */
  function macdArea(M, k0, k1, dir) {
    var s = 0;
    for (var i = Math.max(0, k0); i <= Math.min(M.hist.length - 1, k1); i++) {
      if (dir < 0 && M.hist[i] < 0) s += -M.hist[i];   // 下跌段只算绿柱
      else if (dir > 0 && M.hist[i] > 0) s += M.hist[i]; // 上涨段只算红柱
    }
    return s;
  }

  /* ---------- 6. 买卖点 ---------- */
  function signals(bars) {
    var cl = bars.map(function (b) { return b[2]; });
    var M = macd(cl);
    var mk = mergeK(bars);
    var fs = fractals(mk);
    var sg = segs(fs);
    var cs = centers(sg);
    var out = [];

    sg.forEach(function (cur, i) {
      // 找前一个同向段
      var prev = null, pi = -1;
      for (var j = i - 1; j >= 0; j--) if (sg[j].dir === cur.dir) { prev = sg[j]; pi = j; break; }
      if (!prev) return;

      var isDown = cur.dir === -1;
      var newLow = isDown ? (cur.p1 < prev.p1) : (cur.p1 > prev.p1);
      if (!newLow) return;

      // MACD 面积背驰
      var aPrev = macdArea(M, prev.k0, prev.k1, cur.dir);
      var aCur = macdArea(M, cur.k0, cur.k1, cur.dir);
      if (!(aPrev > 0)) return;
      var beichi = aCur < aPrev * 0.9;   // 后段面积 < 前段 90%

      // 一买：下跌创新低 + 面积背驰
      if (isDown && beichi) {
        var inTrend = cs.length >= 2 && cur.p1 < cs[cs.length - 1].ZD;
        out.push({
          type: inTrend ? '一买' : '盘整一买',
          k: cur.k1, d: cur.d1, p: cur.p1,
          areaRatio: +(aCur / aPrev).toFixed(2), cs: cs.length
        });
      }

      // 二买：一买（或下跌背驰段）之后，第一个回调段不破前低
      if (i >= 2 && cur.dir === -1 && beichi) {
        var up = sg[i + 1], back = sg[i + 2];
        if (up && up.dir === 1 && back && back.dir === -1 && back.p1 > cur.p1) {
          out.push({ type: '二买', k: back.k1, d: back.d1, p: back.p1,
            note: '回调不破前低 ' + cur.p1.toFixed(2) });
        }
      }

      // ===== 卖点（对称定义）=====
      // 一卖：上涨创新高 + MACD 红柱面积背驰
      if (!isDown && beichi) {
        var inTrendUp = cs.length >= 2 && cur.p1 > cs[cs.length - 1].ZG;
        out.push({
          type: inTrendUp ? '一卖' : '盘整一卖',
          k: cur.k1, d: cur.d1, p: cur.p1,
          areaRatio: +(aCur / aPrev).toFixed(2)
        });
      }
      // 二卖：一卖后反抽不过前高
      if (i >= 2 && !isDown && beichi) {
        var dn = sg[i + 1], re = sg[i + 2];
        if (dn && dn.dir === -1 && re && re.dir === 1 && re.p1 < cur.p1) {
          out.push({ type: '二卖', k: re.k1, d: re.d1, p: re.p1,
            note: '反抽不过一卖高点 ' + cur.p1.toFixed(2) });
        }
      }
      // 三卖：下跌跌破中枢下沿 ZD（强制卖）
      if (isDown) {
        for (var ci2 = cs.length - 1; ci2 >= 0; ci2--) {
          var c2 = cs[ci2];
          if (cur.k0 >= c2.k0 && cur.p1 < c2.ZD && cur.p0 >= c2.ZD) {
            out.push({ type: '三卖', k: cur.k1, d: cur.d1, p: cur.p1,
              note: '跌破中枢下沿 ZD=' + c2.ZD.toFixed(2), urgent: true });
            break;
          }
        }
      }

      // 三买：上涨段离开中枢后，回调不破中枢上沿 ZG
      if (!isDown && i + 1 < sg.length) {
        var bk = sg[i + 1];
        if (bk && bk.dir === -1) {
          for (var ci = cs.length - 1; ci >= 0; ci--) {
            var c = cs[ci];
            if (cur.k0 >= c.k0 && bk.p1 > c.ZG && bk.p0 < c.ZG * 1.35) {
              out.push({ type: '三买', k: bk.k1, d: bk.d1, p: bk.p1,
                note: '回调不破 ZG=' + c.ZG.toFixed(2) });
              break;
            }
          }
        }
      }
    });
    return { mk: mk, fs: fs, segs: sg, centers: cs, signals: out, macd: M };
  }

  var api = { macd: macd, mergeK: mergeK, fractals: fractals, segs: segs,
    centers: centers, macdArea: macdArea, signals: signals, analyze: signals };
  root.AB_CHAN_CORE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
