#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""三态看盘 · 三报生成器（GitHub Actions 版）

流程：抓数据 -> GitHub Models 写正文 -> 逐数字回溯校验 -> 合并进 daily.js -> 推 Pages(data 分支)

设计红线（与项目既有约定一致）：
  1. 不编造任何数字。正文里出现的每个数字，必须能在本次抓到的数据里找到（允许四舍五入与亿/万亿换算）。
  2. 校验不过就重写一次；还不过就走「模板兜底」，只用数据本身拼出一份不撒谎的简版，绝不硬发。
  3. 缺数据的品种（如美债 10Y 无公开源）不进正文，只在 diagnostics 里记一笔。

用法：
  python gen_report.py --slot morning            # 早报
  python gen_report.py --slot noon --dry-run     # 只生成不推送
  python gen_report.py --slot close --no-push
"""
import argparse
import base64
import hashlib
import html as html_lib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0 Safari/537.36')
REPO = os.environ.get('REPORT_REPO', 'yinzhonghe/san-tai-databuild')
BRANCH = os.environ.get('REPORT_BRANCH', 'data')
TOKEN = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN') or ''
API = 'https://api.github.com'
RISK = ('以上内容根据公开新闻整理，由 AI 辅助总结，仅作信息参考，不构成投资建议，'
        '不代表对走势的预测。市场有风险，决策请独立判断。')

MODELS = [os.environ.get('REPORT_MODEL') or 'gpt-4o', 'gpt-4.1', 'gpt-4o-mini',
          'gpt-4.1-mini', 'DeepSeek-V3-0324']
MODEL_URL = 'https://models.github.ai/inference/chat/completions'


# ---------------------------------------------------------------- HTTP 基础设施
def fetch(url, referer=None, timeout=20, data=None, headers=None):
    hd = {'User-Agent': UA}
    if referer:
        hd['Referer'] = referer
    if headers:
        hd.update(headers)
    req = urllib.request.Request(url, data=data, headers=hd)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(), int((time.time() - t0) * 1000), ''
    except urllib.error.HTTPError as e:
        return (e.read() or b''), int((time.time() - t0) * 1000), 'HTTP %s' % e.code
    except Exception as e:
        return b'', int((time.time() - t0) * 1000), '%s: %s' % (type(e).__name__, e)


def get_json(url, referer=None, timeout=20):
    body, ms, err = fetch(url, referer, timeout)
    if err:
        return None, err
    for enc in ('utf-8', 'gbk'):
        try:
            return json.loads(body.decode(enc)), None
        except Exception:
            continue
    return None, 'parse fail'


def sina_text(url):
    body, ms, err = fetch(url, 'https://finance.sina.com.cn')
    if err:
        return ''
    return body.decode('gbk', 'ignore')


# ---------------------------------------------------------------- 抓数
def num(x):
    try:
        v = float(x)
        return v
    except Exception:
        return None


def pct_of(p, prev):
    if p is None or not prev:
        return None
    return round((p - prev) / prev * 100, 2)


def tencent_fields(text, code):
    m = re.search(r'v_%s="([^"]*)"' % re.escape(code), text)
    return m.group(1).split('~') if m else []


def grab_tencent_quotes():
    """腾讯实时行情：A 股指数 / 美股指数 / 港股。一次请求拿完。"""
    codes = ['sh000001', 'sz399001', 'sz399006', 'sh000688',
             'usDJI', 'usIXIC', 'usINX', 'hkHSI', 'hkHSTECH']
    body, ms, err = fetch('https://qt.gtimg.cn/q=' + ','.join(codes))
    if err:
        return {}, err
    text = body.decode('gbk', 'ignore')
    out = {}
    for c in codes:
        f = tencent_fields(text, c)
        if len(f) < 6:
            continue
        p, prev = num(f[3]), num(f[4])
        out[c] = {'name': f[1], 'price': p, 'prev': prev, 'pct': pct_of(p, prev),
                  'time': (f[30] if len(f) > 30 else '')}
    return out, None


def grab_futures():
    """新浪外盘期货：A50 / 黄金 / 白银 / 原油 / 伦铜。字段：0 现价 4 高 5 低 7 昨收 13 名称"""
    codes = ['hf_CHA50CFD', 'hf_GC', 'hf_SI', 'hf_CL', 'hf_CAD']
    text = sina_text('https://hq.sinajs.cn/list=' + ','.join(codes))
    out = {}
    for c in codes:
        m = re.search(r'hq_str_%s="([^"]*)"' % c, text)
        if not m or not m.group(1):
            continue
        f = m.group(1).split(',')
        p, prev = num(f[0]), num(f[7])
        out[c] = {'name': f[13] if len(f) > 13 else c, 'price': p, 'prev': prev,
                  'pct': pct_of(p, prev), 'high': num(f[4]), 'low': num(f[5]),
                  'time': f[6] if len(f) > 6 else ''}
    return out


def grab_usd_index():
    j, err = get_json('https://push2.eastmoney.com/api/qt/stock/get'
                      '?secid=100.UDI&fields=f43,f58,f170')
    if err or not j or not j.get('data'):
        return None
    d = j['data']
    v = num(d.get('f43'))
    return {'name': d.get('f58') or '美元指数',
            'price': round(v / 100.0, 2) if v else None,
            'pct': round((num(d.get('f170')) or 0) / 100.0, 2)}


def grab_cn_spot():
    """沪深两市成交额（亿元）与指数实时。"""
    j, err = get_json('https://push2.eastmoney.com/api/qt/ulist.np/get'
                      '?secids=1.000001,0.399001&fields=f2,f3,f6,f12,f14&fltt=2')
    if err or not j or not j.get('data'):
        return None, err
    total = 0.0
    for it in j['data'].get('diff') or []:
        total += num(it.get('f6')) or 0
    return round(total / 1e8, 0), None


def grab_breadth():
    """全市场涨跌家数与涨跌停家数。

    东财 clist 单页硬上限 100 条（pz 传多大都只回 100），全市场约 6000 只，
    所以按 pn 并发翻页把涨跌幅全抓回来自己统计。口径：涨跌幅 >=9.8% 计涨停、<=-9.8% 计跌停。
    """
    base = ('https://push2.eastmoney.com/api/qt/clist/get?po=1&np=1&fltt=2&invt=2&fid=f3'
            '&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048'
            '&fields=f3&pz=100&pn=%d')
    first, err = get_json(base % 1, timeout=25)
    if err or not first or not first.get('data'):
        return None, err
    total = first['data'].get('total') or 0
    pages = (total + 99) // 100
    rows = list(first['data'].get('diff') or [])

    from concurrent.futures import ThreadPoolExecutor
    def one(pn):
        j, _ = get_json(base % pn, timeout=25)
        return (j or {}).get('data', {}).get('diff') or [] if j and j.get('data') else []

    with ThreadPoolExecutor(max_workers=8) as ex:
        for chunk in ex.map(one, range(2, pages + 1)):
            rows.extend(chunk)

    up = dn = flat = lu = ld = 0
    for it in rows:
        v = num(it.get('f3'))
        if v is None:
            continue
        if v > 0:
            up += 1
        elif v < 0:
            dn += 1
        else:
            flat += 1
        if v >= 9.8:
            lu += 1
        if v <= -9.8:
            ld += 1
    return {'up': up, 'down': dn, 'flat': flat, 'limit_up': lu, 'limit_down': ld,
            'total': len(rows), 'pages': pages}, None



def grab_sectors():
    """行业板块涨跌幅（东财二级行业 m:90 t:2）。"""
    url = ('https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=200&po=1&np=1'
           '&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f3,f14')
    j, err = get_json(url)
    if err or not j or not j.get('data'):
        return [], []
    rows = [{'n': x.get('f14'), 'pct': num(x.get('f3'))}
            for x in (j['data'].get('diff') or []) if num(x.get('f3')) is not None]
    return rows[:8], rows[-8:][::-1]


def grab_news(pages=4):
    """东财 7x24 快讯（分页用 sortEnd 游标）。"""
    out, cursor = [], ''
    for _ in range(pages):
        url = ('https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724'
               '&fastColumn=102&sortEnd=%s&pageSize=50&req_trace=%d'
               % (urllib.parse.quote(cursor), int(time.time() * 1000)))
        j, err = get_json(url, 'https://kuaixun.eastmoney.com/')
        if err or not j or not j.get('data'):
            break
        lst = j['data'].get('fastNewsList') or []
        if not lst:
            break
        for it in lst:
            out.append({'t': (it.get('title') or '').strip(),
                        'time': (it.get('showTime') or '')[:16],
                        'sum': (it.get('summary') or '').strip()})
        cursor = j['data'].get('sortEnd') or ''
        if not cursor:
            break
    # 去重，按时间倒序
    seen, uniq = set(), []
    for it in out:
        if it['t'] and it['t'] not in seen:
            seen.add(it['t'])
            uniq.append(it)
    return uniq[:60]


# ---- 补充资讯源（2026-11-23 参照「A股每日新闻早报」自动化包改造）
# 原事实包只有东财 7x24 的短标题，模型拿到的是一堆「发生了什么」的碎片，
# 写出来的稿子只能是「XX 传导至 XX」的套话。参考包里的高质量稿靠的是
# 金十 / 财联社 / 证券日报等多源全文。这里把三个无需 key 的公开源接进来，
# 并保留全文（不再砍到 160 字），让模型有足够素材写因果链。
TAG_RE = re.compile(r'<[^>]+>')
TIME_RE = re.compile(r'(\d{1,2}:\d{2})')


def hhmm_of(s):
    """各源时间格式不一（HH:MM / YYYY-MM-DD HH:MM:SS / 时间戳），统一成 HH:MM。"""
    m = TIME_RE.search(str(s or ''))
    return m.group(1).zfill(5) if m else ''


def clean_flash(s):
    # html.unescape 会把 RSS 里的 &#39; &#8217; 等实体也还原，旧的手工替换保留兼容。
    s = html_lib.unescape(TAG_RE.sub('', str(s or '')))
    s = s.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&quot;', '"')
    return re.sub(r'\s+', ' ', s).strip()


def grab_sina_flash(limit=60):
    """新浪财经 7x24 全球实时财经快讯。"""
    url = ('https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=%d'
           '&zhibo_id=152&tag_id=0&dire=f&dpc=1' % limit)
    j, err = get_json(url, 'https://finance.sina.com.cn/7x24/', 20)
    if err or not j:
        return [], err
    try:
        rows = j['result']['data']['feed']['list'] or []
    except Exception:
        return [], '结构变化'
    out = []
    for x in rows:
        txt = clean_flash(x.get('rich_text'))
        if len(txt) < 12:
            continue
        out.append({'t': txt[:60], 'time': hhmm_of(x.get('create_time')),
                    'sum': txt[:400], 'src': '新浪7x24'})
    return out, None


def grab_jin10_flash(limit=60):
    """金十数据快讯（js 变量 newest = [...]）。"""
    body, ms, err = fetch('https://www.jin10.com/flash_newest.js', 'https://www.jin10.com/')
    if err or not body:
        return [], err
    s = body.decode('utf-8', 'ignore')
    try:
        arr = json.loads(s[s.index('['):s.rindex(']') + 1])[:limit]
    except Exception as e:
        return [], 'parse: %s' % e
    out = []
    for x in arr:
        d = x.get('data') or {}
        txt = clean_flash(d.get('content') or d.get('title'))
        if len(txt) < 12:
            continue
        out.append({'t': (d.get('title') or txt)[:60], 'time': hhmm_of(x.get('time')),
                    'sum': txt[:400], 'src': '金十数据',
                    'important': 1 if x.get('important') else 0})
    return out, None


def grab_wscn_flash(limit=60):
    """华尔街见闻 7x24（content_text 是全文）。"""
    url = ('https://api-one-wscn.awtmt.com/apiv1/content/lives'
           '?channel=global-channel&client=pc&limit=%d' % limit)
    j, err = get_json(url, 'https://wallstreetcn.com/live/global', 20)
    if err or not j:
        return [], err
    rows = (j.get('data') or {}).get('items') or []
    out = []
    for x in rows:
        txt = clean_flash(x.get('content_text') or x.get('title'))
        if len(txt) < 12:
            continue
        try:
            tm = time.strftime('%H:%M', time.localtime(float(x.get('display_time') or 0)))
        except Exception:
            tm = ''
        out.append({'t': (x.get('title') or txt)[:60], 'time': tm,
                    'sum': txt[:400], 'src': '华尔街见闻',
                    'important': 1 if (x.get('score') or 0) >= 5 else 0})
    return out, None


def grab_em_search(keyword, limit=20, days=3, pages=2):
    """东财全站文章检索：用来补「昨晚/上周五」的深度事实。

    快讯源只有最近几小时，而参考稿的高价值数字（CME 加息概率、费半周跌幅、
    DRAM/NAND 合约价、券商策略）大多出现在前一两天的文章里。这里按关键词
    定向检索，把命中文章的标题+正文摘要接进事实包。

    多页翻取，不设人为上限：limit 是每页条数、pages 是翻几页，底料宁多勿少。
    """
    out = []
    for page in range(1, pages + 1):
        p = {'uid': '', 'keyword': keyword, 'type': ['cmsArticleWebOld'], 'client': 'web',
             'clientType': 'web', 'clientVersion': 'curr',
             'param': {'cmsArticleWebOld': {'searchScope': 'default', 'sort': 'time',
                                            'pageIndex': page, 'pageSize': limit,
                                            'preTag': '', 'postTag': ''}}}
        url = ('https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param='
               + urllib.parse.quote(json.dumps(p, ensure_ascii=False)))
        body, ms, err = fetch(url, 'https://so.eastmoney.com/')
        if err or not body:
            if page == 1:
                return [], err
            break
        s = body.decode('utf-8', 'ignore')
        i, j = s.find('('), s.rfind(')')
        if i < 0 or j < 0:
            break
        try:
            j2 = json.loads(s[i + 1:j])
            rows = (j2.get('result') or {}).get('cmsArticleWebOld') or []
        except Exception:
            break
        if not rows:
            break
        for x in rows:
            date = x.get('date') or ''
            content = clean_flash(x.get('content'))
            if len(content) < 25:
                continue
            out.append({'title': clean_flash(x.get('title')), 'date': date,
                        'sum': content[:500], 'src': '东财检索'})
    return out, None


def grab_ths_flash(limit=100, pages=3):
    """同花顺滚动资讯：券商研报、政策细节、产业价格，比快讯源深一层。多页翻取。"""
    out = []
    for page in range(1, pages + 1):
        url = ('https://news.10jqka.com.cn/tapp/news/push/stock/'
               '?page=%d&tag=&track=website&pagesize=%d' % (page, limit))
        j, err = get_json(url, 'https://news.10jqka.com.cn/', 20)
        if err or not j:
            break
        rows = (j.get('data') or {}).get('list') or []
        if not rows:
            break
        for x in rows:
            txt = clean_flash(x.get('digest') or x.get('title'))
            if len(txt) < 20:
                continue
            src = x.get('source') or '同花顺'
            out.append({'t': (x.get('title') or txt)[:60],
                        'time': hhmm_of(x.get('rtime') or x.get('ctime')),
                        'sum': txt[:500],
                        'src': src if src in ('财联社', '证券时报', '上海证券报', '新华社', '中国基金报') else '同花顺',
                        'important': 1 if (x.get('import') or x.get('field')) else 0})
    return out, None


def grab_nbd(limit=60):
    """每日经济新闻：列表页是静态 HTML，能直接解析文章标题+链接。"""
    body, ms, err = fetch('https://www.nbd.com.cn/', 'https://www.nbd.com.cn/')
    if err or not body:
        return [], err
    s = body.decode('utf-8', 'ignore')
    pairs = re.findall(r'href="(https?://www\.nbd\.com\.cn/articles/[^"]+\.html)"[^>]*>\s*([^<]{12,120})<', s)
    seen, out = set(), []
    for url, title in pairs:
        t = clean_flash(title)
        key = re.sub(r'[^\u4e00-\u9fa5A-Za-z0-9]', '', t)[:30]
        if not key or key in seen:
            continue
        seen.add(key)
        out.append({'t': t[:60], 'time': '', 'sum': t, 'src': '每日经济新闻', 'url': url})
        if len(out) >= limit:
            break
    return out, None


# ---- 17 个新增公开源（2026-11-23 全网筛选 + 实测）
# 口径：只接公开事实/标题/摘要，不绕过登录、付费墙、验证码；全部低频率拉取。
# 财联社 / 格隆汇进「快讯」，其余公告与 RSS 进「深度资料」，由下游事件级去重。
LINK_RE = re.compile(r'<a\b[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', re.I | re.S)


def _local_tag(tag):
    return str(tag or '').split('}')[-1].lower()


def _xml_text(node, name):
    """RSS/Atom 混着用，按本地标签名找文本，避免命名空间版本差异。"""
    for ch in node.iter():
        if _local_tag(ch.tag) == name.lower() and (ch.text or '').strip():
            return ch.text.strip()
    return ''


def _xml_link(node):
    for ch in node.iter():
        if _local_tag(ch.tag) == 'link':
            if (ch.text or '').strip():
                return ch.text.strip()
            href = ch.attrib.get('href')
            if href:
                return href
    return ''


def grab_rss(url, src, limit=30):
    """通用 RSS/Atom：CNBC/WSJ/MarketWatch/Fed/财政部/中国政府网都走这条。"""
    body, ms, err = fetch(url, url, 20)
    if err or not body:
        # 少数 RSS 网关对 Referer 敏感（MarketWatch 曾返回 400），无 Referer 重试一次。
        time.sleep(1)
        body, ms, err = fetch(url, None, 20)
    if err or not body:
        return [], err
    try:
        root = ET.fromstring(body)
    except Exception as e:
        return [], 'RSS解析失败: %s' % type(e).__name__
    items = [n for n in root.iter() if _local_tag(n.tag) == 'item']
    if not items:
        items = [n for n in root.iter() if _local_tag(n.tag) == 'entry']
    out, seen = [], set()
    for it in items:
        title = clean_flash(_xml_text(it, 'title'))
        desc = clean_flash(_xml_text(it, 'description') or _xml_text(it, 'summary')
                           or _xml_text(it, 'content'))
        if len(title) < 8 and len(desc) < 20:
            continue
        if not title:
            title = desc[:60]
        key = re.sub(r'[^\u4e00-\u9fa5A-Za-z0-9]', '', title)[:36]
        if not key or key in seen:
            continue
        seen.add(key)
        date = (_xml_text(it, 'pubDate') or _xml_text(it, 'published')
                or _xml_text(it, 'updated'))
        out.append({'t': title[:80], 'time': hhmm_of(date), 'date': date[:16],
                    'sum': (desc or title)[:500], 'src': src,
                    'url': _xml_link(it)[:300]})
        if len(out) >= limit:
            break
    return out, None if out else 'RSS 无条目'


def grab_html_list(url, src, limit=30, href_kw=None, minlen=12):
    """通用列表页解析：证监会/统计局/央行/财政部这种静态栏目页。"""
    body, ms, err = fetch(url, url, 20)
    if err or not body:
        return [], err
    s = body.decode('utf-8', 'ignore')
    if s.count('\ufffd') > 20:
        s = body.decode('gbk', 'ignore')
    skip = ('ICP备', '公网安备', '版权所有', '联系我们', '网站地图', 'English')
    out, seen = [], set()
    for href, raw in LINK_RE.findall(s):
        title = clean_flash(raw)
        href = html_lib.unescape(href.strip())
        if len(title) < minlen or title.startswith(skip):
            continue
        if not href or href.startswith(('#', 'javascript:')):
            continue
        if href_kw and not any(k in href for k in href_kw):
            continue
        key = re.sub(r'[^\u4e00-\u9fa5A-Za-z0-9]', '', title)[:36]
        if not key or key in seen:
            continue
        seen.add(key)
        out.append({'t': title[:80], 'time': '', 'sum': title[:500], 'src': src,
                    'url': urllib.parse.urljoin(url, href)[:300]})
        if len(out) >= limit:
            break
    return out, None if out else '列表页未解析到条目'


def grab_cls_flash(limit=50):
    """财联社电报新版接口：公开参数 + 本地签名（无 key、不突破权限）。"""
    params = {'appName': 'CailianpressWeb', 'name': 'telegraph',
              'os': 'web', 'sv': '8.7.9'}
    q = urllib.parse.urlencode(sorted(params.items()))
    sign = hashlib.md5(hashlib.sha1(q.encode()).hexdigest().encode()).hexdigest()
    url = 'https://www.cls.cn/api/cache?' + q + '&sign=' + sign
    j, err = get_json(url, 'https://www.cls.cn/telegraph', 20)
    if err or not j or j.get('errno'):
        return [], err or ('errno=%s' % j.get('errno') if j else '空响应')
    rows = ((j.get('data') or {}).get('roll_data') or [])[:limit]
    out = []
    for x in rows:
        txt = clean_flash(x.get('content') or x.get('brief') or x.get('title'))
        if len(txt) < 10:
            continue
        try:
            tm = time.strftime('%H:%M', time.localtime(float(x.get('ctime') or 0)))
        except Exception:
            tm = ''
        out.append({'t': (x.get('title') or txt)[:60], 'time': tm,
                    'sum': txt[:400], 'src': '财联社',
                    'important': 1 if x.get('level') in ('A', 'B') else 0,
                    'url': (x.get('shareurl') or '')[:200]})
    return out, None if out else '无快讯条目'


def grab_gelonghui_flash(limit=40):
    """格隆汇 7x24 快讯：公开 JSON 接口，列表即全文。"""
    url = ('https://www.gelonghui.com/api/live-channels/all/lives/v4'
           '?category=all&limit=%d' % limit)
    j, err = get_json(url, 'https://www.gelonghui.com/live', 20)
    if err or not j:
        return [], err
    out = []
    for x in (j.get('result') or []):
        txt = clean_flash(x.get('content') or x.get('title'))
        if len(txt) < 10:
            continue
        try:
            tm = time.strftime('%H:%M', time.localtime(float(x.get('createTimestamp') or 0)))
        except Exception:
            tm = ''
        out.append({'t': clean_flash(x.get('title') or txt)[:60], 'time': tm,
                    'sum': txt[:400], 'src': '格隆汇',
                    'important': 1 if (x.get('level') or 0) >= 1 else 0,
                    'url': (x.get('route') or '')[:200]})
    return out, None if out else '无快讯条目'


def grab_cninfo_announcements(limit=60):
    """巨潮公告：法定披露源。用近 3 天窗口，避免 seDate=~ 返回空壳。"""
    bj_now = time.time() + 8 * 3600
    today = time.strftime('%Y-%m-%d', time.gmtime(bj_now))
    start = time.strftime('%Y-%m-%d', time.gmtime(bj_now - 3 * 86400))
    url = 'http://www.cninfo.com.cn/new/hisAnnouncement/query'
    referer = 'http://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure/list/search'
    out, errs = [], []
    for col in ('szse', 'sse'):
        payload = urllib.parse.urlencode({
            'pageNum': 1, 'pageSize': min(40, limit), 'column': col,
            'tabName': 'fulltext', 'plate': '', 'stock': '', 'searchkey': '',
            'secid': '', 'category': '', 'trade': '',
            'seDate': '%s~%s' % (start, today),
            'sortName': 'time', 'sortType': 'desc', 'isHLtitle': 'true',
        }).encode()
        body, ms, err = fetch(url, referer, 20, data=payload, headers={
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest'})
        if err or not body:
            errs.append(err or '空响应')
            continue
        try:
            j = json.loads(body.decode('utf-8', 'ignore'))
        except Exception as e:
            errs.append('解析失败:%s' % type(e).__name__)
            continue
        for x in (j.get('announcements') or []):
            title = clean_flash('%s：%s' % (x.get('secName') or '', x.get('announcementTitle') or ''))
            if len(title) < 10:
                continue
            try:
                date = time.strftime('%Y-%m-%d',
                                     time.gmtime(float(x.get('announcementTime') or 0) / 1000 + 8 * 3600))
            except Exception:
                date = ''
            out.append({'t': title[:80], 'time': '', 'date': date,
                        'sum': (title + '（%s）' % (x.get('announcementTypeName') or '公告'))[:500],
                        'src': '巨潮公告',
                        'url': ('http://static.cninfo.com.cn/' + (x.get('adjunctUrl') or ''))[:300]})
    return out[:limit], None if out else ('；'.join(errs[:2]) or '窗口内0条')


def grab_sse_announcements(limit=40):
    """上交所公告查询接口：必须带官网 Referer，jsonCallBack 保留。"""
    bj_now = time.time() + 8 * 3600
    today = time.strftime('%Y-%m-%d', time.gmtime(bj_now))
    start = time.strftime('%Y-%m-%d', time.gmtime(bj_now - 3 * 86400))
    params = {
        'jsonCallBack': 'cb', 'isPagination': 'true', 'productId': '',
        'keyWord': '', 'securityType': '0101,120100,020100,020200,120200',
        'reportType2': '', 'reportType': 'ALL',
        'beginDate': start, 'endDate': today,
        'pageHelp.pageSize': min(40, limit), 'pageHelp.pageCount': 50,
        'pageHelp.pageNo': 1, 'pageHelp.beginPage': 1,
        'pageHelp.cacheSize': 1, 'pageHelp.endPage': 5,
    }
    url = 'http://query.sse.com.cn/security/stock/queryCompanyBulletin.do?' + urllib.parse.urlencode(params)
    body, ms, err = fetch(url, 'http://www.sse.com.cn/disclosure/listedinfo/announcement/', 20)
    if err or not body:
        return [], err
    s = body.decode('utf-8', 'ignore')
    i, j = s.find('('), s.rfind(')')
    try:
        j2 = json.loads(s[i + 1:j] if i >= 0 and j > i else s)
    except Exception as e:
        return [], '解析失败: %s' % type(e).__name__
    out = []
    for x in (j2.get('result') or [])[:limit]:
        title = clean_flash('%s：%s' % (x.get('SECURITY_NAME') or '', x.get('TITLE') or ''))
        if len(title) < 10:
            continue
        date = x.get('SSEDATE') or (x.get('ADDDATE') or '')[:10] or ''
        out.append({'t': title[:80], 'time': hhmm_of(x.get('ADDDATE')), 'date': date,
                    'sum': (title + '（%s）' % (x.get('BULLETIN_HEADING') or '公告'))[:500],
                    'src': '上交所公告',
                    'url': ('http://www.sse.com.cn' + (x.get('URL') or ''))[:300]})
    return out, None if out else '窗口内0条'


# 国内官方栏目 / 全球 RSS：每条都作为独立深料源进入诊断与配额。
NEW_RSS_SOURCES = (
    ('中国政府网政策', 'https://www.gov.cn/pushinfo/v150203/rss.xml'),
    ('CNBC Markets', 'https://www.cnbc.com/id/10001147/device/rss/rss.html'),
    ('CNBC US', 'https://www.cnbc.com/id/100003114/device/rss/rss.html'),
    ('CNBC Business', 'https://www.cnbc.com/id/15839069/device/rss/rss.html'),
    ('WSJ Markets', 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml'),
    ('MarketWatch', 'https://feeds.content.dowjones.io/public/rss/mw_topstories'),
    ('Seeking Alpha', 'https://seekingalpha.com/feed.xml'),
    ('美联储新闻', 'https://www.federalreserve.gov/feeds/press_all.xml'),
    ('美国财政部', 'https://home.treasury.gov/rss.xml'),
)
NEW_HTML_SOURCES = (
    ('证监会', 'http://www.csrc.gov.cn/csrc/c100028/common_list.shtml', ('c100028',)),
    ('国家统计局', 'https://www.stats.gov.cn/sj/zxfb/', ('t20',)),
    ('中国人民银行', 'http://www.pbc.gov.cn/goutongjiaoliu/113456/113469/index.html',
     ('goutongjiaoliu',)),
    ('财政部', 'https://www.mof.gov.cn/zhengwuxinxi/caizhengxinwen/', ('t20',)),
)


# 每个检索词对应参考稿里的一类「深度事实」。保留关键词本身，
# 让模型知道这些是刻意查来的，而不是拼凑的快讯。
DEEP_QUERY = (
    # 外围与货币政策
    '美联储12月加息概率 CME', 'FOMC 会议纪要 点阵图', '美国 PCE CPI 通胀 预期',
    '美债收益率 美元指数 走势', '费城半导体指数 跌幅 周', '纳指 标普 道指 收盘',
    '特朗普 关税 美联储 政策',
    # 产业主线
    'DRAM NAND 合约价 集邦', '存储芯片 美光 海力士 三星', '英伟达 SEC 审查 新加坡',
    'AI 算力 资本开支 泡沫', '光模块 PCB 出海 订单', '油价 OPEC 地缘 红海',
    '黄金 白银 走势 避险',
    # 国内政策与资金
    '融资保证金 80% 降费 亿', '主动ETF 360亿 上市', '央行 逆回购 MLF 净投放',
    '十大券商 周策略 不必悲观', '证监会 稳市 政策 组合拳', 'ETF 净申购 宽基 资金',
    # A股盘面与结构
    'A股 上周五 收盘 成交额 低点', '沪指 3500 支撑 量能', '两融余额 杠杆资金 流出',
    '板块 涨跌 领涨 领跌', '个股 解禁 业绩预告', '北向资金 外资 A股',
)


HOT_KW = ('美联储', '加息', '降息', '英伟达', '央行', 'A股', '沪指', 'ETF', '存储',
          'DRAM', 'NAND', '油价', '黄金', '关税', '政策', 'MLF', '逆回购', '半导体',
          'AI', '机器人', '出口', 'CPI', 'PCE', 'FOMC', '证监会', '财政部', '国债',
          '美债', '美元', '日经', '韩股', '解禁', '上市', '集采', '降费', '做市商')


def curate_news(pools, cap=48):
    """多源快讯去重 + 按信息量排序，挑出最值得写进正文的一批。

    宁可少而精：模型上下文有限，塞 200 条碎片只会让它抓不到主线。
    """
    seen, out = set(), []
    for src, rows in pools:
        for x in rows or []:
            key = re.sub(r'[^\u4e00-\u9fa5A-Za-z0-9]', '', x.get('sum', ''))[:38]
            if not key or key in seen:
                continue
            seen.add(key)
            s = x.get('sum', '')
            score = 0
            if re.search(r'\d', s):
                score += 2
            if x.get('important'):
                score += 2
            score += sum(1 for k in HOT_KW if k in s)
            if len(s) >= 80:
                score += 1
            x = dict(x)
            x['_score'] = score
            out.append(x)
    out.sort(key=lambda a: (-a['_score'], a.get('time', '')), reverse=False)
    # 时间倒序作为次级排序（字符串 HH:MM 可直接比）
    out.sort(key=lambda a: a.get('time', ''), reverse=True)
    out.sort(key=lambda a: -a['_score'])
    return out[:cap]


# ---------------------------------------------------------------- 组装事实
def build_facts(slot, now_bj=None):
    """把能拿到的数据整理成一份「事实包」，同时记录进度与缺口。"""
    now_bj = now_bj or time.gmtime()
    diag = {'steps': [], 'missing': []}

    def step(name, ok, extra=''):
        diag['steps'].append({'name': name, 'ok': bool(ok), 'note': extra})

    q, err = grab_tencent_quotes()
    step('腾讯行情(A股/美股/港股)', q, err or '%d 个代码' % len(q))

    fut = grab_futures()
    step('新浪外盘期货(A50/金/银/油/铜)', fut, '%d 个' % len(fut))

    usd = grab_usd_index()
    step('东财美元指数', usd, '' if usd else '失败')

    spot, serr = grab_cn_spot()
    # 东财偶发返回空 diff，折算出来是 0 亿——这不是「今日零成交」，是抓失败。
    # 不能把 0 塞进事实包，否则模型会照抄一个不存在的数字。
    if not spot or spot <= 0:
        spot, serr = None, serr or '返回 0 亿（接口空数据）'
    step('沪深成交额', spot is not None, serr or ('%.0f 亿' % spot))

    breadth, berr = grab_breadth()
    step('涨跌家数(全市场)', breadth, berr or ('%s 家' % (breadth or {}).get('total')))

    top, bottom = grab_sectors()
    step('行业板块', top, '%d 个' % len(top))

    news_em = grab_news()
    step('东财7x24快讯', news_em, '%d 条' % len(news_em))

    # 多源全文快讯：东财/新浪/金十/见闻/同花顺/每经，不设人为上限。
    # 底料宁多勿少——判断准不准取决于素材充分不充分，不是靠模型凭空发挥。
    pools = [('东财', news_em)]
    for name, fn in (('新浪7x24', grab_sina_flash), ('金十数据', grab_jin10_flash),
                     ('华尔街见闻', grab_wscn_flash), ('同花顺', grab_ths_flash),
                     ('每日经济新闻', grab_nbd), ('财联社', grab_cls_flash),
                     ('格隆汇', grab_gelonghui_flash)):
        try:
            rows, e = fn()
            step(name + '快讯', rows, e or ('%d 条' % len(rows)))
            pools.append((name, rows))
        except Exception as e:
            step(name + '快讯', False, str(e)[:80])
    raw_news = curate_news(pools, 400)   # 汇总上限放宽到 400，交给下游分级取用
    step('多源快讯汇总', raw_news, '%d 条（已按信息量筛选）' % len(raw_news))

    # 定向检索：参考稿的核心竞争力是「昨晚/上周五」的深度事实（CME 概率、
    # 费半周跌幅、DRAM/NAND 合约价、券商策略、政策细节），这些不在当天的快讯里。
    # 24 组关键词 × 每组 20 篇 × 2 页，不设人为上限，宁可多抓再由下游筛选。
    deep, seen_deep = [], set()
    for qk in DEEP_QUERY:
        try:
            rows, e = grab_em_search(qk, limit=20, pages=2)
            if e:
                step('检索·' + qk, False, e)
                continue
            added = 0
            for x in rows:
                key = re.sub(r'[^\u4e00-\u9fa5A-Za-z0-9]', '', x['title'])[:30]
                if not key or key in seen_deep:
                    continue
                seen_deep.add(key)
                x['query'] = qk
                deep.append(x)
                added += 1
            step('检索·' + qk, added, '%d 篇' % added)
        except Exception as e:
            step('检索·' + qk, False, str(e)[:80])
    step('深度检索汇总', deep, '%d 篇' % len(deep))

    # 新增 17 源里的 15 个深料源：公告/政策/RSS。单独诊断、单独配额，
    # 失败不会中断整份报告；每源按自己的名字进 query，避免被热门检索词挤掉。
    new_deep = []
    def add_new_deep(rows, name):
        n = 0
        for x in rows or []:
            y = dict(x)
            y['query'] = '新源·' + name
            # 深料统一用 title 字段，compact_facts 的 dedupe_events 按 title 取主键
            y['title'] = y.get('title') or y.get('t') or ''
            new_deep.append(y)
            n += 1
        return n

    for name, fn in (('巨潮公告', grab_cninfo_announcements),
                     ('上交所公告', grab_sse_announcements)):
        try:
            rows, e = fn()
            n = add_new_deep(rows, name)
            step('新源·' + name, n, e or ('%d 篇' % n))
        except Exception as e:
            step('新源·' + name, False, str(e)[:80])
    for name, url in NEW_RSS_SOURCES:
        try:
            rows, e = grab_rss(url, name, 30)
            n = add_new_deep(rows, name)
            step('新源·' + name, n, e or ('%d 篇' % n))
        except Exception as e:
            step('新源·' + name, False, str(e)[:80])
    for name, url, href_kw in NEW_HTML_SOURCES:
        try:
            rows, e = grab_html_list(url, name, 30, href_kw=href_kw)
            n = add_new_deep(rows, name)
            step('新源·' + name, n, e or ('%d 篇' % n))
        except Exception as e:
            step('新源·' + name, False, str(e)[:80])
    deep.extend(new_deep)
    step('新增深料源汇总', new_deep, '%d 篇' % len(new_deep))

    diag['missing'].append('美债10年期收益率（东财/新浪公开接口均无返回，已从正文剔除）')

    return {'quotes': q, 'futures': fut, 'usd': usd, 'turnover': spot,
            'breadth': breadth, 'sectors_top': top, 'sectors_bottom': bottom,
            'news': raw_news, 'deep': deep}, diag


def rank_deep(rows, cap=200):
    """深度文章太多放不进上下文，按信息密度与主题相关度打分取前 cap 篇。

    打分依据（与参考稿写法对齐）：
      - 数字越密越好（硬事实多）
      - 命中宏观/产业/政策关键词越多越好
      - 正文越长越好（有展开，不是标题党）
      - 同一检索词下不只取一篇——24 组词都要有代表，避免全被某一个热门词刷屏
    """
    kws = ('加息', '降息', '概率', '指数', '收盘', '涨', '跌', '亿', '万亿', '%',
           'DRAM', 'NAND', '存储', '合约价', '美联储', 'PCE', 'CPI', 'FOMC',
           '融资', '降费', '保证金', 'ETF', '净申购', '两融', '逆回购', 'MLF',
           '券商', '策略', '支撑', '压力', '点位', '成交', '解禁', '北向')

    def score(x):
        s = (x.get('title') or '') + ' ' + (x.get('sum') or '')
        n = len(NUM_RE.findall(s))
        return (min(n, 18) * 2 + sum(1 for k in kws if k in s) * 3
                + min(len(x.get('sum') or ''), 500) // 100)

    ranked = sorted(rows, key=score, reverse=True)
    # 主题配额：每个检索词/新源最多 8 篇，保证各维度都有素材进来，不被热门词刷屏
    quota, out = {}, []
    for x in ranked:
        q = x.get('query', '')
        if quota.get(q, 0) >= 8:
            continue
        quota[q] = quota.get(q, 0) + 1
        out.append(x)
        if len(out) >= cap:
            break
    return out


# 事件级去重：同一件事常被 7 个源反复报道，字面去重抓不住（措辞不同）。
# 用「主题锚点」当指纹：命中哪个主题 + 文里最有辨识度的数字组合。
# 同指纹合并为一条，保留全部来源（来源多=事件重要，不是重复噪音）。
EVENT_ANCHORS = (
    ('美联储加息', ('美联储', '加息', 'FOMC', 'CME', '利率')),
    ('纳指暴跌', ('纳指', '纳斯达克', '美股', '费城半导体', '费半', 'VIX')),
    ('英伟达SEC', ('英伟达', 'SEC', '黄仁勋')),
    ('黄金避险', ('黄金', '金价', '现货金', '贵金属', '白银')),
    ('存储芯片', ('DRAM', 'NAND', '存储', '美光', '海力士', '三星', '集邦')),
    ('稳市新政', ('融资保证金', '降费', '做市商', '稳市', '证监会')),
    ('ETF资金', ('ETF', '净申购', '净流入', '主动ETF', '宽基')),
    ('央行流动性', ('逆回购', 'MLF', '净投放', '央行', '到期')),
    ('韩股日股', ('韩国', 'KOSPI', '韩股', '日经', '日本股市')),
    ('A股盘面', ('沪指', '上证', '创业板', '科创', '两市成交', '成交额')),
    ('券商策略', ('券商', '中信', '中金', '银河证券', '十大券商', '周策略', '研报')),
    ('两融杠杆', ('两融', '融资余额', '杠杆资金', '融资盘')),
    ('油价地缘', ('油价', '原油', 'OPEC', 'WTI', '布油', '红海', '伊朗')),
    ('汇率美债', ('美元指数', '美债', '人民币', '汇率')),
    ('解禁IPO', ('解禁', 'IPO', '申购', '上市')),
)


def event_fingerprint(text, title=''):
    """主题 + 文中高辨识度数字构成指纹。

    只对「有明确市场主题」的新闻做事件合并；没有锚点的杂讯用标题前 24 字做
    指纹，避免「达美航空故障」和「败血症救治」因为都带数字被误并成同一事件。
    """
    s = str(text or '')
    themes = [name for name, kws in EVENT_ANCHORS if any(k in s for k in kws)]
    if not themes:
        # 无市场主题：按标题正文前 24 个中文字做指纹，措辞相同才算同类
        raw = re.sub(r'[^\u4e00-\u9fa5A-Za-z0-9]', '', str(title or s))[:24]
        return '杂讯|' + raw
    theme = themes[0]
    # 数字取两个高辨识度值；排除年份(20xx)、月份日期(1-12)、时分这类噪声
    nums = []
    for m in NUM_RE.finditer(s):
        try:
            v = float(m.group(0))
        except Exception:
            continue
        if 1900 <= v <= 2100 or v < 5 or v in nums:
            continue
        nums.append(v)
        if len(nums) >= 2:
            break
    return theme + '|' + ','.join('%g' % v for v in nums)


def dedupe_events(rows, key_t, key_sum='sum', key_src='src', cap=None):
    """事件级去重：同指纹合并，来源汇总，保留信息最全的那条做主体。

    返回 [(事件摘要, 来源列表, 原始条目)]，供下游决定喂多少给模型。
    """
    groups = {}
    for x in rows:
        title = x.get(key_t) or ''
        text = title + ' ' + (x.get(key_sum) or '')
        fp = event_fingerprint(text, title)
        src = x.get(key_src) or '未知'
        if fp not in groups:
            groups[fp] = {'main': x, 'sources': [src], 'text': text, 'n': 1}
        else:
            g0 = groups[fp]
            g0['n'] += 1
            if src not in g0['sources']:
                g0['sources'].append(src)
            # 主体保留更长的正文（信息更全）
            if len(x.get(key_sum) or '') > len(g0['main'].get(key_sum) or ''):
                g0['main'] = x
    out = []
    for fp, g0 in groups.items():
        out.append({'fp': fp, 'main': g0['main'], 'sources': g0['sources'],
                    'n': g0['n'], 'text': g0['text']})
    # 排序权重：主题重要性 > 多源共振数 > 正文字数。
    # 不能只按来源数排——「达美航空故障」这类杂讯也可能多平台转载，
    # 但和 A 股盘面无关，不该挤掉真正的主线事件。
    theme_rank = {name: len(EVENT_ANCHORS) - i for i, (name, _) in enumerate(EVENT_ANCHORS)}
    def weight(a):
        theme = a['fp'].split('|')[0]
        return (theme_rank.get(theme, 0) * 10 + min(a['n'], 8)
                + min(len(a['main'].get(key_sum) or ''), 400) // 100)
    out.sort(key=weight, reverse=True)
    return out[:cap] if cap else out


def compact_facts(f, slot):
    """给模型看的事实包：只保留正文会引用的字段，避免它乱抓。"""
    q = f['quotes']
    pick = lambda c: ({'price': q[c]['price'], 'pct': q[c]['pct']} if c in q else None)
    out = {
        '时段': {'morning': '早报（盘前）', 'noon': '午间速览', 'close': '收盘复盘'}[slot],
        'A股指数': {'上证': pick('sh000001'), '深成指': pick('sz399001'),
                    '创业板指': pick('sz399006'), '科创50': pick('sh000688')},
        '美股上日收盘': {'道指': pick('usDJI'), '纳指': pick('usIXIC'), '标普500': pick('usINX')},
        '港股': {'恒指': pick('hkHSI'), '恒生科技': pick('hkHSTECH')},
        '富时中国A50期货': ({'price': f['futures']['hf_CHA50CFD']['price'],
                             'pct': f['futures']['hf_CHA50CFD']['pct']}
                            if 'hf_CHA50CFD' in f['futures'] else None),
        '商品': {k.split('_')[1]: {'price': v['price'], 'pct': v['pct']}
                 for k, v in f['futures'].items() if k != 'hf_CHA50CFD'},
        '美元指数': f['usd'],
        '沪深两市成交额_亿元': f['turnover'],
        '涨跌家数': f['breadth'],
        '行业涨幅前8': f['sectors_top'][:8],
        '行业跌幅前8': f['sectors_bottom'][:8],
        # 快讯：400 条原始 → 事件级去重后取前 90 条。
        # 同一件事被多平台报道会合并成一条，但「N 个来源」会标出来——
        # 多源共振说明事件重要，不当作重复噪音删掉。
        '快讯': [{'时间': hhmm_of(ev['main'].get('time')),
                  '来源': '/'.join(ev['sources'][:4]) + ('等%d源' % ev['n'] if ev['n'] > 4 else ''),
                  '标题': ev['main']['t'], '全文': (ev['main'].get('sum') or '')[:340]}
                 for ev in dedupe_events(f['news'], 't', cap=90)],
        # 深度资料：576 篇 → 先按数字密度排序，再事件级去重取前 120 条。
        # 参考稿里的费半周跌幅、CME 概率、DRAM/NAND 合约价都出自这里。
        '深度资料': [{'检索词': ev['main'].get('query', ''),
                    '日期': ev['main'].get('date', ''),
                    '来源': '/'.join(ev['sources'][:3]) + ('等%d源' % ev['n'] if ev['n'] > 3 else ''),
                    '标题': ev['main']['title'], '内容': (ev['main'].get('sum') or '')[:260]}
                   for ev in dedupe_events(rank_deep(f.get('deep') or [], 400),
                                           'title', cap=120)],
        '昨日滚动观点': f.get('rolling') or {},
        '注意': '以上是本次能抓到的全部数据。正文禁止出现本包里没有的数字；'
                '美债收益率等未提供项不要提及。「昨日滚动观点」里的主线要滚动修订，'
                '不要照抄；事件日期与节点可以引用。',
    }
    return out


# ---------------------------------------------------------------- 写作提示
SYSTEM = """你是 A 股盘面分析师，给一个客户看的看盘网站写「三报」（早报 / 午间速览 / 收盘复盘）。
参照物是一份长期维护的《A股每日新闻早报》：它的价值不在复述新闻，而在
「把当天几条硬信息拆成因果链，说清哪个方向能做、哪个要躲、什么条件下改口」。

