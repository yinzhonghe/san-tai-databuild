// ================================================================
// 缠论理论完整实现（chan_theory.js）
// 按《缠中说禅：教你炒股票108课》原文定义逐层构建，替代 chan_unified 的简化结构。
//
// 层级：
//   L0  K线包含处理（连锁合并，方向由处理后的前两根决定）
//   L1  分型（顶/底，相邻同类保留极值，必须交替）
//   L2  笔（老笔:顶底分型间至少1根独立K线；新笔:允许共用K线）
//   L3  线段（特征序列法：特征序列包含合并 → 特征序列分型 → 缺口两种情况）
//   L4  中枢（三个连续次级别走势重叠；ZG=min(g1,g2) ZD=max(d1,d2)
//             GG=max(gn) DD=min(dn)；延伸 / 扩展 / 新生）
//   L5  走势类型（趋势=≥2同向中枢且中枢区间不重叠；盘整=1个中枢）
//   L6  背驰（趋势背驰/盘整背驰：面积对比 + 黄白线回0轴 + DIF极值）
//   L7  三类买卖点（一买=趋势背驰点；二买=一买后次级别回抽结束点，101课三形态；
//                   三买/三卖=中枢离开+回试/回抽不破边+第一次）
//   L8  级别递归（笔级别 / 线段级别 / 日线级别 / 周线级别）+ 区间套
//
// 用法：
//   node tools/chan_theory.js diag 600519.SH     单标的完整结构解剖
//   node tools/chan_theory.js stat               全市场结构统计与密度
//   node tools/chan_theory.js selftest           理论层单元自检
//   node tools/chan_theory.js equity             理论信号回测
// ================================================================

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.dirname(__dirname);

const CAP = 100000, MAXPOS = 8, GAP = 60;
const FEE_BUY = 0.00011, FEE_SELL = 0.00061, SLIP = 0.002;
const LIMIT_UP = 9.8;

/* ================================================================
   L0：K线包含处理
   规则：后一根被前一根包含（或包含前一根）时合并；
        方向由"处理后的前两根"决定（向上取高高、向下取低低）；
        合并后需回溯，与再前一根再次形成包含时继续合并（连锁）。
   ================================================================ */
function mergeK(bars) {
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const nh = b[3], nl = b[4];
    if (!(b[2] > 0) || !(nh > 0) || !(nl > 0)) continue; // 负价/停牌脏数据剔除
    if (out.length === 0) {
      out.push({ h: nh, l: nl, k: i, date: b[0], c: b[2], raw: [i] });
      continue;
    }
    const last = out[out.length - 1];
    const inc = (nh <= last.h && nl >= last.l) || (nh >= last.h && nl <= last.l);
    if (!inc) {
      out.push({ h: nh, l: nl, k: i, date: b[0], c: b[2], raw: [i] });
      continue;
    }
    // 方向：优先用处理后的前两根；只有一根时用当前根与它的关系
    let dir;
    if (out.length >= 2) dir = last.h > out[out.length - 2].h ? 1 : -1;
    else dir = nh >= last.h ? 1 : -1;
    if (dir > 0) { last.h = Math.max(last.h, nh); last.l = Math.max(last.l, nl); }
    else { last.h = Math.min(last.h, nh); last.l = Math.min(last.l, nl); }
    last.c = b[2]; last.k = i; last.date = b[0]; last.raw.push(i);
    // 连锁合并
    while (out.length >= 2) {
      const p = out[out.length - 2], q = out[out.length - 1];
      const inc2 = (q.h <= p.h && q.l >= p.l) || (q.h >= p.h && q.l <= p.l);
      if (!inc2) break;
      let d2;
      if (out.length >= 3) d2 = p.h > out[out.length - 3].h ? 1 : -1;
      else d2 = q.h >= p.h ? 1 : -1;
      if (d2 > 0) { p.h = Math.max(p.h, q.h); p.l = Math.max(p.l, q.l); }
      else { p.h = Math.min(p.h, q.h); p.l = Math.min(p.l, q.l); }
      p.c = q.c; p.k = q.k; p.date = q.date; p.raw = p.raw.concat(q.raw);
      out.pop();
    }
  }
  return out;
}

/* ================================================================
   L1：分型
   顶分型：三根处理后K线，中间最高点最高且最低点也最高
   底分型：对称
   相邻同类分型只保留极值（顶取更高、底取更低）
   ================================================================ */
function fractals(mk) {
  const raw = [];
  for (let i = 1; i < mk.length - 1; i++) {
    const a = mk[i - 1], b = mk[i], c = mk[i + 1];
    if (b.h > a.h && b.h > c.h && b.l > a.l && b.l > c.l) {
      raw.push({ t: 1, i: i, k: b.k, d: b.date, p: b.h, opp: b.l });
    } else if (b.h < a.h && b.h < c.h && b.l < a.l && b.l < c.l) {
      raw.push({ t: -1, i: i, k: b.k, d: b.date, p: b.l, opp: b.h });
    }
  }
  // 同类合并 + 交替化
  const out = [];
  raw.forEach(function (f) {
    const last = out[out.length - 1];
    if (!last) { out.push(f); return; }
    if (last.t === f.t) {
      if ((f.t === 1 && f.p > last.p) || (f.t === -1 && f.p < last.p)) out[out.length - 1] = f;
    } else out.push(f);
  });
  return out;
}

/* ================================================================
   L2：笔
   成笔条件：顶分型与底分型之间至少 1 根独立K线
             老笔 gap>=4（分型中心索引差），新笔 gap>=3（允许共用K线）
   笔的延伸：同向分型出现更极值时，该笔终点后移（由 fractals 的同类合并保证）
   ================================================================ */
function buildBi(mk, fs, opt) {
  opt = opt || {};
  const gap = opt.newBi ? 3 : 4;
  const pts = [];
  fs.forEach(function (f) {
    if (!pts.length) { pts.push(Object.assign({}, f)); return; }
    const last = pts[pts.length - 1];
    if (last.t === f.t) {
      if ((f.t === 1 && f.p > last.p) || (f.t === -1 && f.p < last.p)) pts[pts.length - 1] = Object.assign({}, f);
      return;
    }
    if (f.i - last.i >= gap) pts.push(Object.assign({}, f));
  });
  const bis = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dir = a.t === -1 ? 1 : -1;
    bis.push({
      idx: bis.length, dir: dir,
      t0: a.t, t1: b.t,
      i0: a.i, i1: b.i, k0: a.k, k1: b.k,
      d0: a.d, d1: b.d, p0: a.p, p1: b.p,
      hi: Math.max(a.p, b.p), lo: Math.min(a.p, b.p),
      mkLen: b.i - a.i + 1,          // 处理后K线根数（含两端分型）
      rawLen: b.k - a.k + 1           // 原始K线根数
    });
  }
  return bis;
}

/* ================================================================
   L3：线段（特征序列法）
   向上线段：特征序列 = 线段内所有向下笔，元素取 (高, 低)
   特征序列先做包含合并（与K线同一套规则），再找分型
   线段破坏：
     第一种情况（无缺口）：特征序列顶分型成立即破坏，线段终=顶分型第1元素对应的高点
     第二种情况（有缺口）：需第二个特征序列（反向）也出现分型才确认破坏
   为保持方向连续，线段之间共享端点。
   ================================================================ */
