/*
 * tools/evolve/settle.js · 信号级净收益结算器（B/T4 定稿）
 * ==========================================================
 * 修复 v1 的致命统计错误：v1 只统计「命中启动」样本的 ret3，未命中样本的收益被丢弃——
 * 等于「只算赢的牌，不算输的牌」。本结算器按定稿口径：
 *   - 每个信号都算钱：T 日收盘买入 → T+3 收盘卖出（无论是否命中启动）
 *   - 一字板（sigOneWord）不可成交 → 剔除，不参与结算
 *   - 扣成本：双边佣金 + 卖出印花税 + 滑点 = 0.21%/次（constitution.costModel）
 *   - 机会成本：必须跑赢同期持有沪深300（constitution.target.opportunityCost）
 *   - 覆盖率：低覆盖信号只能进构件池，不能单独上场
 *   - 最短板稳健分：各子时间段取最差而非平均（M5）
 *   - 逐条件消融：剔除每个条件重跑，识别噪声条件（M5）
 *
 * 用法：
 *   node tools/evolve/settle.js --baseline          # 算固定标尺（信号级）
 *   node tools/evolve/settle.js --rule <rule.json>  # 结算单条规则的信号级净收益
 *   node tools/evolve/settle.js --ablate <rule.json># 逐条件消融
 */
'use strict';
var fs = require('fs');
var path = require('path');
var R = require('./rules.js');
var K = require('./kernel.js');

var ROOT = path.dirname(path.dirname(__dirname));
var EVO = path.join(ROOT, 'learn', 'evolve');
var PANEL = path.join(EVO, 'panel.jsonl');
var PANEL_FAST = path.join(EVO, 'panel_sample100k.jsonl');
var CONST = path.join(EVO, 'constitution.json');
function loadJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function cons() { return loadJSON(CONST, {}); }
/* 双轨：日常演化用 10 万采样（秒级），写回/汇报用全样本（精确）。
   环境变量 EVOLVE_PANEL=full 强制全样本；默认 fast（存在采样文件时）。 */
function panelPath() {
  if (process.env.EVOLVE_PANEL === 'full') return PANEL;
  return fs.existsSync(PANEL_FAST) ? PANEL_FAST : PANEL;
}

/* 成本模型：从 constitution 读，净收益 = 毛收益 - 往返成本 */
function roundTripCostPct() {
  var c = cons().costModel || {};
  return (c.commissionPctPerSide || 0.03) * 2 + (c.stampTaxPctSell || 0.05) +
    (c.slippagePctPerSide || 0.1) * 2;
}

/* 机会成本基准：同期沪深300涨幅（从 panel 里 isEtf 且代码是 510300 的样本近似；
   若面板无该代码，用全市场中位数收益作代理，并在 note 标明） */
function findBenchmarkRet(rows) {
  var hs300 = rows.filter(function (r) { return /510300|510310/.test(r.code); });
  if (hs300.length && isNum(hs300[0].y.sigRet3)) return { ret: hs300[0].y.sigRet3, source: 'CSI300_ETF' };
  var rets = rows.map(function (r) { return r.y.sigRet3; }).filter(isNum).sort(function (a, b) { return a - b; });
  if (!rets.length) return { ret: null, source: 'none' };
  return { ret: rets[Math.floor(rets.length / 2)], source: 'market_median_proxy' };
}

/* 核心：对过滤后的样本做信号级结算。
   rule 可为 null（全样本 baseline）。filterFn 可选（时间段/子空间）。
   enrichFn 可选：在 evalRule 之前给 s.f 注入【已编译且可复现】的新特征
   （自由推演实验室造新特征用；不传则生产链路行为完全不变）。 */
