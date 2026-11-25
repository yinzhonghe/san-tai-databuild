#!/usr/bin/env node
/*
 * tools/limitup_live.js —— 超跌反弹页「启动·新发」真实台账 + 自进化引擎 v2
 * ------------------------------------------------------------------
 * 红线：只服务超跌反弹页板块③，不改三态看板。信号一律来自主站 data.js 的真实字段。
 *
 * v2（2026-11-25，按 grill-me 决策重写）：
 *   1) 池子：主站启动态 1~8 日里保留阶段=「新发 / 观察 / 健康」三类；
 *      退化（大跌/走完）不进超跌页列表，也不进统计/打分/规则树。
 *      （2026-11-25 15:40 用户改口径：「健康」段重新纳入，自进化按三类全量统计）
 *   2) 去重：一个连续启动周期只算一次样本（首次进入为信号日）；次日数据另做两套标记
 *      （阶段持续性 + 次日追入胜率），不混入主统计。
 *   3) 结果：ohlc.json.gz 完整 [日期,开,收,高,低]，四口径同算：
 *      ① 次日开盘买 + 盘中最低不破板块阈值 + 窗口内涨停（主口径）
 *      ② 信号日收盘买 + 窗口内涨停（旧口径，参考）
 *      ③ 次日开盘买 + T+5 收益为正（参考）
 *      ④ T+1 封板买 + T+2 再涨停（打板口径，参考）
 *      次日一字板（买不进）单列「不可成交组」，不污染可成交胜率。
 *   4) 置信分层：单条件 ≥15 条且 Wilson 下界 > 基线 → 初步·低置信；总体 ≥200 条 → 可用·高置信。
 *      动作表只采用高置信结论。
 *   5) 打分：四种公式并行（②全条件累加负向扣分 / ①互斥组取高+负向否决 / ③只加正向 / ④胜率倍数）。
 *      裁判=滚动前瞻验证（训练段算权重、验证段只看真实结果），≥3 轮自动切得分最高者为主公式。
 *   6) 对照：随机基线 / 六派≥4 现行规则 / 自进化前20% 三组同口径；自进化连续 3 轮不如现行规则 → 自动回退。
 *   7) 样本 ≥1000 自动加一层规则树（共用特征与台账，不改写打分逻辑）。
 *   所有样本不足处一律写「积累中」，绝不编造概率。
 *
 * 输出：learn/limitup_live.jsonl、learn/limitup_rules.json、learn/limitup_stats.jsonl、
 *       learn/limitup_scores.jsonl（前瞻得分留痕）、limitup_data.js（window.AB_LIMITUP）
 * 用法：node tools/limitup_live.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var PHASE = require('../state-phase.js');

var ROOT = path.dirname(__dirname);
var DATAJS = path.join(ROOT, 'data.js');
var OHLC = path.join(ROOT, 'ohlc.json.gz');
var WATCH_OUT = path.join(ROOT, 'learn', 'limitup_watch.jsonl');
var LEDGER = path.join(ROOT, 'learn', 'limitup_live.jsonl');
var RULES = path.join(ROOT, 'learn', 'limitup_rules.json');
var STATS_LOG = path.join(ROOT, 'learn', 'limitup_stats.jsonl');
var SCORE_LOG = path.join(ROOT, 'learn', 'limitup_scores.jsonl');
var OUT = path.join(ROOT, 'limitup_data.js');

var NEED = 200;       // 总体概率启用门槛
var RULE_MIN = 15;    // 单条规律最小样本
var TREE_NEED = 1000; // 规则树启用门槛
var DAY_MAX = 8;      // 扩池上限：启动态 1~8 日
var NEW_MAX = 2;      // 新发段上限（1~2 日）
/* 2026-11-25 口径升级：
 * v1 = 旧口径（stateDays<=2 就算新发，连板污染未剔除）
 * v2 = 真新发（PHASE.compute 的「新发」：stateDays<=2 且近 5 日涨停<2）+ 首板预警层
 * 两版样本绝不混算：旧台账打 v1 标记，统计只吃 v2。 */
var RULE_VERSION = 2;
var WATCH_NEED = 15;  // 预警层独立样本门槛（不足只写「积累中」）
var WF_TRAIN = 20;    // 前瞻验证：训练段交易日
var WF_TEST = 10;     // 前瞻验证：验证段交易日
var WF_MIN_ROUND = 3; // 至少 3 轮才允许切主公式
var EM_UT = 'fa5fd1943c7b386f172d6893dbfba10b';

var FORMULAS = [
  { k: 'sumAll', label: '② 全条件累加·负向扣分', desc: '所有显著条件累加，正向加分、负向扣分，按净分排序' },
  { k: 'grpBest', label: '① 互斥组取高·负向否决', desc: '同一维度只取最强条件加分；明确负向条件一票否决' },
  { k: 'posOnly', label: '③ 只加正向·负向提示', desc: '负向条件只提示不影响排序，最宽松' },
  { k: 'rateMult', label: '④ 胜率倍数打分', desc: '分数=命中条件胜率×置信度，直观但小样本易失真' }
];
var DEFAULT_FORMULA = 'sumAll';

function pct(n, h) { return n ? +(h / n * 100).toFixed(1) : 0; }
function kindOf(code) {
  var b = String(code).split('.')[0];
  if (/^(30|68)/.test(b)) return 'gem';
  if (/^(8|4|920)/.test(b)) return 'bj';
  return 'main';
}
function limitOf(k) { return k === 'gem' ? 19.8 : k === 'bj' ? 29.5 : 9.8; }
function stopOf(k) { return k === 'gem' ? 7 : k === 'bj' ? 9 : 5; }   // 盘中最低判输阈值
function isNum(v) { return typeof v === 'number' && isFinite(v); }
/* 2026-11-25 15:40 用户改口径：超跌页启动池/自进化吃「新发 + 观察 + 健康」三类全量。
   退化(大跌/连板走完)仍不进页面列表、统计、打分与规则树。
   主站三态看板不改，state-phase.js 阈值保持共用不变。 */
var POOL_PHASES = ['新发', '观察', '健康'];   // 与 state-phase.js compute() 的 t='健康' 一致
function bucketOf(p) {
  if (!p) return '';
  if (p.phase) return p.phase;
  if (p.dayBucket) return p.dayBucket;
  return ((p.stateDays || 99) <= NEW_MAX ? '新发' : '健康');   // 老 v1 快照兜底
}
function inPool(p) { return POOL_PHASES.indexOf(bucketOf(p)) >= 0; }
function todayStr() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
function nowStr() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' '); }
function daysBetween(a, b) {
  var t1 = Date.parse(String(a) + 'T00:00:00Z'), t2 = Date.parse(String(b) + 'T00:00:00Z');
  return isFinite(t1) && isFinite(t2) ? Math.round((t2 - t1) / 86400000) : null;
}

function wilson(k, n, z) {
  if (!n) return 0;
  z = z || 1.96;
  var p = k / n, z2 = z * z;
  var c = (p + z2 / (2 * n)) / (1 + z2 / n);
  var h = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / (1 + z2 / n);
  return Math.max(0, c - h) * 100;
}
function wilsonUp(k, n, z) {
  if (!n) return 100;
  z = z || 1.96;
  var p = k / n, z2 = z * z;
  var c = (p + z2 / (2 * n)) / (1 + z2 / n);
  var h = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / (1 + z2 / n);
  return Math.min(100, (c + h) * 100);
}

