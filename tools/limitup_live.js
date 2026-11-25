#!/usr/bin/env node
/*
 * tools/limitup_live.js —— 「三态主站 · 启动·新发」真实台账 + 规律自进化
 * ------------------------------------------------------------------
 * 口径（不可混用）：
 *   · 信号候选 = data.js 里 state==='启动' 且 stateDays<=2 的个股
 *   · 页面展示 = 与三态主站完全相同的 state-phase.js 阶段判定：
 *       候选再用实时涨跌 / 20 日回撤 / 六派票数变化降级为「新发 / 观察 / 退化」，
 *       只有「新发」才计入主站同款数量；被降级的单独列出，不静默消失。
 *   · 结果 = ohlc.json.gz 的真实日 K，按 asOf 之后 T+1/T+3/T+5 判涨停
 *   · 规律 = 只从上面这条真实台账里挖，样本不足就写「积累中」，绝不用代理回放冒充
 *
 * 2026-11-25 修复：
 *   1) 旧版 forward() 读 sig.asOf，但 pool 条目没带 asOf → 永远匹配不到 K 线，
 *      样本永远是 0/200；现在每条信号都带 asOf，回填真正开始工作。
 *   2) 旧版只看 stateDays<=2，与主站 statePhase 不一致 → 33 vs 36；
 *      现在共用 state-phase.js。
 *   3) 加入多特征规律挖掘 + 时间/状态动作表，随台账每日自动重算。
 *
 * 输出：
 *   learn/limitup_live.jsonl   每日一行真实新发快照（同一 asOf 覆盖，不重复）
 *   learn/limitup_rules.json   最新规律与动作表
 *   learn/limitup_stats.jsonl  每次重算的基线留痕（观察结论是否稳定）
 *   limitup_data.js            window.AB_LIMITUP，供超跌页板块③渲染
 *
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
var LEDGER = path.join(ROOT, 'learn', 'limitup_live.jsonl');
var RULES = path.join(ROOT, 'learn', 'limitup_rules.json');
var STATS_LOG = path.join(ROOT, 'learn', 'limitup_stats.jsonl');
var OUT = path.join(ROOT, 'limitup_data.js');

var NEED = 200;    // 总体概率启用门槛（诚实基线）
var RULE_MIN = 15; // 单条规律的最小样本数，低于此不输出
var EM_UT = 'fa5fd1943c7b386f172d6893dbfba10b';

function pct(n, h) { return n ? +(h / n * 100).toFixed(1) : 0; }
function kindOf(code) {
  var b = String(code).split('.')[0];
  if (/^(30|68)/.test(b)) return 'gem';
  if (/^(8|4|920)/.test(b)) return 'bj';
  return 'main';
}
function limitOf(k) { return k === 'gem' ? 19.8 : k === 'bj' ? 29.5 : 9.8; }
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function todayStr() {
  var d = new Date(Date.now() + 8 * 3600000);
  return d.toISOString().slice(0, 10);
}
function nowStr() {
  var d = new Date(Date.now() + 8 * 3600000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
function daysBetween(a, b) {
  var t1 = Date.parse(String(a) + 'T00:00:00Z'), t2 = Date.parse(String(b) + 'T00:00:00Z');
  return isFinite(t1) && isFinite(t2) ? Math.round((t2 - t1) / 86400000) : null;
}

// ===== 实时报价（给阶段判定用；取不到就明确留空，不拿快照收盘价冒充实时）=====
function txSym(code) {
  var p = /\.SH$/i.test(code) ? 'sh' : 'sz';
  return p + String(code).split('.')[0];
}
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
        if (isNum(price) && price > 0) {
          map[full] = { price: price, chg: isNum(chg) ? chg : null, source: 'tencent', at: at };
        }
      });
    } catch (e) { /* 单块失败不影响其他块 */ }
  }
  // 北交所腾讯不认，走东财 ulist
  var bj = codes.filter(function (c) { return /\.BJ$/i.test(c); });
  if (bj.length) {
    try {
      var secids = bj.map(function (c) { return '0.' + c.split('.')[0]; }).join(',');
      var url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2'
        + '&fields=f2,f3,f12,f13,f60&secids=' + encodeURIComponent(secids) + '&ut=' + EM_UT + '&cb=_abLQ';
      var r2 = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      var t2 = await r2.text();
      var j = /_abLQ\((.*)\)/.exec(t2);
      if (j) {
        var d = JSON.parse(j[1]);
        ((d.data && d.data.diff) || []).forEach(function (it) {
          var code = String(it.f12 || '') + '.BJ';
          var price = Number(it.f2), chg = Number(it.f3);
          if (isNum(price) && price > 0) map[code] = { price: price, chg: isNum(chg) ? chg : null, source: 'eastmoney', at: at };
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

async function main() {
  // 真实新发候选 = 主站 state=启动 且 stateDays<=2（与主站筛选同源）
  var fresh = allRows.filter(function (r) {
    return r && r.kind === 'stock' && r.state === '启动' && (r.stateDays || 99) <= 2;
  });
  var qres = await fetchQuotes(fresh.map(function (r) { return r.code; }));
  var snapshot = {
    date: todayStr(),
    asOf: asOf,
    generatedAt: nowStr(),
    quoteAt: qres.at,
    quoteCovered: qres.covered,
    pool: fresh.map(function (r) {
      var p = r.pct || {}, sc = r.scores || {}, v = r.votes || {};
      var q = qres.map[r.code] || null;
      var ph = PHASE.compute(r, q || {});
      return {
        // asOf 必须写进每条信号，否则 T+1/T+3/T+5 回填永远匹配不到 K 线（旧版 bug）
        asOf: asOf,
        code: r.code, name: String(r.name || '').replace(/\s+/g, ''), ind: r.ind || '',
        kind: kindOf(r.code), state: r.state, stateDays: r.stateDays, stateCapped: !!r.stateCapped,
        resonance: r.resonance, resonancePrev: isNum(r.resonancePrev) ? r.resonancePrev : null,
        votes: v, scores: sc,
        w5: p.w5, w20: p.w20, w60: p.w60, w250: p.w250,
        fund: r.fund, fundLabel: r.fundLabel || '', volRatio: r.volRatio, amtRatio: r.amtRatio,
        rrg: r.quad || '', stage: r.stage || '', veto: r.veto || [], strong: !!r.strong,
        lastClose: (r.closes && r.closes.length) ? r.closes[r.closes.length - 1] : null,
        // statePhase 需要的真实字段（21 根足够算 20 日回撤）
        closes: Array.isArray(r.closes) ? r.closes.slice(-21) : [],
        baseDate: r.baseDate || null,
        e2: r.e2 ? { stateSince: r.e2.stateSince, stateDays: r.e2.stateDays } : {},
        quote: q,                 // 实时价；null 就是没取到，不编造
        phase: ph ? ph.t : null,  // 生成时刻的阶段（页面会按最新实时价重算）
        phaseWhy: ph ? ph.why : ''
      };
    })
  };

  // ===== 写入台账（同一 asOf 覆盖，避免重复）=====
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  var history = [];
  if (fs.existsSync(LEDGER)) {
    fs.readFileSync(LEDGER, 'utf8').split('\n').forEach(function (line) {
      if (!line.trim()) return;
      try { history.push(JSON.parse(line)); } catch (e) { }
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
    var any = false, daily = [], hitDay = null;
    for (var j = 1; j <= n; j++) {
      if (idx + j >= arr.length) break;
      var pc = arr[idx + j - 1].c, cc = arr[idx + j].c;
      var dc = pc > 0 ? +((cc / pc - 1) * 100).toFixed(2) : null;
      daily.push(dc);
      if (!any && dc != null && dc >= limitOf(kindOf(sig.code))) { any = true; hitDay = j; }
    }
    return { chg: chg, any: any, hitDay: hitDay, daily: daily, date: arr[idx + n].d };
  }

  var settled = [], pending = 0;
  history.forEach(function (snap) {
    (snap.pool || []).forEach(function (r) {
      var t1 = forward(r, 1), t3 = forward(r, 3), t5 = forward(r, 5);
      if (!t1 && !t3 && !t5) { pending++; return; }
      settled.push({
        code: r.code, name: r.name, asOf: r.asOf, stateDays: r.stateDays,
        phase: r.phase || (r.stateDays <= 2 ? '新发' : ''),
        resonance: r.resonance, resonancePrev: r.resonancePrev,
        w5: r.w5, w20: r.w20, w60: r.w60,
        fund: r.fund, volRatio: r.volRatio, amtRatio: r.amtRatio,
        rrg: r.rrg, ind: r.ind,
        signalChg: r.quote ? r.quote.chg : null,
        votes: r.votes, scores: r.scores,
        t1: t1, t3: t3, t5: t5
      });
    });
  });

  // ===== 统计与规律挖掘：只认真实样本 =====
  var basePool = settled.filter(function (x) { return x.t5; });
  var baseN = basePool.length;
  var baseHit = basePool.filter(function (x) { return x.t5.any; }).length;
  var baseRate = pct(baseN, baseHit);
  var ready = settled.length >= NEED;

  // Wilson 下界：小样本再高的频率也不当规律用
  function wilson(k, n, z) {
    if (!n) return 0;
    z = z || 1.96;
    var p = k / n, z2 = z * z;
    var c = (p + z2 / (2 * n)) / (1 + z2 / n);
    var h = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / (1 + z2 / n);
    return Math.max(0, c - h) * 100;
  }
  function rateOf(arr, field) {
    var g = arr.filter(function (x) { return x[field]; });
    return { n: g.length, rate: pct(g.length, g.filter(function (x) { return x[field].any; }).length) };
  }
  function t1Rate(arr) {
    var g = arr.filter(function (x) { return x.t1 && x.t1.daily.length; });
    return pct(g.length, g.filter(function (x) { return x.t1.daily[0] != null && x.t1.daily[0] >= limitOf(kindOf(x.code)); }).length);
  }

  var TESTS = [
    { k: 'phaseNew', label: '阶段=新发（主站同款）', f: function (x) { return x.phase === '新发'; } },
    { k: 'phaseDown', label: '阶段=观察/退化', f: function (x) { return x.phase === '观察' || x.phase === '退化'; } },
    { k: 'day1', label: '启动第 1 日', f: function (x) { return x.stateDays === 1; } },
    { k: 'day2', label: '启动第 2 日', f: function (x) { return x.stateDays === 2; } },
    { k: 'v4', label: '六派 ≥4', f: function (x) { return (x.resonance || 0) >= 4; } },
    { k: 'v3', label: '六派 =3', f: function (x) { return (x.resonance || 0) === 3; } },
    { k: 'v2', label: '六派 ≤2', f: function (x) { return (x.resonance || 0) <= 2; } },
    { k: 'w5hi', label: '5 日涨幅 >8%', f: function (x) { return isNum(x.w5) && x.w5 > 8; } },
    { k: 'w5neg', label: '5 日涨幅 <0', f: function (x) { return isNum(x.w5) && x.w5 < 0; } },
    { k: 'w20hi', label: '20 日涨幅 >20%', f: function (x) { return isNum(x.w20) && x.w20 > 20; } },
    { k: 'rrgLead', label: 'RRG 领先象限', f: function (x) { return /领先/.test(x.rrg || ''); } },
    { k: 'fundIn', label: '主力资金净流入', f: function (x) { return isNum(x.fund) && x.fund > 0; } },
    { k: 'volHi', label: '量比 >1.5', f: function (x) { return isNum(x.volRatio) && x.volRatio > 1.5; } },
    { k: 'sigUp', label: '信号日收涨', f: function (x) { return isNum(x.signalChg) && x.signalChg > 0; } },
    { k: 'sigDown', label: '信号日收跌', f: function (x) { return isNum(x.signalChg) && x.signalChg < 0; } }
  ];

  var items = [];
  if (baseN >= RULE_MIN && baseHit > 0) {
    TESTS.forEach(function (t) {
      var g = basePool.filter(t.f);
      if (g.length < RULE_MIN) return;
      var hit = g.filter(function (x) { return x.t5.any; }).length;
      var r = pct(g.length, hit), low = wilson(hit, g.length), up = 100 - wilson(g.length - hit, g.length);
      var lift = baseRate > 0 ? +(r / baseRate).toFixed(2) : null;
      var kind = low > baseRate ? 'positive' : (up < baseRate ? 'negative' : 'neutral');
      if (kind === 'neutral') return;
      items.push({
        key: t.k, label: t.label, n: g.length, hit: hit,
        t1: t1Rate(g), t5: r, lift: lift,
        edge: +(r - baseRate).toFixed(1),
        low: +low.toFixed(1), kind: kind,
        action: kind === 'positive'
          ? '重点跟踪：T+1 看能否延续，T+3 未兑现降级观察，T+5 仍无涨停退出观察'
          : '回避/减配：等到条件重新成立（阶段升级或量能恢复）再评估，不凭这条单独追'
      });
    });
    items.sort(function (a, b) {
      if (a.kind !== b.kind) return a.kind === 'positive' ? -1 : 1;
      return (b.edge - a.edge) || (b.n - a.n);
    });
    items = items.slice(0, 8);
  }

  // 时间 × 状态 → 动作：有真实样本时用统计结果填，没样本时只给「待验证框架」
  var playbook = [];
  if (items.length) {
    var best = items.find(function (x) { return x.kind === 'positive'; });
    var worst = items.find(function (x) { return x.kind === 'negative'; });
    playbook = [
      { when: '信号当日（收盘后）', state: best ? best.label : '主站阶段=新发',
        action: best ? ('符合「' + best.label + '」的列入观察名单；历史 T+5 窗口涨停 ' + best.t5 + '%（' + best.n + ' 条），基线 ' + baseRate + '%')
          : '先列入观察，不凭单日形态下结论' },
      { when: 'T+1', state: '阶段仍=新发 且未跌破启动日低点',
        action: '重点跟踪；若当日转「观察/退化」就从新发名单移除（与主站同步），不追高' },
      { when: 'T+3', state: '仍未出现涨停',
        action: '降为一般观察；只有条件再次满足才保留在优先名单' },
      { when: 'T+5', state: '窗口结束',
        action: '结算后按真实结果回填，重新计算每条规律的样本与优势，自动更新这张表' }
    ];
    if (worst) playbook.push({ when: '任意时点', state: worst.label,
      action: ('历史 T+5 涨停 ' + worst.t5 + '%（' + worst.n + ' 条），低于基线 ' + baseRate + '% —— 降权，不作为买入理由') });
  } else {
    playbook = [
      { when: '信号当日（收盘后）', state: '主站阶段=新发', action: '待验证框架：先入观察名单，不预设涨停率' },
      { when: 'T+1', state: '阶段是否仍=新发', action: '待验证框架：转观察/退化即从新发名单移除' },
      { when: 'T+3 / T+5', state: '是否出现涨停', action: '待验证框架：按真实日 K 回填后再给结论；现在样本不足，不编概率' }
    ];
  }

  var rules = {
    updatedAt: nowStr(), sampleN: baseN, minN: RULE_MIN,
    baseRate: baseRate, baseN: baseN,
    ready: items.length > 0,
    note: items.length ? ('已发现 ' + items.length + ' 条达到 ' + RULE_MIN + ' 条样本的规律，每天自动重算')
      : ('规律积累中：已结算 ' + baseN + '/' + RULE_MIN + ' 条，尚不足以确认任何条件优势'),
    items: items, playbook: playbook
  };

  // 留痕：每次重算一行，方便看结论是否随样本稳定
  fs.mkdirSync(path.dirname(STATS_LOG), { recursive: true });
  fs.appendFileSync(STATS_LOG, JSON.stringify({
    at: nowStr(), asOf: asOf, settled: settled.length, baseN: baseN, baseRate: baseRate,
    top: items.length ? { label: items[0].label, t5: items[0].t5, n: items[0].n } : null
  }) + '\n');
  fs.writeFileSync(RULES, JSON.stringify({ asOf: asOf, generatedAt: nowStr(), rules: rules }, null, 2) + '\n');

  var ledger = history.map(function (x) {
    return { date: x.date, asOf: x.asOf, n: (x.pool || []).length,
      realNew: (x.pool || []).filter(function (p) { return p.phase === '新发'; }).length };
  });

  // ===== 输出 =====
  var newPhase = snapshot.pool.filter(function (x) { return x.phase === '新发'; }).length;
  var downPhase = snapshot.pool.length - newPhase;
  var staleDays = daysBetween(asOf, todayStr());
  var accumulate = { settled: settled.length, pending: pending, need: NEED, ready: ready,
    snapshots: history.length,
    note: ready ? '真实样本已足够，概率开始生效（每天继续回填）'
      : '真实样本累积中（' + settled.length + '/' + NEED + '），不给总体概率；单条规律另需 ≥' + RULE_MIN + ' 条样本' };
  var out = {
    asOf: asOf, generatedAt: snapshot.generatedAt,
    quoteAt: qres.at, quoteCovered: qres.covered,
    staleDays: staleDays,
    source: '三态主站 data.js · state=启动 且 stateDays<=2 · 阶段判定共用 state-phase.js',
    today: snapshot.pool,          // 候选池（含实时价与阶段），前端按最新实时价重算「新发」
    newPhase: newPhase, downPhase: downPhase,
    ledger: ledger,
    accumulate: accumulate,
    stats: ready ? {
      base: { n: baseN, rate: baseRate },
      t1: rateOf(settled, 't1'), t3: rateOf(settled, 't3'), t5: rateOf(settled, 't5'),
      byVote: {}, byDay: {}
    } : null,
    rules: rules,
    verdict: {
      regime: rules.ready ? '已有真实规律 · 按条件筛选' : '数据积累中 · 暂不判断',
      why: '主站真实候选 ' + snapshot.pool.length + ' 只（基准 ' + asOf + '）· 生成时阶段=新发 ' + newPhase
        + ' 只、观察/退化 ' + downPhase + ' 只 · ' + accumulate.note,
      buySell: rules.ready ? ('当前基线 T+5 窗口涨停 ' + baseRate + '%（' + baseN + ' 条）；'
        + items.filter(function (x) { return x.kind === 'positive'; }).slice(0, 1).map(function (x) {
          return '最优条件「' + x.label + '」' + x.t5 + '%（' + x.n + ' 条）';
        }).join('') + ' —— 历史频率不是预测') : '还没有足够真实结果，不给买卖结论',
      topPick: snapshot.pool.length ? ('候选 ' + snapshot.pool.length + ' 只，六派最高 '
        + Math.max.apply(null, snapshot.pool.map(function (x) { return x.resonance || 0; })) + '/6') : '今日无新发候选'
    },
    method: {
      signal: '主站 data.js 里 state=启动 且 stateDays<=2；展示数量再按 state-phase.js 用实时涨跌/回撤/票数降级，与主站「启动·新发」完全一致',
      result: '用 ohlc.json.gz 真实日K按 asOf 后 T+1/T+3/T+5 逐日涨幅判涨停（主板9.8/创业科创19.8/北交29.5）',
      limit: '历史快照无法回溯：data.js 没有每日存档，真实台账从本脚本上线日起逐日累积',
      missing: 'K线未覆盖的日期标记待回填，不用 0 顶替；总体概率需 ' + NEED + ' 条，单条规律需 ' + RULE_MIN + ' 条',
      freshness: staleDays != null && staleDays > 1 ? ('注意：主站数据基准 ' + asOf + '，距今天 ' + staleDays + ' 天，页面会提示数据陈旧') : '数据基准与交易日一致',
      disclaimer: '所有百分比是历史频率，不是预测，不构成投资建议'
    }
  };

  fs.writeFileSync(OUT, 'window.AB_LIMITUP = ' + JSON.stringify(out) + ';\n');
  console.log('三态主站新发：' + asOf + ' 候选 ' + snapshot.pool.length + ' 只（阶段新发 ' + newPhase
    + ' / 观察退化 ' + downPhase + '）· 台账 ' + history.length + ' 天 · 已结算 ' + settled.length + '/' + NEED
    + ' · 规律 ' + items.length + ' 条 · 实时价覆盖 ' + qres.covered + '/' + fresh.length);
}
main().catch(function (e) { console.error(e); process.exit(1); });
