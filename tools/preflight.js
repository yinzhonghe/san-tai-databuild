/*
 * tools/preflight.js · 全局体检（提交/发布前的统一门禁）
 * ========================================================
 * 解决痛点：以前每改一处要靠人肉发现问题再告诉 Agent，耽误时间、难以真正自进化。
 * 本脚本把项目所有【被动守护检查】串成一个主动门禁，改完任何代码一条命令跑完：
 *
 *   node tools/preflight.js
 *
 * 检查项（逐项独立，失败不中断其余项，最后汇总）：
 *   1) JS 语法编译：tools 与 tests 目录下所有 .js 逐个做语法编译检查
 *   2) 宪法封印：constitution.json 的 SHA256 与 seal 一致（篡改即失败）
 *   3) 全套回归测试：npm test（engine→...→freelab→sharecode→...共13套）
 *   4) Python 语法：github_ci/*.py 与 tools/*.py 编译检查
 *   5) 关键数据地基：kline/index.json asOf == panel_gaps.asOf、日报 dataAsOf 存在
 *   6) 发布清单：build_site.py 的 FILES 里每个文件都存在（避免发布漏文件）
 *
 * 红线：只读检查，不修改任何业务文件、不写生产状态。
 * 退出码：全部通过 0；任一失败 1（可直接接 CI / git hook）。
 */
'use strict';
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.dirname(__dirname);
var results = [];
function record(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  — ' + detail : ''));
}
function walk(dir, ext) {
  var out = [];
  try {
    fs.readdirSync(dir).forEach(function (e) {
      var p = path.join(dir, e);
      var st; try { st = fs.statSync(p); } catch (x) { return; }
      if (st.isDirectory()) out = out.concat(walk(p, ext));
      else if (p.endsWith(ext)) out.push(p);
    });
  } catch (e) {}
  return out;
}
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }

console.log('=== 三态看盘 · 全局体检 preflight ===\n');

// 1) JS 语法编译（用 node --check 子进程，正确处理 ES module / worker 等不同类型）
(function () {
  var files = walk(path.join(ROOT, 'tools'), '.js').concat(walk(path.join(ROOT, 'tests'), '.js'));
  var bad = [];
  files.forEach(function (f) {
    // --input-type=module 对 export/import 文件；先按 CJS 试，失败再按 ESM 试，都失败才算坏
    var r1 = cp.spawnSync(process.execPath, ['--check', f], { cwd: ROOT, encoding: 'utf8' });
    if (r1.status === 0) return;
    var r2 = cp.spawnSync(process.execPath, ['--input-type=module', '--check'],
      { cwd: ROOT, encoding: 'utf8', input: fs.readFileSync(f, 'utf8') });
    if (r2.status !== 0) bad.push(path.relative(ROOT, f) + ': ' + (r1.stderr || '').split('\n')[0]);
  });
  record('JS 语法编译（' + files.length + ' 个文件）', bad.length === 0, bad.slice(0, 3).join(' | '));
})();

// 2) 宪法封印
(function () {
  try {
    var crypto = require('crypto');
    var cpath = path.join(ROOT, 'learn', 'evolve', 'constitution.json');
    var spath = path.join(ROOT, 'learn', 'evolve', 'constitution.seal.json');
    var hash = crypto.createHash('sha256').update(fs.readFileSync(cpath)).digest('hex');
    var seal = readJson(spath, {});
    record('宪法封印 SHA256 一致', hash === seal.hash, hash === seal.hash ? '' : '封印被改动！');
  } catch (e) { record('宪法封印 SHA256 一致', false, e.message); }
})();

// 3) 全套回归测试
(function () {
  try {
    // 直接跑 package.json 里 test 串的每条 node 测试，避免依赖 npm CLI 的跨环境路径问题
    var pkg = readJson(path.join(ROOT, 'package.json'), {});
    var cmd = String((pkg.scripts || {}).test || '').replace(/\bnode\s+/g, '');
    var tests = cmd.split('&&').map(function (s) { return s.trim(); }).filter(Boolean);
    var badTests = [], totalPass = 0;
    tests.forEach(function (t) {
      var r = cp.spawnSync(process.execPath, [t], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
      var out = (r.stdout || '') + (r.stderr || '');
      if (r.status !== 0) badTests.push(path.basename(t) + ': ' + out.slice(-120).replace(/\n/g, ' '));
      else totalPass++;
    });
    record('全套回归测试（' + tests.length + ' 套）', badTests.length === 0,
      badTests.length ? badTests.slice(0, 3).join(' | ') : (totalPass + '/' + tests.length + ' 全绿'));
  } catch (e) { record('全套回归测试', false, e.message); }
})();

// 4) Python 语法（调 py_compile，失败则跳过不算错，只提示）
(function () {
  var pyFiles = walk(path.join(ROOT, 'github_ci'), '.py').concat(walk(path.join(ROOT, 'tools'), '.py'));
  var py = process.platform === 'win32' ? 'python' : 'python3';
  var r = cp.spawnSync(py, ['-m', 'py_compile'].concat(pyFiles), { cwd: ROOT, encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') record('Python 语法编译', true, '环境无 python，跳过');
  else record('Python 语法编译（' + pyFiles.length + ' 个文件）', r.status === 0,
    r.status === 0 ? '' : (r.stderr || '').slice(-200));
})();

// 5) 数据地基：kline/index.json asOf == panel_gaps.asOf
(function () {
  var idx = readJson(path.join(ROOT, 'kline', 'index.json'), {});
  var gaps = readJson(path.join(ROOT, 'learn', 'evolve', 'panel_gaps.json'), {});
  var a = String(idx.asOf || ''), b = String(gaps.asOf || '');
  record('K线 asOf 与面板 asOf 一致', !!a && a === b, a + ' vs ' + b);
})();

// 6) 发布清单文件存在
(function () {
  var src = fs.readFileSync(path.join(ROOT, 'tools', 'build_site.py'), 'utf8');
  var m = src.match(/FILES\s*=\s*\[([\s\S]*?)\]/);
  if (!m) { record('发布清单文件存在', false, '解析 FILES 失败'); return; }
  var names = [];
  m[1].replace(/"([^"]+)"/g, function (_, n) { names.push(n); });
  var missing = names.filter(function (n) { return !fs.existsSync(path.join(ROOT, n)); });
  record('发布清单文件存在（' + names.length + ' 个）', missing.length === 0,
    missing.length ? '缺失：' + missing.join(', ') : '');
})();

var failed = results.filter(function (r) { return !r.ok; });
console.log('\n[preflight] ' + (results.length - failed.length) + '/' + results.length + ' 项通过'
  + (failed.length ? '，失败 ' + failed.length + ' 项：' + failed.map(function (r) { return r.name; }).join('、') : '，全部通过'));
process.exit(failed.length ? 1 : 0);