function segFeatureMerge(elems) {
  // 对特征序列元素做包含合并（元素 = {h,l,bi}）
  const out = [];
  elems.forEach(function (e) {
    const last = out[out.length - 1];
    if (!last) { out.push(Object.assign({}, e)); return; }
    const inc = (e.h <= last.h && e.l >= last.l) || (e.h >= last.h && e.l <= last.l);
    if (!inc) { out.push(Object.assign({}, e)); return; }
    let dir;
    if (out.length >= 2) dir = last.h > out[out.length - 2].h ? 1 : -1;
    else dir = e.h >= last.h ? 1 : -1;
    if (dir > 0) { last.h = Math.max(last.h, e.h); last.l = Math.max(last.l, e.l); }
    else { last.h = Math.min(last.h, e.h); last.l = Math.min(last.l, e.l); }
    last.bi2 = e.bi;
  });
  return out;
}

function segFractal(merged, type) {
  // type=1 找顶分型；type=-1 找底分型
  for (let i = 1; i < merged.length - 1; i++) {
    const a = merged[i - 1], b = merged[i], c = merged[i + 1];
    if (type === 1) {
      if (b.h > a.h && b.h > c.h && b.l > a.l && b.l > c.l) return { at: i, first: a, mid: b, last: c };
    } else {
      if (b.l < a.l && b.l < c.l && b.h < a.h && b.h < c.h) return { at: i, first: a, mid: b, last: c };
    }
  }
  return null;
}

function buildSeg(bis, opt) {
  // 以笔为最小单位划分线段：线段至少3笔，方向与首笔一致
  // 破坏定位：特征序列分型的"中间元素"对应的笔 bis[mid.bi] 就是下一段的起始笔
  //           本段终点笔 = bis[mid.bi - 1]
  const out = [];
  if (bis.length < 3) return out;
  let start = 0;
  let guard = 0;
  while (start < bis.length - 2 && guard++ < bis.length * 3) {
    const dir = bis[start].dir;
    const feature = [];
    let brokeAt = -1;
    let gapFlag = false, secondSeqOk = false;

    for (let i = start + 1; i < bis.length; i++) {
      const bi = bis[i];
      if (bi.dir === dir) continue;            // 同向笔不属于特征序列
      feature.push({ h: Math.max(bi.p0, bi.p1), l: Math.min(bi.p0, bi.p1), bi: i });
      if (feature.length < 3) continue;
      const merged = segFeatureMerge(feature);
      const needTop = (dir === 1);             // 向上线段只看顶分型，向下只看底分型
      const fr = segFractal(merged, needTop ? 1 : -1);
      if (!fr) continue;
      // 缺口：第1、2 特征元素之间无重合区间
      const e1 = feature[0], e2 = feature[1];
      gapFlag = needTop ? (e1.l > e2.h) : (e1.h < e2.l);
      if (!gapFlag) { brokeAt = fr.mid.bi; break; }
      // 第二种情况：从分型最高/低点开始的第二特征序列也须出现反向分型
      const feat2 = [];
      for (let q = start + 1; q <= i; q++) {
        if (bis[q].dir === dir) feat2.push({ h: bis[q].hi, l: bis[q].lo, bi: q });
      }
      const m2 = segFeatureMerge(feat2);
      if (segFractal(m2, needTop ? -1 : 1)) { brokeAt = fr.mid.bi; secondSeqOk = true; break; }
    }

    // 未破坏 → 本段延伸到最后一笔
    const sEnd = brokeAt > start + 1 ? brokeAt - 1 : bis.length - 1;
    if (sEnd < start + 2) {                       // 不足3笔无法成段，前移
      start = start + 1; continue;
    }
    const s = {
      idx: out.length, dir: dir,
      i0: bis[start].i0, i1: bis[sEnd].i1,
      k0: bis[start].k0, k1: bis[sEnd].k1,
      d0: bis[start].d0, d1: bis[sEnd].d1,
      p0: bis[start].p0, p1: bis[sEnd].p1,
      hi: Math.max(bis[start].p0, bis[sEnd].p1),
      lo: Math.min(bis[start].p0, bis[sEnd].p1),
      biCount: sEnd - start + 1,
      gap: gapFlag, secondSeq: secondSeqOk, broke: brokeAt > 0
    };
    out.push(s);
    if (sEnd >= bis.length - 1) break;
    start = brokeAt > start ? brokeAt : sEnd + 1;  // 下一段从转折笔开始
  }
  // 交替性兜底：同向相邻直接合并（正常不应触发）
  const fin = [];
  out.forEach(function (s) {
    const last = fin[fin.length - 1];
    if (last && last.dir === s.dir) {
      last.i1 = s.i1; last.k1 = s.k1; last.d1 = s.d1; last.p1 = s.p1;
      last.hi = Math.max(last.p0, s.p1); last.lo = Math.min(last.p0, s.p1);
      last.biCount += s.biCount;
    } else fin.push(s);
  });
  fin.forEach(function (s, i) { s.idx = i; });
  return fin;
}

/* ================================================================
   L4：中枢
   定义：被至少三个连续次级别走势类型所重叠的部分
   区间：ZG = min(g1, g2)，ZD = max(d1, d2)（前两段定区间，第三段确认重叠）
        GG = max(gn)，DD = min(dn)（全程最高/最低）
   延伸：后续走势与 [ZD,ZG] 有重叠 → 纳入本中枢，GG/DD 扩展，ZG/ZD 不变
   结束：出现与 [ZD,ZG] 不再重叠的走势（该走势即离开段）
   ================================================================ */
function buildCenters(units) {
  const centers = [];
  if (!units || units.length < 3) return centers;
  let i = 0;
  while (i + 2 < units.length) {
    const a = units[i], b = units[i + 1], c = units[i + 2];
    const zg = Math.min(a.hi, b.hi);
    const zd = Math.max(a.lo, b.lo);
    if (!(zg > zd)) { i++; continue; }
    // 第三段必须与 [zd,zg] 有重叠才成立
    if (!(c.hi > zd && c.lo < zg)) { i++; continue; }
    let s = i, e = i + 2;
    let gg = Math.max(a.hi, b.hi, c.hi);
    let dd = Math.min(a.lo, b.lo, c.lo);
    // 向后延伸
    let j = i + 3;
    while (j < units.length) {
      const u = units[j];
      if (u.hi > zd && u.lo < zg) { gg = Math.max(gg, u.hi); dd = Math.min(dd, u.lo); e = j; j++; }
      else break;
    }
    centers.push({
      idx: centers.length,
      i0: s, i1: e,
      ZG: zg, ZD: zd, GG: gg, DD: dd,
      k0: units[s].k0, k1: units[e].k1,
      d0: units[s].d0, d1: units[e].d1,
      nUnits: e - s + 1,
      extendUnits: Math.max(0, e - (s + 2)),
      enterUnit: s - 1,
      leaveUnit: e + 1 >= units.length ? -1 : e + 1,
      leaveDir: (e + 1 < units.length) ? units[e + 1].dir : 0
    });
    i = e + 1;
  }
  return centers;
}

