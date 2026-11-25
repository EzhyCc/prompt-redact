#!/usr/bin/env node
// Minimal CLI for format-based local redaction; it does not claim universal coverage.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact, scan } from '../src/index.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const names=['contact','identity','credential','finance','network','semantic'];
const rules=names.flatMap(n=>JSON.parse(readFileSync(resolve(root,`rules/zh-CN/${n}.json`),'utf8')).rules);
const help=`prompt-redact — 本地格式信息脱敏工具
它只替换规则覆盖到的格式类信息。

用法：
  prompt-redact redact "文本"
  prompt-redact redact -f 文件路径
  prompt-redact scan "文本"
选项：
  --semantic      启用语义类规则
  --add 张三,李四  追加个人词表（逗号分隔）
  --json          输出 redact 完整返回值 JSON
  --quiet         只输出结果，不输出统计
  --help          显示帮助`;
const args=process.argv.slice(2);
if(args.includes('--help')||args.length===0){console.log(help);process.exit(0);}
const mode=args.shift();
if(!['redact','scan'].includes(mode)){console.error(help);process.exit(1);}
let input=args.find(a=>!a.startsWith('-'));
const fileIndex=args.indexOf('-f');
if(fileIndex>=0){const file=args[fileIndex+1];if(!file){console.error('缺少文件路径');process.exit(1);}try{input=readFileSync(file,'utf8');}catch(e){console.error('读取失败:',e.message);process.exit(1);}}
if(typeof input!=='string'){console.error('缺少文本参数或 -f 文件路径');process.exit(1);}
const semantic=args.includes('--semantic');
const addIndex=args.indexOf('--add');
const customTerms=addIndex>=0?(args[addIndex+1]||'').split(',').filter(Boolean):[];
if(mode==='scan'){
 const found=scan(input,rules.filter(r=>r.tier!=='semantic'||semantic));
 for(const h of found)console.log(`${h.ruleId} | ${h.category} | ${h.severity} | ${h.token} | ${h.start}:${h.end}`);
 process.exit(0);
}
const result=redact(input,{rules,enableSemantic:semantic,customTerms});
if(args.includes('--json'))console.log(JSON.stringify(result,null,2));
else console.log(result.text);
if(!args.includes('--quiet')&&!args.includes('--json'))console.error(`命中 ${result.stats.total} 项，残留高危 ${result.residuals.length} 项`);
process.exit(result.blocked?2:0);
