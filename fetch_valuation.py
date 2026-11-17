# -*- coding: utf-8 -*-
"""批量抓全市场估值（PE / PB / 换手率 / 市值），供「贵不贵」判断用。

为什么单独抓
------------
「股价贵还是便宜」不能只看自身历史分位，还要**跟同行业比**。而行业对比需要全市场 PE/PB，
我们快照里只有市值（来自新浪，单位万元）。腾讯 `qt.gtimg.cn` 一次可批量取 50+ 只，
且字段是交易所同源口径（38 换手率 / 39 PE-TTM / 44 流通市值 / 45 总市值 / 46 PB）。

用法：
  python tools/fetch_valuation.py            # 全量（约 1~2 分钟）
  python tools/fetch_valuation.py --limit 200
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
OUT = os.path.join(SITE, "_valuation.json")

HEADERS = ["-H", "Referer: https://gu.qq.com/"]


def _curl(url, timeout=15):
    for _ in range(3):
        try:
            p = subprocess.run(["curl", "-s", "-m", str(timeout)] + HEADERS + [url],
                               capture_output=True)
            if p.stdout:
                return p.stdout.decode("gbk", "ignore")
        except Exception:
            pass
        time.sleep(0.3)
    return ""


def to_sym(code):
    """600519.SH → sh600519"""
    c, _, mk = code.partition(".")
    return (mk or "SH").lower() + c


def parse_line(line):
    """v_sh600519="...~..." → dict 或 None"""
    if "=" not in line:
        return None
    sym = line.split("=", 1)[0].strip()
    if not sym.startswith("v_"):
        return None
    body = line.split('="', 1)
    if len(body) < 2:
        return None
    a = body[1].rsplit('"', 1)[0].split("~")
    if len(a) < 50:
        return None

    def n(i):
        try:
            return float(a[i])
        except (ValueError, IndexError):
            return None

    code6 = re.sub(r"^v_[a-z]{2}", "", sym)
    mk = sym[2:4].upper()
    return {
        "code": code6 + "." + mk,
        "name": a[1],
        "price": n(3),
        "pe": n(39),          # PE(TTM)，亏损为空或负
        "pb": n(46),
        "turn": n(38),        # 换手率 %
        "floatCap": n(44),    # 流通市值（亿）
        "totalCap": n(45),    # 总市值（亿）
        "amplitude": n(43),
        "volumeRatio": n(49),
    }


def fetch_batch(codes):
    url = "https://qt.gtimg.cn/q=" + ",".join(to_sym(c) for c in codes)
    txt = _curl(url)
    out = {}
    for line in txt.split(";"):
        d = parse_line(line.strip())
        if d and d["price"]:
            out[d["code"]] = d
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--batch", type=int, default=50)
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()

    data_js = os.path.join(SITE, "data.js")
    if not os.path.isfile(data_js):
        print("找不到 data.js，先运行 build_data.py")
        return 1
    txt = open(data_js, encoding="utf-8-sig").read()
    codes = re.findall(r'"code":\s*"(\d{6}\.[A-Z]{2})"', txt)
    codes = sorted(set(codes))
    if a.limit:
        codes = codes[: a.limit]
    print("待抓估值：%d 只，每批 %d，并发 %d" % (len(codes), a.batch, a.threads))

    batches = [codes[i:i + a.batch] for i in range(0, len(codes), a.batch)]
    result, done = {}, 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=a.threads) as ex:
        for part in ex.map(fetch_batch, batches):
            result.update(part)
            done += 1
            if done % 20 == 0 or done == len(batches):
                print("  %d/%d 批，已取 %d 只，%.0fs" % (done, len(batches), len(result), time.time() - t0))
            time.sleep(0.05)

    ok = [v for v in result.values() if v.get("pe") is not None]
    print("完成：%d 只有效，其中 %d 只有 PE（其余亏损或缺失）；耗时 %.0fs"
          % (len(result), len(ok), time.time() - t0))
    json.dump(result, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
    print("已写出 %s" % OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
