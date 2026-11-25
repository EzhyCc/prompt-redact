// DSH 插件的端到端自测：把真实的 LlmRuntime 和本插件挂进一个最小 cordis 容器，
// 检查请求到达适配器之前的形态是否符合预期。
//
// 找不到 DSH 安装时整组跳过（打印 0 passed, 0 failed），这样 CI 上跑不受影响。
// 指定安装位置：设置环境变量 DSH_ROOT 指向 resources/app/dsh。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATES = [
  process.env.DSH_ROOT,
  'C:/Users/c2557/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh',
  join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/app/dsh')
].filter(Boolean);

const dshRoot = CANDIDATES.find(base => existsSync(join(base, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')));
if (!dshRoot) {
  process.stdout.write('SKIP 找不到 DSH 安装，跳过插件端到端测试（设置 DSH_ROOT 可指定）\n\n0 passed, 0 failed\n');
  process.exit(0);
}

const load = relative => import(pathToFileURL(join(dshRoot, 'node_modules', '@deepseek-ai', relative)).href);
const { Context } = await load('cordis/lib/index.js');
const { LlmRuntime } = await load('dsh-llm/lib/index.js');

// 隔离真实配置：默认指向一个不存在的临时路径，避免开发机上 ~/.prompt-redact/config.json
// 悄悄盖掉每条用例的 cordis 配置（这个坑真的踩过一次）。
const isolatedConfig = join(mkdtempSync(join(tmpdir(), 'pr-isolated-')), 'config.json');
process.env.PROMPT_REDACT_CONFIG = isolatedConfig;

const plugin = await import('../lib/index.js');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
  }
}

/** 起一个容器，挂上 LlmRuntime、一个观察者、以及本插件。 */
async function boot(config = {}) {
  const ctx = new Context();
  ctx.plugin(LlmRuntime);
  await ctx.start?.();

  const seen = [];
  ctx.on('llm/stream', (options, next) => { seen.push(options); return next(); });

  ctx.plugin(plugin, config);
  await ctx.start?.();
  // 规则是异步读盘的，等一拍
  await new Promise(resolve => setTimeout(resolve, 250));
  return { ctx, seen };
}

async function call(ctx, messages) {
  const chunks = [];
  for await (const chunk of ctx.llm.stream({ provider: 'no-such-provider', model: 'test', messages })) chunks.push(chunk);
  return chunks;
}

const userText = () => ([
  { role: 'user', content: [{ type: 'text', text: '张三手机 138-0013-8000，身份证 110101199003071233，邮箱 a@b.com' }] }
]);

// ── 基础行为 ────────────────────────────────────────────────────────
{
  const { ctx, seen } = await boot({ enabled: true, customTerms: ['张三'] });
  await call(ctx, [
    { role: 'system', content: [{ type: 'text', text: '你是助手，回拨 13900139000' }] },
    { role: 'user', content: [
      { type: 'text', text: '张三手机 138-0013-8000，身份证 110101199003071233' },
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAA' } }
    ] },
    { role: 'assistant', content: [{ type: 'text', text: '收到，电话 13800138000' }] }
  ]);

  const payload = JSON.stringify(seen.at(-1));

  check('适配器收到的是改写后的请求', () => assert.ok(seen.length >= 1));

  check('user 手机号被替换', () => {
    assert.ok(payload.includes('[手机号]'), payload);
    assert.ok(!payload.includes('138-0013-8000'));
  });
  check('user 身份证被替换', () => assert.ok(payload.includes('[身份证]') && !payload.includes('110101199003071233')));
  check('个人词表生效', () => assert.ok(payload.includes('[自定义词]')));
  check('system 提示词原样保留', () => assert.ok(payload.includes('13900139000')));
  check('assistant 历史原样保留', () => assert.ok(payload.includes('13800138000')));
  check('图片块原样保留', () => assert.ok(payload.includes('"type":"image"')));
  // 派发两次是这套机制的正常形态：第一次是原始请求（观察者看到它），
  // 插件不改它，而是重新发一次改写后的请求（第二次）。不能变成 3 次以上，
  // 那说明递归没被挡住。
  check('只重发一次，递归被挡住', () => {
    assert.equal(seen.length, 2, `派发了 ${seen.length} 次`);
    assert.ok(JSON.stringify(seen[0]).includes('138-0013-8000'), '第一次应当是原始请求');
    assert.ok(JSON.stringify(seen[1]).includes('[手机号]'), '第二次应当是改写后的请求');
  });
}

// ── 配置文件覆盖 cordis 配置（设置页写的那个文件） ──────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'pr-dsh-'));
  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ enabled: false }), 'utf8');
  const previous = process.env.PROMPT_REDACT_CONFIG;
  process.env.PROMPT_REDACT_CONFIG = configFile;
  try {
    const { ctx, seen } = await boot({ enabled: true });
    await call(ctx, userText());
    check('配置文件覆盖 cordis 配置', () => {
      const payload = JSON.stringify(seen.at(-1));
      assert.ok(payload.includes('138-0013-8000'), 'enabled:false 时应当原样透传');
      assert.ok(!payload.includes('[手机号]'));
    });
  } finally {
    if (previous === undefined) delete process.env.PROMPT_REDACT_CONFIG;
    else process.env.PROMPT_REDACT_CONFIG = previous;
  }
}

