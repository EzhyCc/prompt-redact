// 客户端插件自测：在 Node 里模拟浏览器环境（window.__ModuleLoader__ + React），
// 验证生成的 lib/client.js 能加载、能注册 settings.section、且内联的引擎真的能脱敏。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failed += 1; process.stderr.write(`FAIL ${name}: ${error.message}\n`); }
}

// 先确保生成物是最新的（构建脚本必须可重复执行）
execFileSync(process.execPath, [join(ROOT, 'tools', 'build-client.mjs')], { stdio: 'ignore' });

const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

// ── 假 React：hooks 同步求值，足以跑一遍渲染路径 ──────────────────
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: factory => factory(),
  useCallback: fn => fn,
  useEffect: () => {},
  useRef: value => ({ current: value })
};

const fakeRequire = name => {
  if (name === 'react') return react;
  if (name === 'react/jsx-runtime') return { jsx: react.createElement, jsxs: react.createElement };
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return {};
  throw new Error(`不该 require：${name}`);
};

// ── 跑一遍打包产物 ────────────────────────────────────────────────
let loaded = null;
const context = vm.createContext({
  window: { __ModuleLoader__: { load: spec => { loaded = spec; } } },
  console
});
vm.runInContext(source, context, { filename: 'client.js' });

check('生成物调用了 window.__ModuleLoader__.load', () => {
  assert.ok(loaded, '没有调用 load');
  assert.equal(loaded.id, 'prompt-redact');
  assert.equal(typeof loaded.factory, 'function');
});

const module_ = loaded.factory(fakeRequire);

check('导出 apply / inject / Debugger', () => {
  assert.equal(typeof module_.apply, 'function');
  assert.ok(module_.inject, '缺少 inject');
  assert.equal(typeof module_.Debugger, 'function');
});

check('引擎被内联进来了', () => {
  const internals = module_.__internals;
  assert.ok(internals, '缺少 __internals');
  assert.equal(typeof internals.redact, 'function');
  assert.ok(Array.isArray(internals.RULES));
  assert.ok(internals.RULES.length >= 25, `规则只有 ${internals.RULES.length} 条`);
});

check('内联的引擎能真正脱敏', () => {
  const { redact, Session, RULES } = module_.__internals;
  const result = redact('联系人张三，手机 13800138000，合同金额 1,280,000 元。', {
    rules: RULES,
    session: new Session({ maxEntries: 100 })
  });
  assert.ok(!result.text.includes('13800138000'), '手机号没被替换');
  assert.ok(result.text.includes('[手机号]'), '缺少占位符');
  assert.ok(result.hits.length >= 2, `只命中 ${result.hits.length} 处`);
});

check('内联的引擎认得出个人词表', () => {
  const { redact, Session, RULES } = module_.__internals;
  const result = redact('这是张三的合同', { rules: RULES, session: new Session({ maxEntries: 50 }), customTerms: ['张三'] });
  assert.ok(!result.text.includes('张三'), '词表没生效');
  assert.ok(result.text.includes('['), '没有产生占位符');
});

// ── 注册契约 ─────────────────────────────────────────────────────
const registered = [];
const injected = [];
const ctx = {
  slots: {
    inject: (name, fn) => { injected.push(name); fn(); },
    register: (meta, component) => { registered.push({ meta, component }); }
  }
};

check('apply 注册到 settings.section', () => {
  module_.apply(ctx);
  assert.deepEqual(injected, ['settings.section']);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].meta.name, 'settings.section');
  assert.equal(registered[0].meta.id, 'prompt-redact');
  assert.ok(registered[0].meta.order > 0, '缺少 order');
  assert.equal(typeof registered[0].meta.label, 'function');
  assert.equal(registered[0].meta.label(), '提示词脱敏');
  assert.equal(typeof registered[0].component, 'function');
});

check('宿主没有 slots 时不抛错', () => {
  module_.apply({});
  module_.apply(undefined);
});

// ── 组件能渲染出脱敏结果 ─────────────────────────────────────────
/** 收集整棵树的文本。 */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { node.forEach(item => collectText(item, out)); return out; }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (typeof node !== 'object') return out;
  collectText(node.children ?? [], out);
  return out;
}

/** 找到那个显示「实际发出内容」的 pre。 */
function findOutputPre(node) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findOutputPre(item);
      if (found) return found;
    }
    return null;
  }
  if (node.type === 'pre') return node;
  return findOutputPre(node.children ?? []);
}

check('组件渲染后输出区是占位符、不是原文', () => {
  const Component = registered[0].component;
  const tree = Component({});

  const pre = findOutputPre(tree);
  assert.ok(pre, '没找到输出区');
  const output = collectText(pre).join('');
  assert.ok(output.includes('[手机号]'), `输出区没有占位符：${output.slice(0, 80)}`);
  assert.ok(!output.includes('13800138000'), '输出区里还有原号码');

  const all = collectText(tree).join(' ');
  assert.ok(/命中 \d+ 处/.test(all), '没有命中计数');
});

check('预览区显示原文并给命中片段加高亮', () => {
  const Component = registered[0].component;
  const tree = Component({});

  const marks = [];
  const walk = node => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'mark') marks.push(node);
    walk(node.children ?? []);
  };
  walk(tree);

  assert.ok(marks.length >= 1, '预览区没有高亮片段');
  assert.ok(collectText(tree).join('').includes('13800138000'), '预览区应当保留原文');
});

check('高亮分段覆盖全文、不丢字', () => {
  const { redact, Session, RULES, buildSegments } = module_.__internals;
  const text = '手机 13800138000，邮箱 a@b.com。';
  const result = redact(text, { rules: RULES, session: new Session({ maxEntries: 50 }) });
  const segments = buildSegments(text, result.hits);
  assert.equal(segments.map(s => s.text).join(''), text, '分段拼接后与原文不一致');
  assert.ok(segments.some(s => s.hit), '没有任何高亮段');
});

check('生成物里没有残留占位标记', () => {
  assert.ok(!source.includes('__ENGINE_START__'), '引擎占位符还在');
  assert.ok(!source.includes('__RULES__'), '规则占位符还在');
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
