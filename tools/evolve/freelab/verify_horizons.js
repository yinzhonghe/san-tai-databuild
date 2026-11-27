/*
 * tools/evolve/freelab/verify_horizons.js · 四时间维度分类验证器
 * ================================================================
 * 把自由推演实验室按【月 / 周 / 日 / T0ETF·日内】四个维度分开结算：
 *   月(d20)：T 收盘买 → T+20 收盘卖（约20个交易日）
 *   周(d5) ：T 收盘买 → T+5  收盘卖
 *   日(d1) ：T 收盘买 → T+1  收盘卖
 *   日内(T0)：T 开盘买 → T 收盘卖，只放行支持 T+0 的 ETF（其余标 notT0，标缺口不编造）
 *
 * 每个维度用同一套宪法硬门槛验证（净收益>0 / t≥3 / 覆盖率≥2% / Wilson / 跑赢基准），
 * 但「基准」按维度各自算：同期全市场该维度的中位收益（真实样本，非估算）。
 * 红线：fail-closed——缺数据跳过、一字板剔除；不写 constitution/population/heartbeat；
 *       通过也标注「历史回测、非前瞻」，绝不荐股。
 *
 * 产物：learn/evolve/freelab/verified_horizons.json
 * 用法：node tools/evolve/freelab/verify_horizons.js [--models <path>]
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.dirname(path.dirname(path.dirname(__dirname)));
var EVO = path.join(ROOT, 'learn', 'evolve');
var LAB = path.join(EVO, 'freelab');
var CONST = path.join(EVO, 'constitution.json');
var SAMPLE = path.join(LAB, 'horizon_sample.jsonl');
var MODELS = path.join(LAB, 'models.jsonl');
var OUT = path.join(LAB, 'verified_horizons.json');

var R = require('../rules.js');
var K = require('../kernel.js');
var EXPR = require('../expr.js');
var FEAT = require('../features.js');
var VF = require('./verify.js');

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function loadJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function loadJSONL(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; }
}

/* 四个维度的定义：key / 收益字段 / 样本过滤器 / 展示名 */
var DIMENSIONS = [
  { key: 'month', retKey: 'd20', name: '按月', desc: 'T收盘买→T+20收盘卖（约1个月）',
    filter: function (s) { return isNum(s.y && s.y.d20); } },
  { key: 'week', retKey: 'd5', name: '按周', desc: 'T收盘买→T+5收盘卖（约1周）',
    filter: function (s) { return isNum(s.y && s.y.d5); } },
  { key: 'day', retKey: 'd1', name: '按日', desc: 'T收盘买→T+1收盘卖（次日）',
    filter: function (s) { return isNum(s.y && s.y.d1); } },
  { key: 'intradayT0', retKey: 'intra', name: 'T0ETF·日内', desc: 'T开盘买→T收盘卖（仅T+0 ETF）',
    filter: function (s) { return !!s.t0ok && isNum(s.y && s.y.intra); } }
];

/* 把 2000 行抽样用于新特征可复现检查（从 horizon 样本取，字段口径一致） */
function sampleRows(n) {
  var out = [];
  try {
    var lines = fs.readFileSync(SAMPLE, 'utf8').split('\n');
    var step = Math.max(1, Math.floor(lines.length / n));
    for (var i = 0; i < lines.length && out.length < n; i += step) {
      try { out.push(JSON.parse(lines[i])); } catch (e) {}
    }
  } catch (e) {}
  return out;
}

/* 编译模型的新特征（复用 verify.js 已验证的逻辑，样本换成 horizon 口径） */
function compileNew(model) {
  var res = { ok: true, errors: [], compiled: {}, names: [] };
  var rows = sampleRows(2000);
  (model.newFeatures || []).forEach(function (nf) {
    if (nf.name && FEAT.META[nf.name]) {
      res.errors.push('新特征名冲突: ' + nf.name); res.ok = false; return;
    }
    var c;
    try { c = EXPR.compile(nf.expr); }
    catch (e) { res.errors.push('表达式编译失败[' + nf.name + ']: ' + e.message); res.ok = false; return; }
    var bad = c.deps.filter(function (d) { return !FEAT.META[d]; });
    if (bad.length) { res.errors.push('未注册依赖[' + nf.name + ']: ' + bad.join(',')); res.ok = false; return; }
    var chk = EXPR.checkReproducible(c, rows);
    if (!chk.ok) { res.errors.push('不可复现[' + nf.name + ']: ' + chk.reason); res.ok = false; return; }
    res.compiled[nf.name] = c; res.names.push(nf.name);
  });
  return res;
}

