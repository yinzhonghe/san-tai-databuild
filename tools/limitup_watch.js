#!/usr/bin/env node
/*
 * tools/limitup_watch.js
 * ------------------------------------------------------------------
 * 新发涨停观察（供超跌反弹页第三个板块使用，独立于三态主站）。
 *
 * 每天收盘后由 oversold.yml 调用：
 *   node tools/limitup_watch.js
 *
 * 输出 limitup_data.js（window.AB_LIMITUP），含：
 *   1. today     —— 最新交易日「启动·新发」信号池，每只打分 + 直白建议 + 连板/涨停概率
 *   2. scoreboard—— 打分分档的历史实测涨停率（验证打分是否有效，供持续优化）
 *   3. commonality —— 多维度共性统计（当日涨幅/振幅/位置/量能/中期动能/板块）
 *   4. consec / sell —— 连板概率、涨停后各日收益（回答买卖时机）
 *   5. ledger    —— 最近 90 个交易日台账（新发数/当日涨停/未来涨停率），看市场热度趋势
 *   6. verdict   —— 当下市场「适不适合做」的直白判断
 *
 * 口径：ohlc.json.gz 后复权日K + bt_lib.dailySignals 逐日回放；「新发」=三态首次转启动那天；
 * 涨停按收盘涨幅（主板9.8/创业科创19.8/北交29.5）；历史K线无成交量，量能用振幅比代理。
 * 所有概率均为历史频率，不是预测，不构成投资建议。
 */
'use strict';
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var lib = require('./bt_lib.js');
var evo = require('./limitup_evolve_lib.js');

var ROOT = path.dirname(__dirname);
var OHLC = path.join(ROOT, 'ohlc.json.gz');
var DATAJS = path.join(ROOT, 'data.js');
var OUT = path.join(ROOT, 'limitup_data.js');

function kindOf(code) {
  var b = String(code).split('.')[0];
  if (/^(15|16|50|51|52|56|58)/.test(b)) return 'etf';
  if (/^(30|68)/.test(b)) return 'gem';
  if (/^(8|4|920)/.test(b)) return 'bj';
  return 'main';
}
function limitOf(k) { return k === 'gem' ? 19.8 : k === 'bj' ? 29.5 : 9.8; }
function toBars(a) { return a.map(function (x) { return { d: x[0], o: x[1], c: x[2], h: x[3], l: x[4], v: 0 }; }); }
function pct(n, h) { return n ? +(h / n * 100).toFixed(1) : 0; }
function med(a) { if (!a.length) return 0; var b = a.slice().sort(function (x, y) { return x - y; }); return +b[Math.floor(b.length / 2)].toFixed(2); }
function q(a, p) { if (!a.length) return 0; var b = a.slice().sort(function (x, y) { return x - y; }); return +b[Math.floor(b.length * p)].toFixed(2); }
function avgN(n, s) { return n ? +(s / n).toFixed(2) : 0; }

// 代码 → 名称/行业（从 data.js 取；取不到留空，不编造）
var nameMap = {};
var liveAsOf = '';
try {
  var s = fs.readFileSync(DATAJS, 'utf8');
  var D = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
  // 名称去掉数据自带的空格（如「生 意 宝」→「生意宝」），否则页面搜索/对照会漏
  (D.rows || []).forEach(function (r) {
    if (r && r.code) nameMap[r.code] = {
      name: String(r.name || '').replace(/\s+/g, ''),
      ind: r.ind, state: r.state || '', stateDays: r.stateDays
    };
  });
  var r0 = (D.rows || []).find(function (x) { return x && x.asOf; });
  if (r0) liveAsOf = r0.asOf;
} catch (e) { console.log('  [提示] data.js 读取失败，名称留空：' + e.message); }

var O = JSON.parse(zlib.gunzipSync(fs.readFileSync(OHLC)).toString());

