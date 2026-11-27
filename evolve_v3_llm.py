# -*- coding: utf-8 -*-
"""三态自进化 v3 · 大模型假设生成器（种群演化版）
=====================================================
与 v1（六派权重）/v2（单条规则候选）独立，供 v2 引擎的种群演化使用。

定稿依据（2026-11-26 三轮 grill-me）：
  - T1/T2：模型只改「外部策略+受限外壳」，禁改裁判；constitution 冻结锚点（本脚本只读不写）。
  - T3/T4：额度闸（每天最多1次主调用+3轮现场加练，token上限）、调用审计日志。
  - M4：输出「带占位符的策略草图」，系统展开30~50变体后送 kernel，禁止先看结果倒推。
  - M2：needTestTime=true（连续3代全灭）时，才允许现场加练（最多3轮）。
  - C：模型可造新特征，但只能写成受限表达式（白名单函数），必须声明 reproducibility。
  - 红线：status=candidate，只写 llm_candidates_v3.json，绝不写 registry/population/constitution。

用法：
  python github_ci/evolve_v3_llm.py --dry-run     # 查触发条件/额度闸/事实包，不调 API
  python github_ci/evolve_v3_llm.py               # 满足触发才调模型
  python github_ci/evolve_v3_llm.py --force       # 调试强制（仍写 candidate）
环境变量：LLM_API_KEY（必需）、LLM_API_BASE、LLM_MODELS
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
ROOT = _HERE if os.path.isdir(os.path.join(_HERE, 'learn')) else os.path.dirname(_HERE)
EVO = os.path.join(ROOT, 'learn', 'evolve')
POP = os.path.join(EVO, 'population.json')
CONST = os.path.join(EVO, 'constitution.json')
HB = os.path.join(EVO, 'heartbeat.json')
GAPS = os.path.join(EVO, 'panel_gaps.json')
HUNTER = os.path.join(EVO, 'data_sources.json')
OUT = os.path.join(EVO, 'llm_candidates_v3.json')
CALL_LOG = os.path.join(EVO, 'llm_call_log.jsonl')
TRIGGER = os.path.join(EVO, 'llm_trigger_v3.json')

DEFAULT_MODEL = 'glm-5.3-flash'
API_BASE = os.environ.get('LLM_API_BASE') or 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
CN_TZ = timezone(timedelta(hours=8))

# 白名单：与 expr.js / features.js 同步，模型只能用这些
FEATURES = [
    'volSqueeze20', 'volSqueeze60', 'volRatio5', 'volRamp', 'pvrDiv',
    'rsSlope', 'rsSlope20', 'breakout20', 'pullback20', 'maGap20', 'maGap60',
    'bodyRatio', 'closePos', 'gapPct', 'consecDown', 'streakLimit',
    'ret5', 'ret20', 'ret60', 'amtTrend'
]
FEATURE_DEFS = {
    'volSqueeze20': 'ATR5/ATR20，<1波动收缩', 'volSqueeze60': 'ATR10/ATR60',
    'volRatio5': '当日量/前5日均量', 'volRamp': '前5日均量/前20日均量',
    'pvrDiv': '量价背离度=ret5-10*(volRamp-1)',
    'rsSlope': '个股ret10*2-行业ret10中位数', 'rsSlope20': '个股ret20-行业ret20中位数',
    'breakout20': '收盘/前20日高点-1', 'pullback20': '收盘/近20日高点-1',
    'maGap20': '收盘/MA20-1', 'maGap60': '收盘/MA60-1',
    'bodyRatio': '|收-开|/(高-低)', 'closePos': '(收-低)/(高-低)',
    'gapPct': '开/前收-1', 'consecDown': '连阴天数', 'streakLimit': '连板数',
    'ret5': '5日涨幅%', 'ret20': '20日涨幅%', 'ret60': '60日涨幅%',
    'amtTrend': '|ret5|*volRamp'
}
WHITELIST_FUNCS = ['abs', 'min', 'max', 'sqrt', 'sign', 'log1p', 'clamp', 'rank']
OPS = ['>', '>=', '<', '<=', 'between']


def now_cn():
    return datetime.now(CN_TZ)


def load_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def budget_check(trigger, force=False):
    """额度闸（T3）：每天最多1次主调用+3轮加练；超限直接拒绝。
       返回 (allowed, reason, counter)"""
    cons = load_json(CONST, {})
    b = cons.get('budget') or {}
    max_calls = int(b.get('llmCallsPerDayMax') or 1)
    max_rounds = int(b.get('testTimeRoundsMax') or 3)
    today = now_cn().strftime('%Y-%m-%d')
    c = load_json(trigger, {})
    if c.get('date') != today:
        c = {'date': today, 'calls': 0, 'rounds': 0}
    if force:
        return True, 'force（调试强制）', c
    if c['calls'] >= max_calls and c['rounds'] >= max_rounds:
        return False, '今日额度耗尽：主调用 %d/%d、加练 %d/%d' % (c['calls'], max_calls, c['rounds'], max_rounds), c
    if c['calls'] >= max_calls:
        return False, '今日主调用已用尽（%d/%d），加练需 needTestTime 触发' % (c['calls'], max_calls), c
    return True, '额度内：主调用 %d/%d' % (c['calls'], max_calls), c


def should_trigger(hb, pop, force=False):
    """触发：本地跑完一代（heartbeat=done）且 needTestTime 或 首批无候选；或 force。"""
    if force:
        return True, 'force'
    h = hb.get('status')
    if h not in ('done', 'published'):
        return False, '本地尚未跑完当天一代（心跳=%s）' % (h or 'none')
    if hb.get('needTestTime'):
        return True, '连续3代全灭→现场课程加练（最多3轮）'
    if not os.path.exists(OUT):
        return True, '首批候选为空'
    return False, '当天已有候选且未触发加练'


def build_facts(pop, cons, hb, gaps, hunter):
    rules = (pop.get('rules') or [])
    recent = []
    for r in rules[-12:]:
        m = r.get('lastMetrics') or {}
        recent.append({
            'id': r.get('id'), 'desc': r.get('desc'), 'status': r.get('status'),
            'when': r.get('when'), 'expect': r.get('expect'),
            'netRet3': m.get('netRet3'), 'winRate': m.get('winRate'),
            'tStat': m.get('tStat'), 'worstSegment': m.get('worstSegmentNet'),
            'hardGate': r.get('hardGate'), 'softJudge': r.get('softJudge'),
            'elo': r.get('elo'), 'lineage': r.get('lineage')
        })
    # 只给模型看真实统计（netRet3 为负说明亏钱），不喂未验证数字
    base = (cons.get('baseline') or {})
    return {
        'constitution': {
            'goal': cons.get('goal'), 'hardGate': (cons.get('target') or {}).get('hardGate'),
            'costPct': (cons.get('costModel') or {}).get('totalRoundTripPct'),
            'baseline': {k: base.get(k) for k in ('signalRet3', 'winRate', 'n', 'note')},
            'minTStat': (cons.get('multipleTesting') or {}).get('minTStat')
        },
        'population': {
            'generation': pop.get('generation'), 'total': len(rules),
            'trialTotal': pop.get('trialTotal'), 'recentRules': recent,
            'needTestTime': hb.get('needTestTime', False)
        },
        'featureDefs': FEATURE_DEFS,
        'exprFuncs': WHITELIST_FUNCS,
        'ops': OPS,
        'dataGaps': {k: gaps.get(k) for k in ('noIndustry', 'shortHistory', 'noVolume')},
        'sources': {k: v.get('status') for k, v in hunter.items()},
        'rules': [
            '禁止编造特征字段或数值；只能用 featureDefs 与 exprFuncs',
            '输出【草图骨架】：阈值用 @P1/@P2 占位，系统会展开30~50变体送验证器',
            '新特征写成受限表达式（如 abs(ret5) 或 clamp(pvrDiv,-5,5)），必须声明可复现性',
            '若需要当前没有的数据（资金/舆情/龙虎榜），在 dataNeeds 声明字段名+理由，不要假设有值',
            '全部是候选假设，验证器会独立裁判；自然语言解释不计入证据包'
        ]
    }


def system_prompt():
    return (
        '你是 A 股短线量化研究助理，为种群演化自进化系统产出【候选策略草图】。\n'
        '硬约束：\n'
        '- baseline 信号级净收益为负（追启动整体亏钱），你要找的是能把净收益转正且跑赢基准的条件。\n'
        '- 输出草图骨架：when 条件里的阈值写成 "@P1" "@P2" 占位符，系统会自动展开成阈值网格变体。\n'
        '- 若造新特征，只能写成受限表达式：白名单函数 ' + ','.join(WHITELIST_FUNCS) +
        ' + 已注册特征 + 四则运算；禁止自由代码/分号/访问文件网络。\n'
        '- 每条草图写 basis（依据哪个真实统计）、dataNeeds（缺什么数据）、verifyNeed（样本需求）。\n'
        '- 至多 5 条草图；全部 status=candidate；不构成投资建议。\n'
        '- 严格输出 JSON，无 Markdown 代码块、无前后缀。\n'
        '输出格式：\n'
        '{"sketches":[{"desc":"策略白话","when":[{"f":"volSqueeze20","op":"<","v":"@P1"},'
        '{"f":"volRatio5","op":"between","lo":"between","hi":"between"}],'
        '"unless":[],"expect":"up","newFeatures":[{"name":"xxx","expr":"abs(ret5)","reproducible":true}],'
        '"dataNeeds":[],"basis":"依据...","verifyNeed":"需N样本"}],'
        '"oneLine":"当前最该验证的方向","weakestLink":"证据里最弱的一环"}'
    )


def parse_content(txt):
    """稳健解析模型文本：剥 markdown 代码块、截取 JSON 主体。返回 (obj, err)。"""
    if not txt:
        return None, '空内容（可能思考链吃满 max_tokens）'
    s = txt.strip()
    m = re.search(r'```(?:json|JSON)?\s*([\s\S]*?)\s*```', s)
    if m:
        s = m.group(1).strip()
    candidates = [s]
    a, b = s.find('{'), s.rfind('}')
    if a >= 0 and b > a:
        candidates.append(s[a:b + 1])
    last = ''
    for c in candidates:
        try:
            return json.loads(c), None
        except Exception as e:
            last = str(e)
    return None, 'JSON解析失败(%s): %s' % (last, s[:160].replace('\n', ' '))


def call_model(model, key, messages, max_tokens):
    body = {'model': model, 'messages': messages, 'temperature': 0.4,
            'max_tokens': max_tokens, 'response_format': {'type': 'json_object'}}
    raw = json.dumps(body).encode('utf-8')
    last_err = ''
    usage = None
    for delay in (0, 6, 20):
        if delay:
            time.sleep(delay)
        req = urllib.request.Request(API_BASE, data=raw, method='POST', headers={
            'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
            'Accept': 'application/json', 'User-Agent': 'san-tai-evolve-v3/1.0'})
        try:
            with urllib.request.urlopen(req, timeout=240) as resp:
                raw_resp = resp.read().decode('utf-8', 'ignore')
            try:
                data = json.loads(raw_resp)
            except Exception:
                print('[evolve-v3] API 非JSON响应(前400字): ' + raw_resp[:400].replace('\n', ' '), flush=True)
                last_err = 'API 非JSON响应: ' + raw_resp[:120].replace('\n', ' ')
                break
            usage = data.get('usage')
            ch = data['choices'][0]
            msg = ch.get('message') or {}
            txt = msg.get('content') or ''
            if not txt and msg.get('reasoning_content'):
                txt = msg['reasoning_content']
            obj, perr = parse_content(txt)
            if perr:
                last_err = perr
                if '空内容' in perr:
                    continue
                break
            return obj, usage, None
        except urllib.error.HTTPError as e:
            ebody = ''
            try: ebody = e.read().decode('utf-8', 'ignore')[:300].replace('\n', ' ')
            except Exception: pass
            last_err = 'HTTP %s %s' % (e.code, ebody)
            if e.code not in (429, 500, 502, 503, 504):
                break
        except Exception as e:
            last_err = '%s: %s' % (type(e).__name__, e)
            break
    return None, usage, last_err


def audit(reason, model, usage, err):
    rec = {'at': now_cn().isoformat(), 'reason': reason, 'model': model,
           'usage': usage, 'error': err}
    os.makedirs(os.path.dirname(CALL_LOG), exist_ok=True)
    with open(CALL_LOG, 'a', encoding='utf-8') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--model', default=(os.environ.get('LLM_MODELS') or DEFAULT_MODEL).split(',')[0].strip())
    args = ap.parse_args()

    pop = load_json(POP, {})
    cons = load_json(CONST, {})
    hb = load_json(HB, {})
    gaps = load_json(GAPS, {})
    hunter = load_json(HUNTER, {})
    allowed, budget_reason, counter = budget_check(TRIGGER, args.force)
    fire, trigger_reason = should_trigger(hb, pop, args.force)
    print('[evolve-v3] %s | gen=%s | 触发=%s(%s) | 额度=%s(%s) | 模型=%s' % (
        now_cn().strftime('%Y-%m-%d %H:%M'), pop.get('generation'), fire, trigger_reason,
        allowed, budget_reason, args.model))
    if args.dry_run:
        facts = build_facts(pop, cons, hb, gaps, hunter)
        print('[evolve-v3] dry-run：事实包键 %s' % ','.join(facts.keys()))
        return 0
    if not (fire and allowed):
        print('[evolve-v3] 未触发或额度不足：不调用模型')
        return 0
    key = (os.environ.get('LLM_API_KEY') or '').strip()
    if not key:
        sys.exit('[evolve-v3] 缺 LLM_API_KEY')
    if '4.7' in args.model:
        sys.exit('[evolve-v3] 拒绝 glm-4.7')

    facts = build_facts(pop, cons, hb, gaps, hunter)
    max_tokens = int((cons.get('budget') or {}).get('maxTokensPerCall') or 8000)
    obj, usage, err = call_model(args.model, key, [
        {'role': 'system', 'content': system_prompt()},
        {'role': 'user', 'content': '事实包（真实台账）：\n' + json.dumps(facts, ensure_ascii=False)[:50000]}], max_tokens)
    audit(trigger_reason, args.model, usage, err)
    if err:
        sys.exit('[evolve-v3] 模型调用失败：%s' % err)

    out = {
        'at': now_cn().strftime('%Y-%m-%d %H:%M'), 'model': args.model, 'usage': usage,
        'status': 'candidate', 'generation': pop.get('generation'), 'trigger': trigger_reason,
        'disclaimer': '候选草图，未经 kernel 验证；不构成投资建议。',
        'gate': '系统展开30~50变体→kernel硬验证→settle信号级结算→softJudge；本文件不改population/constitution',
        'result': obj
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write('\n')
    # 更新额度计数
    counter['calls'] = int(counter.get('calls') or 0) + 1
    counter['date'] = now_cn().strftime('%Y-%m-%d')
    with open(TRIGGER, 'w', encoding='utf-8') as f:
        json.dump(counter, f, ensure_ascii=False, indent=2)
    print('[evolve-v3] 候选草图已写入 %s' % OUT)
    print('[evolve-v3] 一句话：%s' % (obj.get('oneLine') or '（模型未给）'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
