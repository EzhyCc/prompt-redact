#!/usr/bin/env node
// 把引擎源码和规则内联进客户端插件，生成 lib/client.js。
//
// 为什么要构建：客户端插件跑在 DSH 渲染进程里，只能 require 宿主提供的共享模块
// （react），读不到仓库里的文件。所以匹配逻辑与规则必须在构建时静态内联。
//
// 做法：按依赖顺序拼接 src/*.js，去掉 import 行、剥掉 export 关键字。
// 引擎只有 376 行、无循环依赖、无默认导出，这种朴素转换是安全的——
// 转换后用 test/client.selftest.js 在 vm 里真跑一遍来兜底。

import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const ORDER = ['constants.js', 'validators.js', 'session.js', 'index.js'];

/** 把一份 ES 模块转成可以直接放进函数体的普通脚本。 */
function toScript(file) {
  const source = readFileSync(join(ROOT, 'src', file), 'utf8');
  return source
    .split('\n')
    .filter(line => !/^\s*import\s.+from\s+['"].+['"];?\s*$/.test(line))
    .map(line => line
      .replace(/^export\s+function\s+/, 'function ')
      .replace(/^export\s+class\s+/, 'class ')
      .replace(/^export\s+const\s+/, 'const ')
      .replace(/^export\s+let\s+/, 'let ')
      .replace(/^export\s+\{[^}]*\};?\s*$/, ''))
    .join('\n')
    .trim();
}

// 缩进四格，让内联后的代码在 factory 里读起来不别扭
const engine = ORDER
  .map(toScript)
  .join('\n\n')
  .split('\n')
  .map(line => (line.trim() ? `      ${line}` : line))
  .join('\n');

const rulesDir = join(ROOT, 'rules', 'zh-CN');
const manifest = JSON.parse(readFileSync(join(rulesDir, 'manifest.json'), 'utf8'));
const rules = [];
for (const file of manifest.files) {
  const data = JSON.parse(readFileSync(join(rulesDir, file), 'utf8'));
  rules.push(...(data.rules ?? []));
}

const template = readFileSync(join(ROOT, 'lib', 'client.template.js'), 'utf8');
const output = template
  .replace(/[ \t]*\/\*__ENGINE_START__\*\/[\s\S]*?\/\*__ENGINE_END__\*\//, () => engine.trimEnd())
  .replace('/*__RULES__*/ []', () => JSON.stringify(rules));

if (output.includes('__ENGINE_START__') || output.includes('__RULES__')) {
  console.error('占位符没有被替换，检查 client.template.js 里的标记');
  process.exit(1);
}

const target = join(ROOT, 'lib', 'client.js');
writeFileSync(target, output, 'utf8');

// 语法自检：这是普通脚本（不是 ESM），--check 直接可用
const probe = join(ROOT, 'lib', '.client-check.js');
copyFileSync(target, probe);
try {
  execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
} finally {
  unlinkSync(probe);
}

console.log(`引擎 ${ORDER.length} 个模块、${engine.split('\n').length} 行已内联`);
console.log(`规则 ${rules.length} 条已内联`);
console.log(`生成: ${target}（${Math.round(output.length / 1024)} KB，语法检查通过）`);
