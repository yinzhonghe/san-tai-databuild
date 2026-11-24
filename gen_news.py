# -*- coding: utf-8 -*-
"""多源舆情采集器（2026-11-24 · 真实行业口径）

与旧版最大的区别：不再手工列 16/32 个「概念主题」，而是直接从 data.js / _ind_map.json
读取每只标的的 ind（与「行业 · 三态下钻」「板块共振」完全同一个字段）生成行业主题。
这样舆情雷达里的行业数、行业名、归属标的都和总表一致，不会再出现两套逻辑对不上。

设计红线：
  1) 不编造数据——每条都来自真实源，带标题、时间、媒体、链接；某源失败就如实记 err。
  2) 不缩窄口径——同一事件多源转载只做展示去重，来源全部计入媒体数。
  3) 时效诚实——快讯只有 HH:MM 标 prec=min；公告/RSS 有完整日期标 prec=day/min。
  4) 基线诚实——surge 只在累积 ≥3 天真实历史后计算；不足显示「积累中」，不伪造 7 日基线。
  5) 行业真实——行业全集来自本地行业映射，不手写主题数；每条新闻按「行业名 / 二级行业名 /
     该行业成分股名称」真实命中，命不中就留空，不硬塞。

输出：news_data.js —— window.AB_NEWS = {...}
云端：news.yml 定时调用并推到 data 分支 → Pages → 前端远端刷新。
"""
import argparse
import datetime as dt
import email.utils
import hashlib
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

# 由 build_industry_themes() 在运行时从真实行业映射生成
INDUSTRY_THEMES = {}     # key -> (行业名, 展示用检索词)
INDUSTRY_KW = {}         # key -> (行业名, 二级行业, 成分股名...)
INDUSTRY_META = {}       # key -> {name,l1,l2,stocks}
KW_INDEX = {}            # 关键词 -> set(行业key)
LONG_KWS = []            # 长度 >8 的行业名，单独做 in 判断
SEARCH_TERMS = []        # 定向检索词：用一级行业名（约 27 个），不按 246 个行业逐个打接口

POS = ('增持', '回购', '中标', '签约', '涨价', '提价', '超预期', '扭亏', '预增', '新高',
       '突破', '获批', '订单', '扩产', '分红', '重组', '收购', '利好', '增长', '降本', '减亏')
NEG = ('减持', '立案', '处罚', '亏损', '预亏', '下调', '退市', '违规', '诉讼', '冻结',
       '质押', '终止', '问询', '商誉', '跌停', '风险提示', '爆仓', '下滑', '警示')


def log(*a):
    print(*a, flush=True)


def build_industry_themes(rows):
    """从 data.js 行 / _ind_map.json 构造真实行业主题与标题倒排关键词。

    rows 里每行必须带 ind（与行业页同一个字段）；没有 data.js 时退回 _ind_map.json，
    至少保证行业名与层级一致，只是少了成分股名称命中线索。
    """
    global SEARCH_TERMS
    groups = {}

    def put(ind, l1, l2, name, weight=0):
        ind = str(ind or '').strip()
        if not ind or ind in ('其他', '综合'):
            return
        g = groups.setdefault(ind, {'l1': str(l1 or ''), 'l2': str(l2 or ''),
                                    'names': {}, 'stocks': 0})
        if not g['l1'] and l1:
            g['l1'] = str(l1)
        if not g['l2'] and l2:
            g['l2'] = str(l2)
        nm = str(name or '').strip()
        if len(nm) >= 3 and 'ST' not in nm.upper() and '*' not in nm:
            g['names'][nm] = max(g['names'].get(nm, 0), weight)
        g['stocks'] += 1

    if rows:
        for r in rows:
            if not isinstance(r, dict):
                continue
            # 核心票 / 大市值票更常出现在标题里，优先作为该行业的命中线索
            w = (1e9 if r.get('tier') == 'core' else 0) + (r.get('mcap') or r.get('nmc') or 0)
            put(r.get('ind'), r.get('indL1') or r.get('l1'),
                r.get('indL2') or r.get('l2'), r.get('name'), w)
    else:
        for cand in (os.path.join(HERE, '_ind_map.json'),
                     os.path.join(HERE, '..', '_ind_map.json')):
            if not os.path.exists(cand):
                continue
            try:
                m = json.load(open(cand, encoding='utf-8'))
                for v in m.values():
                    if isinstance(v, dict):
                        put(v.get('ind'), v.get('l1'), v.get('l2'), None)
                break
            except Exception as e:
                log('[news] 行业映射读取失败：%s' % str(e)[:60])

    for name in sorted(groups):
        g = groups[name]
        key = 'i_' + hashlib.md5(name.encode('utf-8')).hexdigest()[:10]
        kws = [name]
        if g['l2'] and g['l2'] != name:
            kws.append(g['l2'])
        # 成分股名称是「哪家公司属于哪个行业」的真实线索；限 12 个高权重词，避免索引爆炸
        kws += [nm for nm, _w in sorted(g['names'].items(), key=lambda kv: -kv[1])[:12]]
        seen = set()
        kws = [k for k in kws if k and not (k in seen or seen.add(k))]
        INDUSTRY_THEMES[key] = (name, ' '.join(kws[:8]))
        INDUSTRY_KW[key] = tuple(kws)
        INDUSTRY_META[key] = {'name': name, 'l1': g['l1'], 'l2': g['l2'],
                              'stocks': g['stocks']}
        for kw in kws:
            if len(kw) > 8:
                LONG_KWS.append((kw, key))
            else:
                KW_INDEX.setdefault(kw, set()).add(key)
    SEARCH_TERMS = sorted({g['l1'] for g in groups.values() if g['l1']})
    log('[news] 真实行业主题 %d 个 / 一级行业检索词 %d 个' % (len(INDUSTRY_THEMES), len(SEARCH_TERMS)))


