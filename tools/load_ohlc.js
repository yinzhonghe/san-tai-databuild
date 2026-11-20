'use strict';
/*
 * 行情加载器（兼容三种存放形态）
 *   1) 分片：ohlc_v2_p0..p7.json.gz  → 合并为 {asOf, codes:{code:{n,list,last,dead,bars}}}
 *   2) 单片：process.env.OHLC 指定
 *   3) 旧版：ohlc.json.gz {bars:{code:[[...]]}}
 * 统一返回 {asOf, basis, codes:{code:{name/list/last/dead,bars}}, legacy}
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.dirname(__dirname);

function normalize(src, legacy) {
  const codes = {};
  Object.keys(src).forEach(function (code) {
    const v = src[code];
    if (legacy) {
      codes[code] = { n: '', list: v[0] && v[0][0], last: v[v.length - 1][0], dead: 0, bars: v };
    } else {
      codes[code] = { n: v.n || '', list: v.list, last: v.last, dead: v.dead || 0, bars: v.bars };
    }
  });
  return codes;
}

function load() {
  const env = process.env.OHLC;
  if (env && /ohlc_v2/.test(env)) {
    const files = [];
    for (let i = 0; i < 16; i++) {
      const f = path.join(ROOT, 'ohlc_v2_p' + i + '.json.gz');
      if (fs.existsSync(f)) files.push(f);
    }
    if (files.length) {
      const out = { asOf: '', basis: '', codes: {}, legacy: false, parts: files.length };
      files.forEach(function (f) {
        const part = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString());
        if (part.asOf > out.asOf) out.asOf = part.asOf;
        out.basis = out.basis || part.basis;
        Object.keys(part.codes).forEach(function (c) { out.codes[c] = part.codes[c]; });
      });
      return out;
    }
  }
  const file = env || (fs.existsSync(path.join(ROOT, 'ohlc_v2_p0.json.gz')) ? null : 'ohlc.json.gz');
  if (file) {
    const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, file))).toString());
    const legacy = !!raw.bars;
    const src = legacy ? raw.bars : raw.codes;
    return { asOf: raw.asOf || '', basis: raw.basis || '', codes: normalize(src, legacy), legacy: legacy, parts: 1 };
  }
  // 默认：分片
  const files = [];
  for (let i = 0; i < 16; i++) {
    const f = path.join(ROOT, 'ohlc_v2_p' + i + '.json.gz');
    if (fs.existsSync(f)) files.push(f);
  }
  const out = { asOf: '', basis: '', codes: {}, legacy: false, parts: files.length };
  files.forEach(function (f) {
    const part = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString());
    if (part.asOf > out.asOf) out.asOf = part.asOf;
    if (part.basis && !out.basis) out.basis = part.basis;
    Object.keys(part.codes).forEach(function (c) { out.codes[c] = part.codes[c]; });
  });
  return out;
}

module.exports = { load, ROOT };