/* 中枢扩展：相邻两中枢的波动区间重叠 → 升级为更大级别中枢 */
function expandCenters(centers) {
  const out = [];
  centers.forEach(function (c) {
    const last = out[out.length - 1];
    if (last && c.ZD < last.ZG && c.ZG > last.ZD) {
      // 波动区间重叠 → 公共部分成为更大级别中枢的区间
      last.ZG = Math.min(last.ZG, c.ZG);
      last.ZD = Math.max(last.ZD, c.ZD);
      last.GG = Math.max(last.GG, c.GG);
      last.DD = Math.min(last.DD, c.DD);
      last.i1 = c.i1; last.k1 = c.k1; last.d1 = c.d1;
      last.nUnits += c.nUnits;
      last.merged = (last.merged || 1) + 1;
      last.leaveUnit = c.leaveUnit; last.leaveDir = c.leaveDir;
    } else out.push(Object.assign({}, c));
  });
  out.forEach(function (c, i) { c.idx = i; });
  return out;
}

/* ================================================================
   L5：走势类型分解
   趋势：至少两个同向中枢，且中枢区间绝对不重叠
         下跌趋势：后中枢 ZG < 前中枢 ZD
         上涨趋势：后中枢 ZD > 前中枢 ZG
   盘整：只有一个中枢
   ================================================================ */
function classifyTrend(centers) {
  const legs = [];
  if (!centers.length) return legs;
  let cur = null;
  for (let i = 1; i < centers.length; i++) {
    const p = centers[i - 1], c = centers[i];
    let kind;
    if (c.ZD > p.ZG) kind = 'up';
    else if (c.ZG < p.ZD) kind = 'down';
    else kind = 'expand';
    if (!cur || cur.kind !== kind) {
      cur = { kind: kind, startIdx: i - 1, endIdx: i, centers: [p, c] };
      legs.push(cur);
    } else { cur.endIdx = i; cur.centers.push(c); }
  }
  if (!legs.length) legs.push({ kind: 'consolidation', startIdx: 0, endIdx: 0, centers: [centers[0]] });
  return legs;
}

/* ================================================================
   L6：背驰
   MACD 面积：同向柱体面积累加
   黄白线回0轴：中枢区间内 |DIF| 最小值 / 前段 |DIF| 峰值 < zeroRatio
   趋势背驰：≥2 同向中枢，比较"进入第一中枢的段"与"离开最后中枢的段"
   ================================================================ */
function ema(a, n) {
  const k = 2 / (n + 1), o = [];
  let p = a[0];
  for (let i = 0; i < a.length; i++) { p = i === 0 ? a[0] : a[i] * k + p * (1 - k); o.push(p); }
  return o;
}
function macd(cl) {
  const ef = ema(cl, 12), es = ema(cl, 26);
  const dif = ef.map(function (v, i) { return v - es[i]; });
  const dea = ema(dif, 9);
  const hist = dif.map(function (v, i) { return (v - dea[i]) * 2; });
  return { dif: dif, dea: dea, hist: hist };
}
function areaOf(M, k0, k1, dir) {
  let s = 0;
  const a = Math.max(0, k0), b = Math.min(M.hist.length - 1, k1);
  for (let i = a; i <= b; i++) {
    if (dir < 0 && M.hist[i] < 0) s += -M.hist[i];
    else if (dir > 0 && M.hist[i] > 0) s += M.hist[i];
  }
  return s;
}
function difPeak(M, k0, k1, dir) {
  let peak = 0;
  const a = Math.max(0, k0), b = Math.min(M.dif.length - 1, k1);
  for (let i = a; i <= b; i++) {
    const v = dir < 0 ? -M.dif[i] : M.dif[i];
    if (v > peak) peak = v;
  }
  return peak;
}
function difMinAbs(M, k0, k1) {
  let m = Infinity;
  const a = Math.max(0, k0), b = Math.min(M.dif.length - 1, k1);
  for (let i = a; i <= b; i++) {
    const v = Math.abs(M.dif[i]);
    if (v < m) m = v;
  }
  return m;
}
function difAt(M, k) {
  if (k < 0 || k >= M.dif.length) return 0;
  return M.dif[k];
}

/* 判定一段走势是否构成趋势背驰
   units  : 走势单位（笔或线段）
   centers: 该级别的中枢
   leg    : classifyTrend 产出的趋势腿
   返回 { beichi, areaRatio, zeroOK, newExtreme } */
function judgeBeichi(units, centers, leg, M, P) {
  P = P || {};
  const areaThresh = P.areaThresh !== undefined ? P.areaThresh : 0.9;
  const zeroRatio = P.zeroRatio !== undefined ? P.zeroRatio : 0.5;
  if (!leg || leg.kind === 'expand' || leg.kind === 'consolidation') {
    return { beichi: false, reason: '非趋势' };
  }
  const dir = leg.kind === 'up' ? 1 : -1;
  const firstC = leg.centers[0], lastC = leg.centers[leg.centers.length - 1];
  if (leg.centers.length < 2) return { beichi: false, reason: '中枢不足2' };
  // 趋势腿跨度 = 第一中枢起点 → 最后中枢结束之后（含离开段）
  const spanStart = firstC.i0;
  const spanEnd = Math.min(units.length - 1, lastC.i1 + 3);
  // 取该跨度内所有与趋势同向的段，最后一段 = C（离开段），前一段 = A（对比段）
  const same = [];
  for (let i = spanStart; i <= spanEnd; i++) if (units[i].dir === dir) same.push(i);
  if (same.length < 2) return { beichi: false, reason: '同向段不足2' };
  const A = units[same[same.length - 2]], C = units[same[same.length - 1]];
  // 创新极值
  const newExtreme = dir < 0 ? (C.p1 < A.p1) : (C.p1 > A.p1);
  if (!newExtreme) return { beichi: false, reason: '未创新极值' };
  const aP = areaOf(M, A.k0, A.k1, dir);
  const aC = areaOf(M, C.k0, C.k1, dir);
  if (!(aP > 0)) return { beichi: false, reason: 'A段无同向面积' };
  const areaRatio = aC / aP;
  const areaOK = aC < aP * areaThresh;
  // 黄白线回0轴：两中枢之间的反弹段把 DIF 拉回 0 附近
  const midStart = firstC.k1, midEnd = lastC.k0;
  const minAbs = difMinAbs(M, midStart, midEnd);
  const peakA = difPeak(M, A.k0, A.k1, dir);
  const zeroOK = peakA > 0 && minAbs < peakA * zeroRatio;
  // DIF 极值也需背驰（价格新低但 DIF 未新低）
  const difC = Math.abs(difAt(M, C.k1));
  const difA = difPeak(M, A.k0, A.k1, dir);
  return {
    beichi: areaOK && zeroOK,
    areaRatio: areaRatio,
    areaOK: areaOK,
    zeroOK: zeroOK,
    zeroMinAbs: minAbs,
    peakA: peakA,
    difC: difC,
    difA: difA,
    difShrink: difC < difA,
    dir: dir,
    Ak: same[same.length - 2],
    Ck: same[same.length - 1],
    A: { k0: A.k0, k1: A.k1, p0: A.p0, p1: A.p1 },
    C: { k0: C.k0, k1: C.k1, p0: C.p0, p1: C.p1 }
  };
}