// ===== 打分规则（0~11 分，因子均可从当日K线算得，不引入未来信息）=====
// 依据：全历史归因统计里各分档的 T+5 涨停率差异
function scoreOf(f) {
  var sc = 0, parts = {};
  // 1) 当日涨幅（最强单因子：5-7% 档 10.3% vs 0-3% 档 4.5%）
  var a = f.chg1;
  parts.chg = (a >= 5 && a < 7) ? 2 : ((a >= 3 && a < 5) || (a >= 7 && a < f.lim)) ? 1 : 0;
  // 2) 当日振幅（涨停组中位 7.05% vs 未涨停 4.01%）
  parts.amp = f.amp >= 7 ? 2 : f.amp >= 5 ? 1 : 0;
  // 3) 60日位置（贴顶≥85% 档 7.9% vs 低中位<50% 档 4.5%）
  parts.pos = f.pos60 != null ? (f.pos60 >= 0.85 ? 2 : f.pos60 >= 0.5 ? 1 : 0) : 0;
  // 4) 量能代理（振幅比 急放≥1.6 档 10.9% vs 缩量 5.4%）
  parts.vol = f.ampRatio != null ? (f.ampRatio >= 1.3 ? 2 : f.ampRatio >= 1.1 ? 1 : 0) : 0;
  // 5) 中期动能（20日≥20% 档 14.3%、60日≥30% 档 12.9%）
  parts.mid = (f.chg20 >= 15 && f.chg60 >= 25) ? 2 : (f.chg20 >= 10 || f.chg60 >= 15) ? 1 : 0;
  // 6) 板块（主板 7.4% vs 创业科创 1.5%）
  parts.board = f.kind === 'main' ? 1 : 0;
  Object.keys(parts).forEach(function (k) { sc += parts[k]; });
  return { score: sc, parts: parts };
}
function tierOf(sc, cut) {
  cut = cut || evo.cutoffs(evo.DEFAULT);
  if (sc >= cut.t3) return { t: '可小仓试探', cls: 'hot', note: '历史该档 T+5 涨停率最高；次日冲高可先减，别恋战' };
  if (sc >= cut.t2) return { t: '重点观察', cls: 'warm', note: '条件较齐，等放量确认再动，跌破启动日最低价离场' };
  if (sc >= cut.t1) return { t: '观察', cls: 'mid', note: '条件一般，先放自选看 1~2 天，不必急着买' };
  return { t: '回避', cls: 'cold', note: '接近全市场随机水平（4.5%），不值得单独下手' };
}

// ===== 全市场回放 =====
var signals = [];       // 每条新发信号（含特征 + 结果），用于统计
var ledgerMap = {};     // date -> {n, lu, hit5n, hit5}
var consec = { n: 0, c2: 0, c3: 0 }, seal = {};
var after = { 1: { n: 0, sum: 0, win: 0, arr: [] }, 2: { n: 0, sum: 0, win: 0, arr: [] }, 3: { n: 0, sum: 0, win: 0, arr: [] }, 5: { n: 0, sum: 0, win: 0, arr: [] } };

var codes = Object.keys(O.bars);
for (var ci = 0; ci < codes.length; ci++) {
  var code = codes[ci], kind = kindOf(code);
  if (kind === 'etf') continue;
  var arr = O.bars[code];
  if (!arr || arr.length < 280) continue;
  var ds;
  try { ds = lib.dailySignals(toBars(arr)); } catch (e) { continue; }
  if (!ds || !ds.n) continue;
  var close = ds.close, high = ds.high, low = ds.low, n = ds.n, lim = limitOf(kind);

  var isLU = new Array(n).fill(false), chg = new Array(n).fill(0), amp = new Array(n).fill(0);
  for (var i = 1; i < n; i++) {
    var p = close[i - 1];
    if (!(p > 0) || !(close[i] > 0)) continue;
    chg[i] = (close[i] / p - 1) * 100;
    if (chg[i] >= lim) isLU[i] = true;
    amp[i] = (high[i] - low[i]) / p * 100;
  }
  function ampAvg(s, e) { var t = 0, c = 0; for (var z = s; z <= e; z++) if (z >= 0 && z < n) { t += amp[z]; c++; } return c ? t / c : null; }

  for (var k2 = 62; k2 < n; k2++) {
    if (!(ds.states[k2] === '启动' && ds.states[k2 - 1] !== '启动')) continue;  // 新发

    var hi60 = -Infinity, lo60 = Infinity;
    for (var z2 = k2 - 59; z2 <= k2; z2++) { if (z2 < 0) break; if (close[z2] > hi60) hi60 = close[z2]; if (close[z2] < lo60) lo60 = close[z2]; }
    var pos60 = hi60 > lo60 ? +((close[k2] - lo60) / (hi60 - lo60)).toFixed(3) : null;
    var a5 = ampAvg(k2 - 4, k2), a20 = ampAvg(k2 - 19, k2);
    var ampRatio = (a5 && a20) ? +(a5 / a20).toFixed(3) : null;

    var f = {
      code: code, name: (nameMap[code] || {}).name || '', ind: (nameMap[code] || {}).ind || '',
      liveState: (nameMap[code] || {}).state || '', liveDays: (nameMap[code] || {}).stateDays || null,
      kind: kind, lim: lim, date: ds.dates[k2],
      chg1: +chg[k2].toFixed(2),
      chg5: k2 >= 5 ? +((close[k2] / close[k2 - 5] - 1) * 100).toFixed(2) : null,
      chg20: k2 >= 20 ? +((close[k2] / close[k2 - 20] - 1) * 100).toFixed(2) : null,
      chg60: k2 >= 60 ? +((close[k2] / close[k2 - 60] - 1) * 100).toFixed(2) : null,
      pos60: pos60, amp: +amp[k2].toFixed(2), ampRatio: ampRatio
    };
    var sc = scoreOf(f);
    f.score = sc.score; f.parts = sc.parts;

    // 结果（未来，仅统计用，不进打分）
    var hit0 = isLU[k2], hit5 = false;
    for (var z3 = k2 + 1; z3 <= Math.min(n - 1, k2 + 5); z3++) if (isLU[z3]) { hit5 = true; break; }
    f.hit0 = hit0 ? 1 : 0; f.hit5 = hit5 ? 1 : 0;
    signals.push(f);

    // 台账
    var lg = ledgerMap[f.date] || (ledgerMap[f.date] = { n: 0, lu: 0, hit5n: 0 });
    lg.n++; if (hit0) lg.lu++; if (hit5) lg.hit5n++;

    // 连板 / 卖出时机（主板首板）
    if (kind === 'main' && hit0 && k2 < n - 6) {
      consec.n++;
      var c2 = isLU[k2 + 1], c3 = isLU[k2 + 2];
      if (c2) consec.c2++;
      if (c2 && c3) consec.c3++;
      var sealKey = close[k2] / high[k2] > 0.995 ? '封死' : close[k2] / high[k2] > 0.985 ? '接近封板' : '触板回落';
      if (!seal[sealKey]) seal[sealKey] = { n: 0, c2: 0 };
      seal[sealKey].n++; if (c2) seal[sealKey].c2++;
      [1, 2, 3, 5].forEach(function (h) {
        var jj = k2 + h; if (jj >= n) return;
        var r = (close[jj] / close[k2] - 1) * 100;
        var o = after[h]; o.n++; o.sum += r; if (r > 0) o.win++;
        if (o.arr.length < 200000) o.arr.push(r);
      });
    }
  }
}