def themes_of(title):
    """标题 → 行业 key。用标题子串倒排，避免 1600 条 × 6000 只股票的暴力匹配。"""
    found = set()
    t = str(title or '')
    for n in range(2, 9):
        for p in range(0, max(0, len(t) - n + 1)):
            hit = KW_INDEX.get(t[p:p + n])
            if hit:
                found.update(hit)
    for kw, key in LONG_KWS:
        if kw in t:
            found.add(key)
    return sorted(found)


def polarity(title):
    p = sum(1 for k in POS if k in title)
    n = sum(1 for k in NEG if k in title)
    return (p, n, 1 if p > n else (-1 if n > p else 0))


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
    d = dt.datetime(today.year, today.month, today.day, 12, 0, tzinfo=TZ8)
    return d.timestamp(), 'day'


def norm_title(t):
    return re.sub(r'[^\u4e00-\u9fa5A-Za-z0-9]', '', str(t or ''))[:16]


def collect():
    """复用 gen_report 的 24 源 + 一级行业定向检索，返回 (统一条目, 诊断)。"""
    today = dt.datetime.now(TZ8).date()
    items, diag = [], []

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
                'k': themes_of(title), 'src': name,
            })
            n += 1
        diag.append({'name': name, 'n': n, 'err': err or ''})
        return n

    # 1) 快讯 8 源
    try:
        add(G.grab_news(), '东财7x24')
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

    # 4) 一级行业定向检索：不按 246 个三级行业逐个打接口，避免把公开源打挂
    for q in SEARCH_TERMS:
        try:
            rows, e = G.grab_em_search(q, limit=20, pages=1)
            if e:
                diag.append({'name': '检索·' + q, 'n': 0, 'err': e})
                continue
            add(rows, '检索·' + q)
        except Exception as e:
            diag.append({'name': '检索·' + q, 'n': 0, 'err': str(e)[:80]})
    return items, diag


def add_stock_and_sector_news(items, diag, codes):
    """个股专属新闻（东财 np-listapi），带完整日期，按股票名命中真实行业。"""
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
                'date': str(x.get('Art_ShowTime') or '')[:16],
                'sum': str(x.get('Art_Abstract') or '')[:220],
                'src': label,
                'media': str(x.get('Np_dst') or label),
                'url': str(x.get('Art_Url') or '')[:240],
            })
        return out, None

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
    """展示去重：同一事件多源转载，正文只留一条，来源集合保留全部。"""
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
    """按真实行业聚合。基线不足 3 天时 surge=None，绝不伪造 7 日基线。"""
    D = 86400.0
    by_theme = {k: [] for k in INDUSTRY_THEMES}
    for x in items:
        for k in x['k']:
            if k in by_theme:
                by_theme[k].append(x)

    prev_hist = prev_hist or {}
    day_key = today.isoformat()
    themes, agg, new_hist = [], {}, {}
    for key, arr in by_theme.items():
        arr.sort(key=lambda z: -z['ts'])
        n_today = sum(1 for x in arr if x['ts'] > now_ts - D)
        media = sorted({s for x in arr if x['ts'] > now_ts - D for s in x.get('sources', [x['m']])})
        p = sum(x['p'] for x in arr if x['ts'] > now_ts - D)
        n = sum(x['n'] for x in arr if x['ts'] > now_ts - D)
        direction = 1 if p > n else (-1 if n > p else 0)
        score = round((p - n) / (p + n), 3) if (p + n) else 0.0
        noise = sum(max(0, x.get('copies', 1) - 1) for x in arr if x['ts'] > now_ts - D)

        hist = dict(prev_hist.get(key) or {})
        hist[day_key] = n_today
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
        eff = round((surge if surge is not None else 1.0) / (1 + 0.4 * noise), 3)
        eff_signed = round(eff * (score if direction else 1), 3)

        nm, kw = INDUSTRY_THEMES[key]
        meta = INDUSTRY_META.get(key, {})
        top = [{'t': x['t'], 'd': dt.datetime.fromtimestamp(x['ts'], TZ8).strftime('%m-%d %H:%M'),
                'u': x['u'], 'm': '/'.join(x.get('sources', [x['m']])[:3])}
               for x in arr[:3]]
        read = '真实多源：当日 %d 条 / %d 家媒体 / %s' % (
            n_today, len(media), '偏正面' if direction > 0 else ('偏谨慎' if direction < 0 else '方向不明'))
        if status != 'ready':
            read += '；激增基线积累中（%s），暂不判断热度倍数' % status
        obj = {
            'key': key, 'name': nm, 'kw': kw,
            'l1': meta.get('l1', ''), 'l2': meta.get('l2', ''), 'stocks': meta.get('stocks', 0),
            'dir': direction, 'score': score,
            'n1': n_today, 'nToday': n_today, 'n7': None, 'baseline': baseline,
            'baselineStatus': status, 'surge': surge,
            'eff': eff_signed, 'noise': noise, 'mediaN': len(media), 'nSources': len(media),
            'top': top, 'read': read,
        }
        themes.append(obj)
        eng_eff = round(abs(score) * 1.2 + min(len(media), 12) / 12.0 * 0.4, 3)
        agg[key] = {
            'key': key, 'name': nm, 'dir': direction, 'score': score,
            'eff': eng_eff, 'noise': noise, 'surge': surge,
            'n1': n_today, 'n7': None, 'mediaN': len(media),
            'l1': meta.get('l1', ''), 'stocks': meta.get('stocks', 0),
            'baselineStatus': status,
            'top': ' / '.join(t['t'] for t in top[:2]),
            'read': '真实多源（%d家，极性 %+.2f）' % (len(media), score),
        }
    themes.sort(key=lambda z: -(abs(z['eff']) if z['eff'] is not None else 0))
    return themes, agg, new_hist, items


