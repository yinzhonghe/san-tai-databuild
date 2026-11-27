# -*- coding: utf-8 -*-
"""
三态看盘 · 腾讯云函数 SCF 定时触发器（完整替代 Cloudflare Worker）
==================================================================
背景：GitHub Actions 的 schedule 是 best-effort，高峰期漂移/漏触发；
      Cloudflare 控制台国内打不开，wrangler 也走不通。
      正解是用一个「国内可直连、调度可靠」的外部定时器去调用
      GitHub workflow_dispatch API（秒级、不走 schedule 队列）。
      本文件就是那个外部定时器，功能与 tools/cf_worker.js 完全对齐。

与旧版的区别：
  旧版只在 08:00 检查一次自进化心跳，且 dispatch 的 evolve_daily.yml
  在线上仓库 .github/workflows/ 里并不存在（会 404）。
  新版覆盖 cf_worker.js 的全部 11 个定时任务，并保留自进化心跳兜底
  （需先把 github_ci/evolve_daily.yml 推到线上 .github/workflows/ 才生效）。

部署（浏览器操作，约 5 分钟）：
  1. https://console.cloud.tencent.com/scf → 微信扫码登录 → 新建函数
     地域任意（国内地域即可）/ 事件函数 / Python 3.9+ / 名称 santai-cron
     执行超时 30 秒，内存 128MB
  2. 把本文件全文粘进在线代码编辑器，入口函数填 main_handler
  3. 环境变量（函数配置 → 环境变量）：
       GH_TOKEN = GitHub classic PAT（勾选 repo + workflow）
       GH_REPO  = yinzhonghe/san-tai-databuild
  4. 触发管理 → 新建定时触发器：
       cron 表达式 `0 * * * * * *`（每分钟第 0 秒），时区选 Asia/Shanghai
       函数在内部按北京时间匹配到具体任务才 dispatch，非任务分钟直接跳过
  5. 手动测试：控制台「测试」→ 事件模板传 {"Message":"{\"slot\":\"noon\"}"}
      日志看到 dispatched 即成功；不传 Message 则按当前北京时间自动匹配

安全：GH_TOKEN 只存环境变量，绝不写进代码或公开仓库。
"""
import base64
import datetime
import json
import os
import urllib.error
import urllib.request

GH_API = 'https://api.github.com'
CN_TZ_OFFSET = 8 * 3600

