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
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

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
    s = TAG_RE.sub('', str(s or ''))
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

    # 多源全文快讯：东财标题 + 新浪/金十/见闻全文，按信息量挑 48 条
    pools = [('东财', news_em)]
    for name, fn in (('新浪7x24', grab_sina_flash), ('金十数据', grab_jin10_flash),
                     ('华尔街见闻', grab_wscn_flash)):
        try:
            rows, e = fn()
            step(name + '快讯', rows, e or ('%d 条' % len(rows)))
            pools.append((name, rows))
        except Exception as e:
            step(name + '快讯', False, str(e)[:80])
    news = curate_news(pools, 48)
    step('多源快讯汇总', news, '%d 条（已按信息量筛选）' % len(news))

    diag['missing'].append('美债10年期收益率（东财/新浪公开接口均无返回，已从正文剔除）')

    return {'quotes': q, 'futures': fut, 'usd': usd, 'turnover': spot,
            'breadth': breadth, 'sectors_top': top, 'sectors_bottom': bottom,
            'news': news}, diag


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
        # 全文 + 来源：参考包的高质量稿每条新闻都点名来源、带完整数字，
        # 砍成 160 字标题摘要只会逼出「XX 传导至 XX」的套话。
        '快讯': [{'时间': hhmm_of(n['time']), '来源': n.get('src') or '东财7x24',
                   '标题': n['t'], '全文': n['sum'][:400]}
                  for n in f['news'][:48]],
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
6. 只输出 JSON，不要 markdown 代码块，不要解释文字。

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
- 第四段「中期时间轴与盘后关注」：先给未来 1–3 个月的关键日期节点（从快讯里找真实日期，
  如 FOMC、PCE、会议、财报、政策生效日），再给三情景区间（乐观/中性/悲观，各带点位区间与触发条件），
  最后列今日盘后到明晨要盯的 3–5 件事。这一段就是参考包的「大盘时间轴推演」。

【滚动要求】
事实包里的「昨日滚动观点」是昨天同一时段的判断。把其中的主线、时间节点、三情景
拿出来对照今天的新事实：变了就改写并说明变化，没变可以保留但必须补充今天的新数据。
不要整段照抄，也不要当成不存在。

【其余字段】
- oneLine 90–150 字：整体判断（守什么、等什么）+ 对立方阵 + 条件→行动。
- bulls / bears 各 4–6 条，每条 40–70 字，「事实（带数字、带来源或机构）+ 传导路径」。
- weigh 120–200 字：先说谁决定开盘，再说谁决定跌不深，末句「所以判断是 X，不是 Y」。
- news 10–11 条（不足就按实际条数），long 100–160 字：发生了什么 + 关键数字 + 对板块的影响，
  点名来源；不要 5 条就交差。
- watch 4–5 条，每条带具体日期/时间点与可验证数字，不要一句话打包。
- verdict 只能取三个值之一，与整体强弱一致。
"""


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
    """思考型模型必须先留够思考的额度，否则 content 为空、finish_reason=length。"""
    return 24000 if model.startswith('glm-5') else 8000


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


def call_model(facts, slot, extra_note='', prefer_fast=False):
    key, url, models, kind = llm_config()
    if not key:
        return None, None, '没有可用的 LLM_API_KEY'
    if prefer_fast:
        # 重写轮用快速档：glm-5.x 单次就要 4 分钟，重写再来一次等于翻倍，
        # 而且实测 4.7 的篇幅只比 5.3 少约 5%，不值得为这 5% 多等 4 分钟
        fast = [m for m in models if not m.startswith('glm-5')]
        if fast:
            models = fast
    msgs = [
        {'role': 'system', 'content': SYSTEM},
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
        # 整百且 ≥1000 的整数只可能是「整数关口/目标位/条件位」（3500 点、6000 亿），
        # 不是测量值，任何一只票的真实数据都不会恰好是整百，所以放行，避免误杀。
        if abs(v) >= 1000 and abs(v) % 100 == 0:
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
def style_issues(c):
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
    if pts and not any(k in pts[-1] for k in ('情景', '时间轴', 'FOMC', 'PCE', '中央经济', '会议')):
        issues.append('第四段缺中期时间轴 / 三情景')
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
        issues = style_issues(content)
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
                i2 = style_issues(content2)
                # 重写轮用快速档，篇幅可能短一点（实测 4.7 比 5.3 少约 5%），
                # 只要没短过 70%、数字更干净、风格问题不更多就采用，否则会白白退回模板稿
                if (len(u2) <= len(unverified) and t2 >= t1 * 0.7 and len(i2) <= len(issues)):
                    content, model, unverified, issues = content2, model2, u2, i2
                    print('[校验] 重写后：剩 %d 个无出处数字，points %d 字，风格问题 %d 项'
                          % (len(u2), t2, len(i2)))
    if not content or len(unverified) > 3:
        print('[兜底] 模型不可用或数字仍不可溯源（%d 个），改用模板生成。原因：%s'
              % (len(unverified), verr or '有数字在事实包里找不到出处'))
        content = template_report(facts_raw, args.slot, diag)
        model = 'template-fallback'
        unverified = []

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
