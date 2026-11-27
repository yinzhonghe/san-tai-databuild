/*
 * tools/evolve/make_sample.js · 从全样本面板生成等距分层采样（修 head 截断 bug）
 * ==============================================================================
 * 背景：旧 panel_sample100k.jsonl 是 head -100000，只覆盖 2/13~7/21，
 *       日常 settle 默认读它 → 8~11月行情完全缺席，holdout 段形同虚设。
 * 正解：等距抽样（每 step 行取 1 行），保留全时间分布，末行贴近全样本末端。
 * 用法：node tools/evolve/make_sample.js [--n 100000]
 */
'use strict';
var fs = require('fs');
var path = require('path');
var ROOT = path.dirname(path.dirname(__dirname));
var EVO = path.join(ROOT, 'learn', 'evolve');
var SRC = path.join(EVO, 'panel.jsonl');
var DST = path.join(EVO, 'panel_sample100k.jsonl');

function countLines(p) {
  var fd = fs.openSync(p, 'r'), buf = Buffer.alloc(1 << 20), n = 0, last = 10;
  while (true) {
    var got = fs.readSync(fd, buf, 0, buf.length, null);
    if (!got) break;
    for (var i = 0; i < got; i++) if (buf[i] === 10) n++;
    last = buf[got - 1];
  }
  fs.closeSync(fd);
  return n + (last === 10 ? 0 : 1);
}
function dateOf(line) {
  try { return JSON.parse(line).date || ''; } catch (e) { return ''; }
}

var args = process.argv.slice(2);
var wantN = 100000, ai = args.indexOf('--n');
if (ai >= 0 && +args[ai + 1] > 0) wantN = +args[ai + 1];

var total = countLines(SRC);
var step = Math.max(1, Math.floor(total / wantN));
console.log('[make_sample] 全样本 %d 行 → 目标 %d 行（步长 %d）', total, wantN, step);

var fd = fs.openSync(SRC, 'r');
var out = fs.openSync(DST, 'w');
var buf = Buffer.alloc(1 << 20);
var lineNo = 0, written = 0, carry = '';
var firstDate = '', lastDate = '';
function consume(line) {
  if (!line) return;
  if (lineNo % step === 0) {
    fs.writeSync(out, line + '\n');
    written++;
    if (!firstDate) firstDate = dateOf(line);
    lastDate = dateOf(line);
  }
  lineNo++;
}
while (true) {
  var got = fs.readSync(fd, buf, 0, buf.length, null);
  if (!got) break;
  var chunk = carry + buf.toString('utf8', 0, got);
  var lines = chunk.split('\n');
  carry = lines.pop();
  for (var i = 0; i < lines.length; i++) consume(lines[i]);
}
consume(carry);
fs.closeSync(fd); fs.closeSync(out);
console.log('[make_sample] 已写 %d 行 → %s | 首 %s 末 %s (%.1f MB)',
  written, DST, firstDate, lastDate, fs.statSync(DST).size / 1048576);
if (written < wantN * 0.9) { console.error('采样行数不足'); process.exit(2); }
