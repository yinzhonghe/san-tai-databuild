/*
 * tools/evolve/panel.js · 历史横截面重建器（自进化地基）
 * ---------------------------------------------------------------------------
 * grill-me 定稿 A/B 分支：
 *   - 目标：盘整→启动「前 1~3 天」识别，标签=T+1..T+3 出现可交易启动。
 *   - 命中口径：放量突破 或 非一字涨停；一字板剔除。
 *   - 收益：启动日收盘买入 → T+3 收盘（封板则次日开盘）。
 *   - 样本：250 日 kline 分片（含量）做核心回测；长历史 OHLC 只做形态。
 *   - 红线：缺数据标 null / 跳过，绝不用 0 顶替、绝不编造。
 *
 * 用法：
 *   node tools/evolve/panel.js            # 生成 learn/evolve/panel.jsonl + 缺口清单
 *   node tools/evolve/panel.js --check    # 只统计，不落盘
 */
'use strict';
var fs = require('fs');
var path = require('path');
var FEAT = require('./features.js');

var ROOT = path.dirname(path.dirname(__dirname));   // tools/evolve → 仓库根
var KLINE_DIR = path.join(ROOT, 'kline');
var DATAJS = path.join(ROOT, 'data.js');
var OUT_DIR = path.join(ROOT, 'learn', 'evolve');
var PANEL_OUT = path.join(OUT_DIR, 'panel.jsonl');
var GAP_OUT = path.join(OUT_DIR, 'panel_gaps.json');
var OFFSET = 8192;
var BASE_DAY = Date.UTC(2020, 0, 1) / 86400000;

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function decodeKline(packed) {
  if (typeof packed !== 'string' || packed.length < 4) return [];
  var prevClose = parseInt(packed.slice(0, 4), 36);
  var prevDay = 0, body = packed.slice(4), rows = [];
  for (var i = 0; i + 17 <= body.length; i += 17) {
    var seg = body.slice(i, i + 17);
    var dlt = parseInt(seg.slice(0, 3), 36);
    var day = prevDay === 0 ? dlt : prevDay + dlt;
    var o = parseInt(seg.slice(3, 6), 36) - OFFSET + prevClose;
    var h = parseInt(seg.slice(6, 9), 36) - OFFSET + prevClose;
    var l = parseInt(seg.slice(9, 12), 36) - OFFSET + prevClose;
    var c = parseInt(seg.slice(12, 15), 36) - OFFSET + prevClose;
    var v = Math.pow(10, parseInt(seg.slice(15, 17), 36) / 100) - 1;
    if (!(c > 0) || !(h >= l)) { prevClose = c; prevDay = day; continue; }
    rows.push({
      d: new Date((BASE_DAY + day) * 86400000).toISOString().slice(0, 10),
      o: o / 100, h: h / 100, l: l / 100, c: c / 100, v: Math.max(0, v)
    });
    prevClose = c; prevDay = day;
  }
  return rows;
}
function limitOf(code) {
  var b = String(code || '').split('.')[0];
  if (/^(30|68)/.test(b)) return 19.8;
  if (/^(8|4|920)/.test(b)) return 29.5;
  return 9.8;
}
function kindOf(code) {
  var b = String(code || '').split('.')[0];
  if (/^(30|68)/.test(b)) return 'gem';
  if (/^(8|4|920)/.test(b)) return 'bj';
  return 'main';
}

/* 命中判定：从 T 日起往后看 1..3 天，找第一个「可交易启动日」。
   返回 {hit, day, entry, entrySrc, ret3, sigRet3, sigOneWord, oneWordSeen} 或 null（数据不足）。
   sigRet3 = 信号级净收益基础：T 日收盘买入 → T+3 收盘卖出（无论是否命中启动）。
   这是「每个信号都算钱」的结算口径（B 分支定稿）：不看是否命中，T 日发信号就算一笔。
   sigOneWord = T 日本身一字板（买不进），此类信号不可成交，裁判必须剔除。 */
