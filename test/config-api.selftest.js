// 设置接口自测：真的起一个 HTTP 服务，用真请求打进去。
//
// 要覆盖的都是「写配置」这种事最容易出事的地方：
//   · 只认 GET/POST
//   · POST 必须同源 + JSON（否则本机任意网页能发简单请求改配置 —— CSRF）
//   · 字段校验与夹紧，非法值不落盘
//   · 合并而不是覆盖，保住本版本不认识的键
//   · 就地更新 settings 对象，让运行中的插件立刻看到新值
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIELD_RULES,
  isSameOriginJsonRequest,
  normalizePatch,
  readRawConfig,
  registerConfigApi,
  writeRawConfig
} from '../lib/config-api.js';

const HERE = dirname(fileURLToPath(import.meta.url));

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

// ── 纯函数部分 ─────────────────────────────────────────────────────
check('normalizePatch 只接受认识的键', () => {
  const { values } = normalizePatch({ enabled: false, 不认识的键: 1 });
  assert.deepEqual(values, { enabled: false });
});

check('normalizePatch 夹紧整数范围', () => {
  const low = normalizePatch({ maxEntries: 1 }).values;
  assert.equal(low.maxEntries, FIELD_RULES.maxEntries.min);
  const high = normalizePatch({ maxTextLength: 9_999_999_999 }).values;
  assert.equal(high.maxTextLength, FIELD_RULES.maxTextLength.max);
  const good = normalizePatch({ maxEntries: 800 }).values;
  assert.equal(good.maxEntries, 800);
});

check('normalizePatch 拒绝错误类型，不静默接受', () => {
  const { values, rejected } = normalizePatch({ enabled: 'yes', maxEntries: 1.5 });
  assert.equal(values.enabled, undefined);
  assert.equal(values.maxEntries, undefined);
  assert.equal(rejected.length, 2);
});

check('normalizePatch 清洗词表：去空、去重、限长', () => {
  const { values } = normalizePatch({ customTerms: ['  张三 ', '', '张三', 'x'.repeat(200), 42] });
  assert.deepEqual(values.customTerms, ['张三']);
});

check('readRawConfig 对坏 JSON 不抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-cfg-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, '{ 这不是 JSON', 'utf8');
    assert.deepEqual(readRawConfig(file), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

check('writeRawConfig 是原子写、写出来是合法 JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-cfg-'));
  try {
    const file = join(dir, 'config.json');
    writeRawConfig(file, { enabled: true, customTerms: ['张三'] });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { enabled: true, customTerms: ['张三'] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

check('isSameOriginJsonRequest 拦住 text/plain（CSRF）', () => {
  const makeReq = headers => ({ headers });
  assert.equal(isSameOriginJsonRequest(makeReq({ 'content-type': 'text/plain', host: 'a' })), false);
  assert.equal(isSameOriginJsonRequest(makeReq({ 'content-type': 'application/json', host: 'a', origin: 'http://evil.test' })), false);
  assert.equal(isSameOriginJsonRequest(makeReq({ 'content-type': 'application/json', host: 'a', origin: 'http://a' })), true);
  assert.equal(isSameOriginJsonRequest(makeReq({ 'content-type': 'application/json; charset=utf-8', host: 'a' })), true);
});

// ── 真 HTTP ─────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'pr-api-'));
const configFile = join(dir, 'config.json');
// 预置一个「别的宿主写的」未知键，用来验证合并而不是覆盖
writeFileSync(configFile, JSON.stringify({ enabled: true, customTerms: [], 宿主甲写入的键: '保留我' }), 'utf8');

const settings = { enabled: true, enableSemantic: false, customTerms: [], maxEntries: 500, redactToolResults: false, maxTextLength: 200000, redactSessionLog: false };

const server = createServer((req, res) => {
  // 直接复用 registerConfigApi 注册的 handler
  handlerRef(req, res);
});

let handlerRef = null;
const fakeCtx = {
  inject: (deps, callback) => {
    assert.deepEqual(deps, ['webServer']);
    callback({
      webServer: {
        register: options => {
          handlerRef = options.handler;
          return () => {};
        }
      }
    });
  }
};

registerConfigApi(fakeCtx, { settings, file: configFile, log: () => {} });

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/prompt-redact-api`;

async function request(method, body, headers = {}) {
  const response = await fetch(base, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
}

try {
  await checkAsync('GET 返回当前设置、路径与字段范围', async () => {
    const { status, data } = await request('GET');
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.path, configFile);
    assert.equal(data.settings.enabled, true);
    assert.ok(data.fields.maxEntries.min > 0);
  });

  await checkAsync('POST 保存并就地更新运行中的 settings', async () => {
    const { status, data } = await request('POST', { settings: { maxEntries: 999 } });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(settings.maxEntries, 999, 'settings 对象没有被就地更新，改动不会立即生效');
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).maxEntries, 999);
  });

  await checkAsync('POST 合并而不是覆盖，未知键保住', async () => {
    await request('POST', { settings: { enabled: false } });
    const raw = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(raw.宿主甲写入的键, '保留我', '未知键被覆盖掉了');
    assert.equal(raw.maxEntries, 999, '上次保存的值丢了');
    assert.equal(settings.enabled, false);
    await request('POST', { settings: { enabled: true } });
  });

  await checkAsync('POST 夹紧超范围的值', async () => {
    const { data } = await request('POST', { settings: { maxTextLength: 1 } });
    assert.equal(data.settings.maxTextLength, FIELD_RULES.maxTextLength.min);
    await request('POST', { settings: { maxTextLength: 200000 } });
  });

  await checkAsync('POST 拒绝非 JSON 类型（CSRF 防线）', async () => {
    const { status, data } = await request('POST', { settings: { enabled: false } }, { 'Content-Type': 'text/plain' });
    assert.equal(status, 403);
    assert.equal(data.ok, false);
    assert.equal(settings.enabled, true, '被 CSRF 请求改掉了');
  });

  await checkAsync('POST 拒绝跨源', async () => {
    const { status } = await request('POST', { settings: { enabled: false } }, { Origin: 'http://evil.test' });
    assert.equal(status, 403);
    assert.equal(settings.enabled, true);
  });

  await checkAsync('POST 坏 JSON 返回 400 而不是崩掉', async () => {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: '{ 坏掉了'
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).ok, false);
  });

  await checkAsync('PUT 返回 405', async () => {
    const { status } = await request('PUT', {});
    assert.equal(status, 405);
  });

  await checkAsync('空补丁返回 400', async () => {
    const { status } = await request('POST', { settings: {} });
    assert.equal(status, 400);
  });

  await checkAsync('词表能存能读', async () => {
    await request('POST', { settings: { customTerms: ['张三', '某某科技'] } });
    const raw = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.deepEqual(raw.customTerms, ['张三', '某某科技']);
    assert.deepEqual(settings.customTerms, ['张三', '某某科技']);
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}

// ── 宿主没有 webServer 时不能抛错 ──────────────────────────────────
check('没有 inject 的宿主安全返回 false', () => {
  assert.equal(registerConfigApi({}, { settings: {}, file: 'x' }), false);
  assert.equal(registerConfigApi(undefined, { settings: {}, file: 'x' }), false);
});

check('register 抛错（重复路由）时不影响加载', () => {
  const logs = [];
  const result = registerConfigApi({
    inject: (deps, callback) => callback({ webServer: { register: () => { throw new Error('duplicate exact route'); } } })
  }, { settings: {}, file: 'x', log: m => logs.push(m) });
  assert.equal(result, true);
  assert.ok(logs.join('').includes('注册失败'), '没有留下告警');
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
