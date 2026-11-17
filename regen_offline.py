#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三态看盘 · 离线前复权日K / 全量行业成分股 再生脚本
==============================================================
用途：把「浏览器实时跨域」依赖降到最低。生成两份静态 JS：
  site/kline.js     全市场标的的全量前复权日K（上市以来，默认最多 10000 根）
  site/industry.js  东财行业板块列表（含当日涨跌幅）+ 每个板块的全量成分股

生成后上传/重新发布站点即可生效；页面优先读静态数据，实时接口只做增量增强。
未生成时两个文件是空骨架，页面自动跳过并走实时多源，不影响使用。

用法（在本目录的上级，即 asset-board/ 下执行）：
  python tools/regen_offline.py                    # 全量生成
  python tools/regen_offline.py --skip-kline     # 只生成行业
  python tools/regen_offline.py --skip-industry  # 只生成日K
  python tools/regen_offline.py --limit 500      # 每只只取最近 500 根
  python tools/regen_offline.py --site /path/to/site

依赖：默认仅 Python 标准库（urllib / json / re / argparse），零 pip install 也能跑。
      可选增强：pip install akshare 后，日K 与行业板块改用 akshare（多源容错、行业接口稳定）；
      未装 akshare 时自动降级为标准库直连东财 push2his（仅日K），行业接口走 push2 兜底。
数据源：akshare（免费开源，GitHub: akfamily/akshare）为主；东财公开接口（push2his kline +
      push2 clist）为兜底。均无需注册 / API Key，与 live.js 口径一致。
注意：脚本需在一台能访问网络的机器上运行；本沙箱网络不通时
      会明确报「网络不可达」并保留原有文件，不会写出半截数据。
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

EM_UT = "fa5fd1943c7b386f172d6893dbfba10b"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
HOST_PUSH2 = "https://push2.eastmoney.com/api/qt/clist/get"
HOST_KLINE = "https://push2his.eastmoney.com/api/qt/stock/kline/get"


# ---- 可选的 akshare 增强（免费开源，GitHub: akfamily/akshare）----
# 装了 akshare 时优先用它（多源容错、行业板块接口稳定）；
# 没装时退回标准库直连东财（零依赖降级，但 push2 行业接口 2026-04 起已失效，仅兜底）。
_AK = None
_BOARD_NAME = {}  # bk 代码 -> 板块名称（供成分股反查）


def ak():
    global _AK
    if _AK is not None:
        return _AK
    try:
        import akshare as m
        _AK = m
    except Exception:
        _AK = False
    return _AK


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def fetch_kline_ak(code, limit):
    m = ak()
    if not m:
        return None
    try:
        df = m.stock_zh_a_hist(symbol=re.sub(r"\.\w+$", "", code), period="daily",
                               start_date="20000101", end_date="20500101", adjust="qfq")
        if df is None or len(df) == 0:
            return None
        out = []
        for _, r in df.iterrows():
            try:
                out.append([
                    str(r["日期"]), float(r["开盘"]), float(r["收盘"]),
                    float(r["最高"]), float(r["最低"]),
                    int(float(r["成交量"])), _num(r.get("涨跌幅")), _num(r.get("换手率")),
                ])
            except (ValueError, TypeError, KeyError):
                continue
        return out[-limit:] if limit else out
    except Exception:
        return None


def fetch_boards_ak():
    m = ak()
    if not m:
        return None
    try:
        df = m.stock_board_industry_name_em()
    except Exception:
        return None
    boards = []
    for _, r in df.iterrows():
        bk = str(r.get("板块代码") or "")
        name = str(r.get("板块名称") or "")
        if bk and name:
            boards.append({
                "bk": bk, "name": name,
                "chg": _num(r.get("涨跌幅")), "price": _num(r.get("最新价")),
                "lead": str(r.get("领涨股票") or ""),
                "leadChg": _num(r.get("领涨股票-涨跌幅")),
            })
    return boards or None


def fetch_cons_ak(name):
    m = ak()
    if not m:
        return None
    try:
        df = m.stock_board_industry_cons_em(symbol=name)
    except Exception:
        return None
    out = []
    for _, r in df.iterrows():
        bare = str(r.get("代码") or "")
        if not re.match(r"^\d{6}$", bare):
            continue
        out.append({
            "code": bare + (".SH" if bare.startswith(("6", "9")) else ".SZ"),
            "bare": bare, "name": str(r.get("名称") or ""),
            "price": _num(r.get("最新价")), "chg": _num(r.get("涨跌幅")),
            "amt": _num(r.get("成交额")), "turn": _num(r.get("换手率")),
        })
    return out or None