【硬规则】
1. 只使用事实包里出现的数字与事实。禁止编造点位、涨跌幅、金额、百分比。
2. 精确数字照抄；整数关口、目标位、区间（如 3500 点、1.5 万亿、3620—3740）可以作为
   「观察位 / 情景假设」使用，但必须写成条件句，不能冒充已发生的事实。
3. 每个判断都要写清成立条件与失效条件。「谨慎乐观」「或将继续震荡」这类两头话一律不合格。
4. 禁止套话：不要反复写「传导至 A 股XX板块」「显示抗跌性」「关注后续进展」。
   要写具体的人、机构、日期、价格、政策名，以及它们之间的因果。
5. 至少 5 条 news 的 long 里点名来源（金十数据 / 财联社 / 新浪7x24 / 华尔街见闻 / 东财7x24 等）。
6. 「深度资料」是按关键词专门检索来的前一两天的硬事实（CME 加息概率、费半周跌幅、
    DRAM/NAND 合约价、券商周策略、政策细节等）。**必须至少引用其中 4 个数字**，
    并写明出处机构（CME / 集邦 / 中信证券 / 新华社 等）。这些是拉开质量差距的关键，
    不要用快讯里的泛泛表述替代它们。
7. 只输出 JSON，不要 markdown 代码块，不要解释文字。

