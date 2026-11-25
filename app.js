/*
 * 三态看盘 v2 · 应用逻辑
 * ===== 共享语义的唯一入口（SSOT，详见 ARCH.md）=====
 * 以下四件事全站只能走一处，新增模块请直接调用，不要自己再写一遍：
 *   · 三态展示：stateBlock(r, opts)   —— pill + 已N个交易日 + 阶段标签，可点开六派依据
 *   · 三态判断：statePhase(r)         —— 新发 / 健康 / 观察 / 退化
 *   · 标的代码：normCode() + DS.snapshot() —— 一律全码（000001.SH ≠ 000001.SZ）
 *   · 今日行情：daySpan(q) + QUOTES[全码]  —— 停牌显示「无成交」，不是 +0.00%
 * 历史上多次 bug 都源于「同一语义在多处各写一遍」。
 * 哈希路由单页；全市场/我的看板/行业/方法论；内联个股透镜（去 iframe）。
 * 实时行情走 AB_DS 多源降级；快照结论（三态/六派）直接取自 data.js。
 */
(function () {
  'use strict';
  var DS = window.AB_DS;
  if (DS && DS.init) DS.init();

  // ---------- 基础工具 ----------
  function $(id) { return document.getElementById(id); }
  /* ---------- 术语白话 ----------
     用户反复提「看不懂专业名词」。这里给高频术语统一配一句人话，
     用 t('强度','…') 包起来就有虚线下划线和悬停解释。 */
  var TERMS = {
    '三态': '把一只票的走势粗分成三段：启动（刚转强、还在加速）、盘整（横着走、方向不明）、走完（涨过了、动能衰竭）。它是「阶段判断」，不是买卖信号。',
    '启动': '三个状态之一：近期转强且还在加速。注意「刚启动」和「启动了很久」风险完全不同，看后面的阶段标签。',
    '盘整': '三个状态之一：横盘震荡、方向不明。可能蓄势再上，也可能转跌，是最需要等的阶段。',
    '走完': '三个状态之一：前期涨过、动能已衰竭。不代表马上跌，而是「这一段大概率结束了」。',
    '六派': '结构 / 量价 / 资金 / 情绪 / 配置 / 舆情 六个互相独立的视角，每个视角各自投一票「是否启动」。4 票以上才算多派共振，票越少越像噪音。',
    '结构': '看价格是否站上 60 日均线、且均线本身在往上走。回答的是「大方向有没有转多」。',
    '量价': '看涨跌有没有成交量配合：涨且放量算健康，涨却缩量是虚涨，跌且放量是出货。',
    '资金': '用 OBV（能量潮）判断资金是流入还是流出：把每天成交量按涨跌方向累加，看趋势。',
    '情绪': '用 RSI（相对强弱指标）衡量近期涨跌力度：大于 55 偏热，小于 45 偏冷。',
    '配置': '看 20 日均线是否上穿、且价格站上均线，反映中期资金的建仓节奏。',
    '舆情': '看放量异动 + 当日方向，作为「市场关注度突然升温」的代理指标。',
    '票数': '六派里有几派投了「启动」票。4/6 表示六派中有四派看多，超过半数才算共振。',
    '否决': '某个视角发现了明确的反向证据（如放量下跌），可以一票否掉「启动」判定，避免只看多数票的误判。',
    '强度': '相对大盘的强弱（RS-Ratio）。大于 100 = 跑赢大盘，数值越大越强；小于 100 = 跑输。',
    '动量': '这种强弱的「加速度」（RS-Momentum）。大于 100 = 还在变得更强；小于 100 = 强不起来了，即使现在还在涨。',
    '象限': '把「强度」和「动量」画成四个格子：领先（强且更强）、改善（弱但在转强）、走弱（强但在衰减）、落后（弱且更弱）。',
    '领先': '强度 >100 且动量 >100：既跑赢大盘，还在继续加速。俗称「正在抱团」。',
    '改善': '强度 <100 但动量 >100：还在跑输，但已经开始追上来了。轮动最早的信号。',
    '走弱': '强度 >100 但动量 <100：还在跑赢，但劲头过去了。',
    '落后': '强度 <100 且动量 <100：跑输大盘且越来越弱。',
    '激增倍数': '近 24 小时资讯条数 ÷ 前 7 日日均条数。2× 表示比平时热闹一倍，10× 以上通常有大新闻。',
    '有效激增': '扣掉重复转载、同一来源刷屏之后的净激增倍数，比原始倍数可靠。',
    '筹码': '把每笔成交按价格堆起来，看大家主要买在什么价位。块越长 = 越多人成本在那一带，往往形成支撑或压力。',
    '获利盘': '在当前价位之上买入的人（已浮盈）占全部持仓的比例。获利盘太高，一有风吹草动容易集体卖出。',
    '连板': '连续涨停的天数。2 板 = 连续两天涨停，板数越高情绪越极端。',
    '涨停': '当日涨幅达到上限（主板 10%、创业板/科创板 20%、ST 5%）。',
    '分位': '把历史数据从小到大排队，当前值排在第几%。分位 90% 表示历史上只有 10% 的时间比现在更高。',
    '中位数': '把所有数排序后取正中间那个。比平均值更抗极端值，用来代表「多数股票的情况」。',
    '量比': '今天每分钟成交量 ÷ 过去 5 日每分钟均量。大于 1 = 放量，小于 1 = 缩量。',
    '换手': '当天成交的股数占流通股的比例。换手高 = 交投活跃，也意味着分歧大。',
    '背离': '价格创新高但指标没跟上（或反过来），说明推动力量在衰减，常见于趋势末端。',
    '回撤': '从最近一个高点往下掉了多少。回撤 15% = 比高点低了 15%。',
    '振幅': '当天最高价与最低价的差距 ÷ 昨收，衡量这一天波动有多剧烈。',
    '均线': '过去 N 天收盘价的平均值连成的线。20 日线看短期趋势，60 日线看中期，250 日线（年线）看长期。',
    '年线': '过去 250 个交易日的平均价。站上年线通常代表长期趋势转好。',
    '市值加权': '按公司市值大小分配权重来算平均涨跌，大盘股影响更大。官方板块指数就是这样算的，比等权平均更接近真实。',
    '快照': '构建时算好、不随盘中变化的数据（如情绪温度、连板梯队）。看到「快照 11-16」就是这个意思，不是实时值。',
    '折算': '基金份额拆分/合并（如 1 份拆成 2 份，价格对折），不是真跌。不复权的价格序列会显示成暴跌，必须用复权价看。'
  };
  /* ---------- 术语速查面板 ----------
     与其在每个词后面挂 tooltip（101 处「六派」会改到手软、还容易改坏），
     不如给一个随时能查的总表，再在术语密集的区块配一行「怎么看」。 */
  function termPanelHtml() {
    var groups = [
      ['三态是什么', ['三态', '启动', '盘整', '走完']],
      ['六派怎么投票', ['六派', '结构', '量价', '资金', '情绪', '配置', '舆情', '票数', '否决']],
      ['RRG 轮动', ['强度', '动量', '象限', '领先', '改善', '走弱', '落后']],
      ['舆情与热度', ['激增倍数', '有效激增']],
      ['筹码与位置', ['筹码', '获利盘', '分位', '中位数', '均线', '年线', '回撤', '振幅']],
      ['行情与交易', ['量比', '换手', '涨停', '连板', '背离', '市值加权']],
      ['数据口径', ['快照', '折算']]
    ];
    var body = groups.map(function (g) {
      var rows = g[1].filter(function (k) { return TERMS[k]; }).map(function (k) {
        return '<div class="tp-row"><div class="tp-k">' + esc(k) + '</div>'
          + '<div class="tp-v">' + esc(TERMS[k]) + '</div></div>';
      }).join('');
      return '<div class="tp-g"><div class="tp-h">' + esc(g[0]) + '</div>' + rows + '</div>';
    }).join('');
    return '<div id="termPanel" class="tp-mask"><div class="tp-card">'
      + '<div class="tp-top"><b>术语速查 · 都是人话</b>'
      + '<button id="termClose" class="tp-x">×</button></div>'
      + '<div class="tp-body">' + body + '</div>'
      + '<div class="tp-foot">这份解释只讲「它是什么」，不构成买卖建议。</div>'
      + '</div></div>';
  }
  function openTermPanel() {
    if (document.getElementById('termPanel')) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = termPanelHtml();
    var el = wrap.firstElementChild;
    document.body.appendChild(el);
    function close() { if (el.parentNode) el.parentNode.removeChild(el); }
    el.querySelector('#termClose').onclick = close;
    el.onclick = function (ev) { if (ev.target === el) close(); };
  }
  function installTermBtn() {
    var right = document.querySelector('.topbar .right');
    if (!right || document.getElementById('termBtn')) return;
    var b = document.createElement('button');
    b.id = 'termBtn';
    b.className = 'icon-btn';
    b.title = '术语速查（看不懂的词点这里）';
    b.textContent = '?';
    b.style.fontWeight = '700';
    b.onclick = openTermPanel;
    right.appendChild(b);
  }
  function t(word, tipText) {
    var w = TERMS[word] || tipText || '';
    if (!w) return esc(word);
    return '<span class="term" title="' + esc(w) + '">' + esc(word) + '</span>';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function fmt(v, d) { if (!isNum(v)) return '—'; return v.toFixed(d == null ? 2 : d); }
  function pct(v) { if (!isNum(v)) return '—'; return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
  function signCls(v) { return v > 0 ? 'up' : (v < 0 ? 'down' : 'mut'); }
  function asOfClean(meta) { var a = (meta && meta.asOf) || '构建日'; var i = a.indexOf(' · '); return i >= 0 ? a.slice(0, i) : a; }
  /* 事件委托用的向上查找：浏览器原生 closest 优先，附带极简兜底 */
  function closest(node, sel) {
    if (!node) return null;
    if (node.closest) { try { return node.closest(sel); } catch (e) {} }
    var p = /^([a-zA-Z]*)(?:\.([\w-]+))?(?:\[([\w-]+)\])?$/.exec(sel);
    if (!p) return null;
    while (node && node !== document) {
      var ok = true;
      if (p[1] && (!node.tagName || String(node.tagName).toLowerCase() !== p[1].toLowerCase())) ok = false;
      if (ok && p[2] && !(node.classList && node.classList.contains(p[2]))) ok = false;
      if (ok && p[3] && !(node.getAttribute && node.getAttribute(p[3]) != null)) ok = false;
      if (ok) return node;
      node = node.parentNode;
    }
    return null;
  }

  var STATE_MAP = {
    '启动': { cls: 'launch', tri: '▲' },
    '盘整': { cls: 'consol', tri: '—' },
    '走完': { cls: 'done', tri: '▼' }
  };
  function statePill(s) {
    var m = STATE_MAP[s] || { cls: 'unk', tri: '·' };
    return '<span class="pill ' + m.cls + '"><span class="tri">' + m.tri + '</span>' + esc(s || '未知') + '</span>';
  }
  var SIX = [
    { k: 'structure', n: '结构' }, { k: 'volume', n: '量价' }, { k: 'fund', n: '资金' },
    { k: 'senti', n: '情绪' }, { k: 'config', n: '配置' }, { k: 'news', n: '舆情' }
  ];
  function votesOf(r) { return (r && r.votes) || {}; }
  function bullCount(r) {
    if (isNum(r.resonance)) return r.resonance;
    var v = votesOf(r), c = 0;
    SIX.forEach(function (s) { if (v[s.k] === 1) c++; });
    return c;
  }
  function sixTags(r) {
    var v = votesOf(r);
    return '<div class="six">' + SIX.map(function (s) {
      var val = v[s.k];
      var cls = val === 1 ? 'bull' : (val === -1 ? 'bear' : 'mid');
      var ic = val === 1 ? '✓' : (val === -1 ? '✗' : '—');
      return '<span class="tag ' + cls + '"><span class="ic">' + ic + '</span>' + s.n + '</span>';
    }).join('') + '</div>';
  }

  /* ---------- 三态时间 · 六派各自的判断时点 ----------
   * 数据口径：e2.stateHistory 是快照中约 250/60/20/5 日前的三态采样锚点(date/state/back)；
   * e2.stateSince / stateDays 为当前三态的起始日与持续天数；窗口日期取自 meta.windows / newsMeta.window。
   * 六派观察窗口不同（见 voteDef 与 e2.votes 原文），按各自可见锚点找出最近一段「启动」的起始日，
   * 即该派认定的启动起点。仅为快照锚点的时间归属整理，非逐日重算、非各派当日实发信号。
   */
  var SIX_WIN = [
    { k: 'structure', name: '结构派', winKey: 'w250', backs: [20, 60, 250], note: '中期结构 / 阶段 / 背离' },
    { k: 'volume', name: '量价派', winKey: 'w20', backs: [5, 20], note: '近5 / 近20 日量价' },
    { k: 'fund', name: '资金派', winKey: 'w5', backs: [5], note: '主力净流入（最近落库日）' },
    { k: 'senti', name: '情绪派', winKey: 'w5', backs: [5], note: '情绪温度 / 近5日强度' },
    { k: 'config', name: '配置派', winKey: 'w60', backs: [20, 60], note: 'RRG 相对强度与动量' },
    { k: 'news', name: '舆情派', winKey: '', backs: [5], note: '资讯 8 天窗口（近1日 / 前7日）' }
  ];
  function metaInfo() { return (DS && DS.meta && DS.meta()) || RAW().meta || {}; }
  function dayStr(s) { var m = /(\d{4}-\d{2}-\d{2})/.exec(String(s == null ? '' : s)); return m ? m[1] : ''; }
  /* ---------- 状态起始日：唯一口径 ----------
   * 旧行直接用快照里记录的 stateSince；全市场竞争数据没有逐日状态记录，
   * 就用「当前状态已持续几个交易日」（构建时用引擎逐日回测算出的 stateDays）
   * 从基准日倒推。列表 / 详情 / 方法论全部读这两个函数，
   * 避免同一只票出现两个「启动日期」。 */
  function fmtYmd(d) { var z = function (x) { return x < 10 ? '0' + x : '' + x; }; return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); }
  function backTradingDays(ymd, n) {
    var t = String(ymd || '').replace(/\D/g, '');
    if (t.length !== 8 || !(n >= 0)) return null;
    var d = new Date(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8));
    if (n === 0) return fmtYmd(d);          // 当天就是起点（stateDays=1）
    var left = n;
    while (left > 0) { d.setDate(d.getDate() - 1); var w = d.getDay(); if (w !== 0 && w !== 6) left--; }
    return fmtYmd(d);
  }
  function sinceOf(r) {
    if (!r) return null;
    var e2 = r.e2 || {};
    var d = dayStr(e2.stateSince);
    if (d) return d;
    if (isNum(r.stateDays) && r.baseDate) return backTradingDays(r.baseDate, r.stateDays - 1);
    return null;
  }
  function daysOf(r) {
    if (!r) return null;
    if (isNum(r.stateDays)) return r.stateDays;
    var e2 = r.e2 || {};
    return e2.stateDays != null ? e2.stateDays : null;
  }
  /* 展示用：超过回溯窗口（45 个交易日）时标成「≥45」，不假装精确 */
  function daysText(r) {
    var d = daysOf(r);
    if (d == null) return '—';
    return (r && r.stateCapped ? '≥' : '') + d + ' 个交易日';
  }
  function md(d) { return d ? String(d).slice(5) : '—'; }
  function winPart(w, i) { var s = String((metaInfo().windows || {})[w] || '').split('~'); return dayStr(s[i] || ''); }
  function winStart(w) { return winPart(w, 0); }
  function winEnd(w) { return winPart(w, 1); }
  function stateRangeLabel(r) {
    var e2 = r.e2 || {}, since = sinceOf(r);
    var m = metaInfo();
    // 终点用 DATA 再生时点（部分行由页面实时引擎重算，stateSince 会晚于快照收盘日）
    var to = dayStr(m.asOf) || dayStr(m.asOfCore) || winEnd('w5');
    if (!since) return '时间未记录';
    if (to && to < since) to = since;           // 防时间倒挂
    if (!to || to === since) return md(since) + ' 起';
    return md(since) + ' → ' + md(to);
  }
  /* 六派依据：直接读引擎真实输出（六派分数 / 威科夫阶段 / 缠论 / RRG / 资金口径），
     不再依赖旧快照的 e2.votes.txt（全市场数据里已不存在，导致整块显示"快照未记录"）。
     每个派都只回答一个问题：这一票是根据什么投出来的。 */
  function sixEvidenceText(r, k) {
    var sc = r.scores || {}, wn = { w5: '近5日', w20: '近20日', w60: '近60日', w250: '近250日' };
    function pc(v) { return isNum(v) ? (v >= 0 ? '+' : '') + fmt(v, 2) + '%' : '—'; }
    if (k === 'structure') {
      var parts = ['结构分 ' + fmt(sc.structure, 2)];
      if (r.wyckoff && r.wyckoff.stage) parts.push('威科夫阶段：' + r.wyckoff.stage);
      if (r.chan && r.chan.pos && r.chan.pos !== 'na') {
        var pm = { above: '中枢上方', in: '中枢内', below: '中枢下方' }[r.chan.pos] || r.chan.pos;
        var bm2 = r.chan.bi === 'up' ? '向上笔' : (r.chan.bi === 'down' ? '向下笔' : '笔未定');
        parts.push('缠论：' + pm + '·' + bm2 + (r.chan.diverg ? '·背驰' : ''));
      }
      parts.push('250日 ' + pc(r.pct && r.pct.w250));
      return parts.join(' · ');
    }
    if (k === 'volume') {
      return ['量价分 ' + fmt(sc.volume, 2),
        '5日 ' + pc(r.pct && r.pct.w5), '20日 ' + pc(r.pct && r.pct.w20),
        '60日 ' + pc(r.pct && r.pct.w60), '唐奇安/MACD/RSI 由前复权日K 实时计算'].join(' · ');
    }
    if (k === 'fund') {
      if (r.kind === 'index') {
        return '指数没有个股主力口径（成分股资金不在此列）→ 用指数成交额与量能变化代理 · 资金分 ' + fmt(sc.fund, 2);
      }
      /* 实时资金优先：data.js 快照没带 --fund 时，fundflow.js 会从东财资金流日线
         取最近交易日真实净额（个股=主力净流入，ETF=资金流净额）。只在缓存命中时显示，
         拉不到就退回下面的快照代理并如实标注，绝不编造。 */
      var ff = (typeof window !== 'undefined' && window.AB_FUNDFLOW && window.AB_FUNDFLOW.voteOf)
        ? window.AB_FUNDFLOW.voteOf(r.code) : null;
      if (ff) return ff.label + ' · 资金分 ' + fmt(sc.fund, 2);
      if (isNum(r.fund)) {
        var lab = String(r.fundLabel || '东财口径');
        // fundLabel 有时已经写成「个股主力净流入 +1.65 亿」，再拼一次就成 0.00 亿（+1.65 亿）
        var head = (lab.indexOf('亿') >= 0 || lab.indexOf('净流入') >= 0)
          ? lab : ('个股主力净流入 ' + fmt(r.fund / 1e8, 2) + ' 亿（' + lab + '）');
        return head + ' · 资金分 ' + fmt(sc.fund, 2);
      }
      return '无个股主力口径（构建时未开 --fund）→ 用所属行业资金中位数代理 · 资金分 ' + fmt(sc.fund, 2);
    }
    if (k === 'senti') {
      var temp = (RAW().engine || {}).temp;
      return ['情绪分 ' + fmt(sc.senti, 2),
        isNum(temp) ? '市场温度 ' + fmt(temp * 100, 0) + '/100' : '市场温度 —',
        '自身5日强度 ' + pc(r.pct && r.pct.w5)].join(' · ');
    }
    if (k === 'config') {
      return ['RRG 象限：' + (r.quad || '—'),
        isNum(r.rsRatio) ? '相对强度 ' + fmt(r.rsRatio, 1) : '相对强度 —',
        isNum(r.rsMomentum) ? '相对动量 ' + fmt(r.rsMomentum, 1) : '相对动量 —',
        '配置分 ' + fmt(sc.config, 2)].join(' · ');
    }
    if (k === 'news') {
      /* 舆情票的唯一真相是「资讯雷达」那套实时口径（东财全网资讯 + 极性 + 三方核对）。
         构建快照里没有新闻源，所以这里不给死结论，而是等实时结果回填（见 applyLiveNewsVote）。 */
      return '实时资讯判定中…（构建快照不含新闻源，本票以实时资讯为准）';
    }
    return '该派无额外依据';
  }
  function sixTimingRows(r) {
    var v = votesOf(r), m = metaInfo();
    var asOf = dayStr(m.asOf) || dayStr(m.asOfCore) || '';
    return SIX_WIN.map(function (w) {
      return {
        k: w.k, name: w.name, dir: v[w.k], note: w.note,
        asOf: asOf, age: daysFrom(asOf),
        txt: sixEvidenceText(r, w.k)
      };
    });
  }
  function stateCellHtml(r) {
    var open = !!STTIME_OPEN[r.code];
    return '<td class="st-cell"><div data-stblock="' + esc(r.code) + '">' + stateBlock(r, { click: false }) + '</div>'
      + '<button class="st-time" data-sttime="' + esc(r.code) + '" title="展开六派各自判断的时间与依据">'
      + (open ? '收起六派 ▴' : '六派依据 ▾') + '</button></td>';
  }
  function sixTimingHtml(r, noToggle) {
    var rows = sixTimingRows(r);
    var asOf = rows.length ? rows[0].asOf : '';
    var trs = rows.map(function (x) {
      var ic = x.dir === 1 ? '✓' : (x.dir === -1 ? '✗' : '—');
      var cls = x.dir === 1 ? 'bull' : (x.dir === -1 ? 'bear' : 'mid');
      return '<tr><td>' + esc(x.name) + '</td>'
        + '<td><span class="tag ' + cls + '"><span class="ic">' + ic + '</span></span></td>'
        + '<td' + (x.k === 'news' ? ' data-news-vote' : (x.k === 'fund' ? ' data-fund-evi="' + esc(r.code) + '"' : '')) + '>' + esc(x.txt) + '</td>'
        + '<td><span class="cat">' + esc(x.note) + '</span></td></tr>';
    }).join('');
    return '<div class="st-panel">'
      + '<div class="hd"><b>' + esc(r.name) + ' · 六派依据明细</b>' + stateBlock(r, { click: false })
      + '<span class="cat">当前状态自 ' + esc(sinceOf(r) || '—') + ' 起 · '
      + esc(daysText(r)) + '</span>'
      + (noToggle ? '' : '<button class="st-time" data-sttime="' + esc(r.code) + '" style="margin-left:auto">收起 ▴</button>')
      + '</div>'
      /* 六派明细弹窗同样要能直接看到「接下来怎么走」——
         从卡片点进来的人，是想知道下一步怎么办，不是来看六派怎么打分的。 */
      + (window.AB_PATH && window.AB_PATH.render ? window.AB_PATH.render(r) : '')
      + '<div class="sum">两件事别混在一起看：<b>①「状态自 ' + esc(sinceOf(r) || '—')
      + ' 起」</b>说的是这个三态<b>已经持续了 '
      + esc(daysOf(r) != null ? daysOf(r) : '—') + ' 个交易日</b>（不是今天才出现）；'
      + '<b>②「依据 ' + esc(asOf) + ' 收盘」</b>说的是六派这一票用的是<b>哪一天的收盘数据</b>。'
      + '两者用的是同一天的数据，只是一个描述「持续多久」、一个描述「什么时候算的」。'
      + '六派共振 <b>' + bullCount(r) + '/6</b>，其中舆情票由「资讯雷达」实时判定（构建快照不含新闻源，以实时结果为准）。✗ 表示未投启动票，<b>不代表看跌</b>。</div>'
      + '<div class="m-scroll-hint">← 表格可左右滑动查看「依据」与「看的是哪段」 →</div>'
      + '<table class="st-table six-timing"><thead><tr><th>派别</th><th>当前票</th>'
      + '<th>这一票的依据（全部来自引擎实算）</th><th>看的是哪段</th></tr></thead><tbody>' + trs + '</tbody></table>'
      + '<div class="notice">口径：六派票由 <code>six-engine.js</code> 用 ' + esc(asOf)
      + ' 的前复权收盘重算，票数、分数与依据同源；三态为阶段判断，与涨跌无必然关系，'
      + '<b>不构成投资建议，不预示未来收益</b>。</div>'
      + '<div class="insight" data-insight-code="' + esc(r.code) + '"><div class="insight-sec">'
      + '<h4>三态 / 六派前瞻胜率（1周 / 1月 / 3月）· 近似规则，非实盘口径</h4>'
      + '<div class="hint" style="margin:-2px 0 8px">口径说明：这里用「票数 ≥4 且站上 MA20」近似历史三态，'
      + '并加了与引擎相同的结构票门槛和 60/250 日绝对趋势闸门；但引擎还有否决项（顶部背离、超跌反弹、'
      + '舆情未确认等）与结构阈值，纯前端回放拿不到当期截面数据，<b>无法做到完全同源</b>，所以只作方向参考。</div>'
      + '<div class="insight-bt"><div class="hint">正在读取前复权日K 并逐日重算历史信号…</div></div>'
      + '</div><div class="insight-risk"></div></div>'
      + '</div>';
  }
  var STTIME_OPEN = {};   // 全市场表里已展开的标的（排序/筛选重绘后保持）
  /* 非表格位置（卡片 / 榜单 / 体检 / 列表）点三态：没有可展开的表格行，就用浮层显示同一份依据。
     和全市场表里的展开共用 sixTimingHtml，保证「点哪里看到的都是同一套东西」。 */
  function openStateDetail(code) {
    var r = DS.snapshot(code); if (!r) return;
    var m = document.getElementById('stModal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'stModal'; m.className = 'st-modal';
      m.addEventListener('click', function (ev) {
        var tg = ev.target;
        if (tg === m || (tg && tg.getAttribute && tg.getAttribute('data-stclose') != null)) closeStateDetail();
      });
      document.body.appendChild(m);
    }
    m.innerHTML = '<div class="st-modal-bd">'
      + '<div class="st-modal-head"><b>' + esc(r.name) + '</b> <span class="cat">' + esc(r.code) + '</span>'
      + statePill(r.state)
      + '<button class="st-modal-x" data-stclose title="关闭">×</button></div>'
      + '<div class="st-modal-body">' + statePhaseNote(r)
      + '<div class="xc-jump" style="margin:0 0 10px">'
      + '<a class="btn btn-primary" href="#/history?code=' + encodeURIComponent(r.code) + '" data-stclose>打开前世今生 ›</a>'
      + '<a class="btn" href="#/lens?code=' + encodeURIComponent(r.code) + '" data-stclose>侧栏透镜</a>'
      + '</div>'
      + sixTimingHtml(r, true) + '</div></div>';
    m.classList.add('open');
    /* 浮层里也有「前瞻胜率」块（sixTimingHtml 自带），不水合会一直显示「正在读取…」 */
    try { hydrateInsights(); } catch (e) {}
  }
  function closeStateDetail() {
    var m = document.getElementById('stModal');
    if (m) m.classList.remove('open');
  }

  function typeLabel(r) {
    if (!r) return '—';
    if (r.kind === 'index') return '指数';
    var k = r.kind || '';
    if (/ETF/i.test(k)) return 'ETF';
    if (/LC|GP|股|STOCK/i.test(k)) return '个股';
    return r.cat || r.kind || '—';
  }

  // ---------- 关注池（本地存储） ----------
  var FOLLOW_KEY = 'ab_follows_v2';
  function getFollows() { try { return JSON.parse(localStorage.getItem(FOLLOW_KEY) || '[]'); } catch (e) { return []; } }
  function setFollows(a) { try { localStorage.setItem(FOLLOW_KEY, JSON.stringify(a)); } catch (e) {} }
  function isFollow(code) { return getFollows().indexOf(code) >= 0; }
  function toggleFollow(code) {
    var a = getFollows(); var i = a.indexOf(code);
    if (i >= 0) a.splice(i, 1); else a.push(code);
    setFollows(a); return a;
  }
  function starHtml(code) { return '<span class="row-star' + (isFollow(code) ? ' on' : '') + '" data-code="' + esc(code) + '">' + (isFollow(code) ? '★' : '☆') + '</span>'; }

  /* ================================================================
   * 统一分析组件：判断日期 / 风险预警 / 历史结论表现 / 六派回测胜率
   * 全站所有显示三态、六派结论的页面共用同一套口径与展示逻辑。
   * ================================================================ */
  function daysFrom(d) {
    if (!d) return null;
    var t = Date.parse(String(d).slice(0, 10) + 'T00:00:00');
    if (!isFinite(t)) return null;
    var a = new Date(t), b = new Date();
    // 用日历日差，避免「昨天」被 24 小时四舍五入算成 2 天
    var da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    var db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.max(0, Math.round((db - da) / 86400000));
  }
  function stateDateInfo(r) {
    var e2 = (r && r.e2) || {}, m = metaInfo();
    var since = sinceOf(r);
    var asOf = dayStr(m.asOf) || dayStr(m.asOfCore) || winEnd('w5');
    return {
      since: since, asOf: asOf, core: dayStr(m.asOfCore) || asOf,
      age: daysFrom(asOf), days: daysOf(r), state: r && r.state,
      capped: !!(r && r.stateCapped),
      bull: r ? bullCount(r) : 0
    };
  }
  /* 判断日期标签：compact 用于表格/列表，full 用于详情页。
   * 明确「依据截至 + 距今 + 状态起点」，让用户自行判断是否仍采纳该结论。 */
  function stateDateTag(r, compact) {
    if (!r) return '';
    var i = stateDateInfo(r), stale = i.age != null && i.age >= 3;
    var d = i.days;
    /* stateDays 是相对「该股 baseDate」数的交易日。个别标的日K 落后（如只到 11-09），
       若只显示「起 11-06 · 已 2 个交易日」，读起来像「11-06 到今天才 2 天」——必须把数据日一起标出来。 */
    var bd = r.baseDate ? String(r.baseDate) : '';
    var baseTxt = bd.length === 8 ? (bd.slice(4, 6) + '-' + bd.slice(6, 8)) : '';
    var core = String(i.core || '').replace(/-/g, '');
    /* 只在该股日K 真的落后时才标「数据日」：全站 asOf 常比 baseDate 晚 1 天（生成日 vs 收盘日），
       差 1 天属正常，不该给每只票都挂一句，否则全是噪音。 */
    var bdGap = 0;
    if (bd.length === 8 && core.length === 8) {
      var tt = function (s) { return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)); };
      bdGap = Math.abs(tt(bd) - tt(core)) / 86400000;
    }
    var lagged = !!(bd && core && bd < core && (r.klStale || bdGap >= 2));
    /* 只讲一件事：这个状态从哪天开始、已经持续多久。
       「判断日」是快照口径，与状态起点并列会让人误以为矛盾，放进 title 说明即可。 */
    var asOfTxt = (i.asOf ? md(i.asOf) : '—') + (i.age != null ? '（距今 ' + i.age + ' 天）' : '');
    var txt = compact
      /* 「起 11-04」是英语语序（since 11-04），中文要说「11-04 起」。 */
      ? (i.since ? (md(i.since) + ' 起' + (d != null ? ' · 已连续 ' + (i.capped ? '≥' : '') + d + ' 个交易日' : ''))
                 : '时间未记录')
      : (i.since ? ('当前状态自 ' + i.since + ' 起' + (d != null ? '，已连续 ' + (i.capped ? '≥' : '') + d + ' 个交易日' : ''))
                 : '当前状态起始日未记录');
    if (lagged && baseTxt) txt += (compact ? ' · 数据日 ' + baseTxt : '（该股日K 只到 ' + baseTxt + '）');
    if (r && r.klStale) txt += ' ⚠日K陈旧';
    return '<span class="st-asof' + (stale ? ' stale' : '') + '" title="判断依据截至 ' + esc(asOfTxt)
      + (lagged && baseTxt ? '；该股日K 只到 ' + esc(baseTxt) + '，比全站基准晚，已持续天数按该股自己的数据日计算' : '')
      + '；三态为阶段判断，不构成投资建议。">'
      + esc(txt) + '</span>';
  }
  function stateDated(r, compact) { return statePill(r && r.state) + stateDateTag(r, compact); }

  /* ---------- 三态「阶段健康度」 ----------
     同样是「启动」，第 1 天和第 12 天的风险完全不同。这里用四个已经真实存在的输入判断：
       ① 已持续交易日 stateDays
       ② 今日实时涨跌 QUOTES
       ③ 较近 20 日高点的回撤（用 rows.closes / 实时序列算）
       ④ 六派票数变化 resonancePrev（live-refresh 重算前存下的旧票数）
     输出四态：新发 / 健康 / 观察 / 退化。阈值是经验值，文案里明写「非概率」，不装成统计结论。 */
  function recentDrawdown(r) {
    var c = (r && (r.__liveCloses || r.closes));
    if (!Array.isArray(c) || c.length < 21) return null;
    var seg = c.slice(-21), hi = -Infinity, i;
    for (i = 0; i < seg.length; i++) if (isNum(seg[i]) && seg[i] > hi) hi = seg[i];
    var last = c[c.length - 1];
    if (!isFinite(hi) || !isNum(last) || hi <= 0) return null;
    return (last / hi - 1) * 100;
  }
  function statePhase(r) {
    if (!r) return null;
    var d = daysOf(r);
    if (d == null) return null;
    var q = QUOTES[r.code], day = (q && isNum(q.chg)) ? q.chg : null;
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
      /* 跌 3%~5%：以前会落到「健康」，但「今天跌 4 个点还叫健康」与直觉严重冲突。
         启动态最怕的就是单日大阴，3% 已经是明确的反向信号，先降为「观察」。 */
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
  function statePhaseTag(r) {
    var p = statePhase(r);
    if (!p) return '';
    return '<span class="phase-tag ' + p.cls + '" title="' + esc(p.why + '（按已持续天数/回撤/票数变化综合分档，经验阈值，非概率）') + '">'
      + esc(p.t) + '</span>';
  }
  function statePhaseNote(r) {
    var p = statePhase(r);
    if (!p || !p.why) return '';
    return '<div class="phase-note ' + p.cls + '"><b>' + esc(p.t) + '</b>：' + esc(p.why)
      + '<span class="cat">按已持续天数 / 回撤 / 六派票数变化分档 · 经验阈值，非概率</span></div>';
  }
  /* 全站唯一的三态展示入口：
       pill + 起X日·已N个交易日 + 阶段标签，整块可点 → 六派依据明细。
     以前 13 处各写各的（有的只有 pill、有的没天数、只有全市场表能点开依据），现在只认这一个。
     opts: { tag:false 不显示阶段标签 / date:false 不显示天数 / click:false 不可点 / long:true 长文案 / missing: 空值占位 } */
  function stateBlock(r, opts) {
    opts = opts || {};
    if (!r) return opts.missing || '<span class="mut">—</span>';
    var body = statePill(r.state)
      + (opts.date === false ? '' : stateDateTag(r, opts.long ? false : true))
      + (opts.tag === false ? '' : statePhaseTag(r));
    if (opts.click === false) return '<span class="st-inline">' + body + '</span>';
    return '<span class="st-click" data-sttime="' + esc(r.code) + '" title="点开查看六派各自判断的时间与依据">'
      + body + '</span>';
  }

  /* ---------- 风险预警（解释「6/6 看启动却跌停」并给出可提前提示的信号） ----------
   * 理论参考（GitHub）：AkatQuas/stock-radar 的 ATR 波动率过高 / RSI 极端 / 均线走弱 /
   * 放量下跌 / 回撤过大 / 跳空低开 / MACD 空头 / CCI 顶部陷阱；
   * Stock-Crash-Early-Warning-System 的 RSI14+波动率+量能突增+单日跌≥5%；
   * 动量崩溃（momentum crash）与滚动波动率 EWS。 */
  var RISK_THEORY = '风险信号口径参考 GitHub：AkatQuas/stock-radar（ATR/RSI/放量下跌/回撤/跳空/MACD 空头/CCI 顶部陷阱）、Stock-Crash-Early-Warning-System（RSI14 + 波动率 + 量能突增 + 单日跌≥5%），以及动量崩溃与滚动波动率预警（EWS）。均为客观历史条件，<b>不预测未来</b>。';
  function techStats(bars) {
    if (!bars || bars.length < 25) return null;
    var c = bars.map(function (b) { return b.c; }), v = bars.map(function (b) { return b.v || 0; });
    var n = c.length;
    function avg(a, k) { var s = 0; for (var i = n - k; i < n; i++) s += a[i]; return s / k; }
    var ma5 = avg(c, 5), ma20 = avg(c, 20), ma60 = n >= 60 ? avg(c, 60) : null;
    var v20 = avg(v, 20) || 1;
    var gains = 0, losses = 0, i;
    for (i = n - 14; i < n; i++) { var d = c[i] - c[i - 1]; if (d > 0) gains += d; else losses -= d; }
    var rsi = losses ? 100 - 100 / (1 + gains / losses) : 100;
    var rets = [];
    for (i = n - 20; i < n; i++) rets.push(c[i] / c[i - 1] - 1);
    var mr = rets.reduce(function (a, b) { return a + b; }, 0) / rets.length;
    var vol = Math.sqrt(rets.reduce(function (a, b) { return a + (b - mr) * (b - mr); }, 0) / rets.length) * 100;
    var hi = Math.max.apply(null, c.slice(-60));
    return {
      ma5: ma5, ma20: ma20, ma60: ma60, rsi: rsi, vol: vol,
      last: bars[n - 1], prev: bars[n - 2], volRatio: (v[n - 1] || 0) / v20,
      drawdown: (c[n - 1] / hi - 1) * 100
    };
  }
  function riskAlerts(r, q, bars) {
    var out = [], p = r.pct || {}, chg = q && q.chg, i = stateDateInfo(r), t = techStats(bars);
    // ① 快照结论与当日走势背离（闽发铝业 6/6 却跌停的根因解释）
    if (isNum(chg) && chg <= -5 && i.bull >= 4) {
      out.push({ lv: 'high', t: '快照结论与当日走势背离',
        d: '六派 ' + i.bull + '/6 看启动、三态为「' + esc(r.state) + '」，但今日 <b>' + pct(chg) + '</b>。'
          + '快照判断依据截至 ' + (i.core || i.asOf) + '，<b>不含当日</b>，六派不是对今天行情的预测；当日大跌属结论生成之后的新信息，需重新评估。' });
    } else if (isNum(chg) && chg <= -3 && r.state === '启动') {
      out.push({ lv: 'mid', t: '启动态与当日走势背离',
        d: '今日 ' + pct(chg) + '，与快照「启动」阶段判断不一致；快照不含当日，可核对状态是否即将切换。' });
    }
    // ② 判断依据陈旧
    if (i.age != null && i.age >= 3) {
      out.push({ lv: i.age >= 5 ? 'high' : 'mid', t: '判断依据距今 ' + i.age + ' 天',
        d: '三态 / 六派结论基于 ' + (i.asOf || '—') + ' 的快照与再生口径，未逐日重算；间隔越久，结论失效可能性越高，请自行判断是否仍采纳。' });
    }
    // ③ 涨幅透支 / 拥挤（动量崩溃前置条件）
    if (isNum(p.w20) && p.w20 >= 50) out.push({ lv: 'mid', t: '近20日 ' + pct(p.w20) + ' · 短期涨幅透支',
      d: '短期涨幅过大时，动量崩溃（momentum crash）与获利回吐风险上升；可核对量能是否衰竭。' });
    if (isNum(p.w60) && p.w60 >= 100) out.push({ lv: 'mid', t: '近60日 ' + pct(p.w60) + ' · 拥挤度偏高',
      d: '中期累积涨幅较大，交易拥挤时负面信息的冲击常被放大（客观历史规律，非预测）。' });
    // ④ 日K 技术预警（有真实日K才给）
    if (t) {
      if (t.rsi >= 70) out.push({ lv: 'mid', t: 'RSI14 = ' + fmt(t.rsi, 1) + ' · 超买区', d: '参考 RSI 极端与顶部陷阱信号；超买后回落属常见历史形态。' });
      if (t.last.c < t.ma20) out.push({ lv: 'mid', t: '收盘跌破 MA20', d: '最新收盘 ' + fmt(t.last.c, 2) + ' 低于 20 日均线 ' + fmt(t.ma20, 2) + '，中期均线支撑转弱。' });
      if (t.volRatio >= 2 && t.last.c < t.prev.c) out.push({ lv: 'high', t: '放量下跌 · 量比 ' + fmt(t.volRatio, 1) + '×', d: '成交量显著高于 20 日均量且收阴，参考 Volume Selloff 风险信号。' });
      if (t.drawdown <= -20) out.push({ lv: 'mid', t: '距 60 日高点回撤 ' + fmt(t.drawdown, 1) + '%', d: '回撤过大是常见风险标记（客观历史事实）。' });
      if (t.vol >= 5) out.push({ lv: 'mid', t: '20 日波动率 ' + fmt(t.vol, 1) + '% · 波动放大', d: '滚动波动率抬升是 EWS 常用的风险前置条件。' });
    }
    if (!out.length) out.push({ lv: 'ok', t: '未触发预设风险条件', d: '这不代表无风险；快照结论仍不含当日，且所有模型都无法覆盖突发消息、停牌、政策等事件。' });
    return out;
  }
  function riskHtml(r, q, bars) {
    var list = riskAlerts(r, q, bars);
    return '<div class="risk-box"><div class="risk-hd">⚠ 风险提示 · 结论时效'
      + '<span class="cat">客观历史数据 · 非预测 · 不构成投资建议</span></div>'
      + list.map(function (a) {
        return '<div class="risk-item ' + a.lv + '"><b>' + esc(a.t) + '</b><span>' + a.d + '</span></div>';
      }).join('')
      + '<div class="risk-theory">' + RISK_THEORY + '</div></div>';
  }

  /* ---------- 历史三态结论 + 结论后涨跌幅 ----------
   * series 固定 5 个锚点：约250/60/20/5日前 + 今日；x[2]＝该锚点到今日涨跌幅。
   * stateHistory 的 back 与之一一对应（back=0 对应「今日」，尚无后续区间）。 */
  /* ============================================================
   * 前瞻统计引擎（2026-11-13 用户确认口径）
   * GitHub 依据：injoyai/strategy-tail「买入信号未来N天收益分析」（信号数/平均收益/
   *   胜率/最大收益/最大亏损汇总表）、PEAD-Validation（+5/+21/+63 交易日）、
   *   QuantMind 事件研究（T+0~T+20 累计收益与胜率曲线）、
   *   kronos-india signal tracker（n / Wins / Win rate / Expectancy）。
   * 口径：
   *  - 周期 +5 / +21 / +63 交易日 ≈ 1周 / 1月 / 3月；基准为信号日收盘，
   *    统计区间从 T+1 开始（执行滞后一根K线，避免前视偏差）。
   *  - 方向胜率：看多上涨记赢 / 看空下跌记赢 / 盘整按振幅收敛记赢
   *    （1周 |涨跌|<5%、1月 <12%、3月 <25%，仅衡量是否维持震荡）。
   *  - 每周期给 样本数·方向胜率·平均方向收益·中位收益·到最高点最大涨幅(MFE)·
   *    到最低点最大跌幅(MAE)·终点涨跌。
   *  - 信号定义：三态按「状态切换日」；六派按「各派由中性转多/转空的独立触发日」，
   *    因此各派样本数不同。
   *  - 样本来自前复权日K 逐日重算，不是快照 4 个锚点（那 4 个只作个案幅度）。
   * ============================================================ */
  var HORIZONS = [
    { key: 'w1', n: 5, t: '约1周' },
    { key: 'm1', n: 21, t: '约1月' },
    { key: 'm3', n: 63, t: '约3月' }
  ];
  var KLINE_CACHE = {};   // code -> {p, bars, source}；全站共享，避免重复请求
  var KLINE_CAP_MS = 9000;   // 整体超时上限：4 源 × 9s 会拖到 36s，这里封顶，避免「永久卡在加载」
  function klineFor(code) {
    var c = KLINE_CACHE[code];
    if (c && c.p) return c.p;
    var src = DS.getKline(code, 3000);
    var p = new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (done) return; done = true; resolve(null); }, KLINE_CAP_MS);
      src.then(function (k) { if (done) return; done = true; clearTimeout(t); resolve(k); })
        .catch(function () { if (done) return; done = true; clearTimeout(t); resolve(null); });
    });
    KLINE_CACHE[code] = { p: p, bars: null, source: null };
    p.then(function (k) {
      KLINE_CACHE[code] = { p: p, bars: (k && k.bars) || null, source: k && k.source };
    });
    return p;
  }
  function cachedBars(code) { var c = KLINE_CACHE[code]; return c && c.bars && c.bars.length > 80 ? c.bars : null; }
  function medianOf(a) { if (!a.length) return null; var b = a.slice().sort(function (x, y) { return x - y; }); return b[Math.floor(b.length / 2)]; }
  function dateIndex(dates, d) {
    if (!d || !dates || !dates.length) return -1;
    var s = String(d).slice(0, 10), i;
    var first = String(dates[0]).slice(0, 10), last = String(dates[dates.length - 1]).slice(0, 10);
    if (s < first || s > last) return -1;   // 早于日K 起点：交给 back 天数兜底
    for (i = 0; i < dates.length; i++) { if (String(dates[i]).slice(0, 10) === s) return i; }
    for (i = 0; i < dates.length; i++) { if (String(dates[i]).slice(0, 10) >= s) return i; }
    return -1;
  }
  /* 历史锚点定位：优先按真实日期；日K 覆盖不到时按「约 N 交易日前」估算 */
  function caseIndex(ds, x) {
    var i = dateIndex(ds.dates, dayStr(x.date) || x.date);
    if (i >= 0) return i;
    var b = Number(x.back);
    return isFinite(b) && b > 0 ? Math.max(0, ds.n - 1 - Math.round(b)) : -1;
  }
  /* 逐日重算：三态状态序列 + 六派每日方向票。三态为可解释的阶段代理规则，
   * 与快照「阶段判断」同向但非快照原文模型，页面会明确标注。 */
  function dailySignals(bars) {
    var sig = sixSignals(bars), n = bars.length, i;
    var close = bars.map(function (b) { return b.c; });
    var clma = buildPMA(close); // P1：前缀和，O(1) 取 MA20
    var high = bars.map(function (b) { return isNum(b.h) && b.h > 0 ? b.h : b.c; });
    var low = bars.map(function (b) { return isNum(b.l) && b.l > 0 ? b.l : b.c; });
    var dates = bars.map(function (b) { return b.d; });
    var states = new Array(n);
    for (i = 0; i < n; i++) {
      if (i < 62) { states[i] = '盘整'; continue; }
      var bull = 0, bear = 0;
      SIX.forEach(function (s) { var v = sig[s.k][i] || 0; if (v > 0) bull++; else if (v < 0) bear++; });
      var ma20 = clma(i, 20);
      /* 与实时引擎对齐的两条门槛（引擎在 six-engine.js 的「三态判定」）：
         ① 启动必须至少有一张结构票（引擎要求 votes.structure > 0）
         ② 走完除「空票 ≥4 且跌破 MA20」外，还有绝对趋势闸门：60 日与 250 日同时 ≤ -10%
         仍不等于完全同源（引擎还有 veto 否决项、结构阈值、舆情票约束），
         所以页面文案写「近似规则」，不冒充实盘口径。 */
      var stv = (sig.structure && sig.structure[i]) || 0;
      var w60i = i >= 60 ? (close[i] / close[i - 60] - 1) * 100 : null;
      var w250i = i >= 250 ? (close[i] / close[i - 250] - 1) * 100 : null;
      if (bull >= 4 && stv > 0 && (!ma20 || close[i] >= ma20)) states[i] = '启动';
      else if ((w60i != null && w250i != null && w60i <= -10 && w250i <= -10)
        || (bear >= 4 && ma20 && close[i] < ma20)) states[i] = '走完';
      else states[i] = '盘整';
    }
    return { sig: sig, states: states, close: close, high: high, low: low, dates: dates, n: n };
  }
  /* 由真实日K 逐日重算的三态「连续段」：用于历史三态演化带 + K 线背景着色。
   * 直接回应「6/5–7/22 明明是上涨启动，为什么页面只给走完」——这里按真实日K 重算，
   * 那段若被规则判为启动会显示为蓝带，与快照当前态相互独立。 */
  function stateRuns(bars) {
    if (!bars || bars.length < 63) return null;
    var ds = dailySignals(bars), st = ds.states, d = ds.dates, n = ds.n, runs = [], i = 0;
    while (i < n) {
      var s = st[i], j = i;
      while (j + 1 < n && st[j + 1] === s) j++;
      runs.push({ state: s, i0: i, i1: j, d0: d[i], d1: d[j], days: j - i + 1 });
      i = j + 1;
    }
    return { runs: runs, ds: ds };
  }
  /* 事件：三态切换日（每个状态段只记一次）+ 六派各派独立触发日 */
  function buildEvents(ds) {
    var st = [], six = {}, i;
    SIX.forEach(function (s) { six[s.k] = []; });
    for (i = 62; i < ds.n; i++) {
      if (ds.states[i] !== ds.states[i - 1]) {
        var s = ds.states[i];
        st.push({ i: i, date: ds.dates[i], state: s, dir: s === '启动' ? 1 : (s === '走完' ? -1 : 0) });
      }
      SIX.forEach(function (p) {
        var v = ds.sig[p.k][i] || 0, pv = ds.sig[p.k][i - 1] || 0;
        /* 独立触发日：方向发生变化的当天才算新信号（含 0→多空、多→空翻转）。
         * 只认「0→非0」会让 OBV / 量能这类几乎不回中性的因子样本为 0。 */
        if (v !== 0 && v !== pv) six[p.k].push({ i: i, date: ds.dates[i], dir: v });
      });
    }
    return { states: st, six: six };
  }
  function forwardStats(ds, events) {
    return HORIZONS.map(function (h) {
      var cnt = 0, win = 0, sum = 0, rets = [], mf = [], ma = [], ends = [];
      events.forEach(function (ev) {
        var i = ev.i, j = Math.min(ds.n - 1, i + h.n);
        if (j <= i || !(ds.close[i] > 0)) return;
        var base = ds.close[i], hi = -Infinity, lo = Infinity, t;
        for (t = i + 1; t <= j; t++) { if (ds.high[t] > hi) hi = ds.high[t]; if (ds.low[t] < lo) lo = ds.low[t]; }
        var end = (ds.close[j] / base - 1) * 100;
        var up = (hi / base - 1) * 100, dn = (lo / base - 1) * 100;
        var d = ev.dir, ok;
        /* 中性（盘整）信号以「区间振幅收敛」为胜，阈值随周期放大，
         * 否则 1 月 / 3 月用固定 3% 会得到接近 0 的无意义胜率。 */
        if (d > 0) ok = end > 0;
        else if (d < 0) ok = end < 0;
        else ok = Math.abs(end) < (h.n <= 5 ? 5 : (h.n <= 21 ? 12 : 25));
        if (ok) win++;
        var signed = d === 0 ? end : d * end;
        cnt++; sum += signed; rets.push(signed); mf.push(up); ma.push(dn); ends.push(end);
      });
      var avgOf = function (a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; };
      return {
        key: h.key, t: h.t, n: h.n, count: cnt,
        winRate: cnt ? win / cnt * 100 : null,
        avg: cnt ? sum / cnt : null, median: medianOf(rets),
        mfeAvg: avgOf(mf), maeAvg: avgOf(ma), endAvg: avgOf(ends),
        mfeMax: mf.length ? Math.max.apply(null, mf) : null,
        maeMin: ma.length ? Math.min.apply(null, ma) : null
      };
    });
  }
  function statGroups(ds) {
    var ev = buildEvents(ds), gs = [];
    ['启动', '盘整', '走完'].forEach(function (s) {
      gs.push({ name: s, detail: '状态切换日（首次进入该状态）',
        stats: forwardStats(ds, ev.states.filter(function (x) { return x.state === s; })) });
    });
    SIX.forEach(function (s) {
      gs.push({ name: s.n + '派', detail: SIX_FACTOR[s.k], k: s.k,
        stats: forwardStats(ds, ev.six[s.k]) });
    });
    return { groups: gs, events: ev, stateGroups: gs.slice(0, 3), sixGroups: gs.slice(3) };
  }
  function wrCell(st) {
    if (!st || !st.count) return '<td class="mut">—</td>';
    if (st.winRate == null) return '<td class="mut">样本不足</td>';
    var cls = st.winRate >= 55 ? 'fw-hi' : (st.winRate < 45 ? 'fw-lo' : '');
    return '<td><b class="' + cls + '">' + fmt(st.winRate, 1) + '%</b></td>';
  }
  function forwardTable(groups, title, note) {
    var rows = groups.map(function (g) {
      var m1 = g.stats[1];
      return '<tr><td class="nm"><b>' + esc(g.name) + '</b><span class="cat">' + esc(g.detail) + '</span></td>'
        + '<td>' + (m1.count || '—') + '</td>'
        + g.stats.map(wrCell).join('')
        + '<td class="' + (m1.avg != null ? signCls(m1.avg) : 'mut') + '">' + (m1.avg != null ? pct(m1.avg) : '—') + '</td>'
        + '<td class="up">' + (m1.mfeAvg != null ? pct(m1.mfeAvg) : '—') + '</td>'
        + '<td class="down">' + (m1.maeAvg != null ? pct(m1.maeAvg) : '—') + '</td>'
        + '</tr>';
    }).join('');
    return '<div class="fw"><div class="fw-t">' + esc(title) + '</div>'
      + '<table class="st-table fw-table"><thead><tr><th>信号</th><th>1月样本</th>'
      + '<th>1周胜率</th><th>1月胜率</th><th>3月胜率</th>'
      + '<th>1月平均方向收益</th><th>1月内到最高点</th><th>1月内到最低点</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table>' + (note ? '<div class="risk-theory">' + note + '</div>' : '') + '</div>';
  }
  function anchorOf(r, back) {
    var label = Number(back) === 0 ? '今日' : '约' + back + '日前';
    var s = (Array.isArray(r.series) ? r.series : []).filter(function (x) { return x[0] === label; })[0];
    return s ? { label: s[0], val: Number(s[1]), chg: Number(s[2]) } : null;
  }
  function historyOutcomes(r) {
    var hist = (r.e2 && Array.isArray(r.e2.stateHistory)) ? r.e2.stateHistory : [];
    var order = [250, 60, 20, 5, 0];
    return hist.map(function (x) {
      var b = Number(x.back), a = anchorOf(r, b);
      var near = order.filter(function (o) { return o < b; }).sort(function (p, q2) { return q2 - p; })[0];
      var an = near != null ? anchorOf(r, near) : null;
      var seg = (a && an && isNum(a.val) && a.val) ? (an.val / a.val - 1) * 100 : null;
      return {
        date: dayStr(x.date) || x.date, state: x.state, back: b,
        label: a ? a.label : '—', toNow: a && isNum(a.chg) ? a.chg : null,
        toNext: isNum(seg) ? seg : null, nextLabel: an ? an.label : null
      };
    });
  }
  /* ---------- 快照历史结论 · 个案幅度 ----------
   * 用户口径：某日给出「启动」，就给「从启动到最高点涨了多少 / 盘整区间 /
   * 走完后下跌了多少」。状态区间 = 该结论日 → 下一个结论日；有日K 时用真实
   * 前复权高低点算 MFE / MAE，无日K 时退回快照归一化锚点并明确标注。
   * 注意：这 4 个锚点是「个案」，样本=1，不参与上方前瞻胜率统计。 */
  function anchorCaseRows(r, bars) {
    var hist = ((r.e2 && Array.isArray(r.e2.stateHistory)) ? r.e2.stateHistory : [])
      .slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
    var ds = bars && bars.length > 80 ? dailySignals(bars) : null;
    var snap = historyOutcomes(r);
    return hist.map(function (x, idx) {
      var next = hist[idx + 1];
      var out = {
        date: dayStr(x.date) || x.date, state: x.state,
        up: null, dn: null, end: null, span: null, basis: '快照归一化锚点', days: null
      };
      if (ds) {
        var i = caseIndex(ds, x);
        var j = next ? caseIndex(ds, next) : ds.n - 1;
        if (i >= 0 && j > i && ds.close[i] > 0) {
          var base = ds.close[i], hi = -Infinity, lo = Infinity, t, hiAt = i, loAt = i;
          for (t = i + 1; t <= Math.min(j, ds.n - 1); t++) {
            if (ds.high[t] > hi) { hi = ds.high[t]; hiAt = t; }
            if (ds.low[t] < lo) { lo = ds.low[t]; loAt = t; }
          }
          out.up = (hi / base - 1) * 100;
          out.dn = (lo / base - 1) * 100;
          out.end = (ds.close[Math.min(j, ds.n - 1)] / base - 1) * 100;
          out.span = ds.dates[i] + ' ~ ' + ds.dates[Math.min(j, ds.n - 1)];
          out.days = Math.max(hiAt - i, loAt - i);
          out.basis = '前复权日K';
        }
      }
      if (out.end == null) {
        var o = snap.filter(function (z) { return String(z.date).slice(0, 10) === String(out.date).slice(0, 10); })[0];
        if (o) out.end = o.toNext != null ? o.toNext : o.toNow;
      }
      return out;
    });
  }
  function outcomeHtml(r, compact) {
    var rows = anchorCaseRows(r, cachedBars(r.code));
    if (!rows.length) return '<div class="hint">快照未记录历史状态节点，暂无个案幅度可核对。</div>';
    var rowsHtml = rows.map(function (x) {
      var cell = function (v) { return isNum(v) ? '<span class="' + signCls(v) + '">' + pct(v) + '</span>' : '<span class="mut">—</span>'; };
      return '<tr><td>' + esc(x.date || '—') + '</td><td>' + statePill(x.state) + '</td>'
        + '<td>' + (x.span ? esc(x.span) + '<span class="cat">' + esc(x.basis) + '</span>' : '<span class="cat">' + esc(x.basis) + ' · 无日K区间</span>')
        + '</td><td>' + cell(x.up) + '</td><td>' + cell(x.dn) + '</td><td>' + cell(x.end) + '</td>'
        + '<td>' + (x.days != null && x.days > 0 ? esc(x.days) + ' 交易日' : '—') + '</td></tr>';
    }).join('');
    return '<div class="outcome' + (compact ? ' compact' : '') + '">'
      + '<div class="out-sum">每个历史结论给出<b>该状态区间内（结论日 → 下一个结论日）的'
      + '到最高点最大涨幅 / 到最低点最大跌幅 / 区间终点涨跌</b>：'
      + '<b>启动看上行、盘整看振幅、走完看下行</b>'
      + '<span class="cat">仅 ' + rows.length + ' 个个案、样本=1，不参与胜率统计</span></div>'
      + '<div class="m-scroll-hint">← 表格可左右滑动 →</div>'
      + '<table class="st-table"><thead><tr><th>结论日期</th><th>当时三态</th><th>状态区间 · 依据</th>'
      + '<th>区间内到最高点</th><th>区间内到最低点</th><th>区间终点</th><th>极值到达</th></tr></thead>'
      + '<tbody>' + rowsHtml + '</tbody></table>'
      + '<div class="risk-theory">幅度由<b>前复权日K 的真实最高/最低价</b>相对结论日收盘计算；'
      + '日K 不可用时退回快照归一化锚点反推（今日=100）并标注依据。以上为<b>客观历史涨跌幅</b>，'
      + '三态是阶段判断、不是涨跌建议，<b>不构成投资建议，不预示未来收益</b>。</div></div>';
  }
  /* ---------- 六派历史方向命中率（浏览器端日K 现场回测） ----------
   * 参考 GitHub：kronos-india signal tracker（Total signals / Wins / Win rate / Expectancy）、
   * multi-strategy-backtester（执行滞后一根 K 线，避免前视偏差）、walk-forward 样本外口径。
   * 口径：T 日算出的方向信号，只用 T+1 收盘收益判定命中；仅统计非中性信号。
   * 注意：历史资讯密度序列不可得，舆情派用「量能异动方向」作可解释的代理因子。 */
  function maAt(c, i, k) {
    if (i < k - 1) return null;
    var s = 0, j;
    for (j = i - k + 1; j <= i; j++) s += c[j];
    return s / k;
  }
  /* 前缀和 MA：O(n) 构建一次，之后 O(1) 取任意窗口均值（替代 maAt 的 O(k) 每次重算，见 P1） */
  function buildPMA(arr) {
    var n = arr.length, pre = new Array(n + 1); pre[0] = 0;
    for (var i = 1; i <= n; i++) pre[i] = pre[i - 1] + (isNum(arr[i - 1]) ? arr[i - 1] : 0);
    return function (i, k) {
      if (i < k - 1) return null;
      return (pre[i + 1] - pre[i + 1 - k]) / k;
    };
  }
  function sixSignals(bars) {
    var c = bars.map(function (b) { return b.c; }), v = bars.map(function (b) { return b.v || 0; });
    var n = c.length, obv = [0], i, j;
    for (i = 1; i < n; i++) obv.push(obv[i - 1] + (c[i] > c[i - 1] ? v[i] : (c[i] < c[i - 1] ? -v[i] : 0)));
    var out = { structure: [], volume: [], fund: [], senti: [], config: [], news: [] };
    /* 前缀和：MA / 均量一次构建，循环内 O(1) 取均值（P1，原 maAt 为 O(k) 每次重算） */
    var cma = buildPMA(c), vma = buildPMA(v);
    for (i = 0; i < 61; i++) { Object.keys(out).forEach(function (k) { out[k].push(0); }); }
    for (i = 61; i < n; i++) {
      var ma20 = cma(i, 20), ma60 = cma(i, 60), ma60p = cma(i - 10, 60), ma20p = cma(i - 5, 20);
      var r5 = (c[i] / c[i - 5] - 1) * 100;
      var v20 = vma(i - 1, 20) || 1;
      var g = 0, l = 0;
      for (j = i - 13; j <= i; j++) { var d = c[j] - c[j - 1]; if (d > 0) g += d; else l -= d; }
      var rsi = l ? 100 - 100 / (1 + g / l) : 100;
      out.structure.push(c[i] > ma60 && ma60 >= ma60p ? 1 : (c[i] < ma60 && ma60 < ma60p ? -1 : 0));
      out.volume.push(r5 > 1 && v[i] > v20 ? 1 : (r5 < -1 && v[i] > v20 ? -1 : 0));
      out.fund.push(obv[i] > obv[i - 10] ? 1 : (obv[i] < obv[i - 10] ? -1 : 0));
      out.senti.push(rsi > 55 ? 1 : (rsi < 45 ? -1 : 0));
      out.config.push(ma20 > ma20p && c[i] > ma20 ? 1 : (ma20 < ma20p && c[i] < ma20 ? -1 : 0));
      /* 舆情派历史资讯序列不可得，用「量能异动 + 当日方向」作代理：
       * 放量 >1.25× 或 缩量 <0.72× 前20日均量均记异动（原 2× 过严，正常行情几乎无样本）。 */
      out.news.push((v[i] > 1.25 * v20 || v[i] < 0.72 * v20) ? (c[i] >= c[i - 1] ? 1 : -1) : 0);
    }
    return out;
  }
  /* 注意：以下为「浏览器端日K 回测代理因子」，与透镜里实时六派引擎公式（six-engine.js analyze）并不相同；
   * 回测只统计各代理因子由中性转多 / 转空的历史方向胜率，不代表实时模型的胜率。 */
  var SIX_FACTOR = {
    structure: '回测代理·收盘 vs MA60 且 MA60 方向（≠ 实时结构分）',
    volume: '回测代理·近5日动量 + 放量',
    fund: '回测代理·OBV 10 日净变化',
    senti: '回测代理·RSI14（>55 / <45）',
    config: '回测代理·MA20 斜率 + 价格位置',
    news: '回测代理·成交量异动方向（舆情历史序列不可得）'
  };
  function sixBacktest(r, bars) {
    if (!bars || bars.length < 80) return { ok: false, bars: bars ? bars.length : 0 };
    var ds = dailySignals(bars);
    return { ok: true, source: 'kline', bars: bars.length, ds: ds, stats: statGroups(ds) };
  }
  function backtestHtml(r, bt) {
    if (!bt || !bt.ok) {
      return '<div class="ind-empty">前复权日K 暂不可用（已尝试 离线静态 / 东财 push2his / 东财 push2 / 腾讯 / 新浪）：'
        + '<b>暂无足够样本计算前瞻胜率</b>，缺口如实标注，不以零代替。下方快照历史结论的个案幅度仍可查看。</div>';
    }
    var ev = bt.stats.events, nState = ev.states.length, nSix = 0;
    Object.keys(ev.six).forEach(function (k) { nSix += ev.six[k].length; });
    return '<div class="bt-sum">口径：基于近 <b>' + bt.bars + '</b> 根前复权日K <b>逐日重算</b>三态与六派信号，'
      + '共 <b>' + nState + '</b> 个三态切换日 / <b>' + nSix + '</b> 个六派独立触发日；'
      + '信号日收盘为基准，统计 T+5 / T+21 / T+63 交易日（约1周 / 1月 / 3月），'
      + '看多上涨记赢、看空下跌记赢；<b>盘整（中性）按振幅收敛记赢</b>'
      + '（1周 |涨跌|&lt;5%、1月 &lt;12%、3月 &lt;25%，阈值随周期放大，仅衡量是否维持震荡）。</div>'
      + forwardTable(bt.stats.stateGroups, '三态信号 · 出现后前瞻表现',
          '三态按「状态切换日」计一次信号，每个状态段不重复计数。「到最高点 / 到最低点」为该周期内相对信号日收盘的最大有利 / 不利偏移均值。')
      + forwardTable(bt.stats.sixGroups, '六派信号 · 各派独立触发日',
          '各派按「该派<b>回测代理因子</b>由中性转多 / 转空」的触发日分别计数，<b>各派样本数不同</b>；'
          + '舆情派因缺历史资讯序列，以量能异动方向作代理。<b>这些代理因子与透镜实时六派公式不同，胜率不可混用。</b>')
      + '<div class="risk-theory">说明：以上为<b>浏览器端用前复权日K 现场逐日重算的代理回测</b>，'
      + '不是快照里六派原文模型的历史信号序列，也不含交易成本与滑点；重叠窗口未做去相关处理。'
      + '三态 / 六派是阶段判断，<b>历史胜率不预示未来、不构成投资建议</b>。'
      + '若需逐派真实历史信号胜率，需 DATA 再生脚本输出每派历史状态序列。</div>';
  }
  /* ---------- 全站统一展示块 ----------
   * 判断日期 + 风险预警 + 快照历史结论个案幅度 + 三态/六派前瞻胜率。
   * 透镜 / 前世今生 / 体检 / 全市场展开面板 / 行业成分股全部复用同一口径。 */
  function insightBlock(r, q, skipOutcome) {
    var code = esc(r.code);
    return '<div class="insight" data-insight-code="' + code + '">'
      + '<div class="insight-hd">结论时效 · 风险提示 · 历史表现 <span class="cat">全站统一口径</span></div>'
      + stateDateTag(r, false)
      + '<div class="insight-risk">' + riskHtml(r, q || {}, null) + '</div>'
      + (skipOutcome ? '' : '<div class="insight-sec"><h4>快照历史结论 · 个案幅度</h4>'
          + '<div class="insight-case" data-case-code="' + code + '">' + outcomeHtml(r, true) + '</div></div>')
      + '<div class="insight-sec"><h4>三态 / 六派信号 · 前瞻胜率（1周 / 1月 / 3月）</h4>'
      + '<div class="insight-bt"><div class="hint">正在读取前复权日K 并逐日重算历史信号…</div></div></div>'
      + '</div>';
  }
  function fillAll(sel, html) {
    if (!document.querySelectorAll) return;
    Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) { el.innerHTML = html; });
  }
  /* 异步水合：日K 到位后统一补 胜率表 / 技术预警 / 个案幅度 / 六派每行胜率。
   * klineFor 带全站缓存，多个页面、多次渲染不会重复请求。 */
  /* 手机上宽表格会超出屏幕，这里给每个「真的能横向滚动」的表加一行提示，
     并在缩回桌面宽度时自动移除。判断依据是 scrollWidth > clientWidth，不猜。 */
  function markScrollHints() {
    var wraps = document.querySelectorAll('.table-wrap');
    for (var i = 0; i < wraps.length; i++) {
      var w = wraps[i];
      var need = w.scrollWidth > w.clientWidth + 6;
      var prev = w.previousElementSibling;
      var has = prev && prev.className && String(prev.className).indexOf('m-scroll-hint') >= 0;
      if (need && !has) {
        var d = document.createElement('div');
        d.className = 'm-scroll-hint';
        d.textContent = '← 左右滑动查看全部列 →';
        w.parentNode.insertBefore(d, w);
      } else if (!need && has) {
        prev.parentNode.removeChild(prev);
      }
    }
  }

  function hydrateInsights() {
    var codes = {}, sel = function (s) { return document.querySelectorAll ? document.querySelectorAll(s) : []; };
    Array.prototype.forEach.call(sel('.insight[data-insight-code]'), function (el) {
      var c = el.getAttribute('data-insight-code'); if (c) codes[c] = 1;
    });
    Array.prototype.forEach.call(sel('[data-evi-wr]'), function (el) {
      var v = String(el.getAttribute('data-evi-wr') || '').split('|')[0]; if (v) codes[v] = 1;
    });
    Array.prototype.forEach.call(sel('.arch-wrap[data-archive-code]'), function (el) {
      var v = el.getAttribute('data-archive-code'); if (v) codes[v] = 1;
    });
    /* 三态演化带容器：抽屉里只有它，没有 insight/arch 容器，也必须被收集 */
    Array.prototype.forEach.call(sel('.evo-wrap[data-evo-code]'), function (el) {
      var v = el.getAttribute('data-evo-code'); if (v) codes[v] = 1;
    });
    Array.prototype.forEach.call(sel('.kl-wrap[data-kl-code]'), function (el) {
      var v = el.getAttribute('data-kl-code'); if (v) codes[v] = 1;
    });
    Object.keys(codes).forEach(function (code) {
      var r = DS.snapshot(code);
      klineFor(code).then(function (k) {
        var bars = k && k.bars, bt = sixBacktest(r, bars);
        var root = '.insight[data-insight-code="' + code + '"]';
        fillAll(root + ' .insight-bt', backtestHtml(r, bt));
        fillAll(root + ' .insight-risk', riskHtml(r, QUOTES[code] || {}, bars));
        if (r) {
          fillAll('.insight-case[data-case-code="' + code + '"]', outcomeHtml(r, true));
          fillAll('.arch-wrap[data-archive-code="' + code + '"]', historyArchive(r, bars));
          fillAll('.evo-wrap[data-evo-code="' + code + '"]', historyStateEvolution(r, bars));
          var px = (QUOTES[code] && isNum(QUOTES[code].price)) ? QUOTES[code].price
            : (bars && bars.length && isNum(bars[bars.length - 1].c) ? bars[bars.length - 1].c : null);
          if (px) {
            fillAll('.kl-wrap[data-kl-code="' + code + '"]',
              '<div class="ds-h" style="margin-top:14px">关键价位 <span class="cat">上方压力 / 下方支撑 · 来自前复权日K</span></div>'
              + keyLevelsHtml(r, bars, px));
          }
        }
        var g = {};
        if (bt.ok) bt.stats.sixGroups.forEach(function (x) { g[x.k] = x.stats[1]; });
        Array.prototype.forEach.call(sel('[data-evi-wr]'), function (el) {
          var v = String(el.getAttribute('data-evi-wr') || '').split('|');
          if (v[0] !== code) return;
          var st = g[v[1]];
          el.innerHTML = (st && st.count)
            ? '<b class="' + (st.winRate >= 55 ? 'fw-hi' : (st.winRate < 45 ? 'fw-lo' : '')) + '">'
              + fmt(st.winRate, 0) + '%</b> 历史1月胜率 · n=' + st.count
            : '<span class="mut">历史胜率：样本不足</span>';
        });
      }).catch(function () {
        var root = '.insight[data-insight-code="' + code + '"]';
        fillAll(root + ' .insight-bt', backtestHtml(r, { ok: false }));
        Array.prototype.forEach.call(sel('[data-evi-wr]'), function (el) {
          if (String(el.getAttribute('data-evi-wr') || '').split('|')[0] === code) {
            el.innerHTML = '<span class="mut">历史胜率：日K 不可用</span>';
          }
        });
      });
    });
    try { window.dispatchEvent(new Event('ab:hydrated')); } catch (e) {}
  }
  /* ---------- 原生 Canvas K 线（零依赖，不依赖 ECharts CDN） ----------
   * 参考 GitHub：klinecharts/KLineChart（Canvas 零依赖 K 线）、Vibe-Research /
   * hanai-investment-dsh（概览页直接给 5/10/20/60 均线 + 成交量 + 前复权日K）。
   * 有日K画蜡烛 + MA5/MA20 + 成交量；无日K画快照归一化净值折线，永不空白。 */
  var UP_C = '#e0433a', DOWN_C = '#16a06a';   // A 股约定：红涨绿跌
  function drawCanvasChart(el, cfg) {
    if (!el) return;
    var bars = cfg.bars || [], series = cfg.series || [];
    /* 全历史日K 可能上千根，主图只画最近 N 根（统计仍用全量） */
    var showLast = cfg.showLast || 120;
    if (bars.length > showLast) bars = bars.slice(-showLast);
    var mode = bars.length > 1 ? 'kline' : (series.length > 1 ? 'line' : 'empty');
    try {
      el.innerHTML = '';
      if (mode === 'empty') { el.innerHTML = '<div class="ind-empty">暂无可用行情数据；下方锚点卡仍可查看。</div>'; return; }
      if (cfg.notice) {
        var nd = document.createElement('div'); nd.className = 'kline-note';
        nd.innerHTML = cfg.notice; el.appendChild(nd);
      }
      var cv = document.createElement('canvas'); cv.className = 'kline-cv';
      var tip = document.createElement('div'); tip.className = 'kline-tip';
      el.appendChild(cv); el.appendChild(tip);
      var g = cv.getContext && cv.getContext('2d');
      if (!g) { el.innerHTML = '<div class="ind-empty">当前浏览器不支持 Canvas 图表；下方锚点数据仍可查看。</div>'; return; }

      var meta = { idx: -1, x0: 0, dx: 1, n: 1, padL: 52, padR: 58, top: 14, mainH: 1, volTop: 1, volH: 1 };
      function fmtVol(v) {
        if (!isFinite(v)) return '—';
        return v >= 1e8 ? fmt(v / 1e8, 2) + '亿' : (v >= 1e4 ? fmt(v / 1e4, 1) + '万' : String(Math.round(v)));
      }
      function paint() {
        var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
        var W = Math.max(280, el.clientWidth || rect.width || 600), H = Math.max(180, el.clientHeight || rect.height || 280);
        var dpr = window.devicePixelRatio || 1;
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
        cv.style.width = W + 'px'; cv.style.height = H + 'px';
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, H);
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
        var padL = 52, padR = 58, top = 16, bot = 24;
        var mainH = (H - top - bot) * 0.72, volH = (H - top - bot) * 0.20;
        var volTop = top + mainH + 10, plotW = W - padL - padR;
        g.font = '10px system-ui,-apple-system,"Microsoft YaHei",sans-serif';
        g.strokeStyle = '#eef1f7'; g.lineWidth = 1; g.fillStyle = '#98a2b3';
        var i, y;
        for (i = 0; i <= 4; i++) {
          y = top + mainH * i / 4;
          g.beginPath(); g.moveTo(padL, y + .5); g.lineTo(W - padR, y + .5); g.stroke();
        }
        var lo, hi, labels = [], vals = [];
        if (mode === 'kline') {
          lo = Math.min.apply(null, bars.map(function (b) { return b.l || b.c; }));
          hi = Math.max.apply(null, bars.map(function (b) { return b.h || b.c; }));
          vals = bars.map(function (b) { return b.c; });
          labels = bars.map(function (b) { return b.d; });
        } else {
          vals = series.map(function (x) { return Number(x[1]); });
          lo = Math.min.apply(null, vals); hi = Math.max.apply(null, vals);
          labels = series.map(function (x) { return x[0]; });
        }
        var span = (hi - lo) || 1; lo -= span * .06; hi += span * .06;
        function py(v) { return top + mainH - (v - lo) / (hi - lo) * mainH; }
        for (i = 0; i <= 4; i++) {
          var pv = hi - (hi - lo) * i / 4;
          g.fillStyle = '#98a2b3'; g.textAlign = 'right';
          g.fillText(mode === 'kline' ? fmt(pv, 2) : fmt(pv, 1), padL - 6, top + mainH * i / 4 + 3);
        }
        // 日期刻度
        g.textAlign = 'center'; g.fillStyle = '#98a2b3';
        var step = Math.max(1, Math.floor(labels.length / 5));
        for (i = 0; i < labels.length; i += step) {
          g.fillText(String(labels[i]).slice(5), padL + plotW * (i + .5) / labels.length, H - 6);
        }
        if (mode === 'line') {
          // 快照归一化净值折线 + 渐变填充 + 锚点
          var grad = g.createLinearGradient(0, top, 0, top + mainH);
          grad.addColorStop(0, 'rgba(37,99,235,.22)'); grad.addColorStop(1, 'rgba(124,58,237,.02)');
          g.beginPath();
          vals.forEach(function (v, k) { var x = padL + plotW * (k + .5) / vals.length; k ? g.lineTo(x, py(v)) : g.moveTo(x, py(v)); });
          g.lineTo(padL + plotW * (vals.length - .5) / vals.length, top + mainH);
          g.lineTo(padL + plotW * .5 / vals.length, top + mainH); g.closePath();
          g.fillStyle = grad; g.fill();
          g.beginPath();
          vals.forEach(function (v, k) { var x = padL + plotW * (k + .5) / vals.length; k ? g.lineTo(x, py(v)) : g.moveTo(x, py(v)); });
          g.strokeStyle = '#6d4ae8'; g.lineWidth = 2; g.stroke();
          vals.forEach(function (v, k) {
            var x = padL + plotW * (k + .5) / vals.length;
            g.beginPath(); g.arc(x, py(v), 3.5, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
            g.strokeStyle = '#6d4ae8'; g.lineWidth = 1.5; g.stroke();
            g.fillStyle = '#5b6478'; g.textAlign = 'center'; g.fillText(fmt(v, 1), x, py(v) - 9);
          });
        } else {
          // 蜡烛 + 成交量 + MA5 / MA20
          var n = bars.length, dx = plotW / n, bw = Math.max(1, Math.min(9, dx * .62));
          /* 三态演化背景带：逐日重算（蓝=启动 / 灰=盘整 / 橙=走完），画在蜡烛之下 */
          if (cfg.bands) {
            var sr = stateRuns(bars);
            if (sr) {
              sr.runs.forEach(function (rn) {
                var x0 = padL + dx * rn.i0, x1 = padL + dx * (rn.i1 + 1);
                var col = rn.state === '启动' ? 'rgba(37,99,235,.12)'
                  : (rn.state === '走完' ? 'rgba(180,83,9,.12)' : 'rgba(152,162,179,.07)');
                g.fillStyle = col; g.fillRect(x0, top, Math.max(dx, x1 - x0), mainH);
              });
              g.strokeStyle = 'rgba(120,130,150,.28)'; g.lineWidth = 1;
              sr.runs.forEach(function (rn) {
                if (rn.i0 === 0) return;
                var x = padL + dx * rn.i0; g.beginPath(); g.moveTo(x, top); g.lineTo(x, top + mainH); g.stroke();
              });
            }
          }
          var vmax = Math.max.apply(null, bars.map(function (b) { return b.v || 0; })) || 1;
          for (i = 0; i < n; i++) {
            var b = bars[i], x = padL + dx * (i + .5);
            var up = b.c >= b.o, col = up ? UP_C : DOWN_C;
            g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1;
            g.beginPath(); g.moveTo(x, py(b.h || Math.max(b.o, b.c))); g.lineTo(x, py(b.l || Math.min(b.o, b.c))); g.stroke();
            var y1 = py(Math.max(b.o, b.c)), y2 = py(Math.min(b.o, b.c));
            g.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
            g.globalAlpha = .55;
            g.fillRect(x - bw / 2, volTop + volH - (b.v || 0) / vmax * volH, bw, (b.v || 0) / vmax * volH);
            g.globalAlpha = 1;
          }
          [[5, '#f0a616'], [20, '#2563eb']].forEach(function (ma) {
            g.beginPath(); g.strokeStyle = ma[1]; g.lineWidth = 1.3;
            var started = false;
            for (i = 0; i < n; i++) {
              var mv = maAt(vals, i, ma[0]); if (mv == null) continue;
              var x2 = padL + dx * (i + .5);
              started ? g.lineTo(x2, py(mv)) : (g.moveTo(x2, py(mv)), started = true);
            }
            g.stroke();
          });
          g.fillStyle = '#f0a616'; g.textAlign = 'left'; g.fillText('MA5', padL + 4, top + 10);
          g.fillStyle = '#2563eb'; g.fillText('MA20', padL + 42, top + 10);
          g.fillStyle = '#98a2b3'; g.fillText('成交量', padL + 4, volTop + 10);
          meta = { idx: -1, x0: padL, dx: dx, n: n, padL: padL, padR: padR, top: top, mainH: mainH, volTop: volTop, volH: volH };
        }
        // 数据来源角标
        g.textAlign = 'right'; g.fillStyle = '#98a2b3';
        g.fillText(mode === 'kline' ? ((cfg.isIdx ? '指数日K · ' : '前复权日K · ') + (cfg.source || '多源')) : '快照归一化净值（今日=100，非逐日K线）', W - padR, top + 10);
      }
      paint();
      if (window.ResizeObserver) {
        try { var ro = new ResizeObserver(function () { try { paint(); } catch (e) {} }); ro.observe(el); } catch (e) {}
      }
      if (requestAnimationFrame) requestAnimationFrame(function () { requestAnimationFrame(function () { try { paint(); } catch (e) {} }); });
      if (cv.addEventListener) cv.addEventListener('mousemove', function (ev) {
        if (mode !== 'kline' || !meta.dx) return;
        var rect = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0 };
        var x = (ev.clientX || 0) - rect.left;
        var k = Math.max(0, Math.min(meta.n - 1, Math.floor((x - meta.x0) / meta.dx)));
        var b = bars[k], prev = bars[k - 1];
        if (!b) return;
        var chg = prev && prev.c ? (b.c / prev.c - 1) * 100 : null;
        tip.innerHTML = '<b>' + esc(b.d) + '</b> 开 ' + fmt(b.o, 2) + ' 高 ' + fmt(b.h, 2)
          + ' 低 ' + fmt(b.l, 2) + ' 收 <b class="' + (chg != null ? signCls(chg) : '') + '">' + fmt(b.c, 2)
          + (chg != null ? '（' + pct(chg) + '）' : '') + '</b> 量 ' + fmtVol(b.v);
        tip.style.display = 'block';
        tip.style.left = Math.min(rect.width - 240, Math.max(4, x + 10)) + 'px';
        tip.style.top = '4px';
      });
      if (cv.addEventListener) cv.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
    } catch (e) {
      try { el.innerHTML = '<div class="ind-empty">图表绘制失败（' + esc(e && e.message) + '）；下方锚点数据仍可查看。</div>'; } catch (e2) {}
    }
  }

  // ---------- 行情（多源） ----------
  var QUOTES = {};           // code -> {price,chg,source}
  var QUOTES_TS = 0;
  function loadQuotes(codes, force) {
    var now = Date.now();
    if (!force && QUOTES_TS && now - QUOTES_TS < 15000 && Object.keys(QUOTES).length) {
      return Promise.resolve(QUOTES);
    }
    // 全市场（约 5000 只）走「一次批量行情」接口，避免超长 ulist/URL；小池走原多源降级
    if (codes && codes.length > 200 && DS.getAllQuotes) {
      return DS.getAllQuotes(codes).then(function (res) {
        Object.keys(res.map).forEach(function (k) { QUOTES[k] = res.map[k]; });
        QUOTES_TS = Date.now();
        updateStateBanner('em', res.update);
        return QUOTES;
      }).catch(function () { updateStateBanner('snapshot', 0); return QUOTES; });
    }
    return DS.getTodayQuotes(codes).then(function (res) {
      Object.keys(res.map).forEach(function (k) { QUOTES[k] = res.map[k]; });
      QUOTES_TS = Date.now();
      updateStateBanner(res.source, res.update);
      /* 行业页的「板块今日%」在板块指数缺失时会回落到「池内均涨」，
         而池内均涨依赖 QUOTES：行情到货后必须自己重绘一次，
         否则那些行会一直显示「—」，用户以为是坏了（以前要点一下行才刷新）。 */
      if (lastPath === '/sector' && $('sectorBody')) { try { renderSectorBody(); } catch (e) {} }
      return QUOTES;
    }).catch(function () { updateStateBanner('snapshot', 0); return QUOTES; });
  }
  /* 数据源健康度：让「源挂了」和「我们算错了」能区分开。
     以前东财限流时页面只是数字不动，用户会以为是我们算错。 */
  function srcHealthHtml() {
    if (!DS.srcHealth) return '';
    var h = DS.srcHealth(), parts = [];
    Object.keys(h).forEach(function (k) {
      var o = h[k];
      if (o.state === 'idle') return;
      var color = o.state === 'ok' ? '#0f7a3d' : (o.state === 'flaky' ? '#b45309' : '#b42318');
      var mark = o.state === 'ok' ? '正常' : (o.state === 'flaky' ? '不稳' : '不可用');
      parts.push('<span style="color:' + color + ';margin-left:8px">' + esc(o.name) + ' ' + mark + '</span>');
    });
    if (!parts.length) return '';
    return '<span class="cat" style="margin-left:10px">｜数据源</span>' + parts.join('');
  }
  function updateStateBanner(source, ts) {
    var dot = $('stateDot'), txt = $('stateText');
    var meta = DS.meta() || {};
    if (source === 'snapshot' || source === 'cache' && !Object.keys(QUOTES).length) {
      dot.className = 'dot snap';
      txt.textContent = '实时源暂不可用 · 已用快照口径（数据截至 ' + asOfClean(meta) + '，不含当日）';
    } else {
      dot.className = 'dot live';
      txt.innerHTML = '实时行情来源：' + ({ em: '东方财富', tencent: '腾讯', sina: '新浪', cache: '本地缓存' }[source] || source)
        + ' · 已更新 ' + new Date(ts || Date.now()).toLocaleTimeString('zh-CN', { hour12: false })
        + srcHealthHtml();
    }
  }

  // ---------- 图表（防压扁） ----------
  function makeChart(elId, option) {
    var el = $(elId); if (!el) return null;
    if (typeof echarts === 'undefined') return null;
    // 重复进入视图时先销毁旧实例，避免叠图 / 内存泄漏
    try { var old = echarts.getInstanceByDom(el); if (old) old.dispose(); } catch (e) {}
    var c = echarts.init(el);
    c.setOption(option);
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { try { c.resize(); } catch (e) {} });
      ro.observe(el);
    }
    // 双 rAF 兜底：容器从 0 宽展开后重绘
    requestAnimationFrame(function () { requestAnimationFrame(function () { try { c.resize(); } catch (e) {} }); });
    return c;
  }

  // ---------- 路由 ----------
  function currentRoute() {
    var h = location.hash.replace(/^#/, '') || '/';
    var q = {};
    var qi = h.indexOf('?');
    if (qi >= 0) {
      h.slice(qi + 1).split('&').forEach(function (p) { var kv = p.split('='); q[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ''); });
      h = h.slice(0, qi);
    }
    return { path: h, q: q };
  }
  function navigate(path) { location.hash = path; }

  function setActiveNav(path) {
    var nav = (path === '/history') ? '/picker' : path;   // 完整报告归到「前世今生」入口
    var mob = (nav === '/health' || nav === '/method' || nav === '/sector') ? '/picker' : nav;
    document.querySelectorAll('#nav a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-route') === nav);
    });
    document.querySelectorAll('#mobnav a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-route') === mob);
    });
  }

  var lastPath = null;
  var ACTIVE_CODE = null;         // 最近打开的标的（供 /history 与 /picker 复用）
  /* 把任意写法的 code 归一成快照里的全码（000001.SH / 000001.SZ / 600519.SH）。
     页面里同一标的会被好几条链路各取一次数（K线图用 r.code、筹码用入参 code、
     实时价用 QUOTES[code]），只要一处是裸码，就会出现「标题是 A、图是 B」。
     所有入口先过这里，后续一律只认全码。 */
  function normCode(code) {
    if (!code) return code;
    var s = DS.snapshot(code);
    return (s && s.code) ? s.code : code;
  }
  function render(keepScroll) {
    var r = currentRoute();
    var path = r.path;
    if (r.q.code) ACTIVE_CODE = normCode(r.q.code);
    // 分享深链接收端：?ref=VID 或 hash 内的 ref，来自 guard 邀请 / 分享卡
    if (r.q.ref) REF_FROM = r.q.ref;
    else {
      try { REF_FROM = new URLSearchParams(location.search).get('ref') || ''; } catch (e) {}
    }

    // 完整前世今生报告 / 选股入口：独立全屏视图
    if (path === '/history' || path === '/picker') {
      hideDrawer();
      renderPath(path, keepScroll);
      return;
    }
    // lens 通过 ?code= 打开抽屉，不切换主视图
    if (r.q.code) {
      if (!lastPath || lastPath === '/lens' || lastPath === '/picker' || lastPath === '/history') renderPath('/all', keepScroll);
      openLens(r.q.code);
    } else {
      hideDrawer();
      renderPath(path, keepScroll);
    }
  }
  /* keepScroll=true：同一页面的「重绘」（实时刷新重算后），必须保持滚动位置。
     以前重绘后无条件 scrollTo(0,0)，于是每 60 秒实时刷新一次就把正在往下看的用户弹回顶部。 */
  function renderPath(path, keepScroll) {
    var sy = keepScroll ? (window.pageYOffset || (document.documentElement && document.documentElement.scrollTop) || 0) : 0;
    setActiveNav(path);
    lastPath = path;
    var view = $('view');
    if (path === '/') view.innerHTML = viewHome();
    else if (path === '/all') view.innerHTML = viewAll();
    else if (path === '/sector') view.innerHTML = viewSector();
    else if (path === '/news') view.innerHTML = viewNews();
    else if (path === '/rrg') view.innerHTML = viewRrg();
    else if (path === '/health') view.innerHTML = viewHealth();
    else if (path === '/method') view.innerHTML = viewMethod();
    else if (path === '/history') view.innerHTML = viewHistory(ACTIVE_CODE);
    else if (path === '/picker') view.innerHTML = viewPicker();
    else if (path === '/more') view.innerHTML = viewMore();
    else view.innerHTML = viewHome();
    bindView(path);
    if (path === '/sector') {
      loadIndustryData().then(function () {
        if (lastPath === '/sector') renderSectorBody();
      });
    }
    hydrateInsights();      // 所有含 .insight / .arch-wrap 的页面统一水合日K 档案、预警与胜率
    hydrateQuotes();        // 任何标了 data-q 的元素自动补今日涨跌（不再各处各写一遍）
    refreshMarketLive();    // 市场条：成交额 / 涨跌家数走实时，温度等仍是快照口径
    markScrollHints();      // 手机端宽表格的「可左右滑」提示
    /* 重绘保持滚动位置；导航才回顶 */
    try {
      if (keepScroll) {
        if (sy > 0) {
          if (window.requestAnimationFrame) window.requestAnimationFrame(function () { window.scrollTo(0, sy); });
          else window.scrollTo(0, sy);
        }
      } else if (window.scrollTo) window.scrollTo(0, 0);
    } catch (e) {}
  }

  // ---------- 视图：我的看板 ----------
  /* ---------- 大盘三态（四大宽基）----------
     「一进网页就知道大盘什么情况」：不看个股、不看榜单，先给四个指数的三态。
     数据来自构建时用同一套六派引擎算出的 indexStates；点位/涨跌用腾讯实时刷新。 */
  function indexStates() {
    var a = RAW().indexStates;
    return Array.isArray(a) ? a : [];
  }
  function idxVerdict(list) {
    if (!list.length) return '';
    var cnt = { '启动': 0, '盘整': 0, '走完': 0 };
    list.forEach(function (x) { if (cnt[x.state] != null) cnt[x.state]++; });
    var n = list.length;
    if (cnt['走完'] >= 3) return { t: '整体偏弱：多数宽基处于「走完」', cls: 'bad' };
    if (cnt['启动'] >= 2) return { t: '整体转强：多个宽基回到「启动」', cls: 'good' };
    if (cnt['启动'] + cnt['走完'] === 0) return { t: '整体震荡：宽基普遍「盘整」', cls: 'mid' };
    return { t: '分化：' + n + ' 个宽基状态不一致，看结构不看指数', cls: 'mid' };
  }
  function indexStripHtml() {
    var list = indexStates();
    if (!list.length) return '';
    var v = idxVerdict(list);
    var cards = list.map(function (x) {
      var st = x.state || '—';
      var cls = st === '启动' ? 'launch' : (st === '走完' ? 'done' : 'consol');
      var days = (x.stateDays != null) ? ((x.stateCapped ? '≥' : '') + x.stateDays + ' 个交易日') : '—';
      var chg = x.chg;
      /* 用 data-history 而不是 data-open：指数的"灵魂"是它的三态历史与K线，
         直接进前世今生比先进透镜再点一次更符合"一进网页就想看大盘"的场景。 */
      return '<div class="idx-card" data-idx="' + esc(x.code) + '" data-history="' + esc(x.code) + '"'
        + ' title="点击查看该指数的前世今生（三态 / K线 / 筹码）" style="cursor:pointer">'
        + '<div class="ic-h"><span class="ic-n">' + esc(x.name) + '</span>'
        + '<span class="ic-st st-' + cls + '">' + esc(st) + '</span></div>'
        + '<div class="ic-p"><b data-idx-point>' + (x.point != null ? fmt(x.point, 2) : '—') + '</b>'
        + '<span data-idx-chg class="' + (chg != null ? signCls(chg) : 'mut') + '">'
        + (chg != null ? pct(chg) : '—') + '</span></div>'
        + '<div class="ic-s" title="六派各自投方向票，这里数的是投「启动」票的派数；0 表示没有一派越过投票阈值（其余为中性或反对），不等于六派都看空。">'
        + esc(days) + ' · 六派 ' + (x.resonance != null ? x.resonance : '—') + '/6 投启动</div>'
        + '</div>';
    }).join('');
    return '<div class="idx-strip">'
      + '<div class="idx-head"><b>大盘三态</b>'
      + '<span class="idx-verdict ' + v.cls + '">' + esc(v.t) + '</span>'
      + '<span class="cat">数据 ' + esc(dayStr((RAW().meta || {}).asOf) || '—') + ' 收盘 · 每日更新 · 点卡片看前世今生</span></div>'
      + '<div class="idx-grid">' + cards + '</div>'
      + '</div>';
  }
  /* 点位用腾讯实时刷新（指数同样走 46 字段接口） */
  function hydrateIndexStrip() {
    var list = indexStates();
    if (!list.length) return;
    var codes = list.map(function (x) { return x.code; });
    /* 以前逐只调 getQuoteRich，点位和涨跌幅来自不同响应、不同时点，
       会出现「点位是今天的、涨跌幅是昨天的」这种自相矛盾。
       现在一次请求拿全（同一个响应里的 f2 点位 / f3 涨跌幅），保证两者同源同时。 */
    var fetchMap = DS.getQuotesByChunks
      ? DS.getQuotesByChunks(codes)
      : Promise.all(codes.map(function (c) {
          return DS.getQuoteRich(c).then(function (q) { return [c, q]; }).catch(function () { return [c, null]; });
        })).then(function (arr) {
          var m = {}; arr.forEach(function (x) { if (x[1]) m[x[0]] = x[1]; }); return { map: m };
        });
    fetchMap.then(function (res) {
      var map = (res && res.map) || {};
      Object.keys(map).forEach(function (c) { QUOTES[c] = map[c]; });
      list.forEach(function (x) {
        var q = map[x.code]; if (!q) return;
        var card = document.querySelector('[data-idx="' + x.code + '"]');
        if (!card) return;
        var pel = card.querySelector('[data-idx-point]'), cel = card.querySelector('[data-idx-chg]');
        var px = isNum(q.price) ? q.price : null;
        var chg = (q.chg != null && isNum(q.chg)) ? q.chg : null;
        /* 若涨跌幅缺失但有点位和昨收，就自己算，绝不让两个数打架 */
        if (chg == null && px != null && isNum(q.preClose) && q.preClose > 0) chg = (px / q.preClose - 1) * 100;
        /* 两个值必须一起成立才更新：只更新点位会把「今天的点位」和「昨天的涨跌幅」
           拼在一起，看起来就是「3634.35 -0.59%」这种对不上的组合。 */
        if (px == null || chg == null) return;
        if (pel) pel.textContent = fmt(px, 2);
        if (cel) { cel.className = signCls(chg); cel.textContent = pct(chg); }
      });
    }).catch(function () { });
  }

  function viewHome() {
    var meta = DS.meta() || {};
    var recs = DS.allRecords();
    var follows = getFollows().map(function (c) { return DS.snapshot(c); }).filter(Boolean);
    var signals = recs.slice().sort(function (a, b) {
      var sa = (a.state === '启动' ? 2 : 0) + newsRankOf(a);
      var sb = (b.state === '启动' ? 2 : 0) + newsRankOf(b);
      return sb - sa;
    }).slice(0, 8);

    var hero = '<section class="hero">'
      + '<div class="hero-kicker">DAILY SIGNAL · 每日看盘</div>'
      + '<h1>用三态看懂 A 股处在 <em>启动 · 盘整 · 走完</em></h1>'
      + '<p class="sub">每日信号 + 我的看板 · 数据截至 ' + esc(asOfClean(meta)) + '（实时行情开盘后自动补全当日）</p>'
      + '<div class="hero-signals">'
      + sigCard('关注标的', follows.length + ' <small>只</small>', '★ 我的看板', '#/health')
      + sigCard('今日启动信号', recs.filter(function (r) { return r.state === '启动'; }).length + ' <small>只</small>', '▲ 三态=启动', null, 'all:启动')
      + sigCard('舆情升温', recs.filter(newsHot).length + ' <small>只</small>', '◎ 真实资讯命中 / 激增', '#/news')
      + trialCard()
      + '</div>'
      + heroActions()
      + '</section>'
      + indexStripHtml();

    var body = '';
    if (follows.length) {
      body += '<div class="section-title"><h2>我的关注</h2><span class="desc">你标记过的标的，每日回来就能看到变化</span></div>';
      body += '<div class="grid cols-3" id="followGrid">' + follows.map(stockCard).join('') + '</div>';
    } else {
      body += '<div class="section-title"><h2>今日信号 · 启动 + 舆情升温</h2><span class="desc">没关注？先看看这些 · 点 ☆ 加入我的看板</span></div>';
      body += '<div class="grid cols-4" id="signalGrid">' + signals.map(stockCard).join('') + '</div>';
    }

    // 舆情雷达 · 首页速览（完整主题数由 news_data.js 决定，不再写死）
    var allThemes = themeList();
    var themes = allThemes.slice().sort(function (a, b) { return (b.eff || 0) - (a.eff || 0); }).slice(0, 6);
    if (themes.length) {
      body += '<div class="section-title"><h2>舆情雷达 · 速览</h2><span class="desc">当日真实资讯 × 极性 · <a href="#/news" style="color:var(--blue-d)">查看完整 ' + allThemes.length + ' 个行业 ›</a></span></div>';
      body += '<div class="card"><div class="six" style="gap:10px">'
        + themes.map(function (t) {
          return '<span class="tag bull" style="cursor:pointer" data-ntheme="' + esc(t.key) + '">' + esc(t.name)
            + ' <b>' + (isNum(t.surge) ? fmt(t.surge, 1) + '×' : (t.n1 || 0) + '条') + '</b></span>';
        }).join('') + '</div><div class="hint" style="margin-top:8px">点行业进完整雷达；基线未满 3 天时徽标显示当日真实条数 / 极性，不冒充激增倍数。</div></div>';
    }

    body += legendBlock();
    return hero + marketBar() + healthAlertBanner() + intradayBlocks() + dailyBriefBlock() + quickLinks() + changesBlock() + body;
  }
  /* ---------- 市场环境的两个补充指标（并入已有 marketBar，不另起一条） ----------
     原来的「市场情绪温度」条已经有涨跌家数 / 涨停跌停 / 成交额，但缺两样：
     ① 个股中位数涨跌（比指数更能说明「今天好不好做」）② 连板梯队。
     两者都用快照数据算，所以标注口径，不假装是实时。 */
  function median5Pct() {
    var xs = [];
    DS.allRecords().forEach(function (r) {
      var v = r.pct && r.pct.w5;
      if (isNum(v)) xs.push(v);
    });
    if (xs.length < 50) return null;
    xs.sort(function (a, b) { return a - b; });
    return xs[Math.floor(xs.length / 2)];
  }
  function limitPct(code) {
    var b = String(code || '').replace(/\.[A-Z]+$/, '');
    if (/^(30|68)/.test(b)) return 19.8;        // 创业板 / 科创板
    if (/^(8|4|92)/.test(b)) return 29.8;       // 北交所
    return 9.8;                                  // 主板
  }
  function limitBoards() {
    var out = {};
    DS.allRecords().forEach(function (r) {
      if (r.kind !== 'stock') return;
      var c = r.closes;
      if (!Array.isArray(c) || c.length < 3) return;
      var lim = limitPct(r.code), n = 0;
      for (var i = c.length - 1; i > 0; i--) {
        var prev = c[i - 1];
        if (!isNum(prev) || prev <= 0) break;
        if ((c[i] / prev - 1) * 100 >= lim) n++; else break;
      }
      if (n >= 2) out[n] = (out[n] || 0) + 1;
    });
    return out;
  }
  /* 首页四张卡以前是死的（只有数字），用户点不动。
     现在每张都能点进对应页面：关注 → 关注体检；启动 → 全市场并自动筛「启动」；舆情 → 舆情雷达。 */
  function sigCard(t, v, s, href, jump) {
    var inner = '<div class="t">' + t + '</div><div class="v">' + v + '</div><div class="s">' + s + '</div>'
      + (href || jump ? '<div class="sig-go">查看 ›</div>' : '');
    if (jump) return '<div class="sig-card sig-link" data-jump="' + esc(jump) + '">' + inner + '</div>';
    if (href) return '<a class="sig-card sig-link" href="' + href + '">' + inner + '</a>';
    return '<div class="sig-card">' + inner + '</div>';
  }

  // ---------- guard.js 兼容层：试用倒计时 / 邀请入口 / 价值时刻 ----------
  // guard.js 由 *.app.workbuddy.host 网关注入，同步暴露 window.AB_USER。
  // 本地预览或未注入时全部优雅降级（不显示试用卡、不报错）。
  function trialInner(u) {
    var v, s;
    if (u.licensed) { v = '已授权'; s = '长期可用 · 设备码 ' + esc(u.vid); }
    else {
      var d = (u.daysLeft != null ? u.daysLeft : u.trialLeft);
      v = (d != null ? d + ' <small>交易日</small>' : '—');
      s = u.invites ? '含邀请 +' + (u.invites * (u.inviteDays || 3)) + ' 日' : '免费试用 · 邀请可 +3 日/人';
    }
    return '<div class="t">试用剩余</div><div class="v">' + v + '</div><div class="s">' + s + '</div>';
  }
  function trialCard() {
    var u = window.AB_USER;
    return u ? '<div class="sig-card" id="trialCard">' + trialInner(u) + '</div>' : '';
  }
  function heroActions() {
    var u = window.AB_USER;
    var h = '<div class="hero-actions">'
      + '<a class="btn btn-primary" href="#/picker">查看个股 / ETF 前世今生 ›</a>'
      + '<a class="btn" href="#/all">浏览三态总表</a>';
    if (u && u.inviteLink) {
      h += '<button class="btn-invite" id="inviteBtn">邀请好友 · 双方各 +' + (u.inviteDays || 3) + ' 交易日</button>'
        + '<span class="hero-trial-note" id="abTrialNote">设备码 ' + esc(u.vid) + ' · 邀请奖励自动到账</span>';
    }
    return h + '</div>';
  }
  function refreshTrialUI() {
    var u = window.AB_USER; if (!u) return;
    var c = $('trialCard'); if (c) c.innerHTML = trialInner(u);
    var n = $('abTrialNote');
    if (n) n.textContent = (u.licensed ? '已授权' : '已邀请 ' + (u.invites || 0) + ' 人') + ' · 设备码 ' + u.vid + ' · 奖励自动到账';
  }
  function copyText(t) {
    function legacy() {
      var ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      if (ta.parentNode) ta.parentNode.removeChild(ta);
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).catch(legacy);
      else legacy();
    } catch (e) { legacy(); }
  }
  function bindInvite() {
    var b = $('inviteBtn'); if (!b) return;
    b.addEventListener('click', function () {
      var u = window.AB_USER; if (!u || !u.inviteLink) return;
      copyText(u.inviteLink);
      var old = b.textContent; b.textContent = '✓ 邀请链接已复制';
      setTimeout(function () { b.textContent = old; }, 1800);
    });
  }
  // F：首次「+关注」后派发价值时刻，触发 guard.js 的一次性邀请轻推
  function fireValueMoment() {
    try {
      if (localStorage.getItem('ab_value_moment_v2')) return;
      localStorage.setItem('ab_value_moment_v2', '1');
      var ev;
      if (typeof CustomEvent === 'function') ev = new CustomEvent('ab:value-moment');
      else { ev = document.createEvent('Event'); ev.initEvent('ab:value-moment', false, false); }
      window.dispatchEvent(ev);
    } catch (e) {}
  }

  function stockCard(r) {
    var q = QUOTES[r.code] || {};
    var dayChg = q.chg;
    return '<div class="card" data-open="' + esc(r.code) + '" style="cursor:pointer">'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start">'
      + '<div><b>' + esc(r.name) + '</b> <span class="cat">' + esc(r.code) + '</span><div style="font-size:11px;color:var(--hint);margin-top:2px">' + typeLabel(r) + ' · ' + esc(r.ind || '') + '</div></div>'
      + starHtml(r.code) + '</div>'
      + '<div style="margin:10px 0 8px"><span data-stblock="' + esc(r.code) + '">' + stateBlock(r) + '</span> <span style="font-size:12px;color:var(--muted);margin-left:8px">六派 ' + bullCount(r) + '/6 看启动</span></div>'
      + '<div class="kpis">'
      /* data-daycell：首页卡片自己不在全市场表的批量取价范围内，
         所以渲染后要单独取一次价并把这一格刷新掉，否则「今日」长期是「—」 */
      + '<div class="kpi" data-daycell="' + esc(r.code) + '"><div class="l">今日</div><div class="v">'
      + daySpan(q, '—')
      + '</div><div class="s">' + (isSuspended(q) ? '无成交' : (dayChg != null ? '实时' : '快照无当日')) + '</div></div>'
      + kpi('近5日', '<span class="mut">' + pct(r.pct && r.pct.w5) + '</span>', '快照')
      + kpi('近60日', '<span class="mut">' + pct(r.pct && r.pct.w60) + '</span>', '快照')
      + '</div></div>';
  }
  function refreshHomeDay() {
    var cells = document.querySelectorAll('[data-daycell]');
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i], q = QUOTES[c.getAttribute('data-daycell')];
      if (!q || q.chg == null) continue;
      var v = c.querySelector('.v'), s = c.querySelector('.s');
      if (v) v.innerHTML = daySpan(q, '—');
      if (s) s.textContent = isSuspended(q) ? '无成交' : '实时';
      var code = c.getAttribute('data-daycell'), sb = document.querySelector('[data-stblock="' + code + '"]');
      var rr = DS.snapshot(code);
      if (sb && rr) sb.innerHTML = stateBlock(rr, { click: false });
    }
  }
  function primeHomeCards() {
    var grid = document.getElementById('followGrid') || document.getElementById('signalGrid');
    if (!grid) return;
    var codes = [], els = grid.querySelectorAll('[data-open]');
    for (var i = 0; i < els.length; i++) {
      var c = els[i].getAttribute('data-open');
      if (c) codes.push(c);
    }
    if (!codes.length) return;
    primeCodes(codes, refreshHomeDay);
  }
  function kpi(l, v, s) { return '<div class="kpi"><div class="l">' + l + '</div><div class="v">' + v + '</div><div class="s">' + s + '</div></div>'; }

  function legendBlock() {
    return '<div class="glossary">'
      + '<div class="legend">'
      + '<div class="item"><span class="sw" style="background:var(--state-launch)"></span>启动 ▲：三态判断为启动阶段（非看涨）</div>'
      + '<div class="item"><span class="sw" style="background:var(--state-consol)"></span>盘整 —：震荡整理</div>'
      + '<div class="item"><span class="sw" style="background:var(--state-done)"></span>走完 ▼：阶段接近尾声（非看跌）</div>'
      + '</div>'
      + '<div class="st-legend-note">三态后的时间＝当前状态的持续区间（起点 → 数据再生时点）；<b>点开时间</b>可查看六派各自判断的窗口日期与认定的启动起点。</div>'
      + '<details><summary>三态 / 六派 是什么？（点开）</summary>'
      + '<p><b>三态</b>：把任一只标的所处的位置归纳为「启动 / 盘整 / 走完」三个阶段，是对「现在处在哪儿」的阶段判断，<b>不预示涨跌</b>。</p>'
      + '<p><b>六派</b>：结构 / 量价 / 资金 / 情绪 / 配置 / 舆情 六个维度分别给出看多(✓)/看空(✗)/中性(—)，合计「X/6 派看启动」。</p>'
      + '<p>今日% 为东财/腾讯/新浪实时（红涨绿跌，事实表述）；近5/20/60/250日为快照区间，<b>不含当日</b>，避免误读。</p>'
      + '</details></div>';
  }

  // ---------- 视图：全市场 ----------
  var SORT = { key: 'resonance', dir: -1 };
  var ALL_COLS = [
    { k: 'name', t: '名称', lft: true },
    { k: 'type', t: '类型' },
    { k: 'state', t: '三态 · 时间', title: '三态后的区间＝当前状态持续区间；点时间可展开六派各自判断的时点' },
    { k: 'day', t: '今日%', title: '东财/腾讯/新浪实时；失败显示 —' },
    { k: 'w5', t: '近5日', title: '快照区间涨跌·截至构建日·不含当日' },
    { k: 'w20', t: '近20日', title: '快照区间涨跌·不含当日' },
    { k: 'w60', t: '近60日', title: '快照区间涨跌·不含当日' },
    { k: 'w250', t: '近250日', title: '快照区间涨跌·不含当日' },
    { k: 'resonance', t: '六派' },
    { k: 'quad', t: 'RRG 象限', title: '相对强度/动量四象限（配置派依据）' },
    { k: 'news', t: '舆情', title: '基线就绪显示激增倍数；未就绪显示真实资讯条数/媒体数（个股命中或行业级）' },
    { k: 'star', t: '★' }
  ];
  function allHeadHtml() {
    return '<tr>' + ALL_COLS.map(function (c) {
      var on = SORT.key === c.k;
      return '<th class="' + (c.lft ? 'lft ' : '') + (on ? 'on' : '') + '" data-sort="' + c.k + '"' + (c.title ? ' title="' + c.title + '"' : '') + '>'
        + c.t + (on ? '<span class="ar">' + (SORT.dir < 0 ? '▼' : '▲') + '</span>' : '') + '</th>';
    }).join('') + '</tr>';
  }
  function renderAllHead() { var h = $('allHead'); if (h) h.innerHTML = allHeadHtml(); }
  function viewAll() {
    var recs = DS.allRecords();
    return '<div class="section-title"><h2>三态总表</h2><span class="desc">' + recs.length + ' 只标的 · 点任意一行打开个股透镜</span></div>'
      + '<div class="notice viewall-note" style="background:linear-gradient(135deg,#f3f7ff,#f6f1ff)">'
      + '本表覆盖 <b>' + recs.length + ' 只</b> A 股全部上市公司（腾讯 / 新浪免费行情重算，不依赖任何付费数据源），'
      + '逐只算三态 / 六派。运行再生脚本加 <code>--fund</code> 才含主力资金流（资金派）；'
      + '舆情列来自云端采集的公开资讯（个股名称命中 / 行业级，均带真实条数与媒体数）；激增倍数需 ≥3 天基线，不足时显示条数不显示倍数。搜索框仍可查任意标的实时行情。</div>'
      + '<div class="howto"><b>怎么看这张表</b>：'
      + '<span class="k">6派</span> 里的数字＝六派中有几派投了「启动」票，<b>4/6 以上才算共振</b>，'
      + '0/6 只是没跌破门槛、不等于六派都看空；'
      + '<span class="k">今日%</span> 是实时价，<span class="k">近5/20/60/250日</span> 是区间涨跌（不含今日）。'
      + '标「折算失真」的是基金拆分造成的假跌，不是真的暴跌。</div>'
      + filterBar()
      + (isMobileList()
          ? '<div id="allBody" class="m-list"></div>'
          : '<div class="table-wrap wide"><table class="list-tbl"><thead id="allHead">' + allHeadHtml() + '</thead><tbody id="allBody"></tbody></table></div>')
      + (isMobileList() ? mSortBar() : '')
      + '<div id="allPager"></div>'
      + legendBlock();
  }
  function filterBar() {
    return '<div id="filters" style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">'
      + chip('st', '全部') + chip('st', '启动') + chip('st', '盘整') + chip('st', '走完')
      + chip('ty', '全部') + chip('ty', 'ETF') + chip('ty', '个股')
      + '<span style="width:1px;background:var(--line);margin:4px 2px"></span>'
      /* 阶段筛选：同样是「启动」，新发 / 健康 / 观察 / 退化 的风险完全不同，
         只看三态会漏掉「启动但已经走坏」的那批。 */
      + phaseChips()
      + '<label style="font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border:1px solid var(--line);border-radius:9px"><input type="checkbox" id="surgeOnly"> 仅看舆情激增</label>'
      + '</div>';
  }
  /* 阶段选项必须跟着三态走：选了「走完」还列「新发/健康」是没有意义的。
     启动 → 新发/健康/观察/退化；走完 → 刚走完/走完中/走完已久；盘整 → 盘整中/久盘。 */
  var PHASE_OF = {
    '启动': ['新发', '健康', '观察', '退化'],
    '走完': ['刚走完', '走完中', '走完已久'],
    '盘整': ['盘整中', '久盘']
  };
  var PHASE_PARENT = {};
  Object.keys(PHASE_OF).forEach(function (k) {
    PHASE_OF[k].forEach(function (v) { PHASE_PARENT[v] = k; });
  });
  function phaseChips() {
    var list = PHASE_OF[FILTER.st];
    if (!list) return '';
    var cur = list.indexOf(FILTER.ph) >= 0 ? FILTER.ph : '全部';
    return chip('ph', '全部', cur) + list.map(function (v) { return chip('ph', v, cur); }).join('');
  }
  function chip(group, val, cur) {
    /* 原来这里 var on 声明了两次，后一句把前一句覆盖掉，等于 cur 参数白传 ——
       子状态那排 chip 的高亮永远停在「全部」，用户点了也看不出选中了哪个。 */
    var on = (cur != null ? cur : FILTER[group]) === val ? ' active' : '';
    return '<span class="tag fchip' + on + '" data-group="' + group + '" data-val="' + val + '" style="cursor:pointer;user-select:none">' + val + '</span>'; }

  var FILTER = { st: '全部', ty: '全部', ph: '全部', surge: false };
  /* 全市场 5000+ 只：一次性渲染会生成 7 万+ DOM 节点导致卡死，故分页渲染。 */
  var ALL_PAGE = 1, ALL_PS = 100;
  function pagerHtml(total, pages, start, shown) {
    if (total <= ALL_PS) return '<div class="cat" style="padding:10px 2px">共 ' + total + ' 只</div>';
    var prev = ALL_PAGE <= 1, next = ALL_PAGE >= pages;
    return '<div class="pager" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;padding:14px 4px">'
      + '<button class="btn pg" data-pg="1"' + (prev ? ' disabled' : '') + '>« 首页</button>'
      + '<button class="btn pg" data-pg="' + (ALL_PAGE - 1) + '"' + (prev ? ' disabled' : '') + '>‹ 上页</button>'
      + '<span class="cat">第 <b>' + ALL_PAGE + '</b> / ' + pages + ' 页 · 共 ' + total + ' 只'
      + '（本页 ' + (start + 1) + '–' + (start + shown) + '）</span>'
      + '<button class="btn pg" data-pg="' + (ALL_PAGE + 1) + '"' + (next ? ' disabled' : '') + '>下页 ›</button>'
      + '<button class="btn pg" data-pg="' + pages + '"' + (next ? ' disabled' : '') + '>末页 »</button>'
      + '</div>';
  }
  /* 「启动」列表里常出现当日暴跌的票：六派看的是截至快照日的结构/量价，
     当日大跌是快照之后的新信息。这不是数据错，但只把 ⚠ 塞在涨跌幅后面太不显眼，
     所以在列表顶部集中点名，并给出「启动后表现」，让用户分清「信号刚发出」和「已经涨完」。
     统计口径全部取自现有真实字段（stateDays + closes / __liveCloses），不估算。 */
  function sinceLaunchPct(r) {
    var c = r.__liveCloses || r.closes;
    if (!Array.isArray(c) || c.length < 3 || !isNum(r.stateDays) || r.stateDays < 1) return null;
    var i = c.length - 1 - (r.stateDays - 1);
    if (i < 0 || !isNum(c[i]) || !c[i]) return null;
    var last = c[c.length - 1];
    if (!isNum(last)) return null;
    return (last / c[i] - 1) * 100;
  }
  function divergenceRowHtml(recs) {
    var bad = [];
    recs.forEach(function (r) {
      var q = QUOTES[r.code];
      if (!q || !isNum(q.chg)) return;
      if (q.chg <= -5 && bullCount(r) >= 4) bad.push({ r: r, chg: q.chg });
    });
    if (!bad.length) return '';
    bad.sort(function (a, b) { return a.chg - b.chg; });
    var names = bad.slice(0, 4).map(function (x) {
      var sp = sinceLaunchPct(x.r);
      return '<b>' + esc(x.r.name) + '</b> ' + pct(x.chg)
        + (sp != null ? '（启动后 ' + pct(sp) + '）' : '');
    }).join('、');
    return '<tr class="divergence-row"><td colspan="' + (ALL_COLS.length + 1) + '">'
      + '<div class="dv-note"><b>本页 ' + bad.length + ' 只「六派看启动但今日跌超 5%」</b>：' + names
      + (bad.length > 4 ? ' 等' : '')
      + '<span class="dv-sub">快照结论截至 ' + esc(asOfClean(DS.meta())) + ' 收盘，今日走势是快照之后的新信息。'
      + '「启动后」＝从三态转「启动」那天收盘算到现在，正数说明这段还在赚、负数说明已经回吐 —— 用它区分「刚启动」和「涨完在跌」。</span>'
      + '</div></td></tr>';
  }
  /* 手机端列表用卡片，不是表格。
     表格 12 列在 390px 宽上必然要横滑，滑到右边就忘了左边是哪只票；
     卡片把「名称 / 现价 / 涨跌 / 三态 / 六派 / 启动天数」压成两行，一屏 8 只。
     桌面端仍走原来的表格，两套 DOM 各自独立，互不干扰。 */
  /* 手机上没有表头，点不了列排序 —— 给一排按钮替代。 */
  function mSortBar() {
    var list = [['resonance', '六派'], ['day', '涨跌'], ['state', '三态'], ['w5', '近5日'], ['w20', '近20日']];
    return '<div class="m-sort">' + list.map(function (x) {
      var on = SORT.key === x[0];
      return '<span class="m-sbtn' + (on ? ' on' : '') + '" data-msort="' + x[0] + '">'
        + x[1] + (on ? (SORT.dir < 0 ? ' ↓' : ' ↑') : '') + '</span>';
    }).join('') + '</div>';
  }
  function isMobileList() { return (window.innerWidth || 1200) <= 640; }
  function mCardHtml(r) {
    var q = QUOTES[r.code] || {}, day = q.chg;
    var px = (q.price != null) ? fmt(q.price, 2) : '—';
    var cls = r.state === '启动' ? 'launch' : (r.state === '盘整' ? 'consol' : 'done');
    var since = sinceOf(r) || '';
    var days = (r.stateDays != null) ? r.stateDays : null;
    return '<div class="m-card" data-open="' + esc(r.code) + '">'
      + '<div class="m-c1"><b>' + esc(r.name) + '</b>'
      + '<span class="m-code">' + esc(String(r.code).replace(/\.[A-Z]+$/, '')) + '</span></div>'
      + '<div class="m-c2"><span class="m-px">' + px + '</span>'
      + '<span class="m-chg ' + (day != null ? signCls(day) : 'mut') + '">'
      + (day != null ? pct(day) : '…') + '</span>'
      + '<span class="m-six">六派 <b>' + bullCount(r) + '</b>/6</span>'
      + (since ? '<span class="m-since">' + esc(String(since).slice(5)) + ' 起'
        + (days ? ' · ' + days + ' 天' : '') + '</span>' : '')
      /* 状态放第二行右侧。第一行试过 flex / grid 都抢不到空间，
         放这里和价格、六派同一行排布，稳定可见。子状态（新发/健康/观察/退化）现场算。 */
      + '<div class="m-strow"><span class="m-state m-' + cls + '">' + esc(r.state || '—')
      + (function () {
        try { var ph = statePhase(r); return (ph && ph.t) ? ' · ' + esc(ph.t) : ''; } catch (e) { return ''; }
      })() + '</span></div>'
      + '</div></div>';
  }

  function renderAllBody(resetPage) {
    var recs = DS.allRecords().slice();
    recs = recs.filter(function (r) {
      if (MOD_KW.all) {
        var kw = MOD_KW.all.toLowerCase(), bare = String(r.code).toLowerCase();
        if (bare.indexOf(kw) < 0 && String(r.name || '').toLowerCase().indexOf(kw) < 0) return false;
      }
      if (FILTER.st !== '全部' && r.state !== FILTER.st) return false;
      if (FILTER.ty !== '全部' && typeLabel(r) !== FILTER.ty) return false;
      if (FILTER.ph && FILTER.ph !== '全部') {
        var pp = statePhase(r);
        if (!pp || pp.t !== FILTER.ph) return false;
      }
      if (FILTER.surge && newsRankOf(r) < 0.8) return false;
      return true;
    });
    recs.sort(function (a, b) {
      var va, vb, dir = SORT.dir;
      if (SORT.key === 'name') { va = a.name || ''; vb = b.name || ''; return dir * va.localeCompare(vb, 'zh'); }
      if (SORT.key === 'type') { va = typeLabel(a); vb = typeLabel(b); return dir * va.localeCompare(vb, 'zh'); }
      if (SORT.key === 'state') {
        /* 原来只按「启动/盘整/走完」三个大类排，同一大类完全相等 ——
           所以列表里全是「走完」时，点列头等于没反应（3,2,3,2,3,2,1 这种乱序原样保留）。
           现在同大类内再按「已持续天数」排：dir=-1 时天数多的在前（起点更早）。 */
        var RANK = { '启动': 0, '盘整': 1, '走完': 2 };
        var ra = (RANK[a.state] != null ? RANK[a.state] : 9);
        var rb = (RANK[b.state] != null ? RANK[b.state] : 9);
        if (ra !== rb) return dir * (ra - rb);
        var da = (a.stateDays != null ? a.stateDays : 0);
        var db = (b.stateDays != null ? b.stateDays : 0);
        if (da !== db) return dir * (da - db);
        return dir * String(a.name || '').localeCompare(String(b.name || ''), 'zh');
      }
      va = val(a, SORT.key); vb = val(b, SORT.key); return dir * (va - vb);
    });
    if (resetPage) ALL_PAGE = 1;
    var pages = Math.max(1, Math.ceil(recs.length / ALL_PS));
    if (ALL_PAGE > pages) ALL_PAGE = pages;
    var start = (ALL_PAGE - 1) * ALL_PS;
    var view = recs.slice(start, start + ALL_PS);
    var body = $('allBody'); if (!body) return;
    var anyQuote = Object.keys(QUOTES).length > 0;   // 行情未到时用「…」而非「—」区分「加载中/无数据」
    ALL_VIEW = view;
    if (isMobileList()) {
      body.innerHTML = view.length
        ? view.map(mCardHtml).join('')
        : '<div class="hint" style="padding:20px 12px;text-align:center">当前筛选没有匹配的标的。</div>';
      var pg0 = $('allPager');
      if (pg0) pg0.innerHTML = pagerHtml(recs.length, pages, start, view.length);
      if (view.length) setTimeout(primeVisibleQuotes, 30);
      return;
    }
    body.innerHTML = divergenceRowHtml(view) + view.map(function (r) {
      var q = QUOTES[r.code] || {};
      var day = q.chg;
      // 快照结论与当日走势背离：如 6/6 看启动却跌停，列表直接给可见预警
      var riskMark = (isNum(day) && day <= -5 && bullCount(r) >= 4)
        ? ' <span class="risk-mark" title="六派看启动但今日大跌：快照结论不含当日，请重新评估">⚠</span>' : '';
      return '<tr data-open="' + esc(r.code) + '" title="点击查看个股透镜 / 前世今生" style="cursor:pointer">'
        + '<td class="name"><b>' + esc(r.name) + '</b><span class="cat">' + esc(r.code) + '</span> '
        + '<span class="cell-more" style="color:var(--blue);font-size:11px">详情 ›</span> '
        + '<button class="share-btn" data-share="' + esc(r.code) + '" title="生成该标的分享卡">分享</button></td>'
        + '<td>' + typeLabel(r) + '</td>'
        + stateCellHtml(r)
        + '<td class="' + (day != null ? signCls(day) : 'mut') + '" title="实时涨跌幅'
        + (QUOTES_TS ? '（' + esc(new Date(QUOTES_TS).toTimeString().slice(0, 5)) + ' 抓取）' : '')
        + '；左侧三态与近 N 日为快照口径，不含当日">'
        + (day != null ? daySpan(q, anyQuote ? '—' : '…') : (anyQuote ? '—' : '…')) + riskMark + '</td>'
        + '<td class="mut">' + pctSafe(r, 'w5') + '</td>'
        + '<td class="mut">' + pctSafe(r, 'w20') + '</td>'
        + '<td class="mut">' + pctSafe(r, 'w60') + '</td>'
        + '<td class="mut">' + pctSafe(r, 'w250') + '</td>'
        + '<td>' + bullCount(r) + '/6</td>'
        + '<td><span class="quad-chip">' + esc(quadOf(r)) + '</span></td>'
        + '<td>' + newsCellHtml(r) + '</td>'
        + '<td>' + starHtml(r.code) + '</td>'
        + '</tr>'
        + (STTIME_OPEN[r.code] ? '<tr class="st-expand"><td colspan="' + ALL_COLS.length + '">' + sixTimingHtml(r) + '</td></tr>' : '');
    }).join('');
    var pager = $('allPager');
    if (pager) pager.innerHTML = pagerHtml(recs.length, pages, start, view.length);
    markScrollHints();
    injectModuleSearch();
    if (!recs.length) {
      body.innerHTML = '<tr><td colspan="' + ALL_COLS.length + '" style="padding:22px 10px;text-align:center;color:var(--muted);line-height:1.9">'
        + '当前筛选：<b>' + esc(FILTER.st) + ' × ' + esc(FILTER.ty) + '</b> → 没有匹配的标的。<br>'
        + (FILTER.st !== '全部' || FILTER.ty !== '全部'
            ? '把上面任一筛选切回「全部」即可看到其余标的。'
            : '数据可能未加载完成，请稍等或点右上角刷新。')
        + '</td></tr>';
    } else {
      setTimeout(primeVisibleQuotes, 30);   // 先渲染骨架，再补当前页价格
    }
  }
  /* 通用批量补价：给「行业展开面板 / 任意列表」用。
     之前只有当前页 100 只取过价，所以展开某个行业时，除第一行外全是「—」。
     这里按 200 只一批并发取，回来后只刷新该面板的「今日%」单元格（不整表重绘）。 */
  function primeCodes(codes, done) {
    var need = (codes || []).filter(function (c) { return c && !QUOTES[c]; });
    if (!need.length) { if (done) done(); return; }
    var chunks = [], i;
    for (i = 0; i < need.length; i += 200) chunks.push(need.slice(i, i + 200));
    Promise.all(chunks.map(function (ch) {
      return DS.getTodayQuotes(ch).then(function (res) {
        var m = (res && res.map) || {};
        Object.keys(m).forEach(function (k) { QUOTES[k] = m[k]; });
        return true;
      }).catch(function () { return false; });
    })).then(function () {
      QUOTES_TS = Date.now();
      if (done) done();
    });
  }
  /* 只刷新指定容器里带 data-day 的单元格 */
  function refreshDayIn(root) {
    if (!root) return;
    var tds = root.querySelectorAll('td[data-day]');
    for (var i = 0; i < tds.length; i++) {
      var c = tds[i].getAttribute('data-day');
      var q = QUOTES[c];
      if (!q || q.chg == null) continue;
      tds[i].className = signCls(q.chg);
      tds[i].textContent = pct(q.chg);
    }
  }
  /* 当前页优先取价：只请求可见的这 100 只，1 个请求（约 0.3~1s）就能把「今日%」铺满，
     不必等全市场 5600 只的批量结果。翻页时也会顺带补齐新出现的标的。 */
  var PRIME_TS = 0, PRIME_BUSY = false;
  function primeVisibleQuotes() {
    var body = $('allBody'); if (!body) return;
    if (PRIME_BUSY || Date.now() - PRIME_TS < 8000) return;
    var trs = body.querySelectorAll('tr[data-open]'), need = [];
    for (var i = 0; i < trs.length; i++) {
      var c = trs[i].getAttribute('data-open');
      if (c && !QUOTES[c]) need.push(c);
    }
    if (!need.length) return;
    PRIME_BUSY = true;
    DS.getTodayQuotes(need).then(function (res) {
      var m = (res && res.map) || {};
      Object.keys(m).forEach(function (k) { QUOTES[k] = m[k]; });
      QUOTES_TS = Date.now(); PRIME_TS = Date.now();
      refreshDayCells();
    }).catch(function () {}).then(function () { PRIME_BUSY = false; });
  }
  /* 行情到达后只更新「今日%」单元格，不整表重绘（不打断滚动 / 不重置分页） */
  /* 增量刷新只改「今日%」单元格，不重建整表；所以背离提示与 ⚠ 必须在这里一起补，
     否则首屏（行情未到）渲染不出提示、行情到货后也永远不出现。 */
  function refreshDayCells() {
    var body = $('allBody'); if (!body) return;
    var trs = body.querySelectorAll('tr[data-open]');
    for (var i = 0; i < trs.length; i++) {
      var tr = trs[i], code = tr.getAttribute('data-open'), q = QUOTES[code];
      var td = tr.children[3];
      if (!td || !q || q.chg == null) continue;
      var r = DS.snapshot(code);
      var mk = (r && q.chg <= -5 && bullCount(r) >= 4)
        ? ' <span class="risk-mark" title="六派看启动但今日大跌：快照结论不含当日，请重新评估">⚠</span>' : '';
      td.className = signCls(q.chg);
      td.innerHTML = pct(q.chg) + mk;
      /* 阶段标签依赖今日涨跌（跌超 5% 判「退化」），行情到货后必须跟着重算，
         否则首屏算出的「观察」会一直挂着，直到整表重绘。 */
      var sb = body.querySelector('[data-stblock="' + code + '"]');
      if (sb && r) sb.innerHTML = stateBlock(r, { click: false });
    }
    updateDivergenceRow();
  }
  var ALL_VIEW = [];          // 当前页的行，供增量刷新时重算背离提示
  function updateDivergenceRow() {
    var body = $('allBody'); if (!body || !ALL_VIEW.length) return;
    var old = body.querySelector('.divergence-row');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var html = divergenceRowHtml(ALL_VIEW);
    if (html) body.insertAdjacentHTML('afterbegin', html);
  }
  /* 舆情列的统一口径：基线就绪时显示激增倍数；未就绪时显示真正抓到的
     条数 / 媒体数（个股命中）或行业级条数，不再一律用「—」把真实证据藏掉。 */
  function newsRankOf(r) {
    var nm = (r && r.newsMain) || {};
    if (isNum(nm.surge)) return 2 + nm.surge * (nm.dir >= 0 ? 1 : 0.4);
    var n = isNum(nm.n1) ? nm.n1 : 0, m = isNum(nm.mediaN) ? nm.mediaN : 0,
        s = isNum(nm.score) ? nm.score : 0;
    return n ? Math.min(2, 0.4 + n / 20 + m / 30 + s * 0.2) : -1e9;
  }
  function newsHot(r) {
    var nm = (r && r.newsMain) || {};
    if (isNum(nm.surge)) return nm.surge > 0.5;
    return (nm.evidenceN || 0) >= 3 && (nm.dir || 0) > 0;
  }
  function newsCellHtml(r) {
    var nm = (r && r.newsMain) || {};
    if (!nm.level) return '<span class="mut">—</span>';
    var txt = isNum(nm.surge) ? fmt(nm.surge, 1) + '×'
      : (nm.level === '个股命中'
          ? (nm.evidenceN || 0) + '条' + (nm.mediaN ? '·' + nm.mediaN + '家' : '')
          : '行业' + (nm.n1 || 0) + '条');
    return '<span class="' + (nm.dir > 0 ? 'dir-up' : (nm.dir < 0 ? 'dir-down' : 'mut'))
      + '" title="' + esc(nm.read || '') + '">' + txt + '</span>';
  }

  /* 数值列返回原值，dir=-1 即为降序（大在前）；缺失值垫底 */
  function val(r, k) {
    if (k === 'name') return r.name || '';
    if (k === 'type') return typeLabel(r);
    if (k === 'state') return ({ '启动': 0, '盘整': 1, '走完': 2 }[r.state] != null ? ({ '启动': 0, '盘整': 1, '走完': 2 }[r.state]) : 9);
    if (k === 'day') { var q = QUOTES[r.code]; return q && q.chg != null ? q.chg : -1e9; }
    if (k === 'resonance') return bullCount(r);
    if (k === 'quad') return ({ '领先': 4, '改善': 3, '走弱': 2, '落后': 1 }[quadOf(r)] || 0);
    if (k === 'news') return newsRankOf(r);
    if (k === 'star') return 0;
    return (r.pct && r.pct[k] != null) ? r.pct[k] : -1e9;
  }

  // ---------- 视图：行业（可排序表格 + 成分股下钻） ----------
  /* 行业口径（2026-11-13 用户确认）：接东财全量行业成分股 + 板块指数当日涨跌。
   * 「标的数」= 全行业成分股数（并标池内 N 只）；「今日」= 真实板块指数涨跌幅，
   * 不再用 158 只池内标的等权均值冒充板块涨跌（工业金属只有 1 只跌停 → -9.93% 的错值）。
   * GitHub 依据：akshare-mcp / astock-data-skill 的 stock_board_industry_name_em / _cons_em。 */
  var IND_DATA = { boards: [], mapped: {}, cons: {}, loaded: false };
  function loadIndustryData() {
    if (IND_DATA.loaded || !DS.getIndustryBoards) return Promise.resolve(IND_DATA);
    return DS.getIndustryBoards().then(function (boards) {
      IND_DATA.boards = boards || [];
      IND_DATA.mapped = {};
      DS.allRecords().forEach(function (r) {
        var g = r.ind || '其他';
        if (Object.prototype.hasOwnProperty.call(IND_DATA.mapped, g)) return;
        IND_DATA.mapped[g] = DS.mapIndustry ? DS.mapIndustry(g, IND_DATA.boards) : null;
      });
      IND_DATA.loaded = true;
      return IND_DATA;
    }).catch(function () { IND_DATA.loaded = true; return IND_DATA; });
  }
  function boardFor(name) { return IND_DATA.mapped[name] || null; }
  function fullConsHtml(name, b, list) {
    /* 池内判定先用全码（000001.SZ），再用裸码兜底：裸码是跨市场可撞的，
       只拿裸码当唯一键会把沪市 000001 和深市 000001 混成一个。 */
    var inPool = {}, inPoolBare = {};
    DS.allRecords().forEach(function (r) {
      inPool[r.code] = r;
      inPoolBare[String(r.code).replace(/\.[A-Z]{2,4}$/, '')] = r;
    });
    var rows = list.slice().sort(function (x, y) { return (y.chg == null ? -1e9 : y.chg) - (x.chg == null ? -1e9 : x.chg); })
      .map(function (x) {
        var r = inPool[x.code] || inPoolBare[x.bare];
        return '<tr data-open="' + esc(x.code) + '" title="点击查看个股透镜 / 前世今生 / K线" style="cursor:pointer">'
          + '<td class="name"><b>' + esc(x.name) + '</b> <span class="cat">' + esc(x.code) + '</span>'
          + (r ? ' <span class="tag mid">池内</span>' : '') + '</td>'
          + '<td>' + (x.price != null ? fmt(x.price, 2) : '—') + '</td>'
          + '<td class="' + (x.chg != null ? signCls(x.chg) : 'mut') + '">' + (x.chg != null ? pct(x.chg) : '—') + '</td>'
          + '<td class="cat">' + (x.amt != null ? fmt(x.amt / 1e8, 2) + '亿' : '—') + '</td>'
          + '<td class="cat">' + (x.turn != null ? fmt(x.turn, 2) + '%' : '—') + '</td>'
          + (r ? '<td>' + stateBlock(r) + '</td>' : '<td class="mut">池外 · 无三态</td>')
          + '</tr>';
      }).join('');
    return '<div class="ind-full"><div class="ind-full-hd"><b>全行业成分股 · ' + esc(b.name)
      + '（' + esc(b.bk) + '）</b> · ' + list.length + ' 只 · 板块当日 <b class="'
      + (b.chg != null ? signCls(b.chg) : 'mut') + '">' + (b.chg != null ? pct(b.chg) : '—')
      + '</b> · 点行打开透镜 / K线</div>'
      + '<div class="table-wrap"><table class="mini-tbl"><thead><tr><th>名称</th><th>最新价</th><th>今日%</th>'
      + '<th>成交额</th><th>换手</th><th>三态（池内）</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '<div class="hint">全量成分股来自东财行业板块（或离线 industry.js），与「158 只快照池」是两套口径；'
      + '三态 / 六派信号<b>只覆盖池内标的</b>，池外标的提供实时价与 K 线。数据为客观行情，不构成投资建议。</div></div>';
  }
  function hydrateIndustryCons() {
    if (!document.querySelectorAll) return;
    Array.prototype.forEach.call(document.querySelectorAll('[data-indcons]'), function (el) {
      var name = el.getAttribute('data-indcons'), b = boardFor(name);
      if (!b || el.getAttribute('data-loaded')) return;
      el.setAttribute('data-loaded', '1');
      var render = function (list) {
        el.innerHTML = list && list.length ? fullConsHtml(name, b, list)
          : '<div class="notice">该板块全量成分股暂未取到（离线 industry.js 未生成且东财接口不可用）；'
            + '下方仍保留 158 只快照池内的标的，<b>不代表全行业</b>。</div>';
      };
      if (IND_DATA.cons[b.bk]) { render(IND_DATA.cons[b.bk]); return; }
      DS.getIndustryCons(b.bk).then(function (list) { IND_DATA.cons[b.bk] = list || []; render(IND_DATA.cons[b.bk]); })
        .catch(function () { render([]); });
    });
  }
  var SEC_SORT = { key: 'avg', dir: -1 };
  var MEM_SORT = {};         // 行业名 -> {key,dir}
  var OPEN_IND = {};         // 当前展开的行业
  var SEC_COLS = [
    { k: 'name', t: '行业', lft: true, tip: '按行业名排序' },
    { k: 'count', t: '成分股数', tip: '全行业成分股数（含池内 N 只）；未匹配到板块时显示池内数' },
    { k: 'avg', t: '板块今日%', tip: '东财板块指数（拿不到时用成分股市值加权估算，单元格会标「市值加权」）。板块指数本身就是市值加权，比等权平均接近得多，但仍非官方指数' },
    { k: 'avg5', t: '近5日均%', tip: '快照区间涨跌均值，不含当日' },
    { k: 'states', t: '三态分布', tip: '该行业成分股里 启动 / 盘整 / 走完 各多少只' },
    { k: 'launch', t: '启动占比', tip: '三态=启动 的占比' },
    /* 领涨与领跌合成一列上下两行：分成两列时右侧「领跌」在 1280 宽的屏上会被裁掉 */
    { k: 'up', t: '领涨 / 领跌', tip: '上行＝领涨股（按领涨幅度排序）；下行＝领跌股（无实时时用近5日）' }
  ];
  /* ---------- 份额折算 / 拆分检测 ----------
     实测：通信ETF国泰(515880) 不复权 1.320→0.385（-70.8%），前复权 0.220→0.385（+75.0%）。
     快照的 pct 是拿未复权收盘算的，份额折算会被算成暴跌 —— 这种数字比「不给」更有害。
     这里用快照自带的 61 根收盘做一次跳变检测：单日 |涨跌| > 25% 视为疑似折算。
     （A股个股有涨跌停，不可能单日超过 25%；ETF 折算/拆分才会。） */
  var SPLIT_CACHE = {};
  function suspectedSplit(r) {
    if (!r || !r.code) return false;
    if (SPLIT_CACHE[r.code] != null) return SPLIT_CACHE[r.code];
    var c = r.closes;
    var hit = false;
    if (Array.isArray(c) && c.length > 3) {
      for (var i = 1; i < c.length; i++) {
        var p0 = c[i - 1], p1 = c[i];
        if (!isNum(p0) || !isNum(p1) || p0 <= 0) continue;
        if (Math.abs((p1 / p0 - 1) * 100) > 25) { hit = true; break; }
      }
    }
    /* 更关键的一条：c250 是「250 个交易日前那一根收盘」。
       若它与 61 根序列最早一根的量级差 3 倍以上，说明中间发生过份额折算，
       w250 用这两个不同基准的价算出来必然是假的（515880 实测：c250≈275、现价≈41.6）。
       这种情况最近 61 根里是看不到跳变的，只靠逐日检测会漏。 */
    if (!hit && isNum(r.c250) && r.c250 > 0 && Array.isArray(c) && c.length) {
      var ratio = r.c250 / c[0];
      if (ratio > 3 || ratio < 0.33) hit = true;
    }
    SPLIT_CACHE[r.code] = hit;
    return hit;
  }
  /* 区间涨跌展示：疑似折算的标的，长周期数字直接标「折算失真」，
     短周期（5/20 日）如果没跨到折算日仍然可信，所以只在跨到时降级。
     判断依据：该周期内是否出现过 >25% 的跳变。 */
  function pctSafe(r, key) {
    var v = r && r.pct ? r.pct[key] : null;
    if (!isNum(v)) return '<span class="mut">—</span>';
    if (!suspectedSplit(r)) return pct(v);
    /* w250 依赖 c250（250 个交易日前那根），一旦中间折算过就必然失真，
       而最近 61 根里看不到跳变，所以这里直接用「量级突变」判定，不再逐日扫。 */
    if (key === 'w250') {
      return '<span class="mut" title="该标的在近 250 个交易日内发生过份额折算/拆分，'
        + '未复权的收盘价会造成虚假暴跌。真实涨跌幅请看「前世今生」里的前复权日K。">折算失真</span>';
    }
    var back = { w5: 5, w20: 20, w60: 60, w250: 250 }[key] || 0;
    var c = r.closes || [];
    var span = Math.min(back + 1, c.length);
    var crossed = false;
    for (var i = c.length - span + 1; i < c.length; i++) {
      if (i < 1) continue;
      var p0 = c[i - 1], p1 = c[i];
      if (!isNum(p0) || !isNum(p1) || p0 <= 0) continue;
      if (Math.abs((p1 / p0 - 1) * 100) > 25) { crossed = true; break; }
    }
    if (!crossed) return pct(v);
    return '<span class="mut" title="该区间内发生过份额折算/拆分，未复权的收盘价会造成虚假暴跌。'
      + '真实涨跌幅请点开「前世今生」看（那里用前复权日K重算）。">折算失真</span>';
  }
  function dayOf(r) { var q = QUOTES[r.code]; return q && q.chg != null ? q.chg : null; }
  /* 停牌/未开盘识别：成交量为 0 且涨跌为 0 → 当天没有成交（688798 这类停牌股会返回 0.00%）。
     不写死「停牌」（开盘前也是 0 成交），统一显示「无成交」，title 里说明两种情况。 */
  function isSuspended(q) {
    return !!(q && q.volume === 0 && (q.chg == null || q.chg === 0));
  }
  function daySpan(q, missing) {
    if (!q || q.chg == null) return '<span class="mut">' + (missing || '—') + '</span>';
    if (isSuspended(q)) return '<span class="mut" title="成交量为 0：停牌或当日尚未开盘，不是「平盘」">无成交</span>';
    return '<span class="' + signCls(q.chg) + '">' + pct(q.chg) + '</span>';
  }
  function avgOf(a) { if (!a.length) return null; var s = 0; a.forEach(function (x) { s += x; }); return s / a.length; }
  function sectorStats() {
    var groups = {};
    DS.allRecords().forEach(function (r) {
      var g = r.ind || (r.kind === 'etf' ? '' : '其他');
      if (!g) return;                       // 未匹配行业的 ETF 不进行业页
      (groups[g] = groups[g] || { name: g, list: [] }).list.push(r);
    });
    return Object.keys(groups).map(function (g) {
      /* ETF 排在最前（用户要求：板块里有对应 ETF 就放第一个），
         其余按当日涨跌绝对值降序，让板块里最活跃的票先露头。 */
      var list = groups[g].list.slice().sort(function (a, b) {
        var ea = a.kind === 'etf' ? 0 : 1, eb = b.kind === 'etf' ? 0 : 1;
        if (ea !== eb) return ea - eb;
        return Math.abs(dayOf(b) || 0) - Math.abs(dayOf(a) || 0);
      });
      var etfN = list.filter(function (r) { return r.kind === 'etf'; }).length;
      var days = list.map(dayOf).filter(function (x) { return x != null; });
      var w5s = list.map(function (r) { return r.pct && r.pct.w5; }).filter(isNum);
      var byDay = list.filter(function (r) { return dayOf(r) != null; }).sort(function (a, b) { return dayOf(b) - dayOf(a); });
      var byW5 = list.filter(function (r) { return r.pct && isNum(r.pct.w5); }).sort(function (a, b) { return b.pct.w5 - a.pct.w5; });
      function vOf(r) { if (!r) return null; var d = dayOf(r); return d != null ? d : (r.pct && isNum(r.pct.w5) ? r.pct.w5 : null); }
      var b = boardFor(g);
      var full = b && IND_DATA.cons[b.bk] ? IND_DATA.cons[b.bk] : null;
      /* 领涨 / 领跌
         旧实现有两个坑：
           ① full（行业全量成分股）里若 chg 全为空，排序退化成原序，
              sf[0] 与 sf[last] 可能取到同一只 —— 于是「领涨」「领跌」是同一只股票；
           ② 全行业普涨时，最后一名其实是「涨幅最小」，标成「领跌」会误导。
         现在统一成「候选池 → 按涨跌排序 → 取首尾，且首尾不能是同一只」，并标出「涨幅最小」。 */
      var up = null, down = null, upVal = null, downVal = null;
      var cands = [];
      if (full && full.length) {
        cands = full.map(function (x) {
          return { name: x && x.name, code: x && x.code, v: (x && x.chg != null ? x.chg : null) };
        });
      }
      if (!cands.filter(function (x) { return x.v != null; }).length) {
        cands = list.map(function (r) {
          var d = dayOf(r);
          return { name: r.name, code: r.code, v: d != null ? d : (r.pct && isNum(r.pct.w5) ? r.pct.w5 : null) };
        });
      }
      var okC = cands.filter(function (x) { return x.v != null && x.name; })
        .sort(function (x, y) { return y.v - x.v; });
      if (okC.length) {
        up = okC[0]; upVal = up.v;
        if (okC.length > 1) {
          down = okC[okC.length - 1]; downVal = down.v;
          if (downVal != null && downVal >= 0) down = { name: down.name, code: down.code, v: down.v, weak: 1 };
        }
      }
      var launch = list.filter(function (r) { return r.state === '启动'; }).length;
      return {
        name: g, list: list, count: list.length, etfCount: etfN,
        board: b, boardChg: b && b.chg != null ? b.chg : null,
        fullCount: full ? full.length : null, consList: full,
        /* 板块涨跌：东财 clist 已整体不可用（服务器侧也报 Remote end closed），
           拿不到官方板块指数。退而用「成分股市值加权」—— 板块指数本身就是市值加权，
           比等权均涨接近得多，但仍是估算，界面上必须标清口径，不能冒充官方指数。 */
        avgDay: (function () {
          var wSum = 0, wTot = 0;
          list.forEach(function (r) {
            var d = dayOf(r);
            if (d == null || !isNum(r.mcap) || r.mcap <= 0) return;
            wSum += d * r.mcap; wTot += r.mcap;
          });
          return wTot > 0 ? wSum / wTot : avgOf(days);
        })(),
        avg5: avgOf(w5s), launch: launch,
        launchPct: list.length ? launch / list.length * 100 : 0,
        up: up, down: down, upVal: upVal, downVal: downVal,
        hasRealtime: days.length > 0,
        states: {
          '启动': launch,
          '盘整': list.filter(function (r) { return r.state === '盘整'; }).length,
          '走完': list.filter(function (r) { return r.state === '走完'; }).length
        }
      };
    }).filter(function (g) { return g.count >= 2; });   // 只有 1 只的板块没信息量，直接不展示
  }
  function secVal(o, k) {
    if (k === 'name') return o.name;
    if (k === 'count') return o.fullCount != null ? o.fullCount : o.count;
    if (k === 'avg') return o.boardChg != null ? o.boardChg : (o.avgDay == null ? -1e9 : o.avgDay);
    if (k === 'avg5') return o.avg5 == null ? -1e9 : o.avg5;
    if (k === 'launch') return o.launchPct;
    if (k === 'up') return o.upVal == null ? -1e9 : o.upVal;
    if (k === 'down') return o.downVal == null ? 1e9 : o.downVal;
    return 0;
  }
  function sectorHeadHtml() {
    return '<tr>' + SEC_COLS.map(function (c) {
      var on = SEC_SORT.key === c.k;
      var attr = c.nosort ? '' : ' data-ssort="' + c.k + '" style="cursor:pointer"';
      return '<th class="' + (c.lft ? 'lft ' : '') + (on ? 'on' : '') + '"' + attr + ' title="' + c.tip + '">'
        + c.t + (on ? '<span class="ar">' + (SEC_SORT.dir < 0 ? '▼' : '▲') + '</span>' : '') + '</th>';
    }).join('') + '</tr>';
  }
  function viewSector() {
    var _st = sectorStats();
    var n = _st.length;
    var withEtf = _st.filter(function (o) { return o.etfCount > 0; }).length;
    return '<div class="section-title"><h2>行业 · 三态下钻</h2><span class="desc">' + n + ' 个行业 · 其中 <b>'
      + withEtf + ' 个</b>有对应 ETF（已置顶）· 点列头排序 · 点行业展开成分股</span></div>'
      + '<p class="sort-hint">默认按「板块今日%」降序，该列取<b>东财行业板块指数当日涨跌幅</b>（与看盘软件一致）；'
      + '取不到板块数据时回落到「池内均涨」并明确标注口径，不再用少数池内标的冒充板块。'
      + '「成分股数」为全行业数量并标注池内 N 只；展开后列全量成分股，可点开透镜 / K线。'
      + '<b>三态与六派信号覆盖全部 A 股（腾讯 / 新浪免费行情重算）</b>；宽基 / 主题类（如创业板宽基、港股科技）不是行业板块，不做成分股扩展。</p>'
      + '<div class="table-wrap wide"><table class="ind-table"><thead id="sectorHead">' + sectorHeadHtml() + '</thead><tbody id="sectorBody"></tbody></table></div>'
      + legendBlock();
  }
  function renderSectorBody() {
    var head = $('sectorHead'); if (head) head.innerHTML = sectorHeadHtml();
    var body = $('sectorBody'); if (!body) return;
    var list = sectorStats();
    if (MOD_KW.sector) {
      var skw = MOD_KW.sector;
      list = list.filter(function (o) { return String(o.name).indexOf(skw) >= 0; });
    }
    list.sort(function (a, b) {
      var va = secVal(a, SEC_SORT.key), vb = secVal(b, SEC_SORT.key), dir = SEC_SORT.dir;
      if (SEC_SORT.key === 'name') return dir * String(va).localeCompare(String(vb), 'zh');
      return dir * (va - vb);
    });
    body.innerHTML = list.map(function (o) {
      var open = !!OPEN_IND[o.name];
      /* 行业表渲染后，用东财板块指数把「池内均涨」换成真实板块涨跌。
     拿不到就保留池内均涨并如实标注，不假装成板块指数。 */
  function hydrateBoardChg(list) {
    if (!DS.getBoardQuotes) return;
    var bks = [];
    (list || []).forEach(function (o) { if (o.board && o.board.bk) bks.push(o.board.bk); });
    if (!bks.length) return;
    DS.getBoardQuotes(bks).then(function (res) {
      var map = (res && res.map) || {};
      if (!Object.keys(map).length) return;
      var cells = document.querySelectorAll('[data-boardchg]');
      for (var i = 0; i < cells.length; i++) {
        var bk = cells[i].getAttribute('data-boardchg');
        var b = map[bk];
        if (!b || b.chg == null) continue;
        var v = cells[i].querySelector('[data-boardval]');
        var src = cells[i].querySelector('[data-boardsrc]');
        if (v) { v.textContent = pct(b.chg); }
        cells[i].className = signCls(b.chg);
        if (src) src.textContent = '板块指数';
      }
    }).catch(function () { });
  }
  function leader(o) {
        if (!o || o.v == null) return '<span class="mut">—</span>';
        var nm = String(o.name || '');
        if (nm.length > 6) nm = nm.slice(0, 6) + '…';
        return '<span class="ld-n">' + esc(nm) + '</span>'
          + ' <span class="' + signCls(o.v) + '">' + pct(o.v) + '</span>'
          + (o.weak ? '<span class="cat">涨幅最小</span>' : '');
      }
      var dayV = o.boardChg != null ? o.boardChg : o.avgDay;
      var row = '<tr class="ind-row' + (open ? ' ind-open' : '') + '" data-indtoggle="' + esc(o.name) + '" title="点击展开/收起成分股">'
        + '<td class="name"><b>' + esc(o.name) + '</b> <span style="color:var(--blue);font-size:11px">' + (open ? '▾ 收起' : '▸ 展开') + '</span>'
        + (o.board ? '<span class="cat">' + esc(o.board.name) + '</span>' : '<span class="cat">ETF/未匹配</span>') + '</td>'
        + '<td>' + (o.fullCount != null ? '<b>' + o.fullCount + '</b>' : o.count)
        + ' <span class="cat">池内 ' + o.count + (o.etfCount ? ' · ETF ' + o.etfCount : '') + '</span></td>'
        + '<td class="' + (dayV != null ? signCls(dayV) : 'mut') + '"'
        + (o.board && o.board.bk ? ' data-boardchg="' + esc(o.board.bk) + '"' : '') + '>'
        + '<span data-boardval>' + (dayV != null ? pct(dayV) : '—') + '</span>'
        + '<span class="cat" data-boardsrc>' + (o.boardChg != null ? '板块指数' : '市值加权') + '</span></td>'
        + '<td class="' + (o.avg5 != null ? signCls(o.avg5) : 'mut') + '">' + (o.avg5 != null ? pct(o.avg5) : '—') + '</td>'
        + '<td class="st-badges">'
        + '<span class="st-b st-launch" title="启动">启 ' + o.states['启动'] + '</span>'
        + '<span class="st-b st-consol" title="盘整">整 ' + o.states['盘整'] + '</span>'
        + '<span class="st-b st-done" title="走完">完 ' + o.states['走完'] + '</span>'
        + '</td>'
        + '<td>' + fmt(o.launchPct, 0) + '% <span class="cat">(' + o.launch + '/' + o.count + ')</span></td>'
        + '<td class="ld-cell">' + leader(o.up) + (o.hasRealtime ? '' : ' <span class="cat">近5日</span>')
        + '<div class="ld-down">' + leader(o.down) + '</div></td>'
        + '</tr>';
      if (open) row += '<tr class="ind-detail"><td colspan="7">' + indPanelHtml(o) + '</td></tr>';
      return row;
    }).join('');
    injectModuleSearch();
    markScrollHints();
    hydrateBoardChg(list);
    hydrateIndustryCons();   // 展开面板里的全量成分股异步水合
    /* 展开的行业：池内成员可能远超当前页 100 只，先把它们的「今日%」补回来，
       否则会出现"展开后只有第一行有今日涨跌、其余全是 —"的错觉。 */
    list.filter(function (o) { return !!OPEN_IND[o.name]; }).forEach(function (o) {
      primeCodes(o.list.map(function (r) { return r.code; }), function () {
        refreshDayIn(document);   // 只改带 data-day 的单元格，不重绘表格
      });
    });
  }
  function indPanelHtml(o) {
    var s = MEM_SORT[o.name] || { key: 'day', dir: -1 };
    var cols = [
      { k: 'name', t: '名称', lft: true }, { k: 'state', t: '三态' },
      { k: 'day', t: '今日%' }, { k: 'w5', t: '近5日' }, { k: 'w20', t: '近20日' },
      { k: 'resonance', t: '六派' }, { k: 'star', t: '★' }
    ];
    function mv(r, k) {
      if (k === 'name') return r.name || '';
      if (k === 'state') return ({ '启动': 0, '盘整': 1, '走完': 2 }[r.state] != null ? ({ '启动': 0, '盘整': 1, '走完': 2 }[r.state]) : 9);
      if (k === 'day') { var d = dayOf(r); return d == null ? -1e9 : d; }
      if (k === 'resonance') return bullCount(r);
      return (r.pct && isNum(r.pct[k])) ? r.pct[k] : -1e9;
    }
    var list = o.list.slice().sort(function (a, b) {
      var ea = a.kind === 'etf' ? 0 : 1, eb = b.kind === 'etf' ? 0 : 1;
      if (ea !== eb) return ea - eb;          // ETF 始终置顶（用户要求）
      var va = mv(a, s.key), vb = mv(b, s.key);
      if (s.key === 'name') return s.dir * String(va).localeCompare(String(vb), 'zh');
      return s.dir * (va - vb);
    });
    var etfNote = o.etfCount
      ? ''
      : '<div class="pl" style="margin:0 0 8px">本行业<b>暂无跟踪该主题的 ETF</b>（不是漏匹配）：'
        + 'ETF 只覆盖约 50 个主流行业，冷门细分（如钾肥、锦纶）市场上没有对应产品。</div>';
    var th = '<tr>' + cols.map(function (c) {
      var on = s.key === c.k;
      return '<th class="' + (c.lft ? 'lft ' : '') + (on ? 'on' : '') + '" data-msort="' + c.k + '" data-mg="' + esc(o.name) + '" style="cursor:pointer">'
        + c.t + (on ? '<span class="ar">' + (s.dir < 0 ? '▼' : '▲') + '</span>' : '') + '</th>';
    }).join('') + '</tr>';
    var rows = list.map(function (r) {
      var d = dayOf(r);
      return '<tr data-open="' + esc(r.code) + '" title="点击打开个股透镜" style="cursor:pointer">'
        + '<td class="name"><b>' + esc(r.name) + '</b> <span class="cat">' + esc(r.code) + '</span>'
        + (r.kind === 'etf' ? ' <span class="etf-tag">ETF</span>' : '') + '</td>'
        + '<td>' + stateBlock(r) + '</td>'
        + '<td class="' + (d != null ? signCls(d) : 'mut') + '" data-day="' + esc(r.code) + '">' + (d != null ? pct(d) : '—') + '</td>'
        + '<td class="mut">' + pct(r.pct && r.pct.w5) + '</td>'
        + '<td class="mut">' + pct(r.pct && r.pct.w20) + '</td>'
        + '<td>' + bullCount(r) + '/6</td>'
        + '<td>' + starHtml(r.code) + '</td>'
        + '</tr>';
    }).join('');
    var b = boardFor(o.name);
    var etfNote = o.etfCount ? '' : '<div class="pl" style="margin:0 0 8px">本行业<b>暂无跟踪该主题的 ETF</b>（不是漏匹配）：'
      + 'ETF 只覆盖约 50 个主流行业，冷门细分（如钾肥、锦纶）市场上确实没有对应产品。</div>';
    var fullSlot = b
      ? '<div class="ind-cons-slot" data-indcons="' + esc(o.name) + '">正在加载 <b>' + esc(b.name)
        + '（' + esc(b.bk) + '）</b> 全量成分股…</div>'
      : '<div class="notice"><b>未匹配到东财行业板块</b>：「' + esc(o.name) + '」属于 ETF 宽基 / 主题分类，'
        + '或同花顺行业名与东财板块名不一致；下方仅展示看板收录的 ' + list.length
        + ' 只，<b>不代表全行业规模</b>。</div>';
    return '<div class="ind-panel">'
      + '<div class="section-title" style="margin:0 0 8px"><h2 style="font-size:14px">全行业成分股 · 当日涨跌榜</h2>'
      + '<span class="desc">东财行业板块口径（或离线 industry.js）</span></div>' + fullSlot
      + '<div class="section-title" style="margin:16px 0 8px"><h2 style="font-size:14px">池内标的 · 三态视角</h2>'
      + '<span class="desc">看板收录的 ' + list.length + ' 只 · 点列头排序 · 点行打开透镜</span></div>'
      + '<table class="mini-tbl"><thead>' + th + '</thead><tbody>' + rows + '</tbody></table></div>';
  }

  /* ============================================================
   * 旧版核心功能补齐层
   * GitHub 调研依据：
   *  - RRG（Mrugesh666/RRG-Sector-Rotation-Analyzer、xkqg/MatPlotLibNet）：
   *    RS=标的/基准，标准化为 RS-Ratio 与 RS-Momentum，四象限固定以基准线为原点，
   *    顺时针 领先→走弱→落后→改善。本站 data.js 已给出「相对基准的超额/动量变化」，
   *    故中心为 0/0，等价于标准 RRG 的 100/100。
   *  - 舆情激增（billy3321/worldmonitor、SteveTrewick/DoomTrend）：
   *    短窗口 n1 vs 7 日基线 n7/7，绝对计数下限 + 相对倍数 + 噪声降权 + 方向系数 + 热度交叉验证。
   *  - 关注体检（AnkitaMuni/Smart_Watchlist、recursiverob/ScoreMyStocks）：
   *    Last-Seen 基线对比 + 多因子打分 + 红黄绿分级（此处红黄绿=风险等级，与涨跌无关）。
   *  - 分享海报（walnut-a/text-card-maker、webix-Talib/card-generator）：
   *    纯 Canvas 2× 绘制 + qrcode.js（二维码 ≥100px）+ 无后端 PNG 导出。
   * ============================================================ */
  function RAW() { return window.AB_DATA || {}; }
  function readLS(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function bjToday() { try { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); } catch (e) { return 'today'; } }
  function safeUrl(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : ''; }
  function themeList() {
    var D = RAW(), out = [], seen = {}, agg = D.themeAgg || {};
    /* 真实多源舆情优先（AB_NEWS：云端多源采集，源数见 AB_NEWS.sources）。整块替换 D.themeAgg，
       让下面的聚合逻辑与 newsCard 全用真实当日条数/媒体数/极性，
       不用静态历史 titleIndex。读不到时原样退回旧快照。 */
    var RN = (typeof window !== 'undefined' && window.AB_NEWS) ? window.AB_NEWS : null;
    if (RN && RN.themes && RN.themes.length) {
      var realAgg = {};
      RN.themes.forEach(function (t) { realAgg[t.key] = t; });
      agg = realAgg;
      var realOut = RN.themes.map(function (t) {
        var o = {}, k;
        for (k in t) if (Object.prototype.hasOwnProperty.call(t, k)) o[k] = t[k];
        return o;
      });
      realOut.sort(function (a, b) { return (Math.abs(b.eff || 0) - Math.abs(a.eff || 0)); });
      return realOut;
    }
    (Array.isArray(D.themes) ? D.themes : []).forEach(function (t) {
      var o = {}, k;
      for (k in t) if (Object.prototype.hasOwnProperty.call(t, k)) o[k] = t[k];
      var a = agg[o.key] || {};
      ['h24max', 'h24avg', 'n24', 'heatWeekMax', 'liveKw'].forEach(function (x) { if (o[x] == null && a[x] != null) o[x] = a[x]; });
      seen[o.key] = 1; out.push(o);
    });
    Object.keys(agg).forEach(function (key) {
      if (seen[key]) return;
      var o = {}, a = agg[key], k;
      for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k];
      o.key = o.key || key; out.push(o);
    });
    return out;
  }

  // ---------- 市场温度 / 全市场概览 ----------
  /* 市场条分两类数据，必须分开标注，否则「过时的快照」会被当成实时：
       · 实时：两市成交额、上涨/下跌家数（来自东财指数接口 f6 / f104-f106）
       · 快照：情绪温度、个股中位数、连板、沪深300 区间涨跌（构建时算好，不随盘中变）
     之前把「成交额 7200 亿」当实时展示，而它其实是写死的常数 —— 这类错误最伤口碑。 */
  var MKT_LIVE = null;
  /* 全站统一补价：任何元素只要写上 data-q="600519.SH"，渲染完就会自动有今日涨跌。
     以前每个视图各写一套取价逻辑，漏一处就出现「点一个才出一个」。
     clist 全市场接口在浏览器里不可用，所以这里走 ulist 分块（每次 150 只）。 */
  function fillQuoteEl(el, q) { el.innerHTML = daySpan(q, '—'); }
  function hydrateQuotes() {
    var els = document.querySelectorAll('[data-q]');
    if (!els.length) return;
    var list = [], seen = {};
    for (var i = 0; i < els.length; i++) {
      var c = els[i].getAttribute('data-q');
      if (!c) continue;
      var have = QUOTES[c];
      if (have && have.chg != null) { fillQuoteEl(els[i], have); continue; }
      if (!seen[c]) { seen[c] = 1; list.push(c); }
    }
    if (!list.length || !DS.getQuotesByChunks) return;
    DS.getQuotesByChunks(list).then(function (res) {
      var map = (res && res.map) || {};
      Object.keys(map).forEach(function (c) { QUOTES[c] = map[c]; });
      var all = document.querySelectorAll('[data-q]');
      for (var j = 0; j < all.length; j++) {
        var cc = all[j].getAttribute('data-q');
        if (map[cc]) fillQuoteEl(all[j], map[cc]);
      }
      /* 无额外动作：中位数 / 连板用快照口径，不依赖实时价 */

    }).catch(function () { });
  }
  function amtText(a) {
    if (!isNum(a)) return '—';
    return a >= 10000 ? (fmt(a / 10000, 2) + ' 万亿') : (fmt(a, 0) + ' 亿');
  }
  function refreshMarketLive() {
    if (!DS.getMarketLive) return;
    /* 延后 1.2 秒：首屏还有 guard 的云端请求 + 全市场分块取价在跑，
       同一时刻去打东财指数接口容易被直接断流（表现为一直显示快照值）。 */
    setTimeout(function () { doRefreshMarketLive(); }, 1200);
  }
  function doRefreshMarketLive() {
    DS.getMarketLive().then(function (d) {
      if (!d) return;
      MKT_LIVE = d;
      function set(k, v) { var el = document.querySelector('[data-mk="' + k + '"]'); if (el) el.textContent = v; }
      set('up', d.up); set('down', d.down); set('amount', amtText(d.amount));
      /* 拿到数据才敢标「实时」，否则保持「快照 + 日期」，绝不把旧值说成实时 */
      var t2 = document.querySelector('[data-mk-tag="amount"]');
      if (t2) t2.textContent = '实时';
      try { updateStateBanner('tencent', Date.now()); } catch (e) { }
      refreshBreadth();
    }).catch(function () { });
  }
  /* 涨跌家数：腾讯不给指数级家数，只能自己数。等全量取价（live-refresh）到位后统计，
     覆盖不足 1200 只就先不显示，绝不用部分样本冒充「两市家数」。 */
  var BREADTH_TRIES = 0;
  function refreshBreadth() {
    var up = 0, down = 0, flat = 0, n = 0;
    Object.keys(QUOTES).forEach(function (c) {
      var q = QUOTES[c];
      if (!q || q.chg == null || !isNum(q.chg)) return;
      n++;
      if (q.chg > 0.005) up++; else if (q.chg < -0.005) down++; else flat++;
    });
    var t1 = document.querySelector('[data-mk-tag="updown"]');
    if (n < 1200) {
      /* 还没取全：过一会儿再试，最多 8 次（约 16 秒） */
      if (BREADTH_TRIES++ < 8) { setTimeout(refreshBreadth, 2000); }
      return;
    }
    BREADTH_TRIES = 0;
    function set(k, v) { var el = document.querySelector('[data-mk="' + k + '"]'); if (el) el.textContent = v; }
    set('up', up); set('down', down);
    if (t1) t1.textContent = '实时';
  }
  function marketBar() {
    var m = RAW().market || {}, s = RAW().summary || {}, bm = m.benchmark || {};
    var temp = isNum(m.temp) ? m.temp : 50;
    var med5 = median5Pct();
    var lb = limitBoards();
    var lbTxt = Object.keys(lb).sort(function (x, y) { return y - x; }).slice(0, 3)
      .map(function (k) { return k + '板 ' + lb[k]; }).join(' · ');
    var snapDay = dayStr((RAW().meta || {}).asOf) || '—';
    function cell(l, v, cls) { return '<div class="mkt-cell"><div class="l">' + l + '</div><div class="v ' + (cls || '') + '">' + v + '</div></div>'; }
    var L = MKT_LIVE;
    return '<div class="market-bar"><div class="mkt-temp">'
      + '<div class="t"><span>市场情绪温度 <span class="cat">快照 ' + esc(snapDay) + '</span></span><b>' + fmt(temp, 1) + ' / 100</b></div>'
      + '<div class="tempbar"><i style="width:' + Math.max(2, Math.min(100, temp)) + '%"></i></div>'
      + '<div class="note">' + esc(m.phase || '—') + (m.phaseNote ? ' · ' + esc(m.phaseNote) : '')
      + '<br>温度为快照口径，不随盘中变化；下面的成交额与涨跌家数是实时的。</div></div>'
      + '<div class="mkt-cells">'
      + cell('上涨 / 下跌 <span class="cat" data-mk-tag="updown">' + (L ? '实时' : '快照 ' + esc(snapDay)) + '</span>',
        '<span data-mk="up">' + (L && isNum(L.up) ? L.up : (isNum(m.up) ? m.up : '—')) + '</span> / '
        + '<span data-mk="down">' + (L && isNum(L.down) ? L.down : (isNum(m.down) ? m.down : '—')) + '</span>', 'up')
      + cell('涨停 / 跌停', (isNum(m.lu) ? m.lu : '—') + ' / ' + (isNum(m.ld) ? m.ld : '—'))
      + cell('个股中位数 <span class="cat">近5日</span>', med5 != null ? pct(med5) : '—', med5 != null ? signCls(med5) : '')
      + cell('连板梯队 <span class="cat">截至快照</span>', lbTxt || '—')
      + cell('两市成交额 <span class="cat" data-mk-tag="amount">' + (L ? '实时' : '快照 ' + esc(snapDay)) + '</span>',
        '<span data-mk="amount">' + amtText(L && isNum(L.amount) ? L.amount : m.amount) + '</span>')
      + cell('沪深300 近20日', isNum(bm.m20) ? pct(bm.m20) : '—', isNum(bm.m20) ? signCls(bm.m20) : '')
      + '</div></div>';
  }
  function quickLinks() {
    return '<div class="quick-links">'
      + '<a href="#/news">◎ 舆情激增雷达</a>'
      + '<a href="#/rrg">◈ RRG 相对轮动</a>'
      + '<a href="#/health">✚ 关注池健康体检</a>'
      + '<a href="#/sector">▤ 行业下钻</a>'
      + '<a href="#/picker">⤢ 个股前世今生</a>'
      + '<button class="btn" data-share="" title="生成今日信号榜分享海报">↗ 今日信号海报</button>'
      + '</div>';
  }

  // ---------- 今日变化 · 上次看以来 / 连胜（Last-Seen 基线） ----------
  var SEEN_KEY = 'ab_seen_v2', STREAK_KEY = 'ab_streak_v2';
  function streakInfo() {
    var days = readLS(STREAK_KEY, []); if (!Array.isArray(days)) days = [];
    var t = bjToday();
    if (days.indexOf(t) < 0) { days.push(t); days = days.slice(-90); writeLS(STREAK_KEY, days); }
    var n = 0, cur;
    try { cur = new Date(t + 'T00:00:00Z'); } catch (e) { return { n: 1, total: days.length }; }
    for (var i = 0; i < 90; i++) {
      var ds = cur.toISOString().slice(0, 10);
      if (days.indexOf(ds) < 0) break;
      n++; cur = new Date(cur.getTime() - 86400e3);
    }
    return { n: n, total: days.length };
  }
  /* 今日早报：用一句白话 + 可展开的新闻速览，回答「今天大概会怎么走、为什么」。
     数据来自独立的 daily.js，每天换那一个文件即可，不必重跑全量构建。 */
  /* 每日速览：一天三个时段（早报 / 午间速览 / 收盘复盘），按当前时间自动切换。
     新闻列表只显示一句话摘要，点标题展开看完整说明 —— 手机上不截断。 */
  var DAILY_OPEN = false;
  var DAILY_NEWS = {};      // 展开中的新闻下标
  /* 只有「真的有正文」的时段才算数据。
     坑：daily.js 里 close: {} 这种占位空对象是 truthy，若只用 `D.close || D.noon`
     判断，15:00 一到就会选中这个空档，整块点评被渲染成空（早报/午间直接消失）。
     必须按 oneLine 判断有效。 */
  function dailyOk(s) { return (s && s.oneLine) ? s : null; }
  function dailySlot(D) {
    if (!D) return null;
    if (!D.morning && !D.noon && !D.close) return D;   // 兼容旧结构（顶层即内容）
    // 过期检测：数据日期早于今天时，按当前时间回退会显示「昨天的早盘预判」，
    // 那种内容已经过时且误导。改为直接显示最新可用时段（收盘 > 午盘 > 早盘）。
    var todayStr = new Date().toLocaleDateString('sv-SE');  // YYYY-MM-DD（本地时区）
    if (D.date && D.date < todayStr) return dailyOk(D.close) || dailyOk(D.noon) || dailyOk(D.morning);
    var now = new Date(), t = now.getHours() * 60 + now.getMinutes();
    if (t >= 900) return dailyOk(D.close) || dailyOk(D.noon) || dailyOk(D.morning);   // 15:00 后看收盘
    if (t >= 690) return dailyOk(D.noon) || dailyOk(D.morning) || dailyOk(D.close);   // 11:30 后看午盘
    return dailyOk(D.morning) || dailyOk(D.noon) || dailyOk(D.close);
  }
  // 数据是否过期（用于标题标注，避免把昨日内容当今日）
  function dailyStale(D) {
    if (!D || !D.date) return false;
    var todayStr = new Date().toLocaleDateString('sv-SE');
    return D.date < todayStr;
  }
  /* 标题按时段命名：只有早上叫「早报」，中午/收盘各有自己的名字。
     过期（昨日）内容统一加「昨日」前缀。 */
  function dailyTitle(D, S) {
    var stale = dailyStale(D) ? '昨日' : '今日';
    if (S === D.morning) return stale + '早报';
    if (S === D.noon) return stale + '午间速览';
    if (S === D.close) return stale + '收盘复盘';
    return stale + '速览';
  }
  /* 盘中快报：10:30 / 14:00 + 事件插播。
     设计约束：不覆盖早报/午评/收盘，只把新增判断前置并用橙色区分；
     旧三档仍在下面完整保留，读者能对照「当时怎么判断 → 现在验证到哪一步」。 */
  function intradayBlocks() {
    var D = (typeof window !== 'undefined') ? window.AB_DAILY : null;
    if (!D || !D.intraday || !D.intraday.length) return '';
    var today = new Date().toLocaleDateString('sv-SE');
    var arr = D.intraday.filter(function (x) { return x && x.date === today; }).slice(-3).reverse();
    if (!arr.length) return '';
    return arr.map(function (x) {
      var stateCls = x.status === '兑现' ? 'ok' : (x.status === '证伪' ? 'bad' : 'wait');
      var h = '<div class="intraday-card">'
        + '<div class="intraday-hd">'
        + '<span class="intraday-tag">' + esc(x.label || '[盘中快报]') + '</span>'
        + '<b>' + esc(x.slot || '') + ' ' + esc(x.name || '盘中快报') + '</b>'
        + '<span class="intraday-status ' + stateCls + '">' + esc(x.status || '待验证') + '</span>'
        + '<span class="cat">' + esc(x.at || '') + (x.model ? ' · ' + esc(x.model) : '') + '</span>'
        + '</div>';
      if (x.change) h += '<div class="intraday-change"><b>状态变更</b>　' + esc(x.change) + '</div>';
      h += '<div class="intraday-cols"><div class="intraday-col">'
        + '<div class="intraday-t">对照结论</div>'
        + ((x.reviews || []).map(function (r) {
            return '<div class="intraday-i"><span class="ist ' + (r.state === '兑现' ? 'ok' : (r.state === '证伪' ? 'bad' : 'wait')) + '">'
              + esc(r.state || '待验证') + '</span><b>' + esc(r.point || '') + '</b>'
              + (r.evidence ? '<div class="iev">' + esc(r.evidence) + '</div>' : '') + '</div>';
          }).join('') || '<div class="intraday-i mut">—</div>')
        + '</div><div class="intraday-col">'
        + '<div class="intraday-t">期间新增事件</div>'
        + ((x.events || []).map(function (e) {
            return '<div class="intraday-i"><b>' + esc(e.t || '') + '</b>'
              + (e.d ? '<div class="iev">' + esc(e.d) + '</div>' : '') + '</div>';
          }).join('') || '<div class="intraday-i mut">—</div>')
        + '</div></div></div>';
      return h;
    }).join('');
  }

  function dailyBriefBlock() {
    var D = (typeof window !== 'undefined') ? window.AB_DAILY : null;
    var S = dailySlot(D);
    if (!S || !S.oneLine) return '';
    var slotName = (S === D.morning) ? '早盘' : (S === D.noon ? '午盘' : (S === D.close ? '收盘' : ''));
    var vcls = S.verdict === '偏积极' ? 'pos' : (S.verdict === '偏消极' ? 'neg' : 'neu');
    /* 收盘档还没写（15:00–15:05 之间）时，这里显示的是午间那一档。
       明说一句，读者才不会以为午间内容就是收盘结论。放单独一行，
       不往标题行里塞——手机上标题行已经有 5 个元素，再挤就会换行错位。 */
    var tNow = (new Date()).getHours() * 60 + (new Date()).getMinutes();
    var pending = (D && D.close && tNow >= 900 && S !== D.close)
      ? ('收盘复盘 15:05 生成，当前显示 ' + esc(S.at || '') + ' 那一档') : '';
    var h = '<div class="daily-card">'
      + '<div class="daily-hd"><b>' + dailyTitle(D, S) + '</b>'
      + '<span class="daily-slot">' + slotName + '</span>'
      + '<span class="cat">' + esc(D.date || '') + ' ' + esc(S.at || '') + '</span>'
      + '<span class="daily-verdict ' + vcls + '">' + esc(S.verdict || '中性') + '</span>'
      + '<span class="daily-toggle" data-daily="toggle">' + (DAILY_OPEN ? '收起 ▴' : '展开 ▾') + '</span></div>'
      + (pending ? '<div class="daily-pending">' + pending + '</div>' : '')
      + '<div class="daily-line">' + esc(S.oneLine) + '</div>';
    if (DAILY_OPEN) {
      /* 多空清单摆在最前面：让「有没有真做权衡」变成看得见的东西，
         而不是只在文字里说一句「综合来看」。空清单或敷衍的清单，一眼就能看出来。 */
      if ((S.bulls || []).length || (S.bears || []).length) {
        h += '<div class="dw-wrap">'
          + '<div class="dw-col dw-bull"><div class="dw-t">利多 · ' + (S.bulls || []).length + ' 条</div>'
          + ((S.bulls || []).map(function (x) { return '<div class="dw-i">+ ' + esc(x) + '</div>'; }).join('') || '<div class="dw-i mut">—</div>')
          + '</div>'
          + '<div class="dw-col dw-bear"><div class="dw-t">利空 · ' + (S.bears || []).length + ' 条</div>'
          + ((S.bears || []).map(function (x) { return '<div class="dw-i">− ' + esc(x) + '</div>'; }).join('') || '<div class="dw-i mut">—</div>')
          + '</div></div>';
        if (S.weigh) h += '<div class="dw-weigh"><b>怎么权衡的</b>　' + esc(S.weigh) + '</div>';
      }
      if ((S.points || []).length) {
        h += '<ul class="daily-points">' + S.points.map(function (x) {
          return '<li>' + esc(x) + '</li>';
        }).join('') + '</ul>';
      }
      if ((S.news || []).length) {
        h += '<div class="daily-sub">新闻速览 · 点标题看完整说明</div>'
          + '<div class="daily-news">' + S.news.map(function (n, i) {
            var c = n.dir === '积极' ? 'up' : (n.dir === '消极' ? 'down' : 'mut');
            var open = !!DAILY_NEWS[i];
            var body = open && n.long ? n.long : n.d;
            return '<div class="dn-item' + (open ? ' open' : '') + '">'
              + '<div class="dn-hd" data-nlong="' + i + '">'
              + '<span class="dn-dir ' + c + '">' + esc(n.dir) + '</span>'
              + '<b>' + esc(n.t) + '</b>'
              + '<span class="dn-lvl">' + esc(n.lvl) + '</span>'
              + '<span class="dn-arrow">' + (open ? '▴' : '▾') + '</span></div>'
              + '<div class="dn-body">' + esc(body) + '</div>'
              + '<div class="dn-sec">影响板块：' + esc(n.sec) + '</div></div>';
          }).join('') + '</div>';
      }
      if (S.watch) h += '<div class="daily-watch"><b>今日盘后关注</b>　' + esc(S.watch) + '</div>';
    }
    var risk = (D && D.risk) || S.risk;
    if (DAILY_OPEN && risk) h += '<div class="daily-risk">' + esc(risk) + '</div>';
    return h + '</div>';
  }

  function changesBlock() {
    var seen = readLS(SEEN_KEY, {}), follows = getFollows(), items = [];
    follows.forEach(function (c) {
      var r = DS.snapshot(c); if (!r) return;
      var o = seen[c]; if (!o || !o.state) return;
      if (o.state !== r.state) items.push({ cls: 'flip', name: r.name, code: c,
        txt: '三态由 <b>' + esc(o.state) + '</b> 切换为 <b>' + esc(r.state) + '</b>' });
      else if (isNum(o.resonance) && o.resonance !== bullCount(r))
        items.push({ cls: '', name: r.name, code: c, txt: '六派共振 ' + o.resonance + '/6 → <b>' + bullCount(r) + '/6</b>' });
      else if (isNum(o.w5) && isNum(r.pct && r.pct.w5) && Math.abs(o.w5 - r.pct.w5) > 4)
        items.push({ cls: 'warn', name: r.name, code: c, txt: '近5日区间 ' + pct(o.w5) + ' → <b>' + pct(r.pct.w5) + '</b>' });
    });
    // 记录本次「看到的」状态，供下次对比
    var next = {};
    follows.forEach(function (c) {
      var r = DS.snapshot(c);
      if (r) next[c] = { state: r.state, resonance: bullCount(r), w5: r.pct && r.pct.w5, date: bjToday() };
    });
    writeLS(SEEN_KEY, next);
    var st = streakInfo();
    var head = '<div class="section-title"><h2>今日变化 · 上次看以来</h2>'
      + '<span class="desc">基于上次打开时记下的状态（Last-Seen 基线）</span>'
      + '<span class="streak">✦ 连续访问 ' + st.n + ' 天</span></div>';
    if (!items.length) {
      return head + '<div class="change-grid"><div class="change-card"><b>暂无状态变化</b><div class="d">'
        + (follows.length ? '你关注的 ' + follows.length + ' 只标的，三态 / 六派 / 近5日与上次一致（快照口径）。'
          : '先点 ☆ 关注几只标的，下次回来这里就会显示变化。') + '</div></div></div>';
    }
    return head + '<div class="change-grid">' + items.slice(0, 9).map(function (x) {
      return '<div class="change-card ' + x.cls + '" data-open="' + esc(x.code) + '" style="cursor:pointer">'
        + '<b>' + esc(x.name) + '</b><div class="d">' + x.txt + '</div></div>';
    }).join('') + '</div>';
  }

  // ---------- RRG 相对轮动 ----------
  var RRG_QUADS = [
    { k: '领先', cls: 'q-leading', desc: '相对强度为正 · 动量向上' },
    { k: '改善', cls: 'q-improving', desc: '相对强度偏弱 · 动量转正' },
    { k: '走弱', cls: 'q-weakening', desc: '相对强度仍强 · 动量转弱' },
    { k: '落后', cls: 'q-lagging', desc: '相对强度与动量均偏弱' }
  ];
  var RRG_SEL = '领先';
  function rrgPoints() {
    return DS.allRecords().filter(function (r) { return r.rrg && isFinite(r.rrg.x) && isFinite(r.rrg.y); });
  }
  function quadOf(r) {
    if (r.quad) return r.quad;
    if (!r || !r.rrg) return '—';
    var x = r.rrg.x, y = r.rrg.y;
    if (x >= 0 && y >= 0) return '领先';
    if (x < 0 && y >= 0) return '改善';
    if (x >= 0 && y < 0) return '走弱';
    return '落后';
  }
  /* ---------- 行业轮动（RRG 的「能用来干嘛」版） ----------
     散点图讲的是「相对位置」，但投资要的是「往哪个方向看」。所以先把 234 个行业按
     成分股 5/20/60 日中位数聚合成一个个「行业点」，用与个股完全相同的 RRG 公式算相对强度/动量
     （同一个基准：全市场中位数），再按象限分三张清单：
       正在抱团 = 领先（强且还在变强）；下一棒 = 改善（弱但转强）；正在退潮 = 走弱/落后。
     每个行业附一只代表股（六派票数最高），点开就能继续看个股，避免只停在行业名上。 */
  function medN(a) {
    if (!a || !a.length) return null;
    var b = a.slice().sort(function (x, y) { return x - y; });
    return b[Math.floor(b.length / 2)];
  }
  function sectorRrg() {
    var groups = {};
    DS.allRecords().forEach(function (r) {
      if (!r.ind || r.kind === 'etf') return;
      var p = r.pct || {};
      if (!isNum(p.w20) || !isNum(p.w60)) return;
      var g = groups[r.ind] || (groups[r.ind] = { name: r.ind, list: [], w5: [], w20: [], w60: [] });
      g.list.push(r);
      if (isNum(p.w5)) g.w5.push(p.w5);
      g.w20.push(p.w20); g.w60.push(p.w60);
    });
    var bm = (RAW().engine || {}).bm || { m20: 0, m60: 0 };
    function rp(w, bw) { return (1 + w / 100) / (1 + bw / 100); }
    return Object.keys(groups).map(function (k) {
      var g = groups[k];
      if (g.list.length < 3) return null;          // 少于 3 只的行业没有代表性
      var m5 = medN(g.w5), m20 = medN(g.w20), m60 = medN(g.w60);
      if (m20 == null || m60 == null) return null;
      var b5 = (bm.m20 + bm.m60) / 2;
      var rs20 = rp(m20, bm.m20), rs60 = rp(m60, bm.m60), rs5 = rp(m5 == null ? m20 : m5, b5);
      var rsS = Math.cbrt(rs20 * rs60 * rs5);
      var x = Math.max(-40, Math.min(40, (rsS - 1) * 100));
      var y = Math.max(-60, Math.min(60, (rs20 / Math.max(rs60, 1e-6) - 1) * 100));
      var quad = x >= 0 && y >= 0 ? '领先' : (x < 0 && y >= 0 ? '改善' : (x >= 0 && y < 0 ? '走弱' : '落后'));
      var launch = g.list.filter(function (r) { return r.state === '启动'; }).length;
      var done = g.list.filter(function (r) { return r.state === '走完'; }).length;
      var rep = g.list.slice().sort(function (a, b) {
        return (bullCount(b) - bullCount(a)) || ((b.pct.w20 || 0) - (a.pct.w20 || 0));
      })[0];
      return {
        name: k, n: g.list.length, x: x, y: y, quad: quad,
        m20: m20, m60: m60, launch: launch, done: done,
        launchPct: launch / g.list.length * 100,
        donePct: done / g.list.length * 100, rep: rep
      };
    }).filter(Boolean);
  }
  function sectorRrgBlockHtml(all) {
    all = all || sectorRrg();
    if (!all.length) return '';
    function withTotal(arr, n) { try { arr.total = n; } catch (e) { } return arr; }
    var holdAll = all.filter(function (o) { return o.quad === '领先'; });
    var nextAll = all.filter(function (o) { return o.quad === '改善'; });
    var fadeAll = all.filter(function (o) { return o.quad === '走弱' || o.quad === '落后'; });
    var hold = withTotal(holdAll.slice().sort(function (a, b) { return (b.x + b.y) - (a.x + a.y); }).slice(0, 10), holdAll.length);
    var next = withTotal(nextAll.slice().sort(function (a, b) { return b.y - a.y; }).slice(0, 10), nextAll.length);
    var fade = withTotal(fadeAll.slice().sort(function (a, b) { return (a.x + a.y) - (b.x + b.y); }).slice(0, 10), fadeAll.length);
    function box(title, sub, arr, cls) {
      return '<div class="rot-card ' + cls + '"><div class="rot-h"><b>' + title + '</b><span class="cat">' + sub + '</span></div>'
        + (arr.length ? arr.map(function (o) {
          return '<div class="rot-row"><div class="rot-n"><b>' + esc(o.name) + '</b>'
            + '<span class="cat">' + o.n + ' 只</span></div>'
            + '<div class="rot-v">' + t('强度') + ' ' + fmt(o.x, 1) + ' · ' + t('动量') + ' ' + fmt(o.y, 1) + '</div>'
            + '<div class="rot-s">启 ' + o.launch + ' / 完 ' + o.done + '（' + fmt(o.launchPct, 0) + '% 启动）</div>'
            + (o.rep ? '<div class="rot-rep" data-open="' + esc(o.rep.code) + '" title="点开看这只代表股">'
              + esc(o.rep.name) + ' <span class="cat">' + bullCount(o.rep) + '/6</span></div>' : '')
            + '<div class="rot-more" data-rotind="' + esc(o.name) + '" data-rotn="' + o.n + '">全部 ' + o.n + ' 只 ›</div>'
            + '</div>';
        }).join('') : '<div class="hint">当前没有落在这个象限的行业</div>')
        + (arr.length > 0 && arr.total > arr.length
          ? '<div class="rot-alln" data-rotall="' + cls + '">共 <b>' + arr.total + '</b> 个 · '
            + '<span style="color:var(--blue-d);cursor:pointer">展开全部 ›</span></div>' : '')
        + '</div>';
    }
    window.__ROT_ALL = { hold: holdAll, next: nextAll, fade: fadeAll };
    var howtoRrg = '<div class="howto"><b>怎么看这三列</b>：'
      + '<span class="k">强度 > 100</span> = 跑赢大盘，<span class="k">动量 > 100</span> = 还在变强。'
      + '两个都大于 100 就是「正在抱团」；强度还在 100 以下、动量先转正，就是「下一棒」；'
      + '两个都掉下来则是「退潮」。</div>';
    return howtoRrg + '<div class="rot-wrap">'
      + '<div class="rot-lead"><b>这个页现在直接回答三件事</b>：钱正在抱团哪些行业、下一棒可能轮到谁、哪些在退潮。'
      + '行业点由该行业成分股的 5/20/60 日涨幅中位数聚合，公式与个股 RRG 完全相同（基准＝全市场中位数），'
      + '所以行业与个股的相对位置可以直接对照。</div>'
      + '<div class="rot-grid">'
      + box('正在抱团', '领先：跑赢且在加速 · 顺势方向', hold, 'hold')
      + box('下一棒候选', '改善：还跑输但动量转正 · 轮动最早一步', next, 'next')
      + box('正在退潮', '走弱 / 落后：强度或动量已掉头', fade, 'fade')
      + '</div></div>';
  }
  /* 三清单每行只放一只代表股，用户想知道「另外那些是什么」——点「全部 N 只」在本行展开成分股，
     按六派票数排序（同票再按当日涨跌），点名字继续打开个股。 */
  function rotExpand(el) {
    var name = el.getAttribute('data-rotind');
    var row = el.parentNode;
    if (!row) return;
    var old = row.querySelector('.rot-all');
    if (old) { row.removeChild(old); el.textContent = '全部 ' + (el.getAttribute('data-rotn') || '') + ' 只 ›'; return; }
    var list = DS.allRecords().filter(function (r) { return r.ind === name; })
      .sort(function (a, b) {
        var d = bullCount(b) - bullCount(a);
        if (d) return d;
        return (dayOf(b) || -999) - (dayOf(a) || -999);
      }).slice(0, 12);
    if (!list.length) return;
    var box = document.createElement('div');
    box.className = 'rot-all';
    box.innerHTML = list.map(function (r) {
      var d = dayOf(r);
      return '<div class="rot-sub" data-open="' + esc(r.code) + '">'
        + '<b>' + esc(r.name) + '</b><span class="cat">' + esc(r.code) + '</span>'
        + '<span title="六派里有几派投了「启动」票（满 6 派）">' + bullCount(r) + '<span class="cat">/6</span></span>'
        + '<span data-q="' + esc(r.code) + '" class="' + (d != null ? signCls(d) : 'mut') + '">'
        + (d != null ? pct(d) : '—') + '</span></div>';
    }).join('') + '<div class="cat" style="margin-top:6px">按六派票数排序 · 最多 12 只 · 点名称打开个股</div>';
    row.appendChild(box);
    hydrateQuotes();          /* 展开的 12 只立即补价，不用逐个点 */
  }
  function viewRrg() {
    var pts = rrgPoints(), cnt = {}, bm = (RAW().market || {}).benchmark || {};
    var sectors = sectorRrg();
    /* 象限卡的数量跟着视图走：行业模式数行业，个股模式数个股，避免「图上 234 个点、卡片写 6074 只」 */
    if (RRG_MODE === 'sector') sectors.forEach(function (o) { cnt[o.quad] = (cnt[o.quad] || 0) + 1; });
    else pts.forEach(function (r) { var q = quadOf(r); cnt[q] = (cnt[q] || 0) + 1; });
    var cards = RRG_QUADS.map(function (q) {
      return '<div class="quad-card ' + q.cls + (RRG_SEL === q.k ? ' sel' : '') + '" data-quad="' + q.k + '">'
        + '<div class="q">' + q.k + '</div><div class="n">' + (cnt[q.k] || 0) + '</div><div class="s">' + q.desc + '</div></div>';
    }).join('');
    var modeBtns = '<div class="rrg-mode">'
      + '<button class="btn' + (RRG_MODE === 'sector' ? ' on' : '') + '" data-rrgmode="sector">行业轮动（' + sectors.length + '）</button>'
      + '<button class="btn' + (RRG_MODE === 'stock' ? ' on' : '') + '" data-rrgmode="stock">个股散点（前 1200 只）</button>'
      + '</div>';
    return '<div class="section-title"><h2>资金往哪儿轮 · RRG 相对轮动</h2><span class="desc">'
      + '先看下面三张清单，再看图；图上的点可以点开</span></div>'
      + sectorRrgBlockHtml(sectors)
      + modeBtns
      + '<div class="rrg-guide">'
      + '<div class="rg-q"><b>这张图回答一个问题</b>：钱正在从哪些板块流出、流向哪些板块。</div>'
      + '<div class="rg-steps">'
      + '<div class="rg-s"><span class="rg-n">1</span><div><b>看横轴（相对强度）</b>：这只票跑赢还是跑输全市场。右边＝跑赢。</div></div>'
      + '<div class="rg-s"><span class="rg-n">2</span><div><b>看纵轴（动量变化）</b>：它是在变强还是变弱。上面＝变强。</div></div>'
      + '<div class="rg-s"><span class="rg-n">3</span><div><b>看它落在哪个象限</b>：右上「领先」＝既强又还在变强，通常是资金正在抱团的方向；右下「走弱」＝强但开始减速；左下「落后」＝最弱；左上「改善」＝弱但开始转强，是<b>轮动最早的一步</b>。</div></div>'
      + '</div>'
      + '<div class="rg-use"><b>怎么用</b>：想找「正在被资金选中」的方向，看<b>领先</b>象限；想找「可能补涨的下一棒」，看<b>改善</b>象限（但需要个股本身的启动/盘整确认，别只看图）。点象限卡片可筛选右侧列表。</div>'
      + '</div>'
      + '<div class="rrg-trail">'
      + '<div class="rt-head"><b>单只标的的轮动轨迹</b><span class="cat">输入代码或名称，看它在四个象限之间怎么走 —— 顺时针是健康的轮动，来回跳说明没有主线</span></div>'
      + '<div class="rt-ctrl">'
      + '<input id="rtCode" type="text" placeholder="代码或名称，如 600519 / 沪深300ETF" autocomplete="off" />'
      + '<select id="rtStep"><option value="5">按周</option><option value="20" selected>按月</option></select>'
      + '<select id="rtCount"><option value="6">近 6 期</option><option value="9">近 9 期</option><option value="12" selected>近 12 期</option></select>'
      + '<button class="btn btn-primary" id="rtGo">生成轨迹</button>'
      + '<span class="cat" id="rtHint"></span>'
      + '</div>'
      + '<div id="rtChart" class="rt-chart"></div>'
      + '</div>'
      + '<div class="rrg-layout"><div class="rrg-chart" id="rrgChart"></div><div>'
      + '<div class="quad-grid">' + cards + '</div><div class="rrg-list" id="rrgList"></div></div></div>'
      + '<div class="rrg-note"><b>口径</b>：横轴 = 相对强度（个股 5/20/60 日表现 ÷ <b>全市场样本中位数</b>同期表现的几何均值 ×100），'
      + '纵轴 = 相对动量的变化；中心 0/0 相当于「跟全市场一样」。'
      + '基准中位数为 20 日 ' + (isNum(bm.m20) ? pct(bm.m20) : '—') + ' / 60 日 ' + (isNum(bm.m60) ? pct(bm.m60) : '—') + '。'
      + '典型轮动为顺时针 <b>领先 → 走弱 → 落后 → 改善 → 领先</b>。'
      + '圆点颜色按<b>三态</b>区分（蓝=启动／灰=盘整／橙=走完），与涨跌无关；大点为强启动。本图为客观相对位置，<b>不构成投资建议</b>。</div>'
      + legendBlock();
  }
  function renderRrgList() {
    var el = $('rrgList'); if (!el) return;
    if (RRG_MODE === 'sector') {
      var sl = sectorRrg().filter(function (o) { return o.quad === RRG_SEL; })
        .sort(function (a, b) { return (b.x + b.y) - (a.x + a.y); }).slice(0, 30);
      el.innerHTML = '<div style="font-size:12px;color:var(--muted);margin-bottom:6px"><b>' + esc(RRG_SEL) + '</b> 象限 · '
        + sl.length + ' 个行业（按强度+动量排序）</div>'
        + (sl.length ? sl.map(function (o) {
          return '<div class="row"><span><b>' + esc(o.name) + '</b> <span class="cat">' + o.n + ' 只 · 启 '
            + o.launch + '/完 ' + o.done + '</span></span><span><span class="cat">' + fmt(o.x, 1) + ' / ' + fmt(o.y, 1)
            + '</span>' + (o.rep ? ' · <span style="color:var(--blue-d);cursor:pointer" data-open="' + esc(o.rep.code) + '">'
            + esc(o.rep.name) + '</span>' : '') + '</span></div>';
        }).join('') : '<div class="ind-empty">该象限暂无行业</div>');
      return;
    }
    var list = rrgPoints().filter(function (r) { return quadOf(r) === RRG_SEL; })
      .sort(function (a, b) { return (b.rrg.x + b.rrg.y) - (a.rrg.x + a.rrg.y); });
    el.innerHTML = '<div style="font-size:12px;color:var(--muted);margin-bottom:6px"><b>' + esc(RRG_SEL) + '</b> 象限 · '
      + list.length + ' 只（按相对强度+动量排序）</div>'
      + (list.length ? list.slice(0, 60).map(function (r) {
        return '<div class="row" data-open="' + esc(r.code) + '"><span>' + stateBlock(r) + ' <b>' + esc(r.name)
          + '</b> <span class="cat">' + esc(r.code) + '</span></span><span><span class="cat">'
          + fmt(r.rrg.x, 1) + ' / ' + fmt(r.rrg.y, 1) + '</span> · ' + bullCount(r) + '/6</span></div>';
      }).join('') : '<div class="ind-empty">该象限暂无标的</div>');
  }
  /* ---------- 单只标的的 RRG 轨迹（第 6 点） ----------
   * 用该标的的真实前复权日K，按周/月切片回放：每一期都用「当时已知的收盘序列」
   * 重算 w5/w20/w60 → 与全市场基准比 → 得到 RS-Ratio / RS-Momentum 坐标。
   * 这样得到的是「当时它落在哪个象限」，而不是用今天的坐标画一条假历史线。 */
  function rtPct(closes) {
    var n = closes.length, last = closes[n - 1];
    function r(b) {
      if (n < b + 1) return null;
      var a = closes[n - 1 - b];
      return a ? (last / a - 1) * 100 : null;
    }
    return { w5: r(5), w20: r(20), w60: r(60), w250: r(250) };
  }
  function rtXY(p, bm) {
    function rp(w, b) { return (1 + (w || 0) / 100) / (1 + (b || 0) / 100); }
    var rs20 = rp(p.w20, bm.m20), rs60 = rp(p.w60, bm.m60), rs5 = rp(p.w5, (bm.m20 + bm.m60) / 2);
    var sm = Math.cbrt(rs20 * rs60 * rs5);
    return {
      x: Math.max(-40, Math.min(40, (sm - 1) * 100)),
      y: Math.max(-60, Math.min(60, (rs20 / Math.max(rs60, 1e-6) - 1) * 100))
    };
  }
  function buildRrgTrail(bars, step, count, bm) {
    var out = [];
    for (var i = count - 1; i >= 0; i--) {
      var end = bars.length - i * step;
      if (end < 70) continue;                  // 至少要有 60 日窗口 + 余量
      var closes = bars.slice(0, end).map(function (b) { return b.c; });
      var p = rtPct(closes), xy = rtXY(p, bm);
      out.push({ date: String(bars[end - 1].d).slice(0, 10), x: xy.x, y: xy.y, w5: p.w5, w20: p.w20 });
    }
    return out;
  }
  var RT_TIMER = null;
  function drawRrgTrail(row, step, count) {
    var el = $('rtChart'); if (!el) return;
    if (typeof echarts === 'undefined') { el.innerHTML = '<div class="ind-empty">图表库未加载</div>'; return; }
    if (RT_TIMER) { clearInterval(RT_TIMER); RT_TIMER = null; }
    var bm = (RAW().engine || {}).bm || { m20: 0, m60: 0 };
    var hint = $('rtHint');
    if (hint) hint.textContent = '正在读取前复权日K…';
    el.innerHTML = '';
    klineFor(row.code).then(function (k) {
      var bars = k && k.bars;
      if (!bars || bars.length < 90) {
        el.innerHTML = '<div class="ind-empty">该标的日K不足（需 90 根以上），无法生成轨迹</div>';
        if (hint) hint.textContent = '';
        return;
      }
      var trail = buildRrgTrail(bars, step, count, bm);
      if (trail.length < 2) {
        el.innerHTML = '<div class="ind-empty">可用期数不足（历史太短）</div>';
        if (hint) hint.textContent = '';
        return;
      }
      if (hint) hint.textContent = esc(row.name) + ' · ' + trail.length + ' 期 · ' + trail[0].date + ' → ' + trail[trail.length - 1].date;
      var last = trail[trail.length - 1];
      var chart = makeChart('rtChart', {
        grid: { left: 52, right: 24, top: 24, bottom: 40 },
        tooltip: {
          trigger: 'item', backgroundColor: '#fff', borderColor: '#e3e8f2',
          textStyle: { color: '#111827', fontSize: 12 },
          formatter: function (o) {
            var d = o.data && o.data.raw; if (!d) return '';
            var q = d.x >= 0 && d.y >= 0 ? '领先' : (d.x < 0 && d.y >= 0 ? '改善' : (d.x >= 0 && d.y < 0 ? '走弱' : '落后'));
            return '<b>' + esc(d.date) + '</b><br/>象限：<b>' + q + '</b><br/>相对强度 ' + fmt(d.x, 1) + ' / 动量 ' + fmt(d.y, 1);
          }
        },
        xAxis: {
          type: 'value', name: '相对强度', nameLocation: 'middle', nameGap: 26,
          min: -25, max: 25, splitLine: { lineStyle: { color: '#eef1f6' } },
          axisLine: { onZero: true, lineStyle: { color: '#c9d2e0' } }
        },
        yAxis: {
          type: 'value', name: '动量', min: -35, max: 35,
          splitLine: { lineStyle: { color: '#eef1f6' } },
          axisLine: { onZero: true, lineStyle: { color: '#c9d2e0' } }
        },
        series: [{
          type: 'line', symbol: 'circle', symbolSize: 7, smooth: false,
          lineStyle: { width: 2, color: '#1d4ed8' },
          itemStyle: { color: '#1d4ed8' },
          label: {
            show: true, position: 'top', fontSize: 10, color: '#64748b',
            formatter: function (o) { return o.data && o.data.raw ? String(o.data.raw.date).slice(5) : ''; }
          },
          data: [],
          markLine: {
            silent: true, symbol: 'none',
            lineStyle: { color: '#c9d2e0', type: 'dashed' },
            data: [{ xAxis: 0 }, { yAxis: 0 }]
          },
          /* 四象限底色 + 名称：让「现在在哪个象限」一眼可读 */
          markArea: {
            silent: true,
            label: { show: true, position: 'insideTopLeft', color: '#94a3b8', fontSize: 11, fontWeight: 'bold' },
            data: [
              [{ xAxis: 0, yAxis: 0, name: '领先 · 强且更强', itemStyle: { color: 'rgba(29,78,216,.07)' } }, { xAxis: 25, yAxis: 35 }],
              [{ xAxis: -25, yAxis: 0, name: '改善 · 弱但转强', itemStyle: { color: 'rgba(22,163,74,.07)' } }, { xAxis: 0, yAxis: 35 }],
              [{ xAxis: 0, yAxis: -35, name: '走弱 · 强但转弱', itemStyle: { color: 'rgba(245,158,11,.08)' } }, { xAxis: 25, yAxis: 0 }],
              [{ xAxis: -25, yAxis: -35, name: '落后 · 弱且更弱', itemStyle: { color: 'rgba(148,163,184,.08)' } }, { xAxis: 0, yAxis: 0 }]
            ]
          }
        }]
      });
      if (!chart) return;
      /* 逐帧「生长」：模拟时间推进，一次多显一个点 */
      var i = 0;
      function frame() {
        i++;
        chart.setOption({
          series: [{
            data: trail.slice(0, i).map(function (p) {
              return { value: [p.x, p.y], raw: p };
            })
          }]
        });
        if (i >= trail.length) {
          if (RT_TIMER) { clearInterval(RT_TIMER); RT_TIMER = null; }
          chart.setOption({
            series: [{
              markPoint: {
                symbolSize: 46, label: { fontSize: 10, color: '#fff' },
                data: [{ coord: [last.x, last.y], value: '现在', itemStyle: { color: '#c0392b' } }]
              }
            }]
          });
        }
      }
      frame();
      RT_TIMER = setInterval(frame, 340);
    });
  }
  function runRrgTrail() {
    var kw = String(($('rtCode') || {}).value || '').trim();
    var step = parseInt((($('rtStep') || {}).value || '20'), 10);
    var count = parseInt((($('rtCount') || {}).value || '12'), 10);
    if (!kw) { var h0 = $('rtHint'); if (h0) h0.textContent = '请先输入代码或名称'; return; }
    var recs = DS.allRecords();
    var hit = recs.filter(function (r) {
      return r.code === kw || String(r.code).indexOf(kw) === 0 ||
        String(r.code).replace(/\.[A-Z]+$/, '') === kw || (r.name || '').indexOf(kw) >= 0;
    })[0];
    if (!hit) {
      var h1 = $('rtHint');
      if (h1) h1.textContent = '没找到「' + kw + '」，试试完整代码（如 600519）或名称关键字';
      return;
    }
    drawRrgTrail(hit, step, count);
  }

  /* 默认画「行业点」（234 个），个股散点作为可切换视图（最多 1200 个，按市值取，
     避免 6000 点把浏览器拖住）。同一个坐标系、同一套公式，行业与个股可以直接对照。 */
  var RRG_MODE = 'sector';
  function rrgChartData() {
    if (RRG_MODE === 'sector') {
      var qc = { '领先': '#1d4ed8', '改善': '#0f9d58', '走弱': '#b45309', '落后': '#98a2b3' };
      return sectorRrg().map(function (o) {
        return {
          x: o.x, y: o.y, name: o.name, quad: o.quad, code: null,
          size: Math.max(9, Math.min(30, 7 + o.n / 5)),
          color: qc[o.quad] || '#98a2b3', showLabel: o.n >= 8,
          tip: '<b>' + esc(o.name) + '</b>（' + o.n + ' 只）<br/>象限：' + esc(o.quad)
            + '<br/>相对强度 ' + fmt(o.x, 1) + ' / 动量 ' + fmt(o.y, 1)
            + '<br/>启动 ' + o.launch + ' 只 · 走完 ' + o.done + ' 只'
            + (o.rep ? '<br/>代表股：' + esc(o.rep.name) + ' ' + bullCount(o.rep) + '/6' : '')
        };
      });
    }
    var colors = { '启动': '#1d4ed8', '盘整': '#98a2b3', '走完': '#b45309' };
    return rrgPoints().slice().sort(function (a, b) { return (b.mcap || 0) - (a.mcap || 0); }).slice(0, 1200)
      .map(function (r) {
        return {
          x: r.rrg.x, y: r.rrg.y, name: r.name, quad: quadOf(r), code: r.code,
          size: r.strong ? 12 : 7, color: colors[r.state] || '#98a2b3', showLabel: !!r.strong,
          tip: '<b>' + esc(r.name) + '</b><br/>三态：' + esc(r.state) + ' · 象限：' + esc(quadOf(r))
            + '<br/>相对强度 ' + fmt(r.rrg.x, 2) + ' / 动量 ' + fmt(r.rrg.y, 2)
            + '<br/>六派 ' + bullCount(r) + '/6'
        };
      });
  }
  function drawRrgChart() {
    var el = $('rrgChart'); if (!el) return;
    if (typeof echarts === 'undefined') { el.innerHTML = '<div class="ind-empty">图表库未加载；右侧象限统计与列表仍可查看。</div>'; return; }
    var data = rrgChartData();
    if (!data.length) { el.innerHTML = '<div class="ind-empty">当前视图没有可画的数据（行业需至少 3 只成分股）</div>'; return; }
    var xs = data.map(function (p) { return p.x; }).sort(function (a, b) { return a - b; });
    var ys = data.map(function (p) { return p.y; }).sort(function (a, b) { return a - b; });
    function q(a, p) { return a[Math.min(a.length - 1, Math.floor(a.length * p))]; }
    var xmin = Math.min(q(xs, .02), -5) - 3, xmax = Math.max(q(xs, .98), 5) + 3;
    var ymin = Math.min(q(ys, .02), -5) - 3, ymax = Math.max(q(ys, .98), 5) + 3;
    var c = makeChart('rrgChart', {
      grid: { left: 58, right: 26, top: 34, bottom: 52 },
      /* 轴名用大白话：横轴"跟大盘比强弱"，纵轴"在变强还是变弱"。
         专业词（RS-Ratio / RS-Momentum）放到页面下方口径里，图上不出现。 */
      graphic: [
        { type: 'text', right: 40, top: 42, silent: true, style: { text: '① 既跑赢大盘、又还在变强\n＝资金正在抱团', fill: 'rgba(29,78,216,.55)', font: '11px sans-serif', textAlign: 'right' } },
        { type: 'text', left: 66, top: 42, silent: true, style: { text: '② 还跑输大盘、但开始变强\n＝下一棒候选', fill: 'rgba(15,157,88,.62)', font: '11px sans-serif' } },
        { type: 'text', right: 40, bottom: 60, silent: true, style: { text: '④ 既跑输、还在变弱\n＝回避', fill: 'rgba(180,83,9,.55)', font: '11px sans-serif', textAlign: 'right' } },
        { type: 'text', left: 66, bottom: 60, silent: true, style: { text: '③ 跑赢但开始变弱\n＝小心退潮', fill: 'rgba(102,112,133,.6)', font: '11px sans-serif' } }
      ],
      tooltip: { trigger: 'item', backgroundColor: '#fff', borderColor: '#e3e8f2', textStyle: { color: '#111827', fontSize: 12 },
        formatter: function (p) { return (p.data && p.data.tip) || ''; } },
      xAxis: { type: 'value', min: xmin, max: xmax, name: '← 输给大盘　　｜　　跑赢大盘 →', nameLocation: 'middle', nameGap: 30,
        nameTextStyle: { color: '#667085', fontSize: 11 }, splitLine: { lineStyle: { color: '#eef1f7' } }, axisLabel: { color: '#98a2b3', formatter: function (v) { return Math.round(v); } } },
      yAxis: { type: 'value', min: ymin, max: ymax, name: '变强 ↑ / 变弱 ↓', nameTextStyle: { color: '#667085', fontSize: 11 },
        splitLine: { lineStyle: { color: '#eef1f7' } }, axisLabel: { color: '#98a2b3', formatter: function (v) { return Math.round(v); } } },
      series: [{
        type: 'scatter',
        data: data.map(function (d) {
          return { value: [d.x, d.y], name: d.name, code: d.code, quad: d.quad, tip: d.tip,
            symbolSize: d.size,
            itemStyle: { color: d.color, opacity: RRG_MODE === 'stock' && !d.code ? .5 : .88, borderColor: '#fff', borderWidth: 1 } };
        }),
        /* 222 个行业点全标名字会叠成一团（还会因 formatter 取值错位冒出零散数字），
           所以平时不标名字：悬停才显示，完整名单在右侧「象限列表」和上面三张清单里。 */
        label: { show: false },
        emphasis: {
          label: { show: true, color: '#111827', fontSize: 11, fontWeight: 'bold',
            formatter: function (p) { return String((p.data && p.data.name) || '').slice(0, 8); } }
        },
        markArea: { silent: true, data: [
          [{ xAxis: 0, yAxis: 0, itemStyle: { color: 'rgba(37,99,235,.055)' } }, { xAxis: xmax, yAxis: ymax }],
          [{ xAxis: xmin, yAxis: 0, itemStyle: { color: 'rgba(124,58,237,.05)' } }, { xAxis: 0, yAxis: ymax }],
          [{ xAxis: 0, yAxis: ymin, itemStyle: { color: 'rgba(233,147,15,.055)' } }, { xAxis: xmax, yAxis: 0 }],
          [{ xAxis: xmin, yAxis: ymin, itemStyle: { color: 'rgba(102,112,133,.05)' } }, { xAxis: 0, yAxis: 0 }]
        ] },
        markLine: { silent: true, symbol: 'none', lineStyle: { color: '#c9cfda', width: 1, type: 'solid' },
          label: { show: false }, data: [{ xAxis: 0 }, { yAxis: 0 }] }
      }]
    });
    if (c && c.on) c.on('click', function (p) { if (p && p.data && p.data.code) navigate('/lens?code=' + encodeURIComponent(p.data.code)); });
  }

  // ---------- 舆情激增雷达 ----------
  var NEWS_SORT = 'count';                 // 基线未就绪时按真实条数排，不拿 null 冒充 0
  var NEWS_L1 = '全部';                     // 一级行业筛选（来自真实 indL1）
  var NEWS_Q = '';
  var NEWS_ONLY_HIT = false;
  var NEWS_TABS = [
    { k: 'count', t: '按资讯条数' }, { k: 'surge', t: '按激增倍数' },
    { k: 'dir', t: '按舆情方向' }, { k: 'media', t: '按媒体数' },
    { k: 'name', t: '按行业名称' }, { k: 'stocks', t: '按成分股数' }
  ];
  function themeRelated(key) {
    return DS.allRecords().filter(function (r) { return Array.isArray(r.themes) && r.themes.indexOf(key) >= 0; })
      .sort(function (a, b) { return bullCount(b) - bullCount(a); }).slice(0, 6);
  }
  function newsCard(t) {
    var surge = isNum(t.surge) ? t.surge : 0, eff = isNum(t.eff) ? t.eff : surge;
    var hot = eff >= 1.2, dir = isNum(t.dir) ? t.dir : 0;
    var dirTxt = dir > 0.2 ? '偏正面' : (dir < -0.2 ? '偏谨慎' : '中性/分歧');
    var baseNote = t.baselineStatus && t.baselineStatus !== 'ready' ? t.baselineStatus : '';
    var links = (Array.isArray(t.top) ? t.top.slice(0, 3) : []).map(function (n) {
      var u = safeUrl(n.u);
      return u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(n.d || '') + ' · ' + esc(n.t || '') + '</a>'
        : '<span class="cat">' + esc(n.t || '') + '</span>';
    }).join('');
    var rel = themeRelated(t.key);
    return '<div class="news-card"><div class="nh"><div><h3>' + esc(t.name || t.key) + '</h3>'
      + '<div class="kw">' + (t.l1 ? esc(t.l1) + ' / ' : '') + (t.l2 && t.l2 !== t.name ? esc(t.l2) + ' · ' : '')
      + (isNum(t.stocks) ? t.stocks + ' 只成分股 · ' : '') + '命中词：' + esc(String(t.kw || '—').slice(0, 56)) + '</div></div>'
      + '<div class="news-badge' + (hot ? '' : ' calm') + '">' + (isNum(t.surge) ? fmt(t.surge, 1) + '×' : ((t.n1 || 0) + '条')) + '</div></div>'
      + '<div class="news-metrics">'
      + '<span>当日 <b>' + (isNum(t.n1) ? t.n1 : '—') + '</b> 条</span>'
      + '<span>媒体 <b>' + (isNum(t.mediaN) ? t.mediaN : (isNum(t.n7) ? t.n7 : '—')) + '</b> 家</span>'
      + '<span>激增 <b>' + (isNum(t.surge) ? fmt(surge, 2) + '×' : (baseNote ? '积累中' : '—')) + '</b></span>'
      + '<span>极性 <b class="' + (dir > 0.2 ? 'dir-up' : (dir < -0.2 ? 'dir-down' : '')) + '">' + (isNum(t.score) ? (t.score > 0 ? '+' : '') + fmt(t.score, 2) : '—') + '</b></span>'
      + '<span>方向 <b class="' + (dir > 0.2 ? 'dir-up' : (dir < -0.2 ? 'dir-down' : '')) + '">' + dirTxt + '</b></span>'
      + (isNum(t.h24max) ? '<span>24h 热度峰值 <b>' + fmt(t.h24max, 1) + '</b></span>' : '')
      + (t.flag ? '<span>标记 <b>' + esc(t.flag) + '</b></span>' : '')
      + '</div>'
      + (t.read ? '<div class="news-read">' + esc(String(t.read).slice(0, 260)) + '</div>' : '')
      + (links ? '<div class="news-links"><div class="lb">代表资讯（快照留存 · 点击打开原文）</div>' + links + '</div>' : '')
      + (rel.length ? '<div class="news-related"><span class="lb">关联标的</span>' + rel.map(function (r) {
        return '<span class="tag mid" data-open="' + esc(r.code) + '">' + esc(r.name) + '</span>';
      }).join('') + '</div>' : '')
      + '</div>';
  }
  /* 资讯雷达：当前数据源没有新闻，绝不编造。空时给出诚实说明 + 用真实行情算的「量价异动」替代。 */
  function viewNewsEmpty(m) {
    var recs = DS.allRecords().filter(function (r) { return r.pct && isNum(r.pct.w5); });
    function top(desc) {
      return recs.slice().sort(function (a, b) { return desc ? b.pct.w5 - a.pct.w5 : a.pct.w5 - b.pct.w5; }).slice(0, 8);
    }
    function rows(list) {
      return list.map(function (r) {
        return '<div class="row" data-open="' + esc(r.code) + '"><span>' + stateBlock(r)
          + ' <b>' + esc(r.name) + '</b> <span class="cat">' + esc(r.code) + '</span></span>'
          + '<span><b class="' + signCls(r.pct.w5) + '">' + pct(r.pct.w5) + '</b> <span class="cat">近5日 · '
          + bullCount(r) + '/6</span></span></div>';
      }).join('');
    }
    return '<div class="section-title"><h2>资讯雷达</h2><span class="desc">当前数据源未接入新闻 · 下方为真实行情算出的量价异动</span></div>'
      + '<div class="empty-card"><h3>为什么这里是空的</h3>'
      + '这个页面原本用来盯「资讯密度突然放大」的标的（同一主题的新闻数量短时间内激增）。'
      + '本站在用的腾讯 / 新浪免费行情接口<b>只提供价格与成交，不提供新闻正文</b>，'
      + '所以雷达没有数据可算。<br/>按「不编数据」的原则，这里不会用随机数或旧数据把版面填满。'
      + '<ul><li>如果你只关心<b>价格在动</b>：看下面的「量价异动」，它完全由真实行情算出。</li>'
      + '<li>如果你确实要新闻驱动：需要接入带新闻的付费/授权数据源，构建时用 <code>--fund</code> 以外的新闻接口补齐。</li></ul></div>'
      + '<div class="grid cols-2" style="margin-top:14px">'
      + '<div class="card"><h3>近 5 日最强势 <span class="cat">全市场 · 按 5 日涨幅</span></h3>' + rows(top(true)) + '</div>'
      + '<div class="card"><h3>近 5 日最弱势 <span class="cat">全市场 · 按 5 日跌幅</span></h3>' + rows(top(false)) + '</div>'
      + '</div>'
      + '<div class="rrg-note"><b>口径</b>：近 5 日涨幅 = 前复权收盘价相对 5 个交易日前的变化，<b>不含当日</b>；'
      + '「启动/盘整/走完」是阶段判断，与涨跌无必然关系。<b>不构成投资建议</b>。</div>'
      + legendBlock();
  }
  /* ---------- 资讯雷达（单只标的）----------
   * 逻辑（开源项目里的通用做法，akshare/stock_news_em 一类）：
   *   1) 按「代码 / 名称」搜全网财经资讯，拿带时间戳的条目；
   *   2) 用近 24h 条数 ÷ 前 7 日日均（基线）得到「激增倍数」；
   *   3) 标题近乎重复的算噪声，做折扣（同一件事被十家转载不算十条）；
   *   4) 用来源媒体数做交叉验证（只有一个来源的暴增更可能是通稿）；
   *   5) 关键词极性给方向（增持/中标/涨价 为正，减持/立案/亏损 为负）。
   * 这套口径与页面「舆情激增怎么算」的说明完全一致，不是另造指标。
   */
  var NEWS_KW = '';   // 舆情雷达自己的搜索词：不能和 ACTIVE_CODE 混用，
                      // 否则页面每 60 秒重渲染一次就会把输入框换成"上次打开的标的"（看起来像自动跳转）
  var NEWS_POS = ['增持', '回购', '中标', '签约', '涨价', '提价', '超预期', '扭亏', '预增', '新高', '突破', '获批', '订单', '扩产', '分红', '重组', '收购', '利好'];
  var NEWS_NEG = ['减持', '立案', '处罚', '亏损', '预亏', '下调', '退市', '违规', '诉讼', '冻结', '质押', '终止', '问询', '商誉', '跌停', '风险提示', '爆仓'];
  function newsPolarity(title) {
    var p = 0, n = 0;
    NEWS_POS.forEach(function (k) { if (title.indexOf(k) >= 0) p++; });
    NEWS_NEG.forEach(function (k) { if (title.indexOf(k) >= 0) n++; });
    return { p: p, n: n, dir: p > n ? 1 : (n > p ? -1 : 0) };
  }
  function normTitle(t) {
    return String(t || '').replace(/[\s\p{P}]/gu, '').slice(0, 16);
  }
  function newsMetrics(items) {
    var nowMs = Date.now(), H = 3600000, D = 86400000;
    function ts(x) { var t = Date.parse(String(x.date).replace(/-/g, '/')); return isNaN(t) ? null : t; }
    var rows = items.map(function (x) { var t = ts(x); return t == null ? null : { t: t, x: x }; }).filter(Boolean)
      .sort(function (a, b) { return b.t - a.t; });
    if (!rows.length) return null;
    // 以「最新一条资讯的时间」为基准日，避免服务端时间与时区带来的偏差
    var latest = rows[0].t;
    function cnt(fromMs, toMs) {
      return rows.filter(function (r) { return r.t > fromMs && r.t <= toMs; }).length;
    }
    var n1 = cnt(latest - D, latest + H);
    var n7 = cnt(latest - 7 * D, latest + H);
    var n30 = cnt(latest - 30 * D, latest + H);
    var baseline = n7 > n1 ? (n7 - n1) / 6 : 0.5;
    var surge = n1 / Math.max(baseline, 0.5);
    var day1 = rows.filter(function (r) { return r.t > latest - D; });
    var uniq = {}, dup = 0;
    day1.forEach(function (r) {
      var k = normTitle(r.x.title);
      if (uniq[k]) dup++; else uniq[k] = 1;
    });
    var medias = {};
    rows.filter(function (r) { return r.t > latest - 7 * D; }).forEach(function (r) { if (r.x.media) medias[r.x.media] = 1; });
    var pol = day1.reduce(function (a, r) {
      var q = newsPolarity(r.x.title); a.p += q.p; a.n += q.n; return a;
    }, { p: 0, n: 0 });
    var dir = pol.p > pol.n ? 1 : (pol.n > pol.p ? -1 : 0);
    var noiseFactor = 1 / (1 + 0.4 * dup);
    return {
      rows: rows, latest: latest, n1: n1, n7: n7, n30: n30,
      baseline: baseline, surge: surge, dup: dup, uniqN: Object.keys(uniq).length,
      mediaN: Object.keys(medias).length, dir: dir, p: pol.p, n: pol.n,
      eff: surge * noiseFactor * (dir === 0 ? 1 : dir),
      noiseFactor: noiseFactor, total: items.length
    };
  }
  function newsVerdict(mt, r) {
    if (!mt) return '';
    var s = mt.surge, bits = [];
    if (s >= 3) bits.push('<b>资讯密度异常放大</b>（' + fmt(s, 1) + '× 于前期日均）');
    else if (s >= 1.5) bits.push('资讯密度<b>温和上升</b>（' + fmt(s, 1) + '×）');
    else bits.push('资讯密度<b>低于/接近前期日均</b>（' + fmt(s, 1) + '×），没有明显异动');
    bits.push('去重后 24h 内实际 ' + mt.uniqN + ' 条（重复转载 ' + mt.dup + ' 条，已降权）');
    bits.push('涉及 ' + mt.mediaN + ' 家媒体');
    if (mt.dir === 1) bits.push('标题以<b>偏正面</b>措辞为主（' + mt.p + ' 正 / ' + mt.n + ' 负）');
    else if (mt.dir === -1) bits.push('标题以<b>偏负面</b>措辞为主（' + mt.p + ' 正 / ' + mt.n + ' 负）');
    else bits.push('正负措辞相当，方向不明');
    var tail = '';
    if (mt.mediaN <= 1 && s >= 2) tail = ' <b>但来源单一</b>，需警惕通稿式放量。';
    else if (s >= 3 && mt.dir === 1) tail = ' 属可观察的「信息驱动」状态，是否可持续要看后续几天是否维持。';
    else if (s >= 3 && mt.dir === -1) tail = ' 负面信息集中出现，需核对公告原文再判断。';
    return bits.join('；') + '.' + tail;
  }
  function newsRowHtml(x) {
    return '<div class="nr-row"><span class="nr-t">' + esc(String(x.date).slice(5, 16)) + '</span>'
      + '<span class="nr-x"><a href="' + esc(x.url || '#') + '" target="_blank" rel="noopener">' + esc(x.title) + '</a>'
      + '<span class="cat">' + esc(x.media || '—') + '</span></span></div>';
  }
  /* 7 日逐日条数柱状（这就是「搜索/曝光趋势」的可视化，不需要微信指数） */
  function newsTrendHtml(mt) {
    var D = 86400000, days = [], i;
    for (i = 6; i >= 0; i--) {
      var to = mt.latest - i * D, from = to - D;
      var n = mt.rows.filter(function (r) { return r.t > from && r.t <= to; }).length;
      days.push({ n: n, d: new Date(to) });
    }
    var max = Math.max.apply(null, days.map(function (x) { return x.n; })) || 1;
    var bars = days.map(function (x) {
      var h = Math.max(3, Math.round(x.n / max * 100));
      var lab = (x.d.getMonth() + 1) + '/' + x.d.getDate();
      return '<div class="nt-col" title="' + lab + '：' + x.n + ' 条"><div class="nt-b" style="height:' + h + '%"></div>'
        + '<div class="nt-n">' + x.n + '</div><div class="nt-d">' + lab + '</div></div>';
    }).join('');
    return '<div class="nt-wrap"><div class="nt-h">近 7 日每日资讯条数</div><div class="nt-bars">' + bars + '</div></div>';
  }
  /* 市场热度（同花顺热榜）：小时榜 / 日榜 + 升温速度 */
  function hotBlockHtml(hot, code) {
    var bare = String(code || '').replace(/\.[A-Z]+$/, '');
    var o = hot && hot[bare];
    if (!hot || !hot._size || (!hot._size.hour && !hot._size.day)) {
      return '<div class="hot-card"><div class="ds-h">市场热度 <span class="cat">热榜接口暂不可用</span></div>'
        + '<div class="hint">同花顺热榜当前取不到（可能接口变动或网络受限），本项留空，不做估算。</div></div>';
    }
    if (!o) {
      return '<div class="hot-card"><div class="ds-h">市场热度 <span class="cat">同花顺热榜</span></div>'
        + '<div class="hint">该标的<b>当前未进入全市场热度前 100</b>（小时榜与日榜都没有）。'
        + '这本身是个信息：既没有媒体放量，也没有散户追捧——多数时候属于「没人讨论」。</div></div>';
    }
    var h = o.hour || null, d = o.day || null;
    var heat = h && d ? (d.rank - h.rank) : null;   // >0 表示小时榜排名更靠前 = 短期升温
    function cell(k, v, s, cls) { return '<div class="cs"><div class="k">' + k + '</div><div class="v ' + (cls || '') + '">' + v + '</div><div class="s">' + s + '</div></div>'; }
    var tags = ((h || d || {}).tags || []).slice(0, 4).map(function (t) { return '<span class="chip-s">' + esc(t) + '</span>'; }).join('');
    var reason = (h || d || {}).reason || '';
    var pop = (h || d || {}).popular || '';
    return '<div class="hot-card"><div class="ds-h">市场热度 <span class="cat">同花顺热榜 · 搜索/浏览热度排名（含 CORS，浏览器直连）</span></div>'
      + '<div class="cyq-kpi">'
      + cell('小时榜', h ? '第 ' + h.rank : '未上榜', h ? '热度值 ' + fmt(h.rate, 0) : '全市场前 100 之外', h && h.rank <= 20 ? 'up' : '')
      + cell('日榜', d ? '第 ' + d.rank : '未上榜', d ? '热度值 ' + fmt(d.rate, 0) : '全市场前 100 之外')
      + cell('升温速度', heat == null ? '—' : (heat > 0 ? '↑ ' + heat + ' 位' : (heat < 0 ? '↓ ' + (-heat) + ' 位' : '持平')),
        '小时榜相比日榜的排名变化', heat != null && heat > 0 ? 'up' : (heat != null && heat < 0 ? 'down' : ''))
      + cell('当日涨跌', (h || d).rise != null ? pct((h || d).rise) : '—', (h || d).name || '')
      + '</div>'
      + (reason || tags || pop ? '<div class="hot-reason">'
        + (reason ? '<b>上榜原因：</b>' + esc(reason) : '')
        + (pop ? ' <span class="chip-s">' + esc(pop) + '</span>' : '')
        + (tags ? ' <span class="cat">概念：</span>' + tags : '')
        + '</div>' : '')
      + '</div>';
  }
  /* ---------- 舆情极性：一句话给出「利好 / 利空」 ----------
   * 借鉴 BettaFish（微舆）的结论层设计：它用微调模型（BERT/GPT-2/Qwen LoRA）做情感，
   * 我们浏览器里没有模型，但可以把词典法最容易翻车的三处补上，效果接近：
   *   ① 否定词：「不及预期」「未减持」——命中词前 4 字内有否定词就翻转；
   *   ② 程度副词：「大幅超预期」×1.5，「略增」×0.6；
   *   ③ 主体归属：标题/摘要里没出现公司名或代码的，权重砍半（避免"别人家减持"算到它头上）；
   * 再加时间衰减（越新权重越高），最后归一成 -1 ~ +1 的净倾向。
   */
  var NEWS_NEGATORS = ['不', '未', '没', '无', '难', '否认', '辟谣', '取消', '终止'];
  var NEWS_DEG_UP = ['大幅', '显著', '明显', '暴涨', '暴增', '激增', '创', '超预期', '翻倍'];
  var NEWS_DEG_DN = ['略', '微', '小幅', '轻微', '或将'];
  function polarityOf(items, name, code) {
    var pos = 0, neg = 0, posN = 0, negN = 0, evidence = [];
    var nowMs = Date.now();
    function weightOf(dateStr) {
      var t = Date.parse(String(dateStr).replace(/-/g, '/'));
      if (isNaN(t)) return 0;
      var age = (nowMs - t) / 86400000;
      return age <= 1 ? 1 : (age <= 3 ? 0.8 : (age <= 7 ? 0.6 : 0.3));
    }
    function scan(txt, words, sign) {
      var acc = 0;
      words.forEach(function (k) {
        var i = txt.indexOf(k);
        while (i >= 0) {
          var pre = txt.slice(Math.max(0, i - 4), i);
          var flip = NEWS_NEGATORS.some(function (n) { return pre.indexOf(n) >= 0; });
          var deg = NEWS_DEG_UP.some(function (d) { return pre.indexOf(d) >= 0; }) ? 1.5
            : (NEWS_DEG_DN.some(function (d) { return pre.indexOf(d) >= 0; }) ? 0.6 : 1);
          acc += (flip ? -1 : 1) * deg * sign;
          i = txt.indexOf(k, i + 1);
        }
      });
      return acc;
    }
    (items || []).forEach(function (x) {
      var w = weightOf(x.date);
      if (!w) return;
      var txt = String(x.title || '') + ' ' + String(x.summary || '');
      var subject = (name && txt.indexOf(name) >= 0) || (code && txt.indexOf(code) >= 0);
      if (!subject) w *= 0.5;
      var sc = scan(txt, NEWS_POS, 1) + scan(txt, NEWS_NEG, -1);
      if (sc > 0) { pos += sc * w; posN++; }
      else if (sc < 0) { neg += -sc * w; negN++; }
      if (Math.abs(sc) >= 1) evidence.push({ t: sc > 0 ? 1 : -1, w: Math.abs(sc) * w, x: x });
    });
    var total = pos + neg;
    var net = total > 0 ? (pos - neg) / total : 0;
    evidence.sort(function (a, b) { return b.w - a.w; });
    return {
      pos: pos, neg: neg, posN: posN, negN: negN, net: net,
      top: evidence.slice(0, 4),
      level: net >= 0.35 ? '明确利好' : (net >= 0.15 ? '偏利好' : (net > -0.15 ? '中性' : (net > -0.35 ? '偏利空' : '明确利空')))
    };
  }
  var RADAR_INDEX = { '上证指数': '000001.SH', '深证成指': '399001.SZ', '创业板指': '399006.SZ', '科创50': '000688.SH' };
  /* 舆情 × 三态 × 价格 的三方核对
   * 为什么需要它：单看"消息说了什么"很容易被一篇通稿带偏；
   * 但「消息有没有放量」「走势处在哪个阶段」「价格有没有认」三件事同时摆出来，
   * 互相印证或互相打脸，结论的可信度就完全不同。这是本项目对舆情的核心判断逻辑。 */
  function crossSignal(mt, pol, r) {
    if (!mt) return null;
    var surge = mt.surge >= 1.5, quiet = mt.surge < 1.2;
    var dir = pol ? pol.net : 0;
    var state = r && r.state ? r.state : null;
    var q = r ? (QUOTES[r.code] || null) : null;
    var day = (q && isNum(q.chg)) ? q.chg : (r && isNum(r.chg) ? r.chg : null);
    var w5 = (r && r.pct && isNum(r.pct.w5)) ? r.pct.w5 : null;
    var trend = day != null ? day : w5;
    var trendTxt = trend == null ? '—' : ((trend >= 0 ? '+' : '') + fmt(trend, 2) + '%' + (day != null ? '（今日）' : '（近5日）'));
    var expTxt = '激增 ' + fmt(mt.surge, 1) + '× · ' + mt.mediaN + ' 家媒体';
    var polTxt = pol ? (pol.level + '（' + (dir >= 0 ? '+' : '') + fmt(dir, 2) + '）') : '—';
    var res;
    if (quiet) {
      res = { lvl: '无消息驱动', cls: 'mid',
        why: '资讯密度没有放大（' + fmt(mt.surge, 1) + '×），这一票没有增量信息，此时应<b>以三态与价格为准</b>，不要用舆情做理由。' };
    } else if (surge && dir >= 0.15 && state === '启动' && trend != null && trend > 0) {
      res = { lvl: '互相印证 · 偏多', cls: 'good',
        why: '消息放量、措辞偏正面，同时走势刚进入「启动」且价格在涨 —— 三条证据同向，这类组合的可信度最高（但要防高位追）。' };
    } else if (surge && dir <= -0.15 && state === '走完' && trend != null && trend < 0) {
      res = { lvl: '危险信号', cls: 'bad',
        why: '负面消息集中出现，走势已在「走完」阶段，价格同时在跌 —— 这是最需要警惕的三重共振，先看公告原文再决定。' };
    } else if (surge && dir >= 0.15 && (state === '走完' || (trend != null && trend < 0))) {
      res = { lvl: '利好拉不动 · 存疑', cls: 'mid',
        why: '消息偏正面，但' + (r && r.kind === 'index' ? '指数' : '股价') + '不认（或仍在「走完」阶段）—— 常见于利好兑现、出货或消息本身不够硬，<b>不要只看标题做多</b>。' };
    } else if (surge && dir <= -0.15 && state !== '走完') {
      res = { lvl: '负面扩散 · 观察', cls: 'mid',
        why: '坏消息在扩散，但走势还没走坏 —— 属于「先有雷声」阶段，看后续几天价格是否跟着破位。' };
    } else if (surge && state === '启动' && trend != null && trend < 0) {
      res = { lvl: '启动遇回落 · 观察', cls: 'mid',
        why: '三态刚转「启动」，但当日或近 5 日在跌 —— 可能是一次洗盘，也可能启动失败，看能否重新站上均线。' };
    } else if (surge) {
      res = { lvl: '有热度 · 方向不清', cls: 'mid',
        why: '资讯确实放量，但措辞正负相当，属于事件性讨论；这种时候<b>看价格比看观点可靠</b>。' };
    } else {
      res = { lvl: '温和 · 无共振', cls: 'mid',
        why: '关注度小幅上升，未与走势形成共振，暂不构成独立理由。' };
    }
    return {
      lvl: res.lvl, cls: res.cls, why: res.why,
      rows: [
        ['舆情', expTxt + ' · ' + polTxt],
        ['走势', (state || '—') + (r && r.stateDays != null ? '（已 ' + (r.stateCapped ? '≥' : '') + r.stateDays + ' 个交易日）' : '') + ' · ' + trendTxt],
        ['结论', res.lvl]
      ]
    };
  }
  function crossSignalHtml(mt, pol, r) {
    var c = crossSignal(mt, pol, r);
    if (!c) return '';
    var rows = c.rows.map(function (x, i) {
      return '<div class="xr"><span class="xk">' + x[0] + '</span><span class="xv">' + esc(x[1]) + '</span></div>';
    }).join('');
    /* 看完这三行还想深究，必须能一键过去 —— 以前只能自己跑到「前世今生」再搜一遍代码，
       链路多两步，很多人到这就断了。这里直接给出两个入口。 */
    var code = (r && r.code) || '';
    var jump = code ? '<div class="xc-jump">'
      + '<a class="btn btn-primary" href="#/history?code=' + encodeURIComponent(code) + '" style="font-size:12px;padding:6px 12px">打开前世今生 ›</a>'
      + '<button class="btn" data-sttime="' + esc(code) + '" style="font-size:12px;padding:6px 12px">六派依据</button>'
      + '<a class="btn" href="#/lens?code=' + encodeURIComponent(code) + '" style="font-size:12px;padding:6px 12px">侧栏透镜</a>'
      + '</div>' : '';
    return '<div class="xcheck ' + c.cls + '">'
      + '<div class="xc-h"><b>舆情 × 三态 × 价格 三方核对</b><span class="xc-lvl">' + esc(c.lvl) + '</span></div>'
      + '<div class="xc-rows">' + rows + '</div>'
      + '<div class="xc-why">' + c.why + '</div>' + jump + '</div>';
  }

  /* 一句话总结：把「热度增长」和「方向」合成投资含义 —— 这是用户真正要的那句话 */
  function stanceOneLiner(mt, pol, hot, code) {
    if (!mt || !pol) return '';
    var isIdx = !!(DS.isIndexCode && DS.isIndexCode(code));
    var bare = String(code || '').replace(/\.[A-Z]+$/, '');
    var o = hot && hot[bare];
    var heatUp = !!(o && o.hour && o.day && (o.day.rank - o.hour.rank) > 10) || !!(o && o.hour && o.hour.rank <= 30);
    var surge = mt.surge >= 1.5;
    var dir = pol.net;
    var tone, cls;
    if (surge && dir >= 0.15) { tone = '关注度上升 + 措辞偏正面 → <b>偏利好</b>，属于「有资金愿意讲故事」的状态'; cls = 'good'; }
    else if (surge && dir <= -0.15) { tone = '关注度上升 + 措辞偏负面 → <b>偏利空</b>，坏消息正在扩散，先看公告原文再动手'; cls = 'bad'; }
    else if (surge) { tone = '关注度上升但方向不明 → <b>中性偏观察</b>，多为事件性讨论而非趋势'; cls = 'mid'; }
    else if (dir >= 0.15) { tone = '没有放量、但存量措辞偏正面 → <b>温和偏多</b>，属「没人吵但也不差」'; cls = 'good'; }
    else if (dir <= -0.15) { tone = '没有放量、存量措辞偏负面 → <b>温和偏空</b>，注意慢性利空'; cls = 'bad'; }
    else { tone = '既没放量也没明显倾向 → <b>无信号</b>，舆情层面不构成买卖理由'; cls = 'mid'; }
    if (heatUp && dir <= -0.15) tone += '；且热度排名在抬升，负面扩散速度需要盯';
    if (isIdx) tone = tone.replace('属于「有资金愿意讲故事」的状态', '但命中的多是个股 / 板块标题，<b>不代表指数整体</b>');
    return '<div class="stance ' + cls + '"><span class="st-q">一句话</span><b>' + pol.level + '</b>（净倾向 '
      + (dir >= 0 ? '+' : '') + fmt(dir, 2) + '）：' + tone
      + '<div class="st-evi">正面 ' + pol.posN + ' 条 / 负面 ' + pol.negN + ' 条'
      + (pol.top.length ? ' · 关键标题：' + pol.top.slice(0, 2).map(function (e) {
        return '<span class="' + (e.t > 0 ? 'up' : 'down') + '">' + esc(String(e.x.title).slice(0, 26)) + '…</span>';
      }).join(' ') : '')
      + '</div></div>';
  }

  /* 舆情强度：把「媒体曝光」与「市场热度」两个维度合成一句话结论 */
  function radarVerdictHtml(mt, hot, code) {
    var bare = String(code || '').replace(/\.[A-Z]+$/, '');
    var o = hot && hot[bare];
    var score = 0, why = [];
    if (mt.surge >= 3) { score += 2; why.push('资讯密度 ' + fmt(mt.surge, 1) + '× 于前期日均'); }
    else if (mt.surge >= 1.5) { score += 1; why.push('资讯密度温和上升 ' + fmt(mt.surge, 1) + '×'); }
    else why.push('资讯密度没有异动（' + fmt(mt.surge, 1) + '×）');
    if (mt.mediaN >= 5) { score += 1; why.push(mt.mediaN + ' 家媒体覆盖'); }
    if (o && o.hour) { score += (o.hour.rank <= 20 ? 2 : 1); why.push('热度小时榜第 ' + o.hour.rank); }
    else if (o && o.day) { score += 1; why.push('登上日榜第 ' + o.day.rank); }
    else why.push('未进入热榜');
    if (o && o.hour && o.day && o.day.rank - o.hour.rank > 10) { score += 1; why.push('正在升温'); }
    var lvl, cls;
    if (score >= 5) { lvl = '强'; cls = 'bad'; }
    else if (score >= 3) { lvl = '中'; cls = 'mid'; }
    else if (score >= 1) { lvl = '弱'; cls = 'mid'; }
    else { lvl = '无'; cls = 'good'; }
    var tone = lvl === '无' ? '既没有媒体放量，也没有热度排名，说明<b>当前没有资金/舆论层面的异动</b>。'
      : (lvl === '强' ? '这是典型「信息驱动」状态，值得去读原文核实，而不是只看热度。'
        : '有一定关注度，但还不到「人人都在说」的程度，适合放进观察名单。');
    return '<div class="radar-verdict"><b>舆情强度：' + lvl + '</b>（' + score + '/6 分）—— ' + why.join('；') + '。' + tone + '</div>';
  }
  function renderNewsRadar() {
    var el = $('newsBody'); if (!el) return;
    var kw = String(($('newsKw') || {}).value || '').trim();
    NEWS_KW = kw;                       // 记住用户自己的输入
    if (!kw) { el.innerHTML = '<div class="hint">输入代码或名称后点「检测」。</div>'; return; }
    var recs = DS.allRecords();
    /* 匹配顺序：指数/全码精确 → 个股与 ETF。
       以前先做「名称包含」匹配，输入"上证指数"会先命中名称里带这四个字的
       "上证指数ETF国泰(510210)"，指数本身反而被挤掉，舆情与三方核对全用了那只 ETF。 */
    var kwT = String(kw).trim();
    var idxCode = RADAR_INDEX[kwT] || (/^\d{6}\.(SH|SZ)$/i.test(kwT) ? kwT.toUpperCase() : null);
    var idxRow = idxCode ? DS.snapshot(idxCode) : null;
    if (!idxRow) {
      var p = (RAW().indexStates || []).filter(function (x) { return String(x.name).indexOf(kwT) >= 0; })[0];
      if (p) idxRow = DS.snapshot(p.code);
    }
    var hit = idxRow ? null : recs.filter(function (r) {
      var bare = String(r.code).replace(/\.[A-Z]+$/, '');
      return bare === kw || String(r.code) === kw || (r.name || '') === kw;
    })[0];
    if (!hit && !idxRow) {
      /* 名称包含匹配兜底：优先「名称更短」的，避免 ETF 把个股/指数挤掉 */
      var cands = recs.filter(function (r) { return (r.name || '').indexOf(kw) >= 0; });
      cands.sort(function (a, b) { return String(a.name).length - String(b.name).length; });
      hit = cands[0] || null;
    }
    var row = idxRow || hit;
    var keyName = row ? (row.name || kw) : kw;
    el.innerHTML = '<div class="hint">正在同时拉「全网资讯」与「市场热榜」：' + esc(keyName) + '…</div>';
    Promise.all([
      DS.getNews(keyName, 60).catch(function () { return null; }),
      (DS.getHotList ? DS.getHotList() : Promise.resolve(null)).catch(function () { return null; })
    ]).then(function (res) {
      var news = res[0], hot = res[1];
      var mt = news && news.list ? newsMetrics(news.list) : null;
      var hotHtml = (row && row.kind === 'index')
        ? '<div class="hot-card"><div class="ds-h">市场热度 <span class="cat">同花顺热榜只排个股</span></div>'
          + '<div class="hint">指数不在个股热榜里。大盘的"热度"用三态与成交额看更准，见下方三方核对里的「走势」。</div></div>'
        : hotBlockHtml(hot, hit ? hit.code : kw);
      if (!mt) {
        el.innerHTML = '<div class="radar-head"><b>' + esc(keyName) + '</b></div>'
          + '<div class="empty-card"><h3>资讯接口没有返回条目</h3>'
          + '可能原因：关键词太具体、接口临时限流、或该标的近期确实没有任何报道。'
          + '下方「市场热度」仍然有效，可先用它判断是否有人在讨论。</div>'
          + hotHtml
          + '<div class="rrg-note">资讯与热度是两套独立数据：一个看媒体，一个看散户。缺一边时另一边照常显示，不互相顶替。</div>';
        return;
      }
      var head = '<div class="radar-head"><b>' + esc(row ? row.name : keyName) + '</b>'
        + (row ? ' <span class="cat">' + esc(row.code) + ' · ' + esc(row.ind || '—') + ' · ' + esc(row.state || '') + '</span>' : '')
        + '<span class="cat">最新一条 ' + esc(String(new Date(mt.latest).toISOString()).slice(0, 16).replace('T', ' '))
        + ' · 全网存量 ' + (news.total != null ? news.total : '—') + ' 条</span></div>'
        /* 指数关键词（如"上证指数"）覆盖面远大于单只个股，24h 条数天然偏高，
           不说明这一点用户会拿指数的 120× 去比个股的 1.5×。 */
        + (row && row.kind === 'index'
          ? '<div class="rrg-note"><b>指数口径</b>：关键词覆盖面远大于单只个股，24 小时条数与激增倍数天然偏高，<b>不要与个股横向比</b>；'
            + '大盘的关注度看三态与成交额更准，舆情只作辅助。</div>' : '');
      var kpi = '<div class="radar-kpi">'
        + '<div class="rk"><div class="k">近 24 小时</div><div class="v">' + mt.n1 + ' 条</div><div class="s">去重后 ' + mt.uniqN + ' 条</div></div>'
        + '<div class="rk"><div class="k">前 7 日日均</div><div class="v">' + fmt(mt.baseline, 1) + ' 条</div><div class="s">7 日共 ' + mt.n7 + ' 条</div></div>'
        + '<div class="rk"><div class="k">激增倍数</div><div class="v ' + (mt.surge >= 1.5 ? 'up' : 'mut') + '">' + fmt(mt.surge, 1) + '×</div><div class="s">24h ÷ 基线</div></div>'
        + '<div class="rk"><div class="k">来源媒体</div><div class="v">' + mt.mediaN + ' 家</div><div class="s">7 日窗口</div></div>'
        + '</div>';
      var list = '<div class="radar-list"><div class="rl-h">近 7 日资讯（按时间倒序，最多 14 条）</div>'
        + mt.rows.filter(function (r) { return r.t > mt.latest - 7 * 86400000; }).slice(0, 14).map(function (r) { return newsRowHtml(r.x); }).join('')
        + '</div>';
      var pol = polarityOf(mt.rows.map(function (r) { return r.x; }), row ? row.name : keyName, row ? row.code : '');
      el.innerHTML = head + kpi
        + stanceOneLiner(mt, pol, hot, row ? row.code : '')
        + crossSignalHtml(mt, pol, row)
        + radarVerdictHtml(mt, hot, row ? row.code : '')
        + '<div class="radar-two">' + newsTrendHtml(mt) + hotHtml + '</div>'
        + (newsVerdict(mt, row) ? '<div class="rrg-note"><b>媒体侧读法：</b>' + newsVerdict(mt, row) + '</div>' : '')
        + list
        + '<div class="rrg-note"><b>口径</b>：激增倍数 = 近 24 小时条数 ÷ 前 7 日日均；标题近乎重复按噪声降权；'
        + '方向由标题关键词极性判断；市场热度取同花顺热榜每小时/每日排名。'
        + '<b>微信指数</b>没有公开接口（需登录、无 API），所以用「同花顺搜索热度榜」作为搜索量的替代口径，'
        + '这比编一个数诚实。关注度不等于基本面，<b>不构成投资建议</b>。</div>';
    }).catch(function (e) {
      el.innerHTML = '<div class="empty-card"><h3>获取失败</h3>' + esc(String(e && e.message || e)) + '</div>';
    });
  }

  /* ---------- 热度上升最快（同花顺热榜） ----------
     用户要的是「榜单」：一眼看到哪些标的的关注度正在快速上升，并且点进去能和六派对上。
     数据全部来自同花顺公开热榜（小时榜 / 日榜）：跃升 = 日榜排名 − 小时榜排名，
     正数代表最近几小时排名在往前挤。取不到就空白说明，不做估算、不补零。 */
  var HOT_SORT = { key: 'jump', dir: -1 };
  /* 板块热度榜：同花顺热榜拉不到时的兜底，也是「板块共振」的横向视角。
     数据全在本地（sectorStates + 个股行业），不依赖任何外部接口，永远有内容。
     诚实标注它是「板块热度」而不是「资讯热度」——两者含义不同，不能混说。 */
  function sectorRankHtml() {
    var D = RAW();
    var list = D.sectorStates || [], rows = D.rows || [];
    if (!list.length || !rows.length) return '';
    var agg = {};
    rows.forEach(function (r) {
      var nm = r.ind || r.indL2 || '';
      if (!nm) return;
      var a = agg[nm] = agg[nm] || { n: 0, launch: 0, done: 0 };
      a.n++;
      if (r.state === '启动') a.launch++;
      if (r.state === '走完') a.done++;
    });
    var out = [];
    list.forEach(function (s2) {
      var a = agg[s2.name];
      if (!a || a.n < 3) return;
      out.push({ name: s2.name, state: s2.state || '—', days: s2.stateDays,
        chg: (s2.chg == null ? null : s2.chg), n: a.n, launch: a.launch, done: a.done });
    });
    if (!out.length) return '';
    out.sort(function (a, b) {
      var ra = a.n ? a.launch / a.n : 0, rb = b.n ? b.launch / b.n : 0;
      if (rb !== ra) return rb - ra;
      return (b.chg || 0) - (a.chg || 0);
    });
    out = out.slice(0, 20);
    var cls = { '启动': 'up', '走完': 'down', '盘整': 'mut' };
    var h = '<div class="section-title" style="margin-top:6px"><h2>板块热度 · 谁在里面动</h2>'
      + '<span class="desc">按「该板块内处于启动态的股票占比」排序 · 共 ' + out.length + ' 个板块上榜</span></div>'
      + '<div class="ind-empty" style="background:#f7f9fc;border-color:#e3ebf6;color:#42526b;margin-bottom:10px">'
      + '<b>这里看的是「板块」热度，不是「资讯」热度</b>'
      + '<div style="margin-top:4px">同花顺资讯热榜当前取不到（接口限流），所以改用板块自身的状态来回答同一个问题：'
      + '哪些板块里正在有股票启动。板块状态与个股用的是同一套三态引擎，口径一致。</div></div>'
      + '<table class="tbl" style="font-size:12.5px"><thead><tr>'
      + '<th>板块</th><th>板块状态</th><th>启动 / 成分</th><th>启动占比</th><th>板块涨跌</th></tr></thead><tbody>';
    out.forEach(function (x) {
      var ratio = x.n ? (x.launch / x.n * 100) : 0;
      h += '<tr><td><b>' + esc(x.name) + '</b></td>'
        + '<td><span class="' + (cls[x.state] || 'mut') + '">' + esc(x.state)
        + (x.days ? ' · ' + x.days + ' 日' : '') + '</span></td>'
        + '<td>' + x.launch + ' / ' + x.n + '</td>'
        + '<td>' + ratio.toFixed(1) + '%</td>'
        + '<td class="' + (x.chg > 0 ? 'up' : (x.chg < 0 ? 'down' : 'mut')) + '">'
        + (x.chg == null ? '—' : (x.chg >= 0 ? '+' : '') + x.chg.toFixed(2) + '%') + '</td></tr>';
    });
    return h + '</tbody></table>';
  }

  function hotRankBlockHtml() {
    var howtoHot = '<div class="howto"><b>怎么看</b>：'
      + '<span class="k">跃升</span> ＝ 日榜排名 − 小时榜排名，正数越大说明最近几小时突然被搜爆；'
      + '<span class="k">热度值</span> 是同花顺的综合关注度，只用来横向比较；'
      + '点任意一行展开「舆情 × 三态 × 价格」三方核对。</div>';
    return howtoHot + '<div class="section-title" style="margin-top:20px"><h2>热度上升最快</h2>'
      + '<span class="desc">同花顺热榜 · 小时榜相对日榜的排名跃升 · 点任意一行看「舆情 × 三态 × 价格」三方核对</span></div>'
      + '<div id="hotRankWrap" class="hot-rank-wrap"><div class="hint" style="padding:14px">正在读取同花顺热榜…</div></div>';
  }
  function hydrateHotRank() {
    var wrap = $('hotRankWrap'); if (!wrap || !DS.getHotList) return;
    DS.getHotList().then(function (hot) {
      if (!wrap) return;
      if (!hot || !hot._size || (!hot._size.hour && !hot._size.day)) {
        /* 以前这里直接整块消失，用户会以为功能被删了。
           现在明确说「源不可用」并给一个重试按钮，且说明下面的雷达不受影响。 */
        var fb = '';
        try { fb = sectorRankHtml(); } catch (e) { fb = ''; }
        wrap.innerHTML = fb
          ? fb + '<div style="margin-top:10px"><button class="btn" data-hotretry>重新拉取资讯热榜</button></div>'
          : '<div class="ind-empty"><b>热榜源暂时取不到</b>'
            + '<div>同花顺热榜限流或接口变动，<b>不是这里算错了</b>。</div>'
            + '<button class="btn" data-hotretry style="margin-top:10px">重新拉取热榜</button></div>';
        return;
      }
      var items = [];
      Object.keys(hot).forEach(function (c) {
        if (c === '_size') return;
        var o = hot[c] || {}, h = o.hour, d = o.day, base = h || d;
        if (!base || !isNum(base.rank)) return;
        var jump = (h && d && isNum(h.rank) && isNum(d.rank)) ? (d.rank - h.rank) : null;
        /* 同花顺把热度值给成字符串（"479838.0"），直接 isNum 判断会全变成「—」 */
        var rv = parseFloat(base.rate);
        items.push({
          code: c, name: base.name || c, rank: base.rank, jump: jump,
          rate: isFinite(rv) ? rv : null,
          rise: isNum(base.rise) ? base.rise : null,
          reason: base.reason, tags: base.tags || []
        });
      });
      if (!items.length) { wrap.innerHTML = '<div class="ind-empty">热榜返回为空，稍后重试</div>'; return; }
      function hsortMark(k) {
        if (HOT_SORT.key !== k) return '';
        return ' <span style="font-size:10px">' + (HOT_SORT.dir > 0 ? '▲' : '▼') + '</span>';
      }
      function sortItems() {
        var k = HOT_SORT.key, dir = HOT_SORT.dir;
        items.sort(function (a, b) {
          var va, vb;
          if (k === 'name') { return dir * String(a.name).localeCompare(String(b.name), 'zh'); }
          if (k === 'chg') {
            va = (DS.snapshot(a.code) && dayOf(DS.snapshot(a.code)) != null) ? dayOf(DS.snapshot(a.code)) : a.rise;
            vb = (DS.snapshot(b.code) && dayOf(DS.snapshot(b.code)) != null) ? dayOf(DS.snapshot(b.code)) : b.rise;
          } else { va = a[k]; vb = b[k]; }
          if (va == null && vb == null) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          return dir * (va - vb);
        });
      }
      function paint() {
        if (!wrap) return;
        window.__repaintHot = paint;   /* 表头点击排序后重画 */
        sortItems();                   /* 排序必须放在 paint 里，否则点表头不会重排 */
        var top = items.slice(0, 20);
        wrap.innerHTML = '<div class="table-wrap wide"><table class="hot-rank-tbl"><thead><tr>'
          + '<th class="lft hsort" data-hsort="name" style="cursor:pointer">名称' + hsortMark('name') + '</th>'
          + '<th class="hsort" data-hsort="rank" style="cursor:pointer">小时榜' + hsortMark('rank') + '</th>'
          + '<th class="hsort" data-hsort="jump" style="cursor:pointer">跃升' + hsortMark('jump') + '</th>'
          + '<th class="hsort" data-hsort="rate" style="cursor:pointer">热度值' + hsortMark('rate') + '</th>'
          + '<th class="hsort" data-hsort="chg" style="cursor:pointer">今日%' + hsortMark('chg') + '</th>'
          + '<th>三态</th><th>六派</th><th class="lft">上榜原因</th></tr></thead><tbody>'
          + top.map(function (x) {
            var r = DS.snapshot(x.code), day = r ? dayOf(r) : null;
            /* 行情没到时用热榜自带的涨跌幅兜底（标注口径），不留「—」 */
            var dv = day != null ? day : x.rise;
            var viaHot = day == null && x.rise != null;
            return '<tr class="hot-row" data-hot="' + esc(x.code) + '" data-hotname="' + esc(x.name) + '">'
              + '<td class="name"><b>' + esc(x.name) + '</b> <span class="cat">' + esc(x.code) + '</span>'
              + '<span style="color:var(--blue);font-size:11px"> ▸ 核对</span></td>'
              + '<td>' + x.rank + '</td>'
              + '<td>' + (x.jump == null ? '<span class="mut">—</span>'
                : (x.jump > 0 ? '<b class="up">+' + x.jump + '</b>' : (x.jump < 0 ? '<span class="down">' + x.jump + '</span>' : '0'))) + '</td>'
              + '<td>' + (x.rate != null ? fmt(x.rate, 0) : '—') + '</td>'
              + '<td class="' + (dv != null ? signCls(dv) : 'mut') + '"'
              + (viaHot ? ' title="热榜自带的涨跌幅（实时行情未到）"' : '') + '>'
              + (dv != null ? pct(dv) : '—') + (viaHot ? '<span class="cat">热榜</span>' : '') + '</td>'
              + '<td>' + (r ? stateBlock(r) : '<span class="mut">池外</span>') + '</td>'
              + '<td>' + (r ? bullCount(r) + '/6' : '—') + '</td>'
              + '<td class="lft reason">' + esc(String(x.reason || x.tags.join(' · ') || '—').slice(0, 30)) + '</td>'
              + '</tr>';
          }).join('') + '</tbody></table></div>'
          + '<div class="hint">跃升 = 日榜排名 − 小时榜排名（正数＝最近几小时关注度在往上挤，0 或负＝正在退潮）。'
          + '热度只说明「有多少人在看」，<b>不等于基本面变化</b>；点行拉实时资讯做三方核对，看它与三态、价格是否互相印证。</div>';
      }
      paint();
      markScrollHints();
      /* 这 20 只多半不在当前页的批量行情里，自己拉一次再重绘，别让「今日%」长期是「—」 */
      var need = top.map(function (x) { return x.code; }).filter(function (c) { return !QUOTES[c]; });
      if (need.length) {
        DS.getTodayQuotes(need).then(function (res) {
          Object.keys((res && res.map) || {}).forEach(function (k) { QUOTES[k] = res.map[k]; });
          paint();
        }).catch(function () {});
      }
    }).catch(function () {
      if (wrap) wrap.innerHTML = '<div class="ind-empty">热榜读取失败，稍后重试</div>';
    });
  }
  /* 点榜单一行的展开：复用资讯雷达那套判定（newsMetrics / polarityOf / radarCompactHtml），
     保证同一标的在榜单里和在雷达页看到的结论完全一致。 */
  function hotRowToggle(tr) {
    if (!tr) return;
    var code = tr.getAttribute('data-hot'), name = tr.getAttribute('data-hotname') || code;
    var nx = tr.nextSibling;
    if (nx && nx.className === 'hot-detail') { tr.parentNode.removeChild(nx); return; }
    document.querySelectorAll('.hot-detail').forEach(function (x) { x.parentNode.removeChild(x); });
    var det = document.createElement('tr');
    det.className = 'hot-detail';
    det.innerHTML = '<td colspan="8"><div class="hint" style="padding:8px 2px">正在拉取「' + esc(name) + '」的实时资讯并做三方核对…</div></td>';
    tr.parentNode.insertBefore(det, tr.nextSibling);
    var row = DS.snapshot(code) || { code: code, name: name };
    Promise.all([
      DS.getNews(name, 60).catch(function () { return null; }),
      (DS.getHotList ? DS.getHotList() : Promise.resolve(null)).catch(function () { return null; })
    ]).then(function (res) {
      var news = res[0], hot = res[1];
      var mt = news && news.list ? newsMetrics(news.list) : null;
      if (!mt) {
        det.innerHTML = '<td colspan="8"><div class="hint" style="padding:8px 2px">'
          + '资讯接口没有返回「' + esc(name) + '」的条目（可能关键词太具体、限流、或确实没报道）。'
          + '这一栏留空，不编结论。</div></td>';
        return;
      }
      var pol = polarityOf(mt.rows.map(function (r) { return r.x; }), name, code);
      det.innerHTML = '<td colspan="8">' + radarCompactHtml(mt, pol, hot, row, code, name) + '</td>';
    }).catch(function () {
      det.innerHTML = '<td colspan="8"><div class="hint">核对失败，稍后重试</div></td>';
    });
  }

  function viewNews() {
    var allList = themeList(), m = (RAW().meta || {}).newsMeta || {};
    if (allList.length) {
      var RN0 = (typeof window !== 'undefined' && window.AB_NEWS) ? window.AB_NEWS : null;
      var l1s = [];
      allList.forEach(function (t) { if (t.l1 && l1s.indexOf(t.l1) < 0) l1s.push(t.l1); });
      l1s.sort(function (a, b) { return String(a).localeCompare(String(b), 'zh'); });
      if (NEWS_L1 !== '全部' && l1s.indexOf(NEWS_L1) < 0) NEWS_L1 = '全部';
      var list = allList.filter(function (t) {
        if (NEWS_L1 !== '全部' && t.l1 !== NEWS_L1) return false;
        if (NEWS_ONLY_HIT && !(t.n1 > 0)) return false;
        if (NEWS_Q) {
          var hay = [t.name, t.l1, t.l2, t.kw].map(function (x) { return String(x || ''); }).join(' ');
          if (hay.indexOf(NEWS_Q) < 0) return false;
        }
        return true;
      });
      function sk(t) {
        if (NEWS_SORT === 'count') return isNum(t.n1) ? t.n1 : -1;
        if (NEWS_SORT === 'media') return isNum(t.mediaN) ? t.mediaN : -1;
        if (NEWS_SORT === 'stocks') return isNum(t.stocks) ? t.stocks : -1;
        if (NEWS_SORT === 'dir') return isNum(t.dir) ? t.dir : -1e9;
        if (NEWS_SORT === 'surge') return isNum(t.surge) ? t.surge : -1;
        return isNum(t.eff) ? t.eff : -1;
      }
      if (NEWS_SORT === 'name') {
        list.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'zh'); });
      } else {
        list.sort(function (a, b) { return sk(b) - sk(a); });
      }
      var srcNote = RN0
        ? (RN0.sources ? RN0.sources.length : '—') + ' 个真实源 · ' + (RN0.total || 0) + ' 条 · 更新 ' + (RN0.asOf || '—')
        : '短窗口资讯密度 vs 7 日基线';
      var filterHtml = '<div class="news-filter" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0 14px">'
        + '<select id="newsL1" style="padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--txt)">'
        + ['全部'].concat(l1s).map(function (x) {
            return '<option value="' + esc(x) + '"' + (NEWS_L1 === x ? ' selected' : '') + '>' + esc(x) + '</option>';
          }).join('') + '</select>'
        + '<input id="newsQ" type="search" placeholder="搜行业名 / 关键词" value="' + esc(NEWS_Q) + '"'
        + ' style="padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--txt);min-width:150px">'
        + '<button class="btn" id="newsFilterGo">筛选</button>'
        + '<label style="font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:4px">'
        + '<input type="checkbox" id="newsOnlyHit"' + (NEWS_ONLY_HIT ? ' checked' : '') + '> 仅看有资讯</label>'
        + '<span style="flex-basis:100%;display:flex;gap:6px;flex-wrap:wrap;margin-top:2px">'
        + NEWS_TABS.map(function (x) {
            return '<button class="btn' + (NEWS_SORT === x.k ? ' on' : '') + '" data-ntab="' + x.k + '">' + x.t + '</button>';
          }).join('') + '</span></div>';
      return '<div class="section-title"><h2>舆情雷达 · 真实行业口径</h2><span class="desc">'
        + list.length + ' / ' + allList.length + ' 个行业 · ' + srcNote + '</span></div>'
        + (RN0 ? '<div class="rrg-note" style="margin:0 0 12px">行业全集来自 <b>data.js rows[].ind / _ind_map.json</b>，'
            + '与「行业 · 三态下钻」「板块共振」完全同源；按「行业名 / 二级行业 / 该行业成分股名称」真实命中新闻。'
            + '激增倍数需累积 ≥3 天真实历史才计算，不足时显示条数，<b>不用当天数据伪造 7 日基线</b>。'
            + '不构成投资建议。</div>' : '')
        + filterHtml
        + (list.length ? '<div class="news-grid">' + list.map(newsCard).join('') + '</div>'
            : '<div class="hint" style="padding:22px;text-align:center">当前筛选没有匹配的行业，试试清空关键词或切回「全部」。</div>')
        + hotRankBlockHtml();
    }
    var def = NEWS_KW || '上证指数';   // 默认就给大盘，不留空
    return '<div class="section-title"><h2>资讯雷达 · 单只标的</h2>'
      + '<span class="desc">按「近 24 小时资讯密度 ÷ 前 7 日日均」量化，重复转载降权、按来源与措辞定方向</span></div>'
      + hotRankBlockHtml()      // 榜单放在单只检测之前：用户先看「谁在升温」，再决定点开谁做核对
      + '<div class="radar-box">'
      + '<div class="radar-ctrl">'
      + '<input id="newsKw" type="text" autocomplete="off" placeholder="输入代码或名称，如 600519 / 贵州茅台" value="' + esc(def) + '" />'
      + '<button class="btn btn-primary" id="newsGo">检测资讯密度</button>'
      + '<span class="cat">数据来自东财全网资讯搜索，实时抓取</span>'
      + '<div class="radar-quick">' + Object.keys(RADAR_INDEX).map(function (n) {
        return '<span class="rq" data-rkw="' + esc(n) + '">' + esc(n) + '</span>';
      }).join('') + '</div>'
      + '</div>'
      + '<div id="newsBody"><div class="hint">输入标的后点「检测」。</div></div>'
      + '</div>'
      + '<div class="rrg-note"><b>为什么这样做</b>：单看「有几条新闻」会被转载和通稿带偏。'
      + '这里把 24 小时条数与前期日均比，先把标题近乎重复的算噪声降权，再看来源媒体数是否跟上，'
      + '最后用措辞极性定方向 —— 三个条件同时成立的「激增」，才值得你去看原文。'
      + '资讯密度衡量的是<b>关注度</b>，不等于基本面变化，<b>不构成投资建议</b>。</div>'
      + legendBlock();
  }

  // ---------- 关注池健康体检（五维：趋势 / 资金 / 舆情 / 估值 / 位置）----------
  // 维度均为「风险等级」红黄绿，非涨跌判断；当前数据集未含估值分位，诚实标注缺口，不估算。
  function positionPct(r) {
    var s = r.series;
    if (!Array.isArray(s) || s.length < 2) return null;
    var vals = s.map(function (x) { return (Array.isArray(x) && isNum(x[1])) ? x[1] : null; }).filter(function (v) { return v != null; });
    if (vals.length < 2) return null;
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (max - min < 1e-6) return 0.5;
    return (s[s.length - 1][1] - min) / (max - min); // 今日(=100) 在区间内的相对位置
  }
  function healthDims(r) {
    var e2 = r.e2 || {}, p = r.pct || {}, nm = r.newsMain || {}, d = [];
    function add(name, level, s, detail) { d.push({ name: name, level: level, s: s, detail: detail }); }
    // 1) 趋势：三态 + 区间动量
    var w5 = isNum(p.w5) ? p.w5 : null, w20 = isNum(p.w20) ? p.w20 : null;
    if (r.state === '启动') {
      var tLevel = (w5 != null && w5 < 0 && w20 != null && w20 < 0) ? 'warn' : 'good';
      add('趋势', tLevel, '▲ 启动', '处于启动阶段' + (w5 != null ? '，近5日 ' + pct(w5) : '') + '；需核对动量是否延续');
    } else if (r.state === '盘整') {
      add('趋势', 'warn', '— 盘整', '方向未明，六派分歧通常较大');
    } else {
      add('趋势', 'bad', '▼ 走完', '阶段接近尾声，动能衰减（非看跌判断）');
    }
    // 2) 资金：六派资金派投票 + 主力净流入标签
    var fundDir = (r.votes && isNum(r.votes.fund)) ? r.votes.fund : 0;
    var fundLbl = r.fundLabel ? String(r.fundLabel).replace(/（东方财富口径）/, '') : '';
    /* 资金派：优先用实时拉的当日主力净流入（AB_FUNDFLOW），拉不到才用快照的行业代理。
       历史回测不含资金派（免费源只留半年），这里只补当前显示，绝不改写历史统计。 */
    var ff = (typeof window !== 'undefined' && window.AB_FUNDFLOW) ? window.AB_FUNDFLOW.voteOf(r.code) : null;
    if (ff) { fundDir = ff.fund; fundLbl = ff.label; }
    if (fundDir === -1) add('资金', 'bad', '净流出', '资金派反对当前判断' + (fundLbl ? '：' + fundLbl : ''));
    else if (fundDir === 1) add('资金', 'good', '净流入', '资金派支持' + (fundLbl ? '：' + fundLbl : ''));
    else add('资金', 'warn', '中性', fundLbl ? fundLbl : '资金面无显著方向');
    // 3) 舆情：资讯激增 + 方向
    var surge = isNum(nm.surge) ? nm.surge : 0, dir = isNum(nm.dir) ? nm.dir : 0;
    if (surge > 0.5 && dir < 0) add('舆情', 'bad', fmt(surge, 1) + '×', '资讯激增但方向偏谨慎，需核对');
    else if (surge > 0.4) add('舆情', 'warn', fmt(surge, 1) + '×', '资讯密度异常抬升，需核对');
    else add('舆情', 'good', '常态', '无显著资讯密度异常');
    // 4) 估值：当前数据集未含估值分位 → 诚实缺口（绝不估算）
    add('估值', 'na', '缺口', '当前数据集未含估值分位（诚实缺口，不估算）');
    // 5) 位置：由 series 归一化净值锚点推算区间位置百分位
    var pos = positionPct(r);
    if (pos == null) add('位置', 'warn', '—', '快照缺区间数据');
    else if (pos > 0.8) add('位置', 'warn', Math.round(pos * 100) + '%', '接近阶段高位，留意透支 / 止盈');
    else if (pos < 0.2) add('位置', 'good', Math.round(pos * 100) + '%', '处于阶段低位（区间位置）');
    else add('位置', 'good', Math.round(pos * 100) + '%', '处于阶段中部（区间位置）');
    return d;
  }
  // 关注健康度：0-100，越高越稳；估值缺口不计入惩罚。
  function healthScore(r, dims) {
    var bad = dims.filter(function (x) { return x.level === 'bad'; }).length;
    var warn = dims.filter(function (x) { return x.level === 'warn'; }).length;
    var pen = bad * 22 + warn * 10;
    if (r.e2 && r.e2.divergence) pen += 8;
    if (Array.isArray(r.veto) && r.veto.length) pen += 10;
    return Math.max(0, Math.min(100, 100 - pen));
  }
  // 「对你意味着什么」结论（止盈预警 / 风险提示 / 关注 / 持有观察）
  function healthVerdict(r, level) {
    var e2 = r.e2 || {}, nm = r.newsMain || {}, p = r.pct || {};
    var days = e2.stateDays != null ? e2.stateDays : 0;
    var hasDiv = !!(e2.divergence);
    var fundDir = (r.votes && isNum(r.votes.fund)) ? r.votes.fund : 0;
    var veto = Array.isArray(r.veto) ? r.veto.length : 0;
    var surge = isNum(nm.surge) ? nm.surge : 0, dir = isNum(nm.dir) ? nm.dir : 0;
    if (r.state === '走完' && (days >= 15 || hasDiv || (isNum(p.w60) && p.w60 > 40))) {
      return { cls: 'high', t: '止盈预警', why: '阶段走完且' + (days >= 15 ? '已持续 ' + days + ' 天' : hasDiv ? '存在派别分歧' : '中期涨幅过大') + '，再上的性价比下降，关注兑现节奏（非卖出指令）' };
    }
    if (veto || (hasDiv && /反对|偏空|流出/.test(e2.divergence.txt || '')) || fundDir === -1) {
      return { cls: 'high', t: '风险提示', why: (veto ? ('记录 ' + veto + ' 项否决 / 风险标记') : hasDiv ? '派别分歧，结论稳健性存疑' : '资金派翻空（' + fundDir + '）') + '，建议核对关键位与持仓逻辑' };
    }
    if (surge > 0.5 && dir < 0) {
      return { cls: 'mid', t: '关注', why: '资讯激增但方向偏谨慎，留意舆情后续演化' };
    }
    if (r.state === '启动' && days < 10) {
      return { cls: 'low', t: '持有观察 · 启动早期', why: '处于启动阶段且持续 ' + days + ' 天，属机会观察区，核对动量是否延续' };
    }
    if (r.state === '盘整') {
      return { cls: 'low', t: '持有观察 · 盘整蓄势', why: '方向未明，六派分歧通常较大，等待方向选择' };
    }
    return { cls: level === 'high' ? 'high' : (level === 'mid' ? 'mid' : 'low'), t: '持有观察', why: '当前未触发重点预警项，按既定逻辑持有观察' };
  }
  function scoreBadge(score) {
    return '<span class="hscore ' + (score >= 80 ? 'low' : (score >= 60 ? 'mid' : 'high')) + '" title="关注健康度（越高越稳，非收益预测）">' + score + '<small>分</small></span>';
  }
  function viewHealth() {
    var follows = getFollows().map(function (c) { return DS.snapshot(c); }).filter(Boolean);
    var h = '<div class="section-title"><h2>关注池健康体检</h2><span class="desc">五维红黄绿为<b>风险等级</b>，非涨跌判断 · 按紧急度排序</span></div>';
    if (!follows.length) {
      return h + '<div class="health-empty">还没有关注任何标的。去 <a href="#/all" style="color:var(--blue-d)">全市场</a> 点 ☆ 加入几只，这里会给出每只的核对清单。</div>'
        + legendBlock();
    }
    var scored = follows.map(function (r) {
      var d = healthDims(r);
      var bad = d.filter(function (x) { return x.level === 'bad'; }).length,
        warn = d.filter(function (x) { return x.level === 'warn'; }).length;
      var risk = bad * 3 + warn + ((r.e2 && r.e2.divergence) ? 2 : 0) + ((Array.isArray(r.veto) && r.veto.length) ? 3 : 0);
      var level = risk >= 6 ? 'high' : (risk >= 3 ? 'mid' : 'low');
      return { r: r, d: d, risk: risk, level: level, score: healthScore(r, d), verdict: healthVerdict(r, level) };
    }).sort(function (a, b) { return b.risk - a.risk; });
    h += '<div class="notice">打开即见需要优先核对的标的。以下均为<b>客观事实核对项</b>，<b>不构成买卖建议</b>；颜色表示需要留意的程度，与红涨绿跌无关。健康度评分仅综合上述维度，非未来收益预测。</div>';
    h += scored.map(function (o) {
      var r = o.r, e2 = r.e2 || {}, v = o.verdict;
      var ltxt = o.level === 'high' ? '优先核对' : (o.level === 'mid' ? '留意' : '平稳');
      var hist = Array.isArray(e2.stateHistory) ? e2.stateHistory : [];
      var traj = hist.length ? hist.map(function (x) { return esc(x.date || '') + ' ' + esc(x.state || ''); }).join(' → ')
        + ' → 当前 ' + esc(r.state) : '仅记录当前状态：' + esc(r.state);
      /* 整张卡都可点，不再只有右下「透镜」按钮能点。
         按钮仍保留（用户已经习惯），点它会命中最近的可点元素，只触发一次。 */
      return '<div class="health-card' + (o.level === 'high' ? ' alert' : '') + '" data-open="' + esc(r.code) + '" style="cursor:pointer"><div class="health-head">'
        + '<b>' + esc(r.name) + '</b> <span class="cat">' + esc(r.code) + '</span> ' + stateBlock(r)
        + scoreBadge(o.score)
        + '<span class="risk ' + o.level + '">' + ltxt + '</span><span style="flex:1"></span>'
        + '<button class="btn" data-open="' + esc(r.code) + '">透镜</button>'
        + '<button class="btn" data-history="' + esc(r.code) + '">前世今生</button>'
        + '<button class="btn" data-share="' + esc(r.code) + '">分享</button>'
        + '</div><div class="verdict ' + v.cls + '"><b>' + esc(v.t) + '</b> · ' + esc(v.why) + '</div>'
        + '<div class="health-dims">' + o.d.map(function (x) {
          return '<div class="hdim ' + x.level + '"><div class="l">' + x.name + '</div><div class="s">' + x.s
            + '</div><div class="d">' + esc(x.detail) + '</div></div>';
        }).join('') + '</div>'
        + '<div class="traj"><b>轨迹复盘</b>：' + traj + ' · 当前状态自 ' + esc(sinceOf(r) || '—')
        + ' 起，约 ' + esc(e2.stateDays != null ? e2.stateDays + ' 天' : '—') + '。</div>'
        + (e2.divergence ? '<div class="notice" style="margin-top:8px">分歧预警：' + esc(e2.divergence.txt) + '</div>' : '')
        + '<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:var(--blue-d)">查看决定性证据 / 风险预警 / 六派历史胜率</summary>'
        + '<div style="margin-top:8px">' + sixEvidence(r) + '</div>'
        + insightBlock(r, QUOTES[r.code] || {}, true)
        + (e2.falsify && e2.falsify.txt ? '<div class="notice" style="margin-top:8px">可证伪锚点：' + esc(e2.falsify.txt) + '</div>' : '')
        + '</details></div>';
    }).join('');
    return h + legendBlock();
  }
  // 首页「打开即见预警」横幅：关注池中若存在优先核对项，置顶红色提示（无推送时代的通知替代）。
  function healthAlertBanner() {
    var follows = getFollows().map(function (c) { return DS.snapshot(c); }).filter(Boolean);
    if (!follows.length) return '';
    var high = [];
    follows.forEach(function (r) {
      var d = healthDims(r);
      var bad = d.filter(function (x) { return x.level === 'bad'; }).length,
        warn = d.filter(function (x) { return x.level === 'warn'; }).length;
      var risk = bad * 3 + warn + ((r.e2 && r.e2.divergence) ? 2 : 0) + ((Array.isArray(r.veto) && r.veto.length) ? 3 : 0);
      if (risk >= 6) high.push(r);
    });
    if (!high.length) return '';
    var names = high.slice(0, 6).map(function (r) { return esc(r.name); }).join('、') + (high.length > 6 ? (' 等 ' + high.length + ' 只') : '');
    return '<div class="health-alert">'
      + '<div class="ha-ico">⚠</div>'
      + '<div class="ha-body"><b>关注池体检：' + high.length + ' 只标的需优先核对</b>'
      + '<div class="ha-sub">' + names + ' · 高位走完 / 破位 / 派别分歧等风险项，打开即见（客观核对，非买卖建议）</div></div>'
      + '<a class="btn btn-primary" href="#/health">去体检 ›</a>'
      + '</div>';
  }

  // ---------- 视图：方法论 ----------
  function viewMethod() {
    return '<div class="section-title"><h2>方法论 · 三态看盘</h2></div>'
      + '<div class="grid cols-3">'
      + methodCard('▲ 启动', '标的所处阶段被判断为「启动」——资金/结构/情绪开始共振向上。这是阶段位置判断，不等于「明天会涨」。', 'var(--state-launch)')
      + methodCard('— 盘整', '多空拉锯、方向不明的震荡整理期。六派分歧通常最大。', 'var(--state-consol)')
      + methodCard('▼ 走完', '一波阶段接近尾声，动能衰减。不等于「明天会跌」，更多是「再上的性价比下降」。', 'var(--state-done)')
      + '</div>'
      + '<div class="card" style="margin-top:14px"><h3>三态九档：为什么同一个态还要再分</h3>'
      + '<p style="color:var(--muted);font-size:13px;margin-top:6px">同样是「启动」，刚切换的第一天和已经涨了 12 天，风险完全不同；同样是「走完」，'
      + '昨天刚转和已经磨了一个月，后面的走法也完全相反。所以按「已持续天数 + 回撤幅度 + 票数变化」再分档，共 9 档：</p>'
      + '<table class="tbl" style="margin-top:10px;font-size:12.5px"><thead><tr><th>大类</th><th>子档</th><th>判定</th><th>含义与应对倾向</th></tr></thead><tbody>'
      + '<tr><td rowspan="4">▲ 启动</td><td>新发</td><td>≤2 个交易日</td><td>刚切换，仍在验证。可跟，但要设紧止损</td></tr>'
      + '<tr><td>健康</td><td>3–8 个交易日</td><td>主升段，行情已走一段。持有为主，不加仓</td></tr>'
      + '<tr><td>观察</td><td>9–15 天，或出大阴线 / 票数减少</td><td>超出常见长度，追高性价比下降</td></tr>'
      + '<tr><td>退化</td><td>&gt;15 天，或单日跌超 5%</td><td>启动失败前兆，按「不是启动」对待</td></tr>'
      + '<tr><td rowspan="2">— 盘整</td><td>盘整中</td><td>&lt;20 个交易日</td><td>方向未定，等箱体突破</td></tr>'
      + '<tr><td>久盘</td><td>≥20 个交易日</td><td>久盘之后方向通常更急，重点盯量能突变</td></tr>'
      + '<tr><td rowspan="3">▼ 走完</td><td>刚走完</td><td>≤3 个交易日</td><td>下跌动能还在释放，<b>不要抄底</b></td></tr>'
      + '<tr><td>走完中</td><td>4–15 个交易日</td><td>仍在震荡消化，别把反弹当反转</td></tr>'
      + '<tr><td>走完已久</td><td>&gt;15 个交易日</td><td>消化较充分，<b>留意是否重新吸筹</b>（才可能出现机会）</td></tr>'
      + '</tbody></table>'
      + '<p style="color:var(--muted);font-size:12px;margin-top:8px">天数为经验阈值，不是概率。真正的判断依据是「条件是否成立」，见下方路径表。</p>'
      + '</div>'
      + '<div class="card" style="margin-top:14px"><h3>九档各自的后续路径（条件 → 走向 → 应对）</h3>'
      + '<p style="color:var(--muted);font-size:13px;margin-top:6px">理想情况下三态是个闭环：启动 → 盘整 → 走完 → 重新启动。'
      + '但实际交易里每一步都会分叉，所以这里把每一档的<b>所有可能走向</b>都列出来，并写明触发条件——'
      + '条件成立就走对应那条，不成立就继续等。个股页只显示「当前这一档」的路径，这里是完整版。</p>'
      + (window.AB_PATH && window.AB_PATH.allTable ? window.AB_PATH.allTable() : '')
      + '</div>'
      + '<div class="card" style="margin-top:14px"><h3>六派共振（X/6 看启动）</h3>'
      + '<div class="six">' + SIX.map(function (s) { return '<span class="tag mid">' + s.n + '</span>'; }).join('') + '</div>'
      + '<p style="color:var(--muted);font-size:13px;margin-top:10px">六个维度独立投票，合计看多票数即「X/6 派看启动」。每派原文依据可在个股透镜 / 前世今生里逐条查看。</p></div>'
      + '<div class="grid cols-3" style="margin-top:14px">'
      + (Array.isArray(RAW().voteDef) ? RAW().voteDef : []).map(function (v) {
        return methodCard(esc(v.name || v.key), esc(v.desc || ''), 'var(--blue-d)');
      }).join('')
      + '</div>'
      + '<div class="grid cols-3" style="margin-top:14px">'
      + methodCard('舆情激增怎么算', 'n1 = 近 1 日强相关资讯条数，n7 = 前 7 日条数，基线日均 = n7/7；surge = n1 ÷ max(基线日均, 0.5)。有效激增 = surge ÷ (1 + 0.4×噪声数)，再乘主题方向系数。<b>本票由「资讯雷达」实时计算</b>：全网资讯密度 × 标题极性 × 三方核对（舆情×三态×价格）；'
        + '构建快照不含新闻源，明细里显示的实时舆情票以雷达结果为准。', 'var(--violet)')
      + methodCard('RRG 相对轮动', '横轴 = 相对强度（个股 5/20/60 日表现 ÷ 基准同期表现，取几何均值后 ×100），纵轴 = 相对动量的变化。基准取<b>全市场样本的中位数</b>（不是沪深300）。四象限：领先 / 改善 / 走弱 / 落后，典型轮动顺时针。', 'var(--teal)')
      + methodCard('数据时点与口径', '三态 / 六派由腾讯 / 新浪免费行情重算的基础快照（截至页面标注时点）。<b>资金派</b>：优先用东财资金流日线的最近交易日真实净额（个股主力净流入 / ETF 资金流净额），拉不到才退用行业或成交额代理，并明确标注口径；<b>舆情派</b>：由「资讯雷达」实时判定（密度 + 极性 + 三方核对），快照内不含新闻，故以实时票为准。今日% 与日K 在浏览器端实时抓取（东财 / 腾讯 / 新浪降级），快照区间不含当日，失败会明确标注。', 'var(--amber)')
      + '</div>'
      + '<div class="notice" style="margin-top:14px">合规声明：本工具为客观数据观察，<b>不构成投资建议，不预示未来收益</b>。三态与六派均为基于公开数据的阶段/维度判断，任何投资请独立决策并自担风险。</div>';
  }
  function methodCard(t, d, c) {
    return '<div class="card"><h3 style="color:' + c + '">' + t + '</h3><p style="color:var(--muted);font-size:13px;margin:0">' + d + '</p></div>';
  }

  // ---------- 「前世今生」独立全屏报告 ----------
  function hh(l, v, s) { return '<div class="hh-box"><div class="l">' + l + '</div><div class="v">' + v + '</div><div class="s">' + s + '</div></div>'; }
  function pickerItem(r, note) {
    return '<div class="picker-item" data-history="' + esc(r.code) + '">'
      + '<div><b>' + esc(r.name) + '</b><span class="cat">' + esc(r.code) + (note ? ' · ' + esc(note) : '') + '</span></div>'
      + '<div class="pi-st">' + stateBlock(r) + '</div></div>';
  }
  /* 「更多」：老功能都收在这里，导航只留四项。
     入口降级不等于删除 —— 常用的是全市场筛选，其余按需进来找。 */
  function viewMore() {
    var items = [
      { h: '#/sector', t: '行业三态', d: '按东财三级行业看启动/盘整/走完，以及板块内的成分股' },
      { h: '#/news', t: '舆情雷达', d: '资讯密度激增的标的，配合三态看消息与走势是否同向' },
      { h: '#/rrg', t: 'RRG 轮动', d: '相对大盘的强弱与动量，判断资金在往哪个方向转' },
      { h: '#/picker', t: '前世今生', d: '单只标的的完整脉络：三态切换历史、六派依据、结构细节' },
      { h: '#/method', t: '方法论', d: '三态九档、六派定义、路径表与全部口径说明' }
    ];
    var h = '<div class="section-title"><h2>更多功能</h2>'
      + '<span class="desc">日常只看「全市场」和「大盘」，这里按需取用</span></div>';
    h += '<div class="grid cols-2">';
    items.forEach(function (x) {
      h += '<a class="card" href="' + x.h + '" style="display:block;text-decoration:none;color:inherit">'
        + '<div style="font-size:15px;font-weight:500;color:var(--ink)">' + esc(x.t) + '</div>'
        + '<div style="font-size:12.5px;color:var(--muted);margin-top:6px;line-height:1.7">'
        + esc(x.d) + '</div></a>';
    });
    h += '</div>';
    return h;
  }

  function viewPicker() {
    var recs = DS.allRecords();
    var follows = getFollows().map(function (c) { return DS.snapshot(c); }).filter(Boolean);
    var launch = recs.filter(function (r) { return r.state === '启动'; })
      .sort(function (a, b) { return bullCount(b) - bullCount(a); }).slice(0, 20);
    var surge = recs.filter(newsHot).sort(function (a, b) { return newsRankOf(b) - newsRankOf(a); }).slice(0, 12);
    var recent = ACTIVE_CODE ? DS.snapshot(ACTIVE_CODE) : null;
    var h = '<div class="section-title"><h2>个股 / ETF / 指数 · 前世今生</h2><span class="desc">输入代码 / 名称 / 指数直接打开，或从下面挑一只</span></div>';
    h += histSwitcherHtml('');
    h += '<div class="notice">也可以从下面的「今日启动信号 / 舆情激增 / 关注」里点一只；'
      + '在「全市场」或「行业」点任意一行进入侧栏透镜后，再点「⤢ 打开完整前世今生」。</div>';
    function group(title, desc, list) {
      if (!list.length) return '';
      return '<div class="section-title"><h2>' + title + '</h2><span class="desc">' + desc + '</span></div>'
        + '<div class="picker-grid">' + list.map(function (r) { return pickerItem(r); }).join('') + '</div>';
    }
    if (recent) h += group('最近查看', '接着看上一只', [recent]);
    h += group('我的关注', follows.length + ' 只', follows);
    h += group('今日启动信号', '按六派共振排序', launch);
    h += group('舆情激增', '资讯密度显著抬升', surge);
    h += '<div class="section-title"><h2>全部标的</h2><span class="desc">' + recs.length + ' 只（点开任意一只）</span></div>'
      + '<details><summary style="cursor:pointer;color:var(--blue);font-weight:600">展开全部标的</summary>'
      + '<div class="picker-grid" style="margin-top:12px">' + recs.map(function (r) { return pickerItem(r); }).join('') + '</div></details>';
    return h;
  }

  /* 结论后表现：明确以「结论日」为基期，逐锚点列出累计涨跌；
   * 直接回应「至约20日前」的歧义——它是从结论日算到约X个交易日前，并非以今日为基期往前推。 */
  function perfLegs(r, x, o) {
    var node = anchorOf(r, x.back);
    if (!node) return '<span class="cat">该锚点无后续行情数据</span>';
    var order = [250, 60, 20, 5, 0].filter(function (b) { return b < Number(x.back); });
    var parts = order.map(function (b) {
      var a = anchorOf(r, b); if (!a || !node.val) return '';
      var chg = (a.val / node.val - 1) * 100;
      var lbl = b === 0 ? '到今日' : ('到约 ' + b + ' 日前');
      return '<span class="perf-leg">' + lbl + ' <b class="' + signCls(chg) + '">' + pct(chg) + '</b></span>';
    }).filter(Boolean);
    var head = '<span class="perf-base">基期＝该结论日（' + esc(x.date || x.t || '—') + '），<b>不是今日</b>；'
      + '锚点为快照归一化区间（今日＝100）。</span>';
    var note = '<span class="cat">「至约 X 日前」＝从结论日算到约 X 个交易日前，'
      + '不是以今日为基期往前推 X 天。以上为客观历史涨跌，不预示未来。</span>';
    return head + '<span class="perf-legs">' + parts.join('') + '</span>' + note;
  }
  /* 前世今生：状态切换时间线（快照记录） */
  function historyTimeline(r) {
    var e2 = r.e2 || {};
    var hist = Array.isArray(e2.stateHistory) ? e2.stateHistory : [];
    var outs = historyOutcomes(r);
    var items = hist.map(function (x, i) {
      var st = x.state || '';
      var cls = STATE_MAP[st] ? STATE_MAP[st].cls : 'unk';
      var o = outs[i] || {};
      var perf = Number(x.back) === 0
        ? '<span class="cat">当日节点，尚无后续区间。</span>'
        : perfLegs(r, x, o);
      return '<li class="tl-item ' + cls + '"><span class="tl-dot"></span>'
        + '<div class="tl-date">' + esc(x.date || x.t || '—') + ' · ' + statePill(st) + '</div>'
        + '<div class="tl-body">' + (x.back != null ? '约 ' + esc(x.back) + ' 日前' : '')
        + (x.from ? ' · 自 ' + esc(x.from) + ' 切换而来' : ' · 快照记录的状态节点') + '</div>'
        + '<div class="tl-outcome">结论后表现：' + perf + '</div></li>';
    });
    var last = e2.lastFlip || {};
    items.push('<li class="tl-item now ' + (STATE_MAP[r.state] ? STATE_MAP[r.state].cls : 'unk') + '"><span class="tl-dot"></span>'
      + '<div class="tl-date">' + stateBlock(r, { click: false }) + ' <span class="cat">当前</span></div>'
      + '<div class="tl-body">已持续约 ' + esc(daysOf(r) != null ? daysOf(r) + ' 个交易日' : '—')
      + (last.from ? ' · 上次由 ' + esc(last.from) + ' 切换' : '') + '；三态为阶段判断，不代表涨跌方向。</div>'
      + '<div class="tl-outcome">' + stateDateTag(r, true) + '</div></li>');
    return '<ul class="tl">' + items.join('') + '</ul>'
      + (hist.length ? '' : '<div class="hint">快照未记录更早的状态切换，以上仅显示当前状态。</div>');
  }
  /* 历史三态演化：用真实前复权日K 逐日重算，展示「三段式」演化带 + 各段切换日期。
   * 与快照当前态相互独立；无日K 时退回提示（由 hydrateInsights 在日K 到位后补绘）。 */
  function historyStateEvolution(r, bars) {
    var sr = stateRuns(bars);
    if (!sr) {
      return '<div class="hint">历史三态演化需要前复权日K（当前未取到）。下方「状态脉络」时间线为快照记录的状态节点；'
        + '生成离线日K 或联网后，本模块会自动按真实日K 逐日重算每日三态。</div>';
    }
    var runs = sr.runs, ds = sr.ds, n = ds.n, close = ds.close;
    var W = 1000, H = 30;
    /* 时间轴：每个连续段一个矩形，宽度严格按「该段占全部交易日的比例」，
       一眼看出各状态持续多久。旧实现把日期文字塞进 flex 窄条，1000+ 天时互相压叠不可读。 */
    var rects = runs.map(function (x) {
      var x0 = x.i0 / n * W;
      var w = Math.max((x.i1 - x.i0 + 1) / n * W, 0.7);
      var g = (close[x.i0] && close[x.i1]) ? (close[x.i1] / close[x.i0] - 1) * 100 : null;
      var tip = x.state + '：' + x.d0 + (x.d0 !== x.d1 ? ' ~ ' + x.d1 : '')
        + ' · ' + x.days + ' 个交易日' + (g != null ? ' · 区间 ' + (g >= 0 ? '+' : '') + g.toFixed(1) + '%' : '');
      return '<rect class="segr seg-' + STATE_MAP[x.state].cls + '" x="' + x0.toFixed(1)
        + '" y="0" width="' + w.toFixed(1) + '" height="' + H + '"><title>' + esc(tip) + '</title></rect>';
    }).join('');
    /* 年份刻度 */
    var ticks = [], lastY = '';
    for (var i = 0; i < n; i++) {
      var y = String(ds.dates[i] || '').slice(0, 4);
      if (/^\d{4}$/.test(y) && y !== lastY) {
        ticks.push('<span style="left:' + (i / n * 100).toFixed(2) + '%">' + y + '</span>');
        lastY = y;
      }
    }
    /* 汇总：每个状态几段、共多少交易日、占比 */
    var order = ['启动', '盘整', '走完'], agg = {};
    runs.forEach(function (x) { var a = agg[x.state] || (agg[x.state] = { seg: 0, days: 0 }); a.seg++; a.days += x.days; });
    var stats = order.map(function (st) {
      var a = agg[st] || { seg: 0, days: 0 }, m = STATE_MAP[st];
      return '<div class="evo2-stat"><span class="dot seg-' + m.cls + '"></span><b>' + st + '</b> '
        + a.seg + ' 段 · ' + a.days + ' 日 · ' + Math.round(a.days / n * 100) + '%</div>';
    }).join('');
    /* 最长的几段「启动」：直接回答「哪段启动持续最久」 */
    var top = runs.filter(function (x) { return x.state === '启动'; })
      .sort(function (a, b) { return b.days - a.days; }).slice(0, 3);
    var topHtml = top.length ? ('<div class="evo2-top"><div class="cat">持续最久的「启动」段</div>'
      + '<table class="evo2-table"><tbody>' + top.map(function (x) {
        var g = (close[x.i0] && close[x.i1]) ? (close[x.i1] / close[x.i0] - 1) * 100 : null;
        return '<tr><td>' + esc(x.d0) + ' ~ ' + esc(x.d1) + '</td><td>' + x.days + ' 交易日</td>'
          + '<td class="' + (g != null && g >= 0 ? 'up' : 'down') + '">'
          + (g != null ? (g >= 0 ? '+' : '') + g.toFixed(1) + '%' : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>') : '';
    var cur = runs[runs.length - 1];
    return '<div class="evo2">'
      + '<div class="evo2-note">逐日重算（<b class="t-launch">蓝＝启动</b> / <b class="t-consol">灰＝盘整</b> / <b class="t-done">橙＝走完</b>）：'
      + '用 <b>' + bars.length + '</b> 根前复权日K 每天判一次，<b>色块宽度＝该状态持续天数</b>，鼠标移到色块可看起止日期与区间涨跌。'
      + '与快照当前态 ' + statePill(r.state) + ' 相互独立。</div>'
      + '<div class="evo2-track"><svg class="evo2-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + rects + '</svg></div>'
      + '<div class="evo2-axis">' + ticks.join('') + '</div>'
      + '<div class="evo2-stats">' + stats + '</div>'
      + topHtml
      + '<div class="evo2-cur">最近一段：' + (cur ? statePill(cur.state) + ' ' + esc(cur.d0) + ' 起，已 ' + cur.days + ' 个交易日' : '—') + '</div>'
      + '<div class="risk-theory">口径：逐日重算为可解释规则代理（六派≥4 看多且站上 MA20→启动；≥4 看空且跌破 MA20→走完；余为盘整），'
      + '与快照「阶段判断」同向但不等同。若与你的直观（如某段明显上涨却标盘整）不符，属规则口径差异，可作复核线索。</div>'
      + '</div>';
  }
  /* 当前位置条：以快照锚点（今日=100）计算区间相对位置，并给出高低位锚点与近似日期 */
  function positionBar(r, bars) {
    var s = Array.isArray(r.series) ? r.series : [];
    var vals = s.map(function (x) { return Number(x[1]); }).filter(isNum);
    if (vals.length < 2) return '';
    var hi = Math.max.apply(null, vals), lo = Math.min.apply(null, vals);
    var pos = hi > lo ? Math.max(0, Math.min(100, (100 - lo) / (hi - lo) * 100)) : 50;
    var hiEntry = s.filter(function (x) { return Number(x[1]) === hi; })[0];
    var loEntry = s.filter(function (x) { return Number(x[1]) === lo; })[0];
    function approxDate(label) {
      var m = /约\s*(\d+)\s*日前/.exec(label || '');
      if (m) { var td = new Date(); td.setDate(td.getDate() - Math.round(Number(m[1]) * 7 / 5)); return td.toISOString().slice(0, 10); }
      if (/今日/.test(label || '')) return new Date().toISOString().slice(0, 10);
      return '—';
    }
    var hiDate = approxDate(hiEntry && hiEntry[0]), loDate = approxDate(loEntry && loEntry[0]);
    return '<div class="posbar-wrap">'
      + '<div class="notice posbar-notice">'
      + '<b>当前位置</b>：在快照锚点区间内的相对分位约 <b>' + fmt(pos, 0) + '%</b>（区间最低 ' + fmt(lo, 1) + ' → 最高 ' + fmt(hi, 1) + '，今日＝100）。'
      + '此为归一化锚点区间，<b>非真实历史最高/最低价</b>，仅供相对位置参考。</div>'
      + '<div class="posbar-new"><div class="posbar-mark" style="left:calc(' + fmt(pos, 1) + '% - 1px)"></div>'
      + '<span class="posbar-cap" style="left:' + fmt(pos, 1) + '%">当前 ▲ ' + fmt(100, 0) + '</span></div>'
      + '<div class="posbar-label">'
      + '<span>区间低位<br><b>' + fmt(lo, 1) + '</b><br><span class="pdate">' + esc(loEntry && loEntry[0] || '—') + '<br>≈ ' + loDate + '</span></span>'
      + '<span style="text-align:center;color:var(--muted)">相对分位 ' + fmt(pos, 0) + '%</span>'
      + '<span style="text-align:right">区间高位<br><b>' + fmt(hi, 1) + '</b><br><span class="pdate">' + esc(hiEntry && hiEntry[0] || '—') + '<br>≈ ' + hiDate + '</span></span>'
      + '</div>'
      + (bars && bars.length > 60 ? '<div class="hint" style="margin-top:6px">另：真实前复权日K 的「区间最高/最低 + 确切日期」见上方「个股历史档案 · 里程碑」（实测高低点，非归一化锚点）。</div>' : '')
      + '</div>';
  }
  function anchorCards(r) {
    var s = Array.isArray(r.series) ? r.series : [];
    if (!s.length) return '';
    return '<div class="anchor-row">' + s.map(function (x) {
      return '<div class="anchor"><div class="l">' + esc(x[0]) + '</div><div class="v">' + fmt(Number(x[1]), 1) + '</div>'
        + '<div class="l">至今 <span class="' + signCls(Number(x[2])) + '">' + pct(Number(x[2])) + '</span></div></div>';
    }).join('') + '</div>';
  }
  /* ---------- 个股历史档案（前世今生独有能力，不复用透镜组件） ----------
   * GitHub 参考：Vibe-Research「K线 + 事件回看 + 每项数字带证据/计算ID」、
   * Apex-Analysis / kirot2026/stock-quant-analysis「区间收益 / 最大涨幅 / 最大跌幅 /
   * 波动率 / 最大回撤」、Stock-Market-Analysis-using-R「drawdown underwater / 52周高低」。
   * 全部由全量前复权日K 客观推导；日K 不可用时明确标缺口，不用快照锚点编造数字。 */
  function historyArchive(r, bars) {
    /* 指数没有复权概念，点位本身就是连续序列；文案不能沿用它"前复权"的说法，
       否则用户会以为指数也做过除权处理。 */
    var isIdx = !!(r && r.kind === 'index');
    var PX = isIdx ? '点位' : '前复权价';
    if (!bars || bars.length < 60) {
      return '<div class="ind-empty"><b>历史档案需要' + (isIdx ? '指数日K' : '前复权日K') + '，当前未取到</b>'
        + '<div>已尝试 离线静态 kline.js / 东财 push2his / 东财 push2 / 腾讯 fqkline / 新浪。'
        + '缺口如实标注，不以快照锚点冒充历史行情。生成离线日K 后本模块会自动补全。</div></div>';
    }
    var n = bars.length, i, j;
    var c = bars.map(function (b) { return b.c; });
    var h = bars.map(function (b) { return isNum(b.h) && b.h > 0 ? b.h : b.c; });
    var l = bars.map(function (b) { return isNum(b.l) && b.l > 0 ? b.l : b.c; });
    var d = bars.map(function (b) { return b.d; });
    var v = bars.map(function (b) { return isNum(b.v) ? b.v : 0; });
    var hi = -Infinity, lo = Infinity, hiI = 0, loI = 0;
    for (i = 0; i < n; i++) { if (h[i] > hi) { hi = h[i]; hiI = i; } if (l[i] < lo) { lo = l[i]; loI = i; } }
    var last = c[n - 1];
    /* 最大回撤（收盘口径）与修复天数 */
    var peak = c[0], peakI = 0, maxDD = 0, ddP = 0, ddT = 0;
    for (i = 0; i < n; i++) {
      if (c[i] > peak) { peak = c[i]; peakI = i; }
      var dd = (c[i] / peak - 1) * 100;
      if (dd < maxDD) { maxDD = dd; ddP = peakI; ddT = i; }
    }
    var repair = null;
    for (i = ddT + 1; i < n; i++) { if (c[i] >= c[ddP]) { repair = i - ddT; break; } }
    /* 年度 / 区间表现 */
    var years = {}, order = [];
    for (i = 0; i < n; i++) {
      var y = String(d[i]).slice(0, 4);
      if (!years[y]) { years[y] = { s: c[i], e: c[i], first: d[i], last: d[i] }; order.push(y); }
      years[y].e = c[i]; years[y].last = d[i];
    }
    var yearRows = order.slice(-6).map(function (y) {
      var o = years[y], rr = (o.e / o.s - 1) * 100;
      return '<tr><td>' + esc(y) + '</td><td class="' + signCls(rr) + '">' + pct(rr) + '</td>'
        + '<td class="cat">' + esc(o.first) + ' ~ ' + esc(o.last) + '</td></tr>';
    }).join('');
    /* 年化波动率（20 / 60 日） */
    function annualVol(k) {
      var rs = [], t, m, s = 0;
      for (t = Math.max(1, n - k); t < n; t++) { if (c[t - 1] > 0) rs.push((c[t] / c[t - 1] - 1) * 100); }
      if (rs.length < 5) return null;
      m = rs.reduce(function (a, b) { return a + b; }, 0) / rs.length;
      rs.forEach(function (x) { s += (x - m) * (x - m); });
      return Math.sqrt(s / (rs.length - 1)) * Math.sqrt(250);
    }
    var v20 = annualVol(20), v60 = annualVol(60);
    /* 放量异动日 Top5（量 / 前20日均量） */
    var spikes = [];
    for (i = 20; i < n; i++) {
      var a = 0; for (j = i - 20; j < i; j++) a += v[j];
      a = (a / 20) || 1;
      var mult = v[i] / a;
      if (mult >= 1.8 && c[i - 1] > 0) spikes.push({ i: i, mult: mult, chg: (c[i] / c[i - 1] - 1) * 100 });
    }
    spikes.sort(function (a, b) { return b.mult - a.mult; });
    spikes = spikes.slice(0, 5);
    var spikeHtml = spikes.length ? '<table class="st-table"><thead><tr><th>日期</th><th>量能倍数</th><th>当日涨跌</th></tr></thead><tbody>'
      + spikes.map(function (x) {
        return '<tr><td>' + esc(d[x.i]) + '</td><td>' + fmt(x.mult, 1) + '×</td>'
          + '<td class="' + signCls(x.chg) + '">' + pct(x.chg) + '</td></tr>';
      }).join('') + '</tbody></table>' : '<div class="hint">覆盖区间内无 ≥1.8× 的量能异动日。</div>';
    /* 里程碑时间线 */
    var ms = [
      { t: '档案起点', d: d[0], x: '覆盖第一根' + PX + '日K，收盘 <b>' + fmt(c[0], 2) + '</b>' },
      { t: '区间最高', d: d[hiI], x: PX + '最高 <b>' + fmt(hi, 2) + '</b>，当前较该点 <b class="' + signCls((last / hi - 1) * 100) + '">' + pct((last / hi - 1) * 100) + '</b>' },
      { t: '区间最低', d: d[loI], x: PX + '最低 <b>' + fmt(lo, 2) + '</b>，当前较该点 <b class="' + signCls((last / lo - 1) * 100) + '">' + pct((last / lo - 1) * 100) + '</b>' },
      { t: '最大回撤', d: d[ddP] + ' ~ ' + d[ddT], x: '<b class="down">' + pct(maxDD) + '</b>（' + (repair != null ? '修复约 ' + repair + ' 交易日' : '区间内尚未修复') + '）' }
    ];
    var msHtml = '<div class="tl">' + ms.map(function (x) {
      return '<li class="tl-item"><span class="tl-dot"></span><div class="tl-date">' + esc(x.t) + ' · ' + esc(x.d) + '</div>'
        + '<div class="tl-body">' + x.x + '</div></li>';
    }).join('') + '</div>';
    var kpiHtml = '<div class="kpis">'
      + kpi('档案覆盖', n + ' 根日K', esc(d[0]) + ' ~ ' + esc(d[n - 1])
        + (n > 900 ? '（上市至今）' : '（约 ' + Math.round(n / 250 * 10) / 10 + ' 年）'))
      + kpi('区间最高', fmt(hi, 2), esc(d[hiI]))
      + kpi('区间最低', fmt(lo, 2), esc(d[loI]))
      + kpi('最大回撤', '<span class="down">' + pct(maxDD) + '</span>', repair != null ? '修复 ' + repair + ' 交易日' : '未修复')
      + kpi('20日年化波动', v20 != null ? fmt(v20, 1) + '%' : '—', '由日收益标准差年化')
      + kpi('60日年化波动', v60 != null ? fmt(v60, 1) + '%' : '由日收益标准差年化')
      + '</div>';
    return '<div class="archive">'
      + '<div class="arch-sum">以下每项均由 <b>' + n + ' 根' + (isIdx ? '指数日K' : '前复权日K') + '</b> 现场计算，'
      + '覆盖 ' + esc(d[0]) + ' ~ ' + esc(d[n - 1]) + '；不含财报 / 估值 / 同行数据（DATA 快照无这些字段，缺口如实标注）。</div>'
      + kpiHtml
      + '<div class="section-title" style="margin:16px 0 8px"><h2 style="font-size:14px">里程碑 · 事件回看</h2>'
      + '<span class="desc">区间起点 / 历史高低点 / 最大回撤</span></div>' + msHtml
      + '<div class="two-col" style="margin-top:14px"><div>'
      + '<div class="section-title"><h2 style="font-size:14px">年度表现</h2><span class="desc">按自然年首尾收盘</span></div>'
      + '<table class="st-table"><thead><tr><th>年份</th><th>区间涨跌</th><th>覆盖区间</th></tr></thead><tbody>' + yearRows + '</tbody></table>'
      + '</div><div>'
      + '<div class="section-title"><h2 style="font-size:14px">放量异动日 Top5</h2><span class="desc">相对前20日均量 ≥1.8×</span></div>'
      + spikeHtml + '</div></div>'
      + '<div class="risk-theory">口径：' + (isIdx ? '指数点位' : '前复权价格') + '、收盘价计算回撤与年度收益，日内最高/最低用于高低点；'
      + '波动率为日收益标准差 × √250；量能倍数 = 当日成交量 / 前20日均量。'
      + '以上为<b>客观历史统计</b>，样本区间即上方覆盖区间，<b>不构成投资建议，不预示未来收益</b>。</div>'
      + '</div>';
  }
  function sixEvidence(r) {
    var e2 = r.e2 || {}, v = e2.votes || {}, ev = Array.isArray(e2.evidence) ? e2.evidence : [];
    var tm = {}; sixTimingRows(r).forEach(function (x) { tm[x.k] = x; });
    var rows = SIX.map(function (s) {
      var o = v[s.k] || {}, t = tm[s.k] || {};
      var dir = o.dir != null ? o.dir : votesOf(r)[s.k];
      var ic = dir === 1 ? '✓' : (dir === -1 ? '✗' : '—');
      var cls = dir === 1 ? 'bull' : (dir === -1 ? 'bear' : 'mid');
      var when = '<span class="evi-date">依据 ' + esc(t.asOf || '—') + ' 收盘数据</span>';
      /* 该派针对本标的的历史胜率（逐日重算的前瞻统计），由 hydrateInsights 异步水合 */
      var wr = '<span class="evi-wr" data-evi-wr="' + esc(r.code) + '|' + s.k + '">'
        + '历史胜率：加载中日K（约数秒）…</span>';
      if (s.k === 'news') {
        return '<div class="evi-row"><span class="p">' + s.n + '</span><span class="tag ' + cls + '"><span class="ic">' + ic + '</span></span>'
          + '<span data-news-vote>' + esc(t.txt || sixEvidenceText(r, s.k)) + '</span></div>';
      }
      return '<div class="evi-row"><span class="p">' + s.n + '</span><span class="tag ' + cls + '"><span class="ic">' + ic + '</span></span>'
        + '<span>' + esc(t.txt || sixEvidenceText(r, s.k)) + ' ' + when + wr + '</span></div>';
    }).join('');
    var _sc = r.scores || {};
    var _cand = [
      ['结构', _sc.structure], ['量价', _sc.volume], ['资金', _sc.fund],
      ['情绪', _sc.senti], ['配置', _sc.config]
    ].filter(function (x) { return isNum(x[1]) && Math.abs(x[1]) >= 0.1; })
      .sort(function (a, b) { return Math.abs(b[1]) - Math.abs(a[1]); }).slice(0, 3);
    var ev2 = _cand.map(function (x) {
      return { p: x[0] + ' ' + (x[1] > 0 ? '+' : '') + fmt(x[1], 2), txt: sixEvidenceText(r, { '结构': 'structure', '量价': 'volume', '资金': 'fund', '情绪': 'senti', '配置': 'config' }[x[0]]) };
    });
    var top = ev2.map(function (e) {
      return '<div class="evi-row"><span class="p">' + esc(e.p || '证据') + '</span><span>' + esc(e.txt || '') + '</span></div>';
    }).join('');
    return '<div class="evi">' + rows + '</div>'
      + (top ? '<div class="section-title" style="margin:14px 0 8px"><h2 style="font-size:14px">决定性证据 Top 3</h2></div><div class="evi">' + top + '</div>' : '')
      + (e2.divergence ? '<div class="notice">分歧提示：' + esc(typeof e2.divergence === 'string' ? e2.divergence : JSON.stringify(e2.divergence)) + '</div>' : '');
  }
  function monitorList(r) {
    var e2 = r.e2 || {}, p = r.pct || {}, items = [];
    if (e2.falsify && e2.falsify.txt) items.push('三态判断的失效条件：' + e2.falsify.txt);
    if (sinceOf(r)) items.push('当前状态自 ' + sinceOf(r) + ' 起，已持续约 ' + (daysOf(r) != null ? daysOf(r) + ' 个交易日' : '—') + '；可核对状态是否切换。');
    ['w5', 'w20', 'w60', 'w250'].forEach(function (k) {
      if (isNum(p[k]) && p[k] < 0) items.push(({ w5: '近5日', w20: '近20日', w60: '近60日', w250: '近250日' }[k]) + ' 区间为负（' + pct(p[k]) + '），动量偏弱。');
    });
    if (r.newsMain && r.newsMain.name) items.push('舆情' + (r.newsMain.level === '行业级' ? '行业' : '个股命中')
      + '「' + r.newsMain.name + '」' + (isNum(r.newsMain.surge)
        ? '激增 ' + fmt(r.newsMain.surge, 1) + '×'
        : '当日真实资讯 ' + (r.newsMain.n1 || 0) + ' 条 / ' + (r.newsMain.mediaN || 0) + ' 家（基线未就绪，不判倍数）')
      + '；可核对资讯密度是否回落。');
    if (Array.isArray(r.veto) && r.veto.length) items.push('快照记录 ' + r.veto.length + ' 项否决/风险标记：' + r.veto.map(function (x) { return esc(typeof x === 'string' ? x : JSON.stringify(x)); }).join('、'));
    if (!items.length) items.push('暂无额外监控项，请以最新快照与实时行情为准。');
    return '<ul class="monitor-list">' + items.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
      + '<div class="notice">以上为<b>客观事实核对项</b>，用于观察状态是否变化，<b>不构成买卖建议</b>；本工具不提供仓位或止损指令。</div>';
  }
  function identityHtml(r) {
    function row(l, v) { return '<div class="evi-row"><span class="p">' + l + '</span><span>' + (v != null && v !== '' ? esc(v) : '—') + '</span></div>'; }
    var rows = [
      row('类型', typeLabel(r)), row('板块 / 行业', (r.l1 ? r.l1 + ' / ' : '') + (r.ind || '—')),
      row('快照时点', r.asOf), row('数据来源', r.src),
      row('覆盖层级', r.tier === 'core' ? '核心池' : (r.tier === 'ext' ? '扩展池' : r.tier))
    ];
    if (typeLabel(r) === 'ETF') {
      rows.push(row('跟踪指数', r.index));
      rows.push(row('规模', r.size != null ? fmt(Number(r.size), 1) + ' 亿' : null));
      rows.push(row('费率', r.fee != null ? fmt(Number(r.fee), 2) + '%' : null));
    } else {
      rows.push(row('总市值', isNum(r.mcap) ? fmt(r.mcap, 1) + ' 亿' : null));
      rows.push(row('关联 ETF', r.etfLinkName ? r.etfLinkName + '（' + r.etfLink + '）' : null));
    }
    if (r.indInfo && r.indInfo.name) rows.push(row('所属行业指数', r.indInfo.name + ' · ' + r.indInfo.code));
    return '<div class="evi">' + rows.join('') + '</div>';
  }

  /* ---------- 公司档案：比 F10 更好读的「一页看懂」 ----------
   * 数据来源：东财 datacenter F10 主报表（营收 / 净利 / 毛利 / ROE / 负债 / 现金流）+ 本地快照（市值 / 行业 / 三态 / 六派）。
   * 编辑视角的三条原则：
   *   1) 先给结论句，再给数字 —— 读者先知道"这是家什么公司、贵不贵、赚不赚钱"；
   *   2) 每个数字都带比较基准（行业排名 / 全 A 排名 / 同比），孤立数字没有意义；
   *   3) 缺口如实写，不估算、不用 0 填充。
   */
  var RANK_CACHE = null;
  function rankMaps() {
    if (RANK_CACHE) return RANK_CACHE;
    var recs = DS.allRecords().filter(function (r) { return isNum(r.mcap) && r.mcap > 0; });
    var all = recs.slice().sort(function (a, b) { return b.mcap - a.mcap; });
    var rankAll = {}, byInd = {};
    all.forEach(function (r, i) {
      rankAll[r.code] = i + 1;
      var g = r.ind || '—';
      (byInd[g] = byInd[g] || []).push(r);
    });
    var rankInd = {}, indSize = {};
    Object.keys(byInd).forEach(function (g) {
      byInd[g].sort(function (a, b) { return b.mcap - a.mcap; });
      indSize[g] = byInd[g].length;
      byInd[g].forEach(function (r, i) { rankInd[r.code] = i + 1; });
    });
    RANK_CACHE = { all: rankAll, ind: rankInd, indSize: indSize, total: all.length };
    return RANK_CACHE;
  }
  function lastPriceOf(r) {
    var q = QUOTES[r.code];
    if (q && isNum(q.price)) return q.price;
    var c = r.closes;
    if (Array.isArray(c) && c.length) return c[c.length - 1];
    return null;
  }
  function quartersOf(dateStr) {
    var m = Number(String(dateStr || '').slice(5, 7));
    return m === 3 ? 1 : (m === 6 ? 2 : (m === 9 ? 3 : 4));
  }
  function yiOf(v) { return v == null ? '—' : fmt(v / 1e8, 1) + ' 亿'; }
  function spct(v, d) { return v == null ? '—' : (v >= 0 ? '+' : '') + fmt(v, d == null ? 1 : d) + '%'; }
  function grade(v, hi, mid, reverse) {
    if (v == null) return '';
    if (reverse) return v <= hi ? 'good' : (v <= mid ? 'mid' : 'bad');
    return v >= hi ? 'good' : (v >= mid ? 'mid' : 'bad');
  }
  /* 一句话画像：把散数字压成一句人话，每个判断都能指回具体数据 */
  function oneLiner(r, fin) {
    var c = fin && fin.cur; if (!c) return '';
    var rk = rankMaps(), price = lastPriceOf(r);
    var q = rk.all[r.code], tot = rk.total;
    var ir = rk.ind[r.code], iz = rk.indSize[r.ind || '—'];
    var pe = (price && isNum(c.eps) && c.eps > 0) ? price / (c.eps * 4 / quartersOf(c.date)) : null;
    var pb = (price && isNum(c.bps) && c.bps > 0) ? price / c.bps : null;
    var bits = [];
    bits.push('一家' + (r.ind ? '「' + r.ind + '」' : '') + '公司');
    if (q) bits.push('总市值 ' + fmt(r.mcap, 0) + ' 亿，全 A 第 ' + q + ' / ' + tot + (ir ? '、行业内第 ' + ir + ' / ' + iz : ''));
    if (c.grossPct != null) bits.push('毛利率 ' + fmt(c.grossPct, 1) + '%' + (c.grossPct >= 60 ? '（强定价权）' : (c.grossPct >= 30 ? '（中等）' : '（偏薄，靠规模与周转）')));
    if (c.roe != null) bits.push('ROE ' + fmt(c.roe, 1) + '%' + (c.roe >= 15 ? '（赚钱效率高）' : (c.roe >= 8 ? '（一般）' : '（偏低）')));
    if (fin.revYoy != null || fin.profitYoy != null) {
      var rv = fin.revYoy, pf = fin.profitYoy;
      var tone = ((rv != null && rv < 0) || (pf != null && pf < 0)) ? '增速已转弱' : ((rv != null && rv > 20) ? '仍在快跑' : '增长平缓');
      bits.push('最新报告期营收 ' + spct(rv) + '、净利 ' + spct(pf) + '（' + tone + '）');
    }
    if (pe != null) bits.push('PE(年化) ' + fmt(pe, 1) + '×' + (pe > 60 ? '（偏贵）' : (pe < 15 ? '（偏低）' : '（中性）')) + (pb != null ? '、PB ' + fmt(pb, 2) + '×' : ''));
    if (r.state) bits.push('技术面三态为「' + r.state + '」，已 ' + (daysOf(r) != null ? (r.stateCapped ? '≥' : '') + daysOf(r) : '—') + ' 个交易日，六派 ' + bullCount(r) + '/6 看启动');
    return bits.join('；') + '。';
  }
  function perfBars(fin) {
    var rows = (fin.rows || []).slice(0, 8).reverse();
    if (!rows.length) return '';
    var maxRev = Math.max.apply(null, rows.map(function (x) { return Math.abs(x.rev || 0); })) || 1;
    var maxPf = Math.max.apply(null, rows.map(function (x) { return Math.abs(x.profit || 0); })) || 1;
    var cells = rows.map(function (x) {
      var rw = Math.round((x.rev || 0) / maxRev * 100);
      var pw = Math.round((x.profit || 0) / maxPf * 100);
      return '<div class="pb-col" title="' + esc((x.name || '') + ' 营收 ' + yiOf(x.rev) + ' 净利 ' + yiOf(x.profit)) + '">'
        + '<div class="pb-bars">'
        + '<div class="pb-b rev" style="height:' + Math.max(2, rw) + '%"></div>'
        + '<div class="pb-b pf" style="height:' + Math.max(2, pw) + '%"></div>'
        + '</div><div class="pb-x">' + esc(String(x.name || '').replace('报', '')) + '</div>'
        + '<div class="pb-y">' + (x.rev != null ? fmt(x.rev / 1e8, 0) : '—') + '</div></div>';
    }).join('');
    return '<div class="perf-bars">' + cells + '</div>'
      + '<div class="perf-legend"><span class="lg rev"></span>营业总收入（亿元）<span class="lg pf"></span>归母净利润（亿元）</div>';
  }
  /* ---------- 筹码分布（CYQ 近似）+ 估值位置 ----------
   * 借鉴 simonlin1212/a-stock-data 的「筹码分布 CYQ 本地计算」思路：
   * 不依赖任何付费接口，用「每日成交量按当日 [最低, 最高] 均匀分布」把量摊到价格轴上，
   * 得到获利盘比例 / 平均成本 / 90% 成本区间 / 集中度。
   * 这是近似法（不是交易所逐笔筹码），页面会明确标注口径与窗口，不吹成精确值。
   */
  function cyqOf(bars, price) {
    if (!Array.isArray(bars) || bars.length < 60) return null;
    var use = bars.slice(-250);
    var lo = Infinity, hi = -Infinity, i;
    use.forEach(function (b) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; });
    if (!(hi > lo) || !isNum(price) || price <= 0) return null;
    var NB = 80, bins = new Array(NB), step = (hi - lo) / NB;
    for (i = 0; i < NB; i++) bins[i] = 0;
    use.forEach(function (b) {
      var v = isNum(b.v) && b.v > 0 ? b.v : 0;
      if (!v) return;
      var a = Math.max(0, Math.floor((b.l - lo) / step));
      var z = Math.min(NB - 1, Math.floor((b.h - lo) / step));
      var n = z - a + 1;
      for (var k = a; k <= z; k++) bins[k] += v / n;
    });
    var total = bins.reduce(function (s, x) { return s + x; }, 0);
    if (!total) return null;
    var cum = 0, below = 0, avgNum = 0, p05 = null, p95 = null;
    for (i = 0; i < NB; i++) {
      var mid = lo + step * (i + 0.5), share = bins[i] / total;
      cum += share; avgNum += mid * share;
      if (mid <= price) below += share;
      if (p05 == null && cum >= 0.05) p05 = mid;
      if (p95 == null && cum >= 0.95) p95 = mid;
    }
    return {
      window: use.length + ' 个交易日',
      lo: lo, hi: hi, avg: avgNum, profit: below,
      p05: p05 == null ? lo : p05, p95: p95 == null ? hi : p95,
      conc: (p95 != null && avgNum > 0) ? (p95 - (p05 == null ? lo : p05)) / avgNum : null,
      bins: bins, step: step
    };
  }
  function cyqHtml(c, price, isIdx) {
    var U = isIdx ? '点' : '元';
    if (!c) {
      return '<div class="ds-h">筹码分布 <span class="cat">日K 不足 60 根，无法估算</span></div>'
        + '<div class="hint">筹码分布需要足够长的日K 才能摊量；该标的日K 不足或未取到。</div>';
    }
    var max = Math.max.apply(null, c.bins) || 1;
    var bars = c.bins.map(function (v, i) {
      var p = c.lo + c.step * (i + 0.5);
      var inRange = p >= c.p05 && p <= c.p95;
      return '<div class="cyq-b' + (inRange ? '' : ' out') + (p <= price ? ' win' : '') + '" style="height:'
        + Math.max(1, Math.round(v / max * 100)) + '%" title="' + fmt(p, 2) + ' ' + U + ' · 占 ' + fmt(v / (c.bins.reduce(function (s, x) { return s + x; }, 0)) * 100, 1) + '%"></div>';
    }).join('');
    function pc(v) { return fmt(v * 100, 1) + '%'; }
    return '<div class="ds-h">筹码分布 <span class="cat">' + esc(c.window) + ' · 按每日 [最低, 最高] 均匀摊量（近似法）' + (isIdx ? ' · 指数按点位摊量' : '') + '</span></div>'
      + '<div class="pl">通俗说：把这段时间每天的成交按"当时的价格"摊开，看<b>'
      + (isIdx ? '有多少筹码的成本低于当前点位' : '有多少人买得比你便宜') + '</b>。'
      + (isIdx ? '成本低于现价＝这部分筹码浮盈（获利后可能兑现）；成本高于现价＝上方存在抛压。'
               : '获利盘高＝多数人赚钱（但一旦下跌容易集中卖出）；获利盘低＝多数人被套（反弹到成本区会有抛压）。') + '</div>'
      + '<div class="cyq-wrap">'
      + '<div class="cyq-chart"><div class="cyq-bars">' + bars + '</div>'
      + '<div class="cyq-axis"><span>' + fmt(c.lo, 2) + '</span><span>' + (isIdx ? '当前 ' : '现价 ') + fmt(price, 2) + '</span><span>' + fmt(c.hi, 2) + '</span></div></div>'
      + '<div class="cyq-kpi">'
      + '<div class="cs"><div class="k">获利盘</div><div class="v ' + (c.profit > 0.7 ? 'good' : (c.profit < 0.3 ? 'bad' : 'mid')) + '">' + pc(c.profit) + '</div><div class="s">' + (isIdx ? '点位低于当前点位的成交占比' : '现价以下的筹码占比') + '</div></div>'
      + '<div class="cs"><div class="k">平均成本</div><div class="v">' + fmt(c.avg, 2) + '</div><div class="s">' + (isIdx ? '点位' : '现价') + (price >= c.avg ? '高于' : '低于') + '平均成本 ' + spct((price / c.avg - 1) * 100) + '</div></div>'
      + '<div class="cs"><div class="k">90% 成本区间</div><div class="v" style="font-size:13px">' + fmt(c.p05, 2) + ' ~ ' + fmt(c.p95, 2) + '</div><div class="s">' + (isIdx ? '密集成交区参考' : '套牢盘压力位参考') + '</div></div>'
      + '<div class="cs"><div class="k">集中度</div><div class="v">' + (c.conc != null ? fmt(c.conc * 100, 1) + '%' : '—') + '</div><div class="s">越小越集中（越易单边）</div></div>'
      + '</div></div>';
  }
  /* 估值位置：从「近一年」改为「尽可能长的历史」。
     关键是不能拿今天的 EPS 去除十年前的股价——那样算出来的 PE 是错的。
     所以按报告期分段：每根日K 用「该日之前最近一期已公布的 EPS/BPS」折算，
     财报覆盖不到的更早区间直接跳过并如实标注，不用当前值硬凑。 */
  function valPosOf(bars, fin, price) {
    var c = fin && fin.cur; if (!c || !Array.isArray(bars) || bars.length < 60) return null;
    /* PIT：一份财报只有「公告之后」才算可知。用 NOTICE_DATE（公告日）作为生效日，
       而不是报告期（REPORT_DATE）—— 否则 9 月底的季报会被当成 9 月就能看到，
       回看那段区间时等于用了未来信息。缺公告日的老数据退回报告期并标注。 */
    function avail(x) { return String((x && (x.notice || x.date)) || '').slice(0, 10); }
    var rows = (fin.rows || []).filter(function (x) { return x && (x.notice || x.date); }).slice()
      .sort(function (a, b) { return avail(a) < avail(b) ? -1 : 1; });
    if (!rows.length) rows = [c];
    function snapAt(d, key, annual) {
      var pick = null;
      for (var i = 0; i < rows.length; i++) {
        var x = rows[i];
        if (avail(x) <= d && isNum(x[key]) && x[key] > 0) pick = x;
      }
      if (!pick) return null;                 // 早于最早一期财报：不给，不猜
      return annual ? pick[key] * 4 / quartersOf(pick.date) : pick[key];
    }
    var lastD = String(bars[bars.length - 1].d).slice(0, 10);
    function series(key, annual) {
      var arr = [], from = null;
      for (var i = 0; i < bars.length; i++) {
        var d = String(bars[i].d).slice(0, 10);
        var base = snapAt(d, key, annual);
        if (!base) continue;
        var v = bars[i].c / base;
        if (!isFinite(v) || v <= 0) continue;
        if (!from) from = d;
        arr.push(v);
      }
      if (arr.length < 40) return null;
      var nowBase = snapAt(lastD, key, annual);
      if (!nowBase) return null;
      var now = price / nowBase;
      var below = arr.filter(function (v) { return v <= now; }).length;
      var sorted = arr.slice().sort(function (a, b) { return a - b; });
      return {
        now: now, pct: below / arr.length,
        min: sorted[0], max: sorted[sorted.length - 1],
        med: sorted[Math.floor(sorted.length / 2)],
        from: from, to: lastD, n: arr.length
      };
    }
    var peS = series('eps', true), pbS = series('bps', false);
    if (!peS && !pbS) return null;
    var main = peS || pbS;
    return { pe: peS, pb: pbS, n: main.n, from: main.from, to: main.to };
  }
  /* ---------- 贵不贵：把五个维度合成一个可解释的结论 ----------
   * 用户要的是两个答案：现在贵了，还是便宜了。所以这里不做"综合评分"了事，
   * 而是先给倾向，再逐条列出每个维度的证据（每一条都能点开核对）。
   */
  function cheapnessHtml(fin, r, vp, price, bars) {
    /* 指数没有 PE/PB/每股收益，也没有"行业 PE 中位"可对标：
       强行套个股那五档结论会把指数的点位当成股价来评贵贱。这里直接不出结论，
       改由 indexPosHtml 用「点位在近一年区间的位置」说话。 */
    if (r && r.kind === 'index') return '';
    var c = fin && fin.cur;
    var rows = [], score = 0;
    var pe = (isNum(r.pe) && r.pe > 0) ? r.pe : null;
    var pb = (isNum(r.pb) && r.pb > 0) ? r.pb : null;
    var indPE = ((RAW().meta || {}).indPE || {})[r.ind];
    /* 进度条的宽度必须是「真实分位」（0~100%），不能再用评分 delta ——
       旧写法里 67% 的 PE 分位落在中间地带，delta=0 → 宽度 0%，条是空的，
       数字写着 67% 却什么都没有，非常容易被当成 bug。颜色另由 delta 决定。 */
    function push(label, val, pctv, note, delta) {
      score += delta;
      var w = Math.max(1.5, Math.min(100, isNum(pctv) ? pctv * 100 : 0));
      rows.push('<div class="vp-row"><div class="vp-t">' + label + '</div>'
        + '<div class="vp-bar"><div class="vp-fill ' + (delta < 0 ? 'good' : (delta > 0 ? 'bad' : 'mid'))
        + '" style="width:' + Math.round(w) + '%"></div></div>'
        + '<div class="vp-v"><b class="' + (delta < 0 ? 'good' : (delta > 0 ? 'bad' : 'mid')) + '">' + val + '</b>'
        + '<span class="cat">' + note + '</span></div></div>');
    }
    if (vp && vp.pe) {
      var q = vp.pe.pct;
      push('PE 分位', Math.round(q * 100) + '%', q, '历史（' + esc(vp.from || '') + ' 起）自己的 PE 位置，越低越便宜',
        q >= 0.8 ? 1 : (q <= 0.2 ? -1 : 0));
    }
    if (vp && vp.pb) {
      var q2 = vp.pb.pct;
      push('PB 分位', Math.round(q2 * 100) + '%', q2, '历史自己的 PB 位置',
        q2 >= 0.8 ? 0.5 : (q2 <= 0.2 ? -0.5 : 0));
    }
    if (pe && indPE) {
      var rel = pe / indPE - 1;
      /* 「vs 行业」容易看不懂，换成「比同行贵/便宜」，并把两个数并排摆出来 */
      push('比同行', (rel >= 0 ? '贵 ' : '便宜 ') + fmt(Math.abs(rel) * 100, 0) + '%',
        Math.min(1, Math.max(0, (rel + 0.5) / 1.0)),
        '本股 PE ' + fmt(pe, 1) + '×，同行中位数 ' + fmt(indPE, 1) + '×（' + esc(r.ind) + '）',
        rel >= 0.25 ? 1 : (rel <= -0.2 ? -1 : 0));
    }
    if (pe && c && isNum(fin.profitYoy) && fin.profitYoy > 0) {
      var peg = pe / fin.profitYoy;
      push('PEG', fmt(peg, 2), Math.min(1, Math.max(0, (peg - 0.5) / 2.5)),
        'PEG＝市盈率 ÷ 净利增速（当前净利同比 ' + fmt(fin.profitYoy, 1) + '%）。'
        + '小于 1 说明增长跟得上估值，大于 2 说明贵得有点勉强',
        peg >= 2 ? 1 : (peg <= 1 ? -1 : 0));
    }
    if (Array.isArray(bars) && bars.length >= 200 && price > 0) {
      var use = bars.slice(-250), sum = 0;
      use.forEach(function (b) { sum += b.c; });
      var ma = sum / use.length, dev = (price / ma - 1) * 100;
      push('距年线', (dev >= 0 ? '+' : '') + fmt(dev, 1) + '%',
        Math.max(0, Math.min(1, (dev + 30) / 60)),
        '年线＝过去 250 个交易日的平均价（' + fmt(ma, 2) + '）。现价比它'
        + (dev >= 0 ? '高 ' : '低 ') + fmt(Math.abs(dev), 1) + '%，'
        + (dev >= 25 ? '已经离得很远，追高风险大' : (dev <= -15 ? '明显在年线下方，属于弱势区' : '在年线附近，属于正常波动')),
        dev >= 25 ? 0.5 : (dev <= -15 ? -0.5 : 0));
    }
    if (!rows.length) return '';
    var verdict, cls, advice;
    if (score <= -1.5) { verdict = '偏便宜'; cls = 'good'; advice = '多数维度同时指向「低于自身常态」，属于可以认真研究的位置；但便宜也可能有便宜的原因，先确认业绩是否在恶化。'; }
    else if (score <= -0.5) { verdict = '略偏便宜'; cls = 'good'; advice = '部分维度偏低，尚不极端，可等更明确的信号。'; }
    else if (score < 0.5) { verdict = '大致合理'; cls = 'mid'; advice = '各项指标都在自身常态附近，价格没有明显的贵或便宜。'; }
    else if (score < 1.5) { verdict = '略偏贵'; cls = 'mid'; advice = '部分维度偏高，需要业绩继续兑现来消化。'; }
    else { verdict = '偏贵'; cls = 'bad'; advice = '多数维度同时指向「高于自身常态」，对业绩兑现的要求很高，一旦不达预期回撤会很快。'; }
    return '<div class="ds-h">现在贵还是便宜 <span class="cat">五个维度合成，逐条可核对</span></div>'
      + '<div class="cheap-head ' + cls + '"><div class="ch-v">' + verdict + '</div>'
      + '<div class="ch-s">' + advice + '</div></div>'
      + '<div class="vp-wrap">' + rows.join('') + '</div>'
      + '<div class="pl">通俗说：<b>PE 分位 99%</b> 就是"有记录的这段时间里，只有 1% 的日子比现在更贵"；'
      + '分位越低越便宜。<b>PEG</b> 是"你为每 1% 的增长付了多少钱"，小于 1 说明增长没被高估。</div>'
      + '<div class="hint">说明：分位按<b>各报告期的 EPS/BPS 分段折算</b>（不是拿今天的 EPS 反推历史，那样会算错），'
      + '所以区间长度＝有财报可对上的那段，通常比「近一年」长得多，也不受单一年份极端行情主导；'
      + '行业对比取同行业 PE 中位数（亏损股不参与）；PEG 仅在净利同比为正时给。'
      + '五个维度方向一致时结论更可靠，互相打架时以「偏贵/偏便宜」的措辞保留分歧。</div>';
  }
  /* 指数的「位置」：指数没有 PE / PB / EPS，唯一的客观标尺是点位自己在历史区间里排第几。
     这里只描述位置，不给「贵 / 便宜」——没有盈利口径还谈贵贱是伪精度。 */
  function indexPosHtml(r, bars, price) {
    if (!Array.isArray(bars) || bars.length < 60 || !(price > 0)) {
      return '<div class="ds-h">点位位置 <span class="cat">日K 不足 60 根，无法计算</span></div>'
        + '<div class="hint">点位分位需要足够长的日K；当前样本不足，缺口如实标注，不用估值口径凑数。</div>';
    }
    /* 分位用「全部可用日K」（指数能取到约 800 根，够覆盖一轮完整周期）；
       年线仍只用最后 250 根，两者不能混——否则「vs 年线」会变成 vs 历史均价。 */
    var cs = [], from = null, ds = [];
    bars.forEach(function (b) {
      if (isNum(b.c) && b.c > 0) { cs.push(b.c); ds.push(String(b.d).slice(0, 10)); }
    });
    if (cs.length < 40) return '';
    if (ds.length) from = ds[0];
    var lowN = 0, lo = Infinity, hi = -Infinity;
    cs.forEach(function (v) { if (v <= price) lowN++; if (v < lo) lo = v; if (v > hi) hi = v; });
    var tail = cs.slice(-250), sum = 0;
    tail.forEach(function (v) { sum += v; });
    var ma = sum / tail.length, dev = (price / ma - 1) * 100;
    var q = lowN / cs.length;
    var sorted = cs.slice().sort(function (a, b) { return a - b; });
    var med = sorted[Math.floor(sorted.length / 2)];
    var cls = q >= 0.8 ? 'bad' : (q <= 0.2 ? 'good' : 'mid');
    var tone = q >= 0.8 ? '处于历史高位区。'
      : (q <= 0.2 ? '处于历史低位区。' : '处于历史中间地带。');
    function block(tag, pctv, now, note) {
      return '<div class="vp-row"><div class="vp-t">' + tag + '</div>'
        + '<div class="vp-bar"><div class="vp-fill ' + cls + '" style="width:' + Math.round(pctv * 100) + '%"></div>'
        + '<div class="vp-mk" style="left:' + Math.round(pctv * 100) + '%"></div></div>'
        + '<div class="vp-v"><b class="' + cls + '">' + now + '</b><span class="cat">' + note + '</span></div></div>';
    }
    return '<div class="ds-h">现在在什么位置 <span class="cat">点位在全部 ' + cs.length + ' 个交易日（' + esc(from || '') + ' 起）里的分位</span></div>'
      + '<div class="cheap-head ' + cls + '"><div class="ch-v">'
      + (q >= 0.8 ? '历史偏高' : (q <= 0.2 ? '历史偏低' : '历史居中')) + '</div>'
      + '<div class="ch-s">' + esc(r.name) + ' 当前 ' + fmt(price, 2) + ' 点，' + tone
      + '指数没有盈利口径，<b>位置高低不等于贵或便宜</b>，只说明它离自己的常态有多远。</div></div>'
      + '<div class="vp-wrap">'
      + block('点位分位', q, Math.round(q * 100) + '%', '历史区间 ' + fmt(lo, 1) + '~' + fmt(hi, 1) + '，中位 ' + fmt(med, 1))
      + block('距年线', Math.max(0, Math.min(1, (dev + 30) / 60)), (dev >= 0 ? '+' : '') + fmt(dev, 1) + '%',
        '年线＝近 250 个交易日均价 ' + fmt(ma, 1) + '；现价' + (dev >= 0 ? '高' : '低') + ' ' + fmt(Math.abs(dev), 1) + '%')
      + '</div>'
      + '<div class="hint">读法：分位 90% ＝ 历史上有 90% 的交易日点位比现在低。'
      + '这里衡量的是「指数自己走得多远」，<b>不是估值</b>；指数估值（PE/PB）需要成分股盈利加总，本站没有该数据，不估。</div>';
  }
  /* ---------- 关键价位（支撑 / 压力） ----------
     参考 TSP 的「9 类关键价位」思路，但只用本站已有的前复权日K，不引入新数据源：
     近 20/60/250 日高低 + MA20/MA60，按现价分成「上方压力」「下方支撑」，
     每个都给出距现价的百分比 —— 让用户知道「再涨 3% 到这里」「跌 5% 到这里」。 */
  function keyLevels(bars, price) {
    if (!Array.isArray(bars) || bars.length < 25 || !(price > 0)) return null;
    function seg(n) { return bars.slice(-Math.min(n, bars.length)); }
    function hi(n) { var s = seg(n), m = -Infinity; s.forEach(function (b) { if (isNum(b.h) && b.h > m) m = b.h; }); return m; }
    function lo(n) { var s = seg(n), m = Infinity; s.forEach(function (b) { if (isNum(b.l) && b.l > 0 && b.l < m) m = b.l; }); return m; }
    function ma(n) { var s = seg(n), t = 0, c = 0; s.forEach(function (b) { if (isNum(b.c)) { t += b.c; c++; } }); return c ? t / c : null; }
    var cands = [
      { n: '近20日高', v: hi(20) }, { n: '近60日高', v: hi(60) }, { n: '近250日高', v: hi(250) },
      { n: 'MA20', v: ma(20) }, { n: 'MA60', v: ma(60) },
      { n: '近20日低', v: lo(20) }, { n: '近60日低', v: lo(60) }, { n: '近250日低', v: lo(250) }
    ].filter(function (x) { return isNum(x.v) && x.v > 0; });
    if (!cands.length) return null;
    var above = cands.filter(function (x) { return x.v > price; }).sort(function (a, b) { return a.v - b.v; }).slice(0, 4);
    var below = cands.filter(function (x) { return x.v < price; }).sort(function (a, b) { return b.v - a.v; }).slice(0, 4);
    return { above: above, below: below };
  }
  function keyLevelsHtml(r, bars, price) {
    var k = keyLevels(bars, price);
    if (!k) return '<div class="hint">日K 不足，无法给出关键价位。</div>';
    function rows(list, empty) {
      if (!list.length) return '<div class="hint">' + empty + '</div>';
      return list.map(function (x) {
        var gap = (x.v / price - 1) * 100;
        return '<div class="kl-row"><span class="kl-n">' + esc(x.n) + '</span>'
          + '<span class="kl-v">' + fmt(x.v, 2) + '</span>'
          + '<span class="kl-g ' + signCls(gap) + '">' + (gap >= 0 ? '+' : '') + fmt(gap, 1) + '%</span></div>';
      }).join('');
    }
    return '<div class="kl-wrap2">'
      + '<div class="kl-col"><div class="kl-h bad">上方压力 <span class="cat">现价 ' + fmt(price, 2) + '</span></div>'
      + rows(k.above, '上方没有历史价位（已在高点之上）') + '</div>'
      + '<div class="kl-col"><div class="kl-h good">下方支撑</div>'
      + rows(k.below, '下方没有历史价位（已在新低之下）') + '</div>'
      + '</div><div class="hint">价位来自前复权日K：近 20/60/250 日最高与最低、MA20/MA60。'
      + '百分比是距现价的距离，不是目标价。<b>戳穿压力位不等于会继续涨，跌破支撑也不等于会继续跌</b>，它只是「历史上的筹码密集处」。</div>';
  }

  /* 指数专属档案：替代个股那套财报 / 规模 / 估值。写的全是 indexStates 与实时行情真有的字段。 */
  function indexDossierHtml(r, rich) {
    var price = (rich && isNum(rich.price) && rich.price > 0) ? rich.price : r.point;
    var p = r.pct || {}, sc = r.scores || {};
    function cell(k, v, s) { return '<div class="ds-cell"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + s + '</div></div>'; }
    function sv(v) { return isNum(v) ? '<span class="' + signCls(v) + '">' + (v > 0 ? '+' : '') + fmt(v, 2) + '</span>' : '—'; }
    var tone = r.state === '启动' ? '处在「启动」阶段（结构转强的判断，不是看涨）'
      : (r.state === '走完' ? '处在「走完」阶段（阶段接近尾声的判断，不是看跌）' : '处在「盘整」阶段（方向未定的整理）');
    return '<div class="dossier">'
      + '<div class="ds-one"><span class="ds-tag">一句话</span>'
      + esc(r.name) + '最新 ' + fmt(price, 2) + ' 点，' + tone + '，已持续 '
      + (r.stateDays != null ? (r.stateCapped ? '≥' : '') + r.stateDays + ' 个交易日' : '—')
      + '；六派中 ' + bullCount(r) + '/6 投启动票。'
      + '<b>指数是一篮子股票，没有企业财报、没有 PE/PB</b>，所以这一页只讲点位与结构，不讲公司基本面。</div>'
      + '<div class="ds-h">点位与区间 <span class="cat">快照 ' + esc(asOfClean(DS.meta() || {})) + ' 收盘 · 四窗口不含当日</span></div>'
      + '<div class="ds-grid six">'
      + cell('最新点位', fmt(price, 2), rich && isNum(rich.chgPct) ? '实时涨跌 ' + pct(rich.chgPct) : '快照点位')
      + cell('近5日', pct(p.w5), '快照区间')
      + cell('近20日', pct(p.w20), '快照区间')
      + cell('近60日', pct(p.w60), '快照区间')
      + cell('近250日', pct(p.w250), '快照区间')
      + cell('六派共振', bullCount(r) + ' / 6', '看启动票数，非涨跌预测')
      + '</div>'
      + '<div class="ds-h">六派分值 <span class="cat">与个股同一套引擎 · 指数版</span></div>'
      + '<div class="ds-grid six">'
      + cell('结构', sv(sc.structure), '分型 / 笔 / 中枢 / 背驰')
      + cell('量价', sv(sc.volume), '唐奇安 / MACD / RSI / 布林')
      + cell('资金', sv(sc.fund), '成交额与量能变化')
      + cell('情绪', sv(sc.senti), '涨跌家数与热度')
      + cell('配置', sv(sc.config), 'RRG 相对强度 / 动量')
      + cell('舆情', sv(sc.news), '快照无新闻源，实时票见下方六派明细')
      + '</div>'
      + '<div class="hint" style="margin-top:10px">口径：指数三态由构建脚本用与个股相同的引擎、'
      + '在指数自己的日K 上算出；点位来自腾讯实时行情，区间涨跌取自快照。<b>不构成投资建议，不预示未来收益</b>。</div>'
      + '</div>';
  }
  function valPosHtml(vp) {
    if (!vp || (!vp.pe && !vp.pb)) {
      return '<div class="ds-h">估值位置 <span class="cat">缺少 EPS / BPS 或日K，无法折算</span></div>'
        + '<div class="hint">估值分位需要「各期 EPS/BPS + 对应区间日收盘」，缺一项就不给，避免用错口径。</div>';
    }
    function block(tag, o, unit) {
      if (!o) return '';
      var cls = o.pct >= 0.8 ? 'bad' : (o.pct <= 0.2 ? 'good' : 'mid');
      return '<div class="vp-row"><div class="vp-t">' + tag + '</div>'
        + '<div class="vp-bar"><div class="vp-fill ' + cls + '" style="width:' + Math.round(o.pct * 100) + '%"></div>'
        + '<div class="vp-mk" style="left:' + Math.round(o.pct * 100) + '%"></div></div>'
        + '<div class="vp-v"><b class="' + cls + '">' + fmt(o.now, 1) + unit + '</b>'
        + '<span class="cat">历史分位 ' + Math.round(o.pct * 100) + '%（区间 ' + fmt(o.min, 1) + '~' + fmt(o.max, 1) + '，中位 ' + fmt(o.med, 1) + '）</span></div></div>';
    }
    return '<div class="ds-h">估值位置 <span class="cat">覆盖 ' + vp.n + ' 个交易日（' + esc(vp.from || '') + ' ~ ' + esc(vp.to || '')
      + '）· 按各期财报（公告日生效）EPS/BPS 分段折算</span></div>'
      + '<div class="vp-wrap">' + block('PE', vp.pe, '×') + block('PB', vp.pb, '×') + '</div>'
      + '<div class="hint">读法：分位越低＝相对自己的历史越便宜。低于 20% 属偏低区，高于 80% 属偏高区。'
      + '这里的分位是「同一份盈利下，市场愿意给的价格」的波动，<b>不等于业绩变化</b>。'
      + '区间长度受财报期数限制：更早的年份没有对应的 EPS/BPS，不参与计算，也不用今天的 EPS 反推（那样会算错）。</div>';
  }
  /* 实时盘口：换手率 / 量比 / 振幅 / 距涨跌停 —— 全部来自腾讯 46 字段，真实值
     指数没有涨跌停与换手率，第 4 格改用「昨收」；换手率置 —，避免把指数的空字段当 0 展示。 */
  function tapeHtml(rich, r) {
    if (!rich) return '';
    var isIdx = !!(r && r.kind === 'index');
    function cell(k, v, s, cls) { return '<div class="cs"><div class="k">' + k + '</div><div class="v ' + (cls || '') + '">' + v + '</div><div class="s">' + s + '</div></div>'; }
    var distUp = (isNum(rich.limitUp) && isNum(rich.price) && rich.limitUp > 0) ? (rich.limitUp / rich.price - 1) * 100 : null;
    var distDn = (isNum(rich.limitDown) && isNum(rich.price) && rich.limitDown > 0) ? (1 - rich.limitDown / rich.price) * 100 : null;
    return '<div class="ds-h">实时盘口 <span class="cat">腾讯行情 46 字段 · ' + esc(String(rich.time || '').replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2}).*/, '$1-$2-$3 $4:$5')) + (isIdx ? ' · 指数无涨跌停 / 换手率' : '') + '</span></div>'
      + '<div class="cyq-kpi">'
      + cell('换手率', (!isIdx && rich.turnover != null) ? fmt(rich.turnover, 2) + '%' : '—', isIdx ? '指数不适用' : '当日成交占流通股')
      + cell('量比', rich.volumeRatio != null ? fmt(rich.volumeRatio, 2) : '—', '>1 放量，<1 缩量')
      + cell('振幅', rich.amplitude != null ? fmt(rich.amplitude, 2) + '%' : '—', '当日最高最低波幅')
      + (isIdx
        ? cell('昨收', isNum(rich.preClose) ? fmt(rich.preClose, 2) : '—', '用于核对当日涨跌')
        : cell('距涨停', distUp != null ? fmt(distUp, 2) + '%' : '—', isNum(rich.limitUp) ? '涨停价 ' + fmt(rich.limitUp, 2) : '—',
          distUp != null && distUp < 2 ? 'up' : ''))
      + '</div>';
  }

  function dossierHtml(fin, r, rich) {
    var rk = rankMaps();
    var price = (rich && isNum(rich.price) && rich.price > 0) ? rich.price : lastPriceOf(r);
    if (!fin || !fin.cur) {
      return '<div class="dossier"><div class="empty-card" style="margin:0"><h3>没有取到财报数据</h3>'
        + (r.kind === 'index'
            ? '指数是一篮子股票，<b>没有企业财报、也没有 PE/PB 这类公司口径</b>，'
              + '所以这块留空；三态、六派与 K线 在下方照常给出。'
            : (String(r.code).indexOf('.BJ') > 0
              ? '北交所标的在该财报接口里覆盖不全，<b>缺口如实标注，不用 0 代替</b>。'
              : '可能是接口临时不可用，或该标的（如宽基 ETF）本身没有企业财报。'))
        + '</div></div>';
    }
    var c = fin.cur;
    // PE/PB 优先用腾讯实时（TTM 口径，交易所同源）；取不到才退化成「股价 ÷ 年化 EPS」估算
    var pe = (rich && isNum(rich.pe) && rich.pe > 0) ? rich.pe
      : ((price && isNum(c.eps) && c.eps > 0) ? price / (c.eps * 4 / quartersOf(c.date)) : null);
    var pb = (rich && isNum(rich.pb) && rich.pb > 0) ? rich.pb
      : ((price && isNum(c.bps) && c.bps > 0) ? price / c.bps : null);
    var capShow = (rich && isNum(rich.totalCap) && rich.totalCap > 0) ? rich.totalCap : r.mcap;
    var q = rk.all[r.code], ir = rk.ind[r.code], iz = rk.indSize[r.ind || '—'];

    var val = [
      ['总市值', capShow != null ? fmt(capShow, 0) + ' 亿' : '—', q ? '全 A 第 ' + q + ' / ' + rk.total : '无市值数据'],
      ['行业排名', ir ? '第 ' + ir + ' / ' + iz : '—', esc(r.ind || '行业未匹配')],
      ['PE（TTM）', pe != null ? fmt(pe, 1) + '×' : '—', (rich && isNum(rich.pe)) ? '腾讯实时口径' : '股价 ÷ 年化 EPS'],
      ['PB', pb != null ? fmt(pb, 2) + '×' : '—', '股价 ÷ 每股净资产'],
      ['每股收益', isNum(c.eps) ? fmt(c.eps, 2) + ' 元' : '—', esc(c.name || '')],
      ['每股净资产', isNum(c.bps) ? fmt(c.bps, 2) + ' 元' : '—', 'BPS']
    ].map(function (x) {
      return '<div class="ds-cell"><div class="k">' + x[0] + '</div><div class="v">' + x[1] + '</div><div class="s">' + x[2] + '</div></div>';
    }).join('');

    var body = [
      ['毛利率', c.grossPct != null ? fmt(c.grossPct, 1) + '%' : '—', grade(c.grossPct, 50, 25), '越高越有定价权'],
      ['净利率', c.netPct != null ? fmt(c.netPct, 1) + '%' : '—', grade(c.netPct, 10, 3), '每 100 元收入留下多少利润'],
      ['ROE', c.roe != null ? fmt(c.roe, 1) + '%' : '—', grade(c.roe, 15, 8), '股东每 100 元净资产的回报'],
      ['ROIC', c.roic != null ? fmt(c.roic, 1) + '%' : '—', grade(c.roic, 10, 5), '含负债的真实资本回报'],
      ['资产负债率', c.debt != null ? fmt(c.debt, 1) + '%' : '—', grade(c.debt, 40, 65, true), '超过 65% 属高杠杆'],
      ['每股经营现金', c.cashps != null ? fmt(c.cashps, 2) + ' 元' : '—', grade(c.cashps, 1, 0, false), '与 EPS 对比看利润含金量']
    ].map(function (x) {
      return '<div class="ds-cell"><div class="k">' + x[0] + '</div><div class="v ' + x[2] + '">' + x[1] + '</div><div class="s">' + x[3] + '</div></div>';
    }).join('');

    /* 看点 / 风险：规则明确、可复查，不是主观评级 */
    var watch = [], risk = [];
    if (c.grossPct != null && c.grossPct >= 60) watch.push('毛利率 ' + fmt(c.grossPct, 1) + '%，具备定价权，抗成本上行能力强。');
    if (c.roe != null && c.roe >= 15) watch.push('ROE ' + fmt(c.roe, 1) + '%，股东回报效率处于高位。');
    if (c.debt != null && c.debt <= 30) watch.push('资产负债率仅 ' + fmt(c.debt, 1) + '%，财务弹性大。');
    if (q && q <= 100) watch.push('全 A 市值第 ' + q + '，属流动性最好的头部公司。');
    if (r.state === '启动' && bullCount(r) >= 4) watch.push('三态「启动」且六派 ' + bullCount(r) + '/6 共振，技术面与基本面同向。');
    if (fin.revYoy != null && fin.revYoy > 20) watch.push('营收同比 ' + spct(fin.revYoy) + '，仍在扩张期。');

    if (c.debt != null && c.debt >= 70) risk.push('资产负债率 ' + fmt(c.debt, 1) + '%，杠杆偏高，利率与再融资环境变化会放大波动。');
    if (fin.revYoy != null && fin.revYoy > 0 && fin.profitYoy != null && fin.profitYoy < -10) risk.push('增收不增利：营收 ' + spct(fin.revYoy) + ' 但净利 ' + spct(fin.profitYoy) + '，成本或费用在侵蚀利润。');
    if (fin.revYoy != null && fin.revYoy < 0) risk.push('营收同比 ' + spct(fin.revYoy) + '，需求端已出现收缩。');
    if (isNum(c.cashps) && isNum(c.eps) && c.eps > 0 && c.cashps < c.eps * 0.5) risk.push('每股经营现金流 ' + fmt(c.cashps, 2) + ' 元低于每股收益 ' + fmt(c.eps, 2) + ' 元，利润的现金含量偏弱，需查应收与存货。');
    if (pe != null && pe > 50 && !(fin.profitYoy > 30)) risk.push('PE ' + fmt(pe, 1) + '× 已高于成长速度能支撑的水平，估值对业绩兑现要求很高。');
    if (r.klStale) risk.push('日K 未更新到最新交易日，区间与持续天数可能失真，先别据此下判断。');
    if (!watch.length) watch.push('规则未命中显著正向特征，请结合行业与公告自行判断。');
    if (!risk.length) risk.push('规则未命中明显风险项；这不等于没有风险，财报本身有滞后。');

    return '<div class="dossier">'
      + '<div class="ds-one"><span class="ds-tag">一句话</span>' + esc(oneLiner(r, fin)) + '</div>'
      + '<div class="ds-h">规模与估值</div><div class="ds-grid six">' + val + '</div>'
      + '<div class="ds-h">赚钱能力与财务体质 <span class="cat">' + esc(c.name || '') + ' · 数据截至 ' + esc(c.date) + '</span></div>'
      + '<div class="ds-grid six">' + body + '</div>'
      + '<div class="ds-h">业绩趋势 <span class="cat">最近 ' + Math.min((fin.rows || []).length, 8) + ' 个报告期（累计口径）</span></div>'
      + perfBars(fin)
      + '<div class="ds-two"><div class="ds-watch"><div class="ds-h">看什么</div><ul>'
      + watch.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>'
      + '<div class="ds-risk"><div class="ds-h">警惕什么</div><ul>'
      + risk.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div></div>'
      + '<div class="hint" style="margin-top:10px">口径：营收 / 净利为报告期<b>年初至今累计</b>（三季报＝前三季度），同比为与去年同期报告期比；'
      + 'PE 用「股价 ÷ 年化每股收益」估算（EPS × 4 ÷ 已过季度数），亏损或微利不显示；排名基于本站全市场市值快照。'
      + '财报有滞后，<b>不代表当前经营状况；不构成投资建议</b>。</div>'
      + '</div>';
  }
  function hydrateFinance(code) {
    var el = $('finBlock'); if (!el || !code) return;
    if (el.getAttribute('data-loaded') === '1') return;
    var r = DS.snapshot(code) || { code: code };
    var isIdx = r.kind === 'index';
    if (!isIdx && !DS.getFinance) { el.innerHTML = ''; return; }
    // 三路并发：财报（慢）/ 实时行情 / 日K（本地分片，快）——谁先到都不影响最终拼装
    // 指数不发财报请求：它没有财报，发出去只会拿回空表或串到同裸码的个股上。
    Promise.all([
      isIdx ? Promise.resolve(null) : DS.getFinance(code).catch(function () { return null; }),
      (DS.getQuoteRich ? DS.getQuoteRich(code) : Promise.resolve(null)).catch(function () { return null; }),
      klineFor(code).catch(function () { return null; })
    ]).then(function (res) {
      var fin = res[0], rich = res[1], k = res[2];
      var bars = k && k.bars ? k.bars : null;
      var price = (rich && isNum(rich.price) && rich.price > 0) ? rich.price : (isIdx ? r.point : lastPriceOf(r));
      if (isIdx) {
        el.innerHTML = indexDossierHtml(r, rich)
          + '<div class="dossier">' + tapeHtml(rich, r) + indexPosHtml(r, bars, price)
          + cyqHtml(cyqOf(bars, price), price, true) + '</div>';
        el.setAttribute('data-loaded', '1');
        return;
      }
      var cyq = cyqOf(bars, price);
      var vp = valPosOf(bars, fin, price);
      var extra = tapeHtml(rich, r) + cheapnessHtml(fin, r, vp, price, bars)
        + cyqHtml(cyq, price) + valPosHtml(vp);
      el.innerHTML = dossierHtml(fin, r, rich)
        + (extra ? '<div class="dossier">' + extra + '</div>' : '');
      el.setAttribute('data-loaded', '1');
    }).catch(function () { el.innerHTML = ''; });
  }

  /* 前世今生自己的搜索框：不用退回列表或顶部全局搜索，直接在本页切换标的。
     支持代码（600519 / 600519.SH）、名称关键字（茅台）、以及四大指数（上证指数…）。 */
  function histSwitcherHtml(cur) {
    return '<div class="mod-kw hist-kw">'
      + '<input id="histKw" type="text" autocomplete="off" placeholder="切换标的：代码 / 名称 / 指数，如 600519、茅台、上证指数" value="' + esc(cur || '') + '" />'
      + '<button class="btn btn-primary" id="histGo">查看</button>'
      + '<span class="mk-hint" id="histHint">在本页直接切换，回车即可</span>'
      + '</div>';
  }
  function histJump() {
    var box = $('histKw'); if (!box) return;
    var kw = String(box.value || '').trim();
    var hint = $('histHint');
    if (!kw) { if (hint) hint.textContent = '请输入代码或名称'; return; }
    var recs = DS.allRecords();
    /* 指数要先认：否则输入"上证指数"只会命中不到任何个股，
       而输入 000001.SH 又会掉进裸码回退变成平安银行。 */
    var idxs = RAW().indexStates || [];
    var idxHit = null;
    for (var i = 0; i < idxs.length; i++) {
      var nm = String(idxs[i].name || ''), cd = String(idxs[i].code || '').toUpperCase();
      if (nm === kw || nm.indexOf(kw) >= 0 || cd === kw.toUpperCase()) { idxHit = idxs[i]; break; }
    }
    var hit = recs.filter(function (r) {
      var bare = String(r.code).replace(/\.[A-Z]+$/, '');
      return r.code === kw || bare === kw || (r.name || '').indexOf(kw) >= 0;
    })[0];
    var code = idxHit ? idxHit.code
      : (hit ? hit.code
        : (RADAR_INDEX[kw] || (/^\d{6}\.(SH|SZ)$/i.test(kw) ? kw.toUpperCase() : null)));
    if (!code || !DS.snapshot(code)) {
      if (hint) hint.textContent = '没找到「' + kw + '」：试试完整代码（600519 / 000001.SH）、名称关键字（茅台 / 上证）或指数名（上证指数）';
      return;
    }
    if (hint) hint.textContent = '正在打开 ' + code + '…';
    navigate('/history?code=' + encodeURIComponent(code));
  }

  function viewHistory(code) {
    var r = code ? DS.snapshot(code) : null;
    if (!r) return viewPicker();   // 未指定标的：直接给带搜索框的挑选页，避免两个标题叠加
    /* 指数与个股共用这一页，但内容不能共用：指数没有财报 / PE / PB / 行业对标。
       之前这里没区分，指数卡片带着「000001.SH」进来又被裸码回退成平安银行，
       页面就出现「标题写个股、K线却是指数点位」的混搭。现在先认指数再分叉渲染。 */
    var isIdx = r.kind === 'index';
    code = r.code;                 // 统一用快照里规范化后的全码，避免裸码在后续链路再被误配
    var q = QUOTES[code] || {}, e2 = r.e2 || {}, meta = DS.meta() || {};
    var days = daysText(r);
    var dayChg = (q.chg != null) ? q.chg : (isIdx && isNum(r.chg) ? r.chg : null);
    var head = '<div class="page-head">'
      + '<button class="btn" data-back>‹ 返回</button>'
      + '<div class="ph-main"><h1>' + esc(r.name) + ' · 前世今生</h1>'
      + '<div class="ph-sub">' + esc(code) + ' · ' + typeLabel(r) + ' · ' + esc(r.ind || '—') + ' · 三态截至 ' + esc(asOfClean(meta)) + '</div></div>'
      + stateBlock(r, { click: false })
      + (!isIdx ? '<button class="btn' + (isFollow(code) ? ' on' : '') + '" data-star-toggle="' + esc(code) + '">' + (isFollow(code) ? '★ 已关注' : '☆ 加入我的看板') + '</button>'
        + '<button class="btn btn-primary" data-lens="' + esc(code) + '">侧栏透镜 ›</button>' : '')
      + '<button class="btn" data-share="' + esc(code) + '">↗ 分享卡</button>'
      + '</div>';
    var hero = histSwitcherHtml(code) + '<div class="hist-hero">'
      + hh('三态', stateBlock(r, { tag: false }), '阶段判断 · 非涨跌建议')
      + hh('六派共振', bullCount(r) + '/6', '看启动票数')
      + hh('已持续', days, '当前状态')
      + hh('今日', dayChg != null ? daySpan(q, '—') : '<span class="mut">—</span>',
        isSuspended(q) ? '无成交 · 停牌或未开盘' : (q.chg != null ? '实时 · 三源降级' : (isIdx && dayChg != null ? '快照收盘 · 实时点位见下方盘口' : '实时源暂不可用')))
      + '</div>'
      + '<div id="finBlock" data-fin-code="' + esc(code) + '"><div class="hint">'
      + (isIdx ? '正在读取指数日K 与实时点位…' : '正在读取最新财报（营收 / 净利润 / 毛利率）…') + '</div></div>';

    /* 「接下来怎么走」放在结论速览的状态说明下面：不折叠、直接可见。
       位置选择理由——用户看完「现在是什么状态」后，第一个问题就是「那接下来呢」，
       把路径紧贴状态放，比塞在页面下半部分的「前世今生」里更符合阅读顺序。 */
    var h = head + hero + statePhaseNote(r)
      + (window.AB_PATH && window.AB_PATH.render ? window.AB_PATH.render(r) : '');
    /* 1) 前世今生独有内容：历史档案（不复用透镜组件，根治「和其他板块雷同」） */
    h += sec(1, '前世今生 · ' + (isIdx ? '指数' : '个股') + '历史档案', '全量' + (isIdx ? '指数' : '前复权') + '日K 客观推导 · 每个数字标注口径',
      '<div class="arch-wrap" data-archive-code="' + esc(code) + '">'
      + historyArchive(r, cachedBars(code)) + '</div>');
    h += sec(2, '状态脉络与历史结论', '三态切换时间线 + 真实日K 重算的历史三态演化带 + 每个结论的区间实际幅度',
      historyTimeline(r)
      + '<div class="evo-wrap" data-evo-code="' + esc(code) + '">' + historyStateEvolution(r, cachedBars(code)) + '</div>'
      + '<div class="hint" style="margin-top:8px">口径说明：上面的「状态脉络」是快照里记录的切换节点（构建时算），'
      + '「演化带」是按当天日K 逐日重算 —— 两者判定规则不同，出现节点不一致时<b>以演化带为准</b>。'
      + '演化带用的是简化规则（票数≥4 + 结构票 + MA20 + 60/250 日绝对闸门），'
      + '引擎还有否决项与结构阈值，纯前端回放拿不到当期截面数据，所以只能算近似。</div>'
      + positionBar(r, cachedBars(code))
      + '<div class="section-title" style="margin:16px 0 8px"><h2 style="font-size:14px">历史结论 · 个案幅度</h2>'
      + '<span class="desc">启动看上行 / 盘整看振幅 / 走完看下行</span></div>' + outcomeHtml(r, false));
    h += sec(3, '价格全景 · K 线', (isIdx ? '真 · 指数日K（红涨绿跌）+ MA5 / MA20 + 成交量' : '真 · 前复权日K（红涨绿跌）+ MA5 / MA20 + 成交量'),
      '<div id="histChart" class="chart-box" style="height:320px"></div>'
      + '<div class="hint">K 线由离线静态 / 东财 / 腾讯 / 新浪 多源'
      + (isIdx ? '指数日K（指数无除权，点位即连续序列，无需前复权）' : '前复权日K')
      + ' 现场绘制（Canvas 零依赖，不需要图表 CDN）；'
      + '鼠标悬停可看当日开高低收、涨跌幅与成交量。<b>日K 全部源不可用时页面会明确标注「这不是 K 线」</b>，'
      + '不会把快照锚点连线伪装成 K 线。图表仅反映历史走势，不预示未来。</div>'
      + anchorCards(r)
      + '<div class="kl-wrap" data-kl-code="' + esc(r.code) + '">'
      + '<div class="ds-h" style="margin-top:14px">关键价位 <span class="cat">上方压力 / 下方支撑 · 来自前复权日K</span></div>'
      + '<div class="hint">正在用日K 计算…</div></div>'
      + '<div class="kpis" style="margin-top:12px">'
      + kpi('近5日', '<span class="mut">' + pct(r.pct && r.pct.w5) + '</span>', '快照·不含当日')
      + kpi('近20日', '<span class="mut">' + pct(r.pct && r.pct.w20) + '</span>', '快照')
      + kpi('近60日', '<span class="mut">' + pct(r.pct && r.pct.w60) + '</span>', '快照')
      + kpi('近250日', '<span class="mut">' + pct(r.pct && r.pct.w250) + '</span>', '快照')
      + kpi('上市以来', '<span class="mut" data-listed>读取日K…</span>', '首根K线至今')
      + (isIdx
        ? kpi('最新点位', isNum(r.point) ? fmt(r.point, 2) + ' 点' : '—', '指数·无市值口径')
        : kpi('总市值 / 规模', isNum(r.mcap) ? fmt(r.mcap, 1) + '亿' : (r.size != null ? fmt(r.size, 1) + '亿' : '—'), typeLabel(r)))
      + '</div>');
    h += sec(4, '三态与六派依据', '每派原文依据 + 该派历史胜率 · 结构/量价/资金/情绪/配置/舆情', sixTags(r)
      + '<div style="height:10px"></div>' + sixEvidence(r)
      + '<details class="st-details"><summary>六派各自判断的时间与启动起点（点开 / 收起）</summary>'
      + sixTimingHtml(r, true) + '</details>');
    h += sec(5, '结论时效 · 风险预警 · 前瞻胜率', '判断日期 / 快照与实时背离 / 1周·1月·3月方向胜率', insightBlock(r, q, true));
    var scores = r.scores || {};
    var scoreRows = SIX.map(function (s) {
      var v = Number(scores[s.k]);
      if (!isNum(v)) return '';
      var w = Math.max(4, Math.min(100, (v + 1.5) / 3 * 100));
      return '<div class="evi-row"><span class="p">' + s.n + '</span><span style="flex:1;background:#eef2fb;border-radius:6px;height:8px;position:relative">'
        + '<span style="position:absolute;left:0;top:0;bottom:0;width:' + fmt(w, 0) + '%;background:var(--grad-brand);border-radius:6px"></span></span>'
        + '<span class="cat">' + fmt(v, 2) + '</span></div>';
    }).join('');
    var ind = r.indInfo || {};
    var appendix = '';
    appendix += sec('A1', isIdx ? '结构、资金与指数位置' : '结构、资金与行业位置', '客观因子', '<div class="two-col"><div class="evi">' + (scoreRows || '<div class="mut">无因子分值</div>') + '</div><div class="evi">'
      + '<div class="evi-row"><span class="p">阶段</span><span>' + esc(r.stage || '—')
        + (isNum(r.structConf) ? ' · 结构一致度 ' + Math.round(r.structConf * 100) + '%' : '')
        + (r.quad ? ' · RRG ' + esc(r.quad) : '')
        + (isNum(r.rsRatio) ? ' · RS-Ratio ' + fmt(r.rsRatio, 1) : '') + '</span></div>'
      + '<div class="evi-row"><span class="p">资金</span><span>' + esc(r.fundLabel || '—') + '</span></div>'
      + (isIdx
        ? '<div class="evi-row"><span class="p">性质</span><span>宽基指数 · 无行业归属、无 PE/PB、无换手率口径（不适用，不是缺数据）</span></div>'
          + '<div class="evi-row"><span class="p">点位</span><span>' + (isNum(r.point) ? fmt(r.point, 2) + ' 点' : '—')
          + (isNum(r.chg) ? ' · 快照当日 ' + pct(r.chg) : '') + '</span></div>'
        : '<div class="evi-row"><span class="p">行业</span><span>' + esc(ind.name || r.ind || '—') + (isNum(ind.m20) ? ' · 近20日 ' + pct(ind.m20) : '') + '</span></div>'
          + '<div class="evi-row"><span class="p">行业宽度</span><span>' + (isNum(ind.breadth) ? fmt(ind.breadth, 1) + '%' : '—') + ' · 换手 ' + (isNum(ind.turnover) ? fmt(ind.turnover, 2) + '%' : '—') + '</span></div>')
      + '</div></div>');
    var nm = r.newsMain || {}, themes = Array.isArray(r.themes) ? r.themes : [], tmap = {};
    themeList().forEach(function (t) { tmap[t.key] = t.name; });
    var news = Array.isArray(r.newsItems) ? r.newsItems.slice(0, 4) : [];
    appendix += sec('A2', '舆情与主题', '资讯密度与情绪', (themes.length ? '<div class="six">' + themes.map(function (t) { return '<span class="tag mid">' + esc(tmap[t] || t) + '</span>'; }).join('') + '</div>' : '<div class="mut">无显著主题标签</div>')
      + (nm.name ? '<div class="notice">有效激增：' + esc(nm.name) + ' · ' + fmt(nm.surge || 0, 1) + '×' + (nm.read ? '<br/>' + esc(String(nm.read).slice(0, 240)) : '') + '</div>' : '')
      + (news.length ? '<div class="evi" style="margin-top:10px">' + news.map(function (n) {
        return '<div class="evi-row"><span class="p">' + esc(n.name || '主题') + '</span><span>' + esc(String(n.read || '').slice(0, 150)) + '</span></div>';
      }).join('') + '</div>' : '')
      + newsLinksHtml(r));
    var hs = e2.histStat || {};
    appendix += sec('A3', '历史统计与可证伪锚点', '客观历史 · 不预示未来', '<div class="stat-note">' + esc(hs.txt || '相似形态样本不足，不做概率统计。') + '</div>'
      + (e2.falsify && e2.falsify.txt ? '<div class="notice">可证伪锚点：' + esc(e2.falsify.txt) + '</div>' : '')
      + (e2.falsify && e2.falsify.note ? '<div class="hint">' + esc(e2.falsify.note) + '</div>' : ''));
    appendix += sec('A4', '监控清单', '客观核对项 · 非建议', monitorList(r));
    appendix += sec('A5', '标的身份与关联', '快照字段 / 同类对比 / RRG 位置',
      identityHtml(r) + (r.rrg ? '<div class="notice" style="margin-top:8px">RRG 象限 <b>' + esc(quadOf(r))
        + '</b>：相对强度 ' + fmt(r.rrg.x, 2) + '、相对动量 ' + fmt(r.rrg.y, 2)
        + '（中心 0/0 为沪深300 基准线，顺时针 领先→走弱→落后→改善）。</div>' : ''));
    h += sec(6, '附录 · 快照明细', '客观因子 / 舆情主题 / 历史统计 / 监控清单 / 标的身份（默认折叠，内容不删）',
      '<details class="appendix"><summary>展开快照明细 · 5 组客观数据（点开 / 收起）</summary>'
      + '<div class="apx-body">' + appendix + '</div></details>');
    h += sec(7, '来源与口径', '', '<div class="src">数据：腾讯 / 新浪免费行情全市场重算（三态截至 ' + esc(asOfClean(meta)) + '）'
      + '；实时行情：东财 / 腾讯 / 新浪三源降级，实时源不可用则标注快照口径。四窗口为快照区间涨跌，<b>不含当日</b>。'
      + (e2.note ? esc(e2.note) + '。' : '') + '本页为客观历史数据整理，<b>不构成投资建议，不预示未来收益</b>。</div>');
    h += sec(8, '白话词典与数据缺口', '看得懂 · 可核对',
      '<div class="glossary"><details open><summary>名词解释（点开 / 收起）</summary>'
      + '<p><b>三态</b>：启动 / 盘整 / 走完，是「现在处在哪个阶段」的判断，<b>不是买卖建议、不预示涨跌</b>。</p>'
      + '<p><b>六派</b>：结构 / 量价 / 资金 / 情绪 / 配置 / 舆情 六个维度各自投方向票；✓ 认同启动，✗ 不认同（<b>不等于看跌</b>），— 中性。</p>'
      + '<p><b>判断日期</b>：结论所依据数据的截至日；距今越久越可能失效，请自行决定是否仍采纳。</p>'
      + '<p><b>此后表现 / 方向命中率</b>：基于快照锚点与前复权日K 的客观历史统计，样本有限、未计交易成本，<b>不预示未来</b>。</p>'
      + '<p><b>数据缺口</b>：本页不含财报盈利质量 / 同行估值 / 全球对比（DATA 快照没有这些字段，缺口如实标注，不以零代替）；'
      + '历史资讯逐日序列亦不可得，舆情派历史命中率以量能异动方向代理。</p>'
      + '</details></div>');
    return h + legendBlock();
  }

  // ---------- 个股透镜（内联抽屉） ----------
  var SUGGEST_NAMES = {};   // 在线检索得到的池外标的名称（code -> name）
  /* 抽屉里的舆情区块：直接复用「资讯雷达」的取数与判定函数（newsMetrics / polarityOf /
     stanceOneLiner / crossSignalHtml / newsTrendHtml），不再读快照里那套旧字段。
     这样同一个标的在抽屉与独立页看到的结论必然一致。 */
  function radarCompactHtml(mt, pol, hot, row, code, name) {
    var kpi = '<div class="radar-kpi mini">'
      + '<div class="rk"><div class="k">近24h</div><div class="v">' + mt.n1 + '</div><div class="s">去重 ' + mt.uniqN + '</div></div>'
      + '<div class="rk"><div class="k">7日日均</div><div class="v">' + fmt(mt.baseline, 1) + '</div><div class="s">共 ' + mt.n7 + ' 条</div></div>'
      + '<div class="rk"><div class="k">激增</div><div class="v ' + (mt.surge >= 1.5 ? 'up' : 'mut') + '">' + fmt(mt.surge, 1) + '×</div><div class="s">24h÷基线</div></div>'
      + '<div class="rk"><div class="k">媒体</div><div class="v">' + mt.mediaN + '</div><div class="s">7日</div></div>'
      + '</div>';
    var list = mt.rows.filter(function (r) { return r.t > mt.latest - 7 * 86400000; }).slice(0, 5)
      .map(function (r) { return newsRowHtml(r.x); }).join('');
    return stanceOneLiner(mt, pol, hot, code)
      + crossSignalHtml(mt, pol, row)
      + kpi
      + (list ? '<div class="radar-list"><div class="rl-h">最近资讯</div>' + list + '</div>' : '')
      + '<div class="radar-more"><span class="rq" data-rnews="' + esc(name || '') + '">在「资讯雷达」里看完整分析（趋势图 / 热榜 / 更多标题）›</span></div>';
  }
  /* 实时舆情票回填：六派明细里的舆情行，等实时资讯到位后统一改写。
     vote 规则与三方核对同源：净倾向 ≥0.15 记 +1，≤-0.15 记 -1，之间记 0。 */
  function applyLiveNewsVote(pol, mt) {
    if (!pol || !mt) return;
    var vote = pol.net >= 0.15 ? 1 : (pol.net <= -0.15 ? -1 : 0);
    var txt = '实时舆情 ' + (vote > 0 ? '+1 票' : (vote < 0 ? '−1 票' : '0 票（中性）'))
      + ' · ' + pol.level + '（净倾向 ' + (pol.net >= 0 ? '+' : '') + fmt(pol.net, 2)
      + '；24h ' + mt.n1 + ' 条、' + mt.mediaN + ' 家媒体）'
      + ' ｜ 构建快照不含新闻源，本票以实时资讯为准';
    var nodes = document.querySelectorAll('[data-news-vote]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = txt;
  }

  function hydrateNewsEmbed() {
    var el = $('newsEmbed');
    if (!el || el.getAttribute('data-loaded') === '1') return;
    var code = el.getAttribute('data-news-code');
    var name = el.getAttribute('data-news-name') || code;
    if (!code || !DS.getNews) { el.innerHTML = ''; return; }
    var row = DS.snapshot(code) || { code: code, name: name };
    Promise.all([
      DS.getNews(name, 40).catch(function () { return null; }),
      (DS.getHotList ? DS.getHotList() : Promise.resolve(null)).catch(function () { return null; })
    ]).then(function (res) {
      var news = res[0], hot = res[1];
      var mt = news && news.list ? newsMetrics(news.list) : null;
      if (!mt) {
        el.innerHTML = '<div class="hint">资讯接口暂不可用（或该标的近期没有报道）。下方仍可看主题标签与关联标的；'
          + '稍后可在「资讯雷达」重试。</div>';
        return;
      }
      var pol = polarityOf(mt.rows.map(function (r) { return r.x; }), name, code);
      applyLiveNewsVote(pol, mt);
      el.innerHTML = radarCompactHtml(mt, pol, hot, row, code, name);
      el.setAttribute('data-loaded', '1');
    }).catch(function () {
      el.innerHTML = '<div class="hint">资讯加载失败，可在「资讯雷达」重试。</div>';
    });
  }

  function openLens(code) {
    var r = DS.snapshot(code);
    if (!r) { openLightLens(code); return; }
    code = r.code || code;          // 统一成全码：抽屉标题 / QUOTES / 分享深链必须与图表同一标的
    /* 指数没有个股透镜那套（财报 / 行业 / 资金 / RRG 都不适用），
       直接给指数版快照 + 通往前世今生的入口，不要套个股报告模板。 */
    if (r.kind === 'index') { openIndexLens(r, code); return; }
    var q = QUOTES[code] || {};
    $('drawerTitle').innerHTML = '<b>' + esc(r.name) + '</b> <span class="cat">' + esc(code) + '</span> ' + stateBlock(r, { click: false });
    var body = $('drawerBody');
    body.innerHTML = (REF_FROM ? '<div class="notice" style="background:linear-gradient(135deg,#f3edff,#eef4ff);border-color:#dcd0fb;color:#4b3a91">'
      + '🎁 好友 <b>' + esc(REF_FROM) + '</b> 分享给你这只标的 · 下面是它的三态与六派快照</div>' : '')
      + '<div class="drawer-actions">'
      + '<button class="btn btn-primary" data-history="' + esc(code) + '">⤢ 打开完整前世今生</button>'
      + '<button class="btn' + (isFollow(code) ? ' on' : '') + '" data-star-toggle="' + esc(code) + '">' + (isFollow(code) ? '★ 已关注' : '☆ 加入我的看板') + '</button>'
      + '<button class="btn" data-share="' + esc(code) + '">↗ 生成分享卡</button>'
      + '<button class="btn" data-back>‹ 返回列表</button>'
      + '</div>' + lensReport(r, q);
    hydrateNewsEmbed();
    $('drawerMask').classList.add('open');
    $('drawer').classList.add('open');document.body.classList.add('drawer-open');
    // 图表 + 实时价（抽屉展开后容器才有宽度）
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        drawLensChart(r);
        refreshLensLive(code);
        hydrateInsights();
      });
    });
  }
  /* 指数专用抽屉：只放指数真有的东西（点位 / 四窗口 / 六派分值），不套个股模板。
     从首页关注卡、分享深链、或旧的 #/lens?code=000001.SH 进来都走这里。 */
  function openIndexLens(r, code) {
    $('drawerTitle').innerHTML = '<b>' + esc(r.name) + '</b> <span class="cat">' + esc(code) + ' · 指数</span> ' + stateBlock(r, { click: false });
    var body = $('drawerBody');
    body.innerHTML = '<div class="drawer-actions">'
      + '<button class="btn btn-primary" data-history="' + esc(code) + '">⤢ 打开完整前世今生</button>'
      + '<button class="btn" data-share="' + esc(code) + '">↗ 生成分享卡</button>'
      + '<button class="btn" data-back>‹ 返回列表</button>'
      + '</div>' + indexDossierHtml(r, QUOTES[code] ? { price: QUOTES[code].price, chgPct: QUOTES[code].chg } : null);
    $('drawerMask').classList.add('open');
    $('drawer').classList.add('open');document.body.classList.add('drawer-open');
  }


  /* 池外标的（如「宇通客车」）：没有三态/六派，但照样给实时报价 + 前复权日K，
   * 避免用户为看一根 K 线再跳去别的软件。参考 Vibe-Research「概览直接看 K 线」。 */
  function openLightLens(code) {
    var name = SUGGEST_NAMES[code] || code;
    $('drawerTitle').innerHTML = '<b>' + esc(name) + '</b> <span class="cat">' + esc(code) + '</span> '
      + '<span class="pill unk">池外标的</span>';
    $('drawerBody').innerHTML = '<div class="notice">该标的<b>未收录进全市场快照</b>，因此没有三态 / 六派结论'
      + '（需 DATA 再生脚本纳入后才有，缺口如实标注）。下面提供多源实时报价与前复权日K，'
      + '可直接在站内看盘；<b>不构成投资建议</b>。</div>'
      + '<div class="kpis" id="lightKpis"></div>'
      + '<div id="lensChart" class="chart-box" style="height:320px;margin-top:12px"></div>'
      + '<div class="hint">前复权日K（红涨绿跌）+ MA5 / MA20 + 成交量，Canvas 零依赖；鼠标悬停看当日开高低收。</div>'
      + sec(1, '来源与口径', '', '<div class="src">实时行情：东财 / 腾讯 / 新浪三源降级；日K：东财 / 新浪。'
        + '本页为公开客观行情整理，<b>不构成投资建议，不预示未来收益</b>。</div>');
    $('drawerMask').classList.add('open');
    $('drawer').classList.add('open');document.body.classList.add('drawer-open');
    DS.getTodayQuotes([code]).then(function (out) {
      var q = out && out.map ? out.map[code] : null; if (!q) return;
      QUOTES[code] = q;
      var el = $('lightKpis');
      if (el) el.innerHTML = kpi('最新价', q.price != null ? fmt(q.price, 2) : '—', '实时 · ' + (q.source || ''))
        + kpi('今日', '<span class="' + signCls(q.chg) + '">' + pct(q.chg) + '</span>', '实时');
    }).catch(function () {});
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { drawSeriesChart('lensChart', { code: code, series: [] }); });
    });
  }
  function hideDrawer() {
    $('drawerMask').classList.remove('open');
    $('drawer').classList.remove('open');document.body.classList.remove('drawer-open');
  }
  function closeDrawer() { hideDrawer(); }   /* 不再改写 URL，避免破坏分享深链 */
  function lensReport(r, q) {
    var e2 = r.e2 || {};
    var bull = bullCount(r);
    var ev = (e2.evidence && Array.isArray(e2.evidence)) ? e2.evidence : [];
    var topEv = ev.length ? ev[0].txt || ev[0] : (r.newsMain && r.newsMain.read ? r.newsMain.read : '');
    /* 以前读 e2.stateDays —— 但 data.js 已不再输出 e2，于是「已持续」永远是「— 天」。
       统一走 daysOf(r)（r.stateDays），与表格 / 前世今生同源。 */
    var days = daysOf(r);

    var h = '';
    // 00 结论速览
    h += sec(0, '结论速览', '', '<div class="kpis">'
      /* 现价必须是第一张卡：所有对比（离均线多远、离箱体上下沿多远）
         都要有价格做参照，看不到价格就等于没法判断。 */
      + kpi('现价', ((q && q.price != null) ? fmt(q.price, 2) : '—')
        + (q && q.chg != null ? ' <span class="' + (q.chg > 0 ? 'up' : (q.chg < 0 ? 'down' : 'mut')) + '" style="font-size:13px">'
          + (q.chg >= 0 ? '+' : '') + q.chg.toFixed(2) + '%</span>' : ''),
        q && q.price != null ? (q.source || '实时') : '待行情')
      + kpi('三态', stateBlock(r, { click: false, tag: false, date: false }), '阶段判断 · 明细见下方')
      + kpi('六派共振', bull + '/6 看启动', '看多票数')
      + kpi('已持续', days != null ? days + ' 个交易日' : '—', '当前态 · 截至该股数据日')
      + '<div class="kpi" id="lensDayKpi"><div class="l">今日</div><div class="v">' + daySpan(q, '—') + '</div><div class="s">'
      + (isSuspended(q) ? '无成交 · 停牌或未开盘' : (q.chg != null ? '实时' : '快照无当日')) + '</div></div>'
      + '</div>' + statePhaseNote(r)
      /* 路径推演不只放前世今生：抽屉（侧栏透镜）是最高频的查看入口，
         很多人从列表点开就看这一屏，所以同样要给出「接下来怎么走」。 */
      + (window.AB_PATH && window.AB_PATH.render ? window.AB_PATH.render(r) : '')
      + (topEv ? '<div class="notice" style="background:#eef4fb;border-color:#cfe2f6;color:#1d4e86">' + esc(topEv) + '</div>' : '')
      + insightBlock(r, q));

    // 01 前世今生（状态脉络 + 当前位置）
    h += sec(1, '前世今生', '三态切换脉络 · 快照', historyTimeline(r)
      + '<div class="evo-wrap" data-evo-code="' + esc(r.code) + '"><div class="hint">正在读取前复权日K，逐日重算历史三态…</div></div>'
      + positionBar(r));

    // 02 价格区间 + 图
    h += sec(2, '价格区间表现', '四窗口区间涨跌（快照）', '<div class="kpis">'
      + kpi('近5日', '<span class="mut">' + pct(r.pct && r.pct.w5) + '</span>', '快照·不含当日')
      + kpi('近20日', '<span class="mut">' + pct(r.pct && r.pct.w20) + '</span>', '快照')
      + kpi('近60日', '<span class="mut">' + pct(r.pct && r.pct.w60) + '</span>', '快照')
      + kpi('近250日', '<span class="mut">' + pct(r.pct && r.pct.w250) + '</span>', '快照')
      + kpi('上市以来', '<span class="mut" data-listed>读取中…</span>', '首根K线至今')
      + kpi('总市值', isNum(r.mcap) ? fmt(r.mcap, 1) + '亿' : '—', typeLabel(r))
      + '</div>'
      + '<div id="lensChart" class="chart-box" style="height:280px;margin-top:12px"></div>'
      + '<div class="hint">前复权日K 蜡烛图（红涨绿跌）+ MA5 / MA20 + 成交量，Canvas 零依赖直接绘制；'
      + '鼠标悬停看当日开高低收。多源日K 均失败时回退快照归一化净值折线（今日=100，非逐日K线）。'
      + '仅反映历史走势，不预示未来。</div>'
      + anchorCards(r));

    // 03 六派详解（每派原文依据 + 决定性证据 Top3）
    h += sec(3, '六派信号详解', '结构 / 量价 / 资金 / 情绪 / 配置 / 舆情 · 每派均带判断日期',
      sixTags(r) + '<div style="height:10px"></div>' + sixEvidence(r)
      + '<details class="st-details"><summary>六派各自判断的时间与启动起点（点开 / 收起）</summary>'
      + sixTimingHtml(r, true) + '</details>');

    // 04 舆情与主题（含代表资讯 + 关联标的 / RRG）
    var themes = Array.isArray(r.themes) ? r.themes : [], tmap = {};
    themeList().forEach(function (t) { tmap[t.key] = t.name; });
    var nm = r.newsMain;
    h += sec(4, '舆情、主题与关联', '实时资讯密度 · 与「资讯雷达」同一套口径',
      '<div class="radar-embed" id="newsEmbed" data-news-code="' + esc(r.code) + '" data-news-name="' + esc(r.name) + '">'
      + '<div class="hint">正在拉取实时资讯与热度…</div></div>'
      + (themes.length ? '<div class="six">' + themes.map(function (t) { return '<span class="tag mid">' + esc(tmap[t] || t) + '</span>'; }).join('') + '</div>' : '')
      + '<div class="section-title" style="margin:14px 0 8px"><h2 style="font-size:14px">关联标的 / 同类对比 / RRG</h2></div>'
      + etfCompareHtml(r));

    // 05 监控清单（客观核对项，不含任何仓位/买卖指令）
    var basis = e2.basis || e2.note || '';
    h += sec(5, '监控清单', '客观核对项 · 非建议', monitorList(r)
      + (basis ? '<div class="hint">快照口径：' + esc(basis) + '</div>' : ''));

    // 06 来源
    var meta = DS.meta() || {};
    h += sec(6, '来源与口径', '', '<div class="src">数据：腾讯 / 新浪免费行情全市场重算（三态截至 ' + esc(asOfClean(meta)) + '）。资金派优先取东财最近交易日真实资金流（个股/ETF 口径分列），失败退代理并标注；实时行情：东财/腾讯/新浪三源降级。本页为客观历史快照与公开数据整理，<b>不构成投资建议，不预示未来收益</b>。</div>');
    h += sec(7, '白话词典', '看得懂 · 可核对', '<div class="glossary"><details open><summary>名词解释（点开 / 收起）</summary>'
      + '<p><b>三态</b>：阶段的判断，不是涨跌预测；<b>六派</b>：六个维度各自投方向票，✗ 不代表看跌。</p>'
      + '<p><b>判断日期</b>：结论依据数据的截至日，距今越久越可能失效；<b>此后表现 / 命中率</b>为客观历史统计，样本有限，不预示未来。</p>'
      + '<p><b>数据缺口</b>：无财报盈利质量 / 同行估值 / 全球对比字段，缺口如实标注，不以零代替。</p>'
      + '</details></div>');
    return h;
  }
  function sec(no, t, d, inner) {
    return '<div class="lens-sec"><div class="lh"><span class="no">' + no + '</span><h3>' + esc(t) + '</h3>' + (d ? '<span class="d">' + esc(d) + '</span>' : '') + '</div>' + inner + '</div>';
  }
  function initChart(el) {
    if (typeof echarts === 'undefined') return null;
    try { var old = echarts.getInstanceByDom(el); if (old) old.dispose(); } catch (e) {}
    var c = echarts.init(el);
    if (window.ResizeObserver) { try { var ro = new ResizeObserver(function () { try { c.resize(); } catch (e2) {} }); ro.observe(el); } catch (e3) {} }
    requestAnimationFrame(function () { requestAnimationFrame(function () { try { c.resize(); } catch (e4) {} }); });
    return c;
  }
  /* 价格全景：只在前复权日K 到位时画真蜡烛 K 线。
   * 多源全失败时明确标「这不是 K 线」，绝不把快照 5 锚点连线伪装成 K 线。 */
  function drawSeriesChart(elId, r) {
    var el = $(elId); if (!el) return;
    el.innerHTML = '<div class="kline-loading"><span class="spin"></span>正在获取前复权日K（离线静态 → 东财 → 腾讯 → 新浪，约数秒内）…<br><span class="cat">这是真实请求，并非伪造进度；任一源成功即画真 K 线，全部失败会明确标「非 K 线」。</span></div>';
    if (!r || !r.code || !DS.getKline) return;
    /* 前世今生要看「上市至今」，250 根（约一年）太短。
       这里先尝试腾讯全历史（一次请求，可回溯到上市），失败再退回本地分片。 */
    /* 腾讯日K 单次只给 800 根（约 3 年），要「上市以来」必须走东财（lmt 可到 6000+）。
       之前这里调 tencentKlineLive(6000)，实际拿到 800 根就被截断了，
       所以「上市以来」显示的首根是 2023 年 —— 不是真的上市日。 */
    var src = (elId === 'histChart')
      ? DS.getKline(r.code, 6000).catch(function () { return null; })
      : Promise.resolve(null);
    src.then(function (full) {
      if (full && full.bars && full.bars.length > 300) return full;
      return klineFor(r.code);
    }).then(function (k) {
      var cur = $(elId); if (!cur) return;
      if (k && k.bars && k.bars.length > 1) {
        var isIdx = r.kind === 'index';
        /* 「上市以来」：用这次拉到的全是历史里第一根 K 线算，比快照的四个窗口更有参照意义 */
        var kpLs = document.querySelectorAll('[data-listed]');
        for (var ki = 0; ki < kpLs.length; ki++) {
          var kpL = kpLs[ki];
          if (!(k.bars.length > 10)) break;
          var fb = k.bars[0], lb = k.bars[k.bars.length - 1];
          var fp = (fb.c > 0) ? ((lb.c / fb.c - 1) * 100) : null;
          if (fp != null && isFinite(fp)) {
            kpL.textContent = pct(fp);
            kpL.className = signCls(fp);
            kpL.title = '首根K线 ' + String(fb.d || fb.date || '').slice(0, 10)
              + ' 收 ' + fmt(fb.c, 2) + ' → 最新 ' + fmt(lb.c, 2)
              + '；共 ' + k.bars.length + ' 根，已含复权';
          } else {
            /* 前复权首根为负（长期分红的老股，如茅台）= 算不出涨跌，
               改用后复权重算一次：后复权价恒为正，是「上市至今」的正确口径。 */
            kpL.textContent = '换算中…';
            (function (el) {
              if (!DS.getKlineHfq) { el.textContent = '—'; return; }
              DS.getKlineHfq(r.code, 6000).then(function (h) {
                if (!h || !h.bars || h.bars.length < 10) { el.textContent = '—'; return; }
                var f0 = h.bars[0], l0 = h.bars[h.bars.length - 1];
                if (!(f0.c > 0)) { el.textContent = '—'; return; }
                var p2 = (l0.c / f0.c - 1) * 100;
                el.textContent = pct(p2);
                el.className = signCls(p2);
                el.title = '后复权口径（长期分红会让前复权价变成负数，故改用后复权）｜首根 '
                  + String(f0.d || f0.date || '').slice(0, 10) + ' 起，共 ' + h.bars.length + ' 根';
              }).catch(function () { el.textContent = '—'; });
            })(kpL);
          }
        }
        drawCanvasChart(cur, {
          bars: k.bars, source: k.source, showLast: 120, bands: true, isIdx: isIdx,
          notice: '真 · ' + (isIdx ? '指数日K（指数无除权，点位即连续序列）' : '前复权日K')
            + ' ｜ 最近 ' + Math.min(120, k.bars.length) + ' / ' + k.bars.length
            + ' 根 · 来源 ' + esc(k.source || '—') + ' · 红涨绿跌 · MA5 / MA20 · 成交量'
            + ' · 背景三态带＝逐日重算（蓝启动/灰盘整/橙走完）'
        });
        return;
      }
      cur.innerHTML = '<div class="kline-fail"><b>前复权日K 暂不可用</b>'
        + '<div>已尝试：离线静态 kline.js / 东财 push2his / 东财 push2 / 腾讯 fqkline / 新浪（整体 ≤9 秒上限）。'
        + '下方仅为快照 5 个锚点的归一化净值连线，<b>不是 K 线、不是逐日行情</b>；'
        + '请检查网络或在交易时段重试，也可运行 tools/regen_offline.py 生成离线日K 后重新发布。</div></div>';
      var s = (r && Array.isArray(r.series)) ? r.series : [];
      if (s.length) {
        var box = document.createElement('div'); box.className = 'kline-fallback';
        cur.appendChild(box);
        drawCanvasChart(box, { series: s, source: '快照锚点' });
      }
    }).catch(function () {
      var cur = $(elId); if (!cur) return;
      cur.innerHTML = '<div class="kline-fail"><b>日K 全部源均未取到</b>'
        + '<div>本页其余快照数据仍可查看；图表位置不显示任何伪装成 K 线的折线。</div></div>';
    });
  }
  function drawLensChart(r) { drawSeriesChart('lensChart', r); }
  /* code 可能是裸码 / sh 前缀 / 全码；一律先经 snapshot 归一成 r.code 再画。
     K 线图、筹码分布、历史档案、实时价必须指向同一个标的，
     否则会出现「筹码是指数点位、K线是个股价格」这种同一页两套行情。 */
  function drawHistoryChart(code) {
    var r = DS.snapshot(code);
    if (r) drawSeriesChart('histChart', r);
  }
  function refreshLensLive(code) {
    code = normCode(code);          // 写入 QUOTES 的键必须是全码，否则 QUOTES[r.code] 取不到
    DS.getQuoteSingle(code).then(function (q) {
      if (!q) return;
      QUOTES[code] = q;
      updateStateBanner(q.source, Date.now());
      var cell = $('lensDayKpi');
      if (cell) cell.innerHTML = '<div class="l">今日</div><div class="v">' + daySpan(q, '—') + '</div><div class="s">'
        + (isSuspended(q) ? '无成交 · 停牌或未开盘' : '实时 · ' + (q.source || '')) + '</div>';
    }).catch(function () {});
    /* 资金派：拉当日主力净流入补快照的空缺（免费源只留半年，做不了历史回测，
       所以这里只更新当前透镜的显示，绝不改写 data.js 或任何历史统计）。 */
    try {
      if (window.AB_FUNDFLOW) {
        var _rr = DS.snapshot(code);
        window.AB_FUNDFLOW.get(code, function (ff) {
          if (!ff) return;   // 拉不到就保持快照原值（行业代理），不编造
          var box = $('drawerBody');
          if (!box || !box.classList.contains('open') && !$('drawer').classList.contains('open')) return;
          var r = DS.snapshot(code);
          if (!r) return;
          /* 六派依据明细里的资金单元格（这是用户截图里最显眼的那一行） */
          var fundCell = box.querySelector('[data-fund-evi]');
          if (fundCell) fundCell.textContent = ff.label + ' · 资金分 ' + fmt((r.scores || {}).fund, 2);
          /* 只重绘「六派诊断」里资金那一条，不动其余内容。
             用文本替换：找到含「资金面无显著方向/资金派支持/资金派反对」的行，替换其详情。 */
          var dirCls = ff.dir > 0 ? 'good' : (ff.dir < 0 ? 'bad' : 'warn');
          var dirTxt = ff.dir > 0 ? '净流入' : (ff.dir < 0 ? '净流出' : '中性');
          var nodes = box.querySelectorAll('.diag-row, .six-row, [data-six]');
          var patched = false;
          Array.prototype.forEach.call(nodes, function (n) {
            if (patched) return;
            var txt = n.textContent || '';
            if (txt.indexOf('资金') < 0) return;
            var lbl = (n.querySelector('.d, .detail, .six-d, .cat') || null);
            if (lbl) {
              lbl.textContent = '资金派' + (ff.dir > 0 ? '支持：' : (ff.dir < 0 ? '反对：' : '中性：')) + ff.label;
              patched = true;
            }
          });
          if (!patched) {
            /* 找不到可精确替换的行时，在资金派区块顶部插一条实时标签 */
            var anchor = null;
            Array.prototype.forEach.call(box.querySelectorAll('*'), function (n) {
              if (!anchor && (n.textContent || '').indexOf('主力净流入') >= 0 && n.children.length < 3) anchor = n;
            });
            if (anchor) {
              var tip = document.createElement('div');
              tip.className = 'ff-live-tip';
              tip.textContent = '实时资金：' + ff.label + '（资金派投票 ' + (ff.dir > 0 ? '赞成' : (ff.dir < 0 ? '反对' : '中性')) + '）';
              anchor.parentNode.insertBefore(tip, anchor);
            }
          }
        }, _rr && _rr.kind);
      }
    } catch (e) { }
  }

  /* ---------- 代表资讯 / ETF 关联（透镜与前世今生复用） ---------- */
  function newsLinksHtml(r) {
    var items = Array.isArray(r.newsItems) ? r.newsItems : [], links = [];
    items.forEach(function (n) {
      (Array.isArray(n.top) ? n.top : []).forEach(function (x) {
        var u = safeUrl(x.u);
        if (u) links.push({ d: x.d, t: x.t, u: u });
      });
    });
    if (!links.length) return '';
    return '<div class="news-links"><div class="lb">代表资讯（快照留存 · 点击打开原文）</div>'
      + links.slice(0, 6).map(function (x) {
        return '<a href="' + esc(x.u) + '" target="_blank" rel="noopener noreferrer">'
          + esc(x.d || '') + ' · ' + esc(x.t || '') + '</a>';
      }).join('') + '</div>';
  }
  function etfCompareHtml(r) {
    var rows = [];
    function add(l, v) { if (v != null && v !== '') rows.push('<div class="evi-row"><span class="p">' + l + '</span><span>' + esc(v) + '</span></div>'); }
    if (r.etfLink) add('关联 ETF', (r.etfLinkName || '') + '（' + r.etfLink + '）');
    if (r.index) add('跟踪指数', r.index);
    if (r.fee != null) add('管理费率', fmt(Number(r.fee), 2) + '%');
    if (r.size != null) add('规模', fmt(Number(r.size), 1) + ' 亿');
    if (r.rrg) add('RRG 象限', quadOf(r) + '（相对强度 ' + fmt(r.rrg.x, 1) + ' / 动量 ' + fmt(r.rrg.y, 1) + '）');
    if (Array.isArray(r.alts) && r.alts.length) {
      var alts = r.alts.slice(0, 4).map(function (a) {
        if (typeof a === 'string') return esc(a);
        return esc(a.name || a.code || '') + (a.fee != null ? '（费率 ' + fmt(Number(a.fee), 2) + '%）' : '');
      }).join('、');
      if (alts) add('同类备选', alts);
    }
    if (r.fundLabel) add('资金口径', r.fundLabel + (r.fundProxy ? '（代理值）' : ''));
    return rows.length ? '<div class="evi">' + rows.join('') + '</div>' : '<div class="mut">快照未记录关联标的</div>';
  }

  /* ---------- 动态分享海报（Canvas 2× + 本地 qrcode.js） ----------
   * 深链：?ref=VID&focus=CODE#/lens?code=CODE —— guard.js 仍能从 location.search 捕获 ref，
   * 新版自身从 hash 的 code 打开透镜，接收端展示「XX 分享给你」。 */
  var POSTER_URL = '', POSTER_CODE = '', REF_FROM = '';
  function shareDeepLink(code) {
    var u = window.AB_USER || {}, parts = [], base = location.origin + location.pathname;
    /* sharecode 必须带出去，否则别人打开就是「链接不完整」。
       取值顺序：当前地址 → 本机记住的 → 应用固定的。
       前两个都可能为空（比如从书签或无参入口打开），所以必须有最后一道兜底，
       否则分享出去的链接一律打不开。 */
    var sc = ''; try { sc = new URLSearchParams(location.search).get('sharecode') || ''; } catch (e) {}
    if (!sc) { try { sc = localStorage.getItem('ab_sharecode') || ''; } catch (e) { } }
    if (!sc) sc = 'EPDR6ET2KO';
    try { localStorage.setItem('ab_sharecode', sc); } catch (e) { }
    if (sc) parts.push('sharecode=' + encodeURIComponent(sc));
    if (u.vid) parts.push('ref=' + encodeURIComponent(u.vid));
    if (code) parts.push('focus=' + encodeURIComponent(code));
    return base + (parts.length ? '?' + parts.join('&') : '')
      + '#/lens?code=' + encodeURIComponent(code || '');
  }
  function loadQR() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'qrcode.js?v=20261114f';
      s.onload = function () { window.qrcode ? res(window.qrcode) : rej(new Error('qrcode 未就绪')); };
      s.onerror = function () { rej(new Error('二维码组件加载失败')); };
      document.head.appendChild(s);
    });
  }
  function drawQR(c, url, x, y, size) {
    if (!window.qrcode) return false;
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(url); qr.make();
      var n = qr.getModuleCount(), cell = size / n, pad = 10;
      c.fillStyle = '#ffffff'; c.fillRect(x - pad, y - pad, size + pad * 2, size + pad * 2);
      c.fillStyle = '#111827';
      for (var row = 0; row < n; row++) {
        for (var col = 0; col < n; col++) {
          if (qr.isDark(row, col)) c.fillRect(x + col * cell, y + row * cell, Math.ceil(cell), Math.ceil(cell));
        }
      }
      return true;
    } catch (e) { return false; }
  }
  function rr(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
  }
  function wrapText(c, txt, x, y, maxW, lh, maxLines) {
    var line = '', lines = [], s = String(txt || '');
    for (var i = 0; i < s.length; i++) {
      var test = line + s[i];
      if (c.measureText(test).width > maxW && line) { lines.push(line); line = s[i]; if (lines.length >= maxLines) break; }
      else line = test;
    }
    if (line && lines.length < maxLines) lines.push(line);
    lines.slice(0, maxLines).forEach(function (l, i) { c.fillText(l, x, y + i * lh); });
    return lines.length * lh;
  }
  function posterBase(c, W, H, title, sub) {
    var g = c.createLinearGradient(0, 0, W, 230);
    g.addColorStop(0, '#2563eb'); g.addColorStop(.55, '#5b45d8'); g.addColorStop(1, '#7c3aed');
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);
    c.fillStyle = g; c.fillRect(0, 0, W, 230);
    c.fillStyle = 'rgba(255,255,255,.14)'; c.beginPath(); c.arc(W - 40, 24, 150, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#ffffff'; c.font = '700 42px "PingFang SC","Microsoft YaHei",sans-serif';
    c.fillText('三态看盘', 50, 92);
    c.font = '500 20px "PingFang SC","Microsoft YaHei",sans-serif'; c.fillStyle = 'rgba(255,255,255,.9)';
    c.fillText('用三态看懂 A 股处在 启动 · 盘整 · 走完', 50, 130);
    c.font = '400 17px "PingFang SC","Microsoft YaHei",sans-serif'; c.fillStyle = 'rgba(255,255,255,.72)';
    c.fillText(sub || ('数据截至 ' + asOfClean(DS.meta())), 50, 168);
    c.font = '700 24px "PingFang SC","Microsoft YaHei",sans-serif'; c.fillStyle = '#ffffff';
    c.fillText(title, 50, 210);
  }
  function posterFoot(c, W, H, url) {
    var y = H - 260;
    c.fillStyle = '#f7f9ff'; c.fillRect(0, y - 22, W, 282);
    c.fillStyle = '#98a2b3'; c.font = '400 17px "PingFang SC","Microsoft YaHei",sans-serif';
    c.fillText('扫码看这只标的的三态与六派依据', 50, y + 14);
    c.fillText('长按识别 / 保存到相册再分享', 50, y + 40);
    c.fillStyle = '#5b6478'; c.font = '400 15px "PingFang SC","Microsoft YaHei",sans-serif';
    wrapText(c, '本卡为客观历史快照与公开数据整理，不构成投资建议，不预示未来收益。三态为阶段判断，与涨跌无必然关系。',
      50, y + 74, 370, 23, 3);
    var qrSize = 176;                 // >=100px，保证手机可识别（GitHub 实践）
    drawQR(c, url, W - qrSize - 56, y + 8, qrSize);
    c.fillStyle = '#111827'; c.font = '600 16px "PingFang SC","Microsoft YaHei",sans-serif';
    c.fillText('三态看盘 · 每日信号', 50, H - 24);
  }
  function drawPosterCard(cv, r, url) {
    var c = cv.getContext('2d'); if (!c) return;
    var W = cv.width, H = cv.height;
    posterBase(c, W, H, '单标的分享卡', (r.asOf || ('数据截至 ' + asOfClean(DS.meta()))));
    var e2 = r.e2 || {}, p = r.pct || {}, q = QUOTES[r.code] || {};
    // 主卡
    c.fillStyle = '#ffffff'; rr(c, 40, 258, W - 80, 566, 22); c.fill();
    c.strokeStyle = '#e3e8f2'; c.lineWidth = 2; c.stroke();
    c.fillStyle = '#111827'; c.font = '700 46px "PingFang SC","Microsoft YaHei",sans-serif';
    c.fillText(String(r.name || '').slice(0, 12), 72, 326);
    c.fillStyle = '#98a2b3'; c.font = '400 20px "PingFang SC","Microsoft YaHei",sans-serif';
    c.fillText(String(r.code || '') + ' · ' + typeLabel(r) + ' · ' + String(r.ind || '—'), 72, 360);
    // 三态徽标（中性三色，不绑红绿）
    var col = r.state === '启动' ? '#1d4ed8' : (r.state === '盘整' ? '#667085' : '#b45309');
    c.fillStyle = col; rr(c, 72, 384, 216, 66, 14); c.fill();
    c.fillStyle = '#ffffff'; c.font = '700 30px "PingFang SC","Microsoft YaHei",sans-serif';
    c.fillText((r.state === '启动' ? '▲ ' : r.state === '盘整' ? '— ' : '▼ ') + (r.state || '—'), 94, 429);
    c.fillStyle = '#111827'; c.font = '700 28px "PingFang SC","Microsoft YaHei",sans-serif';
    c.fillText(bullCount(r) + '/6 派看启动', 312, 427);
    c.fillStyle = '#98a2b3'; c.font = '400 17px "PingFang SC","Microsoft YaHei",sans-serif';
    c.fillText('阶段判断 · 非涨跌建议', 72, 478);
    // 四窗口
    var wins = [['近5日', p.w5], ['近20日', p.w20], ['近60日', p.w60], ['近250日', p.w250]];
    wins.forEach(function (w, i) {
      var x = 72 + i * 155;
      c.fillStyle = '#f7f9ff'; rr(c, x, 500, 142, 96, 12); c.fill();
      c.fillStyle = '#98a2b3'; c.font = '400 17px "PingFang SC","Microsoft YaHei",sans-serif';
      c.fillText(w[0], x + 14, 528);
      c.fillStyle = '#111827'; c.font = '700 25px "PingFang SC","Microsoft YaHei",sans-serif';
      c.fillText(pct(w[1]), x + 14, 568);
    });
    // 今日（如有）
    c.fillStyle = '#5b6478'; c.font = '400 18px "PingFang SC","Microsoft YaHei",sans-serif';
    c.fillText('今日（实时）：' + (q.chg != null ? pct(q.chg) : '实时源暂不可用 · 快照不含当日'), 72, 630);
    // 客观历史统计
    c.fillStyle = '#111827'; c.font = '700 20px "PingFang SC","Microsoft YaHei",sans-serif';
    c.fillText('客观历史统计', 72, 674);
    c.fillStyle = '#5b6478'; c.font = '400 17px "PingFang SC","Microsoft YaHei",sans-serif';
    wrapText(c, (e2.histStat && e2.histStat.txt) || '相似形态样本不足，不做概率统计。', 72, 704, W - 160, 25, 2);
    // 决定性证据
    var ev = [];   // 决定性证据不再读旧快照（会与当前分数打架），改由当前分数现算
    if (ev.length) {
      c.fillStyle = '#111827'; c.font = '700 20px "PingFang SC","Microsoft YaHei",sans-serif';
      c.fillText('决定性证据', 72, 770);
      c.fillStyle = '#5b6478'; c.font = '400 17px "PingFang SC","Microsoft YaHei",sans-serif';
      wrapText(c, (ev[0].p ? ev[0].p + '：' : '') + (ev[0].txt || ''), 72, 798, W - 160, 24, 1);
    }
    // 情谊文案
    if (REF_FROM) {
      c.fillStyle = '#7c3aed'; c.font = '600 20px "PingFang SC","Microsoft YaHei",sans-serif';
      c.fillText('好友 ' + String(REF_FROM).slice(0, 12) + ' 分享给你 · 一起用三态看盘', 50, 862);
    }
    posterFoot(c, W, H, url);
  }
  /* 全站分享海报：不讲「今天涨了什么」，讲「这个工具能帮你看什么」。
     分享出去的大多是不认识的人，给他一张信号榜没有意义；
     三句话把方法说清，才有人愿意扫码。 */
  function drawPosterBoard(cv, url) {
    var c = cv.getContext('2d'); if (!c) return;
    var W = cv.width, H = cv.height;
    posterBase(c, W, H, '三态看盘', '看清 A 股现在站在哪一步');

    c.fillStyle = '#ffffff'; rr(c, 40, 250, W - 80, 640, 22); c.fill();
    c.strokeStyle = '#e3e8f2'; c.lineWidth = 2; c.stroke();

    var items = [
      ['①', '现在是什么状态',
        '沪深北 5500 余只股票、520 余只 ETF，',
        '每只都标在「启动 / 盘整 / 走完」三态里，',
        '谁刚起来、谁在磨、谁在派发，一眼看清。'],
      ['②', '接下来可能怎么走',
        '每种状态都列出几种可能的分支，',
        '写明「到什么条件走哪条」「走到那条该怎么做」。',
        '不猜涨跌，只把路摆出来。'],
      ['③', '板块是不是一起动',
        '板块跑同一套三态。个股启动时，能看出',
        '它所在的板块是否也在启动 ——',
        '有同伴的行情，和孤军奋战是两回事。']
    ];
    var y0 = 306;
    items.forEach(function (it, i) {
      var y = y0 + i * 208;
      c.fillStyle = '#2f6bff';
      c.font = '700 30px "PingFang SC","Microsoft YaHei",sans-serif';
      c.fillText(it[0], 78, y);
      c.fillStyle = '#111827';
      c.font = '700 27px "PingFang SC","Microsoft YaHei",sans-serif';
      c.fillText(it[1], 124, y);
      c.fillStyle = '#5b6478';
      c.font = '400 19px "PingFang SC","Microsoft YaHei",sans-serif';
      c.fillText(it[2], 124, y + 46);
      c.fillText(it[3], 124, y + 80);
      c.fillText(it[4], 124, y + 114);
    });
    posterFoot(c, W, H, url);
  }
  /* 当前时段速览的绘图参数（标题按早报/午间/收盘自动换名） */
  function posterDailyParams() {
    var D = (typeof window !== 'undefined') ? window.AB_DAILY : null;
    var S = dailySlot(D);
    if (!D || !S || !S.oneLine) return null;
    var slotName = (S === D.morning) ? '早盘' : (S === D.noon ? '午盘' : (S === D.close ? '收盘' : ''));
    var watchTitle = slotName === '午盘' ? '下午关注' : (slotName === '收盘' ? '明日关注' : '今日关注');
    return { D: D, S: S, title: dailyTitle(D, S), slotName: slotName, watchTitle: watchTitle };
  }
  /* canvas → img：微信只对 <img> 提供「保存到相册」，对 <canvas> 没有。
     所以画完统一转成 dataURL 放进 img，并把 canvas 藏起来。 */
  function posterToImg(cv) {
    var img = $('posterImg'); if (!img) return false;
    try {
      img.src = cv.toDataURL('image/png');
      img.classList.add('on');
      cv.style.display = 'none';
      return true;
    } catch (e) {
      cv.style.display = 'block';
      img.classList.remove('on');
      return false;
    }
  }
  function renderPoster() {
    var cv = $('posterCanvas'); if (!cv || !cv.getContext) return;
    try {
      var r = POSTER_CODE ? DS.snapshot(POSTER_CODE) : null;
      var P = posterDailyParams();
      if (POSTER_CODE && r) {
        cv.width = 750; cv.height = 1120;
        drawPosterCard(cv, r, POSTER_URL);
      } else if (P && window.STK_POSTER && window.STK_POSTER.draw(cv, POSTER_URL, P)) {
        /* 早报长图：尺寸由内容撑开，draw() 内部自己设宽高 */
      } else {
        cv.width = 750; cv.height = 1120;
        drawPosterBoard(cv, POSTER_URL);
      }
      posterToImg(cv);
    } catch (e) {
      var hint = $('posterHint'); if (hint) hint.textContent = '海报绘制失败：' + (e && e.message ? e.message : '未知') + '，可直接复制深链分享';
    }
  }
  function openPoster(code) {
    var modal = $('posterModal'), mask = $('posterMask'); if (!modal || !mask) return;
    POSTER_CODE = code ? normCode(code) : '';
    POSTER_URL = shareDeepLink(POSTER_CODE);
    var P = posterDailyParams();
    var t = $('posterTitle');
    if (t) t.textContent = POSTER_CODE ? '单标的分享卡' : (P ? '分享卡 · ' + P.title : '分享卡 · 三态看盘');
    var hint = $('posterHint');
    if (hint) hint.textContent = '长按图片可保存到相册' + (P && !POSTER_CODE ? ' · 图里就是本档速览正文' : ' · 二维码指向该标的深链');
    modal.classList.add('open'); mask.classList.add('open');
    renderPoster();                                  // 先出不依赖网络的版本
    loadQR().then(function () { renderPoster(); }).catch(function () {});   // 二维码就绪后重绘
  }
  function closePoster() {
    var modal = $('posterModal'), mask = $('posterMask');
    if (modal) modal.classList.remove('open');
    if (mask) mask.classList.remove('open');
  }
  /* 生成当前时段速览的纯文字，用于微信里复制粘贴分享（微信不支持下载 PNG）。
     内容 = 标题 + 时段 + 一句话 + 多空清单 + 权衡 + 分析点 + 新闻 + 关注点 + 风险提示。 */
  function dailyShareText() {
    var D = (typeof window !== 'undefined') ? window.AB_DAILY : null;
    if (!D) return '';
    var S = dailySlot(D);
    if (!S || !S.oneLine) return '';
    var L = [];
    L.push('【' + dailyTitle(D, S) + ' · ' + (S === D.morning ? '早盘' : S === D.noon ? '午间' : '收盘') + '】');
    L.push((D.date || '') + ' ' + (S.at || ''));
    L.push('');
    L.push(S.oneLine);
    L.push('');
    if ((S.bulls || []).length) { L.push('利多（' + S.bulls.length + '）：'); S.bulls.forEach(function (x) { L.push('+ ' + x); }); }
    if ((S.bears || []).length) { L.push('利空（' + S.bears.length + '）：'); S.bears.forEach(function (x) { L.push('- ' + x); }); }
    if (S.weigh) { L.push(''); L.push('怎么权衡的：' + S.weigh); }
    if ((S.points || []).length) {
      L.push(''); L.push('要点：');
      S.points.forEach(function (x, i) { L.push((i + 1) + '. ' + x); });
    }
    if ((S.news || []).length) {
      L.push(''); L.push('新闻速览：');
      S.news.forEach(function (n) {
        L.push('[' + n.dir + '/' + n.lvl + '] ' + n.t + '：' + (n.d || ''));
        if (n.long) L.push('   ' + n.long);
      });
    }
    if (S.watch) { L.push(''); L.push('关注：' + S.watch); }
    if (D.risk) { L.push(''); L.push(D.risk); }
    return L.join('\n');
  }

  function bindPoster() {
    function on(id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); }
    /* 顶栏的分享按钮：任何页面都能点。
       在个股详情/抽屉里打开时，带当前标的生成「那只票」的卡；
       否则生成全站大盘卡。这样不管在哪个页面，右手边都有出口。 */
    on('shareBtn', function () {
      var code = '';
      try { if (typeof ACTIVE_CODE !== 'undefined' && ACTIVE_CODE) code = ACTIVE_CODE; } catch (e) { }
      openPoster(code || '');
    });
    on('posterClose', closePoster);
    on('posterMask', closePoster);
    on('posterCopy', function () {
      copyText(POSTER_URL);
      var b = $('posterCopy'), old = b ? b.textContent : '';
      if (b) { b.textContent = '✓ 深链已复制'; setTimeout(function () { b.textContent = old; }, 1800); }
    });
    on('posterDownload', function () {
      /* 微信里下载 PNG 会被拦，改为复制当前时段速览文字，直接粘贴即可分享。 */
      var txt = dailyShareText();
      if (!txt) {
        var hint0 = $('posterHint'); if (hint0) hint0.textContent = '暂无可分享的速览文字';
        return;
      }
      copyText(txt);
      var b = $('posterDownload'), old = b ? b.textContent : '';
      if (b) { b.textContent = '✓ 文字已复制'; setTimeout(function () { b.textContent = old; }, 2200); }
      var hint = $('posterHint'); if (hint) hint.textContent = '已复制，去微信里粘贴即可 · 深链在左边按钮';
    });
  }

  /* ---------- 任意标的即时查询（不在 158 只快照池也能看实时价） ---------- */
  function quickLookup(bare) {
    var res = $('searchResults'); if (!res) return;
    var x = DS.marketOf ? DS.marketOf(bare) : { bare: bare, m: 0 };
    var full = x.bare + (x.m === 1 ? '.SH' : '.SZ');
    res.innerHTML = '<div class="r mut">正在查询 ' + esc(bare) + ' 实时行情…</div>';
    res.classList.add('open');
    DS.getTodayQuotes([full]).then(function (out) {
      var q = out && out.map ? out.map[full] : null;
      if (!q) { res.innerHTML = '<div class="r mut">' + esc(bare) + ' 未收录进全市场快照，且实时行情暂不可用（交易时段重试）。</div>'; return; }
      QUOTES[full] = q;
      res.innerHTML = '<div class="r"><span><b>' + esc(bare) + '</b> <span class="cat">' + esc(full)
        + ' · 仅实时报价，未纳入快照池</span></span><span class="' + signCls(q.chg) + '">'
        + (q.chg != null ? pct(q.chg) : '—') + '</span></div>'
        + '<div class="r mut" style="font-size:11px">三态 / 六派结论需运行再生脚本纳入后才有；当前仅展示多源实时价格。</div>';
    }).catch(function () { res.innerHTML = '<div class="r mut">实时源暂不可用，请稍后重试。</div>'; });
  }

  // ---------- 事件绑定（全局委托：动态生成的行/成分股永远可点） ----------
  function bindView(path) {
    bindInvite();
    if (path === '/all') { renderAllHead(); renderAllBody(); }
    if (path === '/sector') renderSectorBody();
    if (path === '/rrg') { renderRrgList(); drawRrgChart(); }
    if (path === '/history') { drawHistoryChart(ACTIVE_CODE); hydrateFinance(ACTIVE_CODE); }
    if (path === '/news') {
      var nkw = $('newsKw');
      // 只有输入框为空时才用记忆值回填，绝不覆盖用户正在输入的内容
      if (nkw && !nkw.value && NEWS_KW) nkw.value = NEWS_KW;
      if (nkw && nkw.value) renderNewsRadar();
      hydrateHotRank();
    }
    if (path === '/' || path === '' || path === '/home') { hydrateIndexStrip(); primeHomeCards(); }
  }

  function closeSearch() {
    var r = $('searchResults'), i = $('searchInput');
    if (r) r.classList.remove('open');
    if (i) i.value = '';
  }
  function doStar(el) {
    var code = el.getAttribute('data-code') || el.getAttribute('data-star-toggle');
    if (!code) return;
    var list = toggleFollow(code);
    if (el.classList) el.classList.toggle('on', isFollow(code));
    if (el.textContent !== undefined && /^[★☆]$/.test(String(el.textContent).trim())) el.textContent = isFollow(code) ? '★' : '☆';
    else el.innerHTML = isFollow(code) ? '★ 已关注' : '☆ 加入我的看板';
    if (list.length === 1) fireValueMoment();
  }
  function sortAllBy(k) {
    if (SORT.key === k) SORT.dir *= -1;
    else { SORT.key = k; SORT.dir = (k === 'name' || k === 'type' || k === 'state') ? 1 : -1; }
    renderAllHead(); renderAllBody(true);
  }
  function applyChip(ch) {
    var g = ch.getAttribute('data-group'), v = ch.getAttribute('data-val');
    FILTER[g] = v;
    if (g === 'st') {
      FILTER.ph = '全部';                 /* 换三态时阶段回到「全部」，否则会筛出空表 */
      var fb = $('filters');
      if (fb) fb.outerHTML = filterBar(); /* 阶段选项跟着重画 */
    }
    document.querySelectorAll('.fchip[data-group="' + g + '"]').forEach(function (x) { x.classList.remove('active'); });
    ch.classList.add('active');
    renderAllBody(true);
  }
  function toggleInd(g) {
    if (OPEN_IND[g]) delete OPEN_IND[g]; else OPEN_IND[g] = 1;
    renderSectorBody();
  }
  function sortSectorBy(k) {
    if (SEC_SORT.key === k) SEC_SORT.dir *= -1;
    else { SEC_SORT.key = k; SEC_SORT.dir = (k === 'name') ? 1 : -1; }
    renderSectorBody();
  }
  function sortMembers(g, k) {
    var s = MEM_SORT[g] || { key: 'day', dir: -1 };
    if (s.key === k) s.dir *= -1; else { s.key = k; s.dir = (k === 'name') ? 1 : -1; }
    MEM_SORT[g] = s;
    renderSectorBody();
  }
  /* ---------- 「本页搜索」：每个列表模块自己的搜索框 ----------
     顶部那个搜索框是全局的（会跳走）。这里给列表页一个"只筛当前表"的输入框，
     输入时不跳转、不重绘整页，只过滤本模块的数据。 */
  var MOD_KW = { all: '', sector: '' };
  function modSearchHost() {
    var b = $('allBody');
    if (b) return { key: 'all', host: b.closest('.table-wrap') ? b.closest('.table-wrap').parentNode : null };
    var sb = $('sectorBody');
    if (sb) return { key: 'sector', host: sb.closest('.table-wrap') ? sb.closest('.table-wrap').parentNode : null };
    return null;
  }
  function injectModuleSearch() {
    var m = modSearchHost();
    if (!m || !m.host) return;
    if (m.host.querySelector('.mod-kw')) return;
    var ph = m.key === 'all' ? '在本页筛选：代码 / 名称，如 600519、茅台'
      : '在本页筛选：行业名，如 半导体、白酒';
    var wrap = document.createElement('div');
    wrap.className = 'mod-kw';
    wrap.innerHTML = '<input type="text" autocomplete="off" placeholder="' + ph + '" value="'
      + esc(MOD_KW[m.key]) + '" /><span class="mk-hint">只筛选本页，不影响顶部全局搜索</span>';
    m.host.insertBefore(wrap, m.host.firstChild);
    var inp = wrap.querySelector('input');
    inp.addEventListener('input', function () {
      MOD_KW[m.key] = inp.value.trim();
      if (m.key === 'all') renderAllBody(true); else renderSectorBody();
    });
  }

  function bindGlobal() {
    document.addEventListener('click', function (e) {
      var t = e.target;
      // 分享海报（优先于 data-open：表格行内的「分享」小按钮不应触发打开透镜）
      if (t && t.hasAttribute && t.hasAttribute('data-hotretry')) {
        hydrateHotRank();
        return;
      }
      var ra = closest(t, '[data-rotall]');
      if (ra) {
        var rk = ra.getAttribute('data-rotall');
        var src = (window.__ROT_ALL || {})[rk] || [];
        var boxEl = ra.parentNode;
        var list = src.slice().sort(function (a, b) {
          return rk === 'next' ? (b.y - a.y) : (rk === 'fade' ? ((a.x + a.y) - (b.x + b.y)) : ((b.x + b.y) - (a.x + a.y)));
        });
        var rowsHtml = list.map(function (o) {
          return '<div class="rot-row"><div class="rot-n"><b>' + esc(o.name) + '</b>'
            + '<span class="cat">' + o.n + ' 只</span></div>'
            /* 注意：事件处理函数里 `t` 已被用作「点击目标」(var t = e.target)，
               这里绝不能再调 t('强度') 这个术语函数 —— 会把 DOM 当函数调用直接抛错，
               表现就是「点了没反应」。术语文案这里直接写死。 */
            + '<div class="rot-v" title="强度 >100 跑赢大盘；动量 >100 还在变强">强度 ' + fmt(o.x, 1) + ' · 动量 ' + fmt(o.y, 1) + '</div>'
            + '<div class="rot-s">启 ' + o.launch + ' / 完 ' + o.done + '（' + fmt(o.launchPct, 0) + '% 启动）</div>'
            + (o.rep ? '<div class="rot-rep" data-open="' + esc(o.rep.code) + '">' + esc(o.rep.name)
              + ' <span class="cat">' + bullCount(o.rep) + '/6</span></div>' : '')
            + '<div class="rot-more" data-rotind="' + esc(o.name) + '" data-rotn="' + o.n + '">全部 ' + o.n + ' 只 ›</div>'
            + '</div>';
        }).join('');
        var keep = [];
        for (var ci = 0; ci < boxEl.childNodes.length; ci++) {
          var nd = boxEl.childNodes[ci];
          if (nd.className && String(nd.className).indexOf('rot-h') >= 0) keep.push(nd.outerHTML);
        }
        boxEl.innerHTML = keep.join('') + rowsHtml
          + '<div class="rot-alln"><span style="color:var(--hint)">已展开全部 ' + list.length + ' 个</span></div>';
        return;
      }
      var hs = closest(t, '[data-hsort]');
      if (hs) {
        var hk = hs.getAttribute('data-hsort');
        if (HOT_SORT.key === hk) HOT_SORT.dir = -HOT_SORT.dir;
        else { HOT_SORT.key = hk; HOT_SORT.dir = (hk === 'name' || hk === 'rank') ? 1 : -1; }
        if (window.__repaintHot) { try { window.__repaintHot(); } catch (e) { } }
        return;
      }
      var jp = closest(t, '[data-jump]');
      if (jp) {
        var jv = jp.getAttribute('data-jump') || '';
        var jparts = jv.split(':');
        if (jparts[0] === 'all') { FILTER.st = jparts[1] || '全部'; navigate('/all'); }
        return;
      }
      var nw = closest(t, '[data-nlong]');
      if (nw) {
        var k = nw.getAttribute('data-nlong');
        DAILY_NEWS[k] = !DAILY_NEWS[k];
        /* 展开一条新闻要重渲染整页，滚动位置会丢 —— 手机上表现为「一点就跳回顶部」。
           记住当前 scrollY，渲染后立刻回到原位。 */
        var keepY = window.pageYOffset || document.documentElement.scrollTop || 0;
        render();
        setTimeout(function () { window.scrollTo(0, keepY); }, 0);
        return;
      }
      var dly = closest(t, '[data-daily]');
      if (dly) {
        DAILY_OPEN = !DAILY_OPEN;
        var keepY2 = window.pageYOffset || document.documentElement.scrollTop || 0;
        render();
        setTimeout(function () { window.scrollTo(0, keepY2); }, 0);
        return;
      }
      var ms = closest(t, '[data-msort]');
      if (ms) {
        var k = ms.getAttribute('data-msort');
        if (SORT.key === k) SORT.dir = -SORT.dir; else { SORT.key = k; SORT.dir = -1; }
        renderAllBody(true);
        return;
      }
      var sh = closest(t, '[data-share]');
      if (sh) { openPoster(sh.getAttribute('data-share') || ''); return; }
      var hr = closest(t, '.hot-row');
      if (hr) { hotRowToggle(hr); return; }
      // RRG 单只轨迹
      if (t && t.id === 'rtGo') { runRrgTrail(); return; }
      // 资讯雷达
      if (t && t.id === 'newsGo') { renderNewsRadar(); return; }
      if (t && t.id === 'histGo') { histJump(); return; }
      var rn = closest(t, '[data-rnews]');
      if (rn) {
        NEWS_KW = rn.getAttribute('data-rnews') || '';
        navigate('/news'); return;
      }
      var rq = closest(t, '[data-rkw]');
      if (rq) {
        var kwv = rq.getAttribute('data-rkw');
        var box = $('newsKw'); if (box) { box.value = kwv; NEWS_KW = kwv; }
        renderNewsRadar(); return;
      }
      // 全市场分页
      var pg = closest(t, '[data-pg]');
      if (pg) {
        var n = parseInt(pg.getAttribute('data-pg'), 10);
        if (n && n !== ALL_PAGE) { ALL_PAGE = n; renderAllBody(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
        return;
      }
      // 三态时间：点区间展开/收起六派判断时点（必须先于 data-open，避免同时打开透镜）
      var stt = closest(t, '[data-sttime]');
      if (stt) {
        var sc = stt.getAttribute('data-sttime');
        if (sc) {
          var ab = $('allBody');
          var inTable = ab && ab.querySelector('tr[data-open="' + sc + '"]');
          if (inTable) { STTIME_OPEN[sc] = !STTIME_OPEN[sc]; renderAllBody(); hydrateInsights(); }
          else openStateDetail(sc);      // 卡片 / 榜单 / 列表：用浮层，交互与表格一致
        }
        return;
      }
      // RRG 象限选择 / 舆情排序 tab / 首页主题速览 / 任意标的即时查询
      var qd = closest(t, '[data-quad]');
      if (qd) {
        RRG_SEL = qd.getAttribute('data-quad');
        document.querySelectorAll('.quad-card').forEach(function (x) { x.classList.toggle('sel', x.getAttribute('data-quad') === RRG_SEL); });
        renderRrgList(); return;
      }
      var rm = closest(t, '[data-rrgmode]');
      if (rm) {
        RRG_MODE = rm.getAttribute('data-rrgmode') === 'stock' ? 'stock' : 'sector';
        renderPath('/rrg', true);   // 保持滚动位置，避免切换视图就跳回顶部
        return;
      }
      var rme = closest(t, '[data-rotind]');
      if (rme) { rotExpand(rme); return; }
      var nt = closest(t, '[data-ntab]');
      if (nt) { NEWS_SORT = nt.getAttribute('data-ntab'); renderPath('/news', true); return; }
      if (t && t.id === 'newsFilterGo') {
        var sel = $('newsL1'), q = $('newsQ'), oh = $('newsOnlyHit');
        NEWS_L1 = sel ? sel.value : '全部';
        NEWS_Q = q ? q.value.trim() : '';
        NEWS_ONLY_HIT = oh ? !!oh.checked : false;
        renderPath('/news', true); return;
      }
      var nth = closest(t, '[data-ntheme]');
      if (nth) { navigate('/news'); return; }
      var qk = closest(t, '[data-quick]');
      if (qk) { quickLookup(qk.getAttribute('data-quick')); return; }
      var star = closest(t, '.row-star');
      if (star) { doStar(star); return; }
      var stg = closest(t, '[data-star-toggle]');
      if (stg) { doStar(stg); return; }
      var hs = closest(t, '[data-history]');
      if (hs) { ACTIVE_CODE = hs.getAttribute('data-history'); navigate('/history?code=' + encodeURIComponent(ACTIVE_CODE)); return; }
      var ln = closest(t, '[data-lens]');
      if (ln) { ACTIVE_CODE = ln.getAttribute('data-lens'); navigate('/lens?code=' + encodeURIComponent(ACTIVE_CODE)); return; }
      var op = closest(t, '[data-open]');
      if (op) {
        var code = op.getAttribute('data-open');
        if (!code) return;
        ACTIVE_CODE = code; closeSearch();
        navigate('/lens?code=' + encodeURIComponent(code));
        return;
      }
      var ind = closest(t, '[data-indtoggle]');
      if (ind) { toggleInd(ind.getAttribute('data-indtoggle')); return; }
      var thA = closest(t, 'th[data-sort]'); if (thA) { sortAllBy(thA.getAttribute('data-sort')); return; }
      var thS = closest(t, 'th[data-ssort]'); if (thS) { sortSectorBy(thS.getAttribute('data-ssort')); return; }
      var thM = closest(t, 'th[data-msort]'); if (thM) { sortMembers(thM.getAttribute('data-mg'), thM.getAttribute('data-msort')); return; }
      var ch = closest(t, '.fchip'); if (ch) { applyChip(ch); return; }
      var bk = closest(t, '[data-back]');
      if (bk) { location.hash = (lastPath && lastPath !== '/history' && lastPath !== '/picker') ? lastPath : '/'; return; }
    });
    document.addEventListener('change', function (e) {
      if (!e.target) return;
      if (e.target.id === 'surgeOnly') { FILTER.surge = !!e.target.checked; renderAllBody(true); }
      if (e.target.id === 'newsL1') { NEWS_L1 = e.target.value; renderPath('/news', true); }
      if (e.target.id === 'newsOnlyHit') { NEWS_ONLY_HIT = !!e.target.checked; renderPath('/news', true); }
    });
  }

  // 搜索
  function bindSearch() {
    var inp = $('searchInput'), res = $('searchResults');
    var timer = null, seq = 0;
    inp.addEventListener('input', function () {
      var q = inp.value.trim().toLowerCase();
      if (!q) { res.classList.remove('open'); return; }
      var recs = DS.allRecords().filter(function (r) {
        return (r.name && r.name.toLowerCase().indexOf(q) >= 0) || (r.code && r.code.toLowerCase().indexOf(q) >= 0) || (r.ind && r.ind.toLowerCase().indexOf(q) >= 0);
      }).slice(0, 12);
      /* 指数不在 allRecords 里，单列一段放在最前：搜"上证"能直接进指数前世今生 */
      var idxs = (RAW().indexStates || []).filter(function (x) {
        return String(x.name || '').toLowerCase().indexOf(q) >= 0 || String(x.code || '').toLowerCase().indexOf(q) >= 0;
      });
      var idxHtml = idxs.map(function (x) {
        return '<div class="r" data-history="' + esc(x.code) + '" style="cursor:pointer"><span><b>' + esc(x.name)
          + '</b> <span class="cat">' + esc(x.code) + '</span></span><span class="mut">指数 · 前世今生</span></div>';
      }).join('');
      var html = idxHtml + recs.map(function (r) {
        return '<div class="r" data-open="' + esc(r.code) + '"><span>' + esc(r.name) + ' <span class="cat">' + esc(r.code) + '</span></span><span class="mut">' + typeLabel(r) + '</span></div>';
      }).join('');
      if (!recs.length && !idxs.length && /^\d{6}$/.test(q)) {
        html = '<div class="r" data-quick="' + esc(q) + '" style="cursor:pointer">' + esc(q)
          + ' 未纳入快照池 · <b style="color:var(--blue-d)">点此查询实时行情 ›</b></div>';
      }
      var mySeq = ++seq;
      res.innerHTML = html || '<div class="r mut">本地快照池无匹配 · 正在检索全 A 股代码表…</div>';
      res.classList.add('open');
      /* 中文名 / 拼音 / 任意 A 股在线联想：参考 1Skip/stock-analyzer 全量名称索引 +
       * qitongw92/stock_analysis 精确优先模糊补充。池外标的点开可看实时价 + K 线。 */
      if (DS.suggest) {
        clearTimeout(timer);
        timer = setTimeout(function () {
          var kw = inp.value.trim();
          DS.suggest(kw).then(function (list) {
            if (mySeq !== seq) return;
            list = (list || []).filter(function (x) { return x && x.code && !DS.snapshot(x.code); }).slice(0, 8);
            if (!list.length) {
              if (!html) res.innerHTML = '<div class="r mut">未找到「' + esc(kw) + '」；可检查名称，或直接输入 6 位代码查询实时行情。</div>';
              return;
            }
            var extra = '<div class="r srch-group">全 A 股在线匹配 · 未纳入快照池（点开看实时价 + K 线）</div>'
              + list.map(function (x) {
                SUGGEST_NAMES[x.code] = x.name;
                return '<div class="r" data-open="' + esc(x.code) + '" style="cursor:pointer"><span><b>' + esc(x.name)
                  + '</b> <span class="cat">' + esc(x.code) + '</span></span><span class="mut">池外 · K 线 ›</span></div>';
              }).join('');
            res.innerHTML = (html || '') + extra;
            res.classList.add('open');
          }).catch(function () {});
        }, 220);
      }
    });
    document.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest) return;
      if (!e.target.closest('#search')) res.classList.remove('open');
    });
  }

  // 抽屉关闭
  function bindDrawer() {
    $('drawerClose').addEventListener('click', function () { location.hash = lastPath || '/'; });
    $('drawerMask').addEventListener('click', function () { location.hash = lastPath || '/'; });
  }

  // 刷新按钮
  function bindRefresh() {
    function go() {
      var codes = DS.allRecords().map(function (r) { return r.code; });
      loadQuotes(codes, true).then(function () {
        var p = currentRoute().path;
        if (p === '/all') renderAllBody();
        else renderPath(p);
      });
    }
    $('refreshBtn').addEventListener('click', go);
    $('stateRefresh').addEventListener('click', go);
  }

  // ---------- 启动 ----------
  function boot() {
    // guard.js 兼容：暴露刷新钩子（邀请奖励到账 / 授权校验完成时由 guard 回调）
    if (!boot._guardDone) {
      boot._guardDone = true;
      window.AB_UPGRADE = window.AB_UPGRADE || {};
      window.AB_UPGRADE.onLive = refreshTrialUI;
      window.addEventListener('ab:user-ready', refreshTrialUI);
      window.addEventListener('load', refreshTrialUI);
      setTimeout(refreshTrialUI, 600);      // guard 若晚于本脚本注入，补足一次
    }

    // data.js / data-service.js 可能晚于本脚本就绪（预览环境尤其常见）：最多等 ~5s
    if (!window.AB_DATA || !window.AB_DS) {
      boot._wait = (boot._wait || 0) + 1;
      // gzip 异步加载约 1.7MB，弱网下可能要十几秒：放宽到 ~24s 再判定失败
      if (boot._wait < 200) {
        if (boot._wait === 20) { var st = $('stateText'); if (st) st.textContent = '全市场数据加载中…（约 1.7MB）'; }
        setTimeout(boot, 120); return;
      }
      $('stateText').textContent = '数据加载失败（data.js / data-service.js 未就绪）';
      return;
    }
    DS = window.AB_DS; DS.init();          // 重建索引，确保快照可用
    if (!boot._bound) {
      boot._bound = true;
      bindSearch(); bindDrawer(); bindRefresh(); bindGlobal(); bindPoster();
    }
    var codes = DS.allRecords().map(function (r) { return r.code; });
    // 不阻塞首屏：先渲染（今日% 显示「…」），行情一到只补刷这一列
    loadQuotes(codes, false).then(function () { try { refreshDayCells(); } catch (e) {} });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.id === 'newsKw') { renderNewsRadar(); }
      if (e.key === 'Enter' && e.target && e.target.id === 'newsQ') {
        NEWS_Q = e.target.value.trim(); renderPath('/news', true);
      }
      if (e.key === 'Enter' && e.target && e.target.id === 'histKw') { histJump(); }
    });
    /* 窄屏下搜索框放不下长占位符，换短的（只是文案，不影响功能） */
    try {
      if (window.innerWidth <= 720) {
        var si = document.getElementById('searchInput');
        if (si) si.setAttribute('placeholder', '搜代码 / 名称');
      }
    } catch (e) {}
    try { installTermBtn(); } catch (e) { }
    window.addEventListener('hashchange', render);
    /* 桌面↔手机 或 旋转屏幕后重算「哪些表需要滑动提示」 */
    var _mrsT = null;
    window.addEventListener('resize', function () {
      if (_mrsT) clearTimeout(_mrsT);
      _mrsT = setTimeout(function () { try { markScrollHints(); } catch (e) {} }, 180);
    });
    render();
    refreshTrialUI();
    // 打开即实时：全市场批量取价 → 重算四窗口 → 重跑六派 → 重渲染（非交易时段自然回退收盘）
    if (window.AB_LIVE && window.AB_LIVE.start) window.AB_LIVE.start();
  }
  /* 暴露诊断接口给 selfcheck.js（复用真实三态重算引擎，避免规则二次实现导致漂移） */
  window.AB_DIAG = {
    get DS() { return DS; },
    dailySignals: dailySignals, stateRuns: stateRuns, stateDateInfo: stateDateInfo,
    cachedBars: cachedBars, SIX: SIX, STATE_MAP: STATE_MAP, sixSignals: sixSignals, klineFor: klineFor,
    statePhase: statePhase,   // state-path.js 用它取当前子状态（新发/健康/刚走完…）
    priceOf: function (c) { var q = QUOTES[c]; return (q && isNum(q.price)) ? q.price : null; },
    /* 实时刷新触发的重绘：keepScroll=true，保持用户当前阅读位置（否则每次刷新都弹回顶部） */
    render: function () { render(true); },
    loadQuotes: loadQuotes,   // 供 live-refresh.js 实时重算后重渲染
    runSelfCheck: null   // 由 selfcheck.js 注入，boot 完成后调用
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
