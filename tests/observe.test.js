/* 观察组学习 + 渲染修复 静态/逻辑自检 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');

// 1. 观察组切片逻辑（与 limitup_live.js obsSlice 一致）
function winOf(x) { return x.ev.a.win; }
function obsSlice(pool) {
  var n = pool.length, win = pool.filter(winOf).length;
  var rets = pool.map(function (x) { return x.ev.c.ret; }).filter(function (v) { return typeof v === 'number' && isFinite(v); });
  var wr = n ? +(win / n * 100).toFixed(1) : null;
  var ar = rets.length ? +(rets.reduce(function (a, b) { return a + b; }, 0) / rets.length).toFixed(2) : null;
  return { n: n, win: win, winRate: wr, avgRet5: ar };
}
var mk = function (win, ret) { return { ev: { a: { win: win }, c: { ret: ret } } }; };
var board = [mk(true, 8), mk(false, -6), mk(true, 3)];
var weak = [mk(false, -9), mk(false, -3), mk(false, 1), mk(true, 2)];
var ob = obsSlice(board), ow = obsSlice(weak);
assert.strictEqual(ob.n, 3, '连板降级样本数');
assert.strictEqual(ob.winRate, 66.7, '连板降级胜率');
assert.strictEqual(ob.avgRet5, 1.67, '连板降级T+5均值');
assert.strictEqual(ow.winRate, 25, '走弱回落胜率');
assert.strictEqual(obsSlice([]).winRate, null, '空样本不给胜率(不编造)');

// 2. TESTS 含观察组三条件
var live = fs.readFileSync(path.join(ROOT, 'tools', 'limitup_live.js'), 'utf8');
['phaseObserve', 'obsBoard', 'obsWeak', 'observeStats', 'phaseWhy'].forEach(function (k) {
  assert(live.indexOf(k) >= 0, '自进化脚本应含 ' + k);
});

// 3. 渲染修复：setHTML 存在且派发清单/情绪用 innerHTML，观察区有渲染与事件
var ov = fs.readFileSync(path.join(ROOT, 'oversold.html'), 'utf8');
assert(/function setHTML\(/.test(ov), '应定义 setHTML');
assert(ov.indexOf("setHTML('luDispList', html)") >= 0, '派发清单必须用 setHTML 而非 textContent');
assert(ov.indexOf("setHTML('luMood', moodHtml)") >= 0, '情绪模块必须用 setHTML');
assert(ov.indexOf("setHTML('luWatchList', html)") >= 0, '首板预警列表必须用 setHTML 而非 textContent');
assert(!/\bset\(\s*'[\w-]+'\s*,\s*html\s*\)/.test(ov), '不应再有用 set() 写 HTML 变量的乱码');
assert(!/\bset\(\s*'[\w-]+'\s*,\s*['"][^'"]*<(?:div|span|b|br|i|em|ul|li|table|tr|td)\b/.test(ov), '不应再有用 set() 写 HTML 字面量的乱码');
assert(ov.indexOf('function renderObs()') >= 0, '应有观察组渲染');
assert(ov.indexOf("data-ot") >= 0, '应有观察组 tab');
assert(ov.indexOf('fetchTurnTencent') >= 0, '换手率应走腾讯通道');
var a38 = ov.indexOf('a[38]'), a44 = ov.indexOf('a[44]');
assert(a38 > 0 && a44 > 0, '应解析腾讯字段38换手率/44流通市值');

// 4. 2026-11-25 定稿：超跌页启动池/自进化只保留「新发 + 观察」
assert(live.indexOf("POOL_PHASES = ['新发', '观察']") >= 0, '自进化池应只含新发/观察');
assert(live.indexOf("if (!inPool(p)) return;") >= 0, '旧台账也要过滤掉健康期/退化');
assert(live.indexOf('phaseHealth') < 0, '不应再有健康期条件');
assert(ov.indexOf("var allList = (G['新发'] || []).concat(G['观察'] || []);") >= 0, '页面启动池只取新发+观察');
assert(ov.indexOf('data-lut="health"') < 0, '页面不应再有健康期筛选');
assert(ov.indexOf("data-lut=\"phaseObs\"") >= 0, '页面应有启动观察阶段筛选');

// 5. 启动池搜索框（代码/名称/行业/板块，与 tab/表头筛选/排序叠加）
assert(ov.indexOf('id="luSearch"') >= 0, '页面应有启动池搜索框');
assert(ov.indexOf('id="luSearchInfo"') >= 0, '页面应有命中数提示');
assert(ov.indexOf('function luMatchQuery(') >= 0, '应定义搜索匹配函数');
assert(ov.indexOf('if (!luMatchQuery(x, luQuery)) return false;') >= 0, '搜索应参与列表筛选');
assert(ov.indexOf("getElementById('luSearch')") >= 0, '搜索框应绑定输入事件');
var mq = ov.match(/function luMatchQuery\(x, q\) \{[\s\S]*?\n  \}/);
assert(mq, '应能提取搜索匹配函数');
var matchFn = new Function(mq[0] + '; return luMatchQuery;')();
var stock = { code: '301575.SZ', name: '艾芬达', ind: '家居用品', rrg: '家居' };
assert.strictEqual(matchFn(stock, ''), true, '空词不过滤');
assert.strictEqual(matchFn(stock, '301575'), true, '裸代码可搜');
assert.strictEqual(matchFn(stock, '301575.SZ'), true, '全代码可搜');
assert.strictEqual(matchFn(stock, '艾芬达'), true, '名称可搜');
assert.strictEqual(matchFn(stock, '家居'), true, '行业/板块可搜');
assert.strictEqual(matchFn(stock, '电子'), false, '不匹配应过滤');
assert.strictEqual(matchFn(stock, '艾芬达 家居'), true, '空格分词按与匹配');
assert.strictEqual(matchFn(stock, '艾芬达 电子'), false, '多词有一个不匹配即过滤');

// 6. 搜索范围=整页：首板预警 / 派发清单 / 启动观察 / 今日优选 / 启动池 全部过滤
assert(ov.indexOf('全页查找') >= 0, '搜索框应标明整页生效');
assert(ov.indexOf("'整页 ' + Object.keys(hit).length") >= 0, '应显示整页命中数');
['W.list.filter(function (x) { return luMatchQuery(x, luQuery); })',
 'pool.filter(function (x) { return luMatchQuery(x, luQuery); })',
 'allObs.filter(function (x) { return luMatchQuery(x, luQuery); })',
 '(L.today || []).filter(function (x) { return luMatchQuery(x, luQuery); })'].forEach(function (frag) {
  assert(ov.indexOf(frag) >= 0, '整页搜索应覆盖：' + frag.split('.')[0]);
});

console.log('观察组学习+渲染修复测试 通过（切片4项 + 自进化5锚点 + 渲染7锚点 + 只留新发/观察6项 + 搜索14项）');