【输出结构】
{
 "verdict": "偏积极|偏消极|中性",
 "oneLine": "中性偏谨慎（一句话点出对立方阵）。……。结论：……",
 "bulls": ["事实+数字+传导，40–70 字", …4-6条],
 "bears": ["事实+数字+传导，40–70 字", …4-6条],
 "weigh": "哪一侧作用于开盘/当日走势，哪一侧决定跌不深，最后一句「所以判断是 X，不是 Y」",
 "points": ["【一、今天怎么开】…", "【二、主线要分两层看】…", "【三、方向排序：做谁、躲谁】…", "【四、中期时间轴与盘后关注】…"],
 "news": [{"t":"标题","d":"一句话","long":"100–160字全文展开","dir":"积极|消极|中性","lvl":"重要|中等|一般","sec":"影响板块"}],
 "watch": "① …；② …；③ …；④ …（每条带日期/时间点与可验证的数字）"
}

【四段 points 的写法（每段 250–400 字，硬要求）】
- 第一段「今天怎么开」：先写外围与今晨发生了什么（指数、期指、亚太盘、商品），
  再给开盘区间的条件判断，最后列 2–3 个对冲变量。用「第一…第二…第三…」串。
- 第二段「主线要分两层看」：挑当日最重要的一条产业/政策主线，**必须拆成两层**
  （例：治理折价 vs 产业需求；情绪冲击 vs 产业趋势；政策托底 vs 流动性到期）。
  每层都要有具体数字、机构观点、以及受益/受害的板块分层。
