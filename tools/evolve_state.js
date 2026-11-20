'use strict';
/*
 * 自进化 · 三态校准
 * ==================================================================
 * 为什么不能直接回放历史：三态是「六派当期截面投票 + 行业分位」算出来的，
 * 历史某一天的截面（市值分位、行业排名、舆情）已经拿不到了。硬回放只能得到
 * 一个「价格代理版」，看着像真，其实不是引擎当时的判断。
 *
 * 所以这里走「先记账、后对账」：
 *   archive  每天把引擎真实输出的三态 / 六派分 / 票数 / 收盘，压缩存一档
 *   score    等 20 个交易日走完，用真实收盘给它打分（收益、是否上涨、相对指数超额）
 *   calib    汇总成「某状态 → 20 日胜率 / 平均收益 / 超额」的校准表
 *
 * 好处：样本是真的，不存在未来函数；开始时样本少，页面就如实写「累计中」，
 * 不拿近似值冒充实盘胜率。攒够 60 个交易日就能替代前端那张「近似规则」表。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const vm = require('vm');
const L = require('./learn_lib.js');

const DIR = path.join(L.LEARN, 'state');
const CALIB = path.join(L.LEARN, 'state_calib.json');
const HORIZON = 20;

function ensureDir() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }

function loadData() {
  const p = path.join(L.ROOT, 'data.js');
  const code = fs.readFileSync(p, 'utf8').replace(/^\ufeff/, '');
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { timeout: 60000 });
  return ctx.window.AB_DATA;
}

function archive() {
  const D = loadData();
  const date = (D.meta && D.meta.asOf) || '';
  if (!date) throw new Error('data.js 缺少 asOf');
  ensureDir();
  const rows = (D.rows || []).map(function (r) {
    const cl = (r.closes && r.closes.length) ? r.closes[r.closes.length - 1] : null;
    const s = r.scores || {};
    return [
      r.code, r.state || '', r.stage || '',
      +(s.structure || 0).toFixed(3), +(s.volume || 0).toFixed(3), +(s.fund || 0).toFixed(3),
      +(s.senti || 0).toFixed(3), +(s.config || 0).toFixed(3), +(s.news || 0).toFixed(3),
      r.resonance == null ? -1 : r.resonance, r.negVotes == null ? -1 : r.negVotes,
      cl == null ? null : +(+cl).toFixed(3),
      r.indL1 || r.ind || '', r.kind || ''
    ];
  });
  const f = path.join(DIR, date + '.json.gz');
  fs.writeFileSync(f, zlib.gzipSync(Buffer.from(JSON.stringify({ date: date, rows: rows }))));
  console.log('三态快照归档 %s：%d 只，%s KB', date, rows.length, Math.round(fs.statSync(f).size / 1024));
}

function readArchives() {
  ensureDir();
  return fs.readdirSync(DIR).filter(function (f) { return /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f); })
    .map(function (f) {
      try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, f))).toString()); }
      catch (e) { return null; }
    }).filter(Boolean).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
}

function score() {
  const arch = readArchives();
  const idx = L.loadIndexHist();
  const cal = idx.bars.map(function (b) { return b[0]; });   // 交易日历
  const idxCl = idx.bars.map(function (b) { return b[2]; });
  const pos = {};
  cal.forEach(function (d, i) { pos[d] = i; });

  const ready = arch.filter(function (a) {
    const i = pos[a.date];
    return i != null && i + HORIZON < cal.length;
  });
  if (!ready.length) {
    L.writeJson(CALIB, { ready: false, updatedAt: new Date().toISOString().slice(0, 19), days: arch.length, need: HORIZON, note: '样本累计中' });
    console.log('三态校准：归档 %d 天，尚不足 %d 个交易日，暂不出胜率', arch.length, HORIZON);
    return;
  }

  const O = require('./load_ohlc.js').load();
  const idxMap = {};
  O.codes && Object.keys(O.codes).forEach(function (c) {
    const m = O.codes[c];
    if (!m.bars) return;
    const mp = {};
    m.bars.forEach(function (b, i) { mp[b[0]] = i; });
    idxMap[c] = mp;
  });

  const buckets = {};
  function put(key, sub, ret, ex) {
    const b = buckets[key] = buckets[key] || {};
    const s = b[sub] = b[sub] || { n: 0, win: 0, sum: 0, sumEx: 0, arr: [] };
    s.n++; if (ret > 0) s.win++; s.sum += ret; s.sumEx += ex; s.arr.push(ret);
  }

  let samples = 0;
  ready.forEach(function (a) {
    const i0 = pos[a.date];
    const fwdDate = cal[i0 + HORIZON];
    const idxRet = (idxCl[i0 + HORIZON] / idxCl[i0] - 1) * 100;
    a.rows.forEach(function (r) {
      const code = r[0], state = r[1], stage = r[2], pos6 = r[9];
      const cl0 = r[11];
      if (!cl0 || !state) return;
      const mp = idxMap[code];
      if (!mp) return;
      const j0 = mp[a.date];
      if (j0 == null) return;
      // 用日历日定位 20 个交易日后的收盘（停牌则取之前最近一根）
      let j1 = mp[fwdDate];
      if (j1 == null) {
        let back = HORIZON;
        while (back > 0 && j1 == null) { j1 = mp[cal[i0 + back]]; back--; }
      }
      if (j1 == null || j1 <= j0) return;
      const bars = O.codes[code].bars;
      const c1 = bars[j1][2];
      if (!(c1 > 0)) return;
      const ret = (c1 / cl0 - 1) * 100;
      if (!isFinite(ret) || Math.abs(ret) > 300) return;      // 除权/停牌异常，跳过
      samples++;
      put('state', state, ret, ret - idxRet);
      put('votes', String(pos6), ret, ret - idxRet);
      put('stage', stage || '—', ret, ret - idxRet);
    });
  });

  function pack(b) {
    const out = {};
    Object.keys(b).forEach(function (k) {
      const s = b[k];
      if (s.n < 30) return;
      out[k] = {
        n: s.n,
        win: +(s.win / s.n * 100).toFixed(1),
        avg: +(s.sum / s.n).toFixed(2),
        ex: +(s.sumEx / s.n).toFixed(2),
        med: +L.median(s.arr).toFixed(2)
      };
    });
    return out;
  }

  const out = {
    ready: true,
    updatedAt: new Date().toISOString().slice(0, 19),
    horizon: HORIZON,
    days: arch.length,
    scoredDays: ready.length,
    from: ready[0].date,
    to: ready[ready.length - 1].date,
    samples: samples,
    state: pack(buckets.state || {}),
    votes: pack(buckets.votes || {}),
    stage: pack(buckets.stage || {}),
    note: '实盘前瞻样本：每天归档引擎真实输出，' + HORIZON + ' 个交易日后用真实收盘对账。'
      + '不含近似回放，因此从启用日开始累计。'
  };
  L.writeJson(CALIB, out);
  console.log('三态校准：评分 %d 天 / %d 条，期末 %s', ready.length, samples, out.to);
  Object.keys(out.state).forEach(function (k) {
    const v = out.state[k];
    console.log('  %s  n=%d  20日胜率 %s%%  均值 %s%%  超额 %s pp', k, v.n, v.win, v.avg, v.ex);
  });
}

const cmd = process.argv[2] || 'archive';
if (cmd === 'archive') archive();
else if (cmd === 'score') score();
else if (cmd === 'all') { archive(); score(); }
else console.log('用法: archive|score|all');