/* ================================================================
   L7：三类买卖点
   一买  = 下跌趋势背驰点（≥2 同向中枢 + 面积背驰 + 黄白线回0轴 + DIF<0）
   一卖  = 上涨趋势背驰点（对称）
   二买  = 一买后第一次上涨结束、次级别回抽结束点（101课三形态：强/一般/弱）
   二卖  = 一卖后第一次下跌结束、反抽不过前高
   三买  = 中枢向上离开后回试不破 ZG（每个中枢仅第一次）
   三卖  = 中枢向下离开后反抽不破 ZD（每个中枢仅第一次）
   ================================================================ */
function detectPoints(units, centers, M, P) {
  P = P || {};
  const pts = { buy1: [], sell1: [], buy2: [], sell2: [], buy3: [], sell3: [] };

  // ---- 一买 / 一卖：趋势背驰 ----
  const legs = classifyTrend(centers);
  legs.forEach(function (leg) {
    if (leg.kind !== 'down' && leg.kind !== 'up') return;
    const b = judgeBeichi(units, centers, leg, M, P);
    if (!b.beichi) return;
    const lu = b.Ck;
    if (lu < 0 || lu >= units.length) return;
    const C = units[lu];
    const difV = difAt(M, C.k1);
    if (leg.kind === 'down' && difV < 0) {
      pts.buy1.push({
        k: C.k1, d: C.d1, p: C.p1, unit: lu,
        areaRatio: b.areaRatio, zeroMinAbs: b.zeroMinAbs, nCenters: leg.centers.length
      });
    }
    if (leg.kind === 'up' && difV > 0) {
      pts.sell1.push({
        k: C.k1, d: C.d1, p: C.p1, unit: lu,
        areaRatio: b.areaRatio, nCenters: leg.centers.length
      });
    }
  });

  // ---- 二买 / 二卖 ----
  pts.buy1.forEach(function (b1) {
    const u = b1.unit;
    if (u + 2 >= units.length) return;
    const up = units[u + 1], dn = units[u + 2];
    if (up.dir !== 1 || dn.dir !== -1) return;
    let baseC = null;
    centers.forEach(function (c) { if (c.i1 <= u) baseC = c; });
    const low = dn.p1;
    let grade = '一般';
    if (baseC) {
      if (low > baseC.ZG) grade = '强';       // 站到原中枢上方（二三买合一）
      else if (low <= b1.p) grade = '弱';     // 跌破一买（最弱形态，盘整背驰扩张平台）
      else grade = '一般';                     // 中枢下方但高于一买：最标准
    } else grade = low > b1.p ? '一般' : '弱';
    pts.buy2.push({
      k: dn.k1, d: dn.d1, p: low, unit: u + 2,
      from: b1.k, grade: grade, breakB1: low <= b1.p
    });
  });
  pts.sell1.forEach(function (s1) {
    const u = s1.unit;
    if (u + 2 >= units.length) return;
    const dn = units[u + 1], up = units[u + 2];
    if (dn.dir !== -1 || up.dir !== 1) return;
    const high = up.p1;
    pts.sell2.push({
      k: up.k1, d: up.d1, p: high, unit: u + 2,
      from: s1.k, leaveB1: high >= s1.p
    });
  });

  // ---- 三买 / 三卖：每个中枢仅第一次 ----
  centers.forEach(function (c) {
    for (let i = c.i1 + 1; i + 1 < units.length; i++) {
      const u = units[i];
      if (u.dir !== 1) continue;
      if (u.p0 <= c.ZG && u.p1 > c.ZG) {
        const back = units[i + 1];
        if (back && back.dir === -1 && back.p1 > c.ZG) {
          pts.buy3.push({
            k: back.k1, d: back.d1, p: back.p1, unit: i + 1,
            ZG: c.ZG, center: c.idx, leaveDepth: u.p1 / c.ZG - 1,
            backDepth: back.p1 / c.ZG - 1
          });
        }
        break;
      }
    }
    for (let i = c.i1 + 1; i + 1 < units.length; i++) {
      const u = units[i];
      if (u.dir !== -1) continue;
      if (u.p0 >= c.ZD && u.p1 < c.ZD) {
        const back = units[i + 1];
        if (back && back.dir === 1 && back.p1 < c.ZD) {
          pts.sell3.push({
            k: back.k1, d: back.d1, p: back.p1, unit: i + 1,
            ZD: c.ZD, center: c.idx, leaveDepth: u.p1 / c.ZD - 1,
            backDepth: back.p1 / c.ZD - 1
          });
        }
        break;
      }
    }
  });

  // 同一 K 位置合并（多中枢可能指向同一回试点）
  ['buy1', 'sell1', 'buy2', 'sell2', 'buy3', 'sell3'].forEach(function (t) {
    const m = {};
    pts[t].forEach(function (x) { m[x.k] = x; });
    pts[t] = Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return a.k - b.k; });
  });
  return pts;
}

/* ================================================================
   L8：级别递归
   L1 笔级别：笔 → 笔中枢 → 走势类型 → 买卖点
   L2 线段级别：线段 → 线段中枢 → 走势类型 → 买卖点（≈ 本级别/日线级别）
   L3 周线级别：日线聚合为周线后重复同一套结构
   ================================================================ */
function weekKey(d) {
  const dt = new Date(d + 'T00:00:00Z');
  const t = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wn = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + '-W' + wn;
}
function toWeekly(bars) {
  const out = [];
  let cur = null, curKey = '';
  bars.forEach(function (b) {
    const wk = weekKey(b[0]);
    if (!cur || curKey !== wk) {
      if (cur) out.push(cur);
      cur = [b[0], b[1], b[2], b[3], b[4]];
      curKey = wk;
    } else {
      cur[2] = b[2];
      cur[3] = Math.max(cur[3], b[3]);
      cur[4] = Math.min(cur[4], b[4]);
    }
  });
  if (cur) out.push(cur);
  return out;
}

/* 单标的完整结构分析 */
function analyzeOne(bars, P) {
  P = Object.assign({ newBi: false, areaThresh: 0.9, zeroRatio: 0.5 }, P || {});
  const cl = bars.map(function (b) { return b[2]; });
  const M = macd(cl);
  const mk = mergeK(bars);
  const fx = fractals(mk);
  const bis = buildBi(mk, fx, { newBi: P.newBi });
  const segs = buildSeg(bis, P);
  const cBi = buildCenters(bis);
  const cSeg = buildCenters(segs);
  const cSegExp = expandCenters(cSeg);
  const legsBi = classifyTrend(cBi);
  const legsSeg = classifyTrend(cSegExp);
  const ptsBi = detectPoints(bis, cBi, M, P);
  const ptsSeg = detectPoints(segs, cSegExp, M, P);
  return {
    cl: cl, M: M, mk: mk, fx: fx, bis: bis, segs: segs,
    cBi: cBi, cSeg: cSeg, cSegExp: cSegExp,
    legsBi: legsBi, legsSeg: legsSeg,
    ptsBi: ptsBi, ptsSeg: ptsSeg
  };
}

