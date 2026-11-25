// Prompt Redact 的 DeepSeek Harness 插件：在模型请求发出之前，把 user 消息里的敏感信息替换成占位符。
//
// 挂载点：cordis 的 `llm/stream` 瀑布。DSH 的 LlmRuntime 每发一次模型请求都会 dispatch 它：
//   streamWithRegistration(options) {
//     return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options))
//   }
//
// 注意 `next()` 不接受参数——没法把改写后的 options 传下去。所以这里的做法是：
// 在监听器内部再调一次 ctx.llm.stream(改写后的 options)，用 busy 标记挡住自己避免无限递归。
// 因为 waterfall 的派发是同步的（stream() 是普通方法，不是 generator），busy 的开关窗口是安全的。

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redact } from '../src/index.js';
import { Session } from '../src/session.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_DIR = join(HERE, '..', 'rules', 'zh-CN');

export const name = 'prompt-redact';
export const inject = ['llm'];

/** 日志是可选的：不同宿主暴露 logger 的方式不一样，拿不到就静默跳过。 */
function log(ctx, level, message) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('prompt-redact') : null;
    logger?.[level]?.(message);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** 读入规则库。失败时返回空数组，让插件退化为"什么都不做"而不是崩掉宿主。 */
async function loadRules(ctx) {
  try {
    const files = (await readdir(RULES_DIR)).filter(file => file.endsWith('.json'));
    const groups = await Promise.all(files.map(async file => {
      const raw = await readFile(join(RULES_DIR, file), 'utf8');
      return JSON.parse(raw).rules ?? [];
    }));
    return groups.flat();
  } catch (error) {
    log(ctx, 'warn', `规则加载失败，插件将不生效：${error.message}`);
    return [];
  }
}

/**
 * 替换文本块里的敏感信息。
 *
 * 默认只碰 role=user：system 提示词被替换会出问题，assistant 历史被替换会让上下文自相矛盾。
 * 打开 redactToolResults 后额外处理 role=tool —— 上传的文件经文件工具读出后就是 tool 消息，
 * 不处理的话文件正文会明文进上下文。代价是模型读到的代码/日志也会被改写，
 * 如果它正在改文件里的字面量，可能改错，所以默认关闭。
 */
function redactMessages(messages, run, roles) {
  return messages.map(message => {
    if (!message || !roles.has(message.role) || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map(block => {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') return block;
      const replaced = run(block.text);
      if (replaced === block.text) return block;
      changed = true;
      return { ...block, text: replaced };
    });
    return changed ? { ...message, content } : message;
  });
}

export function apply(ctx, config = {}) {
  const settings = {
    enabled: config.enabled !== false,
    enableSemantic: config.enableSemantic === true,
    customTerms: Array.isArray(config.customTerms) ? config.customTerms : [],
    maxEntries: Number.isInteger(config.maxEntries) ? config.maxEntries : 500,
    redactToolResults: config.redactToolResults === true
  };

  if (!settings.enabled) return;

  const session = new Session({ maxEntries: settings.maxEntries });
  const roles = new Set(['user']);
  let rules = [];
  let busy = false;
  let stats = { requests: 0, replacements: 0, failures: 0 };

  loadRules(ctx).then(loaded => { rules = loaded; });

  const runRedact = text => redact(text, {
    rules,
    session,
    enableSemantic: settings.enableSemantic,
    customTerms: settings.customTerms
  });

  ctx.on('llm/stream', (options, next) => {
    if (busy || !options || !Array.isArray(options.messages) || rules.length === 0) return next();

    let rewritten;
    try {
      // 逐条消息脱敏；用一次 runRedact 调用统计命中数不方便，这里按消息累计
      const messages = redactMessages(options.messages, text => {
        const result = runRedact(text);
        stats.replacements += result.hits.length;
        return result.text;
      }, roles);
      stats.requests += 1;
      rewritten = messages;
    } catch (error) {
      // 失败时放行，但必须在日志里留下痕迹——绝不静默装作保护成功
      stats.failures += 1;
      log(ctx, 'warn', `脱敏失败，本次请求未受保护：${error.message}`);
      return next();
    }

    busy = true;
    try {
      return ctx.llm.stream({ ...options, messages: rewritten });
    } finally {
      busy = false;
    }
  });

  log(ctx, 'info', `已启用：${settings.enableSemantic ? '含语义类规则' : '仅格式类规则'}，个人词表 ${settings.customTerms.length} 条`);

  // 工具结果的脱敏放在 post-execute 上：它在结果写入会话日志之前执行，
  // 所以文件正文从工具返回的那一刻就已经是 token，明文根本没进日志。
  // 比在 llm/stream 里改写 role=tool 更彻底，也更省——只算一次，不用每轮重算。
  if (settings.redactToolResults) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      if (!decision || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision;
      const content = decision.content ?? result?.content;
      if (!Array.isArray(content) || rules.length === 0) return decision;

      let changed = false;
      const redacted = content.map(block => {
        if (!block || block.type !== 'text' || typeof block.text !== 'string') return block;
        try {
          const outcome = runRedact(block.text);
          stats.replacements += outcome.hits.length;
          if (outcome.text === block.text) return block;
          changed = true;
          return { ...block, text: outcome.text };
        } catch (error) {
          stats.failures += 1;
          log(ctx, 'warn', `工具结果脱敏失败（${exec?.name ?? 'unknown'}）：${error.message}`);
          return block;
        }
      });

      if (!changed) return decision;
      return { ...decision, content: redacted };
    });
  }

  // 供设置页或其它插件读取的只读状态
  try {
    ctx.provide?.('promptRedactStats', () => ({ ...stats, sessionSize: session.size() }));
  } catch {
    /* 宿主不支持 provide 时忽略 */
  }
}