function settleStream(rule, filterFn, enrichFn) {
  var cost = roundTripCostPct();
  return new Promise(function (resolve, reject) {
    var rl = require('readline').createInterface({ input: fs.createReadStream(panelPath(), { encoding: 'utf8' }), crlfDelay: Infinity });
    var st = { n: 0, tradable: 0, eligible: 0, skippedOneWord: 0, skippedNoData: 0,
      sumNet: 0, netN: 0, wins: 0, rets: [], bySegment: {}, byDate: {},
      benchRet: null, universeRets: [] };
    rl.on('line', function (line) {
      if (!line.trim()) return;
      var s; try { s = JSON.parse(line); } catch (e) { return; }
      if (filterFn && !filterFn(s)) return;
      if (enrichFn) { s.f = s.f || {}; enrichFn(s.f); }
      // 一字板信号不可成交：剔除
      if (s.y && s.y.sigOneWord) { st.skippedOneWord++; return; }
      // 信号级收益：每个信号都必须有 sigRet3（无论命中与否）
      if (!s.y || !isNum(s.y.sigRet3)) { st.skippedNoData++; return; }
      // 覆盖率分母：同一过滤口径下的全部可交易信号（一字板/无数据已剔除）
      st.eligible++;
      st.universeRets.push(s.y.sigRet3);
      if (/510300|510310/.test(s.code) && st.benchRet == null) st.benchRet = s.y.sigRet3;
      if (rule) {
        var v = R.evalRule(rule, s);
        if (v !== 'match') return;
      }
      st.n++;
      st.tradable++;
      var net = s.y.sigRet3 - cost;
      st.sumNet += net; st.netN++;
      if (net > 0) st.wins++;
      st.rets.push(net);
      // 按月份分段（稳健分取最差段）
      var seg = s.date.slice(0, 7);
      var g = st.bySegment[seg] = st.bySegment[seg] || { n: 0, sum: 0, wins: 0 };
      g.n++; g.sum += net; if (net > 0) g.wins++;
      var d = s.date;
      var dg = st.byDate[d] = st.byDate[d] || { n: 0, sum: 0, wins: 0 };
      dg.n++; dg.sum += net; if (net > 0) dg.wins++;
    });
    rl.on('close', function () {
      var avgNet = st.netN ? st.sumNet / st.netN : null;
      var winRate = st.netN ? st.wins / st.netN : null;
      var wilson = (st.netN && st.wins != null) ? K.wilsonLower(st.wins, st.netN) : null;
      // t 值：净收益均值 / (标准差/√n)
      var sd = 0;
      if (st.netN > 1 && st.rets.length) {
        var mean = avgNet, ss = 0;
        for (var i = 0; i < st.rets.length; i++) ss += (st.rets[i] - mean) * (st.rets[i] - mean);
        sd = Math.sqrt(ss / (st.rets.length - 1));
      }
      var tStat = (sd > 0 && st.netN > 1) ? avgNet / (sd / Math.sqrt(st.netN)) : null;
      // 覆盖率：命中信号数 / 同口径可交易信号总数（此前从未计算，导致软裁判永远 REFUTED）
      var coverage = st.eligible ? +(st.n / st.eligible * 100).toFixed(2) : 0;
      // 机会成本：沪深300 ETF 同期收益；面板无该代码时用全市场中位数代理并标注
      var bench = st.benchRet != null ? { ret: st.benchRet, source: 'CSI300_ETF' }
        : (st.universeRets.length
          ? (function () { var a = st.universeRets.slice().sort(function (x, y) { return x - y; });
              return { ret: a[Math.floor(a.length / 2)], source: 'market_median_proxy' }; })()
          : { ret: null, source: 'none' });
      var excess = (isNum(bench.ret) && isNum(avgNet)) ? +(avgNet - bench.ret).toFixed(4) : null;
      // 最短板稳健分：各月净收益的最小值
      var segNets = Object.keys(st.bySegment).map(function (k) {
        var g = st.bySegment[k]; return g.n >= 20 ? g.sum / g.n : null;
      }).filter(isNum);
      var worstSeg = segNets.length ? Math.min.apply(null, segNets) : null;
      resolve({
        n: st.n, tradable: st.tradable, eligible: st.eligible,
        skippedOneWord: st.skippedOneWord, skippedNoData: st.skippedNoData,
        coverage: coverage, benchmarkRet: bench.ret, benchmarkSource: bench.source,
        excessOverHold: excess,
        grossAvg: st.netN ? (st.sumNet + cost * st.netN) / st.netN : null,
        costPct: cost, netRet3: avgNet == null ? null : +avgNet.toFixed(4),
        winRate: winRate == null ? null : +winRate.toFixed(4),
        wilsonLower: wilson == null ? null : +wilson.toFixed(4),
        tStat: tStat == null ? null : +tStat.toFixed(3),
        worstSegmentNet: worstSeg == null ? null : +worstSeg.toFixed(4),
        segments: Object.keys(st.bySegment).length,
        note: '信号级口径：每个T日信号都算钱；一字板剔除；扣往返成本' + cost.toFixed(2) + '%；概率性结论非「正确」'
      });
    });
    rl.on('error', reject);
  });
}