// ===== 自进化：每天用最新成熟数据检查打分权重（时间外验证，达标才改）=====
// 交易日历取 K 线最长的标的，避免「某天没有新发信号」被误判成非交易日
var calCode = codes.reduce(function (m, c) {
  return (O.bars[c] && O.bars[c].length > ((O.bars[m] || []).length)) ? c : m;
}, codes[0] || '');
var calDates = ((O.bars[calCode] || []).map(function (b) { return b[0]; })).filter(Boolean).sort();
var evoRun = evo.run(signals, calDates, O.asOf || calDates[calDates.length - 1] || '');
var P = evoRun.params, ELOG = evoRun.log;
var ECUT = evo.cutoffs(P.weights);   // 分档切点随权重走，默认 9/7/5
// 用进化后的权重重算得分。parts（基础档位）不变，保证训练与展示同一口径
signals.forEach(function (x) { x.score = evo.scoreParts(x, P.weights).score; });

// ===== 汇总 =====
// 最新交易日 = 全局最大日期（signals 按代码顺序 push，末条日期不一定是最新）
var lastDate = signals.reduce(function (m, x) { return x.date > m ? x.date : m; }, '');
// 最新交易日可能有多条，取最后日期那一批
var today = signals.filter(function (x) { return x.date === lastDate; });
today.forEach(function (x) {
  var t = tierOf(x.score, ECUT);
  x.tier = t.t; x.tierCls = t.cls; x.tierNote = t.note;
  // 连板概率：当日涨停才有连板概念
  if (x.hit0) {
    x.consecProb = (seal['封死'] && seal['封死'].n) ? pct(seal['封死'].n, seal['封死'].c2) : pct(consec.n, consec.c2);
    x.consecNote = '当日已首板，历史次日连板约 ' + x.consecProb + '%';
  } else {
    x.consecProb = 0;
    x.consecNote = '当日未涨停，谈不上连板';
  }
});
today.sort(function (a, b) { return b.score - a.score || b.chg1 - a.chg1; });

// 打分分档实测（分档切点跟随自进化后的权重，默认仍是 9/7/5）
var sbl = [
  '<' + ECUT.t1 + '分',
  ECUT.t1 + '-' + (ECUT.t2 - 1) + '分',
  ECUT.t2 + '-' + (ECUT.t3 - 1) + '分',
  '≥' + ECUT.t3 + '分'
];
var sb = [{ n: 0, lu: 0 }, { n: 0, lu: 0 }, { n: 0, lu: 0 }, { n: 0, lu: 0 }];
signals.forEach(function (x) {
  var bi = evo.tierIndex(x.score, ECUT);
  sb[bi].n++; if (x.hit5) sb[bi].lu++;
});
var scoreboard = sb.map(function (o, i) { return { label: sbl[i], n: o.n, rate: pct(o.n, o.lu) }; }).reverse();

