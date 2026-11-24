/* 六派交叉验证引擎 · 前端复刻版
   与 build.py 的 evaluate() 逐条对应，用于「检索即分析」对任意标的即时推演。
   同时导出为 CommonJS，便于 Node 端与 Python 结果做一致性交叉校验。 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AB_SIX = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function sign(v, dead) {
    if (v == null || !isFinite(v)) return 0;
    if (v > dead) return 1;
    if (v < -dead) return -1;
    return 0;
  }
  function T(x) { return Math.tanh(x); }
  function r3(v) { return Math.round(clamp(v, -1e6, 1e6) * 1000) / 1000; }
  function r2(v) { return Math.round(v * 100) / 100; }

  /* 归一化净值锚点：今日=100，历史锚点 = 100/(1+区间涨跌幅)，极端值截断 */
  function seriesOf(pct) {
    var pts = [["今日", 100.0, 0.0]];
    [["w5", "约5日前"], ["w20", "约20日前"], ["w60", "约60日前"], ["w250", "约250日前"]]
      .forEach(function (w) {
        var v = Number(pct[w[0]]);
        var c = clamp(v, -75, 150);
        pts.push([w[1], Math.round(100 / (1 + c / 100) * 1000) / 1000, Math.round(v * 10000) / 10000]);
      });
    return pts.reverse();
  }

  function rankFor(kind, structRaw, E) {
    var arr = (E.rankTable || {})[kind] || [];
    if (!arr.length) return 0.5;
    var i = 0;
    while (i < arr.length && arr[i] < structRaw) i++;
    return clamp((i + 0.5) / arr.length, 0.01, 0.99);
  }

  /* 舆情标题按个股名称倒排索引（P3 性能优化）
   * 全站只扫描一次 titleIndex，之后「检索即分析」命中为 O(1)；
   * DATA.rows 提供名称全集，自定义标的一次扫描后也缓存，避免每次按键全表扫描。 */
  var _nameIdx = null;
  function buildNameIndex(DATA) {
    if (_nameIdx) return _nameIdx;
    var titles = (DATA.engine && DATA.engine.titleIndex) || [];
    var idx = {}, names = [];
    if (DATA.rows) Object.keys(DATA.rows).forEach(function (c) {
      var nm = DATA.rows[c] && DATA.rows[c].name; if (nm) names.push(nm);
    });
    /* 真实多源条目优先：标题里出现个股名称 → 归到该股的舆情命中。
       items 带 k（主题键）/u（链接）/m（媒体），前端可追溯来源。 */
    var RN = realNews(), realItems = (RN && RN.items) || [];
    if (realItems.length && names.length) {
      names.forEach(function (nm) {
        if (!nm || nm.length < 2) return;
        var h = [], seen = {};
        for (var i = 0; i < realItems.length && h.length < 6; i++) {
          var it = realItems[i];
          if (it.t && it.t.indexOf(nm) >= 0) {
            var key = (it.k && it.k[0]) || 'real';
            var tk = key + '|' + it.t.slice(0, 12);
            if (seen[tk]) continue;
            seen[tk] = 1;
            h.push({ key: key, title: it.t, u: it.u, m: it.m, ts: it.ts, d: it.d });
          }
        }
        if (h.length) idx[nm] = h;
      });
      _nameIdx = idx;
      return idx;
    }
    titles.forEach(function (x) {
      names.forEach(function (nm) {
        if (nm && nm.length >= 2 && x[1].indexOf(nm) >= 0) {
          (idx[nm] = idx[nm] || []).push({ key: x[0], title: x[1] });
        }
      });
    });
    _nameIdx = idx;
    return idx;
  }
  function nameHitsFor(DATA, name) {
    if (!name) return [];
    var idx = buildNameIndex(DATA);
    if (idx.hasOwnProperty(name)) return idx[name].slice();
    /* 自定义标的（不在 DATA.rows 名称全集内）：单次扫描并缓存 */
    var h = [];
    ((DATA.engine && DATA.engine.titleIndex) || []).forEach(function (x) {
      if (h.length < 4 && x[1].indexOf(name) >= 0) h.push({ key: x[0], title: x[1] });
    });
    idx[name] = h;
    return h.slice();
  }

  /* 主题级舆情聚合（2026-11 修复）：
     旧 data.js 的 themeAgg 恒为空数组，导致六派舆情票对所有标的都为 0——
     不是"没有舆情"，而是聚合结果从没写进 data.js。这里从随站发布的
     titleIndex（真实新闻标题）+ themeDir（主题方向）派生一份主题聚合：
       score = 主题方向分（-1~1），eff/noise 取保守值，避免误判"激增脉冲"。
     注意：标题是构建时的历史缓存（非当日实时新闻），只作主题级方向参考，
     页面 newsItems 会标注来源；不编造条数/热度。 */
  var _themeAgg = null;
  /* 真实多源舆情（window.AB_NEWS，由 gen_news.py 云端每日采集公开源生成）。
     最高优先级：它的 themeAgg.score 来自真实标题极性、eff 来自真实媒体数，
     surge 未就绪时为 null（基线积累中），绝不虚高。读不到时逐级回退旧缓存。 */
  function realNews() {
    if (typeof window === 'undefined' || !window.AB_NEWS) return null;
    return window.AB_NEWS;
  }
  function themeAggOf(DATA, E) {
    if (_themeAgg) return _themeAgg;
    var RN = realNews();
    if (RN && RN.themeAgg && Object.keys(RN.themeAgg).length) {
      var agg = {};
      Object.keys(RN.themeAgg).forEach(function (k) {
        var x = RN.themeAgg[k];
        agg[k] = {
          key: k, name: x.name || k, dir: x.dir || 0, score: x.score || 0,
          // 引擎只用真实的极性强度 eff；surge 未就绪不参与放大，避免假象
          eff: x.eff || 0, noise: x.noise || 0,
          surge: x.surge == null ? 1 : x.surge,
          n1: x.n1 || 0, n7: x.n1 || 0,
          top: x.top || '', read: x.read || '真实多源舆情'
        };
      });
      _themeAgg = agg;
      return agg;
    }
    var src = DATA.themeAgg;
    /* 调用方按 AG[themeKey] 取，所以统一返回「key → 聚合对象」字典。
       旧快照里 themeAgg 是空数组 []，等同于无数据。 */
    if (src && !Array.isArray(src) && Object.keys(src).length) {
      _themeAgg = src;
      return _themeAgg;
    }
    if (Array.isArray(src) && src.length && src[0] && src[0].key) {
      var m = {};
      src.forEach(function (x) { m[x.key] = x; });
      _themeAgg = m;
      return _themeAgg;
    }
    var titles = E.titleIndex || [], dirs = E.themeDir || {}, byKey = {};
    titles.forEach(function (x) { (byKey[x[0]] = byKey[x[0]] || []).push(x[1]); });
    var out = {};
    Object.keys(byKey).forEach(function (k) {
      var arr = byKey[k], dir = dirs[k] || 0;
      out[k] = {
        key: k, name: k, dir: dir, score: dir,
        eff: 1.2, noise: 1, surge: 1,
        n1: 0, n7: arr.length, top: arr.slice(0, 2).join(' / '),
        read: '主题级舆情（历史缓存）'
      };
    });
    _themeAgg = out;
    return out;
  }

  /* ---------- 真实技术指标（仅在提供收盘序列时启用） ----------
   * 量价派原先只用「涨跌幅加速度 + 换手率」代理，与页面标注的
   * 唐奇安 / MACD / RSI 并不相符。这里按标准定义从收盘序列直接计算，
   * 让量价派名副其实；无序列（老快照）时自动退回纯代理。 */
  function taOf(closes) {
    if (!Array.isArray(closes) || closes.length < 35) return null;
    var n = closes.length, last = closes[n - 1], i;
    /* 唐奇安通道（20日）：当前价在通道内的相对位置 0~1 */
    var hh = -Infinity, ll = Infinity;
    for (i = n - 20; i < n; i++) { if (closes[i] > hh) hh = closes[i]; if (closes[i] < ll) ll = closes[i]; }
    var donch = hh > ll ? (last - ll) / (hh - ll) : 0.5;
    /* MACD(12,26)：EMA 端点差，折算成占价比便于跨股票比较 */
    function ema(a, p) { var k = 2 / (p + 1), e = a[0]; for (var j = 1; j < a.length; j++) e = a[j] * k + e * (1 - k); return e; }
    var macd = ema(closes, 12) - ema(closes, 26);
    var macdPct = last ? (macd / last) * 100 : 0;
    /* RSI(14) */
    var gain = 0, loss = 0;
    for (i = n - 14; i < n; i++) {
      var df = closes[i] - closes[i - 1];
      if (df > 0) gain += df; else loss -= df;
    }
    var rsi = (gain + loss) ? gain / (gain + loss) * 100 : 50;
    /* 布林带宽（20日，4σ/均值%）：只用于识别波动压缩/扩张，不单独计分 */
    function bwAt(end) {
      var m = 0, k;
      for (k = end - 19; k <= end; k++) m += closes[k];
      m /= 20;
      var v = 0;
      for (k = end - 19; k <= end; k++) v += (closes[k] - m) * (closes[k] - m);
      return m ? (4 * Math.sqrt(v / 20) / m) * 100 : null;
    }
    var bwNow = bwAt(n - 1), bwPrev = n >= 41 ? bwAt(n - 21) : null;
    return {
      donch: donch, macdPct: macdPct, rsi: rsi,
      bw: bwNow, bwChg: (bwNow != null && bwPrev != null && bwPrev > 0) ? (bwNow / bwPrev - 1) : null
    };
  }

  /* 引擎配置完整性兜底：旧快照的 engine 被裁成只剩 bm，
     E.ind / E.thresholds / E.voteDead 变 undefined 会让 analyze 抛错，
     调用方（live-refresh）静默吞掉 → 六派从未重算却无人知晓。
     这里给一份最小可用默认（阈值取保守值、死区取中性），
     保证「即使配置残缺也不崩」；正式构建由 build_data.py 补齐完整配置。 */
  var FALLBACK_CFG = {
    temp: 50, fundMedian: 0,
    bm: { m20: 0, m60: 0 },
    ind: {}, indTheme: {}, themeDir: {},
    titleIndex: [], rankTable: {},
    thresholds: { etf: 0.34, stock: 0.4 },
    voteDead: { structure: 0.25, volume: 0.25, fund: 0.25, senti: 0.3, config: 0.25, news: 0.18 }
  };
  function analyze(input, DATA) {
    var E = DATA.engine || {};
    Object.keys(FALLBACK_CFG).forEach(function (k) { if (E[k] == null) E[k] = FALLBACK_CFG[k]; });
    DATA.engine = E;
    var AG = themeAggOf(DATA, E);
    var kind = input.kind === "etf" ? "etf" : "stock";
    var tier = input.tier || "core";
    var p = input.pct || {};
    var raw = { w5: Number(p.w5), w20: Number(p.w20), w60: Number(p.w60), w250: Number(p.w250) };
    var pct = {};
    ["w5", "w20", "w60", "w250"].forEach(function (k) { pct[k] = Math.round(raw[k] * 10000) / 10000; });

    /* 数据质量标记 + winsorize */
    var dataFlags = [];
    var vals = [raw.w5, raw.w20, raw.w60, raw.w250];
    var sameAll = (Math.max.apply(null, vals) - Math.min.apply(null, vals)) < 0.005;
    if (sameAll) {
      dataFlags.push("四个区间涨跌幅完全一致（" + (raw.w5 > 0 ? "+" : "") + raw.w5.toFixed(2) + "%），疑似次新股或长期停牌，样本不足以定态");
    } else if (Math.abs(raw.w60 - raw.w250) < 0.005 && Math.abs(raw.w250) > 100) {
      dataFlags.push("60日与250日涨跌幅相同且幅度异常（" + (raw.w250 > 0 ? "+" : "") + raw.w250.toFixed(1) + "%），上市可能不足一年");
    }
    if (raw.w250 < -60 || raw.w250 > 150) {
      dataFlags.push("年度涨跌幅 " + (raw.w250 > 0 ? "+" : "") + raw.w250.toFixed(1) + "% 超出常规区间，或含份额折算/复权口径差异");
    }
    var w5 = clamp(raw.w5, -40, 60), w20 = clamp(raw.w20, -60, 120),
        w60 = clamp(raw.w60, -70, 150), w250 = clamp(raw.w250, -80, 220);

    /* 行业信息 */
    var ind = input.ind || "";
    var iv = E.ind[ind] || null;
    var indInfo = iv ? { name: ind, code: iv.code || "—", l1: iv.l1,
      fundYi: iv.fundYi, turnover: iv.turnover, breadth: iv.breadth, m20: iv.m20 } : null;

    /* 舆情主题：行业映射 + 新闻标题直接命中（倒排索引 O(1)，见 nameHitsFor）
     * ETF 没有自己的个股新闻，但财经网站的舆情本就按「板块/主题」发布——
     * 用 ETF 名称映射到的行业（ind）→ indTheme 主题键，取主题级舆情。
     * 例如家电ETF → 白色家电 → t_ce/t_robot。宽基/策略 ETF 无行业映射则舆情弃权。 */
    var themes = (input.themes || []).slice();
    var hits = nameHitsFor(DATA, kind === "stock" ? input.name : null);
    if (kind === "etf" && !themes.length && ind && E.indTheme && E.indTheme[ind]) {
      themes = E.indTheme[ind].slice();
    }
    /* 2026-11-24：AB_NEWS 已改成真实行业口径（key 是 i_xxx，name=rows[].ind）。
       旧 E.indTheme 里的 t_xxx 在新聚合里不存在，直接用 input.ind 按行业名精确映射，
       保证六派舆情票与「行业页 / 板块共振 / 舆情雷达」用的是同一个行业。 */
    var indKey = null;
    Object.keys(AG).forEach(function (k) { if (AG[k].name === ind) indKey = k; });
    if (indKey && themes.indexOf(indKey) < 0) themes.push(indKey);
    hits.forEach(function (h) {
      var hitKey = AG[h.key] ? h.key : indKey;
      if (hitKey && themes.indexOf(hitKey) < 0) themes.push(hitKey);
    });
    var rel = [];
    themes.forEach(function (k) { if (AG[k]) rel.push(AG[k]); });
    var strongest = null;
    rel.forEach(function (x) { if (!strongest || x.eff > strongest.eff) strongest = x; });

    /* (1) 结构派 · 对齐标准 Wyckoff 四阶段（吸筹→拉升→派发→下跌，命名同 wyckoff-trading / go-wyckoff）
     * 并给出「结构方向一致度」structConf：四区间同向最确定、两上两下最不确定。 */
    var wt = kind === "etf" ? [0.15, 0.25, 0.40, 0.20] : [0.30, 0.30, 0.28, 0.12];
    var structRaw = wt[0] * T(w250 / 25) + wt[1] * T(w60 / 18) + wt[2] * T(w20 / 12) + wt[3] * T(w5 / 6);
    var struct = structRaw, wyckoff = "S2 拉升", stage = "S2 拉升";
    var subPos = (w250 > 0 ? 1 : 0) + (w60 > 0 ? 1 : 0) + (w20 > 0 ? 1 : 0) + (w5 > 0 ? 1 : 0); // 0..4 同向计数
    if (w20 > 0 && w60 > 0 && w5 > 0) { struct += 0.22; wyckoff = "S2 拉升·突破段"; }
    if (w60 > 12 && w20 < 0 && w5 < 0) { struct -= 0.32; wyckoff = "S3 派发/顶部背离"; }
    if (w250 < -18 && Math.abs(w60) < 8 && w20 > 3) { struct += 0.20; wyckoff = "S1→S2 底部转折(吸筹末)"; }
    if (w20 < 0 && w60 < 0 && w250 < 0) { struct -= 0.24; wyckoff = "S4 下跌"; }
    structRaw = r3(clamp(structRaw, -1.5, 1.5));
    struct = r3(clamp(struct, -1.5, 1.5));
    /* 缠论（形态学：分型→笔→中枢→背驰，构建时由 tools/chan.py 算好）：
     * 价在最近中枢上方且最近一笔向上 = 结构延续；跌破中枢且向下笔 = 结构走坏；
     * 出现背驰（创新高/新低但力度衰减）反向扣分。缺失则不参与（不编造）。 */
    var chan = input.chan || null, chanNote = '';
    if (chan && chan.pos && chan.pos !== 'na') {
      if (chan.pos === 'above' && chan.bi === 'up') { struct += 0.10; chanNote = '中枢上方·向上笔'; }
      else if (chan.pos === 'below' && chan.bi === 'down') { struct -= 0.10; chanNote = '中枢下方·向下笔'; }
      else if (chan.pos === 'in') { struct -= 0.04; chanNote = '中枢内震荡'; }
      else { chanNote = chan.pos === 'above' ? '中枢上方' : '中枢下方'; }
      if (chan.diverg) { struct -= 0.08; chanNote += '·背驰'; }
      struct = r3(clamp(struct, -1.5, 1.5));
    }
    /* 结构方向一致度：四区间完全同向=1，两两相反=0（仅方向一致性的代理，非统计置信） */
    var structConf = r3(clamp(Math.abs(subPos - 2) / 2, 0, 1));
    var rank = (input.rank != null) ? input.rank : rankFor(kind, structRaw, E);
    struct = r3(clamp(0.70 * struct + 0.30 * (rank - 0.5) * 2.0, -1.5, 1.5));
    stage = wyckoff;

    /* (2) 量价派；在线取数时可用标的自身真实换手率覆盖行业代理 */
    var accel = (w5 / 5 * 20) - w20;
    var tov = (input.turnover != null && isFinite(input.turnover)) ? Number(input.turnover)
            : (iv && iv.turnover != null) ? iv.turnover : 3.0;
    var ta = taOf(input.closes);
    var vp;
    if (ta) {
      /* 有收盘序列：加速度 + 中期动量 + 换手 + 唐奇安位置 + MACD 柱 + RSI 复合 */
      vp = 0.28 * T(accel / 12)
         + 0.22 * T((w20 - w60 / 3) / 10)
         + 0.10 * T((tov - 3) / 3)
         + 0.18 * T((ta.donch - 0.5) * 2)
         + 0.12 * T(ta.macdPct / 3)
         + 0.10 * T((ta.rsi - 50) / 20);
    } else {
      /* 无序列（旧快照）：退回纯涨跌幅 / 换手率代理 */
      vp = 0.45 * T(accel / 12) + 0.35 * T((w20 - w60 / 3) / 10) + 0.20 * T((tov - 3) / 3);
    }
    vp = r3(clamp(vp, -1.5, 1.5));

    /* (3) 资金派；在线标的能取到自身主力净流入，不再使用行业代理 */
    var fundRaw, fundLabel, fundProxy = false, fsc;
    if (input.fundSelf && input.fund != null && isFinite(input.fund)) {
      fundRaw = Number(input.fund);
      fsc = T(fundRaw / (kind === "etf" ? 8.0 : 2.0));
      fundLabel = (kind === "etf" ? "ETF" : "个股") + "主力净流入 " +
        (fundRaw > 0 ? "+" : "") + fundRaw.toFixed(2) + " 亿（东方财富口径）";
      fundProxy = false;
    } else if (kind === "stock" && tier === "core") {
      fundRaw = (input.fund == null ? 0 : Number(input.fund));
      fsc = T(fundRaw / 2.0);
      fundLabel = "个股主力净流入 " + (fundRaw > 0 ? "+" : "") + fundRaw.toFixed(2) + " 亿";
      fundProxy = false;
    } else if (kind === "etf" && (input.amtRatio != null || input.volRatio != null) &&
               isFinite(input.amtRatio != null && isFinite(input.amtRatio) ? input.amtRatio : input.volRatio)) {
      /* ETF 的资金代理（2026-11 二次修正）：
         东财 f62 主力净流入对 ETF 恒为 0（ETF 没有"主力"概念），旧代码除 8 后
         tanh≈0.008，资金票结构上永远拿不到。
         先用「成交额比」（近5日均额 / 近20日均额，日K量×高/低/收代表价还原），
         旧快照没有该字段时退回份额量比。金额比更贴近用户说的「切换成金额」，
         也避开 ETF 份额拆分/低单价带来的假放量。符号仍由价格方向共同决定：
           金额放大 + 价涨 → 正；金额放大 + 价跌 → 负；萎缩 → 接近中性。
         绝不写成"净流入 X 亿"——这是代理分，不是实测资金流。 */
      var useAmt = input.amtRatio != null && isFinite(input.amtRatio);
      var ratioName = useAmt ? "amtRatio" : "volRatio";
      var vr = clamp(Number(input[ratioName]), 0.2, 5);
      var volSignal = T((vr - 1) / 0.45);          // 比值1→0，1.45→0.76，0.55→-0.76
      var dirSignal = T(w5 / 5.0);                  // 近5日方向
      fsc = r3(clamp(volSignal * 0.65 + dirSignal * 0.35, -1, 1));
      fundRaw = null;                                // 不编造金额
      fundLabel = "ETF " + (useAmt ? "成交额" : "量能") + "资金代理：近5/20日"
        + (useAmt ? "金额比" : "量比") + " " + vr.toFixed(2) + "×、近5日 " +
        (w5 > 0 ? "+" : "") + w5.toFixed(1) + "%（量×代表价估算，代理分，非实测净流入）";
      fundProxy = true;
    } else {
      if (iv && iv.fundYi != null) { fundRaw = iv.fundYi; var src = "所属" + ind + "行业"; }
      else { fundRaw = E.fundMedian; src = "全市场行业中位数"; }
      fsc = T(fundRaw / (kind === "stock" ? 2.0 : 8.0));
      fundLabel = src + "主力净流入 " + (fundRaw > 0 ? "+" : "") + fundRaw.toFixed(2) +
        " 亿（" + (kind === "stock" ? "个股口径" : "ETF") + "代理）";
      fundProxy = true;
    }
    fsc = r3(clamp(fsc, -1.5, 1.5));

    /* (4) 情绪派 · 多源复合（参考 Fear&Greed 多源指数，离线口径内）
     * 市场温度(E.temp) + 近5日动量 + 行业宽度(iv.breadth)；仍属简化代理，不接实时舆情模型。 */
    var breadth = (iv && isFinite(iv.breadth)) ? iv.breadth : null;
    var wBreadth = breadth != null ? 0.25 : 0;
    var wMom = 0.55 - wBreadth; // 有行业宽度则动量权重 0.30，否则补到 0.55
    var senti = 0.45 * ((E.temp / 100 - 0.5) * 2.0)
              + wMom * T(w5 / 6.0)
              + wBreadth * T((breadth - 50) / 25);
    senti = r3(clamp(senti, -1.5, 1.5));

    /* (5) 配置派 · 标准化 JdK RS-Ratio / RS-Momentum（参考 rrg-python / RRG-Lite）
     * 仅 4 个区间锚点，无法做逐日指数平滑，用三窗口几何均值近似平滑后的相对强度；
     * 标注为「简化 RRG」，与真正的逐日 RRG 不可等同。 */
    var bm = E.bm || { m20: 0, m60: 0 };
    function rp(w, bw) { return (1 + w / 100) / (1 + bw / 100); } // 相对表现比（个股 vs 基准）
    var rs20 = rp(w20, bm.m20), rs60 = rp(w60, bm.m60),
        rs5 = rp(w5, (bm.m20 + bm.m60) / 2);
    var rsSmooth = Math.cbrt(rs20 * rs60 * rs5); // 几何均值，对极端更稳
    var rsRatio = r3(clamp((rsSmooth - 1) * 100, -40, 40));        // 类比 JdK RS-Ratio（×100）
    var rsMomentum = r3(clamp((rs20 / Math.max(rs60, 1e-6) - 1) * 100, -60, 60)); // RS 斜率
    var cfg = 0.60 * T(rsRatio / 14.0) + 0.40 * T(rsMomentum / 12.0);
    cfg = r3(clamp(cfg, -1.5, 1.5));

    /* (6) 舆情派 */
    var ns = 0.0;
    if (rel.length) {
      var avg = rel.reduce(function (a, x) { return a + x.score; }, 0) / rel.length;
      ns = strongest.score * 0.85 + 0.15 * avg + (hits.length ? 0.22 * Math.min(hits.length, 2) : 0);
      if (strongest.noise >= 4) ns *= 0.35;
    }
    /* 个股专属新闻的真实极性：nameHits 里的条目带 d(+1/0/-1)，按多数方向合成，
       避免「有新闻就一律+0.22」把利空报道也算成利好。无极性（d=0）不计。 */
    if (hits.length) {
      var hp = 0, hn = 0, hHas = false;
      hits.forEach(function (h) {
        if (h.d === 1) { hp++; hHas = true; }
        else if (h.d === -1) { hn++; hHas = true; }
      });
      if (hHas) {
        var hdir = (hp - hn) / (hp + hn);           // -1~1
        var hConf = Math.min(hp + hn, 4) / 4;        // 条数越多越可信，封顶 4 条
        ns = r3(ns * 0.4 + hdir * hConf * 0.6);      // 个股专属极性占主导
      }
    }
    ns = r3(clamp(ns, -1.2, 1.2));

    var D = E.voteDead;
    var votes = {
      structure: sign(struct, D.structure), volume: sign(vp, D.volume),
      fund: sign(fsc, D.fund), senti: sign(senti, D.senti),
      config: sign(cfg, D.config), news: sign(ns, D.news)
    };
    var pos = 0, neg = 0;
    Object.keys(votes).forEach(function (k) { if (votes[k] > 0) pos++; else if (votes[k] < 0) neg++; });

    /* 否决条款 */
    var veto = [];
    if (w5 > 8 && w20 < 0 && fsc < 0)
      veto.push("假突破否决：近5日 " + (w5 > 0 ? "+" : "") + w5.toFixed(1) + "% 但20日仍为负且资金净流出");
    if (w20 > 0 && w5 < -2 && w60 < -10)
      veto.push("顶部背离否决：中期涨幅已兑现、近5日转跌且60日仍深跌");
    if (w250 < -25 && w60 < -10 && w20 > 15)
      veto.push("深跌反弹否决：年度 " + (w250 > 0 ? "+" : "") + w250.toFixed(0) + "%、60日 " +
        (w60 > 0 ? "+" : "") + w60.toFixed(0) + "%，属超跌反弹而非启动");
    if (strongest && strongest.eff >= 8 && fsc < 0 && vp < 0)
      veto.push("舆情脉冲未获确认：" + strongest.name + " 有效激增 " + strongest.eff.toFixed(1) +
        "×，但资金与量价同为负（防消息面追高）");
    if (sameAll) veto.push("数据质量否决：" + dataFlags[0]);
    if (strongest && strongest.noise >= 4 && votes.news > 0) {
      votes.news = 0;
      pos = 0; Object.keys(votes).forEach(function (k) { if (votes[k] > 0) pos++; });
    }
    var need = (strongest && strongest.dir <= -0.2 && strongest.eff >= 8) ? 4 : 3;

    /* RRG 象限（提前到三态判定前：走弱时配置票不得计入启动确认） */
    var rrg = { x: r2(rsRatio), y: r2(rsMomentum), rsRatio: rsRatio, rsMomentum: rsMomentum };
    var quad = rrg.x >= 0 && rrg.y >= 0 ? "领先" : rrg.x < 0 && rrg.y >= 0 ? "改善" :
               rrg.x >= 0 && rrg.y < 0 ? "走弱" : "落后";
    /* 走弱降级：RS 比值仍高但动量转负 = 强但正在衰减，
       配置派的 RS 票此时不该当作"启动确认票"。仅剥夺 config 的赞成票，
       不改 scores.config（分数仍展示，供用户看 RRG 全貌）。 */
    if (quad === "走弱" && votes.config > 0) {
      votes.config = 0;
      pos--;
    }

    /* 三态判定 */
    var thr = E.thresholds[kind];
    var state;
    var confirmOk = kind === "etf"
      ? (votes.fund > 0 || votes.news > 0)   // ETF 启动必须有资金(量能代理)或主题舆情至少一票确认
      : true;
    if (!veto.length && struct > thr && pos >= need && votes.structure > 0 &&
        (vp > 0 || fsc > 0) && votes.news >= 0 && confirmOk) state = "启动";
    /* 绝对趋势闸门：60 日与 250 日同时深跌（≤ -10%）且结构显著为负 → 直接判「走完」。
       为什么需要它：六派票是「相对强弱」的合成，宽基 ETF 在普跌市里抗跌，量价分可能只是中性，
       凑不够看空票就会落到「盘整」。但「已经跌了 10% 以上」是绝对事实，不该被相对强弱盖过。
       这条只下调、不上调：永远不会因此把票判成「启动」。 */
    else if (w60 <= -10 && w250 <= -10 && struct < -0.30) state = "走完";
    else if (struct < -0.30 && (neg >= 3 || (neg >= 2 && vp < 0)) && (vp < 0 || fsc < 0)) state = "走完";
    else state = "盘整";
    if (sameAll) state = "盘整";
    var strong = state === "启动" && pos >= 5 && votes.news > 0 && (fsc > 0 || votes.fund > 0);

    /* 动作层 */
    var series = seriesOf(raw);
    var n5 = series[series.length - 2][1], n20 = series[series.length - 3][1],
        n60 = series[series.length - 4][1];
    var action;
    if (state === "启动") {
      var first = (w20 >= 8 || (w5 >= 5 && w20 >= 3))
        ? "第一笔·现价建仓：买 1/2 仓（已处突破段，20日 " + (w20 > 0 ? "+" : "") + w20.toFixed(1) +
          "%、5日 " + (w5 > 0 ? "+" : "") + w5.toFixed(1) + "%）"
        : "第一笔·突破单：净值站上 20 日锚点 " + n20.toFixed(1) + "（今日=100）上方买 1/2 仓";
      action = [first,
        "第二笔·回踩单：回踩 5 日锚点 " + n5.toFixed(1) + " 不破再补 1/2 仓",
        "止损：跌破 60 日锚点 " + n60.toFixed(1) + "，或自首笔成本回撤 7%"];
    } else if (state === "盘整") {
      action = (strongest && strongest.eff >= 6 && !veto.length)
        ? ["舆情已放大但结构未确认：观望为主，最多 1/4 仓试单",
           "等 20 日动量转正 + 资金票转正后再加仓", "止损：试单亏损 5% 即退出"]
        : ["观望，不新建仓；已有仓位维持不动",
           "触发条件：结构分 > 0.4 且 ≥3 派共振", "若舆情激增但资金未确认，视为噪声脉冲"];
    } else {
      action = ["减仓：先减 1/2，反弹至 20 日锚点附近继续减",
                "清仓条件：5 日动量与资金票同时转负",
                "不参与反抽；重新进入观察池需结构票转正"];
    }

    /* 舆情明细 */
    var newsItems = rel.slice().sort(function (a, b) { return b.eff - a.eff; }).map(function (x) {
      return { key: x.key, name: x.name, surge: x.surge, eff: x.eff, noise: x.noise,
        dir: x.dir, score: x.score, flag: x.flag, read: x.read, top: x.top,
        n1: x.n1, n7: x.n7, h24max: x.h24max, h24avg: x.h24avg };
    });

    return {
      code: input.code || "CUSTOM", name: input.name || "自定义标的", kind: kind,
      tier: tier, asOf: input.asOf || (tier === "ext" ? DATA.meta.asOfExt : DATA.meta.asOfCore),
      cat: kind === "etf" ? (input.cat || "自定义") : ind,
      ind: ind, l1: iv ? iv.l1 : null,
      fee: input.fee == null ? null : input.fee, size: input.size == null ? null : input.size,
      mcap: input.mcap == null ? null : input.mcap,
      fund: (input.fundSelf && input.fund != null) ? Number(input.fund)
            : (kind === "stock" && tier === "core") ? fundRaw : null,
      fund3d: input.fund3d == null ? null : input.fund3d,
      alts: input.alts || [], nCand: input.nCand || 1, index: input.index || null,
      src: input.src || null,
      themes: themes, newsHits: hits, pct: pct, series: series, rank: rank,
      scores: { structure: struct, volume: vp, fund: fsc, senti: senti, config: cfg, news: ns },
      structRaw: structRaw, dataFlags: dataFlags, votes: votes,
      resonance: pos, negVotes: neg, need: need, state: state, strong: strong, stage: stage,
      wyckoff: wyckoff, structConf: structConf,
      veto: veto, action: action, newsItems: newsItems,
      newsMain: newsItems.length ? newsItems[0] : null,
      fundLabel: fundLabel, fundProxy: fundProxy, indInfo: indInfo,
      etfLink: null, etfLinkName: null, rrg: rrg, quad: quad,
      rsRatio: rsRatio, rsMomentum: rsMomentum
    };
  }

  /* 缓存清理：远端 news_data.js 刷新后调用，让 themeAgg/nameHits 用新舆情重算 */
  function resetCache() { _themeAgg = null; _nameIdx = null; }

  return { analyze: analyze, seriesOf: seriesOf, clamp: clamp, sign: sign,
           resetCache: resetCache };
});