function labelOf(bars, t, limPct) {
  if (t + 3 >= bars.length) return null;
  var end0 = bars[t + 3];
  var sigRet3 = (end0 && end0.c > 0 && bars[t].c > 0)
    ? +((end0.c / bars[t].c - 1) * 100).toFixed(3) : null;
  var sigOneWord = isNum(bars[t].o) && bars[t].o === bars[t].h &&
    bars[t].h === bars[t].l && bars[t].l === bars[t].c &&
    t > 0 && bars[t - 1].c > 0 &&
    (bars[t].c / bars[t - 1].c - 1) * 100 >= limPct - 0.5;
  var entry = null, hitDay = 0, oneWordSeen = false;
  for (var dt = 1; dt <= 3; dt++) {
    var b = bars[t + dt], prev = bars[t + dt - 1];
    if (!b || !prev || !(prev.c > 0) || !(b.c > 0)) continue;
    var chg = (b.c / prev.c - 1) * 100;
    var v5 = 0, n = 0;
    for (var q = Math.max(0, t + dt - 5); q < t + dt; q++) { if (isNum(bars[q].v)) { v5 += bars[q].v; n++; } }
    var avgV = n ? v5 / n : null;
    var volOk = isNum(b.v) && isNum(avgV) && avgV > 0 ? (b.v / avgV >= 1.3) : null;
    var oneWord = isNum(b.o) && b.o === b.h && b.h === b.l && b.l === b.c && chg >= limPct - 0.5;
    if (oneWord) { oneWordSeen = true; continue; }   // 一字板：买不进，跳过
    var breakout = chg >= limPct * 0.6 && volOk === true;      // 放量突破（量缺则不判）
    var limitUp = chg >= limPct - 0.5;                          // 非一字涨停
    if (breakout || limitUp) {
      entry = b.c;
      // 封板收盘买不进 → 取次日开盘（若有）
      if (limitUp && bars[t + dt + 1] && isNum(bars[t + dt + 1].o)) entry = bars[t + dt + 1].o;
      hitDay = dt;
      break;
    }
  }
  var end = bars[t + 3];
  if (!entry || !end || !(end.c > 0) || !(entry > 0)) {
    return { hit: false, day: 0, entry: null, entrySrc: null, ret3: null,
      sigRet3: sigRet3, sigOneWord: sigOneWord, oneWordSeen: oneWordSeen };
  }
  return {
    hit: true, day: hitDay, entry: +entry.toFixed(3),
    entrySrc: (hitDay && bars[t + hitDay] && Math.abs(entry - bars[t + hitDay].c) < 0.005) ? '启动日收盘' : '次日开盘',
    ret3: +((end.c / entry - 1) * 100).toFixed(3),
    sigRet3: sigRet3, sigOneWord: sigOneWord, oneWordSeen: oneWordSeen
  };
}

function loadKlineUniverse() {
  var idxPath = path.join(KLINE_DIR, 'index.json');
  if (!fs.existsSync(idxPath)) throw new Error('缺少 kline/index.json，请先跑 tools/build_kline.py');
  var idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  var byShard = {};
  Object.keys(idx.map || {}).forEach(function (code) {
    var s = idx.map[code];
    (byShard[s] = byShard[s] || []).push(code);
  });
  var bars = {};
  Object.keys(byShard).forEach(function (s) {
    var p = path.join(KLINE_DIR, 's' + s + '.json');
    if (!fs.existsSync(p)) return;
    var j = JSON.parse(fs.readFileSync(p, 'utf8'));
    byShard[s].forEach(function (code) {
      if (j.codes && j.codes[code]) bars[code] = decodeKline(j.codes[code]);
    });
  });
  return { bars: bars, asOf: idx.asOf || '' };
}
function loadMeta() {
  var out = {};
  try {
    var s = fs.readFileSync(DATAJS, 'utf8');
    var d = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    (d.rows || []).forEach(function (r) {
      // 白名单：只保留 data.js 里真实存在的个股/ETF，剔除 kline 里混入的指数（如 000001.SH）
      if (r.kind !== 'stock' && r.kind !== 'etf') return;
      out[r.code] = { name: r.name, ind: r.ind || r.indL2 || '', kind: r.kind, isEtf: r.kind === 'etf' };
    });
  } catch (e) { console.log('  [警告] data.js 元数据读取失败：' + e.message); }
  return out;
}

/* 截面行业相对强度：按 (date, ind) 聚合同日 ret10/ret20 中位数。
   两遍法：第一遍收集各票每日 ret，第二遍生成面板时回填。只覆盖个股（ETF 无行业）。 */
function buildIndustryRS(uni, meta) {
  var bucket = {};
  Object.keys(uni.bars).forEach(function (code) {
    var m = meta[code];
    if (!m || !m.ind || m.isEtf) return;
    var bars = uni.bars[code];
    var closes = bars.map(function (b) { return b.c; });
    for (var t = 60; t + 3 < bars.length; t++) {
      var d = bars[t].d;
      var r10 = FEAT.ret(closes, t, 10);
      var r20 = FEAT.ret(closes, t, 20);
      if (r10 == null && r20 == null) continue;
      var k = d + '|' + m.ind;
      var b2 = bucket[k] = bucket[k] || { r10: [], r20: [] };
      if (r10 != null) b2.r10.push(r10);
      if (r20 != null) b2.r20.push(r20);
    }
  });
  // 只保留中位数，释放原始数组
  Object.keys(bucket).forEach(function (k) {
    var b = bucket[k];
    function med(a) { if (!a.length) return null; a.sort(function (x, y) { return x - y; }); return a[Math.floor(a.length / 2)]; }
    bucket[k] = { r10: med(b.r10), r20: med(b.r20) };
  });
  return bucket;
}

