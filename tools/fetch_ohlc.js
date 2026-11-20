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

async function one(code) {
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
  const out = { asOf: new Date().toISOString().slice(0, 10), count: Object.keys(bars).length, bars: bars };
  const json = JSON.stringify(out);
  fs.writeFileSync(path.join(ROOT, 'ohlc.json.gz'), zlib.gzipSync(Buffer.from(json), { level: 9 }));
  console.log('完成 %d 只 · 原始 %.0fMB · gz %.0fMB · %.1f 分钟',
    out.count, json.length / 1048576, fs.statSync(path.join(ROOT, 'ohlc.json.gz')).size / 1048576,
    (Date.now() - t0) / 60000);
})();
