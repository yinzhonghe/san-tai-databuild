/*
 * tests/data_foundation.test.js · 数据根基守护（2026-11-27）
 * 根因：① 测试污染生产心跳 → 当天演化被跳过；② 采样 head 截断 → 8-11月行情缺席；
 *       ③ 页面把报告生成日标成数据日 → 看着新其实旧。
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var ROOT = path.dirname(__dirname);
var EVO = path.join(ROOT, 'learn', 'evolve');
var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + ': ' + e.message); failed++; }
}
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function lastDate(p) {
  var fd = fs.openSync(p, 'r'), st = fs.fstatSync(fd), b = Buffer.alloc(4096);
  fs.readSync(fd, b, 0, 4096, Math.max(0, st.size - 4096)); fs.closeSync(fd);
  var lines = b.toString('utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]).date;
}

console.log('=== 数据根基守护测试 ===');

test('采样文件覆盖全时间窗（末日期距全样本 < 10 天）', function () {
  var full = lastDate(path.join(EVO, 'panel.jsonl'));
  var sample = lastDate(path.join(EVO, 'panel_sample100k.jsonl'));
  var gap = (Date.parse(full) - Date.parse(sample)) / 86400000;
  assert.ok(gap < 10, '采样末 ' + sample + ' 距全样本 ' + full + ' 有 ' + gap.toFixed(0) + ' 天（head 截断？）');
});

test('kline 与 panel_gaps 的 asOf 一致', function () {
  var k = readJson(path.join(ROOT, 'kline', 'index.json'), {});
  var g = readJson(path.join(EVO, 'panel_gaps.json'), {});
  assert.ok(k.asOf && g.asOf, '缺 asOf');
  assert.strictEqual(String(k.asOf), String(g.asOf), 'kline=' + k.asOf + ' gaps=' + g.asOf);
});

test('报告带 dataAsOf 且非 TEST 心跳', function () {
  var s = fs.readFileSync(path.join(ROOT, 'evolve_report.js'), 'utf8');
  assert.ok(s.indexOf('"dataAsOf"') >= 0, 'report 缺 dataAsOf 字段');
  var hb = readJson(path.join(EVO, 'heartbeat.json'), {});
  assert.notStrictEqual(hb.version, 'TEST', '生产心跳被测试污染为 TEST');
  assert.ok(hb.gen == null || hb.gen < 50, '心跳 gen=' + hb.gen + ' 异常（测试写 gen=99？）');
});

test('make_sample.js 存在且被云端工作流调用', function () {
  var p = path.join(ROOT, 'tools', 'evolve', 'make_sample.js');
  assert.ok(fs.existsSync(p), '缺 make_sample.js');
  var yml = fs.readFileSync(path.join(ROOT, 'github_ci', 'evolve_daily.yml'), 'utf8');
  assert.ok(yml.indexOf('make_sample.js') >= 0, '云端工作流未重建采样');
});

// 2026-11-27：hunter 探活误判根因——裸 curl + 只看 HTTP 200
var H = require('../tools/evolve/hunter.js');
test('hunter 探活：带真实数据的 200 判定可用', function () {
  var out = '{"rc":0,"data":{"klines":["2026-11-26,1,2,3"]}}\n__HTTP__200\n';
  var r = H.parseProbe(out);
  assert.strictEqual(r.ok, true, '真实数据应判可用');
  assert.strictEqual(r.rows, 1);
});
test('hunter 探活：200 但空 data 不得判可用（防误报）', function () {
  ['{"rc":100,"data":null}\n__HTTP__200\n', '{"data":{"klines":[]}}\n__HTTP__200\n'].forEach(function (out) {
    assert.strictEqual(H.parseProbe(out).ok, false, '空数据不应判可用: ' + out.slice(0, 30));
  });
});
test('hunter 探活：限流 HTTP000 判不可用（诚实报错）', function () {
  assert.strictEqual(H.parseProbe('\n__HTTP__000\n').ok, false);
});
test('hunter 探活：带浏览器头+ut 的 probeUrl 已登记', function () {
  var reg = readJson(path.join(EVO, 'data_sources.json'), {});
  var f = reg.fundflow_hist || {};
  assert.ok(f.probeUrl && f.probeUrl.indexOf('ut=') >= 0, '缺带 ut 的 probeUrl');
  assert.ok(f.probeUrl.indexOf('secid=') >= 0, 'probeUrl 缺 secid');
});

// 2026-11-27：自进化「四关」漏洞——覆盖率从未计算、机会成本空值放行、旧 t 值做硬验证
var K2 = require('../tools/evolve/kernel.js');
test('软裁判：覆盖率缺失一律 REFUTED（不许空值放行）', function () {
  var s = { netRet3: 0.5, wilsonLower: 0.55, coverage: null, excessOverHold: 0.3, tStat: 4 };
  var v = K2.softJudge(s, { target: { hardGate: { minCoveragePct: 2 }, opportunityCost: { requireExcessOverHold: true } }, multipleTesting: { minTStat: 3 } });
  assert.strictEqual(v.verdict, 'REFUTED', '覆盖率空值不得通过');
  assert.ok(v.notes.some(function (x) { return x.indexOf('覆盖率') >= 0; }), '缺覆盖率拒绝理由');
});
test('软裁判：机会成本空值一律 REFUTED（不许 null 放行）', function () {
  var s = { netRet3: 0.5, wilsonLower: 0.55, coverage: 5, excessOverHold: null, tStat: 4 };
  var v = K2.softJudge(s, { target: { hardGate: { minCoveragePct: 2 }, opportunityCost: { requireExcessOverHold: true } }, multipleTesting: { minTStat: 3 } });
  assert.strictEqual(v.verdict, 'REFUTED', '机会成本空值不得通过');
});
test('软裁判：四关全过才 NOT_REFUTED', function () {
  var s = { netRet3: 0.5, wilsonLower: 0.55, coverage: 5, excessOverHold: 0.3, tStat: 4 };
  var v = K2.softJudge(s, { target: { hardGate: { minCoveragePct: 2 }, opportunityCost: { requireExcessOverHold: true } }, multipleTesting: { minTStat: 3 } });
  assert.strictEqual(v.verdict, 'NOT_REFUTED');
});
test('软裁判：善于伪装的弱收益（t<3）不得放行', function () {
  var s = { netRet3: 0.0386, wilsonLower: 0.459, coverage: 5, excessOverHold: 0.1, tStat: 0.327 };
  var v = K2.softJudge(s, { target: { hardGate: { minCoveragePct: 2 }, opportunityCost: { requireExcessOverHold: true } }, multipleTesting: { minTStat: 3 } });
  assert.strictEqual(v.verdict, 'REFUTED');
});
test('硬验证：t 值低于门槛必须 HARD_REJECT', function () {
  var rule = { id: 'x', when: [{ f: 'ret5', op: '>', v: 0 }], expect: 'up', status: 'shadow', tStat: -7 };
  var v = K2.hardGate(rule, {});
  assert.strictEqual(v.verdict, 'HARD_REJECT', 't=-7 不该 HARD_PASS');
});

setTimeout(function () {
  console.log('\n结果: ' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
}, 200);
