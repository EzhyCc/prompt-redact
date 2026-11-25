// 客户端插件自测：在 Node 的 vm 里模拟 DSH 的客户端环境（window.__ModuleLoader__ + require），
// 跑一遍生成的 lib/client.js。
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

// 构建必须可重复执行，且构建自带的语法检查必须过
execFileSync(process.execPath, [join(ROOT, 'tools', 'build-client.mjs')], { stdio: 'ignore' });

const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: factory => factory()
};

function loadClient(modules) {
  let loaded = null;
  const warnings = [];
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: spec => { loaded = spec; } } },
    console: { warn: (...args) => warnings.push(args.join(' ')), log() {}, error() {} }
  });
  vm.runInContext(source, context, { filename: 'client.js' });
  const fakeRequire = name => {
    if (name === 'react') {
      if (modules.reactThrows) throw new Error('模拟：react 不可用');
      return react;
    }
    throw new Error(`不该 require：${name}`);
  };
  return { spec: loaded, exports: loaded ? loaded.factory(fakeRequire) : null, warnings };
}

check('生成物用 window.__ModuleLoader__.load 注册', () => {
  const { spec } = loadClient({});
  assert.ok(spec, '没有调用 load');
  assert.equal(spec.id, 'prompt-redact');
  assert.equal(typeof spec.factory, 'function');
});

check('返回契约是 { inject: [\'slots\'], apply }', () => {
  const { exports } = loadClient({});
  assert.ok(exports, 'factory 没有返回值');
  assert.deepEqual([...exports.inject], ['slots'], `inject 形状不对：${JSON.stringify(exports.inject)}`);
  assert.equal(typeof exports.apply, 'function');
});

