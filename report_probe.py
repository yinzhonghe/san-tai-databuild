# -*- coding: utf-8 -*-
"""三报数据探针（只读）

目的：在 GitHub runner 真实环境里确认三件事
  1. 早报需要的各类行情，哪些能拿到、延迟多少、数值对不对
  2. 东财 7x24 快讯能否作为新闻源
  3. GitHub Models 能否用内置 GITHUB_TOKEN 免 key 调用（决定三报要不要另买 LLM key）

只写 report-probe-result.json，不碰 data.js / build-* 任何生产文件。
"""
import json
import os
import platform
import re
import time
import urllib.error
import urllib.request

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

CASES = [
    ('A股指数-腾讯', '上证/深成/创业板/科创50',
     'https://qt.gtimg.cn/q=sh000001,sz399001,sz399006,sh000688', None),
    ('美股指数-腾讯', '道指/纳指/标普',
     'https://qt.gtimg.cn/q=usDJI,usIXIC,usINX', None),
    ('港股-腾讯', '恒指/恒生科技',
     'https://qt.gtimg.cn/q=hkHSI,hkHSTECH', None),
    ('外盘期货-新浪', 'A50/原油/黄金/白银/伦铜',
     'https://hq.sinajs.cn/list=hf_CHA50CFD,hf_CL,hf_GC,hf_SI,hf_CAD',
     'https://finance.sina.com.cn'),
    ('美元指数-东财', '100.UDI',
     'https://push2.eastmoney.com/api/qt/stock/get?secid=100.UDI&fields=f43,f57,f58,f170', None),
    ('美债10Y-东财', '100.UST10Y（预期拿不到，用于确认缺口）',
     'https://push2.eastmoney.com/api/qt/stock/get?secid=100.UST10Y&fields=f43,f57,f58', None),
    ('上证日K-腾讯', '60 根，算关键位/均线',
     'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,60,qfq', None),
    ('美股日K-腾讯', '道指 10 根',
     'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=usDJI,day,,,10,qfq', None),
    ('东财全市场清单', 'total，用来算涨跌停',
     'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f3'
     '&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f2,f3,f12,f14', None),
    ('东财7x24快讯', '新闻源候选',
     'https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724'
     '&fastColumn=102&sortEnd=&pageSize=10&req_trace=' + str(int(time.time() * 1000)), None),
    ('东财板块涨幅', '板块排名',
     'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=10&po=1&np=1&fltt=2&invt=2&fid=f3'
     '&fs=m:90+t:2&fields=f3,f12,f14', None),
]

MODEL_ENDPOINTS = [
    ('models.github.ai', 'https://models.github.ai/inference/chat/completions'),
    ('models.inference.ai.azure.com', 'https://models.inference.ai.azure.com/chat/completions'),
]


def http_get(url, referer=None, timeout=25):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    if referer:
        req.add_header('Referer', referer)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            return True, r.status, int((time.time() - t0) * 1000), body, ''
    except urllib.error.HTTPError as e:
        return False, e.code, int((time.time() - t0) * 1000), (e.read() or b'')[:400], 'HTTP %s' % e.code
    except Exception as e:
        return False, 0, int((time.time() - t0) * 1000), b'', '%s: %s' % (type(e).__name__, e)


def tencent(text, code):
    m = re.search(r'v_%s="([^"]*)"' % re.escape(code), text)
    return m.group(1).split('~') if m else []


def kline(text, code):
    """腾讯 K 线返回标准 JSON；qfq 参数下 key 可能是 qfqday。"""
    try:
        j = json.loads(text)
        d = (j.get('data') or {}).get(code) or {}
        for k in ('qfqday', 'day', 'hfqday'):
            if d.get(k):
                return d[k]
    except Exception:
        pass
    return []