def http_json(url, retries=2, timeout=15):
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://quote.eastmoney.com/"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
            # JSONP 兼容：剥掉 callback(...)
            m = re.match(r"^\s*[\w$]+\((.*)\)\s*;?\s*$", raw, re.S)
            if m:
                raw = m.group(1)
            return json.loads(raw)
        except Exception as e:  # noqa: BLE001
            last = e
            if i < retries:
                time.sleep(0.4 * (i + 1))
    raise RuntimeError("请求失败：%s（%s）" % (url[:110], last))


def market_of(code):
    if code.endswith(".SH"):
        return 1, code[:-3]
    if code.endswith(".SZ"):
        return 0, code[:-3]
    bare = re.sub(r"\.[A-Z]{2,4}$", "", code)
    return (1 if bare.startswith(("6", "9")) else 0), bare


def load_pool(site_dir):
    path = os.path.join(site_dir, "data.js")
    with open(path, "r", encoding="utf-8") as f:
        txt = f.read()
    codes = re.findall(r'"code"\s*:\s*"(\d{6}\.(?:SH|SZ))"', txt)
    seen, out = set(), []
    for c in codes:
        if c not in seen:
            seen.add(c)
            out.append(c)
    if not out:
        raise RuntimeError("未能从 %s 解析出标的代码，检查 data.js 结构" % path)
    return out


def beg_date(days_back=4000):
    t = time.time() - days_back * 86400
    return time.strftime("%Y%m%d", time.localtime(t))


def fetch_kline(code, limit):
    k = fetch_kline_ak(code, limit)
    if k is not None:
        return k
    # 降级：标准库直连东财 push2his（akshare 未装时）
    m, bare = market_of(code)
    q = urllib.parse.urlencode({
        "ut": EM_UT, "secid": "%d.%s" % (m, bare),
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "klt": 101, "fqt": 1, "beg": beg_date(), "end": "20500101", "lmt": limit,
    })
    d = http_json(HOST_KLINE + "?" + q)
    kl = (d.get("data") or {}).get("klines") or []
    out = []
    for line in kl:
        p = str(line).split(",")
        try:
            out.append([
                p[0], float(p[1]), float(p[2]), float(p[3]), float(p[4]),
                int(float(p[5] or 0)), float(p[8] or 0), float(p[10] or 0),
            ])
        except (ValueError, IndexError):
            continue
    return out


def fetch_boards():
    boards = fetch_boards_ak()
    if boards is not None:
        return boards
    # 降级：标准库直连东财 push2（注：该接口 2026-04 起多家确认失效，仅兜底）
    q = urllib.parse.urlencode({
        "pn": 1, "pz": 200, "po": 1, "np": 1, "fltt": 2, "invt": 2, "fid": "f3",
        "fs": "m:90+t:2+f:!50", "fields": "f12,f13,f14,f2,f3,f128,f136", "ut": EM_UT,
    })
    d = http_json(HOST_PUSH2 + "?" + q)
    diff = (d.get("data") or {}).get("diff") or []
    boards = []
    for it in diff:
        if not it:
            continue
        bk = str(it.get("f12") or "")
        name = str(it.get("f14") or "")
        if bk and name:
            boards.append({
                "bk": bk, "name": name,
                "chg": it.get("f3") if isinstance(it.get("f3"), (int, float)) else None,
                "price": it.get("f2") if isinstance(it.get("f2"), (int, float)) else None,
                "lead": str(it.get("f128") or ""),
                "leadChg": it.get("f136") if isinstance(it.get("f136"), (int, float)) else None,
            })
    return boards


