// 拉 ETF 的 OHLC（腾讯后复权 hfq 分段为主，新浪兜底）
// 输出合并到 ohlc.json.gz（标记 isETF）
// 2026-11-24：
//   - 旧版主源新浪 datalen=1023 实际只有约 4 年（注释写「够11年」是错的），缠论长周期判断吃亏；
//   - 改腾讯 hfq 分段：单次 640 根、往前滚最多 8 段，实测 510300 拿到 2888 根（2015 至今），
//     与个股 ohlc 的东财 fqt=2 同为后复权、口径统一；
//   - 三入口轮换 + 每入口限速由 fetch_gate 负责；新浪保留为失败兜底（不复权，仅在腾讯全挂时用）。
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

// 主源：腾讯后复权分段，最多 8 段 × 640 根 ≈ 11 年
async function fromTencent(code) {
  const sym = txSymbol(code);
  const segs = [];
  let end = END_D;
  for (let pass = 0; pass < 8; pass++) {
    const hit = await G.txKline(sym, { fq: 'hfq', beg: BEG_D, end: end, n: 640 });
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

// 兜底：新浪不复权（只有约 1023 根 ≈ 4 年），腾讯三入口全挂时才用
async function fromSina(code) {
  const arr = await G.sinaKline(sinaSymbol(code));
  if (!arr) return null;
  return arr.map(function (x) {
    return [x.day, parseFloat(x.open), parseFloat(x.close), parseFloat(x.high), parseFloat(x.low)];
  }).filter(function (b) { return b[1] > 0 && b[2] > 0; });
}

async function one(code) {
  let b = null;
  try { b = await fromTencent(code); } catch (e) { }
  if (b && b.length > 100) return { bars: b, src: 'tx-hfq' };
  try { b = await fromSina(code); } catch (e) { }
  if (b && b.length > 100) return { bars: b, src: 'sina' };
  return null;
}

(async function () {
  const codes = picks.map(function (p) { return p.code; })
    .filter(function (c) { return /^\d{6}\.(SH|SZ)$/.test(c); });
  console.log('拉 %d 只 ETF，并发 %d（腾讯后复权分段 / 新浪兜底）', codes.length, CONC);
  let idx = 0, done = 0, ok = 0, nTX = 0, nSina = 0, fail = 0;
  const t0 = Date.now();
  async function worker() {
    while (idx < codes.length) {
      const c = codes[idx++];
      try {
        const r = await one(c);
        if (r) {
          O.bars[c] = r.bars; O.isETF[c] = 1; ok++;
          if (r.src === 'tx-hfq') nTX++; else nSina++;
        } else fail++;
      } catch (e) { fail++; }
      done++;
      if (done % 200 === 0) console.log('  %d/%d · 成功%d(腾讯hfq%d/新浪%d) 失败%d · %.0fs',
        done, codes.length, ok, nTX, nSina, fail, (Date.now() - t0) / 1000);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  O.count = Object.keys(O.bars).length;
  const json = JSON.stringify(O);
  fs.writeFileSync(path.join(ROOT, 'ohlc.json.gz'), zlib.gzipSync(Buffer.from(json), { level: 9 }));
  console.log('完成：共 %d 只（其中ETF %d）· 新增ETF 成功%d(腾讯hfq%d/新浪%d) 失败%d · gz %sMB · %s 分钟',
    O.count, Object.keys(O.isETF).length, ok, nTX, nSina, fail,
    (fs.statSync(path.join(ROOT, 'ohlc.json.gz')).size / 1048576).toFixed(1), ((Date.now() - t0) / 60000).toFixed(1));
  if (fail > codes.length * 0.2) console.error('[警告] ETF 抓取失败率超过 20%%');
})();
