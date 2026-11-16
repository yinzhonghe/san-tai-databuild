#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
数据源连通性探测
================
在 GitHub Actions runner 上跑，用来回答一个问题：
「这台机器能不能拉到 A 股公开数据？」

背景：开发机的网络出口访问东财会被直接断开（Remote end closed），
但换一个网络环境（云端）就正常 —— 所以先确认 runner 侧通畅，
再决定要不要把构建搬过来。

输出既打到 stdout（看日志），也写 probe-result.txt（便于直接读文件）。
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
OUT = []


def get(url, referer=None, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    if referer:
        req.add_header("Referer", referer)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "ignore"), None
    except Exception as e:  # noqa: BLE001
        return None, "%s: %s" % (type(e).__name__, e)


def check(name, url, judge, referer=None):
    t0 = time.time()
    body, err = get(url, referer)
    ms = int((time.time() - t0) * 1000)
    if err:
        OUT.append("[FAIL] %-18s %5dms  %s" % (name, ms, err[:110]))
        return False
    ok, detail = judge(body)
    OUT.append("[%s] %-18s %5dms  %s" % (" OK " if ok else "FAIL", name, ms, detail))
    return ok


def j_eastmoney_clist(body):
    d = json.loads(body)
    total = (d.get("data") or {}).get("total")
    n = len((d.get("data") or {}).get("diff") or [])
    return bool(total), "total=%s diff=%s" % (total, n)


def j_eastmoney_kline(body):
    d = json.loads(body)
    ks = ((d.get("data") or {}).get("klines")) or []
    return bool(ks), "klines=%d 末根=%s" % (len(ks), ks[-1][:32] if ks else "-")


def j_tencent(body):
    # 腾讯返回 var v_sh600519="1~贵州茅台~600519~...";
    ok = "v_sh600519" in body and len(body) > 80
    seg = body.split("~")
    return ok, "字段数=%d 现价=%s" % (len(seg), seg[3] if len(seg) > 3 else "-")


def j_ths(body):
    d = json.loads(body)
    lst = ((d.get("data") or {}).get("stock_list")) or []
    return bool(lst), "stock_list=%d" % len(lst)


def j_sina(body):
    ok = "hq_str_sh000001" in body
    return ok, body[:60].replace("\n", " ")


def main():
    OUT.append("runner: %s / py%s" % (os.environ.get("RUNNER_OS", "?"), sys.version.split()[0]))
    results = []

    # 1) 东财全市场列表 —— 这是本地最致命的那个接口
    results.append(check(
        "东财 clist 全市场",
        "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=20&po=1&np=1&fltt=2"
        "&invt=2&fid=f3&fs=m:0+t:6,m:1+t:2&fields=f2,f3,f12,f13&ut=fa5fd1943c7b386f172d6893dbfba10b",
        j_eastmoney_clist))

    # 2) 东财前复权日K —— 复权口径的源头
    results.append(check(
        "东财 kline(前复权)",
        "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&klt=101&fqt=1"
        "&beg=20250101&end=20500101&lmt=300&fields1=f1,f2,f3&fields2=f51,f53"
        "&ut=fa5fd1943c7b386f172d6893dbfba10b",
        j_eastmoney_kline))

    # 3) 腾讯实时 —— 前端现在的主力源
    results.append(check("腾讯实时", "https://qt.gtimg.cn/q=sh600519,sz000001", j_tencent))

    # 4) 同花顺热榜 —— 舆情页依赖
    results.append(check(
        "同花顺热榜",
        "https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock"
        "?stock_type=a&list_type=normal&type=hour",
        j_ths))

    # 5) 新浪 —— 需要 Referer，顺便验证这条限制是否还在
    results.append(check("新浪(带Referer)", "https://hq.sinajs.cn/list=sh000001", j_sina,
                         referer="https://finance.sina.com.cn"))

    ok_n = sum(1 for x in results if x)
    OUT.append("")
    OUT.append("通过 %d / %d" % (ok_n, len(results)))
    text = "\n".join(OUT)
    print(text)
    with open("probe-result.txt", "w", encoding="utf-8") as f:
        f.write(text + "\n")
    return 0 if ok_n >= 3 else 1


if __name__ == "__main__":
    sys.exit(main())
