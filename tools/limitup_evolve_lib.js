'use strict';
/*
 * tools/limitup_evolve_lib.js
 * ------------------------------------------------------------------
 * 「启动·新发 → 涨停」打分卡的自进化内核（与缠论一买的 learn/* 完全独立）。
 *
 * 原则（与项目一贯口径一致）：
 *   1. 只用信号当日可见的特征调参，hit5 仅用于事后评估；
 *   2. 训练/验证按时间切分，训练用较早窗口、验证用最近成熟窗口，不做随机打散；
 *   3. 每次最多动 2 个因子、每个 ±0.5，且必须通过时间外验证门槛才采纳，防止过拟合；
 *   4. 权重范围 0.5~1.5，默认全 1 → 满分 11，与页面既有 0-11 分口径和历史分档统计一致；
 *   5. 每次运行都留痕（检查/采纳/拒绝 + 原因），参数写不进去就退回旧版，不产生半成品。
 */
var fs = require('fs');
var path = require('path');

var HOME = path.dirname(__dirname);
var PF = path.join(HOME, 'learn', 'limitup_params.json');
var FACTORS = ['chg', 'amp', 'pos', 'vol', 'mid', 'board'];
var FDESC = {
  chg: '当日涨幅甜区', amp: '当日振幅', pos: '60日位置',
  vol: '量能代理(振幅比)', mid: '中期动能', board: '主板优先'
};
var DEFAULT = { chg: 1, amp: 1, pos: 1, vol: 1, mid: 1, board: 1 };
var MINW = 0.5, MAXW = 1.5, STEP = 0.5;

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function r1(v) { return Math.round(v * 10) / 10; }
function pct(n, h) { return n ? r1(h / n * 100) : 0; }
function maxPart(k) { return k === 'board' ? 1 : 2; }

function freshParams(asOf) {
  return {
    version: 'l' + (asOf || new Date().toISOString().slice(0, 10)) + '-0',
    type: 'limitup_scorecard',
    trainedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
    asOf: asOf || '', target: 'hit5',
    weights: clone(DEFAULT),
    checks: 0, adoptions: 0,
    lastCheck: '', lastAction: 'init', lastReason: '初始参数，来自全历史归因统计',
    history: []
  };
}

/** 读参数；缺文件/损坏时回默认。旧版 0~2 权重自动折算到 0.5~1.5，保留检查记录。 */
function load(asOf) {
  try {
    var p = JSON.parse(fs.readFileSync(PF, 'utf8'));
    if (!p || p.type !== 'limitup_scorecard' || !p.weights) throw new Error('bad params');
    var legacy = FACTORS.some(function (k) { return Number(p.weights[k]) > MAXW; });
    FACTORS.forEach(function (k) {
      var v = Number(p.weights[k]);
      if (!isFinite(v)) throw new Error('bad weight ' + k);
      if (legacy) v = v / 2;                       // 2→1，1→0.5（早期草稿的旧量级）
      v = Math.max(MINW, Math.min(MAXW, Math.round(v / STEP) * STEP));
      p.weights[k] = r1(v);
    });
    if (Object.keys(p.weights).every(function (k) { return p.weights[k] <= 0; })) throw new Error('all zero');
    p.checks = Number(p.checks) || 0;
    p.adoptions = Number(p.adoptions) || 0;
    if (!Array.isArray(p.history)) p.history = [];
    return p;
  } catch (e) {
    return freshParams(asOf);
  }
}

function save(p) {
  fs.mkdirSync(path.dirname(PF), { recursive: true });
  var tmp = PF + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p, null, 1) + '\n');
  fs.renameSync(tmp, PF);
}

/** 按权重打分。阈值固定（保持语义稳定），只有权重进化。 */
function scoreParts(f, w) {
  var a = f.chg1, parts = {};
  parts.chg = (a >= 5 && a < 7) ? 2 : ((a >= 3 && a < 5) || (a >= 7 && a < f.lim)) ? 1 : 0;
  parts.amp = f.amp >= 7 ? 2 : f.amp >= 5 ? 1 : 0;
  parts.pos = f.pos60 != null ? (f.pos60 >= 0.85 ? 2 : f.pos60 >= 0.5 ? 1 : 0) : 0;
  parts.vol = f.ampRatio != null ? (f.ampRatio >= 1.3 ? 2 : f.ampRatio >= 1.1 ? 1 : 0) : 0;
  parts.mid = (f.chg20 >= 15 && f.chg60 >= 25) ? 2 : (f.chg20 >= 10 || f.chg60 >= 15) ? 1 : 0;
  parts.board = f.kind === 'main' ? 1 : 0;
  var sc = 0;
  FACTORS.forEach(function (k) { sc += parts[k] * (w[k] || 0); });
  return { score: sc, parts: parts };
}

