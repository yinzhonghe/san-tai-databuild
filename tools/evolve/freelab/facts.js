/*
 * tools/evolve/freelab/facts.js · 自由推演实验室 · 市场画像生成器
 * =================================================================
 * 这个模块与 v2 证据包自进化【平行且独立】：
 *   - v2：六派种子 → 受限草图 → kernel 硬裁判（戴着镣铐进化）
 *   - 本模块：把真实样本整理成「市场画像」，喂给大模型【自由推演】，
 *     让它自己提出任意模型假设，再看能不能用真实数据跑出钱。
 *
 * 红线（继承全项目）：
 *   - 只用真实样本算画像，缺数据标缺口，绝不拿 0/估算顶替（fail-closed）。
 *   - 不改 constitution.json（封印锚点）、不写 population/heartbeat。
 *   - 画像里的净收益 = 信号级 sigRet3 - 往返成本，一字板剔除。
 *
 * 产物：learn/evolve/freelab/facts.json
 * 用法：node tools/evolve/freelab/facts.js [--full]
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.dirname(path.dirname(path.dirname(__dirname))); // tools/evolve/freelab -> 项目根
var EVO = path.join(ROOT, 'learn', 'evolve');
var LAB = path.join(EVO, 'freelab');
var SAMPLE = path.join(EVO, 'panel_sample100k.jsonl');
var FULL = path.join(EVO, 'panel.jsonl');
var CONST = path.join(EVO, 'constitution.json');
var GAPS = path.join(EVO, 'panel_gaps.json');
var FUND_PORTRAIT = path.join(LAB, 'fundflow_portrait.json');
var OUT = path.join(LAB, 'facts.json');

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function loadJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function median(a) {
  if (!a.length) return null;
  var s = a.slice().sort(function (x, y) { return x - y; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function avg(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
function r(v, d) { return isNum(v) ? +v.toFixed(d == null ? 3 : d) : null; }
function todayCN() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }

/* 把一列 {v,net} 切成 nBuckets 个分位档，逐档算真实净收益。
   每个档返回区间 [lo,hi]、样本数、平均净收益、胜率、相对基线的超额。 */
function bucketize(pairs, nBuckets, baseNet) {
  var valid = pairs.filter(function (p) { return isNum(p.v); })
    .sort(function (a, b) { return a.v - b.v; });
  if (!valid.length) return [];
  var out = [];
  for (var b = 0; b < nBuckets; b++) {
    var i0 = Math.floor(valid.length * b / nBuckets);
    var i1 = Math.floor(valid.length * (b + 1) / nBuckets);
    var slice = valid.slice(i0, i1);
    if (!slice.length) continue;
    var nets = slice.map(function (p) { return p.net; }).filter(isNum);
    var wins = nets.filter(function (x) { return x > 0; }).length;
    out.push({
      bucket: (b + 1) + '/' + nBuckets,
      lo: r(slice[0].v, 4), hi: r(slice[slice.length - 1].v, 4),
      n: slice.length,
      net: r(avg(nets), 4),
      winRate: nets.length ? r(wins / nets.length, 4) : null,
      excess: (isNum(baseNet) && nets.length) ? r(avg(nets) - baseNet, 4) : null
    });
  }
  return out;
}