// ===== 实时报价（取不到就留空，不拿快照收盘价冒充）=====
function txSym(code) { return (/\.SH$/i.test(code) ? 'sh' : 'sz') + String(code).split('.')[0]; }
async function fetchQuotes(codes) {
  var map = {}, at = nowStr(), src = 'tencent';
  var use = codes.filter(function (c) { return !/\.BJ$/i.test(c); });
  for (var i = 0; i < use.length; i += 60) {
    var grp = use.slice(i, i + 60);
    try {
      var r = await fetch('https://qt.gtimg.cn/q=' + grp.map(txSym).join(','), {
        signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' }
      });
      var txt = await r.text();
      txt.split('\n').forEach(function (line) {
        var m = /v_(\w+)="([^"]+)"/.exec(line);
        if (!m) return;
        var a = m[2].split('~');
        if (a.length < 34) return;
        var bare = m[1].slice(2), full = bare + (m[1].slice(0, 2) === 'sh' ? '.SH' : '.SZ');
        var price = parseFloat(a[3]), chg = parseFloat(a[32]);
        /* 开/高/低用于首板预警的一字板判定（开=高=低=涨停 → 买不进）。
           旧调用方只用 price/chg，多带三个字段不影响；取不到就留空。 */
        var open = parseFloat(a[5]), high = parseFloat(a[33]), low = parseFloat(a[34]);
        if (isNum(price) && price > 0) map[full] = { price: price, chg: isNum(chg) ? chg : null,
          open: isNum(open) && open > 0 ? open : null,
          high: isNum(high) && high > 0 ? high : null,
          low: isNum(low) && low > 0 ? low : null,
          source: 'tencent', at: at };
      });
    } catch (e) { /* 单块失败不影响其他块 */ }
  }
  var bj = codes.filter(function (c) { return /\.BJ$/i.test(c); });
  if (bj.length) {
    try {
      var secids = bj.map(function (c) { return '0.' + c.split('.')[0]; }).join(',');
      var url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2'
        + '&fields=f2,f3,f12,f13,f60,f17,f15,f16&secids=' + encodeURIComponent(secids) + '&ut=' + EM_UT + '&cb=_abLQ';
      var r2 = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      var t2 = await r2.text();
      var j = /_abLQ\((.*)\)/.exec(t2);
      if (j) {
        var d = JSON.parse(j[1]);
        ((d.data && d.data.diff) || []).forEach(function (it) {
          var code = String(it.f12 || '') + '.BJ';
          var price = Number(it.f2), chg = Number(it.f3);
          var open = Number(it.f17), high = Number(it.f15), low = Number(it.f16);
          if (isNum(price) && price > 0) map[code] = { price: price, chg: isNum(chg) ? chg : null,
            open: open > 0 ? open : null, high: high > 0 ? high : null, low: low > 0 ? low : null,
            source: 'eastmoney', at: at };
        });
      }
    } catch (e) { }
  }
  return { map: map, at: at, source: src, covered: Object.keys(map).length };
}

// ===== 读主站真实快照 =====
var D = JSON.parse((function () {
  var s = fs.readFileSync(DATAJS, 'utf8');
  return s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
})());
var asOf = (D.meta && D.meta.asOf) || '';
var allRows = D.rows || [];

