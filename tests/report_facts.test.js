/*
 * tests/report_facts.test.js · 三报「封板数 / 历史对比」诚实性守护（2026-11-27）
 *
 * 事故复盘：
 *   ① 2026-11-27 真实涨停 426 只，收评写 1465 只——因为 grab_breadth() 用
 *      「涨跌幅 >=9.8%」近似涨停，20CM/30CM 板块集体暴涨时把「涨了 10% 以上」
 *      全算成封板。必须改问东财涨停/跌停池，失败时明确标「估算，非真实封板」。
 *   ② 同一稿写「今日涨幅已超越 924（上证 +4.15%）案例」，
 *      但同段今日上证只有 +3.73%——两个数字都在事实包里，
 *      unmatched_numbers 查不出来，需要 comparison_issues 做同指数一致性门禁。
 *
 * 红线：只读检查，不改任何生产文件。
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var ROOT = path.dirname(__dirname);
var pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + ': ' + e.message); fail++; }
}

console.log('=== 三报事实口径守护测试 ===');
var gr = fs.readFileSync(path.join(ROOT, 'github_ci', 'gen_report.py'), 'utf8');
var ea = fs.readFileSync(path.join(ROOT, 'github_ci', 'event_alert.py'), 'utf8');

test('涨停改走东财真实封板池，不再拿 9.8% 当涨停', function () {
  assert.ok(gr.indexOf('getTopic%sPool') >= 0, '未接涨停/跌停池');
  assert.ok(gr.indexOf("'ZT' if kind == 'up' else 'DT'") >= 0, '未区分涨停/跌停池');
  assert.ok(gr.indexOf('def grab_limit_pool') >= 0, '缺 grab_limit_pool()');
  assert.ok(gr.indexOf("'limit_up': lu if lu_real is None else lu_real") >= 0,
    '真实封板数未优先写入 breadth.limit_up');
  assert.ok(gr.indexOf("'limitUpApprox': approx") >= 0, '缺估算标记');
  assert.ok(gr.indexOf('涨幅≥9.8%估算（非真实封板）') >= 0, '降级口径未明说不是真实封板');
});

test('事实包/提示词把封板口径交给模型', function () {
  assert.ok(gr.indexOf("'涨停口径':") >= 0, 'compact_facts 缺涨停口径字段');
  assert.ok(gr.indexOf('只能引用事实包「涨跌家数」里的 limit_up/limit_down') >= 0,
    'SYSTEM 缺封板数硬规则');
  assert.ok(gr.indexOf('涨幅≥9.8% 不是涨停') >= 0, 'SYSTEM 未点明 9.8% 陷阱');
});

test('历史对比同指数同口径门禁已接线（首稿+两轮重写）', function () {
  assert.ok(gr.indexOf('def comparison_issues') >= 0, '缺 comparison_issues()');
  assert.ok(gr.indexOf('case_as_today_issues(content, facts_raw)') >= 0,
    '首稿未过门禁');
  assert.ok((gr.match(/case_as_today_issues\(content[23], facts_raw\)/g) || []).length === 2,
    '两轮重写未过门禁');
  assert.ok(gr.indexOf('同指数、同口径、同方向') >= 0, 'SYSTEM 缺同指数比较规则');
});

test('提示词示例不带可照抄的当日涨幅数字', function () {
  var m = ea.match(/oneLine 开头必须点名事件与方向（例：([^）]*)）/);
  assert.ok(m, '找不到 oneLine 示例');
  assert.ok(!/\d+(\.\d+)?%/.test(m[1]), '示例里带了涨幅数字，模型会照抄：' + m[1]);
  assert.ok(ea.indexOf('不得照抄提示词里的历史案例数字') >= 0, '未声明示例不是今日事实');
});

test('comparison_issues 运行时：拦反结论、放过否定式与真实超越', function () {
  var exe = process.platform === 'win32' ? 'python' : 'python3';
  var code = [
    'import importlib.util, sys',
    'spec = importlib.util.spec_from_file_location("gr", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'cases = ["2024-09-24 一行一局一会：上证 +4.15%、创业板 +5.54%"]',
    'facts = {"quotes": {"sh000001": {"pct": 3.73}}, "eventAlerts": [{"cases": cases}]}',
    'bad = {"points": ["上证今日涨3.73%，历史复盘上证涨4.15%，今日涨幅已超越该案例。"]}',
    'assert m.comparison_issues(bad, facts), "反向结论没拦住"',
    'neg = {"points": ["上证今日涨3.73%，历史复盘上证涨4.15%，今日涨幅尚未超越该案例。"]}',
    'assert not m.comparison_issues(neg, facts), "否定式被误伤"',
    'facts2 = {"quotes": {"sh000001": {"pct": 5.2}}, "eventAlerts": [{"cases": cases}]}',
    'good = {"points": ["上证今日涨5.2%，历史复盘上证涨4.15%，今日涨幅已超越该案例。"]}',
    'assert not m.comparison_issues(good, facts2), "真实超越被误伤"',
    'print("OK")'
  ].join('\n');
  var r = cp.spawnSync(exe, ['-c', code, path.join(ROOT, 'github_ci', 'gen_report.py')],
    { cwd: ROOT, encoding: 'utf8', timeout: 40000 });
  assert.equal(r.status, 0, 'Python 校验失败: ' + (r.stdout || '') + (r.stderr || '').slice(-400));
  assert.ok((r.stdout || '').indexOf('OK') >= 0, '未输出 OK');
});

test('前端市场条不再用涨幅阈值冒充封板数', function () {
  var app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  var ds = fs.readFileSync(path.join(ROOT, 'data-service.js'), 'utf8');
  assert.ok(ds.indexOf('getLimitPools') >= 0, 'DS 缺真实封板池接口');
  assert.ok(ds.indexOf('getTopic') >= 0 && ds.indexOf('Pool') >= 0, '未接涨停/跌停池');
  assert.ok(ds.indexOf('data.tc') >= 0 || ds.indexOf('dd.tc') >= 0, '未读 tc 封板数');
  assert.ok(app.indexOf('DS.getLimitPools') >= 0, 'app.js 未调真实封板池');
  assert.ok(app.indexOf('实时·真实封板') >= 0, '未标注真实封板口径');
  assert.ok(app.indexOf('取数失败') >= 0, '取数失败未明确标注');
  // 不允许再用 limitPct 阈值数涨停（refreshBreadth 里那段必须已删）
  var rb = app.slice(app.indexOf('function refreshBreadth'), app.indexOf('function refreshHs300'));
  assert.ok(rb.indexOf('limitPct') < 0, 'refreshBreadth 仍用涨幅阈值近似涨停');
});

test('comparison_issues 运行时：整数案例/提示词照抄/创纪录也拦，跨指数不误伤', function () {
  var exe = process.platform === 'win32' ? 'python' : 'python3';
  var code = [
    'import importlib.util, sys',
    'spec = importlib.util.spec_from_file_location("gr", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'def chk(name, points, q, expect, alerts=None):',
    '    f = {"quotes": q}',
    '    if alerts is not None: f["eventAlerts"] = alerts',
    '    got = bool(m.comparison_issues({"points": points}, f))',
    '    assert got == expect, name + " expect=" + str(expect) + " got=" + str(got)',
    'sh = {"sh000001": {"pct": 3.73}}',
    'alerts = [{"cases": ["2024-09-24 上证 +4.15%"]}]',
    'chk("整数案例4%", ["上证今日涨3.73%，历史案例上证涨4%，今日涨幅已超越该案例。"], sh, True)',
    'chk("无eventAlert照抄924", ["上证今日涨3.73%，924案例上证涨4.15%，今日涨幅已超越该案例。"], sh, True)',
    'chk("创历史新高", ["上证今日涨3.73%，创下历史新高。"], sh, True, alerts)',
    'chk("真实超越5.2", ["上证今日涨5.2%，924案例上证涨4.15%，今日涨幅已超越该案例。"], {"sh000001":{"pct":5.2}}, False)',
    'chk("否定式", ["上证今日涨3.73%，924案例上证涨4.15%，今日涨幅尚未超越该案例。"], sh, False, alerts)',
    'chk("创业板口径不误伤", ["创业板今日涨11.61%，924案例创业板涨5.54%，今日涨幅已超越该案例。"], {"sz399006":{"pct":11.61}}, False, [{"cases":["2024-09-24 创业板 +5.54%"]}])',
    'print("OK")'
  ].join('\n');
  var r = cp.spawnSync(exe, ['-c', code, path.join(ROOT, 'github_ci', 'gen_report.py')],
    { cwd: ROOT, encoding: 'utf8', timeout: 40000 });
  assert.equal(r.status, 0, 'Python 校验失败: ' + (r.stdout || '') + (r.stderr || '').slice(-400));
  assert.ok((r.stdout || '').indexOf('OK') >= 0, '未输出 OK');
});

test('case_as_today_issues 运行时：案例数字写成今日涨幅拦下，历史语境/真实值不误伤', function () {
  var exe = process.platform === 'win32' ? 'python' : 'python3';
  var code = [
    'import importlib.util, sys',
    'spec = importlib.util.spec_from_file_location("gr", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'f = {"quotes": {"sh000001": {"pct": 3.73}}}',
    'bad = {"points": ["今日上证涨4.15%，成长股领涨。"]}',
    'assert m.case_as_today_issues(bad, f), "案例数字冒充今日没拦住"',
    'hist = {"points": ["历史复盘924上证涨4.15%，今日上证涨3.73%。"]}',
    'assert not m.case_as_today_issues(hist, f), "历史语境被误伤"',
    'real = {"points": ["今日上证涨3.73%，成交2万亿。"]}',
    'assert not m.case_as_today_issues(real, f), "真实今日值被误伤"',
    'print("OK")'
  ].join('\n');
  var r = cp.spawnSync(exe, ['-c', code, path.join(ROOT, 'github_ci', 'gen_report.py')],
    { cwd: ROOT, encoding: 'utf8', timeout: 40000 });
  assert.equal(r.status, 0, 'Python 校验失败: ' + (r.stdout || '') + (r.stderr || '').slice(-400));
  assert.ok((r.stdout || '').indexOf('OK') >= 0, '未输出 OK');
});

console.log('\n[report_facts] ' + pass + '/' + (pass + fail) + ' 项通过');
process.exit(fail ? 1 : 0);
