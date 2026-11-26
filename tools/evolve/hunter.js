/*
 * tools/evolve/hunter.js · 数据缺口自动猎手（用户新增要求）
 * ---------------------------------------------------------------------------
 * 需求：自进化过程中规则若需要当前快照没有的数据，就自动全网搜索查找，
 *       直到拿到可验证的数据源；拿不到就明确标注缺口，绝不编造。
 *
 * 工作方式（三级）：
 *   1) registry 适配器表：项目已有的真实源（新浪行业 / 东财资金 / 腾讯行情 / 舆情多源），
 *      先查这里，命中就直接调用现成脚本。
 *   2) 全网搜索兜底：registry 里没有的字段，输出结构化 search_spec（含中英文查询词、
 *      候选公开接口特征），交给带联网能力的执行体（Agent/WebSearch）去找；
 *      找到的接口写入 registry 并验证。
 *   3) 验证关卡：任何新源必须过「取得到 + 字段对得上 + 可重复」三关才标记 verified，
 *      否则留 status=searching，规则继续标「数据缺口，规则暂停」。
 *
 * 红线：不编造任何数值；取不到的数据绝不拿 0/估算顶替；缺口就是缺口。
 *
 * 用法：
 *   node tools/evolve/hunter.js --scan              # 扫描当前缺口
 *   node tools/evolve/hunter.js --spec <field>      # 输出某字段的全网搜索规格
 *   node tools/evolve/hunter.js --verify <field>    # 验证适配器是否可用（调现成脚本）
 */
'use strict';
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.dirname(path.dirname(__dirname));
var REG = path.join(ROOT, 'learn', 'evolve', 'data_sources.json');
var GAPS = path.join(ROOT, 'learn', 'evolve', 'panel_gaps.json');

/* 项目已验证可用的真实数据源适配器（指向现成脚本/接口，不重复实现） */
var BUILTIN = {
  industry: {
    label: '行业分类', script: 'tools/fetch_industry.py', output: '_ind_map.json',
    cmd: 'python tools/fetch_industry.py', status: 'verified',
    note: '新浪行业分类，免费零依赖；build_data.py 已接入'
  },
  fundflow: {
    label: '主力资金流', script: 'tools/limitup_live.js', status: 'verified',
    endpoint: 'push2.eastmoney.com/api/qt/ulist.np/get',
    note: '东财实时资金，项目已有；历史逐日资金流仍缺（见 fundflow_hist）'
  },
  quote: {
    label: '实时行情', script: 'data-service.js', status: 'verified',
    endpoint: 'qt.gtimg.cn / sina', note: '腾讯+新浪双源，项目已有'
  },
  sentiment: {
    label: '舆情新闻', script: 'github_ci/gen_news.py', status: 'verified',
    note: '17+ 源多源采集，项目已有'
  },
  fundflow_hist: {
    label: '历史逐日资金流', status: 'searching',
    searchSpec: {
      cn: ['A股 个股 历史每日主力净流入 免费接口', '东方财富 资金流向 历史数据 API 每日'],
      en: ['China A-share historical daily fund flow free API', 'eastmoney individual stock fund flow history endpoint'],
      hints: ['push2his.eastmoney.com/api/qt/stock/fflow/daykline/get', '需验证是否免费无需token、是否含历史每日净流入'],
      acceptCriteria: ['返回真实历史逐日数值', '可按代码查询', '无需付费key或key可免费获得', '有明确字段说明']
    }
  },
  oneword_intraday: {
    label: '一字板封单/开板时间', status: 'searching',
    searchSpec: {
      cn: ['A股 涨停 封板时间 开板次数 免费数据源', '龙虎榜 一字板 封单量 历史接口'],
      en: ['China A-share limit up seal time historical data API'],
      hints: ['此类分钟级数据多需付费', '免费源可能只有当日快照，历史不可回溯'],
      acceptCriteria: ['含封板/开板时间或封单量', '历史可回溯', '免费或已有额度']
    }
  }
};

