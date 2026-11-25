# -*- coding: utf-8 -*-
"""盘中快报（10:30 / 14:00 + 事件触发插播）。

设计约束（2026-11-25 与用户确认）：
- 不覆盖早报/午评/收盘，只往 daily.js 的 intraday 数组追加一条；
- 轻量三块：对照结论 + 期间事件 + 一句状态变更；不给新买卖点位；
- 数据只取实时行情/板块 + 快讯，不跑 24 组深料检索，避免和整点三报抢资源。
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_report as gr

SLOT_META = {
    'am_flash': {'at': '10:30', 'ref': 'morning', 'label': '[对照早报]',
                 'name': '开盘一小时回顾'},
    'pm_flash': {'at': '14:00', 'ref': 'noon', 'label': '[对照午评]',
                 'name': '下午一小时回顾'},
    'event': {'at': '', 'ref': '', 'label': '[事件插播]', 'name': '盘中事件插播'},
}

SYSTEM = """你是 A 股盘中快报分析师。读者已经看过今天的早报/午评，这次只回答三件事：
原先的判断现在兑现了没有；这段时间发生了哪些真正新增的事；判断状态要不要改。
只使用「事实包」里出现的数字和事实，禁止编造点位、涨跌幅、金额。

【硬规则】
1. 不覆盖、不重述旧稿全文。每条对照结论必须写清「早报/午评原判断 → 现在状态 → 依据」。
2. 状态只能是：兑现 / 证伪 / 待验证 / 混合。不许写「持续关注」这种空话。
3. 期间事件只列事实包里「期间事件」中的条目，最多 5 条；不写旧稿里已出现过的内容。
4. change 只写一句判断状态变化，禁止给出任何新的买卖点位、仓位建议或目标价。
5. 全文 400–600 字，不写四段式、不写新闻长文、不写盘后关注清单。
6. 只输出 JSON，不要 markdown 代码块。

