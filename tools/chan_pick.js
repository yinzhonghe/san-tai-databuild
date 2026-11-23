'use strict';
/*
 * 缠论一买选股（新版：chan_theory L0-L8 引擎 + ohlc_v2 全样本数据）
 * -------------------------------------------------------------------
 * 口径与回测 F1 完全一致：
 *   信号 = 笔级(ptsBi) 一买 = 下跌趋势(D) 的 C 段背驰 + C 段 DIF<0
 *   止损 -8%、持有 45 天、每笔固定仓位（回测口径，页面仅展示信号）
 * 页面过滤沿用三步排除法：
 *   1) areaRatio < 0.3 视为"背了又背"，剔除
 *   2) 必须有笔中枢（排除盘整一买）
 *   3) 按 distCS（距中枢下沿，越负越前）排序 —— 回测中该排序 +8.03% 最优
 *
 * 数据：
 *   个股 ← ohlc_v2 分片（5,461 只，含 257 只退市，除权缺口已修复）
 *   ETF  ← ohlc.json.gz 的 isETF（525 只，后复权；v2 不含 ETF）
 *
 * 用法：node --max-old-space-size=8192 tools/chan_pick.js
 *      环境变量 WIN 控制回看窗口（默认 20 个交易日）
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const L = require('./load_ohlc.js');
const T = require('./chan_theory.js');
const LB = require('./learn_lib.js');

const ROOT = path.dirname(__dirname);
const WIN = +(process.env.WIN || 20);

/* ---------- 进化模型（learn/chan_params.json） ----------
 * 只有训练侧判定「样本外优于基线」才会把 adopt 置 true；否则退回基线参数。
 * 环境变量优先级最高，方便回测复现某一版参数。
 */
const MODEL = LB.readJson(path.join(LB.LEARN, 'chan_params.json'), null);
const USE_MODEL = !!(MODEL && MODEL.adopt && MODEL.card && MODEL.card.edges);
const AREA_MIN = +(process.env.AREA_MIN || (USE_MODEL ? MODEL.areaMin : 0.3));
const MIN_SCORE = USE_MODEL ? MODEL.minScore : null;
if (MODEL) {
  console.log('模型 %s：%s（样本外胜率%s%% / n=%s）',
    MODEL.version, USE_MODEL ? '已启用' : '未启用（沿用基线参数）', MODEL.oos && MODEL.oos.win, MODEL.oos && MODEL.oos.n);
}

/* 指数 20 日涨跌（模型特征 reg20），按信号日期取 */
const REG20 = (function () {
  const idx = LB.loadIndexHist();
  const m = {}, cl = [];
  idx.bars.forEach(function (b, i) { m[b[0]] = i; cl.push(b[2]); });
  const out = {};
  idx.bars.forEach(function (b, i) {
    out[b[0]] = i >= 20 ? (cl[i] / cl[i - 20] - 1) * 100 : 0;
  });
  return out;
})();

/* ---------- 行业/状态标签（data.js 复用，取不到就留空） ---------- */
const INFO = {};
try {
  const raw = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8')
    .replace(/^\ufeff/, '').replace(/window\.AB_DATA\s*=/, 'global.__D=').replace(/;?\s*$/, '');
  (0, eval)(raw);
  (global.__D.rows || []).forEach(function (r) { INFO[r.code] = r; });
} catch (e) { console.warn('data.js 读取失败，行业标签留空:', e.message); }

/* ---------- 真实价换算系数（后复权 → 真实可交易价） ----------
 * 缠论形态必须用后复权算（跨除权日连续），但页面展示的「现价/中枢/止损/买卖点」
 * 必须是真实股价，否则会出现「实际 4.66 元、页面显示 50 多元」的量级错误。
 * data.js 的 closes 是腾讯前复权真实价，与 ohlc 后复权同一标的同一交易日，
 * 系数 = 真实收盘 / 后复权收盘。后复权序列 = 真实序列 × 常数，故同一票任一天
 * 系数恒定（除权日整数跳变也已被后复权抹平），可用最新一日对齐。
 * 每票系数不同（送转分红历史不同），必须逐票算，不能用统一倍数。
 */
function realFactor(code, bars) {
  const r = INFO[code];
  if (!r || !r.closes || !r.closes.length) return 1;
  const real = r.closes[r.closes.length - 1];   // data.js 最新真实价
  const hfq = bars[bars.length - 1][2];         // 后复权最新收盘
  return (real > 0 && hfq > 0) ? (real / hfq) : 1;
}

