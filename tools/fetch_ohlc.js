// 拉全市场 11 年 OHLC 后复权数据，供缠论分型/笔/中枢使用。
// 输出：ohlc.json.gz  { code: [[date, open, close, high, low], ...] }
// 2026-11-24：抓取链路接入 tools/fetch_gate.js —— 东财统一限流、腾讯三入口轮换 + 后复权 hfq 兜底。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const G = require('./fetch_gate');

const ROOT = path.dirname(__dirname);
const CONC = parseInt(process.argv[2] || '4', 10);
const BEG = '20150101', END = '20261231';
const BEG_D = BEG.slice(0, 4) + '-' + BEG.slice(4, 6) + '-' + BEG.slice(6, 8);
const END_D = END.slice(0, 4) + '-' + END.slice(4, 6) + '-' + END.slice(6, 8);

const raw = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8')
  .replace(/^\ufeff/, '').replace(/window\.AB_DATA\s*=/, 'global.__D =');
(0, eval)(raw);
const codes = (global.__D.rows || []).map(function (r) { return r.code; })
  .filter(function (c) { return /^\d{6}\.(SH|SZ)$/.test(c); });

function secid(code) {
  return (code.endsWith('.SH') ? '1.' : '0.') + code.slice(0, 6);
}
function txSymbol(code) {
  return (code.endsWith('.SH') ? 'sh' : 'sz') + code.slice(0, 6);
}

// 东财后复权日K（历史最深，正常首选）。统一走闸门：最小间隔 + 抖动 + 失败退避，
// 不再用 10 并发猛打单入口（云端曾因此 5461 只只剩 1281 只）。
async function fromEastmoney(code) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
    + '?secid=' + secid(code) + '&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55'
    + '&klt=101&fqt=2&beg=' + BEG + '&end=' + END;
  const kl = await G.emKlines(url);
  if (!kl) return null;
  return kl.map(function (x) {
    const p = x.split(',');
    return [p[0], parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3]), parseFloat(p[4])];
  });
}

// 腾讯后复权(hfq)日K兜底：单次最多 640 根，按年份分段往前滚。
// 三入口轮换 + 每入口限速由 fetch_gate 负责；hfq 与东财 fqt=2 同为后复权，口径不混。
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

async function one(code) {
  let b = null;
  try { b = await fromEastmoney(code); } catch (e) { }
  if (b && b.length > 200) return { bars: b, src: 'em' };
  try { b = await fromTencent(code); } catch (e) { }
  if (b && b.length > 200) return { bars: b, src: 'tx-hfq' };
  return null;
}

(async function () {
  console.log('标的 %d 只，并发 %d（东财限速 / 腾讯三入口轮换）', codes.length, CONC);
  const bars = {};
  let idx = 0, done = 0, ok = 0, nEM = 0, nTX = 0, fail = 0;
  const t0 = Date.now();
  async function worker() {
    while (idx < codes.length) {
      const c = codes[idx++];
      try {
        const r = await one(c);
        if (r) {
          bars[c] = r.bars; ok++;
          if (r.src === 'em') nEM++; else nTX++;
        } else fail++;
      } catch (e) { fail++; }
      done++;
      if (done % 300 === 0) console.log('  %d/%d · 成功%d(东财%d/腾讯%d) 失败%d · %.0fs',
        done, codes.length, ok, nEM, nTX, fail, (Date.now() - t0) / 1000);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  // asOf 必须是数据里最后一根 K 线的日期，不能用 new Date()
  let maxD = '';
  Object.keys(bars).forEach(function (c) {
    const b = bars[c];
    if (b && b.length) { const d = b[b.length - 1][0]; if (d > maxD) maxD = d; }
  });
  const out = { asOf: maxD || new Date().toISOString().slice(0, 10), count: Object.keys(bars).length, bars: bars };
  const json = JSON.stringify(out);
  fs.writeFileSync(path.join(ROOT, 'ohlc.json.gz'), zlib.gzipSync(Buffer.from(json), { level: 9 }));
  console.log('完成 %d 只（东财%d / 腾讯后复权%d / 失败%d）· 原始 %sMB · gz %sMB · %s 分钟',
    out.count, nEM, nTX, fail, (json.length / 1048576).toFixed(1),
    (fs.statSync(path.join(ROOT, 'ohlc.json.gz')).size / 1048576).toFixed(1), ((Date.now() - t0) / 60000).toFixed(1));
  if (out.count < codes.length * 0.8) {
    console.error('[警告] 覆盖率低于 80%%，一买池可能明显缩水');
  }
})();
