#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三态看盘 · 生成可公开分享的干净站点目录（dist/）
================================================
只复制「页面运行真正需要的文件」，把与运行无关的内容全部排除：
  · 项目上下文 / 对话记录（18MB，含隐私）
  · tools/ tests/ v2/ .github/ 等开发文件
  · 历史遗留单页（lens.html / sector.html / share.html / admin.html 等，主页面不再引用）
  · 备份文件（data.js.bak-*）

用法：
  python tools/build_site.py            # 生成/刷新 dist/
  python tools/build_site.py --check    # 只检查体积与文件清单，不复制
"""
import argparse
import gzip
import io
import json
import os
import shutil
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(TOOLS)
DIST = os.path.join(SITE, "dist")

# 页面运行必需（index.html 引用 + app.js 动态加载）
FILES = [
    "index.html",
    "daily.js",
    "news_data.js",     # 多源舆情快照（gen_news.py 云端采集，源数与条目见 asOf 文件内诊断）
    "oversold.html",    # 超跌反弹观察池（独立页，无导航入口）
    "oversold_data.js", # 由 tools/final_pick.js 生成
    "chan_pick_data.js", # 由 tools/chan_pick.js 生成（缠论一买+K线）
    "limitup_data.js",  # 由 tools/limitup_live.js 生成（三态主站口径「启动·新发」真实台账，超跌页板块③）
    "styles.css",
    "data.js",          # 全市场快照（含 closes / c250）
    "kline.js",
    "industry.js",
    "echarts.min.js",
    "fundflow.js",       # 资金派当日实时净流入（补快照空缺）
    "data-service.js",
    "six-engine.js",
    "app.js",
    "live-refresh.js",
    "state-path.js",
    "selfcheck.js",
    "qrcode.js",        # 分享海报二维码（app.js 动态注入）
    "learn_report.js",  # 自进化汇总（模型战绩 / 点评对账 / 三态校准）
    "poster_daily.js",  # 早报/午间/收盘长图（app.js 调用，画完转 <img>）
    "guard.js",         # 试用 / 邀请 / 风险门（index.html 与 share.html 都要）
    "share.html",       # 邀请落地页（guard.inviteLink() 指向它，缺了就是 404）
    "wechat-qr.jpg",    # 到期锁屏页的企业微信二维码（缺了就是破图）
    "cloud-sdk.js",     # 云端 SDK：邀请记账 / 同意留痕 / 全站开关都依赖它
    "admin.html",       # 后台（不硬编码私钥，需手动导入；不导入则什么也做不了）
]

# 部署平台的图片/图标（可选，缺失不影响运行）
OPTIONAL = ["icon.png", "cover.png"]


def human(n):
    return "%.1f MB" % (n / 1048576.0) if n >= 1048576 else "%d KB" % (n / 1024)


def sync_asset_versions(site_dir):
    """构建时把所有静态资源的 ?v= 统一成「构建时间戳」。

    为什么要用时间戳而不是手写版本号：
      浏览器按完整 URL 缓存静态文件。版本号不变，URL 就不变，
      于是改了 CSS/JS 之后，用户浏览器里跑的还是几天前那份 ——
      改了半天的东西在手机上看不到效果，排查起来极其费时。
    每次构建都换一个号，从根上避免这个问题。
    代价只是每次发布首屏多下载几百 KB（而数据本身就有 2MB，占比很小）。

    两件事都要做：
      1) 已经有 ?v= 的，换成新号；
      2) 裸 src="xxx.js"（还没带版本号的）补上新号 —— 否则那些文件永远吃老缓存。
         oversold.html 就是这种情况：底下的 chan_pick_data.js 每天重新生成，
         不补版本号，用户看到的一直是昨天那份信号。
    """
    import re as _re
    import datetime as _dt
    ver = _dt.datetime.now().strftime("%Y%m%d%H%M")
    for name in ("index.html", "oversold.html"):
        p = os.path.join(site_dir, name)
        if not os.path.isfile(p):
            continue
        html = open(p, encoding="utf-8").read()
        new = _re.sub(r'\?v=[0-9a-zA-Z.]+', '?v=' + ver, html)
        new = _re.sub(r'(src="[A-Za-z0-9_.\-]+\.(?:js|css))"', r'\1?v=' + ver + '"', new)
        if new != html:
            open(p, "w", encoding="utf-8").write(new)
            print("已同步 %s 的静态资源版本号 → %s" % (name, ver))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只检查不复制")
    args = ap.parse_args()

    # 先把静态资源版本号对齐，再复制 —— 顺序不能反，否则复制出去还是旧引用
    sync_asset_versions(SITE)

    missing = [f for f in FILES if not os.path.isfile(os.path.join(SITE, f))]
    if missing:
        print("缺少必需文件：" + ", ".join(missing))
        return 1

    total = sum(os.path.getsize(os.path.join(SITE, f)) for f in FILES)
    print("待发布文件 %d 个，合计 %s" % (len(FILES), human(total)))
    for f in FILES:
        print("  %-20s %8s" % (f, human(os.path.getsize(os.path.join(SITE, f)))))
    if total > 8 * 1048576:
        print("⚠ 体积偏大（>8MB），首次加载会比较慢")

    if args.check:
        return 0

    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(DIST, exist_ok=True)
    for f in FILES:
        shutil.copy2(os.path.join(SITE, f), os.path.join(DIST, f))
    for f in OPTIONAL:
        src = os.path.join(SITE, f)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(DIST, f))

    # 日K 分片：真实蜡烛图的唯一数据来源（在线三源在浏览器里都拿不到）。
    # index.json 说明每个代码落在哪个分片，页面只取打开的那一只所在的分片。
    ksrc = os.path.join(SITE, "kline")
    if os.path.isdir(ksrc):
        shutil.copytree(ksrc, os.path.join(DIST, "kline"))
        n = len(os.listdir(ksrc))
        print("日K 分片：%d 个文件 · %s" % (n, human(sum(
            os.path.getsize(os.path.join(ksrc, x)) for x in os.listdir(ksrc)))))
    else:
        print("⚠ 未找到 kline/ 目录：真实蜡烛图会退化为在线源（浏览器多半取不到）")
        print("  先生成：python tools/build_kline.py")

    # data.json.gz：纯 JSON 的 gzip 版本，页面用 DecompressionStream 异步解压。
    # 7.7MB → 约 1.7MB，是「分享给别人、弱网/手机打开」体验的关键。
    # 同时保留 data.js 作为老浏览器 / 解压失败时的回退路径。
    txt = open(os.path.join(SITE, "data.js"), encoding="utf-8-sig").read()
    i = txt.find("window.AB_DATA")
    if i < 0:
        print("⚠ data.js 结构异常（找不到 window.AB_DATA），跳过 gzip 生成")
        print("已生成发布目录：%s" % DIST)
        return 1
    payload = txt[txt.find("=", i) + 1:].strip().rstrip(";").strip()
    try:
        json.loads(payload)          # 校验是合法 JSON，避免页面端解析失败
    except Exception as e:
        print("⚠ data.js 内容不是合法 JSON（%s），跳过 gzip 生成" % e)
        print("已生成发布目录：%s" % DIST)
        return 1
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as g:
        g.write(payload.encode("utf-8"))
    gz = buf.getvalue()
    with open(os.path.join(DIST, "data.json.gz"), "wb") as f:
        f.write(gz)
    print("data.json.gz：%.2f MB（原 %.2f MB，压缩到 %.0f%%）"
          % (len(gz) / 1048576.0, len(payload.encode()) / 1048576.0, len(gz) * 100.0 / len(payload.encode())))

    print("已生成发布目录：%s" % DIST)
    return 0


if __name__ == "__main__":
    sys.exit(main())