# 任务表：北京时间。全量接管线上所有 workflow 的 schedule（schedule 段已从 workflow 删除）。
# 关键：build.yml 原 schedule 触发会走全量构建；改 dispatch 后必须显式传 mode=full，
#       否则 github.event_name != 'schedule' 会退化成 100 只小样本。
JOBS = [
    {'key': 'morning',    'h': 7,  'm': 30, 'wf': 'report.yml',   'ref': 'main',
     'inputs': {'slot': 'morning', 'dry_run': 'false', 'tier': 'high', 'model': ''}},
    {'key': 'build',      'h': 7,  'm': 35, 'wf': 'build.yml',    'ref': 'main',
     'inputs': {'mode': 'full'}},
    {'key': 'watch_am',   'h': 8,  'm': 5,  'wf': 'watchdog.yml', 'ref': 'main',
     'inputs': {'slot': 'auto'}},
    # 自进化兜底：心跳去重（data 分支），今天已 published 就跳过。
    {'key': 'evolve',     'h': 8,  'm': 0,  'wf': 'evolve_daily.yml', 'ref': 'main',
     'inputs': {'reason': 'scf_fallback'}, 'guard': 'heartbeat'},
    {'key': 'am_flash',   'h': 10, 'm': 30, 'wf': 'intraday.yml', 'ref': 'main',
     'inputs': {'slot': 'am_flash', 'force': 'false', 'model': '', 'dry_run': 'false'}},
    {'key': 'news_am',    'h': 10, 'm': 0,  'wf': 'news.yml',     'ref': 'main',
     'inputs': {}},
    {'key': 'event11',    'h': 11, 'm': 0,  'wf': 'intraday.yml', 'ref': 'main',
     'inputs': {'slot': 'event', 'force': 'false', 'model': '', 'dry_run': 'false'}},
    {'key': 'noon',       'h': 11, 'm': 35, 'wf': 'report.yml',   'ref': 'main',
     'inputs': {'slot': 'noon', 'dry_run': 'false', 'tier': 'high', 'model': ''}},
    {'key': 'watch_noon', 'h': 12, 'm': 10, 'wf': 'watchdog.yml', 'ref': 'main',
     'inputs': {'slot': 'auto'}},
    {'key': 'event13',    'h': 13, 'm': 0,  'wf': 'intraday.yml', 'ref': 'main',
     'inputs': {'slot': 'event', 'force': 'false', 'model': '', 'dry_run': 'false'}},
    {'key': 'news_pm',    'h': 13, 'm': 0,  'wf': 'news.yml',     'ref': 'main',
     'inputs': {}},
    {'key': 'pm_flash',   'h': 14, 'm': 0,  'wf': 'intraday.yml', 'ref': 'main',
     'inputs': {'slot': 'pm_flash', 'force': 'false', 'model': '', 'dry_run': 'false'}},
    {'key': 'event1430',  'h': 14, 'm': 30, 'wf': 'intraday.yml', 'ref': 'main',
     'inputs': {'slot': 'event', 'force': 'false', 'model': '', 'dry_run': 'false'}},
    {'key': 'close',      'h': 15, 'm': 5,  'wf': 'report.yml',   'ref': 'main',
     'inputs': {'slot': 'close', 'dry_run': 'false', 'tier': 'high', 'model': ''}},
    {'key': 'watch_pm',   'h': 15, 'm': 40, 'wf': 'watchdog.yml', 'ref': 'main',
     'inputs': {'slot': 'auto'}},
    # 16:30 双任务：舆情收盘档 + 超跌池（两者互不依赖）
    {'key': 'news_close', 'h': 16, 'm': 30, 'wf': 'news.yml',     'ref': 'main',
     'inputs': {}},
    {'key': 'oversold',   'h': 16, 'm': 30, 'wf': 'oversold.yml', 'ref': 'main',
     'inputs': {'skip_fetch': 'false'}},
    # 自由推演实验室：20:00（收盘+演化后），与证据包自进化平行独立；额度闸防重复烧钱。
    {'key': 'freelab',    'h': 20, 'm': 0,  'wf': 'freelab.yml',   'ref': 'main',
     'inputs': {'force': 'false', 'reason': 'scf_daily'}},
    # 季度任务：5/9/11 月 10 日 16:00（北京时间）；不限星期几（原 schedule 也不限）。
    {'key': 'refresh_basics', 'h': 16, 'm': 0, 'wf': 'refresh-basics.yml', 'ref': 'main',
     'inputs': {'also_build': 'rebuild'}, 'months': [5, 9, 11], 'dom': 10,
     'ignore_weekend': True},
]
JOBS_BY_KEY = {j['key']: j for j in JOBS}


def _log(msg):
    print('[%s] %s' % (_beijing_now().strftime('%Y-%m-%d %H:%M:%S'), msg))


def _env(name, default=''):
    return (os.environ.get(name) or default).strip()


def _beijing_now():
    return datetime.datetime.utcnow() + datetime.timedelta(seconds=CN_TZ_OFFSET)


def _http(url, method='GET', headers=None, body=None, timeout=20):
    h = {'User-Agent': 'santai-scf-cron/2.0', 'Accept': 'application/vnd.github+json'}
    h.update(headers or {})
    data = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode('utf-8', 'replace')
            return r.status, (json.loads(raw) if raw.strip().startswith(('{', '[')) else raw)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')[:300]
    except Exception as e:
        return 0, '%s: %s' % (type(e).__name__, e)


def _heartbeat_done(token, repo):
    """读 data 分支心跳；昨天/今天 published 即视为已跑完，避免重复触发。"""
    now = _beijing_now()
    url = '%s/repos/%s/contents/learn/evolve/heartbeat.json?ref=data&_t=%d' % (
        GH_API, repo, int(now.timestamp()))
    status, obj = _http(url, headers={'Authorization': 'Bearer ' + token})
    if status != 200 or not isinstance(obj, dict) or not obj.get('content'):
        return False, '心跳读取失败 HTTP=%s' % status
    try:
        hb = json.loads(base64.b64decode(obj['content']).decode('utf-8'))
    except Exception as e:
        return False, '心跳解析失败 %s' % e
    yesterday = (now.date() - datetime.timedelta(days=1)).isoformat()
    today = now.date().isoformat()
    done = hb.get('date') in (yesterday, today) and hb.get('status') == 'published'
    return done, '%s/%s' % (hb.get('date'), hb.get('status'))


