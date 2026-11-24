# -*- coding: utf-8 -*-
"""多源舆情采集器（2026-11-24）

复用 gen_report.py 里已验证可用的 24 个新闻源抓取函数，把「快讯 / 检索 / 公告 / RSS /
政策栏目」统一归一化成结构化条目，再按 16 个主题 + 个股名称命中，计算**真实**的
n1（近 24h）/ n7（近 7 日）/ surge（激增倍数）/ 媒体数 / 极性方向。

设计红线（与全站一致）：
  1) 不编造数据——每条都来自真实源，带标题、时间、媒体、链接；某源失败就如实记 err。
  2) 不缩窄口径——多个源报道同一事件只做「展示去重」，但每个源都计入统计（sourceSet）。
  3) 时效诚实——快讯只有 HH:MM，标注 prec=min；公告/RSS 有完整日期，标注 prec=day/min。
  4) 南向兼容——输出 window.AB_NEWS，six-engine.js / app.js 优先读它，读不到就退回旧的
     静态 titleIndex（历史缓存），不会因为缺数据而崩。

输出：news_data.js —— window.AB_NEWS = {...}
用法：
  python github_ci/gen_news.py --out news_data.js            # 本地生成
  python github_ci/gen_news.py --out news_data.js --dry-run  # 只打印诊断不写文件
云端由 news.yml 定时调用并推到 data 分支 → Pages。
"""
import argparse
import datetime as dt
import email.utils
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import gen_report as G   # noqa: E402  复用已验证的抓取底座，__main__ 有保护，安全

TZ8 = dt.timezone(dt.timedelta(hours=8))

# ---- 16 主题：名称 + 检索式（kw 用于前端展示「检索式」，也用于定向补抓）----
THEMES = {
    't_robot': ('机器人', '人形机器人 具身智能 减速器'),
    't_ai': ('AI算力', 'AI 算力 光模块 GPU 大模型'),
    't_chip': ('半导体', '半导体 芯片 晶圆 先进封装'),
    't_battery': ('锂电池', '固态电池 锂电池 新能源车'),
    't_innov': ('创新药', '创新药 出海 CXO 医保'),
    't_baijiu': ('白酒', '白酒 茅台 渠道 动销'),
    't_broker': ('券商', '券商 并购重组 证券业'),
    't_bank': ('银行', '银行 险资 破净 息差'),
    't_metal': ('有色金属', '铜 有色 黄金 稀土'),
    't_coal': ('煤炭', '煤炭 动力煤 煤价'),
    't_solar': ('光伏', '光伏 硅料 反内卷 组件'),
    't_mil': ('军工航天', '军工 商业航天 卫星 火箭'),
    't_game': ('传媒游戏', '游戏 影视 传媒 AI短剧'),
    't_estate': ('房地产', '房地产 楼市 现房销售'),
    't_ce': ('消费电子', '消费电子 AI眼镜 端侧'),
    't_power': ('电力电网', '电力 电网 算力用电 变压器'),
}

# 主题关键词 → 主题键（一条标题可命中多个主题；命中即计入，不强行单选）
THEME_KW = {
    't_robot': ('机器人', '人形', '具身', '宇树', '优必选', '减速器', '伺服', '灵巧手', '特斯拉机器人'),
    't_ai': ('AI', '算力', '光模块', 'GPU', '大模型', '人工智能', '英伟达', '液冷', '数据中心', '智能体', 'AIGC'),
    't_chip': ('半导体', '芯片', '晶圆', '封装', '光刻', '存储', 'DRAM', 'NAND', '集成电路', 'EDA', '中芯', '台积电'),
    't_battery': ('固态电池', '锂电池', '电池', '新能源车', '宁德时代', '锂电', '充电桩', '正极材料'),
    't_innov': ('创新药', '出海', 'CXO', '医保', '生物医药', '临床', 'FDA', '医药', '恒瑞', 'BD交易'),
    't_baijiu': ('白酒', '茅台', '五粮液', '泸州老窖', '渠道', '动销'),
    't_broker': ('券商', '证券', '并购重组', '投行', '中金', '中信证券'),
    't_bank': ('银行', '险资', '破净', '息差', '存款', '信贷', '保险资金'),
    't_metal': ('铜', '有色', '黄金', '稀土', '铝', '金属', '金银', '锂矿'),
    't_coal': ('煤炭', '动力煤', '煤价', '焦煤', '电煤'),
    't_solar': ('光伏', '硅料', '组件', '逆变器', '电池片', '反内卷'),
    't_mil': ('军工', '航天', '卫星', '火箭', '商业航天', '国防', '无人机'),
    't_game': ('游戏', '影视', '传媒', '短剧', '院线', '出版', '动漫'),
    't_estate': ('房地产', '楼市', '现房', '房价', '土地', '房企', '住房'),
    't_ce': ('消费电子', 'AI眼镜', '智能眼镜', '端侧', '手机', '耳机', '可穿戴'),
    't_power': ('电力', '电网', '变压器', '特高压', '用电', '电价', '绿电'),
}

