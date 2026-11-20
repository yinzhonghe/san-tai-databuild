// 拉 ETF 的 OHLC（新浪源，腾讯对ETF有WAF，东财不通）
// 新浪 datalen 最大 1023，够11年日K。输出合并到 ohlc.json.gz（标记 isETF）
// 用法：node tools/fetch_etf_ohlc.js [并发]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.dirname(__dirname);
const CONC = parseInt(process.argv[2] || '8', 10);
const picks = require(path.join(ROOT, '_etf_pick.json'));
const O = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'ohlc.json.gz'))).toString());
O.isETF = O.isETF || {};

function sinaSymbol(code) {
  return (code.endsWith('.SH') ? 'sh' : 'sz') + code.slice(0, 6);
}

async function one(code) {
  const sym = sinaSymbol(code);
  const url = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/'
    + 'CN_MarketData.getKLineData?symbol=' + sym + '&scale=240&ma=no&datalen=1023';
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const txt = await r.text();
  let arr;
  try { arr = JSON.parse(txt); } catch (e) { return null; }
  if (!arr || !arr.length) return null;
  return arr.map(function (x) {
    return [x.day, parseFloat(x.open), parseFloat(x.close), parseFloat(x.high), parseFloat(x.low)];
  }).filter(function (b) { return b[1] > 0 && b[2] > 0; });
}

(async function () {
  const codes = picks.map(function (p) { return p.code; }).filter(function (c) { return /^\d{6}\.(SH|SZ)$/.test(c); });
  console.log('拉 %d 只 ETF，并发 %d', codes.length, CONC);
  let idx = 0, done = 0, ok = 0;
  const t0 = Date.now();
  async function worker() {
    while (idx < codes.length) {
      const c = codes[idx++];
      try {
        const b = await one(c);
        if (b && b.length > 100) { O.bars[c] = b; O.isETF[c] = 1; ok++; }
      } catch (e) { }
      done++;
      if (done % 100 === 0) console.log('  %d/%d · 成功%d · %.0fs', done, codes.length, ok, (Date.now() - t0) / 1000);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  O.count = Object.keys(O.bars).length;
  const json = JSON.stringify(O);
  fs.writeFileSync(path.join(ROOT, 'ohlc.json.gz'), zlib.gzipSync(Buffer.from(json), { level: 9 }));
  console.log('完成：共 %d 只（其中ETF %d）· gz %.0fMB · %.1f 分钟',
    O.count, Object.keys(O.isETF).length,
    fs.statSync(path.join(ROOT, 'ohlc.json.gz')).size / 1048576, (Date.now() - t0) / 60000);
})();