/* ---------- 数据 ---------- */
const O = L.load();                       // 个股（ohlc_v2）
const codes = Object.keys(O.codes);
const ASOF = O.asOf;
let skipStale = 0;
let skipScore = 0;
console.log('个股数据 asOf=%s 分片%s 标的%d', O.asOf, O.parts || 1, codes.length);

let OLDBARS = {}, ETF = {}, ETFASOF = '';
let ASOF_ETF = '';                        // ETF 自己的最新交易日（新浪源比东财慢，不能强求与个股同日）
try {
  const old = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'ohlc.json.gz'))).toString());
  ETF = old.isETF || {};
  OLDBARS = old.bars || {};
  ETFASOF = old.asOf || '';
} catch (e) { console.warn('ETF 数据读取失败:', e.message); }

const WIN_START_IDX = {};                 // 每只票的回看起点
function recentBuy1(A, N) {
  const from = Math.max(0, N - WIN);
  let best = null;
  A.ptsBi.buy1.forEach(function (s) {
    if (s.k < from || s.k >= N) return;
    if (!best || s.k > best.k) best = s;
  });
  return best;
}

function build(code, bars, nm, isEtf) {
  if (!bars || bars.length < 250) return null;
  let A;
  try { A = T.analyzeOne(bars); } catch (e) { return null; }

  const N = bars.length;
  const sig = recentBuy1(A, N);
  if (!sig) return null;

  const area = sig.areaRatio || 1;
  if (area < AREA_MIN) return null;                  // 背了又背
  const cBi = A.cBi || [];
  if (!cBi.length) return null;                      // 盘整一买

  const lastBar = bars[N - 1];
  const px = lastBar[2];
  if (!(px > 0)) return null;
  const refAsOf = (isEtf && ASOF_ETF) ? ASOF_ETF : ASOF;
  if (lastBar[0] !== refAsOf) { skipStale++; return null; }   // 停牌/数据陈旧，价格不可用

  const c = cBi[cBi.length - 1];
  const ZD = c.ZD, ZG = c.ZG;
  const distCS = ZD > 0 ? (px / ZD - 1) * 100 : 0;
  const sell3 = px < ZD ? +(ZD * 0.97).toFixed(3) : +ZD.toFixed(3);
  const daysAgo = N - 1 - sig.k;

  /* 进化模型打分：特征一律取「信号当时」的值，避免用今天的信息给昨天的信号打分 */
  let score = null;
  if (USE_MODEL) {
    let cSig = null;
    for (let i = 0; i < cBi.length; i++) if (cBi[i].i1 <= sig.unit) cSig = cBi[i];
    const date500 = bars[Math.max(0, sig.k - 500)][0];
    const cs500 = cBi.filter(function (x) { return x.d1 >= date500; }).length;
    const xv = LB.featureVec(bars, sig.k, {
      areaRatio: sig.areaRatio,
      nCenters: sig.nCenters,
      csRecent: cs500,
      ZD: cSig ? cSig.ZD : ZD
    }, { reg20: REG20[sig.d] || 0 });
    score = +LB.cardScore(MODEL.card, xv, MODEL.feats).toFixed(2);
  }

  const kline = bars.slice(-120).map(function (b) {
    return [b[0], +b[1].toFixed(3), +b[2].toFixed(3), +b[3].toFixed(3), +b[4].toFixed(3)];
  });
  const k0 = kline[0][0];

  const centersRecent = (c.d1 >= k0) ? [{ d0: c.d0, d1: c.d1, ZD: +ZD.toFixed(3), ZG: +ZG.toFixed(3) }] : [];

  const marks = [];
  [['buy1', '一买'], ['buy2', '二买'], ['buy3', '三买']].forEach(function (t) {
    (A.ptsBi[t[0]] || []).forEach(function (s) {
      if (s.d >= k0) marks.push({ d: s.d, p: +s.p.toFixed(3), t: t[1] });
    });
  });
  marks.sort(function (a, b) { return a.d < b.d ? -1 : 1; });

  const info = INFO[code] || {};
  // 缠论形态用后复权算完，展示价统一换算回真实价（4.66 元那种），避免 50 元的量级错误。
  // 比例类指标（distCS/retSince/area）与复权无关，保持不变。
  const rf = realFactor(code, bars);
  const rp = function (v) { return v > 0 ? +(v * rf).toFixed(3) : 0; };
  return {
    code: code, name: nm,
    sigDate: sig.d, daysAgo: daysAgo,
    retSince: +(((px / (sig.p > 0 ? sig.p : px)) - 1) * 100).toFixed(2),
    sigPx: rp(sig.p > 0 ? sig.p : px),
    px: rp(px),
    pxRaw: +px.toFixed(3),                 // 后复权原值，仅供自进化台账对账（打分实际按 date+code 重取 bars）
    realFactor: +rf.toFixed(6),            // 换算系数，便于核验
    area: +area.toFixed(2),
    areaRaw: +area.toFixed(3),
    nCenters: sig.nCenters || cBi.length,
    csRecent: cBi.filter(function (x) { return x.d1 >= k0; }).length,
    csAll: cBi.length,
    ZD: rp(ZD), ZG: rp(ZG),
    distCS: +distCS.toFixed(1),            // 比例：(px/ZD-1)*100，复权不影响
    score: score,
    mver: USE_MODEL ? MODEL.version : '',
    sell3: rp(sell3),
    stop: rp(px * 0.92),
    ind: info.ind || info.indL1 || '',
    state: info.state || '',
    kline: kline.map(function (b) { return [b[0], rp(b[1]), rp(b[2]), rp(b[3]), rp(b[4])]; }),
    centers: centersRecent.map(function (c) {
      return { d0: c.d0, d1: c.d1, ZD: rp(c.ZD), ZG: rp(c.ZG) };
    }),
    marks: marks.map(function (m) { return { d: m.d, p: rp(m.p), t: m.t }; }),
    etf: !!isEtf
  };
}

