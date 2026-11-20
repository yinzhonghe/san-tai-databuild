'use strict';
/*
 * 自进化 · 底层库
 * ------------------------------------------------------------------
 * 只做四件事，全部基于真实数据，不做估算：
 *   1) 前向收益标注：给定信号日 k，算 T+5/10/20/45 的真实收益、期间最大浮亏 MAE、是否触发止损
 *   2) 特征矩阵：把信号变成可训练的向量（背驰强度 / 距中枢 / 中枢数 / 动量 / 量比 / 指数环境）
 *   3) 岭回归：标准化 + 闭式解，避免小样本下权重爆炸
 *   4) 滚动训练：只用「当时已经发生的」样本训练，检验「之后的」样本 —— 杜绝未来函数
 *
 * 为什么不用深度学习：日频形态信号一年只有几千个，参数量一大必然拟合噪声。
 * 这里最多 9 个特征、线性打分，宁可欠拟合，也不要假精度。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.dirname(__dirname);
const LEARN = path.join(ROOT, 'learn');

function ensure() { if (!fs.existsSync(LEARN)) fs.mkdirSync(LEARN, { recursive: true }); }

function readJson(p, dft) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dft; }
}
function writeJson(p, o) {
  ensure();
  fs.writeFileSync(p, JSON.stringify(o, null, 1));
}
function readJsonl(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; }
}
function appendJsonl(p, rows) {
  ensure();
  if (!rows || !rows.length) return 0;
  fs.appendFileSync(p, rows.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n');
  return rows.length;
}

/* ---------------- 交易日工具 ---------------- */
function ymd(d) { return d.slice(0, 10); }
function daysBetween(a, b) {              // 纯日历日差，仅用于粗筛
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

/* ---------------- 前向收益标注 ---------------- */
/*
 * bars: [[date, open, close, high, low, vol], ...]（与 chan_pick/chan_theory 同口径）
 * 入场：信号日收盘（引擎给出的 p1 就是信号 K 的收盘）
 * 出场：持有 hold 个交易日后收盘；期间盘中最低价触及 stopPct 则按 -stopPct 计（保守：先止损后到期）
 * 返回 null 表示样本不够（还没走完 hold 天）
 */
function labelOutcome(bars, k, hold, stopPct) {
  if (!bars || k < 0 || k >= bars.length) return null;
  const entry = bars[k][2];
  if (!(entry > 0)) return null;
  const end = Math.min(bars.length - 1, k + hold);
  // 必须走满持有期才算标注：否则「T+20」会混进只走了 5 天的样本，
  // 把不同持有期的收益混在一个标签里，训练出来的模型等于在拟合噪声。
  if (end - k < hold) return null;

  let mae = 0, mfe = 0, stopped = false, stopDay = null;
  for (let j = k + 1; j <= end; j++) {
    const b = bars[j];
    const low = b[4] > 0 ? b[4] : b[2];
    const high = b[3] > 0 ? b[3] : b[2];
    const rl = (low / entry - 1) * 100, rh = (high / entry - 1) * 100;
    if (rl < mae) mae = rl;
    if (rh > mfe) mfe = rh;
    if (!stopped && rl <= -stopPct) { stopped = true; stopDay = j - k; break; }
  }
  const ret = stopped ? -stopPct : (bars[end][2] / entry - 1) * 100;
  return {
    ret: +ret.toFixed(2),
    mae: +mae.toFixed(2),
    mfe: +mfe.toFixed(2),
    stopped: stopped,
    stopDay: stopDay,
    hold: end - k,
    done: end - k >= hold                       // 是否走满持有期
  };
}

/* ---------------- 特征 ---------------- */
const FEATS = ['area', 'distCS', 'nCenters', 'csRecent', 'mom60', 'volRatio', 'logPx', 'reg20'];
const FDESC = {
  area: '背驰力度比 C/A（越小越弱，越容易反转）',
  distCS: '信号价距中枢下沿 %（越负=跌得越深）',
  nCenters: '下跌趋势内中枢个数（越多越成熟）',
  csRecent: '此前 500 根 K 内的中枢数（密度）',
  mom60: '信号前 60 日涨跌幅 %（超跌程度）',
  volRatio: '5 日均量 / 60 日均量（恐慌放量）',
  logPx: '价格对数（低价股弹性）',
  reg20: '指数前 20 日涨跌幅 %（市场环境）'
};
function clip(v, a, b) { return Math.max(a, Math.min(b, v)); }

/* indexBars: sh000001 的日线数组，用于 reg20；dateIdx 为 date→i 映射 */
function featureVec(bars, k, s, ctx) {
  const N = bars.length;
  const p = bars[k][2];
  const ZD = s.ZD || 0;
  const i60 = Math.max(0, k - 60);
  const mom60 = bars[i60][2] > 0 ? (p / bars[i60][2] - 1) * 100 : 0;
  let v5 = 0, v60 = 0, n5 = 0, n60 = 0;
  for (let j = Math.max(0, k - 59); j <= k; j++) { v60 += bars[j][5] || 0; n60++; }
  for (let j = Math.max(0, k - 4); j <= k; j++) { v5 += bars[j][5] || 0; n5++; }
  const vr = (n60 && v60 > 0 && n5) ? (v5 / n5) / (v60 / n60) : 1;
  return [
    clip(s.areaRatio == null ? 1 : s.areaRatio, 0, 2.5),
    clip(ZD > 0 ? (p / ZD - 1) * 100 : 0, -35, 12),
    clip(s.nCenters || 1, 1, 6),
    clip(s.csRecent || 0, 0, 30),
    clip(mom60, -70, 60),
    clip(vr, 0.2, 4),
    clip(Math.log10(p > 0 ? p : 1), -1, 2.5),
    clip(ctx && ctx.reg20 != null ? ctx.reg20 : 0, -20, 20)
  ];
}

/* ---------------- 统计小工具 ---------------- */
function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
function median(a) {
  if (!a.length) return 0;
  const b = a.slice().sort(function (x, y) { return x - y; });
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}
function quantile(a, q) {
  if (!a.length) return 0;
  const b = a.slice().sort(function (x, y) { return x - y; });
  const i = clip(q * (b.length - 1), 0, b.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? b[lo] : b[lo] + (b[hi] - b[lo]) * (i - lo);
}
function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
}
function winsor(a, lim) {
  return a.map(function (x) { return clip(x, -lim, lim); });
}

/* ---------------- 标准化 + 岭回归 ---------------- */
function fitScaler(X) {
  const d = X[0].length, mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (let j = 0; j < d; j++) {
    const col = X.map(function (r) { return r[j]; });
    mu[j] = mean(col); sd[j] = stdev(col) || 1;
  }
  return { mu: mu, sd: sd };
}
function applyScaler(X, sc) {
  return X.map(function (r) { return r.map(function (v, j) { return (v - sc.mu[j]) / sc.sd[j]; }); });
}

/* 解 (A + λI) w = b，高斯-约当，维度 ≤ 12 */
function solve(A, b) {
  const n = b.length;
  const M = A.map(function (row, i) { return row.concat([b[i]]); });
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    if (Math.abs(M[piv][i]) < 1e-12) continue;
    const t = M[i]; M[i] = M[piv]; M[piv] = t;
    const pv = M[i][i];
    for (let c = i; c <= n; c++) M[i][c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r][i];
      if (!f) continue;
      for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c];
    }
  }
  return M.map(function (row) { return row[n]; });
}

