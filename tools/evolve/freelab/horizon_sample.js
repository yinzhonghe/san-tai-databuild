/*
 * tools/evolve/freelab/horizon_sample.js · 四时间维度真实收益样本生成器
 * =====================================================================
 * 背景：自由推演实验室要按【月 / 周 / 日 / T0ETF·日内】四个维度推演，
 *       但 panel.jsonl 只有 sigRet3（T+3 收盘→收盘），没有其它持有期的真实收益。
 *       本模块从真实 kline 分片按 (code,date) 对齐样本，逐条计算四个维度的真实收益：
 *         d20  = T 收盘买 → T+20 收盘卖（月，约20个交易日）
 *         d5   = T 收盘买 → T+5  收盘卖（周）
 *         d1   = T 收盘买 → T+1  收盘卖（日）
 *         intra= T 开盘买 → T 收盘卖（日内/T0；仅对支持 T+0 的 ETF/品种放行，其余标 notT0）
 *       再按 constitution 的往返成本扣费（一字板买不进标 oneWord，验证时剔除）。
 *
 * 红线：
 *   - 只用真实 kline OHLC，缺数据一律 null（fail-closed），不用 0/估算顶替。
 *   - 不改 constitution / population / heartbeat；产物只写 learn/evolve/freelab/。
 *   - 成本口径保守：T0 也按同一往返成本扣，不假设 ETF 免印花税（缺口里如实标注）。
 *
 * 产物：learn/evolve/freelab/horizon_sample.jsonl
 * 用法：node tools/evolve/freelab/horizon_sample.js [--full]
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.dirname(path.dirname(path.dirname(__dirname)));  // tools/evolve/freelab -> 根
var EVO = path.join(ROOT, 'learn', 'evolve');
var LAB = path.join(EVO, 'freelab');
var KLINE = path.join(ROOT, 'kline');
var SAMPLE = path.join(EVO, 'panel_sample100k.jsonl');
var FULL = path.join(EVO, 'panel.jsonl');
var OUT = path.join(LAB, 'horizon_sample.jsonl');

var PANEL = require('../panel.js');
var T0_KEYWORDS = /黄金|纳指|恒生|标普|日经|德国|法国|亚太|东南亚|国际|QDII|债|货币|美元|日元|融资|添益|日利/;

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function r(v) { return isNum(v) ? +v.toFixed(3) : null; }
function retPct(a, b) { return (isNum(a) && isNum(b) && a > 0) ? +((b / a - 1) * 100).toFixed(3) : null; }
function todayCN() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }

/* 加载 kline 分片 → {code: [{d,o,h,l,c,v}...]}（复用 panel.js 已验证的解码器） */
function loadBars() {
  var idxPath = path.join(KLINE, 'index.json');
  if (!fs.existsSync(idxPath)) throw new Error('缺少 kline/index.json');
  var idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  var byShard = {};
  Object.keys(idx.map || {}).forEach(function (code) {
    var s = idx.map[code];
    (byShard[s] = byShard[s] || []).push(code);
  });
  var bars = {};
  Object.keys(byShard).forEach(function (s) {
    var p = path.join(KLINE, 's' + s + '.json');
    if (!fs.existsSync(p)) return;
    var j = JSON.parse(fs.readFileSync(p, 'utf8'));
    byShard[s].forEach(function (code) {
      if (j.codes && j.codes[code]) bars[code] = PANEL.decodeKline(j.codes[code]);
    });
  });
  return { bars: bars, asOf: idx.asOf || '' };
}

/* code -> {date: barIndex}，只建样本里出现的 code 的索引，省内存 */
function buildIndex(bars, wantedCodes) {
  var map = {};
  Object.keys(wantedCodes).forEach(function (code) {
    var arr = bars[code];
    if (!arr) return;
    var m = {};
    for (var i = 0; i < arr.length; i++) m[arr[i].d] = i;
    map[code] = m;
  });
  return map;
}

/* 从 data.js 读 ETF 真实名称（panel 行没有 name 字段），用于识别 T+0 品种 */
function loadNames() {
  var out = {}, p = path.join(ROOT, 'data.js');
  try {
    var s = fs.readFileSync(p, 'utf8');
    var d = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    (d.rows || []).forEach(function (r) { if (r && r.code) out[r.code] = r.name || ''; });
  } catch (e) {}
  return out;
}

