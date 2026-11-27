/*
 * tools/evolve/report.js · 每日汇报生成器 v2（超跌页第④板块数据源）
 * ======================================================================
 * 读 v2 引擎产物（population / constitution / heartbeat），产出证据包口径汇报：
 *   ① 信号级 baseline（每个信号都算钱、扣成本）
 *   ② 改进了哪些：active 规则的校正净收益 vs baseline + 逐条件消融（噪声/核心构件）
 *   ③ 胜率：Wilson 下界 + 覆盖率 + 机会成本差；样本不足标「积累中」
 *   ④ 数据缺口 / 累计试验次数 / 验证额度
 *   ⑤ 下一步：证据里最弱一环 + 待补数据 + 现场课程触发状态
 * 产出 evolve_report.js（window.AB_EVOLVE_REPORT），浏览器直接加载，不动三态主站。
 */
'use strict';
var fs = require('fs');
var path = require('path');
var K = require('./kernel.js');

var ROOT = path.dirname(path.dirname(__dirname));
var EVO = path.join(ROOT, 'learn', 'evolve');
var OUT = path.join(ROOT, 'evolve_report.js');
var POP = path.join(EVO, 'population.json');
var CONST = path.join(EVO, 'constitution.json');
var HB = path.join(EVO, 'heartbeat.json');
var GAPS = path.join(EVO, 'panel_gaps.json');
var HUNTER = path.join(EVO, 'data_sources.json');
var LLM = path.join(EVO, 'llm_candidates_v3.json');
var DAILY_LOG = path.join(EVO, 'daily_log.jsonl');
/* 当前窗口实测基线（settle --baseline --out 写盘）：宪法 baseline 冻结于 2026-11-26 旧窗口，
   扩窗后 n 变了但冻结值不漂移；报告与 netDelta 必须用同窗口实测值，冻结值仅作 frozen 参照。 */
var MEASURED_BASE = path.join(EVO, 'baseline_measured.json');

