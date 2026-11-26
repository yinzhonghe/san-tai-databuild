/*
 * tools/evolve/judge.js · 回测裁判 + 影子写回 + 自动回滚（自进化核心）
 * ---------------------------------------------------------------------------
 * grill-me 定稿 C/D/E 分支：
 *   - 固定 baseline（全样本命中率 5.41% / 3日收益 -0.41%），不随模型漂移。
 *   - 双裁判：命中率 与 3日收益，两个都要显著跑赢 baseline 才算改进。
 *   - 样本门槛 30；Wilson 下界（95%）防小样本侥幸。
 *   - 走查用 walk-forward：训练段定规则，验证段独立重算，防过拟合。
 *   - 影子期 ≥10 交易日 → 显著才写回 active → 每日限 1~2 条变更 →
 *     连续 3 日跑输 baseline 自动 retired 回滚。
 *   - 全程版本化留痕（registry.json），任何变更可追溯、可一键退回。
 */
'use strict';
var fs = require('fs');
var path = require('path');
var R = require('./rules.js');

var ROOT = path.dirname(path.dirname(__dirname));
var PANEL = path.join(ROOT, 'learn', 'evolve', 'panel.jsonl');
var REGISTRY = path.join(ROOT, 'learn', 'evolve', 'registry.json');
var LOG = path.join(ROOT, 'learn', 'evolve', 'judge_log.jsonl');

var MIN_N = 30;              // 样本门槛：低于此数只标「积累中」
var SHADOW_DAYS = 10;        // 影子期最少交易日
var MAX_CHANGE = 2;          // 每天最多写回/退役条数
var ROLLBACK_DAYS = 3;       // 连续跑输 baseline 天数 → 回滚
var Z = 1.96;                // Wilson 95%

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function wilsonLower(k, n, z) {
  if (!n) return 0;
  z = z || Z;
  var p = k / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}
function todayStr() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); }
  catch (e) {
    return { version: 1, asOf: '', baseline: null, rules: [], history: [] };
  }
}
function saveRegistry(reg) {
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + '\n');
}
function appendLog(obj) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify(obj) + '\n');
}

/* 计算 baseline：全样本（模拟 grill-me 定稿的固定标尺）。
   注意 baseline 只算一次并固化在 registry，之后不重算，避免标尺漂移。 */
function computeBaseline() {
  return R.evaluateStream(PANEL, R.BASELINE_RULE).then(function (s) {
    return {
      n: s.n, hits: s.hits, hitRate: s.hitRate, avgRet3: s.avgRet3,
      note: '全样本固定标尺：命中率与3日收益；命中样本3日平均收益为负说明「命中≠赚钱」',
      frozenAt: todayStr()
    };
  });
}

/* 对单条规则做裁决：返回 {verdict:'pass'|'fail'|'accumulating', metrics, reasons[]} */
function judge(rule, base, metrics) {
  var reasons = [];
  if (!metrics || metrics.n < MIN_N) {
    return { verdict: 'accumulating', metrics: metrics, reasons: ['样本 ' + (metrics ? metrics.n : 0) + ' < ' + MIN_N + '，积累中'] };
  }
  // 命中率：Wilson 下界必须 > baseline 命中率
  var lb = wilsonLower(metrics.hits, metrics.n, Z);
  var hitOk = lb > (base.hitRate / 100);
  reasons.push('命中率 ' + metrics.hitRate + '% (Wilson下界 ' + (lb * 100).toFixed(2) + '%) vs baseline ' + base.hitRate + '% → ' + (hitOk ? '达标' : '不达标'));
  // 收益：平均 ret3 必须 > baseline（这是钱，硬门槛）
  var retOk = isNum(metrics.avgRet3) && metrics.avgRet3 > base.avgRet3 + 0.1;
  reasons.push('3日收益 ' + metrics.avgRet3 + '% vs baseline ' + base.avgRet3 + '% → ' + (retOk ? '达标' : '不达标'));
  // expect=down 的规则（回避型）判定反过来
  if (rule.expect === 'down') {
    hitOk = lb < (base.hitRate / 100);
    retOk = isNum(metrics.avgRet3) && metrics.avgRet3 < base.avgRet3 - 0.1;
  }
  return { verdict: (hitOk && retOk) ? 'pass' : 'fail', metrics: metrics, reasons: reasons,
           wilsonLower: +(lb * 100).toFixed(2) };
}

/* walk-forward：把面板按日期切成训练/验证两段，验证段独立评估（防过拟合） */
function walkForwardSplit(samples, trainDays, testDays) {
  // samples 需先按日期升序；取最后 testDays 个交易日作验证，前面 trainDays 作训练
  var dates = [];
  samples.forEach(function (s) { if (dates.indexOf(s.date) < 0) dates.push(s.date); });
  dates.sort();
  var testStart = dates[Math.max(0, dates.length - testDays)];
  var trainEnd = dates[Math.max(0, dates.length - testDays - 1)];
  return {
    train: function (s) { return s.date <= trainEnd; },
    test: function (s) { return s.date >= testStart; },
    testStart: testStart, trainEnd: trainEnd
  };
}

/* 每日裁决：评估所有 shadow 规则，达标则写回 active（限变更数），跑输则退役。
   panelPath 可传自定义路径便于测试。 */
