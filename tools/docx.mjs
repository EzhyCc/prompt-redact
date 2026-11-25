#!/usr/bin/env node
// docx 相关命令的统一入口。纯 JS、零依赖：不需要 Python，不需要任何外部程序。
//
//   node tools/docx.mjs redact  --in 模板.docx --out 输出目录 [--terms "词=标签,..."] [--org]
//   node tools/docx.mjs compose --base 模板-脱敏.docx --content 内容.json --out 成品.docx
//
// redact 产出：
//   <输出目录>/<原名>-脱敏.docx      给模型看的模板（占位符，格式不变）
//   <输出目录>/<原名>.map.json       占位符 → 真实值（只留本地）
// compose 产出：
//   <成品路径>                       交付物

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeDocxBuffer } from './docx/compose.js';
import { redactDocxBuffer, withOrgFallback } from './docx/redact.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_DIR = join(HERE, '..', 'rules', 'zh-CN');

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function parse(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) { out._.push(token); continue; }
    const key = token.slice(2);
    if (key === 'org' || key === 'help' || key === 'json') { out[key] = true; continue; }
    out[key] = argv[index + 1];
    index += 1;
  }
  return out;
}

/** "词=标签,词2=标签2" → { 词: '标签', 词2: '标签2' } */
function parseTerms(raw) {
  const terms = {};
  for (const pair of String(raw ?? '').split(/[,，]/)) {
    const item = pair.trim();
    if (!item) continue;
    const [value, label] = item.split('=').map(part => part.trim());
    if (value) terms[value] = label || '自定义词';
  }
  return terms;
}

let ruleCache = null;
function loadRules() {
  if (ruleCache) return ruleCache;
  const rules = [];
  for (const file of readdirSync(RULES_DIR)) {
    if (!file.endsWith('.json') || file === 'manifest.json') continue;
    const data = JSON.parse(readFileSync(join(RULES_DIR, file), 'utf8'));
    rules.push(...(data.rules ?? []));
  }
  ruleCache = rules;
  return rules;
}

function redact(argv) {
  const args = parse(argv);
  if (!args.in || !args.out) {
    fail('用法：node tools/docx.mjs redact --in 模板.docx --out 输出目录 [--terms "词=标签,..."] [--org]');
  }
  if (!existsSync(args.in)) fail(`找不到输入文件：${args.in}`);

  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });

  const base = basename(args.in, extname(args.in));
  const redactedPath = join(outDir, `${base}-脱敏.docx`);
  const mapPath = join(outDir, `${base}.map.json`);

  const rules = args.org ? withOrgFallback(loadRules()) : loadRules();
  const started = Date.now();
  const { buffer, tokens, stats } = redactDocxBuffer(readFileSync(args.in), {
    rules,
    terms: parseTerms(args.terms)
  });
  writeFileSync(redactedPath, buffer);
  writeFileSync(mapPath, `${JSON.stringify({ tokens }, null, 2)}\n`, 'utf8');

  console.log(
    `部件 ${stats.parts} | 段落 ${stats.paragraphs}（改写 ${stats.paragraphsChanged}）`
    + ` | 文档属性改写 ${stats.looseChanged} | 作者属性改写 ${stats.attrsChanged}`
    + ` | 命中 ${stats.occurrences} 处 | ${Date.now() - started} ms`
  );
  console.log('');
  console.log(`脱敏模板：${redactedPath}`);
  console.log(`回填映射：${mapPath}（${Object.keys(tokens).length} 条，含真实值，只留本地）`);
  return 0;
}

function compose(argv) {
  const args = parse(argv);
  if (!args.base || !args.content || !args.out) {
    fail('用法：node tools/docx.mjs compose --base 模板-脱敏.docx --content 内容.json --out 成品.docx');
  }
  if (!existsSync(args.base)) fail(`找不到基底模板：${args.base}`);
  if (!existsSync(args.content)) fail(`找不到内容文件：${args.content}`);

  const content = JSON.parse(readFileSync(args.content, 'utf8'));
  const started = Date.now();
  const { buffer, stats } = composeDocxBuffer(readFileSync(args.base), content);

  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buffer);

  console.log(`匹配章节 ${stats.chapters}：${stats.matched.join('、')}`);
  if (stats.missing.length) console.log(`未匹配：${stats.missing.join('、')}`);
  console.log(`删除段落 ${stats.removed}，插入段落 ${stats.inserted} | ${Date.now() - started} ms`);
  console.log('');
  console.log(`成品：${outPath}`);
  return 0;
}

const HELP = `prompt-redact docx —— 保格式处理 Word 文档（纯 JS，零依赖）

  node tools/docx.mjs redact --in 模板.docx --out 输出目录 [--terms "词=标签,..."] [--org]
      就地脱敏，产出「<原名>-脱敏.docx」和「<原名>.map.json」两个文件。
      --terms  个人词表，逗号分隔，「词=标签」可指定占位符名字
      --org    兜底：把 XX公司/医院/大学/研究院/集团 一律替换成 [机构]

  node tools/docx.mjs compose --base 模板-脱敏.docx --content 内容.json --out 成品.docx
      在脱敏模板上重建各章正文（保留标题、页眉页脚、表格、自动编号与正文字号）。

覆盖范围：正文、表格、文本框、全部页眉页脚、脚注、尾注、批注、
文档属性（标题/作者/公司）、修订记录作者。`;

const [command, ...rest] = process.argv.slice(2);
if (!command || command === '--help' || command === '-h') { console.log(HELP); process.exit(0); }
if (command === 'redact') process.exit(redact(rest));
if (command === 'compose') process.exit(compose(rest));
console.log(HELP);
process.exit(1);