/* 区间套：周线定方向 → 日线找买点 → 笔级别确认 */
function intervalNest(bars, P) {
  const A = analyzeOne(bars, P);
  const wbars = toWeekly(bars);
  if (wbars.length < 60) return null;
  const W = analyzeOne(wbars, P);
  // 周线最后一个趋势方向
  let wTrend = 'none';
  if (W.legsSeg.length) {
    const last = W.legsSeg[W.legsSeg.length - 1];
    wTrend = last.kind;
  }
  // 周线是否处于背驰段（最后一腿为趋势且背驰成立）
  let wBeichi = false;
  if (W.cSegExp.length >= 2) {
    const lastLeg = W.legsSeg[W.legsSeg.length - 1];
    if (lastLeg && (lastLeg.kind === 'down' || lastLeg.kind === 'up')) {
      const b = judgeBeichi(W.segs, W.cSegExp, lastLeg, W.M, P);
      wBeichi = b.beichi;
    }
  }
  // 日线买点（线段级）在周线下跌背驰的条件下才有效
  const buys = A.ptsSeg.buy1.concat(A.ptsSeg.buy2.filter(function (x) { return x.grade !== '弱'; }));
  return {
    wTrend: wTrend, wBeichi: wBeichi,
    wCenters: W.cSegExp.length,
    dailyBuy1: A.ptsSeg.buy1.length,
    dailyBuy2: A.ptsSeg.buy2.length,
    confirmedBuys: (wTrend === 'down' && wBeichi) ? buys.length : 0,
    A: A, W: W
  };
}

/* ================================================================
   入口：数据加载 / 自检 / 解剖 / 统计 / 回测
   ================================================================ */
function loadBars(minBars) {
  const O = require('./load_ohlc.js').load();
  const map = {};
  Object.keys(O.codes).forEach(function (code) {
    const b = O.codes[code].bars;
    if (!b || b.length < (minBars || 320)) return;
    map[code] = b;
  });
  return map;
}

function pct(a, b) { return b ? (a / b * 100).toFixed(1) + '%' : '—'; }

