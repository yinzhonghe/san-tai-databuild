'use strict';
/*
 * 自进化 · 点评校准
 * ==================================================================
 * 每天三段（早报/午间/收盘）都会给一个 verdict（偏积极/偏中性/偏消极）和一个区间。
 * 这里把它们记下来，事后用上证指数真实走势对账：
 *   · 方向命中：偏积极要求当日收涨 ≥+0.2%，偏消极要求 ≤-0.2%，偏中性要求 |涨跌|<0.6%
 *   · 区间覆盖：oneLine 里的「3560–3600」这类数字对，当日最低/最高有没有落在里面
 *   · 幅度误差：一句话里给的点位中枢与实际收盘的差距
 *
 * 校准结果会生成 learn/commentary_rules.md，三个定时任务的 prompt 会读它，
 * 于是「写得准不准」会反过来改变下一期的措辞与区间宽度 —— 这是可验证的自进化，
 * 不是让模型自己夸自己。
 *
 * 用法：node tools/evolve_verdict.js archive|score|rules|all
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const L = require('./learn_lib.js');

const BRIEF = path.join(L.LEARN, 'brief_log.jsonl');
const SCORED = path.join(L.LEARN, 'brief_scored.jsonl');
const STATS = path.join(L.LEARN, 'verdict_stats.json');
const RULES = path.join(L.LEARN, 'commentary_rules.md');

function readDaily() {
  const p = path.join(L.ROOT, 'daily.js');
  const code = fs.readFileSync(p, 'utf8').replace(/^\ufeff/, '');
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { timeout: 30000 });
  return ctx.window.AB_DAILY;
}

/* ---------------- 归档：覆盖同日同档（当天重写会替换，不会脏数据） ---------------- */
function archive() {
  const D = readDaily();
  const date = D.date;
  if (!date) throw new Error('daily.js 缺少 date');
  const rows = L.readJsonl(BRIEF).filter(function (r) { return r.date !== date; });
  ['morning', 'noon', 'close'].forEach(function (slot) {
    const s = D[slot];
    if (!s || (!s.oneLine && !s.verdict)) return;
    rows.push({
      date: date, slot: slot, at: s.at || '', verdict: s.verdict || '',
      oneLine: s.oneLine || '', nBull: (s.bulls || []).length, nBear: (s.bears || []).length,
      nPoint: (s.points || []).length, nNews: (s.news || []).length,
      at2: new Date().toISOString().slice(0, 19)
    });
  });
  L.ensure();
  fs.writeFileSync(BRIEF, rows.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n');
  console.log('点评归档 ' + date + '：' + rows.filter(function (r) { return r.date === date; }).length + ' 档（累计 ' + rows.length + ' 条）');
}

/* ---------------- 解析一句话里的区间与点位 ---------------- */
function parseLevels(text) {
  if (!text) return { ranges: [], points: [] };
  const s = String(text).replace(/[，、；]/g, ' ');
  const ranges = [];
  // 3572–3582 / 3560-3600 / 3560—3600 / 3550~3600
  const re = /(\d{3,5}(?:\.\d+)?)\s*[–—\-~至]\s*(\d{3,5}(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(s))) {
    const a = +m[1], b = +m[2];
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (lo > 1200 && hi < 8000 && hi > lo) ranges.push([lo, hi]);
  }
  const nums = (s.match(/\d{4}(?:\.\d+)?/g) || []).map(Number).filter(function (v) { return v > 1200 && v < 8000; });
  return { ranges: ranges, points: nums };
}

/* ---------------- 对账 ---------------- */
function score() {
  const rows = L.readJsonl(BRIEF);
  if (!rows.length) { console.log('还没有点评记录'); return; }
  const idx = L.loadIndexHist();
  const bars = idx.bars;
  const pos = {};
  bars.forEach(function (b, i) { pos[b[0]] = i; });

  const out = [];
  let scored = 0, pending = 0;
  rows.forEach(function (r) {
    const i = pos[r.date];
    if (i == null) { pending++; out.push(r); return; }
    // 早报/午间评的是「当天」，收盘评的是「次日」
    let ti;
    if (r.slot === 'close') {
      if (i + 1 >= bars.length) { pending++; out.push(r); return; }
      ti = i + 1;
    } else {
      if (i === 0) { pending++; out.push(r); return; }
      ti = i;
    }
    const prev = bars[ti - 1][2], cur = bars[ti][2];
    const ret = (cur / prev - 1) * 100;
    const v = r.verdict || '';
    let hit = null;
    if (v.indexOf('积极') >= 0) hit = ret >= 0.2;
    else if (v.indexOf('消极') >= 0) hit = ret <= -0.2;
    else if (v.indexOf('中性') >= 0) hit = Math.abs(ret) < 0.6;

    const lv = parseLevels(r.oneLine);
    const wide = lv.ranges.length ? lv.ranges.reduce(function (a, b) {
      return (b[1] - b[0]) > (a[1] - a[0]) ? b : a;
    }) : null;
    const low = bars[ti][4] > 0 ? bars[ti][4] : cur;
    const high = bars[ti][3] > 0 ? bars[ti][3] : cur;
    const covered = wide ? (low >= wide[0] * 0.999 && high <= wide[1] * 1.001) : null;

    scored++;
    out.push(Object.assign({}, r, {
      scored: true, targetDate: bars[ti][0], ret: +ret.toFixed(2), hit: hit,
      range: wide, covered: covered,
      closeErr: wide ? +((cur - (wide[0] + wide[1]) / 2)).toFixed(2) : null
    }));
  });

  L.ensure();
  fs.writeFileSync(SCORED, out.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n');

  const done = out.filter(function (r) { return r.scored; });
  const byV = {}, bySlot = {};
  function acc(b, k, r) {
    const s = b[k] = b[k] || { n: 0, hit: 0, cov: 0, covN: 0 };
    s.n++; if (r.hit) s.hit++;
    if (r.covered != null) { s.covN++; if (r.covered) s.cov++; }
  }
  done.forEach(function (r) {
    acc(byV, r.verdict || '未标注', r);
    acc(bySlot, r.slot, r);
  });
  function pack(b) {
    const o = {};
    Object.keys(b).forEach(function (k) {
      const s = b[k];
      o[k] = {
        n: s.n,
        hit: +(s.hit / s.n * 100).toFixed(1),
        cover: s.covN ? +(s.cov / s.covN * 100).toFixed(1) : null
      };
    });
    return o;
  }
  const stats = {
    updatedAt: new Date().toISOString().slice(0, 19),
    total: rows.length, scored: done.length, pending: pending,
    from: done.length ? done[0].date : '',
    to: done.length ? done[done.length - 1].date : '',
    byVerdict: pack(byV), bySlot: pack(bySlot),
    recent: done.slice(-8).reverse().map(function (r) {
      return { date: r.date, slot: r.slot, verdict: r.verdict, ret: r.ret, hit: r.hit, covered: r.covered };
    })
  };
  L.writeJson(STATS, stats);
  console.log('点评对账：已评 ' + done.length + ' / 待评 ' + pending);
  Object.keys(stats.byVerdict).forEach(function (k) {
    const v = stats.byVerdict[k];
    console.log('  ' + k + '  n=' + v.n + '  方向命中 ' + v.hit + '%  区间覆盖 ' + (v.cover == null ? '-' : v.cover + '%'));
  });
}

/* ---------------- 生成写作规则（给定时任务读） ---------------- */
function rules() {
  const st = L.readJson(STATS, null);
  if (!st || !st.scored) {
    fs.writeFileSync(RULES, '# 点评校准规则\n\n样本不足（尚未对账），本期不生成倾向性规则。\n'
      + '写作仍按四段式，硬要求：精确数字、给区间、给失效条件。\n');
    console.log('样本不足，已写入空规则');
    return;
  }
  const lines = [];
  lines.push('# 点评校准规则（自动生成，勿手改）');
  lines.push('');
  lines.push('> 由 `tools/evolve_verdict.js` 根据 ' + st.scored + ' 次真实对账生成（'
    + st.from + ' ~ ' + st.to + '）。写作时必须遵守下面由数据得出的结论，而不是凭感觉。');
  lines.push('');
  lines.push('## 一、方向命中率（实测）');
  lines.push('');
  lines.push('| 判断 | 次数 | 方向命中率 | 区间覆盖率 |');
  lines.push('|---|---|---|---|');
  Object.keys(st.byVerdict).forEach(function (k) {
    const v = st.byVerdict[k];
    lines.push('| ' + k + ' | ' + v.n + ' | ' + v.hit + '% | ' + (v.cover == null ? '—' : v.cover + '%') + ' |');
  });
  lines.push('');
  lines.push('## 二、当期必须执行的调整');
  lines.push('');
  const v = st.byVerdict;
  Object.keys(v).forEach(function (k) {
    const x = v[k];
    if (x.n < 5) {
      lines.push('- 「' + k + '」只有 ' + x.n + ' 次样本，样本不足：仍可给出判断，但必须写明「样本少，仅作参考」。');
    } else if (x.hit < 45) {
      lines.push('- 「' + k + '」命中率仅 ' + x.hit + '%（' + x.n + ' 次）：本期不要把话说满，改成条件句'
        + '（「若 X 守住则 Y，否则 Z」），并给出反向情形。');
    } else if (x.hit > 65) {
      lines.push('- 「' + k + '」命中 ' + x.hit + '%（' + x.n + ' 次）：可以给明确方向，但仍须给出失效位。');
    } else {
      lines.push('- 「' + k + '」命中 ' + x.hit + '%（' + x.n + ' 次）：维持中性措辞，不放大确定性。');
    }
    if (x.cover != null && x.cover < 60) {
      lines.push('  - 区间覆盖只有 ' + x.cover + '%：说明给的区间太窄，本期把区间放宽（上下沿各外扩 0.3%~0.5%）。');
    } else if (x.cover != null && x.cover > 85) {
      lines.push('  - 区间覆盖 ' + x.cover + '%：区间偏宽，本期可收窄到更有信息量的范围。');
    }
  });
  lines.push('');
  lines.push('## 三、最近几次对账（自查用）');
  lines.push('');
  lines.push('| 日期 | 档 | 判断 | 当日/次日涨跌 | 命中 | 区间覆盖 |');
  lines.push('|---|---|---|---|---|---|');
  (st.recent || []).forEach(function (r) {
    lines.push('| ' + r.date + ' | ' + r.slot + ' | ' + r.verdict + ' | ' + (r.ret > 0 ? '+' : '') + r.ret + '% | '
      + (r.hit ? '✓' : '✗') + ' | ' + (r.covered == null ? '—' : (r.covered ? '✓' : '✗')) + ' |');
  });
  lines.push('');
  lines.push('## 四、不变的红线');
  lines.push('');
  lines.push('- 数字必须精确到小数位，禁止「大幅」「明显」「有所」这类模糊词。');
  lines.push('- 每个判断都要给失效条件（破了哪一位就不再成立）。');
  lines.push('- 不编造新闻与数据；查不到就写「未获取到」，不用估算顶替。');
  fs.writeFileSync(RULES, lines.join('\n') + '\n');
  console.log('已生成 ' + RULES + '（基于 ' + st.scored + ' 次对账）');
}

const cmd = process.argv[2] || 'all';
if (cmd === 'archive') archive();
else if (cmd === 'score') score();
else if (cmd === 'rules') rules();
else { archive(); score(); rules(); }