POS = ('增持', '回购', '中标', '签约', '涨价', '提价', '超预期', '扭亏', '预增', '新高',
       '突破', '获批', '订单', '扩产', '分红', '重组', '收购', '利好', '增长', '降本', '减亏')
NEG = ('减持', '立案', '处罚', '亏损', '预亏', '下调', '退市', '违规', '诉讼', '冻结',
       '质押', '终止', '问询', '商誉', '跌停', '风险提示', '爆仓', '下滑', '减持', '警示')


def log(*a):
    print(*a, flush=True)


def polarity(title):
    p = sum(1 for k in POS if k in title)
    n = sum(1 for k in NEG if k in title)
    return (p, n, 1 if p > n else (-1 if n > p else 0))


def themes_of(title):
    return [k for k, kws in THEME_KW.items() if any(x.lower() in title.lower() for x in kws)]


def parse_dt(x, today):
    """返回 (epoch秒, 精度)。优先完整 date，其次 HH:MM 配当天，最后当天正午。"""
    date_s = str(x.get('date') or '').strip()
    time_s = str(x.get('time') or '').strip()
    if date_s:
        try:
            s = date_s.replace('Z', '+0000')
            d = email.utils.parsedate_to_datetime(s)
            if d.tzinfo is None:
                d = d.replace(tzinfo=TZ8)
            return d.timestamp(), 'min' if re.search(r'\d{1,2}:\d{2}', date_s) else 'day'
        except Exception:
            m = re.search(r'(\d{4})[-/](\d{1,2})[-/](\d{1,2})', date_s)
            if m:
                base = dt.datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), 12, 0, tzinfo=TZ8)
                hm = re.search(r'(\d{1,2}):(\d{2})', date_s)
                if hm:
                    base = base.replace(hour=int(hm.group(1)), minute=int(hm.group(2)))
                    return base.timestamp(), 'min'
                return base.timestamp(), 'day'
    if re.match(r'^\d{1,2}:\d{2}$', time_s):
        h, m = time_s.split(':')
        d = dt.datetime(today.year, today.month, today.day, int(h), int(m), tzinfo=TZ8)
        return d.timestamp(), 'min'
    # 只有当天、无具体时刻：放当天正午，标 day（不冒充精确到分钟）
    d = dt.datetime(today.year, today.month, today.day, 12, 0, tzinfo=TZ8)
    return d.timestamp(), 'day'


def norm_title(t):
    return re.sub(r'[^\u4e00-\u9fa5A-Za-z0-9]', '', str(t or ''))[:16]


