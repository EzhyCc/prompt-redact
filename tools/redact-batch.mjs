#!/usr/bin/env node
// 批量脱敏桥：从 stdin 读 JSON {texts:[...], terms:{...}, semantic:false}，
// 写到 stdout {texts:[...], tokens:{...}}。
// 用途：Python 的 docx 处理器把整篇文档的所有文本节点一次性送进来，一次调用完成脱敏，
// 避免为每个节点单独起进程；同时保证规则引擎只有一份（JS 里的 src/index.js）。
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../src/index.js';
import { Session } from '../src/session.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_DIR = join(HERE, '..', 'rules', 'zh-CN');

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let payload;
try {
  payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} catch (error) {
  process.stderr.write(`输入不是合法 JSON：${error.message}\n`);
  process.exit(1);
}

const texts = Array.isArray(payload.texts) ? payload.texts : [];
const terms = payload.terms && typeof payload.terms === 'object' ? payload.terms : {};

const files = (await readdir(RULES_DIR)).filter(f => f.endsWith('.json') && f !== 'manifest.json');
const groups = await Promise.all(files.map(async f => JSON.parse(await readFile(join(RULES_DIR, f), 'utf8')).rules ?? []));
const rules = groups.flat();

// --org：把所有「XX公司/医院/大学/研究院/集团」一律当机构名兜底（词表列不全时用）
if (payload.org === true) {
  rules.push({
    id: 'org-fallback', label: '机构', category: 'identity', tier: 'format',
    severity: 'medium', token: 'ORG',
    match: [{
      type: 'regex',
      pattern: '[\u4e00-\u9fa5A-Za-z0-9]{2,12}(?:\u80a1\u4efd\u6709\u9650\u516c\u53f8|\u6709\u9650\u8d23\u4efb\u516c\u53f8|\u6709\u9650\u516c\u53f8|\u516c\u53f8|\u533b\u9662|\u5927\u5b66|\u7814\u7a76\u9662|\u96c6\u56e2)'
    }]
  });
}

const session = new Session({ maxEntries: 20000 });
const out = texts.map(text => (typeof text === 'string' && text.length > 0
  ? redact(text, { rules, session, enableSemantic: payload.semantic === true, customTerms: terms }).text
  : text));

process.stdout.write(JSON.stringify({ texts: out, tokens: Object.fromEntries(session.entries()) }));