/* 返回 {w, b, scaler}：y = b + Σ w_j * z_j */
function ridge(X, y, lambda) {
  const sc = fitScaler(X);
  const Z = applyScaler(X, sc);
  const d = Z[0].length;
  const A = [];
  for (let i = 0; i < d; i++) { A.push(new Array(d).fill(0)); }
  const bv = new Array(d).fill(0);
  Z.forEach(function (z, i) {
    for (let a = 0; a < d; a++) {
      bv[a] += z[a] * y[i];
      for (let b = 0; b < d; b++) A[a][b] += z[a] * z[b];
    }
  });
  for (let a = 0; a < d; a++) A[a][a] += lambda;
  const w = solve(A, bv);
  return { w: w, b: mean(y), scaler: sc };
}
function scoreOf(model, x) {
  let s = model.b;
  for (let j = 0; j < model.w.length; j++) s += model.w[j] * ((x[j] - model.scaler.mu[j]) / model.scaler.sd[j]);
  return s;
}

/* ---------------- 指数环境 ---------------- */
function loadIndexHist() { return readJson(path.join(LEARN, 'index_hist.json'), { asOf: '', bars: [] }); }

/* ---------------- 打分卡打分（与 evolve_chan 训练时同口径） ---------------- */
function cardScore(card, x, feats) {
  let s = card.base;
  for (let j = 0; j < feats.length; j++) {
    const f = feats[j], e = card.edges[f] || [], v = x[j];
    let b = 0; while (b < e.length && v > e[b]) b++;
    s += ((card.vals[f] || [])[b] || 0);
  }
  return s;
}

/* ---------------- 版本号 ---------------- */
function versionTag(s) {
  const h = require('crypto').createHash('sha1').update(JSON.stringify(s)).digest('hex').slice(0, 6);
  return s + '-' + h;
}

module.exports = {
  ROOT, LEARN, ensure, readJson, writeJson, readJsonl, appendJsonl,
  ymd, daysBetween, labelOutcome, FEATS, FDESC, featureVec, clip, cardScore,
  mean, median, quantile, stdev, winsor, fitScaler, applyScaler, ridge, scoreOf,
  solve, loadIndexHist, versionTag
};
