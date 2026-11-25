// Prompt Redact 的 DeepSeek Harness 插件：在模型请求发出之前，把 user 消息里的敏感信息替换成占位符。
//
// ── 挂载点 ───────────────────────────────────────────────────────────
// cordis 的 `llm/stream` 瀑布。LlmRuntime 每发一次模型请求都会派发它：
//   streamWithRegistration(options) {
//     return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options))
//   }
//
// `next()` 不接受参数，没法把改写后的 options 往下传。所以这里的做法是在监听器内部
// 再调一次 ctx.llm.stream(改写后的 options)，用 busy 标记挡住自己。因为 waterfall 的
// 派发是同步的（stream() 是普通方法，不是 generator），busy 的开关窗口是安全的。
//
// ── 设计底线 ─────────────────────────────────────────────────────────
// 这是插在别人对话链路中间的一段代码，它出错不能让用户发不出消息。
// 所以任何一条路径上的异常都会退回 `next()`，把原始请求原样放行，并在日志里留下痕迹。
// 唯一不能接受的失败是「界面显示已保护但实际发了原文」——插件没有界面，就没有这种可能。

import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redact } from '../src/index.js';
import { Session } from '../src/session.js';
import { configPath, readableConfigPath } from './config-path.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_DIR = join(HERE, '..', 'rules', 'zh-CN');

/** 规则目录里不是规则包的文件。 */
const NON_RULE_FILES = new Set(['manifest.json']);

/** 单块文本超过这个长度就跳过脱敏：宁可漏，也不要把一次对话卡住。 */
const DEFAULT_MAX_TEXT_LENGTH = 200_000;

/**
 * 用户配置文件的位置。设置页写的也是它。
 * 宿主中立：DSH 插件、浏览器扩展、本地代理读的是同一个文件。
 * @returns {string}
 */
export function userConfigPath() {
  return configPath();
}

/** 读用户配置。文件不存在、不是合法 JSON、不是对象，都当作空配置。 */
function loadUserConfig(ctx) {
  const path = readableConfigPath();
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    log(ctx, 'warn', `用户配置读取失败，已忽略（${path}）：${error.message}`);
    return {};
  }
}

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