- 第三段「方向排序：做谁、躲谁」：点名 2–3 个最顺方向（政策直接给钱的、资金已经在买的、
  事件脉冲的），再点名 1–2 个要躲的方向，都要说不追高的理由。
- 第四段「中期时间轴与盘后关注」必须包含三块，缺一不可：
  ① **中期预测表浓缩**：挑 2–3 个重大事件，每个写成「事件 → 历史参照（过去同类周期股市怎么走）
     → 未来 1–3 个月板块影响 → 关键时间节点」。例如存储周期要写 DRAM 强 / NAND 弱的剪刀差、
     2017/2021 涨价周期的股价表现、12 月合约价与答辩日期。
  ② **四阶段大盘时间轴**：按「未来两周 / 12 月上旬 / 12 月中下旬 / 次年 1–3 月」四段推演，
     每段有明确的事件驱动与操作重心，不要笼统说「继续观察」。
  ③ **三情景区间**：乐观 / 中性 / 悲观各给点位区间与触发条件（点位可作条件位，不得冒充已发生）。
  最后列今日盘后到明晨要盯的 3–5 件事（带具体时间）。

【滚动要求】
事实包里的「昨日滚动观点」是昨天同一时段的判断。把其中的主线、时间节点、三情景
拿出来对照今天的新事实：变了就改写并说明变化，没变可以保留但必须补充今天的新数据。
不要整段照抄，也不要当成不存在。

