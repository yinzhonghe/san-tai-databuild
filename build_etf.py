#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三态看盘 · ETF 同类去重（全网 ETF → 每个主题只留一只）
=======================================================
现状：原先 data.js 里只有 54 只 ETF（历史遗留），而全网实际约 900+ 只。
同一主题往往有 5~10 只不同公司发的 ETF（比如「沪深300ETF」有十几只），
全部列出来只会把看板淹掉，因此按主题聚合，每个主题只保留一只代表。

去重规则（按用户口径，能做的部分优先做对）：
  1) 先按「主题」分组：从基金简称里剥掉 ETF 后缀与基金公司简称；
  2) 组内优先选**费率最低**的 —— 费率取自基金档案字段 fund_Rate / fund_sourceRate；
  3) 费率相同或都取不到时，选**规模最大**（用流通市值 nmc / 总市值 mktcap，单位万元）。

诚实说明：天天基金 pingzhongdata 接口对不少 ETF 返回空费率字符串，且单只响应约 200KB，
900 只全量抓取不现实。因此只对「同一主题下有多只」的组，抓规模前 3 名的费率做比较；
仍取不到就按规模定，并在输出里标注 source=size，前端会显示「按规模」。

用法：
  python tools/build_etf.py              # 生成 _etf_pick.json
  python tools/build_etf.py --no-fee     # 跳过费率抓取（更快，纯按规模）
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

