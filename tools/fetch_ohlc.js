// 拉全市场 11 年 OHLC 后复权数据，供缠论分型/笔/中枢使用。
// 输出：ohlc.json.gz  { code: [[date, open, close, high, low], ...] }
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.dirname(__dirname);
const CONC = parseInt(process.argv[2] || '10', 10);
const BEG = '20150101', END = '20261231';

const raw = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8')
  .replace(/^\ufeff/, '').replace(/window\.AB_DATA\s*=/, 'global.__D =');
(0, eval)(raw);
const codes = (global.__D.rows || []).map(function (r) { return r.code; })
  .filter(function (c) { return /^\d{6}\.(SH|SZ)$/.test(c); });

function secid(code) {
  return (code.endsWith('.SH') ? '1.' : '0.') + code.slice(0, 6);
}

// 东财后复权日K（历史最深，正常首选）。云端 runner 出口 IP 常被东财限流返回空，
// 所以失败要走下面的腾讯备用源，不能让个股池清零。
async function fromEastmoney(code) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
    + '?secid=' + secid(code) + '&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55'
    + '&klt=101&fqt=2&beg=' + BEG + '&end=' + END;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' } });
  if (!r.ok) return null;
  const j = await r.json();
  const kl = (j.data && j.data.klines) || [];
  if (!kl.length) return null;
  return kl.map(function (x) {
    const p = x.split(',');
    return [p[0], parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3]), parseFloat(p[4])];
  });
}

// 腾讯前复权日K备用源：单次最多 640 根，按年份分段拼接还原长历史。
// 每段的 end 固定为上一段首日的前一天，往前滚，直到拿不到更多或到 BEG。
function txSymbol(code) {
  return (code.endsWith('.SH') ? 'sh' : 'sz') + code.slice(0, 6);
}
async function fromTencent(code) {
  const sym = txSymbol(code);
  const segs = [];
  let end = END.slice(0, 4) + '-' + END.slice(4, 6) + '-' + END.slice(6, 8); // YYYY-MM-DD
  const begMin = BEG.slice(0, 4) + '-' + BEG.slice(4, 6) + '-' + BEG.slice(6, 8);
  for (let pass = 0; pass < 8; pass++) {
    const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
      + '?param=' + sym + ',day,' + begMin + ',' + end + ',640,qfq';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) break;
    const j = await r.json();
    const d = (j.data || {})[sym] || {};
    const kl = d.qfqday || d.day || [];
    if (!kl.length) break;
    const rows = kl.map(function (x) {
      return [x[0], parseFloat(x[1]), parseFloat(x[2]), parseFloat(x[3]), parseFloat(x[4])];
    }).filter(function (b) { return b[0] && b[2] > 0; });
    segs.unshift(rows);
    const first = rows[0][0];
    if (first <= begMin || rows.length < 640) break;
    const dt = new Date(first + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() - 1);
    end = dt.toISOString().slice(0, 10);
  }
  // 拼接并按日期去重（段间可能重叠）
  const seen = {}, out = [];
  segs.forEach(function (rows) {
    rows.forEach(function (b) { if (!seen[b[0]]) { seen[b[0]] = 1; out.push(b); } });
  });
  out.sort(function (a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); });
  return out;
}

async function one(code) {
  try {
    const b = await fromEastmoney(code);
    if (b && b.length > 200) return b;
  } catch (e) { }
  // 东财被限流/返回空 → 腾讯前复权兜底（单只票内部口径一致即可算缠论形态）
  try {
    const b = await fromTencent(code);
    if (b && b.length > 200) return b;
  } catch (e) { }
  return null;
}

(async function () {
  console.log('标的 %d 只，并发 %d', codes.length, CONC);
  const bars = {};
  let idx = 0, done = 0, ok = 0;
  const t0 = Date.now();
  async function worker() {
    while (idx < codes.length) {
      const c = codes[idx++];
      try {
        const b = await one(c);
        if (b && b.length > 200) { bars[c] = b; ok++; }
      } catch (e) { }
      done++;
      if (done % 500 === 0) console.log('  %d/%d · %.0fs', done, codes.length, (Date.now() - t0) / 1000);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  // asOf 必须是「数据里最后一根 K 线的日期」，不能用 new Date()：
  // 周末/假期跑会写成一个非交易日，导致 chan_pick 的 lastBar!==ASOF 判定把所有票都当陈旧剔掉
  let maxD = '';
  Object.keys(bars).forEach(function (c) {
    const b = bars[c];
    if (b && b.length) { const d = b[b.length - 1][0]; if (d > maxD) maxD = d; }
  });
  const out = { asOf: maxD || new Date().toISOString().slice(0, 10), count: Object.keys(bars).length, bars: bars };
  const json = JSON.stringify(out);
  fs.writeFileSync(path.join(ROOT, 'ohlc.json.gz'), zlib.gzipSync(Buffer.from(json), { level: 9 }));
  console.log('完成 %d 只 · 原始 %.0fMB · gz %.0fMB · %.1f 分钟',
    out.count, json.length / 1048576, fs.statSync(path.join(ROOT, 'ohlc.json.gz')).size / 1048576,
    (Date.now() - t0) / 60000);
})();
