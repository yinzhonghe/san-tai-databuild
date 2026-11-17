#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三态看盘 · 行业归属补全（新浪行业分类，免费零依赖）
==================================================
东财行业接口在部分网络会整段拒绝（返回 000），本脚本改用新浪行业分类：
  1) newSinaHy.php 拿全部行业（代码 / 名称 / 成分股数）
  2) 逐个行业拉成分股（分页）→ 得到 代码 → 行业名 的映射

产出 `_ind_map.json`（{ "600000.SH": "银行行业" }），build_data.py 会自动读取，
从而让 data.js 的每只标的带上 ind，行业页/成分股下钻恢复可用。

用法：
  python tools/fetch_industry.py            # 生成/刷新 _ind_map.json
  python tools/fetch_industry.py --limit 3  # 只跑前 3 个行业（调试）
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

TOOLS = os.path.dirname(os.path.abspath(__file__))
# 兼容两种部署方式：放 tools/ 下（本地开发）或直接放仓库根目录（GitHub 网页上传常见）。
# 判据：同级有没有 build_data.py —— 有就说明这里是站点根目录。
SITE = TOOLS if os.path.isfile(os.path.join(TOOLS, "build_data.py")) else os.path.dirname(TOOLS)
OUT = os.path.join(SITE, "_ind_map.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
REF = "https://finance.sina.com.cn"


def get_raw(url, timeout=15, retries=1):
    for i in range(retries + 1):
        try:
            p = subprocess.run(["curl", "-s", "-m", str(timeout), "-A", UA,
                                "-H", "Referer: " + REF, url], capture_output=True)
            if p.returncode == 0 and p.stdout:
                return p.stdout
        except FileNotFoundError:
            break
        time.sleep(0.3 * (i + 1))
    return None


def get_text(url, encoding="utf-8", **kw):
    b = get_raw(url, **kw)
    if not b:
        return None
    try:
        return b.decode(encoding, "ignore")
    except Exception:
        return None


def fetch_industries():
    """→ [(node, 名称, 家数)]；新浪该接口是 GBK。"""
    txt = get_text("https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php", "gbk")
    if not txt:
        return []
    m = re.search(r"=\s*(\{.*\})\s*;?\s*$", txt.strip())
    if not m:
        return []
    try:
        obj = json.loads(m.group(1))
    except Exception:
        return []
    out = []
    for _, v in obj.items():
        parts = str(v).split(",")
        if len(parts) >= 3 and parts[0].startswith("new_"):
            try:
                cnt = int(parts[2])
            except ValueError:
                cnt = 0
            out.append((parts[0], parts[1], cnt))
    return out


def fetch_members(node):
    """拉某行业全部成分股 → [code(带后缀), ...]"""
    codes, page = [], 1
    while page <= 30:
        url = ("https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/"
               "Market_Center.getHQNodeData?page=%d&num=100&sort=symbol&asc=1"
               "&node=%s&symbol=&_s_r_a=page" % (page, node))
        txt = get_text(url)
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
            bare = str(r.get("code") or "")
            if not re.match(r"^\d{6}$", bare):
                continue
            if sym[:2] in ("sh", "sz", "bj"):
                codes.append(bare + "." + sym[:2].upper())
        if len(arr) < 100:
            break
        page += 1
        time.sleep(0.05)
    return codes


def fetch_industry_em():
    """东财 F10 基本信息报表（RPT_F10_BASIC_ORGINFO）→ 全部 A 股的三级行业。

    为什么换掉新浪：新浪行业只有 49 类且只覆盖约一半标的，粒度也怪
    （「计算机设备」只挂 1 只）。东财 EM2016 是「一级-二级-三级」，
    例如「计算机-计算机设备-其他计算机设备」，覆盖全市场。
    """
    code2ind, page, pages = {}, 1, None
    while True:
        url = ("https://datacenter.eastmoney.com/securities/api/data/v1/get"
               "?reportName=RPT_F10_BASIC_ORGINFO"
               "&columns=SECUCODE,EM2016,BOARD_NAME_LEVEL"
               "&pageNumber=%d&pageSize=500&sortColumns=SECUCODE&sortTypes=1" % page)
        txt = get_text(url)
        if not txt:
            break
        try:
            d = json.loads(txt)
        except Exception:
            break
        r = (d.get("result") or {})
        arr = r.get("data") or []
        if pages is None:
            pages = r.get("pages") or 1
        for o in arr:
            secu = str(o.get("SECUCODE") or "")
            if not re.match(r"^\d{6}\.(SH|SZ|BJ)$", secu):
                continue
            em = str(o.get("EM2016") or "").strip()
            if not em:
                continue
            parts = em.split("-")
            code2ind[secu] = {
                "ind": parts[-1] if len(parts) >= 3 else (parts[1] if len(parts) == 2 else parts[0]),
                "l2": parts[1] if len(parts) >= 2 else parts[0],
                "l1": parts[0]
            }
        if page >= (pages or 1) or not arr:
            break
        page += 1
        time.sleep(0.05)
    return code2ind


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--threads", type=int, default=6)
    args = ap.parse_args()

    print("正在拉东财三级行业（EM2016）…")
    data = fetch_industry_em()
    if not data:
        print("东财行业报表不可达，回退新浪行业分类…")
        inds = fetch_industries()
        code2ind = {}
        for node, name, _ in (inds if not args.limit else inds[: args.limit]):
            for c in fetch_members(node):
                code2ind.setdefault(c, {"ind": name, "l2": name, "l1": name})
        data = code2ind
    if not data:
        print("两个源都没取到行业数据")
        return 1

    json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
    from collections import Counter
    l1 = Counter(v["l1"] for v in data.values())
    l3 = Counter(v["ind"] for v in data.values())
    print("已写出 %s：%d 只标的带行业（一级 %d 类 / 三级 %d 类）"
          % (OUT, len(data), len(l1), len(l3)))
    print("一级行业 Top6:", l1.most_common(6))
    print("三级行业示例:", l3.most_common(5))
    return 0


if __name__ == "__main__":
    sys.exit(main())
