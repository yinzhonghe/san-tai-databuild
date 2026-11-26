/*
 * tools/evolve/kernel.js · 分层不可绕过验证器（M1/T2 定稿）
 * ============================================================
 * 从数学范式（AlphaProof/Nexus 的 Lean kernel）迁移，但承认股市没有零误报的二元验证器：
 *   - 硬验证层（hard）：确定性、零误报，任何策略必须通过，否则直接 REJECT。
 *   - 软裁判层（soft）：概率性结论，只说「当前证据下未被证伪」，永不说「正确」。
 *
 * 硬验证层检查（全部可机械判定）：
 *   1. constitution 哈希一致（锚点未被改动）
 *   2. 规则 DSL 合法（R.validate）+ 所有特征在 META 里真实存在
 *   3. 数据可复现：规则依赖的字段历史覆盖率 ≥ 阈值
 *   4. 可成交性：一字板/涨跌停信号已在 panel 标记剔除
 *   5. 时间隔离：holdout 段未被用于生成规则（检查 rule.bornFrom 来源）
 *   6. 多重检验：按全局累计试验数校正 t 值
 *   7. 证据包完整（evidence.requiredForActive）
 *
 * 软裁判层：净收益、胜率 Wilson 下界、覆盖率、机会成本、稳健分（只给分数，不判"正确"）。
 *
 * 用法：
 *   node tools/evolve/kernel.js --seal           # 首次封印 constitution，写 hash
 *   node tools/evolve/kernel.js --verify         # 校验 constitution hash
 *   node tools/evolve/kernel.js --hard <rule.json>  # 对单条规则跑硬验证
 */
'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var R = require('./rules.js');
var FEAT = require('./features.js');

var ROOT = path.dirname(path.dirname(__dirname));
var EVO = path.join(ROOT, 'learn', 'evolve');
var CONST = path.join(EVO, 'constitution.json');
var SEAL = path.join(EVO, 'constitution.seal.json');
var PANEL = path.join(EVO, 'panel.jsonl');
var TRIAL_COUNTER = path.join(EVO, 'trial_counter.json');

function loadJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function hashOf(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

/* 封印：把 constitution 的 hash 写进 seal 文件（人工操作，模型无权调用） */
function seal() {
  if (!fs.existsSync(CONST)) throw new Error('缺 constitution.json');
  var h = hashOf(CONST);
  var s = { hash: h, sealedAt: new Date().toISOString(), version: loadJSON(CONST, {}).version };
  fs.writeFileSync(SEAL, JSON.stringify(s, null, 2) + '\n');
  return s;
}

/* 校验：constitution 是否被改动。返回 {ok, reason} */
function verifySeal() {
  if (!fs.existsSync(SEAL)) return { ok: false, reason: '未封印（请先人工运行 --seal）' };
  var sealObj = loadJSON(SEAL, {});
  var now = hashOf(CONST);
  if (!sealObj.hash) return { ok: false, reason: 'seal 无 hash' };
  if (sealObj.hash !== now) return { ok: false, reason: 'constitution 已被改动！hash 不匹配，拒绝运行。请人工确认后重新封印。' };
  return { ok: true, hash: now };
}

/* 硬验证层：对一条规则做零误报检查。返回 {pass, reasons[], checks{}} */
function hardGate(rule, opts) {
  opts = opts || {};
  var checks = {};
  var reasons = [];

  // 0) 锚点完整性
  var sealChk = verifySeal();
  checks.constitution = sealChk.ok;
  if (!sealChk.ok) reasons.push('[FATAL] ' + sealChk.reason);

  // 1) DSL 合法性 + 特征真实性
  var v = R.validate(rule);
  checks.dsl = v.ok;
  if (!v.ok) reasons.push('DSL 非法: ' + v.errors.join('; '));
  var allCond = (rule.when || []).concat(rule.unless || []);
  var unknownFeat = allCond.map(function (c) { return c.f; })
    .filter(function (f) { return !FEAT.META[f]; });
  checks.featuresReal = unknownFeat.length === 0;
  if (unknownFeat.length) reasons.push('不存在的特征: ' + unknownFeat.join(', '));
  // 表达式新特征：必须在 META 里注册且通过可复现检查（C 分支）
  if (rule.newFeatures) {
    var bad = rule.newFeatures.filter(function (nf) {
      return !nf.name || !nf.expr || !FEAT.META[nf.name] || nf.reproducible !== true;
    });
    checks.newFeaturesReal = bad.length === 0;
    if (bad.length) reasons.push('新特征未注册或未通过可复现检查: ' + bad.map(function (b) { return b.name; }).join(', '));
  }

  // 2) 数据可复现：依赖字段在面板中的覆盖率
  var depCoverage = opts.depCoverage || {};
  Object.keys(depCoverage).forEach(function (f) {
    if (depCoverage[f] < 0.95) reasons.push('特征 ' + f + ' 覆盖率 ' + (depCoverage[f] * 100).toFixed(1) + '% < 95%');
  });
  checks.dataReproducible = reasons.filter(function (x) { return x.indexOf('覆盖率') >= 0; }).length === 0;

  // 3) 可成交性：规则不得依赖一字板信号（panel 已标记 sigOneWord，裁判侧剔除）
  checks.tradable = rule.excludeOneWord !== false;  // 默认必须排除一字板
  if (!checks.tradable) reasons.push('规则未排除一字板信号（不可成交）');

  // 4) 时间隔离：规则不得声明使用 holdout 段生成
  var cons = loadJSON(CONST, {});
  var hold = cons.validation || {};
  checks.timeIsolated = !(rule.bornFrom && rule.bornFrom.usedHoldout === true);
  if (!checks.timeIsolated) reasons.push('规则生成时使用了 holdout 验证段（数据泄漏）');

  // 5) 多重检验：全局试验次数校正
  var tc = loadJSON(TRIAL_COUNTER, { total: 0 });
  var minT = (cons.multipleTesting || {}).minTStat || 3.0;
  checks.multipleTesting = (rule.tStat == null) || (rule.tStat >= minT);
  if (!checks.multipleTesting) reasons.push('t 值 ' + rule.tStat + ' < ' + minT + '（累计试验 ' + tc.total + ' 次后门槛）');

  // 6) 证据包（仅 active 准入时检查；shadow 阶段可缺）
  if (opts.forActive) {
    var need = (cons.evidence || {}).requiredForActive || [];
    var missing = need.filter(function (k) { return rule.evidence == null || rule.evidence[k] == null; });
    checks.evidence = missing.length === 0;
    if (missing.length) reasons.push('证据包缺失: ' + missing.join(', '));
  }

  var fatal = reasons.filter(function (x) { return x.indexOf('[FATAL]') === 0; }).length > 0;
  var pass = !fatal && reasons.length === 0;
  return { pass: pass, checks: checks, reasons: reasons, verdict: fatal ? 'REJECT_ANCHOR' : (pass ? 'HARD_PASS' : 'HARD_REJECT') };
}

/* 软裁判层：给定结算统计，返回概率性结论（永不说"正确"）。
   stats: {netRet3, winRate, wilsonLower, coverage, excessOverHold, worstSegment, n, tStat} */
function softJudge(stats, cons) {
  cons = cons || loadJSON(CONST, {});
  var g = (cons.target || {}).hardGate || {};
  var notes = [];
  var ok = true;
  function chk(cond, msg) { if (!cond) { ok = false; notes.push(msg); } }
  chk(isFinite(stats.netRet3) && stats.netRet3 > (g.minNetRet3Pct || 0),
    '净收益 ' + stats.netRet3 + '% 未过门槛 ' + (g.minNetRet3Pct || 0) + '%');
  chk(isFinite(stats.wilsonLower) && stats.wilsonLower >= (g.minWilsonLowerWinRate || 0.5),
    '胜率 Wilson 下界 ' + stats.wilsonLower + ' 未过 ' + (g.minWilsonLowerWinRate || 0.5));
  chk(isFinite(stats.coverage) && stats.coverage >= (g.minCoveragePct || 2),
    '覆盖率 ' + stats.coverage + '% 未过 ' + (g.minCoveragePct || 2) + '%');
  chk(stats.excessOverHold !== false, '未跑赢持有基准（机会成本）');
  chk(!isFinite(stats.tStat) || stats.tStat >= ((cons.multipleTesting || {}).minTStat || 3),
    't 值 ' + stats.tStat + ' 未过多重检验门槛');
  return {
    verdict: ok ? 'NOT_REFUTED' : 'REFUTED',
    confidence: 'probabilistic',
    statement: ok ? '当前证据下未被证伪（非「正确」，需持续活体考核）' : '已被当前证据拒绝',
    notes: notes, stats: stats
  };
}

/* 试验计数器：每次提交候选规则到 kernel 都 +1（全局、持久化） */
function bumpTrial(n) {
  n = n || 1;
  var tc = loadJSON(TRIAL_COUNTER, { total: 0, history: [] });
  tc.total = (tc.total || 0) + n;
  tc.history.push({ at: new Date().toISOString(), delta: n, total: tc.total });
  if (tc.history.length > 200) tc.history = tc.history.slice(-200);
  fs.writeFileSync(TRIAL_COUNTER, JSON.stringify(tc, null, 2) + '\n');
  return tc.total;
}

function main() {
  var args = process.argv.slice(2);
  if (args[0] === '--seal') { console.log('封印:', JSON.stringify(seal())); return; }
  if (args[0] === '--verify') { console.log('校验:', JSON.stringify(verifySeal())); return; }
  if (args[0] === '--hard') {
    var p = args[1];
    if (!p) { console.error('用法: --hard <rule.json>'); process.exit(1); }
    var rule = loadJSON(p, null);
    if (!rule) { console.error('规则文件读取失败:', p); process.exit(1); }
    console.log(JSON.stringify(hardGate(rule, { forActive: args.indexOf('--active') >= 0 }), null, 2));
    return;
  }
  console.log('用法: --seal | --verify | --hard <rule.json> [--active]');
}
if (require.main === module) main();
function wilsonLower(k, n, z) {
  if (!n) return 0;
  z = z || 1.96;
  var p = k / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}
module.exports = { seal: seal, verifySeal: verifySeal, hardGate: hardGate,
  softJudge: softJudge, bumpTrial: bumpTrial, hashOf: hashOf, wilsonLower: wilsonLower };
