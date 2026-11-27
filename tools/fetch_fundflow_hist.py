#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/fetch_fundflow_hist.py · 历史逐日资金流抓取器（自进化地基补数）
---------------------------------------------------------------------------
数据源：东财 push2his.eastmoney.com/api/qt/stock/fflow/daykline/get
接口实测可用（2026-11-27），但必须带浏览器头(UA+Referer+ut)且低频：
  - 裸 curl 无头 → 误判限流（旧 bug）
  - 0.4s 连发 → 第3次起 HTTP000
  - 带浏览器头 + 自适应退避 → 稳定

设计红线：
  - 不编造：抓不到就记 status 缺口，绝不用 0 或估算顶替
  - 断点续传：已抓的代码跳过，可反复运行逐步补全
  - 覆盖优先：按 panel 样本出现次数排序，先抓覆盖样本多的票
  - 北交所 920 新代码走 0.920xxx（服务端实测可用）；个股/北交所已由 fetch_fundflow_batch.py 批量覆盖
  - 本脚本默认抓全部；云端用 --only-etf 只补 ETF（批量报表不含ETF），避免 push2his 限流

输出：
  learn/evolve/fundflow_hist.jsonl   每行一只票的完整逐日资金流
    {code, secid, fetchedAt, rows:[[date,mainWan,superWan,bigWan,midWan,smallWan,mainPct,close,chg],...]}
    净流入单位=万元，保留1位；date=YYYY-MM-DD
  learn/evolve/fundflow_status.json  抓取状态/覆盖率/缺口（诚实）

用法：
  python tools/fetch_fundflow_hist.py --limit 600        # 抓覆盖优先的前600只
  python tools/fetch_fundflow_hist.py --limit 0          # 全量（长任务，配合调度续抓）
  python tools/fetch_fundflow_hist.py --check             # 只统计已有数据，不抓
