#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ETF 资金流历史：FTShare 东财 ETF 资金流批量接口（按交易日全市场出数）。

为什么用这个源（2026-11-27 全网检索结论）：
  1. push2his fflow/daykline 对 ETF 只给 121 个交易日（2026-06-03 起），且逐票请求
     511 只 × 每票一次，本地 IP 会被限流；FTShare 同款东财数据历史更长（2026-03-16 起），
     且按日期区间批量出数（page_size=1000，一个月约 30 页），几分钟补齐全历史。
  2. 数据一致性已逐位验证：同一 ETF 同一天，FTShare main_net/xl_net/l_net/m_net/s_net
     与东财 push2his f52/f56/f55/f54/f53 完全一致（单位元），main_pct/close/change_pct
     亦一致。字段直接对齐 fundflow_portrait 的 9 列格式，不估算、不编造。
  3. 早期缺口（2026-01-28 ~ 2026-03-15，FTShare 与 push2his 均无）明确标缺口，不填 0。
  4. 匿名额度：FTShare 限制每天 500 次请求（约 250 页 × 2 次探页/页）。首轮全量约 250 页刚好够；
     若遇 429，分片断点续传保留已完成页，次日额度恢复后重跑只补缺失页（不重复消耗）。
     11月尾部若本轮 429 失败，由 push2his 逐票源（fetch_fundflow_hist.py --only-etf）兜底。

输出：learn/evolve/fundflow_etf.jsonl（每行 {code, rows:[9列]}，与 fundflow_hist 同格式）
      learn/evolve/fundflow_etf_status.json
