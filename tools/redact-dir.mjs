#!/usr/bin/env node
// 目录级脱敏：把源目录里的文件抽成文本、脱敏后写到新目录，文件名也中性化。
//
// 分工：
//   模型只看 <目标目录>            —— 全是占位符和 f001 这种中性文件名
//   映射表写到 <目标目录>.map.json —— 含原始文件名和原值，只留本地，不要交给模型
//
// 用法：
//   node tools/redact-dir.mjs --from 源目录 --to 目标目录 [--add "词=标签,词2=标签2"]
//   node tools/redact-dir.mjs --fill --map 映射表.json --from 产出目录 --to 成稿目录
//
// 支持直接读：.txt .md .csv .json .log .html .xml .yml .sql .js .py .ini .conf
// 支持抽取文本：.docx .xlsx .pptx（纯 Node 内置模块，不需要 Office）

import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { basename, extname, join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../src/index.js';
import { Session } from '../src/session.js';
import { extractOfficeText } from './extract/office.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_DIR = join(HERE, '..', 'rules', 'zh-CN');

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.log', '.html', '.htm', '.xml', '.yml', '.yaml', '.ini', '.conf', '.sql', '.js', '.ts', '.py', '.sh']);

/** 能抽文本的 Office 格式。 */
const OFFICE_EXT = new Set(['.docx', '.xlsx', '.pptx']);

/** 知道要读、但读不了的：明确报告，不假装支持。 */
const KNOWN_BINARY = new Set(['.doc', '.xls', '.ppt', '.pdf', '.zip', '.rar', '.7z', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.mp4', '.mp3', '.wav', '.dwg', '.vsd']);

const PLACEHOLDER_RE = /\[[^[\]\n]{1,20}\]/g;

function parseArgs(argv) {
  const out = { from: '', to: '', terms: {}, semantic: false, fill: false, maps: [], orgFallback: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--from') out.from = argv[++i];
    else if (key === '--to') out.to = argv[++i];
    else if (key === '--map') out.maps.push(argv[++i]);
    else if (key === '--add') {
      // "某某科技=客户,某某医院=医院" → { 某某科技: '客户', 某某医院: '医院' }
      for (const pair of String(argv[++i] ?? '').split(/[,，]/)) {
        const item = pair.trim();
        if (!item) continue;
        const [value, label] = item.split('=').map(s => s.trim());
        out.terms[value] = label || '自定义词';
      }
    } else if (key === '--semantic') out.semantic = true;
    else if (key === '--org-fallback') out.orgFallback = true;
    else if (key === '--fill') out.fill = true;
  }
  if (!out.from || !out.to) {
    console.error('用法：node tools/redact-dir.mjs --from 源目录 --to 目标目录 [--add "词=标签,..."] [--semantic]');
    console.error('      node tools/redact-dir.mjs --fill --map 映射表.json --from 产出目录 --to 成稿目录');
    process.exit(1);
  }
  if (out.fill && out.maps.length === 0) {
    console.error('回填模式需要 --map 映射表.json（可重复传多份）');
    process.exit(1);
  }
  return out;
}

async function loadRules() {
  const files = (await readdir(RULES_DIR)).filter(f => f.endsWith('.json') && f !== 'manifest.json');
  const groups = await Promise.all(files.map(async f => JSON.parse(await readFile(join(RULES_DIR, f), 'utf8')).rules ?? []));
  return groups.flat();
}

async function walk(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else if (entry.isFile()) out.push({ full, rel: relative(base, full) });
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const files = await walk(resolve(args.from));
mkdirSync(args.to, { recursive: true });
// ── 回填模式：把产出文档里的占位符换回真值 ─────────────────────────
if (args.fill) {
  // 合并多份映射表：材料目录和模板目录各自产出一份，回填时要一起用
  const tokens = {};
  for (const mapPath of args.maps) {
    const map = JSON.parse(await readFile(mapPath, 'utf8'));
    Object.assign(tokens, map.tokens ?? {});
  }
  let used = 0;
  let leftover = 0;

  for (const file of files) {
    const text = await readFile(file.full, 'utf8');
    let filled = text;
    for (const [token, value] of Object.entries(tokens)) {
      if (filled.includes(token)) { filled = filled.split(token).join(value); used += 1; }
    }
    leftover += (filled.match(PLACEHOLDER_RE) ?? []).length;
    const target = join(args.to, file.rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, filled, 'utf8');
  }

  console.log(`回填 ${files.length} 个文件，替换 ${used} 处`);
  if (leftover > 0) console.log(`仍有 ${leftover} 个方括号内容，请确认是否漏填`);
  process.exit(0);
}

// ── 脱敏模式 ───────────────────────────────────────────────────────
const rules = await loadRules();
const session = new Session({ maxEntries: 5000 });

// 兜底：词表列不全时，把所有「XX公司 / XX医院 / XX大学 / XX研究院 / XX集团」一律当成机构名。
// 描述性的「中心」故意不包含——「数据中心」「测试中心」这类会被误伤。
// 代价是句子可读性下降（某某科技有限公司 → [机构]），换来的是不会漏掉任何企业名。
if (args.orgFallback) {
  rules.push({
    id: 'org-fallback', label: '机构', category: 'identity', tier: 'format',
    severity: 'medium', token: 'ORG',
    match: [{
      type: 'regex',
      pattern: '[\\u4e00-\\u9fa5A-Za-z0-9]{2,12}(?:股份有限公司|有限责任公司|有限公司|公司|医院|大学|研究院|集团)'
    }]
  });
}

const fileMap = [];
const skipped = [];
let processed = 0;
let hits = 0;

for (const [index, file] of files.entries()) {
  const ext = extname(file.full).toLowerCase();
  const newName = `f${String(index + 1).padStart(3, '0')}.txt`;
  let text;

  if (TEXT_EXT.has(ext)) {
    text = await readFile(file.full, 'utf8');
  } else if (OFFICE_EXT.has(ext)) {
    try {
      text = extractOfficeText(await readFile(file.full), ext);
    } catch (error) {
      skipped.push({ file: file.rel, reason: `解析失败：${error.message}` });
      continue;
    }
  } else {
    skipped.push({ file: file.rel, reason: KNOWN_BINARY.has(ext) ? `不支持 ${ext}（需要专门的解析器）` : '不是文本类型' });
    continue;
  }

  const result = redact(text, { rules, session, enableSemantic: args.semantic, customTerms: args.terms });
  hits += result.hits.length;

  await writeFile(join(args.to, newName), result.text, 'utf8');
  fileMap.push({ original: file.rel, redacted: newName, from: ext, replacements: result.hits.length });
  processed += 1;
}

const manifestPath = `${args.to}.map.json`;
await writeFile(manifestPath, `${JSON.stringify({
  source: resolve(args.from),
  files: fileMap,
  skipped,
  tokens: Object.fromEntries(session.entries())
}, null, 2)}\n`, 'utf8');

console.log(`处理 ${processed} 个文件，替换 ${hits} 处`);
console.log(`脱敏副本：${resolve(args.to)}`);
console.log(`映射表（含原始信息，只留本地，不要交给模型）：${manifestPath}`);
if (skipped.length > 0) {
  console.log(`\n未处理 ${skipped.length} 个：`);
  for (const item of skipped.slice(0, 12)) console.log(`  ${item.file} —— ${item.reason}`);
  if (skipped.length > 12) console.log(`  …还有 ${skipped.length - 12} 个`);
}