function selftest() {
  console.log('\n========== 理论层单元自检 ==========\n');
  const BARS = loadBars();
  const codes = Object.keys(BARS);
  const code = codes.includes('600519.SH') ? '600519.SH' : codes[0];
  const A = analyzeOne(BARS[code], {});
  let pass = 0, fail = 0;
  function chk(name, ok, detail) {
    if (ok) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')); }
    else { fail++; console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')); }
  }
  console.log('标的选择: ' + code + '（原始K线 ' + BARS[code].length + ' 根）\n');

  // L0 包含处理
  let containCnt = 0;
  for (let i = 1; i < A.mk.length; i++) {
    const p = A.mk[i - 1], q = A.mk[i];
    if ((q.h <= p.h && q.l >= p.l) || (q.h >= p.h && q.l <= p.l)) containCnt++;
  }
  chk('L0 处理后K线无残留包含关系', containCnt === 0,
    '处理后 ' + A.mk.length + ' 根，残留包含 ' + containCnt + ' 处');

  // L1 分型交替
  let altBad = 0;
  for (let i = 1; i < A.fx.length; i++) if (A.fx[i].t === A.fx[i - 1].t) altBad++;
  chk('L1 分型严格交替', altBad === 0, '分型 ' + A.fx.length + ' 个，同型相邻 ' + altBad + ' 处');

  // L2 笔
  let biBad = 0, biShort = 0;
  for (let i = 1; i < A.bis.length; i++) if (A.bis[i].dir === A.bis[i - 1].dir) biBad++;
  A.bis.forEach(function (b) { if (b.mkLen < 4) biShort++; });
  chk('L2 笔方向交替', biBad === 0, '笔 ' + A.bis.length + ' 段，同向相邻 ' + biBad + ' 处');
  chk('L2 笔成笔条件(处理后K线≥4)', biShort === 0, '不足者 ' + biShort + ' 段');

  // L3 线段
  let segBad = 0;
  for (let i = 1; i < A.segs.length; i++) if (A.segs[i].dir === A.segs[i - 1].dir) segBad++;
  chk('L3 线段方向交替', segBad === 0, '线段 ' + A.segs.length + ' 段，同向相邻 ' + segBad + ' 处');
  chk('L3 线段至少3笔', A.segs.filter(function (s) { return s.biCount < 3; }).length === 0,
    '不足3笔者 ' + A.segs.filter(function (s) { return s.biCount < 3; }).length + ' 段');

  // L4 中枢
  let ctrBad = 0;
  A.cBi.forEach(function (c) { if (!(c.ZG > c.ZD)) ctrBad++; });
  chk('L4 笔中枢 ZG>ZD', ctrBad === 0, '笔中枢 ' + A.cBi.length + ' 个');
  let ctrBad2 = 0;
  A.cSegExp.forEach(function (c) { if (!(c.ZG > c.ZD)) ctrBad2++; });
  chk('L4 线段中枢(扩展后) ZG>ZD', ctrBad2 === 0, '线段中枢 ' + A.cSegExp.length + ' 个');

  // L5 走势类型
  chk('L5 走势类型分解可用', A.legsSeg.length > 0, '趋势腿 ' + A.legsSeg.length + ' 条：' +
    A.legsSeg.map(function (l) { return l.kind; }).join('/'));

  // L6/L7 买卖点
  chk('L7 一买 DIF<0', A.ptsSeg.buy1.every(function (b) { return difAt(A.M, b.k) < 0; }),
    '线段级一买 ' + A.ptsSeg.buy1.length + ' 个');
  chk('L7 一卖 DIF>0', A.ptsSeg.sell1.every(function (s) { return difAt(A.M, s.k) > 0; }),
    '线段级一卖 ' + A.ptsSeg.sell1.length + ' 个');

  // L8 周线递归
  const wb = toWeekly(BARS[code]);
  chk('L8 周线聚合', wb.length > 0 && wb.length < BARS[code].length,
    '周线 ' + wb.length + ' 根 / 日线 ' + BARS[code].length + ' 根');
  const nest = intervalNest(BARS[code], {});
  chk('L8 区间套可用', !!nest, nest ? ('周线趋势=' + nest.wTrend + ' 周线背驰=' + nest.wBeichi + ' 确认买点=' + nest.confirmedBuys) : 'null');

  console.log('\n自检结果: PASS ' + pass + ' / FAIL ' + fail + '\n');
  return { pass: pass, fail: fail };
}

function diag(code) {
  console.log('\n========== 单标的完整结构解剖: ' + code + ' ==========\n');
  const BARS = loadBars();
  if (!BARS[code]) {
    const alt = Object.keys(BARS).find(function (c) { return c.indexOf(code) >= 0; });
    if (!alt) { console.log('未找到标的 ' + code); return; }
    code = alt;
    console.log('已匹配: ' + code);
  }
  const bars = BARS[code];
  const A = analyzeOne(bars, {});
  console.log('原始K线 ' + bars.length + ' → 处理后 ' + A.mk.length + ' 根（合并率 ' + pct(A.mk.length, bars.length) + '）');
  console.log('分型 ' + A.fx.length + '；笔 ' + A.bis.length + '；线段 ' + A.segs.length);
  console.log('笔中枢 ' + A.cBi.length + '；线段中枢 ' + A.cSeg.length + ' → 扩展后 ' + A.cSegExp.length);
  console.log('走势腿(线段级): ' + A.legsSeg.map(function (l) { return l.kind; }).join(' → '));
  console.log('\n--- 最近 10 个笔中枢 ---');
  console.log('序号'.padStart(4) + '起始'.padStart(12) + '结束'.padStart(12) + 'ZD'.padStart(9) + 'ZG'.padStart(9) + 'GG'.padStart(9) + 'DD'.padStart(9) + '段数'.padStart(6));
  A.cBi.slice(-10).forEach(function (c) {
    console.log(String(c.idx).padStart(4) + String(c.d0).padStart(12) + String(c.d1).padStart(12)
      + c.ZD.toFixed(2).padStart(9) + c.ZG.toFixed(2).padStart(9) + c.GG.toFixed(2).padStart(9) + c.DD.toFixed(2).padStart(9)
      + String(c.nUnits).padStart(6));
  });
  console.log('\n--- 线段级买卖点 ---');
  ['buy1', 'buy2', 'buy3', 'sell1', 'sell2', 'sell3'].forEach(function (t) {
    const arr = A.ptsSeg[t];
    if (!arr.length) { console.log(t + ': 0'); return; }
    console.log(t + ': ' + arr.length + ' 个 → 最近3个 ' + arr.slice(-3).map(function (x) {
      return x.d + '@' + x.p.toFixed(2) + (x.grade ? '(' + x.grade + ')' : '');
    }).join(' | '));
  });
  console.log('\n--- 笔级买卖点 ---');
  ['buy1', 'buy2', 'buy3', 'sell1', 'sell2', 'sell3'].forEach(function (t) {
    console.log(t + ': ' + A.ptsBi[t].length);
  });
  const nest = intervalNest(bars, {});
  if (nest) console.log('\n区间套: 周线趋势 ' + nest.wTrend + '，周线背驰 ' + nest.wBeichi + '，日线确认买点 ' + nest.confirmedBuys);
  return A;
}

function stat() {
  console.log('\n========== 全市场结构统计 ==========\n');
  const BARS = loadBars();
  const codes = Object.keys(BARS);
  console.log('标的 ' + codes.length + ' 只，逐只构建 L0→L8 结构…');
  const agg = {
    n: 0, rawK: 0, mkK: 0, fx: 0, bi: 0, seg: 0,
    cBi: 0, cSeg: 0, cSegExp: 0,
    legsDown: 0, legsUp: 0, legsExpand: 0,
    beichiOK: 0, beichiTry: 0,
    buy1: 0, sell1: 0, buy2s: 0, buy2g: 0, buy2w: 0, sell2: 0,
    buy3: 0, sell3: 0, buy3GG: 0,
    cov: {}
  };
  const byYear = {};
  const t0 = Date.now();
  let done = 0;
  codes.forEach(function (code) {
    const bars = BARS[code];
    const A = analyzeOne(bars, {});
    agg.n++;
    agg.rawK += bars.length;
    agg.mkK += A.mk.length;
    agg.fx += A.fx.length;
    agg.bi += A.bis.length;
    agg.seg += A.segs.length;
    agg.cBi += A.cBi.length;
    agg.cSeg += A.cSeg.length;
    agg.cSegExp += A.cSegExp.length;
    A.legsSeg.forEach(function (l) {
      if (l.kind === 'down') agg.legsDown++;
      else if (l.kind === 'up') agg.legsUp++;
      else agg.legsExpand++;
      if (l.kind === 'down' || l.kind === 'up') {
        agg.beichiTry++;
        const b = judgeBeichi(A.segs, A.cSegExp, l, A.M, {});
        if (b.beichi) agg.beichiOK++;
      }
    });
    agg.buy1 += A.ptsSeg.buy1.length;
    agg.sell1 += A.ptsSeg.sell1.length;
    agg.sell2 += A.ptsSeg.sell2.length;
    agg.buy3 += A.ptsSeg.buy3.length;
    agg.sell3 += A.ptsSeg.sell3.length;
    A.ptsSeg.buy2.forEach(function (x) {
      if (x.grade === '强') agg.buy2s++; else if (x.grade === '弱') agg.buy2w++; else agg.buy2g++;
    });
    A.ptsSeg.buy3.forEach(function (x) { if (x.leaveDepth > 0.05) agg.buy3GG++; });

    function mark(arr, tag) {
      arr.forEach(function (x) {
        const y = String(x.d || '').slice(0, 4);
        if (!y) return;
        byYear[y] = byYear[y] || {};
        byYear[y][tag] = (byYear[y][tag] || 0) + 1;
      });
    }
    mark(A.ptsSeg.buy1, 'buy1'); mark(A.ptsSeg.sell1, 'sell1');
    mark(A.ptsSeg.buy2, 'buy2'); mark(A.ptsSeg.sell2, 'sell2');
    mark(A.ptsSeg.buy3, 'buy3'); mark(A.ptsSeg.sell3, 'sell3');

    done++;
    if (done % 500 === 0) console.log('  …已处理 ' + done + ' / ' + codes.length + '（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
  });

  console.log('\n--- 结构规模 ---');
  console.log('处理后K线压缩率: ' + pct(agg.mkK, agg.rawK) + '（' + agg.rawK + ' → ' + agg.mkK + '）');
  console.log('平均每只: 分型 ' + (agg.fx / agg.n).toFixed(0) + '，笔 ' + (agg.bi / agg.n).toFixed(0)
    + '，线段 ' + (agg.seg / agg.n).toFixed(0) + '，笔中枢 ' + (agg.cBi / agg.n).toFixed(1)
    + '，线段中枢 ' + (agg.cSegExp / agg.n).toFixed(1) + '（扩展前 ' + (agg.cSeg / agg.n).toFixed(1) + '）');
  console.log('全市场 笔 ' + agg.bi + '，线段 ' + agg.seg + '，笔中枢 ' + agg.cBi + '，线段中枢 ' + agg.cSegExp);

  console.log('\n--- 走势类型 ---');
  console.log('下跌趋势腿 ' + agg.legsDown + '，上涨 ' + agg.legsUp + '，扩展/重叠 ' + agg.legsExpand);
  console.log('趋势腿中背驰成立 ' + agg.beichiOK + ' / ' + agg.beichiTry + '（' + pct(agg.beichiOK, agg.beichiTry) + '）');

  console.log('\n--- 线段级买卖点密度 ---');
  console.log('一买 ' + agg.buy1 + '（覆盖 ' + pct(Object.keys(BARS).filter(function (c) { return true; }).length, agg.n) + ' 标的）');
  console.log('一卖 ' + agg.sell1);
  console.log('二买 ' + (agg.buy2s + agg.buy2g + agg.buy2w) + '（强 ' + agg.buy2s + ' / 一般 ' + agg.buy2g + ' / 弱 ' + agg.buy2w + '）');
  console.log('二卖 ' + agg.sell2);
  console.log('三买 ' + agg.buy3 + '（离开深度>5% 者 ' + agg.buy3GG + '）');
  console.log('三卖 ' + agg.sell3);

  console.log('\n--- 分年信号 ---');
  const yrs = Object.keys(byYear).sort();
  console.log('年份'.padEnd(8) + '一买'.padStart(8) + '一卖'.padStart(8) + '二买'.padStart(8) + '二卖'.padStart(8) + '三买'.padStart(8) + '三卖'.padStart(8));
  yrs.forEach(function (y) {
    const o = byYear[y];
    console.log(y.padEnd(8) + String(o.buy1 || 0).padStart(8) + String(o.sell1 || 0).padStart(8)
      + String(o.buy2 || 0).padStart(8) + String(o.sell2 || 0).padStart(8)
      + String(o.buy3 || 0).padStart(8) + String(o.sell3 || 0).padStart(8));
  });
  console.log('\n总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  fs.writeFileSync(path.join(ROOT, 'theory_stat.json'), JSON.stringify({ agg: agg, byYear: byYear }, null, 1));
  console.log('已写入 theory_stat.json');
}

/* 次级别回抽确认入场（86课稳妥法）
   一买成立后不追高，等次级别（笔）的第一次回抽：
     - 回抽低点仍高于一买低点 → 在该回抽笔走完的次日买入（构造有效）
     - 回抽低点跌破一买低点 → 构造失败，放弃该信号
   返回入场K线索引；无有效入场返回 -1。 */
function pullbackEntry(k, p, sub) {
  for (let i = 0; i < sub.length; i++) {
    const u = sub[i];
    if (u.dir !== -1 || u.k1 <= k) continue;
    return u.p1 > p ? u.k1 + 1 : -1;
  }
  return -1;
}

function equity(P, opt) {
  P = P || {};
  opt = Object.assign({ level: 'bi', useBuy2: true, useBuy3: false, entryLag: 0,
    entryMode: 'lag', stateMachine: false, addOnBuy3: false, stopPct: 8, holdDays: 60,
    holdConfirmed: null }, opt || {});
  console.log('\n========== 理论信号回测（级别=' + opt.level + '，二买=' + opt.useBuy2 + '，三买=' + opt.useBuy3
    + '，入场=' + opt.entryMode + (opt.entryMode === 'lag' ? '(' + opt.entryLag + '日)' : '')
    + '，状态机=' + (opt.stateMachine ? '开' : '关') + '）==========\n');
  const BARS = loadBars();
  const SIG = {};
  Object.keys(BARS).forEach(function (code) {
    const A = analyzeOne(BARS[code], P);
    const src = opt.level === 'seg' ? A.ptsSeg : A.ptsBi;
    const buy = {}, sell = {}, buy3M = {}, sell3M = {};
    // 确认滞后：笔/段终点需后续走势确认
    //   数字 = 固定后移 N 根K线
    //   'auto' = 后移到"确认单元（下一笔/段）走完"的K线，即信号真正可被识别的时点
    const UNITS = opt.level === 'seg' ? A.segs : A.bis;
    function shift(x) {
      let k;
      if (opt.entryLag === 'auto') {
        const nxt = UNITS[(x.unit !== undefined ? x.unit : 0) + 1];
        k = (nxt && nxt.k1 > x.k) ? nxt.k1 : x.k + 5;
      } else k = x.k + opt.entryLag;
      return { k: k, d: x.d, p: x.p, grade: x.grade, src: x.k };
    }
    if (opt.entryMode === 'pullback') {
      // 回抽确认：只用一买，等到次级别回抽不破低点才入场
      src.buy1.forEach(function (x) {
        const kb = pullbackEntry(x.k, x.p, A.bis);
        if (kb > 0 && kb < A.cl.length) buy[kb] = { k: kb, p: x.p, src: x.k, grade: '回抽确认' };
      });
    } else {
      src.buy1.forEach(function (x) { const y = shift(x); buy[y.k] = y; });
      if (opt.useBuy2) src.buy2.forEach(function (x) { if (x.grade !== '弱') { const y = shift(x); buy[y.k] = buy[y.k] || y; } });
      if (opt.useBuy3) src.buy3.forEach(function (x) { const y = shift(x); buy[y.k] = buy[y.k] || y; });
    }
    src.sell1.concat(src.sell2).concat(src.sell3).forEach(function (x) { const y = shift(x); sell[y.k] = y; });
    // 状态机用：三买/三卖原始时点（同滞后口径）
    src.buy3.forEach(function (x) { const y = shift(x); buy3M[y.k] = y; });
    src.sell3.forEach(function (x) { const y = shift(x); sell3M[y.k] = y; });
    const idx = {};
    BARS[code].forEach(function (b, i) { idx[b[0]] = i; });
    const chg = BARS[code].map(function (b, i) {
      return i > 0 && BARS[code][i - 1][2] > 0 ? (b[2] / BARS[code][i - 1][2] - 1) * 100 : 0;
    });
    SIG[code] = { buy: buy, sell: sell, buy3: buy3M, sell3: sell3M, cl: A.cl, bars: BARS[code], idx: idx, chg: chg,
      last: BARS[code][BARS[code].length - 1][0] };
  });

  const dateSet = {};
  const CODES = Object.keys(SIG);
  CODES.forEach(function (c) { SIG[c].bars.forEach(function (b) { dateSet[b[0]] = 1; }); });
  const dates = Object.keys(dateSet).filter(function (d) { return d >= '2015-01-01'; }).sort();
  const SLOT_CAP = CAP / MAXPOS;

  const slots = new Array(MAXPOS).fill(null);
  const lastK = {};
  let cash = CAP, fees = 0, wins = 0, sumRet = 0;
  const tradeRets = [], whyCnt = {}, curve = [];
  let peak = CAP, maxDD = 0;

  dates.forEach(function (date, di) {
    slots.forEach(function (s, si) {
      if (!s) return;
      const ser = SIG[s.code];
      const i = ser.idx[date];
      // 【修复】退市/终止上市强平：越过最后一根K线仍持仓时，按最后收盘价结算，
      //   否则仓位会被永久冻结、净值虚高且资金锁死。
      if (i === undefined) {
        if (date > ser.last) {
          const lp = ser.cl[ser.cl.length - 1];
          if (lp > 0) {
            const ret0 = (lp / s.entry - 1) * 100;
            const gross0 = s.cap * (1 + ret0 / 100);
            const cost0 = s.cap * (FEE_BUY + FEE_SELL + 2 * SLIP);
            cash += gross0 - cost0; fees += cost0;
            tradeRets.push(ret0); sumRet += ret0; if (ret0 > 0) wins++;
            whyCnt['退市'] = (whyCnt['退市'] || 0) + 1;
            slots[si] = null;
          }
        }
        return;
      }
      if (!(ser.cl[i] > 0)) return;
      const px = ser.cl[i];
      const ret = (px / s.entry - 1) * 100;
      let why = null;
      // 状态机：一买后出现的第一个三类买卖点决定成败
      //   先三买 = 底部构造确认（可加仓，继续持有）
      //   先三卖 = 构造失败（立刻离场，不等止损/到期）
      if (opt.stateMachine && !s.decided) {
        if (ser.sell3[i]) { s.decided = true; why = '三卖·构造失败'; }
        else if (ser.buy3[i]) {
          s.decided = true; s.confirmed = true;
          if (opt.addOnBuy3 && cash >= SLOT_CAP * 0.5) {
            const add = SLOT_CAP * 0.5;
            s.entry = (s.cap * s.entry + add * px) / (s.cap + add);
            s.cap += add; cash -= add; fees += add * FEE_BUY;
          }
        }
      }
      if (!why) {
        if (ret <= -opt.stopPct) why = '止损';
        else if (ser.sell[i]) why = '卖点';
        else {
          // 三买已确认底部构造的仓位，用更长的持有上限（让趋势跑完）
          const lim = (opt.stateMachine && s.confirmed && opt.holdConfirmed) ? opt.holdConfirmed : opt.holdDays;
          if (i - s.i >= lim) why = '到期';
        }
      }
      if (!why) return;
      const gross = s.cap * (1 + ret / 100);
      const cost = s.cap * (FEE_BUY + FEE_SELL + 2 * SLIP);
      cash += gross - cost; fees += cost;
      tradeRets.push(ret); sumRet += ret; if (ret > 0) wins++;
      whyCnt[why] = (whyCnt[why] || 0) + 1;
      slots[si] = null;
    });
    // 入场（按代码顺序扫描，槽位满即停）
    for (let ci = 0; ci < CODES.length; ci++) {
      const code = CODES[ci];
      const ser = SIG[code];
      const i = ser.idx[date];
      if (i === undefined || !ser.buy[i]) continue;
      // 避免在样本末尾买入（无足够后续K线可结算）
      if (i >= ser.bars.length - opt.holdDays - 2) continue;
      if (lastK[code] !== undefined && i - lastK[code] < GAP) continue;
      const free = slots.findIndex(function (s) { return !s; });
      if (free < 0) break;
      const px = ser.cl[i];
      if (!(px > 0)) continue;
      if (ser.chg[i] >= LIMIT_UP) continue;          // 涨停无法买入
      if (cash < SLOT_CAP) break;
      cash -= SLOT_CAP;
      slots[free] = { code: code, i: i, entry: px, cap: SLOT_CAP };
      lastK[code] = i;
    }
    let eq = cash;
    slots.forEach(function (s) {
      if (!s) return;
      const ser = SIG[s.code];
      const i = ser.idx[date];
      eq += (i !== undefined && ser.cl[i] > 0) ? s.cap * (ser.cl[i] / s.entry) : s.cap;
    });
    curve.push(eq);
    if (eq > peak) peak = eq;
    const dd = (1 - eq / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  });

  const final = curve.length ? curve[curve.length - 1] : CAP;
  const trades = tradeRets.length;
  console.log('期末 ' + Math.round(final).toLocaleString() + '（收益 ' + ((final / CAP - 1) * 100).toFixed(1) + '%）');
  console.log('最大回撤 ' + maxDD.toFixed(1) + '%  交易 ' + trades + ' 笔  胜率 ' + pct(wins, trades)
    + '  单笔期望 ' + (trades ? (sumRet / trades).toFixed(2) : '—') + '%  费用 ' + Math.round(fees));
  console.log('卖出原因 ' + JSON.stringify(whyCnt));
  const tag = opt.level + (opt.useBuy2 ? '_b2' : '') + (opt.useBuy3 ? '_b3' : '')
    + '_' + opt.entryMode + (opt.entryMode === 'lag' ? 'lag' + opt.entryLag : '')
    + (opt.stateMachine ? '_sm' : '');
  fs.writeFileSync(path.join(ROOT, 'theory_equity_' + tag + '.json'),
    JSON.stringify({ level: opt.level, useBuy2: opt.useBuy2, useBuy3: opt.useBuy3, lag: opt.entryLag,
      entryMode: opt.entryMode, stateMachine: opt.stateMachine,
      stopPct: opt.stopPct, holdDays: opt.holdDays,
      final: final, maxDD: maxDD, trades: trades, win: trades ? wins / trades * 100 : 0,
      avgRet: trades ? sumRet / trades : 0, fees: fees, whyCnt: whyCnt }, null, 1));
  console.log('已写入 theory_equity_' + tag + '.json');
  return { final: final, maxDD: maxDD, trades: trades, win: trades ? wins / trades * 100 : 0, avgRet: trades ? sumRet / trades : 0, whyCnt: whyCnt };
}

if (require.main === module) {
  const cmd = process.argv[2] || 'selftest';
  if (cmd === 'selftest') selftest();
  else if (cmd === 'diag') diag(process.argv[3] || '600519.SH');
  else if (cmd === 'stat') stat();
  else if (cmd === 'equity') {
    const rows = [];
    [['线段级·一买+二买·滞后2', { level: 'seg', useBuy2: true, useBuy3: false, entryLag: 2 }],
     ['线段级·一买·回抽确认', { level: 'seg', useBuy2: false, useBuy3: false, entryMode: 'pullback' }],
     ['线段级·一买+二买·状态机', { level: 'seg', useBuy2: true, useBuy3: false, entryLag: 2, stateMachine: true }],
     ['线段级·状态机+确认延长120', { level: 'seg', useBuy2: true, useBuy3: false, entryLag: 2, stateMachine: true, holdConfirmed: 120 }],
     ['线段级·状态机+加仓+延长', { level: 'seg', useBuy2: true, useBuy3: false, entryLag: 2, stateMachine: true, addOnBuy3: true, holdConfirmed: 120 }],
     ['笔级·仅一买·滞后2', { level: 'bi', useBuy2: false, useBuy3: false, entryLag: 2 }],
     ['笔级·仅一买·回抽确认', { level: 'bi', useBuy2: false, useBuy3: false, entryMode: 'pullback' }],
     ['笔级·仅一买·状态机', { level: 'bi', useBuy2: false, useBuy3: false, entryLag: 2, stateMachine: true }],
     ['笔级·仅一买·状态机+延长120', { level: 'bi', useBuy2: false, useBuy3: false, entryLag: 2, stateMachine: true, holdConfirmed: 120 }],
     ['笔级·一买+二买+状态机+延长', { level: 'bi', useBuy2: true, useBuy3: false, entryLag: 2, stateMachine: true, holdConfirmed: 120 }]
    ].forEach(function (it) {
      const r = equity({}, it[1]);
      rows.push({ name: it[0], level: it[1].level, useBuy2: it[1].useBuy2, useBuy3: it[1].useBuy3,
        lag: it[1].entryLag, final: r.final, maxDD: r.maxDD, trades: r.trades, win: r.win, avgRet: r.avgRet });
    });
    fs.writeFileSync(path.join(ROOT, 'theory_equity_summary.json'), JSON.stringify(rows, null, 1));
    console.log('\n--- 汇总 ---');
    console.log('方案'.padEnd(30) + '期末'.padStart(12) + '回撤'.padStart(8) + '交易'.padStart(7) + '胜率'.padStart(8) + '期望'.padStart(8));
    rows.forEach(function (x) {
      console.log(x.name.padEnd(30) + Math.round(x.final).toLocaleString().padStart(12)
        + x.maxDD.toFixed(1).padStart(8) + String(x.trades).padStart(7)
        + x.win.toFixed(1).padStart(8) + x.avgRet.toFixed(2).padStart(8));
    });
  }
  else console.log('用法: node tools/chan_theory.js selftest|diag <code>|stat|equity');
}

module.exports = {
  mergeK, fractals, buildBi, buildSeg, segFeatureMerge, segFractal,
  buildCenters, expandCenters, classifyTrend, judgeBeichi,
  ema, macd, areaOf, difPeak, difMinAbs, difAt,
  detectPoints, analyzeOne, intervalNest, toWeekly, weekKey, loadBars,
  equity, pullbackEntry
};
