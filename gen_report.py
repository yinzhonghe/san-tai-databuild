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
    step('沪深成交额', spot is not None, serr or ('%.0f 亿' % (spot or 0)))

    breadth, berr = grab_breadth()
    step('涨跌家数(全市场)', breadth, berr or ('%s 家' % (breadth or {}).get('total')))

    top, bottom = grab_sectors()
    step('行业板块', top, '%d 个' % len(top))

    news = grab_news()
    step('东财7x24快讯', news, '%d 条' % len(news))

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
        '快讯': [{'时间': n['time'][-5:], '标题': n['t'], '摘要': n['sum'][:110]}
                 for n in f['news'][:40]],
        '注意': '以上是本次能抓到的全部数据。正文禁止出现本包里没有的数字；'
                '美债收益率等未提供项不要提及。',
    }
    return out


# ---------------------------------------------------------------- 写作提示
SYSTEM = """你是 A 股盘面分析师，为一个给客户看的看盘网站写「三报」（早报/午间速览/收盘复盘）。
读者是自己做决策的散户，要的是能落地的判断，不是复述新闻。

【硬规则】
1. 只使用用户消息里「事实包」提供的数字。禁止任何数据包里没有的数字、点位、涨跌幅、金额。
   没有的品种（比如美债收益率）直接不提，不要写「数据缺失」「暂无」。
2. 禁止模糊词替代数字：「大幅下跌」「明显放量」「普遍走弱」这类一律不许单独出现，必须带数字。
3. 判断要有方向、有条件：说清楚「什么情况下成立、什么情况下不成立」，不要两头都说。
4. 只输出 JSON，不要 markdown 代码块，不要任何解释文字。

【输出结构】
{
 "verdict": "偏积极|偏消极|中性",
 "oneLine": "整体判断：…（守…，等…）。…。结论：…",
 "bulls": ["带数字的多头理由", …3-6条],
 "bears": ["带数字的空头理由", …3-6条],
 "weigh": "哪一侧作用于开盘价/当日走势，哪一侧决定跌不深，一句话讲清权重",
 "points": ["【一、判断式小标题】正文…", "【二、…】…", "【三、…】…", "【四、…】…"],
 "news": [{"t":"标题","d":"一句话","long":"2-3句展开，含数字","dir":"积极|消极|中性","lvl":"重要|中等|一般","sec":"影响板块"}],
 "watch": "今日关注：点位+数字+时间点，2-4 句"
}

【各段的写法】
- points 必须四段，每段以【一、…】到【四、…】开头，段内用「第一…第二…」串因果链，全文合计不少于 12 个精确数字。
- oneLine 用一句有画面感的话给结论，必须包含一个可验证的位（点位或涨跌幅）与一个触发条件。
- news 5-8 条，来自事实包里的「快讯」，选对明日/当日交易真有影响的，按重要性排序。
- verdict 只能取三个值之一，与 bulls/bears 的强弱一致，不要写「谨慎乐观」这种自造词。
"""


def call_model(facts, slot, extra_note=''):
    msgs = [
        {'role': 'system', 'content': SYSTEM},
        {'role': 'user', 'content':
            '时段：%s\n\n事实包：\n%s\n\n%s请按结构输出 JSON。'
            % (slot, json.dumps(facts, ensure_ascii=False, indent=1),
               (extra_note + '\n\n') if extra_note else '')},
    ]
    payload = json.dumps({'model': None, 'messages': msgs, 'temperature': 0.6,
                          'max_tokens': 3500}).encode()
    last = ''
    for model in MODELS:
        if not model:
            continue
        body = json.loads(payload.decode())
        body['model'] = model
        data = json.dumps(body).encode()
        raw, ms, err = fetch(MODEL_URL, timeout=90, data=data, headers={
            'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json',
            'Accept': 'application/json'})
        if err:
            last = '%s -> %s %s' % (model, err, raw[:200].decode('utf-8', 'ignore'))
            print('[模型] %s 失败：%s' % (model, last))
            continue
        try:
            j = json.loads(raw.decode('utf-8', 'ignore'))
            txt = j['choices'][0]['message']['content']
            print('[模型] %s 成功（%d ms）' % (model, ms))
        except Exception as e:
            last = '%s -> 解析失败 %s %s' % (model, e, raw[:200])
            print('[模型] %s 解析失败：%s' % (model, last))
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
                    last = '%s -> JSON 坏 %s' % (model, e)
            else:
                last = '%s -> 没有 JSON' % model
    return None, None, last