function maxScoreOf(w) {
  return r1(FACTORS.reduce(function (s, k) { return s + (w[k] || 0) * maxPart(k); }, 0));
}

/** 分档切点：默认满分 11 时得到 9/7/5，与页面既有档位完全一致。 */
function cutoffs(w) {
  var m = maxScoreOf(w);
  return {
    max: m,
    t3: Math.max(2, Math.round(m * 0.80)),
    t2: Math.max(1, Math.round(m * 0.63)),
    t1: Math.max(1, Math.round(m * 0.45))
  };
}
function tierIndex(score, cut) {
  return score >= cut.t3 ? 3 : score >= cut.t2 ? 2 : score >= cut.t1 ? 1 : 0;
}

/** 分档命中率 + 单调性惩罚（低档命中率高于高档的幅度之和，百分点）。 */
function evaluate(signals, w) {
  var cut = cutoffs(w);
  var b = [{ n: 0, h: 0 }, { n: 0, h: 0 }, { n: 0, h: 0 }, { n: 0, h: 0 }];
  for (var i = 0; i < signals.length; i++) {
    var x = signals[i], sc = 0;
    for (var j = 0; j < FACTORS.length; j++) {
      var k = FACTORS[j];
      sc += ((x.parts || {})[k] || 0) * (w[k] || 0);
    }
    var idx = tierIndex(sc, cut);
    b[idx].n++; b[idx].h += x.hit5 ? 1 : 0;
  }
  var rates = b.map(function (o) { return pct(o.n, o.h); });
  var penalty = 0;
  for (var m = 0; m < 3; m++) penalty += Math.max(0, rates[m] - rates[m + 1]);
  return {
    buckets: b, rates: rates, cut: cut,
    topN: b[3].n, topRate: rates[3], penalty: r1(penalty),
    objective: r1(rates[3] - 0.5 * penalty)
  };
}

/** 训练窗口里各因子的边际提升（满分档 vs 0 分档的 T+5 涨停率差）。 */
function liftsOf(signals) {
  var out = {};
  FACTORS.forEach(function (k) {
    var hi = { n: 0, h: 0 }, lo = { n: 0, h: 0 }, full = maxPart(k);
    for (var i = 0; i < signals.length; i++) {
      var x = signals[i], v = (x.parts || {})[k] || 0;
      if (v >= full) { hi.n++; hi.h += x.hit5 ? 1 : 0; }
      else if (v === 0) { lo.n++; lo.h += x.hit5 ? 1 : 0; }
    }
    out[k] = hi.n >= 100 && lo.n >= 100 ? r1(pct(hi.n, hi.h) - pct(lo.n, lo.h)) : 0;
  });
  return out;
}

/**
 * 训练 + 时间外验证。dates 为全局交易日升序数组；末尾 5 日未来窗口不足，不参与评估。
 */
