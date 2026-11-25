// 插件工具自测：验证 redact_docx / compose_docx 注册成功并能真正跑通。
// 不依赖宿主：defineTool 用假实现注入，ctx 是桩。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractOfficeText } from '../tools/extract/office.js';
import { toTermMap, registerFileTools } from '../lib/file-tools.js';
import { makeDocx } from './helpers/make-docx.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_DIR = join(HERE, '..', 'rules', 'zh-CN');

function loadRules() {
  const rules = [];
  for (const file of readdirSync(RULES_DIR)) {
    if (!file.endsWith('.json') || file === 'manifest.json') continue;
    rules.push(...(JSON.parse(readFileSync(join(RULES_DIR, file), 'utf8')).rules ?? []));
  }
  return rules;
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failed += 1; process.stderr.write(`FAIL ${name}: ${error.message}\n`); }
}

async function checkAsync(name, fn) {
  try { await fn(); passed += 1; process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failed += 1; process.stderr.write(`FAIL ${name}: ${error.message}\n`); }
}

const WORK = mkdtempSync(join(tmpdir(), 'pr-tools-'));

try {
  const registered = [];
  const ctx = { tools: { register: tool => registered.push(tool) } };
  const defineTool = spec => spec;

  const ok = await registerFileTools(ctx, { defineTool, getRules: loadRules, getTerms: () => ['张三'] });

  check('注册返回成功', () => assert.equal(ok, true));
  check('注册了两个工具', () => {
    assert.equal(registered.length, 2);
    const names = registered.map(t => t.name).sort();
    assert.deepEqual(names, ['compose_docx', 'redact_docx']);
  });

  check('工具都有描述与参数', () => {
    for (const tool of registered) {
      assert.ok(tool.description && tool.description.length > 10, `${tool.name} 缺描述`);
      assert.ok(tool.parameters && typeof tool.parameters === 'object', `${tool.name} 缺参数`);
      assert.equal(typeof tool.execute, 'function');
    }
  });

  check('toTermMap 支持字符串与数组', () => {
    assert.deepEqual(toTermMap('a=甲,b=乙'), { a: '甲', b: '乙' });
    assert.deepEqual(toTermMap(['张三']), { 张三: '自定义词' });
    assert.deepEqual(toTermMap(undefined), {});
  });

  // ── 真正调用 redact_docx ──────────────────────────────────────────
  const source = join(WORK, '合同.docx');
  writeFileSync(source, makeDocx({
    creator: '张三',
    paragraphs: [
      { text: '1 项目简介', style: 'Heading1', fontSize: 32 },
      { text: '联系人张三，手机 13800138000。', fontSize: 24 }
    ]
  }));

  const redactTool = registered.find(t => t.name === 'redact_docx');
  const redactResult = await redactTool.execute({ path: source, terms: '某某科技=客户' });

  check('redact_docx 返回成功并给出路径', () => {
    assert.equal(redactResult.ok, true, redactResult.error);
    assert.ok(existsSync(redactResult.redactedPath), '脱敏文件没生成');
    assert.ok(existsSync(redactResult.mapPath), '映射表没生成');
  });

  check('redact_docx 产出的内容确实脱敏了', () => {
    const text = extractOfficeText(readFileSync(redactResult.redactedPath), '.docx');
    assert.ok(!text.includes('13800138000'), '手机号仍在');
    assert.ok(text.includes('[手机号]'), '没有占位符');
  });

  await checkAsync('redact_docx 不存在的路径返回 ok:false', async () => {
    const bad = await redactTool.execute({ path: join(WORK, '没有这个文件.docx') });
    assert.equal(bad.ok, false);
    assert.ok(bad.error.includes('找不到文件'));
  });

  // ── 真正调用 compose_docx ─────────────────────────────────────────
  const composeTool = registered.find(t => t.name === 'compose_docx');
  const out = join(WORK, '成品.docx');
  const composeResult = await composeTool.execute({
    base: redactResult.redactedPath,
    content: JSON.stringify({ 项目简介: ['本项目为[医院]电子病历归档系统（一期）。'] }),
    out
  });

  check('compose_docx 返回成功并生成成品', () => {
    assert.equal(composeResult.ok, true, composeResult.error);
    assert.ok(existsSync(out), '成品没生成');
    assert.deepEqual(composeResult.chapters, ['项目简介']);
  });

  check('compose_docx 成品内容正确', () => {
    const text = extractOfficeText(readFileSync(out), '.docx');
    assert.ok(text.includes('电子病历归档系统'), '缺少新内容');
    assert.ok(!text.includes('陈年旧文'), '旧内容没清掉');
  });

  await checkAsync('compose_docx 遇到坏 JSON 返回 ok:false', async () => {
    const bad = await composeTool.execute({ base: redactResult.redactedPath, content: '{不是JSON', out });
    assert.equal(bad.ok, false);
  });

  // ── 宿主不支持 tools 时不能抛错 ───────────────────────────────────
  await checkAsync('没有 tools 能力时安全返回 false', async () => {
    assert.equal(await registerFileTools({}, { defineTool }), false);
    assert.equal(await registerFileTools(undefined, { defineTool }), false);
  });
} finally {
  rmSync(WORK, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
