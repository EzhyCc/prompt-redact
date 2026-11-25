#!/usr/bin/env node
// 检查客户端插件的「组合契约」——这是 DSH 启动崩溃的唯一来源。
//
// DSH 在启动时会组合所有声明了 dsh.client 的包；任何一个组合失败，
// 它抛 ClientPackageCompositionError（AggregateError），整个应用起不来。
// 所以下面每一条都必须过：
//
//   1. package.json 里 dsh.client 与 exports["./client"] 必须同时存在
//   2. exports["./client"] 指向的文件必须真实存在
//   3. bundle 必须是 lazy CJS：以普通脚本执行，只调用 window.__ModuleLoader__.load
//      （顶层 import/export 会 SyntaxError）
//   4. 注册的 id 必须等于包名
//   5. factory(require) 只能 require 种子词；非种子词必须被 try/catch 兜住
//   6. factory 必须返回对象，且带 apply 函数
//
// 用法：node tools/check-client-contract.mjs [--base 目录]

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));

/** DSH 客户端模块系统提供的「种子词」。从 dsh-client-modules 的 require 错误信息反推。 */
const SEED_WORDS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client'
]);

/** 这些模块虽然不是种子词，但被 try/catch 包着、失败只是降级，可以放行。 */
const TOLERATED_IF_CAUGHT = new Set([
  '@deepseek-ai/dsh-client-ui-primitives'
]);

export function checkClientContract(baseDir = join(HERE, '..')) {
  const problems = [];
  const pkgPath = join(baseDir, 'package.json');

  if (!existsSync(pkgPath)) return { ok: false, problems: ['找不到 package.json'] };

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const declaresClient = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh.client : undefined;

  if (declaresClient === undefined) {
    // 不声明客户端插件是合法状态（此时不会有组合风险）
    return { ok: true, problems: [], skipped: true, reason: '没有声明 dsh.client' };
  }

  // 1) 两边必须成对出现
  const clientExport = pkg.exports?.['./client'];
  if (clientExport === undefined) {
    problems.push('声明了 dsh.client 但 exports["./client"] 缺失（DSH 会在 resolveMeta 抛错，启动失败）');
  }
  if (typeof clientExport !== 'string' && !(clientExport && typeof clientExport.default === 'string')) {
    problems.push('exports["./client"] 必须是字符串，或带字符串 default 的对象');
  }

  const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default;
  const bundlePath = clientRel ? resolve(baseDir, clientRel) : null;

  // 2) 文件必须存在
  if (bundlePath && !existsSync(bundlePath)) {
    problems.push(`exports["./client"] 指向的文件不存在：${clientRel}`);
    return { ok: false, problems, bundlePath };
  }

  if (!bundlePath) return { ok: false, problems };

  const source = readFileSync(bundlePath, 'utf8');

  // 3) 不能有顶层 ESM 语法
  if (/^\s*import\s/m.test(source)) problems.push('bundle 含顶层 import：普通脚本执行会 SyntaxError');
  if (/^\s*export\s/m.test(source)) problems.push('bundle 含顶层 export：普通脚本执行会 SyntaxError');

  // 3b) 以普通脚本执行，收集注册
  const queue = [];
  const context = vm.createContext({
    window: { __ModuleLoader__: { mode: 'queue', pendingQueue: queue, load: r => queue.push(r) } },
    console: { warn() {}, log() {}, error() {} }
  });

  try {
    vm.runInContext(source, context, { filename: bundlePath });
  } catch (error) {
    problems.push(`bundle 作为脚本执行失败（${error.name}）：${error.message}`);
    return { ok: false, problems, bundlePath };
  }

  // 4) 注册的 id 必须等于包名
  const registration = queue.find(item => item.id === pkg.name);
  if (!registration) {
    problems.push(`没有以包名 ${pkg.name} 注册；实际注册：${queue.map(item => item.id).join(', ') || '（空）'}`);
    return { ok: false, problems, bundlePath };
  }
  if (typeof registration.factory !== 'function') problems.push('factory 不是函数');

  // 5) + 6) 忠实模拟 require 与导出检查
  const seed = {
    react: {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
      useMemo: factory => factory(),
      useEffect: () => {},
      useRef: value => ({ current: value }),
      useCallback: fn => fn,
      memo: component => component,
      Fragment: 'Fragment'
    },
    'react/jsx-runtime': {
      jsx: (type, props) => ({ type, props: props ?? {}, children: [] }),
      jsxs: (type, props) => ({ type, props: props ?? {}, children: [] })
    },
    'react-dom': { createPortal: node => node },
    'react-dom/client': { createRoot: () => ({ render() {}, unmount() {} }) }
  };

  const requested = [];
  const fakeRequire = specifier => {
    requested.push(specifier);
    if (Object.hasOwn(seed, specifier)) return seed[specifier];
    throw new Error(`client-modules: cannot resolve "${specifier}" — not a seed word, not a materialized module, and not a row in the boot graph`);
  };

  let exported;
  try {
    exported = registration.factory(fakeRequire);
  } catch (error) {
    problems.push(`factory 外抛（DSH 组合阶段会失败）：${error.message}`);
    return { ok: false, problems, bundlePath, requested };
  }

  if (typeof exported !== 'object' || exported === null) {
    problems.push('factory 返回值不是对象');
    return { ok: false, problems, bundlePath, requested };
  }
  if (typeof exported.apply !== 'function') {
    problems.push(`factory 返回的对象缺少 apply 函数（实际 ${typeof exported.apply}）`);
  }

  // 非种子词请求：如果 factory 没抛错，说明它已经被 try/catch 兜住了，只做提示
  const nonSeed = requested.filter(specifier => !Object.hasOwn(seed, specifier));
  const tolerated = nonSeed.filter(specifier => TOLERATED_IF_CAUGHT.has(specifier));
  const unexpected = nonSeed.filter(specifier => !TOLERATED_IF_CAUGHT.has(specifier));
  if (unexpected.length > 0) {
    problems.push(`require 了未预期的非种子词模块：${unexpected.join(', ')}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    bundlePath,
    requested,
    tolerated,
    inject: exported.inject
  };
}

// 直接执行时打印结果
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseArgIndex = process.argv.indexOf('--base');
  const base = baseArgIndex !== -1 ? resolve(process.argv[baseArgIndex + 1]) : join(HERE, '..');
  const result = checkClientContract(base);

  if (result.skipped) {
    console.log(`SKIP  ${result.reason}（不会参与启动组合，安全）`);
    process.exit(0);
  }

  console.log(`${result.ok ? 'PASS' : 'FAIL'}  客户端插件组合契约  ${result.bundlePath ?? ''}`);
  if (result.inject !== undefined) console.log(`       inject: ${JSON.stringify(result.inject)}`);
  if (result.tolerated?.length) console.log(`       已兜住的非种子词：${result.tolerated.join(', ')}`);
  for (const problem of result.problems) console.log(`       ✗ ${problem}`);
  process.exit(result.ok ? 0 : 1);
}