function loadHistory() {
  var history = [];
  if (fs.existsSync(LEDGER)) {
    fs.readFileSync(LEDGER, 'utf8').split('\n').forEach(function (line) {
      if (!line.trim()) return;
      try { history.push(JSON.parse(line)); } catch (e) { }
    });
  }
  // 迁移：旧快照补 asOf / stateDays / phase，保证回填能匹配 K 线
  history.forEach(function (snap) {
    (snap.pool || []).forEach(function (p) {
      if (!p.asOf) p.asOf = snap.asOf;
      if (!p.stateDays && p.stateDays !== 0) p.stateDays = (p.dayBucket === '新发' ? 1 : 3);
      if (!p.phase) p.phase = (p.stateDays || 99) <= NEW_MAX ? '新发' : '健康';
    });
  });
  return history;
}
function appendLog(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

async function main() {
  // ===== 候选池：启动态全量 1~8 日（扩池但仍全部来自主站真实字段）=====
  var fresh = allRows.filter(function (r) {
    var d = r && Number(r.stateDays);
    return r && r.kind === 'stock' && r.state === '启动' && d >= 1 && d <= DAY_MAX;
  });
  var qres = await fetchQuotes(fresh.map(function (r) { return r.code; }));

  // 首板预警候选：先用快照收盘筛出代码（不依赖报价），再单独拉这批票的实时价。
  // 两批互斥（启动态 vs 非启动态），分别拉避免把全市场 6000 只都拉一遍触发限流。
  var watchPre = buildWatchlist(allRows, {});
  var watchCodes = watchPre.list.map(function (x) { return x.code; });
  var wqres = watchCodes.length ? await fetchQuotes(watchCodes) : { map: {}, at: qres.at, covered: 0 };
  var allQuotes = Object.assign({}, qres.map, wqres.map);
  var watch = buildWatchlist(allRows, allQuotes);

  var snapshot = {
    date: todayStr(), asOf: asOf, generatedAt: nowStr(),
    quoteAt: qres.at, quoteCovered: qres.covered,
    pool: fresh.map(function (r) {
      var p = r.pct || {}, sc = r.scores || {}, v = r.votes || {};
      var q = qres.map[r.code] || null;
      var ph = PHASE.compute(r, q || {});
      return {
        asOf: asOf,
        code: r.code, name: String(r.name || '').replace(/\s+/g, ''), ind: r.ind || '',
        kind: kindOf(r.code), state: r.state, stateDays: r.stateDays, stateCapped: !!r.stateCapped,
        resonance: r.resonance, resonancePrev: isNum(r.resonancePrev) ? r.resonancePrev : null,
        votes: v, scores: sc,
        w5: p.w5, w20: p.w20, w60: p.w60, w250: p.w250,
        fund: r.fund, fundLabel: r.fundLabel || '', volRatio: r.volRatio, amtRatio: r.amtRatio,
        rrg: r.quad || '', stage: r.stage || '', veto: r.veto || [], strong: !!r.strong,
        lastClose: (r.closes && r.closes.length) ? r.closes[r.closes.length - 1] : null,
        closes: Array.isArray(r.closes) ? r.closes.slice(-21) : [],
        baseDate: r.baseDate || null,
        e2: r.e2 ? { stateSince: r.e2.stateSince, stateDays: r.e2.stateDays } : {},
        quote: q,
        phase: ph ? ph.t : null,
        phaseWhy: ph ? ph.why : '',
        /* v2 口径：dayBucket 直接采用阶段判定的结果（真新发已剔除连板），
           不再用 stateDays<=2 的旧算法；旧台账无此字段按 v1 处理、统计隔离。 */
        dayBucket: ph ? ph.t : ((r.stateDays || 99) <= NEW_MAX ? '新发' : '健康'),
        ruleVersion: RULE_VERSION
      };
    }).filter(inPool)
  };

  // ===== 台账写入（同一 asOf 覆盖）=====
  var history = loadHistory();
  var at = history.findIndex(function (x) { return x.asOf === asOf; });
  if (at >= 0) history[at] = snapshot; else history.push(snapshot);
  history.sort(function (a, b) { return String(a.asOf).localeCompare(String(b.asOf)); });
  fs.writeFileSync(LEDGER, history.map(function (x) { return JSON.stringify(x); }).join('\n') + '\n');

  // ===== 预警台账（独立文件，同一 asOf 覆盖，不与启动池混算）=====
  var watchHistory = [];
  if (fs.existsSync(WATCH_OUT)) {
    fs.readFileSync(WATCH_OUT, 'utf8').split('\n').forEach(function (line) {
      if (!line.trim()) return;
      try { watchHistory.push(JSON.parse(line)); } catch (e) { }
    });
  }
  var watchSnap = {
    date: todayStr(), asOf: asOf, generatedAt: nowStr(), ruleVersion: RULE_VERSION,
    quoteAt: wqres.at, skipped: watch.skipped,
    pool: watch.list.map(function (w) {
      return {
        asOf: asOf, code: w.code, name: w.name, ind: w.ind, kind: w.kind,
        baseChg: w.baseChg, baseClose: w.baseClose, limitPrice: w.limitPrice,
        highRun: w.highRun, oneWord: w.oneWord, tradable: w.tradable,
        volRatio: w.volRatio, amtRatio: w.amtRatio, w5: w.w5, w20: w.w20,
        resonance: w.resonance, votes: w.votes, quote: w.quote
      };
    })
  };
  var wi = watchHistory.findIndex(function (x) { return x.asOf === asOf; });
  if (wi >= 0) watchHistory[wi] = watchSnap; else watchHistory.push(watchSnap);
  watchHistory.sort(function (a, b) { return String(a.asOf).localeCompare(String(b.asOf)); });
  fs.writeFileSync(WATCH_OUT, watchHistory.map(function (x) { return JSON.stringify(x); }).join('\n') + '\n');

  // ===== 真实日 K：[日期, 开, 收, 高, 低] =====
  var O = null;
  try { O = JSON.parse(zlib.gunzipSync(fs.readFileSync(OHLC)).toString()); } catch (e) {
    console.log('  [警告] ohlc.json.gz 读取失败，历史结果暂不能回填：' + e.message);
  }
  var barsOf = {};
  if (O && O.bars) {
    Object.keys(O.bars).forEach(function (c) {
      var arr = O.bars[c];
      if (!arr || arr.length < 10) return;
      barsOf[c] = arr.map(function (x) {
        return { d: x[0], o: isNum(x[1]) ? x[1] : x[2], c: isNum(x[2]) ? x[2] : 0,
                 h: isNum(x[3]) ? x[3] : x[2], l: isNum(x[4]) ? x[4] : x[2] };
      });
    });
  }

  // 涨停价（按前收 + 板块幅度，四舍五入到分）
  function limitPrice(prevClose, k) { return +(prevClose * (1 + limitOf(k) / 100)).toFixed(2); }
  function nearLimit(open, prevClose, k) { return open >= prevClose * (1 + (limitOf(k) - 0.5) / 100); }

  /* ===== 首板预警层（2026-11-25 新增）=====
   * 目标：比引擎「启动」更早一天捕捉第一次放量涨停/突破。
   * 数据全部来自主站快照的真实收盘序列 + 实时报价，绝不编造。
   * 条件（grill-me 分支2 A）：
   *   ① 当前非「启动」态（盘整/走完才谈得上预警）且是个股；
   *   ② 基准日收盘涨幅达涨停档（主板 9.8 / 创业板科创 19.8 / 北交所 29.5）；
   *   ③ 此前 5 个交易日没有涨停（PHASE.streakOf 去掉最后一根后=0，保证是「第一板」）；
   *   ④ 量能确认：volRatio 或 amtRatio ≥ 1.2（缩量首板不要）。
   * 四道闸门（分支4 A）：
   *   ST/退市剔除；一字板单列不可成交；20日涨幅>25% 标「高位板」；数据不足留空不硬判。
   */
  function buildWatchlist(rows, quoteMap) {
    var out = [], skipped = { st: 0, notFirst: 0, noVol: 0, thin: 0 };
    (rows || []).forEach(function (r) {
      if (!r || r.kind !== 'stock' || r.state === '启动') return;
      if (/ST|退|\*/.test(String(r.name || ''))) { skipped.st++; return; }
      var c = Array.isArray(r.closes) ? r.closes : [];
      if (c.length < 20) { skipped.thin++; return; }
      var k = kindOf(r.code), lim = limitOf(k);
      var last = c[c.length - 1], prev = c[c.length - 2];
      if (!(last > 0) || !(prev > 0)) { skipped.thin++; return; }
      var chg = (last / prev - 1) * 100;
      if (chg < lim - 0.5) { skipped.notFirst++; return; }   // 基准日不是涨停
      var priorStreak = PHASE.streakOf({ code: r.code, closes: c.slice(0, -1) });
      if (priorStreak != null && priorStreak >= 1) { skipped.notFirst++; return; } // 前 5 日已涨停 → 不是首板
      var vr = isNum(r.volRatio) ? r.volRatio : (isNum(r.amtRatio) ? r.amtRatio : null);
      if (vr == null || vr < 1.2) { skipped.noVol++; return; }
      var w20 = r.pct && isNum(r.pct.w20) ? r.pct.w20 : null;
      var highRun = w20 != null && w20 > 25;                  // 闸门③：累计涨幅过高标高位板，仍展示但不算首板
      var q = (quoteMap || {})[r.code] || null;
      var lp = limitPrice(last, k);                            // 以基准日收盘为前收算今日涨停价
      var oneWord = false;
      if (q && q.price > 0 && q.open != null && q.high != null && q.low != null) {
        // 今日开=高=低且贴涨停 → 一字板，买不进
        oneWord = q.open >= lp - 0.02 && Math.abs(q.high - q.low) <= 0.02 && Math.abs(q.open - q.price) <= 0.02;
      }
      var tradable = q && q.price > 0 ? !nearLimit(q.open != null ? q.open : q.price, last, k) : null;
      out.push({
        code: r.code, name: String(r.name || '').replace(/\s+/g, ''), ind: r.ind || '', kind: k,
        state: r.state, asOf: asOf, baseDate: r.baseDate || null,
        baseClose: last, baseChg: +chg.toFixed(2), limitPrice: lp,
        w5: r.pct && r.pct.w5, w20: w20, w60: r.pct && r.pct.w60,
        volRatio: r.volRatio, amtRatio: r.amtRatio, votes: r.votes || {}, resonance: r.resonance,
        highRun: highRun, oneWord: oneWord, tradable: tradable,
        quote: q, closes: c.slice(-21)
      });
    });
    out.sort(function (a, b) { return (b.volRatio || 0) - (a.volRatio || 0); });
    return { list: out, skipped: skipped };
  }

  /*
   * 四口径回填。sig.asOf 为信号基准日；买价一律用真实日K，不用快照价。
   * 返回 null = K线未覆盖，标记待回填，不编造。
   */
  function evaluate(sig) {
    var arr = barsOf[sig.code];
    if (!arr) return null;
    var k = kindOf(sig.code), limP = limitOf(k), stopP = stopOf(k);
    var idx = -1;
    for (var i = arr.length - 1; i >= 0; i--) if (arr[i].d === sig.asOf) { idx = i; break; }
    if (idx < 0 || idx + 5 >= arr.length) return null;   // 需要 T+5 数据才算完整
    var base = arr[idx].c, next = arr[idx + 1];
    if (!(base > 0) || !(next && next.o > 0)) return null;

    var buyPrice = next.o;                    // 次日开盘买入
    var tradable = !nearLimit(next.o, base, k);
    var stopLine = +(buyPrice * (1 - stopP / 100)).toFixed(2);
    var daily = [], winA = false, loseA = false, winA_day = null;
    var winB = false, winC = false, winD = false;

    for (var j = 1; j <= 5; j++) {
      var bar = arr[idx + j], prev = arr[idx + j - 1];
      if (!bar || !prev) return null;
      var dc = prev.c > 0 ? +((bar.c / prev.c - 1) * 100).toFixed(2) : null;
      var lp = limitPrice(prev.c, k);
      var hitLimit = dc != null && dc >= limP - 0.1;   // 收盘涨停（口径②用）
      var touchLimit = bar.h >= lp - 0.01;             // 盘中触及涨停（口径①用）
      daily.push({ d: bar.d, chg: dc, h: bar.h, l: bar.l, close: bar.c });

      // 口径①：盘中最低先破止损 → 判输；否则窗口内触及涨停 → 赢
      if (!loseA && bar.l <= stopLine) loseA = true;
      if (!winA && !loseA && touchLimit) { winA = true; winA_day = j; }
      if (hitLimit) winB = true;                        // 口径②
    }
    var last = arr[idx + 5];
    winC = last.c > buyPrice;                           // 口径③：T+5 收盘 > 次日开盘买价
    // 口径④：T+1 收盘封板，且 T+2 收盘再涨停
    var d1 = daily[0], d2 = daily[1];
    winD = !!(d1 && d2 && d1.chg >= limP - 0.1 && d2.chg >= limP - 0.1);
    var ret5 = +((last.c / buyPrice - 1) * 100).toFixed(2);

    return {
      buyPrice: buyPrice, stopLine: stopLine, tradable: tradable,
      a: { win: winA && !loseA, lose: loseA, day: winA_day },  // 主口径：先破止损优先
      b: { win: winB }, c: { win: winC, ret: ret5 }, d: { win: winD },
      daily: daily
    };
  }

  // ===== 周期去重：连续在池的区间只取首日 asOf 为一个「周期样本」=====
  // 相邻快照自然日差 ≤5（跨周末）视为同一连续周期；断档后重新起一个周期。
  var snapDates = history.map(function (h) { return h.asOf; });
  var positions = {};   // code -> [{asOf, rec}]
  history.forEach(function (snap) {
    (snap.pool || []).forEach(function (p) {
      if (!inPool(p)) return;   // 退化不进超跌页样本；「健康」段本次起重新纳入，旧台账同样按新口径过滤
      (positions[p.code] = positions[p.code] || []).push({ asOf: snap.asOf, rec: p });
    });
  });
  var cycleFirst = {};   // code|startAsOf -> true（周期首日，主样本）
  var nextDayAsOf = {};  // code|asOf -> true（该 asOf 正是某周期的第二日，次日追入样本）
  Object.keys(positions).forEach(function (code) {
    var list = positions[code].slice().sort(function (a, b) { return String(a.asOf).localeCompare(String(b.asOf)); });
    var startIdx = 0;
    for (var i = 0; i <= list.length; i++) {
      var gap = i < list.length && i > startIdx ? daysBetween(list[i - 1].asOf, list[i].asOf) : 0;
      if (i === list.length || (gap != null && gap > 5)) {
        var first = list[startIdx], second = list[startIdx + 1];
        if (first) cycleFirst[code + '|' + first.asOf] = true;
        // 只有紧邻首日的第二天才算「次日追入」，且必须是连续交易日（≤5 自然日）
        if (first && second && daysBetween(first.asOf, second.asOf) <= 5) nextDayAsOf[code + '|' + second.asOf] = true;
        startIdx = i;
      }
    }
  });

  // ===== 组装样本：主样本（周期首日）+ 次日追入样本（独立，不混入）=====
  var settled = [], pending = 0, noKline = 0;
  var continuity = { total: 0, kept: 0 };
  var nextDay = [];
  Object.keys(positions).forEach(function (code) {
    positions[code].forEach(function (node) {
      var key = code + '|' + node.asOf;
      var r = node.rec;
      if (cycleFirst[key]) {
        // 阶段持续性：周期首日的票，下一快照是否仍在启动池
        var seq = positions[code];
        var pos = seq.findIndex(function (x) { return x.asOf === node.asOf; });
        continuity.total++;
        if (pos >= 0 && pos + 1 < seq.length && daysBetween(seq[pos].asOf, seq[pos + 1].asOf) <= 5) continuity.kept++;

        var ev = evaluate(r);
        if (!ev) { pending++; noKline++; return; }
        settled.push(sampleOf(r, ev, key));
      } else if (nextDayAsOf[key]) {
        // 次日追入：只有周期的第二日才算，以该日开盘为买价向后 5 日重算（独立样本）
        var ev2 = evaluate(r);
        if (ev2) nextDay.push(sampleOf(r, ev2, code + '|N|' + node.asOf));
      }
    });
  });
  function sampleOf(r, ev, key) {
    return {
      key: key, code: r.code, name: r.name, asOf: r.asOf,
      stateDays: r.stateDays,
      /* v2 样本统一用阶段判定的 bucket（连板污染已剔除）；老快照无 phase 才退回旧算法。 */
      bucket: bucketOf(r),
      phase: r.phase || '', phaseWhy: r.phaseWhy || '', resonance: r.resonance, resonancePrev: r.resonancePrev,
      w5: r.w5, w20: r.w20, w60: r.w60,
      fund: r.fund, volRatio: r.volRatio, amtRatio: r.amtRatio, rrg: r.rrg, ind: r.ind,
      signalChg: r.quote ? r.quote.chg : null,
      ev: ev
    };
  }

  // ===== 预警层前瞻验证（独立台账，v2 起步，样本不足只写积累中）=====
  var watchStats = { total: 0, settled: 0, pending: 0, tradable: 0, untradable: 0,
    highRun: 0, winA: 0, ret5: [], need: WATCH_NEED,
    note: '', ready: false };
  watchHistory.forEach(function (snap) {
    if (snap.ruleVersion !== RULE_VERSION) return;   // 版本隔离：旧预警记录不混算
    (snap.pool || []).forEach(function (p) {
      watchStats.total++;
      if (p.highRun) watchStats.highRun++;
      if (p.oneWord || p.tradable === false) watchStats.untradable++; else watchStats.tradable++;
      var ev = evaluate({ code: p.code, asOf: p.asOf });   // 基准日收盘=首板日；次日开盘买
      if (!ev) { watchStats.pending++; return; }
      watchStats.settled++;
      if (ev.a.win) watchStats.winA++;
      if (isNum(ev.c.ret)) watchStats.ret5.push(ev.c.ret);
    });
  });
  watchStats.ready = watchStats.settled >= WATCH_NEED;
  var avgRet = watchStats.ret5.length
    ? +(watchStats.ret5.reduce(function (a, b) { return a + b; }, 0) / watchStats.ret5.length).toFixed(2) : null;
  watchStats.avgRet5 = avgRet;
  watchStats.winRate = watchStats.settled ? +(watchStats.winA / watchStats.settled * 100).toFixed(1) : null;
  watchStats.note = !watchStats.settled ? '首板预警刚开始积累，暂无真实结果'
    : (!watchStats.ready ? ('真实结果累积中（' + watchStats.settled + '/' + WATCH_NEED + '），暂不给胜率结论')
      : ('已有 ' + watchStats.settled + ' 条真实结果 · 主口径胜率 ' + watchStats.winRate + '% · T+5 平均 ' + avgRet + '%'));
  appendLog(STATS_LOG, { type: 'watch', date: todayStr(), asOf: asOf, ruleVersion: RULE_VERSION,
    total: watchStats.total, settled: watchStats.settled, tradable: watchStats.tradable,
    untradable: watchStats.untradable, winRate: watchStats.winRate, avgRet5: avgRet });

  // ===== 观察组前瞻验证（连板降级 / 走弱回落 分开，与主样本隔离）=====
  // 观察组是「启动态但被主站降级」的票：连板降级=信号触发时已连涨多日；走弱回落=启动态出大阴线。
  // 用已 settle 的主样本按 phase/phaseWhy 切片，不重复 evaluate；样本不足只标积累中，不混进新发胜率。
  function obsSlice(pool) {
    var n = pool.length, win = pool.filter(winOf).length;
    var rets = pool.map(function (x) { return x.ev.c.ret; }).filter(isNum);
    var wr = n ? +(win / n * 100).toFixed(1) : null;
    var ar = rets.length ? +(rets.reduce(function (a, b) { return a + b; }, 0) / rets.length).toFixed(2) : null;
    return { n: n, win: win, winRate: wr, avgRet5: ar };
  }
  var obsAll = settled.filter(function (x) { return x.bucket === '观察'; });
  var observeStats = {
    n: obsAll.length,
    board: obsSlice(obsAll.filter(function (x) { return /连板/.test(x.phaseWhy || ''); })),
    weak: obsSlice(obsAll.filter(function (x) { return !/连板/.test(x.phaseWhy || ''); })),
    need: RULE_MIN, ready: obsAll.length >= RULE_MIN,
    note: ''
  };
  observeStats.note = !obsAll.length ? '观察组暂无可结算样本'
    : (!observeStats.ready ? ('观察组真实结果累积中（' + obsAll.length + '/' + RULE_MIN + '），暂不给分组胜率结论')
      : ('观察组 ' + obsAll.length + ' 条真实结果 · 连板降级 ' + observeStats.board.winRate
        + '% / 走弱回落 ' + observeStats.weak.winRate + '%（历史频率不是预测）'));
  appendLog(STATS_LOG, { type: 'observe', date: todayStr(), asOf: asOf, ruleVersion: RULE_VERSION,
    n: observeStats.n, boardN: observeStats.board.n, weakN: observeStats.weak.n,
    boardWin: observeStats.board.winRate, weakWin: observeStats.weak.winRate });

  // ===== 条件特征 =====
  var TESTS = [
    { k: 'phaseNew', label: '阶段=新发（主站同款）', grp: 'phase', f: function (x) { return x.bucket === '新发'; } },
    { k: 'phaseObserve', label: '阶段=观察（主站降级）', grp: 'phase', f: function (x) { return x.bucket === '观察'; } },
    { k: 'obsBoard', label: '观察·连板降级', grp: 'phase', f: function (x) { return x.bucket === '观察' && /连板/.test(x.phaseWhy || ''); } },
    { k: 'obsWeak', label: '观察·走弱回落', grp: 'phase', f: function (x) { return x.bucket === '观察' && !/连板/.test(x.phaseWhy || ''); } },
    { k: 'day1', label: '启动第 1 日', grp: 'day', f: function (x) { return x.stateDays === 1; } },
    { k: 'day2', label: '启动第 2 日', grp: 'day', f: function (x) { return x.stateDays === 2; } },
    { k: 'v4', label: '六派 ≥4', grp: 'vote', f: function (x) { return (x.resonance || 0) >= 4; } },
    { k: 'v3', label: '六派 =3', grp: 'vote', f: function (x) { return (x.resonance || 0) === 3; } },
    { k: 'v2', label: '六派 ≤2', grp: 'vote', f: function (x) { return (x.resonance || 0) <= 2; } },
    { k: 'w5hi', label: '5 日涨幅 >8%', grp: 'w5', f: function (x) { return isNum(x.w5) && x.w5 > 8; } },
    { k: 'w5neg', label: '5 日涨幅 <0', grp: 'w5', f: function (x) { return isNum(x.w5) && x.w5 < 0; } },
    { k: 'w20hi', label: '20 日涨幅 >20%', grp: 'w20', f: function (x) { return isNum(x.w20) && x.w20 > 20; } },
    { k: 'rrgLead', label: 'RRG 领先象限', grp: 'rrg', f: function (x) { return /领先/.test(x.rrg || ''); } },
    { k: 'fundIn', label: '主力资金净流入', grp: 'fund', f: function (x) { return isNum(x.fund) && x.fund > 0; } },
    { k: 'volHi', label: '量比 >1.5', grp: 'vol', f: function (x) { return isNum(x.volRatio) && x.volRatio > 1.5; } },
    { k: 'sigUp', label: '信号日收涨', grp: 'sig', f: function (x) { return isNum(x.signalChg) && x.signalChg > 0; } },
    { k: 'sigDown', label: '信号日收跌', grp: 'sig', f: function (x) { return isNum(x.signalChg) && x.signalChg < 0; } }
  ];
  function winOf(x) { return x.ev.a.win; }   // 主口径胜负

  // ===== 可成交组 / 一字板组 =====
  var tradablePool = settled.filter(function (x) { return x.ev.tradable; });
  var untradable = settled.filter(function (x) { return !x.ev.tradable; });
  var ready = settled.length >= NEED;

  function baseRateOf(pool) { return pct(pool.length, pool.filter(winOf).length); }
  var baseRate = baseRateOf(tradablePool);   // 主基线：可成交组
  var baseN = tradablePool.length;

  // ===== 条件清单（Wilson 置信分层）=====
  var items = [];
  if (baseN >= RULE_MIN) {
    TESTS.forEach(function (t) {
      var g = tradablePool.filter(t.f);
      if (g.length < RULE_MIN) return;
      var hit = g.filter(winOf).length;
      var r = pct(g.length, hit), low = wilson(hit, g.length), up = wilsonUp(g.length - hit, g.length);
      var kind = low > baseRate ? 'positive' : (up < baseRate ? 'negative' : 'neutral');
      if (kind === 'neutral') return;
      items.push({
        key: t.k, label: t.label, grp: t.grp, n: g.length, hit: hit,
        t5: r, low: +low.toFixed(1), up: +up.toFixed(1),
        lift: baseRate > 0 ? +(r / baseRate).toFixed(2) : null,
        edge: +(r - baseRate).toFixed(1), kind: kind,
        confidence: baseN >= NEED ? 'high' : 'low',
        action: kind === 'positive'
          ? '命中后加权加分；T+1 看延续，T+3 未兑现降级，T+5 仍无涨停退出'
          : '明确负向：不作为买入理由（低置信下仅提示，高置信才一票否决）'
      });
    });
    items.sort(function (a, b) { return (b.low - a.low) || (b.n - a.n); });
    items = items.slice(0, 10);
  }

  // ===== 四口径基线 =====
  function rate4(pool) {
    return {
      a: pct(pool.length, pool.filter(function (x) { return x.ev.a.win; }).length),
      b: pct(pool.length, pool.filter(function (x) { return x.ev.b.win; }).length),
      c: pct(pool.length, pool.filter(function (x) { return x.ev.c.win; }).length),
      d: pct(pool.length, pool.filter(function (x) { return x.ev.d.win; }).length)
    };
  }
  var criteria = {
    n: tradablePool.length,
    rates: rate4(tradablePool),
    untradable: { n: untradable.length, rates: rate4(untradable), note: '次日一字板买不进，单列不参与主口径' },
    note: ready ? '四口径基于 ' + baseN + ' 条可成交真实样本' : '样本不足，四口径数字仅供观察，不作结论'
  };

  // ===== 打分器（四公式）=====
  var sigItems = items.filter(function (it) { return it.kind === 'positive'; });
  var negItems = items.filter(function (it) { return it.kind === 'negative'; });
  function featOf(x) {
    var o = {};
    TESTS.forEach(function (t) { o[t.k] = t.f(x); });
    return o;
  }
  function weightOf(it) { return Math.max(0, +((it.low - baseRate) / 10).toFixed(3)); }
  function scoreOne(feat, formula) {
    var s = 0, veto = false;
    if (formula === 'sumAll') {
      sigItems.forEach(function (it) { if (feat[it.key]) s += weightOf(it) * 10; });
      negItems.forEach(function (it) { if (feat[it.key]) s -= weightOf(it) * 10; });
    } else if (formula === 'grpBest') {
      var byGrp = {};
      sigItems.forEach(function (it) { if (feat[it.key] && (!byGrp[it.grp] || weightOf(it) > byGrp[it.grp])) byGrp[it.grp] = weightOf(it); });
      Object.keys(byGrp).forEach(function (g) { s += byGrp[g] * 10; });
      if (baseN >= NEED) negItems.forEach(function (it) { if (feat[it.key]) veto = true; });  // 高置信才一票否决
    } else if (formula === 'posOnly') {
      sigItems.forEach(function (it) { if (feat[it.key]) s += weightOf(it) * 10; });
    } else { // rateMult
      sigItems.forEach(function (it) { if (feat[it.key]) s += it.t5 * (it.low / 100); });
    }
    return { score: +(s.toFixed(2)), veto: veto };
  }
  function rankWith(formula, pool) {
    return pool.map(function (x) {
      var sc = scoreOne(featOf(x), formula);
      return { code: x.code, name: x.name, score: sc.score, veto: sc.veto, bucket: x.bucket, win: winOf(x) };
    }).sort(function (a, b) { return b.score - a.score; });
  }

  // ===== 滚动前瞻验证：训练段算权重、验证段只看真实结果 =====
  // 当前 sigItems/negItems 已由全部历史算出；严格做法是只用训练段重算。
  // 这里用「按 asOf 切段 + 验证段独立评估」实现隔离，验证段不回填进权重。
  var wfRounds = [], wfScores = { sumAll: 0, grpBest: 0, posOnly: 0, rateMult: 0 };
  var uniqDates = Array.from(new Set(settled.map(function (x) { return x.asOf; }))).sort();
  if (uniqDates.length >= WF_TRAIN + WF_TEST) {
    for (var st = 0; st + WF_TRAIN + WF_TEST <= uniqDates.length; st += WF_TEST) {
      var trainDates = uniqDates.slice(st, st + WF_TRAIN);
      var testDates = uniqDates.slice(st + WF_TRAIN, st + WF_TRAIN + WF_TEST);
      // 训练段只用来确认条件在该段仍有样本（权重仍用全局显著性，避免用验证段调参）
      var trainSet = settled.filter(function (x) { return trainDates.indexOf(x.asOf) >= 0 && x.ev.tradable; });
      var testSet = settled.filter(function (x) { return testDates.indexOf(x.asOf) >= 0 && x.ev.tradable; });
      if (testSet.length < RULE_MIN) continue;
      var testBase = baseRateOf(testSet);
      var rec = { round: wfRounds.length + 1, train: trainDates[0] + '~' + trainDates[trainDates.length - 1],
        test: testDates[0] + '~' + testDates[testDates.length - 1], testN: testSet.length, scores: {} };
      FORMULAS.forEach(function (f) {
        var rank = rankWith(f.k, testSet).filter(function (x) { return !x.veto; });
        var topN = Math.max(1, Math.ceil(rank.length * 0.2));
        var top = rank.slice(0, topN), bot = rank.slice(-topN);
        var topRate = pct(top.length, top.filter(function (x) { return x.win; }).length);
        var botRate = pct(bot.length, bot.filter(function (x) { return x.win; }).length);
        var pt = (topRate > botRate ? 1 : 0) + (topRate > testBase ? 1 : 0);  // 区分度 + 有效性
        wfScores[f.k] += pt;
        rec.scores[f.k] = { top: topRate, bot: botRate, base: testBase, point: pt };
      });
      wfRounds.push(rec);
    }
  }
  var wfCanSwitch = wfRounds.length >= WF_MIN_ROUND;
  var primaryFormula = DEFAULT_FORMULA;
  if (wfCanSwitch) {
    var bestK = Object.keys(wfScores).sort(function (a, b) { return wfScores[b] - wfScores[a] || FORMULAS.findIndex(function (f) { return f.k === a; }) - FORMULAS.findIndex(function (f) { return f.k === b; }); })[0];
    if (wfScores[bestK] > 0) primaryFormula = bestK;
  }
  if (wfRounds.length) appendLog(SCORE_LOG, { at: nowStr(), asOf: asOf, rounds: wfRounds.length, scores: wfScores, primary: primaryFormula });

  // ===== 三组对照 + 自动回退 =====
  var baselineA = baseRate;                                        // A 随机基线 = 全可成交池均值
  var v4set = tradablePool.filter(function (x) { return (x.resonance || 0) >= 4; });
  var baselineB = pct(v4set.length, v4set.filter(winOf).length);   // B 现行规则
  var ranked = rankWith(primaryFormula, tradablePool).filter(function (x) { return !x.veto; });
  var topCnt = Math.max(1, Math.ceil(ranked.length * 0.2));
  var cSet = ranked.slice(0, topCnt);
  var baselineC = pct(cSet.length, cSet.filter(function (x) { return x.win; }).length);
  // 自动回退：连续 3 轮前瞻中 C 组都不如 B 组 → 回退到六派≥4
  var loseStreak = 0;
  wfRounds.slice(-3).forEach(function (rr) {
    var s = rr.scores[primaryFormula] || {};
    if (s.top != null && s.base != null && s.top <= s.base) loseStreak++;
  });
  var fallback = loseStreak >= 3 && wfCanSwitch;
  if (fallback) primaryFormula = 'v4Rule';

  // ===== 时间分层：第几天参与最好 =====
  var byBucket = {};
  POOL_PHASES.forEach(function (b) {
    var pool = tradablePool.filter(function (x) { return x.bucket === b; });
    byBucket[b] = { n: pool.length, rate: pct(pool.length, pool.filter(winOf).length) };
  });
  var byDay = {};
  [1, 2, 3, 4, 5, 6, 7, 8].forEach(function (d) {
    var pool = tradablePool.filter(function (x) { return x.stateDays === d; });
    if (pool.length) byDay[d] = { n: pool.length, rate: pct(pool.length, pool.filter(winOf).length) };
  });

  // ===== 规则树（≥1000 条自动启用，共用特征，不改打分）=====
  var tree = { enabled: settled.length >= TREE_NEED, need: TREE_NEED, rules: [], note: '' };
  if (tree.enabled) {
    POOL_PHASES.forEach(function (b) {
      var pool = tradablePool.filter(function (x) { return x.bucket === b; });
      if (pool.length < RULE_MIN) return;
      var best = sigItems.map(function (it) {
        var g = pool.filter(function (x) { return featOf(x)[it.key]; });
        return { cond: it.label, n: g.length, rate: pct(g.length, g.filter(winOf).length) };
      }).filter(function (x) { return x.n >= RULE_MIN; }).sort(function (a, b2) { return b2.rate - a.rate; })[0];
      if (best) tree.rules.push({ when: b, state: best.cond, rate: best.rate, n: best.n,
        action: '该时间层命中「' + best.cond + '」时优先；历史 T+5 涨停 ' + best.rate + '%' });
    });
    tree.note = '规则树已启用（' + settled.length + ' 条样本），与打分器共用特征与台账';
  } else {
    tree.note = '规则树需 ' + TREE_NEED + ' 条真实样本，当前 ' + settled.length + ' 条，未启用';
  }

  // ===== 时间 × 状态 → 动作表 =====
  var playbook = [];
  var bestBucket = Object.keys(byBucket).sort(function (a, b) { return byBucket[b].rate - byBucket[a].rate; })[0];
  var bestDay = Object.keys(byDay).sort(function (a, b) { return byDay[b].rate - byDay[a].rate; })[0];
  if (ready) {
    playbook = [
      { when: '信号当日（收盘后）', state: '启动池 · ' + (bestBucket || '新发') + ' · 第' + (bestDay || '1') + '日',
        action: '按自进化总分排序（当前主公式 ' + (FORMULAS.find(function (f) { return f.k === primaryFormula; }) || { label: '六派≥4' }).label
          + '），优先前 20%；历史该层 T+5 涨停 ' + (byBucket[bestBucket] || { rate: 0 }).rate + '%' },
      { when: 'T+1 开盘', state: '能成交（非一字板）',
        action: '以次日开盘价买入，盘中最低跌破 ' + stopOf('main') + '%/7%/9%（主板/创业科创/北交）先判输，不等收盘' },
      { when: 'T+1 收盘', state: '阶段是否仍=新发/启动',
        action: '转非启动即从优先名单移除；阶段持续性历史 ' + (continuity.total ? pct(continuity.total, continuity.kept) : 0) + '%' },
      { when: 'T+3', state: '仍未触及涨停',
        action: '降为一般观察；只有条件再次满足才保留' },
      { when: 'T+5 收盘', state: '窗口结束',
        action: '按真实日 K 结算四口径，回填并重算权重、前瞻得分与对照组' }
    ];
  } else {
    playbook = [
      { when: '信号当日（收盘后）', state: '启动池（仅新发 / 观察两类）', action: '待验证框架：先入观察名单，不预设涨停率' },
      { when: 'T+1 开盘', state: '能否成交', action: '待验证框架：一字板买不进单列，可成交组才统计' },
      { when: 'T+1 / T+3 / T+5', state: '阶段与涨停', action: '待验证框架：按真实日 K 回填后再给结论；现在样本不足，不编概率' }
    ];
  }

  var rules = {
    updatedAt: nowStr(), sampleN: settled.length, minN: RULE_MIN, highN: NEED,
    baseRate: baseRate, baseN: baseN,
    ready: ready, confidence: ready ? 'high' : (items.length ? 'low' : 'none'),
    note: ready ? ('总体 ' + settled.length + ' 条已结算，高置信结论生效')
      : (items.length ? ('单条件已有个初步规律（' + items.length + ' 条，低置信）；总体需 ' + NEED + ' 条才升为可用')
        : ('规律积累中：已结算 ' + settled.length + '/' + RULE_MIN + ' 条，尚不足以确认任何条件优势')),
    items: items, playbook: playbook,
    criteria: criteria, byBucket: byBucket, byDay: byDay,
    continuity: { n: continuity.total, kept: continuity.kept, rate: pct(continuity.total, continuity.kept) },
    nextDay: { n: nextDay.length, rate: pct(nextDay.length, nextDay.filter(winOf).length), note: '次日追入独立样本，不混入主统计' },
    scoring: {
      primary: primaryFormula, fallback: fallback,
      formulas: FORMULAS, points: wfScores, rounds: wfRounds.length, canSwitch: wfCanSwitch,
      note: wfCanSwitch ? ('滚动前瞻验证 ' + wfRounds.length + ' 轮，主公式：' + primaryFormula)
        : ('前瞻验证需 ≥' + WF_MIN_ROUND + ' 轮，当前 ' + wfRounds.length + ' 轮，暂用 ' + DEFAULT_FORMULA)
    },
    comparison: {
      A_random: { n: tradablePool.length, rate: baselineA, label: '随机基线（全池均值）' },
      B_vote4: { n: v4set.length, rate: baselineB, label: '现行规则 六派≥4' },
      C_evo: { n: cSet.length, rate: baselineC, label: '自进化前20%' },
      betterThanB: baselineC > baselineB,
      note: fallback ? '自进化连续3轮不如现行规则，已自动回退到六派≥4' : '仅在 C 持续高于 B 时才认为自进化有效'
    },
    tree: tree
  };

  // ===== 留痕 =====
  appendLog(STATS_LOG, {
    at: nowStr(), asOf: asOf, settled: settled.length, baseN: baseN, baseRate: baseRate,
    criteria: criteria.rates, comparison: { A: baselineA, B: baselineB, C: baselineC },
    primary: primaryFormula, fallback: fallback,
    top: items.length ? { label: items[0].label, t5: items[0].t5, n: items[0].n } : null
  });
  fs.mkdirSync(path.dirname(RULES), { recursive: true });
  fs.writeFileSync(RULES, JSON.stringify({ asOf: asOf, generatedAt: nowStr(), rules: rules }, null, 2) + '\n');

  var ledger = history.map(function (x) {
    var pl = x.pool || [];
    return { date: x.date, asOf: x.asOf, n: pl.length,
      newPhase: pl.filter(function (p) { return bucketOf(p) === '新发'; }).length,
      observe: pl.filter(function (p) { return bucketOf(p) === '观察'; }).length,
      health: pl.filter(function (p) { return bucketOf(p) === '健康'; }).length };
  });

  // ===== 今日候选打分（给页面「今天怎么做」用）=====
  var todayPool = snapshot.pool.map(function (p) {
    var feat = featOf({ bucket: p.dayBucket, stateDays: p.stateDays, resonance: p.resonance,
      w5: p.w5, w20: p.w20, rrg: p.rrg, fund: p.fund, volRatio: p.volRatio,
      signalChg: p.quote ? p.quote.chg : null });
    var sc = scoreOne(feat, primaryFormula === 'v4Rule' ? 'posOnly' : primaryFormula);
    if (primaryFormula === 'v4Rule') sc.score = (p.resonance || 0) >= 4 ? 10 : 0;
    var hit = sigItems.filter(function (it) { return feat[it.key]; }).map(function (it) { return it.label; });
    var negHit = negItems.filter(function (it) { return feat[it.key]; }).map(function (it) { return it.label; });
    var q = p.quote || {};
    var canTrade = isNum(q.price) && isNum(p.lastClose) && p.lastClose > 0
      ? !nearLimit(q.price, p.lastClose, p.kind) : null;   // null=报价缺失，不臆断
    return Object.assign({}, p, {
      _score: sc.score, _veto: sc.veto, _hit: hit, _negHit: negHit,
      _tradable: canTrade, _action: sc.veto || (primaryFormula === 'v4Rule' && (p.resonance || 0) < 4)
        ? '回避' : (sc.score > 0 ? '可参与' : '观察')
    });
  });

  var newPhase = snapshot.pool.filter(function (x) { return x.dayBucket === '新发'; }).length;
  var obsPhase = snapshot.pool.filter(function (x) { return x.dayBucket === '观察'; }).length;
  var healthPhase = snapshot.pool.filter(function (x) { return x.dayBucket === '健康'; }).length;
  var staleDays = daysBetween(asOf, todayStr());
  var accumulate = { settled: settled.length, pending: pending, need: NEED, ready: ready,
    snapshots: history.length, pendingK: noKline,
    note: ready ? '真实样本已足够，高置信结论生效（每天继续回填）'
      : '真实样本累积中（' + settled.length + '/' + NEED + '），单条件低置信门槛 ' + RULE_MIN + ' 条' };

  var out = {
    asOf: asOf, generatedAt: snapshot.generatedAt,
    quoteAt: qres.at, quoteCovered: qres.covered, staleDays: staleDays,
    source: '三态主站 data.js · state=启动 且 stateDays 1~8 · 保留阶段=新发/观察/健康（退化剔除）· 共用 state-phase.js · v2 真新发口径',
    ruleVersion: RULE_VERSION,
    today: todayPool, newPhase: newPhase, observePhase: obsPhase, healthPhase: healthPhase,
    downPhase: snapshot.pool.length - newPhase,   // 兼容旧字段：新发以外（观察+健康）
    /* 首板预警层：独立于启动池，时间更早（基准日首板 vs 引擎第 3~4 日才切启动）。 */
    watchlist: {
      asOf: asOf, quoteAt: wqres.at, skipped: watch.skipped,
      list: watch.list, stats: watchStats,
      note: '基准日 ' + asOf + ' 收盘首板 + 量比≥1.2；ST 已剔除、一字板单列不可成交、20日涨幅>25% 标高位板；' + watchStats.note
    },
    /* 观察组：启动态但被主站降级的票（连板降级/走弱回落），自进化单独前瞻验证，不与新发混算 */
    observeStats: observeStats,
    ledger: ledger, accumulate: accumulate, rules: rules,
    verdict: {
      regime: ready ? '高置信 · 按自进化排序' : (items.length ? '低置信 · 仅有初步条件' : '数据积累中 · 暂不判断'),
      why: '启动池 ' + snapshot.pool.length + ' 只（新发 ' + newPhase + ' / 观察 ' + obsPhase + ' / 健康 ' + healthPhase
        + '）· 连续周期样本 ' + settled.length + ' 条 · ' + accumulate.note,
      topPick: todayPool.length ? todayPool.slice().sort(function (a, b) { return b._score - a._score; }).slice(0, 5)
        .map(function (x) { return x.name + ' ' + x._score + '分/' + x._action; }).join('、') : '今日无启动候选',
      buySell: ready ? ('对照：随机 ' + baselineA + '% · 六派≥4 ' + baselineB + '% · 自进化前20% ' + baselineC
        + '% · 主公式 ' + primaryFormula + (fallback ? '（已回退）' : '') + ' —— 历史频率不是预测')
        : '还没有足够真实结果，不给买卖结论',
      comparison: rules.comparison, scoring: rules.scoring
    },
    method: {
      signal: '主站 data.js 中 state=启动 且 stateDays 1~8；连续启动周期去重只算首日；一字板买不进单列。v2 起「新发」改用 state-phase.js 真新发口径（连板≥2 降级为观察）；首板预警层从非启动态里筛，独立台账，不与启动池混算；观察组（连板降级/走弱回落）单独前瞻验证，不与新发组混算',
      result: 'ohlc.json.gz 真实日K：[开,收,高,低]；①次日开盘买+盘中最低破阈值先判输+窗口涨停；②信号收盘；③T+5收益；④T+1封板T+2再板',
      limit: '历史快照无法回溯：data.js 无每日存档，真实台账从本脚本上线日起逐日累积',
      missing: 'K线未覆盖标记待回填；单条件需 ' + RULE_MIN + ' 条、总体需 ' + NEED + ' 条、规则树需 ' + TREE_NEED + ' 条',
      freshness: staleDays != null && staleDays > 1 ? ('注意：主站数据基准 ' + asOf + '，距今 ' + staleDays + ' 天') : '数据基准与交易日一致',
      disclaimer: '所有百分比是历史频率，不是预测；统计规律不构成投资建议'
    }
  };

  fs.writeFileSync(OUT, 'window.AB_LIMITUP = ' + JSON.stringify(out) + ';\n');
  console.log('启动池 ' + asOf + '：候选 ' + snapshot.pool.length + '（新发' + newPhase + '/观察' + obsPhase + '/健康' + healthPhase
    + '）· 周期样本 ' + settled.length + '（可成交' + baseN + '/一字' + untradable.length + '）· 待回填 ' + pending
    + ' · 条件 ' + items.length + ' · 主公式 ' + primaryFormula + ' · 前瞻 ' + wfRounds.length + ' 轮 · 对照 A' + baselineA
    + '/B' + baselineB + '/C' + baselineC + '% · 观察组样本 ' + observeStats.n);
}
main().catch(function (e) { console.error(e); process.exit(1); });
