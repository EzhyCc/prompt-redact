#!/usr/bin/env node
// 最小命令行：本地格式脱敏 + 把脱敏副本生成的文档回填成真值成稿。
// 它不声称覆盖所有隐私信息。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact, scan } from '../src/index.js';
import { Session } from '../src/session.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const names = ['contact', 'identity', 'credential', 'finance', 'network', 'semantic'];
const rules = names.flatMap(n => JSON.parse(readFileSync(resolve(root, `rules/zh-CN/${n}.json`), 'utf8')).rules);

const TOKEN_RE = /\[[A-Z]{2,12}_[0-9A-F]{4}\]/g;

const help = `prompt-redact — 本地格式信息脱敏工具
它只替换规则覆盖到的格式类信息。

用法：
  prompt-redact redact "文本"
  prompt-redact redact -f 文件路径 [--save-map 映射.json]
  prompt-redact scan "文本"
  prompt-redact fill -f 带占位符的文档 -m 映射.json [-o 输出路径]

选项：
  --semantic        启用语义类规则
  --add 张三,李四    追加个人词表（逗号分隔）
  --json            输出 redact 完整返回值 JSON
  --save-map 路径    把本次的 token → 真值映射写到文件（明文，自己保管）
  --quiet           只输出结果，不输出统计
  --help            显示帮助

fill 是本地回填：把 AI 基于脱敏副本写出的文档里的 [TYPE_XXXX] 换回真值。
映射文件只在你自己的磁盘上，回填过程不经过网络。`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.length === 0) { console.log(help); process.exit(0); }

const mode = args.shift();
if (!['redact', 'scan', 'fill'].includes(mode)) { console.error(help); process.exit(1); }

const readArg = flag => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) { console.error(`${flag} 缺少参数`); process.exit(1); }
  return value;
};

const readTextFile = path => {
  try {
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    console.error('读取失败:', error.message);
    process.exit(1);
  }
};

// ---- fill：把文档里的占位符换回真值 ----
if (mode === 'fill') {
  const templatePath = readArg('-f');
  const mapPath = readArg('-m');
  if (!templatePath || !mapPath) { console.error('fill 需要 -f 模板 和 -m 映射文件'); process.exit(1); }

  const template = readTextFile(templatePath);
  let map;
  try {
    map = JSON.parse(readTextFile(mapPath));
  } catch (error) {
    console.error('映射文件不是合法 JSON:', error.message);
    process.exit(1);
  }

  const missing = new Set();
  const filled = template.replace(TOKEN_RE, token => {
    if (Object.hasOwn(map, token)) return map[token];
    missing.add(token);
    return token;
  });

  const outPath = readArg('-o');
  if (outPath) writeFileSync(outPath, filled, 'utf8');
  else console.log(filled);

  if (!args.includes('--quiet')) {
    const total = (template.match(TOKEN_RE) || []).length;
    console.error(`回填 ${total - missing.size}/${total} 个占位符`);
    if (missing.size > 0) {
      console.error(`以下占位符在映射里找不到，已原样保留：${[...missing].join(', ')}`);
    }
  }
  process.exit(missing.size > 0 ? 3 : 0);
}

// ---- redact / scan ----
const filePath = readArg('-f');
const input = filePath ? readTextFile(filePath) : args.find(a => !a.startsWith('-'));
if (typeof input !== 'string') { console.error('缺少文本参数或 -f 文件路径'); process.exit(1); }

const semantic = args.includes('--semantic');
const customTerms = (readArg('--add') || '').split(',').filter(Boolean);

if (mode === 'scan') {
  const found = scan(input, rules.filter(r => r.tier !== 'semantic' || semantic));
  for (const hit of found) console.log(`${hit.ruleId} | ${hit.category} | ${hit.severity} | ${hit.token} | ${hit.start}:${hit.end}`);
  process.exit(0);
}

const session = new Session();
const result = redact(input, { rules, session, enableSemantic: semantic, customTerms });

const mapPath = readArg('--save-map');
if (mapPath) {
  const map = Object.fromEntries(session.entries());
  writeFileSync(mapPath, JSON.stringify(map, null, 2), 'utf8');
  if (!args.includes('--quiet')) {
    console.error(`映射已写入 ${mapPath}（含原始值，请自行保管，不要提交到仓库）`);
  }
}

if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
else console.log(result.text);

if (!args.includes('--quiet') && !args.includes('--json')) {
  console.error(`命中 ${result.stats.total} 项，残留高危 ${result.residuals.length} 项`);
}
process.exit(result.blocked ? 2 : 0);