function train(signals, dates, params, asOf) {
  var log = { checked: 0, reason: '', changed: [],
    trainN: 0, validN: 0, trainOld: null, trainNew: null, validOld: null, validNew: null };
  var matureIdx = Math.max(0, dates.length - 6);
  if (matureIdx < 120) { log.reason = '成熟交易日不足（' + (matureIdx + 1) + '天），跳过'; return { params: params, log: log }; }

  var validStart = dates[Math.max(0, matureIdx - 249)];
  var trainStart = dates[Math.max(0, matureIdx - 999)];
  var trainSet = [], validSet = [];
  for (var i = 0; i < signals.length; i++) {
    var x = signals[i];
    if (x.date >= validStart && x.date <= dates[matureIdx]) validSet.push(x);
    else if (x.date >= trainStart && x.date < validStart) trainSet.push(x);
  }
  log.trainN = trainSet.length; log.validN = validSet.length;
  if (trainSet.length < 2000 || validSet.length < 1000) {
    log.reason = '训练/验证样本不足（' + trainSet.length + '/' + validSet.length + '），跳过';
    return { params: params, log: log };
  }

  var w0 = clone(params.weights);
  var oldTrain = evaluate(trainSet, w0), oldValid = evaluate(validSet, w0);
  log.trainOld = oldTrain.objective; log.validOld = oldValid.objective;
  log.validTopOld = oldValid.topRate;

  // 冷却：距上次采纳至少 5 个交易日
  var lastAdoptDate = '';
  (params.history || []).slice().reverse().some(function (h) {
    if (h.action === 'adopt') { lastAdoptDate = h.date || ''; return true; }
    return false;
  });
  if (lastAdoptDate) {
    var di = dates.indexOf(lastAdoptDate), ai = dates.indexOf(asOf);
    if (di >= 0 && ai >= 0 && ai - di < 5) {
      log.reason = '距上次调参不足5个交易日，保持当前参数';
      return { params: params, log: log };
    }
  }

  // 候选：朝训练窗口实测方向调整，每次最多 2 个因子、每个 ±0.5
  var lift = liftsOf(trainSet), want = {};
  FACTORS.forEach(function (k) { want[k] = lift[k] >= 3 ? 1.5 : lift[k] < 1 ? 0.5 : 1; });
  var moves = [];
  FACTORS.forEach(function (k) {
    var d = r1(want[k] - w0[k]);
    if (d) moves.push({ k: k, d: Math.sign(d), gain: Math.abs(lift[k]) + (k === 'board' ? 0.1 : 0) });
  });
  moves.sort(function (a, b) { return b.gain - a.gain; });
  moves = moves.slice(0, 2);
  log.lifts = lift;

  var w1 = clone(w0);
  moves.forEach(function (m) { w1[m.k] = r1(Math.max(MINW, Math.min(MAXW, w1[m.k] + m.d * STEP))); });
  var newTrain = evaluate(trainSet, w1), newValid = evaluate(validSet, w1);
  log.trainNew = newTrain.objective; log.validNew = newValid.objective;
  log.validTopNew = newValid.topRate;
  moves.forEach(function (m) {
    log.changed.push({ factor: m.k, desc: FDESC[m.k], from: w0[m.k], to: w1[m.k], trainLift: lift[m.k] });
  });

  var improved = newValid.objective > oldValid.objective + 0.5;
  var notWorseMono = newValid.penalty <= oldValid.penalty + 0.5;
  var enoughTop = newValid.topN >= 300;
  var trainAgrees = newTrain.objective >= oldTrain.objective - 0.3;
  log.checked = 1;

  if (improved && notWorseMono && enoughTop && trainAgrees && moves.length) {
    var p = clone(params);
    p.weights = w1;
    p.version = 'l' + asOf + '-' + (Number(p.adoptions) + 1);
    p.adoptions = Number(p.adoptions) + 1;
    p.lastAction = 'adopt';
    p.lastReason = '验证集目标分 ' + oldValid.objective + '→' + newValid.objective
      + '，顶部档涨停率 ' + oldValid.topRate + '%→' + newValid.topRate + '%';
    p.asOf = asOf;
    p.trainedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
    p.history = (p.history || []).concat([{
      date: asOf, action: 'adopt', version: p.version, changes: log.changed, reason: p.lastReason,
      trainN: trainSet.length, validN: validSet.length,
      validOld: oldValid.objective, validNew: newValid.objective
    }]).slice(-60);
    log.reason = p.lastReason;
    return { params: p, log: log };
  }

  var why = !improved ? '验证集目标分未提升（' + oldValid.objective + '→' + newValid.objective + '）'
    : !notWorseMono ? '分档单调性变差'
    : !enoughTop ? '最高档样本不足300'
    : !trainAgrees ? '训练集不支持该调整'
    : '无可调整因子';
  var p2 = clone(params);
  p2.lastAction = 'reject';
  p2.lastReason = why;
  p2.asOf = asOf;
  p2.history = (p2.history || []).concat([{
    date: asOf, action: 'reject', version: p2.version, reason: why,
    candidate: log.changed, validOld: oldValid.objective, validNew: newValid.objective
  }]).slice(-60);
  log.reason = why;
  return { params: p2, log: log };
}

/** 每日入口：读 → 训练 → 留痕 → 写回。 */
function run(signals, dates, asOf) {
  var p = load(asOf);
  var r = train(signals, dates, p, asOf);
  var out = r.params;
  out.checks = Number(out.checks) + 1;
  out.lastCheck = new Date().toISOString().slice(0, 16).replace('T', ' ');
  if (!r.log.checked) {
    out.history = (out.history || []).concat([{
      date: asOf, action: 'skip', version: out.version, reason: r.log.reason
    }]).slice(-60);
  }
  try { save(out); } catch (e) { console.log('  [警告] 参数写回失败，沿用内存参数：' + e.message); }
  return { params: out, log: r.log };
}

module.exports = {
  PF: PF, FACTORS: FACTORS, FDESC: FDESC, DEFAULT: DEFAULT,
  load: load, save: save, scoreParts: scoreParts, evaluate: evaluate,
  maxScoreOf: maxScoreOf, cutoffs: cutoffs, tierIndex: tierIndex,
  train: train, run: run
};
