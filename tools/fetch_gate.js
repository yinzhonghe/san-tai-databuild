'use strict';
/**
 * 统一取数闸门（2026-11-24）—— 一买链路专用
 *
 * 背景：旧一买脚本用 8~10 并发猛打单入口（东财 push2his / 腾讯 web.ifzq / 新浪），
 * 云端 runner 出口 IP 被风控后 5461 只只剩 1281 只，页面出现大片空缺。
 * 线上已验证的做法见 tools/build_data.py 的 fetch_kline_tencent：
 *   ① 腾讯三入口轮换（web.ifzq / ifzq / proxy.finance.qq.com）；
 *   ② 每个入口独立最小间隔 + 随机抖动；
 *   ③ 东财系共用同一风控面 → 收敛到单一出口做串行限流。
 * 这里把同一套机制复用到一买抓取，不改数据口径、不编造数据。
 *
 * 注意：gate 用「预约制」而非「sleep 后再记录」——并发 worker 同时进入时，
 * 后者必须排到前者之后的时间点，否则限流形同虚设。
 */

const TX_HOSTS = [
  'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
  'https://ifzq.gtimg.cn/appstock/app/fqkline/get',
  'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get'
];

const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

const _nextAt = new Map();   // host -> 下一次允许发出请求的时间戳
let _rr = 0;

/** 预约一个发送时刻，返回需要等待的 Promise（无 await 的原子登记，并发安全） */
function gate(host, minMs, jitterMs) {
  const now = Date.now();
  const prev = _nextAt.get(host) || 0;
  const jitter = jitterMs ? Math.floor(Math.random() * jitterMs) : 0;
  const at = Math.max(now, prev + minMs) + jitter;
  _nextAt.set(host, at);
  return sleep(at - now);
}

function nextHost(hosts) {
  const hs = hosts && hosts.length ? hosts : TX_HOSTS;
  return hs[_rr++ % hs.length];
}

/**
 * 腾讯复权日K：三入口轮换，失败自动退下一个入口。
 * @returns { rows, host, fq } | null   rows: [[date, open, close, high, low, ...], ...]
 */
async function txKline(sym, opt) {
  const o = Object.assign({ fq: 'qfq', beg: '', end: '', n: 640, minMs: 100, jitter: 50, tries: 3 }, opt);
  const param = [sym, 'day', o.beg, o.end, o.n, o.fq].join(',');
  for (let k = 0; k < o.tries; k++) {
    const host = nextHost(o.hosts);
    await gate(host, o.minMs, o.jitter);
    try {
      const r = await fetch(host + '?param=' + param, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const j = await r.json();
      const d = (j.data || {})[sym] || {};
      const key = o.fq === 'hfq' ? 'hfqday' : (o.fq === 'qfq' ? 'qfqday' : 'day');
      const arr = d[key] || d.day || [];
      if (arr.length) return { rows: arr, host: host, fq: o.fq };
    } catch (e) { /* 下一个入口 */ }
  }
  return null;
}

/** 东财 kline：所有调用统一走这里，限流 + 失败退避重试 */
async function emKlines(url, opt) {
  const o = Object.assign({ minMs: 220, jitter: 100, retries: 2 }, opt);
  for (let k = 0; k <= o.retries; k++) {
    await gate('eastmoney', o.minMs, o.jitter);
    if (k) await sleep(180 * k);
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' }
      });
      if (!r.ok) continue;
      const j = await r.json();
      const kl = (j.data && j.data.klines) || [];
      if (kl.length) return kl;
    } catch (e) { /* 重试 */ }
  }
  return null;
}

/** 新浪日K：限速 + 重试；ETF 腾讯也可用（2026-11-24 实测三入口均返回 ETF hfq/qfq） */
async function sinaKline(sym, opt) {
  const o = Object.assign({ minMs: 150, jitter: 80, retries: 2 }, opt);
  const url = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/'
    + 'CN_MarketData.getKLineData?symbol=' + sym + '&scale=240&ma=no&datalen=1023';
  for (let k = 0; k <= o.retries; k++) {
    await gate('sina', o.minMs, o.jitter);
    if (k) await sleep(180 * k);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const txt = await r.text();
      const arr = JSON.parse(txt);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (e) { /* 重试 */ }
  }
  return null;
}

module.exports = { TX_HOSTS, sleep, gate, nextHost, txKline, emKlines, sinaKline };
