import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { redact, scan, resolveConflicts } from '../src/index.js';
import { Session } from '../src/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const ruleFiles = readdirSync(resolve(root, 'rules/zh-CN'))
  .filter(name => name.endsWith('.json') && name !== 'manifest.json')
  .sort();
const rules = ruleFiles.flatMap(name => JSON.parse(readFileSync(resolve(root, `rules/zh-CN/${name}`), 'utf8')).rules);
const samples = JSON.parse(readFileSync(resolve(root, 'test/rule-samples.json'), 'utf8'));
let passed = 0;
let failed = 0;
let performanceElapsedMs = null;
function check(name, fn) {
  try { fn(); passed += 1; }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.stack || error.message}`); }
}
function safeRedact(text, options = {}) { return redact(text, { rules, ...options }); }

const mainInput = `甲方：深圳市云深科技有限公司
联系人 张三，手机 138-0013-8000，身份证 110101199003071233
回款卡号 6222021234567894，工号 A1027
邮箱 zhang.san@yunshen-tech.com.cn，内网 10.12.33.44
DB: mysql://root:Pa55w0rd@10.12.33.9:3306/prod
Key: sk-proj-AbCdEf1234567890XyZq
密码：Qwe!2345`;
const mainResult = safeRedact(mainInput);
check('§10.1 main sample: all required values are replaced', () => {
  const required = [
    ['手机号', '138-0013-8000'], ['身份证', '110101199003071233'],
    ['手机号', '6222021234567894'], ['工号/学号', 'A1027'],
    ['邮箱', 'zhang.san@yunshen-tech.com.cn'], ['IP 地址', '10.12.33.44'],
    ['数据库连接串', 'mysql://root:Pa55w0rd@10.12.33.9:3306/prod'],
    ['OpenAI 密钥', 'sk-proj-AbCdEf1234567890XyZq'], ['口令', 'Qwe!2345']
  ];
  for (const [label, raw] of required) {
    assert.ok(!mainResult.text.includes(raw), `${label}: original value remains`);
  }
  // 银行卡号这条会与 cn-bank-account 争同一段文本，谁赢都可以，但必须被替换
  assert.ok(mainResult.hits.some(hit => hit.label === '银行卡号' || hit.label === '银行账号'));
  for (const label of ['手机号', '身份证', '工号/学号', '邮箱', 'IP 地址', '数据库连接串', 'OpenAI 密钥', '口令']) {
    assert.ok(mainResult.hits.some(hit => hit.label === label), `${label}: no replacement hit`);
  }
  assert.ok(mainResult.text.includes('深圳市云深科技有限公司'));
  assert.ok(mainResult.text.includes('张三'));
  assert.ok(mainResult.text.includes('工号 '));
  assert.ok(mainResult.text.includes('密码：'));
  assert.ok(!mainResult.text.includes('10.12.33.9:3306/prod'));
  assert.equal(mainResult.blocked, false);
});
check('§10.1 占位符是中文语义标签，不是随机码', () => {
  for (const hit of mainResult.hits) {
    assert.match(hit.token, /^\[[^[\]\n]{1,20}\]$/, `unexpected token shape: ${hit.token}`);
    assert.ok(!/_[0-9A-F]{4}\]$/.test(hit.token), `随机码没有换掉: ${hit.token}`);
  }
  assert.ok(mainResult.text.includes('[手机号]'));
  assert.ok(mainResult.text.includes('[身份证]'));
});
check('§10.1 full database URI including database path is consumed', () => {
  const hit = scan(mainInput, rules).find(item => item.ruleId === 'db-uri');
  assert.ok(hit);
  assert.equal(hit.value, 'mysql://root:Pa55w0rd@10.12.33.9:3306/prod');
  assert.equal(mainInput.slice(hit.start, hit.end), hit.value);
});
check('§10.1 email-like substring inside postgres credentials is not matched', () => {
  assert.equal(scan('postgres://u:p@host', rules).some(hit => hit.ruleId === 'email'), false);
});

const negativeCases = [
  // 注意：不能用「订单号 xxx」——那条现在会被 bid-number 命中，属于预期行为
  '流水号 2611260001234', '端口 8080', '版本 v1.2.3', '邮编 518000',
  '110101199003071234', '6222021234567895', '12800138000'
];
for (const [i, sample] of negativeCases.entries()) {
  check(`§10.2 negative ${i + 1}`, () => assert.deepEqual(scan(sample, rules), []));
}

check('same Session reuses token for repeated phone value', () => {
  const session = new Session();
  const result = safeRedact('13800138000 / 13800138000', { session });
  assert.equal(result.hits.length, 2);
  assert.equal(result.hits[0].token, result.hits[1].token);
});
check('同一会话内同类不同值递增编号', () => {
  const session = new Session();
  const result = safeRedact('13800138000 和 13900139000', { session });
  assert.deepEqual(result.hits.map(hit => hit.token), ['[手机号]', '[手机号_2]']);
});
check('不传 Session 时同一次调用内仍然去重', () => {
  const result = safeRedact('13800138000 / 13800138000', { session: null });
  assert.equal(result.hits[0].token, result.hits[1].token);
  assert.match(result.hits[0].token, /^\[手机号\]$/);
});
check('customTerms replaces literal term with a readable placeholder', () => {
  const result = safeRedact('张三今天到岗', { customTerms: ['张三'] });
  assert.match(result.text, /^\[自定义词\]今天到岗$/);
});
check('semantic company rule is enabled only when requested', () => {
  const input = '请分析深圳市云深科技有限公司的供应链风险';
  assert.ok(safeRedact(input, { enableSemantic: false }).text.includes('深圳市云深科技有限公司'));
  assert.ok(!safeRedact(input, { enableSemantic: true }).text.includes('深圳市云深科技有限公司'));
});
for (const value of ['', null, undefined, 123]) {
  check(`invalid/empty input ${String(value)} does not throw`, () => {
    const result = safeRedact(value);
    assert.equal(result.text, '');
    assert.deepEqual(result.hits, []);
    assert.equal(result.blocked, false);
  });
}
check('empty rules return original text unchanged', () => {
  const result = redact('原文 13800138000', { rules: [] });
  assert.equal(result.text, '原文 13800138000');
  assert.equal(result.blocked, false);
});
check('serialized result contains no raw sensitive values', () => {
  const result = safeRedact('13800138000 110101199003071233 密码：Qwe!2345');
  const json = JSON.stringify(result);
  for (const raw of ['13800138000', '110101199003071233', 'Qwe!2345']) assert.ok(!json.includes(raw));
  for (const hit of result.hits) assert.equal(Object.hasOwn(hit, 'value'), false);
  for (const residual of result.residuals) assert.equal(Object.hasOwn(residual, 'value'), false);
});
check('resolveConflicts uses ruleId as deterministic final tie-breaker', () => {
  const base = { start: 0, end: 5, severity: 'high' };
  const result = resolveConflicts([{ ...base, ruleId: 'z-rule' }, { ...base, ruleId: 'a-rule' }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].ruleId, 'a-rule');
});
check('valueGroup positions are original-text coordinates', () => {
  const hit = scan('工号：A1027', rules).find(item => item.ruleId === 'employee-id');
  assert.ok(hit);
  assert.equal(hit.start, 3);
  assert.equal(hit.end, 8);
  assert.equal('工号：A1027'.slice(hit.start, hit.end), 'A1027');
});
// 个人词表里如果填了和占位符同名的词（例如「手机号」），
// 二次扫描会命中自己产出的占位符——必须靠 token 区间过滤挡掉，不能误报 blocked。
check('customTerms 与占位符同名时不产生假阻断', () => {
  const result = safeRedact('电话 13800138000', { customTerms: ['手机号'], session: new Session() });
  assert.equal(result.text, '电话 [手机号]');
  assert.equal(result.blocked, false);
  assert.equal(result.residuals.length, 0);
});
check('customTerms 与 IP 占位符同名时不产生假阻断', () => {
  const result = safeRedact('内网 10.1.2.3', { customTerms: ['IP地址'], session: new Session() });
  assert.equal(result.text, '内网 [IP地址]');
  assert.equal(result.blocked, false);
  assert.equal(result.residuals.length, 0);
});
// 关键词锚定 + valueGroup 的规则（密码：xxx / 税号：xxx）会把冒号后面的任何内容当值，
// 包括上一轮自己产出的占位符。不挡住的话，对已脱敏文本再跑一次会把占位符换成规则标签，
// 映射当场就断了——这个 bug 修过两次，两次都是换占位符格式之后复发的。
check('已经脱敏的文本再跑一次一字不改', () => {
  const once = safeRedact('密码：Qwe!2345，电话 13800138000，税号：91310000MA1FL0Q157', { session: new Session() });
  const twice = safeRedact(once.text, { session: new Session() });
  assert.equal(twice.text, once.text);
  assert.equal(twice.stats.total, 0);
});
check('旧格式随机码占位符不会被二次脱敏', () => {
  const text = '密码：[PASSWORD_DB67]，电话 [PHONE_7913]，卡号 [CARD_BEBB]';
  const result = safeRedact(text, { session: new Session() });
  assert.equal(result.text, text);
  assert.equal(result.stats.total, 0);
});
check('数字开头但不是占位符的值仍会被处理', () => {
  const result = safeRedact('密码：12345678', { session: new Session() });
  assert.equal(result.text, '密码：[口令]');
});

check('5000-character text is processed in under 20ms', () => {
  const longText = '普通文本'.repeat(1250);
  assert.equal(longText.length, 5000);
  safeRedact(longText); // warm-up
  const start = performance.now();
  safeRedact(longText);
  const elapsed = performance.now() - start;
  performanceElapsedMs = elapsed;
  assert.ok(elapsed < 20, `elapsed ${elapsed.toFixed(3)}ms`);
});

console.log('§10.1 主样例完整输出：');
console.log(JSON.stringify(mainResult, null, 2));
console.log(`5000 字性能实测：${performanceElapsedMs === null ? '未执行' : performanceElapsedMs.toFixed(3) + 'ms'}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
