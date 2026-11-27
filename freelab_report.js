/* 自动生成 by tools/evolve/freelab/report.js，勿手改 */
window.AB_FREELAB_REPORT = {
  "summary": {
    "state": "自由推演实验室已就位：市场画像来自 100,877 条真实信号（扣0.31%成本、一字板剔除）；大模型已提 9 个模型，验证跑出 0 个 / 未证明 8 个。",
    "did": "把 100,949 条样本整理成「市场画像」——每个特征按真实取值分 5 档，逐档算信号级净收益/胜率/超额，再按月份、行业切片。让大模型读这份画像【自由推演】，不受六派种子/白名单草图约束，自己提出模型（可执行规则 / 新特征表达式 / 纯叙事假设皆可），然后用同一套真实结算器逐条验钱。",
    "result": "大模型提了 9 个模型，但真实结算后【0 个跑出可交易模型】——8 个栽在净收益/t值/覆盖率/跑赢基准上，1 个还是无法回测的叙事假设。这是诚实结论，不是没跑。",
    "direction": "自由度放在「假设」——鼓励大模型跨特征组合、造新表达式、提市场状态机/分域模型；严格度放在「验证」——任何模型都要过净收益>0、t≥3、覆盖率≥2%、Wilson下界、跑赢持有基准五关。现已按【按月 / 按周 / 按日 / T0ETF·日内】四维度分类推演：每维度用真实 kline 算自己的基准（月T+20、周T+5、日T+1、日内开盘→收盘），模型只在自己声明的维度上结算，不拿T+3的旧尺子量所有持有期。资金流维度已接入：真实抓取 5854 只票的逐日五档资金流，join 106,151 条样本（覆盖率 98.0%），派生主力净流入/超大单结构/资金加速度，供大模型推演；未覆盖样本一律标缺口。下一步继续补覆盖率、等资金流样本够厚后让它进模型验证链。"
  },
  "at": "2026-11-27",
  "generatedAt": "2026-11-27T10:33:33.094Z",
  "version": "freelab-v2-horizons",
  "model": "glm-5.3-flash",
  "dataAsOf": "20261127",
  "hasFacts": true,
  "hasRun": true,
  "disclaimer": "自由推演是【研究性实验】：大模型假设 + 历史回测，含幸存者偏差与过拟合风险，非实盘前瞻收益，不构成投资建议。与 v2 证据包自进化相互独立、互不影响。",
  "baseline": {
    "constitutionNet": -0.5671,
    "measuredNet": -0.2368,
    "measuredWinRate": 0.439,
    "samples": 100949,
    "tradable": 100877,
    "costPct": 0.31,
    "skippedOneWord": 72,
    "skippedNoData": 0
  },
  "window": {
    "firstDate": "2025-03-17",
    "lastDate": "2026-11-23"
  },
  "gaps": {
    "noIndustry": 461,
    "shortHistory": 1,
    "note": "行业/一字板历史等缺口由数据猎手补，取不到就标缺口，不得假设有值；资金流维度见 fundflow 字段（真实抓取，未覆盖样本标缺口，不填0）"
  },
  "portraitHighlights": [
    {
      "key": "volSqueeze60",
      "label": "60日波动收缩比",
      "spread": 0.39,
      "bestBucket": "1/5",
      "bestNet": -0.0371,
      "worstBucket": "5/5",
      "worstNet": -0.4271,
      "coverage": 0.9998
    },
    {
      "key": "ret20",
      "label": "20日涨幅",
      "spread": 0.3884,
      "bestBucket": "4/5",
      "bestNet": 0.0063,
      "worstBucket": "1/5",
      "worstNet": -0.3821,
      "coverage": 1
    },
    {
      "key": "pullback20",
      "label": "20日高点回撤",
      "spread": 0.3727,
      "bestBucket": "5/5",
      "bestNet": -0.0442,
      "worstBucket": "1/5",
      "worstNet": -0.4169,
      "coverage": 1
    },
    {
      "key": "maGap20",
      "label": "20日均线偏离",
      "spread": 0.3306,
      "bestBucket": "4/5",
      "bestNet": -0.0914,
      "worstBucket": "1/5",
      "worstNet": -0.422,
      "coverage": 1
    },
    {
      "key": "breakout20",
      "label": "20日突破幅度",
      "spread": 0.3199,
      "bestBucket": "5/5",
      "bestNet": -0.0924,
      "worstBucket": "1/5",
      "worstNet": -0.4123,
      "coverage": 1
    },
    {
      "key": "accel",
      "label": "资金加速度(万元)",
      "spread": 0.2949,
      "bestBucket": "2/5",
      "bestNet": -0.4991,
      "worstBucket": "5/5",
      "worstNet": -0.794,
      "coverage": 0.548
    }
  ],
  "byMonth": [
    {
      "key": "2025-04",
      "n": 2163,
      "net": 1.2072,
      "winRate": 0.5617
    },
    {
      "key": "2025-05",
      "n": 4882,
      "net": 0.0997,
      "winRate": 0.4404
    },
    {
      "key": "2025-06",
      "n": 5126,
      "net": 0.307,
      "winRate": 0.4867
    },
    {
      "key": "2025-07",
      "n": 5923,
      "net": 0.5494,
      "winRate": 0.5019
    },
    {
      "key": "2025-08",
      "n": 5406,
      "net": 0.6935,
      "winRate": 0.5115
    },
    {
      "key": "2025-09",
      "n": 5683,
      "net": -0.0373,
      "winRate": 0.4288
    },
    {
      "key": "2025-11",
      "n": 5181,
      "net": -0.4766,
      "winRate": 0.4152
    },
    {
      "key": "2025-12",
      "n": 5955,
      "net": 0.347,
      "winRate": 0.4746
    },
    {
      "key": "2026-01",
      "n": 5187,
      "net": 0.2272,
      "winRate": 0.4675
    },
    {
      "key": "2026-02",
      "n": 3654,
      "net": -0.0085,
      "winRate": 0.4795
    },
    {
      "key": "2026-03",
      "n": 5731,
      "net": -1.136,
      "winRate": 0.3795
    },
    {
      "key": "2026-04",
      "n": 5483,
      "net": 1.0787,
      "winRate": 0.5555
    },
    {
      "key": "2026-05",
      "n": 4714,
      "net": -1.3665,
      "winRate": 0.3169
    },
    {
      "key": "2026-06",
      "n": 5504,
      "net": -0.6944,
      "winRate": 0.3837
    },
    {
      "key": "2026-07",
      "n": 6057,
      "net": -0.9825,
      "winRate": 0.4468
    },
    {
      "key": "2026-08",
      "n": 5539,
      "net": 0.4979,
      "winRate": 0.4909
    },
    {
      "key": "2026-09",
      "n": 5552,
      "net": -0.8065,
      "winRate": 0.3878
    },
    {
      "key": "2026-11",
      "n": 4245,
      "net": -2.1727,
      "winRate": 0.3041
    },
    {
      "key": "2025-10",
      "n": 4384,
      "net": -0.0466,
      "winRate": 0.4621
    },
    {
      "key": "2026-10",
      "n": 4507,
      "net": -1.8052,
      "winRate": 0.3046
    }
  ],
  "byIndustry": [
    {
      "key": "影视",
      "n": 332,
      "net": 0.6444,
      "winRate": 0.4849
    },
    {
      "key": "营销服务",
      "n": 406,
      "net": 0.3949,
      "winRate": 0.4557
    },
    {
      "key": "地面装备",
      "n": 316,
      "net": 0.2827,
      "winRate": 0.4589
    },
    {
      "key": "矿山冶金机械",
      "n": 423,
      "net": 0.1679,
      "winRate": 0.4468
    },
    {
      "key": "化学新材料",
      "n": 496,
      "net": 0.12,
      "winRate": 0.5
    },
    {
      "key": "通信传输设备",
      "n": 901,
      "net": 0.0654,
      "winRate": 0.4606
    },
    {
      "key": "其他稀有小金属",
      "n": 367,
      "net": 0.035,
      "winRate": 0.4687
    },
    {
      "key": "燃气",
      "n": 491,
      "net": 0.0257,
      "winRate": 0.4786
    },
    {
      "key": "消费电子设备",
      "n": 720,
      "net": 0.018,
      "winRate": 0.4611
    },
    {
      "key": "仪器仪表",
      "n": 1402,
      "net": 0.0051,
      "winRate": 0.4536
    }
  ],
  "fundflow": {
    "fetchedCodes": 5854,
    "joinRate": 0.9798,
    "joinedRows": 106151,
    "baseline": {
      "measuredNet": -0.7648,
      "measuredWinRate": 0.4042,
      "samples": 106151,
      "costPct": 0.31
    },
    "status": {
      "fetchedCodes": 452,
      "coveragePct": 84.58,
      "unsupportedCodes": 0,
      "unsupportedReason": "北交所 secid 误判已修（0.920xxx 服务端实测可用）；个股/北交所已由 datacenter 批量报表覆盖，ETF 走本脚本逐票补抓",
      "failedCodes": 6
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
    "highlights": [
      {
        "key": "accel",
        "label": "主力资金加速度(万元)",
        "coverage": 0.9804,
        "spread": 0.2594,
        "bestBucket": "2/5",
        "bestNet": -0.6571,
        "worstBucket": "5/5",
        "worstNet": -0.9165
      },
      {
        "key": "main5",
        "label": "近5日主力净流入(万元)",
        "coverage": 0.9804,
        "spread": 0.2488,
        "bestBucket": "4/5",
        "bestNet": -0.6595,
        "worstBucket": "1/5",
        "worstNet": -0.9083
      },
      {
        "key": "superRatio5",
        "label": "超大单占主力比",
        "coverage": 0.9799,
        "spread": 0.1687,
        "bestBucket": "5/5",
        "bestNet": -0.6669,
        "worstBucket": "2/5",
        "worstNet": -0.8356
      },
      {
        "key": "mainPctT",
        "label": "当日主力净占比(%)",
        "coverage": 0.9804,
        "spread": 0.1549,
        "bestBucket": "5/5",
        "bestNet": -0.6817,
        "worstBucket": "4/5",
        "worstNet": -0.8366
      }
    ]
  },
  "verified": {
    "modelCount": 9,
    "passedCount": 0,
    "notProvenCount": 8,
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
        "reason": "未过门槛: 净收益、t≥3、Wilson下界（历史回测，非前瞻收益）",
        "metrics": {
          "n": 4087,
          "tradable": 4087,
          "eligible": 100877,
          "skippedOneWord": 72,
          "skippedNoData": 0,
          "coverage": 4.05,
          "benchmarkRet": -1.312,
          "benchmarkSource": "CSI300_ETF",
          "excessOverHold": 1.1804,
          "grossAvg": 0.17838757034499647,
          "costPct": 0.31,
          "netRet3": -0.1316,
          "winRate": 0.4659,
          "wilsonLower": 0.4506,
          "tStat": -1.587,
          "worstSegmentNet": -3.4904,
          "segments": 20,
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
        "reason": "未过门槛: t≥3、覆盖率、Wilson下界（历史回测，非前瞻收益）",
        "metrics": {
          "n": 1045,
          "tradable": 1045,
          "eligible": 100877,
          "skippedOneWord": 72,
          "skippedNoData": 0,
          "coverage": 1.04,
          "benchmarkRet": -1.312,
          "benchmarkSource": "CSI300_ETF",
          "excessOverHold": 1.6103,
          "grossAvg": 0.6082631578947377,
          "costPct": 0.31,
          "netRet3": 0.2983,
          "winRate": 0.5139,
          "wilsonLower": 0.4836,
          "tStat": 1.471,
          "worstSegmentNet": -3.3259,
          "segments": 20,
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
        "reason": "未过门槛: 净收益、t≥3、Wilson下界（历史回测，非前瞻收益）",
        "metrics": {
          "n": 2201,
          "tradable": 2201,
          "eligible": 100877,
          "skippedOneWord": 72,
          "skippedNoData": 0,
          "coverage": 2.18,
          "benchmarkRet": -1.312,
          "benchmarkSource": "CSI300_ETF",
          "excessOverHold": 1.0395,
          "grossAvg": 0.03752794184461662,
          "costPct": 0.31,
          "netRet3": -0.2725,
          "winRate": 0.453,
          "wilsonLower": 0.4323,
          "tStat": -2.083,
          "worstSegmentNet": -2.4829,
          "segments": 21,
          "note": "信号级口径：每个T日信号都算钱；一字板剔除；扣往返成本0.31%；概率性结论非「正确」"
        }
      },
      {
        "id": "free_20261127_04",
        "thesis": "造新特征 = 超跌幅度 × 缩量程度，综合打分选前20%",
        "origin": "llm_free",
        "modelType": "expression",
        "at": "2026-11-27 13:30",
        "verdict": "NOT_PROVEN",
        "reason": "未过门槛: 净收益、t≥3、Wilson下界（历史回测，非前瞻收益）",
        "metrics": {
          "n": 4087,
          "tradable": 4087,
          "eligible": 100877,
          "skippedOneWord": 72,
          "skippedNoData": 0,
          "coverage": 4.05,
          "benchmarkRet": -1.312,
          "benchmarkSource": "CSI300_ETF",
          "excessOverHold": 1.1804,
          "grossAvg": 0.17838757034499647,
          "costPct": 0.31,
          "netRet3": -0.1316,
          "winRate": 0.4659,
          "wilsonLower": 0.4506,
          "tStat": -1.587,
          "worstSegmentNet": -3.4904,
          "segments": 20,
          "note": "信号级口径：每个T日信号都算钱；一字板剔除；扣往返成本0.31%；概率性结论非「正确」"
        }
      },
      {
        "id": "free_20261127_05",
        "thesis": "追60日涨幅>9.3%且均线偏离>4.8%的强势票是最亏的，反向回避可提升整体",
        "origin": "llm_free",
        "modelType": "rule",
        "at": "2026-11-27 13:30",
        "verdict": "NOT_PROVEN",
        "reason": "未过门槛: 净收益、t≥3、Wilson下界（历史回测，非前瞻收益）",
        "metrics": {
          "n": 21810,
          "tradable": 21810,
          "eligible": 100877,
          "skippedOneWord": 72,
          "skippedNoData": 0,
          "coverage": 21.62,
          "benchmarkRet": -1.312,
          "benchmarkSource": "CSI300_ETF",
          "excessOverHold": 1.1959,
          "grossAvg": 0.19386712517194182,
          "costPct": 0.31,
          "netRet3": -0.1161,
          "winRate": 0.4374,
          "wilsonLower": 0.4308,
          "tStat": -2.377,
          "worstSegmentNet": -5.5997,
          "segments": 20,
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
      },
      {
        "id": "ff_20261127_01",
        "thesis": "近5日主力净流入在[-93,971]万温和区(画像最好档net-0.66)且60日跌超12%,避开大幅流出与爆炒区",
        "origin": "profile_seed",
        "modelType": "rule",
        "at": "2026-11-27 17:29",
        "verdict": "NOT_PROVEN",
        "reason": "未过门槛: 净收益、t≥3、Wilson下界（历史回测，非前瞻收益）",
        "metrics": {
          "n": 3730,
          "tradable": 3730,
          "eligible": 100877,
          "skippedOneWord": 72,
          "skippedNoData": 0,
          "coverage": 3.7,
          "benchmarkRet": -1.312,
          "benchmarkSource": "CSI300_ETF",
          "excessOverHold": 0.8387,
          "grossAvg": -0.16328176943699596,
          "costPct": 0.31,
          "netRet3": -0.4733,
          "winRate": 0.4271,
          "wilsonLower": 0.4113,
          "tStat": -5.552,
          "worstSegmentNet": -2.7261,
          "segments": 12,
          "note": "信号级口径：每个T日信号都算钱；一字板剔除；扣往返成本0.31%；概率性结论非「正确」"
        }
      },
      {
        "id": "ff_20261127_02",
        "thesis": "加速度[-318,584]万(画像第3档-0.675)且超大单占比>0.53(第5档最好-0.666),机构温和吸筹",
        "origin": "profile_seed",
        "modelType": "rule",
        "at": "2026-11-27 17:29",
        "verdict": "NOT_PROVEN",
        "reason": "未过门槛: 净收益、t≥3、覆盖率、Wilson下界（历史回测，非前瞻收益）",
        "metrics": {
          "n": 1950,
          "tradable": 1950,
          "eligible": 100877,
          "skippedOneWord": 72,
          "skippedNoData": 0,
          "coverage": 1.93,
          "benchmarkRet": -1.312,
          "benchmarkSource": "CSI300_ETF",
          "excessOverHold": 0.8609,
          "grossAvg": -0.14110923076922915,
          "costPct": 0.31,
          "netRet3": -0.4511,
          "winRate": 0.419,
          "wilsonLower": 0.3973,
          "tStat": -4.046,
          "worstSegmentNet": -1.7155,
          "segments": 12,
          "note": "信号级口径：每个T日信号都算钱；一字板剔除；扣往返成本0.31%；概率性结论非「正确」"
        }
      },
      {
        "id": "ff_20261127_03",
        "thesis": "主力净占比[-7.78,0.04]%(第2/3档较好)且60日超跌,避开主力大幅出逃和涨停爆炒",
        "origin": "profile_seed",
        "modelType": "rule",
        "at": "2026-11-27 17:29",
        "verdict": "NOT_PROVEN",
        "reason": "未过门槛: 净收益、t≥3、Wilson下界（历史回测，非前瞻收益）",
        "metrics": {
          "n": 7577,
          "tradable": 7577,
          "eligible": 100877,
          "skippedOneWord": 72,
          "skippedNoData": 0,
          "coverage": 7.51,
          "benchmarkRet": -1.312,
          "benchmarkSource": "CSI300_ETF",
          "excessOverHold": 0.7364,
          "grossAvg": -0.265556552725352,
          "costPct": 0.31,
          "netRet3": -0.5756,
          "winRate": 0.4297,
          "wilsonLower": 0.4186,
          "tStat": -9.217,
          "worstSegmentNet": -2.7803,
          "segments": 12,
          "note": "信号级口径：每个T日信号都算钱；一字板剔除；扣往返成本0.31%；概率性结论非「正确」"
        }
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
        "netRet": 0.5276,
        "tStat": 10.935,
        "winRate": 0.4724,
        "samples": 96362,
        "coverage": 100,
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
        "netRet": -0.0486,
        "tStat": -2.158,
        "winRate": 0.4575,
        "samples": 96362,
        "coverage": 100,
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
        "netRet": -0.2755,
        "tStat": -28.571,
        "winRate": 0.4159,
        "samples": 96362,
        "coverage": 100,
        "note": ""
      },
      "modelCount": 9,
      "passedCount": 0,
      "notProvenCount": 9,
      "models": [
        {
          "name": "避开追高(反向验证)",
          "thesis": "追60日涨幅>9.3%且均线偏离>4.8%的强势票是最亏的，反向回避可提升整体",
          "verdict": "NOT_PROVEN",
          "reason": "未过门槛: 净收益、t≥3、Wilson下界",
          "netRet": -0.2626,
          "tStat": -9.778,
          "coverage": 22.39
        },
        {
          "name": "资金加速度温和+超大单占优",
          "thesis": "加速度[-318,584]万(画像第3档-0.675)且超大单占比>0.53(第5档最好-0.666),机构温和吸筹",
          "verdict": "NOT_PROVEN",
          "reason": "未过门槛: 净收益、t≥3、覆盖率、Wilson下界、跑赢基准",
          "netRet": null,
          "tStat": null,
          "coverage": 0
        },
        {
          "name": "主力温和区+超跌",
          "thesis": "近5日主力净流入在[-93,971]万温和区(画像最好档net-0.66)且60日跌超12%,避开大幅流出与爆炒区",
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
          "reason": "未过门槛: 净收益、t≥3、Wilson下界",
          "netRet": -0.2755,
          "tStat": -28.571,
          "coverage": 100
        },
        {
          "name": "避开资金极端+主力净占比温和",
          "thesis": "主力净占比[-7.78,0.04]%(第2/3档较好)且60日超跌,避开主力大幅出逃和涨停爆炒",
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
        "netRet": -0.2654,
        "tStat": -8.979,
        "winRate": 0.1845,
        "samples": 905,
        "coverage": 100,
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
  "lastModelAt": "2026-11-27 17:29"
};
