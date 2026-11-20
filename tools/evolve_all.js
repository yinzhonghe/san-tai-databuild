'use strict';
/*
 * 自进化 · 一键跑完整闭环
 * ------------------------------------------------------------------
 * 顺序（每一步都基于真实文件，失败就停，不往下继续制造半成品）：
 *   1. 指数日线同步          → learn/index_hist.json
 *   2. 历史信号库（缺才建）  → learn/chan_signals.json.gz
 *   3. 滚动训练              → learn/chan_params.json（含门禁：不达标不采纳）
 *   4. 重算今日名单          → chan_pick_data.js（用新参数 + 记台账）
 *   5. 实盘到期打真实分      → learn/chan_live.jsonl
 *   6. 三态快照归档/对账     → learn/state_calib.json
 *   7. 点评归档/对账/生成规则 → learn/commentary_rules.md
 *   8. 汇总给页面            → learn_report.js
 *
 * 用法：
 *   node tools/evolve_all.js            # 日常（不重扫全市场，约 2 分钟）
 *   node tools/evolve_all.js --bootstrap # 强制重扫历史信号（换了数据源/引擎时）
 *   node tools/evolve_all.js --no-pick   # 不重算名单（只训练/对账）
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const args = process.argv.slice(2);
const forceBoot = args.indexOf('--bootstrap') >= 0;
const noPick = args.indexOf('--no-pick') >= 0;

const HEAP = ['--max-old-space-size=8192'];

const failed = [];
function run(label, script, extra, soft) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, HEAP.concat([path.join(ROOT, 'tools', script)], extra || []), {
    cwd: ROOT, stdio: 'inherit', env: process.env
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(0);
  if (r.status !== 0) {
    if (soft) {
      console.error('! ' + label + ' 失败（exit ' + r.status + '，' + dt + 's），继续后续步骤');
      failed.push(label);
      return false;
    }
    console.error('✗ ' + label + ' 失败（exit ' + r.status + '，' + dt + 's）');
    process.exit(r.status || 1);
  }
  console.log('✓ ' + label + '（' + dt + 's）\n');
}

console.log('==== 自进化闭环 ' + new Date().toISOString().slice(0, 19) + ' ====');

run('同步指数日线', 'evolve_index.js', [], true);

const sigFile = path.join(ROOT, 'learn', 'chan_signals.json.gz');
if (forceBoot || !fs.existsSync(sigFile)) {
  run('扫描历史一买信号', 'evolve_chan.js', ['bootstrap'], true);
}
run('滚动训练打分卡', 'evolve_chan.js', ['train'], true);
if (!noPick) run('用新参数重算名单', 'chan_pick.js');
run('实盘台账结算', 'evolve_chan.js', ['score'], true);
run('三态快照归档', 'evolve_state.js', ['archive'], true);
run('三态到期对账', 'evolve_state.js', ['score'], true);
run('点评归档与对账', 'evolve_verdict.js', ['all'], true);
run('汇总页面数据', 'evolve_report.js');

if (failed.length) console.log('==== 完成，但以下步骤失败（已保留旧参数/旧数据）：' + failed.join('、') + ' ====');
else console.log('==== 完成：learn/ 已更新，learn_report.js 已生成 ====');