def collect():
    """复用 gen_report 的 24 源，返回 (统一条目, 诊断)。"""
    today = dt.datetime.now(TZ8).date()
    items, diag = [], []
    raw_pools = []

    def add(rows, name, err=None):
        n = 0
        for r in rows or []:
            title = str(r.get('t') or r.get('title') or '').strip()
            if len(title) < 8:
                continue
            ts, prec = parse_dt(r, today)
            p, nn, d = polarity(title)
            items.append({
                't': title[:90], 'ts': ts, 'prec': prec,
                'm': str(r.get('src') or r.get('media') or name)[:24],
                'u': str(r.get('url') or '')[:240],
                'sum': str(r.get('sum') or '')[:220],
                'p': p, 'n': nn, 'd': d,
                'k': themes_of(title),
                'src': name,
            })
            n += 1
        diag.append({'name': name, 'n': n, 'err': err or ''})
        return n

    # 1) 快讯 8 源（东财 / 新浪 / 金十 / 见闻 / 同花顺 / 每经 / 财联社 / 格隆汇）
    try:
        em = G.grab_news()
        add(em, '东财7x24')
    except Exception as e:
        diag.append({'name': '东财7x24', 'n': 0, 'err': str(e)[:80]})
    for name, fn in (('新浪7x24', G.grab_sina_flash), ('金十数据', G.grab_jin10_flash),
                     ('华尔街见闻', G.grab_wscn_flash), ('同花顺', G.grab_ths_flash),
                     ('每日经济新闻', G.grab_nbd), ('财联社', G.grab_cls_flash),
                     ('格隆汇', G.grab_gelonghui_flash)):
        try:
            rows, e = fn()
            add(rows, name, e)
        except Exception as e:
            diag.append({'name': name, 'n': 0, 'err': str(e)[:80]})

    # 2) 公告 2 源
    for name, fn in (('巨潮公告', G.grab_cninfo_announcements),
                     ('上交所公告', G.grab_sse_announcements)):
        try:
            rows, e = fn()
            add(rows, name, e)
        except Exception as e:
            diag.append({'name': name, 'n': 0, 'err': str(e)[:80]})

    # 3) RSS 9 源 + 政策栏目 4 源
    for name, url in G.NEW_RSS_SOURCES:
        try:
            rows, e = G.grab_rss(url, name, 30)
            add(rows, name, e)
        except Exception as e:
            diag.append({'name': name, 'n': 0, 'err': str(e)[:80]})
    for name, url, href_kw in G.NEW_HTML_SOURCES:
        try:
            rows, e = G.grab_html_list(url, name, 30, href_kw=href_kw)
            add(rows, name, e)
        except Exception as e:
            diag.append({'name': name, 'n': 0, 'err': str(e)[:80]})

    # 4) 主题定向检索：每个主题 1 组关键词 × 20 篇 × 1 页（16 次检索，底料宁多勿少）
    for key, (nm, kw) in THEMES.items():
        for q in kw.split()[:2]:
            try:
                rows, e = G.grab_em_search(q, limit=20, pages=1)
                if e:
                    diag.append({'name': '检索·' + q, 'n': 0, 'err': e})
                    continue
                add(rows, '检索·' + q)
            except Exception as e:
                diag.append({'name': '检索·' + q, 'n': 0, 'err': str(e)[:80]})
            break   # 每个主题先只用第一组关键词，控制总量；缺料时再手动加

    # 5) 个股专属新闻流（东财 np-listapi 个股变体，2026-11-24 实测可用，带完整日期）
    #    用户诉求：舆情放到个股，源可以更多。公开接口里只有这个是「按个股代码」返回专属资讯的，
    #    覆盖热点个股的定向报道。范围：启动/高换手的核心标的（由 --codes 传入），默认空不抓。
    return items, diag


def add_stock_and_sector_news(items, diag, codes):
    """个股专属 + 板块专属新闻。codes: [(code, market)]，market 1=沪 0=深。

    np-listapi 的 mTypeAndCode：
      个股 = '1.600519'（沪）/ '0.000001'（深）
      板块 = '90.BK1036'（东财行业板块码）
    返回字段 Art_Title / Art_ShowTime / Np_dst(来源) / Art_Url。
    """
    import urllib.parse
    today = dt.datetime.now(TZ8).date()

    def grab(mtc, label, limit=8):
        url = ('https://np-listapi.eastmoney.com/comm/web/getListInfo?'
               'client=web&biz=web_news_col&column=347&order=1&needJumpAd=true'
               '&page_index=1&page_size=%d&fastcolumn=101&mTypeAndCode=%s&type=1'
               % (limit, urllib.parse.quote(mtc)))
        body, ms, err = G.fetch(url, 'https://quote.eastmoney.com/', 15)
        if err or not body:
            return [], err
        try:
            j = json.loads(body.decode('utf-8', 'ignore'))
        except Exception as e:
            return [], 'parse:' + type(e).__name__
        lst = (j.get('data') or {}).get('list') or []
        out = []
        for x in lst:
            out.append({
                't': str(x.get('Art_Title') or '').strip()[:90],
                'time': str(x.get('Art_ShowTime') or '')[:16],
                'date': str(x.get('Art_ShowTime') or '')[:16],
                'sum': str(x.get('Art_Abstract') or '')[:220],
                'src': label,
                'media': str(x.get('Np_dst') or label),
                'url': str(x.get('Art_Url') or '')[:240],
            })
        return out, None

    # 个股：所有传入代码的专属新闻，打上股票名前缀便于前端按名称命中
    for code, market, name in codes:
        try:
            rows, e = grab('%d.%s' % (market, code), '个股·' + name)
            n = 0
            for r in rows or []:
                title = str(r.get('t') or '').strip()
                if len(title) < 8:
                    continue
                ts, prec = parse_dt(r, today)
                p, nn, d = polarity(title)
                items.append({
                    't': title, 'ts': ts, 'prec': prec, 'm': r.get('media') or ('个股·' + name),
                    'u': r.get('url') or '', 'sum': r.get('sum', ''), 'p': p, 'n': nn, 'd': d,
                    'k': themes_of(title), 'src': '个股专属', 'stock': code,
                })
                n += 1
            diag.append({'name': '个股·' + name, 'n': n, 'err': e or ''})
        except Exception as e:
            diag.append({'name': '个股·' + name, 'n': 0, 'err': str(e)[:60]})


