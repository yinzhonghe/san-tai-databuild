#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三态看盘 · 全市场 data.js 再生（免费开源源 akshare）
==================================================
把「全 A 股约 5000 只」逐只拉免费行情，算三态 / 六派，重写成 data.js。
彻底不依赖同花顺 iFinD / 付费数据；全部来自免费开源源 akshare + 东财公开接口兜底。

两种模式：
  --universe full     （默认）拉取 A 股全部约 5000 只，逐只算三态/六派，写 data.js（全市场版）
  --universe curated  仅重算现有 data.js 内的标的（旧行为，向后兼容；保留原策展元数据）

逐只字段：
  - pct      四区间涨跌幅 w5/w20/w60/w250（由前复权日K算）
  - ind      行业归属（东财行业板块反查）
  - fund     主力资金流（可选 --fund；不传则资金派按弃权计，六派其余五派仍有效）
  - scores / state / resonance / rrg / quad / structConf / wyckoff / series(5点) ...
            经 tools/compute_engine.js 调【真实 six-engine.js】计算（单一真相源）

诚实降级（免费源无法可靠生成，延续"不编数据"红线）：
  - themes / newsItems / newsMain / e2 语义证据 / 市场摘要文本 → 置空并标注。
  - 资金派：不传 --fund 时按弃权（不编造净流入）。

性能与健壮性（全市场约 5000 只）：
  - 日K 写入磁盘缓存(--cache)，首次慢、重跑秒回；断点续跑(--resume)跳过已缓存。
  - 并发拉取(--threads，默认 6)；单只失败自动跳过（不阻断全量）。
  - 全市场基准 bm 取全样本 w20/w60 中位数，使 RRG 相对强度真正「以全市场为锚」。
  - 实测首次全量约 10~30 分钟（视网络 / 是否含 --fund）；沙箱无网时请用 --self-test 离线自检。

用法：
  python tools/build_data.py --universe full                 # 全市场正式重算并覆盖 data.js
  python tools/build_data.py --universe full --max 200       # 先小批量试跑 200 只
  python tools/build_data.py --universe full --fund          # 含主力资金流（更慢但六派完整）
  python tools/build_data.py --universe full --no-ind       # 跳过行业反查（更快，ind 留空）
  python tools/build_data.py --universe curated             # 旧行为：仅重算现有标的
  python tools/build_data.py --self-test --max 500          # 离线自检：合成 500 只，不联网验证流水线
  python tools/build_data.py --universe full --dry-run      # 写 _dry_data.js 不覆盖原文件
  python tools/build_data.py --site /path/to/site           # 指定 data.js 所在目录
