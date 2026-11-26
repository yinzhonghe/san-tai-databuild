/*
 * tools/evolve/expr.js · 受限表达式白名单求值器（C 分支定稿）
 * ==============================================================
 * 模型可以造新特征（数学表达式），但绝不允许自由 JS / eval / 访问文件或网络。
 * 实现：自己写一个极小的递归下降解析器，只认白名单函数 + 已注册特征变量 + 数字常量。
 *
 * 语法（BNF 简化）：
 *   expr    := term (('+'|'-') term)*
 *   term    := factor (('*'|'/') factor)*
 *   factor  := '-'? primary
 *   primary := number | feature_name | func '(' expr (',' expr)* ')' | '(' expr ')'
 * 白名单函数：abs, min, max, sqrt, sign, log1p, clamp(x,lo,hi), rank(x)（横截面占位，运行时由 ctx 提供）
 *
 * 可复现检查：表达式引用的所有特征必须在 FEAT.META 注册；在 panel 上重算覆盖率≥95% 才算可复现。
 *
 * 用法：
 *   node tools/evolve/expr.js --eval "div(volSqueeze20, 2)" '{"volSqueeze20":0.8}'
 *   node tools/evolve/expr.js --check "abs(ret5)"   # 检查语法+依赖
 */
'use strict';
var FEAT = require('./features.js');

var FUNCS = {
  abs: { arity: 1, fn: Math.abs },
  min: { arity: 2, fn: Math.min },
  max: { arity: 2, fn: Math.max },
  sqrt: { arity: 1, fn: Math.sqrt },
  sign: { arity: 1, fn: Math.sign },
  log1p: { arity: 1, fn: function (x) { return Math.log(1 + x); } },
  clamp: { arity: 3, fn: function (x, lo, hi) { return Math.max(lo, Math.min(hi, x)); } },
  rank: { arity: 1, fn: function (x, ctx) { return (ctx && isNum(ctx.rankOf) && ctx.rankOf[x] != null) ? ctx.rankOf[x] : null; }, crossSectional: true }
};
function isNum(v) { return typeof v === 'number' && isFinite(v); }

/* 词法分析：只产出白名单 token，任何未知字符直接抛错 */
function tokenize(src) {
  var tokens = [], i = 0;
  while (i < src.length) {
    var ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      var m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
      if (!m) throw new Error('非法数字 at ' + i);
      tokens.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      var m2 = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i));
      var name = m2[0];
      tokens.push({ t: FUNCS[name] ? 'func' : 'var', v: name }); i += name.length; continue;
    }
    if ('+-*/(),'.indexOf(ch) >= 0) { tokens.push({ t: ch, v: ch }); i++; continue; }
    throw new Error('非法字符 "' + ch + '" at ' + i + '（禁止自由代码）');
  }
  tokens.push({ t: 'eof', v: '' });
  return tokens;
}

/* 递归下降解析器 → AST。只产出白名单节点。 */
function parse(src) {
  var ts = tokenize(src), pos = 0;
  function peek() { return ts[pos]; }
  function eat(t) { if (ts[pos].t !== t) throw new Error('期望 ' + t + ' 实际 ' + ts[pos].t); return ts[pos++]; }
  function expr() {
    var node = term();
    while (peek().t === '+' || peek().t === '-') {
      var op = ts[pos++].t; node = { op: op, a: node, b: term() };
    }
    return node;
  }
  function term() {
    var node = factor();
    while (peek().t === '*' || peek().t === '/') {
      var op = ts[pos++].t; node = { op: op, a: node, b: factor() };
    }
    return node;
  }
  function factor() {
    if (peek().t === '-') { pos++; return { op: 'neg', a: factor() }; }
    return primary();
  }
  function primary() {
    var tk = peek();
    if (tk.t === 'num') { pos++; return { op: 'num', v: tk.v }; }
    if (tk.t === 'var') {
      pos++;
      if (!FEAT.META[tk.v]) throw new Error('未注册特征: ' + tk.v + '（禁止编造字段）');
      return { op: 'var', v: tk.v };
    }
    if (tk.t === 'func') {
      var name = tk.v, spec = FUNCS[name]; pos++;
      eat('('); var args = [];
      if (peek().t !== ')') {
        args.push(expr());
        while (peek().t === ',') { pos++; args.push(expr()); }
      }
      eat(')');
      if (args.length !== spec.arity) throw new Error(name + ' 需要 ' + spec.arity + ' 个参数，实际 ' + args.length);
      return { op: 'call', name: name, args: args };
    }
    if (tk.t === '(') { pos++; var n = expr(); eat(')'); return n; }
    throw new Error('意外 token: ' + tk.t);
  }
  var ast = expr();
  if (peek().t !== 'eof') throw new Error('表达式尾部有残余: ' + peek().t);
  return ast;
}

