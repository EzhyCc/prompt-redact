// 客户端插件「组合契约」自测。
//
// 这是 DSH 启动崩溃的唯一来源：任何一个声明了 dsh.client 的包组合失败，
// DSH 抛 ClientPackageCompositionError，整个应用起不来。
// 所以这道门必须既能放行正确版本，也能拦住错误版本。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkClientContract } from '../tools/check-client-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failed += 1; process.stderr.write(`FAIL ${name}: ${error.message}\n`); }
}

// 先重新构建，保证被测文件是最新的
execFileSync(process.execPath, [join(ROOT, 'tools', 'build-client.mjs')], { stdio: 'ignore' });

// ── 真仓库：必须通过 ────────────────────────────────────────────────
const real = checkClientContract(ROOT);

check('仓库的客户端插件通过组合契约', () => {
  assert.equal(real.ok, true, real.problems.join(' | '));
  assert.equal(real.skipped, undefined, '仓库应该声明了 dsh.client');
  assert.deepEqual([...real.inject], ['slots'], `inject 形状不对：${JSON.stringify(real.inject)}`);
});

check('package.json 里 dsh.client 与 exports["./client"] 成对出现', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const declares = pkg.dsh?.client !== undefined;
  const hasExport = pkg.exports?.['./client'] !== undefined;
  assert.equal(declares, hasExport, `声明=${declares} 导出=${hasExport}；必须同时存在或同时缺失`);
});

check('bundle 是 lazy CJS，不含顶层 import/export', () => {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(source), '含顶层 import');
  assert.ok(!/^\s*export\s/m.test(source), '含顶层 export');
  assert.ok(/window\.__ModuleLoader__\.load\(/.test(source), '没有调用 load');
});

check('注册的 id 等于包名', () => {
  assert.ok(/id:\s*['"]prompt-redact['"]/.test(readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')));
});

// ── 负向：每种错误版本都必须被拦住 ─────────────────────────────────
const WORK = mkdtempSync(join(tmpdir(), 'pr-contract-'));
try {
  /** 造一个最小包目录。 */
  const makePkg = (name, pkgJson, files) => {
    const dir = join(WORK, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf8');
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content, 'utf8');
    }
    return dir;
  };

  const goodBundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

  check('负向：裸 ESM bundle 必须被拦住', () => {
    const dir = makePkg('bare-esm', {
      name: 'bare-esm',
      exports: { './client': './lib/client.js' },
      dsh: { client: { platform: 'web' } }
    }, { 'lib/client.js': "import * as React from 'react';\nexport function apply() {}\n" });
    const result = checkClientContract(dir);
    assert.equal(result.ok, false, '裸 ESM 竟然通过了');
    const all = result.problems.join(' | ');
    assert.ok(all.includes('顶层 import'), `没指出顶层 import：${all}`);
  });

  check('负向：声明 dsh.client 但没有 exports["./client"] 必须被拦住', () => {
    const dir = makePkg('no-export', {
      name: 'no-export',
      exports: { '.': './lib/index.js' },
      dsh: { client: { platform: 'web' } }
    }, { 'lib/index.js': 'export const name = "x";\n' });
    const result = checkClientContract(dir);
    assert.equal(result.ok, false, '缺 exports 竟然通过了');
    assert.ok(result.problems.join(' | ').includes('exports["./client"]'), '没指出缺 exports');
  });

  check('负向：exports 指向不存在的文件必须被拦住', () => {
    const dir = makePkg('missing-file', {
      name: 'missing-file',
      exports: { './client': './lib/client.js' },
      dsh: { client: { platform: 'web' } }
    }, {});
    const result = checkClientContract(dir);
    assert.equal(result.ok, false, '文件不存在竟然通过了');
    assert.ok(result.problems.join(' | ').includes('不存在'), '没指出文件不存在');
  });

  check('负向：注册 id 与包名不一致必须被拦住', () => {
    const dir = makePkg('wrong-id', {
      name: 'wrong-id',
      exports: { './client': './lib/client.js' },
      dsh: { client: { platform: 'web' } }
    }, {
      'lib/client.js': 'window.__ModuleLoader__.load({ id: "别的名字", factory: () => ({ apply() {} }) });\n'
    });
    const result = checkClientContract(dir);
    assert.equal(result.ok, false, 'id 不一致竟然通过了');
    assert.ok(result.problems.join(' | ').includes('没有以包名'), '没指出 id 不一致');
  });

  check('负向：factory 外抛必须被拦住', () => {
    const dir = makePkg('factory-throws', {
      name: 'factory-throws',
      exports: { './client': './lib/client.js' },
      dsh: { client: { platform: 'web' } }
    }, {
      'lib/client.js': 'window.__ModuleLoader__.load({ id: "factory-throws", factory: () => { throw new Error("炸了"); } });\n'
    });
    const result = checkClientContract(dir);
    assert.equal(result.ok, false, '外抛竟然通过了');
    assert.ok(result.problems.join(' | ').includes('factory 外抛'), '没指出外抛');
  });

  check('负向：缺 apply 必须被拦住', () => {
    const dir = makePkg('no-apply', {
      name: 'no-apply',
      exports: { './client': './lib/client.js' },
      dsh: { client: { platform: 'web' } }
    }, {
      'lib/client.js': 'window.__ModuleLoader__.load({ id: "no-apply", factory: () => ({ inject: [] }) });\n'
    });
    const result = checkClientContract(dir);
    assert.equal(result.ok, false, '缺 apply 竟然通过了');
    assert.ok(result.problems.join(' | ').includes('apply'), '没指出缺 apply');
  });

  check('负向：require 非种子词必须被拦住', () => {
    const dir = makePkg('bad-require', {
      name: 'bad-require',
      exports: { './client': './lib/client.js' },
      dsh: { client: { platform: 'web' } }
    }, {
      'lib/client.js': 'window.__ModuleLoader__.load({ id: "bad-require", factory: (require) => { require("lodash"); return { apply() {} }; } });\n'
    });
    const result = checkClientContract(dir);
    assert.equal(result.ok, false, '非种子词竟然通过了');
    assert.ok(result.problems.join(' | ').includes('lodash'), '没指出非种子词');
  });

  check('不声明 dsh.client 的包算安全跳过', () => {
    const dir = makePkg('no-client', { name: 'no-client', exports: { '.': './lib/index.js' } }, { 'lib/index.js': 'export const name = "x";\n' });
    const result = checkClientContract(dir);
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
  });

  // 正确版本必须是同一份代码
  check('正确 bundle 在临时目录里同样通过', () => {
    const dir = makePkg('good', JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')), { 'lib/client.js': goodBundle });
    const result = checkClientContract(dir);
    assert.equal(result.ok, true, result.problems.join(' | '));
  });
} finally {
  rmSync(WORK, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