def stock_news_map(items):
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
    ap.add_argument('--data', default='', help='data.js（取行业全集与启动核心标的）')
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
            log('[news] 载入历史基线 %d 行业' % len(prev_hist))
        except Exception as e:
            log('[news] 历史读取跳过：%s' % str(e)[:50])

    # 先读 data.js：既是行业全集来源，也用于挑个股专属新闻目标
    data_path = args.data
    if not data_path:
        for cand in ('data.js', os.path.join(HERE, '..', 'data.js')):
            if os.path.exists(cand):
                data_path = cand
                break
    rows, stock_codes = [], []
    if data_path and os.path.exists(data_path):
        try:
            s = open(data_path, encoding='utf-8').read()
            D = json.loads(s[s.index('{'):s.rindex('}') + 1])
            rows = D.get('rows') or []
            if args.max_stocks > 0:
                def score_row(r):
                    if r.get('kind') != 'stock':
                        return -1
                    return (3 if r.get('state') == '启动' else 0) \
                        + (2 if r.get('tier') == 'core' else 0) \
                        + ((r.get('pct') or {}).get('w5', 0) or 0)
                picked = sorted(rows, key=score_row, reverse=True)[:args.max_stocks]
                for r in picked:
                    code = str(r.get('code') or '')
                    bare, mkt = code.split('.')[0], (0 if code.endswith('.SZ') else 1)
                    if len(bare) == 6 and bare.isdigit():
                        stock_codes.append((bare, mkt, r.get('name') or bare))
                log('[news] 个股专属新闻目标 %d 只' % len(stock_codes))
        except Exception as e:
            log('[news] data.js 读取跳过：%s' % str(e)[:50])
    build_industry_themes(rows)

    items, diag = collect()
    if stock_codes:
        add_stock_and_sector_news(items, diag, stock_codes)

    ok = sum(1 for d in diag if d['n'] > 0)
    log('[news] 源 %d 个，有效 %d 个，原始条目 %d' % (len(diag), ok, len(items)))
    for d in diag:
        if d['n'] == 0:
            log('   [空] %-14s %s' % (d['name'], d['err'][:60]))

    uniq = dedupe(items)
    themes, agg, new_hist, agg_items = aggregate(uniq, now.timestamp(), now.date(), prev_hist)
    log('[news] 去重后 %d 条；行业有新闻 %d/%d' % (len(uniq), sum(1 for t in themes if t['n1'] > 0), len(themes)))
    for t in [x for x in themes if x['n1'] > 0][:6]:
        sv = ('%5.2f' % t['surge']) if t['surge'] is not None else '  —  '
        log('   %-10s 当日=%-3d surge=%s 媒体=%-2d dir=%+d 基线=%s' % (
            t['name'], t['n1'], sv, t['mediaN'], t['dir'], t['baselineStatus']))

    obj = {
        'asOf': now.strftime('%Y-%m-%d %H:%M'),
        'tz': 'Asia/Shanghai',
        'scope': 'industry',             # 前端据此显示「行业口径」而不是旧的主题口径
        'industryLevel': 'ind',          # 与 data.js rows[].ind / 行业页 / 板块共振同源
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
        'note': '真实行业口径（%d 个行业，取自 data.js rows[].ind / _ind_map.json）；'
                '%d 源；快讯仅 HH:MM（prec=min）；同一事件多源转载已合并展示但来源全部计入媒体数；'
                'surge 仅在累积≥3天真实历史后计算，不足标「积累中」，绝不虚高；'
                '不编造标题/条数/热度。' % (len(INDUSTRY_THEMES), len(diag)),
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
