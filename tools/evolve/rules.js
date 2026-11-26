/*
 * tools/evolve/rules.js · 规则 DSL + 评估器（自进化模块）
 * ---------------------------------------------------------------------------
 * 规则格式（机器可执行、可回测、能证伪）：
 * {
 *   id: 'r20261126_01',
 *   desc: '波动收缩 + 温和放量回踩',
 *   when: [ { f:'volSqueeze20', op:'<', v:0.85 }, { f:'volRatio5', op:'between', lo:1.1, hi:1.8 } ],
 *   unless: [ { f:'streakLimit', op:'>=', v:2 } ],      // 可选：排除项
 *   expect: 'up',                                        // up=命中率↑ / down=命中率↓(回避)
 *   origin: 'llm' | 'manual' | 'baseline',
 *   deps: ['high','low','close','volume'],               // 依赖字段，供数据猎手判断缺口
 *   status: 'shadow' | 'active' | 'retired',
 *   bornAt: '2026-11-26'
 * }
 *
 * 红线：
 *   - 条件里的 f 必须存在于 features.META，否则规则判为无效（不猜字段）。
 *   - 缺数据的样本不计入该规则的分母（fail-closed），绝不拿 0 顶替。
 *   - 每条规则必须声明 deps，用于数据缺口检测。
 */
'use strict';
var FEAT = require('./features.js');

function isNum(v) { return typeof v === 'number' && isFinite(v); }

var OPS = {
  '>':  function (x, v) { return isNum(x) && x > v; },
  '>=': function (x, v) { return isNum(x) && x >= v; },
  '<':  function (x, v) { return isNum(x) && x < v; },
  '<=': function (x, v) { return isNum(x) && x <= v; },
  '=':  function (x, v) { return isNum(x) && x === v; },
  'between': function (x, lo, hi) { return isNum(x) && x >= lo && x <= hi; },
  'isUp': function (x) { return isNum(x) && x > 0; },
  'isDown': function (x) { return isNum(x) && x < 0; }
};

/* 校验规则合法性：返回 {ok, errors[]} */
function validate(rule) {
  var errors = [];
  if (!rule || !rule.when || !rule.when.length) errors.push('缺 when 条件');
  (rule.when || []).concat(rule.unless || []).forEach(function (c) {
    if (!FEAT.META[c.f]) errors.push('未知特征字段: ' + c.f);
    if (!OPS[c.op]) errors.push('未知操作符: ' + c.op);
    if (['>', '>=', '<', '<=', '='].indexOf(c.op) >= 0 && !isNum(c.v)) errors.push(c.f + ' 缺数值阈值 v');
    if (c.op === 'between' && (!isNum(c.lo) || !isNum(c.hi))) errors.push(c.f + ' between 缺 lo/hi');
  });
  if (!Array.isArray(rule.deps) || !rule.deps.length) errors.push('缺 deps 依赖声明');
  if (rule.expect !== 'up' && rule.expect !== 'down') errors.push('expect 必须是 up/down');
  return { ok: errors.length === 0, errors: errors };
}

/* 规则对单个样本求值：
   返回 'match' | 'skip'(缺数据) | 'nomatch' */
function evalRule(rule, sample) {
  var f = sample.f || {};
  function test(c) {
    var fn = OPS[c.op];
    if (!fn) return false;
    if (c.op === 'between') return fn(f[c.f], c.lo, c.hi);
    if (c.op === 'isUp' || c.op === 'isDown') return fn(f[c.f]);
    return fn(f[c.f], c.v);
  }
  for (var i = 0; i < rule.when.length; i++) {
    var c = rule.when[i];
    if (!isNum(f[c.f])) return 'skip';            // fail-closed：缺数据不计入
    if (!test(c)) return 'nomatch';
  }
  for (var j = 0; j < (rule.unless || []).length; j++) {
    var u = rule.unless[j];
    if (!isNum(f[u.f])) return 'skip';
    if (test(u)) return 'nomatch';                 // 命中排除项 → 不匹配
  }
  return 'match';
}

/* 规则依赖的数据是否齐备（对照 panel_gaps）：返回 {ready, missing[]} */
function checkDeps(rule, gaps) {
  var missing = [];
  (rule.deps || []).forEach(function (d) {
    if (d === 'volume' && gaps.noVolume > gaps.totalCodes * 0.2) missing.push('volume');
    if (d === 'industry' && gaps.noIndustry > gaps.totalCodes * 0.2) missing.push('industry');
  });
  return { ready: missing.length === 0, missing: missing };
}

/* 从面板文件流式统计规则表现（不把 551MB 读进内存）。
   panelPath: panel.jsonl；rule：规则；onSample 可选回调。
   返回 {n, hits, hitRate, sumRet3, avgRet3, skip} */
function evaluateStream(panelPath, rule, filterFn) {
  var fs = require('fs');
  var rl = require('readline').createInterface({ input: fs.createReadStream(panelPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  var st = { n: 0, hits: 0, hitRate: 0, sumRet3: 0, avgRet3: null, skip: 0, retN: 0 };
  return new Promise(function (resolve, reject) {
    rl.on('line', function (line) {
      if (!line.trim()) return;
      var s;
      try { s = JSON.parse(line); } catch (e) { return; }
      if (filterFn && !filterFn(s)) return;
      var v = evalRule(rule, s);
      if (v === 'skip') { st.skip++; return; }
      if (v !== 'match') return;
      st.n++;
      if (s.y && s.y.hit) st.hits++;
      if (s.y && isNum(s.y.ret3)) { st.sumRet3 += s.y.ret3; st.retN++; }
    });
    rl.on('close', function () {
      st.hitRate = st.n ? +(st.hits / st.n * 100).toFixed(2) : null;
      st.avgRet3 = st.retN ? +(st.sumRet3 / st.retN).toFixed(3) : null;
      delete st.sumRet3; delete st.retN;
      resolve(st);
    });
    rl.on('error', reject);
  });
}

/* baseline：不设条件，全样本命中率（固定标尺，不随模型变化） */
var BASELINE_RULE = {
  id: 'baseline', desc: '全样本基准', when: [{ f: 'ret5', op: '>', v: -1e9 }],
  expect: 'up', origin: 'baseline', deps: ['close'], status: 'active'
};

module.exports = {
  OPS: OPS, validate: validate, evalRule: evalRule, checkDeps: checkDeps,
  evaluateStream: evaluateStream, BASELINE_RULE: BASELINE_RULE
};