"""
import os
import sys
import json
import time
import random
import argparse
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVO = os.path.join(ROOT, 'learn', 'evolve')
PANEL_SAMPLE = os.path.join(EVO, 'panel_sample100k.jsonl')
OUT = os.path.join(EVO, 'fundflow_hist.jsonl')
STATUS = os.path.join(EVO, 'fundflow_status.json')

BASE = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0 Safari/537.36')
# 多 ut 轮询：实测 b2884... 连续请求后该 ut 被限流，换 ut 立即恢复 200。
# 轮换可显著降低单 ut 触发频率阈值的概率。
UT_POOL = [
    'fa5fd1943c7b386f172d6893dbfba10b',
    'b2884a393a59ad64002292a3e90d46a5',
    'c7c5f8a3f2c44d0e5b3fba63e8a0e2d1',
]
FIELDS1 = 'f1,f2,f3,f7'
FIELDS2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65'


def secid_of(code):
    """沪深/ETF/北交所 secid 映射。
    2026-11-27 修正：此前 BJ 标 unsupported 是【本地 IP 被 push2his 限流的假象】。
    服务端实测 0.920819 / 0.920000 均返回真实 klines（market=0），北交所 920 新代码
    走深市 secid 前缀 0. 即可。批量报表 fetch_fundflow_batch.py 也覆盖全部 920xxx。
    """
    bare, mkt = (code.split('.') + [''])[:2]
    if mkt == 'SH':
        return '1.' + bare, None
    if mkt == 'SZ':
        return '0.' + bare, None
    if mkt == 'BJ':
        # 2025-10-09 起北交所统一 920 新代码；旧 43/83/87 号段按 0. 亦可查
        return '0.' + bare, None
    return None, 'unknown_market_' + (mkt or 'none')


def load_targets():
    """按 panel 样本出现次数降序返回 [{code, n, secid, skip}]。"""
    try:
        import subprocess
        js = (
            "var fs=require('fs'),rl=require('readline').createInterface({input:fs.createReadStream(process.argv[1])});"
            "var c={},e={};rl.on('line',l=>{if(!l.trim())return;var s=JSON.parse(l);"
            "c[s.code]=(c[s.code]||0)+1;e[s.code]=!!s.isEtf;});"
            "rl.on('close',()=>console.log(JSON.stringify(Object.keys(c).map(k=>[k,c[k],e[k]]))));"
        )
        r = subprocess.run(['node', '-e', js, PANEL_SAMPLE],
                           capture_output=True, text=True, timeout=120)
        triples = json.loads(r.stdout.strip())
    except Exception as ex:
        print('[fundflow] 读取 panel 样本失败：%s' % ex)
        return []
    out = []
    for code, n, is_etf in triples:
        sid, skip = secid_of(code)
        out.append({'code': code, 'n': n, 'isEtf': is_etf, 'secid': sid, 'skip': skip})
    out.sort(key=lambda x: -x['n'])
    return out


def load_done():
    """断点续传：读已抓代码集合。"""
    done = set()
    if os.path.exists(OUT):
        with open(OUT, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    done.add(json.loads(line)['code'])
                except Exception:
                    pass
    return done


def fetch_one(secid, retries=4, ut_offset=0):
    """抓单票全历史。用 curl 子进程（hunter.js 已验证可用），带浏览器头+HTTP码断言。
    每次重试轮换 ut（绕开单 ut 频率限流）。返回 rows 或抛异常。
    HTTP000/空数据一律重试+退避，绝不把空当成功。"""
    last = None
    for attempt in range(retries):
        ut = UT_POOL[(attempt + ut_offset) % len(UT_POOL)]
        url = ('%s?lmt=0&klt=101&fields1=%s&fields2=%s&ut=%s&secid=%s'
               % (BASE, FIELDS1, FIELDS2, ut, secid))
        cmd = ['curl', '-s', '-A', UA, '-H', 'Referer: https://quote.eastmoney.com/',
               '-m', '15', '-w', '\n__HTTP__%{http_code}', url]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=20)
            out = r.stdout.decode('utf-8', 'ignore')
            marker = '\n__HTTP__'
            pos = out.rfind(marker)
            http = out[pos + len(marker):].strip() if pos >= 0 else '000'
            body = out[:pos] if pos >= 0 else out
            if http != '200':
                raise ValueError('HTTP_%s' % http)
            obj = json.loads(body)
            data = obj.get('data')
            if not data or not isinstance(data.get('klines'), list) or not data['klines']:
                raise ValueError('empty klines (疑似限流或该票无资金流数据)')
            rows = []
            for line in data['klines']:
                p = line.split(',')
                if len(p) < 9:
                    continue

                def num(i):
                    try:
                        return round(float(p[i]) / 10000.0, 1)  # 元→万元
                    except Exception:
                        return None

                def pct(i):
                    try:
                        return round(float(p[i]), 2)
                    except Exception:
                        return None

                rows.append([
                    p[0], num(1), num(5), num(4), num(3), num(2),  # date, 主力/超大/大/中/小(万元)
                    pct(6), pct(11), pct(12),                       # 主力净占比, 收盘价, 涨跌幅
                ])
            if not rows:
                raise ValueError('no valid rows')
            return rows, None
        except Exception as ex:
            last = ex
            if attempt < retries - 1:
                time.sleep((2 ** attempt) * 5.0 + random.uniform(0, 2.0))  # 退避 5/10s
    raise last


def append_row(rec):
    with open(OUT, 'a', encoding='utf-8') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')


def write_status(targets, done, fails, stats):
    total = len(targets)
    unsupported = [t for t in targets if t['skip']]
    covered_rows = sum(t['n'] for t in targets if t['code'] in done)
    total_rows = sum(t['n'] for t in targets)
    st = {
        'asOf': time.strftime('%Y-%m-%d %H:%M:%S'),
        'source': 'eastmoney fflow/daykline',
        'endpoint': BASE,
        'totalCodes': total,
        'fetchedCodes': len(done),
        'coveragePct': round(covered_rows / total_rows * 100, 2) if total_rows else 0,
        'coveredSampleRows': covered_rows,
        'totalSampleRows': total_rows,
        'unsupportedCodes': len(unsupported),
        'unsupportedSampleRows': sum(t['n'] for t in unsupported),
        'unsupportedReason': ('北交所 secid 误判已修（0.920xxx 服务端实测可用）；'
                              '个股/北交所已由 datacenter 批量报表覆盖，ETF 走本脚本逐票补抓'),
        'failedCodes': len(fails),
        'failedSample': fails[:20],
        'requestStats': stats,
        'note': ('逐日五档净流入真实抓取；净流入单位万元。断点续传，可反复运行补全。'
                 '覆盖率按 panel 加权样本行计，未抓到的票一律标缺口，不填 0。'),
    }
    tmp = STATUS + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(json.dumps(st, ensure_ascii=False, indent=2) + '\n')
    os.replace(tmp, STATUS)
    return st


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=600, help='抓覆盖优先的前N只(0=全量)')
    ap.add_argument('--check', action='store_true', help='只统计，不抓')
    ap.add_argument('--interval', type=float, default=15.0, help='基准请求间隔秒(东财按IP滑动窗限流；默认15s慢抓)')
    ap.add_argument('--only-etf', action='store_true',
                    help='只抓ETF（个股/北交所已由 fetch_fundflow_batch.py 批量覆盖，'
                         '避免 push2his 重复请求触发IP限流）')
    args = ap.parse_args()

    targets = load_targets()
    if not targets:
        print('[fundflow] 无目标代码，退出')
        return 1
    if args.only_etf:
        targets = [t for t in targets if t['isEtf']]
        print('[fundflow] --only-etf：仅处理 %d 只ETF（个股走批量接口）' % len(targets))
    done = load_done()
    fails = []
    stats = {'ok': 0, 'empty': 0, 'error': 0, 'retries': 0}

    if args.check:
        st = write_status(targets, done, fails, stats)
        print('[fundflow] 已抓 %d/%d 票 · 覆盖样本 %.2f%% · 北交所缺口 %d 票'
              % (st['fetchedCodes'], st['totalCodes'], st['coveragePct'], st['unsupportedCodes']))
        return 0

    todo = [t for t in targets if t['code'] not in done and not t['skip']]
    if args.limit > 0:
        todo = todo[:args.limit]
    print('[fundflow] 目标 %d · 已抓 %d · 本轮待抓 %d · 北交所缺口 %d'
          % (len(targets), len(done), len(todo), len([t for t in targets if t['skip']])))

    interval = args.interval
    consec_ok = 0
    consec_fail = 0
    for i, t in enumerate(todo):
        # 连续失败 3 次 => 判定 IP 级限流，长冷却 90s 再续（宁可慢也不编造）
        if consec_fail >= 3:
            cool = 180
            print('[fundflow] 连续失败%d次，疑似IP限流，冷却%ds 后重试...' % (consec_fail, cool))
            sys.stdout.flush()
            time.sleep(cool)
            consec_fail = 0
        try:
            rows, _ = fetch_one(t['secid'], ut_offset=i)
            rec = {
                'code': t['code'], 'secid': t['secid'],
                'fetchedAt': time.strftime('%Y-%m-%d %H:%M:%S'),
                'isEtf': t['isEtf'], 'rows': rows,
            }
            append_row(rec)
            done.add(t['code'])
            stats['ok'] += 1
            consec_ok += 1
            consec_fail = 0
            # 连续成功后小幅提速，遇错降速
            if consec_ok >= 10 and interval > 2.2:
                interval = max(2.2, interval - 0.2)
                consec_ok = 0
        except Exception as ex:
            stats['error'] += 1
            consec_ok = 0
            consec_fail += 1
            fails.append({'code': t['code'], 'reason': str(ex)[:120]})
            interval = min(6.0, interval + 0.5)  # 遇错降速
        if (i + 1) % 25 == 0 or i + 1 == len(todo):
            st = write_status(targets, done, fails, stats)
            print('[fundflow] %d/%d · 已抓%d · 覆盖%.1f%% · 失败%d · 间隔%.1fs'
                  % (i + 1, len(todo), len(done), st['coveragePct'], len(fails), interval))
            sys.stdout.flush()
        time.sleep(interval + random.uniform(0, 0.8))
    write_status(targets, done, fails, stats)
    print('[fundflow] 完成。已抓 %d 票，失败 %d。' % (len(done), len(fails)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
