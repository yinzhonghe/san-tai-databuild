/*
 * tools/evolve/pop.js · 种群演化引擎（A/D/M3/M4/M5 定稿）
 * ==============================================================
 * AlphaZero 式闭环（本地实现，诚实标注为「统计演化」非围棋自对弈）：
 *   初始种群 = 六派/现有特征当人类种子 → 每代：
 *     1. Elo 排名（只作繁殖权重，绝不作采纳依据 M3）
 *     2. 交叉/变异：阈值扰动、特征替换、条件增删（自动，不花额度 D）
 *     3. 草图批量变体：骨架+占位符 → 30~50 变体（M4，禁止先看结果倒推）
 *     4. 裁判：kernel.hardGate + settle 信号级净收益 + softJudge（永不说"正确"）
 *     5. 存活者进活体池逐日考核；连续跑输退役；记录血缘
 *   久攻不下：连续3代全灭 → 现场课程（拆子问题/子空间，最多3轮 M2）
 *
 * 文件：learn/evolve/population.json（种群+Elo+血缘）、live_pool.json（活体池）
 * 用法：
 *   node tools/evolve/pop.js --init                    # 用人类种子初始化种群
 *   node tools/evolve/pop.js --generation              # 跑一代（本地裁判）
 *   node tools/evolve/pop.js --variants <sketch.json>  # 草图批量变体
 *   node tools/evolve/pop.js --status                  # 查看种群状态
 */
'use strict';
var fs = require('fs');
var path = require('path');
var R = require('./rules.js');
var FEAT = require('./features.js');
var K = require('./kernel.js');
var S = require('./settle.js');
var EXPR = require('./expr.js');

var ROOT = path.dirname(path.dirname(__dirname));
var EVO = path.join(ROOT, 'learn', 'evolve');
var POP = path.join(EVO, 'population.json');
var LIVE = path.join(EVO, 'live_pool.json');
var CONST = path.join(EVO, 'constitution.json');
function loadJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function saveJSON(p, o) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); }
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function cons() { return loadJSON(CONST, {}); }
function today() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }

/* 人类种子：六派/现有特征里「直觉上合理」的规则，仅作起点，不是答案 */
var HUMAN_SEEDS = [
  { id: 'seed_volSqueeze', desc: '[人类种子] 波动收缩+温和放量', when: [
    { f: 'volSqueeze20', op: '<', v: 0.9 }, { f: 'volRatio5', op: 'between', lo: 1.0, hi: 2.2 }],
    expect: 'up', deps: ['high', 'low', 'close', 'volume'], origin: 'human_seed' },
  { id: 'seed_pullback', desc: '[人类种子] 20日高点回撤5~15%+缩量', when: [
    { f: 'pullback20', op: 'between', lo: -15, hi: -5 }, { f: 'volSqueeze20', op: '<', v: 0.95 }],
    expect: 'up', deps: ['high', 'close'], origin: 'human_seed' },
  { id: 'seed_breakout', desc: '[人类种子] 逼近20日高点+量能温和', when: [
    { f: 'breakout20', op: 'between', lo: -3, hi: 0 }, { f: 'volRamp', op: '>', v: 1.05 }],
    expect: 'up', deps: ['high', 'close', 'volume'], origin: 'human_seed' },
  { id: 'seed_ma', desc: '[人类种子] 站在60日线上方+短期回踩', when: [
    { f: 'maGap60', op: '>', v: 0 }, { f: 'maGap20', op: 'between', lo: -2, hi: 1 }],
    expect: 'up', deps: ['close'], origin: 'human_seed' }
];

function init() {
  var elo = (cons().elo || {});
  var pop = { version: '2.0', bornAt: today(), generation: 0,
    rules: HUMAN_SEEDS.map(function (r) {
      return Object.assign({}, r, { status: 'seed', elo: elo.initialRating || 1500,
        bornGen: 0, parentIds: [], lineage: [], hash: null });
    }),
    history: [], trialTotal: 0 };
  saveJSON(POP, pop);
  return pop;
}

