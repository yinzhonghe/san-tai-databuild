/* 自动生成 by tools/evolve/freelab/report.js，勿手改 */
window.AB_FREELAB_REPORT = {
  "summary": {
    "state": "自由推演实验室已就位：市场画像来自 108,271 条真实信号（扣0.31%成本、一字板剔除）；大模型已提 6 个模型，验证跑出 0 个 / 未证明 5 个。",
    "did": "把 108,338 条样本整理成「市场画像」——每个特征按真实取值分 5 档，逐档算信号级净收益/胜率/超额，再按月份、行业切片。让大模型读这份画像【自由推演】，不受六派种子/白名单草图约束，自己提出模型（可执行规则 / 新特征表达式 / 纯叙事假设皆可），然后用同一套真实结算器逐条验钱。",
    "result": "大模型提了 6 个模型，但真实结算后【0 个跑出可交易模型】——5 个栽在净收益/t值/覆盖率/跑赢基准上，1 个还是无法回测的叙事假设。这是诚实结论，不是没跑。",
    "direction": "自由度放在「假设」——鼓励大模型跨特征组合、造新表达式、提市场状态机/分域模型；严格度放在「验证」——任何模型都要过净收益>0、t≥3、覆盖率≥2%、Wilson下界、跑赢持有基准五关。现已按【按月 / 按周 / 按日 / T0ETF·日内】四维度分类推演：每维度用真实 kline 算自己的基准（月T+20、周T+5、日T+1、日内开盘→收盘），模型只在自己声明的维度上结算，不拿T+3的旧尺子量所有持有期。资金流维度已接入：真实抓取 15 只票的逐日五档资金流，join 165 条样本（覆盖率 0.1%），派生主力净流入/超大单结构/资金加速度，供大模型推演；未覆盖样本一律标缺口。下一步继续补覆盖率、等资金流样本够厚后让它进模型验证链。"
  },
  "at": "2026-11-27",
  "generatedAt": "2026-11-27T06:44:15.597Z",
  "version": "freelab-v2-horizons",
  "model": "glm-5.3-flash",
  "dataAsOf": "20261126",
  "hasFacts": true,
  "hasRun": true,
  "disclaimer": "自由推演是【研究性实验】：大模型假设 + 历史回测，含幸存者偏差与过拟合风险，非实盘前瞻收益，不构成投资建议。与 v2 证据包自进化相互独立、互不影响。",
  "baseline": {
    "constitutionNet": -0.5671,
    "measuredNet": -0.7589,
    "measuredWinRate": 0.4038,
    "samples": 108338,
    "tradable": 108271,
    "costPct": 0.31,
    "skippedOneWord": 67,
    "skippedNoData": 0
  },
  "window": {
    "firstDate": "2026-01-13",
    "lastDate": "2026-11-23"
  },
  "gaps": {
    "noIndustry": 461,
    "shortHistory": 1,
    "note": "行业/一字板历史等缺口由数据猎手补，取不到就标缺口，不得假设有值；资金流维度见 fundflow 字段（真实抓取，未覆盖样本标缺口，不填0）"
  },
  "portraitHighlights": [
    {
      "key": "ret60",
      "label": "60日涨幅",
      "spread": 0.7107,
      "bestBucket": "1/5",
      "bestNet": -0.4306,
      "worstBucket": "5/5",
      "worstNet": -1.1413,
      "coverage": 1
    },
    {
      "key": "volSqueeze60",
      "label": "60日波动收缩比",
      "spread": 0.5521,
      "bestBucket": "1/5",
      "bestNet": -0.4855,
      "worstBucket": "5/5",
      "worstNet": -1.0376,
      "coverage": 0.9998
    },
    {
      "key": "pvrDiv",
      "label": "量价背离度",
      "spread": 0.4986,
      "bestBucket": "5/5",
      "bestNet": -0.4428,
      "worstBucket": "3/5",
      "worstNet": -0.9414,
      "coverage": 1
    },
    {
      "key": "gapPct",
      "label": "跳空幅度",
      "spread": 0.4358,
      "bestBucket": "5/5",
      "bestNet": -0.4821,
      "worstBucket": "4/5",
      "worstNet": -0.9179,
      "coverage": 1
    },
    {
      "key": "maGap60",
      "label": "60日均线偏离",
      "spread": 0.4336,
      "bestBucket": "1/5",
      "bestNet": -0.4625,
      "worstBucket": "5/5",
      "worstNet": -0.8961,
      "coverage": 1
    },
    {
      "key": "ret20",
      "label": "20日涨幅",
      "spread": 0.4171,
      "bestBucket": "1/5",
      "bestNet": -0.5521,
      "worstBucket": "2/5",
      "worstNet": -0.9692,
      "coverage": 1
    }
  ],
  "byMonth": [
    {
      "key": "2026-02",
      "n": 4103,
      "net": -0.7396,
      "winRate": 0.4311
    },
    {
      "key": "2026-03",
      "n": 12611,
      "net": -1.0643,
      "winRate": 0.3866
    },
    {
      "key": "2026-04",
      "n": 12070,
      "net": 1.0842,
      "winRate": 0.5529
    },
    {
      "key": "2026-05",
      "n": 10387,
      "net": -1.155,
      "winRate": 0.3275
    },
    {
      "key": "2026-06",
      "n": 12107,
      "net": -0.7281,
      "winRate": 0.3862
    },
    {
      "key": "2026-07",
      "n": 13321,
      "net": -1.0789,
      "winRate": 0.4407
    },
    {
      "key": "2026-08",
      "n": 12186,
      "net": 0.4587,
      "winRate": 0.4911
    },
    {
      "key": "2026-09",
      "n": 12218,
      "net": -0.76,
      "winRate": 0.3861
    },
    {
      "key": "2026-10",
      "n": 9908,
      "net": -1.9393,
      "winRate": 0.2905
    },
    {
      "key": "2026-11",
      "n": 9337,
      "net": -2.2167,
      "winRate": 0.3065
    }
  ],
  "byIndustry": [
    {
      "key": "养殖",
      "n": 356,
      "net": 0.0307,
      "winRate": 0.4579
    },
    {
      "key": "光学元件",
      "n": 753,
      "net": -0.0189,
      "winRate": 0.4635
    },
    {
      "key": "机床设备",
      "n": 393,
      "net": -0.0543,
      "winRate": 0.4631
    },
    {
      "key": "煤炭开采洗选",
      "n": 525,
      "net": -0.0716,
      "winRate": 0.4724
    },
    {
      "key": "LED",
      "n": 408,
      "net": -0.1702,
      "winRate": 0.473
    },
    {
      "key": "股份制与城商行",
      "n": 694,
      "net": -0.1888,
      "winRate": 0.4452
    },
    {
      "key": "化学新材料",
      "n": 549,
      "net": -0.2366,
      "winRate": 0.439
    },
    {
      "key": "其他非银行金融",
      "n": 335,
      "net": -0.321,
      "winRate": 0.4567
    },
    {
      "key": "新能源发电",
      "n": 416,
      "net": -0.3764,
      "winRate": 0.4111
    },
    {
      "key": "火电",
      "n": 597,
      "net": -0.3841,
      "winRate": 0.4489
    }
  ],
  "fundflow": {
    "fetchedCodes": 15,
    "joinRate": 0.0015,
    "joinedRows": 165,
    "baseline": {
      "measuredNet": -0.9921,
      "measuredWinRate": 0.4121,
      "samples": 165,
      "costPct": 0.31
    },
    "status": {
      "fetchedCodes": 12,
      "coveragePct": 0.21,
      "unsupportedCodes": 332,
      "unsupportedReason": "北交所 secid 映射暂不通（0./1. 实测 HTTP000），标缺口不编造",
      "failedCodes": 0
    },
    "highlights": [
      {
        "key": "accel",
        "label": "主力资金加速度(万元)",
        "coverage": 0.0015,
        "spread": 4.22,
        "bestBucket": "4/5",
        "bestNet": 0.5188,
        "worstBucket": "5/5",
        "worstNet": -3.7012
      },
      {
        "key": "superRatio5",
        "label": "超大单占主力比",
        "coverage": 0.0015,
        "spread": 2.5994,
        "bestBucket": "2/5",
        "bestNet": 0.6627,
        "worstBucket": "5/5",
        "worstNet": -1.9367
      },
      {
        "key": "main5",
        "label": "近5日主力净流入(万元)",
        "coverage": 0.0015,
        "spread": 2.4515,
        "bestBucket": "4/5",
        "bestNet": -0.1873,
        "worstBucket": "5/5",
        "worstNet": -2.6388
      },
      {
        "key": "mainPctT",
        "label": "当日主力净占比(%)",
        "coverage": 0.0015,
        "spread": 1.2532,
        "bestBucket": "3/5",
        "bestNet": -0.4848,
        "worstBucket": "4/5",
        "worstNet": -1.738
      }
    ]
  },
  "verified": {
    "modelCount": 6,
    "passedCount": 0,
    "notProvenCount": 5,
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
          "n": 6948,
          "tradable": 6948,
          "eligible": 108271,
          "skippedOneWord": 67,
          "skippedNoData": 0,
          "coverage": 6.42,
          "benchmarkRet": -0.214,
          "benchmarkSource": "CSI300_ETF",
          "excessOverHold": 0.0585,
          "grossAvg": 0.1544589810017278,
          "costPct": 0.31,
          "netRet3": -0.1555,
          "winRate": 0.4617,
          "wilsonLower": 0.45,
          "tStat": -2.385,
          "worstSegmentNet": -3.9069,
          "segments": 10,
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
        "reason": "未过门槛: 覆盖率（历史回测，非前瞻收益）",
        "metrics": {
          "n": 2142,
          "tradable": 2142,
          "eligible": 108271,
          "skippedOneWord": 67,
          "skippedNoData": 0,
          "coverage": 1.98,
          "benchmarkRet": -0.214,
          "benchmarkSource": "CSI300_ETF",
          "excessOverHold": 0.9251,
          "grossAvg": 1.0210541549953323,
          "costPct": 0.31,
          "netRet3": 0.7111,
          "winRate": 0.5677,
          "wilsonLower": 0.5466,
          "tStat": 4.931,
          "worstSegmentNet": -3.0689,
          "segments": 10,
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
          "n": 4321,
          "tradable": 4321,
          "eligible": 108271,
          "skippedOneWord": 67,
          "skippedNoData": 0,
          "coverage": 3.99,
          "benchmarkRet": -0.214,
          "benchmarkSource": "CSI300_ETF",
          "excessOverHold": 0.0925,
          "grossAvg": 0.18850034714186553,
          "costPct": 0.31,
          "netRet3": -0.1215,
          "winRate": 0.4571,
          "wilsonLower": 0.4423,
          "tStat": -1.257,
          "worstSegmentNet": -2.6208,
          "segments": 10,
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
          "n": 6948,
          "tradable": 6948,
          "eligible": 108271,
          "skippedOneWord": 67,
          "skippedNoData": 0,
          "coverage": 6.42,
          "benchmarkRet": -0.214,
          "benchmarkSource": "CSI300_ETF",
          "excessOverHold": 0.0585,
          "grossAvg": 0.1544589810017278,
          "costPct": 0.31,
          "netRet3": -0.1555,
          "winRate": 0.4617,
          "wilsonLower": 0.45,
          "tStat": -2.385,
          "worstSegmentNet": -3.9069,
          "segments": 10,
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
        "reason": "未过门槛: 净收益、t≥3、Wilson下界、跑赢基准（历史回测，非前瞻收益）",
        "metrics": {
          "n": 15003,
          "tradable": 15003,
          "eligible": 108271,
          "skippedOneWord": 67,
          "skippedNoData": 0,
          "coverage": 13.86,
          "benchmarkRet": -0.214,
          "benchmarkSource": "CSI300_ETF",
          "excessOverHold": -0.7247,
          "grossAvg": -0.6287091248416993,
          "costPct": 0.31,
          "netRet3": -0.9387,
          "winRate": 0.3989,
          "wilsonLower": 0.391,
          "tStat": -13.987,
          "worstSegmentNet": -6.4549,
          "segments": 11,
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
        "netRet": -2.6194,
        "tStat": -53.76,
        "winRate": 0.3635,
        "samples": 98333,
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
        "netRet": -0.8295,
        "tStat": -34.227,
        "winRate": 0.404,
        "samples": 98333,
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
        "netRet": -0.4363,
        "tStat": -41.256,
        "winRate": 0.4089,
        "samples": 98333,
        "coverage": 100,
        "note": ""
      },
      "modelCount": 6,
      "passedCount": 0,
      "notProvenCount": 6,
      "models": [
        {
          "name": "深跌破均线+量价背离",
          "thesis": "均线下方深跌(maGap60<-12.6%)且放量下跌背离(pvrDiv>4.5)的票，恐慌盘出尽后反弹",
          "verdict": "NOT_PROVEN",
          "reason": "未过门槛: t≥3、覆盖率、Wilson下界",
          "netRet": 0.0304,
          "tStat": 0.39,
          "coverage": 1.97
        },
        {
          "name": "超跌+向上跳空",
          "thesis": "深跌后跳空高开(gapPct>0.53%)是资金回流的确认信号",
          "verdict": "NOT_PROVEN",
          "reason": "未过门槛: t≥3、Wilson下界",
          "netRet": 0.024,
          "tStat": 0.427,
          "coverage": 3.85
        },
        {
          "name": "超跌强度综合打分(新特征)",
          "thesis": "造新特征 = 超跌幅度 × 缩量程度，综合打分选前20%",
          "verdict": "NOT_PROVEN",
          "reason": "未过门槛: 净收益、t≥3、Wilson下界",
          "netRet": -0.1466,
          "tStat": -3.927,
          "coverage": 6.61
        },
        {
          "name": "市场状态机(待工程化)",
          "thesis": "画像显示月度净收益差异巨大(8月+0.46%、11月-2.22%)，说明追启动策略的成败高度依赖大盘环境；应先判断市场状态(趋势/震荡/情绪周期)，只在情绪回升期启动，其余空仓",
          "verdict": "NOT_PROVEN",
          "reason": "未过门槛: 净收益、t≥3、Wilson下界",
          "netRet": -0.4363,
          "tStat": -41.256,
          "coverage": 100
        },
        {
          "name": "避开追高(反向验证)",
          "thesis": "追60日涨幅>9.3%且均线偏离>4.8%的强势票是最亏的，反向回避可提升整体",
          "verdict": "NOT_PROVEN",
          "reason": "未过门槛: 净收益、t≥3、Wilson下界、跑赢基准",
          "netRet": -0.5203,
          "tStat": -13.64,
          "coverage": 14.71
        }
      ]
    },
    {
      "key": "intradayT0",
      "name": "T0ETF·日内",
      "desc": "T开盘买→T收盘卖（仅T+0 ETF）",
      "retKey": "intra",
      "baseline": {
        "netRet": -0.3744,
        "tStat": -10.525,
        "winRate": 0.1743,
        "samples": 918,
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
  "lastModelAt": "2026-11-27 13:30"
};