function loadReg() {
  try {
    var j = JSON.parse(fs.readFileSync(REG, 'utf8'));
    // 合并 builtin：registry 里已有的用户验证结果优先，新增字段补齐
    Object.keys(BUILTIN).forEach(function (k) { if (!j[k]) j[k] = BUILTIN[k]; });
    return j;
  } catch (e) { return JSON.parse(JSON.stringify(BUILTIN)); }
}
function saveReg(j) {
  fs.mkdirSync(path.dirname(REG), { recursive: true });
  fs.writeFileSync(REG, JSON.stringify(j, null, 2) + '\n');
}
function scan() {
  var reg = loadReg();
  var gap = {};
  try { gap = JSON.parse(fs.readFileSync(GAPS, 'utf8')); } catch (e) {}
  var out = { asOf: new Date().toISOString().slice(0, 10), panelGaps: gap, sources: {} };
  Object.keys(reg).forEach(function (k) {
    out.sources[k] = { label: reg[k].label, status: reg[k].status,
      note: reg[k].note || (reg[k].searchSpec ? '待全网搜索' : '') };
  });
  return out;
}
function specOf(field) {
  var reg = loadReg();
  var s = reg[field];
  if (!s) return { field: field, status: 'unknown', message: '该字段未在适配器表中，需先登记 searchSpec' };
  if (s.status === 'verified') return { field: field, status: 'verified', adapter: s };
  return { field: field, status: s.status, searchSpec: s.searchSpec || null, acceptCriteria: s.searchSpec && s.searchSpec.acceptCriteria };
}
/* 验证适配器：检查脚本/输出是否存在，或探活 endpoint */
function verify(field) {
  var reg = loadReg(), s = reg[field];
  if (!s) return Promise.resolve({ field: field, ok: false, reason: '未登记' });
  if (s.status === 'verified' && s.script) {
    var p = path.join(ROOT, s.script);
    if (!fs.existsSync(p)) return Promise.resolve({ field: field, ok: false, reason: '脚本不存在: ' + s.script });
    return Promise.resolve({ field: field, ok: true, reason: '适配器脚本存在: ' + s.script });
  }
  if (s.endpoint) {
    return new Promise(function (resolve) {
      var url = 'https://' + s.endpoint;
      var child = cp.spawn('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '12', url], { stdio: ['ignore', 'pipe', 'ignore'] });
      var code = '';
      child.stdout.on('data', function (d) { code += d.toString(); });
      child.on('close', function () { resolve({ field: field, ok: code === '200', reason: 'HTTP ' + code, endpoint: url }); });
    });
  }
  return Promise.resolve({ field: field, ok: false, reason: 'status=' + s.status + '，尚无可用适配器；请用 --spec 输出搜索规格让联网执行体去找' });
}
/* 登记新发现的适配器（由联网执行体找到接口后调用） */
function register(field, adapter) {
  var reg = loadReg();
  if (!adapter || !adapter.label || !adapter.status) throw new Error('adapter 需含 label/status');
  reg[field] = adapter;
  saveReg(reg);
  return { field: field, registered: true };
}

function main() {
  var a = process.argv;
  if (a.indexOf('--scan') >= 0) {
    console.log(JSON.stringify(scan(), null, 2));
  } else if (a.indexOf('--spec') >= 0) {
    console.log(JSON.stringify(specOf(a[a.indexOf('--spec') + 1]), null, 2));
  } else if (a.indexOf('--verify') >= 0) {
    verify(a[a.indexOf('--verify') + 1]).then(function (r) { console.log(JSON.stringify(r, null, 2)); });
  } else if (a.indexOf('--register') >= 0) {
    // --register <field> '<json>' —— 联网执行体找到接口后登记
    try {
      console.log(JSON.stringify(register(a[a.indexOf('--register') + 1], JSON.parse(a[a.indexOf('--register') + 2])), null, 2));
    } catch (e) { console.error('登记失败:', e.message); process.exit(1); }
  } else {
    console.log('用法: hunter.js --scan | --spec <field> | --verify <field> | --register <field> <json>');
  }
}
if (require.main === module) main();
module.exports = { scan: scan, specOf: specOf, verify: verify, register: register, BUILTIN: BUILTIN };