/* 在指定维度上结算一个模型：一次流式扫描，同时算该维度全样本基准（中位收益） */
function settleInDimension(model, dim, cons, sealOk) {
  var cost = ((cons.costModel && cons.costModel.totalRoundTripPct) || 0.31);
  var gate = (cons.target && cons.target.hardGate) || {};
  var minT = (cons.multipleTesting && cons.multipleTesting.minTStat) || 3;
  var rule = model.rule && model.rule.when && model.rule.when.length ? model.rule : null;

  // 先编译新特征并校验，失败直接返回，不启动流
  var nf = compileNew(model);
  if (!nf.ok) return Promise.resolve({ metrics: null, verdict: 'REJECT',
    reason: '新特征: ' + nf.errors.join(' / '), fails: ['新特征'] });
  var v = R.validate(rule || {}, nf.names);
  if (rule && !v.ok) return Promise.resolve({ metrics: null, verdict: 'REJECT',
    reason: '规则不合法: ' + v.errors.join(' / '), fails: ['规则'] });
  if (!sealOk) return Promise.resolve({ metrics: null, verdict: 'REJECT',
    reason: '宪法封印失效', fails: ['封印'] });
  var enrich = null;
  if (nf.names.length) {
    enrich = function (f) {
      nf.names.forEach(function (name) {
        var val;
        try { val = nf.compiled[name].eval(f); } catch (e) { val = null; }
        f[name] = isNum(val) ? val : null;
      });
    };
  }

  return new Promise(function (resolve) {
    var rl = require('readline').createInterface({ input: fs.createReadStream(SAMPLE, { encoding: 'utf8' }), crlfDelay: Infinity });
    var st = { eligible: 0, n: 0, sumNet: 0, wins: 0, rets: [], universe: [], byMonth: {} };
    rl.on('line', function (line) {
      if (!line.trim()) return;
      var s; try { s = JSON.parse(line); } catch (e) { return; }
      if (!dim.filter(s)) return;
      if (s.oneWord) return;                       // 一字板买不进
      var gross = s.y[dim.retKey];
      if (!isNum(gross)) return;                   // fail-closed
      st.universe.push(gross);                     // 全市场该维度基准
      st.eligible++;
      // 无规则 = baseline，全部可交易样本都算一笔（与 settle.js settleStream(null) 同口径）
      if (rule) {
        if (enrich) { s.f = s.f || {}; enrich(s.f); }
        if (R.evalRule(rule, s) !== 'match') return;
      }
      var net = gross - cost;
      st.n++; st.sumNet += net; if (net > 0) st.wins++;
      st.rets.push(net);
      var mo = s.date.slice(0, 7);
      var g = st.byMonth[mo] || (st.byMonth[mo] = { n: 0, sum: 0 });
      g.n++; g.sum += net;
    });
    rl.on('close', function () {
      var med = null;
      if (st.universe.length) {
        var a = st.universe.slice().sort(function (x, y) { return x - y; });
        med = a[Math.floor(a.length / 2)];
      }
      var avg = st.n ? st.sumNet / st.n : null;
      var sd = 0;
      if (st.n > 1 && st.rets.length) {
        var m = avg, ss = 0;
        st.rets.forEach(function (x) { ss += (x - m) * (x - m); });
        sd = Math.sqrt(ss / (st.rets.length - 1));
      }
      var tStat = (sd > 0 && st.n > 1) ? avg / (sd / Math.sqrt(st.n)) : null;
      var wilson = st.n ? K.wilsonLower(st.wins, st.n) : null;
      var coverage = st.eligible ? +(st.n / st.eligible * 100).toFixed(2) : 0;
      var excess = (isNum(med) && isNum(avg)) ? +(avg - (med - cost)).toFixed(4) : null;
      var segNets = Object.keys(st.byMonth).map(function (k) {
        var g = st.byMonth[k]; return g.n >= 10 ? g.sum / g.n : null;
      }).filter(isNum);
      var m = {
        n: st.n, eligible: st.eligible, coverage: coverage,
        netRet: avg == null ? null : +avg.toFixed(4),
        winRate: st.n ? +(st.wins / st.n).toFixed(4) : null,
        wilsonLower: wilson == null ? null : +wilson.toFixed(4),
        tStat: tStat == null ? null : +tStat.toFixed(3),
        benchmarkRet: med == null ? null : +(med - cost).toFixed(4),
        excessOverHold: excess,
        worstSegmentNet: segNets.length ? +Math.min.apply(null, segNets).toFixed(4) : null,
        segments: Object.keys(st.byMonth).length,
        costPct: cost, retKey: dim.retKey, dim: dim.key
      };
      var fails = [];
      if (!isNum(m.netRet) || m.netRet <= (gate.minNetRet3Pct || 0)) fails.push('净收益');
      if (!isNum(m.tStat) || m.tStat < minT) fails.push('t≥' + minT);
      if (!isNum(m.coverage) || m.coverage < (gate.minCoveragePct || 2)) fails.push('覆盖率');
      if (!isNum(m.wilsonLower) || m.wilsonLower < (gate.minWilsonLowerWinRate || 0.5)) fails.push('Wilson下界');
      if (!isNum(m.excessOverHold) || m.excessOverHold <= 0) fails.push('跑赢基准');
      resolve({ metrics: m, verdict: fails.length ? 'NOT_PROVEN' : 'PASSED',
        reason: fails.length ? ('未过门槛: ' + fails.join('、')) : '五关全过（历史回测，非前瞻）',
        fails: fails });
    });
    rl.on('error', function () { resolve({ metrics: null, verdict: 'ERROR', reason: '读取样本失败', fails: ['样本'] }); });
  });
}

