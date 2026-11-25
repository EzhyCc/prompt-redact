import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { redact, scan, resolveConflicts } from '../src/index.js';
import { Session } from '../src/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const ruleFiles = ['contact', 'identity', 'credential', 'finance', 'network', 'semantic'];
const rules = ruleFiles.flatMap(name => JSON.parse(readFileSync(resolve(root, `rules/zh-CN/${name}.json`), 'utf8')).rules);
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
    ['PHONE', '138-0013-8000'], ['IDCARD', '110101199003071233'],
    ['6222021234567894', '6222021234567894'], ['EMPID', 'A1027'],
    ['EMAIL', 'zhang.san@yunshen-tech.com.cn'], ['IP', '10.12.33.44'],
    ['DBURI', 'mysql://root:Pa55w0rd@10.12.33.9:3306/prod'],
    ['APIKEY', 'sk-proj-AbCdEf1234567890XyZq'], ['PASSWORD', 'Qwe!2345']
  ];
  for (const [kind, raw] of required) {
    assert.ok(!mainResult.text.includes(raw), `${kind}: original value remains`);
    assert.ok(mainResult.hits.some(hit => hit.token.startsWith(`[${kind === '6222021234567894' ? 'CARD' : kind}_`)
      || (kind === '6222021234567894' && hit.token.startsWith('[ACCOUNT_'))), `${kind}: no replacement hit`);
  }
  assert.ok(mainResult.text.includes('深圳市云深科技有限公司'));
  assert.ok(mainResult.text.includes('张三'));
  assert.ok(mainResult.text.includes('工号 '));
  assert.ok(mainResult.text.includes('密码：'));
  assert.ok(!mainResult.text.includes('10.12.33.9:3306/prod'));
  assert.equal(mainResult.blocked, false);
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
  '订单号 2611260001234', '端口 8080', '版本 v1.2.3', '邮编 518000',
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
check('different Sessions produce different tokens', () => {
  const first = safeRedact('13800138000', { session: new Session() }).hits[0].token;
  const second = safeRedact('13800138000', { session: new Session() }).hits[0].token;
  assert.notEqual(first, second);
});
check('null Session uses a valid random token without throwing', () => {
  const result = safeRedact('13800138000', { session: null });
  assert.match(result.hits[0].token, /^\[[A-Z]{2,12}_[0-9A-F]{4}\]$/);
});
check('customTerms replaces literal term', () => {
  const result = safeRedact('张三今天到岗', { customTerms: ['张三'] });
  assert.match(result.text, /^\[TERM_[0-9A-F]{4}\]今天到岗$/);
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
// 注意：输入里必须真的含有一个会产生 [PHONE_xxxx] token 的值。
// 如果只传 'PHONE'（两个字），永远产不出 token，断言必然通过，等于没测。
check('customTerms PHONE does not match inside a produced token', () => {
  const result = safeRedact('电话 13800138000', { customTerms: ['PHONE'], session: new Session() });
  assert.match(result.text, /\[PHONE_[0-9A-F]{4}\]/);
  assert.equal(result.blocked, false);
  assert.equal(result.residuals.length, 0);
});
check('customTerms IP does not match inside a produced token', () => {
  const result = safeRedact('内网 10.1.2.3', { customTerms: ['IP'], session: new Session() });
  assert.match(result.text, /\[IP_[0-9A-F]{4}\]/);
  assert.equal(result.blocked, false);
  assert.equal(result.residuals.length, 0);
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