check('没有 require 任何 Harness Client 包', () => {
  assert.ok(!source.includes('dsh-client-ui-primitives'), '仍在 require primitives（DSH 明确禁止）');
  assert.ok(!/require\(['"]@deepseek-ai\//.test(source), 'factory 里 require 了 @deepseek-ai/* 包');
});

check('react 不可用时退化成空插件、不抛错', () => {
  const { exports, warnings } = loadClient({ reactThrows: true });
  assert.ok(exports, 'factory 抛出去了，会连累整个渲染进程');
  assert.deepEqual([...exports.inject], []);
  assert.equal(typeof exports.apply, 'function');
  exports.apply({ slots: { register() {}, inject() {} } }); // 不能抛
  assert.ok(warnings.length >= 1, '没有留下告警');
});

check('引擎被内联进来了', () => {
  const { exports } = loadClient({});
  const internals = exports.__internals;
  assert.ok(internals, '缺少 __internals');
  assert.equal(typeof internals.redact, 'function');
  assert.ok(internals.RULES.length >= 25, `规则只有 ${internals.RULES.length} 条`);
});

check('内联的引擎能真正脱敏', () => {
  const { exports } = loadClient({});
  const { redact, Session, RULES } = exports.__internals;
  const result = redact('联系人张三，手机 13800138000，合同金额 1,280,000 元。', {
    rules: RULES, session: new Session({ maxEntries: 100 })
  });
  assert.ok(!result.text.includes('13800138000'), '手机号没被替换');
  assert.ok(result.text.includes('[手机号]'), '缺少占位符');
  assert.ok(result.hits.length >= 2, `只命中 ${result.hits.length} 处`);
});

check('内联的引擎认得出个人词表', () => {
  const { exports } = loadClient({});
  const { redact, Session, RULES } = exports.__internals;
  const result = redact('这是张三的合同', {
    rules: RULES, session: new Session({ maxEntries: 50 }), customTerms: ['张三']
  });
  assert.ok(!result.text.includes('张三'), '词表没生效');
});

const registered = [];
const injected = [];
const ctx = {
  slots: {
    inject: (name, fn) => { injected.push(name); fn(); },
    register: (meta, component) => { registered.push({ meta, component }); }
  }
};

check('apply 注册侧栏入口 sidebar.panellist', () => {
  const { exports } = loadClient({});
  exports.apply(ctx);
  assert.deepEqual([...injected], ['sidebar.panellist', 'main'], `注入的 slot 不对：${JSON.stringify([...injected])}`);
  assert.equal(registered.length, 2);

  const entry = registered[0].meta;
  assert.equal(entry.name, 'sidebar.panellist');
  assert.equal(entry.id, 'prompt-redact');
  assert.equal(entry.label, '提示词脱敏', 'label 必须是普通字符串');
  assert.equal(typeof entry.label, 'string');
  assert.ok(entry.order > 0);
  assert.equal(typeof registered[0].component, 'function', '侧栏入口需要图标组件');

  const page = registered[1].meta;
  assert.equal(page.name, 'main');
  assert.equal(page.key, 'prompt-redact', 'main 的 key 要和侧栏 id 对应');
});

check('图标组件能渲染出 svg', () => {
  const icon = registered[0].component({});
  assert.equal(icon.type, 'svg');

  const types = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    types.push(node.type);
    walk(node.children ?? []);
  };
  walk(icon);
  assert.ok(types.filter(type => type === 'path').length >= 2, '图标内容不完整');
});

check('宿主没有 slots 时不抛错', () => {
  const { exports } = loadClient({});
  exports.apply({});
  exports.apply(undefined);
  exports.apply({ slots: {} });
});

function collectText(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { node.forEach(item => collectText(item, out)); return out; }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (typeof node !== 'object') return out;
  collectText(node.children ?? [], out);
  return out;
}

function findOutputPre(node) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) { const found = findOutputPre(item); if (found) return found; }
    return null;
  }
  if (node.type === 'pre') return node;
  return findOutputPre(node.children ?? []);
}

check('组件渲染：输出区是占位符，不是原文', () => {
  const tree = registered[1].component({});
  const pre = findOutputPre(tree);
  assert.ok(pre, '没找到输出区');
  const output = collectText(pre).join('');
  assert.ok(output.includes('[手机号]'), `输出区没有占位符：${output.slice(0, 80)}`);
  assert.ok(!output.includes('13800138000'), '输出区里还有原号码');
  assert.ok(/命中 \d+ 处/.test(collectText(tree).join(' ')), '没有命中计数');
});

check('组件渲染：预览区保留原文并加高亮', () => {
  const tree = registered[1].component({});
  const marks = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'mark') marks.push(node);
    walk(node.children ?? []);
  };
  walk(tree);
  assert.ok(marks.length >= 1, '没有高亮片段');
  assert.ok(collectText(tree).join('').includes('13800138000'), '预览区应当保留原文');
});

check('命中表「命中内容」列显示的是原文，不是空', () => {
  const tree = registered[1].component({});

  let tbody = null;
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'tbody') tbody = node;
    walk(node.children ?? []);
  };
  walk(tree);
  assert.ok(tbody, '没找到命中表');

  const rows = [];
  const collectRows = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(collectRows); return; }
    if (node.type === 'tr') rows.push(node);
    collectRows(node.children ?? []);
  };
  collectRows(tbody);
  assert.ok(rows.length >= 3, `命中表只有 ${rows.length} 行`);

  const firstCells = rows.map(row => collectText(row).join(' '));
  assert.ok(firstCells[0].includes('13800138000'), `第一行「命中内容」是空的：${firstCells[0]}`);
  assert.ok(firstCells[0].includes('cn-mobile'), '第一行缺少规则 id');
});

check('高亮分段覆盖全文、不丢字', () => {
  const { exports } = loadClient({});
  const { redact, Session, RULES, buildSegments } = exports.__internals;
  const text = '手机 13800138000，邮箱 a@b.com。';
  const result = redact(text, { rules: RULES, session: new Session({ maxEntries: 50 }) });
  const segments = buildSegments(text, result.hits);
  assert.equal(segments.map(s => s.text).join(''), text);
  assert.ok(segments.some(s => s.hit));
});

check('没有残留占位标记', () => {
  assert.ok(!source.includes('__ENGINE_START__'));
  assert.ok(!source.includes('__RULES__'));
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
