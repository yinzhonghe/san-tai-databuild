'use strict';
/*
 * 自进化 · 缠论一买模型（分箱打分卡）
 * ==================================================================
 * 闭环：选股(chan_pick) → 台账(ledger) → 到期用真实走势打分(live) →
 *       历史全样本滚动训练(train) → 新参数回灌选股 → 下一轮
 *
 * 为什么用分箱打分卡而不是回归/神经网络：
 *   10 年全市场只有几百个一买信号，参数一多必然拟合噪声；而且真实关系是非线性的
 *   （放量买一胜率 28%、缩量 58%，背驰力度比则是中间最好）。分箱打分卡既保留非线性，
 *   参数量又与样本量匹配，每一档的分数还能直接读懂、写进页面。
 *
 * 子命令：
 *   bootstrap  全市场扫描 → 每个历史一买信号 = 一行「特征 + 真实前向收益」
 *   train      逐年滚动：用「该年之前」的样本学打分卡，在该年上验证（无未来函数）
 *   score      给台账里的实盘选股打真实分（模型上线后的真实战绩）
 *   report     打印模型与战绩
 *
 * 三条硬约束：
 *   1) 训练集严格早于验证年 —— 不偷看未来
 *   2) 年度等权 —— 防止 2026 年的一次暴跌行情把权重全吃掉
 *   3) 只有「样本外稳健优于基线」才换参数，否则沿用冠军参数（防退化）
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const L = require('./learn_lib.js');

const ROOT = L.ROOT;
const SIG_FILE = path.join(L.LEARN, 'chan_signals.json.gz');
const PARAM_FILE = path.join(L.LEARN, 'chan_params.json');
const LEDGER = path.join(L.LEARN, 'chan_ledger.jsonl');
const LIVE = path.join(L.LEARN, 'chan_live.jsonl');
const HIST = path.join(L.LEARN, 'chan_history.jsonl');

const STOP = 8;
const HORIZONS = [10, 20, 45];

/* ==================== bootstrap ==================== */
function bootstrap() {
  const T = require('./chan_theory.js');
  const O = require('./load_ohlc.js').load();
  const idx = L.loadIndexHist();
  const idxMap = {}, idxCl = [];
  idx.bars.forEach(function (b, i) { idxMap[b[0]] = i; idxCl.push(b[2]); });
  function reg20(date) {
    const i = idxMap[date];
    if (i == null || i < 20) return 0;
    return (idxCl[i] / idxCl[i - 20] - 1) * 100;
  }

  const codes = Object.keys(O.codes);
  console.log('载入 ' + codes.length + ' 只（asOf ' + O.asOf + '），扫描历史一买…');

  const rows = [];
  let analyzed = 0, sigN = 0, bad = 0;
  const t0 = Date.now();

  codes.forEach(function (code) {
    const m = O.codes[code];
    const bars = m.bars;
    if (!bars || bars.length < 320) return;
    let A;
    try { A = T.analyzeOne(bars); } catch (e) { bad++; return; }
    analyzed++;
    const centers = A.cBi || [];

    A.ptsBi.buy1.forEach(function (s) {
      if (s.k < 250 || s.k >= bars.length - 6) return;
      let c = null;
      for (let i = 0; i < centers.length; i++) if (centers[i].i1 <= s.unit) c = centers[i];
      if (!c) return;
      const k500 = Math.max(0, s.k - 500);
      const date500 = bars[k500][0];
      const csRecent = centers.filter(function (x) { return x.d1 >= date500; }).length;

      const feats = L.featureVec(bars, s.k, {
        areaRatio: s.areaRatio, nCenters: s.nCenters, csRecent: csRecent, ZD: c.ZD
      }, { reg20: reg20(s.d) });

      const o = {};
      let complete = true;
      HORIZONS.forEach(function (h) {
        const x = L.labelOutcome(bars, s.k, h, STOP);
        if (!x) { complete = false; return; }
        o['r' + h] = x.ret;
      });
      if (!complete) return;
      const o45 = L.labelOutcome(bars, s.k, 45, STOP);
      rows.push([code, s.d].concat(feats,
        [o.r10, o.r20, o.r45, o45.mae, o45.stopped ? 1 : 0]));
      sigN++;
    });

    if (analyzed % 1500 === 0) {
      console.log('  已分析 ' + analyzed + ' / ' + codes.length + '，信号 ' + sigN
        + '，' + Math.round((Date.now() - t0) / 1000) + 's');
    }  });

  const payload = {
    builtAt: new Date().toISOString().slice(0, 19),
    asOf: O.asOf, basis: O.basis, holds: HORIZONS, stop: STOP,
    feats: L.FEATS, universe: analyzed, rows: rows
  };
  L.ensure();
  fs.writeFileSync(SIG_FILE, zlib.gzipSync(Buffer.from(JSON.stringify(payload))));
  const ds = rows.map(function (r) { return r[1]; }).sort();
  console.log('完成：分析 ' + analyzed + ' 只（失败 ' + bad + '），有效信号 ' + sigN
    + '，' + ds[0] + ' ~ ' + ds[ds.length - 1]);
  console.log('写入 ' + SIG_FILE + '（' + (fs.statSync(SIG_FILE).size / 1048576).toFixed(1) + ' MB）');
}