/* 一维 baseline（无规则）：只给画像，不判通过 */
function baselineOf(dim, cons) {
  return settleInDimension({ rule: null, newFeatures: [] }, dim, cons, true)
    .then(function (r) { return r.metrics; });
}

function verifyAll(modelsPath) {
  var cons = loadJSON(CONST, {});
  var seal = K.verifySeal();
  var models = loadJSONL(modelsPath || MODELS).slice(-40);
  var dims = DIMENSIONS.map(function (d) {
    return baselineOf(d, cons).then(function (baseline) {
      return { key: d.key, name: d.name, desc: d.desc, retKey: d.retKey, baseline: baseline, models: [] };
    });
  });
  return Promise.all(dims).then(function (dimResults) {
    var byKey = {};
    dimResults.forEach(function (d) { byKey[d.key] = d; });
    var tasks = [];
    models.forEach(function (m) {
      var hz = m.horizon || 'day';
      if (!byKey[hz]) hz = 'day';   // 未声明维度默认按日，不丢模型
      tasks.push(settleInDimension(m, DIMENSIONS.filter(function (d) { return d.key === hz; })[0],
        cons, seal.ok).then(function (r) {
          byKey[hz].models.push({
            id: m.id || ('free_' + String(m.thesis || '').slice(0, 10)),
            name: m.name || '', thesis: m.thesis || '', horizon: hz,
            verdict: r.verdict, reason: r.reason, metrics: r.metrics,
            at: m.at || null
          });
        }));
    });
    return Promise.all(tasks).then(function () {
      dimResults.forEach(function (d) {
        d.passedCount = d.models.filter(function (x) { return x.verdict === 'PASSED'; }).length;
        d.notProvenCount = d.models.filter(function (x) { return x.verdict === 'NOT_PROVEN'; }).length;
      });
      var result = {
        generatedAt: new Date().toISOString(),
        sealOk: seal.ok, modelCount: models.length,
        dimensions: dimResults,
        disclaimer: '四维度全部为历史回测：信号级净收益已扣成本、含幸存者偏差与过拟合风险，非实盘前瞻收益，不构成投资建议。日内T0只对名称命中跨境/黄金/债券/货币等T+0品种的ETF放行，其余标缺口不编造。'
      };
      fs.mkdirSync(LAB, { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
      return result;
    });
  });
}

function main() {
  var mi = process.argv.indexOf('--models');
  var mp = mi >= 0 ? process.argv[mi + 1] : null;
  verifyAll(mp).then(function (r) {
    console.log('[verify-horizons] 模型 %d | 封印 %s', r.modelCount, r.sealOk ? '有效' : '失效');
    r.dimensions.forEach(function (d) {
      console.log('  %s(%s): baseline净=%s%% t=%s 覆盖=%s%% | 模型%d 跑出%d 未证明%d',
        d.name, d.key, d.baseline && d.baseline.netRet, d.baseline && d.baseline.tStat,
        d.baseline && d.baseline.coverage, d.models.length, d.passedCount, d.notProvenCount);
    });
    console.log('[verify-horizons] 已写入 %s', OUT);
  }).catch(function (e) {
    console.error('[verify-horizons] 失败:', e && e.stack || e);
    process.exit(1);
  });
}
if (require.main === module) main();
module.exports = { verifyAll: verifyAll, settleInDimension: settleInDimension, DIMENSIONS: DIMENSIONS, baselineOf: baselineOf };
