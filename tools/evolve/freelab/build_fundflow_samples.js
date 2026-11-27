/*
 * tools/evolve/freelab/build_fundflow_samples.js
 * ================================================
 * 把真实历史资金流按 (code,date) join 进训练样本，让资金流特征进入
 * 【验证结算闭环】——不只是给大模型看画像，而是让资金流假设能被真金白银验证。
 *
 * 输入：panel_sample100k.jsonl / panel.jsonl + 三源资金流（批量/ETF/逐票）
 * 输出：panel_sample100k_ff.jsonl / panel_ff.jsonl（f 字段注入 4 个资金流特征）
 *       — 仅在 f 上追加 main5/superRatio5/accel/mainPctT，其余字段原样保留。
 * 红线：join 不到就不写该字段（fail-closed），不填 0、不估算；用哪个样本由
 *       EVOLVE_PANEL=full / panelPath 显式切换，默认样本不污染生产链。
 *
 * 用法：node tools/evolve/freelab/build_fundflow_samples.js [--full]
 */
'use strict';
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var ROOT = path.dirname(path.dirname(path.dirname(__dirname)));
var EVO = path.join(ROOT, 'learn', 'evolve');
var FUND = path.join(EVO, 'fundflow_hist.jsonl');
var FUND_BATCH = path.join(EVO, 'fundflow_batch.jsonl.gz');
var FUND_ETF = path.join(EVO, 'fundflow_etf.jsonl');
var STATUS = path.join(EVO, 'freelab', 'fundflow_sample_status.json');

function num(v) { return typeof v === 'number' && isFinite(v); }

function absorb(map, line) {
  if (!line.trim()) return;
  var o; try { o = JSON.parse(line); } catch (e) { return; }
  if (!o || !o.code) return;
  var byDate = map[o.code] || (map[o.code] = {});
  (o.rows || []).forEach(function (row) { if (row && row[0]) byDate[row[0]] = row; });
}

function loadFundflow() {
  var map = {};
  if (fs.existsSync(FUND_BATCH)) {
    try {
      var txt = zlib.gunzipSync(fs.readFileSync(FUND_BATCH)).toString('utf8');
      txt.split('\n').forEach(function (line) { absorb(map, line); });
    } catch (e) { console.error('[warn] 批量资金流 gz 读取失败，退回逐票源'); }
  }
  if (fs.existsSync(FUND_ETF)) fs.readFileSync(FUND_ETF, 'utf8').split('\n').forEach(function (l) { absorb(map, l); });
  if (fs.existsSync(FUND)) fs.readFileSync(FUND, 'utf8').split('\n').forEach(function (l) { absorb(map, l); });
  return map;
}

/* 派生 T 日可观测资金流特征；只用 date <= T 的行。缺数据返回 null。 */
function derive(codeMap, code, date) {
  var byDate = codeMap[code];
  if (!byDate) return null;
  var dates = Object.keys(byDate).sort();
  var idx = dates.indexOf(date);
  if (idx < 0 || idx < 10) return null;
  var win5 = dates.slice(idx - 4, idx + 1).map(function (d) { return byDate[d]; });
  var win5prev = dates.slice(idx - 9, idx - 4).map(function (d) { return byDate[d]; });
  function sumField(rows, i) {
    var vals = rows.map(function (x) { return x[i]; }).filter(num);
    return vals.length === rows.length ? vals.reduce(function (a, b) { return a + b; }, 0) : null;
  }
  var main5 = sumField(win5, 1), main5prev = sumField(win5prev, 1), super5 = sumField(win5, 2);
  var pctT = byDate[date][6];
  var superRatio5 = (num(super5) && num(main5) && Math.abs(main5) > 1e-6) ? super5 / Math.abs(main5) : null;
  var accel = (num(main5) && num(main5prev)) ? main5 - main5prev : null;
  return { main5: main5, superRatio5: superRatio5, accel: accel, mainPctT: pctT };
}

function buildOne(inPath, outPath, map) {
  return new Promise(function (resolve, reject) {
    var rows = 0, joined = 0;
    var rl = require('readline').createInterface({ input: fs.createReadStream(inPath, { encoding: 'utf8' }), crlfDelay: Infinity });
    var ws = fs.createWriteStream(outPath, { encoding: 'utf8' });
    rl.on('line', function (line) {
      if (!line.trim()) return;
      var s; try { s = JSON.parse(line); } catch (e) { return; }
      rows++;
      var ff = derive(map, s.code, s.date);
      if (ff) {
        s.f = s.f || {};
        Object.keys(ff).forEach(function (k) { if (num(ff[k])) s.f[k] = +ff[k].toFixed(4); });
        joined++;
      }
      ws.write(JSON.stringify(s) + '\n');
    });
    rl.on('close', function () { ws.end(function () { resolve({ rows: rows, joined: joined, out: outPath }); }); });
    rl.on('error', reject);
  });
}

function main() {
  var full = process.argv.indexOf('--full') >= 0;
  var map = loadFundflow();
  var codes = Object.keys(map).length;
  console.log('[ff-samples] 资金流覆盖 ' + codes + ' 票');
  var jobs = [
    { in: path.join(EVO, 'panel_sample100k.jsonl'), out: path.join(EVO, 'panel_sample100k_ff.jsonl') }
  ];
  if (full) jobs.push({ in: path.join(EVO, 'panel.jsonl'), out: path.join(EVO, 'panel_ff.jsonl') });
  var chain = Promise.resolve();
  var results = [];
  jobs.forEach(function (j) {
    chain = chain.then(function () { return buildOne(j.in, j.out, map); }).then(function (r) { results.push(r); });
  });
  chain.then(function () {
    var st = { generatedAt: new Date().toISOString(), fundflowCodes: codes, features: ['main5', 'superRatio5', 'accel', 'mainPctT'], jobs: results,
      note: 'join 不到不写字段（fail-closed），不填0不估算。样本切换由 tools/evolve/settle.js panelPath() 控制。' };
    fs.writeFileSync(STATUS, JSON.stringify(st, null, 2), 'utf8');
    results.forEach(function (r) { console.log('[ff-samples] ' + path.basename(r.out) + ': join ' + r.joined + '/' + r.rows + ' (' + (r.joined / Math.max(1, r.rows) * 100).toFixed(1) + '%)'); });
  }).catch(function (e) { console.error('[ff-samples] 失败: ' + e.message); process.exitCode = 1; });
}
main();