function daily(panelPath, opts) {
  panelPath = panelPath || PANEL;
  opts = opts || {};
  var reg = loadRegistry();
  return Promise.resolve(reg.baseline || computeBaseline()).then(function (base) {
    reg.baseline = base;
    // 独立验证段：用面板最近 HOLDOUT 个交易日作 held-out，防过拟合。
    // 先扫一遍拿到日期列表（只取 date 字段，成本低）。
    var HOLDOUT = 20;
    var dateSet = {};
    return new Promise(function (resolveDates) {
      var rl = require('readline').createInterface({ input: fs.createReadStream(panelPath, { encoding: 'utf8' }), crlfDelay: Infinity });
      rl.on('line', function (line) {
        var m = /"date":"(\d{4}-\d{2}-\d{2})"/.exec(line);
        if (m) dateSet[m[1]] = 1;
      });
      rl.on('close', function () { resolveDates(Object.keys(dateSet).sort()); });
    }).then(function (dates) {
      var holdStart = dates[Math.max(0, dates.length - HOLDOUT)];
      reg.holdout = { start: holdStart, days: Math.min(HOLDOUT, dates.length) };
      var tasks = reg.rules.filter(function (r) { return r.status === 'shadow' || r.status === 'active'; })
        .map(function (r) {
          return R.evaluateStream(panelPath, r).then(function (m) {
            // 独立验证段：只看 holdStart 之后的样本
            return R.evaluateStream(panelPath, r, function (s) { return s.date >= holdStart; }).then(function (hm) {
              var v = judge(r, base, m);
              var hv = judge(r, base, hm);
              r.lastMetrics = m;
              r.lastJudge = v;
              r.holdoutMetrics = hm;
              r.holdoutJudge = hv;
              // 双闸门：全样本与独立验证段都要 pass，才允许写回
              var combined = (v.verdict === 'pass' && hv.verdict === 'pass') ? 'pass'
                : (v.verdict === 'accumulating' || hv.verdict === 'accumulating') ? 'accumulating' : 'fail';
              return { rule: r, verdict: { verdict: combined, reasons: v.reasons.concat(['[验证段] ' + hv.reasons.join('; ')]) }, metrics: m, holdout: hm };
            });
          });
        });
      return Promise.all(tasks).then(function (results) {
        return finishDaily(reg, base, results, opts);
      });
    });
  });
}

function finishDaily(reg, base, results, opts) {
      var changes = [], rollbacks = [];
      // 先处理回滚：active 规则连续 ROLLBACK_DAYS 天 fail → retired
      results.forEach(function (x) {
        if (x.rule.status === 'active' && x.verdict.verdict === 'fail') {
          x.rule.failStreak = (x.rule.failStreak || 0) + 1;
          if (x.rule.failStreak >= ROLLBACK_DAYS && changes.length < MAX_CHANGE) {
            x.rule.status = 'retired';
            x.rule.retiredAt = todayStr();
            rollbacks.push(x.rule.id);
          }
        } else if (x.rule.status === 'active') {
          x.rule.failStreak = 0;
        }
      });
      // shadow 达标 → active（每个自然日限变更数）
      results.forEach(function (x) {
        if (x.rule.status === 'shadow' && x.verdict.verdict === 'pass') {
          x.rule.shadowDays = (x.rule.shadowDays || 0) + 1;
          if (x.rule.shadowDays >= SHADOW_DAYS && changes.length < MAX_CHANGE) {
            x.rule.status = 'active';
            x.rule.activatedAt = todayStr();
            changes.push(x.rule.id);
          }
        }
      });
      reg.asOf = todayStr();
      reg.history.push({ at: todayStr(), baseline: base, changes: changes, rollbacks: rollbacks,
        holdout: reg.holdout,
        evaluated: results.map(function (x) { return { id: x.rule.id, status: x.rule.status, verdict: x.verdict.verdict, metrics: x.metrics, holdout: x.holdout }; }) });
      if (reg.history.length > 60) reg.history = reg.history.slice(-60);
      if (!opts.dryRun) saveRegistry(reg);
      var entry = { at: todayStr(), changes: changes, rollbacks: rollbacks, baseline: base,
        rules: results.map(function (x) { return { id: x.rule.id, desc: x.rule.desc, status: x.rule.status, verdict: x.verdict }; }) };
      if (!opts.dryRun) appendLog(entry);
      return entry;
}

/* 添加候选规则（来自 LLM 或手工）：只进 shadow，绝不直接 active */
function addCandidate(rule) {
  var v = R.validate(rule);
  if (!v.ok) throw new Error('规则非法: ' + v.errors.join('; '));
  var reg = loadRegistry();
  if (reg.rules.some(function (r) { return r.id === rule.id; })) return { added: false, reason: '已存在' };
  reg.rules.push(Object.assign({}, rule, { status: 'shadow', shadowDays: 0, bornAt: todayStr(), failStreak: 0 }));
  saveRegistry(reg);
  return { added: true, total: reg.rules.length };
}

/* 一键回滚：把最近 N 天写回的规则全部退回 shadow */
function rollbackLast(n) {
  n = n || 1;
  var reg = loadRegistry();
  var rolled = [];
  var recent = reg.history.slice(-n);
  recent.forEach(function (h) {
    (h.changes || []).forEach(function (id) {
      var r = reg.rules.filter(function (x) { return x.id === id; })[0];
      if (r && r.status === 'active') { r.status = 'shadow'; r.shadowDays = SHADOW_DAYS; rolled.push(id); }
    });
  });
  saveRegistry(reg);
  return rolled;
}

module.exports = {
  computeBaseline: computeBaseline, judge: judge, daily: daily,
  addCandidate: addCandidate, rollbackLast: rollbackLast,
  wilsonLower: wilsonLower, loadRegistry: loadRegistry,
  MIN_N: MIN_N, SHADOW_DAYS: SHADOW_DAYS, Z: Z
};