/* 求值：values=特征名→数值；ctx 提供横截面 rank 等运行时数据。缺数据返回 null（fail-closed）。 */
function evalAST(node, values, ctx) {
  switch (node.op) {
    case 'num': return node.v;
    case 'var': return isNum(values[node.v]) ? values[node.v] : null;
    case 'neg': { var a = evalAST(node.a, values, ctx); return a == null ? null : -a; }
    case '+': case '-': case '*': case '/': {
      var x = evalAST(node.a, values, ctx), y = evalAST(node.b, values, ctx);
      if (!isNum(x) || !isNum(y)) return null;
      if (node.op === '/' && y === 0) return null;
      return node.op === '+' ? x + y : node.op === '-' ? x - y : node.op === '*' ? x * y : x / y;
    }
    case 'call': {
      var args = node.args.map(function (a) { return evalAST(a, values, ctx); });
      if (args.some(function (a) { return !isNum(a); })) return null;
      var spec = FUNCS[node.name];
      return spec.crossSectional ? spec.fn.apply(null, args.concat([ctx]))
        : spec.fn.apply(null, args);
    }
    default: return null;
  }
}

function compile(src) {
  var ast = parse(src);
  return {
    expr: src,
    deps: (function walk(n, out) {
      if (n.op === 'var') out.push(n.v);
      if (n.a) walk(n.a, out);
      (n.args || []).forEach(function (a) { walk(a, out); });
      return out.filter(function (v, i, arr) { return arr.indexOf(v) === i; });
    })(ast, []),
    eval: function (values, ctx) { return evalAST(ast, values || {}, ctx || {}); }
  };
}

/* 可复现检查：依赖注册 + 面板覆盖率≥95%（抽样 2000 行即可，避免每次扫 108 万） */
function checkReproducible(compiled, sampleRows) {
  var missing = compiled.deps.filter(function (d) { return !FEAT.META[d]; });
  if (missing.length) return { ok: false, reason: '未注册特征: ' + missing.join(',') };
  if (!sampleRows || !sampleRows.length) return { ok: false, reason: '无样本可验' };
  var valid = 0;
  sampleRows.forEach(function (s) {
    var v = compiled.eval(s.f || {});
    if (isNum(v)) valid++;
  });
  var rate = valid / sampleRows.length;
  return { ok: rate >= 0.95, coverage: +rate.toFixed(4),
    reason: rate >= 0.95 ? '可复现' : '覆盖率 ' + (rate * 100).toFixed(1) + '% < 95%' };
}

function main() {
  var args = process.argv.slice(2);
  if (args[0] === '--eval') {
    var c = compile(args[1]);
    var vals = args[2] ? JSON.parse(args[2]) : {};
    console.log(JSON.stringify({ expr: args[1], deps: c.deps, result: c.eval(vals) }));
    return;
  }
  if (args[0] === '--check') {
    try {
      var c2 = compile(args[1]);
      console.log(JSON.stringify({ ok: true, expr: args[1], deps: c2.deps }));
    } catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }
  console.log('用法: --eval "<expr>" \'{"volSqueeze20":0.8}\' | --check "<expr>"');
}
if (require.main === module) main();
module.exports = { compile: compile, parse: parse, FUNCS: FUNCS, checkReproducible: checkReproducible };