TOOLS = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(TOOLS)
OUT = os.path.join(SITE, "_etf_pick.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
REF = "https://finance.sina.com.cn"

# 基金公司简称：用于从简称里剥离，得到「主题」
COMPANIES = [
    "易方达", "广发", "华夏", "华泰柏瑞", "南方", "嘉实", "富国", "天弘", "国泰", "银华",
    "工银", "招商", "汇添富", "博时", "鹏华", "平安", "建信", "交银", "中银", "浦银",
    "兴全", "景顺", "华宝", "国联安", "万家", "中欧", "华安", "大成", "融通", "长城",
    "长盛", "宝盈", "上投", "海富通", "兴业", "民生", "方正", "中信保诚", "国联", "西部利得",
    "前海开源", "泰康", "新华", "中加", "金鹰", "诺安", "东财", "华富", "德邦", "红土",
    "永赢", "中融", "国寿安保", "泰达宏利", "农银", "汇安", "恒生前海", "创金合信", "蜂巢",
]


def http_get(url, referer=REF, timeout=15, retries=1):
    for i in range(retries + 1):
        try:
            p = subprocess.run(["curl", "-s", "-m", str(timeout), "-A", UA,
                                "-H", "Referer: " + referer, url], capture_output=True)
            if p.returncode == 0 and p.stdout:
                return p.stdout.decode("utf-8", "ignore")
        except FileNotFoundError:
            break
        time.sleep(0.3 * (i + 1))
    return None


def fetch_all_etf():
    """新浪 etf_hq_fund 分页 → [{code,name,nmc,mktcap}]（nmc/mktcap 单位：万元）。"""
    out, page = [], 1
    while page <= 20:
        url = ("https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/"
               "Market_Center.getHQNodeData?page=%d&num=100&sort=symbol&asc=1"
               "&node=etf_hq_fund&symbol=&_s_r_a=page" % page)
        txt = http_get(url)
        if not txt:
            break
        try:
            arr = json.loads(txt)
        except Exception:
            break
        if not arr:
            break
        for r in arr:
            sym = str(r.get("symbol") or "").lower()
            bare = str(r.get("code") or "").strip()
            name = str(r.get("name") or "").strip()
            if not re.match(r"^\d{6}$", bare) or not name or sym[:2] not in ("sh", "sz"):
                continue
            try:
                nmc = float(r.get("nmc") or 0)
            except (TypeError, ValueError):
                nmc = 0.0
            try:
                mktcap = float(r.get("mktcap") or 0)
            except (TypeError, ValueError):
                mktcap = 0.0
            out.append({"code": bare + "." + sym[:2].upper(), "name": name,
                        "nmc": nmc, "mktcap": mktcap})
        if len(arr) < 100:
            break
        page += 1
        time.sleep(0.05)
    return out


def theme_of(name):
    """从「180治理ETF交银」/「人工智能ETF易方达」里剥出主题「180治理」/「人工智能」。"""
    t = re.sub(r"\s+", "", name or "")
    t = re.split(r"ETF|etf|ＥＴＦ", t)[0] or t      # ETF 之后一般跟公司名/联接
    for c in COMPANIES:                             # 兜底：去掉可能出现在主题后的公司名
        if t.endswith(c):
            t = t[: -len(c)]
            break
    t = re.sub(r"(联接|增强|指数|基金|发起式|LOF)$", "", t)
    return t or name


def fetch_fee(bare):
    """基金档案里的现费率/原费率（%）。取不到返回 None。"""
    txt = http_get("https://fund.eastmoney.com/pingzhongdata/%s.js" % bare,
                   referer="https://fund.eastmoney.com/", timeout=12)
    if not txt:
        return None
    m = re.search(r'var\s+fund_Rate\s*=\s*"([\d.]*)"', txt)
    if m and m.group(1):
        try:
            return float(m.group(1))
        except ValueError:
            pass
    m = re.search(r'var\s+fund_sourceRate\s*=\s*"([\d.]*)"', txt)
    if m and m.group(1):
        try:
            return float(m.group(1))
        except ValueError:
            pass
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-fee", action="store_true", help="跳过费率抓取，纯按规模")
    ap.add_argument("--threads", type=int, default=6)
    args = ap.parse_args()

    rows = fetch_all_etf()
    if not rows:
        print("未取到 ETF 列表（新浪接口不可达）")
        return 1
    print("全网 ETF：%d 只" % len(rows))

    groups = {}
    for r in rows:
        groups.setdefault(theme_of(r["name"]), []).append(r)
    print("按主题聚类：%d 组（平均每组 %.1f 只）" % (len(groups), len(rows) / len(groups)))

    picks = []
    multi = [g for g in groups.values() if len(g) > 1]
    print("多只同主题的组：%d 组，开始比较费率/规模…" % len(multi))

    def choose(g):
        g = sorted(g, key=lambda x: -(x["nmc"] or x["mktcap"] or 0))
        if len(g) == 1 or args.no_fee:
            return g[0], None, "size"
        # 只对规模前 3 名抓费率，控制请求量
        cand = g[:3]
        fees = {}
        for c in cand:
            f = fetch_fee(c["code"].split(".")[0])
            if f is not None:
                fees[c["code"]] = f
        if fees:
            best_code = min(sorted(fees.keys()), key=lambda k: (fees[k], -next(
                x["nmc"] for x in cand if x["code"] == k)))
            best = next(x for x in cand if x["code"] == best_code)
            return best, fees[best_code], "fee"
        return g[0], None, "size"

    with ThreadPoolExecutor(max_workers=args.threads) as ex:
        for best, fee, src in ex.map(choose, multi):
            best["theme"] = theme_of(best["name"])
            best["fee"] = fee
            best["pickBy"] = src
            best["groupSize"] = len(groups[best["theme"]])
            picks.append(best)
    for g in groups.values():
        if len(g) == 1:
            x = g[0]
            x["theme"] = theme_of(x["name"])
            x["fee"] = None
            x["pickBy"] = "only"
            x["groupSize"] = 1
            picks.append(x)

    for p in picks:
        p["mcap"] = round((p.get("mktcap") or 0) / 1e4, 2)   # 万元 → 亿元（与股票口径一致）
    picks.sort(key=lambda x: -(x["nmc"] or 0))
    json.dump(picks, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
    by_fee = sum(1 for p in picks if p["pickBy"] == "fee")
    print("去重后保留 %d 只（按费率选定 %d 只 / 按规模选定 %d 只）"
          % (len(picks), by_fee, len(picks) - by_fee))
    print("已写出 %s" % OUT)
    print("示例：", [(p["name"], p["theme"], p["groupSize"], p["pickBy"]) for p in picks[:5]])
    return 0


if __name__ == "__main__":
    sys.exit(main())