function build(useFull) {
  var cons = loadJSON(CONST, {});
  var gaps = loadJSON(GAPS, {});
  var cost = (cons.costModel && cons.costModel.totalRoundTripPct) || 0.31;
  var baseNet = (cons.baseline && cons.baseline.signalRet3) || null;
  var featMeta = require('../features.js').META;
  var featKeys = Object.keys(featMeta);

  // feature -> [{v,net}]；byMonth / byIndustry -> {sum,n,wins}
  var byFeature = {}; featKeys.forEach(function (k) { byFeature[k] = []; });
  var byMonth = {}, byIndustry = {};
  var rows = 0, tradable = 0, skippedOneWord = 0, skippedNoData = 0;
  var netSum = 0, netN = 0, wins = 0;
  var dates = [], firstDate = null, lastDate = null;

  var src = useFull && fs.existsSync(FULL) ? FULL : SAMPLE;
  var lines = fs.readFileSync(src, 'utf8').split('\n');
  for (var li = 0; li < lines.length; li++) {
    var line = lines[li];
    if (!line.trim()) continue;
    var s; try { s = JSON.parse(line); } catch (e) { continue; }
    rows++;
    if (s.date) {
      if (!firstDate || s.date < firstDate) firstDate = s.date;
      if (!lastDate || s.date > lastDate) lastDate = s.date;
    }
    if (s.y && s.y.sigOneWord) { skippedOneWord++; continue; }
    if (!s.y || !isNum(s.y.sigRet3)) { skippedNoData++; continue; }
    tradable++;
    var net = s.y.sigRet3 - cost;
    netSum += net; netN++; if (net > 0) wins++;
    var f = s.f || {};
    for (var k = 0; k < featKeys.length; k++) {
      var key = featKeys[k];
      if (isNum(f[key])) byFeature[key].push({ v: f[key], net: net });
    }
    if (s.date) {
      var mo = s.date.slice(0, 7);
      var g = byMonth[mo] || (byMonth[mo] = { sum: 0, n: 0, wins: 0 });
      g.sum += net; g.n++; if (net > 0) g.wins++;
    }
    if (s.ind) {
      var h = byIndustry[s.ind] || (byIndustry[s.ind] = { sum: 0, n: 0, wins: 0 });
      h.sum += net; h.n++; if (net > 0) h.wins++;
    }
  }

  var realNet = netN ? r(netSum / netN, 4) : null;
  var realWin = netN ? r(wins / netN, 4) : null;

  // 特征画像：每档真实净收益 + 最强/最弱档 + 全档极差（供模型发现「单调性/阈值」）
  var features = {};
  featKeys.forEach(function (k) {
    var buckets = bucketize(byFeature[k], 5, realNet);
    if (!buckets.length) { features[k] = { label: featMeta[k].label, buckets: [], note: '无有效样本' }; return; }
    var best = buckets.reduce(function (a, b) { return (b.net == null || (a.net != null && a.net >= b.net)) ? a : b; });
    var worst = buckets.reduce(function (a, b) { return (b.net == null || (a.net != null && a.net <= b.net)) ? a : b; });
    features[k] = {
      label: featMeta[k].label, formula: featMeta[k].formula, unit: featMeta[k].unit,
      coverage: r(byFeature[k].length / Math.max(1, tradable), 4),
      buckets: buckets,
      bestBucket: best.bucket, bestNet: best.net, worstBucket: worst.bucket, worstNet: worst.net,
      spread: (isNum(best.net) && isNum(worst.net)) ? r(best.net - worst.net, 4) : null
    };
  });

  // 按档聚合的月度 / 行业切片（只保留样本量够的，避免小样本噪声）
  var monthList = Object.keys(byMonth).map(function (mo) {
    var g = byMonth[mo];
    return { key: mo, n: g.n, net: r(g.sum / g.n, 4), winRate: r(g.wins / g.n, 4) };
  }).filter(function (x) { return x.n >= 200; });
  var industryList = Object.keys(byIndustry).map(function (ind) {
    var g = byIndustry[ind];
    return { key: ind, n: g.n, net: r(g.sum / g.n, 4), winRate: r(g.wins / g.n, 4) };
  }).filter(function (x) { return x.n >= 300; }).sort(function (a, b) { return b.net - a.net; });

  var facts = {
    generatedAt: new Date().toISOString(),
    generatedOn: todayCN(),
    source: path.basename(src),
    dataAsOf: gaps.asOf || '',
    usage: '自由推演实验室的市场画像原料：全部来自真实样本的信号级净收益（已扣' + r(cost, 2) + '%成本、一字板剔除）。缺数据标缺口，不估算。',
    baseline: {
      constitutionNet: baseNet,
      measuredNet: realNet, measuredWinRate: realWin,
      samples: rows, tradable: tradable, costPct: cost,
      skippedOneWord: skippedOneWord, skippedNoData: skippedNoData
    },
    window: { firstDate: firstDate, lastDate: lastDate },
    features: features,
    byMonth: monthList,
    byIndustry: industryList,
    // 资金流维度：真实抓取的历史逐日资金流 join panel 样本派生（独立产物，资金猎手补数）
    fundflow: loadJSON(FUND_PORTRAIT, null),
    gaps: {
      noIndustry: gaps.noIndustry || 0, shortHistory: gaps.shortHistory || 0,
      note: '行业/一字板历史等缺口由数据猎手补，取不到就标缺口，不得假设有值；' +
        '资金流维度见 fundflow 字段（真实抓取，未覆盖样本标缺口，不填0）'
    },
    sources: loadJSON(path.join(EVO, 'data_sources.json'), {})
  };

  fs.mkdirSync(LAB, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(facts, null, 2), 'utf8');
  return facts;
}

function main() {
  var useFull = process.argv.indexOf('--full') >= 0;
  var f = build(useFull);
  console.log('[freelab-facts] 源=%s 样本=%d 可交易=%d 真实净收益=%s%% 胜率=%s%%',
    f.source, f.baseline.samples, f.baseline.tradable, f.baseline.measuredNet, f.baseline.measuredWinRate);
  console.log('[freelab-facts] 特征 %d 个，月份切片 %d，行业切片 %d',
    Object.keys(f.features).length, f.byMonth.length, f.byIndustry.length);
  console.log('[freelab-facts] 已写入 %s', OUT);
}
if (require.main === module) main();
module.exports = { build: build, bucketize: bucketize };