// 多维度共性
function bucketOf(items, field, bins) {
  return bins.map(function (b) {
    var g = items.filter(function (x) { return b.test(x[field]); });
    var lu = g.filter(function (x) { return x.hit5; }).length;
    return { label: b.label, n: g.length, rate: pct(g.length, lu) };
  });
}
var mainSig = signals.filter(function (x) { return x.kind === 'main'; });
var commonality = {
  chg: bucketOf(mainSig, 'chg1', [
    { label: '当日 0~3%', test: v => v != null && v < 3 },
    { label: '3~5%', test: v => v != null && v >= 3 && v < 5 },
    { label: '5~7%', test: v => v != null && v >= 5 && v < 7 },
    { label: '7%~涨停下', test: v => v != null && v >= 7 && v < 9.8 },
    { label: '当日已涨停', test: v => v != null && v >= 9.8 }
  ]),
  amp: bucketOf(mainSig, 'amp', [
    { label: '振幅 <5%', test: v => v != null && v < 5 },
    { label: '5~7%', test: v => v != null && v >= 5 && v < 7 },
    { label: '≥7%', test: v => v != null && v >= 7 }
  ]),
  pos: bucketOf(mainSig, 'pos60', [
    { label: '低位 <50%', test: v => v != null && v < 0.5 },
    { label: '偏高 50~85%', test: v => v != null && v >= 0.5 && v < 0.85 },
    { label: '贴顶 ≥85%', test: v => v != null && v >= 0.85 }
  ]),
  vol: bucketOf(mainSig, 'ampRatio', [
    { label: '缩量 <1.1', test: v => v != null && v < 1.1 },
    { label: '温和 1.1~1.3', test: v => v != null && v >= 1.1 && v < 1.3 },
    { label: '放量 ≥1.3', test: v => v != null && v >= 1.3 }
  ]),
  chg20: bucketOf(mainSig, 'chg20', [
    { label: '20日 <10%', test: v => v != null && v < 10 },
    { label: '10~20%', test: v => v != null && v >= 10 && v < 20 },
    { label: '≥20%', test: v => v != null && v >= 20 }
  ])
};

// 台账：最近 90 个交易日
var ledgerDates = Object.keys(ledgerMap).sort();
var ledger = ledgerDates.slice(-90).map(function (d) {
  var o = ledgerMap[d];
  var mature = d <= O.asOf && (ledgerDates.indexOf(d) <= ledgerDates.length - 6); // 最后5日未来窗口不足
  return { date: d, n: o.n, lu: o.lu, hit5n: o.hit5n,
    luRate: pct(o.n, o.lu), rate5: mature ? pct(o.n, o.hit5n) : null };
});

// 卖出时机
var sell = {};
[1, 2, 3, 5].forEach(function (h) {
  var o = after[h];
  sell['t' + h] = { n: o.n, avg: avgN(o.n, o.sum), med: med(o.arr), win: pct(o.n, o.win), q25: q(o.arr, 0.25), q75: q(o.arr, 0.75) };
});

// 当下判断：用最近 20 个交易日的新发 T+5 涨停率 vs 全历史基线
var recent = ledger.slice(-20).filter(function (x) { return x.rate5 != null; });  // 排除未来窗口不足的日子
var recentN = recent.reduce(function (s, x) { return s + x.n; }, 0);
var recentHit = recent.reduce(function (s, x) { return s + (x.hit5n || 0); }, 0);
var recentRate = pct(recentN, recentHit);
var allN = signals.length, allHit = signals.filter(function (x) { return x.hit5; }).length;
var allRate = pct(allN, allHit);   // 约 6.9%（含创业科创），主板基线另算
var mainRate = pct(mainSig.length, mainSig.filter(function (x) { return x.hit5; }).length);
var regime, regimeCls, regimeWhy;
if (recentRate >= mainRate * 1.15) { regime = '偏热 · 可做'; regimeCls = 'hot'; }
else if (recentRate <= mainRate * 0.8) { regime = '偏冷 · 少做'; regimeCls = 'cold'; }
else { regime = '中性 · 精选做'; regimeCls = 'mid'; }
regimeWhy = '最近20日新发 T+5 涨停率 ' + recentRate + '%，全历史主板 ' + mainRate + '%';