【其余字段】
- oneLine 150–280 字，必须写成参考稿那种「胜负手」结构：
  「总判断（对立方阵，如外围撕裂：期指送暖、韩股先杀）＋利空一侧的具体数字＋
  对冲一侧的具体数字＋今天大概率怎么开＋**胜负手：某点位承接与量能（从 X 回到 Y）
  是全天关键，条件 A 就做 B，条件 C 就当脉冲**」。不要写「控仓避险为主」这种
  没有触发条件的空结论。数字尽量用深度资料里的硬数字（如 91.4%、27.58 亿、360 亿、3500.83）。
- bulls / bears 各 4–6 条，每条 40–70 字，「事实（带数字、带来源或机构）+ 传导路径」。
- weigh 120–200 字：先说谁决定开盘，再说谁决定跌不深，末句「所以判断是 X，不是 Y」。
- news 10–11 条（不足就按实际条数），long 100–160 字：发生了什么 + 关键数字 + 对板块的影响，
  点名来源；不要 5 条就交差。
- watch 4–5 条，每条带具体日期/时间点与可验证数字，不要一句话打包。
- verdict 只能取三个值之一，与整体强弱一致。
"""


# 2026-11-24：SYSTEM 最初是按早报写的（「今天怎么开」「今日大概率平开」），
# 收盘档也照抄，导致收评写成盘前预测。这里按时段覆盖写作目标，必须对模型显式说明。
SLOT_OVERRIDES = {
    'morning': '',
    'noon': """