/* ==================== 打分卡 ==================== */
function loadSigs() {
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(SIG_FILE)).toString());
  return raw;
}
function toObj(r, feats) {
  return {
    code: r[0], date: r[1], year: r[1].slice(0, 4),
    x: r.slice(2, 2 + feats.length),
    r10: r[2 + feats.length], r20: r[3 + feats.length], r45: r[4 + feats.length],
    mae45: r[5 + feats.length], stop45: r[6 + feats.length]
  };
}

/* 加权均值/分位（权重用于年度等权） */
function wmean(vals, ws) {
  let s = 0, sw = 0;
  for (let i = 0; i < vals.length; i++) { s += vals[i] * ws[i]; sw += ws[i]; }
  return sw ? s / sw : 0;
}
function wquantile(vals, ws, q) {
  const idx = vals.map(function (v, i) { return i; }).sort(function (a, b) { return vals[a] - vals[b]; });
  const tot = ws.reduce(function (a, b) { return a + b; }, 0);
  let acc = 0;
  for (let i = 0; i < idx.length; i++) {
    acc += ws[idx[i]];
    if (acc >= tot * q) return vals[idx[i]];
  }
  return vals[idx[idx.length - 1]];
}
function trimmedMean(arr, frac) {
  if (!arr.length) return 0;
  const b = arr.slice().sort(function (x, y) { return x - y; });
  const k = Math.floor(b.length * (frac || 0.1));
  const s = b.slice(k, b.length - k);
  return s.length ? L.mean(s) : L.mean(b);
}

const BINS = +(process.env.BINS || 5), SHRINK = +(process.env.SHRINK || 30);

/* 训练打分卡：每年等权，返回 {base, edges:{f:[..]}, vals:{f:[..]}} */
function fitCard(rows, feats, target, yearsForEqual) {
  const y = rows.map(function (o) { return o[target]; });
  // 年度等权
  const cnt = {};
  rows.forEach(function (o) { cnt[o.year] = (cnt[o.year] || 0) + 1; });
  const w = rows.map(function (o) { return 1 / cnt[o.year]; });

  const base = wmean(y, w);
  const edges = {}, vals = {};
  for (let j = 0; j < feats.length; j++) {
    const col = rows.map(function (o) { return o.x[j]; });
    const e = [];
    for (let b = 1; b < BINS; b++) e.push(+wquantile(col, w, b / BINS).toFixed(6));
    const uniq = e.filter(function (v, i) { return i === 0 || v > e[i - 1]; });
    edges[feats[j]] = uniq;
    const sums = new Array(uniq.length + 1).fill(0), wts = new Array(uniq.length + 1).fill(0);
    for (let i = 0; i < rows.length; i++) {
      const v = col[i];
      let b = 0; while (b < uniq.length && v > uniq[b]) b++;
      sums[b] += y[i] * w[i]; wts[b] += w[i];
    }
    vals[feats[j]] = sums.map(function (s, b) {
      const m = wts[b] > 0 ? s / wts[b] : base;
      // 收缩：小样本档位拉回全局均值
      const k = SHRINK * (wts[b] > 0 ? 1 : 0);
      const shrunk = wts[b] > 0 ? (s + base * k) / (wts[b] + k) : base;
      return +(shrunk - base).toFixed(3);
    });
  }
  return { type: 'scorecard', base: +base.toFixed(3), edges: edges, vals: vals, target: target };
}

function cardScore(card, x, feats) {
  let s = card.base;
  for (let j = 0; j < feats.length; j++) {
    const f = feats[j], e = card.edges[f], v = x[j];
    let b = 0; while (b < e.length && v > e[b]) b++;
    s += (card.vals[f][b] || 0);
  }
  return s;
}