/* 交叉/变异：从存活者生成新候选（自动，不调 LLM） */
function mutate(parents, n) {
  var allFeats = Object.keys(FEAT.META);
  var ops = ['>', '<', 'between'];
  var out = [];
  var seed = parents.length ? parents : HUMAN_SEEDS;
  for (var i = 0; i < n; i++) {
    var p = seed[Math.floor(Math.random() * seed.length)];
    var conds = (p.when || []).map(function (c) { return Object.assign({}, c); });
    var opType = ['threshold', 'feature', 'drop', 'add'][Math.floor(Math.random() * 4)];
    var mutated = false;
    if (conds.length && opType === 'threshold' && isNum(conds[0].v)) {
      var jitter = 1 + (Math.random() - 0.5) * 0.3;
      conds[0].v = +(conds[0].v * jitter).toFixed(3); mutated = true;
    } else if (conds.length && opType === 'feature') {
      var idx = Math.floor(Math.random() * conds.length);
      var f2 = allFeats[Math.floor(Math.random() * allFeats.length)];
      if (f2 !== conds[idx].f) { conds[idx].f = f2; conds[idx].op = ops[Math.floor(Math.random() * ops.length)];
        if (conds[idx].op === 'between') { conds[idx].lo = -5; conds[idx].hi = 5; delete conds[idx].v; }
        else { conds[idx].v = 0; delete conds[idx].lo; delete conds[idx].hi; }
        mutated = true; }
    } else if (conds.length > 1 && opType === 'drop') {
      conds.splice(Math.floor(Math.random() * conds.length), 1); mutated = true;
    } else if (opType === 'add') {
      var nf = allFeats[Math.floor(Math.random() * allFeats.length)];
      conds.push({ f: nf, op: '>', v: 0 }); mutated = true;
    }
    if (!mutated && conds.length) { conds[0].v = +(conds[0].v + (Math.random() - 0.5)).toFixed(3); }
    if (!conds.length) conds = [{ f: 'ret5', op: '>', v: 0 }];
    out.push({ id: 'mut_g' + today().replace(/-/g, '') + '_' + i + '_' + Math.random().toString(36).slice(2, 6),
      desc: '[变异] ' + (p.desc || p.id), when: conds, expect: 'up',
      deps: p.deps || [], origin: 'mutation',
      parentIds: [p.id], lineage: (p.lineage || []).concat([p.id]) });
  }
  return out;
}

/* 草图批量变体（M4）：骨架带占位符 {f:..., op:'>', v:'@P1'} → 阈值网格展开 30~50 个
   红线：变体在 kernel 之前生成，绝不看结算结果倒推条件。 */
function expandSketch(sketch) {
  var out = [];
  var placeholders = [];
  (sketch.when || []).forEach(function (c, i) {
    if (typeof c.v === 'string' && /^@P\d+$/.test(c.v)) placeholders.push({ cond: i, name: c.v });
    if (c.op === 'between' && (typeof c.lo === 'string' || typeof c.hi === 'string')) {
      placeholders.push({ cond: i, name: 'between' });
    }
  });
  var grid = sketch.grid || [-2, -1, -0.5, -0.25, 0, 0.25, 0.5, 1, 2];
  function walk(k, conds) {
    if (k >= placeholders.length) {
      out.push(Object.assign({}, sketch, { id: sketch.id + '_v' + out.length,
        when: conds, origin: 'sketch_variant',
        parentIds: sketch.parentIds || [], lineage: (sketch.lineage || []).concat([sketch.id]) }));
      return;
    }
    var ph = placeholders[k];
    grid.forEach(function (g) {
      var c2 = conds.map(function (c) { return Object.assign({}, c); });
      if (ph.name === 'between') {
        c2[ph.cond].lo = +(g * 5 - 2.5).toFixed(3);
        c2[ph.cond].hi = +(g * 5 + 2.5).toFixed(3);
      } else {
        c2[ph.cond].v = g;
      }
      walk(k + 1, c2);
    });
  }
  walk(0, (sketch.when || []).map(function (c) { return Object.assign({}, c); }));
  return out.slice(0, 50);  // 上限 50 变体（M4 定稿 30~50）
}

/* Elo 更新：只作繁殖权重（M3），绝不作采纳依据 */
function eloUpdate(ratingA, ratingB, scoreA) {
  var K = 32;
  var expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return Math.round(ratingA + K * (scoreA - expectedA));
}

/* 一代演化：hard kernel → 结算 → soft judge → 存活/退役 → 血缘 → Elo
   populate 模式：不依赖 LLM，用人类种子 + 自动变异（LLM 候选由 evolve_v2_llm.py 另行注入） */
