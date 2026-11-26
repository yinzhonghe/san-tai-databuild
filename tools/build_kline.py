# -*- coding: utf-8 -*-
"""把日K「预生成」成静态分片，供页面按需读取真实蜡烛图。

为什么必须预生成
----------------
纯静态页面在浏览器里只能靠 JSONP 或 CORS 拿数据，而实测三个日K源都不给：
  · 东财 push2his：加 cb / callback 就返回空，且无 CORS 头
  · 新浪 quotes.sina.cn：直接忽略 callback，返回裸 JSON，无 CORS 头
  · 腾讯 web.ifzq：构建期高频请求后被 WAF 拦截
所以「前端实时取日K」在架构上走不通。改为构建时把真实前复权日K 打包成
**按代码分片的同源静态文件**，页面打开某只标的时只取它所在的那一个分片。
同源读取不受 CORS 限制，也不需要任何后端。

编码（体积优先）
----------------
每只标的一串字符，bar 之间用 ';' 分隔，每个 bar 固定 15 个字符：
  [0:3]  日期：距 2020-01-01 的天数，base36（3 位）
  [3:6]  开盘：相对「上一根收盘」的差分（单位：分）+8192，base36
  [6:9]  最高：同上
  [9:12] 最低：同上
  [12:15]收盘：同上
  [15:17]成交量：log10(量+1)×100 的 base36（2 位，用于画量柱，够看形状不追求精确）
差分而不是绝对值，是因为相邻两天价格接近，base36 只需 3 位就能覆盖 ±4000 分
（±40 元）的日常波动，高價股的极端跳空由 8192 偏移与截断保护兜底。

用法：
  python tools/build_kline.py --cache "C:/Users/.../Temp/kc" --bars 250
  python tools/build_kline.py --self-test          # 不联网，校验编解码
"""

import argparse
import glob
import math
import time
import time
import json
import os
import sys

B36 = "0123456789abcdefghijklmnopqrstuvwxyz"
EPOCH_Y, EPOCH_M, EPOCH_D = 2020, 1, 1
OFFSET = 8192
CHUNK = 200          # 每个分片容纳的标的数（≈700KB，gzip 后约 250KB）


def _b36(n, width):
    """整数 → 定长 base36（负数先加偏移，调用方负责）。"""
    if n < 0:
        n = 0
    out = ""
    while n > 0:
        out = B36[n % 36] + out
        n //= 36
    out = out or "0"
    if len(out) > width:
        out = out[-width:]
    return out.rjust(width, "0")


def _days_since_epoch(y, m, d):
    import datetime
    return (datetime.date(y, m, d) - datetime.date(EPOCH_Y, EPOCH_M, EPOCH_D)).days


def encode(bars):
    """bars: [(date_str, open, close, high, low, volume)] → 紧凑字符串

    首 4 位是「第一根收盘价（分）」的绝对值 base36（36^4 ≈ 1677 万元，足够），
    之后每根都是相对前一根收盘的差分，避免存绝对值浪费位宽。
    """
    prev_close = None
    prev_day = None
    out = []
    head = None
    for b in bars:
        ds = str(b[0])[:10].replace("-", "")
        if len(ds) != 8:
            continue
        o, c, h, l = (float(b[1]), float(b[2]), float(b[3]), float(b[4]))
        vol = float(b[5]) if len(b) > 5 and b[5] else 0
        if min(o, c, h, l) <= 0:
            continue
        day = _days_since_epoch(int(ds[:4]), int(ds[4:6]), int(ds[6:8]))
        dlt = day if prev_day is None else day - prev_day
        base = prev_close if prev_close is not None else c
        oi, hi, li, ci = [int(round(x * 100)) for x in (o, h, l, c)]
        bi = int(round(base * 100))
        if head is None:
            head = _b36(int(round(c * 100)), 4)
        out.append(_b36(dlt, 3)
                   + _b36(oi - bi + OFFSET, 3)
                   + _b36(hi - bi + OFFSET, 3)
                   + _b36(li - bi + OFFSET, 3)
                   + _b36(ci - bi + OFFSET, 3)
                   + _b36(int(round(math.log10(vol + 1) * 100)), 2))
        prev_close, prev_day = c, day
    if head is None:
        return ""
    return head + "".join(out)