var verdict = {
  regime: regime, regimeCls: regimeCls, why: regimeWhy,
  recentRate: recentRate, baseRate: mainRate, allRate: allRate,
  buySell: '首板后次日平均 +' + sell.t1.avg + '%、胜率 ' + sell.t1.win + '%，但到第5日中位 ' + sell.t5.med + '%、胜率 ' + sell.t5.win + '% —— 结论：可试探但不恋战，次日冲高分批减，最多拿3天',
  consec: '首板后次日连板 ' + pct(consec.n, consec.c2) + '%、连3板 ' + pct(consec.n, consec.c3) + '%；封死涨停板的连板率 ' + (seal['封死'] ? pct(seal['封死'].n, seal['封死'].c2) : '-') + '%',
  topPick: today.length ? ('今日新发 ' + today.length + ' 只，评分最高：' + today[0].name + '（' + today[0].score + '分 · ' + today[0].tier + '）') : '今日无新发信号',
  basisNote: '本池是 ' + (O.asOf || '') + ' 收盘K线回放快照；主站实盘基准 ' + (liveAsOf || '未知')
    + '。两者不是同一天，卡片上的「主站当前状态」是后来走出来的结果，不是当时信号',
  evolve: '打分卡 ' + P.version + '（累计检查 ' + P.checks + ' 次 / 调参 ' + P.adoptions + ' 次）· '
    + (P.lastAction === 'adopt' ? '今日采纳调参' : P.lastAction === 'init' ? '初始参数' : '今日检查未改')
    + '：' + (P.lastReason || '')
};

// 自进化明细：版本、权重、每日检查留痕、验证集前后对比
var evolveOut = {
  version: P.version, trainedAt: P.trainedAt, asOf: P.asOf,
  cut: ECUT,
  checks: P.checks, adoptions: P.adoptions,
  lastCheck: P.lastCheck, lastAction: P.lastAction, lastReason: P.lastReason,
  weights: P.weights, desc: evo.FDESC, maxScore: evo.maxScoreOf(P.weights),
  trainN: ELOG.trainN || 0, validN: ELOG.validN || 0,
  trainOld: ELOG.trainOld, trainNew: ELOG.trainNew,
  validOld: ELOG.validOld, validNew: ELOG.validNew,
  validTopOld: ELOG.validTopOld, validTopNew: ELOG.validTopNew,
  lifts: ELOG.lifts || null, changed: ELOG.changed || [],
  history: (P.history || []).slice(-12)
};

var out = {
  asOf: O.asOf, liveAsOf: liveAsOf, generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
  universe: { codes: codes.length, used: Object.keys(O.bars).filter(function (c) { return kindOf(c) !== 'etf' && O.bars[c] && O.bars[c].length >= 280; }).length, signals: signals.length },
  verdict: verdict,
  evolve: evolveOut,
  today: today,
  scoreboard: scoreboard,
  commonality: commonality,
  consec: { n: consec.n, c2: pct(consec.n, consec.c2), c3: pct(consec.n, consec.c3),
    seal: Object.keys(seal).reduce(function (o, k) { return (o[k] = { n: seal[k].n, rate: pct(seal[k].n, seal[k].c2) }, o), {} }, {}) },
  sell: sell,
  ledger: ledger,
  method: {
    fresh: '三态首次转启动的交易日（由 bt_lib.dailySignals 逐日回放，为近似规则，非实盘六派）',
    limit: '主板收盘涨幅≥9.8%、创业/科创≥19.8%、北交≥29.5%',
    hit5: '新发后 5 个交易日内任一天收盘涨停',
    missing: '历史K线无成交量，量能用「振幅比」代理；无ST标记；无退市票（生存者偏差）；无北交样本',
    disclaimer: '所有百分比是历史频率，不是预测，不构成投资建议'
  }
};

fs.writeFileSync(OUT, 'window.AB_LIMITUP = ' + JSON.stringify(out) + ';\n');
console.log('新发涨停观察：' + out.universe.signals + ' 条历史信号 · ' + (lastDate || '') + ' 新发 ' + today.length + ' 只');
console.log('打分档实测：' + scoreboard.map(function (x) { return x.label + ' ' + x.rate + '%'; }).join(' / '));
console.log('自进化：' + P.version + ' · ' + P.lastAction + ' · ' + (P.lastReason || '')
  + '（训练' + (ELOG.trainN || 0) + ' / 验证' + (ELOG.validN || 0) + '）');
console.log('当下判断：' + verdict.regime + '（' + verdict.why + '）');
console.log('已写出 ' + path.relative(ROOT, OUT));
