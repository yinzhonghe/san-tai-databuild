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
  if (!dataFile) { console.error('找不到 data.js'); process.exit(3); }

  global.window = {};
  var code = fs.readFileSync(dataFile, 'utf8')
    .replace(/^﻿/, '')
    .replace(/window\.AB_DATA\s*=/, 'global.window.AB_DATA =');
  // eslint-disable-next-line no-eval
  (0, eval)(code);
  var AB_DATA = global.window.AB_DATA;
  // six-engine.js 在站点根目录（tools/ 的上一级）
  var sixPath = path.join(__dirname, '..', 'six-engine.js');
  if (!fs.existsSync(sixPath)) sixPath = path.join(__dirname, 'six-engine.js');
  SIX = require(sixPath);

  var items = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  var out = {};
  items.forEach(function (it) {
    var input = {
      code: it.code, name: it.name, kind: it.kind, tier: it.tier,
      pct: it.pct, series: it.series, themes: it.themes || [],
      ind: it.ind, rank: it.rank,
      closes: it.closes,            // 真实收盘序列 → 量价派算唐奇安/MACD/RSI
      c250: it.c250,                // 250 日前收盘，供回溯重算年线
      chan: it.chan,                // 缠论：中枢/笔/背驰（结构派用）
      closesFull: it.closesFull,    // 120 根，仅用于回溯状态天数
      turnover: it.turnover,
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
      ind: o.ind, fundLabel: o.fundLabel, fundProxy: o.fundProxy,
      fund3d: o.fund3d
    };
  });
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log('compute_engine: 已重算 %d 只', items.length);
}

main();
