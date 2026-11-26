/*
 * tools/evolve/heartbeat.js · 心跳三态 + 本地/云端判活（L2/L3 定稿）
 * ======================================================================
 * 心跳三态：pending（跑了未完）→ done（算完未发布）→ published（已发布）
 * 用途：
 *   - 本地每日跑完各阶段写心跳；GitHub 23:30 / 腾讯云函数次日08:00 查心跳决定是否补跑
 *   - 同一版本当天只发布一次（published 直接跳过），防三层定时重复发布
 *
 * 用法：
 *   node tools/evolve/heartbeat.js --set done --gen 3 --active 2
 *   node tools/evolve/heartbeat.js --set published --version 202611261002
 *   node tools/evolve/heartbeat.js --check          # 输出是否今天已完成
 *   node tools/evolve/heartbeat.js --check --needs-publish  # 是否有算完未发布的
 */
'use strict';
var fs = require('fs');
var path = require('path');
var ROOT = path.dirname(path.dirname(__dirname));
var EVO = path.join(ROOT, 'learn', 'evolve');
var HB = path.join(EVO, 'heartbeat.json');
function today() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
function load() { try { return JSON.parse(fs.readFileSync(HB, 'utf8')); } catch (e) { return {}; } }
function save(o) { fs.mkdirSync(EVO, { recursive: true }); fs.writeFileSync(HB, JSON.stringify(o, null, 2) + '\n'); }

function setStage(status, extra) {
  var hb = load();
  hb.date = today();
  hb.status = status;
  hb.updatedAt = new Date(Date.now() + 8 * 3600000).toISOString();
  Object.keys(extra || {}).forEach(function (k) { hb[k] = extra[k]; });
  if (status === 'published') hb.publishedAt = hb.updatedAt;
  save(hb);
  return hb;
}

function check(opts) {
  opts = opts || {};
  var hb = load();
  var isToday = hb.date === today();
  if (opts.needsPublish) {
    return { needsPublish: isToday && hb.status === 'done',
      status: hb.status || 'none', date: hb.date || 'none', version: hb.version || null };
  }
  return { done: isToday && (hb.status === 'done' || hb.status === 'published'),
    published: isToday && hb.status === 'published',
    status: hb.status || 'none', date: hb.date || 'none',
    staleDays: hb.date ? Math.round((Date.now() - Date.parse(hb.date + 'T00:00:00+08:00')) / 86400000) : null };
}

function main() {
  var args = process.argv.slice(2);
  if (args[0] === '--set') {
    var extra = {};
    for (var i = 2; i < args.length; i += 2) if (args[i] && args[i].startsWith('--')) extra[args[i].slice(2)] = isNaN(+args[i + 1]) ? args[i + 1] : +args[i + 1];
    console.log(JSON.stringify(setStage(args[1], extra), null, 2)); return;
  }
  if (args[0] === '--check') { console.log(JSON.stringify(check({ needsPublish: args.indexOf('--needs-publish') >= 0 }), null, 2)); return; }
  console.log('用法: --set <pending|done|published> [--key val ...] | --check [--needs-publish]');
}
if (require.main === module) main();
module.exports = { setStage: setStage, check: check, TODAY: today };
