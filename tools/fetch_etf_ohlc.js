// 拉 ETF 的 OHLC（新浪源为主，腾讯三入口轮换兜底）
// 新浪 datalen 最大 1023，够11年日K。输出合并到 ohlc.json.gz（标记 isETF）
// 用法：node tools/fetch_etf_ohlc.js [并发]
// 2026-11-24：接入 tools/fetch_gate.js —— 统一限速 + 失败重试 + 三入口轮换兜底。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const G = require('./fetch_gate');

const ROOT = path.dirname(__dirname);
const CONC = parseInt(process.argv[2] || '4', 10);
const BEG_D = '2015-01-01', END_D = '2026-12-31';
const picks = require(path.join(ROOT, '_etf_pick.json'));
const O = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'ohlc.json.gz'))).toString());
O.isETF = O.isETF || {};

function sinaSymbol(code) {
  return (code.endsWith('.SH') ? 'sh' : 'sz') + code.slice(0, 6);
}
function txSymbol(code) {
  return (code.endsWith('.SH') ? 'sh' : 'sz') + code.slice(0, 6);
}

async function fromSina(code) {
  const arr = await G.sinaKline(sinaSymbol(code));
  if (!arr) return null;
  return arr.map(function (x) {
    return [x.day, parseFloat(x.open), parseFloat(x.close), parseFloat(x.high), parseFloat(x.low)];
  }).filter(function (b) { return b[1] > 0 && b[2] > 0; });
}

// 新浪失败时的兜底：腾讯 qfq（2026-11-24 实测 ETF 在三入口均可用），最多 640 根/段。
async function fromTencent(code) {
  const sym = txSymbol(code);
  const segs = [];
  let end = END_D;
  for (let pass = 0; pass < 3; pass++) {
    const hit = await G.txKline(sym, { fq: 'qfq', beg: BEG_D, end: end, n: 640 });
    if (!hit) break;
    const rows = hit.rows.map(function (x) {
      return [x[0], parseFloat(x[1]), parseFloat(x[2]), parseFloat(x[3]), parseFloat(x[4])];
    }).filter(function (b) { return b[0] && b[2] > 0; });
    if (!rows.length) break;
    segs.unshift(rows);
    const first = rows[0][0];
    if (first <= BEG_D || rows.length < 640) break;
    const dt = new Date(first + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() - 1);
    end = dt.toISOString().slice(0, 10);
  }
  const seen = {}, out = [];
  segs.forEach(function (rows) {
    rows.forEach(function (b) { if (!seen[b[0]]) { seen[b[0]] = 1; out.push(b); } });
  });
  out.sort(function (a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); });
  return out;
}

async function one(code) {
  let b = null;
  try { b = await fromSina(code); } catch (e) { }
  if (b && b.length > 100) return { bars: b, src: 'sina' };
  try { b = await fromTencent(code); } catch (e) { }
  if (b && b.length > 100) return { bars: b, src: 'tx-qfq' };
  return null;
}

(async function () {
  const codes = picks.map(function (p) { return p.code; })
    .filter(function (c) { return /^\d{6}\.(SH|SZ)$/.test(c); });
  console.log('拉 %d 只 ETF，并发 %d（新浪限速 / 腾讯三入口兜底）', codes.length, CONC);
  let idx = 0, done = 0, ok = 0, nSina = 0, nTX = 0, fail = 0;
  const t0 = Date.now();
  async function worker() {
    while (idx < codes.length) {
      const c = codes[idx++];
      try {
        const r = await one(c);
        if (r) {
          O.bars[c] = r.bars; O.isETF[c] = 1; ok++;
          if (r.src === 'sina') nSina++; else nTX++;
        } else fail++;
      } catch (e) { fail++; }
      done++;
      if (done % 200 === 0) console.log('  %d/%d · 成功%d(新浪%d/腾讯%d) 失败%d · %.0fs',
        done, codes.length, ok, nSina, nTX, fail, (Date.now() - t0) / 1000);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  O.count = Object.keys(O.bars).length;
  const json = JSON.stringify(O);
  fs.writeFileSync(path.join(ROOT, 'ohlc.json.gz'), zlib.gzipSync(Buffer.from(json), { level: 9 }));
  console.log('完成：共 %d 只（其中ETF %d）· 新增ETF 成功%d(新浪%d/腾讯%d) 失败%d · gz %sMB · %s 分钟',
    O.count, Object.keys(O.isETF).length, ok, nSina, nTX, fail,
    (fs.statSync(path.join(ROOT, 'ohlc.json.gz')).size / 1048576).toFixed(1), ((Date.now() - t0) / 60000).toFixed(1));
})();
