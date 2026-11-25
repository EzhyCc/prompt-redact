// 把 docx 能力注册成宿主工具，让模型能直接调用：
//   「把 D:\合同.docx 脱敏」→ redact_docx → 产出 -脱敏.docx 与 .map.json
//   「按模板 B 填内容」→ compose_docx → 产出成品
//
// 全部纯 JS，不需要 Python 或任何外部程序——这正是「装完插件就能用」的关键。
// 宿主没有 tools 能力、或 dsh-tools 不可用时，静默跳过，不影响插件其它功能。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

import { composeDocxBuffer } from '../tools/docx/compose.js';
import { redactDocxBuffer, withOrgFallback } from '../tools/docx/redact.js';

/** "词=标签,词2=标签2" 或 ['词', ...] → { 词: '标签' } */
export function toTermMap(input) {
  if (Array.isArray(input)) {
    return Object.fromEntries(input.filter(t => typeof t === 'string' && t).map(t => [t, '自定义词']));
  }
  const terms = {};
  for (const pair of String(input ?? '').split(/[,，]/)) {
    const item = pair.trim();
    if (!item) continue;
    const [value, label] = item.split('=').map(part => part.trim());
    if (value) terms[value] = label || '自定义词';
  }
  return terms;
}

/**
 * 注册 docx 相关工具。返回是否注册成功。
 *
 * @param {object} ctx cordis 上下文
 * @param {object} options
 * @param {Function} [options.defineTool] 测试时可注入；不传则动态 import '@deepseek-ai/dsh-tools'
 * @param {Function} options.getRules 返回当前规则数组
 * @param {Function} [options.getTerms] 返回插件配置里的词表
 */
export async function registerFileTools(ctx, options = {}) {
  if (!ctx?.tools?.register) return false;

  let defineTool = options.defineTool;
  if (!defineTool) {
    try {
      ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
    } catch {
      return false; // 宿主没提供这个包时，工具能力跳过
    }
  }

  const getRules = options.getRules ?? (() => []);
  const getTerms = options.getTerms ?? (() => []);

  const textOutput = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];

  ctx.tools.register(defineTool({
    name: 'redact_docx',
    description:
      '把一个本地 Word 文档就地脱敏：敏感内容替换成 [手机号]、[客户] 这类占位符，'
      + '格式（表格、页眉页脚、编号、字号）保持不变。'
      + '返回脱敏后文件的绝对路径和映射表路径；映射表含真实值，不要外发。',
    parameters: {
      path: { type: 'string', description: '待脱敏文档的绝对路径' },
      terms: { type: 'string', description: '可选。个人词表，形如 "某某科技=客户,张三=项目经理"', required: false },
      org: { type: 'boolean', description: '可选。把 XX公司/医院/大学/研究院/集团 一律替换成 [机构]', required: false }
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textOutput },
    async execute(args) {
      const source = String(args?.path ?? '');
      if (!source || !existsSync(source)) return { ok: false, error: `找不到文件：${source}` };

      const termMap = { ...toTermMap(getTerms()), ...toTermMap(args?.terms) };
      const rules = args?.org ? withOrgFallback(getRules()) : getRules();
      const base = basename(source, extname(source));
      const dir = dirname(source);

      const { buffer, tokens, stats } = redactDocxBuffer(readFileSync(source), { rules, terms: termMap });
      const redactedPath = join(dir, `${base}-脱敏.docx`);
      const mapPath = join(dir, `${base}.map.json`);
      writeFileSync(redactedPath, buffer);
      writeFileSync(mapPath, `${JSON.stringify({ tokens }, null, 2)}\n`, 'utf8');

      return {
        ok: true,
        redactedPath,
        mapPath,
        replaced: stats.occurrences,
        paragraphsChanged: stats.paragraphsChanged,
        note: '映射表含真实值，只留本地，不要交给模型或外发'
      };
    }
  }));

  ctx.tools.register(defineTool({
    name: 'compose_docx',
    description:
      '在一份已脱敏的 Word 模板上重建各章正文：保留标题、页眉页脚、表格、自动编号，'
      + '新段落继承模板原有正文字号。返回成品文件路径。',
    parameters: {
      base: { type: 'string', description: '脱敏后的模板 docx 绝对路径' },
      content: { type: 'string', description: 'JSON 字符串：{"章节名": ["段落1", "段落2"]}' },
      out: { type: 'string', description: '成品 docx 的输出绝对路径' }
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textOutput },
    async execute(args) {
      const base = String(args?.base ?? '');
      if (!base || !existsSync(base)) return { ok: false, error: `找不到模板：${base}` };

      let content;
      try {
        content = typeof args?.content === 'string' ? JSON.parse(args.content) : args?.content;
      } catch (error) {
        return { ok: false, error: `content 不是合法 JSON：${error.message}` };
      }
      if (!content || typeof content !== 'object') return { ok: false, error: 'content 必须是 { 章节名: [段落] }' };

      const { buffer, stats } = composeDocxBuffer(readFileSync(base), content);
      const out = String(args?.out ?? '');
      if (!out) return { ok: false, error: '缺少 out 参数（成品输出路径）' };
      writeFileSync(out, buffer);

      return { ok: true, out, chapters: stats.matched, removed: stats.removed, inserted: stats.inserted, missing: stats.missing };
    }
  }));

  return true;
}
