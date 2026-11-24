#!/usr/bin/env node
/*
 * tools/compute_engine.js
 * ------------------------------------------------------------------
 * 由 build_data.py 调用：用【真实的 six-engine.js】+【data.js 内嵌的 engine】
 * 批量重算六派分数 / 三态 / 结构阶段等，保证"单一真相源"，不在 Python 侧重写公式。
 *
 * 用法：
 *   node compute_engine.js <inputs.json> <outputs.json>
 *
 * inputs.json  : [{code,name,kind,tier,pct,series,themes,ind,rank}, ...]
 * outputs.json : { "<code>": {scores,state,resonance,negVotes,need,stage,
 *                   structRaw,rrg,quad,structConf,rsRatio,rsMomentum,wyckoff,
 *                   veto,action,strong,newsHits,votes}, ... }
 */
'use strict';
var fs = require('fs');
var path = require('path');
var SIX = null;   // 模块级：stateDaysOf 等辅助函数也要用它

function findData() {
  var cands = [
    path.join(__dirname, 'data.js'),
    path.join(__dirname, '..', 'data.js'),
    path.join(__dirname, 'site', 'data.js'),
    path.join(__dirname, '..', 'site', 'data.js')
  ];
  for (var i = 0; i < cands.length; i++) {
    if (fs.existsSync(cands[i])) return cands[i];
  }
  return null;
}

/* 区间涨跌幅（与 live-refresh.js computePct 同式），用于逐日回溯重算 */
function pctOf(closes, c250) {
  var n = closes.length, last = closes[n - 1];
  function r(b) {
    if (n < b + 1) return null;
    var a = closes[n - 1 - b];
    return a ? Math.round((last / a - 1) * 100 * 10000) / 10000 : null;   // 注意 ×100 转成百分数
  }
  var w250 = r(250);
  if (w250 == null && c250) w250 = Math.round((last / c250 - 1) * 100 * 10000) / 10000;
  return { w5: r(5), w20: r(20), w60: r(60), w250: w250 };
}

/* 当前三态「已经持续几个交易日」：
 * 从最近一天往前，用【真实引擎】逐日重算，状态一旦不同就停。
 * 这是「启动日期」的唯一口径来源（列表 / 抽屉 / 方法论都读它），
 * 避免出现「列表说起于 A、详情说起于 B」的不一致。 */
function stateDaysOf(input, curState, DATA, maxBack) {
  /* 必须用较长的序列（120 根）：若只用 61 根，回溯一根后 w60 就缺值，
     引擎会把 null 当 0，导致「第一天就状态不同」，全部算成 1 天。 */
  var cs = (Array.isArray(input.closesFull) && input.closesFull.length > 70)
    ? input.closesFull : input.closes;
  var days = 1;
  if (!Array.isArray(cs) || cs.length < 30) return { days: 1, capped: false };
  for (var k = 1; k <= maxBack; k++) {
    var end = cs.length - k;          // 用 cs[0..end-1] 作为「k 个交易日前」的已知序列
    if (end < 26) break;
    var probe = Object.create(input);
    probe.closes = cs.slice(0, end);
    probe.pct = pctOf(probe.closes, input.c250);
    var st;
    try { st = SIX.analyze(probe, DATA).state; } catch (e) { break; }
    if (st !== curState) break;
    days++;
  }
  return { days: days, capped: days > maxBack };
}

