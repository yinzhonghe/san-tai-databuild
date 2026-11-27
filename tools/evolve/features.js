/*
 * tools/evolve/features.js · 派生特征库（自进化模块专用，不动主站打分链路）
 * ---------------------------------------------------------------------------
 * 设计依据（2026-11-26 grill-me 定稿）：
 *   - 所有特征只从「历史横截面里真实存在的字段」派生，不编造。
 *   - 目标是「盘整→启动前 1~3 天识别」，所以特征必须能在 T 日收盘算出来。
 *   - 特征分两类：
 *       base  : 直接从 OHLCV 算（panel.js 已有）
 *       deriv : 六派之外的派生量（波动收缩比 / 量价背离 / 板块相对强度斜率等）
 *   - 每个特征都写清公式与数据依赖，缺数据返回 null 而不是 0（fail-closed）。
 * 浏览器与 Node 共用（UMD）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AB_EVOLVE_FEATURES = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function mean(a) { if (!a.length) return null; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  function std(a) {
    if (a.length < 2) return null;
    var m = mean(a), s = 0;
    for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / (a.length - 1));
  }
  function ret(closes, i, n) {
    if (!Array.isArray(closes) || i - n < 0 || i >= closes.length) return null;
    var a = closes[i - n], b = closes[i];
    return isNum(a) && a > 0 && isNum(b) ? (b / a - 1) * 100 : null;
  }
  function slice(a, end, n) {
    var s = Math.max(0, end - n);
    return Array.isArray(a) ? a.slice(s, end) : [];
  }
  function tr(high, low, prevClose) {
    if (!isNum(high) || !isNum(low) || !isNum(prevClose)) return null;
    return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  function atr(bars, end, n) {
    var vals = [];
    for (var i = Math.max(1, end - n + 1); i <= end && i < bars.length; i++) {
      var v = tr(bars[i].h, bars[i].l, bars[i - 1].c);
      if (v != null) vals.push(v);
    }
    return vals.length ? mean(vals) : null;
  }

  /* 全部派生特征的元信息：key → {label, formula, deps, unit}
     deps 用于数据猎手判断「这条规则要跑，还缺什么数据」。 */
  var META = {
    volSqueeze20: { label: '20日波动收缩比', formula: 'ATR(5)/ATR(20)', deps: ['high', 'low', 'close'], unit: 'ratio' },
    volSqueeze60: { label: '60日波动收缩比', formula: 'ATR(10)/ATR(60)', deps: ['high', 'low', 'close'], unit: 'ratio' },
    volRatio5:    { label: '5日量能比', formula: 'vol[t]/mean(vol[t-5..t-1])', deps: ['volume'], unit: 'ratio' },
    volRamp:      { label: '量能斜坡', formula: 'mean(vol[t-5..t-1])/mean(vol[t-20..t-6])', deps: ['volume'], unit: 'ratio' },
    pvrDiv:       { label: '量价背离度', formula: 'ret5 - 30日量价回归残差(简化:ret5 - k*(volRamp-1)*10)', deps: ['close', 'volume'], unit: 'pct' },
    rsSlope:      { label: '板块相对强度斜率', formula: '个股ret10 - 同行业ret10中位数', deps: ['close', 'industry'], unit: 'pct' },
    rsSlope20:    { label: '板块相对强度斜率20', formula: '个股ret20 - 同行业ret20中位数', deps: ['close', 'industry'], unit: 'pct' },
    breakout20:   { label: '20日突破幅度', formula: 'close[t]/max(high[t-20..t-1])-1', deps: ['high', 'close'], unit: 'pct' },
    pullback20:   { label: '20日高点回撤', formula: 'close[t]/max(high[t-20..t])-1', deps: ['high', 'close'], unit: 'pct' },
    maGap20:      { label: '20日均线偏离', formula: 'close[t]/mean(close[t-20..t])-1', deps: ['close'], unit: 'pct' },
    maGap60:      { label: '60日均线偏离', formula: 'close[t]/mean(close[t-60..t])-1', deps: ['close'], unit: 'pct' },
    bodyRatio:    { label: '实体占比', formula: '|close-open|/(high-low)', deps: ['open', 'high', 'low', 'close'], unit: 'ratio' },
    closePos:     { label: '收盘位置', formula: '(close-low)/(high-low)', deps: ['high', 'low', 'close'], unit: 'ratio' },
    gapPct:       { label: '跳空幅度', formula: 'open/prevClose-1', deps: ['open', 'close'], unit: 'pct' },
    consecDown:   { label: '连阴天数', formula: '连续 close<prevClose 的天数', deps: ['close'], unit: 'days' },
    streakLimit:  { label: '连板数', formula: '从 t 往前数涨幅达涨停档的连续天数', deps: ['close'], unit: 'days' },
    ret5:         { label: '5日涨幅', formula: 'close[t]/close[t-5]-1', deps: ['close'], unit: 'pct' },
    ret20:        { label: '20日涨幅', formula: 'close[t]/close[t-20]-1', deps: ['close'], unit: 'pct' },
    ret60:        { label: '60日涨幅', formula: 'close[t]/close[t-60]-1', deps: ['close'], unit: 'pct' },
    amtTrend:     { label: '额能趋势', formula: 'ret5 的绝对值 × volRamp（放量下跌/放量上涨区分）', deps: ['close', 'volume'], unit: 'pct' },
    /* 资金流特征（2026-11-27 接入验证闭环）：由 build_fundflow_samples.js 按
       (code,date) join 真实历史资金流注入样本 f，非 OHLCV 派生。缺数据不写字段，
       evalRule 判 skip（fail-closed），不填0。仅当用 ff 样本时才有值。 */
    main5:        { label: '近5日主力净流入(万元)', formula: '资金流源近5日主力净流入求和', deps: ['fundflow'], unit: 'wan' },
    superRatio5:  { label: '超大单占主力比', formula: '近5日超大单/|近5日主力|, 主力≈0留空', deps: ['fundflow'], unit: 'ratio' },
    accel:        { label: '资金加速度(万元)', formula: '近5日主力 - 前5日主力', deps: ['fundflow'], unit: 'wan' },
    mainPctT:     { label: '当日主力净占比(%)', formula: 'T日主力净流入/成交额', deps: ['fundflow'], unit: 'pct' }
  };

  /* bars: [{d,o,h,l,c,v}]，按时间升序，末尾为 T 日。
     ctx: { limitPct, industryRet10/20 (行业中位数), asOf } 可选。
     返回 {key: value|null}，缺数据一律 null。 */
  function compute(bars, ctx, index) {
    ctx = ctx || {};
    var out = {};
    if (!Array.isArray(bars) || bars.length < 21) return out;
    // index 可选：panel 批量生成时传当前 t，避免每轮 slice(0,t+1) 复制数组
    var i = isNum(index) ? index : bars.length - 1;
    if (i < 20 || i >= bars.length) return out;
    var c = bars.map(function (b) { return b.c; });
    var h = bars.map(function (b) { return b.h; });
    var l = bars.map(function (b) { return b.l; });
    var o = bars.map(function (b) { return b.o; });
    var v = bars.map(function (b) { return b.v; });
    var hasVol = v.some(isNum);
    var lim = isNum(ctx.limitPct) ? ctx.limitPct : 9.8;

    out.ret5 = ret(c, i, 5);
    out.ret20 = ret(c, i, 20);
    out.ret60 = ret(c, i, 60);

    var a5 = atr(bars, i, 5), a20 = atr(bars, i, 20);
    var a10 = atr(bars, i, 10), a60 = atr(bars, i, 60);
    out.volSqueeze20 = (a5 != null && a20 > 0) ? +(a5 / a20).toFixed(4) : null;
    out.volSqueeze60 = (a10 != null && a60 > 0) ? +(a10 / a60).toFixed(4) : null;

    if (hasVol) {
      var v5 = mean(slice(v, i, 5));
      var v20prev = mean(slice(v, i - 5, 15));
      out.volRatio5 = (isNum(v[i]) && v5 > 0) ? +(v[i] / v5).toFixed(4) : null;
      out.volRamp = (v5 != null && v20prev > 0) ? +(v5 / v20prev).toFixed(4) : null;
    } else {
      out.volRatio5 = null; out.volRamp = null;
    }

    out.pvrDiv = (out.ret5 != null && out.volRamp != null)
      ? +(out.ret5 - 10 * (out.volRamp - 1)).toFixed(3) : null;

    out.rsSlope = (out.ret5 != null && isNum(ctx.industryRet10)) ? +(out.ret5 * 2 - ctx.industryRet10).toFixed(3) : null;
    out.rsSlope20 = (out.ret20 != null && isNum(ctx.industryRet20)) ? +(out.ret20 - ctx.industryRet20).toFixed(3) : null;

    var hi20prev = Math.max.apply(null, slice(h, i, 20));
    out.breakout20 = (hi20prev > 0 && isNum(c[i])) ? +((c[i] / hi20prev - 1) * 100).toFixed(3) : null;
    var hi20 = Math.max.apply(null, slice(h, i + 1, 20));
    out.pullback20 = (hi20 > 0 && isNum(c[i])) ? +((c[i] / hi20 - 1) * 100).toFixed(3) : null;

    var ma20 = mean(slice(c, i + 1, 20));
    var ma60 = mean(slice(c, i + 1, 60));
    out.maGap20 = (ma20 > 0 && isNum(c[i])) ? +((c[i] / ma20 - 1) * 100).toFixed(3) : null;
    out.maGap60 = (ma60 > 0 && isNum(c[i])) ? +((c[i] / ma60 - 1) * 100).toFixed(3) : null;

    var rng = (isNum(h[i]) && isNum(l[i])) ? h[i] - l[i] : null;
    out.bodyRatio = (rng > 0 && isNum(o[i]) && isNum(c[i])) ? +(Math.abs(c[i] - o[i]) / rng).toFixed(4) : null;
    out.closePos = (rng > 0 && isNum(c[i]) && isNum(l[i])) ? +((c[i] - l[i]) / rng).toFixed(4) : null;
    out.gapPct = (isNum(o[i]) && isNum(c[i - 1]) && c[i - 1] > 0) ? +((o[i] / c[i - 1] - 1) * 100).toFixed(3) : null;

    var down = 0;
    for (var j = i; j >= 1; j--) {
      if (isNum(c[j]) && isNum(c[j - 1]) && c[j] < c[j - 1]) down++; else break;
    }
    out.consecDown = down;

    var st = 0;
    for (var k = i; k >= 1 && st < 10; k--) {
      if (!isNum(c[k]) || !isNum(c[k - 1]) || c[k - 1] <= 0) break;
      if ((c[k] / c[k - 1] - 1) * 100 >= lim - 0.5) st++; else break;
    }
    out.streakLimit = st;

    out.amtTrend = (out.ret5 != null && out.volRamp != null)
      ? +(Math.abs(out.ret5) * out.volRamp).toFixed(3) : null;

    return out;
  }

  return { META: META, compute: compute, mean: mean, std: std, ret: ret, isNum: isNum };
});
