#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/fetch_fundflow_batch.py · 全市场历史资金流【批量】抓取（绕开 push2his IP 限流）
----------------------------------------------------------------------------------
根因：push2his.eastmoney.com/api/qt/stock/fflow/daykline/get 是按 IP 滑动窗限流的
     逐票接口，本地 IP 连续测试后整段 HTTP000；云端一天补 40 票太慢。

解法：东财【数据中心】另一张报表 RPT_DMSK_TS_FUNDFLOW（datacenter-web 子域，
     不同 WAF，实测本地 IP 仍 200）。它按【交易日 × 全市场】出数：
       - pageSize=5000，一天约 2 页；全年约 269 页 = 134 万行
       - 覆盖全部沪深个股 + 北交所 920xxx（实测 332 票都在）
       - 字段齐全：主力/超大/大/中/小净额(万元)、净占比、收盘价、涨跌幅
       - ETF 不在该报表里 → 仍由 fetch_fundflow_hist.py 走 push2his 云端补抓
     一次全量回补从「5854 次逐票请求」压到「约 270 次批量请求」，且不受 push2
     封禁影响。

设计红线（与前任一致）：
  - 不编造：任何缺失保留缺口，不填 0、不估算
  - 断点续传：按页落盘临时分片，中断后跳过已完成页
  - 诚实状态：覆盖率按 panel 样本加权，ETF/北交所缺口单独标注

输出：
  learn/evolve/fundflow_batch.jsonl.gz   全市场逐日资金流（gzip，GitHub 单文件 <100MB 限制）
    {code, rows:[[date,mainWan,superWan,bigWan,midWan,smallWan,mainPct,close,chg],...]}
    字段索引与 fundflow_portrait.js / fetch_fundflow_hist.py 完全一致
  learn/evolve/fundflow_batch_status.json  批量抓取状态/覆盖率/缺口

用法：
  python tools/fetch_fundflow_batch.py                 # 全量回补（默认，约5分钟）
  python tools/fetch_fundflow_batch.py --days 30       # 只补最近30个自然日
  python tools/fetch_fundflow_batch.py --check         # 只统计已有分片，不出网
  python tools/fetch_fundflow_batch.py --reset         # 清空分片重来（谨慎）