【本时段：午间速览】
上文所有「今天怎么开 / 今日开盘区间的条件判断」统一改写为：
- 第一段「【一、上午怎么走】」：先复盘上午已发生的指数、成交额、板块与人气变化（用事实包里的收盘/半日数字），
  再说清楚这是延续还是反转了早报判断，最后给出下午 2–3 个可验证的观察变量。
- oneLine 写「上午发生了什么 + 多空对冲 + 下午胜负手」，禁止写「今天大概率平开/高开/低开」。
- weigh 写「上午是谁在买、谁在卖，下午谁决定方向」，不要写「作用于开盘」。
""",
    'close': """
【本时段：收盘复盘——最高优先级，覆盖上文所有盘前表述】
这是 15:00 收盘之后写的复盘，不是盘前预测。上文凡是出现「今天怎么开」「今日大概率平开/高开/低开」
「开盘区间」「开盘后需观察」「作用于开盘」的要求，一律改为下面这套收盘口径：
- 第一段固定标题「【一、今天怎么收】」：先写今日 A 股/港股实际收出的指数、成交额、涨跌家数、领涨领跌行业，
  再对照早报/午间判断说清「兑现了什么、证伪了什么」，最后列 2–3 个明日开盘前必须验证的变量。
  禁止写「今日大概率平开或微幅高开」这类盘前句式。
- oneLine 写「今日收盘事实（多空双方各一个硬数字）＋ 明日胜负手：某点位承接与量能条件，
  条件 A 就做 B，条件 C 就当脉冲」。不得出现「今日大概率怎么开」。
