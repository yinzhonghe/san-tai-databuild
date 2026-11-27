/*
 * tools/evolve/freelab/fundflow_portrait.js · 资金流维度市场画像
 * =================================================================
 * 把真实抓取的【历史逐日资金流】按 (code, date) join 到 panel 样本，
 * 派生出信号日 T 可观测的资金流特征（无未来函数），逐档算真实净收益。
 * 这是自由推演实验室的新维度原料——让大模型能读「主力资金在做什么」。
 *
 * 红线：
 *   - 只用真实抓取的资金流；join 不到的一律标缺口，不填 0、不估算。
 *   - 资金流行为信号日 T 及之前的数据，绝不用 T+1..T+3（避免未来函数）。
 *   - 不改 constitution / population / heartbeat。
 *
 * 输入：learn/evolve/fundflow_batch.jsonl.gz（fetch_fundflow_batch.py 批量全市场，主力）
 *       learn/evolve/fundflow_hist.jsonl（fetch_fundflow_hist.py 逐票，ETF 补抓）
 *       learn/evolve/panel_sample100k.jsonl
 * 输出：learn/evolve/freelab/fundflow_portrait.json
 * 用法：node tools/evolve/freelab/fundflow_portrait.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var ROOT = path.dirname(path.dirname(path.dirname(__dirname)));
var EVO = path.join(ROOT, 'learn', 'evolve');
var LAB = path.join(EVO, 'freelab');
var FUND = path.join(EVO, 'fundflow_hist.jsonl');
var FUND_BATCH = path.join(EVO, 'fundflow_batch.jsonl.gz');
var FUND_STATUS = path.join(EVO, 'fundflow_status.json');
var FUND_BATCH_STATUS = path.join(EVO, 'fundflow_batch_status.json');
var SAMPLE = path.join(EVO, 'panel_sample100k.jsonl');
var CONST = path.join(EVO, 'constitution.json');
var OUT = path.join(LAB, 'fundflow_portrait.json');

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function loadJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function avg(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
function r(v, d) { return isNum(v) ? +v.toFixed(d == null ? 4 : d) : null; }

/* 资金流行字段索引（与 fetch_fundflow_hist.py 一致）：
   0 date, 1 mainWan, 2 superWan, 3 bigWan, 4 midWan, 5 smallWan,
   6 mainPct, 7 close, 8 chg */
function absorb(map, line) {
  if (!line.trim()) return;
  var o; try { o = JSON.parse(line); } catch (e) { return; }
  var byDate = map[o.code] || (map[o.code] = {});
  (o.rows || []).forEach(function (row) { byDate[row[0]] = row; });
}

function loadFundflow() {
  var map = {};
  // ① 批量全市场（个股 + 北交所）：datacenter-web 不同 WAF，不受 push2his 封禁影响
  if (fs.existsSync(FUND_BATCH)) {
    try {
      var txt = zlib.gunzipSync(fs.readFileSync(FUND_BATCH)).toString('utf8');
      txt.split('\n').forEach(function (line) { absorb(map, line); });
    } catch (e) { /* 批量文件损坏 → 退回逐票数据，标缺口 */ }
  }
  // ② 逐票补抓（ETF）：批量报表不含 ETF，这部分由 push2his 云端补
  if (fs.existsSync(FUND)) {
    fs.readFileSync(FUND, 'utf8').split('\n').forEach(function (line) { absorb(map, line); });
  }
  return map;
}

/* 派生 T 日可观测特征：只用 date <= T 的资金流行。 */
function derive(codeMap, code, date) {
  var byDate = codeMap[code];
  if (!byDate) return null;
  var dates = Object.keys(byDate).sort();
  var idx = dates.indexOf(date);
  if (idx < 0) return null;              // T 日无资金流数据 → 缺口
  if (idx < 10) return null;             // 历史不足，无法算 5/10 日
  var win5 = dates.slice(idx - 4, idx + 1).map(function (d) { return byDate[d]; });
  var win5prev = dates.slice(idx - 9, idx - 4).map(function (d) { return byDate[d]; });
  function sumField(rows, i) {
    var vals = rows.map(function (x) { return x[i]; }).filter(isNum);
    return vals.length === rows.length ? vals.reduce(function (a, b) { return a + b; }, 0) : null;
  }
  var main5 = sumField(win5, 1);
  var main5prev = sumField(win5prev, 1);
  var super5 = sumField(win5, 2);
  var pctT = byDate[date][6];
  // 资金结构：超大单占主力比（主力为0时留空，不除零）
  var superRatio5 = (isNum(super5) && isNum(main5) && Math.abs(main5) > 1e-6)
    ? super5 / Math.abs(main5) : null;
  // 资金加速度：近5日 - 前5日主力净流入（万元）
  var accel = (isNum(main5) && isNum(main5prev)) ? main5 - main5prev : null;
  return { main5: main5, superRatio5: superRatio5, accel: accel, mainPctT: pctT };
}