"""
import os
import sys
import json
import time
import gzip
import random
import argparse
import subprocess
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVO = os.path.join(ROOT, 'learn', 'evolve')
PANEL_SAMPLE = os.path.join(EVO, 'panel_sample100k.jsonl')
OUT = os.path.join(EVO, 'fundflow_batch.jsonl.gz')
STATUS = os.path.join(EVO, 'fundflow_batch_status.json')
SHARD_DIR = os.path.join(EVO, 'fundflow_batch_shards')

API = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0 Safari/537.36')
REPORT = 'RPT_DMSK_TS_FUNDFLOW'
COLS = ('SECURITY_CODE,SECUCODE,TRADE_DATE,NET_INFLOW,NET_INFLOW_RATIO,'
        'SUPERDEAL_NET,BIGDEAL_NET,MIDDEAL_NET,SMALLDEAL_NET,CLOSE_PRICE,CHANGE_RATE')
PAGE_SIZE = 5000

# 字段索引（与 fundflow_portrait.js 严格对齐）
IDX = {'date': 0, 'main': 1, 'super': 2, 'big': 3, 'mid': 4, 'small': 5,
       'pct': 6, 'close': 7, 'chg': 8}


def log(msg):
    print('[ff-batch] %s' % msg)
    sys.stdout.flush()


def panel_window():
    """从 panel 采样读日期窗与目标代码集合（含 ETF 标记）。"""
    try:
        js = (
            "var fs=require('fs'),rl=require('readline').createInterface({input:fs.createReadStream(process.argv[1])});"
            "var mn='9999',mx='0',c={},e={};rl.on('line',l=>{if(!l.trim())return;var s=JSON.parse(l);"
            "if(s.date){if(s.date<mn)mn=s.date;if(s.date>mx)mx=s.date;}"
            "c[s.code]=(c[s.code]||0)+1;e[s.code]=!!s.isEtf;});"
            "rl.on('close',()=>console.log(JSON.stringify({min:mn,max:mx,codes:c,etf:e})));"
        )
        r = subprocess.run(['node', '-e', js, PANEL_SAMPLE],
                           capture_output=True, text=True, timeout=180)
        return json.loads(r.stdout.strip())
    except Exception as ex:
        log('读取 panel 采样失败：%s' % ex)
        return None


def fetch_page(pn, window, retries=4):
    """抓一页全市场资金流；带浏览器头+退避，失败抛异常（不返回假空）。"""
    flt = urllib.parse.quote(
        "(TRADE_DATE>='%s')(TRADE_DATE<='%s')"
        % (window['from'], window['to']), safe='')
    url = ('%s?reportName=%s&columns=%s&pageSize=%d&pageNumber=%d'
           '&sortColumns=TRADE_DATE,SECURITY_CODE&sortTypes=1,1&filter=%s'
           % (API, REPORT, COLS, PAGE_SIZE, pn, flt))
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={
            'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/',
            'Accept': 'application/json, text/plain, */*',
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                obj = json.loads(resp.read().decode('utf-8'))
            if not obj.get('success') or not isinstance(obj.get('result'), dict):
                raise ValueError('success=false / result缺失: %s' % (obj.get('message') or '')[:80])
            res = obj['result']
            data = res.get('data') or []
            if not data:
                raise ValueError('空数据页（疑似限流）')
            return {'page': pn, 'pages': res.get('pages') or 0,
                    'count': res.get('count') or 0, 'data': data}
        except Exception as ex:
            last = ex
            if attempt < retries - 1:
                time.sleep((2 ** attempt) * 2.0 + random.uniform(0, 1.0))
    raise last


def num(v):
    try:
        f = float(v)
        return round(f, 4) if abs(f) < 1e12 else None
    except Exception:
        return None


def to_row(rec):
    """数据中心字段 → portrait 行数组（万元/%口径，与 push2his 一致）。"""
    d = str(rec.get('TRADE_DATE') or '')[:10]
    if len(d) != 10:
        return None
    main = num(rec.get('NET_INFLOW'))
    if main is None:                      # 主力净额缺失 → 整行不可用，不填0
        return None
    return [d, main,
            num(rec.get('SUPERDEAL_NET')), num(rec.get('BIGDEAL_NET')),
            num(rec.get('MIDDEAL_NET')), num(rec.get('SMALLDEAL_NET')),
            num(rec.get('NET_INFLOW_RATIO')), num(rec.get('CLOSE_PRICE')),
            num(rec.get('CHANGE_RATE'))]


def shard_path(pn):
    return os.path.join(SHARD_DIR, 'p%05d.json' % pn)


def write_status(panel, shards, merged_codes, stats, window):
    codes = panel.get('codes') or {}
    etf = panel.get('etf') or {}
    stock_codes = [c for c in codes if not etf.get(c)]
    etf_codes = [c for c in codes if etf.get(c)]
    total_rows = sum(codes.values())
    stock_rows = sum(codes[c] for c in stock_codes)
    etf_rows = sum(codes[c] for c in etf_codes)
    covered_rows = sum(codes.get(c, 0) for c in merged_codes if c in codes)
    st = {
        'asOf': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'source': 'eastmoney datacenter-web RPT_DMSK_TS_FUNDFLOW (batch)',
        'endpoint': API,
        'reportName': REPORT,
        'window': window,
        'shardsDone': len(shards),
        'totalCodes': len(codes),
        'stockCodes': len(stock_codes),
        'etfCodes': len(etf_codes),
        'mergedCodes': len(merged_codes),
        'coveragePct': round(covered_rows / total_rows * 100, 2) if total_rows else 0,
        'stockCoveragePct': round(covered_rows / stock_rows * 100, 2) if stock_rows else 0,
        'coveredSampleRows': covered_rows,
        'totalSampleRows': total_rows,
        'etfGapRows': etf_rows,
        'etfGapNote': 'ETF 不在批量报表中，由 fetch_fundflow_hist.py 走 push2his 云端补抓',
        'bjCodes': sum(1 for c in codes if c.endswith('.BJ')),
        'bjCovered': sum(1 for c in merged_codes if c.endswith('.BJ')),
        'bjNote': '北交所 920xxx 在批量报表内（0.920xxx secid 服务端实测可用）',
        'stats': stats,
        'note': ('完全开放数据：一行=一只票的一个交易日，按 panel 样本加权统计覆盖。'
                 '缺口保留为空，不填 0、不估算。'),
    }
    tmp = STATUS + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(st, f, ensure_ascii=False, indent=2)
        f.write('\n')
    os.replace(tmp, STATUS)
    return st


def merge_shards(shard_files, panel):
    """把分片合并成按 code 分组的 gzip JSONL；返回合并到的 code 集合。"""
    by_code = {}
    for sp in shard_files:
        try:
            with open(sp, 'r', encoding='utf-8') as f:
                rows = json.load(f)
        except Exception:
            continue
        for code, recs in rows.items():
            bucket = by_code.setdefault(code, {})
            for r in recs:
                bucket[r[0]] = r
    tmp = OUT + '.tmp'
    n = 0
    with gzip.open(tmp, 'wt', encoding='utf-8', compresslevel=6) as f:
        for code in sorted(by_code):
            rows = [by_code[code][d] for d in sorted(by_code[code])]
            f.write(json.dumps({'code': code, 'rows': rows}, ensure_ascii=False,
                               separators=(',', ':')) + '\n')
            n += 1
    os.replace(tmp, OUT)
    return set(by_code), n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=0, help='只补最近N个自然日(0=全量)')
    ap.add_argument('--check', action='store_true', help='只统计，不出网')
    ap.add_argument('--reset', action='store_true', help='清空分片重来')
    ap.add_argument('--interval', type=float, default=1.0, help='页间间隔秒')
    ap.add_argument('--max-pages', type=int, default=0, help='调试：限制页数(0=不限)')
    ap.add_argument('--skip-if-complete', action='store_true',
                    help='若 gz 已覆盖 panel 全窗且个股覆盖率≥99%%，跳过抓取（云端每日复用，避免20分钟重复全量）')
    args = ap.parse_args()

    panel = panel_window()
    if not panel or not panel.get('min'):
        log('无 panel 日期窗，退出')
        return 1

    # 复用判定：已有 gz + 状态窗口覆盖 panel 上界 + 个股覆盖率≥99% → 直接退出0
    if args.skip_if_complete and os.path.exists(OUT) and os.path.exists(STATUS):
        try:
            with open(STATUS, 'r', encoding='utf-8') as f:
                old = json.load(f)
            w = old.get('window') or {}
            if (old.get('stockCoveragePct', 0) >= 99
                    and w.get('to', '') >= panel['max']
                    and w.get('panelFrom', '') == panel['min']):
                log('复用已有批量数据：覆盖率%.1f%% · 窗口%s~%s 覆盖 panel(%s)，跳过抓取'
                    % (old['stockCoveragePct'], w.get('from'), w.get('to'), panel['max']))
                return 0
        except Exception as ex:
            log('复用判定失败（将重抓）：%s' % str(ex)[:100])
    os.makedirs(SHARD_DIR, exist_ok=True)
    if args.reset:
        for fn in os.listdir(SHARD_DIR):
            os.remove(os.path.join(SHARD_DIR, fn))
        log('已清空分片')

    # 画像 derive() 需要 T 日之前 10 个交易日历史；窗口前移 30 自然日，
    # 否则 panel 最早那批样本会因历史不足被误标缺口（诚实但白白丢样本）。
    win_min_dt = datetime.strptime(panel['min'], '%Y-%m-%d') - timedelta(days=30)
    win_min = win_min_dt.strftime('%Y-%m-%d')
    if args.days > 0:
        d = datetime.strptime(panel['max'], '%Y-%m-%d') - timedelta(days=args.days)
        win_min = d.strftime('%Y-%m-%d')
    window = {'from': win_min, 'to': panel['max'], 'panelFrom': panel['min'],
              'lookbackDays': 30}
    shards = sorted(fn for fn in os.listdir(SHARD_DIR) if fn.endswith('.json'))
    shard_nums = set(int(fn[1:6]) for fn in shards if fn.startswith('p') and fn[1:6].isdigit())

    merged_codes, _ = merge_shards([os.path.join(SHARD_DIR, s) for s in shards], panel) if shards else (set(), 0)
    stats = {'pagesFetched': 0, 'pagesReused': len(shards), 'rowsFetched': 0,
             'lastError': None}

    if args.check:
        st = write_status(panel, shard_nums, merged_codes, stats, window)
        log('分片 %d · 合并 %d 票 · 覆盖 %.2f%% · 北交所 %d/%d'
            % (len(shards), len(merged_codes), st['coveragePct'],
               st['bjCovered'], st['bjCodes']))
        return 0

    # 第一页探测总页数
    first_num = 1
    probe = fetch_page(first_num, window)
    total_pages = probe['pages']
    log('报表总页数 %d · 总行 %d · 日期窗 %s~%s'
        % (total_pages, probe['count'], window['from'], window['to']))
    if args.max_pages > 0:
        total_pages = min(total_pages, args.max_pages)

    all_pages = list(range(1, total_pages + 1))
    todo = [p for p in all_pages if p not in shard_nums]
    log('已完成 %d 页，本轮待抓 %d 页' % (len(shard_nums), len(todo)))

    def save(pn, obj):
        # 只存本窗口日期 + 只存 panel 目标代码，压小分片
        want = panel.get('codes') or {}
        win_from, win_to = window['from'], window['to']
        acc = {}
        for rec in obj['data']:
            code = rec.get('SECUCODE') or (rec.get('SECURITY_CODE') or '')
            if code not in want:
                continue
            row = to_row(rec)
            if not row or not (win_from <= row[0] <= win_to):
                continue
            acc.setdefault(code, []).append(row)
        with open(shard_path(pn), 'w', encoding='utf-8') as f:
            json.dump(acc, f, ensure_ascii=False, separators=(',', ':'))
        return sum(len(v) for v in acc.values())

    # 处理第一页（已探测）
    if first_num in todo:
        stats['rowsFetched'] += save(first_num, probe)
        shard_nums.add(first_num)
        stats['pagesFetched'] += 1
        todo.remove(first_num)

    consec_fail = 0
    for i, pn in enumerate(todo):
        if consec_fail >= 3:
            cool = 60
            log('连续失败%d页，冷却%ds 后继续' % (consec_fail, cool))
            time.sleep(cool)
            consec_fail = 0
        try:
            obj = fetch_page(pn, window)
            stats['rowsFetched'] += save(pn, obj)
            shard_nums.add(pn)
            stats['pagesFetched'] += 1
            consec_fail = 0
        except Exception as ex:
            stats['lastError'] = str(ex)[:160]
            consec_fail += 1
            log('第%d页失败：%s' % (pn, str(ex)[:120]))
        if (i + 1) % 20 == 0 or i + 1 == len(todo):
            log('进度 %d/%d · 本轮成功 %d 页 · 累计行 %d'
                % (i + 1, len(todo), stats['pagesFetched'], stats['rowsFetched']))
            merged_codes, _ = merge_shards(
                [os.path.join(SHARD_DIR, s) for s in sorted(os.listdir(SHARD_DIR))
                 if s.endswith('.json')], panel)
            write_status(panel, shard_nums, merged_codes, stats, window)
        time.sleep(args.interval + random.uniform(0, 0.4))

    shard_files = [os.path.join(SHARD_DIR, s) for s in sorted(os.listdir(SHARD_DIR))
                   if s.endswith('.json')]
    merged_codes, n_codes = merge_shards(shard_files, panel)
    st = write_status(panel, shard_nums, merged_codes, stats, window)
    log('完成：%d 票写入 %s · 覆盖 %.2f%% · 北交所 %d/%d · ETF缺口 %d 行'
        % (n_codes, os.path.basename(OUT), st['coveragePct'],
           st['bjCovered'], st['bjCodes'], st['etfGapRows']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
