// 最终超跌反弹名单：整合所有验证过的参数。
//
// 筛选（已回测验证）：
//   1. 排除 ST / 退市
//   2. 从 250 日高点跌 ≥45%
//   3. 250 日内曾翻倍（≥100%）
//   4. 板块分散：每个行业最多 2 只（相关性聚类的近似）
//
// 交易参数（已回测验证，期望 +6.31%）：
//   入场：距 20 日低点反弹 ≥5%（等它自己站起来）
//   止损：-8%
//   止盈：不设，持有到时限
//   时限：45 个交易日
//
// 用法：node tools/final_pick.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.dirname(__dirname);
const H = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'hist.json.gz'))).toString());

const raw = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8')
  .replace(/^\ufeff/, '').replace(/window\.AB_DATA\s*=/, 'global.__D =');
(0, eval)(raw);
const D = global.__D || {};
const info = {};
(D.rows || []).forEach(function (r) { info[r.code] = r; });

const STOP_PCT = 8, HOLD_DAYS = 45, ENTRY_REBOUND = 5;

function maAt(a, e, k) {
  if (e < k - 1) return null;
  let s = 0;
  for (let i = e - k + 1; i <= e; i++) s += a[i];
  return s / k;
}

const pool = [];
Object.keys(H.bars).forEach(function (code) {
  const it = info[code] || {};
  const nm = it.name || '';
  if (/ST|退/.test(nm)) return;
  const arr = H.bars[code];
  if (!arr || arr.length < 260) return;
  const cl = arr.map(function (x) { return x[1]; });
  const n = cl.length;
  const px = cl[n - 1];
  if (!(px > 0)) return;

  // 250 日高低点
  let hi250 = -Infinity, lo250 = Infinity;
  for (let i = Math.max(0, n - 250); i < n; i++) {
    if (cl[i] > hi250) hi250 = cl[i];
    if (cl[i] < lo250) lo250 = cl[i];
  }
  if (!(hi250 > 0) || !(lo250 > 0)) return;
  const drop = (px / hi250 - 1) * 100;
  if (drop > -45) return;
  const surge = (hi250 / lo250 - 1) * 100;
  if (surge < 100) return;

  // 20 日低点、反弹幅度、MA5/MA10
  let lo20 = Infinity;
  for (let i = n - 20; i < n; i++) if (cl[i] < lo20) lo20 = cl[i];
  const rebound = lo20 > 0 ? (px / lo20 - 1) * 100 : 0;
  const m5 = maAt(cl, n - 1, 5), m10 = maAt(cl, n - 1, 10), m20 = maAt(cl, n - 1, 20);
  const m60 = maAt(cl, n - 1, 60);

  // 近期是否还在下跌通道
  const d20 = (px / cl[Math.max(0, n - 21)] - 1) * 100;

  pool.push({
    code: code, name: nm, ind: it.ind || it.indL2 || '未分类',
    px: px, hi250: hi250, lo250: lo250, lo20: lo20,
    drop: drop, surge: surge, rebound: rebound, d20: d20,
    ma5: m5, ma10: m10, ma20: m20, ma60: m60,
    distMA60: m60 ? (px / m60 - 1) * 100 : null,
    // 交易参数
    entryPrice: px * (1 + ENTRY_REBOUND / 100),   // 入场参考（等反弹5%，这里用现价+5%近似）
    stopPrice: px * (1 - STOP_PCT / 100),
    ready: rebound >= ENTRY_REBOUND,               // 当前是否已到入场点
    state: it.state || '—'
  });
});

// 打分：跌幅 + 前期涨幅 + 离均线 + 20日跌速（与回测一致）
function score(x) {
  let s = 0;
  s += Math.min(-x.drop, 70) * 1.0;
  s += Math.min(x.surge, 500) * 0.02;
  s += Math.min(-(x.distMA60 || 0), 60) * 0.3;
  s += Math.min(-x.d20, 50) * 0.2;
  return s;
}
pool.forEach(function (x) { x.score = score(x); });
pool.sort(function (a, b) { return b.score - a.score; });