function generation(opts) {
  opts = opts || {};
  var seal = K.verifySeal();
  if (!seal.ok) return Promise.reject(new Error('constitution 未封印或被篡改，拒绝运行'));
  var pop = loadJSON(POP, null) || init();
  var c = cons();
  var maxVariants = (c.budget || {}).llmCallsPerDayMax || 1;  // 占位：本地变异数不受此限
  var stage = pop.rules.filter(function (r) { return ['seed', 'shadow', 'mutation', 'sketch_variant'].indexOf(r.status) >= 0; });
  var candidates = mutate(pop.rules.filter(function (r) { return r.status === 'active' || r.status === 'shadow'; }), 20);
  var all = stage.concat(candidates);
  var evaluated = [];
  var total = 0;

  function evalOne(rule) {
    return S.settleStream(rule).then(function (s) {
      total++;
      var hard = K.hardGate(rule, {});
      var soft = K.softJudge(s, c);
      rule.lastMetrics = s;
      rule.hardGate = hard.verdict;
      rule.softJudge = soft.verdict;
      rule.tStat = s.tStat;
      rule.status = (hard.pass && soft.verdict === 'NOT_REFUTED') ? 'active' : 'shadow';
      evaluated.push(rule);
      return rule;
    });
  }
  return Promise.all(all.map(evalOne)).then(function () {
    // Elo 锦标赛：按校正净收益两两比较，只更新繁殖权重
    var active = evaluated.filter(function (r) { return r.status === 'active'; });
    for (var i = 0; i < active.length; i++) {
      for (var j = i + 1; j < active.length; j++) {
        var a = active[i], b = active[j];
        var sa = (a.lastMetrics.netRet3 || 0) >= (b.lastMetrics.netRet3 || 0) ? 1 : 0;
        a.elo = eloUpdate(a.elo || 1500, b.elo || 1500, sa);
        b.elo = eloUpdate(b.elo || 1500, a.elo || 1500, 1 - sa);
      }
    }
    pop.generation++;
    pop.rules = evaluated;
    pop.trialTotal = K.bumpTrial(candidates.length);
    pop.history.push({ at: today(), gen: pop.generation, evaluated: evaluated.length,
      active: active.length, trialTotal: pop.trialTotal });
    if (pop.history.length > 60) pop.history = pop.history.slice(-60);
    saveJSON(POP, pop);
    // 活体池：active 规则逐日考核
    var live = loadJSON(LIVE, { rules: [], history: [] });
    active.forEach(function (r) {
      var ex = live.rules.filter(function (x) { return x.id === r.id; })[0];
      if (!ex) live.rules.push({ id: r.id, bornAt: today(), loseStreak: 0, lastNet: r.lastMetrics.netRet3, elo: r.elo });
      else { ex.lastNet = r.lastMetrics.netRet3; ex.elo = r.elo; }
    });
    // 退役：连续 N 天净收益为负
    var losingDays = (c.rollback || {}).consecutiveLosingDays || 3;
    live.rules = live.rules.filter(function (x) {
      x.loseStreak = (x.lastNet != null && x.lastNet < 0) ? (x.loseStreak || 0) + 1 : 0;
      if (x.loseStreak >= losingDays) { x.status = 'retired'; return false; }
      return true;
    });
    live.history.push({ at: today(), active: active.length, live: live.rules.length });
    saveJSON(LIVE, live);
    // 久攻不下：连续3代全灭 → 建议现场课程（由 orchestrator 决定是否触发 LLM 加练）
    var recent = pop.history.slice(-3);
    var allWiped = recent.length === 3 && recent.every(function (h) { return h.active === 0; });
    return { generation: pop.generation, evaluated: evaluated.length, active: active.length,
      shadow: evaluated.length - active.length, allWiped: allWiped,
      trialTotal: pop.trialTotal, livePool: live.rules.length,
      top: active.slice().sort(function (a, b) { return b.elo - a.elo; }).slice(0, 5).map(function (r) {
        return { id: r.id, elo: r.elo, netRet3: r.lastMetrics.netRet3, t: r.tStat }; }) };
  });
}

function main() {
  var args = process.argv.slice(2);
  if (args[0] === '--init') { console.log('初始化:', JSON.stringify(init().rules.length) + ' 个人类种子'); return; }
  if (args[0] === '--status') {
    var p = loadJSON(POP, {});
    console.log(JSON.stringify({ generation: p.generation, rules: (p.rules || []).length,
      active: (p.rules || []).filter(function (r) { return r.status === 'active'; }).length,
      trialTotal: p.trialTotal }, null, 2)); return;
  }
  if (args[0] === '--variants') {
    var sk = loadJSON(args[1], null);
    if (!sk) { console.error('草图读取失败'); process.exit(1); }
    var vs = expandSketch(sk);
    console.log(JSON.stringify({ count: vs.length, ids: vs.map(function (v) { return v.id; }) }, null, 2)); return;
  }
  if (args[0] === '--generation') { generation().then(function (r) { console.log(JSON.stringify(r, null, 2)); }).catch(function (e) { console.error('ERR', e.message); }); return; }
  console.log('用法: --init | --generation | --variants <sketch.json> | --status');
}
if (require.main === module) main();
module.exports = { init: init, generation: generation, mutate: mutate, expandSketch: expandSketch,
  eloUpdate: eloUpdate, HUMAN_SEEDS: HUMAN_SEEDS };
