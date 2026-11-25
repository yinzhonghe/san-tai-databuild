# -*- coding: utf-8 -*-
"""超跌反弹「启动·新发」自进化 —— 离线大模型假设生成器（只提假设，不改打分）。

设计红线（务必遵守）：
  1) 证据门槛：已结算样本 < MIN_SETTLED 时直接退出，不发任何网络请求、不产生费用。
     目的：现在接好通道但不跑，等真实前瞻样本攒够再启用；绝不拿零样本让模型编规律。
  2) 模型只做两件事：失败归因 + 候选规则假设。产出全部标 status=candidate，
     写进独立文件 learn/limitup_evolution.json，绝不改写 limitup_rules.json / limitup_data.js。
  3) 候选规则必须经过 tools/limitup_live.js 既有的 walk-forward + 三组对照 + 自动回退
     验证后，才可能被采纳为打分条件；本脚本不碰那条链路，也不给它塞结论。
  4) 只用真实字段（见 FEATURES），提示词里明确禁止模型编造数据或字段。
  5) 模型固定用最新旗舰 glm-5.3，不含 glm-4.7（用户明确要求）。

用法：
  python github_ci/evolve_llm.py --dry-run            # 只检查门槛/事实包，不调 API
  python github_ci/evolve_llm.py                       # 门槛达到才调模型
  python github_ci/evolve_llm.py --force --model glm-5.3   # 强制跑（调试，仍写候选文件）

环境变量：LLM_API_KEY（必需）、LLM_API_BASE（可选，默认智谱）、LLM_MODELS（可选，覆盖模型）。
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
# 本地脚本在 github_ci/ 下（仓库根=上一级）；远端脚本在仓库根。两处都能定位到 learn/。
ROOT = _HERE if os.path.isdir(os.path.join(_HERE, 'learn')) else os.path.dirname(_HERE)
RULES_JSON = os.path.join(ROOT, 'learn', 'limitup_rules.json')
STATS_LOG = os.path.join(ROOT, 'learn', 'limitup_stats.jsonl')
OUT_JSON = os.path.join(ROOT, 'learn', 'limitup_evolution.json')

MIN_SETTLED = 200          # 与 limitup_live.js 的 highN 一致：低于此数不调用模型
DEFAULT_MODEL = 'glm-5.3'  # 智谱当前最新旗舰（官方文档 2026-11 确认），不用 4.7
API_BASE = os.environ.get('LLM_API_BASE') or 'https://open.bigmodel.cn/api/paas/v4/chat/completions'

CN_TZ = timezone(timedelta(hours=8))

# 只能基于这些真实存在的字段提假设（与 tools/limitup_live.js 的 TESTS/featOf 对齐）
FEATURES = [
    'bucket(新发/健康期/观察)', 'stateDays(启动第几日)', 'phaseWhy(降级原因:连板/走弱)',
    'resonance(六派票数 2/3/4+)', 'w5(5日涨幅)', 'w20(20日涨幅)', 'w60(60日涨幅)',
    'rrg(RRG象限)', 'fund(主力净流入,可为空)', 'volRatio(量比)', 'amtRatio(额比)',
    'signalChg(信号日涨跌)', 'turn(换手率%)', 'floatCap(流通市值亿)',
    'tradable(可成交,一字板不可成交)',
]
OUTCOMES = ['a:次日开盘可成交胜负', 'b:次日收盘胜负', 'c:T+5 结算胜负', 'd:止损优先胜负']


def now_cn():
    return datetime.now(CN_TZ).strftime('%Y-%m-%d %H:%M')


def load_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def settled_count(rules):
    """已结算样本数：优先 rules.sampleN，其次 stats 日志最后一条 settled。"""
    n = (rules.get('rules') or {}).get('sampleN')
    if isinstance(n, (int, float)) and n > 0:
        return int(n)
    try:
        last = None
        with open(STATS_LOG, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    d = json.loads(line)
                    if isinstance(d.get('settled'), (int, float)):
                        last = d
        if last:
            return int(last.get('settled') or 0)
    except Exception:
        pass
    return int(n or 0)


def build_facts(rules, stats_tail):
    """把真实统计压成事实包喂给模型；不包含任何编造或估算数字。"""
    r = rules.get('rules') or {}
    keys = ('sampleN', 'minN', 'highN', 'baseRate', 'baseN', 'ready', 'confidence', 'note',
            'items', 'criteria', 'byBucket', 'byDay', 'continuity', 'nextDay',
            'comparison', 'scoring', 'tree')
    facts = {k: r.get(k) for k in keys if k in r}
    facts['asOf'] = rules.get('asOf')
    facts['statsTail'] = stats_tail[-8:]
    facts['outcomes'] = OUTCOMES
    facts['availableFields'] = FEATURES
    return facts


def stats_tail(n=12):
    out = []
    try:
        with open(STATS_LOG, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
    except Exception:
        pass
    return out[-n:]


def system_prompt():
    return (
        '你是 A 股短线量化研究助理，为「启动·新发」自进化系统做离线复盘。'
        '你只能基于给定事实包做推理，禁止编造任何数据、字段或结论。\n'
        '任务两件：\n'
        '1) 失败归因：找出事实包里"看似有利却实际胜率不高于基准"的条件，'
        '用白话解释可能的失效原因（如样本偏差、追高、一字板不可成交、周期不同而失真）。\n'
        '2) 候选规则假设：提出至多 6 条【可验证】的新条件组合假设，'
        '每条必须写清：用到哪个真实字段、阈值、方向(正向/负向)、依据、'
        '以及"需要多少额外样本才能验证"。\n'
        '硬约束：\n'
        '- 只能使用 availableFields 列出的真实字段，不得引入封板时间/龙虎榜等系统当前没有的字段。\n'
        '- 事实包里数字为 0 或空的项，一律视为"数据不足"，不得解读成结论。\n'
        '- 你输出的每一条都是"候选假设"，不是投资建议，也不是已验证规律；'
        '系统会在真实前瞻样本上验证后才决定是否采纳。\n'
        '- 严格输出 JSON，不要输出 Markdown 代码块、不要任何解释性前后缀。\n'
        '输出格式：\n'
        '{"attribution":[{"condition":"条件key","why":"白话失效原因"}],'
        '"hypotheses":[{"when":"触发场景","field":"真实字段名","threshold":"阈值",'
        '"direction":"正向/负向","basis":"依据事实包哪个数字","verifyNeed":"需多少样本/什么验证","confidence":"低/中/高"}],'
        '"oneLine":"一句话给系统维护者：当前最该验证的方向"}'
    )


def user_prompt(facts, settled):
    return (
        '已结算真实样本数：%d（门槛 %d）。\n'
        '事实包（全部来自系统真实台账，0/空=数据不足）：\n%s\n'
        '请按系统提示词输出 JSON。'
        % (settled, MIN_SETTLED, json.dumps(facts, ensure_ascii=False)[:40000])
    )


def call_model(model, key, messages):
    body = {
        'model': model,
        'messages': messages,
        'temperature': 0.4,
        'max_tokens': 8000,
        'response_format': {'type': 'json_object'},
    }
    raw = json.dumps(body).encode('utf-8')
    delays = [0, 6, 20]
    last_err = ''
    for i, delay in enumerate(delays):
        if delay:
            time.sleep(delay)
        req = urllib.request.Request(API_BASE, data=raw, method='POST', headers={
            'Authorization': 'Bearer ' + key,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'san-tai-evolve-llm/1.0',
        })
        try:
            with urllib.request.urlopen(req, timeout=240) as resp:
                data = json.loads(resp.read().decode('utf-8', 'ignore'))
            ch = data['choices'][0]
            txt = (ch.get('message') or {}).get('content') or ''
            if not txt and (ch.get('message') or {}).get('reasoning_content'):
                txt = ch['message']['reasoning_content']
            txt = re.sub(r'^```(?:json)?|```$', '', txt.strip(), flags=re.M).strip()
            obj = json.loads(txt)
            return obj, data.get('usage'), None
        except urllib.error.HTTPError as e:
            last_err = 'HTTP %s' % e.code
            if e.code not in (429, 500, 502, 503, 504):
                break
        except Exception as e:
            last_err = '%s: %s' % (type(e).__name__, e)
            break
    return None, None, last_err


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='只检查门槛与事实包，不调 API')
    ap.add_argument('--force', action='store_true', help='忽略门槛强制跑（调试用），仍只写候选文件')
    ap.add_argument('--model', default=(os.environ.get('LLM_MODELS') or DEFAULT_MODEL).split(',')[0].strip())
    return ap.parse_args()


def main():
    args = parse_args()
    rules = load_json(RULES_JSON, {})
    settled = settled_count(rules)
    tail = stats_tail()
    model = args.model or DEFAULT_MODEL

    print('[evolve-llm] %s | 已结算=%d 门槛=%d | 模型=%s' % (now_cn(), settled, MIN_SETTLED, model))

    if settled < MIN_SETTLED and not args.force:
        # 关键：样本不足直接退出，绝不发网络请求、不产生费用
        print('[evolve-llm] 真实前瞻样本不足 %d 条（当前 %d），跳过本次调用。'
              '不发网络请求、不生成假设。' % (MIN_SETTLED, settled))
        print('[evolve-llm] 通道与脚本已就位，等 limitup_live.js 真实回填到门槛后自动/手动启用。')
        return 0

    facts = build_facts(rules, tail)
    print('[evolve-llm] 事实包字段: %s' % ','.join(facts.keys()))

    if args.dry_run:
        print('[evolve-llm] --dry-run：门槛检查通过，事实包已构建，未调用模型。')
        return 0

    key = (os.environ.get('LLM_API_KEY') or '').strip()
    if not key:
        sys.exit('[evolve-llm] 缺 LLM_API_KEY，无法调用模型')
    if '4.7' in model:
        sys.exit('[evolve-llm] 模型被拒绝：用户要求只用最新旗舰，不用 glm-4.7')

    messages = [
        {'role': 'system', 'content': system_prompt()},
        {'role': 'user', 'content': user_prompt(facts, settled)},
    ]
    print('[evolve-llm] 调用 %s ...' % model)
    obj, usage, err = call_model(model, key, messages)
    if err:
        sys.exit('[evolve-llm] 模型调用失败：%s' % err)

    out = {
        'at': now_cn(),
        'asOf': facts.get('asOf'),
        'model': model,
        'settled': settled,
        'threshold': MIN_SETTLED,
        'usage': usage,
        'status': 'candidate',
        'disclaimer': '全部为候选假设，未经真实前瞻验证；不构成投资建议。',
        'gate': '候选规则须经 tools/limitup_live.js 的 walk-forward + 三组对照 + 自动回退验证后才可能进打分；本文件不改打分。',
        'result': obj,
    }
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print('[evolve-llm] 候选假设已写入 %s（status=candidate，不影响打分）' % OUT_JSON)
    print('[evolve-llm] 一句话：%s' % (obj.get('oneLine') or '（模型未给）'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
