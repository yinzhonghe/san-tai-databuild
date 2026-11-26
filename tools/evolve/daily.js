/*
 * tools/evolve/daily.js · 每日一代总编排（L3 本地主跑入口）
 * ==============================================================
 * 流程（对应定稿）：
 *   1. constitution 封印校验（不通过直接拒绝）
 *   2. 心跳检查：今天已 published → 跳过（幂等，防三层定时重复跑）
 *   3. 种群演化一代（pop.generation：kernel 硬验证 + settle 结算 + Elo）
 *   4. 久攻不下（连续3代全灭）→ 标记 needTestTime=true，等 LLM 加练（最多3轮）
 *   5. 写心跳 done（算完未发布）
 *   6. 生成证据包报告（report.js）
 *
 * 用法：
 *   node tools/evolve/daily.js                  # 正常每日一代
 *   node tools/evolve/daily.js --force          # 忽略心跳强制跑
 *   node tools/evolve/daily.js --dry-run        # 只检查不执行
 */
'use strict';
var fs = require('fs');
var path = require('path');
var K = require('./kernel.js');
var P = require('./pop.js');
var H = require('./heartbeat.js');

var ROOT = path.dirname(path.dirname(__dirname));
var EVO = path.join(ROOT, 'learn', 'evolve');

function run(opts) {
  opts = opts || {};
  var seal = K.verifySeal();
  if (!seal.ok) return Promise.resolve({ ok: false, reason: seal.reason, stage: 'seal' });

  var hb = H.check();
  if (!opts.force && hb.done) {
    return Promise.resolve({ ok: true, skipped: true, reason: '今天已完成（' + hb.status + '），幂等跳过', heartbeat: hb });
  }
  // 心跳 pending
  H.setStage('pending', { gen: (P ? 0 : 0) });

  return P.generation().then(function (gen) {
    var out = {
      ok: true, at: new Date(Date.now() + 8 * 3600000).toISOString(),
      generation: gen.generation, evaluated: gen.evaluated,
      active: gen.active, shadow: gen.shadow,
      trialTotal: gen.trialTotal, livePool: gen.livePool,
      needTestTime: gen.allWiped,   // 连续3代全灭 → 现场课程触发条件
      top: gen.top
    };
    H.setStage('done', { gen: gen.generation, active: gen.active,
      evaluated: gen.evaluated, needTestTime: gen.allWiped });
    // 写每日审计日志
    var logPath = path.join(EVO, 'daily_log.jsonl');
    fs.mkdirSync(EVO, { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(out) + '\n');
    return out;
  }).catch(function (e) {
    H.setStage('pending', { error: String(e.message || e).slice(0, 200) });
    return { ok: false, reason: String(e.message || e), stage: 'generation' };
  });
}

function main() {
  var args = process.argv.slice(2);
  var dry = args.indexOf('--dry-run') >= 0;
  if (dry) {
    console.log(JSON.stringify({ dryRun: true, seal: K.verifySeal(), heartbeat: H.check() }, null, 2));
    return;
  }
  run({ force: args.indexOf('--force') >= 0 }).then(function (r) { console.log(JSON.stringify(r, null, 2)); });
}
if (require.main === module) main();
module.exports = { run: run };