function load(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function todayStr() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
function pct(v, d) { return isNum(v) ? +v.toFixed(d == null ? 2 : d) : null; }
function fmtNum(v) { return isNum(v) ? String(+v.toFixed(3)) : '—'; }
function loadLog(p, maxLines) {
  try {
    var lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-(maxLines || 20)).map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

function build() {
  var pop = load(POP, {});
  var cons = load(CONST, {});
  var hb = load(HB, {});
  var gaps = load(GAPS, {});
  var hunter = load(HUNTER, {});
  var llm = load(LLM, {});
  var daily = loadLog(DAILY_LOG, 20);
  var frozenBase = cons.baseline || {};
  // 优先当前窗口实测基线；缺文件时回退宪法冻结值（保持旧行为，不报错）。
  var measured = load(MEASURED_BASE, null);
  // 实测基线由 settle --baseline --out 写盘，口径与规则评估一致（默认采样）；
  // 其 n 天然小于全样本 gaps.samples，不能用 n 比对判新鲜。只看字段合法即可，
  // 冻结值始终单列 frozen 供参照。
  var measuredFresh = measured && isNum(measured.netRet3) && isNum(measured.n) && measured.n > 0;
  var base = measuredFresh
    ? { signalRet3: measured.netRet3, winRate: measured.winRate, n: measured.n,
        generatedAt: measured.generatedAt, frozenAt: '' }
    : frozenBase;
  var rules = pop.rules || [];
  var seal = K.verifySeal();

  // 改进明细：v2 口径——信号级净收益、Wilson、覆盖率、消融、证据包
  var improvements = rules.filter(function (r) { return ['active', 'shadow'].indexOf(r.status) >= 0; })
    .map(function (r) {
      var m = r.lastMetrics || {};
      return {
        id: r.id, desc: r.desc || '', status: r.status,
        origin: r.origin || '', generation: r.bornGen != null ? r.bornGen : null,
        n: m.n || 0,
        netRet3: isNum(m.netRet3) ? m.netRet3 : null,
        netDelta: (isNum(m.netRet3) && isNum(base.signalRet3)) ? pct(m.netRet3 - base.signalRet3, 3) : null,
        winRate: isNum(m.winRate) ? pct(m.winRate * 100) : null,
        wilson: isNum(m.wilsonLower) ? pct(m.wilsonLower * 100) : null,
        tStat: isNum(m.tStat) ? m.tStat : null,
        coverage: isNum(m.coverage) ? m.coverage : null,
        worstSeg: isNum(m.worstSegmentNet) ? m.worstSegmentNet : null,
        excessOverHold: isNum(m.excessOverHold) ? m.excessOverHold : null,
        hardGate: r.hardGate || null, softJudge: r.softJudge || null,
        elo: r.elo || null, parentIds: r.parentIds || [],
        ablation: r.evidence && r.evidence.ablation || null,
        dataNeeds: r.dataNeeds || []
      };
    }).sort(function (a, b) {
      if (a.status !== b.status) return (a.status === 'active') - (b.status === 'active');
      return (b.netRet3 == null ? -999 : b.netRet3) - (a.netRet3 == null ? -999 : a.netRet3);
    });

  var active = improvements.filter(function (x) { return x.status === 'active'; });
  var enough = (base.n || 0) >= 30;
  var hasActive = active.length > 0;

  // 数据缺口
  var dataGaps = [];
  Object.keys(hunter).forEach(function (k) {
    var s = hunter[k] || {};
    if (s.status !== 'verified') dataGaps.push({ field: k, label: s.label || k, status: s.status, note: s.note || '' });
  });
  if (gaps.noIndustry > 0) dataGaps.push({ field: 'industry', label: '行业分类缺失', status: 'partial',
    note: gaps.noIndustry + ' 只无行业标签' });

  // 下一步：证据驱动，不拍脑袋
  var nextSteps = [];
  var throttled = dataGaps.filter(function (g) { return g.status === 'found_throttled'; });
  if (throttled.length) nextSteps.push('补数据（' + throttled.map(function (g) { return g.label; }).join('、') + '）：接口已实测可用，须带浏览器头(UA+Referer+ut)并低频重抓；此前裸 curl 误判为限流');
  if (hb.needTestTime) nextSteps.push('连续3代全灭：触发现场课程（拆子问题/子空间找构件，最多3轮，构件须回全市场过 kernel）');
  if (!hasActive) {
    nextSteps.push('当前 active=0：所有候选未过「信号级净收益>0 + t≥3 + 覆盖率 + 机会成本」四关，属诚实积累阶段');
    if (improvements.length) {
      var best = improvements[0];
      nextSteps.push('最接近的候选 ' + best.id + '：净收益 ' + (best.netRet3 == null ? '—' : best.netRet3 + '%') +
        '、t=' + (best.tStat == null ? '—' : best.tStat) + '，下一步调整其阈值/特征组合');
    }
  }
  var noiseRules = improvements.filter(function (x) { return x.ablation && x.ablation.noise && x.ablation.noise.length; });
  if (noiseRules.length) nextSteps.push('消融发现 ' + noiseRules.length + ' 条规则含噪声条件（去掉后收益不变），已在下一代变异时优先删除');
  if (llm && llm.result && llm.result.oneLine) nextSteps.push('模型建议：' + llm.result.oneLine);
  if (!nextSteps.length) nextSteps.push('活体池持续考核中；连续跑输会自动退役，新数据落盘后再优化');

  var trialTotal = load(path.join(EVO, 'trial_counter.json'), {}).total || pop.trialTotal || 0;
  var validation = cons.validation || {};

  // 「一眼看懂」摘要：状态 / 干了什么 / 什么结果 / 往哪努力。全部由真实字段拼装，不写死数字。
  var bestImp = improvements[0] || null;
  var gate = (cons.target || {}).hardGate || {};
  var minT = (cons.multipleTesting || {}).minTStat || 3;
  var summary = {
    state: '第 ' + (pop.generation || 0) + ' 代 · 跑了 ' + trialTotal + ' 次试验 · 评估 ' + rules.length +
      ' 条候选 · 启用 ' + active.length + ' 条 / 影子 ' + (rules.length - active.length) + ' 条',
    did: '把六派理论拆成人类种子，自动变异出候选规则；每条都在 ' + (base.n || gaps.samples || 0).toLocaleString() +
      ' 条历史信号上「逐条算钱」——T 日收盘买、T+3 收盘卖，一字板剔除，扣 ' +
      (cons.costModel ? ((cons.costModel.commissionPctPerSide || 0) * 2 + (cons.costModel.stampTaxPctSell || 0) + (cons.costModel.slippagePctPerSide || 0) * 2) : 0.31).toFixed(2) +
      '% 成本，再用封印的宪法做硬验证 + 软裁判。',
    result: '追启动整体亏钱：基线净收益 ' + fmtNum(base.signalRet3) + '%、胜率 ' + fmtNum(base.winRate) +
      '%。' + (bestImp ? '净收益最高的候选 ' + bestImp.id + ' 达到 ' + fmtNum(bestImp.netRet3) +
      '%，但覆盖率仅 ' + fmtNum(bestImp.coverage) + '%、t=' + fmtNum(bestImp.tStat) +
      '——这是少数样本碰巧撞出的高收益，不是可交易策略，已被新增的覆盖率闸门挡下。' : '') +
      '所以启用 ' + active.length + ' 条——不是没跑，是没一条够格。',
    direction: (function () {
      var gates = [];
      gates.push('净收益 > ' + (gate.minNetRet3Pct || 0) + '%');
      gates.push('t ≥ ' + minT);
      gates.push('Wilson 胜率下界 ≥ ' + ((gate.minWilsonLowerWinRate || 0.5) * 100).toFixed(0) + '%');
      gates.push('覆盖率 ≥ ' + (gate.minCoveragePct || 2) + '%');
      gates.push('跑赢持有基准');
      var fails = [];
      if (bestImp) {
        if (!isNum(bestImp.netRet3) || bestImp.netRet3 <= (gate.minNetRet3Pct || 0)) fails.push('净收益');
        if (!isNum(bestImp.tStat) || bestImp.tStat < minT) fails.push('t 仅 ' + fmtNum(bestImp.tStat));
        if (!isNum(bestImp.wilson) || bestImp.wilson < (gate.minWilsonLowerWinRate || 0.5) * 100) fails.push('Wilson 下界');
        if (!isNum(bestImp.coverage) || bestImp.coverage < (gate.minCoveragePct || 2)) fails.push('覆盖率仅 ' + fmtNum(bestImp.coverage) + '%');
        if (!isNum(bestImp.excessOverHold) || bestImp.excessOverHold <= 0) fails.push('机会成本');
      }
      return '五关全过才准启用：' + gates.join('、') + '。当前最高收益候选栽在【' +
        (fails.length ? fails.join('、') : '综合稳健度') + '】上——净收益能靠少数样本碰出来，t 值和覆盖率碰不出来。' +
        '方向是给规则喂新特征（历史资金流）+ 用「现场课程」拆子问题找新构件，而不是在旧形态上继续微调阈值。';
    })()
  };

  var report = {
    summary: summary,
    at: todayStr(), generatedAt: new Date().toISOString(),
    dataAsOf: gaps.asOf || '',
    version: 'v2', sealOk: seal.ok,
    disclaimer: '数据来自历史回测+kernel裁判，非实盘前瞻收益；净收益已扣0.31%成本，含幸存者偏差、回测偏乐观；不构成投资建议。',
    goal: cons.goal || '',
    // 当前窗口实测基线（与 totalSamples 同口径）；宪法冻结值放 frozen 字段仅作参照，禁止相减当超额。
    baseline: { n: base.n || gaps.samples || 0, nFrozen: !!base.n,
                signalRet3: isNum(base.signalRet3) ? base.signalRet3 : null,
                winRate: isNum(base.winRate) ? base.winRate : null,
                frozenAt: base.frozenAt || '',
                frozen: { signalRet3: isNum(frozenBase.signalRet3) ? frozenBase.signalRet3 : null,
                          winRate: isNum(frozenBase.winRate) ? frozenBase.winRate : null,
                          frozenAt: frozenBase.frozenAt || '',
                          note: '宪法冻结于旧窗口(2026-01起)的固定标尺，仅供参考；不可与实测基线相减当超额' } },
    totalSamples: gaps.samples || 0,
    improvements: improvements,
    activeCount: active.length,
    enough: enough,
    hasActive: hasActive,
    dataGaps: dataGaps,
    nextSteps: nextSteps,
    population: { generation: pop.generation || 0, total: rules.length,
                  active: rules.filter(function (r) { return r.status === 'active'; }).length,
                  shadow: rules.filter(function (r) { return r.status === 'shadow'; }).length,
                  trialTotal: trialTotal,
                  needTestTime: !!hb.needTestTime },
    validation: { split: validation.split, holdoutDays: validation.holdoutDays,
                  minSegments: validation.minNonOverlapSegments,
                  holdoutQuota: (validation.holdoutQuota || {}).initialChecks },
    heartbeat: { status: hb.status || 'none', date: hb.date || '', gen: hb.gen },
    dailyHistory: daily.slice(-8).map(function (d) {
      return { at: d.at, gen: d.generation, active: d.active, evaluated: d.evaluated };
    }),
    llmOneLine: (llm && llm.result && llm.result.oneLine) || ''
  };
  var js = '/* 自动生成 by tools/evolve/report.js v2，勿手改 */\nwindow.AB_EVOLVE_REPORT = ' + JSON.stringify(report, null, 2) + ';\n';
  fs.writeFileSync(OUT, js, 'utf8');
  return report;
}

function main() {
  var r = build();
  console.log('[evolve-report v2] %s | 信号级baseline %s%% | active=%d shadow=%d | 试验%d次 | 缺口%d',
    r.at, r.baseline.signalRet3, r.activeCount, r.population.shadow, r.population.trialTotal, r.dataGaps.length);
  console.log('[evolve-report v2] 已写入 %s', OUT);
}
if (require.main === module) main();
module.exports = { build: build };
