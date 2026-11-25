// docx / xlsx 文本抽取 + 个人词表命名占位符 + 目录回填
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractOfficeText } from '../tools/extract/office.js';
import { readZip } from '../tools/extract/zip.js';
import { redact } from '../src/index.js';
import { Session } from '../src/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixture = name => readFileSync(join(here, 'fixtures', name));

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failed += 1; process.stderr.write(`FAIL ${name}: ${error.message}\n`); }
}

// ── zip 与 Office 抽取 ──────────────────────────────────────────────
check('zip 能列出条目', () => {
  const entries = readZip(fixture('sample.docx'));
  assert.ok(entries.size >= 1);
  assert.ok(entries.has('word/document.xml'), [...entries.keys()].join(','));
});

check('docx 抽出正文', () => {
  const text = extractOfficeText(fixture('sample.docx'), '.docx');
  assert.ok(text.includes('甲方'), text.slice(0, 80));
  assert.ok(text.includes('13800138000'), '手机号应当还在（这一步只抽取，不脱敏）');
  assert.ok(text.includes('\n'), '段落应当分行');
});

check('xlsx 抽出工作表与单元格', () => {
  const text = extractOfficeText(fixture('sample.xlsx'), '.xlsx');
  assert.ok(text.includes('--- sheet1 ---'), text.slice(0, 60));
  assert.ok(text.includes('\t'), '单元格之间应当是制表符');
  assert.ok(text.includes('1280000'), '数字单元格应当保留');
});

check('不认识的扩展名抛错', () => {
  assert.throws(() => extractOfficeText(fixture('sample.docx'), '.pdf'));
});

// ── 个人词表：命名占位符 ────────────────────────────────────────────
const rules = JSON.parse(readFileSync(join(root, 'rules/zh-CN/contact.json'), 'utf8')).rules
  .filter(rule => rule.id === 'cn-mobile');

check('数组写法的词表产出 [自定义词]', () => {
  const result = redact('甲方某某科技，手机 13800138000', { rules, session: new Session(), customTerms: ['某某科技'] });
  assert.equal(result.text, '甲方[自定义词]，手机 [手机号]');
});

check('对象写法的词表产出命名的占位符', () => {
  const result = redact('甲方某某科技某某医院，手机 13800138000', {
    rules, session: new Session(), customTerms: { 某某科技: '客户', 某某医院: '医院' }
  });
  assert.equal(result.text, '甲方[客户][医院]，手机 [手机号]');
});

check('两套词表混用', () => {
  const result = redact('张三在某某科技', {
    rules, session: new Session(), customTerms: ['张三', { value: '某某科技', label: '客户' }]
  });
  assert.equal(result.text, '[自定义词]在[客户]');
});

// ── 目录回填的等价逻辑（这里直接验字符串，目录遍历在 CLI 里） ────────
check('脱敏→回填能还原原文', () => {
  const source = '甲方：某某科技某某医院\n项目经理 张三，手机 13800138000';
  const session = new Session();
  const redacted = redact(source, { rules, session, customTerms: { 某某科技: '客户', 某某医院: '医院', 张三: '项目经理' } });
  assert.ok(!redacted.text.includes('某某科技'));
  let filled = redacted.text;
  for (const [token, value] of session.entries()) filled = filled.split(token).join(value);
  assert.equal(filled, source);
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
