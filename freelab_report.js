/* 自动生成 by tools/evolve/freelab/report.js，勿手改 */
window.AB_FREELAB_REPORT = {
  "summary": {
    "state": "自由推演实验室已就位：市场画像来自 0 条真实信号（扣0.31%成本、一字板剔除）；大模型已提 6 个模型，验证跑出 0 个 / 未证明 4 个。",
    "did": "把 0 条样本整理成「市场画像」——每个特征按真实取值分 5 档，逐档算信号级净收益/胜率/超额，再按月份、行业切片。让大模型读这份画像【自由推演】，不受六派种子/白名单草图约束，自己提出模型（可执行规则 / 新特征表达式 / 纯叙事假设皆可），然后用同一套真实结算器逐条验钱。",
    "result": "大模型提了 6 个模型，但真实结算后【0 个跑出可交易模型】——4 个栽在净收益/t值/覆盖率/跑赢基准上，1 个还是无法回测的叙事假设。这是诚实结论，不是没跑。",
    "direction": "自由度放在「假设」——鼓励大模型跨特征组合、造新表达式、提市场状态机/分域模型；严格度放在「验证」——任何模型都要过净收益>0、t≥3、覆盖率≥2%、Wilson下界、跑赢持有基准五关。现已按【按月 / 按周 / 按日 / T0ETF·日内】四维度分类推演：每维度用真实 kline 算自己的基准（月T+20、周T+5、日T+1、日内开盘→收盘），模型只在自己声明的维度上结算，不拿T+3的旧尺子量所有持有期。资金流维度已接入：真实抓取 5838 只票的逐日五档资金流，join 0 条样本（覆盖率 0.0%），派生主力净流入/超大单结构/资金加速度，供大模型推演；未覆盖样本一律标缺口。下一步继续补覆盖率、等资金流样本够厚后让它进模型验证链。"
  },
  "at": "2026-11-27",
  "generatedAt": "2026-11-27T09:27:06.731Z",
  "version": "freelab-v2-horizons",
  "model": "glm-5.3-flash",
  "dataAsOf": "20261113",
  "hasFacts": true,
  "hasRun": true,
  "disclaimer": "自由推演是【研究性实验】：大模型假设 + 历史回测，含幸存者偏差与过拟合风险，非实盘前瞻收益，不构成投资建议。与 v2 证据包自进化相互独立、互不影响。",
  "baseline": {
    "constitutionNet": -0.5671,
    "measuredNet": null,
    "measuredWinRate": null,
    "samples": 0,
    "tradable": 0,
    "costPct": 0.31,
    "skippedOneWord": 0,
    "skippedNoData": 0
  },
  "window": {
    "firstDate": null,
    "lastDate": null
  },
  "gaps": {
    "noIndustry": 0,
    "shortHistory": 0,
    "note": "行业/一字板历史等缺口由数据猎手补，取不到就标缺口，不得假设有值；资金流维度见 fundflow 字段（真实抓取，未覆盖样本标缺口，不填0）"
  },
  "portraitHighlights": [],
  "byMonth": [],
  "byIndustry": [],
  "fundflow": {
    "fetchedCodes": 5838,
    "joinRate": 0,
    "joinedRows": 0,
    "baseline": {
      "measuredNet": null,
      "measuredWinRate": null,
      "samples": 0,
      "costPct": 0.31
    },
    "status": {
      "fetchedCodes": 0,
      "coveragePct": 0,
      "unsupportedCodes": 0,
      "unsupportedReason": "",
      "failedCodes": 0
    },
    "batchStatus": {
      "source": "eastmoney datacenter-web RPT_DMSK_TS_FUNDFLOW (batch)",
      "mergedCodes": 5343,
      "stockCoveragePct": 100,
      "bjCodes": 332,
      "bjCovered": 332,
      "etfGapRows": 9551,
      "window": {
        "from": "2025-12-14",
        "to": "2026-11-23",
        "panelFrom": "2026-01-13",
        "lookbackDays": 30
      }
    },
    "etfStatus": {
      "source": "FTShare eastmoney-etf-flow (ETF 日资金流批量, 与 push2his 逐位一致)",
      "fetchedEtfCodes": 495,
      "etfCoveragePct": 71.66,
      "earlyGapRows": 873,
      "earlyGapNote": "2026-03-16 前 FTShare/push2his 均无 ETF 资金流数据，标缺口不填0",
      "window": {
        "from": "2026-03-16",
        "to": "2026-11-23",
        "dataStart": "2026-03-16"
      }
    },
    "highlights": []
  },
  "verified": {
    "modelCount": 6,
    "passedCount": 0,
    "notProvenCount": 4,
    "freeHypothesisCount": 1,
    "sealOk": true,
    "models": [
      {
        "id": "free_20261127_01",
        "thesis": "60日跌超19%且60日波动收缩比<0.738的深跌缩量票，杀跌动能衰竭后T+3修复概率更高",
        "origin": "llm_free",
        "modelType": "rule",
        "at": "2026-11-27 13:30",
        "verdict": "NOT_PROVEN",
        "reason": "未过门槛: 净收益、t≥3、覆盖率、Wilson下界、跑赢基准（历史回测，非前瞻收益）",
        "metrics": {
          "n": 0,
          "tradable": 0,
          "eligible": 0,
          "skippedOneWord": 0,
          "skippedNoData": 0,
          "coverage": 0,
          "benchmarkRet": null,
          "benchmarkSource": "none",
          "excessOverHold": null,
          "grossAvg": null,
          "costPct": 0.31,
          "netRet3": null,
          "winRate": null,
          "wilsonLower": null,
          "tStat": null,
          "worstSegmentNet": null,
          "segments": 0,
          "note": "信号级口径：每个T日信号都算钱；一字板剔除；扣往返成本0.31%；概率性结论非「正确」"
        }
      },
      {
        "id": "free_20261127_02",
        "thesis": "均线下方深跌(maGap60<-12.6%)且放量下跌背离(pvrDiv>4.5)的票，恐慌盘出尽后反弹",
        "origin": "llm_free",
        "modelType": "rule",
        "at": "2026-11-27 13:30",
        "verdict": "NOT_PROVEN",
        "reason": "未过门槛: 净收益、t≥3、覆盖率、Wilson下界、跑赢基准（历史回测，非前瞻收益）",
        "metrics": {
          "n": 0,
          "tradable": 0,
          "eligible": 0,
          "skippedOneWord": 0,
          "skippedNoData": 0,
          "coverage": 0,
          "benchmarkRet": null,
          "benchmarkSource": "none",
          "excessOverHold": null,
          "grossAvg": null,
          "costPct": 0.31,
          "netRet3": null,
          "winRate": null,
          "wilsonLower": null,
          "tStat": null,
          "worstSegmentNet": null,
          "segments": 0,
          "note": "信号级口径：每个T日信号都算钱；一字板剔除；扣往返成本0.31%；概率性结论非「正确」"
        }
      },
      {
        "id": "free_20261127_03",
        "thesis": "深跌后跳空高开(gapPct>0.53%)是资金回流的确认信号",
        "origin": "llm_free",
        "modelType": "rule",
        "at": "2026-11-27 13:30",
        "verdict": "NOT_PROVEN",
        "reason": "未过门槛: 净收益、t≥3、覆盖率、Wilson下界、跑赢基准（历史回测，非前瞻收益）",
        "metrics": {
          "n": 0,
          "tradable": 0,
          "eligible": 0,
          "skippedOneWord": 0,
          "skippedNoData": 0,
          "coverage": 0,
          "benchmarkRet": null,
          "benchmarkSource": "none",
          "excessOverHold": null,
          "grossAvg": null,
          "costPct": 0.31,
          "netRet3": null,
          "winRate": null,
          "wilsonLower": null,
          "tStat": null,
          "worstSegmentNet": null,
          "segments": 0,
          "note": "信号级口径：每个T日信号都算钱；一字板剔除；扣往返成本0.31%；概率性结论非「正确」"
        }
      },
      {
        "id": "free_20261127_04",
        "thesis": "造新特征 = 超跌幅度 × 缩量程度，综合打分选前20%",
        "origin": "llm_free",
        "modelType": "expression",
        "at": "2026-11-27 13:30",
        "verdict": "REJECT",
        "reason": "新特征未过可复现检查: 不可复现[freeDepth]: 无样本可验",
        "metrics": null
      },
      {
        "id": "free_20261127_05",
        "thesis": "追60日涨幅>9.3%且均线偏离>4.8%的强势票是最亏的，反向回避可提升整体",
        "origin": "llm_free",
        "modelType": "rule",
        "at": "2026-11-27 13:30",
        "verdict": "NOT_PROVEN",
        "reason": "未过门槛: 净收益、t≥3、覆盖率、Wilson下界、跑赢基准（历史回测，非前瞻收益）",
        "metrics": {
          "n": 0,
          "tradable": 0,
          "eligible": 0,
          "skippedOneWord": 0,
          "skippedNoData": 0,
          "coverage": 0,
          "benchmarkRet": null,
          "benchmarkSource": "none",
          "excessOverHold": null,
          "grossAvg": null,
          "costPct": 0.31,
          "netRet3": null,
          "winRate": null,
          "wilsonLower": null,
          "tStat": null,
          "worstSegmentNet": null,
          "segments": 0,
          "note": "信号级口径：每个T日信号都算钱；一字板剔除；扣往返成本0.31%；概率性结论非「正确」"
        }
      },
      {
        "id": "free_20261127_06",
        "thesis": "画像显示月度净收益差异巨大(8月+0.46%、11月-2.22%)，说明追启动策略的成败高度依赖大盘环境；应先判断市场状态(趋势/震荡/情绪周期)，只在情绪回升期启动，其余空仓",
        "origin": "llm_free",
        "modelType": "narrative",
        "at": "2026-11-27 13:30",
        "verdict": "FREE_HYPOTHESIS",
        "reason": "自由假设（叙事/无法直接执行的模型），尚未工程化为可回测规则；不计入「跑出模型」。",
        "metrics": null
      }
    ]
  },
  "dimensions": [
    {
      "key": "month",
      "name": "按月",
      "desc": "T收盘买→T+20收盘卖（约1个月）",
      "retKey": "d20",
      "baseline": {
        "netRet": null,
        "tStat": null,
        "winRate": null,
        "samples": 0,
        "coverage": 0,
        "note": ""
      },
      "modelCount": 0,
      "passedCount": 0,
      "notProvenCount": 0,
      "models": []
    },
    {
      "key": "week",
      "name": "按周",
      "desc": "T收盘买→T+5收盘卖（约1周）",
      "retKey": "d5",
      "baseline": {
        "netRet": null,
        "tStat": null,
        "winRate": null,
        "samples": 0,
        "coverage": 0,
        "note": ""
      },
      "modelCount": 0,
      "passedCount": 0,
      "notProvenCount": 0,
      "models": []
    },
    {
      "key": "day",
      "name": "按日",
      "desc": "T收盘买→T+1收盘卖（次日）",
      "retKey": "d1",
      "baseline": {
        "netRet": null,
        "tStat": null,
        "winRate": null,
        "samples": 0,
        "coverage": 0,
        "note": ""
      },
      "modelCount": 6,
      "passedCount": 0,
      "notProvenCount": 5,
      "models": [
        {
          "name": "超跌+缩量企稳",
          "thesis": "60日跌超19%且60日波动收缩比<0.738的深跌缩量票，杀跌动能衰竭后T+3修复概率更高",
          "verdict": "NOT_PROVEN",
          "reason": "未过门槛: 净收益、t≥3、覆盖率、Wilson下界、跑赢基准",
          "netRet": null,
          "tStat": null,
          "coverage": 0
        },
        {
          "name": "深跌破均线+量价背离",
          "thesis": "均线下方深跌(maGap60<-12.6%)且放量下跌背离(pvrDiv>4.5)的票，恐慌盘出尽后反弹",
          "verdict": "NOT_PROVEN",
          "reason": "未过门槛: 净收益、t≥3、覆盖率、Wilson下界、跑赢基准",
          "netRet": null,
          "tStat": null,
          "coverage": 0
        },
        {
          "name": "超跌+向上跳空",
          "thesis": "深跌后跳空高开(gapPct>0.53%)是资金回流的确认信号",
          "verdict": "NOT_PROVEN",
          "reason": "未过门槛: 净收益、t≥3、覆盖率、Wilson下界、跑赢基准",
          "netRet": null,
          "tStat": null,
          "coverage": 0
        },
        {
          "name": "避开追高(反向验证)",
          "thesis": "追60日涨幅>9.3%且均线偏离>4.8%的强势票是最亏的，反向回避可提升整体",
          "verdict": "NOT_PROVEN",
          "reason": "未过门槛: 净收益、t≥3、覆盖率、Wilson下界、跑赢基准",
          "netRet": null,
          "tStat": null,
          "coverage": 0
        },
        {
          "name": "市场状态机(待工程化)",
          "thesis": "画像显示月度净收益差异巨大(8月+0.46%、11月-2.22%)，说明追启动策略的成败高度依赖大盘环境；应先判断市场状态(趋势/震荡/情绪周期)，只在情绪回升期启动，其余空仓",
          "verdict": "NOT_PROVEN",
          "reason": "未过门槛: 净收益、t≥3、覆盖率、Wilson下界、跑赢基准",
          "netRet": null,
          "tStat": null,
          "coverage": 0
        }
      ]
    },
    {
      "key": "intradayT0",
      "name": "T0ETF·日内",
      "desc": "T开盘买→T收盘卖（仅T+0 ETF）",
      "retKey": "intra",
      "baseline": {
        "netRet": null,
        "tStat": null,
        "winRate": null,
        "samples": 0,
        "coverage": 0,
        "note": "仅放行名称命中跨境/黄金/债券/货币的T+0 ETF，其余标缺口不编造"
      },
      "modelCount": 0,
      "passedCount": 0,
      "notProvenCount": 0,
      "models": []
    }
  ],
  "horizonDisclaimer": "四维度收益来自真实 kline（月=T+20 / 周=T+5 / 日=T+1 / 日内=T开盘→收盘），已扣往返成本、剔除一字板；日内T0只对名称命中跨境/黄金/债券/货币的ETF放行。全部为历史回测，含幸存者偏差，非前瞻收益、不构成投资建议。",
  "oneLine": "",
  "lastModelAt": "2026-11-27 13:30"
};
