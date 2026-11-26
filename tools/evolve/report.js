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

function load(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function todayStr() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
function pct(v, d) { return isNum(v) ? +v.toFixed(d == null ? 2 : d) : null; }
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
  var base = cons.baseline || {};
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
  if (throttled.length) nextSteps.push('重试限流源（' + throttled.map(function (g) { return g.label; }).join('、') + '）：接口已找到，换网络/降频即可补');
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
  var report = {
    at: todayStr(), generatedAt: new Date().toISOString(),
    version: 'v2', sealOk: seal.ok,
    disclaimer: '数据来自历史回测+kernel裁判，非实盘前瞻收益；净收益已扣0.31%成本，含幸存者偏差、回测偏乐观；不构成投资建议。',
    goal: cons.goal || '',
    baseline: { n: base.n || 0, signalRet3: isNum(base.signalRet3) ? base.signalRet3 : null,
                winRate: isNum(base.winRate) ? base.winRate : null, frozenAt: base.frozenAt || '' },
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