"""
import argparse
import json
import os
import random
import re
import socket
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

socket.setdefaulttimeout(25)  # 单只请求超时兜底，避免一只卡死全量

TOOLS = os.path.dirname(os.path.abspath(__file__))
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)
from chan import analyze_chan   # noqa: E402  简化缠论（分型/笔/中枢/背驰）
SITE_DEFAULT = os.path.dirname(TOOLS)  # data.js 与 tools 同级（便携版布局）

_AK = None


def ak():
    """懒加载 akshare；未安装则返回 None（降级为离线/保留原值）。"""
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


def _suffix(code6):
    """6/9 开头 → .SH，其余 → .SZ。"""
    return ".SH" if code6.startswith(("6", "9")) else ".SZ"


# ---------------- 零依赖 HTTP（curl 优先）----------------
# 说明：部分行情站点会拒绝 Python/OpenSSL 的 TLS 握手（RemoteDisconnected），
# 但系统 curl（Windows 原生 Schannel）可以正常访问，故默认走 curl 子进程；
# curl 不可用时再回退 urllib。

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def http_get(url, referer=None, timeout=15, retries=2):
    """GET 文本；失败返回 None（不抛异常，交由上层降级）。"""
    for i in range(retries + 1):
        try:
            out = subprocess.run(
                ["curl", "-s", "-m", str(timeout), "-A", UA]
                + (["-H", "Referer: " + referer] if referer else [])
                + [url],
                capture_output=True)
            if out.returncode == 0 and out.stdout:
                return out.stdout.decode("utf-8", "ignore")
        except FileNotFoundError:
            break
        time.sleep(0.4 * (i + 1))
    try:  # 回退 urllib
        import urllib.request
        req = urllib.request.Request(url, headers={"User-Agent": UA,
                                                   "Referer": referer or "https://finance.sina.com.cn"})
        return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "ignore")
    except Exception:
        return None


def to_sym(code):
    """600000.SH → sh600000；920000.BJ → bj920000。"""
    bare, _, mk = code.partition(".")
    mk = mk.upper()
    pre = {"SH": "sh", "SZ": "sz", "BJ": "bj"}.get(mk)
    if not pre:
        pre = "sh" if bare.startswith(("6", "9")) else "sz"
    return pre + bare


# ---------------- 免费源拉取 ----------------

def fetch_universe_ak():
    """返回 [(code带后缀, name), ...] 全部 A 股；失败返回 None。"""
    m = ak()
    if not m:
        return None
    try:
        df = m.stock_info_a_code_name()
    except Exception:
        return None
    out = []
    for _, r in df.iterrows():
        bare = str(r.get("code") or "").strip()
        name = str(r.get("name") or "").strip()
        if not re.match(r"^\d{6}$", bare) or not name:
            continue
        out.append((bare + _suffix(bare), name))
    return out or None


def fetch_kline_ak(code, since):
    """前复权日K → [[date,o,c,h,l,v,pct,turn], ...]；失败返回 None。"""
    m = ak()
    if not m:
        return None
    try:
        df = m.stock_zh_a_hist(symbol=re.sub(r"\.\w+$", "", code), period="daily",
                               start_date=since, end_date="20500101", adjust="qfq")
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
        return out
    except Exception:
        return None


def compute_pct(kl):
    """由日K收盘序列算 w5/w20/w60/w250 区间涨跌幅(%)。"""
    closes = [row[2] for row in kl if row[2]]
    n = len(closes)
    def ret(back):
        if n < back + 1:
            return None
        a, b = closes[-1 - back], closes[-1]
        return None if not a else round((b / a - 1) * 100, 4)
    return {"w5": ret(5), "w20": ret(20), "w60": ret(60), "w250": ret(250)}


def fetch_industry_map_ak(cache_path):
    """返回 {code(带后缀): 行业名}；失败返回 {}；结果写缓存。"""
    if cache_path and os.path.isfile(cache_path):
        try:
            return json.load(open(cache_path, encoding="utf-8"))
        except Exception:
            pass
    m = ak()
    if not m:
        return {}
    try:
        boards = m.stock_board_industry_name_em()
    except Exception:
        return {}
    code2ind = {}
    for _, b in boards.iterrows():
        name = str(b.get("板块名称", ""))
        if not name:
            continue
        try:
            cons = m.stock_board_industry_cons_em(symbol=name)
        except Exception:
            continue
        for _, c in cons.iterrows():
            bare = str(c.get("代码", ""))
            if re.match(r"^\d{6}$", bare):
                code2ind[bare + _suffix(bare)] = name
        time.sleep(0.12)
    if cache_path:
        try:
            json.dump(code2ind, open(cache_path, "w", encoding="utf-8"), ensure_ascii=False)
        except Exception:
            pass
    return code2ind


def fetch_fund_ak(code):
    """个股主力净流入 → (fund_float, fundLabel)；失败返回 (None, None)。"""
    m = ak()
    if not m:
        return None, None
    bare = re.sub(r"\.\w+$", "", code)
    market = "sh" if bare.startswith(("6", "9")) else "sz"
    try:
        df = m.stock_individual_fund_flow(stock=bare, market=market)
        if df is None or len(df) == 0:
            return None, None
        last = df.iloc[-1]
        net = _num(last.get("主力净流入-净额"))  # 单位：元
        if net is None:
            return None, None
        yi = net / 1e8
        label = "个股主力净流入 %+.2f 亿（akshare/东财口径）" % yi
        return round(yi, 6), label
    except Exception:
        return None, None


# ---------------- 零依赖免费源（腾讯 / 新浪，不装任何包）----------------

SINA_REF = "https://finance.sina.com.cn"


def fetch_universe_free():
    """新浪 hs_a 全市场分页 → [{'code':'600000.SH','sym':'sh600000','name':...}]。

    覆盖沪 / 深 / 北交所全部 A 股（约 5500 只）。新浪对批量分页较宽容，
    且不依赖东财（东财 push2 在部分网络会整段返回 000）。
    """
    out, page = [], 1
    while page <= 90:
        url = ("https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/"
               "Market_Center.getHQNodeData?page=%d&num=100&sort=symbol&asc=1"
               "&node=hs_a&symbol=&_s_r_a=page" % page)
        txt = http_get(url, referer=SINA_REF)
        if not txt:
            break
        try:
            arr = json.loads(txt)
        except Exception:
            break
        if not arr:
            break
        for r in arr:
            sym = str(r.get("symbol") or "").strip().lower()
            bare = str(r.get("code") or "").strip()
            name = str(r.get("name") or "").strip()
            if not re.match(r"^\d{6}$", bare) or not name:
                continue
            mk = sym[:2] if sym[:2] in ("sh", "sz", "bj") else None
            if not mk:
                continue
            out.append({"code": bare + "." + mk.upper(), "sym": mk + bare,
                        "name": name, "mktcap": _num(r.get("mktcap")),
                        "nmc": _num(r.get("nmc"))})
        if len(arr) < 100:
            break
        page += 1
        time.sleep(0.04)
    return out or None


# ---------------- 腾讯日K：三入口轮换 + 串行限流 ----------------
# 借鉴 simonlin1212/a-stock-data 的两条经验（README「数据源优先级」与 em_get 设计）：
#   1) 腾讯 K 线有 3 个不同入口，单入口约 600 次后开始限流/拦页 → 轮换可显著延长可用时间；
#   2) 东财系接口共用一个风控面，必须串行限流（EM_MIN_INTERVAL=1s + 抖动）才不会成片 503/403。
# 我们之前用 12 线程猛拉单个入口，就是被 WAF 拦的直接原因。
TC_HOSTS = [
    "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
    "https://ifzq.gtimg.cn/appstock/app/fqkline/get",
    "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get",
]
TC_MIN_INTERVAL = float(os.environ.get("TC_MIN_INTERVAL", "0.08"))
_tc_lock = threading.Lock()
_tc_last = {}
_tc_rr = [0]


def _tc_throttle(host):
    """同一入口的串行最小间隔 + 0-50ms 抖动（模仿 em_get 的节流方式）。"""
    with _tc_lock:
        nowt = time.time()
        gap = TC_MIN_INTERVAL - (nowt - _tc_last.get(host, 0))
    if gap > 0:
        time.sleep(gap + random.uniform(0, 0.05))
    with _tc_lock:
        _tc_last[host] = time.time()


def fetch_kline_tencent(sym, n=320):
    """腾讯前复权日K → [[date,o,c,h,l,v], ...]（升序）。三入口轮换，失败逐个退。"""
    with _tc_lock:
        start = _tc_rr[0]
    for k in range(len(TC_HOSTS)):
        host = TC_HOSTS[(start + k) % len(TC_HOSTS)]
        _tc_throttle(host)
        txt = http_get(host + "?param=%s,day,,,%d,qfq" % (sym, n))
        if not txt:
            continue
        try:
            node = (json.loads(txt).get("data") or {}).get(sym) or {}
        except Exception:
            continue
        rows = node.get("qfqday") or node.get("day") or []
        out = []
        for r in rows:
            if len(r) < 6:
                continue
            try:
                out.append([str(r[0])[:10], float(r[1]), float(r[2]), float(r[3]),
                            float(r[4]), float(r[5])])
            except (TypeError, ValueError):
                continue
        if out:
            with _tc_lock:
                _tc_rr[0] = (start + k + 1) % len(TC_HOSTS)
            return out
    return None


def fetch_kline_sina(sym, n=320):
    """新浪日K（**不复权**，用于腾讯不覆盖的北交所）→ 同格式。"""
    url = ("https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketData.getKLineData"
           "?symbol=%s&scale=240&ma=no&datalen=%d" % (sym, n))
    txt = http_get(url, referer=SINA_REF)
    if not txt:
        return None
    try:
        arr = json.loads(txt)
    except Exception:
        return None
    out = []
    for r in arr or []:
        try:
            out.append([str(r["day"])[:10], float(r["open"]), float(r["close"]),
                        float(r["high"]), float(r["low"]), float(r["volume"])])
        except (KeyError, TypeError, ValueError):
            continue
    return out or None


def fetch_kline_any(sym, n=320):
    """沪/深 → 腾讯前复权；失败或北交所 → 新浪（标注不复权）。返回 (kl, src)。"""
    if not sym.startswith("bj"):
        kl = fetch_kline_tencent(sym, n)
        if kl and len(kl) >= 30:
            return kl, "tencent-qfq"
    kl = fetch_kline_sina(sym, n)
    if kl and len(kl) >= 30:
        return kl, "sina-raw"
    return None, None


def fetch_industry_sina():
    """新浪行业分类 → {code: 行业名}。

    新浪 Market_Center 的 node 形如 `sw2_110000`（申万二级）需先枚举行业代码；
    这里改用其「行业板块」聚合页的另一种取法：直接从 hs_a 返回不含行业，
    故退化为空字典（行业字段留空而非编造）。东财可用时会自动改走东财。
    """
    return {}


# ---------------- 解析现有 data.js（经 node，鲁棒）----------------

def load_existing(site):
    """用 node 把现有 data.js 解析成 Python 字典（含 engine / rows / meta 等）。

    首次构建（仓库里还没有 data.js）时返回空骨架而不是抛异常 ——
    否则整条管道在空目录里第一步就崩，云端跑批量构建时正是这个坑。
    """
    data_js = _find_data(site)
    if not data_js:
        print("[info] 未找到已有的 data.js，按首次构建处理（不继承历史快照）")
        return {"engine": {}, "meta": {}, "rows": [], "market": None,
                "summary": None, "summaryEtf": None, "summaryStock": None,
                "summaryCore": None, "summaryExt": None, "themes": [],
                "themeAgg": [], "themeKeywords": [], "voteDef": [], "caveat": None}
    snippet = (
        "global.window={};"
        "var fs=require('fs');"
        "var s=fs.readFileSync(%r,'utf8').replace(/^\\ufeff/,'').replace(/window\\.AB_DATA\\s*=/,'global.window.AB_DATA =');"
        "(0,eval)(s);"
        "var d=global.window.AB_DATA;"
        "process.stdout.write(JSON.stringify({"
        "engine:d.engine, meta:d.meta, rows:d.rows, voteDef:d.voteDef,"
        "themes:d.themes, themeAgg:d.themeAgg, themeKeywords:d.themeKeywords,"
        "market:d.market, summary:d.summary, summaryEtf:d.summaryEtf,"
        "summaryStock:d.summaryStock, summaryCore:d.summaryCore, summaryExt:d.summaryExt,"
        "caveat:d.caveat}));"
    ) % data_js
    # 用绝对路径读，且不传 cwd：原来 _find_data 可能返回相对路径 "data.js"，
    # 而 subprocess 又在 cwd=site 下执行，路径解析对不上会报 ENOENT。
    data_js = os.path.abspath(data_js)
    out = subprocess.check_output(["node", "-e", snippet])
    return json.loads(out.decode("utf-8"))


def _find_data(site):
    for cand in ("data.js", os.path.join(site, "data.js"),
                 os.path.join(site, "site", "data.js")):
        if os.path.isfile(cand):
            return cand
    return None


def load_rows_file(path):
    """直接读取任意 data.js 的 rows（用于从备份里找回被漏掉的 ETF 等）。"""
    snippet = (
        "global.window={};var fs=require('fs');"
        "var s=fs.readFileSync(%r,'utf8').replace(/^\\ufeff/,'').replace(/window\\.AB_DATA\\s*=/,'global.window.AB_DATA =');"
        "(0,eval)(s);process.stdout.write(JSON.stringify(global.window.AB_DATA.rows||[]));"
    ) % path
    out = subprocess.check_output(["node", "-e", snippet])
    return json.loads(out.decode("utf-8"))


# ---------------- 引擎（node）----------------

def run_engine(items, site):
    """调 compute_engine.js 批量重算六派，返回 {code: {...}}；失败抛异常。"""
    in_path = os.path.join(site, "_engine_in.json")
    out_path = os.path.join(site, "_engine_out.json")
    with open(in_path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False)
    subprocess.check_call(["node", os.path.join(TOOLS, "compute_engine.js"),
                           in_path, out_path], cwd=site)
    return json.load(open(out_path, encoding="utf-8"))


# ---------------- 指数三态（我的看板首屏用） ----------------
# 只做 4 个宽基：上证指数 / 深证成指 / 创业板指 / 科创50。
# 它们不是"标的"，不参与选股与排行，只用来回答「今天大盘处在什么状态」。
INDEX_DEF = [
    ("000001.SH", "上证指数", "sh000001"),
    ("399001.SZ", "深证成指", "sz399001"),
    ("399006.SZ", "创业板指", "sz399006"),
    ("000688.SH", "科创50", "sh000688"),
]
INDEX_STATES = []


def build_index_states(site, cache_dir):
    """抓 4 个指数日K → 用同一套六派引擎算三态；结果写入 data.js 的 indexStates。"""
    items = []
    for code, name, sym in INDEX_DEF:
        kl = _kline_cache_get(cache_dir, code, "v2", False) if cache_dir else None
        if not kl:
            kl = fetch_kline_tencent(sym, 320)
            if kl and cache_dir:
                _kline_cache_put(cache_dir, code, "v2", kl)
        if not kl or len(kl) < 60:
            print("  [指数] %s 日K 不足，跳过" % name)
            continue
        closes_all = [round(r[2], 2) for r in kl if r[2]]
        pct = compute_pct(kl)
        c250 = closes_all[-251] if len(closes_all) > 251 else None
        items.append({
            "code": code, "name": name, "kind": "index", "tier": "index",
            "pct": pct, "ind": None, "closes": closes_all[-61:], "c250": c250,
            "point": closes_all[-1],
            "chg": (closes_all[-1] / closes_all[-2] - 1) * 100 if len(closes_all) > 1 else None,
            "baseDate": re.sub(r"\D", "", str(kl[-1][0])),
        })
    if not items:
        return []
    slim = [{k: it.get(k) for k in ("code", "name", "kind", "tier", "pct", "ind", "closes", "c250")}
            for it in items]
    try:
        eng = run_engine(slim, site)
    except Exception as e:
        print("  [指数] 引擎计算失败：%s" % e)
        return []
    out = []
    for it in items:
        eo = eng.get(it["code"]) or {}
        out.append({
            "code": it["code"], "name": it["name"],
            "point": round(it["point"], 2),
            "chg": round(it["chg"], 2) if it["chg"] is not None else None,
            "pct": it["pct"], "baseDate": it["baseDate"],
            "state": eo.get("state"), "stateDays": eo.get("stateDays"),
            "stateCapped": eo.get("stateCapped"),
            "resonance": eo.get("resonance"), "scores": eo.get("scores"),
            # 六派方向票一起落盘：前端「三态与六派依据」要显示每派 ✓/✗/—，
            # 只存 scores 的话指数页只能全显示「—」，看起来像缺数据。
            "votes": eo.get("votes"),
        })
    print("  [指数] %d 个：%s" % (len(out), "、".join("%s=%s" % (x["name"], x["state"]) for x in out)))
    return out


# 六派说明：逐条对照 six-engine.js 的真实实现写，不写引擎里没有的东西
VOTE_DEF = [
    {"key": "structure", "name": "结构派",
     "desc": "温斯坦 / 威科夫四阶段（S1 吸筹 → S2 拉升 → S3 派发 → S4 下跌）+ <b>缠论</b>：5/20/60/250 日涨跌幅加权定骨架；缠论用「分型→笔→中枢→背驰」判断当前价在最近中枢的上方/内部/下方、最近一笔方向、以及是否出现背驰（创新高/新低但力度衰减），满足「中枢上方+向上笔」加分、「跌破中枢+向下笔」减分、背驰反向扣分；再叠加阶段一致性与行业相对排名。"},
    {"key": "volume", "name": "量价派",
     "desc": "量价加速度 + 中期动量差 + 换手率 + 唐奇安通道位置（20日）+ MACD 柱 + RSI(14)；布林带宽只用于识别波动压缩，不单独计分。"},
    {"key": "fund", "name": "资金派",
     "desc": "个股主力净流入（需构建时加 --fund）；拿不到个股口径时退用所属行业 / 全市场行业中位数作代理，并在透镜里标注「代理」。"},
    {"key": "senti", "name": "情绪派",
     "desc": "市场情绪温度（0.45）+ 自身近 5 日强度 + 行业上涨宽度（有行业数据时计入）。"},
    {"key": "config", "name": "配置派",
     "desc": "简化 RRG：5/20/60 日相对表现合成 RS-Ratio / RS-Momentum，基准是<b>全市场样本中位数</b>（不是沪深300）；只有 4 个区间锚点，非逐日平滑版。"},
    {"key": "news", "name": "舆情派",
     "desc": "全网资讯密度（近24h ÷ 前7日日均）× 标题极性（否定词/程度副词/主体校验）× 三方核对（舆情×三态×价格）。该票在页面端由「资讯雷达」实时判定，构建快照不含新闻源，故以实时结果为准。"},
]


# ---------------- 组装新 row ----------------

def assemble_row(r_old, pct, ind, fund, fundLabel, eo, asof, tier, closes=None,
                 base_date=None, c250=None):
    row = {}
    # —— 策展/身份元数据（merge 时保留旧行的富化内容；新增行只有基础字段）——
    for k in ("code", "name", "kind", "tier", "etfLink", "etfLinkName", "market",
              "mcap", "nmc", "size", "fee", "l1", "cat", "alts", "nCand", "index",
              "rank", "newsHits", "themes", "newsItems", "newsMain", "e2",
              "fund", "fundLabel", "fundProxy", "fundSelf", "fund3d",
              "indInfo", "liveMeta", "veto", "action", "strong", "votes"):
        if k in r_old:
            row[k] = r_old[k]
    row.setdefault("kind", "stock")
    row.setdefault("tier", tier)
    # —— 免费源重算 ——
    row["asOf"] = asof
    row["src"] = "免费开源(腾讯/新浪)重算"
    row["pct"] = pct
    row["series"] = eo.get("series") or []          # 引擎由 pct 推得的 5 点净值序列（透镜图用）
    if closes:
        row["closes"] = closes                       # 近 N 日收盘（前复权），供「打开即实时」重算 w5/w20/w60
    if c250 is not None:
        row["c250"] = c250                           # 250 个交易日前收盘，供实时重算 w250
    if base_date:
        row["baseDate"] = base_date                  # 快照基准日 yyyymmdd
    if ind is not None:
        row["ind"] = ind
        row["cat"] = ind
    elif r_old.get("ind") is not None:      # 新源拿不到行业时，保留旧快照的行业归属
        row["ind"] = r_old["ind"]
        row["cat"] = r_old.get("cat") or r_old["ind"]
    if fund is not None:
        row["fund"] = fund
        row["fundSelf"] = True
    if fundLabel is not None:
        row["fundLabel"] = fundLabel
        row["fundProxy"] = fundLabel
    if eo.get("fund3d") is not None:
        row["fund3d"] = eo["fund3d"]
    # —— 引擎重算（真实 six-engine）——
    for k in ("scores", "state", "resonance", "negVotes", "need", "stage",
              "structRaw", "rrg", "quad", "structConf", "rsRatio", "rsMomentum",
              "wyckoff", "veto", "strong", "newsHits", "votes",
              "stateDays", "stateCapped"):
        if k in eo:
            row[k] = eo[k]
    row["dataFlags"] = eo.get("dataFlags") or []
    # —— 体积控制：新增标的不写派生/空字段（前端已全部容错），
    #    e2 / newsItems / newsMain / liveMeta / indInfo / action 均非渲染必需，
    #    全市场 5500 只下这些空对象会白白多出数 MB。旧行已有内容则原样保留。——
    if isinstance(row.get("e2"), dict):
        row["e2"] = dict(row["e2"])
        row["e2"]["votes"] = eo.get("votes")
    return row


def _median(xs):
    xs = sorted([x for x in xs if x is not None])
    if not xs:
        return 0.0
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2.0


def write_data_js(site, engine, meta, rows_new, top, full):
    # 首次构建时 site 里还没有 data.js，_find_data 返回 None，
    # 直接拿去 open() 会 TypeError。这里兜底成目标路径。
    data_js = _find_data(site) or os.path.join(site, "data.js")
    if full:
        summary = "[全市场版：三态/六派由免费源逐只重算；未含人工撰写的组合摘要]"
        obj = {
            "meta": meta,
            "market": top.get("market"),
            "summary": summary, "summaryEtf": summary, "summaryStock": summary,
            "summaryCore": summary, "summaryExt": summary,
            "themes": [], "themeAgg": [], "themeKeywords": [],
            "rows": rows_new, "indexStates": INDEX_STATES, "engine": engine, "voteDef": VOTE_DEF,
            "caveat": top.get("caveat") or "本快照由腾讯/新浪免费源全市场重算；语义富化字段（主题/证据/舆情）已诚实降级。",
        }
    else:
        obj = {
            "meta": meta, "market": top.get("market"),
            "summary": top.get("summary"), "summaryEtf": top.get("summaryEtf"),
            "summaryStock": top.get("summaryStock"), "summaryCore": top.get("summaryCore"),
            "summaryExt": top.get("summaryExt"), "themes": top.get("themes") or [],
            "themeAgg": top.get("themeAgg") or [], "themeKeywords": top.get("themeKeywords") or [],
            "rows": rows_new, "indexStates": INDEX_STATES, "engine": engine, "voteDef": VOTE_DEF,
            "caveat": top.get("caveat"),
        }
    body = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    with open(data_js, "w", encoding="utf-8", newline="\n") as f:
        f.write("/* 由 tools/build_data.py 生成 · 免费开源(腾讯/新浪)全市场重算 · %s */\n"
                % time.strftime("%Y-%m-%d %H:%M"))
        f.write("window.AB_DATA = " + body + ";\n")


# ---------------- 全市场拉取（并发 + 缓存）----------------

def _default_since(days_back=430):
    return time.strftime("%Y%m%d", time.localtime(time.time() - days_back * 86400))


def _kline_cache_get(cache_dir, code, since, fresh):
    if not cache_dir:
        return None
    path = os.path.join(cache_dir, code + ".json")
    if (not fresh) and os.path.isfile(path):
        try:
            rec = json.load(open(path, encoding="utf-8"))
            if rec.get("since") == since and rec.get("kl"):
                return rec["kl"]
        except Exception:
            pass
    return None


def _kline_cache_put(cache_dir, code, since, kl):
    if not cache_dir:
        return
    try:
        os.makedirs(cache_dir, exist_ok=True)
        json.dump({"since": since, "kl": kl}, open(os.path.join(cache_dir, code + ".json"), "w", encoding="utf-8"))
    except Exception:
        pass


REMOVED = []   # 被剔除的退市/清盘标的（写入 meta.removed 留痕）
IND_PE = {}    # 行业中位 PE（写入 meta.indPE）


def build_full(site, args, existing):
    """全市场模式：拉全部 A 股，算三态/六派，返回 (rows_new, engine_bm_patch)。

    数据源全部免费且零依赖：新浪（代码表）+ 腾讯前复权日K（沪深）/ 新浪日K（北交所）。
    """
    universe = fetch_universe_free()
    if not universe:
        print("未能获取 A 股全量代码（新浪接口不可达）。")
        return None, None
    if args.max and args.max < len(universe):
        step = max(1, len(universe) // args.max)   # 均匀抽样，避免试跑时全落在同一交易所
        universe = universe[::step][: args.max]
    n_bj = sum(1 for u in universe if u["code"].endswith(".BJ"))
    print("全市场标的池：%d 只（沪 %d / 深 %d / 北 %d）" % (
        len(universe),
        sum(1 for u in universe if u["code"].endswith(".SH")),
        sum(1 for u in universe if u["code"].endswith(".SZ")), n_bj))

    # 新浪 hs_a 列表只含股票，不含 ETF。把旧数据集里的 ETF 追加进来，
    # 否则页面的「ETF」筛选、ETF 透镜报告会整块变空（功能退化）。
    have = {u["code"] for u in universe}
    added_etf = 0
    for r in (existing.get("rows") or []):
        c = r.get("code")
        if r.get("kind") == "etf" and c and c not in have:
            universe.append({"code": c, "sym": to_sym(c), "name": r.get("name") or c,
                             "mktcap": r.get("mcap"), "nmc": r.get("nmc")})
            have.add(c)
            added_etf += 1
    if added_etf:
        print("  追加 ETF %d 只（旧数据集保留项）" % added_etf)

    cache_dir = args.cache or os.path.join(site, "_kline_cache")
    ind_map = {}
    if not args.no_ind:
        # 东财行业接口（可能被限流）；拿不到就留空，绝不编造
        try_em = os.path.join(site, "_ind_map.json")
        if os.path.isfile(try_em):
            try:
                ind_map = json.load(open(try_em, encoding="utf-8"))
            except Exception:
                ind_map = {}
        print("  行业映射：%d 只代码有行业归属（东财三级 / 缓存）" % len(ind_map))

    old_by_code = {}
    for r in (existing.get("rows") or []):
        if r.get("code"):
            old_by_code[r["code"]] = r

    # ---- ETF：全网去重后纳入 ----
    # 新浪 hs_a 只含股票。ETF 走 tools/build_etf.py 的结果（全网 900+ 只按主题去重，
    # 每个主题只留一只代表），而不是历史遗留的 54 只。
    etf_rows = list(existing.get("rows") or [])
    pick_path = os.path.join(site, "_etf_pick.json")
    picks = None
    if os.path.isfile(pick_path):
        try:
            picks = json.load(open(pick_path, encoding="utf-8"))
        except Exception:
            picks = None
    have = {u["code"] for u in universe}
    added_etf = 0
    if picks:
        for pd in picks:
            c = pd.get("code")
            if not c or c in have:
                continue
            universe.append({"code": c, "sym": to_sym(c), "name": pd.get("name") or c,
                             "mktcap": pd.get("mktcap"), "nmc": pd.get("nmc"), "kind": "etf"})
            have.add(c)
            added_etf += 1
        print("  ETF 来源：%s（全网 %d 只按主题去重后保留 %d 只）"
              % (os.path.basename(pick_path), sum(p.get("groupSize", 1) for p in picks), len(picks)))
    else:
        print("  未找到 _etf_pick.json，回退旧数据里的 ETF（先跑 tools/build_etf.py 可全网去重）")
        if not any(r.get("kind") == "etf" for r in etf_rows):
            for bak in ("data.js.bak-158", "data.js.bak"):
                bp = os.path.join(site, bak)
                if os.path.isfile(bp):
                    try:
                        etf_rows = load_rows_file(bp)
                        break
                    except Exception:
                        pass
        for r in etf_rows:
            c = r.get("code")
            if r.get("kind") == "etf" and c and c not in have:
                universe.append({"code": c, "sym": to_sym(c), "name": r.get("name") or c,
                                 "mktcap": r.get("mcap"), "nmc": r.get("nmc"), "kind": "etf"})
                have.add(c)
                added_etf += 1
    if picks:
        # 股票列表（新浪 hs_a）里偶尔混入 ETF 代码；这些若不在去重结果里就剔除，
        # 否则会出现「同一主题两只」。
        etf_ok = {pd["code"] for pd in picks}
        def _is_fund_code(c):
            return re.match(r"^(50|51|52|56|58|15|16)", c.split(".")[0]) is not None
        before = len(universe)
        universe = [u for u in universe
                    if u.get("kind") == "etf" or u["code"] in etf_ok or not _is_fund_code(u["code"])]
        if before != len(universe):
            print("  剔除股票列表中混入的基金代码 %d 只" % (before - len(universe)))

    # 保留旧 ETF 行的策展字段（跟踪指数/费率等）
    for r in etf_rows:
        if r.get("kind") == "etf" and r.get("code"):
            old_by_code.setdefault(r["code"], r)
    if added_etf:
        print("  追加 ETF %d 只到标的池" % added_etf)

    clen = args.closes_len if args.closes_len is not None else 61

    def worker(item):
        code, sym, name = item["code"], item["sym"], item["name"]
        kl = _kline_cache_get(cache_dir, code, "v2", args.fresh)
        src = "cache"
        if kl is None:
            kl, src = fetch_kline_any(sym, 320)
            if kl:
                _kline_cache_put(cache_dir, code, "v2", kl)
        if not kl:
            return code, None
        pct = compute_pct(kl)
        all_closes = [round(r[2], 2) for r in kl if r[2]]
        closes = all_closes[-clen:] if clen else []
        # 年线锚点：250 个交易日前那一根收盘（用于打开时实时重算 w250）
        c250 = all_closes[-251] if len(all_closes) >= 251 else None
        base_date = re.sub(r"\D", "", str(kl[-1][0])) if kl else None
        chan = analyze_chan(kl)          # 缠论：中枢位置 / 笔方向 / 背驰
        flags = []
        if src == "sina-raw":
            flags.append("北交所/新浪源为不复权收盘，除权日附近窗口可能偏差")
        if c250 is None:
            flags.append("上市不足 251 个交易日，年线（250日）不可得")
        _iv = ind_map.get(code)
        if isinstance(_iv, dict):
            # 用东财「三级」：用户口语里的「汽车零部件」「计算机设备」正是三级，
            # 二级会把它们并成「汽车」「计算机软件」，反而对不上。
            _ind = _iv.get("ind") or _iv.get("l2")
            _l1, _l2 = _iv.get("l1"), _iv.get("l2")
        else:
            _ind, _l1, _l2 = _iv, None, None
        return code, {
            "code": code, "name": name, "kind": item.get("kind") or "stock", "tier": "full",
            "pct": pct, "ind": _ind, "indL1": _l1, "indL2": _l2,
            "fund": None, "fundLabel": None,
            "closes": closes, "c250": c250, "baseDate": base_date, "chan": chan,
            # 仅用于「当前状态已持续几天」的回溯（120 根），不写入 data.js，不增体积
            "closesFull": all_closes[-120:],
            "klSrc": src, "klFlags": flags,
            # 新浪 mktcap/nmc 单位是「万元」，本站统一用「亿元」（与旧快照一致）
            "mcap": round(item["mktcap"] / 1e4, 2) if item.get("mktcap") else None,
            "nmc": round(item["nmc"] / 1e4, 2) if item.get("nmc") else None,
        }

    items, ok, fail = [], 0, 0
    print("并发拉取日K（线程=%d）…" % args.threads)
    with ThreadPoolExecutor(max_workers=args.threads) as ex:
        futs = {ex.submit(worker, it): it["code"] for it in universe}
        done = 0
        for fut in as_completed(futs):
            done += 1
            try:
                code, res = fut.result()
            except Exception:
                code, res = futs[fut], None
            if res is None:
                fail += 1
            else:
                ok += 1
                res["_old"] = old_by_code.get(code)
                items.append(res)
            if done % 500 == 0 or done == len(universe):
                print("  %d/%d，成功 %d，失败 %d" % (done, len(universe), ok, fail))
    print("日K 拉取完成：成功 %d，失败 %d" % (ok, fail))

    slim = [{k: it.get(k) for k in ("code", "name", "kind", "tier", "pct", "ind", "fund",
                                    "fundLabel", "rank", "closes", "c250", "chan", "closesFull")}
            for it in items]
    eng = run_engine(slim, site)
    asof = time.strftime("%Y-%m-%d")
    rows_new, merged = [], 0
    for it in items:
        eo = eng.get(it["code"])
        if not eo:
            continue
        old = it.get("_old")
        base = dict(old) if old else it
        row = assemble_row(base, it["pct"], it["ind"], it["fund"], it["fundLabel"], eo,
                           asof, (old.get("tier") if old else "full"),
                           it.get("closes"), it.get("baseDate"), it.get("c250"))
        row["mcap"] = it.get("mcap") or row.get("mcap")
        row["nmc"] = it.get("nmc") or row.get("nmc")
        row["klSrc"] = it.get("klSrc")
        if it.get("indL1"):
            row["indL1"] = it["indL1"]
        if it.get("indL2"):
            row["indL2"] = it["indL2"]
        if it.get("chan"):
            row["chan"] = it["chan"]          # 供结构派判断中枢位置/笔/背驰
        if it.get("klFlags"):
            row["dataFlags"] = list(row.get("dataFlags") or []) + it["klFlags"]
        if old:
            merged += 1
        rows_new.append(row)
    # 标记「日K 最新只到某天」的标的：这类标的 baseDate 落后，区间窗口会失真，
    # 必须让用户看见，而不是把「起 04-29 · 已 2 个交易日」当成正常结论。
    from collections import Counter as _C
    _dates = [r["baseDate"] for r in rows_new if r.get("baseDate")]
    if _dates:
        _mode = _C(_dates).most_common(1)[0][0]
        _stale = 0
        for r in rows_new:
            bd = r.get("baseDate")
            if not bd or bd == _mode:
                continue
            try:
                import datetime as _dt
                d1 = _dt.date(int(bd[:4]), int(bd[4:6]), int(bd[6:8]))
                d2 = _dt.date(int(_mode[:4]), int(_mode[4:6]), int(_mode[6:8]))
                gap = (d2 - d1).days
            except Exception:
                gap = 0
            if gap > 5:
                r.setdefault("dataFlags", []).append(
                    "日K最新仅到 %s-%s-%s（市场已到 %s-%s-%s），区间窗口与持续天数可能失真"
                    % (bd[:4], bd[4:6], bd[6:8], _mode[:4], _mode[4:6], _mode[6:8]))
                r["klStale"] = True
                _stale += 1
        if _stale:
            print("  标记「日K陈旧」标的 %d 只（数据源未更新到最新交易日）" % _stale)

        # ---- 剔除「已退市 / 已清盘」标的 ----
        # 依据：日K 最后日期距市场基准日太远，且远到不可能是正常停牌。
        # 阈值按类型分开，避免误删「重组停牌」的个股：
        #   ETF 清盘后不再更新（清盘即退市）→ 60 天
        #   个股 长期停牌 → 90 天（短于这个仍然保留，只标 klStale）
        # 被剔除的会在 meta.removed 里留痕，页面可查，不是"悄悄消失"。
        _removed = []
        _keep = []
        for r in rows_new:
            bd = r.get("baseDate")
            if not bd or bd == _mode:
                _keep.append(r)
                continue
            try:
                import datetime as _dt
                d1 = _dt.date(int(bd[:4]), int(bd[4:6]), int(bd[6:8]))
                d2 = _dt.date(int(_mode[:4]), int(_mode[4:6]), int(_mode[6:8]))
                gap = (d2 - d1).days
            except Exception:
                gap = 0
            limit = 60 if r.get("kind") == "etf" else 90
            if gap > limit:
                _removed.append({"code": r.get("code"), "name": r.get("name"),
                                 "lastBar": "%s-%s-%s" % (bd[:4], bd[4:6], bd[6:8]),
                                 "gapDays": gap, "kind": r.get("kind")})
            else:
                _keep.append(r)
        if _removed:
            rows_new = _keep
            REMOVED.extend(_removed)
            print("  剔除已退市/已清盘标的 %d 只（日K 停在 60/90 天前）：%s"
                  % (len(_removed), "、".join(x["name"] for x in _removed[:5]) + ("…" if len(_removed) > 5 else "")))

    # ---- 指数三态（我的看板首屏）----
    global INDEX_STATES
    INDEX_STATES = build_index_states(site, args.cache or os.path.join(site, "_kline_cache"))

    # ---- ETF 归入行业：让「行业」页能直接看到对应 ETF（排在成分股第一位） ----
    # ETF 没有企业财报，东财 BASIC_ORGINFO 里也没有它，只能用「名称关键词 → 三级行业」映射。
    # 关键词按「越具体越优先」排列，命中第一个存在的行业即止；匹配不上就留空，
    # 页面会标「ETF 主题未匹配」，不硬塞（宽基 / 策略类 ETF 本来就不属于某个行业）。
    etf_theme = [
        ("沪深300", ""), ("中证500", ""), ("中证1000", ""), ("中证2000", ""), ("上证50", ""),
        ("科创50", ""), ("科创100", ""), ("创业板", ""), ("北证", ""), ("上证180", ""),
        ("红利", ""), ("价值", ""), ("成长", ""), ("低波", ""), ("央企", ""), ("国企", ""),
        ("人工智能", "其他软件服务"), ("AI", "其他软件服务"), ("云计算", "云服务(含IDC、CDN)"),
        ("大数据", "其他软件服务"), ("网络安全", "其他软件服务"), ("数字经济", "其他软件服务"),
        ("金融科技", "其他互联网金融"), ("区块链", "其他软件服务"), ("信创", "基础软件"),
        ("传媒", "影视"), ("影视", "影视"), ("游戏", "游戏娱乐"), ("动漫", "影视"),
        ("文化", "影视"), ("出版", "平面媒体"), ("广电", "有线电视"), ("元宇宙", "游戏娱乐"),
        ("房地产", "房地产开发"), ("地产", "房地产开发"), ("物业", "一般物业经营"),
        ("医疗", "医疗器械"), ("医药", "化学制剂"), ("创新药", "化学制剂"), ("生物医药", "生物医药"),
        ("疫苗", "生物医药"), ("中药", "中药生产"), ("CXO", "化学辅料药"), ("器械", "医疗器械"),
        ("养殖", "养殖"), ("畜牧", "养殖"), ("种业", "种子"), ("农业", "种植业"), ("饲料", "饲料"),
        ("渔业", "海洋渔业"), ("化工", "其他化学制品"), ("新材料", "化学新材料"),
        ("机器人", "工业机器人"), ("机床", "机床设备"), ("机械", "其他通用机械"),
        ("工程机械", "工程机械"), ("家电", "白色家电"), ("小家电", "小家电"),
        ("光伏", "太阳能"), ("太阳能", "太阳能"), ("风电", "风能"), ("氢能", "其他电源设备"),
        ("核电", "其他发电"), ("储能", "储能设备"), ("电池", "电池材料"), ("锂电", "电池材料"),
        ("新能源车", "乘用车"), ("汽车", "汽车零部件"), ("智能汽车", "汽车零部件"),
        ("建材", "其他建材"), ("水泥", "水泥"), ("玻璃", "玻璃"), ("钢铁", "普钢"),
        ("煤炭", "煤炭开采洗选"), ("电力", "火电"), ("公用事业", "水务"),
        ("军工", "航空装备"), ("国防", "航空装备"), ("航天", "航天装备"), ("卫星", "卫星应用"),
        ("船舶", "船舶制造"), ("芯片", "集成电路"), ("半导体", "集成电路"),
        ("消费电子", "消费电子设备"), ("面板", "显示器件"), ("光模块", "通信传输设备"),
        ("通信", "通信传输设备"), ("5G", "通信传输设备"), ("运营商", "通信运营"),
        ("食品饮料", "食品综合"), ("食品", "食品综合"), ("白酒", "白酒"), ("酒", "白酒"),
        ("乳", "乳制品"), ("调味品", "调味品"), ("啤酒", "啤酒"), ("消费", "食品综合"),
        ("旅游", "旅游服务"), ("酒店", "酒店"), ("餐饮", "餐饮"), ("免税", "百货"),
        ("零售", "百货"), ("超市", "超市"), ("电商", "网上购物"), ("互联网", "其他互联网服务"),
        ("证券", "证券"), ("券商", "证券"), ("银行", "股份制与城商行"), ("保险", "保险"),
        ("信托", "信托"), ("支付", "第三方支付"), ("黄金", "黄金"), ("有色", "铜"),
        ("铜", "铜"), ("铝", "铝"), ("锂", "锂"), ("稀土", "稀土"), ("小金属", "其他稀有小金属"),
        ("煤炭", "煤炭开采洗选"), ("石油", "石油加工"), ("油气", "石油天然气开采"),
        ("天然气", "燃气"), ("电网", "其他输变电设备"), ("特高压", "其他输变电设备"),
        ("基建", "专业工程"), ("建筑", "房屋建筑"), ("港口", "港口"), ("航运", "航运"),
        ("航空", "航空"), ("物流", "物流"), ("快递", "物流"), ("铁路", "铁路运输"),
        ("高速", "高速公路"), ("环保", "环保"), ("碳中和", "环保"), ("水务", "水务"),
        ("纺织", "其他纺织"), ("服装", "服装"), ("造纸", "造纸"), ("包装", "包装印刷"),
        ("家居", "家具制造"), ("教育", "教育信息化服务"), ("养老", "保健护理产品"),
        ("创新医疗", "医疗服务"), ("医疗设备", "医疗器械"), ("互联网医疗", "医疗服务"),
    ]
    inds = set()
    for r in rows_new:
        if r.get("kind") != "etf" and r.get("ind"):
            inds.add(r["ind"])
    matched = 0
    for r in rows_new:
        if r.get("kind") != "etf":
            continue
        nm = str(r.get("name") or "")
        best = None
        # ① 先按「行业名直接出现在 ETF 名里」匹配（最长优先，避免"银行"吃掉"股份制银行"）
        for ind in inds:
            if len(ind) >= 3 and ind in nm and len(ind) > len(best or ""):
                best = ind
        # ② 行业名去掉"其他"前缀再试（「其他专用机械」→「专用机械」）
        if not best:
            for ind in inds:
                core = ind[2:] if ind.startswith("其他") and len(ind) > 4 else ""
                if core and core in nm and len(core) > 1:
                    best = ind
                    break
        # ③ 再按同义词表
        if not best:
            for kw, ind in etf_theme:
                if kw and kw in nm:
                    if ind == "":
                        best = ""       # 宽基 / 策略：明确不归属任何行业
                        break
                    if ind in inds:
                        best = ind
                        break
        if best:
            r["ind"] = best
            r["indSrc"] = "etf-name"
            matched += 1
    print("  ETF 归入行业：%d / %d 只有对应行业（其余为宽基/策略类，留在 ETF 视图）"
          % (matched, sum(1 for x in rows_new if x.get("kind") == "etf")))
    # ---- 每个行业只保留 1 只「代表 ETF」----
    # 用户的规则：同行业放第一位的 ETF，费率最低优先；费率相同取规模最大。
    # 我们的费率源（基金概况页）目前取不到，所以：有 fee 字段就按费率，没有就按规模，
    # 并在页面上标明"按规模选"，不假装按费率排过。
    _by_ind = {}
    for r in rows_new:
        if r.get("kind") == "etf" and r.get("ind"):
            _by_ind.setdefault(r["ind"], []).append(r)
    _dropped = 0
    for ind, lst in _by_ind.items():
        if len(lst) <= 1:
            continue
        def _key(x):
            fee = x.get("fee")
            has_fee = isinstance(fee, (int, float)) and fee > 0
            size = x.get("mcap") or 0
            # (没有费率排后面, 费率升序, 规模降序)
            return (0 if has_fee else 1, fee if has_fee else 0, -size)
        lst.sort(key=_key)
        for r in lst[1:]:
            r["ind"] = None          # 退回 ETF 视图，不进行业
            _dropped += 1
    if _dropped:
        print("  每行业只保留 1 只代表 ETF，退回 ETF 视图 %d 只（费率源不可用 → 按规模选）" % _dropped)


    # ---- 合并全市场估值（腾讯批量，tools/fetch_valuation.py）----
    # 目的：让「贵不贵」能跟同行业比，而不是只看自己的历史分位。
    # 同时把总市值换成腾讯口径（交易所同源，单位亿元），比新浪的「万元」再换算更可靠。
    _val = {}
    _vp = os.path.join(site, "_valuation.json")
    if os.path.isfile(_vp):
        try:
            _val = json.load(open(_vp, encoding="utf-8"))
        except Exception:
            _val = {}
    if _val:
        _hit = 0
        for r in rows_new:
            v = _val.get(r.get("code"))
            if not v:
                continue
            if isinstance(v.get("pe"), (int, float)):
                r["pe"] = round(v["pe"], 2)
            if isinstance(v.get("pb"), (int, float)):
                r["pb"] = round(v["pb"], 2)
            if isinstance(v.get("turn"), (int, float)):
                r["turn"] = round(v["turn"], 2)
            if isinstance(v.get("totalCap"), (int, float)) and v["totalCap"] > 0:
                r["mcap"] = round(v["totalCap"], 2)
            if isinstance(v.get("floatCap"), (int, float)) and v["floatCap"] > 0:
                r["floatCap"] = round(v["floatCap"], 2)
            _hit += 1
        print("  合并全市场估值：%d 只（PE/PB/换手/总市值）" % _hit)
    else:
        print("  未找到 _valuation.json → 估值字段留空（先跑 tools/fetch_valuation.py）")

    # ---- 行业中位 PE：给「本股相对同行贵不贵」提供基准 ----
    # 只统计 PE>0 且 <300 的（亏损股与异常值不参与中位数，否则中位数会被带偏）。
    _byind = {}
    for r in rows_new:
        pe = r.get("pe")
        ind = r.get("ind")
        if ind and isinstance(pe, (int, float)) and 0 < pe < 300:
            _byind.setdefault(ind, []).append(pe)
    IND_PE.clear()
    for k, v in _byind.items():
        if len(v) >= 5:
            v.sort()
            n = len(v)
            IND_PE[k] = round(v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2.0, 2)
    print("  行业中位 PE：%d 个行业（样本≥5 只）" % len(IND_PE))



    print("组装完成：%d 只（其中 %d 只已存在→保留原有策展/舆情字段）" % (len(rows_new), merged))
    # 全市场基准：样本 w20/w60 中位数 → RRG 以全市场为锚
    bm = {
        "m20": round(_median([r["pct"].get("w20") for r in items]), 4),
        "m60": round(_median([r["pct"].get("w60") for r in items]), 4),
    }
    print("全市场基准 bm = %s（用于 RRG 相对强度）" % bm)
    return rows_new, bm


# ---------------- curated 模式（旧行为）----------------

def build_curated(site, args, existing):
    rows_old = existing.get("rows") or []
    asof = time.strftime("%Y-%m-%d")
    print("标的池：%d 只，开始重算…" % len(rows_old))
    since = args.since or _default_since()
    cache_dir = args.cache or os.path.join(site, "_kline_cache")
    ind_map = {}
    if (not args.no_ind) and (not args.dry_run) and ak() is not None:
        ind_map = fetch_industry_map_ak(os.path.join(site, "_ind_map.json"))

    fetched = {}
    items = []
    for r in rows_old:
        code = r.get("code")
        if not code:
            continue
        if args.dry_run:
            pct = r.get("pct") or {"w5": None, "w20": None, "w60": None, "w250": None}
            ind = r.get("ind"); fund = r.get("fund"); fundLabel = r.get("fundLabel")
        else:
            kl = _kline_cache_get(cache_dir, code, since, args.fresh)
            if kl is None:
                kl = fetch_kline_ak(code, since)
                if kl:
                    _kline_cache_put(cache_dir, code, since, kl)
            if not kl:
                print("  [跳过] %s 日K拉取失败，保留原 row" % code)
                continue
            pct = compute_pct(kl)
            ind = ind_map.get(code, r.get("ind"))
            fund = fundLabel = None
            if args.fund:
                fund, fundLabel = fetch_fund_ak(code)
            time.sleep(0.1)
        fetched[code] = (pct, ind, fund, fundLabel)
        items.append({"code": code, "name": r.get("name"), "kind": r.get("kind"),
                      "tier": r.get("tier"), "pct": pct, "ind": ind,
                      "fund": fund, "fundLabel": fundLabel})

    eng = run_engine(items, site)
    rows_new, kept = [], 0
    for r in rows_old:
        code = r.get("code")
        if code not in fetched or code not in eng:
            rows_new.append(r); kept += 1; continue
        pct, ind, fund, fundLabel = fetched[code]
        rows_new.append(assemble_row(r, pct, ind, fund, fundLabel, eng[code], asof, r.get("tier", "core")))
    return rows_new, None, kept


# ---------------- 离线自检（合成标的，不联网）----------------

def build_self_test(site, args, existing):
    random.seed(20261113)
    n = args.max or 500
    items = []
    for i in range(n):
        code = "%06d" % ((600000 + i) if i % 2 == 0 else (1 + i))
        code = code[:6] + _suffix(code[:6])
        # 合成一条随机游走日K（~300 根），用于验证 compute_pct + 引擎 + 组装链路
        price = 10.0
        kl = []
        for d in range(300):
            price *= (1 + random.uniform(-0.03, 0.035))
            kl.append(["2025-%02d-%02d" % ((d // 28) % 12 + 1, d % 28 + 1),
                       price, price, price, price, 1, None, None])
        pct = compute_pct(kl)
        closes = [round(r[2], 2) for r in kl if r[2]][-(args.closes_len or 300):]
        base_date = re.sub(r"\D", "", str(kl[-1][0]))
        items.append({"code": code, "name": "合成股%d" % i, "kind": "stock",
                      "tier": "full", "pct": pct, "ind": None,
                      "fund": None, "fundLabel": None,
                      "closes": closes, "baseDate": base_date})
    slim = [{k: it.get(k) for k in ("code", "name", "kind", "tier", "pct", "ind", "fund", "fundLabel", "rank")}
            for it in items]
    eng = run_engine(slim, site)
    rows_new = [assemble_row(it, it["pct"], None, None, None, eng[it["code"]],
                             "2026-11-13", "full", it.get("closes"), it.get("baseDate"))
                for it in items if it["code"] in eng]
    return rows_new, {"m20": 0.0, "m60": 0.0}


# ---------------- 主流程 ----------------

def main():
    ap = argparse.ArgumentParser(description="用免费开源源重算 data.js（全市场 / 去 iFinD）")
    ap.add_argument("--site", default=SITE_DEFAULT)
    ap.add_argument("--universe", choices=["full", "curated"], default="full")
    ap.add_argument("--max", type=int, default=0, help="最多处理 N 只（试跑用）")
    ap.add_argument("--threads", type=int, default=6, help="并发线程数")
    ap.add_argument("--closes-len", type=int, default=61,
                    help="每只存储近 N 日收盘（供「打开即实时」重算四窗口；0=不存，页面退回快照结论）")
    ap.add_argument("--since", default=None, help="日K 起始日 YYYYMMDD（默认约 430 天前）")
    ap.add_argument("--fund", action="store_true", help="拉取主力资金流（六派资金派完整；更慢）")
    ap.add_argument("--no-ind", action="store_true", help="跳过行业反查")
    ap.add_argument("--no-fund", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--cache", default=None, help="日K 缓存目录")
    ap.add_argument("--fresh", action="store_true", help="忽略缓存重新拉取")
    ap.add_argument("--resume", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--dry-run", action="store_true", help="写 _dry_data.js 不覆盖原文件")
    ap.add_argument("--self-test", action="store_true", help="合成标的离线自检，不联网")
    args = ap.parse_args()
    site = args.site
    if not os.path.isdir(site):
        print("站点目录不存在：%s" % site)
        return 1

    existing = load_existing(site)
    engine = existing.get("engine") or {}
    top = existing

    if args.self_test:
        print("== 离线自检：合成 %d 只，不联网验证流水线 ==" % (args.max or 500))
        rows_new, bm = build_self_test(site, args, existing)
        if bm:
            engine = dict(engine); engine["bm"] = bm
        obj = {"meta": {"source": "selftest", "pool": "full", "asOf": "2026-11-13",
                        "full": True, "count": len(rows_new)},
               "market": top.get("market"), "summary": "[selftest]",
               "summaryEtf": "[selftest]", "summaryStock": "[selftest]",
               "summaryCore": "[selftest]", "summaryExt": "[selftest]",
               "themes": [], "themeAgg": [], "themeKeywords": [],
               "rows": rows_new, "indexStates": INDEX_STATES, "engine": engine, "voteDef": VOTE_DEF,
               "caveat": "selftest"}
        sp = os.path.join(site, "_selftest_data.js")
        with open(sp, "w", encoding="utf-8", newline="\n") as f:
            f.write("window.AB_DATA = " + json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + ";\n")
        # 校验：用 node 重新载入，确认行数 / 字段完整
        ok = subprocess.run(["node", "-e",
            "global.window={};var fs=require('fs');"
            "var s=fs.readFileSync(%r,'utf8').replace(/^\\ufeff/,'').replace(/window\\.AB_DATA\\s*=/,'global.window.AB_DATA =');"
            "(0,eval)(s);var d=global.window.AB_DATA;var r=d.rows;"
            "var n=r.length, ks=r[0]?Object.keys(r[0]).length:0;"
            "var hasScore=r.every(function(x){return x.scores&&x.scores.structure!=null&&x.state});"
            "var hasSeries=r.every(function(x){return Array.isArray(x.series)&&x.series.length===5;});"
            "var hasCloses=r.every(function(x){return Array.isArray(x.closes)&&x.closes.length>10;});"
            "console.log('SELFTEST rows='+n+' keys='+ks+' scoreOk='+hasScore+' series5='+hasSeries+' closes='+hasCloses);"
            "if(n!==%d||!hasScore||!hasSeries||!hasCloses){process.exit(1);}" % (sp, len(rows_new))],
            cwd=site)
        if ok.returncode == 0:
            print("自检通过：%d 只全部含六派分数 / 三态 / 5点序列。产物 %s" % (len(rows_new), sp))
        else:
            print("自检失败：字段不完整，见上。")
        return 0 if ok.returncode == 0 else 1

    if args.universe == "curated":
        rows_new, bm, kept = build_curated(site, args, existing)
        if args.dry_run:
            _dry(site, engine, existing, rows_new)
            print("dry-run 完成：写出 _dry_data.js（%d 重算，%d 沿用）。" % (len(rows_new) - kept, kept))
            return 0
        if bm:
            engine = dict(engine); engine["bm"] = bm
        meta = existing.get("meta") or {}
        _patch_meta(meta, "curated")
        write_data_js(site, engine, meta, rows_new, existing, False)
        print("data.js 已重算并覆盖：%d 只重算，%d 只沿用原值。" % (len(rows_new) - kept, kept))
        return 0

    # —— full 模式 ——
    rows_new, bm = build_full(site, args, existing)
    if rows_new is None:
        return 1
    if bm:
        engine = dict(engine); engine["bm"] = bm
    meta = existing.get("meta") or {}
    _patch_meta(meta, "full", len(rows_new))
    if args.dry_run:
        _dry(site, engine, existing, rows_new)
        print("dry-run 完成：写出 _dry_data.js（%d 只全市场）。" % len(rows_new))
        return 0
    write_data_js(site, engine, meta, rows_new, existing, True)
    print("data.js 已全市场重算并覆盖：%d 只 A 股。" % len(rows_new))
    return 0


def _patch_meta(meta, mode, count=None):
    meta["source"] = "免费开源(腾讯/新浪)全市场重算"
    meta["asOf"] = time.strftime("%Y-%m-%d")
    meta["asOfCore"] = meta["asOf"]
    meta["asOfExt"] = meta["asOf"]
    meta["enriched"] = False
    meta["full"] = True
    meta["pool"] = "full"
    if count is not None:
        meta["count"] = count
    meta["enrichNote"] = "价格由腾讯/新浪免费源重算；语义富化字段已诚实降级"
    if IND_PE:
        meta["indPE"] = IND_PE
    if REMOVED:
        meta["removed"] = REMOVED
        meta["removedNote"] = ("已剔除 %d 只长期无成交的标的（ETF 清盘 60 天 / 个股停牌 90 天以上），"
                               "名单见 meta.removed，不做静默删除" % len(REMOVED))
    meta["newsMeta"] = {"src": "offline-free", "note": "未含"}


def _dry(site, engine, existing, rows_new):
    dry_path = os.path.join(site, "_dry_data.js")
    obj = {
        "meta": {**{k: v for k, v in (existing.get("meta") or {}).items()},
                 "source": "akshare(免费开源)全市场重算[dry-run]", "full": True, "count": len(rows_new)},
        "market": existing.get("market"), "summary": "[dry-run]", "summaryEtf": "[dry-run]",
        "summaryStock": "[dry-run]", "summaryCore": "[dry-run]", "summaryExt": "[dry-run]",
        "themes": [], "themeAgg": [], "themeKeywords": [],
        "rows": rows_new, "engine": engine, "voteDef": existing.get("voteDef"),
        "caveat": "dry-run 产物，未覆盖 data.js",
    }
    with open(dry_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("/* dry-run 产物，未覆盖 data.js */\nwindow.AB_DATA = " +
                json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + ";\n")


if __name__ == "__main__":
    sys.exit(main())