/* 机会成本比较：规则净收益 vs 同期持有基准/全市场中位数 */
function withOpportunityCost(stats, benchRet) {
  var out = Object.assign({}, stats);
  out.benchmarkRet = benchRet.ret;
  out.benchmarkSource = benchRet.source;
  out.excessOverHold = (isNum(benchRet.ret) && isNum(stats.netRet3))
    ? +(stats.netRet3 - benchRet.ret).toFixed(4) : null;
  return out;
}

/* 逐条件消融（M5）：去掉每个 when 条件重跑，识别噪声/核心条件 */
function ablate(rule) {
  var conds = rule.when || [];
  var tasks = [{ label: 'full', rule: rule }];
  conds.forEach(function (c, i) {
    var r2 = Object.assign({}, rule, { when: conds.filter(function (_, j) { return j !== i; }) });
    tasks.push({ label: 'without[' + i + ']:' + c.f + c.op, rule: r2 });
  });
  return Promise.all(tasks.map(function (t) {
    return settleStream(t.rule.when.length ? t.rule : null).then(function (s) {
      return { label: t.label, netRet3: s.netRet3, n: s.n };
    });
  })).then(function (results) {
    var full = results[0].netRet3;
    results.slice(1).forEach(function (r) {
      var delta = (isNum(full) && isNum(r.netRet3)) ? +(full - r.netRet3).toFixed(4) : null;
      r.contribution = delta;                       // 去掉该条件后净收益跌多少 = 该条件贡献
      r.role = delta == null ? 'unknown' : (Math.abs(delta) < 0.02 ? 'noise' : 'core');
    });
    return { full: full, conditions: results.slice(1),
      noise: results.slice(1).filter(function (r) { return r.role === 'noise'; }).map(function (r) { return r.label; }),
      core: results.slice(1).filter(function (r) { return r.role === 'core'; }).map(function (r) { return r.label; }) };
  });
}

function main() {
  var args = process.argv.slice(2);
  if (args[0] === '--baseline') {
    settleStream(null).then(function (s) {
      console.log('=== 信号级 baseline（全样本）===');
      console.log(JSON.stringify(s, null, 2));
    });
    return;
  }
  if (args[0] === '--rule' || args[0] === '--ablate') {
    var p = args[1];
    if (!p) { console.error('用法: --rule|--ablate <rule.json>'); process.exit(1); }
    var rule = loadJSON(p, null);
    if (!rule) { console.error('规则读取失败'); process.exit(1); }
    if (args[0] === '--ablate') {
      ablate(rule).then(function (a) { console.log(JSON.stringify(a, null, 2)); });
    } else {
      settleStream(rule).then(function (s) { console.log(JSON.stringify(s, null, 2)); });
    }
    return;
  }
  console.log('用法: --baseline | --rule <rule.json> | --ablate <rule.json>');
}
if (require.main === module) main();
module.exports = { settleStream: settleStream, ablate: ablate, withOpportunityCost: withOpportunityCost,
  roundTripCostPct: roundTripCostPct, findBenchmarkRet: findBenchmarkRet };
