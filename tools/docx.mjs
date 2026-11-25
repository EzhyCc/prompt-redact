#!/usr/bin/env node
// docx 相关命令的统一入口。python-docx 负责真正读写，这里只做参数解析与输出整理，
// 保证用户看到的产物只有两个文件，中间件全部落在系统临时目录。
//
//   node tools/docx.mjs redact  --in 模板.docx --out 输出目录 [--terms "词=标签,..."] [--org] [--keep-work]
//   node tools/docx.mjs compose --base 模板-脱敏.docx --content 内容.json --out 成品.docx
//
// redact 产出：
//   <输出目录>/<原名>-脱敏.docx      给模型看的模板（占位符，格式不变）
//   <输出目录>/<原名>.map.json       占位符 → 真实值（只留本地）
// compose 产出：
//   <成品路径>                       交付物

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REDACT_PY = join(HERE, 'docx_redact.py');
const COMPOSE_PY = join(HERE, 'docx_compose.py');

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
    if (key === 'org' || key === 'keep-work' || key === 'help') { out[key] = true; continue; }
    out[key] = argv[index + 1];
    index += 1;
  }
  return out;
}

/** 找 python：环境变量优先，其次 PATH 上的 python / python3。 */
function findPython() {
  const explicit = process.env.PROMPT_REDACT_PYTHON;
  if (explicit && existsSync(explicit)) return explicit;
  for (const candidate of ['python', 'python3']) {
    const probe = spawnSync(candidate, ['-c', 'import docx'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  return null;
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

function makeWorkDir() {
  const dir = join(tmpdir(), `prompt-redact-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runPython(python, script, args) {
  const result = spawnSync(python, [script, ...args], { encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

function redact(argv) {
  const args = parse(argv);
  if (!args.in || !args.out) fail('用法：node tools/docx.mjs redact --in 模板.docx --out 输出目录 [--terms "词=标签,..."] [--org]');
  if (!existsSync(args.in)) fail(`找不到输入文件：${args.in}`);

  const python = findPython();
  if (!python) fail('需要 Python 与 python-docx：pip install python-docx（或设置 PROMPT_REDACT_PYTHON）');

  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });

  const base = basename(args.in, extname(args.in));
  const redactedPath = join(outDir, `${base}-脱敏.docx`);
  const mapPath = join(outDir, `${base}.map.json`);

  const work = makeWorkDir();
  const pyArgs = [
    '--in', resolve(args.in),
    '--out', redactedPath,
    '--map', mapPath,
    '--terms', JSON.stringify(parseTerms(args.terms))
  ];
  if (args.org) pyArgs.push('--org');

  try {
    const status = runPython(python, REDACT_PY, pyArgs);
    if (status !== 0) fail('脱敏失败', status);
  } finally {
    if (!args['keep-work']) rmSync(work, { recursive: true, force: true });
  }

  console.log('');
  console.log(`脱敏模板：${redactedPath}`);
  console.log(`回填映射：${mapPath}`);
  console.log('（映射含真实值，只留本地，不要交给模型）');
  return 0;
}

function compose(argv) {
  const args = parse(argv);
  if (!args.base || !args.content || !args.out) {
    fail('用法：node tools/docx.mjs compose --base 模板-脱敏.docx --content 内容.json --out 成品.docx');
  }
  if (!existsSync(args.base)) fail(`找不到基底模板：${args.base}`);
  if (!existsSync(args.content)) fail(`找不到内容文件：${args.content}`);

  const python = findPython();
  if (!python) fail('需要 Python 与 python-docx：pip install python-docx（或设置 PROMPT_REDACT_PYTHON）');

  const pyArgs = ['--base', resolve(args.base), '--content', resolve(args.content), '--out', resolve(args.out)];
  if (args.style) pyArgs.push('--style', args.style);

  const status = runPython(python, COMPOSE_PY, pyArgs);
  if (status !== 0) fail('合成失败', status);
  console.log('');
  console.log(`成品：${resolve(args.out)}`);
  return 0;
}

const HELP = `prompt-redact docx —— 保格式处理 Word 文档

  node tools/docx.mjs redact --in 模板.docx --out 输出目录 [--terms "词=标签,..."] [--org]
      就地脱敏，产出「<原名>-脱敏.docx」和「<原名>.map.json」两个文件。
      --terms  个人词表，逗号分隔，「词=标签」可指定占位符名字
      --org    兜底：把 XX公司/医院/大学/研究院/集团 一律替换成 [机构]

  node tools/docx.mjs compose --base 模板-脱敏.docx --content 内容.json --out 成品.docx
      在脱敏模板上重建各章正文，产出成品。
      --style  正文段落样式名，默认 "Body Text First Indent"

需要 python-docx（pip install python-docx）。用 PROMPT_REDACT_PYTHON 指定解释器。`;

const [command, ...rest] = process.argv.slice(2);
if (!command || command === '--help' || command === '-h') { console.log(HELP); process.exit(0); }
if (command === 'redact') process.exit(redact(rest));
if (command === 'compose') process.exit(compose(rest));
console.log(HELP);
process.exit(1);
