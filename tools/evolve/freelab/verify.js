/*
 * tools/evolve/freelab/verify.js · 自由推演实验室 · 模型验证器
 * ================================================================
 * 大模型可以【自由提出任何模型假设】，但能不能算「跑出一个模型」，
 * 必须由这套验证器用真实数据说了算——自由度在「假设」，严格度在「验证」。
 *
 * 验证链（复用 v2 已被审计的地基，不另造轮子）：
 *   规则合法性(rules.validate) → 新特征可复现(expr.checkReproducible)
 *   → 封印宪法(kernel.verifySeal) → 信号级真实结算(settle.settleStream)
 *   → 宪法硬门槛 + 跑赢持有基准 → 结论
 *
 * 红线：
 *   - 只用真实样本，缺数据 skip（fail-closed），不拿 0 顶替。
 *   - 不改 constitution / population / heartbeat；本模块状态全在 freelab/ 下。
 *   - 通过 ≠ 荐股；一律标注「历史回测、含幸存者偏差、非前瞻收益」。
 *
 * 产物：learn/evolve/freelab/verified.json
 * 用法：node tools/evolve/freelab/verify.js [--models <path>]
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.dirname(path.dirname(path.dirname(__dirname)));
var EVO = path.join(ROOT, 'learn', 'evolve');
var LAB = path.join(EVO, 'freelab');
var CONST = path.join(EVO, 'constitution.json');
var SAMPLE = path.join(EVO, 'panel_sample100k.jsonl');
var MODELS = path.join(LAB, 'models.jsonl');
var OUT = path.join(LAB, 'verified.json');

var R = require('../rules.js');
var K = require('../kernel.js');
var S = require('../settle.js');
var EXPR = require('../expr.js');
var FEAT = require('../features.js');

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function loadJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function loadJSONL(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; }
}

/* 抽样 2000 行做可复现检查（与 expr.checkReproducible 口径一致） */
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

/* 把模型的 newFeatures 编译进一份「临时特征定义副本」，不污染 features.js。
   返回 {ok, errors, compiled:{name->{eval}}, deps:[]} */
function compileNewFeatures(model) {
  var res = { ok: true, errors: [], compiled: {}, deps: [] };
  var nfs = model.newFeatures || [];
  var rows = sampleRows(2000);
  nfs.forEach(function (nf) {
    if (nf.name && FEAT.META[nf.name]) {
      res.errors.push('新特征名与已注册特征冲突: ' + nf.name);
      res.ok = false; return;
    }
    var c;
    try { c = EXPR.compile(nf.expr); }
    catch (e) { res.errors.push('表达式编译失败[' + nf.name + ']: ' + e.message); res.ok = false; return; }
    // 依赖必须都是已注册特征
    var bad = c.deps.filter(function (d) { return !FEAT.META[d]; });
    if (bad.length) { res.errors.push('未注册依赖[' + nf.name + ']: ' + bad.join(',')); res.ok = false; return; }
    var chk = EXPR.checkReproducible(c, rows);
    if (!chk.ok) { res.errors.push('不可复现[' + nf.name + ']: ' + chk.reason); res.ok = false; return; }
    res.compiled[nf.name] = c;
    c.deps.forEach(function (d) { if (res.deps.indexOf(d) < 0) res.deps.push(d); });
  });
  return res;
}

/* 用真实样本结算一个模型。模型形态：
 *   { id, thesis, rule:{when,unless,expect,deps}, newFeatures:[{name,expr}] }
 *   rule 为空 / 无法执行 → 标为「自由假设·待工程化」，不算跑出模型。
 */