【输出结构】
{
 "status": "兑现|证伪|待验证|混合",
 "reviews": [
   {"point":"早报/午评的原判断（不超过40字）","state":"兑现|证伪|待验证|混合",
    "evidence":"事实包里的新数据或新事件，带数字，30–60字"}
 ],
 "events": [
   {"t":"事件标题（事实包原文）","d":"一句话说清为什么重要，带来源或数字，不超过60字"}
 ],
 "change": "一句状态变更：判断变没变、往哪个方向偏，不给操作建议"
}
"""


def bj_now():
    return time.gmtime(time.time() + 8 * 3600)


def build_light_facts(slot, prior):
    """只抓轻量数据：行情/板块/多源快讯，不跑深料检索。"""
    diag = []

    def step(name, ok, note=''):
        diag.append({'name': name, 'ok': bool(ok), 'note': note})

    q, qerr = gr.grab_tencent_quotes()
    step('实时行情', q, qerr or ('%d 个代码' % len(q)))

    spot, serr = gr.grab_cn_spot()
    if not spot or spot <= 0:
        spot, serr = None, serr or '接口返回 0，已剔除'
    step('两市成交额', spot is not None, serr or ('%.0f 亿' % spot))

    top, bottom = gr.grab_sectors()
    step('行业板块', top, '%d 涨 / %d 跌' % (len(top or []), len(bottom or [])))

    pools = []
    for name, fn, arg in (('东财7x24', gr.grab_news, 2),
                          ('新浪7x24', gr.grab_sina_flash, 40),
                          ('金十数据', gr.grab_jin10_flash, 40),
                          ('财联社', gr.grab_cls_flash, 30),
                          ('华尔街见闻', gr.grab_wscn_flash, 30)):
        try:
            rows, err = fn(arg)
            step(name, rows, err or ('%d 条' % len(rows)))
            pools.append((name, rows or []))
        except Exception as e:
            step(name, False, str(e)[:80])

    news = gr.curate_news(pools, 160)
    events = []
    for ev in gr.dedupe_events(news, 't', cap=40):
        main = ev['main']
        events.append({
            'title': main.get('t') or '',
            'time': gr.hhmm_of(main.get('time')),
            'sources': '/'.join(ev['sources'][:4]) + ('等%d源' % ev['n'] if ev['n'] > 4 else ''),
            'n': ev['n'],
            'sum': (main.get('sum') or '')[:220],
        })
    step('事件级去重', events, '%d 条' % len(events))

    pick = lambda c: ({'price': q[c]['price'], 'pct': q[c]['pct']} if c in q else None)
    return {
        '时段': SLOT_META[slot]['name'] if slot in SLOT_META else '盘中插播',
        '对照结论': prior or {'note': '未找到早报/午评结论，本次只报新增事件'},
        'A股指数': {'上证': pick('sh000001'), '深成指': pick('sz399001'),
                    '创业板指': pick('sz399006'), '科创50': pick('sh000688')},
        '两市成交额_亿元': spot,
        '行业涨幅前6': (top or [])[:6],
        '行业跌幅前6': (bottom or [])[:6],
        '期间事件': events,
        '注意': '只使用本包数字；不要给买卖点位或仓位建议；不要重述对照结论全文。',
    }, diag, events


def prior_conclusions(daily, ref):
    s = (daily.get(ref) or {}) if daily else {}
    if not s.get('oneLine'):
        return {}
    out = {'判断': s.get('verdict'), '一句话': s.get('oneLine')[:400], '生成时间': s.get('at')}
    pts = [str(x)[:220] for x in (s.get('points') or [])[:2]]
    if pts:
        out['关键点是'] = pts
    return out


def call_intraday(facts, slot, model_override=None, extra_note=''):
    key, url, models, kind = gr.llm_config()
    if not key:
        return None, None, '没有可用的 LLM_API_KEY'
    if model_override:
        models = [m.strip() for m in str(model_override).split(',') if m.strip()]
    msgs = [
        {'role': 'system', 'content': SYSTEM},
        {'role': 'user', 'content':
            ('时段：%s\n事实包：\n%s\n%s只输出 JSON。'
             % (slot, json.dumps(facts, ensure_ascii=False, indent=1),
                (extra_note + '\n\n') if extra_note else ''))},
    ]
    print('[盘中] 通道=%s 候选=%s' % (kind, ','.join(models)))
    for model in models:
        body = json.dumps({'model': model, 'messages': msgs,
                           'temperature': 0.5, 'max_tokens': 6000,
                           'thinking': {'type': 'disabled'}}, ensure_ascii=False).encode()
        raw, ms, err = gr.fetch(url, timeout=120, data=body, headers={
            'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
            'Accept': 'application/json'})
        if err:
            print('[盘中] %s 失败：%s' % (model, err))
            continue
        try:
            j = json.loads(raw.decode('utf-8', 'ignore'))
            txt = (j['choices'][0]['message'].get('content') or '').strip()
            txt = gr.re.sub(r'^```(?:json)?|```$', '', txt, flags=gr.re.M).strip()
            obj = json.loads(txt)
            print('[盘中] %s 成功（%d ms）' % (model, ms))
            return obj, model, None
        except Exception as e:
            print('[盘中] %s 解析失败：%s' % (model, e))
    return None, None, '所有候选模型都失败'


def normalize_entry(c, slot, at, model, diag):
    meta = SLOT_META[slot]
    reviews = []
    for r in (c.get('reviews') or [])[:4]:
        if isinstance(r, str):
            r = {'point': r[:40], 'state': '待验证', 'evidence': ''}
        reviews.append({
            'point': str(r.get('point') or '')[:80],
            'state': str(r.get('state') or '待验证'),
            'evidence': str(r.get('evidence') or '')[:180],
        })
    events = []
    for e in (c.get('events') or [])[:5]:
        if isinstance(e, str):
            e = {'t': e, 'd': ''}
        events.append({'t': str(e.get('t') or '')[:80], 'd': str(e.get('d') or '')[:180]})
    return {
        'date': time.strftime('%Y-%m-%d', bj_now()),
        'slot': at,
        'kind': 'fixed' if slot != 'event' else 'event',
        'ref': meta['ref'] if slot != 'event' else 'auto',
        'label': meta['label'],
        'name': meta['name'],
        'at': at,
        'status': str(c.get('status') or '待验证'),
        'reviews': reviews,
        'events': events,
        'change': str(c.get('change') or '')[:300],
        'model': model,
        'diag': diag,
    }


def event_reasons(facts, daily):
    """事件插播硬触发：有真异动才出，没触发就静默退出。"""
    if not facts or not daily:
        return []
    existing = [x for x in (daily.get('intraday') or [])
                if x.get('date') == time.strftime('%Y-%m-%d', bj_now())
                and x.get('kind') == 'event']
    if len(existing) >= 2:
        print('[盘中] 今日事件插播已达 2 条上限，跳过')
        return []
    reasons = []
    for name, v in (facts.get('A股指数') or {}).items():
        try:
            if abs(float((v or {}).get('pct') or 0)) >= 0.8:
                reasons.append('%s 涨跌 %.2f%%' % (name, float(v['pct'])))
        except Exception:
            pass
    for key in ('行业涨幅前6', '行业跌幅前6'):
        for s in (facts.get(key) or []):
            try:
                if abs(float(s.get('pct') or 0)) >= 3:
                    reasons.append('%s %.2f%%' % (s.get('name') or s.get('ind') or '行业',
                                                  float(s['pct'])))
            except Exception:
                pass
    resonance = [e for e in (facts.get('期间事件') or []) if (e.get('n') or 0) >= 5]
    if len(resonance) >= 2:
        reasons.append('%d 条事件多源共振（≥5源）' % len(resonance))
    reasons = reasons[:3]
    print('[盘中] 触发检查：%s' % (reasons or '无异动，跳过'))
    return reasons


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--slot', choices=['am_flash', 'pm_flash', 'event'], required=True)
    ap.add_argument('--model', default=os.environ.get('LLM_MODELS') or 'glm-4.7')
    ap.add_argument('--force', action='store_true', help='事件档跳过触发阈值，人工补跑用')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    now = bj_now()
    raw, sha, err = gr.read_remote('daily.js')
    daily = gr.parse_daily(raw.decode('utf-8', 'ignore')) if raw else None
    if not daily:
        print('[盘中] 读取 daily.js 失败：%s' % err)
        return 1
    today = time.strftime('%Y-%m-%d', now)
    if daily.get('date') != today:
        print('[盘中] daily.js 还是 %s 的数据，等三报更新后再插播' % daily.get('date'))
        return 0

    ref = SLOT_META[args.slot]['ref']
    if args.slot == 'event':
        mins = now.tm_hour * 60 + now.tm_min
        ref = 'morning' if mins < 690 else 'noon'
    prior = prior_conclusions(daily, ref)
    facts, diag, events = build_light_facts(args.slot, prior)

    if args.slot == 'event' and not args.force:
        reasons = event_reasons(facts, daily)
        if not reasons:
            return 0
        facts['触发原因'] = reasons
        prior = prior or {'note': '事件插播：对照当日最近一档主报告'}

    content, model, verr = call_intraday(facts, args.slot, args.model)
    if not content:
        print('[盘中] 生成失败：%s' % verr)
        return 1

    at = SLOT_META[args.slot]['at'] or time.strftime('%H:%M', now)
    entry = normalize_entry(content, args.slot, at, model, diag)
    if args.slot == 'event':
        entry['ref'] = ref
        entry['label'] = '[对照早报]' if ref == 'morning' else '[对照午评]'

    arr = [x for x in (daily.get('intraday') or [])
           if x.get('date') == today and x.get('slot') != at]
    arr.append(entry)
    arr = arr[-8:]
    daily['intraday'] = arr
    js = 'window.AB_DAILY = ' + json.dumps(daily, ensure_ascii=False, indent=1) + ';\n'

    print('[盘中] slot=%s at=%s model=%s 对照=%s 事件=%d'
          % (args.slot, at, model, ref, len(entry['events'])))
    print('[盘中] 状态=%s 变更=%s' % (entry['status'], entry['change']))
    if args.dry_run:
        print(js[-4000:])
        return 0
    ok, st, e2 = gr.write_remote('daily.js', js.encode('utf-8'),
                                 'intraday(%s): %s %s via %s' % (args.slot, today, at, model))
    print('[盘中] 推送 daily.js -> %s' % ('OK' if ok else 'FAIL %s %s' % (st, e2)))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