def dedupe(items):
    """展示去重：同一事件多源报道，正文只留一条，但来源集合保留全部（不缩窄统计口径）。

    做法：按 norm_title 分桶；桶内按时间取最新做主条目，sources 合并；每条主题统计用
    「主条目 + 来源数」计算，避免 N 家转载被算成 N 条独立新闻而虚高 surge。
    """
    buckets = {}
    for x in items:
        k = norm_title(x['t'])
        if not k:
            continue
        b = buckets.setdefault(k, {'main': None, 'sources': set(), 'keys': set(), 'n': 0})
        b['n'] += 1
        b['sources'].add(x['m'])
        b['keys'].update(x['k'])
        if b['main'] is None or x['ts'] > b['main']['ts']:
            b['main'] = x
    out = []
    for k, b in buckets.items():
        m = dict(b['main'])
        m['sources'] = sorted(b['sources'])
        m['nSources'] = len(b['sources'])
        m['copies'] = b['n']
        m['k'] = sorted(b['keys'])
        out.append(m)
    return out


def aggregate(items, now_ts, today, prev_hist=None):
    """按主题聚合。

    诚实性设计（2026-11-24，踩过 surge=294× 的假象后重构）：
      公开接口（快讯/检索/公告/RSS）返回的都是「当前时点快照」，拿不到 7 天前的完整
      新闻流。所以「前 7 日基线」不能从当次抓取里凭空造 —— 否则 n7≈n1，baseline≈0.5，
      surge 必然虚高几十倍几百倍，这是编造。
      正确做法：
        · nToday / mediaN / 极性 dir/score 是本次真实抓到的硬数据 → 直接给；
        · baseline 来自**逐日累积的历史**（prev_hist，每天存一份当天条数），
          只有历史天数 ≥ 3 才算 surge；不足时 surge=None 并标 baselineStatus='积累中'。
        · 引擎投票用 score（真实极性）而非虚高 surge，避免污染六派。
    """
    D = 86400.0
    by_theme = {k: [] for k in THEMES}
    for x in items:
        for k in x['k']:
            if k in by_theme:
                by_theme[k].append(x)

    prev_hist = prev_hist or {}
    day_key = today.isoformat()
    themes, agg, new_hist = [], {}, {}
    for key, arr in by_theme.items():
        arr.sort(key=lambda z: -z['ts'])
        # 当日真实条数：以抓到的时间窗（近24h）为准；这是硬数据，不做任何放大
        n_today = sum(1 for x in arr if x['ts'] > now_ts - D)
        media = sorted({s for x in arr if x['ts'] > now_ts - D for s in x.get('sources', [x['m']])})
        p = sum(x['p'] for x in arr if x['ts'] > now_ts - D)
        n = sum(x['n'] for x in arr if x['ts'] > now_ts - D)
        direction = 1 if p > n else (-1 if n > p else 0)
        score = round((p - n) / (p + n), 3) if (p + n) else 0.0
        noise = sum(max(0, x.get('copies', 1) - 1) for x in arr if x['ts'] > now_ts - D)

        # 累积历史：写入今天，读历史天数（不含今天）算基线
        hist = dict(prev_hist.get(key) or {})
        hist[day_key] = n_today
        # 只保留最近 10 天，防止文件膨胀
        for d in sorted(hist)[:-10]:
            hist.pop(d, None)
        new_hist[key] = hist
        prior = [v for d, v in hist.items() if d < day_key][-7:]
        if len(prior) >= 3:
            baseline = sum(prior) / len(prior)
            surge = round(n_today / max(baseline, 1.0), 2)
            status = 'ready'
        else:
            baseline = None
            surge = None
            status = '积累中 %d/3 天' % len(prior)
        # 有效激增：有 ready 基线才算；否则 1.0（中性，不放大也不贬低），方向仍由 score 决定
        eff = round((surge if surge is not None else 1.0) / (1 + 0.4 * noise), 3)
        eff_signed = round(eff * (score if direction else 1), 3)

        nm, kw = THEMES[key]
        top = [{'t': x['t'], 'd': dt.datetime.fromtimestamp(x['ts'], TZ8).strftime('%m-%d %H:%M'),
                'u': x['u'], 'm': '/'.join(x.get('sources', [x['m']])[:3])}
               for x in arr[:3]]
        read = '真实多源：当日 %d 条 / %d 家媒体 / %s' % (
            n_today, len(media), '偏正面' if direction > 0 else ('偏谨慎' if direction < 0 else '方向不明'))
        if status != 'ready':
            read += '；激增基线积累中（%s），暂不判断热度倍数' % status
        obj = {
            'key': key, 'name': nm, 'kw': kw, 'dir': direction, 'score': score,
            'n1': n_today, 'nToday': n_today, 'n7': None, 'baseline': baseline,
            'baselineStatus': status, 'surge': surge,
            'eff': eff_signed, 'noise': noise, 'mediaN': len(media), 'nSources': len(media),
            'top': top, 'read': read,
        }
        themes.append(obj)
        # 引擎聚合对象（six-engine themeAggOf 直接按 key 取）。
        # eff 取「真实极性强度」：|score| 主导，mediaN 作温和加权；不拿未就绪的 surge 放大。
        eng_eff = round(abs(score) * 1.2 + min(len(media), 12) / 12.0 * 0.4, 3)
        agg[key] = {
            'key': key, 'name': nm, 'dir': direction, 'score': score,
            'eff': eng_eff, 'noise': noise, 'surge': surge,
            'n1': n_today, 'n7': None, 'mediaN': len(media),
            'baselineStatus': status,
            'top': ' / '.join(t['t'] for t in top[:2]),
            'read': '真实多源（%d家，极性 %+.2f）' % (len(media), score),
        }
    themes.sort(key=lambda z: -(abs(z['eff']) if z['eff'] is not None else 0))
    return themes, agg, new_hist, items