// 行业分散：每行业最多 2 只
const boardN = {};
pool.forEach(function (x) { boardN[x.ind] = (boardN[x.ind] || 0) + 1; });
const picked = [], used = {};
pool.forEach(function (x) {
  if (picked.length >= 14) return;
  used[x.ind] = used[x.ind] || 0;
  if (used[x.ind] >= 2) return;
  used[x.ind]++;
  picked.push(x);
});

console.log('=== 最终超跌反弹名单（共 %d 只）===\n', picked.length);
console.log('筛选：跌≥45% · 曾翻倍 · 排除ST · 每行业≤2只');
console.log('参数：入场 距20日低点反弹≥5% · 止损-8% · 不设止盈 · 持45个交易日');
console.log('数据：%s\n', H.asOf);
console.log('序 代码        名称      行业          现价   距高点  前期涨  离底反弹  本板超跌  入场  止损价  状态');
console.log('─'.repeat(116));
picked.forEach(function (x, i) {
  console.log(String(i + 1).padStart(2) + ' ' + x.code.padEnd(11) + (x.name || '—').slice(0, 5).padEnd(8)
    + (x.ind || '').slice(0, 7).padEnd(11)
    + x.px.toFixed(2).padStart(7) + (x.drop.toFixed(0) + '%').padStart(8)
    + (x.surge.toFixed(0) + '%').padStart(8) + (x.rebound.toFixed(1) + '%').padStart(9)
    + String(boardN[x.ind]).padStart(9) + ' 只'
    + (x.ready ? ' ✓可入' : ' ○等待').padEnd(7)
    + x.stopPrice.toFixed(2).padStart(7) + '  ' + x.state);
});

const ready = picked.filter(function (x) { return x.ready; });
console.log('\n当前已满足入场信号（反弹≥5%）：%d 只', ready.length);
console.log('尚在等待（反弹<5%）：%d 只', picked.length - ready.length);
console.log('\n说明：');
console.log('  ✓可入 = 已从20日低点反弹5%以上，符合回测最优入场点');
console.log('  ○等待 = 还没反弹到位，追进去容易被震出局');
console.log('  止损价 = 现价 × 0.92（-8%），买入后按实际买入价重新计算');
console.log('\n历史期望 +6.31%（11年、130万样本）；仅供信息整理，不构成投资建议。');

/* 输出页面数据（独立 JS 文件，供 oversold.html 读取） */
var pageData = {
  date: H.asOf,
  count: picked.length,
  readyN: picked.filter(function (x) { return x.ready; }).length,
  params: {
    dropMin: 45, surgeMin: 100, entryRebound: ENTRY_REBOUND,
    stop: STOP_PCT, hold: HOLD_DAYS, expect: 6.31, samples: 1300000
  },
  items: picked.map(function (x) {
    return {
      code: x.code, name: x.name, ind: x.ind, state: x.state,
      px: +x.px.toFixed(2), drop: +x.drop.toFixed(1), surge: +x.surge.toFixed(0),
      rebound: +x.rebound.toFixed(1), boardN: boardN[x.ind] || 0,
      ready: !!x.ready,
      ma20: x.ma20 ? +x.ma20.toFixed(2) : null,
      ma60: x.ma60 ? +x.ma60.toFixed(2) : null,
      entryTarget: +(x.lo20 * (1 + ENTRY_REBOUND / 100)).toFixed(2),  // 需涨到这个价才触发入场
      stopPrice: +x.stopPrice.toFixed(2),
      stopFromEntry: +(x.lo20 * (1 + ENTRY_REBOUND / 100) * (1 - STOP_PCT / 100)).toFixed(2)
    };
  })
};
var out = '/* 超跌反弹观察池 · 由 tools/final_pick.js 生成，勿手改 */\n'
  + 'window.AB_OVERSOLD = ' + JSON.stringify(pageData, null, 1) + ';\n';
fs.writeFileSync(path.join(ROOT, 'oversold_data.js'), out);
console.log('已生成 oversold_data.js（%d 只）', picked.length);
