// Demonstrates the §10.1 example using the core rules.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact, scan } from './src/index.js';
const root=dirname(fileURLToPath(import.meta.url));
const names=['contact','identity','credential','finance','network','semantic'];
const rules=names.flatMap(n=>JSON.parse(readFileSync(resolve(root,`rules/zh-CN/${n}.json`),'utf8')).rules);
const input=`甲方：深圳市云深科技有限公司
联系人 张三，手机 138-0013-8000，身份证 110101199003071233
回款卡号 6222021234567894，工号 A1027
邮箱 zhang.san@yunshen-tech.com.cn，内网 10.12.33.44
DB: mysql://root:Pa55w0rd@10.12.33.9:3306/prod
Key: sk-proj-AbCdEf1234567890XyZq
密码：Qwe!2345`;
const started=performance.now();
const hits=scan(input,rules);
const result=redact(input,{rules});
const elapsed=performance.now()-started;
const color=Boolean(process.stdout.isTTY);
const paint=(s,c)=>color?`\\x1b[${c}m${s}\\x1b[0m`:s;
let marked=input;
for(const hit of [...hits].sort((a,b)=>b.start-a.start)) marked=marked.slice(0,hit.start)+paint(marked.slice(hit.start,hit.end),31)+marked.slice(hit.end);
console.log('① 原文（命中高亮）');console.log(marked);
console.log('\n② 脱敏后');console.log(result.text);
console.log('\n③ 命中表');
console.log('rule id | category | severity | token | start:end');
for(const h of result.hits)console.log(`${h.ruleId} | ${h.category} | ${h.severity} | ${h.token} | ${h.start}:${h.end}`);
console.log(`命中 ${result.stats.total} 项，其中高危 ${result.hits.filter(h=>h.severity==='high').length} 项，耗时 ${elapsed.toFixed(3)} ms`);