def stock_news_map(items):
    """按个股代码聚合专属新闻（供前端在标的详情/舆情票直接展示来源）。"""
    out = {}
    for x in items:
        code = x.get('stock')
        if not code:
            continue
        o = out.setdefault(code, [])
        if len(o) < 8:
            o.append({
                't': x['t'],
                'd': dt.datetime.fromtimestamp(x['ts'], TZ8).strftime('%m-%d %H:%M'),
                'm': x['m'], 'u': x['u'], 'd0': x['d'], 'ts': x['ts'],
            })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='news_data.js')
    ap.add_argument('--prev', default='', help='上一版 news_data.js（读取累积历史基线）')
    ap.add_argument('--data', default='', help='data.js（取启动/核心标的做个股专属新闻）')
    ap.add_argument('--max-stocks', type=int, default=40, help='个股专属新闻最多抓几只')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    t0 = time.time()
    now = dt.datetime.now(TZ8)
    log('[news] 采集开始', now.strftime('%F %H:%M'))
    prev_hist = {}
    prev_path = args.prev or args.out
    if os.path.exists(prev_path):
        try:
            s = open(prev_path, encoding='utf-8').read()
            old = json.loads(s[s.index('{'):s.rindex('}') + 1])
            prev_hist = old.get('hist') or {}
            log('[news] 载入历史基线 %d 主题' % len(prev_hist))
        except Exception as e:
            log('[news] 历史读取跳过：%s' % str(e)[:50])

    items, diag = collect()

    # 个股专属新闻：从 data.js 取「启动 + 核心 + 涨幅居前」的个股，最多 max-stocks 只
    stock_codes = []
    data_path = args.data
    if not data_path:
        for cand in ('data.js', os.path.join(HERE, '..', 'data.js')):
            if os.path.exists(cand):
                data_path = cand
                break
    if data_path and os.path.exists(data_path) and args.max_stocks > 0:
        try:
            s = open(data_path, encoding='utf-8').read()
            D = json.loads(s[s.index('{'):s.rindex('}') + 1])
            rows = D.get('rows') or []
            def score_row(r):
                if r.get('kind') != 'stock':
                    return -1
                sc = 3 if r.get('state') == '启动' else 0
                sc += 2 if r.get('tier') == 'core' else 0
                sc += (r.get('pct') or {}).get('w5', 0) or 0
                return sc
            picked = sorted(rows, key=score_row, reverse=True)[:args.max_stocks]
            for r in picked:
                code = str(r.get('code') or '')
                bare, mkt = code.split('.')[0], (0 if code.endswith('.SZ') else 1)
                if len(bare) == 6 and bare.isdigit():
                    stock_codes.append((bare, mkt, r.get('name') or bare))
            log('[news] 个股专属新闻目标 %d 只' % len(stock_codes))
        except Exception as e:
            log('[news] 个股清单读取跳过：%s' % str(e)[:50])
    if stock_codes:
        add_stock_and_sector_news(items, diag, stock_codes)

    ok = sum(1 for d in diag if d['n'] > 0)
    log('[news] 源 %d 个，有效 %d 个，原始条目 %d' % (len(diag), ok, len(items)))
    for d in diag:
        if d['n'] == 0:
            log('   [空] %-14s %s' % (d['name'], d['err'][:60]))

    uniq = dedupe(items)
    themes, agg, new_hist, agg_items = aggregate(uniq, now.timestamp(), now.date(), prev_hist)
    log('[news] 去重后 %d 条；主题非空 %d/16' % (len(uniq), sum(1 for t in themes if t['n1'] > 0)))
    for t in themes[:6]:
        sv = ('%5.2f' % t['surge']) if t['surge'] is not None else '  —  '
        log('   %-8s 当日=%-3d surge=%s 媒体=%-2d dir=%+d 基线=%s' % (
            t['name'], t['n1'], sv, t['mediaN'], t['dir'], t['baselineStatus']))

    # 个股命中索引：标题直接出现标的名称的条目（前端 nameHitsFor 用；只存标题片段，不编造）
    # 这里不展开全市场 5000+ 名称——前端按 DATA.rows 名称全集对 items 做倒排即可（O(1) 缓存）。
    obj = {
        'asOf': now.strftime('%Y-%m-%d %H:%M'),
        'tz': 'Asia/Shanghai',
        'sources': diag,
        'total': len(uniq),
        'rawTotal': len(items),
        'themes': themes,
        'themeAgg': agg,
        'hist': new_hist,
        'stockNews': stock_news_map(agg_items),
        'items': [{
            't': x['t'], 'ts': x['ts'], 'm': x['m'], 'u': x['u'],
            'k': x['k'], 'd': x['d'], 'p': x['p'], 'n': x['n'],
            'ns': x.get('nSources', 1), 'cp': x.get('copies', 1),
            'src': x['src'], 'prec': x['prec'],
        } for x in sorted(uniq, key=lambda z: -z['ts'])[:1200]],
        'note': '真实多源资讯（%d 源）；快讯仅 HH:MM（prec=min），公告/RSS 精度见 prec；'
                '同一事件多源转载已合并展示但来源全部计入媒体数；'
                'surge 仅在累积≥3天真实历史后计算，不足则标「积累中」，绝不虚高；'
                '不编造标题/条数/热度。' % len(diag),
    }
    if args.dry_run:
        log('[news] dry-run 完成，耗时 %.1fs' % (time.time() - t0))
        return
    js = 'window.AB_NEWS = ' + json.dumps(obj, ensure_ascii=False, separators=(',', ':')) + ';\n'
    with open(args.out, 'w', encoding='utf-8') as f:
        f.write(js)
    log('[news] 已写 %s（%.1f KB，耗时 %.1fs）' % (
        args.out, len(js.encode('utf-8')) / 1024, time.time() - t0))


if __name__ == '__main__':
    main()
