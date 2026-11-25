import assert from 'node:assert/strict';
import { Session, placeholder, placeholderName } from '../src/session.js';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
  }
}

check('同一个值返回同一个占位符', () => {
  const session = new Session();
  assert.equal(session.tokenFor('手机号', '13800138000'), session.tokenFor('手机号', '13800138000'));
});

check('连字符与空格归一化后复用占位符', () => {
  const session = new Session();
  const token = session.tokenFor('手机号', '13800138000');
  assert.equal(session.tokenFor('手机号', '138-0013-8000'), token);
  assert.equal(session.tokenFor('手机号', '138 0013 8000'), token);
});

check('占位符是可读标签，不是随机码', () => {
  const session = new Session();
  assert.equal(session.tokenFor('手机号', '13800138000'), '[手机号]');
  assert.equal(session.tokenFor('身份证', '110101199003071233'), '[身份证]');
});

check('同类不同值递增编号', () => {
  const session = new Session();
  assert.equal(session.tokenFor('手机号', '13800138000'), '[手机号]');
  assert.equal(session.tokenFor('手机号', '13900139000'), '[手机号_2]');
  assert.equal(session.tokenFor('手机号', '13700137000'), '[手机号_3]');
  assert.equal(session.tokenFor('身份证', '110101199003071233'), '[身份证]');
});

check('lookup 返回首次见到的原值', () => {
  const session = new Session();
  const token = session.tokenFor('手机号', '13800138000');
  session.tokenFor('手机号', '138-0013-8000');
  assert.equal(session.lookup(token), '13800138000');
});

check('未知占位符 lookup 返回 undefined', () => {
  assert.equal(new Session().lookup('[不存在]'), undefined);
});

check('size 统计映射条数', () => {
  const session = new Session();
  session.tokenFor('手机号', '13800138000');
  session.tokenFor('身份证', '110101199003071233');
  assert.equal(session.size(), 2);
});

check('clear 清空并重置编号', () => {
  const session = new Session();
  const token = session.tokenFor('手机号', '13800138000');
  session.clear();
  assert.equal(session.size(), 0);
  assert.equal(session.lookup(token), undefined);
  assert.equal(session.tokenFor('手机号', '13900139000'), '[手机号]');
});

check('entries 长度等于 size', () => {
  const session = new Session();
  session.tokenFor('手机号', '13800138000');
  session.tokenFor('邮箱', 'a@b.com');
  assert.equal(session.entries().length, session.size());
});

check('达到 maxEntries 后整体清空重建', () => {
  const session = new Session({ maxEntries: 3 });
  session.tokenFor('手机号', '13800000001');
  session.tokenFor('手机号', '13800000002');
  session.tokenFor('手机号', '13800000003');
  assert.equal(session.size(), 3);
  session.tokenFor('手机号', '13800000004');
  assert.equal(session.size(), 1);
});

check('500 条映射产出 500 个互不相同的占位符', () => {
  const session = new Session({ maxEntries: 501 });
  const tokens = new Set();
  for (let i = 0; i < 500; i += 1) tokens.add(session.tokenFor('编号', `X${i}`));
  assert.equal(tokens.size, 500);
});

check('null / undefined 值抛 TypeError', () => {
  const session = new Session();
  assert.throws(() => session.tokenFor('手机号', null), TypeError);
  assert.throws(() => session.tokenFor('手机号', undefined), TypeError);
});

check('maxEntries 必须是 ≥1 的整数', () => {
  for (const maxEntries of [0, -1, 1.5, NaN, '3']) {
    assert.throws(() => new Session({ maxEntries }), TypeError);
  }
});

check('标签里的方括号与空白被剥掉', () => {
  assert.equal(placeholderName('[手机 号]'), '手机号');
  assert.equal(placeholderName('IP 地址'), 'IP地址');
});

check('空标签回退到 REDACTED', () => {
  assert.equal(placeholderName(''), 'REDACTED');
  assert.equal(placeholderName(undefined), 'REDACTED');
});

check('过长标签截断到 20 字', () => {
  assert.equal(placeholderName('一'.repeat(50)).length, 20);
});

check('placeholder 组装规则', () => {
  assert.equal(placeholder('手机号', 1), '[手机号]');
  assert.equal(placeholder('手机号', 2), '[手机号_2]');
  assert.equal(placeholder('手机号', 12), '[手机号_12]');
});

check('所有占位符都满足统一外形', () => {
  const session = new Session();
  const tokens = [
    session.tokenFor('手机号', '13800138000'),
    session.tokenFor('IP 地址', '10.1.2.3'),
    session.tokenFor('一'.repeat(40), 'x')
  ];
  for (const token of tokens) assert.match(token, /^\[[^[\]\n]{1,20}\]$/);
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