function verifyOne(model, cons, sealOk) {
  var out = {
    id: model.id || ('free_' + String(model.thesis || '').slice(0, 12)),
    thesis: model.thesis || (model.rule && model.rule.desc) || '',
    origin: model.origin || 'llm_free',
    modelType: model.modelType || 'rule',
    at: model.at || null,
    verdict: 'NOT_EVALUATED', reason: '', metrics: null
  };
  var rule = model.rule || null;

  if (!rule || !rule.when || !rule.when.length) {
    out.verdict = 'FREE_HYPOTHESIS';
    out.reason = '自由假设（叙事/无法直接执行的模型），尚未工程化为可回测规则；不计入「跑出模型」。';
    return out;
  }

  // 新特征编译
  var nf = compileNewFeatures(model);
  if (!nf.ok) {
    out.verdict = 'REJECT';
    out.reason = '新特征未过可复现检查: ' + nf.errors.join(' / ');
    return out;
  }

  // 规则合法性：已注册特征 + 本次编译通过的可复现新特征名
  var newNames = Object.keys(nf.compiled);
  var v = R.validate(rule, newNames);
  if (!v.ok) {
    out.verdict = 'REJECT';
    out.reason = '规则不合法: ' + v.errors.join(' / ');
    return out;
  }

  // 封印宪法：验证阶段必须先过封印（但不改它）
  if (!sealOk) {
    out.verdict = 'REJECT';
    out.reason = '[FATAL] 宪法封印失效，拒绝验证。';
    return out;
  }

  // 真实结算：把新特征值注入 s.f（逐样本、按编译 AST 求值），不改原样本
  var enrichFn = newNames.length ? function (f) {
    newNames.forEach(function (name) {
      var value;
      try { value = nf.compiled[name].eval(f); } catch (e) { value = null; }
      f[name] = isNum(value) ? value : null;   // 缺数据 null → evalRule 判 skip（fail-closed）
    });
  } : null;

  return S.settleStream(rule, null, enrichFn).then(function (s) {
    var gate = (cons.target && cons.target.hardGate) || {};
    var minT = (cons.multipleTesting && cons.multipleTesting.minTStat) || 3;
    var fails = [];
    if (!isNum(s.netRet3) || s.netRet3 <= (gate.minNetRet3Pct || 0)) fails.push('净收益');
    if (!isNum(s.tStat) || s.tStat < minT) fails.push('t≥' + minT);
    if (!isNum(s.coverage) || s.coverage < (gate.minCoveragePct || 2)) fails.push('覆盖率');
    if (!isNum(s.wilsonLower) || s.wilsonLower < (gate.minWilsonLowerWinRate || 0.5)) fails.push('Wilson下界');
    if (!isNum(s.excessOverHold) || s.excessOverHold <= 0) fails.push('跑赢基准');
    out.metrics = s;
    out.verdict = fails.length ? 'NOT_PROVEN' : 'PASSED';
    out.reason = fails.length
      ? ('未过门槛: ' + fails.join('、') + '（历史回测，非前瞻收益）')
      : '五关全过（历史回测口径，含幸存者偏差，非荐股）。';
    return out;
  }).catch(function (e) {
    out.verdict = 'ERROR';
    out.reason = '结算异常: ' + (e && e.message || e);
    return out;
  });
}

function verifyAll(modelsPath) {
  var cons = loadJSON(CONST, {});
  var seal = K.verifySeal();
  var models = loadJSONL(modelsPath || MODELS);
  // 只取最近 40 条，避免无限增长拖慢
  models = models.slice(-40);
  return Promise.all(models.map(function (m) { return verifyOne(m, cons, seal.ok); }))
    .then(function (verified) {
      var passed = verified.filter(function (v) { return v.verdict === 'PASSED'; });
      var proven = verified.filter(function (v) { return v.verdict === 'NOT_PROVEN'; });
      var result = {
        generatedAt: new Date().toISOString(),
        sealOk: seal.ok,
        modelCount: verified.length,
        passedCount: passed.length,
        notProvenCount: proven.length,
        freeHypothesisCount: verified.filter(function (v) { return v.verdict === 'FREE_HYPOTHESIS'; }).length,
        disclaimer: '全部为历史回测：信号级净收益已扣成本、含幸存者偏差与过拟合风险，非实盘前瞻收益，不构成投资建议。',
        models: verified
      };
      fs.mkdirSync(LAB, { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
      return result;
    });
}

function main() {
  var mi = process.argv.indexOf('--models');
  var mp = mi >= 0 ? process.argv[mi + 1] : null;
  verifyAll(mp).then(function (r) {
    console.log('[freelab-verify] 模型 %d 个 | 跑出(PASSED) %d | 未证明 %d | 自由假设 %d | 封印 %s',
      r.modelCount, r.passedCount, r.notProvenCount, r.freeHypothesisCount, r.sealOk ? '有效' : '失效');
    console.log('[freelab-verify] 已写入 %s', OUT);
  }).catch(function (e) {
    console.error('[freelab-verify] 失败:', e && e.stack || e);
    process.exit(1);
  });
}
if (require.main === module) main();
module.exports = { verifyOne: verifyOne, verifyAll: verifyAll, compileNewFeatures: compileNewFeatures };
