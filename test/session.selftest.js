import assert from 'node:assert/strict';
import { Session, randomToken } from '../src/session.js';

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

check('same value returns the same token in one session', () => {
  const session = new Session();
  assert.equal(session.tokenFor('PHONE', '13800138000'), session.tokenFor('PHONE', '13800138000'));
});

check('whitespace/hyphen normalization reuses the token', () => {
  const session = new Session();
  const token = session.tokenFor('PHONE', '13800138000');
  assert.equal(session.tokenFor('PHONE', '138-0013-8000'), token);
});

check('different values receive different tokens', () => {
  const session = new Session();
  assert.notEqual(session.tokenFor('PHONE', '13800138000'), session.tokenFor('PHONE', '13900139000'));
});

check('token matches the required format', () => {
  assert.match(new Session().tokenFor('PHONE', '13800138000'), /^\[PHONE_[0-9A-F]{4}\]$/);
});

check('lookup preserves the first-seen original value', () => {
  const session = new Session();
  const token = session.tokenFor('PHONE', '13800138000');
  session.tokenFor('PHONE', '138-0013-8000');
  assert.equal(session.lookup(token), '13800138000');
});

check('different sessions generate independent tokens for the same value', () => {
  const first = new Session();
  const second = new Session();
  assert.notEqual(first.tokenFor('PHONE', '13800138000'), second.tokenFor('PHONE', '13800138000'));
});

check('500 mappings have 500 unique tokens', () => {
  const session = new Session({ maxEntries: 501 });
  const tokens = new Set();
  for (let i = 0; i < 500; i += 1) tokens.add(session.tokenFor('PHONE', `138${String(i).padStart(8, '0')}`));
  assert.equal(tokens.size, 500);
  assert.equal(session.size(), 500);
});

check('maxEntries clears all mappings before inserting the next one', () => {
  const session = new Session({ maxEntries: 3 });
  session.tokenFor('PHONE', '13800000001');
  session.tokenFor('PHONE', '13800000002');
  session.tokenFor('PHONE', '13800000003');
  assert.equal(session.size(), 3);
  session.tokenFor('PHONE', '13800000004');
  assert.equal(session.size(), 1);
});

check('clear removes mappings', () => {
  const session = new Session();
  const token = session.tokenFor('PHONE', '13800138000');
  session.clear();
  assert.equal(session.size(), 0);
  assert.equal(session.lookup(token), undefined);
});

check('entries length equals size', () => {
  const session = new Session();
  session.tokenFor('PHONE', '13800138000');
  session.tokenFor('EMAIL', 'user@example.com');
  assert.equal(session.entries().length, session.size());
});

check('invalid token type throws TypeError', () => {
  assert.throws(() => new Session().tokenFor('phone', 'x'), TypeError);
});

check('null and undefined values throw TypeError', () => {
  const session = new Session();
  assert.throws(() => session.tokenFor('PHONE', null), TypeError);
  assert.throws(() => session.tokenFor('PHONE', undefined), TypeError);
});

check('randomToken rejects invalid types', () => {
  assert.throws(() => randomToken('phone'), TypeError);
  assert.throws(() => randomToken('P'), TypeError);
});

check('maxEntries must be a positive integer', () => {
  for (const maxEntries of [0, -1, 1.5, NaN, '3']) {
    assert.throws(() => new Session({ maxEntries }), TypeError);
  }
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