function build(opts) {
  opts = opts || {};
  var uni = loadKlineUniverse(), meta = loadMeta();
  // 白名单过滤：kline 里的指数不在 data.js 中，直接剔除（否则 000001.SH 会混进个股样本）
  Object.keys(uni.bars).forEach(function (code) { if (!meta[code]) delete uni.bars[code]; });
  var codes = Object.keys(uni.bars);
  var indRS = buildIndustryRS(uni, meta);
  var gaps = { asOf: uni.asOf, totalCodes: codes.length, shortHistory: 0, noVolume: 0, noIndustry: 0, stSkipped: 0, samples: 0, hits: 0, oneWordSkipped: 0 };
  var WARM = 60, TAIL = 3;
  // 108 万行一次性 join 会超 V8 字符串上限（~512MB），改流式写入
  if (!opts.check) fs.mkdirSync(OUT_DIR, { recursive: true });
  var stream = opts.check ? null : fs.createWriteStream(PANEL_OUT, { encoding: 'utf8' });
  function emit(line) { if (stream) stream.write(line + '\n'); }

  codes.forEach(function (code) {
    var bars = uni.bars[code];
    if (!bars || bars.length < WARM + TAIL + 1) { gaps.shortHistory++; return; }
    var m = meta[code] || {};
    if (/ST|退|\*/.test(String(m.name || ''))) { gaps.stSkipped++; return; }
    if (!bars.some(function (b) { return isNum(b.v); })) gaps.noVolume++;
    if (!m.ind) gaps.noIndustry++;
    var lim = limitOf(code);
    // 行业相对强度：同 ind 的 ret20 中位数（用当日全市场快照按行业分组近似；历史逐日行业中位数成本过高，
    // 这里用 meta 里 ind 分组 + 每只票自身 ret20 的截面中位数，panel 生成时一次性算好）
    var closesAll = bars.map(function (b) { return b.c; });
    for (var t = WARM; t + TAIL < bars.length; t++) {
      var d = bars[t].d;
      var rs = m.ind ? indRS[d + '|' + m.ind] : null;
      var ctx = { limitPct: lim,
        industryRet10: (rs && isNum(rs.r10)) ? rs.r10 : null,
        industryRet20: (rs && isNum(rs.r20)) ? rs.r20 : null };
      var f = FEAT.compute(bars, ctx, t);
      var lab = labelOf(bars, t, lim);
      if (!lab) continue;
      // 特征降精度（保留 3 位）以压缩文件：108 万行原始写满精度达 594MB
      Object.keys(f).forEach(function (k) {
        if (isNum(f[k])) f[k] = +f[k].toFixed(3);
      });
      var row = {
        code: code, date: d, ind: m.ind || '', kind: kindOf(code),
        isEtf: !!m.isEtf, lim: lim, f: f, y: lab
      };
      emit(JSON.stringify(row));
      gaps.samples++;
      if (lab.hit) gaps.hits++;
      if (lab.oneWordSeen) gaps.oneWordSkipped++;
    }
  });

  if (!opts.check) {
    stream.end();   // 异步 flush；面板很大，交给进程退出前自然写完
    gaps.hitRate = gaps.samples ? +(gaps.hits / gaps.samples * 100).toFixed(2) : null;
    fs.writeFileSync(GAP_OUT, JSON.stringify(gaps, null, 2) + '\n');
  }
  return gaps;
}

function main() {
  var check = process.argv.indexOf('--check') >= 0;
  var t0 = Date.now();
  var g = build({ check: check });
  console.log('[panel] %s | 代码 %d · 样本 %d · 命中 %d (%s%%) · 一字板跳过 %d',
    check ? '检查' : '生成', g.totalCodes, g.samples, g.hits, g.hitRate == null ? '—' : g.hitRate, g.oneWordSkipped);
  console.log('[panel] 缺口：短历史 %d · 无量 %d · 无行业 %d · ST剔除 %d · 耗时 %ds',
    g.shortHistory, g.noVolume, g.noIndustry, g.stSkipped, Math.round((Date.now() - t0) / 1000));
  if (!check) console.log('[panel] 已写入 %s 与 %s', PANEL_OUT, GAP_OUT);
}
if (require.main === module) main();
module.exports = { build: build, decodeKline: decodeKline, labelOf: labelOf, limitOf: limitOf, kindOf: kindOf };