/** 读入规则库。失败返回空数组，让插件退化为「什么都不做」而不是崩掉宿主。 */
async function loadRules(ctx) {
  try {
    const files = (await readdir(RULES_DIR)).filter(file => file.endsWith('.json') && !NON_RULE_FILES.has(file));
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
 * 默认只碰 role=user：system 提示词被替换会让工具说明错乱，assistant 历史被替换
 * 会让上下文自相矛盾（模型看到自己之前说过的话被改了）。
 */
function redactMessages(messages, run, roles, maxTextLength) {
  let changed = false;
  const out = messages.map(message => {
    if (!message || !roles.has(message.role) || !Array.isArray(message.content)) return message;
    let touched = false;
    const content = message.content.map(block => {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') return block;
      if (block.text.length > maxTextLength) return block;
      const replaced = run(block.text);
      if (replaced === block.text) return block;
      touched = true;
      return { ...block, text: replaced };
    });
    if (!touched) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? out : null;
}

export function apply(ctx, config = {}) {
  // 配置文件覆盖 cordis.patch.yml：设置页写的就是这个文件。
  // 插件在启动时读一次，改完需要重启 DSH（或重载插件）才生效。
  const merged = { ...config, ...loadUserConfig(ctx) };

  const settings = {
    enabled: merged.enabled !== false,
    enableSemantic: merged.enableSemantic === true,
    customTerms: Array.isArray(merged.customTerms) ? merged.customTerms.filter(t => typeof t === 'string' && t) : [],
    maxEntries: Number.isInteger(merged.maxEntries) && merged.maxEntries > 0 ? merged.maxEntries : 500,
    redactToolResults: merged.redactToolResults === true,
    maxTextLength: Number.isInteger(merged.maxTextLength) && merged.maxTextLength > 0 ? merged.maxTextLength : DEFAULT_MAX_TEXT_LENGTH,
    // 把脱敏点前移到「消息写入会话记录之前」，这样聊天界面里你自己那条消息也显示占位符。
    // 默认关：它会改写 append-only 的会话日志，是一处对宿主内部的侵入。
    redactSessionLog: merged.redactSessionLog === true
  };

  const stats = { requests: 0, replacements: 0, failures: 0, skippedTooLong: 0, lastError: null };

  if (!settings.enabled) {
    try {
      ctx.provide?.('promptRedactStats', () => ({ ...stats, enabled: false }));
    } catch { /* 宿主不支持时忽略 */ }
    return;
  }

  const session = new Session({ maxEntries: settings.maxEntries });
  const roles = new Set(['user']);
  /** 已被本插件改写过的 messages 数组，防止多实例或重复挂载导致二次脱敏。 */
  const alreadyRewritten = new WeakSet();
  let rules = [];
  let busy = false;

  loadRules(ctx).then(loaded => {
    rules = loaded;
    log(ctx, 'info', `规则已载入 ${rules.length} 条`);
  });

  const runRedact = text => redact(text, {
    rules,
    session,
    enableSemantic: settings.enableSemantic,
    customTerms: settings.customTerms
  });

  const fail = (error, where) => {
    stats.failures += 1;
    stats.lastError = `${where}: ${error?.message ?? error}`;
    log(ctx, 'warn', `脱敏失败，本次请求按原文放行（${where}）：${error?.message ?? error}`);
  };

  // ── 模型请求：替换 user 消息的文本块 ─────────────────────────────
  ctx.on('llm/stream', (options, next) => {
    try {
      if (busy || rules.length === 0) return next();
      if (!options || !Array.isArray(options.messages)) return next();
      if (alreadyRewritten.has(options.messages)) return next();

      let messages;
      try {
        messages = redactMessages(options.messages, text => {
          if (text.length > settings.maxTextLength) { stats.skippedTooLong += 1; return text; }
          const result = runRedact(text);
          stats.replacements += result.hits.length;
          return result.text;
        }, roles, settings.maxTextLength);
      } catch (error) {
        fail(error, 'redact');
        return next();
      }

      if (messages === null) return next();

      alreadyRewritten.add(messages);
      stats.requests += 1;

      busy = true;
      try {
        return ctx.llm.stream({ ...options, messages });
      } catch (error) {
        busy = false;
        fail(error, 'redispatch');
        return next();
      } finally {
        busy = false;
      }
    } catch (error) {
      // 兜底：连判断逻辑都出错时也要放行
      fail(error, 'hook');
      return next();
    }
  });

  // ── 工具结果：在写入会话日志之前替换，明文不进 log ────────────────
  if (settings.redactToolResults) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      let decision;
      try {
        decision = await next();
      } catch (error) {
        fail(error, 'post-execute/next');
        throw error;
      }

      try {
        if (!decision || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision;
        if (rules.length === 0) return decision;

        const content = decision.content ?? result?.content;
        if (!Array.isArray(content)) return decision;

        let changed = false;
        const redacted = content.map(block => {
          if (!block || block.type !== 'text' || typeof block.text !== 'string') return block;
          if (block.text.length > settings.maxTextLength) { stats.skippedTooLong += 1; return block; }
          try {
            const outcome = runRedact(block.text);
            stats.replacements += outcome.hits.length;
            if (outcome.text === block.text) return block;
            changed = true;
            return { ...block, text: outcome.text };
          } catch (error) {
            fail(error, `tool:${exec?.name ?? 'unknown'}`);
            return block;
          }
        });

        return changed ? { ...decision, content: redacted } : decision;
      } catch (error) {
        fail(error, 'post-execute');
        return decision;
      }
    });
  }

  // ── 会话写入：让界面里自己那条消息也显示占位符 ────────────────────
  // 默认关闭。它会包一层 session.append，属于对宿主内部的侵入：
  // - 包装失败时静默跳过，不影响正常对话
  // - 只处理 type === 'user/message'，其余事件原样通过
  // - 任何异常都退回原方法，绝不让一次写入失败
  // 注意：规则是异步加载的，这里不能判断 rules.length——那会在 apply 时同步求值成 0，
  // 整块被跳过。判空放到真正用的时候（redactText 里）。
  if (settings.redactSessionLog) {
    const redactText = text => {
      if (rules.length === 0) return text;
      if (typeof text !== 'string' || text.length > settings.maxTextLength) return text;
      const result = runRedact(text);
      stats.replacements += result.hits.length;
      return result.text;
    };

    const redactOneMessage = message => {
      if (!message || message.role !== 'user' || !Array.isArray(message.content)) return message;
      let touched = false;
      const content = message.content.map(block => {
        if (!block || block.type !== 'text' || typeof block.text !== 'string') return block;
        const replaced = redactText(block.text);
        if (replaced === block.text) return block;
        touched = true;
        return { ...block, text: replaced };
      });
      return touched ? { ...message, content } : message;
    };

    const wrapSession = session => {
      try {
        if (!session || typeof session.append !== 'function' || session.__promptRedactWrapped) return;
        const original = session.append;
        session.append = function appendWithRedaction(type, data, ...rest) {
          if (type === 'user/message') {
            try {
              // 两种形态都见过：data 本身就是消息，或 data.message 是消息
              if (data && typeof data === 'object' && data.message) {
                data = { ...data, message: redactOneMessage(data.message) };
              } else {
                data = redactOneMessage(data);
              }
            } catch (error) {
              stats.failures += 1;
              log(ctx, 'warn', `会话写入脱敏失败，按原文写入：${error.message}`);
            }
          }
          return original.call(this, type, data, ...rest);
        };
        Object.defineProperty(session, '__promptRedactWrapped', { value: true, enumerable: false });
        stats.sessionLogWrapped = (stats.sessionLogWrapped ?? 0) + 1;
      } catch (error) {
        stats.failures += 1;
        log(ctx, 'warn', `会话对象不可包装，气泡仍显示原文：${error.message}`);
      }
    };

    ctx.on('session/created', wrapSession, { global: true });
    // 插件启用前就已经打开的会话
    try {
      const existing = ctx.session?.list?.() ?? [];
      for (const session of existing) wrapSession(session);
    } catch { /* 拿不到列表就算了，新会话会走到上面的钩子 */ }
  }

  try {
    ctx.provide?.('promptRedactStats', () => ({
      ...stats,
      enabled: true,
      rules: rules.length,
      sessionSize: session.size()
    }));
  } catch { /* 宿主不支持时忽略 */ }

  log(ctx, 'info',
    `已启用：${settings.enableSemantic ? '含语义类规则' : '仅格式类规则'}，`
    + `个人词表 ${settings.customTerms.length} 条，`
    + `工具结果脱敏 ${settings.redactToolResults ? '开' : '关'}，`
    + `会话记录脱敏 ${settings.redactSessionLog ? '开' : '关'}`
    + `（配置来源：cordis + ${userConfigPath()}）`);
}