function bucketize(pairs, nBuckets, baseNet) {
  var valid = pairs.filter(function (p) { return isNum(p.v); }).sort(function (a, b) { return a.v - b.v; });
  if (valid.length < nBuckets * 20) return [];   // 样本太少不出档，避免噪声
  var out = [];
  for (var b = 0; b < nBuckets; b++) {
    var sl = valid.slice(Math.floor(valid.length * b / nBuckets), Math.floor(valid.length * (b + 1) / nBuckets));
    if (!sl.length) continue;
    var nets = sl.map(function (p) { return p.net; }).filter(isNum);
    out.push({
      bucket: (b + 1) + '/' + nBuckets,
      lo: r(sl[0].v, 2), hi: r(sl[sl.length - 1].v, 2), n: sl.length,
      net: r(avg(nets)), winRate: nets.length ? r(nets.filter(function (x) { return x > 0; }).length / nets.length) : null,
      excess: (isNum(baseNet) && nets.length) ? r(avg(nets) - baseNet) : null
    });
  }
  return out;
}

function build() {
  var cons = loadJSON(CONST, {});
  var cost = (cons.costModel && cons.costModel.totalRoundTripPct) || 0.31;
  var fundStatus = loadJSON(FUND_STATUS, {});
  var batchStatus = loadJSON(FUND_BATCH_STATUS, {});
  var codeMap = loadFundflow();
  var keys = ['main5', 'superRatio5', 'accel', 'mainPctT'];
  var labels = { main5: '近5日主力净流入(万元)', superRatio5: '超大单占主力比', accel: '主力资金加速度(万元)', mainPctT: '当日主力净占比(%)' };
  var byFeature = {}; keys.forEach(function (k) { byFeature[k] = []; });

  var rows = 0, joined = 0, skippedOneWord = 0, skippedNoData = 0;
  var netSum = 0, netN = 0, wins = 0;
  var src = path.join(EVO, 'panel_sample100k.jsonl');
  var lines = fs.readFileSync(src, 'utf8').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line.trim()) continue;
    var s; try { s = JSON.parse(line); } catch (e) { continue; }
    rows++;
    if (s.y && s.y.sigOneWord) { skippedOneWord++; continue; }
    if (!s.y || !isNum(s.y.sigRet3)) { skippedNoData++; continue; }
    var net = s.y.sigRet3 - cost;
    var d = derive(codeMap, s.code, s.date);
    if (!d) continue;                    // 无资金流数据 → 标缺口，这条不进画像
    joined++;
    netSum += net; netN++; if (net > 0) wins++;
    keys.forEach(function (k) { if (isNum(d[k])) byFeature[k].push({ v: d[k], net: net }); });
  }

  var realNet = netN ? r(netSum / netN) : null;
  var features = {};
  keys.forEach(function (k) {
    var buckets = bucketize(byFeature[k], 5, realNet);
    var best = null, worst = null;
    if (buckets.length) {
      best = buckets.reduce(function (a, b) { return (b.net == null || (a.net != null && a.net >= b.net)) ? a : b; });
      worst = buckets.reduce(function (a, b) { return (b.net == null || (a.net != null && a.net <= b.net)) ? a : b; });
    }
    features[k] = {
      label: labels[k], buckets: buckets,
      coverage: r(byFeature[k].length / Math.max(1, rows - skippedOneWord - skippedNoData)),
      bestBucket: best && best.bucket, bestNet: best && best.net,
      worstBucket: worst && worst.bucket, worstNet: worst && worst.net,
      spread: (best && worst && isNum(best.net) && isNum(worst.net)) ? r(best.net - worst.net) : null
    };
  });

  var out = {
    generatedAt: new Date().toISOString(),
    source: 'eastmoney datacenter RPT_DMSK_TS_FUNDFLOW(全市场批量) + fflow/daykline(ETF逐票)',
    fetchedCodes: Object.keys(codeMap).length,
    fundStatus: {
      fetchedCodes: fundStatus.fetchedCodes || 0,
      coveragePct: fundStatus.coveragePct || 0,
      unsupportedCodes: fundStatus.unsupportedCodes || 0,
      unsupportedReason: fundStatus.unsupportedReason || '',
      failedCodes: fundStatus.failedCodes || 0
    },
    batchStatus: {
      source: batchStatus.source || null,
      mergedCodes: batchStatus.mergedCodes || 0,
      stockCoveragePct: batchStatus.stockCoveragePct || 0,
      bjCodes: batchStatus.bjCodes || 0,
      bjCovered: batchStatus.bjCovered || 0,
      etfGapRows: batchStatus.etfGapRows || 0,
      window: batchStatus.window || null
    },
    panelRows: rows, joinedRows: joined,
    joinRate: r(joined / Math.max(1, rows), 4),
    baseline: { measuredNet: realNet, measuredWinRate: netN ? r(wins / netN) : null, samples: netN, costPct: cost },
    features: features,
    gaps: {
      note: '个股/北交所走 datacenter 批量报表（不同WAF，不受push2his限流）；ETF 走 push2his 云端逐票补抓。缺口保留为空，不填 0、不估算。'
    }
  };
  fs.mkdirSync(LAB, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  return out;
}

function main() {
  var o = build();
  console.log('[fundflow-portrait] 抓到 ' + o.fetchedCodes + ' 票 · join ' + o.joinedRows + '/' + o.panelRows +
    ' 样本(' + (o.joinRate * 100).toFixed(1) + '%) · 画像净收益 ' + o.baseline.measuredNet + '%');
  console.log('[fundflow-portrait] 特征 %d 个: %s',
    Object.keys(o.features).length,
    Object.keys(o.features).map(function (k) { return k + '(cov ' + (o.features[k].coverage * 100).toFixed(1) + '%)'; }).join(' '));
  console.log('[fundflow-portrait] 已写入 %s', OUT);
}
if (require.main === module) main();
module.exports = { build: build, derive: derive, bucketize: bucketize };