- weigh 写「今天是谁在买、谁在卖，明日谁决定方向」，末句仍是「所以判断是 X，不是 Y」。
- 第四段「中期时间轴与盘后关注」里的「盘后关注」要写明日/次周可验证的事件，不要把今天已收盘的事再说一遍。
""",
}


def system_prompt(slot):
    return SYSTEM + SLOT_OVERRIDES.get(slot, '')


TIER = (os.environ.get('LLM_TIER') or 'high').strip().lower()

# 各档位的候选模型：5.x 是「高质量档」，始终思考（思考链要吃掉上万 token 才动笔）；
# 4.x 是标准档，可关闭思考、速度快。降级链一律保留，避免 429 时直接失败。
TIER_MODELS = {
    # 5.3-flash 排第一位：它的 1797 万专属额度 2026-12-20 就过期，而 5.3 走通用池（仅 195 万）。
    # 实测两者质量只差 6%（points 1591 vs 1689）、耗时几乎一样（209s vs 221s），
    # 所以 5.3 已从候选里去掉——同样的等待时间，没必要去消耗那点宝贵的通用额度。
    'high': 'glm-5.3-flash,glm-4.7,glm-4.7-flash',
    'std': 'glm-4.7,glm-4.7-flash,glm-4-flash',
}


def max_tokens_for(model):
    """思考型模型必须先留够思考的额度，否则 content 为空、finish_reason=length。

    4.7 也从 8000 提到 12000：参考包式稿子有 10 条新闻全文 + 四段 300 字解读，
    8000 token 时 JSON 经常写到一半被截断，直接变成解析失败。
    """
    return 24000 if model.startswith('glm-5') else 12000


def llm_config():
    """有 LLM_API_KEY 就走真模型（OpenAI 兼容协议）；没有才退回 GitHub Models。

    默认通道是智谱 BigModel。LLM_TIER=high 走 glm-5.3（质量优先），
    LLM_TIER=std 走 glm-4.7（速度与成本优先）。模型会换代，所以候选写成串、逐个试。

    GitHub Models 在 Actions runner 上会被出网代理截成 text/plain "OK"，实测不可用，
    所以它只是「理论上存在」的兜底，真跑必须配 LLM_API_KEY。
    """
    key = (os.environ.get('LLM_API_KEY') or '').strip()
    if key:
        base = (os.environ.get('LLM_API_BASE')
                or 'https://open.bigmodel.cn/api/paas/v4/chat/completions').strip()
        default = TIER_MODELS.get(TIER, TIER_MODELS['high'])
        models = [m.strip() for m in (os.environ.get('LLM_MODELS') or default).split(',') if m.strip()]
        return key, base, models, 'zhipu'
    return TOKEN, MODEL_URL, MODELS, 'github-models'


def call_model(facts, slot, extra_note='', prefer_fast=False, force_models=None):
    key, url, models, kind = llm_config()
    if not key:
        return None, None, '没有可用的 LLM_API_KEY'
    if force_models:
        # 人工补跑 / 质量兜底用：跳过档位默认与「重写轮自动加速」，
        # 例如把收盘档强制交给 glm-4.7，避免 flash 降级稿直接上线。
        models = [m.strip() for m in str(force_models).split(',') if m.strip()]
    elif prefer_fast:
        # 重写轮用快速档：glm-5.x 单次就要 4 分钟，重写再来一次等于翻倍，
        # 而且实测 4.7 的篇幅只比 5.3 少约 5%，不值得为这 5% 多等 4 分钟
        fast = [m for m in models if not m.startswith('glm-5')]
        if fast:
            models = fast
    msgs = [
        {'role': 'system', 'content': system_prompt(slot)},
        {'role': 'user', 'content':
            '时段：%s\n\n事实包：\n%s\n\n%s请按结构输出 JSON。'
            % (slot, json.dumps(facts, ensure_ascii=False, indent=1),
               (extra_note + '\n\n') if extra_note else '')},
    ]
    print('[模型] 通道=%s 端点=%s 候选=%s' % (kind, url, ','.join(models)))
    is_zhipu = 'bigmodel.cn' in url
    RETRY_DELAYS = [0, 6, 20]
    for model in models:
        mt = max_tokens_for(model)
        body_obj = {'model': model, 'messages': msgs, 'temperature': 0.6,
                    'max_tokens': mt}
        if is_zhipu:
            # 智谱 4.5+ 默认边思考边回答：思考会占满 max_tokens 导致 content 为空，
            # 三报是结构化 JSON 输出，不需要思考链，直接关掉（实测 0.68s 出正文）。
            # 5.x 系列「始终思考」，传 disabled 或 low 都会报 1210，只能完全不传该字段。
            if not model.startswith('glm-5'):
                body_obj['thinking'] = {'type': 'disabled'}
        body = json.dumps(body_obj).encode()
        raw = b''
        err = ''
        is5 = model.startswith('glm-5')
        # 5.x 单次要 3.5 分钟，重试一次就等于多等 4 分钟，超时宁可直接降级到 4.x
        timeout = 240 if is5 else 120
        delays = [0] if is5 else RETRY_DELAYS
        for i, delay in enumerate(delays):
            if delay:
                print('[模型] %s 限流/故障，%ds 后重试（第 %d 次）' % (model, delay, i))
                time.sleep(delay)
            raw, ms, err = fetch(url, timeout=timeout, data=body, headers={
                'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
                'Accept': 'application/json'})
            if not err:
                break
            if not any(k in err for k in ('429', '500', '502', '503', '504', 'timed out')):
                break
        if err:
            print('[模型] %s 失败：%s %s' % (model, err, raw[:160].decode('utf-8', 'ignore')))
            continue
        try:
            j = json.loads(raw.decode('utf-8', 'ignore'))
            ch = j['choices'][0]
            msg = ch['message']
            finish = ch.get('finish_reason')
            txt = (msg.get('content') or '').strip()
            usage = j.get('usage') or {}
            rea = (usage.get('completion_tokens_details') or {}).get('reasoning_tokens')
            if finish == 'length' and not txt:
                # 思考型模型把额度全花在思考上，正文一个字没写——这是 val 失败，不是成功
                print('[模型] %s 思考吃满 %s tokens（reasoning %s），正文未开始，跳过'
                      % (model, usage.get('completion_tokens'), rea))
                continue
            if not txt and msg.get('reasoning_content'):
                # 部分思考型模型把正文放在 reasoning_content 里，content 为空
                txt = (msg.get('reasoning_content') or '').strip()
            print('[模型] %s 成功（%d ms，正文 %d 字，思考 %s tokens）'
                  % (model, ms, len(txt), rea if rea is not None else 0))
        except Exception as e:
            print('[模型] %s 解析失败：%s %s' % (model, e, raw[:160]))
            continue
        txt = re.sub(r'^```(?:json)?|```$', '', txt.strip(), flags=re.M).strip()
        try:
            return json.loads(txt), model, None
        except Exception:
            m = re.search(r'\{[\s\S]*\}', txt)
            if m:
                try:
                    return json.loads(m.group(0)), model, None
                except Exception as e:
                    print('[模型] %s 返回的 JSON 坏：%s' % (model, e))
    return None, None, '所有候选模型都失败'


# ---------------------------------------------------------------- 数字校验
NUM_RE = re.compile(r'-?\d+(?:\.\d+)?')
WHITELIST = {'1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12',
             '15', '20', '30', '60', '90', '2025', '2026', '0'}

# 指数名称里自带数字（标普500、沪深300…），不是数据，扫数字前先抹掉
INDEX_NAME_RE = re.compile(
    r'标普\s?500|标普\s?100|中证\s?A?500|中证\s?1000|中证\s?500|沪深\s?300|'
    r'上证\s?50|科创\s?50|北证\s?50|创业板\s?50|纳斯达克\s?100|道琼斯')


def collect_numbers(obj, bag):
    if isinstance(obj, dict):
        for v in obj.values():
            collect_numbers(v, bag)
    elif isinstance(obj, list):
        for v in obj:
            collect_numbers(v, bag)
    elif isinstance(obj, (int, float)) and not isinstance(obj, bool):
        bag.append(float(obj))


def allowed_values(facts):
    """把事实包里每个数字，展开成正文可能出现的各种写法（原值/取整/亿元/万亿元/绝对值）。

    注意：快讯的标题与摘要里也带数字（如「发行利率 4.821%」「沪银跌 7.46%」），
    这些是抓来的真实数据，正文引用它们不算编造，所以必须一并纳入允许集，
    否则会误判成「无出处」把好稿拦下来。
    """
    nums, texts = [], []

    def walk(o):
        if isinstance(o, bool):
            return
        if isinstance(o, dict):
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
        elif isinstance(o, (int, float)):
            nums.append(float(o))
        elif isinstance(o, str):
            texts.append(o)

    walk(facts)

    vals = set()
    for v in nums:
        for x in (v, -v, abs(v), v / 1e8, v / 1e12, v / 1e4):
            for d in (0, 1, 2):
                try:
                    vals.add(round(float(x), d))
                except Exception:
                    pass
    for t in texts:
        for s in NUM_RE.findall(t):
            try:
                fv = float(s)
            except Exception:
                continue
            for x in (fv, -fv, abs(fv)):
                for d in (0, 1, 2):
                    vals.add(round(x, d))
    return vals


def unmatched_numbers(content, facts):
    vals = allowed_values(facts)
    text = INDEX_NAME_RE.sub('指数', json.dumps(content, ensure_ascii=False))
    bad = []
    for m in NUM_RE.finditer(text):
        s = m.group(0)
        if s in WHITELIST:
            continue
        try:
            v = float(s)
        except Exception:
            continue
        # 整十且 ≥1000 的整数只可能是「整数关口/目标位/情景区间端点」
        # （3500 点、3480—3580、6000 亿），不是测量值，放行避免误杀。
        # 2026-11-23 试跑：3480/3450/3550 这种情景端点被判无出处，
        # 差点把 1700 字的好稿整篇退回模板。
        if abs(v) >= 1000 and abs(v) % 10 == 0:
            continue
        # 年份不是行情数据。参考包式稿子必然写 2027Q1、2030 年展望，
        # 这些年份在事实包里未必出现，不能因此把整篇好稿毙掉。
        if 2020 <= v <= 2035 and float(v).is_integer():
            continue
        ok = any(abs(v - x) <= max(0.02, abs(x) * 0.002) for x in vals)
        if not ok:
            bad.append(s)
    # 去重保序
    seen, out = set(), []
    for b in bad:
        if b not in seen:
            seen.add(b)
            out.append(b)
    return out


# ---------------------------------------------------------------- 形状归一化

NEWS_DEFAULTS = {'t': '', 'd': '', 'long': '', 'dir': '中性', 'lvl': '一般', 'sec': ''}


def normalize_content(c):
    """把模型输出捏成前端一定能吃的形状。只修格式，不改任何事实与数字。"""
    if not isinstance(c, dict):
        return c

    w = c.get('watch')
    if isinstance(w, list):
        parts = [str(x).strip().rstrip('。；;') for x in w if str(x).strip()]
        c['watch'] = ('；'.join(parts) + '。') if parts else ''
    elif w is not None:
        c['watch'] = str(w).strip()

    for k in ('bulls', 'bears'):
        v = c.get(k)
        if isinstance(v, str):
            c[k] = [x.strip() for x in re.split(r'[；;\n]', v) if x.strip()]
        elif isinstance(v, list):
            c[k] = [str(x).strip() for x in v if str(x).strip()]
        else:
            c[k] = []

    p = c.get('points')
    if isinstance(p, str):
        c['points'] = [x.strip() for x in re.split(r'\n+', p) if x.strip()]
    elif isinstance(p, list):
        c['points'] = [str(x).strip() for x in p if str(x).strip()]
    else:
        c['points'] = []

    n = c.get('news') or []
    items = []
    for x in n if isinstance(n, list) else []:
        if not isinstance(x, dict):
            continue
        for k, dv in NEWS_DEFAULTS.items():
            if not x.get(k):
                x[k] = dv
        items.append(x)
    c['news'] = items

    if c.get('verdict') not in ('偏积极', '偏消极', '中性'):
        c['verdict'] = '中性'
    return c


# ---------------------------------------------------------------- 模板兜底
def template_report(facts, slot, diag):
    """模型不可用或多次校验不过时，用数据本身拼一份不撒谎的简版。"""
    q = facts['quotes']
    sh = q.get('sh000001') or {}
    pct = sh.get('pct')
    verdict = '偏消极' if (pct or 0) <= -0.8 else ('偏积极' if (pct or 0) >= 0.8 else '中性')
    up = (facts['breadth'] or {}).get('up')
    dn = (facts['breadth'] or {}).get('down')
    turn = facts['turnover']
    top = facts['sectors_top'][:3]
    line = '整体判断：%s（上证 %s，%+.2f%%）。上涨 %s 家、下跌 %s 家，两市成交 %s 亿。结论：等方向确认再动手。' % (
        verdict, sh.get('price'), pct or 0, up, dn, turn)
    return {
        'verdict': verdict,
        'oneLine': line,
        'bulls': ['%s 涨 %.2f%%' % (x['n'], x['pct']) for x in top] or ['数据不足'],
        'bears': ['下跌家数 %s 家' % dn, '上证 %+.2f%%' % (pct or 0)],
        'weigh': '以指数与涨跌家数为准，板块只作强度参考。',
        'points': [
            '【一、指数位置】上证 %s，%+.2f%%，昨收 %s。' % (sh.get('price'), pct or 0, sh.get('prev')),
            '【二、市场宽度】上涨 %s 家、下跌 %s 家，涨停 %s 家、跌停 %s 家。' % (
                up, dn, (facts['breadth'] or {}).get('limit_up'), (facts['breadth'] or {}).get('limit_down')),
            '【三、资金】两市成交 %s 亿元。' % turn,
            '【四、结构】涨幅居前：%s。' % '、'.join('%s %.2f%%' % (x['n'], x['pct']) for x in top),
        ],
        'news': [{'t': n['t'], 'd': n['sum'][:60], 'long': n['sum'][:160],
                  'dir': '中性', 'lvl': '一般', 'sec': '待定'} for n in facts['news'][:5]],
        'watch': '关注上方 %s 与下方 %s（上证 20 日区间）。（模板生成，未经模型润色）' % (
            sh.get('price'), sh.get('prev')),
    }


# ---------------------------------------------------------------- 合并与推送
def api(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={
        'Authorization': 'Bearer ' + TOKEN, 'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json',
        'User-Agent': 'san-tai-report'})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, {'error': (e.read() or b'').decode('utf-8', 'ignore')[:300]}


def read_remote(path, branch=None):
    st, j = api('GET', '/repos/%s/contents/%s?ref=%s' % (REPO, path, branch or BRANCH))
    if st != 200:
        return None, None, j.get('error', '')
    try:
        return base64.b64decode(j['content']), j.get('sha'), ''
    except Exception as e:
        return None, None, str(e)


def parse_daily(text):
    i, j = text.find('{'), text.rfind('}')
    if i < 0 or j < 0:
        return None
    try:
        return json.loads(text[i:j + 1])
    except Exception:
        return None


def write_remote(path, content_bytes, message, branch=None):
    """写文件到仓库。data 分支同时有 build.yml 在推，sha 可能过期（409），重试三次。"""
    br = branch or BRANCH
    st2, err = 0, ''
    for attempt in range(3):
        st, cur = api('GET', '/repos/%s/contents/%s?ref=%s' % (REPO, path, br))
        payload = {'message': message, 'branch': br,
                   'content': base64.b64encode(content_bytes).decode()}
        if st == 200 and cur.get('sha'):
            payload['sha'] = cur['sha']
        st2, res = api('PUT', '/repos/%s/contents/%s' % (REPO, path), payload)
        if st2 in (200, 201):
            return True, st2, ''
        err = str(res.get('error', ''))[:200]
        time.sleep(2 + attempt * 2)
    return False, st2, err


# ---------------------------------------------------------------- 风格门禁
def style_issues(c, slot='morning'):
    """参考包最在意的是「有因果、有来源、有中期视角」，这里把它变成可判定的条件。"""
    issues = []
    pts = [str(x) for x in (c.get('points') or [])]
    if len(pts) < 4:
        issues.append('points 只有 %d 段（要 4 段）' % len(pts))
    for i, p in enumerate(pts):
        if len(p) < 220:
            issues.append('第 %d 段只有 %d 字，太短' % (i + 1, len(p)))
    news = c.get('news') or []
    if len(news) < 8:
        issues.append('news 只有 %d 条（要 10 条上下）' % len(news))
    short = [i + 1 for i, n in enumerate(news) if len(str(n.get('long') or '')) < 90]
    if short:
        issues.append('新闻 %s 的展开不足 90 字' % short[:5])
    text = json.dumps(c, ensure_ascii=False)
    n_cliche = text.count('传导至')
    if n_cliche > 4:
        issues.append('「传导至」出现 %d 次，套话堆砌' % n_cliche)
    src_hits = sum(1 for k in ('金十', '财联社', '新浪7x24', '华尔街见闻', '东财7x24') if k in text)
    if src_hits < 3:
        issues.append('只点名了 %d 个资讯来源（要至少 3 个）' % src_hits)
    if pts:
        last = pts[-1]
        if not all(k in last for k in ('乐观', '中性', '悲观')):
            issues.append('第四段缺三情景（乐观/中性/悲观）')
        if not any(k in last for k in ('历史参照', '2017', '2021', '上轮', '上一轮')):
            issues.append('第四段缺中期预测表的历史参照')
        if not any(k in last for k in ('12月', '12 月', '次年', '1–3月', '1-3月')):
            issues.append('第四段缺四阶段时间轴（12月/次年1-3月）')
    one = str(c.get('oneLine') or '')
    # 代码会在 normalize 后追加「数据截至 ...」约 25 字，门禁在追加前跑，
    # 收盘稿带「胜负手 + 条件A/条件C」时按 130 字判，避免误报。
    need = 130 if (slot == 'close' and '胜负手' in one
                   and ('条件A' in one or '条件 A' in one)) else 150
    if len(one) < need or not any(k in one for k in ('胜负手', '关键', '如果', '若', '站稳', '跌破')):
        issues.append('一句话太短或没有胜负手条件句')
    # 收盘/午间最致命的错：把盘前预测句式套到已收盘的复盘里。
    if slot == 'close':
        morning_words = ('今天怎么开', '今日怎么开', '今日大概率', '今天大概率',
                         '大概率平开', '大概率高开', '大概率低开', '开盘后需观察',
                         '若直接低开', '作用于开盘', '决定今日开盘')
        if any(k in json.dumps(pts, ensure_ascii=False) for k in morning_words):
            issues.append('收盘复盘仍在用盘前「怎么开/大概率平开」句式')
        if any(k in one for k in morning_words):
            issues.append('收盘一句话仍在预测今日开盘')
        if pts and '今天怎么收' not in pts[0] and '今日收盘' not in pts[0] and '收盘复盘' not in pts[0]:
            issues.append('收盘复盘第一段没有明确「今天怎么收」')
    elif slot == 'noon':
        if any(k in one for k in ('今天怎么开', '今日大概率', '大概率平开')):
            issues.append('午间速览一句话仍在预测今日开盘')
    return issues


# ---------------------------------------------------------------- 滚动观点
# 参考包里最有价值的不是某一期的文字，而是「中期预测表 + 时间轴」逐日滚动修订。
# 客户页不新增栏目，所以把这两块的精华压缩进 report_state.json，
# 作为下一天的「昨日滚动观点」喂回提示词，让主线/时间节点连续，而不是每天从零开始。
def read_rolling(slot):
    raw, sha, err = read_remote('report_state.json')
    if not raw:
        return {}
    try:
        st = json.loads(raw.decode('utf-8'))
    except Exception:
        return {}
    one = st.get(slot) or {}
    pts = one.get('points') or []
    out = {'date': st.get('date', ''), '判断': (one.get('oneLine') or '')[:180]}
    if len(pts) >= 2:
        out['主线分层'] = pts[1][:260]
    if len(pts) >= 4:
        out['时间轴三情景'] = pts[3][:320]
    out['关注'] = (one.get('watch') or '')[:220]
    return {k: v for k, v in out.items() if v}


def make_rolling_state(old_state, slot, content, today):
    """只留压缩后的滚动字段，避免 state 文件无限膨胀。"""
    try:
        st = json.loads(old_state.decode('utf-8')) if old_state else {}
    except Exception:
        st = {}
    if st.get('date') != today:
        st = {'date': today}
    st[slot] = {
        'verdict': content.get('verdict'),
        'oneLine': (content.get('oneLine') or '')[:400],
        'points': [(p or '')[:500] for p in (content.get('points') or [])],
        'watch': (content.get('watch') or '')[:500],
    }
    return st


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--slot', default='morning', choices=['morning', 'noon', 'close'])
    ap.add_argument('--dry-run', action='store_true', help='只生成，不推送')
    ap.add_argument('--no-push', action='store_true')
    ap.add_argument('--allow-template', action='store_true',
                    help='允许模板兜底稿发布（默认禁止：模型不可用时宁可不更新，也不拿低质量稿覆盖线上）')
    ap.add_argument('--out', default='daily.generated.js')
    args = ap.parse_args()

    bj = time.gmtime(time.time() + 8 * 3600)
    today = time.strftime('%Y-%m-%d', bj)
    hhmm = time.strftime('%H:%M', bj)

    facts_raw, diag = build_facts(args.slot)
    # 滚动观点：昨天同一时段的主线分层与时间轴三情景，作为今天的修订起点
    try:
        rolling = read_rolling(args.slot)
    except Exception as e:
        rolling = {}
        print('[滚动] 读取昨日观点失败：%s' % e)
    if rolling:
        diag['steps'].append({'name': '昨日滚动观点', 'ok': True,
                              'note': 'date=%s' % rolling.get('date', '')})
    facts_raw['rolling'] = rolling
    facts = compact_facts(facts_raw, args.slot)

    content, model, verr = call_model(facts, args.slot)
    unverified = []
    issues = []
    if content:
        unverified = unmatched_numbers(content, facts)
        # 篇幅门禁：points 四段合计不足 800 字基本就是模型偷懒（实测弱模型只写 230 字），
        # 这种稿子发出去还不如不发，先让它重写一次
        thin = sum(len(p) for p in (content.get('points') or [])) < 800
        issues = style_issues(content, args.slot)
        # 只有「明显有问题」才重写：1–3 个未命中数字多数是「整数关口/目标位」这类合理表述，
        # 为它们重写一次要多花 4 分钟（5.x）并可能降级，不值得
        if len(unverified) > 3 or thin or issues:
            note = []
            if unverified:
                note.append('上一版有这些数字在事实包里找不到，必须删掉或换成包内的数字：%s'
                            % ', '.join(unverified[:20]))
            if thin:
                note.append('上一版 points 四段合计不足 800 字，太短了。必须每段 250–400 字，'
                            '用「第一…第二…第三…」串因果链，每段至少 4 个精确数字，写满。')
            if issues:
                note.append('上一版写作不合格：%s。请按提示词重写，尤其是四段结构、'
                            '主线分两层、新闻点名来源、第四段中期时间轴三情景。'
                            % '；'.join(issues[:8]))
            print('[校验] 需要重写：无出处数字 %d 个；points 合计 %d 字；风格问题 %d 项'
                  % (len(unverified), sum(len(p) for p in (content.get('points') or [])), len(issues)))
            content2, model2, _ = call_model(facts, args.slot, '；'.join(note), prefer_fast=True)
            if content2:
                u2 = unmatched_numbers(content2, facts)
                t2 = sum(len(p) for p in (content2.get('points') or []))
                t1 = sum(len(p) for p in (content.get('points') or []))
                i2 = style_issues(content2, args.slot)
                # 重写轮用快速档，篇幅可能短一点（实测 4.7 比 5.3 少约 5%），
                # 只要没短过 70%、数字更干净、风格问题不更多就采用，否则会白白退回模板稿
                ok2 = (len(u2) <= len(unverified) and t2 >= t1 * 0.7 and len(i2) <= len(issues))
                if ok2:
                    content, model, unverified, issues = content2, model2, u2, i2
                    print('[校验] 重写后：剩 %d 个无出处数字，points %d 字，风格问题 %d 项'
                          % (len(u2), t2, len(i2)))
                else:
                    print('[校验] 重写稿未采用：数字 %d→%d 字数 %d→%d 风格 %d→%d'
                          % (len(unverified), len(u2), t1, t2, len(issues), len(i2)))
            # 2026-11-24 收盘档事故：5.3 超时、4.7 首版 JSON 坏，落到 flash 后风格问题 4 项
            # 却被「问题数不增加」的规则放过。flash 只配当救急，不能在风格不过关时直接上线。
            if model and model.endswith('flash') and issues:
                note3 = '；'.join(note + ['上一版由 flash 生成且风格不过关，这次必须按时段写，收盘稿禁止盘前预测句式。'])
                content3, model3, _ = call_model(facts, args.slot, note3, force_models='glm-4.7')
                if content3:
                    u3 = unmatched_numbers(content3, facts)
                    t3 = sum(len(p) for p in (content3.get('points') or []))
                    i3 = style_issues(content3, args.slot)
                    if len(u3) <= len(unverified) + 3 and t3 >= t1 * 0.7 and len(i3) <= len(issues) + 1:
                        content, model, unverified, issues = content3, model3, u3, i3
                        print('[校验] flash 降级稿已由 glm-4.7 替换：剩 %d 个无出处数字，'
                              'points %d 字，风格问题 %d 项' % (len(u3), t3, len(i3)))
                    else:
                        print('[校验] glm-4.7 补写未采用：数字 %d→%d 字数 %d→%d 风格 %d→%d'
                              % (len(unverified), len(u3), t1, t3, len(issues), len(i3)))
    # 血泪教训（2026-11-23 试跑）：模型稿 points 1722 字、风格门禁全过，
    # 只因 4 个数未在事实包里命中就被整篇换成模板稿——模板稿全是 None，
    # 比原文差几个档次。少量未溯源数字应留在 meta 里告警，不该毁掉整篇。
    if not content or len(unverified) > 12:
        print('[兜底] 模型不可用或数字仍不可溯源（%d 个），改用模板生成。原因：%s'
              % (len(unverified), verr or '有数字在事实包里找不到出处'))
        content = template_report(facts_raw, args.slot, diag)
        model = 'template-fallback'
        unverified = []
    elif unverified:
        print('[告警] 保留模型稿，但仍有 %d 个数字未在事实包命中：%s'
              % (len(unverified), ', '.join(unverified[:20])))

    content = normalize_content(content)
    content['at'] = hhmm
    # 参考包每期一句话末尾都标数据截止时间。由代码补写，避免模型写错时间。
    stamp = '数据截至 %s %s。' % (today, hhmm)
    if stamp not in (content.get('oneLine') or ''):
        content['oneLine'] = (content.get('oneLine') or '').rstrip() + stamp
    payload = {'date': today, 'slot': args.slot, 'report': content,
               'diagnostics': diag, 'model': model, 'unverified': unverified,
               'style_issues': issues, 'generated_at': '%s %s' % (today, hhmm)}

    # 读取旧 daily.js 并合并
    old_bytes, sha, rerr = read_remote('daily.js')
    old = parse_daily(old_bytes.decode('utf-8', 'ignore')) if old_bytes else None
    if not old or old.get('date') != today:
        old = {'date': today, 'risk': RISK, 'morning': {}, 'noon': {}, 'close': {}}
    old[args.slot] = content
    old['risk'] = RISK
    js = 'window.AB_DAILY = ' + json.dumps(old, ensure_ascii=False, indent=1) + ';\n'

    with open(args.out, 'w', encoding='utf-8') as f:
        f.write(js)
    with open('report-meta.json', 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    print('[生成] slot=%s date=%s at=%s model=%s 长度=%d 字节'
          % (args.slot, today, hhmm, model, len(js)))
    print('[质量] 利多 %d / 利空 %d / 要点 %d / 新闻 %d'
          % (len(content.get('bulls') or []), len(content.get('bears') or []),
             len(content.get('points') or []), len(content.get('news') or [])))
    print('[诊断] ' + json.dumps(diag['steps'], ensure_ascii=False))

    if args.dry_run or args.no_push or not TOKEN:
        print('[跳过] 未推送（dry-run / no-push / 无 token）')
        return 0

    if model == 'template-fallback' and not args.allow_template:
        print('[拦下] 本次是模板兜底稿，质量不足以覆盖线上，已放弃推送。'
              '（确认要发可加 --allow-template）')
        return 0

    ok, st, err = write_remote('daily.js', js.encode('utf-8'),
                               'report(%s): %s %s via %s' % (args.slot, today, hhmm, model))
    print('[推送] daily.js -> %s %s' % ('OK' if ok else 'FAIL(%s)' % st, err))
    if ok:
        write_remote('report-meta.json', json.dumps(payload, ensure_ascii=False, indent=1).encode(),
                     'report(%s): meta %s' % (args.slot, today))
        # 滚动观点只在正文真正上线后才更新，避免失败稿污染下一天
        old_state_raw, _, _ = read_remote('report_state.json')
        st_state = make_rolling_state(old_state_raw, args.slot, content, today)
        sok, _, serr = write_remote('report_state.json',
                                    json.dumps(st_state, ensure_ascii=False, indent=1).encode(),
                                    'report(%s): rolling state %s' % (args.slot, today))
        print('[推送] report_state.json -> %s %s' % ('OK' if sok else 'FAIL(%s)' % serr, serr))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
