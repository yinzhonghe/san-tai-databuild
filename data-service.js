/*
 * 三态看盘 · v2 数据层（多源降级 + 本地缓存 + 快照兜底）
 * ---------------------------------------------------------------
 * 设计目标：根治「满屏 —」。浏览器侧单一数据源（东财）偶发失败（缺 ut / Referer / 限流）
 * 不应让整页空白。改为：东财(主) → 腾讯 gtimg → 新浪 sina 三源自动降级，
 * 仍取不到的标的回退到 data.js 快照并明确标注「实时未取到·快照不含当日」。
 *
 * 三源均通过 <script> JSONP 方式注入（脚本执行不受 CORS 限制），不依赖 fetch。
 * 全局挂载：window.AB_DS
 */
(function (global) {
  'use strict';

  var EM_UT = 'fa5fd1943c7b386f172d6893dbfba10b';
  var TTL = 20000;            // 本地缓存有效期 20s（盘中）
  var REQ_TIMEOUT = 9000;     // 单源单次请求超时

  // 数据源状态（供 UI 展示）
  var status = {
    lastSource: 'snapshot',    // snapshot | em | tencent | sina
    lastUpdate: 0,             // 时间戳
    message: '尚未拉取实时行情'
  };

  // ---------- 工具 ----------
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function now() { return Date.now(); }

  // 北交所：43/83/87/92 开头（92 为新代码段）。必须单独判，否则 9 开头会被误当沪市。
  function isBJ(bare) { return /^(43|83|87|92)/.test(bare); }
  function marketOf(code) {
    // code 形如 "300413.SZ" / "601318.SH" / "920000.BJ"
    if (code.indexOf('.BJ') > 0) return { m: 0, prefix: 'bj', bare: code.replace('.BJ', '') };
    if (code.indexOf('.SZ') > 0) return { m: 0, prefix: 'sz', bare: code.replace('.SZ', '') };
    if (code.indexOf('.SH') > 0) return { m: 1, prefix: 'sh', bare: code.replace('.SH', '') };
    // 无后缀兜底
    var c = code.replace(/\.[A-Z]{2,4}$/, '');
    var m = (/^(6|9)/.test(c)) ? 1 : 0;
    return { m: m, prefix: m ? 'sh' : 'sz', bare: c };
  }

  function fullCode(bare, m) {
    if (isBJ(bare)) return bare + '.BJ';
    return bare + (m === 1 ? '.SH' : '.SZ');
  }

  // JSONP（带回调参数的端点，如东财）
  function jsonp(url, cbName, timeout) {
    return new Promise(function (resolve, reject) {
      var cb = '_abds' + now().toString(36) + Math.random().toString(36).slice(2, 7);
      var s = document.createElement('script');
      s.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + cbName + '=' + cb;
      s.async = true;
      var done = false;
      function cleanup() { try { document.head.removeChild(s); } catch (e) {} try { delete global[cb]; } catch (e) {} }
      global[cb] = function (data) { if (done) return; done = true; cleanup(); resolve(data); };
      s.onerror = function () { if (done) return; done = true; cleanup(); reject(new Error('script error')); };
      var t = setTimeout(function () { if (done) return; done = true; cleanup(); reject(new Error('timeout')); }, timeout || REQ_TIMEOUT);
      // 清理定时器引用（不影响逻辑）
      s.addEventListener('load', function () { clearTimeout(t); });
      document.head.appendChild(s);
    });
  }

  // 加载「设置全局变量」的脚本（腾讯 gtimg / 新浪 sina），成功后回调读取全局
  function scriptTag(url, timeout) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.async = true;
      var done = false;
      var t = setTimeout(function () { if (done) return; done = true; reject(new Error('timeout')); }, timeout || REQ_TIMEOUT);
      s.onload = function () { if (done) return; done = true; clearTimeout(t); resolve(true); };
      s.onerror = function () { if (done) return; done = true; clearTimeout(t); reject(new Error('script error')); };
      document.head.appendChild(s);
    });
  }

  // ---------- 东财 ulist（主源） ----------
  function emChunk(codes) {
    var secids = codes.map(function (c) { var x = marketOf(c); return x.m + '.' + x.bare; });
    var url = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
      + '?fltt=2&invt=2&fields=f2,f3,f5,f12,f13,f60&secids=' + encodeURIComponent(secids.join(','))
      + '&ut=' + EM_UT;
    return jsonp(url, 'cb', REQ_TIMEOUT).then(function (d) {
      var diff = d && d.data && d.data.diff;
      if (!diff) return {};
      var map = {};
      diff.forEach(function (it) {
        if (!it) return;
        var fc = it.f12, m = it.f13;
        if (fc == null) return;
        var code = fullCode(String(fc), m);
        var price = isNum(it.f2) ? it.f2 : null;
        var chg = isNum(it.f3) ? it.f3 : null;
        // f60 为昨收，可用于校验/兜底；f5 为成交量（手），为 0 且价格未变＝当天没成交（停牌）
        var qq = validQuote('em', { price: price, chg: chg, preClose: isNum(it.f60) ? it.f60 : null,
          volume: isNum(it.f5) ? it.f5 : null, source: 'em' });
        if (qq) map[code] = qq;
      });
      return map;
    });
  }

  // ---------- 源字段契约（fail-closed） ----------
  /* 每个行情源必须声明字段的语义与单位；未声明 = 不采纳。
     并做区间校验：价格必须 >0、涨跌幅必须在 [-100,100]、成交量 >=0。
     历史上踩过的坑：新浪总市值是「万元」、东财是「亿元」，混用会出现 1 万倍的市值；
     也有过把「成交额」当成「成交量」的情况。宁可不给，也不给错单位。 */
  var CONTRACT = {
    em:      { price: 'yuan', chg: 'pct', volume: 'hand', preClose: 'yuan', mcap: 'yi' },
    tencent: { price: 'yuan', chg: 'pct', volume: 'hand', preClose: 'yuan', mcap: 'yi' },
    sina:    { price: 'yuan', chg: 'derived_pct', volume: 'share', preClose: 'yuan', mcap: 'wan' }
  };
  function validQuote(src, q) {
    if (!q) return null;
    if (!isNum(q.price) || q.price <= 0) return null;
    var c = CONTRACT[src];
    /* 只挡「明显不是百分比」的值（如把价格或万分比塞进涨跌幅）；
       新股上市首日可以 +400%，不能按 10%/20% 的涨跌停去卡。 */
    if (c && c.chg && isNum(q.chg) && Math.abs(q.chg) > 1000) return null;
    if (isNum(q.volume) && q.volume < 0) return null;
    if (isNum(q.preClose) && q.preClose < 0) return null;
    return q;
  }

  // ---------- 腾讯 gtimg（兜底源） ----------
  function tencentChunk(codes) {
    var q = codes.map(function (c) { var x = marketOf(c); return x.prefix + x.bare; }).join(',');
    var url = 'https://qt.gtimg.cn/q=' + q;
    return scriptTag(url, REQ_TIMEOUT).then(function () {
      var map = {};
      codes.forEach(function (c) {
        var x = marketOf(c);
        var key = 'v_' + x.prefix + x.bare;
        var raw = global[key];
        if (typeof raw !== 'string' || !raw) return;
        var a = raw.split('~');
        // a[3]=当前价 a[4]=昨收 a[5]=今开 a[6]=成交量(手) a[32]=涨跌幅%
        var price = parseFloat(a[3]);
        var preClose = parseFloat(a[4]);
        var chg = isNum(parseFloat(a[32])) ? parseFloat(a[32]) : (price && preClose ? (price / preClose - 1) * 100 : null);
        // volume / open 用于识别停牌（成交量为 0 且未开盘 = 当天没成交，不是「平盘」）
        var vol = parseFloat(a[6]), open = parseFloat(a[5]);
        var tq = validQuote('tencent', { price: price, chg: chg, preClose: preClose,
          volume: isNum(vol) ? vol : null, open: isNum(open) ? open : null, source: 'tencent' });
        if (tq) map[c] = tq;
      });
      return map;
    });
  }

  // ---------- 数据源健康度 ----------
  /* 免费接口都没有 SLA，随时会挂。挂的时候最怕的不是没数据，而是
     「用户以为是算错了」。这里记录每个源的最近成败，由页面如实展示，
     出问题能一眼看出是「源挂了」还是「我们算错了」。 */
  var SRC = {
    tencent: { name: '腾讯', ok: 0, fail: 0, lastOk: 0, lastErr: '' },
    eastmoney: { name: '东财', ok: 0, fail: 0, lastOk: 0, lastErr: '' },
    ths: { name: '同花顺', ok: 0, fail: 0, lastOk: 0, lastErr: '' },
    sina: { name: '新浪', ok: 0, fail: 0, lastOk: 0, lastErr: '' }
  };
  function markSrc(k, ok, err) {
    var o = SRC[k];
    if (!o) return;
    if (ok) { o.ok++; o.lastOk = now(); o.lastErr = ''; }
    else { o.fail++; o.lastErr = String(err || 'failed').slice(0, 60); }
  }
  function srcHealth() {
    var out = {};
    Object.keys(SRC).forEach(function (k) {
      var o = SRC[k];
      var total = o.ok + o.fail;
      /* 判定口径（2026-11-26 修正）：偶发失败不该立刻标「不可用」吓到用户。
         腾讯一次批量取价会发 ~16 个 script 请求，只要网络抖动 1 次，旧逻辑
         （fail>0 && ok===0 → down）就会误报「腾讯不可用」，哪怕另一批已成功。
         新口径：至少累计 3 次请求才下结论；成功率 <40% 才算 down，<75% 算不稳。
         且只要最近成功过（lastOk 在 60s 内），一律不标 down。 */
      var state = 'idle';
      if (total === 0) state = 'idle';
      else if (o.lastOk && (now() - o.lastOk < 60000)) state = 'ok';
      else if (total < 3) state = o.ok > 0 ? 'flaky' : 'idle';
      else {
        var rate = o.ok / total;
        state = rate < 0.4 ? 'down' : (rate < 0.75 ? 'flaky' : 'ok');
      }
      out[k] = { name: o.name, state: state, ok: o.ok, fail: o.fail, lastOk: o.lastOk, lastErr: o.lastErr };
    });
    return out;
  }

  // ---------- 市场级实时数据（成交额 / 涨跌家数） ----------
  /* 为什么单独做这个：
     ① 快照里的 market.amount 是构建时写死的常数（7200 亿），从没随行情更新，
        用户 14:53 看到的仍是 11-14 的值 —— 这种错会让人否定整站。
     ② 全市场列表接口 clist 在浏览器里直接 ERR（实测），拿不到「涨跌家数」，
        但指数接口 ulist 是通的，f104/f105/f106 就是该市场的 涨/跌/平 家数，
        f6 是指数成交额（沪市 / 深市各自）。
     所以：一次请求同时拿 成交额 + 涨跌家数，60 秒缓存。 */
  var MK = { at: 0, data: null };
  function secidOf(code) {
    var x = marketOf(code);
    var m = x.prefix === 'sh' ? '1' : (x.prefix === 'bj' ? '0' : '0');
    return m + '.' + x.bare;
  }
  function getMarketLive() {
    if (MK.data && (now() - MK.at) < 60000) return Promise.resolve(MK.data);
    /* 走腾讯：东财 ulist 在高频请求下会被断流，这正是「成交额一直显示 7200 亿」的原因。
       腾讯指数第 37 个字段就是成交额（万元），沪 + 深相加即两市成交额。 */
    return getQuotesTx(['000001.SH', '399001.SZ']).then(function (r) {
      var map = (r && r.map) || {};
      var amt = 0, got = 0;
      ['000001.SH', '399001.SZ'].forEach(function (c) {
        var q = map[c];
        if (q && isNum(q.amountWan) && q.amountWan > 0) { amt += q.amountWan / 1e4; got++; }
      });
      if (!got) return null;
      var out = { amount: amt, up: null, down: null, flat: null, at: now() };
      MK.data = out; MK.at = now();
      return out;
    }).catch(function () { return null; });
  }

  // ---------- 东财涨停/跌停池：真实封板数（不是涨幅阈值估算） ----------
  /* 2026-11-27 事故：三报用「涨幅 >=9.8%」近似涨停，20CM/30CM 暴涨日把 1465 只
     写成涨停（真实 417）。前端市场条同源残留，改为直连东财封板池 data.tc。
     失败返回 null，调用方必须标「估算·非封板」，绝不拿阈值数冒充实时封板。 */
  var LP_CACHE = { at: 0, data: null };
  function getLimitPools() {
    if (LP_CACHE.data && (now() - LP_CACHE.at) < 60000) return Promise.resolve(LP_CACHE.data);
    var d = new Date();
    var ymd = '' + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
    function one(kind) {
      var isUp = kind === 'lu';
      var url = 'https://push2ex.eastmoney.com/getTopic' + (isUp ? 'ZT' : 'DT') + 'Pool'
        + '?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1'
        + '&sort=' + encodeURIComponent(isUp ? 'fbt:asc' : 'fund:asc')
        + '&date=' + ymd;
      return jsonp(url, 'cb', REQ_TIMEOUT).then(function (r) {
        var dd = (r && r.data) || {};
        var tc = dd.tc;
        return isNum(tc) && tc >= 0 ? { n: tc, qdate: dd.qdate } : null;
      }).catch(function () { return null; });
    }
    return Promise.all([one('lu'), one('ld')]).then(function (r) {
      if (!r[0] || !r[1]) return null;
      var out = { lu: r[0].n, ld: r[1].n, qdate: r[0].qdate, source: '东财封板池', at: now() };
      LP_CACHE.data = out; LP_CACHE.at = now();
      return out;
    });
  }

  // ---------- 东财行业板块涨跌（真实板块指数，不是池内均涨） ----------
  /* 快照里没有板块指数涨跌，行业表的「板块今日%」只好退化成「池内成分股均涨」，
     用户在普涨行业里看到 +10% 会以为是板块涨了 10%。
     东财板块 secid 形如 90.BK0447，ulist 支持一次查多个。 */
  var BOARD_CACHE = { map: {}, at: 0 };
  function getBoardQuotes(bks) {
    bks = (bks || []).filter(function (x) { return /^BK\d+/i.test(String(x)); });
    if (!bks.length) return Promise.resolve({ map: {} });
    if (now() - BOARD_CACHE.at < 45000) return Promise.resolve({ map: BOARD_CACHE.map });
    var uniq = [], seen = {};
    bks.forEach(function (b) { if (!seen[b]) { seen[b] = 1; uniq.push(b); } });
    var groups = [], i;
    for (i = 0; i < uniq.length; i += 60) groups.push(uniq.slice(i, i + 60));
    var map = {};
    function one(g) {
      var secids = g.map(function (b) { return '90.' + b; }).join(',');
      var url = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
        + '?fltt=2&invt=2&fields=f2,f3,f12,f14&secids=' + encodeURIComponent(secids)
        + '&ut=' + EM_UT;
      return jsonp(url, 'cb', REQ_TIMEOUT).then(function (d) {
        var diff = (d && d.data && d.data.diff) || [];
        if (!diff.length) markSrc('eastmoney', false, 'board empty');
        else markSrc('eastmoney', true);
        diff.forEach(function (it) {
          var bk = String(it.f12 || '').toUpperCase();
          var chg = isNum(it.f3) ? it.f3 : (parseFloat(it.f3) || null);
          if (/^BK\d+/.test(bk) && chg != null) map[bk] = { chg: chg, name: it.f14 || '' };
        });
      }).catch(function () { });
    }
    function run(idx) {
      if (idx >= groups.length) return Promise.resolve();
      return one(groups[idx]).then(function () {
        return new Promise(function (r) { setTimeout(r, 120); }).then(function () { return run(idx + 1); });
      });
    }
    return run(0).then(function () {
      BOARD_CACHE.map = map; BOARD_CACHE.at = now();
      return { map: map };
    });
  }

  // ---------- 批量取价：腾讯 qt.gtimg.cn（实测唯一稳定通道） ----------
  /* 三条通道的实测结论（浏览器内）：
       · 新浪 hq.sinajs.cn  → ERR（限制 Referer，script 标签带的是本站 Referer）
       · 东财 clist 全市场  → ERR（直接断流）
       · 东财 ulist         → 可用但高频被断，且指数字段容易取错（曾把「昨收」当现价）
       · 腾讯 qt.gtimg.cn   → 稳定，一次 60+ 只，字段齐全（3=现价 4=昨收 32=涨跌幅）
     所以主通道换成腾讯；北交所腾讯不认，降级东财。 */
  function txSymbol(code) {
    var x = marketOf(code);
    return x.prefix + x.bare;
  }
  var TX_BLOCK = 400;
  /* 解析单只腾讯行情原始串（v_sh600519="1~名称~代码~现价~昨收~..."）。
     script 通道从 window 变量取 raw，fetch 通道从文本正则取 raw，共用本函数。 */
  function parseOneTx(sym, raw, map) {
    if (typeof raw !== 'string' || raw.length < 40) return;
    var a = raw.split('~');
    var full = fullCode(a[2], sym.slice(0, 2) === 'sh' ? 1 : 0);
    var price = parseFloat(a[3]), pre = parseFloat(a[4]), chg = parseFloat(a[32]);
    var q = validQuote('tencent', {
      price: isNum(price) && price > 0 ? price : null,
      chg: isNum(chg) ? chg : null,
      preClose: isNum(pre) && pre > 0 ? pre : null,
      volume: isNum(parseFloat(a[6])) ? parseFloat(a[6]) : null,
      open: isNum(parseFloat(a[5])) ? parseFloat(a[5]) : null,
      amountWan: isNum(parseFloat(a[37])) ? parseFloat(a[37]) : null,
      source: 'tencent'
    });
    if (q) map[full] = q;
  }
  /* fetch 兜底通道（2026-11-26）：用户的广告拦截/隐私扩展会拦动态脚本标签请求 gtimg，
     但不拦 fetch。qt.gtimg.cn 返回 Access-Control-Allow-Origin:*，允许跨域读取。
     注意返回体是 GBK 编码，必须用 TextDecoder('gbk') 解码，否则中文名乱码（数字不受影响）。 */
  function tencentViaFetch(syms, url, map) {
    if (!window.fetch) return Promise.resolve(0);
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, REQ_TIMEOUT);
    return fetch(url + '&_t=' + Date.now(), ctl ? { signal: ctl.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('tx fetch ' + r.status); return r.arrayBuffer(); })
      .then(function (buf) {
        clearTimeout(to);
        var text;
        try { text = new TextDecoder('gbk').decode(buf); }
        catch (e) { text = new TextDecoder().decode(buf); }
        var before = Object.keys(map).length;
        syms.forEach(function (sym) {
          var m = new RegExp('v_' + sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*"([^"]*)"').exec(text);
          if (m) parseOneTx(sym, m[1], map);
          try { delete window['v_' + sym]; } catch (e) { }
        });
        return Object.keys(map).length - before;
      })
      .catch(function () { clearTimeout(to); return 0; });
  }
  function getQuotesTx(codes) {
    codes = (codes || []).filter(Boolean);
    if (!codes.length) return Promise.resolve({ map: {}, count: 0 });
    var groups = [], i;
    for (i = 0; i < codes.length; i += TX_BLOCK) groups.push(codes.slice(i, i + TX_BLOCK));
    var map = {};
    function one(g) {
      var syms = g.filter(function (c) { return !/\.BJ$/i.test(c); }).map(txSymbol);
      if (!syms.length) return Promise.resolve();
      return new Promise(function (resolve) {
        var url = 'https://qt.gtimg.cn/q=' + syms.join(',');
        var sc = document.createElement('script');
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          /* script 超时：可能请求被挂起（扩展），改走 fetch */
          tencentViaFetch(syms, url, map).then(function (n) {
            markSrc('tencent', n > 0, 'fetch-after-timeout'); resolve();
          });
        }, 6000);
        sc.onload = function () {
          if (settled) return;
          settled = true; clearTimeout(timer);
          var n = 0;
          syms.forEach(function (sym) {
            var v = window['v_' + sym];
            if (typeof v === 'string') { parseOneTx(sym, v, map); n++; }
            try { delete window['v_' + sym]; } catch (e) { }
          });
          /* script 加载了但一个有效数据都没有（可能被扩展替换成空）→ 再试 fetch */
          if (n === 0 && Object.keys(map).length === 0) {
            tencentViaFetch(syms, url, map).then(function (m) {
              markSrc('tencent', m > 0, 'fetch-after-empty'); resolve();
            });
          } else {
            markSrc('tencent', true); resolve();
          }
        };
        sc.onerror = function () {
          if (settled) return;
          settled = true; clearTimeout(timer);
          tencentViaFetch(syms, url, map).then(function (n) {
            markSrc('tencent', n > 0, 'fetch-after-onerror'); resolve();
          });
        };
        sc.src = url;
        (document.head || document.documentElement).appendChild(sc);
      });
    }
    function run(idx) {
      if (idx >= groups.length) return Promise.resolve();
      return Promise.all([one(groups[idx])]).then(function () {
        return new Promise(function (r) { setTimeout(r, 60); }).then(function () { return run(idx + 1); });
      });
    }
    return run(0).then(function () {
      return { map: map, count: Object.keys(map).length };
    });
  }

  // ---------- 批量取价（ulist 分块，替代不可用的 clist） ----------
  /* clist 全市场列表在浏览器里实测返回 ERR，导致 getAllQuotes 全军覆没，
     页面只能靠 primeVisibleQuotes 一只一只补 —— 这就是「点一个才出一个」。
     ulist 支持多 secids，按 150 只一块并行取，覆盖当前视图完全够用。 */
  function getQuotesByChunks(codes, chunk) {
    codes = (codes || []).filter(Boolean);
    if (!codes.length) return Promise.resolve({ map: {}, count: 0 });
    /* 主通道：腾讯批量。取到的直接返回；一只都没取到才降级东财 ulist。 */
    return getQuotesTx(codes).then(function (r) {
      if (r && r.count > 0) return r;
      return emChunkQuotes(codes, chunk);
    });
  }
  function emChunkQuotes(codes, chunk) {
    var size = chunk || 80;
    var groups = [];
    for (var i = 0; i < codes.length; i += size) groups.push(codes.slice(i, i + size));
    var map = {};
    function one(g) {
      var secids = g.map(secidOf).join(',');
      var url = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
        + '?fltt=2&invt=2&fields=f2,f3,f5,f12,f13,f18,f60&secids=' + encodeURIComponent(secids)
        + '&ut=' + EM_UT;
      return jsonp(url, 'cb', REQ_TIMEOUT).then(function (d) {
        var diff = (d && d.data && d.data.diff) || [];
        diff.forEach(function (it) {
          if (!it) return;
          var code = fullCode(String(it.f12 || ''), Number(it.f13));
          var q = validQuote('em', {
            price: isNum(it.f2) ? it.f2 : null,
            chg: isNum(it.f3) ? it.f3 : null,
            volume: isNum(it.f5) ? it.f5 : null,
            preClose: isNum(it.f60) ? it.f60 : (isNum(it.f18) ? it.f18 : null),
            source: 'em'
          });
          if (q) map[code] = q;
        });
      }).catch(function () {});
    }
    /* 每次并发 4 块，避免一次性打爆被限流 */
    function run(idx) {
      if (idx >= groups.length) return Promise.resolve();
      var batch = groups.slice(idx, idx + 2);
      return Promise.all(batch.map(one)).then(function () {
        return new Promise(function (r) { setTimeout(r, 220); }).then(function () { return run(idx + 2); });
      });
    }
    return run(0).then(function () {
      return { map: map, count: Object.keys(map).length };
    });
  }

  // ---------- 新浪 sina（最后兜底） ----------
  function sinaChunk(codes) {
    var list = codes.map(function (c) { var x = marketOf(c); return x.prefix + x.bare; }).join(',');
    var url = 'https://hq.sinajs.cn/list=' + list;
    return scriptTag(url, REQ_TIMEOUT).then(function () {
      var map = {};
      codes.forEach(function (c) {
        var x = marketOf(c);
        var key = 'hq_str_' + x.prefix + x.bare;
        var raw = global[key];
        if (typeof raw !== 'string' || !raw || raw.indexOf(',') < 0) return;
        var a = raw.split(',');
        // a[1]=今开 a[2]=昨收 a[3]=当前价 a[8]=成交量(股)
        var price = parseFloat(a[3]);
        var preClose = parseFloat(a[2]);
        var chg = (price && preClose) ? (price / preClose - 1) * 100 : null;
        var vol = parseFloat(a[8]), op = parseFloat(a[1]);
        var sq = validQuote('sina', { price: price, chg: chg, preClose: preClose,
          volume: isNum(vol) ? vol : null, open: isNum(op) ? op : null, source: 'sina' });
        if (sq) map[c] = sq;
      });
      return map;
    });
  }

  // ---------- 财务摘要（东财 datacenter，JSONP，前端直连） ----------
  // push2 行情域名在部分网络被拦，但 datacenter 是独立域名且支持 callback，
  // 所以可以在浏览器端直接取真实财报，不必给 6000 只标的都预存一份。
  function getFinance(code) {
    /* 指数没有企业财报：直接返回 null，让页面走"指数无财报"的诚实分支，
       而不是拿 000001.SH 去掉后缀去查平安银行的报表。 */
    if (indexSnapshot(code)) return Promise.resolve(null);
    var bare = String(code).replace(/\.[A-Z]+$/, '');
    var mk = /\.SH$/i.test(code) ? 'SH' : (/\.BJ$/i.test(code) ? 'BJ' : 'SZ');
    var secu = bare + '.' + mk;
    // 只取用到的列：columns=ALL 会返回 200 多个字段，单只 200KB+，手机上很慢。
    // 北交所同样覆盖（实测 920021 有完整季报），不再排除。
    var COLS = ['SECUCODE', 'REPORT_DATE', 'REPORT_DATE_NAME', 'NOTICE_DATE',
      'TOTALOPERATEREVE', 'MLR', 'PARENTNETPROFIT', 'EPSJB', 'BPS', 'MGJYXJJE',
      'ROEJQ', 'ROIC', 'TOTALOPERATEREVETZ', 'PARENTNETPROFITTZ',
      'XSMLL', 'XSJLL', 'ZCFZL', 'LD', 'SD'].join(',');
    var url = 'https://datacenter.eastmoney.com/securities/api/data/v1/get'
      + '?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=' + COLS
      + '&filter=' + encodeURIComponent('(SECUCODE="' + secu + '")')
      + '&pageNumber=1&pageSize=12&sortColumns=REPORT_DATE&sortTypes=-1';
    return jsonp(url, 'callback', 9000).then(function (d) {
      var arr = (d && d.result && d.result.data) || [];
      if (!arr.length) return null;
      function pick(o, keys) {
        for (var i = 0; i < keys.length; i++) {
          var v = o[keys[i]];
          if (typeof v === 'number' && isFinite(v)) return v;
        }
        return null;
      }
      var rows = arr.map(function (o) {
        return {
          date: String(o.REPORT_DATE || '').slice(0, 10),
          name: o.REPORT_DATE_NAME || '',
          rev: pick(o, ['TOTALOPERATEREVE', 'TOTAL_OPERATE_INCOME', 'OPERATE_INCOME']),
          profit: pick(o, ['PARENTNETPROFIT', 'PARENT_NETPROFIT', 'NETPROFIT']),
          gross: pick(o, ['MLR', 'GROSS_PROFIT']),
          eps: pick(o, ['EPSJB', 'EPS']),
          bps: pick(o, ['BPS']),
          roe: pick(o, ['ROEJQ', 'ROE_DILUTED', 'ROE']),
          roic: pick(o, ['ROIC']),
          cashps: pick(o, ['MGJYXJJE']),
          // 报表直接给出的比率（百分数），比前端二次推算更准
          revYoy: pick(o, ['TOTALOPERATEREVETZ']),
          profitYoy: pick(o, ['PARENTNETPROFITTZ']),
          grossPct: pick(o, ['XSMLL']),
          netPct: pick(o, ['XSJLL']),
          debt: pick(o, ['ZCFZL']),
          current: pick(o, ['LD']),
          quick: pick(o, ['SD']),
          notice: String(o.NOTICE_DATE || '').slice(0, 10)
        };
      });
      var cur = rows[0], same = null;
      if (cur && cur.date) {
        var y = String(Number(cur.date.slice(0, 4)) - 1);
        same = rows.filter(function (r) { return String(r.date).slice(0, 4) === y; })[0] || null;
      }
      function yoy(a, b) { return (a != null && b) ? (a / b - 1) * 100 : null; }
      return {
        rows: rows,
        cur: cur, sameQuarter: same,
        revYoy: (cur && cur.revYoy != null) ? cur.revYoy : (cur && same ? yoy(cur.rev, same.rev) : null),
        profitYoy: (cur && cur.profitYoy != null) ? cur.profitYoy : (cur && same ? yoy(cur.profit, same.profit) : null),
        grossPct: (cur && cur.grossPct != null) ? cur.grossPct : ((cur && cur.gross != null && cur.rev) ? (cur.gross / cur.rev * 100) : null)
      };
    }).catch(function () { return null; });
  }

  // ---------- 个股资讯搜索（东财搜索接口，JSONP 可用） ----------
  // 舆情雷达的唯一数据来源：按关键字（代码 / 名称）搜全网财经资讯，返回带时间的条目，
  // 前端据此算「短周期资讯密度相对基线的激增倍数」。做法参考开源项目
  // akshare / stock_news_em 与 PySnownlp 系情感统计：先取时间序列条数，
  // 再做标题去重（噪声打折）与来源多样性加权，而不是直接数「有几条」。
  var NEWS_CACHE = {};
  function getNews(keyword, size) {
    var kw = String(keyword || '').trim();
    if (!kw) return Promise.resolve(null);
    var cacheKey = kw + '|' + (size || 40);
    var hit = NEWS_CACHE[cacheKey];
    if (hit && now() - hit.at < 5 * 60000) return Promise.resolve(hit.data);
    var param = {
      uid: '', keyword: kw, type: ['cmsArticleWebOld'],
      client: 'web', clientType: 'web', clientVersion: 'curr',
      param: { cmsArticleWebOld: {
        searchScope: 'default', sort: 'time', pageIndex: 1,
        pageSize: size || 40, preTag: '', postTag: ''
      } }
    };
    // 注意：这里**不能**预置 cb=cb。jsonp() 会再拼一个动态回调名，
    // 两个 cb 参数会让服务端返回裸 JSON（不包回调），于是回调永不触发 → 页面显示"没有搜到资讯"。
    var url = 'https://search-api-web.eastmoney.com/search/jsonp'
      + '?param=' + encodeURIComponent(JSON.stringify(param));
    return jsonp(url, 'cb', 12000).then(function (d) {
      var arr = (d && d.result && d.result.cmsArticleWebOld) || [];
      var out = {
        total: d && d.hitsTotal,
        list: arr.map(function (o) {
          return {
            date: String(o.date || ''), title: String(o.title || ''),
            media: String(o.mediaName || ''), url: String(o.url || ''),
            summary: String(o.content || '').slice(0, 120)
          };
        })
      };
      NEWS_CACHE[cacheKey] = { at: now(), data: out };
      return out;
    }).catch(function () { return null; });
  }

  // ---------- 市场热度榜（同花顺，带 CORS，浏览器可直连） ----------
  // 为什么用它：微信指数没有公开接口（需登录、无 API），但「用户在搜什么、看什么」这件事，
  // 同花顺热榜本身就是按其站内搜索/浏览热度排的，小时榜 + 日榜的排名差就是「升温速度」。
  // 这样「媒体曝光度」与「搜索热度趋势」两个维度都能落地，且都是真实数据。
  var HOT_CACHE = { at: 0, map: null };
  function getHotList() {
    if (HOT_CACHE.map && now() - HOT_CACHE.at < 10 * 60000) return Promise.resolve(HOT_CACHE.map);
    var base = 'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock'
      + '?stock_type=a&list_type=normal&type=';
    function one(t) {
      return fetch(base + t, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    }
    return Promise.all([one('hour'), one('day')]).then(function (res) {
      var h = res[0], d = res[1], map = {};
      markSrc('ths', !!(h || d));
      /* 同花顺这个接口会间歇性抽风（限流/改字段）。失败时退回上次成功的结果，
         并在数据上打 _cachedAt —— 空一块表比「用昨天的数据假装今天的」更糟，
         但「什么都不显示」对天天看的人更糟，所以给缓存 + 明确时间戳。 */
      if ((!h || !d) && HOT_CACHE.map) { return HOT_CACHE.map; }
      function fill(j, key) {
        var l = j && j.data && j.data.stock_list;
        if (!Array.isArray(l)) return;
        l.forEach(function (it) {
          var c = String(it.code || '');
          if (!/^\d{6}$/.test(c)) return;
          var o = map[c] || (map[c] = {});
          o[key] = {
            rank: it.order, rate: it.rate, chg: it.hot_rank_chg,
            rise: it.rise_and_fall, name: it.name,
            reason: it.analyse_title || '',
            tags: (it.tag && it.tag.concept_tag) || [],
            popular: (it.tag && it.tag.popularity_tag) || ''
          };
        });
      }
      fill(h, 'hour'); fill(d, 'day');
      map._size = { hour: !!(h && h.data), day: !!(d && d.data) };
      HOT_CACHE = { at: now(), map: map };
      return map;
    }).catch(function () { return {}; });
  }

  // ---------- 缓存 ----------
  function cacheKey(codes) { return 'abds_q_' + codes.slice().sort().join('|'); }
  function readCache(codes) {
    try {
      var raw = global.localStorage && global.localStorage.getItem(cacheKey(codes));
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (now() - o.t > TTL) return null;
      return o.data || null;
    } catch (e) { return null; }
  }
  function writeCache(codes, data) {
    try {
      global.localStorage && global.localStorage.setItem(cacheKey(codes), JSON.stringify({ t: now(), data: data }));
    } catch (e) {}
  }

  // ---------- 对外：批量取今日行情 ----------
  // 返回 Promise<{ map: {code:{price,chg,source}}, source, update }>
  function getTodayQuotes(codes) {
    codes = (codes || []).filter(Boolean);
    if (!codes.length) return Promise.resolve({ map: {}, source: 'snapshot', update: 0 });

    var cached = readCache(codes);
    var pending = cached ? Object.keys(cached).filter(function (k) { return !cached[k] || cached[k].chg == null; }) : codes.slice();

    if (!pending.length && cached) {
      return Promise.resolve({ map: cached, source: 'cache', update: 0 });
    }

    var sources = [
      { name: 'em', fn: emChunk },
      { name: 'tencent', fn: tencentChunk },
      { name: 'sina', fn: sinaChunk }
    ];

    var acc = cached || {};
    var usedSource = 'snapshot';

    function run(i) {
      if (i >= sources.length) return Promise.resolve();
      var remain = pending.filter(function (c) { return !acc[c] || acc[c].chg == null; });
      if (!remain.length) return Promise.resolve();
      return sources[i].fn(remain).then(function (part) {
        var got = 0;
        Object.keys(part).forEach(function (k) {
          if (part[k] && part[k].chg != null) { acc[k] = part[k]; got++; }
          else if (part[k] && !acc[k]) { acc[k] = part[k]; }
        });
        if (got > 0 && usedSource === 'snapshot') usedSource = sources[i].name;
        return run(i + 1);
      }).catch(function () { return run(i + 1); });
    }

    return run(0).then(function () {
      // 仅把成功取到 chg 的写入缓存，避免缓存一堆 null
      var toCache = {};
      Object.keys(acc).forEach(function (k) { if (acc[k] && acc[k].chg != null) toCache[k] = acc[k]; });
      writeCache(codes, toCache);
      status.lastSource = usedSource;
      status.lastUpdate = now();
      status.message = usedSource === 'snapshot' ? '实时源暂不可用 · 已用快照口径' : ('实时行情来源：' + usedSource);
      return { map: acc, source: usedSource, update: now() };
    });
  }

  // 单只（供 lens 实时价）
  function getQuoteSingle(code) {
    return getTodayQuotes([code]).then(function (r) { return r.map[code] || null; });
  }

  // ---------- K 线（前复权日K：离线静态优先 + 四源实时降级） ----------
  // 返回 { bars:[{d,o,c,h,l,v,pct,turn}], dates:[], close:[], source }
  // 东财参数对齐 live.js 里再生脚本实测可用的格式：
  //   fields1=f1..f6 / fields2=f51..f61 / beg+end+ / lmt；旧版 fields1=f1 且缺 beg 会返回空。
  function packBars(bars, source) {
    return {
      bars: bars,
      dates: bars.map(function (b) { return b.d; }),
      close: bars.map(function (b) { return b.c; }),
      source: source
    };
  }
  function begDate(daysBack) {
    var d = new Date(Date.now() - daysBack * 86400000);
    function p(x) { return x < 10 ? '0' + x : '' + x; }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }
  /* 离线静态日K：kline.js 定义
   * window.AB_KLINE = { asOf, bars: { "159206.SZ": [[d,o,c,h,l,v,pct,turn], ...] } }
   * 由 tools/regen_offline.py 一键生成（生成前为空骨架，自动跳过）。 */
  function offlineKline(code) {
    var K = global.AB_KLINE;
    if (!K || !K.bars) return null;
    var bare = String(code).replace(/\.[A-Z]{2,4}$/, '');
    var arr = K.bars[code] || K.bars[bare];
    if (!arr || arr.length < 2) return null;
    var bars = arr.map(function (a) {
      if (Array.isArray(a)) return { d: a[0], o: +a[1], c: +a[2], h: +a[3], l: +a[4], v: +(a[5] || 0), pct: +(a[6] || 0), turn: +(a[7] || 0) };
      return { d: a.d, o: +a.o, c: +a.c, h: +a.h, l: +a.l, v: +(a.v || 0), pct: +(a.pct || 0), turn: +(a.turn || 0) };
    }).filter(function (b) { return b.d && isNum(b.c) && b.c > 0; });
    return bars.length > 1 ? packBars(bars, 'offline') : null;
  }
  function emKline(code, n, host, fqt) {
    var x = marketOf(code), secid = x.m + '.' + x.bare;
    var url = host + '/api/qt/stock/kline/get?ut=' + EM_UT + '&secid=' + secid
      + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
      + '&klt=101&fqt=' + (fqt == null ? 1 : fqt) + '&beg=' + begDate(1600) + '&end=20500101&lmt=' + n;
    return jsonp(url, 'cb', REQ_TIMEOUT).then(function (d) {
      var k = d && d.data && d.data.klines;
      if (!k || !k.length) throw new Error('em kline empty');
      var bars = k.map(function (line) {
        var p = String(line).split(',');
        return { d: p[0], o: +p[1], c: +p[2], h: +p[3], l: +p[4], v: +(p[5] || 0), pct: +(p[8] || 0), turn: +(p[10] || 0) };
      }).filter(function (b) { return b.d && isNum(b.c) && b.c > 0 && isNum(b.o) && b.o > 0; });
      if (bars.length < 2) throw new Error('em kline empty');
      return packBars(bars, host.indexOf('push2his') >= 0 ? 'em' : 'em-alt');
    });
  }
  /* 腾讯前复权日K：web.ifzq.gtimg.cn/appstock/app/fqkline/get
   * 返回 data[sh600066].qfqday = [[日期,开,收,高,低,量], ...] */
  function tencentKline(code, n) {
    var x = marketOf(code), sym = x.prefix + x.bare;
    var url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + sym + ',day,,,' + n + ',qfq';
    return jsonp(url, 'callback', REQ_TIMEOUT).then(function (d) {
      var o = d && d.data && d.data[sym];
      var k = o && (o.qfqday || o.day || o.hfqday);
      if (!k || !k.length) throw new Error('tencent kline empty');
      var bars = k.map(function (a) {
        return { d: a[0], o: +a[1], c: +a[2], h: +a[3], l: +a[4], v: +(a[5] || 0), pct: 0, turn: 0 };
      }).filter(function (b) { return b.d && isNum(b.c) && b.c > 0 && isNum(b.o) && b.o > 0; });
      if (bars.length < 2) throw new Error('tencent kline empty');
      return packBars(bars, 'tencent');
    });
  }
  function sinaKline(code, n) {
    var x = marketOf(code);
    var url = 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketData.getKLineData'
      + '?symbol=' + x.prefix + x.bare + '&scale=240&ma=no&datalen=' + n;
    return jsonp(url, 'callback', REQ_TIMEOUT).then(function (arr) {
      if (!arr || !arr.length) throw new Error('sina kline empty');
      var bars = arr.map(function (it) {
        return { d: it.d, o: +it.o, c: +it.c, h: +it.h, l: +it.l, v: +(it.v || 0), pct: 0, turn: 0 };
      }).filter(function (b) { return b.d && isNum(b.c) && b.c > 0 && isNum(b.o) && b.o > 0; });
      if (bars.length < 2) throw new Error('sina kline empty');
      return packBars(bars, 'sina');
    });
  }
  /* 顺序：离线静态 → 东财 push2his → 东财 push2（报价能通时该主机通常可用）
   * → 腾讯 fqkline → 新浪。forceLive=true 可跳过静态强制走实时。 */
  // ---------- 腾讯「赋值式」脚本：等价 JSONP，且三入口轮换 ----------
  // 参考 simonlin1212/a-stock-data：腾讯 K 线用 _var=xxx 返回 `xxx={...}`（可执行赋值），
  // 这样跨域也能用 <script> 取数；同时它有 3 个不同入口，单入口约 600 次后限流，轮换可续命。
  // 实测（2026-11-14）：三个入口均可用；bj 代码返回 day（无 qfqday），也支持。
  var TC_HOSTS = [
    'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
    'https://ifzq.gtimg.cn/appstock/app/fqkline/get',
    'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get'
  ];
  var TC_RR = 0;
  function scriptVar(url, name, timeout) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url; s.async = true;
      var done = false, t;
      function fin(err) {
        if (done) return; done = true; clearTimeout(t);
        try { document.head.removeChild(s); } catch (e) {}
        if (err) { reject(new Error(err)); return; }
        var v = global[name];
        try { delete global[name]; } catch (e) {}
        resolve(v);
      }
      s.onload = function () { setTimeout(function () { fin(null); }, 0); };
      s.onerror = function () { fin('script error'); };
      t = setTimeout(function () { fin('timeout'); }, timeout || 8000);
      document.head.appendChild(s);
    });
  }
  function tencentKlineLive(code, n) {
    var x = marketOf(code), sym = x.prefix + x.bare;
    var cnt = Math.max(30, Math.min(800, n || 300));
    var tries = 0;
    function attempt() {
      if (tries >= TC_HOSTS.length) return Promise.reject(new Error('tencent kline all hosts failed'));
      var host = TC_HOSTS[(TC_RR + tries) % TC_HOSTS.length];
      var varName = 'abk' + Math.random().toString(36).slice(2, 9);
      var url = host + '?_var=' + varName + '&param=' + sym + ',day,,,' + cnt + ',qfq&_t=' + now();
      tries++;
      return scriptVar(url, varName, 6000).then(function (d) {
        var o = d && d.data && d.data[sym];
        var k = o && (o.qfqday || o.day || o.hfqday);
        if (!k || k.length < 2) throw new Error('empty');
        var bars = k.map(function (a) {
          return { d: String(a[0]).slice(0, 10), o: +a[1], c: +a[2], h: +a[3], l: +a[4], v: +(a[5] || 0) };
        }).filter(function (b) { return b.d && b.c > 0 && b.o > 0; });
        if (bars.length < 2) throw new Error('empty');
        TC_RR = (TC_RR + tries) % TC_HOSTS.length;   // 成功即换下一个入口，摊薄单入口压力
        return { bars: bars, source: '腾讯K线(实时)', live: true, asOf: bars[bars.length - 1].d.replace(/-/g, '') };
      }).catch(function () { return attempt(); });
    }
    return attempt();
  }

  // ---------- 腾讯实时 46 字段（真实 PE / PB / 换手率 / 涨跌停） ----------
  // 参考同一项目：「腾讯 API 字段 43 是振幅、46 是 PB」，网上大量教程写错。
  // 这里只取详情页需要的几个，缺失不猜（返回 null）。
  var RICH_CACHE = {};
  function getQuoteRich(code) {
    var x = marketOf(code), sym = x.prefix + x.bare;
    var hit = RICH_CACHE[code];
    if (hit && now() - hit.at < 20000) return Promise.resolve(hit.data);
    return scriptTag('https://qt.gtimg.cn/q=' + sym + '&_t=' + now(), 7000).then(function () {
      var raw = global['v_' + sym];
      if (!raw) return null;
      var a = String(raw).split('~');
      function num(i) { var v = parseFloat(a[i]); return isFinite(v) ? v : null; }
      var out = {
        name: a[1], code: a[2],
        price: num(3), preClose: num(4), open: num(5),
        chg: num(31),
        high: num(33), low: num(34),
        turnover: num(38),        // 换手率 %
        pe: num(39),              // PE(TTM)
        amplitude: num(43),       // 振幅 %
        floatCap: num(44),        // 流通市值（亿）
        totalCap: num(45),        // 总市值（亿）
        pb: num(46),
        limitUp: num(47), limitDown: num(48),
        volumeRatio: num(49),     // 量比
        peDyn: num(52), peStatic: num(53),
        time: a[30]
      };
      // 涨跌幅自己算：不同市场/停牌时第 32 位口径不稳，用「现价 / 昨收」更可靠
      if (isNum(a[3]) && +a[3] > 0 && isNum(a[4]) && +a[4] > 0) out.chgPct = (+a[3] / +a[4] - 1) * 100;
      RICH_CACHE[code] = { at: now(), data: out };
      return out;
    }).catch(function () { return null; });
  }

  // ---------- 本地预生成日K（同源静态分片） ----------
  // 三个在线日K源在浏览器里都拿不到（无 JSONP / 无 CORS / 被 WAF 拦），
  // 所以真实蜡烛图改由构建时预生成的分片提供：同源 fetch，不受跨域限制。
  // kline/index.json: {asOf, bars, shards, map:{code: 分片号}}
  // kline/sN.json:    {asOf, codes:{code: "打包字符串"}}
  var KLINDEX = null, KLINDEX_P = null, KLSHARD = {};
  function klBust() {
    var m = (global.AB_DATA && global.AB_DATA.meta) || {};
    return String(m.asOf || m.asOfCore || '1').replace(/\D/g, '') || '1';
  }
  function loadKlIndex() {
    if (KLINDEX) return Promise.resolve(KLINDEX);
    if (KLINDEX_P) return KLINDEX_P;
    KLINDEX_P = fetch('kline/index.json?v=' + klBust() + '&sharecode=EPDR6ET2KO', { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { KLINDEX = j || { map: {} }; return KLINDEX; })
      .catch(function () { KLINDEX = { map: {} }; return KLINDEX; });
    return KLINDEX_P;
  }
  var B36C = '0123456789abcdefghijklmnopqrstuvwxyz';
  function b36(seg) {
    var v = 0;
    for (var i = 0; i < seg.length; i++) v = v * 36 + B36C.indexOf(seg.charAt(i));
    return v;
  }
  function dayToYmd(days) {
    var t = new Date(Date.UTC(2020, 0, 1) + days * 86400000);
    var m = t.getUTCMonth() + 1, d = t.getUTCDate();
    return t.getUTCFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
  }
  /* 解码：前 4 位＝首根收盘（分）；之后每 17 位一根：
     日期差(3) / 开(3) / 高(3) / 低(3) / 收(3) / 量(2)，价格均为「相对上一根收盘」的差分。
     量是 log10 压缩值，只用于画量柱形状，不当作精确成交量。 */
  function decodeKl(packed) {
    if (!packed || packed.length < 21) return null;
    var prevC = b36(packed.slice(0, 4));
    var body = packed.slice(4), prevDay = 0, bars = [];
    for (var i = 0; i + 17 <= body.length; i += 17) {
      var seg = body.substr(i, 17);
      var dl = b36(seg.slice(0, 3));
      var day = prevDay ? prevDay + dl : dl;
      var o = b36(seg.slice(3, 6)) - 8192 + prevC;
      var h = b36(seg.slice(6, 9)) - 8192 + prevC;
      var l = b36(seg.slice(9, 12)) - 8192 + prevC;
      var c = b36(seg.slice(12, 15)) - 8192 + prevC;
      var v = Math.pow(10, b36(seg.slice(15, 17)) / 100) - 1;
      bars.push({ d: dayToYmd(day), o: o / 100, h: h / 100, l: l / 100, c: c / 100, v: v });
      prevC = c; prevDay = day;
    }
    return bars.length ? bars : null;
  }
  function localKline(code) {
    if (!global.fetch) return Promise.resolve(null);
    return loadKlIndex().then(function (idx) {
      var sid = idx && idx.map && idx.map[code];
      if (sid == null) return null;
      var key = 's' + sid;
      if (!KLSHARD[key]) {
        var stamp = (idx && idx.stamp) || klBust();
        KLSHARD[key] = fetch('kline/' + key + '.json?v=' + stamp + '&sharecode=EPDR6ET2KO', { cache: 'force-cache' })
          .then(function (r) { return r.ok ? r.json() : null; });
      }
      return KLSHARD[key].then(function (j) {
        var packed = j && j.codes && j.codes[code];
        if (!packed) return null;
        var bars = decodeKl(packed);
        if (!bars) return null;
        return { bars: bars, source: '本地预生成日K', asOf: j.asOf || idx.asOf, local: true };
      });
    }).catch(function () { return null; });
  }

  function lastBarDate(k) {
    return (k && k.bars && k.bars.length) ? String(k.bars[k.bars.length - 1].d).slice(0, 10) : '';
  }
  function daysBetweenYmd(ymd) {
    var t = String(ymd || '').replace(/\D/g, '');
    if (t.length !== 8) return 999;
    var d = new Date(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8));
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }
  function getKline(code, limit, forceLive) {
    /* 腾讯日K 单次上限 800 根（约 3 年）。要更长的历史（「上市以来」）时必须走东财，
       否则会拿到 800 根就以为到头了，图上看着像「上市才三年」。 */
    if (!forceLive && limit && limit > 800) return getKlineOnline(code, limit);
    if (forceLive) return tencentKlineLive(code, limit).catch(function () { return getKlineOnline(code, limit); });
    return localKline(code).then(function (local) {
      var haveLocal = local && local.bars && local.bars.length > 60;
      // 本地分片是「构建那一刻」的前复权日K：够新就直接用（快、离线可用）。
      // 落后超过 2 个自然日（周末不算）才去腾讯实时拉一次，避免每只票都多打一次网络。
      if (haveLocal && daysBetweenYmd(lastBarDate(local)) <= 2) return local;
      return tencentKlineLive(code, limit).then(function (live) {
        if (live && live.bars && live.bars.length > 60) {
          if (!haveLocal || lastBarDate(live) >= lastBarDate(local)) return live;
        }
        return haveLocal ? local : getKlineOnline(code, limit);
      }).catch(function () {
        return haveLocal ? local : getKlineOnline(code, limit);
      });
    });
  }

  /* 后复权日K：只用于「上市以来」这种超长区间。
     前复权在长期分红后会变成负数（茅台 2001 年前复权价约 -312），算不出涨跌幅；
     后复权价始终为正、且连续，才是算「上市至今涨幅」的正确口径。 */
  function getKlineHfq(code, limit) {
    var n = limit || 6000;
    return emKline(code, n, 'https://push2his.eastmoney.com', 2)
      .catch(function () { return emKline(code, n, 'https://push2.eastmoney.com', 2); });
  }

  function getKlineOnline(code, limit) {
    var n = limit || 400;
    var off = offlineKline(code);
    /* 分片够用才直接返回；要 3000 根而分片只有 250 根时，继续往下走东财。 */
    /* 根数够 + 数据够新（2 个自然日内）才直接用分片；
       分片旧了就算根数够也要拉东财，否则「上市以来」会是过期数据。 */
    if (off && off.bars && off.bars.length > 60 && off.bars.length >= n * 0.8
        && daysBetweenYmd(lastBarDate(off)) <= 2) return Promise.resolve(off);
    return emKline(code, n, 'https://push2his.eastmoney.com')
      .catch(function () { return emKline(code, n, 'https://push2.eastmoney.com'); })
      .catch(function () { return tencentKline(code, n); })
      .catch(function () { return sinaKline(code, n); });
  }

  // ---------- 全市场 A 股代码表（供任意中文名 / 代码搜索） ----------
  // 参考 1Skip/stock-analyzer：全量名称索引 + 本地缓存 + 在线补齐，避免「报一个补一个」
  var UNIVERSE_KEY = 'ab_universe_v1', UNIVERSE_TTL = 7 * 86400000;
  function readUniverse() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(UNIVERSE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.list || !o.list.length || now() - o.t > UNIVERSE_TTL) return null;
      return o.list;
    } catch (e) { return null; }
  }
  function getUniverse() {
    var cached = readUniverse();
    if (cached) return Promise.resolve(cached);
    var url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=6000&po=1&np=1&fltt=2&invt=2&fid=f3'
      + '&fs=' + encodeURIComponent('m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048')
      + '&fields=f12,f13,f14&ut=' + EM_UT;
    return jsonp(url, 'cb', REQ_TIMEOUT).then(function (d) {
      var diff = d && d.data && d.data.diff;
      if (!diff || !diff.length) throw new Error('universe empty');
      var list = diff.map(function (it) {
        var bare = String(it.f12 || '');
        var m = Number(it.f13);
        return { code: fullCode(bare, m), bare: bare, name: String(it.f14 || ''), m: m };
      }).filter(function (x) { return /^\d{6}$/.test(x.bare) && x.name; });
      try { global.localStorage && global.localStorage.setItem(UNIVERSE_KEY, JSON.stringify({ t: now(), list: list })); } catch (e) {}
      return list;
    }).catch(function () { return []; });
  }
  /* ---------- 全市场批量实时行情（少量分页请求覆盖全部 A 股）---------- */
  /* 打开页面即调用：一次装载约 5500 只 A 股最新价/今日涨跌/行情日期，
   * 供 live-refresh.js 用「快照收盘序列 + 今日价」重算四窗口并重跑六派。
   * 非交易时段 f2 即最后收盘价，故同一路径天然得到「收盘统计」。 */
  function _p2(x) { return x < 10 ? '0' + x : '' + x; }
  function _f124ToDate(v) {
    var t = Number(v);
    if (!isFinite(t) || t <= 0) return null;
    if (t > 1e12) t = Math.floor(t / 1000);      // 毫秒 → 秒
    var d = new Date((t + 8 * 3600) * 1000);     // 东财行情时间为北京时间，固定 +8 读取
    return '' + d.getUTCFullYear() + _p2(d.getUTCMonth() + 1) + _p2(d.getUTCDate());
  }
  var ALLQ = { at: 0, map: null, count: 0 };
  /* 东财批量被限流/阻断时的降级：新浪批量（一次 400 只，4 组并行）。
   * 只覆盖「页面已知的标的」（data.js 里的代码），不追求全市场发现。 */
  function sinaBulk(codes, groups) {
    var out = {}, BATCH = 400, G = groups || 4;
    var list = codes.slice(), buckets = [];
    for (var g = 0; g < G; g++) buckets.push([]);
    list.forEach(function (c, i) { buckets[i % G].push(c); });
    function drain(bucket) {
      var idx = 0;
      function step() {
        if (idx >= bucket.length) return Promise.resolve();
        var chunk = bucket.slice(idx, idx + BATCH); idx += BATCH;
        return sinaChunk(chunk).then(function (m) {
          Object.keys(m).forEach(function (k) { out[k] = m[k]; });
          return step();
        }).catch(function () { return step(); });
      }
      return step();
    }
    return Promise.all(buckets.map(drain)).then(function () { return out; });
  }
  /* ETF 代码段：沪 50x/51x/56x/58x，深 15x/16x（用于判断是否需要额外请求基金板块） */
  function isEtfBare(bare) { return /^(15|16|50|51|52|56|58)/.test(bare); }
  function getAllQuotes(codes) {
    if (ALLQ.map && (now() - ALLQ.at) < 15000) {
      return Promise.resolve({ map: ALLQ.map, count: ALLQ.count, update: ALLQ.at, cached: true });
    }
    /* 全量取价同样先走腾讯批量：东财 clist 在浏览器里是死的，
       这是「打开很久只出两三条 / 点一个才出一个」的根源。 */
    if (getQuotesTx && codes && codes.length) {
      return getQuotesTx(codes).then(function (r) {
        if (r && r.count > Math.max(50, codes.length * 0.3)) {
          ALLQ.map = r.map; ALLQ.count = r.count; ALLQ.at = now();
          return { map: r.map, count: r.count, update: ALLQ.at };
        }
        return getAllQuotesViaEm(codes);
      });
    }
    return getAllQuotesViaEm(codes);
  }
  function getAllQuotesViaEm(codes) {
    var FS_STOCK = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
    /* 东财批量行的 fs 默认只覆盖股票市场，不含基金/ETF —— 不额外请求的话
     * 54 只 ETF 的「今日%」永远是「—」（用户实际反馈的现象）。 */
    var FS_ETF = 'b:MK0021,b:MK0022,b:MK0023,b:MK0024';
    var FIELDS = 'f2,f3,f12,f13,f14,f18,f124';
    /* pz 一次取满（原先 pz=800 且串行翻 7 页，是「打开后很久只出两条」的主因） */
    var PZ = 6000, MAXP = 60, map = {};
    function one(fs, pn, have) {
      var url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=' + pn + '&pz=' + PZ
        + '&po=1&np=1&fltt=2&invt=2&fid=f3&fs=' + encodeURIComponent(fs)
        + '&fields=' + FIELDS + '&ut=' + EM_UT;
      return jsonp(url, 'cb', REQ_TIMEOUT).then(function (d) {
        var data = d && d.data;
        if (!data || !data.diff) return;
        var total = isNum(data.total) ? data.total : null;
        data.diff.forEach(function (it) {
          if (!it) return;
          var bare = String(it.f12 || '');
          if (!/^\d{6}$/.test(bare)) return;
          var code = fullCode(bare, Number(it.f13));
          map[code] = {
            price: isNum(it.f2) ? it.f2 : (parseFloat(it.f2) || null),
            chg: isNum(it.f3) ? it.f3 : (parseFloat(it.f3) || null),
            preClose: isNum(it.f18) ? it.f18 : (parseFloat(it.f18) || null),
            date: _f124ToDate(it.f124),
            source: 'em-all'
          };
        });
        /* 翻页判断以 total 为准：若服务端把 pz 截断（返回条数 < 请求数），
           只按「返回条数 >= PZ」判断会漏数据，这里用已取条数对比总数兜底。 */
        var got = (have || 0) + data.diff.length;
        var needMore = (total != null) ? got < total : data.diff.length >= PZ;
        if (needMore && pn < MAXP) return one(fs, pn + 1, got);
      }).catch(function () {});
    }
    var jobs = [one(FS_STOCK, 1, 0)];
    var needEtf = !codes || codes.some(function (c) { return isEtfBare(String(c).replace(/\.[A-Z]+$/, '')); });
    if (needEtf) jobs.push(one(FS_ETF, 1, 0));
    return Promise.all(jobs).then(function () {
      var n = Object.keys(map).length;
      /* 东财几乎没返回（限流 / 网络阻断）→ 用新浪批量兜底，保证「打开即实时」仍有数据 */
      if (n < 200 && codes && codes.length) {
        return sinaBulk(codes).then(function (sm) {
          var sn = Object.keys(sm).length;
          if (sn > n) {
            ALLQ = { at: now(), map: sm, count: sn };
            status.lastSource = 'sina-bulk'; status.lastUpdate = now();
            status.message = '实时行情（新浪兜底）：' + sn + ' 只';
            return { map: sm, count: sn, update: ALLQ.at, fallback: 'sina' };
          }
          ALLQ = { at: now(), map: map, count: n };
          status.lastSource = 'em-all'; status.lastUpdate = now();
          status.message = n ? ('全市场行情：' + n + ' 只') : '全市场行情暂不可用';
          return { map: map, count: n, update: ALLQ.at };
        }).catch(function () {
          ALLQ = { at: now(), map: map, count: n };
          return { map: map, count: n, update: ALLQ.at };
        });
      }
      ALLQ = { at: now(), map: map, count: n };
      status.lastSource = 'em-all'; status.lastUpdate = now();
      status.message = n ? ('全市场行情：' + n + ' 只') : '全市场行情暂不可用';
      return { map: map, count: n, update: ALLQ.at };
    });
  }
  /* 交易日时段判定（北京时间；周末为非交易，节假日按行情日期自动回退收盘） */
  function sessionState() {
    var d = new Date(now() + 8 * 3600 * 1000);   // 以 UTC 字段读取北京墙钟
    var wd = d.getUTCDay(), mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    var weekday = wd >= 1 && wd <= 5;
    var inAM = mins >= 570 && mins <= 690;       // 09:30-11:30
    var inPM = mins >= 780 && mins <= 900;       // 13:00-15:00
    var open = weekday && (inAM || inPM);
    var date = '' + d.getUTCFullYear() + _p2(d.getUTCMonth() + 1) + _p2(d.getUTCDate());
    return { open: open, date: date, mins: mins,
             label: open ? '盘中实时' : '非交易时段 · 收盘数据' };
  }

  // 东财 suggest（中文名 / 拼音 / 代码），失败时回退全量代码表本地过滤
  function suggest(q) {
    var kw = String(q || '').trim();
    if (!kw) return Promise.resolve([]);
    var url = 'https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(kw)
      + '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=12';
    return jsonp(url, 'cb', 6000).then(function (d) {
      var arr = d && d.QuotationCodeTable && d.QuotationCodeTable.Data;
      if (!arr || !arr.length) throw new Error('suggest empty');
      return arr.map(function (it) {
        var qid = String(it.QuoteID || '');
        var seg = qid.split('.');
        var m = Number(seg[0]);
        var bare = seg[1] || String(it.Code || '');
        return { code: fullCode(bare, m), bare: bare, name: String(it.Name || ''), m: m };
      }).filter(function (x) { return /^\d{6}$/.test(x.bare) && x.name; });
    }).catch(function () {
      return getUniverse().then(function (list) {
        var low = kw.toLowerCase();
        return list.filter(function (x) {
          return x.name.toLowerCase().indexOf(low) >= 0 || x.bare.indexOf(low) >= 0;
        }).slice(0, 12);
      });
    });
  }

  /* ============================================================
   * 行业板块：东财全量成分股 + 板块指数当日涨跌
   * GitHub 依据：akshare-mcp / skyformat99/astock-data-skill 的
   *   stock_board_industry_name_em（板块列表含涨跌幅）
   *   stock_board_industry_cons_em（按 BK 代码拉全量成分股）
   * 前端等价 JSONP：push2 clist/get  fs=m:90+t:2 （板块） / b:BKxxxx（成分股）
   * industry.js 可离线提供同结构数据：window.AB_INDUSTRY
   * ============================================================ */
  var IND_CACHE = { boards: null, at: 0 }, IND_CONS = {};
  function offlineIndustry() {
    var D = global.AB_INDUSTRY;
    return (D && D.boards && D.boards.length) ? D : null;
  }
  function getIndustryBoards(force) {
    var off = offlineIndustry();
    if (off && !force) { IND_CACHE.boards = off.boards; return Promise.resolve(off.boards); }
    if (IND_CACHE.boards && now() - IND_CACHE.at < 60000 && !force) return Promise.resolve(IND_CACHE.boards);
    var url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=200&po=1&np=1&fltt=2&invt=2&fid=f3'
      + '&fs=' + encodeURIComponent('m:90+t:2+f:!50')
      + '&fields=f12,f13,f14,f2,f3,f128,f136&ut=' + EM_UT;
    return jsonp(url, 'cb', REQ_TIMEOUT).then(function (d) {
      var diff = d && d.data && d.data.diff;
      if (!diff || !diff.length) throw new Error('boards empty');
      var arr = diff.map(function (it) {
        return {
          bk: String(it.f12 || ''), name: String(it.f14 || ''),
          chg: isNum(it.f3) ? it.f3 : null, price: isNum(it.f2) ? it.f2 : null,
          lead: String(it.f128 || ''), leadChg: isNum(it.f136) ? it.f136 : null
        };
      }).filter(function (b) { return b.bk && b.name; });
      IND_CACHE = { boards: arr, at: now() };
      return arr;
    }).catch(function () { return IND_CACHE.boards || []; });
  }
  function getIndustryCons(bk, force) {
    var off = offlineIndustry();
    if (off && off.cons && off.cons[bk] && !force) return Promise.resolve(off.cons[bk]);
    if (IND_CONS[bk] && now() - IND_CONS[bk].at < 60000 && !force) return Promise.resolve(IND_CONS[bk].list);
    var url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=1000&po=1&np=1&fltt=2&invt=2&fid=f3'
      + '&fs=' + encodeURIComponent('b:' + bk + '+f:!50')
      + '&fields=f12,f13,f14,f2,f3,f6,f8&ut=' + EM_UT;
    return jsonp(url, 'cb', REQ_TIMEOUT).then(function (d) {
      var diff = d && d.data && d.data.diff;
      if (!diff || !diff.length) throw new Error('cons empty');
      var list = diff.map(function (it) {
        var bare = String(it.f12 || ''), m = Number(it.f13);
        return {
          code: fullCode(bare, m), bare: bare, name: String(it.f14 || ''),
          price: isNum(it.f2) ? it.f2 : null, chg: isNum(it.f3) ? it.f3 : null,
          amt: isNum(it.f6) ? it.f6 : null, turn: isNum(it.f8) ? it.f8 : null
        };
      }).filter(function (x) { return /^\d{6}$/.test(x.bare) && x.name; });
      IND_CONS[bk] = { at: now(), list: list };
      return list;
    }).catch(function () { return (IND_CONS[bk] && IND_CONS[bk].list) || []; });
  }
  /* 同花顺行业名 → 东财板块名。仅列高置信差异项；其余靠精确同名 + 包含匹配。
   * 宽基 / 主题 / 跨境类不是行业板块，不做成分股扩展（页面会明确标注）。 */
  var IND_ALIAS = {
    '白酒': '酿酒行业', '零售': '商业百货', '计算机应用': '软件开发',
    '旅游及酒店': '旅游酒店', '环保工程': '环保行业', '煤炭开采加工': '煤炭行业',
    '石油加工贸易': '石油行业', '种植业与林业': '农牧饲渔', '食品加工制造': '食品饮料',
    '钢铁': '钢铁行业', '建筑材料': '水泥建材', '白色家电': '家电行业',
    '包装印刷': '包装材料', '纺织制造': '纺织服装', '有色冶炼加工': '工业金属',
    '文化传媒': '传媒', '军工装备': '航天航空', '电力': '电力行业',
    '房地产': '房地产开发', '光学光电子': '光学光电子'
  };
  var IND_NOT_SECTOR = /宽基|创业板|科创|海外|港股/;
  function mapIndustry(thsName, boards) {
    if (!thsName || IND_NOT_SECTOR.test(thsName)) return null;
    var want = IND_ALIAS[thsName] || thsName;
    var i, b;
    for (i = 0; i < boards.length; i++) { b = boards[i]; if (b.name === want) return b; }
    for (i = 0; i < boards.length; i++) {
      b = boards[i];
      if (want.length >= 2 && (b.name.indexOf(want) >= 0 || want.indexOf(b.name) >= 0)) return b;
    }
    return null;
  }

  // ---------- 快照（data.js） ----------
  var SNAP = { records: [], byCode: {}, byBare: {}, meta: {} };

  /* 把云端 AB_NEWS 的真实条目回填到每一行的 newsMain / newsItems。
   * 背景：data.js 按红线「不编造」不带新闻源，旧代码只读 r.newsMain，
   * 于是即使 news_data.js 已抓到 79 源 1416 条，三态总表的舆情列仍全是「—」。
   * 这里只做真实命中：
   *   1) 个股：标题里完整出现标的名称（按名称倒排，O(条目×名称长度)，不扫全市场）；
   *   2) 个股专属流：AB_NEWS.stockNews[代码]；
   *   3) 行业级：按 rows[].ind 精确映射到 AB_NEWS 的真实行业主题（与行业页/板块共振同源），
   *      明确标「行业级」，绝不冒充个股新闻。
   * 激增倍数只有行业级且基线就绪才给；个股级没有逐日历史，留空并显示真实条数/媒体数。 */
  function hydrateNews() {
    var RN = global.AB_NEWS;
    var rows = SNAP.records || [];
    if (!RN || !rows.length) return 0;
    var items = Array.isArray(RN.items) ? RN.items : [];
    var themes = Array.isArray(RN.themes) ? RN.themes : [];
    var tmap = {}, nameKey = {}, k;
    themes.forEach(function (t) {
      if (!t || !t.key) return;
      tmap[t.key] = t;
      if (t.name) nameKey[t.name] = t.key;
    });

    var nameRows = {};
    rows.forEach(function (r) {
      var n = String((r && r.name) || '').trim();
      if (n.length >= 2) (nameRows[n] = nameRows[n] || []).push(r);
    });
    // 标题倒排：只给「完整标的名」建键，避免 6000 行 × 1200 条的暴力匹配
    var titleIdx = {};
    items.forEach(function (x, i) {
      var t = String((x && x.t) || '');
      for (var len = 2; len <= 8; len++) {
        for (var p = 0; p + len <= t.length; p++) {
          var s = t.substr(p, len);
          if (nameRows[s]) (titleIdx[s] = titleIdx[s] || []).push(i);
        }
      }
    });

    var filled = 0;
    rows.forEach(function (r) {
      if (!r || !r.code) return;
      var hits = [], seen = {};
      function push(x) {
        if (!x || !x.t || seen[x.t]) return;
        seen[x.t] = 1; hits.push(x);
      }
      var nm = String(r.name || '').trim();
      (titleIdx[nm] || []).forEach(function (i) { push(items[i]); });
      var bare = String(r.code).replace(/\.[A-Z]{2,4}$/, '');
      ((RN.stockNews || {})[bare] || []).forEach(function (x) {
        push({ t: x.t, m: x.m, u: x.u, d: x.d0, k: [], src: '个股专属',
               ts: Date.parse(String(x.d || '').replace(/-/g, '/')) || 0 });
      });

      var keys = [];
      function addKey(kk) {
        if (!kk) return;
        var key = tmap[kk] ? kk : nameKey[kk];   // 兼容旧 key 与「行业名→新 key」
        if (key && keys.indexOf(key) < 0) keys.push(key);
      }
      addKey(r.ind);                              // 唯一权威：行业页用的同一个 ind 字段
      hits.forEach(function (h) { (h.k || []).forEach(addKey); });
      // 行业按真实极性强度取最强的一条；没有直接命中时它就是「行业级」证据
      var best = null;
      keys.forEach(function (kk) {
        var t = tmap[kk];
        if (!best || Math.abs(t.score || 0) > Math.abs(best.score || 0) ||
            (t.mediaN || 0) > (best.mediaN || 0)) best = t;
      });

      var media = {}, hp = 0, hn = 0, hHas = false;
      hits.forEach(function (h) {
        if (h.m) media[h.m] = 1;
        if (h.d === 1) { hp++; hHas = true; }
        else if (h.d === -1) { hn++; hHas = true; }
      });
      var dir = hHas ? (hp > hn ? 1 : (hn > hp ? -1 : 0)) : (best ? (best.dir || 0) : 0);
      var score = hHas ? (hp - hn) / (hp + hn) : (best ? (best.score || 0) : 0);
      var level = hits.length ? '个股命中' : (best ? '行业级' : '');
      if (!level) { r.newsMain = null; r.newsItems = []; return; }
      var n1 = hits.length || (best ? (best.n1 || 0) : 0);
      var mediaN = hits.length ? Object.keys(media).length : (best ? (best.mediaN || 0) : 0);
      var read = level === '个股命中'
        ? '真实资讯命中 ' + hits.length + ' 条 / ' + mediaN + ' 家' + (best ? ' · 行业「' + best.name + '」' : '')
          + '；个股逐日基线不足，暂不判激增倍数'
        : '行业「' + best.name + '」当日 ' + n1 + ' 条 / ' + mediaN + ' 家（行业级，非个股专属）'
          + (best.baselineStatus && best.baselineStatus !== 'ready' ? '；激增基线积累中' : '');
      var top = hits.length
        ? hits.slice(0, 3).map(function (h) { return { t: h.t, m: h.m, u: h.u }; })
        : ((best && best.top) || []).slice(0, 3);
      r.newsMain = {
        key: best ? best.key : '', name: best ? best.name : '个股资讯',
        level: level, surge: (!hits.length && best && isNum(best.surge)) ? best.surge : null,
        eff: best ? (best.eff || 0) : score, score: score, dir: dir,
        n1: n1, mediaN: mediaN, nSources: mediaN,
        baselineStatus: hits.length ? '个股基线积累中' : ((best && best.baselineStatus) || ''),
        read: read, top: top, evidenceN: hits.length
      };
      r.newsItems = hits.slice(0, 6).map(function (h) {
        return { title: h.t, t: h.t, m: h.m, u: h.u, d: h.d, src: h.src || '资讯', key: best ? best.key : '' };
      });
      filled++;
    });
    return filled;
  }

  function init() {
    var D = global.AB_DATA;
    if (!D) return;
    SNAP.meta = D.meta || {};
    var raw = D.rows || D.records || D.data || D.list || [];
    var R = Array.isArray(raw) ? raw : Object.keys(raw).map(function (k) { return raw[k]; });
    SNAP.records = R;
    SNAP.byCode = {}; SNAP.byBare = {};
    R.forEach(function (r) {
      if (!r || !r.code) return;
      SNAP.byCode[r.code] = r;
      SNAP.byBare[String(r.code).replace(/\.[A-Z]{2,4}$/, '')] = r;   // 兼容分享深链的裸代码
    });
    hydrateNews();
  }
  /* 指数与个股存在「裸代码撞车」：上证指数 000001.SH 与平安银行 000001.SZ 裸码同为 000001，
     科创50 000688.SH 与国城矿业 000688.SZ 亦然。曾经的问题：snapshot 先做裸码回退，
     于是点指数卡片拿到的是个股行（标题写平安银行 / 国城矿业，K线却是指数点位），
     页面出现"个股财报 + 指数点位"的混搭。现在顺序固定为「全码精确 → 全码指数 → 裸码回退」，
     指数识别只看带市场后缀的全码，裸码回退继续服务分享深链。 */
  function indexSnapshot(code) {
    var list = (global.AB_DATA && global.AB_DATA.indexStates) || [];
    if (!code) return null;
    var s = String(code).toUpperCase().trim();
    /* 容忍 sh000001 / 000001.SH / SH000001 三种写法 */
    var m = s.match(/^([A-Z]{2})?(\d{6})(\.([A-Z]{2}))?$/);
    if (m) {
      var mk = (m[4] || (m[1] === 'SH' || m[1] === 'SZ' ? m[1] : '')).toUpperCase();
      var bare = m[2];
      for (var i = 0; i < list.length; i++) {
        var c = String(list[i].code || '').toUpperCase();
        if (c === s) return wrapIndex(list[i]);
        if (mk && c === bare + '.' + mk) return wrapIndex(list[i]);
      }
      return null;   // 带后缀却没匹配到指数：交给个股逻辑，不做裸码猜测
    }
    return null;
  }
  function wrapIndex(x) {
    return {
      code: x.code, name: x.name, kind: 'index', tier: 'index',
      ind: '宽基指数', cat: '指数',
      state: x.state, stateDays: x.stateDays, stateCapped: x.stateCapped,
      resonance: x.resonance, scores: x.scores, votes: x.votes || null, pct: x.pct,
      point: x.point, chg: x.chg, baseDate: x.baseDate, closes: x.closes, c250: x.c250,
      /* closes 必须带上：前端「接下来怎么走」要靠它算均线和箱体。
         这里重建对象时漏掉过，结果大盘页的价位全是「— 元」和「0 根」。 */
      closes: x.closes, c250: x.c250,
      mcap: null, pe: null, pb: null, turn: null,
      themes: [], newsItems: [], dataFlags: x.state ? [] : ['指数三态未计算']
    };
  }
  function snapshot(code) {
    if (!code) return null;
    if (SNAP.byCode[code]) return SNAP.byCode[code];
    /* 指数必须在裸码回退之前判定，否则 000001.SH 会被 byBare['000001'] 抢走成平安银行 */
    var idx = indexSnapshot(code);
    if (idx) return idx;
    var byBare = SNAP.byBare[String(code).replace(/\.[A-Z]{2,4}$/, '')];
    if (byBare) return byBare;
    return null;
  }
  function isIndexCode(code) { return !!indexSnapshot(code); }
  function allRecords() { return SNAP.records; }
  function meta() { return SNAP.meta; }

  global.AB_DS = {
    init: init,
    refreshNews: hydrateNews,
    getTodayQuotes: getTodayQuotes,
    getQuoteSingle: getQuoteSingle,
    getAllQuotes: getAllQuotes,
    getQuotesByChunks: getQuotesByChunks,
    getKlineHfq: getKlineHfq,
    getMarketLive: getMarketLive,
    getLimitPools: getLimitPools,
    getBoardQuotes: getBoardQuotes,
    srcHealth: srcHealth,
    markSrc: markSrc,
    sessionState: sessionState,
    getKline: getKline,
    getFinance: getFinance,
    getNews: getNews,
    getHotList: getHotList,
    getQuoteRich: getQuoteRich,
    tencentKlineLive: tencentKlineLive,
    offlineKline: offlineKline,
    getIndustryBoards: getIndustryBoards,
    getIndustryCons: getIndustryCons,
    mapIndustry: mapIndustry,
    getUniverse: getUniverse,
    suggest: suggest,
    snapshot: snapshot,
    isIndexCode: isIndexCode,
    allRecords: allRecords,
    meta: meta,
    status: function () { return status; },
    marketOf: marketOf
  };
})(window);
