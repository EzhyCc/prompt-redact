#!/usr/bin/env node
// 零依赖静态服务器：只服务调试器页面，只监听本机回环地址。
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function fail(res, code, message) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(message);
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fail(res, 405, '405 只支持 GET');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch {
    fail(res, 400, '400 路径无法解析');
    return;
  }

  if (pathname === '/' || pathname === '') pathname = '/debugger/index.html';

  // 反斜杠在 Windows 上会被当作路径分隔符，先统一掉再解析，避免绕过。
  const target = normalize(join(ROOT, pathname.replace(/\\/g, '/')));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    fail(res, 403, '403 超出可服务范围');
    return;
  }

  let info;
  try {
    info = await stat(target);
  } catch {
    fail(res, 404, `404 找不到 ${pathname}`);
    return;
  }
  if (info.isDirectory()) {
    fail(res, 403, '403 不列目录');
    return;
  }

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
  console.log('Ctrl+C 停止。');
});
