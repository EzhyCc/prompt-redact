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

/** 只替换 role=user 的 text 块；system 提示词、已有 assistant 回复、图片和文件引用原样保留。 */
function redactMessages(messages, run) {
  return messages.map(message => {
    if (!message || message.role !== 'user' || !Array.isArray(message.content)) return message;
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
    maxEntries: Number.isInteger(config.maxEntries) ? config.maxEntries : 500
  };

  if (!settings.enabled) return;

  const session = new Session({ maxEntries: settings.maxEntries });
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
      });
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

  // 供设置页或其它插件读取的只读状态
  try {
    ctx.provide?.('promptRedactStats', () => ({ ...stats, sessionSize: session.size() }));
  } catch {
    /* 宿主不支持 provide 时忽略 */
  }
}