// ── 会话写入脱敏（让界面里自己那条消息也显示占位符） ────────────────
function makeFakeSession() {
  const calls = [];
  return {
    id: 'fake',
    append(type, data) { calls.push({ type, data }); return { type }; },
    calls
  };
}

for (const flag of [false, true]) {
  const { ctx } = await boot({ enabled: true, redactSessionLog: flag });
  const session = makeFakeSession();
  ctx.emit('session/created', session);
  await new Promise(resolve => setTimeout(resolve, 30));

  session.append('user/message', { role: 'user', content: [{ type: 'text', text: '手机 13800138000，密码：Qwe!2345' }] });
  session.append('assistant/message', { role: 'assistant', content: [{ type: 'text', text: '收到 13800138000' }] });
  session.append('turn/start', { turn: 1 });

  const userPayload = JSON.stringify(session.calls[0]?.data ?? '');
  if (flag) {
    check('会话记录脱敏：user/message 被替换', () => {
      assert.ok(userPayload.includes('[手机号]'), userPayload);
      assert.ok(!userPayload.includes('13800138000'));
      assert.ok(userPayload.includes('[口令]'));
    });
    check('会话记录脱敏：assistant 与其它事件不动', () => {
      assert.ok(JSON.stringify(session.calls[1]?.data).includes('13800138000'));
      assert.equal(session.calls[2]?.data?.turn, 1);
    });
  } else {
    // 现在始终包装 session.append，开关在运行时判断 —— 这样设置页里打开
    // 「界面也显示占位符」立刻生效，不用重启 DSH。关闭时必须完全无操作。
    check('会话记录脱敏关闭时：已包装但内容一字不改', () => {
      assert.equal(session.__promptRedactWrapped, true, '应当已包装，否则无法热切换');
      assert.ok(!userPayload.includes('[手机号]'), '关闭后仍被改写');
      assert.ok(userPayload.includes(String(13800138000)), '原文应当保留');
    });
  }
}

// ── 开关关闭时必须完全透传 ─────────────────────────────────────────
{
  const { ctx, seen } = await boot({ enabled: false });
  await call(ctx, userText());
  check('enabled=false 时原样放行', () => {
    const payload = JSON.stringify(seen.at(-1));
    assert.ok(payload.includes('138-0013-8000'));
    assert.ok(!payload.includes('[手机号]'));
  });
}

// ── 宿主异常不能拖垮对话 ────────────────────────────────────────────
{
  const { ctx, seen } = await boot({ enabled: true });
  const hostile = [{
    role: 'user',
    content: [{ type: 'text', get text() { throw new Error('boom'); } }]
  }];
  let threw = false;
  try { await call(ctx, hostile); } catch { threw = true; }
  check('消息块取值抛异常时不阻断请求', () => {
    assert.equal(threw, false);
    assert.equal(seen.length, 1, '应当回落到 next() 放行一次');
  });
}

// ── 超长文本跳过而不是卡住 ─────────────────────────────────────────
{
  const { ctx, seen } = await boot({ enabled: true, maxTextLength: 100 });
  const long = '填充'.repeat(200) + ' 13800138000';
  await call(ctx, [{ role: 'user', content: [{ type: 'text', text: long }] }]);
  check('超过 maxTextLength 的块原样放行', () => {
    const payload = JSON.stringify(seen.at(-1));
    assert.ok(payload.includes('13800138000'));
    assert.ok(!payload.includes('[手机号]'));
  });
}

// ── 工具结果脱敏开关 ───────────────────────────────────────────────
const toolResult = () => ({
  content: [{ type: 'text', text: '合同正文：电话 13800138000，卡号 6222021234567894' }]
});

for (const enabled of [false, true]) {
  const { ctx } = await boot({ enabled: true, redactToolResults: enabled });
  const decision = await ctx.waterfall({}, 'tools/post-execute', { name: 'read', callId: 'c1' }, toolResult(),
    () => ({ kind: 'accept', content: toolResult().content }));
  const text = decision?.content?.[0]?.text ?? '';
  check(`工具结果脱敏 ${enabled ? '开' : '关'}`, () => {
    if (enabled) {
      assert.ok(text.includes('[手机号]'), text);
      assert.ok(!text.includes('13800138000'));
    } else {
      assert.ok(text.includes('13800138000'));
      assert.ok(!text.includes('[手机号]'));
    }
  });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
