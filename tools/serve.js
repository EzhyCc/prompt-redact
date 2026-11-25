#!/usr/bin/env node
// 本地服务：规则调试器 + 插件设置页。只监听回环地址。
//
// GET  /                 调试器页面
// GET  /api/config       读取插件配置（含文件路径）
// POST /api/config       写入插件配置
// 其它 /xxx              仓库内的静态文件

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configPath, readableConfigPath } from '../lib/config-path.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
let port = 5173;
const portFlag = argv.indexOf('--port');
if (portFlag !== -1) {
  const value = Number(argv[portFlag + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    console.error('用法：node tools/serve.js [--port 5173]');
    process.exit(1);
  }
  port = value;
}

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.ico', 'image/x-icon'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8']
]);

/** 配置项白名单与类型：只接受这几种键，避免设置页把脏数据写进去。 */
const CONFIG_SHAPE = {
  enabled: value => typeof value === 'boolean',
  enableSemantic: value => typeof value === 'boolean',
  redactToolResults: value => typeof value === 'boolean',
  customTerms: value => Array.isArray(value) && value.every(item => typeof item === 'string'),
  maxEntries: value => Number.isInteger(value) && value > 0,
  maxTextLength: value => Number.isInteger(value) && value > 0
};

function sanitizeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('配置必须是一个对象');
  }
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const accept = CONFIG_SHAPE[key];
    if (!accept) throw new Error(`未知配置项：${key}`);
    if (!accept(value)) throw new Error(`配置项 ${key} 的类型不对`);
    out[key] = key === 'customTerms' ? value.map(item => item.trim()).filter(Boolean) : value;
  }
  return out;
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function fail(res, code, message) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(message);
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 阻止别的网页往这里 POST：带了 Origin 就必须是同源。 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  // ── /api/config ────────────────────────────────────────────────
  if (url.pathname === '/api/config') {
    if (!sameOrigin(req)) return fail(res, 403, '403 跨源请求被拒绝');

    if (req.method === 'GET') {
      const path = readableConfigPath();
      try {
        const raw = await readFile(path, 'utf8');
        return sendJson(res, 200, { path, config: JSON.parse(raw) });
      } catch (error) {
        if (error.code === 'ENOENT') return sendJson(res, 200, { path, config: null });
        return sendJson(res, 200, { path, config: null, error: `已存在的配置文件读不出来：${error.message}` });
      }
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = sanitizeConfig(JSON.parse(await readBody(req)));
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
      const path = configPath();
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
        return sendJson(res, 200, { path, config: body });
      } catch (error) {
        return sendJson(res, 500, { error: `写入失败：${error.message}` });
      }
    }

    return fail(res, 405, '405 只支持 GET / POST');
  }

  // ── 静态文件 ───────────────────────────────────────────────────
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return fail(res, 405, '405 只支持 GET');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return fail(res, 400, '400 路径无法解析');
  }
  if (pathname === '/' || pathname === '') pathname = '/debugger/index.html';

  const target = normalize(join(ROOT, pathname.replace(/\\/g, '/')));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    return fail(res, 403, '403 超出可服务范围');
  }

  let info;
  try {
    info = await stat(target);
  } catch {
    return fail(res, 404, `404 找不到 ${pathname}`);
  }
  if (info.isDirectory()) return fail(res, 403, '403 不列目录');

  res.writeHead(200, {
    'content-type': MIME.get(extname(target).toLowerCase()) || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-store'
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`调试器已启动：http://127.0.0.1:${port}/`);
  console.log(`插件配置：${configPath()}`);
});