/* 一组信号在指定 target 上的表现 */
function perf(sel, target) {
  const a = sel.map(function (o) { return o[target]; }).filter(function (v) { return v != null; });
  if (!a.length) return { n: 0, win: null, avg: null, med: null, trim: null, stop: null };
  return {
    n: a.length,
    win: +(a.filter(function (v) { return v > 0; }).length / a.length * 100).toFixed(1),
    avg: +L.mean(a).toFixed(2),
    med: +L.median(a).toFixed(2),
    trim: +trimmedMean(a, 0.1).toFixed(2),
    stop: sel.length ? +(sel.filter(function (o) { return o.stop45; }).length / sel.length * 100).toFixed(1) : null
  };
}

/* ==================== 训练 ==================== */
function train() {
  if (!fs.existsSync(SIG_FILE)) throw new Error('没有历史样本，请先跑 bootstrap');
  const sig = loadSigs();
  const feats = sig.feats;
  const all = sig.rows.map(function (r) { return toObj(r, feats); })
    .filter(function (o) { return o.r20 != null && o.r45 != null; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  if (all.length < 200) throw new Error('样本 ' + all.length + ' 太少');
  console.log('样本 ' + all.length + ' 个，' + all[0].date + ' ~ ' + all[all.length - 1].date);

  const years = Array.from(new Set(all.map(function (o) { return o.year; }))).sort();
  console.log('覆盖年份 ' + years.join('/'));

  const TARGET = 'r20';                     // 先看 20 日：历史上它比 45 日更稳
  const AREAS = [0.2, 0.3, 0.45];
  const QS = [0.3, 0.5, 0.65];

  // 逐年滚动：训练只用测试年之前的样本
  const folds = [];
  years.forEach(function (yr) {
    const tr = all.filter(function (o) { return o.year < yr; });
    const te = all.filter(function (o) { return o.year === yr; });
    if (tr.length < 150 || te.length < 15) return;
    const card = fitCard(tr, feats, TARGET);
    folds.push({ year: yr, trainN: tr.length, testN: te.length, card: card, te: te });
  });
  if (folds.length < 3) throw new Error('可用折不足（' + folds.length + '），样本还不够滚动验证');
  console.log('可用验证年份：' + folds.map(function (f) { return f.year + '(' + f.testN + ')'; }).join(' '));

  // 在所有折上联合选参数（一个决定，不是每折挑一个，减少过拟合）
  let best = null;
  AREAS.forEach(function (am) {
    QS.forEach(function (q) {
      const sel = [];
      folds.forEach(function (f) {
        const trainScores = f.te.map(function () { return 0; }); // 占位，下面用训练集分数定阈值
        const trScores = [];
        // 用训练期自身的分数分布定阈值，避免用验证集调参
        const trRows = all.filter(function (o) { return o.year < f.year; });
        trRows.forEach(function (o) { trScores.push(cardScore(f.card, o.x, feats)); });
        const ms = L.quantile(trScores, q);
        f.te.forEach(function (o) {
          if (o.x[0] >= am && cardScore(f.card, o.x, feats) >= ms) sel.push(o);
        });
      });
      const p = perf(sel, TARGET);
      if (p.n < 120) return;
      // 目标：稳健期望（10% 截尾均值），天然惩罚靠个别暴涨拉起来的方案
      if (!best || p.trim > best.p.trim) best = { am: am, q: q, p: p, sel: sel };
    });
  });
  if (!best) throw new Error('没有满足最小样本的参数组合');

  // 基线：现行生产参数 area≥0.3、不打分
  const baseSel = [];
  folds.forEach(function (f) {
    f.te.forEach(function (o) { if (o.x[0] >= 0.3) baseSel.push(o); });
  });
  const bp = perf(baseSel, TARGET);

  // 生产模型：全部样本、年度等权
  const card = fitCard(all, feats, TARGET);
  const allScores = all.map(function (o) { return cardScore(card, o.x, feats); });
  const minScore = +L.quantile(allScores, best.q).toFixed(2);

  // 三个持有期都算一遍，让数据决定持有期（而不是沿用 45 天）
  const holdCmp = {};
  HORIZONS.forEach(function (h) {
    const t = 'r' + h;
    const sel = best.sel;
    const p = perf(sel, t);
    holdCmp[h] = p;
  });
  let hold = 20, bestTrim = -1e9;
  Object.keys(holdCmp).forEach(function (h) {
    if (holdCmp[h].n >= 100 && holdCmp[h].trim > bestTrim) { bestTrim = holdCmp[h].trim; hold = +h; }
  });

  const improve = +(best.p.trim - bp.trim).toFixed(2);

  // 分年表现（用于门禁：不能让某一年单独崩掉）
  const foldStats = folds.map(function (f) {
    const trRows = all.filter(function (o) { return o.year < f.year; });
    const trScores = trRows.map(function (o) { return cardScore(f.card, o.x, feats); });
    const ms = L.quantile(trScores, best.q);
    const sel = f.te.filter(function (o) { return o.x[0] >= best.am && cardScore(f.card, o.x, feats) >= ms; });
    return { year: f.year, trainN: f.trainN, testN: f.te.length, selN: sel.length, perf: perf(sel, TARGET) };
  });
  const badFold = foldStats.filter(function (f) { return f.selN >= 15 && f.perf.win != null && f.perf.win < 45; });

  // 区分度：高分 30% 与低分 30% 的真实差距（排序能力比「平均值」更能说明精准度）
  const topSel = [], botSel = [];
  folds.forEach(function (f) {
    const trRows = all.filter(function (o) { return o.year < f.year; });
    const trScores = trRows.map(function (o) { return cardScore(f.card, o.x, feats); });
    const hi = L.quantile(trScores, 0.7), lo = L.quantile(trScores, 0.3);
    f.te.forEach(function (o) {
      if (o.x[0] < best.am) return;
      const s = cardScore(f.card, o.x, feats);
      if (s >= hi) topSel.push(o);
      else if (s <= lo) botSel.push(o);
    });
  });
  const spread = { top: perf(topSel, TARGET), bottom: perf(botSel, TARGET) };
  spread.gap = (spread.top.trim != null && spread.bottom.trim != null)
    ? +(spread.top.trim - spread.bottom.trim).toFixed(2) : null;

  // 门禁：样本 ≥100、稳健期望优于基线 ≥0.5pp、且没有「单年崩盘」的折
  const adopt = !!(improve >= 0.5 && best.p.n >= 100 && badFold.length === 0);

  const ver = L.versionTag('c' + new Date().toISOString().slice(0, 10) + '-' + best.am + '-' + best.q + '-' + best.p.n);

  const params = {
    version: ver,
    type: 'scorecard',
    trainedAt: new Date().toISOString().slice(0, 19),
    asOf: sig.asOf,
    target: TARGET,
    hold: hold, stop: STOP,
    feats: feats, fdesc: L.FDESC,
    card: card,
    areaMin: best.am, scoreQ: best.q, minScore: minScore,
    oos: best.p, baseline: bp, improve: improve, adopt: adopt,
    holdCmp: holdCmp,
    folds: foldStats,
    spread: spread,
    badFolds: badFold.map(function (f) { return f.year + '(' + f.perf.win + '%)'; }),
    nSignals: all.length,
    universe: sig.universe,
    note: '逐年滚动训练（训练只用当年之前），年度等权防止单一行情主导；目标为 20 日稳健期望。'
      + '采纳条件：样本 ≥100、稳健期望优于基线 ≥0.5pp、且没有单年胜率 <45% 的折；'
      + '任一条不满足就沿用基线参数，不拿没验证过的参数上页面。'
  };
  L.writeJson(PARAM_FILE, params);
  L.appendJsonl(HIST, [{
    at: params.trainedAt, version: ver, areaMin: best.am, scoreQ: best.q, minScore: minScore,
    hold: hold, oos: best.p, baseline: bp, improve: improve, adopt: adopt, folds: folds.length,
    nSignals: all.length
  }]);

  console.log('\n==== 结果 ====');
  console.log('参数：area≥' + best.am + '  分数≥' + minScore + '（训练分布 ' + Math.round(best.q * 100) + '% 分位）  持有 ' + hold + ' 天  止损 ' + STOP + '%');
  console.log('样本外 n=' + best.p.n + '  胜率 ' + best.p.win + '%  中位 ' + best.p.med + '%  均值 ' + best.p.avg + '%  截尾均值 ' + best.p.trim + '%');
  console.log('基线   n=' + bp.n + '  胜率 ' + bp.win + '%  中位 ' + bp.med + '%  均值 ' + bp.avg + '%  截尾均值 ' + bp.trim + '%');
  console.log('提升 ' + improve + ' pp → ' + (adopt ? '采纳新参数'
    : '不采纳（' + [best.p.n < 100 ? '样本' + best.p.n + '<100' : '',
      improve < 0.5 ? '提升' + improve + 'pp<0.5' : '',
      badFold.length ? '崩盘折:' + badFold.map(function (f) { return f.year; }).join(',') : ''
    ].filter(Boolean).join('；') + '）'));
  console.log('区分度：高分30% 截尾 ' + spread.top.trim + '%（胜率 ' + spread.top.win + '%）'
    + ' vs 低分30% 截尾 ' + spread.bottom.trim + '%（胜率 ' + spread.bottom.win + '%）'
    + ' → 差 ' + spread.gap + ' pp');
  console.log('\n各持有期（样本外同组信号）：');
  HORIZONS.forEach(function (h) {
    const p = holdCmp[h];
    console.log('  T+' + h + '  n=' + p.n + ' 胜率 ' + p.win + '% 中位 ' + p.med + '% 截尾 ' + p.trim + '%');
  });
  console.log('\n打分卡（相对基准的超额百分点）：');
  feats.forEach(function (f) {
    const e = card.edges[f], v = card.vals[f];
    const seg = [];
    for (let i = 0; i <= e.length; i++) {
      const lo = i === 0 ? '≤' + e[0] : (i === e.length ? '>' + e[e.length - 1] : e[i - 1] + '~' + e[i]);
      seg.push(lo + ':' + (v[i] >= 0 ? '+' : '') + v[i]);
    }
    console.log('  ' + f.padEnd(10) + '(' + (L.FDESC[f] || '') + ')  ' + seg.join('  '));
  });
  console.log('\n分年验证：');
  params.folds.forEach(function (f) {
    console.log('  ' + f.year + '  训练' + f.trainN + ' 验证' + f.testN + ' → 选中' + f.selN
      + ' 胜率' + (f.perf.win == null ? '-' : f.perf.win + '%')
      + ' 中位' + (f.perf.med == null ? '-' : f.perf.med + '%'));
  });
}

/* ==================== 给实盘台账打分 ==================== */
function scoreLedger() {
  const rows = L.readJsonl(LEDGER);
  if (!rows.length) { console.log('台账为空：还没记录过实盘选股'); return; }
  const O = require('./load_ohlc.js').load();
  const done = new Set(L.readJsonl(LIVE).map(function (r) { return r.date + '|' + r.code; }));
  const add = [];
  rows.forEach(function (r) {
    const key = r.date + '|' + r.code;
    if (done.has(key)) return;
    const m = O.codes[r.code];
    if (!m || !m.bars) return;
    let i = -1;
    for (let j = m.bars.length - 1; j >= 0; j--) if (m.bars[j][0] === r.date) { i = j; break; }
    if (i < 0 || m.bars.length - 1 - i < 20) return;
    const o20 = L.labelOutcome(m.bars, i, 20, STOP);
    if (!o20) return;
    const o45 = L.labelOutcome(m.bars, i, 45, STOP);
    add.push({
      date: r.date, code: r.code, name: r.name, ver: r.ver || '', score: r.score,
      r20: o20.ret, r45: o45 ? o45.ret : null, stop20: o20.stopped ? 1 : 0, done45: !!(o45 && o45.done)
    });
  });
  L.appendJsonl(LIVE, add);
  console.log('新增已评分选股 ' + add.length + ' 条，累计 ' + L.readJsonl(LIVE).length);
}

/* ==================== 报告 ==================== */
function report() {
  const p = L.readJson(PARAM_FILE, null);
  if (!p) { console.log('还没有训练过模型'); return; }
  console.log('模型 ' + p.version + '  训练于 ' + p.trainedAt + '  样本 ' + p.nSignals);
  console.log('参数 area≥' + p.areaMin + ' 分数≥' + p.minScore + ' 持有' + p.hold + '天 止损' + p.stop + '%');
  console.log('样本外 n=' + p.oos.n + ' 胜率' + p.oos.win + '% 中位' + p.oos.med + '% 均值' + p.oos.avg
    + ' | 基线 n=' + p.baseline.n + ' 胜率' + p.baseline.win + '% 中位' + p.baseline.med + '% 均值' + p.baseline.avg
    + ' | ' + (p.adopt ? '已采纳' : '未采纳'));
  const live = L.readJsonl(LIVE);
  if (live.length) {
    const byVer = {};
    live.forEach(function (r) { (byVer[r.ver || 'unknown'] = byVer[r.ver || 'unknown'] || []).push(r); });
    console.log('\n实盘台账（按模型版本，20 日前向）：');
    Object.keys(byVer).forEach(function (v) {
      const a = byVer[v];
      const rr = a.map(function (x) { return x.r20; }).filter(function (x) { return x != null; });
      console.log('  ' + v + '  n=' + a.length + '  均值' + L.mean(rr).toFixed(2) + '%  胜率'
        + (rr.filter(function (x) { return x > 0; }).length / rr.length * 100).toFixed(1) + '%');
    });
  }
}

const cmd = process.argv[2] || 'report';
const map = { bootstrap: bootstrap, train: train, score: scoreLedger, report: report };
if (!map[cmd]) { console.log('用法: bootstrap|train|score|report'); process.exit(1); }
map[cmd]();
