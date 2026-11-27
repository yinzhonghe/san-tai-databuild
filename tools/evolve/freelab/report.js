/*
 * tools/evolve/freelab/report.js · 自由推演实验室 · 报告生成器
 * ================================================================
 * 产出 freelab_report.js（window.AB_FREELAB_REPORT），浏览器直接加载。
 * 与 evolve_report.js（v2 证据包自进化）【完全独立】，页面是单独模块⑤。
 *
 * 报告回答四个问题（一眼看懂）：
 *   ① 这个维度是什么 / 现在什么状态
 *   ② 大模型自由推演了什么（市场画像 + 它提的模型）
 *   ③ 跑出了什么（真实验证结论，诚实：没跑出就写没跑出）
 *   ④ 往哪努力
 *
 * 数据全部来自 facts.json / verified.json / models.jsonl，不写死数字；
 * 没有数据就如实标「待首次推演」，不用 0 或估算顶替。
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.dirname(path.dirname(path.dirname(__dirname)));
var EVO = path.join(ROOT, 'learn', 'evolve');
var LAB = path.join(EVO, 'freelab');
var OUT = path.join(ROOT, 'freelab_report.js');
var FACTS = path.join(LAB, 'facts.json');
var VERIFIED = path.join(LAB, 'verified.json');
var VERIFIED_H = path.join(LAB, 'verified_horizons.json');
var MODELS = path.join(LAB, 'models.jsonl');
var CONST = path.join(EVO, 'constitution.json');

function loadJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function pct(v, d) { return isNum(v) ? +(v * 100).toFixed(d == null ? 2 : d) : null; }
function fnum(v, d) { return isNum(v) ? +v.toFixed(d == null ? 3 : d) : null; }
function todayCN() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
function loadJSONL(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; }
}

function build() {
  var facts = loadJSON(FACTS, null);
  var verified = loadJSON(VERIFIED, null);
  var verifiedH = loadJSON(VERIFIED_H, null);
  var models = loadJSONL(MODELS);
  var cons = loadJSON(CONST, {});
  var model = (cons.budget && cons.budget.model) || 'glm-5.3-flash';

  // 市场画像亮点：挑每个特征里「最强档净收益 - 最弱档净收益」最大的几个，展示数据里的真实结构
  var portraitHighlights = [];
  if (facts && facts.features) {
    Object.keys(facts.features).forEach(function (k) {
      var f = facts.features[k];
      if (isNum(f.spread) && f.spread > 0) {
        portraitHighlights.push({
          key: k, label: f.label, spread: f.spread,
          bestBucket: f.bestBucket, bestNet: f.bestNet,
          worstBucket: f.worstBucket, worstNet: f.worstNet,
          coverage: f.coverage
        });
      }
    });
    portraitHighlights.sort(function (a, b) { return b.spread - a.spread; });
    portraitHighlights = portraitHighlights.slice(0, 6);
  }

  var nModels = models.length;
  var passed = verified ? (verified.models || []).filter(function (m) { return m.verdict === 'PASSED'; }) : [];
  var notProven = verified ? (verified.models || []).filter(function (m) { return m.verdict === 'NOT_PROVEN'; }) : [];
  var freeHyp = verified ? (verified.models || []).filter(function (m) { return m.verdict === 'FREE_HYPOTHESIS'; }) : [];

  // 最新一条模型的一句话 / 前沿方向
  var last = models.length ? models[models.length - 1] : null;
  var oneLine = last && (last.oneLine || last.frontier) || '';

  var hasFacts = !!facts;
  var hasRun = nModels > 0;
  var fund = facts ? facts.fundflow : null;   // 资金流维度（真实抓取 + join 画像）

  var summary = {
    state: hasFacts
      ? '自由推演实验室已就位：市场画像来自 ' + facts.baseline.tradable.toLocaleString() +
        ' 条真实信号（扣' + fnum(facts.baseline.costPct, 2) + '%成本、一字板剔除）；' +
        '大模型已提 ' + nModels + ' 个模型，验证跑出 ' + passed.length + ' 个 / 未证明 ' + notProven.length + ' 个。'
      : '市场画像未生成：请先运行 node tools/evolve/freelab/facts.js 生成真实数据原料。',
    did: '把 ' + (facts ? facts.baseline.samples.toLocaleString() : '真实') +
      ' 条样本整理成「市场画像」——每个特征按真实取值分 5 档，逐档算信号级净收益/胜率/超额，' +
      '再按月份、行业切片。让大模型读这份画像【自由推演】，不受六派种子/白名单草图约束，' +
      '自己提出模型（可执行规则 / 新特征表达式 / 纯叙事假设皆可），' +
      '然后用同一套真实结算器逐条验钱。',
    result: passed.length
      ? ('跑出 ' + passed.length + ' 个过五关的模型：最好一个净收益 ' + fnum(passed[0].metrics && passed[0].metrics.netRet3) +
         '%、t=' + (passed[0].metrics && passed[0].metrics.tStat) + '、覆盖率 ' +
         (passed[0].metrics && passed[0].metrics.coverage) + '%（历史回测，非前瞻）。')
      : (hasRun
        ? ('大模型提了 ' + nModels + ' 个模型，但真实结算后【0 个跑出可交易模型】——' +
           notProven.length + ' 个栽在净收益/t值/覆盖率/跑赢基准上，' + freeHyp.length +
           ' 个还是无法回测的叙事假设。这是诚实结论，不是没跑。')
        : '尚未首次推演：需配置 LLM_API_KEY 后运行 python github_ci/freelab_llm.py，' +
          '让大模型读画像自由提模型；当前只有真实市场画像，没有模型结论。'),
    direction: '自由度放在「假设」——鼓励大模型跨特征组合、造新表达式、提市场状态机/分域模型；' +
      '严格度放在「验证」——任何模型都要过净收益>0、t≥3、覆盖率≥2%、Wilson下界、跑赢持有基准五关。' +
      '现已按【按月 / 按周 / 按日 / T0ETF·日内】四维度分类推演：每维度用真实 kline 算自己的基准' +
      '（月T+20、周T+5、日T+1、日内开盘→收盘），模型只在自己声明的维度上结算，' +
      '不拿T+3的旧尺子量所有持有期。' +
      (fund && fund.fetchedCodes > 0
        ? ('资金流维度已接入：真实抓取 ' + fund.fetchedCodes + ' 只票的逐日五档资金流，' +
           'join ' + fund.joinedRows.toLocaleString() + ' 条样本（覆盖率 ' + (fund.joinRate * 100).toFixed(1) +
           '%），派生主力净流入/超大单结构/资金加速度，供大模型推演；未覆盖样本一律标缺口。下一步继续补覆盖率、' +
           '等资金流样本够厚后让它进模型验证链。')
        : '下一步：补历史资金流维度（数据猎手抓取中），让大模型有更多真实素材可推演；' +
          '叙事型假设先工程化成可执行规则再验。')
  };

  var report = {
    summary: summary,
    at: todayCN(), generatedAt: new Date().toISOString(),
    version: 'freelab-v2-horizons',
    model: model,
    dataAsOf: facts ? facts.dataAsOf : '',
    hasFacts: hasFacts,
    hasRun: hasRun,
    disclaimer: '自由推演是【研究性实验】：大模型假设 + 历史回测，含幸存者偏差与过拟合风险，非实盘前瞻收益，不构成投资建议。与 v2 证据包自进化相互独立、互不影响。',
    baseline: facts ? facts.baseline : null,
    window: facts ? facts.window : null,
    gaps: facts ? facts.gaps : null,
    portraitHighlights: portraitHighlights,
    byMonth: facts ? facts.byMonth : [],
    byIndustry: facts ? (facts.byIndustry || []).slice(0, 10) : [],
    fundflow: fund ? {
      fetchedCodes: fund.fetchedCodes, joinRate: fund.joinRate,
      joinedRows: fund.joinedRows, baseline: fund.baseline,
      status: fund.fundStatus,
      highlights: Object.keys(fund.features || {}).map(function (k) {
        var f = fund.features[k];
        return { key: k, label: f.label, coverage: f.coverage, spread: f.spread,
          bestBucket: f.bestBucket, bestNet: f.bestNet, worstBucket: f.worstBucket, worstNet: f.worstNet };
      }).filter(function (x) { return isNum(x.spread); }).sort(function (a, b) { return b.spread - a.spread; }).slice(0, 4)
    } : null,
    verified: verified ? {
      modelCount: verified.modelCount, passedCount: verified.passedCount,
      notProvenCount: verified.notProvenCount, freeHypothesisCount: verified.freeHypothesisCount,
      sealOk: verified.sealOk, models: (verified.models || []).slice(-12)
    } : null,
    // 四时间维度推演分类：月 / 周 / 日 / T0ETF·日内，各自真实基准 + 各自验证结论
    dimensions: (verifiedH && verifiedH.dimensions || []).map(function (d) {
      var b = d.baseline || {};
      var factH = ((facts && facts.horizons) || []).filter(function (x) { return x.key === d.key; })[0] || {};
      return {
        key: d.key, name: d.name, desc: d.desc, retKey: d.retKey,
        baseline: {
          netRet: b.netRet != null ? b.netRet : factH.netRet,
          tStat: b.tStat != null ? b.tStat : factH.tStat,
          winRate: b.winRate != null ? b.winRate : factH.winRate,
          samples: b.n != null ? b.n : factH.samples,
          coverage: b.coverage, note: factH.note || ''
        },
        modelCount: (d.models || []).length,
        passedCount: d.passedCount || 0,
        notProvenCount: d.notProvenCount || 0,
        models: (d.models || []).slice(-5).map(function (m) {
          return { name: m.name, thesis: m.thesis, verdict: m.verdict,
            reason: m.reason, netRet: m.metrics && m.metrics.netRet,
            tStat: m.metrics && m.metrics.tStat, coverage: m.metrics && m.metrics.coverage };
        })
      };
    }),
    horizonDisclaimer: '四维度收益来自真实 kline（月=T+20 / 周=T+5 / 日=T+1 / 日内=T开盘→收盘），' +
      '已扣往返成本、剔除一字板；日内T0只对名称命中跨境/黄金/债券/货币的ETF放行。' +
      '全部为历史回测，含幸存者偏差，非前瞻收益、不构成投资建议。',
    oneLine: oneLine,
    lastModelAt: last && last.at || null
  };
  var js = '/* 自动生成 by tools/evolve/freelab/report.js，勿手改 */\nwindow.AB_FREELAB_REPORT = ' + JSON.stringify(report, null, 2) + ';\n';
  fs.writeFileSync(OUT, js, 'utf8');
  return report;
}

function main() {
  var r = build();
  console.log('[freelab-report] 画像=%s | 模型=%d | 跑出=%d | 未证明=%d',
    r.hasFacts ? '有' : '无', r.verified ? r.verified.modelCount : 0,
    r.verified ? r.verified.passedCount : 0, r.verified ? r.verified.notProvenCount : 0);
  console.log('[freelab-report] 已写入 %s', OUT);
}
if (require.main === module) main();
module.exports = { build: build };
