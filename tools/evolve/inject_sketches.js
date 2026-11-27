/*
 * tools/evolve/inject_sketches.js · v3 智谱草图 → 种群 sketch_variant 注入（接线器）
 * =============================================================
 * 背景：evolve_v3_llm.py 产出 llm_candidates_v3.json（带 @P 占位符草图），
 *       但此前没有任何环节把它展开注入 population —— 智谱推演结果从不进验证。
 * 本脚本补上这段接线：
 *   草图 → pop.expandSketch（阈值网格 30~50 变体）→ population.rules[sketch_variant]
 *   → 下一代 generation() 由 kernel.hardGate + settle 真实验证。
 *
 * 红线：
 *   - 先验封印（K.verifySeal），失效拒绝运行。
 *   - 只注入 status=sketch_variant；绝不碰 active/seed/registry/constitution。
 *   - 草图引用的特征必须已在 FEAT.META 注册；未注册的新特征跳过并记原因（不伪造注册）。
 *   - 幂等：按 id 去重，重复草图不重复注入。
 *   - 单次注入上限 50（M4 定稿），全局 sketch_variant 存量上限 200，防种群膨胀。
 *
 * 用法：node tools/evolve/inject_sketches.js [--dry-run]
 */
'use strict';
var fs = require('fs');
var path = require('path');
var K = require('./kernel.js');
var P = require('./pop.js');
var FEAT = require('./features.js');

var ROOT = path.dirname(path.dirname(__dirname));
var EVO = path.join(ROOT, 'learn', 'evolve');
var POP = path.join(EVO, 'population.json');
var SKETCH = path.join(EVO, 'llm_candidates_v3.json');

function loadJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function saveJSON(p, o) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); }
function stamp() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' '); }
// 内容哈希：同一草图重复运行 id 不变 → 幂等去重（时间戳会让每次都生成新 id，绕过去重）
function hash(s) { var h = 0, i; for (i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return 'h' + Math.abs(h).toString(36); }

var MAX_PER_RUN = 50;
var MAX_STOCK = 200;

function main() {
  var dry = process.argv.indexOf('--dry-run') >= 0;
  var seal = K.verifySeal();
  if (!seal.ok) { console.error('[inject] 拒绝：宪法封印失效（' + seal.reason + '）'); process.exit(1); }

  var doc = loadJSON(SKETCH, null);
  var result = {};
  if (!doc || typeof doc !== 'object') {
    result = loadJSON(path.join(EVO, 'llm_candidates_v3_raw.json'), {});
  } else {
    result = doc.result || doc;
  }
  var sketches = Array.isArray(result.sketches) ? result.sketches : [];
  if (!sketches.length) {
    console.log(JSON.stringify({ injected: 0, reason: '无草图（llm_candidates_v3.json 缺 sketches 或未生成）',
      dry: dry, at: stamp() }, null, 2));
    return;
  }

  var pop = loadJSON(POP, null);
  if (!pop || !Array.isArray(pop.rules)) {
    console.error('[inject] 缺 population.json，请先 --init');
    process.exit(1);
  }
  var seen = {};
  pop.rules.forEach(function (r) { if (r.id) seen[r.id] = true; });
  var stock = pop.rules.filter(function (r) { return r.status === 'sketch_variant'; }).length;
  var room = Math.max(0, MAX_STOCK - stock);

  var injected = [];
  var skipped = [];
  for (var i = 0; i < sketches.length && injected.length < MAX_PER_RUN && room > 0; i++) {
    var sk = sketches[i] || {};
    var conds = (sk.when || []).concat(sk.unless || []);
    var unknown = conds.map(function (c) { return c && c.f; })
      .filter(function (f) { return f && !FEAT.META[f]; });
    // 新特征：kernel 要求已注册且 reproducible；未注册则诚实跳过，不伪造
    var badNew = (sk.newFeatures || []).filter(function (nf) {
      return !nf || !nf.name || !FEAT.META[nf.name] || nf.reproducible !== true;
    });
    if (unknown.length || badNew.length) {
      skipped.push({ idx: i + 1, desc: sk.desc || '',
        reason: (unknown.length ? '未注册特征:' + unknown.join(',') : '') +
                (badNew.length ? ' 新特征未注册:' + badNew.map(function (n) { return n.name; }).join(',') : '') });
      continue;
    }
    var base = {
      id: 'v3sk_' + hash(JSON.stringify(sk)),
      desc: '[v3草图] ' + (sk.desc || ''),
      when: sk.when || [], unless: sk.unless || [], expect: sk.expect || 'up',
      status: 'sketch_variant', origin: 'llm_v3_sketch',
      basis: sk.basis || '', verifyNeed: sk.verifyNeed || '',
      dataNeeds: sk.dataNeeds || [], createdAt: stamp(),
      deps: conds.map(function (c) { return c && c.f; }).filter(Boolean)
    };
    var variants = P.expandSketch(base);
    variants.forEach(function (v) {
      if (injected.length >= MAX_PER_RUN || room <= 0) return;
      if (seen[v.id]) { skipped.push({ idx: i + 1, desc: v.id, reason: '重复 id' }); return; }
      seen[v.id] = true; room--;
      injected.push(v);
      if (!dry) pop.rules.push(v);
    });
  }

  if (injected.length && !dry) saveJSON(POP, pop);
  console.log(JSON.stringify({
    at: stamp(), dry: dry, model: result.model || doc.model || '',
    sketchesIn: sketches.length, variantsInjected: injected.length,
    ids: injected.map(function (v) { return v.id; }).slice(0, 8),
    skipped: skipped, stockAfter: dry ? stock : pop.rules.filter(function (r) { return r.status === 'sketch_variant'; }).length,
    note: 'status=sketch_variant；下代 generation() 由 kernel+settle 真实验证，未验证前不进 active'
  }, null, 2));
}
main();
