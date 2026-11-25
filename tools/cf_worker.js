/**
 * 三态看盘 · Cloudflare Worker 定时触发器
 *
 * 作用：由 Cloudflare Cron Triggers 按北京时间触发，调用 GitHub
 *       workflow_dispatch API 启动三报/盘中快报/自检补漏。
 *       替代 GitHub 原生 schedule（best-effort，高峰期漏触发）。
 *
 * 部署：wrangler deploy（见 tools/setup_cloudflare.md）
 * 密钥：GH_TOKEN     = GitHub classic PAT（repo + workflow）
 *       CRON_SECRET  = 自备随机串，防止 cron 端点被外部乱调（可选）
 *
 * 任务清单见下方 JOBS；时间与 tools/setup_cronjobs.py 保持一致。
 */

const REPO = 'yinzhonghe/san-tai-databuild';
const GH_API = 'https://api.github.com/repos/' + REPO + '/actions/workflows';

// workflow -> 各时段的 dispatch inputs（与 setup_cronjobs.py 完全相同）
const JOBS = [
  { key: 'morning',  h: 7,  m: 30, wf: 'report.yml',    inputs: { slot: 'morning',  dry_run: 'false', tier: 'high', model: '' } },
  { key: 'noon',     h: 11, m: 35, wf: 'report.yml',    inputs: { slot: 'noon',     dry_run: 'false', tier: 'high', model: '' } },
  { key: 'close',    h: 15, m: 5,  wf: 'report.yml',    inputs: { slot: 'close',    dry_run: 'false', tier: 'high', model: '' } },
  { key: 'am_flash', h: 10, m: 30, wf: 'intraday.yml',  inputs: { slot: 'am_flash', force: 'false', model: '', dry_run: 'false' } },
  { key: 'event11',  h: 11, m: 0,  wf: 'intraday.yml',  inputs: { slot: 'event',    force: 'false', model: '', dry_run: 'false' } },
  { key: 'event13',  h: 13, m: 0,  wf: 'intraday.yml',  inputs: { slot: 'event',    force: 'false', model: '', dry_run: 'false' } },
  { key: 'pm_flash', h: 14, m: 0,  wf: 'intraday.yml',  inputs: { slot: 'pm_flash', force: 'false', model: '', dry_run: 'false' } },
  { key: 'event1430',h: 14, m: 30, wf: 'intraday.yml',  inputs: { slot: 'event',    force: 'false', model: '', dry_run: 'false' } },
  { key: 'watch_am', h: 8,  m: 5,  wf: 'watchdog.yml',  inputs: { slot: 'auto' } },
  { key: 'watch_noon', h: 12, m: 10, wf: 'watchdog.yml', inputs: { slot: 'auto' } },
  { key: 'watch_pm', h: 15, m: 40, wf: 'watchdog.yml',  inputs: { slot: 'auto' } },
];

function beijingParts(date) {
  // Cron 触发时间以 UTC 传入；北京时间 = UTC + 8h
  const bj = new Date(date.getTime() + 8 * 3600 * 1000);
  return {
    h: bj.getUTCHours(),
    m: bj.getUTCMinutes(),
    dow: bj.getUTCDay(),       // 0=周日
    ymd: bj.toISOString().slice(0, 10),
  };
}

function matchJob(date) {
  const b = beijingParts(date);
  if (b.dow === 0 || b.dow === 6) return null;   // 周末不跑
  // 精确匹配到分钟（Cron scheduledTime 是配置时间点，执行延迟不影响）
  for (const j of JOBS) {
    if (b.h === j.h && b.m === j.m) return j;
  }
  return null;
}

async function dispatch(env, job, when) {
  const body = JSON.stringify({ ref: 'main', inputs: job.inputs });
  const resp = await fetch(GH_API + '/' + job.wf + '/dispatches', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.GH_TOKEN,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'san-tai-cron-worker',
    },
    body,
  });
  const ok = resp.status === 204;
  const detail = ok ? '' : (await resp.text()).slice(0, 300);
  return { ok, status: resp.status, detail };
}

export default {
  // Cloudflare Cron Triggers：每分钟或按配置触发；这里自己判断具体任务
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handle(event.scheduledTime ? new Date(event.scheduledTime) : new Date(), env, 'cron'));
  },

  // 手动测试：GET /trigger?key=<CRON_SECRET>&slot=noon
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, tz: 'Asia/Shanghai', jobs: JOBS.map(j => j.key) }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/trigger') {
      if (env.CRON_SECRET && url.searchParams.get('key') !== env.CRON_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const key = url.searchParams.get('slot');
      const job = JOBS.find(j => j.key === key);
      if (!job) return new Response('unknown slot: ' + key, { status: 400 });
      const r = await dispatch(env, job, new Date());
      return new Response(JSON.stringify({ slot: key, wf: job.wf, ...r }), {
        status: r.ok ? 200 : 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  },
};

async function handle(date, env, source) {
  const job = matchJob(date);
  if (!job) return;                       // 非任务时间点，直接返回
  const b = beijingParts(date);
  const tag = b.ymd + ' ' + String(b.h).padStart(2, '0') + ':' + String(b.m).padStart(2, '0');
  try {
    const r = await dispatch(env, job, date);
    console.log('[' + source + '] ' + tag + ' ' + job.key + ' -> ' + job.wf +
      ' ' + r.status + (r.ok ? '' : ' ' + r.detail));
  } catch (e) {
    console.error('[' + source + '] ' + tag + ' ' + job.key + ' ERROR ' + String(e));
  }
}
