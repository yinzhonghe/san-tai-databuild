// 拉取全市场 2 年前复权日 K，供胜率回测使用。
// 输出：hist.json.gz（{ asOf, bars: { "600519.SH": [[date, close], ...] } }）
// 用法：node tools/fetch_hist.js [并发数]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.dirname(__dirname);
const CONC = parseInt(process.argv[2] || '8', 10);
const BEG = '20150101';
const END = '20261231';

function loadCodes() {
  const s = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8')
    .replace(/^\ufeff/, '')
    .replace(/window\.AB_DATA\s*=/, 'global.__D =');

  (0, eval)(s);
  const D = global.__D;
  const out = [];
  (D.rows || []).forEach(function (r) {
    if (r.code && /^\d{6}\.(SH|SZ|BJ)$/.test(r.code)) out.push(r.code);
  });
  return out;
}

function secid(code) {
  const m = code.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  const mk = m[2] === 'SH' ? '1' : '0';
  return mk + '.' + m[1];
}

async function one(code) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
    + '?secid=' + secid(code) + '&fields1=f1,f2,f3&fields2=f51,f53'
    + '&klt=101&fqt=1&beg=fqt=2&beg=' + BEG + '&end=' + END;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' } });
  if (!r.ok) return null;
  const j = await r.json();
  const kl = (j.data && j.data.klines) || [];
  if (!kl.length) return null;
  return kl.map(function (x) {
    const p = x.split(',');
    return [p[0], parseFloat(p[1])];
  });
}

(async function main() {
  const codes = loadCodes();
  console.log('标的数：%d，并发 %d', codes.length, CONC);
  const bars = {};
  let done = 0, ok = 0, fail = 0;
  const t0 = Date.now();

  let idx = 0;
  async function worker() {
    while (idx < codes.length) {
      const code = codes[idx++];
      try {
        const b = await one(code);
        if (b && b.length > 200) { bars[code] = b; ok++; } else fail++;
      } catch (e) { fail++; }
      done++;
      if (done % 200 === 0) {
        const el = (Date.now() - t0) / 1000;
        console.log('  %d/%d 成功 %d 失败 %d · %.0fs', done, codes.length, ok, fail, el);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  const out = { asOf: new Date().toISOString().slice(0, 10), count: Object.keys(bars).length, bars: bars };
  const json = JSON.stringify(out);
  fs.writeFileSync(path.join(ROOT, 'hist.json.gz'), zlib.gzipSync(Buffer.from(json), { level: 9 }));
  console.log('完成：%d 只 · 原始 %.1fMB · gz %.1fMB · 用时 %.1f 分钟',
    out.count, json.length / 1048576, fs.statSync(path.join(ROOT, 'hist.json.gz')).size / 1048576,
    (Date.now() - t0) / 60000);
})();