def hint(key, text):
    """光有 200 不算通过，要能从返回里抠出一个能自证的数字。"""
    try:
        if key == 'A股指数-腾讯':
            out = []
            for code in ('sh000001', 'sz399001', 'sz399006', 'sh000688'):
                f = tencent(text, code)
                if len(f) > 4:
                    out.append('%s %s (%s)' % (f[1], f[3], f[4]))
            return ' | '.join(out) if out else '未匹配'
        if key == '美股指数-腾讯':
            out = []
            for code in ('usDJI', 'usIXIC', 'usINX'):
                f = tencent(text, code)
                if len(f) > 4:
                    out.append('%s %s' % (f[1], f[3]))
            return ' | '.join(out) if out else '未匹配'
        if key == '港股-腾讯':
            out = []
            for code in ('hkHSI', 'hkHSTECH'):
                f = tencent(text, code)
                if len(f) > 4:
                    out.append('%s %s' % (f[1], f[3]))
            return ' | '.join(out) if out else '未匹配'
        if key == '外盘期货-新浪':
            got = re.findall(r'var hq_str_(\w+)="([^,"]*)', text)
            got = [(k, v) for k, v in got if v]
            return '拿到 %d 个：%s' % (len(got), ', '.join('%s=%s' % kv for kv in got))
        if key == '美元指数-东财':
            j = json.loads(text)
            d = j.get('data') or {}
            return '%s=%s（原始值 %s）' % (d.get('f58'), (d.get('f43') or 0) / 100.0, d.get('f43'))
        if key == '美债10Y-东财':
            j = json.loads(text)
            return 'data=%s（%s）' % (j.get('data'), '缺口，需另想办法' if not j.get('data') else '可用')
        if key == '上证日K-腾讯':
            b = kline(text, 'sh000001')
            if not b:
                return '未解析到 K 线'
            return '%d 根，末根 %s 收 %s' % (len(b), b[-1][0], b[-1][2])
        if key == '美股日K-腾讯':
            b = kline(text, 'usDJI')
            if not b:
                return '未解析到 K 线'
            return '%d 根，末根 %s 收 %s' % (len(b), b[-1][0], b[-1][2])
        if key == '东财全市场清单':
            m = re.search(r'"total":(\d+)', text)
            return 'total=%s' % (m.group(1) if m else 'N/A')
        if key == '东财7x24快讯':
            n = text.count('"summary"')
            m = re.search(r'"summary":"(.{0,50})', text)
            return '快讯 %d 条，首条：%s' % (n, m.group(1) if m else 'N/A')
        if key == '东财板块涨幅':
            pairs = re.findall(r'"f3":([\d.\-]+)[^}]*?"f14":"([^"]+)"', text)
            if pairs:
                return '板块 %d 个，首位 %s %s%%' % (len(pairs), pairs[0][1], pairs[0][0])
            return '未匹配'
    except Exception as e:
        return '解析异常 %s: %s' % (type(e).__name__, e)
    return ''


def test_models():
    tok = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN') or ''
    if not tok:
        return [{'endpoint': '-', 'ok': False, 'error': '没有 GITHUB_TOKEN，跳过'}]
    out = []
    for name, url in MODEL_ENDPOINTS:
        payload = json.dumps({
            'model': 'gpt-4o-mini',
            'messages': [{'role': 'user', 'content': '只回四个字：模型可用'}],
            'max_tokens': 20,
        }).encode()
        req = urllib.request.Request(url, data=payload, method='POST', headers={
            'Authorization': 'Bearer ' + tok,
            'Content-Type': 'application/json',
            'User-Agent': UA,
            'Accept': 'application/json',
        })
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                body = r.read().decode('utf-8', 'ignore')
                try:
                    j = json.loads(body)
                    msg = (j.get('choices') or [{}])[0].get('message', {}).get('content', '')
                except Exception:
                    msg = body[:150]
                out.append({'endpoint': name, 'ok': True,
                            'ms': int((time.time() - t0) * 1000), 'reply': msg})
        except urllib.error.HTTPError as e:
            out.append({'endpoint': name, 'ok': False, 'status': e.code,
                        'ms': int((time.time() - t0) * 1000),
                        'body': (e.read() or b'')[:250].decode('utf-8', 'ignore')})
        except Exception as e:
            out.append({'endpoint': name, 'ok': False,
                        'ms': int((time.time() - t0) * 1000),
                        'error': '%s: %s' % (type(e).__name__, e)})
    return out


def main():
    results = []
    for key, desc, url, ref in CASES:
        ok, status, ms, body, err = http_get(url, ref)
        text = body.decode('gbk', 'ignore') if ('sinajs' in url or 'gtimg' in url) \
            else body.decode('utf-8', 'ignore')
        h = hint(key, text) if ok else err
        results.append({'key': key, 'desc': desc, 'ok': bool(ok and len(body) > 30),
                        'status': status, 'ms': ms, 'bytes': len(body), 'hint': h})
        print('[%s] %-16s %4dms %7dB  %s'
              % ('OK ' if results[-1]['ok'] else 'FAIL', key, ms, len(body), h), flush=True)

    payload = {
        'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'runner': {'os': platform.platform(), 'py': platform.python_version()},
        'passed': sum(1 for r in results if r['ok']),
        'total': len(results),
        'results': results,
        'models': test_models(),
    }
    with open('report-probe-result.json', 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print('通过 %d / %d' % (payload['passed'], payload['total']))
    print('--- GitHub Models ---')
    print(json.dumps(payload['models'], ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
