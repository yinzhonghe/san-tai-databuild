// 拉取全市场 11 年前复权日 K 收盘价，供胜率回测/超跌反弹名单使用。
// 输出：hist.json.gz（{ asOf, bars: { "600519.SH": [[date, close], ...] } }）
// 用法：node tools/fetch_hist.js [并发数]
// 2026-11-24：接入 tools/fetch_gate.js —— 东财统一限流；腾讯三入口轮换 + 后复权 hfq 兜底。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const G = require('./fetch_gate');

const ROOT = path.dirname(__dirname);
const CONC = parseInt(process.argv[2] || '4', 10);
const BEG = '20150101';
const END = '20261231';
const BEG_D = BEG.slice(0, 4) + '-' + BEG.slice(4, 6) + '-' + BEG.slice(6, 8);
const END_D = END.slice(0, 4) + '-' + END.slice(4, 6) + '-' + END.slice(6, 8);

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
function txSymbol(code) {
  const m = code.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  return ({ SH: 'sh', SZ: 'sz', BJ: 'bj' })[m[2]] + m[1];
}

async function fromEastmoney(code) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
    + '?secid=' + secid(code) + '&fields1=f1,f2,f3&fields2=f51,f53'
    + '&klt=101&fqt=1&beg=' + BEG + '&end=' + END;
  const kl = await G.emKlines(url);
  if (!kl) return null;
  return kl.map(function (x) {
    const p = x.split(',');
    return [p[0], parseFloat(p[1])];
  });
}

// 腾讯后复权(hfq)分段拼接：实测 qfq 对老票只回溯到 2016 年（2519 根），
// hfq 能拿满 11 年（2888 根）；复权方式只改绝对价格，区间收益率比例不变，
// 且 hist 与 ohlc 同为后复权、口径统一。东财成功时仍走东财 fqt=1（原口径不变）。
async function fromTencent(code) {
  const sym = txSymbol(code);
  const segs = [];
  let end = END_D;
  for (let pass = 0; pass < 8; pass++) {
    const hit = await G.txKline(sym, { fq: 'hfq', beg: BEG_D, end: end, n: 640 });
    if (!hit) break;
    const rows = hit.rows.map(function (x) { return [x[0], parseFloat(x[2])]; })
      .filter(function (b) { return b[0] && b[1] > 0; });
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
  if (b && b.length > 200) return { bars: b, src: 'tx-qfq' };
  return null;
}

(async function () {
  const codes = loadCodes();
  console.log('标的数：%d，并发 %d（东财限速 / 腾讯三入口轮换）', codes.length, CONC);
  const bars = {};
  let done = 0, ok = 0, nEM = 0, nTX = 0, fail = 0;
  const t0 = Date.now();

  let idx = 0;
  async function worker() {
    while (idx < codes.length) {
      const code = codes[idx++];
      try {
        const r = await one(code);
        if (r) {
          bars[code] = r.bars; ok++;
          if (r.src === 'em') nEM++; else nTX++;
        } else fail++;
      } catch (e) { fail++; }
      done++;
      if (done % 300 === 0) {
        const el = (Date.now() - t0) / 1000;
        console.log('  %d/%d 成功%d(东财%d/腾讯hfq%d) 失败%d · %.0fs', done, codes.length, ok, nEM, nTX, fail, el);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  // asOf 取数据里真实最后一根 K 线日期（周末跑不会写成非交易日）
  let maxD = '';
  Object.keys(bars).forEach(function (c) {
    const b = bars[c];
    if (b && b.length) { const d = b[b.length - 1][0]; if (d > maxD) maxD = d; }
  });
  const out = { asOf: maxD || new Date().toISOString().slice(0, 10), count: Object.keys(bars).length, bars: bars };
  const json = JSON.stringify(out);
  fs.writeFileSync(path.join(ROOT, 'hist.json.gz'), zlib.gzipSync(Buffer.from(json), { level: 9 }));
  console.log('完成：%d 只（东财%d / 腾讯后复权%d / 失败%d）· 原始 %sMB · gz %sMB · 用时 %s 分钟',
    out.count, nEM, nTX, fail, (json.length / 1048576).toFixed(1),
    (fs.statSync(path.join(ROOT, 'hist.json.gz')).size / 1048576).toFixed(1), ((Date.now() - t0) / 60000).toFixed(1));
  if (out.count < codes.length * 0.8) console.error('[警告] 覆盖率低于 80%%，超跌反弹池可能缩水');
})();