function main() {
  var inPath = process.argv[2];
  var outPath = process.argv[3];
  if (!inPath || !outPath) {
    console.error('用法: node compute_engine.js <inputs.json> <outputs.json>');
    process.exit(2);
  }
  var dataFile = findData();
  /* 首次构建（仓库里还没有 data.js）时不能直接退出 —— 那样整条流水线会在
     「数据都拉好了、只差算引擎」这一步挂掉。此时用空基准继续，
     真正的全市场基准 bm 由 build_data.py 在 Python 侧算好后写进最终 data.js。 */
  var AB_DATA = { engine: {}, meta: {}, rows: [] };
  if (dataFile) {
    global.window = {};
    var code = fs.readFileSync(dataFile, 'utf8')
      .replace(/^﻿/, '')
      .replace(/window\.AB_DATA\s*=/, 'global.window.AB_DATA =');
    // eslint-disable-next-line no-eval
    (0, eval)(code);
    AB_DATA = global.window.AB_DATA || AB_DATA;
  } else {
    /* 首次构建没有 data.js。引擎需要 engine.ind（行业表）/ thresholds（判定阈值）/
       rankTable / temp 等一整套配置，光兜底成 {} 会在 six-engine.js:138
       「E.ind[ind]」处抛错（ind 为空串 → undefined['']）。
       所以仓库里随带一份 _engine_cfg.json（从正式 data.js 导出，21KB），
       用它作为引擎配置，保证判定口径与线上完全一致。 */
    var cfgPath = path.join(__dirname, '_engine_cfg.json');
    if (!fs.existsSync(cfgPath)) cfgPath = path.join(__dirname, '..', '_engine_cfg.json');
    var usedCfg = false;
    if (fs.existsSync(cfgPath)) {
      try {
        var cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        AB_DATA = {
          engine: cfg.engine || {}, meta: {}, rows: [],
          themeAgg: [], themes: [], themeKeywords: [],
          voteDef: cfg.voteDef || [], indexStates: []
        };
        usedCfg = true;
        console.error('[info] 首次构建：用 _engine_cfg.json 作为引擎配置（含行业表/阈值）');
      } catch (e2) {
        console.error('[warn] _engine_cfg.json 解析失败：' + (e2 && e2.message));
      }
    }
    if (!usedCfg) console.error('[warn] 首次构建：未找到 data.js 与 _engine_cfg.json，用空基准继续');
  }
  /* 引擎配置兜底（2026-11 事故）：现有 data.js 的 engine 常被裁成只剩 bm，
     直接拿它重算会让 E.thresholds[kind] / E.voteDead 变 undefined，
     six-engine 抛错后被本文件 catch 静默跳过 → 产出 0 只。
     所以无论 data.js 是否存在，都先以 _engine_cfg.json 为配置基线补齐；
     data.js 里的同名字段（如最新 bm / ind）覆盖基线。 */
  (function ensureEngineCfg() {
    var cfgPath = path.join(__dirname, '_engine_cfg.json');
    if (!fs.existsSync(cfgPath)) cfgPath = path.join(__dirname, '..', '_engine_cfg.json');
    if (!fs.existsSync(cfgPath)) return;
    try {
      var cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      var base = (cfg && cfg.engine) || {};
      var cur = AB_DATA.engine || {};
      Object.keys(base).forEach(function (k) {
        if (cur[k] === undefined || cur[k] === null) cur[k] = base[k];
      });
      AB_DATA.engine = cur;
    } catch (e) {
      console.error('[warn] 补齐引擎配置失败：' + (e && e.message));
    }
  })();
  // six-engine.js 在站点根目录（tools/ 的上一级）
  var sixPath = path.join(__dirname, '..', 'six-engine.js');
  if (!fs.existsSync(sixPath)) sixPath = path.join(__dirname, 'six-engine.js');
  SIX = require(sixPath);

  var items = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  /* 首次构建没有 data.js 时，AB_DATA.engine.bm 不存在。
     bm 是 RRG 的相对强度基准（全市场 20/60 日涨幅中位数），
     缺了它每只 analyze 都会抛错 → 全部被跳过 → 最终组装 0 只。
     这里按同一口径（中位数）就地估算，与 build_data.py 侧算法一致。 */
  (function ensureBm() {
    /* 首次构建 AB_DATA 是空壳。six-engine 直接读 DATA.engine / DATA.themeAgg /
       DATA.meta 这些字段：themeAgg 为 undefined 时，第 147 行 AG[k] 就会抛
       「Cannot read properties of undefined」，导致每只票都算不出来。
       这里一次性把所有依赖的容器补齐，缺哪个都不会再炸。 */
    AB_DATA.engine = AB_DATA.engine || {};
    AB_DATA.themeAgg = AB_DATA.themeAgg || [];
    AB_DATA.themeKeywords = AB_DATA.themeKeywords || [];
    AB_DATA.themes = AB_DATA.themes || [];
    AB_DATA.rows = AB_DATA.rows || [];
    AB_DATA.voteDef = AB_DATA.voteDef || [];
    AB_DATA.indexStates = AB_DATA.indexStates || [];
    AB_DATA.meta = AB_DATA.meta || {};
    if (AB_DATA.meta.asOfCore == null) AB_DATA.meta.asOfCore = '';
    if (AB_DATA.meta.asOfExt == null) AB_DATA.meta.asOfExt = '';
    if (AB_DATA.engine.bm && AB_DATA.engine.bm.m20 != null) return;
    var w20 = [], w60 = [];
    items.forEach(function (it) {
      var pp = it.pct || {};
      if (pp.w20 != null) w20.push(pp.w20);
      if (pp.w60 != null) w60.push(pp.w60);
    });
    function med(a) {
      if (!a.length) return 0;
      a.sort(function (x, y) { return x - y; });
      var n = a.length;
      return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
    }
    AB_DATA.engine.bm = { m20: med(w20), m60: med(w60) };
    console.error('[info] 无 data.js，bm 就地估算 m20=' + AB_DATA.engine.bm.m20.toFixed(2) + ' m60=' + AB_DATA.engine.bm.m60.toFixed(2));
  })();
  var out = {};
  var errs = 0, firstErr = null;
  items.forEach(function (it, idx) {
   try {
    var input = {
      code: it.code, name: it.name, kind: it.kind, tier: it.tier,
      pct: it.pct, series: it.series, themes: it.themes || [],
      ind: it.ind, rank: it.rank,
      closes: it.closes,            // 真实收盘序列 → 量价派算唐奇安/MACD/RSI
      c250: it.c250,                // 250 日前收盘，供回溯重算年线
      chan: it.chan,                // 缠论：中枢/笔/背驰（结构派用）
      closesFull: it.closesFull,    // 120 根，仅用于回溯状态天数
      turnover: it.turnover,
      // ETF 无量净流入，用量能比（近5/近20）作资金活跃度代理，引擎会据价方向定号
      volRatio: it.volRatio,
      // ETF 金额量能比（量×代表价还原），优先于纯份额量比；仍不是主力净流入
      amtRatio: it.amtRatio,
      // 传了真实主力净流入就让引擎走「个股自身资金」分支，否则回落到行业代理
      fund: it.fund, fundSelf: it.fund != null
    };
    var o = SIX.analyze(input, AB_DATA);
    var sd = stateDaysOf(input, o.state, AB_DATA, 45);
    out[it.code] = {
      stateDays: sd.days, stateCapped: sd.capped,
      scores: o.scores, state: o.state, resonance: o.resonance,
      negVotes: o.negVotes, need: o.need, stage: o.stage,
      structRaw: o.structRaw, rrg: o.rrg, quad: o.quad,
      structConf: o.structConf, rsRatio: o.rsRatio, rsMomentum: o.rsMomentum,
      wyckoff: o.wyckoff, veto: o.veto, action: o.action,
      strong: o.strong, newsHits: o.newsHits, votes: o.votes,
      series: o.series, dataFlags: o.dataFlags, cat: o.cat,
      ind: o.ind, fundLabel: o.fundLabel, fundProxy: o.fundProxy, amtRatio: it.amtRatio,
      fund3d: o.fund3d
    };
   } catch (e) {
      errs++;
      /* 只打 message 无法定位（如 "Cannot read properties of undefined (reading '')"）。
         这里带上堆栈前 3 行，能直接看到是 six-engine 的哪一行爆的。 */
      var _st = (e && e.stack)
        ? String(e.stack).split('\n').slice(0, 3).map(function (x) { return x.trim(); }).join(' ‖ ')
        : String(e);
      if (!firstErr) firstErr = it.code + ' ' + (it.name || '') + ' → ' + _st;
      if (errs <= 3) console.error('[skip] ' + it.code + ' → ' + _st);
    }
  });
  if (errs) console.error('[warn] 引擎跳过 ' + errs + ' 只，首个错误：' + firstErr);
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log('compute_engine: 已重算 %d 只', items.length);
}

main();