def dispatch(token, repo, job):
    url = '%s/repos/%s/actions/workflows/%s/dispatches' % (GH_API, repo, job['wf'])
    headers = {
        'Authorization': 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
    }
    body = {'ref': job.get('ref', 'main'), 'inputs': job['inputs']}
    status, detail = _http(url, method='POST', headers=headers, body=body)
    ok = status == 204
    _log('%s: %s -> %s HTTP=%s %s' % (
        'dispatched' if ok else 'FAILED', job['key'], job['wf'], status,
        '' if ok else str(detail)[:200]))
    return ok, status


def _pick_jobs(event, now):
    """先按 Message 精确指定（手动测试用），否则按北京时间分钟匹配。
    返回 (jobs列表, source)；同一分钟可能有多个任务（如 16:30 news+oversold）。"""
    msg = ''
    if isinstance(event, dict):
        raw = event.get('Message') or ''
        if isinstance(raw, str) and raw.strip():
            raw = raw.strip()
            try:
                parsed = json.loads(raw)
                msg = (parsed.get('slot') or '') if isinstance(parsed, dict) else raw
            except Exception:
                msg = raw
    if msg:
        job = JOBS_BY_KEY.get(msg)
        return ([job], 'message') if job else ([], 'unknown slot: ' + msg)
    matched = []
    for j in JOBS:
        if j['h'] != now.hour or j['m'] != now.minute:
            continue
        if j.get('months') and now.month not in j['months']:
            continue
        if j.get('dom') and now.day != j['dom']:
            continue
        if now.weekday() >= 5 and not j.get('ignore_weekend'):
            continue                     # 周末跳过常规任务（季度任务豁免）
        matched.append(j)
    return (matched, 'clock') if matched else ([], 'no job at this minute')


def main_handler(event, context):
    token = _env('GH_TOKEN')
    repo = _env('GH_REPO', 'yinzhonghe/san-tai-databuild')
    if not token:
        _log('ERROR: 缺 GH_TOKEN 环境变量')
        return {'ok': False, 'reason': 'no_token'}

    now = _beijing_now()
    jobs, source = _pick_jobs(event, now)
    if not jobs:
        _log('SKIP: %s' % source)
        return {'ok': True, 'action': 'skip', 'reason': source}

    hb_done = None
    results = []
    for job in jobs:
        if job.get('guard') == 'heartbeat':
            if hb_done is None:
                hb_done, why = _heartbeat_done(token, repo)
                if hb_done:
                    _log('SKIP: 自进化心跳已完成 (%s)' % why)
            if hb_done:
                results.append({'key': job['key'], 'action': 'skip',
                                'reason': 'heartbeat_done'})
                continue
        ok, status = dispatch(token, repo, job)
        results.append({'key': job['key'], 'action': 'dispatch' if ok else 'failed',
                        'wf': job['wf'], 'http': status})
    all_ok = all(r['action'] in ('dispatch', 'skip') for r in results)
    acts = [r['action'] for r in results]
    if 'failed' in acts:
        outer = 'failed'
    elif all(a == 'skip' for a in acts):
        outer = 'skip'
    elif 'dispatch' in acts:
        outer = 'dispatch'
    else:
        outer = 'ok'
    return {'ok': all_ok, 'action': outer,
            'results': results, 'source': source, 'time': now.strftime('%F %H:%M')}


if __name__ == '__main__':
    # 本地自检：打印任务表与当前匹配结果，不触发网络请求。
    print('任务表（北京时间）：')
    for j in JOBS:
        print('  %02d:%02d  %-12s %s' % (j['h'], j['m'], j['key'], j['wf']))
    now = _beijing_now()
    jobs, source = _pick_jobs({}, now)
    print('\n当前 %s -> %s (%s)' % (
        now.strftime('%F %H:%M'), ','.join(j['key'] for j in jobs) or '无任务', source))
