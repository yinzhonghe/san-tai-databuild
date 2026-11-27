/*
 * tests/fundflow_batch.test.js · 批量资金流地基守护
 * 守护：
 *   ① 批量抓取器存在且用 datacenter-web RPT_DMSK_TS_FUNDFLOW（不同 WAF，绕开 push2his 限流）
 *   ② 北交所 secid 误判已修（0.920xxx 实测可用，不再标 unsupported）
 *   ③ 画像脚本合并批量(gz)+逐票(jsonl)双源，字段索引一致
 *   ④ 云端 workflow 用批量为主 + ETF 逐票为辅，状态推 data
 *   ⑤ 诚实：状态文件不把缺口填 0；ETF 缺口明确标注
 * 本测试只读，不写生产状态。
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var ROOT = path.dirname(__dirname);
var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + ': ' + e.message); failed++; }
}
function text(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return ''; } }
function json(rel, d) { try { return JSON.parse(text(rel)); } catch (e) { return d; } }

console.log('=== 批量资金流地基守护测试 ===');

var batchPy = text('tools/fetch_fundflow_batch.py');
var histPy = text('tools/fetch_fundflow_hist.py');
var portraitJs = text('tools/evolve/freelab/fundflow_portrait.js');
var yml = text('github_ci/freelab.yml');

// ① 批量抓取器
test('批量抓取器存在且用 datacenter-web 报表（绕开 push2his 限流）', function () {
  assert.ok(batchPy.length > 2000, '批量抓取器缺失或过短');
  assert.ok(batchPy.indexOf('datacenter-web.eastmoney.com') >= 0, '未用 datacenter-web 子域');
  assert.ok(batchPy.indexOf('RPT_DMSK_TS_FUNDFLOW') >= 0, '未用全市场批量报表');
  assert.ok(batchPy.indexOf('pageSize') >= 0 && batchPy.indexOf('5000') >= 0, '未设置大分页');
});
test('批量抓取器支持断点续传与 gzip（分片目录 + 原子写）', function () {
  assert.ok(batchPy.indexOf('fundflow_batch_shards') >= 0, '缺分片续传');
  assert.ok(batchPy.indexOf('gzip.open') >= 0, '缺 gzip 压缩');
  assert.ok(batchPy.indexOf('os.replace') >= 0, '缺原子写');
});
test('批量抓取器字段索引与画像一致（date/main/super/big/mid/small/pct/close/chg）', function () {
  ['NET_INFLOW', 'SUPERDEAL_NET', 'BIGDEAL_NET', 'MIDDEAL_NET', 'SMALLDEAL_NET',
   'NET_INFLOW_RATIO', 'CLOSE_PRICE', 'CHANGE_RATE'].forEach(function (f) {
    assert.ok(batchPy.indexOf(f) >= 0, '批量器缺字段 ' + f);
  });
});

// ② 北交所 secid 修正
test('北交所 secid 已修为 0.920xxx（不再误标 unsupported）', function () {
  assert.ok(histPy.indexOf("return '0.' + bare, None") >= 0, 'BJ 分支未返回 0. 前缀');
  assert.ok(histPy.indexOf("unsupported_bj_secid") < 0, '仍残留 BJ unsupported 误判');
  assert.ok(histPy.indexOf('920') >= 0, '未提 920 新代码');
});
test('逐票抓取器有 --only-etf 模式（避免个股重复请求触发限流）', function () {
  assert.ok(histPy.indexOf('--only-etf') >= 0, '缺 --only-etf 参数');
  assert.ok(histPy.indexOf("t['isEtf']") >= 0, '未按 isEtf 过滤');
});

// ③ 画像双源合并
test('画像脚本合并批量 gz + 逐票 jsonl 双源', function () {
  assert.ok(portraitJs.indexOf('fundflow_batch.jsonl.gz') >= 0, '未读批量 gz');
  assert.ok(portraitJs.indexOf('zlib.gunzipSync') >= 0, '未解压 gz');
  assert.ok(portraitJs.indexOf('fundflow_hist.jsonl') >= 0, '未读逐票 jsonl');
  assert.ok(portraitJs.indexOf('absorb') >= 0, '缺双源合并函数');
});
test('画像暴露批量状态（覆盖率/北交所/ETF缺口）', function () {
  assert.ok(portraitJs.indexOf('batchStatus') >= 0, '未暴露 batchStatus');
  assert.ok(portraitJs.indexOf('stockCoveragePct') >= 0, '未暴露股票覆盖率');
  assert.ok(portraitJs.indexOf('bjCovered') >= 0, '未暴露北交所覆盖');
  assert.ok(portraitJs.indexOf('etfGapRows') >= 0, '未暴露 ETF 缺口');
});

// ④ workflow
test('云端 workflow 批量抓取为主、ETF 逐票为辅', function () {
  assert.ok(yml.indexOf('fetch_fundflow_batch.py') >= 0, 'workflow 未跑批量抓取');
  assert.ok(yml.indexOf('--only-etf') >= 0, 'workflow 未跑 ETF 补抓');
  assert.ok(yml.indexOf('fundflow_batch_shards') >= 0, 'workflow 未同步分片');
  assert.ok(yml.indexOf('fundflow_batch.jsonl.gz') >= 0, 'workflow 未推批量产物到 data');
});

// ⑤ 诚实性
test('状态文件把 ETF/北交所缺口明确标注（不填0、不估算）', function () {
  assert.ok(batchPy.indexOf('etfGapNote') >= 0, '未标注 ETF 缺口');
  assert.ok(batchPy.indexOf('bjNote') >= 0, '未标注北交所说明');
  assert.ok(batchPy.indexOf('不填 0') >= 0 || batchPy.indexOf('不填0') >= 0, '未写明诚实原则');
});
test('已生成的批量状态（若存在）覆盖率真实且北交所缺口非空标注', function () {
  var st = json('learn/evolve/fundflow_batch_status.json', null);
  if (!st) return; // 尚未回补，跳过（不阻塞）
  assert.ok(typeof st.coveragePct === 'number' && st.coveragePct >= 0 && st.coveragePct <= 100,
    '覆盖率异常');
  assert.ok(st.bjCodes > 0, '北交所代码数应为正');
  assert.ok(typeof st.etfGapRows === 'number', '缺 ETF 缺口行数');
});

// ⑥ ETF 批量源（FTShare，2026-11-27）
var etfPy = text('tools/fetch_etf_ftshare.py');
test('ETF 批量抓取器存在且用 FTShare 东财ETF资金流接口', function () {
  assert.ok(etfPy.length > 2000, 'ETF 批量抓取器缺失');
  assert.ok(etfPy.indexOf('eastmoney-etf-flow') >= 0, '未用 ETF 资金流接口');
  assert.ok(etfPy.indexOf('page_size') >= 0 && etfPy.indexOf('1000') >= 0, '未按大分页批量出数');
  assert.ok(etfPy.indexOf('start_date') >= 0 && etfPy.indexOf('end_date') >= 0, '未按日期区间批量');
});
test('ETF 批量器字段与东财逐位对齐（元→万元，9列）', function () {
  ['main_net', 'xl_net', 'l_net', 'm_net', 's_net', 'main_pct', 'close', 'change_pct'].forEach(function (f) {
    assert.ok(etfPy.indexOf(f) >= 0, '缺字段 ' + f);
  });
  assert.ok(etfPy.indexOf('10000.0') >= 0, '未做元→万元换算');
  assert.ok(etfPy.indexOf('逐位') >= 0 || etfPy.indexOf('完全一致') >= 0, '未声明逐位验证');
});
test('ETF 批量器断点续传 + 诚实早期缺口', function () {
  assert.ok(etfPy.indexOf('fundflow_etf_shards') >= 0, '缺分片续传');
  assert.ok(etfPy.indexOf('os.replace') >= 0, '缺原子写');
  assert.ok(etfPy.indexOf('2026-03-16') >= 0, '未标注数据起点');
  assert.ok(etfPy.indexOf('earlyGapRows') >= 0, '未标注早期缺口');
  assert.ok(etfPy.indexOf('不填0') >= 0 || etfPy.indexOf('不填 0') >= 0, '未写明诚实原则');
});
test('画像脚本三源合并（批量+ETF批量+逐票兜底）并暴露 etfStatus', function () {
  assert.ok(portraitJs.indexOf('fundflow_etf.jsonl') >= 0, '未读 ETF 批量 jsonl');
  assert.ok(portraitJs.indexOf('etfStatus') >= 0, '未暴露 etfStatus');
  assert.ok(portraitJs.indexOf('etfCoveragePct') >= 0, '未暴露 ETF 覆盖率');
  assert.ok(portraitJs.indexOf('earlyGapRows') >= 0, '未暴露早期缺口');
});
test('云端 workflow 接入 ETF 批量抓取与分片同步', function () {
  assert.ok(yml.indexOf('fetch_etf_ftshare.py') >= 0, 'workflow 未跑 ETF 批量抓取');
  assert.ok(yml.indexOf('fundflow_etf_shards') >= 0, 'workflow 未同步 ETF 分片');
  assert.ok(yml.indexOf('fundflow_etf.jsonl') >= 0, 'workflow 未推 ETF 产物到 data');
});
test('已生成的 ETF 状态（若存在）覆盖率真实且早期缺口标注', function () {
  var st = json('learn/evolve/fundflow_etf_status.json', null);
  if (!st) return; // 尚未回补，跳过（不阻塞）
  assert.ok(typeof st.etfCoveragePct === 'number' && st.etfCoveragePct >= 0 && st.etfCoveragePct <= 100,
    'ETF 覆盖率异常');
  // 抓取中的中间状态（--max-pages 调试）覆盖率为 0，跳过代码数校验
  if (st.etfCoveragePct > 0) {
    assert.ok(st.fetchedEtfCodes > 0, 'ETF 抓取代码数应为正');
  }
  assert.ok(typeof st.earlyGapRows === 'number', '缺早期缺口行数');
});

console.log('\n[fundflow-batch] 通过 %d / 失败 %d', passed, failed);
process.exit(failed ? 1 : 0);
