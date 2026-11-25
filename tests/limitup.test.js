#!/usr/bin/env node
/* 新发涨停四口径回填单元测试（纯函数，不联网） */
'use strict';
var assert = require('assert');
function kindOf(code) { var b = String(code).split('.')[0]; if (/^(30|68)/.test(b)) return 'gem'; if (/^(8|4|920)/.test(b)) return 'bj'; return 'main'; }
function limitOf(k) { return k === 'gem' ? 19.8 : k === 'bj' ? 29.5 : 9.8; }
function stopOf(k) { return k === 'gem' ? 7 : k === 'bj' ? 9 : 5; }
function limitPrice(p, k) { return +(p * (1 + limitOf(k) / 100)).toFixed(2); }
function nearLimit(o, p, k) { return o >= p * (1 + (limitOf(k) - 0.5) / 100); }
function evaluate(bars, sig) {
  var k = kindOf(sig.code), limP = limitOf(k), stopP = stopOf(k);
  var idx = bars.findIndex(function (b) { return b.d === sig.asOf; });
  if (idx < 0 || idx + 5 >= bars.length) return null;
  var base = bars[idx].c, next = bars[idx + 1];
  if (!(base > 0) || !(next && next.o > 0)) return null;
  var buyPrice = next.o, tradable = !nearLimit(next.o, base, k);
  var stopLine = +(buyPrice * (1 - stopP / 100)).toFixed(2);
  var daily = [], winA = false, loseA = false, winB = false, winC = false, winD = false;
  for (var j = 1; j <= 5; j++) {
    var bar = bars[idx + j], prev = bars[idx + j - 1];
    if (!bar || !prev) return null;
    var dc = prev.c > 0 ? +((bar.c / prev.c - 1) * 100).toFixed(2) : null;
    var lp = limitPrice(prev.c, k);
    var hitLimit = dc != null && dc >= limP - 0.1;
    var touchLimit = bar.h >= lp - 0.01;
    daily.push({ chg: dc, h: bar.h, l: bar.l });
    if (!loseA && bar.l <= stopLine) loseA = true;
    if (!winA && !loseA && touchLimit) winA = true;
    if (hitLimit) winB = true;
  }
  var last = bars[idx + 5];
  winC = last.c > buyPrice;
  var d1 = daily[0], d2 = daily[1];
  winD = !!(d1 && d2 && d1.chg >= limP - 0.1 && d2.chg >= limP - 0.1);
  return { buyPrice: buyPrice, stopLine: stopLine, tradable: tradable,
    a: { win: winA && !loseA, lose: loseA }, b: { win: winB }, c: { win: winC }, d: { win: winD } };
}
function bars(seed) {
  // seed: asOf 收盘 10，之后 5 天可定制
  var out = [{ d: '2026-11-20', o: 10, c: 10, h: 10.2, l: 9.9 }];
  return out.concat(seed.map(function (x, i) {
    return { d: '2026-11-' + (21 + i), o: x.o, c: x.c, h: x.h, l: x.l };
  }));
}
var B = bars;
// 场景1：次日平开 10，第3天盘中涨停（前收10 → 涨停10.98），无破止损 → ①win
var s1 = B([
  { o: 10, c: 10, h: 10.2, l: 9.8 },
  { o: 10, c: 10.98, h: 10.98, l: 10.0 },
  { o: 10.98, c: 10.98, h: 11.0, l: 10.9 },
  { o: 10.98, c: 10.98, h: 11.0, l: 10.9 },
  { o: 10.98, c: 10.98, h: 11.0, l: 10.9 }
]);
var r1 = evaluate(s1, { code: '600000.SH', asOf: '2026-11-20' });
assert.strictEqual(r1.tradable, true);
assert.strictEqual(r1.a.win, true, '盘中触及涨停应判①胜');
assert.strictEqual(r1.b.win, true, '收盘涨停应判②胜');
// 场景2：次日一字涨停开盘（9.9*1.095≈10.84，开 10.9）→ 买不进
var s2 = B([
  { o: 10.98, c: 10.98, h: 10.98, l: 10.98 },
  { o: 10.98, c: 11.5, h: 12.0, l: 10.9 },
  { o: 11.5, c: 11.5, h: 11.6, l: 11.4 },
  { o: 11.5, c: 11.5, h: 11.6, l: 11.4 },
  { o: 11.5, c: 11.5, h: 11.6, l: 11.4 }
]);
var r2 = evaluate(s2, { code: '600000.SH', asOf: '2026-11-20' });
assert.strictEqual(r2.tradable, false, '一字板开盘应判买不进');
// 场景3：次日平开买 10，第2天最低 9.4（跌破止损 9.5）先判输，即便后面涨停也不算
var s3 = B([
  { o: 10, c: 10.1, h: 10.2, l: 9.8 },
  { o: 10.1, c: 9.6, h: 10.2, l: 9.4 },
  { o: 9.6, c: 10.9, h: 11.0, l: 9.5 },
  { o: 10.9, c: 10.9, h: 11.0, l: 10.8 },
  { o: 10.9, c: 10.9, h: 11.0, l: 10.8 }
]);
var r3 = evaluate(s3, { code: '600000.SH', asOf: '2026-11-20' });
assert.strictEqual(r3.a.lose, true, '盘中破-5%应判输');
assert.strictEqual(r3.a.win, false, '先破止损后涨停不算①胜');
// 场景4：创业板阈值 7%，次日买 10，最低 9.6（未破 9.3）→ 不判输
var s4 = B([
  { o: 10, c: 10.1, h: 10.2, l: 9.6 },
  { o: 10.1, c: 10.2, h: 10.3, l: 9.8 },
  { o: 10.2, c: 10.2, h: 10.3, l: 10.0 },
  { o: 10.2, c: 10.2, h: 10.3, l: 10.0 },
  { o: 10.2, c: 12.1, h: 12.2, l: 10.2 }
]);
var r4 = evaluate(s4, { code: '300001.SZ', asOf: '2026-11-20' });
assert.strictEqual(r4.a.lose, false, '创业板 -4% 不应判输（阈值7%）');
// 场景5：数据不足返回 null，不编造
assert.strictEqual(evaluate(B([{ o: 10, c: 10, h: 10, l: 10 }]), { code: '600000.SH', asOf: '2026-11-20' }), null);
console.log('limitup 四口径回填测试 5/5 通过');
