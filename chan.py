#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三态看盘 · 简化缠论（形态学部分）
==================================
参考 GitHub 成熟实现 Vespa314/chan.py（2.3k★）与 chanlun-pro 的形态学思路，
只取「对结构判断有用」的三件事，不追求完整缠论体系：

  1) 分型：3 根 K 线的顶/底分型（顶：中间最高价同时不低于左右；底：反之）
  2) 笔　：分型必须顶底交替，且两端间隔 ≥ 4 根 K 线（缠论「笔」的最低成立条件）
  3) 中枢：连续三笔的价格重叠区间 [ZD, ZG]，取最近一个
  4) 背驰：最后一笔与前一同向笔比较 —— 创新极值但幅度更小 → 背驰

刻意不做：线段、级别递归、区间套、走势类型划分（成本高且对「当前结构位置」判断增益有限）。

输出一个小字典，写进 data.js 的 row.chan，由 six-engine 的结构派消费：
  {zg, zd, pos: above|in|below|na, bi: up|down, diverg: bool, biCount}
"""


def analyze_chan(kl, min_bars=40):
    """kl: [[date, open, close, high, low, vol, ...], ...] 升序；不足则返回 None。"""
    if not kl or len(kl) < min_bars:
        return None
    highs = [r[3] for r in kl]
    lows = [r[4] for r in kl]
    closes = [r[2] for r in kl]
    n = len(kl)

    # ---------- 1) 分型 ----------
    fx = []
    for i in range(1, n - 1):
        h, l = highs[i], lows[i]
        if h >= highs[i - 1] and h >= highs[i + 1] and (h > highs[i - 1] or h > highs[i + 1]):
            fx.append((i, 1, h))        # 顶分型
        elif l <= lows[i - 1] and l <= lows[i + 1] and (l < lows[i - 1] or l < lows[i + 1]):
            fx.append((i, -1, l))       # 底分型

    # ---------- 2) 成笔 ----------
    pts = []
    for i, t, p in fx:
        if not pts:
            pts.append((i, t, p))
            continue
        li, lt, lp = pts[-1]
        if t == lt:
            # 同向分型：保留更极端者（顶取更高、底取更低）
            if (t == 1 and p > lp) or (t == -1 and p < lp):
                pts[-1] = (i, t, p)
        else:
            if i - li >= 4:
                pts.append((i, t, p))
            else:
                # 间隔不足 4 根：不成立新笔；若更极端则视作上一笔的延伸
                if (t == 1 and p > lp) or (t == -1 and p < lp):
                    pts[-1] = (i, t, p)
    if len(pts) < 4:
        return None

    # ---------- 3) 中枢（最近一个连续三笔的重叠区间） ----------
    zg = zd = None
    for k in range(len(pts) - 4, -1, -1):
        segs = []
        for j in range(k, k + 3):
            a, b = pts[j][2], pts[j + 1][2]
            segs.append((min(a, b), max(a, b)))
        hi = min(s[1] for s in segs)
        lo = max(s[0] for s in segs)
        if hi > lo:                      # 三笔有重叠 → 构成中枢
            zg, zd = hi, lo
            break

    last = closes[-1]
    if zg and zd:
        pos = "above" if last > zg else ("below" if last < zd else "in")
    else:
        pos = "na"

    # ---------- 4) 笔方向与背驰 ----------
    bi = "up" if pts[-1][1] == 1 else "down"   # 最后一个端点是顶 → 最近一笔向上
    moves = []
    for j in range(len(pts) - 1):
        p0, p1 = pts[j][2], pts[j + 1][2]
        moves.append({
            "dir": "up" if pts[j + 1][1] == 1 else "down",
            "pct": (p1 - p0) / p0 * 100 if p0 else 0.0,
            "end": p1,
        })
    diverg = False
    if len(moves) >= 3:
        cur = moves[-1]
        prev_same = None
        for m in reversed(moves[:-1]):
            if m["dir"] == cur["dir"]:
                prev_same = m
                break
        if prev_same:
            if cur["dir"] == "up" and cur["end"] > prev_same["end"] and abs(cur["pct"]) < abs(prev_same["pct"]):
                diverg = True            # 顶背驰：新高但力度衰减
            elif cur["dir"] == "down" and cur["end"] < prev_same["end"] and abs(cur["pct"]) < abs(prev_same["pct"]):
                diverg = True            # 底背驰

    return {
        "zg": round(zg, 2) if zg else None,
        "zd": round(zd, 2) if zd else None,
        "pos": pos,
        "bi": bi,
        "diverg": diverg,
        "biCount": len(pts) - 1,
    }


if __name__ == "__main__":
    # 自检：构造一段「上涨—回落—再上涨但力度减弱」的走势，应识别出中枢与顶背驰
    bars, price = [], 10.0
    for i in range(60):
        step = 0.09 if i < 20 else (-0.07 if i < 40 else 0.04)
        price *= (1 + step)
        bars.append(["d%02d" % i, price, price, price * 1.01, price * 0.99, 1000])
    print(analyze_chan(bars))