# ---------------------------------------------------------------- 数字校验
NUM_RE = re.compile(r'-?\d+(?:\.\d+)?')
WHITELIST = {'1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12',
             '15', '20', '30', '60', '90', '2025', '2026', '0'}


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
    """把事实包里每个数字，展开成正文可能出现的各种写法（原值/取整/亿元/万亿元/绝对值）。"""
    bag = []
    collect_numbers({k: v for k, v in facts.items() if k != '快讯'}, bag)
    vals = set()
    for v in bag:
        for x in (v, -v, abs(v), v / 1e8, v / 1e12, v / 1e4):
            for d in (0, 1, 2):
                try:
                    vals.add(round(float(x), d))
                except Exception:
                    pass
    return vals


def unmatched_numbers(content, facts):
    vals = allowed_values(facts)
    text = json.dumps(content, ensure_ascii=False)
    bad = []
    for m in NUM_RE.finditer(text):
        s = m.group(0)
        if s in WHITELIST:
            continue
        try:
            v = float(s)
        except Exception:
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



def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--slot', default='morning', choices=['morning', 'noon', 'close'])
    ap.add_argument('--dry-run', action='store_true', help='只生成，不推送')
    ap.add_argument('--no-push', action='store_true')
    ap.add_argument('--out', default='daily.generated.js')
    args = ap.parse_args()

    bj = time.gmtime(time.time() + 8 * 3600)
    today = time.strftime('%Y-%m-%d', bj)
    hhmm = time.strftime('%H:%M', bj)

    facts_raw, diag = build_facts(args.slot)
    facts = compact_facts(facts_raw, args.slot)

    content, model, verr = call_model(facts, args.slot)
    unverified = []
    if content:
        unverified = unmatched_numbers(content, facts)
        if unverified:
            print('[校验] 首次发现 %d 个无出处数字：%s' % (len(unverified), ', '.join(unverified[:12])))
            content2, model2, _ = call_model(
                facts, args.slot,
                '上一版有这些数字在事实包里找不到，必须删掉或换成包内的数字：%s' % ', '.join(unverified[:20]))
            if content2:
                u2 = unmatched_numbers(content2, facts)
                if len(u2) <= len(unverified):
                    content, model, unverified = content2, model2, u2
                    print('[校验] 重写后剩 %d 个：%s' % (len(u2), ', '.join(u2[:12])))
    if not content or len(unverified) > 3:
        print('[兜底] 模型不可用或数字仍不可溯源（%d 个），改用模板生成' % len(unverified))
        content = template_report(facts_raw, args.slot, diag)
        model = 'template-fallback'
        unverified = []

    content['at'] = hhmm
    payload = {'date': today, 'slot': args.slot, 'report': content,
               'diagnostics': diag, 'model': model, 'unverified': unverified,
               'generated_at': '%s %s' % (today, hhmm)}

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

    ok, st, err = write_remote('daily.js', js.encode('utf-8'),
                               'report(%s): %s %s via %s' % (args.slot, today, hhmm, model))
    print('[推送] daily.js -> %s %s' % ('OK' if ok else 'FAIL(%s)' % st, err))
    if ok:
        write_remote('report-meta.json', json.dumps(payload, ensure_ascii=False, indent=1).encode(),
                     'report(%s): meta %s' % (args.slot, today))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
