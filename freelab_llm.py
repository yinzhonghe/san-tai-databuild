# -*- coding: utf-8 -*-
"""自由推演实验室 · 大模型自由假设生成器
============================================================
与 v2 证据包自进化【平行独立】。核心区别：
  - v3_llm：模型只能产出「白名单草图骨架 + @P 占位符」，戴镣铐跳舞；
  - 本脚本：模型读到完整的【市场画像】（每个特征分档的真实净收益、月度/行业切片、
    基线、数据缺口），被要求【完全自由推演】——可以对任意数据整理、跨特征组合、
    造新特征表达式、提市场状态机/分域模型，甚至提纯叙事假设。
    自由度在「假设」，严格度交给 verify.js 的真实回测。

红线：
  - 只读 constitution.json（封印），绝写不得；不写 population/heartbeat。
  - 只用 facts.json 里的真实统计做推理，禁止编造数值；需要新数据在 dataNeeds 声明。
  - 产物 status=candidate，append 到 models.jsonl，是否「跑出模型」由 verify.js 用真金白银判定。
  - 独立额度闸 + 审计日志；无 LLM_API_KEY 时 --dry-run 只打印画像摘要，不编造模型。

用法：
  python github_ci/freelab_llm.py --dry-run     # 查画像/额度，不调 API
  python github_ci/freelab_llm.py               # 满足触发才调模型
  python github_ci/freelab_llm.py --force       # 调试强制（仍只是候选）
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
LAB = os.path.join(EVO, 'freelab')
CONST = os.path.join(EVO, 'constitution.json')
FACTS = os.path.join(LAB, 'facts.json')
MODELS = os.path.join(LAB, 'models.jsonl')
CALL_LOG = os.path.join(LAB, 'llm_call_log.jsonl')
TRIGGER = os.path.join(LAB, 'llm_trigger.json')

DEFAULT_MODEL = 'glm-5.3-flash'
API_BASE = os.environ.get('LLM_API_BASE') or 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
CN_TZ = timezone(timedelta(hours=8))


def now_cn():
    return datetime.now(CN_TZ)


def load_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def budget_check(trigger, force=False):
    """独立额度闸：每天最多 1 次自由推演主调用；超限拒绝。"""
    cons = load_json(CONST, {})
    b = cons.get('budget') or {}
    max_calls = int(b.get('llmCallsPerDayMax') or 1)
    today = now_cn().strftime('%Y-%m-%d')
    c = load_json(trigger, {})
    if c.get('date') != today:
        c = {'date': today, 'calls': 0}
    if force:
        return True, 'force（调试强制）', c
    if int(c.get('calls') or 0) >= max_calls:
        return False, '今日自由推演额度已用尽（%d/%d）' % (c.get('calls'), max_calls), c
    return True, '额度内 %d/%d' % (c.get('calls'), max_calls), c


def system_prompt():
    return (
        '你是一名 A 股短线量化研究员，正在一个【自由推演实验室】里工作。\n'
        '你会收到一份由真实历史样本整理出的「市场画像」：每个技术特征的取值分 5 档，'
        '每档的信号级净收益/胜率/相对基线超额都已算好；另有按月份、按行业的切片，以及数据缺口。'
        '这些数字是真实的，已扣交易成本、已剔除买不进的一字板。\n\n'
        '【你和普通自进化系统的根本区别：你被允许完全自由发挥】\n'
        '1. 你不局限于六派理论，也不局限于现成的特征组合。可以对任意维度的数据整理、推演、推理。\n'
        '2. 你可以提出任何形态的模型：单条件、多条件组合、市场状态机、分域/分时段模型、'
        '跨特征交互、新特征表达式，或纯叙事性的市场洞察。\n'
        '3. 若造新特征，写成受限表达式：白名单函数 abs/min/max/sqrt/sign/log1p/clamp/rank + '
        '画像里已给的特征名 + 四则运算；禁止自由代码/分号/访问文件网络；并声明 reproducible=true。\n'
        '4. 若提出可执行规则，用 when:[{f,op,v}] / unless:[...] / expect:up|down，'
        'f 必须是画像里出现的特征名或你声明的新特征名；op 取 > >= < <= between isUp isDown；'
        'between 用 lo/hi；必须写 deps。\n'
        '5. 若需要画像里没有的数据（资金流/一字板历史/舆情/龙虎榜），在 dataNeeds 声明字段名+理由，'
        '不要假设它有值，更不要编造数值。\n'
        '6. 纯叙事、暂时无法回测的模型也要保留，但 modelType 写 "narrative"，rule 留空——'
        '验证器会明确标注「自由假设·未工程化」，不会当成跑出的模型。\n\n'
        '【四时间维度分类——强制】每条模型必须声明 horizon，四个维度都要推演：\n'
        '- horizon="month"：按月操作，T收盘买→T+20收盘卖（约1个月），抓中期结构。\n'
        '- horizon="week"：按周操作，T收盘买→T+5收盘卖。\n'
        '- horizon="day"：按日操作，T收盘买→T+1收盘卖（次日）。\n'
        '- horizon="intradayT0"：T0ETF/日内，T开盘买→T收盘卖，只对支持T+0的ETF放行；'
        '若你的假设用不到ETF或没有日内逻辑，不要硬填这个维度。\n'
        '画像里 horizons 字段给了四个维度各自的真实基准净收益/胜率/t值，'
        '你的规则要在对应维度上跑赢该维度基准，不是跑赢T+3基准。\n'
        '四个维度各至少提 1 条（至多 8 条），每条 thesis 要说清「为什么这个持有期适合这条假设」——'
        '月线看结构延续、周线看资金节奏、日线看情绪修复、日内看ETF折溢价与T+0规则。\n\n'
        '【诚实原则】四个维度的基线净收益都是负的（追启动整体亏钱，持有越久亏越多）。'
        '你要找能把净收益转正且跑赢【对应维度】基准的条件。'
        '不要把少数样本碰巧的高收益当成规律；样本量、覆盖率、稳健性都会被独立验证器严格检查。\n'
        '每条模型写清：thesis（假设）、mechanism（为什么）、falsifier（什么情况证明你错）、'
        'confidence（low/mid/high）、dataUsed（用了画像里的哪些数据）。\n'
        '至多 8 条模型；严格输出 JSON，无 Markdown 代码块、无前后缀。\n'
        '输出格式：\n'
        '{"models":[{"name":"模型名","modelType":"rule|expression|narrative",'
        '"horizon":"month|week|day|intradayT0",'
        '"thesis":"一句话假设","mechanism":"推演逻辑","falsifier":"证伪条件",'
        '"confidence":"low|mid|high","dataUsed":["特征名"],'
        '"rule":{"desc":"","when":[{"f":"volSqueeze20","op":"<","v":0.85}],"unless":[],'
        '"expect":"up","deps":["high","low","close"]},'
        '"newFeatures":[{"name":"xxx","expr":"abs(ret5)","reproducible":true}],'
        '"dataNeeds":[]}],'
        '"oneLine":"当前最值得验证的方向一句话","frontier":"下一步该往哪推演",'
        '"horizonNotes":{"month":"...","week":"...","day":"...","intradayT0":"..."}}'
    )


def build_user_prompt(facts):
    """把市场画像压成事实包喂给模型；只给真实统计，截断防超长。"""
    b = facts.get('baseline') or {}
    feat = facts.get('features') or {}
    # 画像压缩：每个特征保留 label/formula/coverage/最强最弱档 + 5 档净收益
    feat_pack = {}
    for k, v in feat.items():
        feat_pack[k] = {
            'label': v.get('label'), 'formula': v.get('formula'),
            'coverage': v.get('coverage'),
            'best': [v.get('bestBucket'), v.get('bestNet')],
            'worst': [v.get('worstBucket'), v.get('worstNet')],
            'spread': v.get('spread'),
            'buckets': [{'q': x.get('bucket'), 'lo': x.get('lo'), 'hi': x.get('hi'),
                         'net': x.get('net'), 'win': x.get('winRate'), 'n': x.get('n')}
                        for x in (v.get('buckets') or [])]
        }
    pack = {
        'baseline': {
            'measuredNet': b.get('measuredNet'), 'winRate': b.get('measuredWinRate'),
            'constitutionNet': b.get('constitutionNet'), 'samples': b.get('samples'),
            'tradable': b.get('tradable'), 'costPct': b.get('costPct'),
            'skippedOneWord': b.get('skippedOneWord'), 'skippedNoData': b.get('skippedNoData')
        },
        'window': facts.get('window'),
        'dataAsOf': facts.get('dataAsOf'),
        'featurePortrait': feat_pack,
        'byMonth': facts.get('byMonth'),
        'byIndustry': (facts.get('byIndustry') or [])[:15],
        # 四时间维度真实基准（月/周/日/日内T0），让模型按维度推演并对齐各自基准
        'horizons': facts.get('horizons'),
        'gaps': facts.get('gaps'),
        'availableFeatures': list(feat.keys()),
        'whitelistFuncs': ['abs', 'min', 'max', 'sqrt', 'sign', 'log1p', 'clamp', 'rank']
    }
    return ('以下是【真实市场画像】（来自历史样本信号级结算，已扣成本、一字板剔除）。'
            '请自由推演，提出你认为能把净收益转正且跑赢基准的模型：\n'
            + json.dumps(pack, ensure_ascii=False)[:60000])


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
    body = {'model': model, 'messages': messages, 'temperature': 0.6,
            'max_tokens': max_tokens, 'response_format': {'type': 'json_object'}}
    raw = json.dumps(body).encode('utf-8')
    last_err = ''
    usage = None
    for delay in (0, 6, 20):
        if delay:
            time.sleep(delay)
        req = urllib.request.Request(API_BASE, data=raw, method='POST', headers={
            'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
            'Accept': 'application/json', 'User-Agent': 'san-tai-freelab/1.0'})
        try:
            with urllib.request.urlopen(req, timeout=240) as resp:
                raw_resp = resp.read().decode('utf-8', 'ignore')
            try:
                data = json.loads(raw_resp)
            except Exception:
                # 2026-11-27：响应非 JSON = 网关/鉴权/额度错误页，重试无意义，直接失败并留诊断。
                # 绝不打印 key；只截响应体前 400 字。
                print('[freelab] API 非JSON响应(前400字): ' + raw_resp[:400].replace('\n', ' '), flush=True)
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
                # 纯空内容可能是思考链偶发吃满，值得重试一次；格式错误不重试。
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
    # 2026-11-27：即使解析失败也透传 usage —— 调用已真实发生，token 必须记账。
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

    facts = load_json(FACTS, None)
    if not facts:
        sys.exit('[freelab] 缺 facts.json：请先运行 node tools/evolve/freelab/facts.js')
    cons = load_json(CONST, {})
    allowed, budget_reason, counter = budget_check(TRIGGER, args.force)
    print('[freelab] %s | 数据基准=%s | 额度=%s(%s) | 模型=%s' % (
        now_cn().strftime('%Y-%m-%d %H:%M'), facts.get('dataAsOf'),
        allowed, budget_reason, args.model))
    print('[freelab] 画像特征 %d 个，样本 %s，已测净收益 %s%%' % (
        len(facts.get('features') or {}), (facts.get('baseline') or {}).get('samples'),
        (facts.get('baseline') or {}).get('measuredNet')))
    if args.dry_run:
        print('[freelab] dry-run：不调 API，不生成模型。真实画像已就绪。')
        return 0
    if not allowed:
        print('[freelab] 额度不足：不调用模型')
        return 0
    key = (os.environ.get('LLM_API_KEY') or '').strip()
    if not key:
        sys.exit('[freelab] 缺 LLM_API_KEY：无密钥不编造模型，只保留真实市场画像。')
    if '4.7' in args.model:
        sys.exit('[freelab] 拒绝 glm-4.7')

    max_tokens = int((cons.get('budget') or {}).get('maxTokensPerCall') or 8000)
    obj, usage, err = call_model(args.model, key, [
        {'role': 'system', 'content': system_prompt()},
        {'role': 'user', 'content': build_user_prompt(facts)}], max_tokens)
    audit('free_reasoning', args.model, usage, err)
    if err:
        sys.exit('[freelab] 模型调用失败：%s' % err)

    models = obj.get('models') or []
    stamp = now_cn().strftime('%Y-%m-%d %H:%M')
    os.makedirs(LAB, exist_ok=True)
    appended = 0
    for i, m in enumerate(models):
        rec = {
            'id': 'free_%s_%02d' % (now_cn().strftime('%Y%m%d'), i + 1),
            'at': stamp, 'origin': 'llm_free', 'model': args.model,
            'status': 'candidate',
            'modelType': m.get('modelType') or 'narrative',
            'horizon': m.get('horizon') or 'day',   # 四时间维度分类：month/week/day/intradayT0
            'name': m.get('name') or ('自由模型%d' % (i + 1)),
            'thesis': m.get('thesis') or '', 'mechanism': m.get('mechanism') or '',
            'falsifier': m.get('falsifier') or '', 'confidence': m.get('confidence') or 'low',
            'dataUsed': m.get('dataUsed') or [],
            'rule': m.get('rule') or None,
            'newFeatures': m.get('newFeatures') or [],
            'dataNeeds': m.get('dataNeeds') or [],
            'oneLine': obj.get('oneLine') or '', 'frontier': obj.get('frontier') or ''
        }
        with open(MODELS, 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        appended += 1

    counter['calls'] = int(counter.get('calls') or 0) + 1
    counter['date'] = now_cn().strftime('%Y-%m-%d')
    with open(TRIGGER, 'w', encoding='utf-8') as f:
        json.dump(counter, f, ensure_ascii=False, indent=2)

    print('[freelab] 已追加 %d 个自由模型候选（status=candidate，待 verify.js 真实验证）' % appended)
    print('[freelab] 四维度分布：%s' % json.dumps(
        {h: sum(1 for m in models if (m.get('horizon') or 'day') == h)
         for h in ('month', 'week', 'day', 'intradayT0')}, ensure_ascii=False))
    print('[freelab] 模型前沿：%s' % (obj.get('frontier') or '（模型未给）'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
