'use strict';
/*
 * 自进化 · 汇总出页面要用的 learn_report.js
 * 页面只读这一份，避免前端到处拼逻辑；所有数字都来自真实文件，没有数就写 null，
 * 前端按「样本累计中」显示，不用 0 或估算顶替。
 */
const fs = require('fs');
const path = require('path');
const L = require('./learn_lib.js');

function readPickParams() {
  try {
    const s = fs.readFileSync(path.join(L.ROOT, 'chan_pick_data.js'), 'utf8');
    const o = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('};') + 1));
    return { date: o.date, params: o.params || {}, nStock: (o.stocks || []).length, nEtf: (o.etfs || []).length };
  } catch (e) { return null; }
}

function main() {
  const p = L.readJson(path.join(L.LEARN, 'chan_params.json'), null);
  const live = L.readJsonl(path.join(L.LEARN, 'chan_live.jsonl'));
  const ledger = L.readJsonl(path.join(L.LEARN, 'chan_ledger.jsonl'));
  const verdict = L.readJson(path.join(L.LEARN, 'verdict_stats.json'), null);
  const state = L.readJson(path.join(L.LEARN, 'state_calib.json'), null);
  const pick = readPickParams();

  const byVer = {};
  live.forEach(function (r) {
    const k = r.ver || 'unknown';
    (byVer[k] = byVer[k] || []).push(r);
  });
  const livePack = {};
  Object.keys(byVer).forEach(function (k) {
    const a = byVer[k];
    const r20 = a.map(function (x) { return x.r20; }).filter(function (x) { return x != null; });
    livePack[k] = {
      n: a.length,
      win20: r20.length ? +(r20.filter(function (x) { return x > 0; }).length / r20.length * 100).toFixed(1) : null,
      avg20: r20.length ? +L.mean(r20).toFixed(2) : null
    };
  });

  const chan = p ? {
    ver: p.version, adopt: p.adopt, hold: p.hold, areaMin: p.areaMin,
    minScore: p.minScore, keepPct: pick && pick.params ? pick.params.keepPct : null,
    cutScore: pick && pick.params ? pick.params.cutScore : null,
    nSignals: p.nSignals, trainedAt: p.trainedAt, oos: p.oos, baseline: p.baseline,
    improve: p.improve, spread: p.spread, folds: p.folds,
    card: p.card ? { base: p.card.base, edges: p.card.edges, vals: p.card.vals } : null,
    feats: p.feats, fdesc: p.fdesc
  } : null;

  const headline = [];
  if (chan) {
    headline.push('缠论一买模型 ' + (chan.adopt ? '已启用' : '未启用')
      + '：样本外 T+' + chan.hold + ' 胜率 ' + (chan.oos && chan.oos.win) + '%（基线 '
      + (chan.baseline && chan.baseline.win) + '%，n=' + (chan.oos && chan.oos.n) + '）');
  } else {
    headline.push('缠论一买模型：尚未训练');
  }
  if (verdict && verdict.scored) {
    const best = Object.keys(verdict.byVerdict).sort(function (a, b) { return verdict.byVerdict[b].n - verdict.byVerdict[a].n; })[0];
    headline.push('点评已对账 ' + verdict.scored + ' 次，' + best + ' 命中 ' + verdict.byVerdict[best].hit + '%');
  } else {
    headline.push('点评对账：从 ' + new Date().toISOString().slice(0, 10) + ' 起累计，样本还不够');
  }
  if (state && state.ready) headline.push('三态校准：' + state.scoredDays + ' 个交易日、' + state.samples + ' 条样本');
  else headline.push('三态校准：样本累计中（每日归档真实快照，20 个交易日后出胜率）');

  const out = {
    updatedAt: new Date().toISOString().slice(0, 19),
    asOf: pick ? pick.date : '',
    today: pick ? { nStock: pick.nStock, nEtf: pick.nEtf, params: pick.params } : null,
    chan: chan,
    live: { total: live.length, ledger: ledger.length, byVer: livePack },
    verdict: verdict,
    state: state,
    headline: headline
  };

  L.writeJson(path.join(L.LEARN, 'report.json'), out);
  const js = '/* 自进化汇总 · 由 tools/evolve_report.js 生成，勿手改 */\n'
    + 'window.AB_LEARN = ' + JSON.stringify(out) + ';\n';
  fs.writeFileSync(path.join(L.ROOT, 'learn_report.js'), js);
  console.log('已生成 learn_report.js（' + (Buffer.byteLength(js) / 1024).toFixed(1) + ' KB）');
  headline.forEach(function (h) { console.log('  · ' + h); });
}

main();