function build(useFull) {
  var src = useFull && fs.existsSync(FULL) ? FULL : SAMPLE;
  var uni = loadBars();
  var names = loadNames();
  var lines = fs.readFileSync(src, 'utf8').split('\n');
  var wanted = {};
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { var s0 = JSON.parse(lines[i]); wanted[s0.code] = 1; } catch (e) {}
  }
  var dateIdx = buildIndex(uni.bars, wanted);

  var stat = { rows: 0, written: 0, noBar: 0, shortHist: 0, oneWord: 0,
    d1: 0, d5: 0, d20: 0, intra: 0, t0Eligible: 0, firstDate: '', lastDate: '' };
  fs.mkdirSync(LAB, { recursive: true });
  var out = fs.createWriteStream(OUT, { encoding: 'utf8' });

  for (var li = 0; li < lines.length; li++) {
    var line = lines[li];
    if (!line.trim()) continue;
    stat.rows++;
    var s; try { s = JSON.parse(line); } catch (e) { continue; }
    var idxMap = dateIdx[s.code], t = idxMap && idxMap[s.date];
    if (t == null) { stat.noBar++; continue; }
    var bars = uni.bars[s.code];
    if (t + 20 >= bars.length) { stat.shortHist++; continue; }   // d20 需要 T+20，不够就整条跳过
    var bT = bars[t];
    var y = {
      d1: retPct(bT.c, bars[t + 1] && bars[t + 1].c),
      d5: retPct(bT.c, bars[t + 5] && bars[t + 5].c),
      d20: retPct(bT.c, bars[t + 20] && bars[t + 20].c),
      intra: retPct(bT.o, bT.c)       // T 日开盘买 → T 日收盘卖（日内）
    };
    // 一字板：T 日开=高=低=收 且涨幅接近涨停 → 日内买不进，验证时剔除
    var lim = s.lim || 9.8;
    var oneWord = isNum(bT.o) && bT.o === bT.h && bT.h === bT.l && bT.l === bT.c &&
      t > 0 && bars[t - 1].c > 0 && retPct(bars[t - 1].c, bT.c) >= lim - 0.5;
    if (oneWord) stat.oneWord++;
    // T0 放行：ETF 名称命中跨境/黄金/债券/货币等 T+0 品种；其余标 notT0（不编造）
    var nm = names[s.code] || s.name || '';
    var t0ok = !!s.isEtf && T0_KEYWORDS.test(nm);
    if (t0ok) stat.t0Eligible++;
    ['d1', 'd5', 'd20', 'intra'].forEach(function (k) { if (isNum(y[k])) stat[k]++; });
    if (!stat.firstDate || s.date < stat.firstDate) stat.firstDate = s.date;
    if (!stat.lastDate || s.date > stat.lastDate) stat.lastDate = s.date;
    out.write(JSON.stringify({
      code: s.code, date: s.date, ind: s.ind || '', isEtf: !!s.isEtf,
      name: s.name || '', lim: lim, t0ok: t0ok,
      f: s.f || {}, y: y, oneWord: oneWord
    }) + '\n');
    stat.written++;
  }
  out.end();
  stat.asOf = uni.asOf;
  stat.generatedOn = todayCN();
  stat.source = path.basename(src);
  fs.writeFileSync(path.join(LAB, 'horizon_sample_status.json'), JSON.stringify(stat, null, 2), 'utf8');
  return stat;
}

function main() {
  var useFull = process.argv.indexOf('--full') >= 0;
  var t0 = Date.now();
  var s = build(useFull);
  console.log('[horizon-sample] 源=%s 样本=%d 写出=%d 无K线=%d 历史不足=%d 一字板=%d',
    s.source, s.rows, s.written, s.noBar, s.shortHist, s.oneWord);
  console.log('[horizon-sample] 有效收益 d1=%d d5=%d d20=%d intra=%d | T0放行ETF=%d | %s~%s | %ds',
    s.d1, s.d5, s.d20, s.intra, s.t0Eligible, s.firstDate, s.lastDate, Math.round((Date.now() - t0) / 1000));
  console.log('[horizon-sample] 已写入 %s', OUT);
}
if (require.main === module) main();
module.exports = { build: build, loadBars: loadBars, T0_KEYWORDS: T0_KEYWORDS };
