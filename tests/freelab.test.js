/*
 * tests/freelab.test.js · 自由推演实验室守护（与 v2 证据包自进化独立）
 * 守护四件事：
 *   ① 真实市场画像地基（facts.json 有真实数据、缺口不编造、净收益为实测值）
 *   ② 新特征可复现路径打通（曾因 rules.validate 不认新特征字段而误 REJECT）
 *   ③ 验证器诚实（净收益为负/覆盖率不足一律 NOT_PROVEN，绝不 PASSED）
 *   ④ 页面接入（入口⑤、板块⑤、报告加载带 sharecode、渲染函数存在、转义兜底）
 * 红线：本测试只读，不写生产状态文件（facts/models/verified 均为已生成产物）。
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var ROOT = path.dirname(__dirname);
var EVO = path.join(ROOT, 'learn', 'evolve');
var LAB = path.join(EVO, 'freelab');
var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + ': ' + e.message); failed++; }
}
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }

console.log('=== 自由推演实验室守护测试 ===');

var facts = readJson(path.join(LAB, 'facts.json'), null);
var verified = readJson(path.join(LAB, 'verified.json'), null);

// ① 市场画像地基
test('facts.json 存在且来自真实样本（样本数>1万、特征20个）', function () {
  assert.ok(facts, 'facts.json 缺失');
  assert.ok(facts.baseline.samples > 10000, '样本数异常: ' + facts.baseline.samples);
  assert.equal(Object.keys(facts.features).length, 20, '特征数不是20');
});
test('画像净收益为实测值且字段含成本/一字板剔除（非编造）', function () {
  assert.ok(typeof facts.baseline.measuredNet === 'number', '缺实测净收益');
  assert.ok(facts.baseline.costPct > 0, '成本未计入');
  assert.ok(facts.baseline.skippedOneWord >= 0 && facts.baseline.skippedNoData >= 0, '缺一字板/缺口计数');
  assert.ok(facts.baseline.samples >= facts.baseline.tradable, '可交易数不应大于样本数');
});
test('每个特征有5档分位且净收益为真实值（fail-closed：档数或净收益缺失则失败）', function () {
  var ks = Object.keys(facts.features);
  ks.forEach(function (k) {
    var f = facts.features[k];
    assert.equal(f.buckets.length, 5, k + ' 分档数不是5');
    f.buckets.forEach(function (b) {
      assert.ok(typeof b.net === 'number' && isFinite(b.net), k + ' 存在非数值净收益档');
      assert.ok(b.n > 0, k + ' 存在空档');
    });
  });
});
test('数据缺口如实标注（gaps 存在，不伪造数值）', function () {
  assert.ok(facts.gaps, '缺 gaps');
  assert.ok(typeof facts.gaps.noIndustry === 'number', '缺口字段缺失');
});

// ② 新特征路径（曾踩坑：rules.validate 不认新特征名 → REJECT）
var R = require('../tools/evolve/rules.js');
var EXPR = require('../tools/evolve/expr.js');
test('rules.validate 不传 extraFields 时仍拒绝未知特征（生产链路不变）', function () {
  var rule = { when: [{ f: 'freeDepth', op: '>', v: 0 }], unless: [], expect: 'up', deps: ['close'] };
  var v = R.validate(rule);
  assert.equal(v.ok, false, '原链路应拒绝未知特征');
});
test('rules.validate 传 extraFields 时接受已编译新特征（自由推演路径打通）', function () {
  var rule = { when: [{ f: 'freeDepth', op: '>', v: 0 }], unless: [], expect: 'up', deps: ['close'] };
  var v = R.validate(rule, ['freeDepth']);
  assert.equal(v.ok, true, '自由推演路径应接受新特征');
});
test('新特征表达式可编译且依赖都被识别', function () {
  var c = EXPR.compile('clamp((-ret60-19.466)/40,0,1)');
  assert.ok(c.deps.indexOf('ret60') >= 0, '依赖识别失败');
  assert.ok(typeof c.eval === 'function', '求值函数缺失');
});

// ③ 验证器诚实
test('verified.json 存在且封印有效、结论分类齐全', function () {
  assert.ok(verified, 'verified.json 缺失');
  assert.equal(verified.sealOk, true, '宪法封印失效');
  assert.ok(typeof verified.passedCount === 'number', '缺 passedCount');
});
test('验证器诚实：净收益为负的模型绝不被判 PASSED', function () {
  (verified.models || []).forEach(function (m) {
    var x = m.metrics || {};
    if (typeof x.netRet3 === 'number' && x.netRet3 <= 0) {
      assert.notEqual(m.verdict, 'PASSED', m.id + ' 负净收益却判跑出');
    }
  });
});
test('新特征模型被真实验证（不再误判 REJECT，而是有结算结果）', function () {
  var nf = (verified.models || []).filter(function (m) { return m.id === 'free_20261127_04'; })[0];
  if (nf) {
    assert.notEqual(nf.verdict, 'REJECT', '新特征仍被误拒绝');
    assert.ok(nf.metrics && typeof nf.metrics.netRet3 === 'number', '新特征模型无结算结果');
  }
});
test('叙事型假设标 FREE_HYPOTHESIS，不计入跑出', function () {
  var nar = (verified.models || []).filter(function (m) { return m.verdict === 'FREE_HYPOTHESIS'; });
  assert.ok(nar.length >= 1, '缺叙事型假设分类');
  nar.forEach(function (m) { assert.equal(m.metrics, null, '叙事假设不应有结算指标'); });
});

// ④ 页面接入
var html = readText(path.join(ROOT, 'oversold.html'));
test('页面有入口卡片⑤与板块⑤容器', function () {
  assert.ok(html.indexOf('data-page="p5"') >= 0, '缺入口⑤');
  assert.ok(html.indexOf('id="p5"') >= 0, '缺板块⑤容器');
  assert.ok(html.indexOf('id="flSummary"') >= 0, '缺摘要框');
});
test('freelab_report.js 加载带 sharecode（分享站点红线）', function () {
  var m = html.match(/<script src="freelab_report\.js\?[^"]*"/);
  assert.ok(m, '缺报告加载');
  assert.ok(m[0].indexOf('sharecode=EPDR6ET2KO') >= 0, '报告加载缺 sharecode');
});
test('渲染函数存在且文本过 esc（XSS 兜底）', function () {
  assert.ok(html.indexOf('renderFreeLab') >= 0, '缺渲染函数');
  assert.ok(html.indexOf("var esc = function (s)") >= 0, '缺 esc 转义');
});
test('构建脚本包含 freelab_report.js（发布不漏文件）', function () {
  var b = readText(path.join(ROOT, 'tools', 'build_site.py'));
  assert.ok(b.indexOf('"freelab_report.js"') >= 0, '构建清单缺报告文件');
});
test('独立状态目录不污染主链路（产物写 freelab/，只读封印宪法）', function () {
  var v = readText(path.join(ROOT, 'tools', 'evolve', 'freelab', 'verify.js'));
  assert.ok(v.indexOf("path.join(EVO, 'freelab')") >= 0, '验证器产物路径不在 freelab 命名空间');
  assert.ok(v.indexOf('constitution.json') >= 0, '验证器应读封印宪法校验');
  assert.ok(v.indexOf('population.json') < 0, '验证器不得写 population 主链路');
});

// ⑤ 资金流维度（真实抓取 + join 画像，缺口不编造）
var fundPortrait = readJson(path.join(LAB, 'fundflow_portrait.json'), null);
test('资金流画像脚本存在（真实抓取 join，无未来函数）', function () {
  var src = readText(path.join(ROOT, 'tools', 'evolve', 'freelab', 'fundflow_portrait.js'));
  assert.ok(src.indexOf("date <= T") >= 0 || src.indexOf('idx + 1') >= 0, '资金流派生未限制在T日及之前');
  assert.ok(src.indexOf('标缺口') >= 0, '缺缺口标注');
});
test('资金流抓取器存在且诚实（退避/续传/缺口，不用0顶替）', function () {
  var src = readText(path.join(ROOT, 'tools', 'fetch_fundflow_hist.py'));
  assert.ok(src.indexOf('UT_POOL') >= 0, '缺多ut轮换（限流防护）');
  assert.ok(src.indexOf('断点续传') >= 0 || src.indexOf('load_done') >= 0, '缺断点续传');
  assert.ok(src.indexOf('unsupported_bj_secid') >= 0, '北交所缺口未标注');
});
test('facts.json 含资金流维度（或明确为null待抓）', function () {
  assert.ok('fundflow' in facts, 'facts 缺 fundflow 字段');
  if (facts.fundflow) {
    assert.ok(facts.fundflow.fetchedCodes >= 0, '缺抓取票数');
    assert.ok(facts.fundflow.features && facts.fundflow.features.main5, '缺主力净流入特征');
    assert.ok(facts.fundflow.joinRate >= 0 && facts.fundflow.joinRate <= 1, 'join率异常');
  }
});
test('资金流画像净收益为实测（若已join样本则非编造）', function () {
  if (fundPortrait && fundPortrait.joinedRows > 0) {
    assert.ok(typeof fundPortrait.baseline.measuredNet === 'number', '缺实测净收益');
    assert.ok(fundPortrait.baseline.costPct > 0, '资金流画像未计成本');
    assert.ok(fundPortrait.joinRate <= 1, 'join率>1异常');
  }
});
test('data_sources.json 资金流源标记 verified（状态与适配器一致）', function () {
  var d = readJson(path.join(EVO, 'data_sources.json'), {});
  assert.equal(d.fundflow_hist.status, 'verified', '资金流源状态未更新');
  assert.ok(d.fundflow_hist.script.indexOf('fetch_fundflow_hist') >= 0, '资金流适配器脚本未记录');
});

console.log('\n[freelab] 通过 %d / 失败 %d', passed, failed);
process.exit(failed ? 1 : 0);