断点续传：按 (月,页) 分片存 shards，重跑跳过已完成分片。
"""
import os
import sys
import json
import time
import gzip
import subprocess
import argparse
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVO = os.path.join(ROOT, 'learn', 'evolve')
PANEL_SAMPLE = os.path.join(EVO, 'panel_sample100k.jsonl')
OUT = os.path.join(EVO, 'fundflow_etf.jsonl')
STATUS = os.path.join(EVO, 'fundflow_etf_status.json')
SHARD_DIR = os.path.join(EVO, 'fundflow_etf_shards')

API = 'https://market.ft.tech/gateway/api/v1/market/data/eastmoney-etf-flow'
PAGE_SIZE = 1000
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'


def log(*a):
    print('[etf-ftshare]', *a, flush=True)


def read_etf_codes():
    """panel 样本里出现的 ETF 代码集合（只需补这些，避免抓无关标的）。"""
    codes = set()
    if not os.path.exists(PANEL_SAMPLE):
        return codes
    with open(PANEL_SAMPLE, 'r', encoding='utf-8') as f:
        for line in f:
            if not line.strip():
                continue
            try:
                o = json.loads(line)
                if o.get('isEtf'):
                    codes.add(o['code'])
            except Exception:
                pass
    return codes


def panel_window():
    mn, mx = None, None
    if os.path.exists(PANEL_SAMPLE):
        with open(PANEL_SAMPLE, 'r', encoding='utf-8') as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    d = json.loads(line).get('date')
                    if not d:
                        continue
                    mn = d if mn is None or d < mn else mn
                    mx = d if mx is None or d > mx else mx
                except Exception:
                    pass
    return mn, mx


def fetch_page(url, retries=4):
    """返回 records 列表 + total；失败抛异常（不返回假空）。"""
    last = None
    for attempt in range(retries):
        cmd = ['curl', '-s', '-A', UA, '-m', '30',
               '-w', '\n__HTTP__%{http_code}', url]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=40)
            out = r.stdout.decode('utf-8', 'ignore')
            marker = '\n__HTTP__'
            pos = out.rfind(marker)
            http = out[pos + len(marker):].strip() if pos >= 0 else '000'
            body = out[:pos] if pos >= 0 else out
            if http != '200':
                raise ValueError('HTTP_%s' % http)
            obj = json.loads(body)
            if obj.get('code') != 200 or not isinstance(obj.get('data'), dict):
                raise ValueError('api_code_%s' % obj.get('code'))
            d = obj['data']
            return d.get('records') or [], int(d.get('total') or 0)
        except Exception as ex:
            last = ex
            if attempt < retries - 1:
                time.sleep((2 ** attempt) * 2.0)
    raise last


def month_ranges(mn, mx):
    """按月切分查询区间（每月约 20 个交易日 × 1500 只 ≈ 3 万行 / 30 页）。"""
    out = []
    cur = datetime.strptime(mn, '%Y-%m-%d')
    end = datetime.strptime(mx, '%Y-%m-%d')
    while cur <= end:
        y, m = cur.year, cur.month
        last_day = datetime(y + (m == 12), 1 if m == 12 else m + 1, 1) - timedelta(days=1)
        seg_end = min(last_day, end)
        out.append((cur.strftime('%Y-%m-%d'), seg_end.strftime('%Y-%m-%d')))
        # 下月 1 号
        cur = datetime(y + (m == 12), 1 if m == 12 else m + 1, 1)
    return out


def shard_path(key):
    safe = key.replace('-', '').replace('_', '')
    return os.path.join(SHARD_DIR, 'ft_%s.json' % safe)


def num(v, div=10000.0, digits=1):
    try:
        return round(float(v) / div, digits)
    except Exception:
        return None


def pct(v):
    try:
        return round(float(v), 2)
    except Exception:
        return None


def to_row(rec):
    """FTShare → fundflow_portrait 9 列（元→万元，与 fetch_fundflow_hist.py 一致）。
       0 date, 1 main, 2 super, 3 big, 4 mid, 5 small, 6 mainPct, 7 close, 8 chg"""
    date = str(rec.get('trade_date') or '')
    if len(date) == 8:
        date = '%s-%s-%s' % (date[:4], date[4:6], date[6:])
    return [
        date,
        num(rec.get('main_net')), num(rec.get('xl_net')), num(rec.get('l_net')),
        num(rec.get('m_net')), num(rec.get('s_net')),
        pct(rec.get('main_pct')), pct(rec.get('close')), pct(rec.get('change_pct')),
    ]


def bare_to_code(bare, bare_map):
    """FTShare 返回 6 位裸码，还原成 panel 的带后缀代码。"""
    return bare_map.get(bare)


def build(args):
    etf_codes = read_etf_codes()
    if not etf_codes:
        log('panel 无 ETF 代码，退出')
        return 1
    # FTShare 用 6 位裸码，panel 用带后缀（510300.SH）；建裸码→全码映射
    bare_map = {}
    for c in etf_codes:
        bare_map.setdefault(c.split('.')[0], c)
    log('裸码映射 %d 条（FTShare 6位码 → panel 带后缀）' % len(bare_map))
    mn, mx = panel_window()
    if not mn or not mx:
        log('无 panel 日期窗，退出')
        return 1
    # FTShare 数据起始 2026-03-16，早于此的区间无需请求（诚实标缺口）
    START = '2026-03-16'
    if mn < START:
        log('panel 起点 %s 早于 FTShare 数据起点 %s；%s 之前样本将标缺口' % (mn, START, START))
        mn = START
    os.makedirs(SHARD_DIR, exist_ok=True)

    stats = {'pagesFetched': 0, 'pagesReused': 0, 'rowsTotal': 0,
             'rowsInPanel': 0, 'lastError': None}
    ranges = month_ranges(mn, mx)
    log('ETF 目标 %d 只，日期窗 %s~%s，分 %d 个月段' % (len(etf_codes), mn, mx, len(ranges)))

    for a, b in ranges:
        # 先探总页数（page=1）
        url1 = '%s?start_date=%s&end_date=%s&page=1&page_size=%d' % (
            API, a.replace('-', ''), b.replace('-', ''), PAGE_SIZE)
        try:
            recs1, total = fetch_page(url1)
        except Exception as ex:
            stats['lastError'] = '%s %s' % (a, ex)
            log('  %s 探页失败：%s' % (a, ex))
            continue
        pages = (total + PAGE_SIZE - 1) // PAGE_SIZE
        log('  %s~%s：%d 行 / %d 页' % (a, b, total, pages))
        for pn in range(1, pages + 1):
            key = '%s_p%04d' % (a, pn)
            sp = shard_path(key)
            if os.path.exists(sp) and not args.reset:
                stats['pagesReused'] += 1
                continue
            if args.max_pages and stats['pagesFetched'] >= args.max_pages:
                log('  达到 --max-pages=%d，停止' % args.max_pages)
                break
            if pn == 1:
                recs = recs1
            else:
                url = '%s?start_date=%s&end_date=%s&page=%d&page_size=%d' % (
                    API, a.replace('-', ''), b.replace('-', ''), pn, PAGE_SIZE)
                try:
                    recs, _ = fetch_page(url)
                except Exception as ex:
                    stats['lastError'] = '%s p%d %s' % (a, pn, ex)
                    log('    p%d 失败：%s' % (pn, ex))
                    continue
            # 只留 panel ETF，转 9 列行
            keep = {}
            for rec in recs:
                bare = str(rec.get('code') or '')[:6]
                code = bare_to_code(bare, bare_map)   # 裸码 → panel 带后缀
                if not code:
                    continue
                row = to_row(rec)
                if not row[0]:
                    continue
                by = keep.setdefault(code, {})
                by[row[0]] = row
            payload = {'a': a, 'b': b, 'pn': pn, 'data': keep}
            tmp = sp + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
            os.replace(tmp, sp)
            stats['pagesFetched'] += 1
            stats['rowsTotal'] += len(recs)
            stats['rowsInPanel'] += sum(len(v) for v in keep.values())
            if stats['pagesFetched'] % 20 == 0:
                log('    已抓 %d 页 / 命中 %d 行' % (
                    stats['pagesFetched'], stats['rowsInPanel']))
            time.sleep(args.interval)

    # 合并分片 → fundflow_etf.jsonl（按 code 聚合）
    merged = {}
    shards = sorted(f for f in os.listdir(SHARD_DIR) if f.startswith('ft_') and f.endswith('.json'))
    for name in shards:
        try:
            obj = json.load(open(os.path.join(SHARD_DIR, name), 'r', encoding='utf-8'))
            for code, by in (obj.get('data') or {}).items():
                dst = merged.setdefault(code, {})
                for d, row in by.items():
                    dst[d] = row
        except Exception:
            pass
    with open(OUT, 'w', encoding='utf-8') as f:
        for code in sorted(merged):
            by = merged[code]
            rows = [by[d] for d in sorted(by)]
            f.write(json.dumps({'code': code, 'rows': rows},
                               ensure_ascii=False, separators=(',', ':')) + '\n')

    # 覆盖率：按 panel 样本行加权
    covered = 0
    total_rows = 0
    early_gap = 0
    with open(PANEL_SAMPLE, 'r', encoding='utf-8') as f:
        for line in f:
            if not line.strip():
                continue
            try:
                o = json.loads(line)
                if not o.get('isEtf'):
                    continue
                total_rows += 1
                by = merged.get(o['code'])
                if by and o.get('date') in by:
                    covered += 1
                elif o.get('date', '') < '2026-03-16':
                    early_gap += 1
            except Exception:
                pass

    status = {
        'asOf': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'source': 'FTShare eastmoney-etf-flow (ETF 日资金流批量, 与 push2his 逐位一致)',
        'endpoint': API,
        'window': {'from': mn, 'to': mx, 'dataStart': '2026-03-16'},
        'etfCodes': len(etf_codes),
        'fetchedEtfCodes': len(merged),
        'coveredSampleRows': covered,
        'etfSampleRows': total_rows,
        'etfCoveragePct': round(covered * 100.0 / total_rows, 2) if total_rows else 0,
        'earlyGapRows': early_gap,
        'earlyGapNote': '2026-03-16 前 FTShare/push2his 均无 ETF 资金流数据，标缺口不填0',
        'stats': stats,
        'note': '一行=一只ETF一个交易日；单位万元；缺口保留为空，不估算。',
    }
    with open(STATUS, 'w', encoding='utf-8') as f:
        json.dump(status, f, ensure_ascii=False, indent=2)

    log('完成：ETF %d 只，命中 %d 行，覆盖 %d/%d = %.2f%%，早期缺口 %d 行' % (
        len(merged), stats['rowsInPanel'], covered, total_rows, status['etfCoveragePct'], early_gap))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--interval', type=float, default=0.3, help='页间隔秒')
    ap.add_argument('--reset', action='store_true', help='忽略分片重抓')
    ap.add_argument('--max-pages', type=int, default=0, help='调试：限制页数')
    ap.add_argument('--check', action='store_true', help='只看状态')
    args = ap.parse_args()
    if args.check:
        if os.path.exists(STATUS):
            s = json.load(open(STATUS, 'r', encoding='utf-8'))
            print(json.dumps(s, ensure_ascii=False, indent=2))
        else:
            print('无状态文件')
        return 0
    return build(args)


if __name__ == '__main__':
    sys.exit(main())