def fetch_cons(bk):
    name = _BOARD_NAME.get(bk, bk)
    cons = fetch_cons_ak(name)
    if cons is not None:
        return cons
    # 降级：标准库直连东财 push2
    q = urllib.parse.urlencode({
        "pn": 1, "pz": 1000, "po": 1, "np": 1, "fltt": 2, "invt": 2, "fid": "f3",
        "fs": "b:%s+f:!50" % bk, "fields": "f12,f13,f14,f2,f3,f6,f8", "ut": EM_UT,
    })
    d = http_json(HOST_PUSH2 + "?" + q)
    diff = (d.get("data") or {}).get("diff") or []
    out = []
    for it in diff:
        if not it:
            continue
        bare = str(it.get("f12") or "")
        if not re.match(r"^\d{6}$", bare):
            continue
        m = int(it.get("f13") or 0)
        out.append({
            "code": bare + (".SH" if m == 1 else ".SZ"), "bare": bare,
            "name": str(it.get("f14") or ""),
            "price": it.get("f2") if isinstance(it.get("f2"), (int, float)) else None,
            "chg": it.get("f3") if isinstance(it.get("f3"), (int, float)) else None,
            "amt": it.get("f6") if isinstance(it.get("f6"), (int, float)) else None,
            "turn": it.get("f8") if isinstance(it.get("f8"), (int, float)) else None,
        })
    return out


def write_js(path, varname, obj, header):
    body = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("/* 由 tools/regen_offline.py 自动生成 · " + time.strftime("%Y-%m-%d %H:%M") + " */\n")
        f.write(header)
        f.write("window.%s = %s;\n" % (varname, body))


def main():
    ap = argparse.ArgumentParser(description="生成离线日K与全量行业成分股静态数据")
    ap.add_argument("--site", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site"))
    ap.add_argument("--limit", type=int, default=10000, help="每只标的最多取多少根日K")
    ap.add_argument("--skip-kline", action="store_true")
    ap.add_argument("--skip-industry", action="store_true")
    args = ap.parse_args()

    site = args.site
    if not os.path.isdir(site):
        print("站点目录不存在：%s" % site)
        return 1
    print("站点目录：%s" % site)

    if not args.skip_kline:
        codes = load_pool(site)
        print("标的池：%d 只，开始拉前复权日K…" % len(codes))
        bars, failed = {}, []
        for i, c in enumerate(codes, 1):
            try:
                k = fetch_kline(c, args.limit)
                if len(k) >= 2:
                    bars[c] = k
                else:
                    failed.append(c)
            except Exception as e:  # noqa: BLE001
                failed.append(c)
                if len(failed) <= 2:
                    print("  示例失败：%s %s" % (c, e))
            if i % 20 == 0 or i == len(codes):
                print("  %d/%d，成功 %d" % (i, len(codes), len(bars)))
            time.sleep(0.12)
        if not bars:
            print("日K 全部失败（网络不可达或接口变更），保留原有 kline.js 不覆盖。")
        else:
            obj = {"asOf": time.strftime("%Y-%m-%d"), "source": "eastmoney kline qfq (regen_offline.py)", "bars": bars}
            write_js(os.path.join(site, "kline.js"), "AB_KLINE", obj,
                     "/* 每根：[日期, 开, 收, 高, 低, 量, 涨跌幅%, 换手率%] */\n")
            print("kline.js 写入完成：%d 只，失败 %d 只（页面对失败标的自动走实时源）" % (len(bars), len(failed)))

    if not args.skip_industry:
        print("拉取行业板块列表…")
        try:
            boards = fetch_boards()
            _BOARD_NAME.clear()
            for b in boards:
                _BOARD_NAME[b["bk"]] = b["name"]
            print("  板块 %d 个（来源：%s），开始拉成分股…" % (
                len(boards), "akshare" if ak() else "eastmoney push2(兜底)"))
            cons = {}
            for i, b in enumerate(boards, 1):
                try:
                    lst = fetch_cons(b["bk"])
                    if lst:
                        cons[b["bk"]] = lst
                except Exception:  # noqa: BLE001
                    pass
                if i % 20 == 0 or i == len(boards):
                    print("  %d/%d，成功 %d" % (i, len(boards), len(cons)))
                time.sleep(0.12)
            if not boards:
                print("板块列表为空，保留原有 industry.js 不覆盖。")
            else:
                src = "akshare industry" if ak() else "eastmoney clist (regen_offline.py)"
                obj = {"asOf": time.strftime("%Y-%m-%d"), "source": src,
                       "boards": boards, "cons": cons}
                write_js(os.path.join(site, "industry.js"), "AB_INDUSTRY", obj,
                         "/* boards=板块列表(含当日涨跌幅) · cons=按 BK 代码的全量成分股 */\n")
                print("industry.js 写入完成：%d 个板块，%d 个板块有成分股" % (len(boards), len(cons)))
        except Exception as e:  # noqa: BLE001
            print("行业数据失败（%s），保留原有 industry.js 不覆盖。" % e)

    print("完成。重新上架后页面会优先使用静态数据。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
