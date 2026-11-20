'use strict';
/*
 * 自进化 · 指数日线同步
 * 用途：① 算信号当时的市场环境（reg20）② 给「点评」打分（判断对不对）
 * 源：新浪 K 线接口（本项目个股/ETF 已在用，稳定）；失败则保留旧文件不动
 */
const https = require('https');
const L = require('./learn_lib.js');

const URL = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData'
  + '?symbol=sh000001&scale=240&ma=no&datalen=800';

function get(url) {
  return new Promise(function (res, rej) {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn' } }, function (r) {
      let b = '';
      r.on('data', function (c) { b += c; });
      r.on('end', function () { res(b); });
    }).on('error', rej);
  });
}

async function main() {
  const txt = await get(URL);
  let arr;
  try { arr = JSON.parse(txt); } catch (e) { throw new Error('返回不是 JSON：' + txt.slice(0, 80)); }
  if (!Array.isArray(arr) || !arr.length) throw new Error('返回为空');

  const bars = arr.map(function (r) {
    return [String(r.day).slice(0, 10), +r.open, +r.close, +r.high, +r.low, +r.volume];
  }).filter(function (b) { return b[0] && b[2] > 0; });

  const prev = L.loadIndexHist();
  const merged = {};
  (prev.bars || []).concat(bars).forEach(function (b) { merged[b[0]] = b; });
  const out = Object.keys(merged).sort().map(function (d) { return merged[d]; });

  L.writeJson(require('path').join(L.LEARN, 'index_hist.json'), {
    symbol: 'sh000001', asOf: out[out.length - 1][0], n: out.length, bars: out
  });
  console.log('上证指数日线：' + out.length + ' 根，最新 ' + out[out.length - 1][0]
    + ' 收 ' + out[out.length - 1][2].toFixed(2));
}

main().catch(function (e) {
  console.error('指数同步失败（保留旧文件）：' + e.message);
  process.exitCode = 2;
});
