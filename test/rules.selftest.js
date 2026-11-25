import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cnMobile, cnIdCard, cnUscc, luhn, ipv4 } from '../src/validators.js';

const here = dirname(fileURLToPath(import.meta.url));
const base = resolve(here, '..');
const files = ['contact','identity','credential','finance','network','semantic'];
const allowedCategories = new Set(['contact','identity','credential','finance','network','custom']);
const allowedTiers = new Set(['format','semantic']);
const allowedSeverities = new Set(['high','medium','low']);
const allowedValidators = { cnMobile, cnIdCard, cnUscc, luhn, ipv4 };
let passed = 0;
let failed = 0;

function check(name, fn) {
  try { fn(); passed += 1; }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.message}`); }
}
function assertRuleMatches(rule, sample) {
  for (const m of rule.match) {
    if (m.type !== 'regex') continue;
    const re = new RegExp(m.pattern, `${m.flags || ''}gd`);
    let match;
    while ((match = re.exec(sample)) !== null) {
      if (match[0].length === 0) { re.lastIndex += 1; continue; }
      const group = m.valueGroup ?? 0;
      const value = match[group];
      if (value === undefined) continue;
      if (m.validate && !allowedValidators[m.validate](value)) continue;
      return true;
    }
  }
  return false;
}
function hasNestedQuantifier(pattern) {
  // Heuristic: a quantified group containing an inner quantifier, then itself quantified.
  return /\((?:[^()\\]|\\.)*(?:[*+]|\{[0-9]+(?:,[0-9]*)?\})(?:[^()\\]|\\.)*\)(?:[*+]|\{[0-9]+,\})/.test(pattern);
}
function hasUnboundedDotAll(pattern) {
  return /\[\\s\\S\](?:[*+]|\{[0,]\})/.test(pattern);
}

const allRules = [];
for (const name of files) {
  check(`${name}.json parses`, () => {
    const data = JSON.parse(awaitRead(`${base}/rules/zh-CN/${name}.json`));
    assert.equal(data.locale, 'zh-CN');
    assert.ok(Array.isArray(data.rules));
    allRules.push(...data.rules);
  });
}
function awaitRead(path) {
  // Files are synchronously loaded below by a preloaded cache for simple zero-dependency Node execution.
  return readFileSync(path);
}
import { readFileSync } from 'node:fs';

const seen = new Set();
check('rule count is exactly 25', () => assert.equal(allRules.length, 25));
check('all rule ids are globally unique', () => {
  for (const r of allRules) { assert.ok(!seen.has(r.id), `duplicate id ${r.id}`); seen.add(r.id); }
});
for (const r of allRules) {
  check(`${r.id}: required fields and enums`, () => {
    for (const key of ['id','label','category','tier','severity','token','match','note']) assert.ok(Object.hasOwn(r,key), `missing ${key}`);
    assert.ok(allowedCategories.has(r.category));
    assert.ok(allowedTiers.has(r.tier));
    assert.ok(allowedSeverities.has(r.severity));
    assert.ok(typeof r.note === 'string' && r.note.length > 0);
    assert.ok(Array.isArray(r.match) && r.match.length > 0);
  });
  check(`${r.id}: token format`, () => assert.match(r.token, /^[A-Z]{2,12}$/));
  for (const [i,m] of r.match.entries()) {
    check(`${r.id}[${i}]: match type`, () => assert.ok(m.type === 'regex' || m.type === 'literal'));
    if (m.validate) check(`${r.id}[${i}]: validator allowed`, () => assert.ok(Object.hasOwn(allowedValidators,m.validate)));
    if (m.type === 'regex') {
      check(`${r.id}[${i}]: regex compiles`, () => new RegExp(m.pattern, 'gd'));
      check(`${r.id}[${i}]: no forbidden escapes`, () => {
        assert.ok(!/\\d/.test(m.pattern), 'contains \\d; use [0-9]');
        assert.ok(!/\\\./.test(m.pattern), 'contains \\. ; use [.]');
      });
      check(`${r.id}[${i}]: no nested quantifier`, () => assert.ok(!hasNestedQuantifier(m.pattern), 'nested quantifier detected'));
      check(`${r.id}[${i}]: no unbounded dotAll`, () => assert.ok(!hasUnboundedDotAll(m.pattern), 'unbounded [\\s\\S]* detected'));
    }
  }
}
const samples = JSON.parse(readFileSync(`${base}/test/rule-samples.json`, 'utf8'));
check('samples cover exactly all rule ids', () => {
  assert.deepEqual(Object.keys(samples).sort(), allRules.map(r=>r.id).sort());
});
for (const [ruleId, cases] of Object.entries(samples)) {
  for (const [i, item] of (cases.regression || []).entries()) {
    const rule = allRules.find(candidate => candidate.id === ruleId);
    check(`${ruleId}: regression ${i + 1}`, () => {
      assert.ok(rule, `unknown rule ${ruleId}`);
      const regexMatches = [];
      for (const matcher of rule.match) {
        if (matcher.type !== 'regex') continue;
        const re = new RegExp(matcher.pattern, 'gd');
        let match;
        while ((match = re.exec(item.text)) !== null) {
          if (match[0].length === 0) { re.lastIndex += 1; continue; }
          const group = matcher.valueGroup ?? 0;
          const value = match[group];
          if (value !== undefined && (!matcher.validate || allowedValidators[matcher.validate](value))) {
            const span = group > 0 ? match.indices[group] : [match.index, match.index + match[0].length];
            regexMatches.push(item.text.slice(span[0], span[1]));
          }
        }
      }
      if (item.expected === null) assert.deepEqual(regexMatches, []);
      else assert.ok(regexMatches.includes(item.expected), `expected exact match ${item.expected}, got ${regexMatches.join('|')}`);
    });
  }
}

for (const r of allRules) {
  const sample = samples[r.id];
  if (!sample) continue;
  check(`${r.id}: two positive and two negative samples`, () => {
    assert.equal(sample.positive.length, 2);
    assert.equal(sample.negative.length, 2);
  });
  for (const [i,s] of (sample.positive || []).entries()) {
    check(`${r.id}: positive ${i+1}`, () => assert.equal(assertRuleMatches(r,s), true, `expected hit: ${s}`));
  }
  for (const [i,s] of (sample.negative || []).entries()) {
    check(`${r.id}: negative ${i+1}`, () => assert.equal(assertRuleMatches(r,s), false, `unexpected hit: ${s}`));
  }
}
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