/* ---------- 个股 ---------- */
const stocks = [];
let skipDead = 0, skipST = 0, skipShort = 0;
codes.forEach(function (code) {
  const m = O.codes[code];
  if (ETF[code]) return;                              // ETF 走下面单独一段，别当个股重复算
  // 名字优先取 data.js 的 name：旧版 ohlc.json.gz（legacy 模式）里 m.n 是空的，
  // 那样 /ST|退/ 永远匹配不到，ST 股会被当成正常票选进来
  const nm = (INFO[code] && INFO[code].name) || m.n || code;
  if (m.dead || (INFO[code] && INFO[code].kind === 'delisted')) { skipDead++; return; }
  if (/ST|退/.test(nm)) { skipST++; return; }         // ST/退：实盘可交易性差
  if (!m.bars || m.bars.length < 250) { skipShort++; return; }
  const r = build(code, m.bars, nm, false);
  if (r) stocks.push(r);
});

/* ---------- ETF ---------- */
// 先用 ETF 自己的最新交易日做基准：新浪源的 ETF 日线常比东财个股慢一天，
// 强行要求与个股同日会让 ETF 池在盘中/数据延迟时整体清零
Object.keys(ETF).forEach(function (code) {
  const b = OLDBARS[code];
  if (b && b.length) { const d = b[b.length - 1][0]; if (d > ASOF_ETF) ASOF_ETF = d; }
});
console.log('ETF 数据基准日 %s（个股 asOf %s，共 %d 只）', ASOF_ETF || '-', ASOF, Object.keys(ETF).length);

const etfs = [];
Object.keys(ETF).forEach(function (code) {
  const bars = OLDBARS[code];                         // v2 不含 ETF，ETF 走旧数据层（后复权）
  if (!bars || bars.length < 250) return;
  const nm = (INFO[code] && INFO[code].name) || (ETF[code] && ETF[code].name) || code;
  const r = build(code, bars, nm, true);
  if (r) etfs.push(r);
});

let CUT_SCORE = null;
function trimByScore(list) {
  // 原地裁剪（调用方拿到的是同一个数组的引用，返回新数组会静默失效）
  if (!USE_MODEL || list.length < 12) return;
  const arr = list.map(function (x) { return x.score; }).sort(function (a, b) { return a - b; });
  // 与训练时的筛选比例一致：scoreQ=0.3 → 去掉分数最低的 30%
  const qDrop = (MODEL.scoreQ != null) ? MODEL.scoreQ : 0.25;
  const cut = arr[Math.floor(arr.length * qDrop)];
  CUT_SCORE = +cut.toFixed(2);
  for (let i = list.length - 1; i >= 0; i--) if (list[i].score < cut) list.splice(i, 1);
}
function sortAndTrim(list) {
  trimByScore(list);
  if (USE_MODEL) {
    // 模型启用后按「模型分」排序：它预测的是 20 日稳健收益，比单纯「离中枢多远」更贴结果
    list.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.distCS - b.distCS;
    });
  } else {
    list.sort(function (a, b) { return a.distCS - b.distCS; });
  }
  return list;
}
sortAndTrim(stocks);
sortAndTrim(etfs);

