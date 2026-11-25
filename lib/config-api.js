// 设置页的宿主侧接口：让客户端插件能读写 ~/.prompt-redact/config.json。
//
// 为什么需要它：客户端插件跑在渲染进程里，没有文件写权限。DSH 的做法是
// 宿主侧在 webServer 上注册一个 HTTP 端点，客户端 fetch 它 —— 这也是
// balance-dsh 把设置写回磁盘的方式（/balance-api?config=1，GET 读 POST 写）。
//
// 几条硬规矩（照 balance-dsh 踩过的坑定的）：
//   · inject 只声明 ['webServer']。多声明依赖会让回调在服务未就绪时被整个跳过，
//     结果就是端点 404、设置页一片空白。
//   · register 要单独 try/catch：热重载后旧实例的路由可能还没清干净，
//     重复注册会抛 duplicate exact route，冒到 loader 就是整个插件加载失败。
//   · POST 必须校验同源 + application/json：端点监听在回环地址，但浏览器里
//     任意网页都能对本机发 text/plain 的「简单请求」，不校验就是 CSRF。
//   · 写盘要原子：先写临时文件再 rename，避免进程中断留下半个 JSON。
//   · 合并而不是整份覆盖：用户文件里可能有本版本不认识的键（别的宿主写的、
//     或者降级后留下的），整份覆盖等于把它们删掉。

import { readFileSync, renameSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** 各字段的合法范围。超出的值夹到边界，而不是拒绝整次保存。 */
export const FIELD_RULES = Object.freeze({
  enabled: { type: 'boolean', defaultValue: true },
  enableSemantic: { type: 'boolean', defaultValue: false },
  redactToolResults: { type: 'boolean', defaultValue: false },
  redactSessionLog: { type: 'boolean', defaultValue: false },
  maxTextLength: { type: 'integer', defaultValue: 200_000, min: 1_000, max: 10_000_000 },
  maxEntries: { type: 'integer', defaultValue: 500, min: 10, max: 100_000 }
});

/** 词表最多留多少条、单条最长多少字 —— 防止一个粘贴把内存吃掉。 */
const MAX_TERMS = 500;
const MAX_TERM_LENGTH = 100;

/**
 * 把任意外来值规整成合法的设置项，只返回**认识**的键。
 * @param {Record<string, unknown>} raw
 * @returns {{ values: Record<string, unknown>, rejected: string[] }}
 */
export function normalizePatch(raw) {
  const values = {};
  const rejected = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { values, rejected: ['（不是对象）'] };
  }

  for (const [key, rule] of Object.entries(FIELD_RULES)) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];

    if (rule.type === 'boolean') {
      if (typeof value === 'boolean') values[key] = value;
      else rejected.push(`${key} 必须是 true/false`);
      continue;
    }

    if (rule.type === 'integer') {
      if (!Number.isInteger(value)) { rejected.push(`${key} 必须是整数`); continue; }
      values[key] = Math.min(rule.max, Math.max(rule.min, value));
    }
  }

  if (Object.hasOwn(raw, 'customTerms')) {
    const list = raw.customTerms;
    if (!Array.isArray(list)) {
      rejected.push('customTerms 必须是数组');
    } else {
      const terms = [];
      for (const item of list) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (!trimmed || trimmed.length > MAX_TERM_LENGTH) continue;
        if (!terms.includes(trimmed)) terms.push(trimmed);
        if (terms.length >= MAX_TERMS) break;
      }
      values.customTerms = terms;
    }
  }

  return { values, rejected };
}

/**
 * 读磁盘上的配置（保留全部未知键）。
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
export function readRawConfig(file) {
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // 文件坏了也不抛：当作空配置，让保存能把好的内容写回去
    return {};
  }
}

/**
 * 原子写：先写临时文件再 rename。
 * @param {string} file
 * @param {Record<string, unknown>} data
 */
export function writeRawConfig(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/**
 * 只放行同源 + JSON 的写请求。
 * 浏览器里其它网页能用 text/plain 发「简单请求」绕过预检，不校验就是 CSRF。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isSameOriginJsonRequest(req) {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/json')) return false;

  const host = String(req.headers.host ?? '');
  const origin = req.headers.origin ?? req.headers.referer;
  if (!origin) return true; // 同源 fetch 有时不带 Origin；host 已限制在回环地址

  try {
    const parsed = new URL(String(origin));
    return parsed.host === host;
  } catch {
    return false;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 把设置接口挂到宿主的 webServer 上。
 *
 * @param {object} ctx cordis 上下文
 * @param {object} options
 * @param {Record<string, unknown>} options.settings 插件当前生效的设置对象（**会被就地修改**，
 *        这样所有已注册的闭包立刻看到新值，不用重启 DSH）
 * @param {string} options.file 配置文件路径
 * @param {(message: string) => void} [options.log]
 * @returns {boolean} 是否尝试注册
 */
export function registerConfigApi(ctx, options) {
  const { settings, file, log } = options;
  if (!ctx || typeof ctx.inject !== 'function') return false;

  ctx.inject(['webServer'], httpCtx => {
    try {
      httpCtx.webServer.register({
        kind: 'exact',
        path: '/prompt-redact-api',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            sendJson(res, 200, {
              ok: true,
              settings: { ...settings },
              path: file,
              fields: Object.fromEntries(Object.entries(FIELD_RULES).map(([key, rule]) => [key, {
                type: rule.type, min: rule.min, max: rule.max, default: rule.defaultValue
              }]))
            });
            return;
          }

          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '只支持 GET 与 POST' });
            return;
          }
          if (!isSameOriginJsonRequest(req)) {
            sendJson(res, 403, { ok: false, error: '只接受同源的 JSON 请求' });
            return;
          }

          let body;
          try {
            const text = await readBody(req);
            body = text.trim() === '' ? {} : JSON.parse(text);
          } catch (error) {
            sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${error.message}` });
            return;
          }

          const patch = body && typeof body === 'object' && body.settings !== undefined ? body.settings : body;
          const { values, rejected } = normalizePatch(patch);
          if (Object.keys(values).length === 0 && rejected.length === 0) {
            sendJson(res, 400, { ok: false, error: '没有可保存的字段' });
            return;
          }

          try {
            // 合并而不是覆盖：保住本版本不认识的键
            const merged = { ...readRawConfig(file), ...values };
            writeRawConfig(file, merged);
            Object.assign(settings, values);
            if (log) log(`设置已保存：${Object.keys(values).join(', ')}`);
            sendJson(res, 200, { ok: true, settings: { ...settings }, rejected });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: `写配置失败：${error.message}` });
          }
        }
      });
    } catch (error) {
      // 注册失败只意味着设置页不可用，聊天脱敏照常
      if (log) log(`设置接口注册失败，设置页将不可用：${error?.message ?? error}`);
    }
  });

  return true;
}
