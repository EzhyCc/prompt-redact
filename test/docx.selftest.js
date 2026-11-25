// docx 两条命令的端到端自测：redact（保格式脱敏）→ compose（保格式填充）。
// 全部纯 JS：fixture 由 test/helpers/make-docx.js 用我们自己的 zip 写入器生成，
// 不需要 Python、不需要 Office、不需要任何外部程序。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractOfficeText } from '../tools/extract/office.js';
import { readZip } from '../tools/extract/zip.js';
import { makeDocx } from './helpers/make-docx.js';
import { composeDocxBuffer } from '../tools/docx/compose.js';
import { redactDocxBuffer, withOrgFallback } from '../tools/docx/redact.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_DIR = join(HERE, '..', 'rules', 'zh-CN');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failed += 1; process.stderr.write(`FAIL ${name}: ${error.message}\n`); }
}

function loadRules() {
  const rules = [];
  for (const file of readdirSync(RULES_DIR)) {
    if (!file.endsWith('.json') || file === 'manifest.json') continue;
    rules.push(...(JSON.parse(readFileSync(join(RULES_DIR, file), 'utf8')).rules ?? []));
  }
  return rules;
}

const WORK = mkdtempSync(join(tmpdir(), 'pr-docx-'));

try {
  const fixture = makeDocx({
    creator: '张三',
    paragraphs: [
      { text: '1 项目简介', style: 'Heading1', fontSize: 32 },
      { text: '建设单位：某某科技有限公司，联系人张三，手机 13800138000。', author: '张三', fontSize: 24 },
      { text: '2 初验目的', style: 'Heading1', fontSize: 32 },
      { text: '原模板里的说明文字。', fontSize: 24 },
      { text: '3 初验标准', style: 'Heading1', fontSize: 32 },
      { text: '子项标题', style: 'Heading5', fontSize: 21 },
      { text: '(1) 电子病历归档系统；', fontSize: 24 }
    ]
  });
  writeFileSync(join(WORK, '模板.docx'), fixture);

  check('fixture 生成（用我们自己的 zip 写入器）', () => {
    const entries = readZip(fixture);
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'docProps/core.xml']) {
      assert.ok(entries.has(name), `缺 ${name}`);
    }
  });

  // ── redact ────────────────────────────────────────────────────────
  const rules = withOrgFallback(loadRules());
  const redacted = redactDocxBuffer(fixture, {
    rules,
    terms: { 某某科技: '客户', 张三: '当事人' }
  });
  const redactedEntries = readZip(redacted.buffer);

  check('redact 统计不为零', () => {
    assert.ok(redacted.stats.paragraphsChanged >= 1, '没有段落被改写');
    assert.ok(redacted.stats.occurrences >= 2, '命中数太少');
  });

  check('脱敏后的正文没有原始敏感信息', () => {
    const text = extractOfficeText(redacted.buffer, '.docx');
    assert.ok(!text.includes('13800138000'), '手机号仍在');
    assert.ok(!text.includes('某某科技'), '公司名仍在');
    assert.ok(text.includes('[手机号]'), '缺少手机号占位符');
  });

  check('整个 docx 包内没有任何部件残留（含文档属性与修订作者）', () => {
    const dirty = [];
    for (const [name, data] of redactedEntries) {
      if (!name.endsWith('.xml')) continue;
      const text = data.toString('utf8');
      for (const word of ['张三', '某某科技', '13800138000']) {
        if (text.includes(word)) dirty.push(`${name} 含 ${word}`);
      }
    }
    assert.deepEqual(dirty, [], dirty.join(' | '));
  });

  check('zip 读取器不遗漏包内部件（docProps/_rels）', () => {
    for (const name of ['docProps/core.xml', '_rels/.rels']) {
      assert.ok(redactedEntries.has(name), `缺少 ${name}`);
    }
  });

  check('文档属性里的作者被替换成占位符', () => {
    const xml = redactedEntries.get('docProps/core.xml').toString('utf8');
    assert.ok(!xml.includes('张三'), '作者名仍在');
    assert.ok(xml.includes('[当事人]'), '作者没被替换成占位符');
  });

  check('修订记录的作者属性被替换', () => {
    const xml = redactedEntries.get('word/document.xml').toString('utf8');
    assert.ok(!/w:author="张三"/.test(xml), 'w:author 仍是真名');
    assert.ok(/w:author="\[当事人\]"/.test(xml), 'w:author 没被替换成占位符');
  });

  check('映射表记录了占位符与原值', () => {
    const keys = Object.keys(redacted.tokens);
    assert.ok(keys.length >= 2, `只有 ${keys.length} 条`);
    assert.ok(keys.includes('[手机号]'));
  });

  check('章节标题保留', () => {
    const text = extractOfficeText(redacted.buffer, '.docx');
    assert.ok(text.includes('项目简介'));
    assert.ok(text.includes('初验目的'));
  });

  // ── compose ───────────────────────────────────────────────────────
  const content = {
    项目简介: ['本项目为[医院]电子病历归档数据管理系统（一期）建设。', '数据库每日 02:00 全量备份。'],
    初验目的: ['确认承建单位按合同完成本期全部建设内容。'],
    初验标准: ['（1）电子病历归档系统：应用可正常启动。']
  };
  const composed = composeDocxBuffer(redacted.buffer, content);
  const composedEntries = readZip(composed.buffer);
  const composedXml = composedEntries.get('word/document.xml').toString('utf8');
  const composedText = extractOfficeText(composed.buffer, '.docx');

  check('compose 匹配到全部章节', () => {
    assert.equal(composed.stats.chapters, 3, `只匹配到 ${composed.stats.chapters} 章`);
    assert.deepEqual(composed.stats.missing, []);
  });

  check('成品里是新内容、旧正文已清掉', () => {
    assert.ok(composedText.includes('电子病历归档数据管理系统'), '缺少新内容');
    assert.ok(composedText.includes('[医院]'), '占位符丢失');
    assert.ok(!composedText.includes('原模板里的说明文字'), '旧正文没清掉');
  });

  check('成品保留章节标题与子标题', () => {
    assert.ok(composedText.includes('项目简介'));
    assert.ok(composedText.includes('初验目的'));
    assert.ok(/Heading5|w:val="Heading5"/.test(composedXml) || composedText.includes('初验标准'));
  });

  // 字号继承：正文底稿是 24（12pt），标题是 32（16pt）。
  // 新插入的段落必须带正文底稿的 w:sz=24，而不是标题的 32。
  check('新段落继承了正文底稿的字号（不是标题字号）', () => {
    const bodySizes = composedXml.match(/<w:sz w:val="24"\/>/g) ?? [];
    assert.ok(bodySizes.length >= 4, `正文段落字号标记只有 ${bodySizes.length} 个`);
    const bodyParagraphs = (composedXml.match(/<w:p>(?:(?!<w:p>)[\s\S])*?电子病历归档数据管理系统[\s\S]*?<\/w:p>/g) ?? []);
    assert.ok(bodyParagraphs.length > 0, '找不到新插入的段落');
    for (const paragraph of bodyParagraphs) {
      assert.ok(paragraph.includes('<w:sz w:val="24"/>'), '新段落没继承正文字号');
      assert.ok(!paragraph.includes('<w:sz w:val="32"/>'), '新段落被套上了标题字号');
    }
  });

  check('克隆段落不携带列表编号（避免和手写的（1）（2）重复）', () => {
    assert.ok(!/<w:numPr>/.test(composedXml), '克隆段落里残留了 numPr');
  });

  check('成品自身没有残留真实标识', () => {
    const dirty = [];
    for (const [name, data] of composedEntries) {
      if (!name.endsWith('.xml')) continue;
      const text = data.toString('utf8');
      for (const word of ['张三', '某某科技', '13800138000']) {
        if (text.includes(word)) dirty.push(`${name} 含 ${word}`);
      }
    }
    assert.deepEqual(dirty, [], dirty.join(' | '));
  });
} finally {
  rmSync(WORK, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
