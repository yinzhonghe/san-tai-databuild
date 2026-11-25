/*
 * state-phase.js · 三态「阶段健康度」唯一口径（浏览器 / Node 共用）
 * ------------------------------------------------------------------
 * 2026-11-25：从 app.js 抽出。原因：超跌页「新发涨停观察」必须和三态主站
 * 显示完全相同的「启动·新发」数量。旧版超跌页只用 stateDays<=2，漏掉了
 * 主站会用「今日实时涨跌 / 20 日回撤 / 六派票数变化」把它降级成
 * 观察/退化 的逻辑；同时云端快照比主站晚一天，于是出现 33 vs 36。
 *
 * 判定输入只有快照已有的真实字段 + 实时报价，不改阈值就不改结论。
 * 任何一端改阈值，必须改这个文件（app.js 与 oversold.html 都调用它）。
 *
 * 浏览器：window.AB_PHASE.compute(row, quote)
 * Node   ：require('./state-phase.js').compute(row, quote)
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AB_PHASE = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function pct(v) { if (!isNum(v)) return '—'; return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
  function fmt(v, d) { return isNum(v) ? v.toFixed(d == null ? 2 : d) : '—'; }

  function daysOf(r) {
    if (!r) return null;
    if (isNum(r.stateDays)) return r.stateDays;
    var e2 = r.e2 || {};
    return isNum(e2.stateDays) ? e2.stateDays : null;
  }

  function bullCount(r) {
    if (!r) return 0;
    if (isNum(r.resonance)) return r.resonance;
    var v = r.votes || {}, c = 0;
    ['structure', 'volume', 'fund', 'senti', 'config', 'news'].forEach(function (k) {
      if (v[k] === 1) c++;
    });
    return c;
  }

  function recentDrawdown(r) {
    var c = r && (r.__liveCloses || r.closes);
    if (!Array.isArray(c) || c.length < 21) return null;
    var seg = c.slice(-21), hi = -Infinity, i;
    for (i = 0; i < seg.length; i++) if (isNum(seg[i]) && seg[i] > hi) hi = seg[i];
    var last = c[c.length - 1];
    if (!isFinite(hi) || !isNum(last) || hi <= 0) return null;
    return (last / hi - 1) * 100;
  }

  /* q: { chg, price, ... } —— 主站是 QUOTES[code]，超跌页是实时报价 map[code] */
  function compute(r, q) {
    if (!r) return null;
    var d = daysOf(r);
    if (d == null) return null;
    var quote = q || {};
    var day = isNum(quote.chg) ? quote.chg : null;
    var dd = recentDrawdown(r);
    var prev = isNum(r.resonancePrev) ? r.resonancePrev : null;
    var bull = bullCount(r);
    var dropVotes = prev != null && bull < prev;
    var voteTxt = dropVotes ? ('六派票数 ' + prev + '→' + bull + '，') : '';

    if (r.state === '启动') {
      if ((day != null && day <= -5) || (dd != null && dd <= -15)) {
        var cause = (day != null && day <= -5) ? ('今日 ' + pct(day)) : ('较近 20 日高点回撤 ' + fmt(dd, 1) + '%');
        return { t: '退化', cls: 'bad', why: '启动态但' + cause + '，' + voteTxt + '启动失败转盘整/走完的典型形态，别当「刚启动」追高' };
      }
      if (day != null && day <= -3) {
        return { t: '观察', cls: 'mid', why: '启动态但今日 ' + pct(day) + '，' + voteTxt + '强势里出大阴线，先看能不能收回' };
      }
      if (dropVotes) return { t: '观察', cls: 'mid', why: voteTxt + '票在减少，结构可能开始松动' };
      if (d <= 2) return { t: '新发', cls: 'good', why: '状态刚切换，仍在验证阶段' };
      if (d <= 8) return { t: '健康', cls: 'good', why: '启动第 ' + d + ' 个交易日，行情通常已走一段' };
      if (d <= 15) return { t: '观察', cls: 'mid', why: '启动已 ' + d + ' 个交易日，超过常见长度，追高性价比下降' };
      return { t: '退化', cls: 'bad', why: '启动已 ' + d + ' 个交易日，远超常见长度，随时可能转盘整/走完' };
    }
    if (r.state === '走完') {
      if (d <= 3) return { t: '刚走完', cls: 'bad', why: '阶段刚结束，风险释放中' };
      if (d <= 15) return { t: '走完中', cls: 'mid', why: '已 ' + d + ' 个交易日，仍在消化' };
      return { t: '走完已久', cls: 'mid', why: '已 ' + d + ' 个交易日，留意是否重新吸筹' };
    }
    if (d >= 20) return { t: '久盘', cls: 'mid', why: '盘整已 ' + d + ' 个交易日，等方向选择' };
    return { t: '盘整中', cls: 'mid', why: '已 ' + d + ' 个交易日，方向未定' };
  }

  /* 超跌页用：同一候选池按实时报价分出「新发 / 观察 / 退化」 */
  function split(candidates, quoteMap) {
    var groups = { '新发': [], '观察': [], '退化': [], '其他': [] };
    (candidates || []).forEach(function (x) {
      var p = compute(x, (quoteMap || {})[x.code]);
      var key = p ? p.t : '其他';
      if (!groups[key]) groups[key] = [];
      x._phase = p || { t: '其他', cls: 'mid', why: '阶段数据不全，无法判定' };
      groups[key].push(x);
    });
    return groups;
  }

  return { compute: compute, split: split, daysOf: daysOf, bullCount: bullCount, recentDrawdown: recentDrawdown };
});
