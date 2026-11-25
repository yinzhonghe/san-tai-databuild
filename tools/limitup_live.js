#!/usr/bin/env node
/*
 * tools/limitup_live.js —— 「三态主站 · 启动·新发」真实台账（替代旧的 bt_lib 回放口径）
 * ------------------------------------------------------------------
 * 口径（不可混用）：
 *   · 信号 = data.js 里 state==='启动' 且 stateDays<=2 的个股（与主站「启动·新发」筛选完全一致）
 *   · 结果 = 用 ohlc.json.gz 的真实日K，按 asOf 之后 T+1/T+3/T+5 交易日收盘涨幅判涨停
 *   · 历史信号只能从今天起逐日累积（data.js 无历史存档），样本不足就显示「积累中」，不编造概率
 *
 * 输出：
 *   learn/limitup_live.jsonl  每日一行真实新发快照（同一 asOf 覆盖，不重复）
 *   limitup_data.js           window.AB_LIMITUP，供超跌页第三个板块渲染
 *
 * 用法：node tools/limitup_live.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var ROOT = path.dirname(__dirname);
var DATAJS = path.join(ROOT, 'data.js');
var OHLC = path.join(ROOT, 'ohlc.json.gz');
var LEDGER = path.join(ROOT, 'learn', 'limitup_live.jsonl');
var OUT = path.join(ROOT, 'limitup_data.js');
var NEED = 200;   // 至少 200 条已结算信号才给统计概率（诚实基线）

function pct(n, h) { return n ? +(h / n * 100).toFixed(1) : 0; }
function kindOf(code) {
  var b = String(code).split('.')[0];
  if (/^(30|68)/.test(b)) return 'gem';
  if (/^(8|4|920)/.test(b)) return 'bj';
  return 'main';
}
function limitOf(k) { return k === 'gem' ? 19.8 : k === 'bj' ? 29.5 : 9.8; }

// ===== 读主站真实快照 =====
var D = JSON.parse((function () {
  var s = fs.readFileSync(DATAJS, 'utf8');
  return s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
})());
var asOf = (D.meta && D.meta.asOf) || '';
var allRows = D.rows || [];
var votesDef = D.voteDef || {};

// 真实新发 = 主站 state=启动 且 stateDays<=2（与主站筛选完全同源）
var fresh = allRows.filter(function (r) {
  return r && r.kind === 'stock' && r.state === '启动' && (r.stateDays || 99) <= 2;
});
var snapshot = {
  date: new Date().toISOString().slice(0, 10),
  asOf: asOf,
  pool: fresh.map(function (r) {
    var p = r.pct || {}, sc = r.scores || {}, v = r.votes || {};
    return {
      code: r.code, name: String(r.name || '').replace(/\s+/g, ''), ind: r.ind || '',
      kind: kindOf(r.code), stateDays: r.stateDays, stateCapped: !!r.stateCapped,
      resonance: r.resonance, votes: v, scores: sc,
      w5: p.w5, w20: p.w20, w60: p.w60, w250: p.w250,
      fund: r.fund, fundLabel: r.fundLabel || '', volRatio: r.volRatio, amtRatio: r.amtRatio,
      rrg: r.quad || '', stage: r.stage || '', veto: r.veto || [], strong: !!r.strong,
      lastClose: (r.closes && r.closes.length) ? r.closes[r.closes.length - 1] : null
    };
  })
};

// ===== 写入台账（同一 asOf 覆盖，避免重复）=====
fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
var history = [];
if (fs.existsSync(LEDGER)) {
  fs.readFileSync(LEDGER, 'utf8').split('\n').forEach(function (line) {
    if (!line.trim()) return;
    try { history.push(JSON.parse(line)); } catch (e) {}
  });
}
var at = history.findIndex(function (x) { return x.asOf === asOf; });
if (at >= 0) history[at] = snapshot; else history.push(snapshot);
history.sort(function (a, b) { return String(a.asOf).localeCompare(String(b.asOf)); });
fs.writeFileSync(LEDGER, history.map(function (x) { return JSON.stringify(x); }).join('\n') + '\n');

// ===== 用真实日K 回填历史信号结果 =====
var O = null;
try { O = JSON.parse(zlib.gunzipSync(fs.readFileSync(OHLC)).toString()); } catch (e) {
  console.log('  [警告] ohlc.json.gz 读取失败，历史结果暂不能回填：' + e.message);
}
var barsOf = {};
if (O && O.bars) {
  Object.keys(O.bars).forEach(function (c) {
    var arr = O.bars[c];
    if (!arr || arr.length < 10) return;
    barsOf[c] = arr.map(function (x) { return { d: x[0], c: x[2] }; });
  });
}

// 某信号 asOf 之后第 n 个交易日的状态：返回涨幅与是否涨停
function forward(sig, n) {
  var arr = barsOf[sig.code];
  if (!arr) return null;
  var idx = -1;
  for (var i = arr.length - 1; i >= 0; i--) if (arr[i].d === sig.asOf) { idx = i; break; }
  if (idx < 0 || idx + n >= arr.length) return null;   // K线未覆盖到该日 → 待回填，不编造
  var base = arr[idx].c, now = arr[idx + n].c;
  if (!(base > 0) || !(now > 0)) return null;
  var chg = +((now / base - 1) * 100).toFixed(2);
  var lu = chg >= limitOf(kindOf(sig.code));
  // 窗口内是否出现过涨停（T+1..T+n 任一日收盘涨停）
  var any = false;
  for (var j = 1; j <= n; j++) {
    if (idx + j >= arr.length) break;
    var pc = arr[idx + j - 1].c, cc = arr[idx + j].c;
    if (pc > 0 && cc / pc - 1 >= limitOf(kindOf(sig.code)) / 100) { any = true; break; }
  }
  return { chg: chg, lu: lu, any: any, date: arr[idx + n].d };
}

var settled = [], pending = 0;
history.forEach(function (snap) {
  (snap.pool || []).forEach(function (r) {
    var t1 = forward(r, 1), t3 = forward(r, 3), t5 = forward(r, 5);
    if (!t1 && !t3 && !t5) { pending++; return; }
    settled.push({
      code: r.code, name: r.name, asOf: snap.asOf, stateDays: r.stateDays,
      resonance: r.resonance, w5: r.w5, w20: r.w20, w60: r.w60,
      votes: r.votes, scores: r.scores, fund: r.fund, ind: r.ind,
      t1: t1, t3: t3, t5: t5
    });
  });
});

// ===== 统计：只有真实样本足够才给概率 =====
var ready = settled.length >= NEED;
var stats = null;
if (ready) {
  function rate(key, field) {
    var g = settled.filter(function (x) { return x[key] && x[key][field] != null; });
    return { n: g.length, rate: pct(g.length, g.filter(function (x) { return x[key][field]; }).length) };
  }
  var byVote = {};
  [0, 1, 2, 3, 4, 5, 6].forEach(function (v) {
    var g = settled.filter(function (x) { return x.resonance === v && x.t5; });
    if (g.length >= 20) byVote[v + '派'] = { n: g.length, rate: pct(g.length, g.filter(function (x) { return x.t5.any; }).length) };
  });
  var byDay = {};
  [1, 2].forEach(function (d) {
    var g = settled.filter(function (x) { return x.stateDays === d && x.t5; });
    if (g.length >= 20) byDay['启动' + d + '日'] = { n: g.length, rate: pct(g.length, g.filter(function (x) { return x.t5.any; }).length) };
  });
  stats = {
    base: { n: settled.filter(function (x) { return x.t5; }).length,
      rate: pct(settled.filter(function (x) { return x.t5; }).length,
        settled.filter(function (x) { return x.t5 && x.t5.any; }).length) },
    t1: rate('t1', 'lu'), t3: rate('t3', 'lu'), t5: rate('t5', 'lu'),
    byVote: byVote, byDay: byDay
  };
}

var ledger = history.map(function (x) {
  return { date: x.date, asOf: x.asOf, n: (x.pool || []).length };
});

// ===== 输出 =====
var accumulate = { settled: settled.length, pending: pending, need: NEED, ready: ready,
  snapshots: history.length,
  note: ready ? '真实样本已足够，概率开始生效（每天继续回填）'
    : '真实样本累积中（' + settled.length + '/' + NEED + '），不给概率、不给打分，避免用代理口径冒充三态主站' };
var out = {
  asOf: asOf, generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
  source: '三态主站 data.js · state=启动 且 stateDays<=2',
  today: snapshot.pool,
  ledger: ledger,
  accumulate: accumulate,
  stats: stats,
  verdict: {
    regime: ready ? (stats.base.rate >= 10 ? '偏热 · 可做' : stats.base.rate <= 5 ? '偏冷 · 少做' : '中性 · 精选做') : '数据积累中 · 暂不判断',
    why: '主站真实新发 ' + snapshot.pool.length + ' 只（基准 ' + asOf + '）· ' + accumulate.note,
    buySell: ready ? ('真实样本 T+1 收盘涨停 ' + stats.t1.rate + '%、T+5 窗口内涨停 ' + stats.base.rate
      + '% —— 仅供观察，历史频率不是预测') : '还没有足够真实结果，不给买卖结论',
    topPick: snapshot.pool.length ? ('今日新发 ' + snapshot.pool.length + ' 只，六派最高 '
      + Math.max.apply(null, snapshot.pool.map(function (x) { return x.resonance || 0; })) + '/6') : '今日无新发信号'
  },
  method: {
    signal: '主站 data.js 的 state=启动 且 stateDays<=2，与三态看板「启动·新发」筛选完全一致',
    result: '用 ohlc.json.gz 真实日K按 asOf 后 T+1/T+3/T+5 交易日收盘涨幅判涨停（主板9.8/创业科创19.8/北交29.5）',
    limit: '历史快照无法回溯：data.js 没有每日存档，真实台账从本脚本上线日起逐日累积',
    missing: 'K线未覆盖的日期标记待回填，不用 0 顶替；样本不足 ' + NEED + ' 条不显示概率',
    disclaimer: '所有百分比是历史频率，不是预测，不构成投资建议'
  }
};

fs.writeFileSync(OUT, 'window.AB_LIMITUP = ' + JSON.stringify(out) + ';\n');
console.log('三态主站新发：' + asOf + ' 真实新发 ' + snapshot.pool.length + ' 只 · 台账 ' + history.length
  + ' 天 · 已结算 ' + settled.length + '/' + NEED + (ready ? '（概率已启用）' : '（积累中）'));
