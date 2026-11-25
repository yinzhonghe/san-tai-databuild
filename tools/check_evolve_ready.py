# -*- coding: utf-8 -*-
"""检查「启动·新发」自进化的真实样本是否攒够，输出结构化进度。

供每日自动化调用；只读台账，不改规则、不调模型、不花钱。
达标判定）：
  - main   已结算主样本 >= 200  （LLM 假设生成的证据门槛）
  - watch  首板预警已结算 >= 15
  - observe 启动观察组已结算 >= 15
首次达标会写 learn/evolve_ready_flags.json 的 reminded 标记，避免天天重复提醒。
"""
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LEARN = os.path.join(ROOT, 'learn')
RULES_JSON = os.path.join(LEARN, 'limitup_rules.json')
STATS_LOG = os.path.join(LEARN, 'limitup_stats.jsonl')
DATA_JS = os.path.join(ROOT, 'limitup_data.js')
FLAGS_JSON = os.path.join(LEARN, 'evolve_ready_flags.json')

THRESHOLDS = {'main': 200, 'watch': 15, 'observe': 15}
CN_TZ = timezone(timedelta(hours=8))


def load_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def number(v):
    return int(v) if isinstance(v, (int, float)) and v > 0 else 0


def tail_stats():
    out = []
    try:
        with open(STATS_LOG, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
    except Exception:
        pass
    return out[-200:]


def last_of(rows, typ):
    for d in reversed(rows):
        if (d.get('type') or '') == typ:
            return d
    return {}


def counts():
    rules = load_json(RULES_JSON, {})
    r = rules.get('rules') or {}
    stats = tail_stats()
    data = {}
    try:
        s = open(DATA_JS, encoding='utf-8').read()
        m = re.search(r'window\.AB_LIMITUP\s*=\s*(\{.*\})\s*;', s, re.S)
        if m:
            data = json.loads(m.group(1))
    except Exception:
        pass

    main = number(r.get('sampleN')) or number(last_of(stats, '').get('settled'))
    watch_stat = ((data.get('watchlist') or {}).get('stats') or {})
    watch = number(watch_stat.get('settled')) or number(last_of(stats, 'watch').get('settled'))
    obs_stat = (data.get('observeStats') or {})
    observe = number(obs_stat.get('n')) or number(last_of(stats, 'observe').get('n'))
    return {'main': main, 'watch': watch, 'observe': observe}


def main():
    counts_now = counts()
    flags = load_json(FLAGS_JSON, {})
    reminded = set(flags.get('reminded') or [])
    ready = {k: counts_now[k] >= need for k, need in THRESHOLDS.items()}
    newly = [k for k in ('main', 'watch', 'observe') if ready[k] and k not in reminded]
    if newly:
        reminded.update(newly)
    out = {
        'at': datetime.now(CN_TZ).strftime('%Y-%m-%d %H:%M'),
        'counts': counts_now,
        'thresholds': THRESHOLDS,
        'ready': ready,
        'newly_ready': newly,
        'llm_gate_open': ready['main'],
        'note': ('主样本已到 200 条，可手动触发 evolve.yml 生成候选假设；'
                 '候选仍须 walk-forward + 三组对照验证才会进打分。') if ready['main']
                else '主样本未到 200 条，不调用模型；观察组/预警组独立累计。',
    }
    try:
        os.makedirs(LEARN, exist_ok=True)
        with open(FLAGS_JSON, 'w', encoding='utf-8') as f:
            json.dump({'reminded': sorted(reminded), 'last': out}, f, ensure_ascii=False, indent=2)
            f.write('\n')
    except Exception:
        pass
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