/* ---------- 输出 ---------- */
const out = {
  date: O.asOf,
  method: '缠论一买 · 笔级趋势背驰 · ' + (USE_MODEL ? '进化模型打分排序' : '三步排除（背驰非极端/有中枢/距中枢排序）'),
  engine: 'chan_theory L0-L8（笔级 ptsBi）',
  basis: O.basis,
  level: '笔级',
  window: WIN,
  params: {
    stop: MODEL && USE_MODEL ? MODEL.stop : 8,
    hold: MODEL && USE_MODEL ? MODEL.hold : 45,
    areaMin: AREA_MIN,
    minScore: MIN_SCORE,
    cutScore: CUT_SCORE,
    keepPct: USE_MODEL ? Math.round((1 - (MODEL.scoreQ != null ? MODEL.scoreQ : 0.25)) * 100) : 100,
    model: USE_MODEL ? MODEL.version : '',
    trainedAt: USE_MODEL ? MODEL.trainedAt : '',
    oos: USE_MODEL ? MODEL.oos : null,
    baseline: USE_MODEL ? MODEL.baseline : null,
    spread: USE_MODEL ? MODEL.spread : null,
    feats: USE_MODEL ? MODEL.feats.map(function (f) { return { k: f, d: (MODEL.fdesc || {})[f] || '' }; }) : null,
    card: USE_MODEL ? MODEL.card : null
  },
  stockCount: stocks.length, etfCount: etfs.length,
  note: '历史基线回测口径：止损 8%、持有 45 天、全样本 5,461 只（含退市），累计 +330.5%、年化 13.09%、'
    + '最大回撤 12.9%、299 笔、胜率 58.2%；页面已剔除 ST/退市（实盘买不到），故页面信号集比回测窄。'
    + (USE_MODEL ? '当前名单由进化模型打分排序，模型口径见上方；两者不可直接对比。' : '当前未启用进化模型。'),
  stocks: stocks, etfs: etfs
};
const js = '/* 缠论一买选股 · 由 tools/chan_pick.js 生成，勿手改 */\n'
  + 'window.AB_CHANPICK = ' + JSON.stringify(out) + ';\n';
fs.writeFileSync(path.join(ROOT, 'chan_pick_data.js'), js);

/* ---------- 实盘台账：把今天发出去的名单记下来，到期后用真实走势打分 ---------- */
(function () {
  const LEDGER = path.join(LB.LEARN, 'chan_ledger.jsonl');
  const seen = new Set(LB.readJsonl(LEDGER).map(function (r) { return r.date + '|' + r.code; }));
  const add = [];
  stocks.concat(etfs).forEach(function (x) {
    const key = O.asOf + '|' + x.code;
    if (seen.has(key)) return;
    add.push({
      date: O.asOf, code: x.code, name: x.name, sigDate: x.sigDate,
      score: x.score, area: x.area, distCS: x.distCS, px: (x.pxRaw != null ? x.pxRaw : x.px),
      etf: !!x.etf, ver: USE_MODEL ? MODEL.version : 'baseline'
    });
  });
  LB.appendJsonl(LEDGER, add);
  if (add.length) console.log('台账：新增 %d 条（模型 %s）', add.length, USE_MODEL ? MODEL.version : 'baseline');
})();

console.log('\n剔除：退市%d / ST%d / 样本不足%d / 停牌陈旧%d；模型分裁剪线 %s', skipDead, skipST, skipShort, skipStale, CUT_SCORE == null ? '未启用' : CUT_SCORE);
console.log('结果：个股 %d 只，ETF %d 只（回看%d个交易日）', stocks.length, etfs.length, WIN);
console.log('面积分布：', JSON.stringify(
  stocks.reduce(function (a, x) { const b = x.area < 0.5 ? 'lt0.5' : x.area < 0.8 ? 'mid' : 'gt0.8'; a[b] = (a[b] || 0) + 1; return a; }, {})
));
console.log('最近信号日：%s（最远 %d 天前）',
  stocks.length ? stocks.map(function (x) { return x.sigDate; }).sort().reverse()[0] : '-',
  stocks.length ? Math.max.apply(null, stocks.map(function (x) { return x.daysAgo; })) : 0);
console.log('文件 ' + (fs.statSync(path.join(ROOT, 'chan_pick_data.js')).size / 1048576).toFixed(1) + ' MB');
if (stocks.length) console.log('个股前5:', stocks.slice(0, 5).map(function (x) { return x.name + '(' + x.distCS + '%)'; }).join(', '));
if (etfs.length) console.log('ETF前5:', etfs.slice(0, 5).map(function (x) { return x.name + '(' + x.distCS + '%)'; }).join(', '));
