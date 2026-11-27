/*
 * tests/event_alert.test.js · 三报重大事件强预警守护（2026-11-27）
 * 守护四件事：
 *   ① 事件库覆盖顶层会议/印花税/国家队/外部冲击等关键暴涨暴跌类型
 *   ② 命中扫描：国常会定调资本市场=已发生+强+up；预告类=即将发生
 *   ③ 三报接线：DEEP_QUERY 加国常会检索、facts 带 eventAlerts、SYSTEM 有强预警要求、
 *      system_prompt 拼入事件规律、content 有 eventAlert 横幅
 *   ④ 前端接线：app.js 渲染 eventAlert 横幅、styles.css 有样式
 * 红线：只读检查，不改任何生产文件。
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var ROOT = path.dirname(__dirname);
var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + ': ' + e.message); failed++; }
}
function readText(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return ''; } }

console.log('=== 三报重大事件强预警守护测试 ===');

var py = readText(path.join('github_ci', 'event_alert.py'));
var gr = readText(path.join('github_ci', 'gen_report.py'));
var app = readText('app.js');
var css = readText('styles.css');

test('事件库 + 自测通过（python event_alert.py --self-test）', function () {
  assert.ok(py, 'event_alert.py 缺失');
  var exe = process.platform === 'win32' ? 'python' : 'python3';
  var r = cp.spawnSync(exe, [path.join(ROOT, 'github_ci', 'event_alert.py'), '--self-test'],
    { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, '自测失败: ' + (r.stdout || r.stderr || '').slice(-200));
});

test('事件库覆盖 9 类暴涨暴跌事件', function () {
  ['gov_council_capital_market', 'politburo_cewc', 'pboc_liquidity', 'stamp_duty',
    'national_team_etf', 'external_shock', 'fed_monetary', 'regulatory_crackdown',
    'supply_policy'].forEach(function (id) {
      assert.ok(py.indexOf(id) >= 0, '缺事件类型: ' + id);
    });
});

test('规律文字含国常会午后暴涨教训与历史参照数字', function () {
  var primerIdx = py.indexOf('def primer');
  var primer = py.slice(primerIdx);
  ['国常会', '印花税', '科创50', '9.29%', '国家队'].forEach(function (kw) {
    assert.ok(primer.indexOf(kw) >= 0, 'primer 缺: ' + kw);
  });
});

test('gen_report DEEP_QUERY 加国常会/政治局/印花税/汇金检索', function () {
  ['国务院常务会议 资本市场 稳市', '政治局会议 资本市场', '印花税 下调 上调',
    '中央汇金 增持ETF 平准基金'].forEach(function (kw) {
      assert.ok(gr.indexOf(kw) >= 0, '缺检索词: ' + kw);
    });
});

test('build_facts 扫描事件并写进事实包 eventAlerts', function () {
  assert.ok(gr.indexOf('EA.detect_alerts(scan_items)') >= 0, '未调用事件扫描');
  assert.ok(gr.indexOf("'eventAlerts': alerts") >= 0, '事实包缺 eventAlerts 字段');
  assert.ok(gr.indexOf('重大事件强预警扫描') >= 0, '诊断步骤缺扫描记录');
});

test('compact_facts 把预警写进「重大事件预警」字段 + 注意事项', function () {
  assert.ok(gr.indexOf("'重大事件预警': [{") >= 0, '事实包缺重大事件预警字段');
  assert.ok(gr.indexOf('按 SYSTEM 里的强预警写作硬要求处理') >= 0, '注意事项未接入强预警写作要求');
});

test('SYSTEM 有强预警硬要求，system_prompt 拼入事件规律', function () {
  assert.ok(gr.indexOf('【重大事件强预警：最高优先级'), 'SYSTEM 缺强预警硬要求');
  assert.ok(gr.indexOf('⚠事件强预警') >= 0, 'SYSTEM 缺 ⚠ 写法');
  assert.ok(gr.indexOf('EA.primer()') >= 0, 'system_prompt 未拼入事件规律');
});

test('content 有确定性 eventAlert 横幅（模型漏写/模板兜底也不丢）', function () {
  assert.ok(gr.indexOf("content['eventAlert'] = EA.banner") >= 0, '未写 eventAlert 横幅');
  assert.ok(gr.indexOf("content['eventAlerts'] = [") >= 0, '未写 eventAlerts 明细');
});

test('前端渲染 eventAlert 横幅 + 样式', function () {
  assert.ok(app.indexOf('S.eventAlert') >= 0, 'app.js 未渲染 eventAlert');
  assert.ok(app.indexOf('daily-event-alert') >= 0, 'app.js 缺样式类');
  assert.ok(css.indexOf('.daily-event-alert') >= 0, 'styles.css 缺样式');
});

console.log('\n[event_alert] ' + passed + '/' + (passed + failed) + ' 项通过');
if (failed) process.exit(1);