def build(cache_dir, out_dir, bars=250, chunk=CHUNK):
    files = sorted(glob.glob(os.path.join(cache_dir, "*.json")))
    if not files:
        print("缓存目录为空：%s" % cache_dir)
        return 1
    data = {}
    asof = None
    for f in files:
        code = os.path.basename(f)[:-5]
        if not code.endswith((".SH", ".SZ", ".BJ")):
            continue
        try:
            kl = json.load(open(f, encoding="utf-8")).get("kl") or []
        except Exception:
            continue
        if len(kl) < 60:
            continue
        kl = kl[-bars:]
        packed = encode(kl)
        if not packed:
            continue
        # 只保留「日」这一层，页面用短键名 d/o/h/l/c 组装
        data[code] = packed
        last = str(kl[-1][0])[:10].replace("-", "")
        if asof is None or last > asof:
            asof = last
    if not data:
        print("没有可用日K")
        return 1

    os.makedirs(out_dir, exist_ok=True)
    for old in glob.glob(os.path.join(out_dir, "s*.json")):
        os.remove(old)

    codes = sorted(data.keys())
    index = {}
    total_bytes = 0
    for i in range(0, len(codes), chunk):
        sid = i // chunk
        part = codes[i:i + chunk]
        obj = {"asOf": asof, "codes": {c: data[c] for c in part}}
        p = os.path.join(out_dir, "s%d.json" % sid)
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))
        total_bytes += os.path.getsize(p)
        for c in part:
            index[c] = sid

    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({"asOf": asof, "bars": bars, "shards": (len(codes) + chunk - 1) // chunk,
                   "stamp": int(time.time()), "map": index},
                  fh, ensure_ascii=False, separators=(",", ":"))
    print("已生成 %s：%d 只 · %d 个分片 · 合计 %.1f MB · 截至 %s"
          % (out_dir, len(codes), (len(codes) + chunk - 1) // chunk,
             total_bytes / 1048576.0, asof))
    print("平均每只 %.0f 字节（%d 根）" % (total_bytes / max(len(codes), 1), bars))
    return 0


def decode(packed):
    """自检用：把编码解回 [(day, o, h, l, c)]"""
    if len(packed) < 4:
        return []
    prev_close = int(packed[:4], 36)          # 分
    prev_day = 0
    body = packed[4:]
    rows = []
    for i in range(0, len(body) - 16, 17):
        seg = body[i:i + 17]
        dlt = int(seg[0:3], 36)
        day = dlt if prev_day == 0 else prev_day + dlt
        o, h, l, c = [int(seg[k:k + 3], 36) - OFFSET + prev_close for k in (3, 6, 9, 12)]
        v = 10 ** (int(seg[15:17], 36) / 100.0) - 1
        rows.append((day, o / 100.0, h / 100.0, l / 100.0, c / 100.0, v))
        prev_close, prev_day = c, day
    return rows


def self_test(cache_dir):
    files = sorted(glob.glob(os.path.join(cache_dir, "*.json")))[:5]
    ok = 0
    for f in files:
        kl = json.load(open(f, encoding="utf-8"))["kl"][-250:]
        packed = encode(kl)
        rows = decode(packed)
        src = [(float(b[1]), float(b[3]), float(b[4]), float(b[2])) for b in kl]  # o,h,l,c
        # 从第二根开始比对（首根是绝对基准）
        same = all(abs(round(rows[i][1], 2) - round(src[i][0], 2)) < 0.02
                   and abs(round(rows[i][2], 2) - round(src[i][1], 2)) < 0.02
                   and abs(round(rows[i][4], 2) - round(src[i][3], 2)) < 0.02
                   for i in range(1, min(len(rows), len(src))))
        print("%-14s bars=%d chars=%d 编解码一致=%s"
              % (os.path.basename(f)[:-5], len(rows), len(packed), same))
        ok += 1 if same else 0
    print("自检：%d/%d 通过" % (ok, len(files)))
    return 0 if ok == len(files) else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=r"C:/Users/36352/AppData/Local/Temp/kc")
    ap.add_argument("--out", default="")
    ap.add_argument("--bars", type=int, default=250)
    ap.add_argument("--chunk", type=int, default=CHUNK)
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return self_test(a.cache)
    site = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = a.out or os.path.join(site, "kline")
    return build(a.cache, out, a.bars, a.chunk)


if __name__ == "__main__":
    sys.exit(main())
