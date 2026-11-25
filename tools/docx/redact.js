// 纯 JS 的 docx 就地脱敏：解压 → 逐部件改文本 → 重新打包。
// 与 Python 版行为对齐：段落级匹配、run 级落笔、映射表同一步产出。

import { redact } from '../../src/index.js';
import { Session } from '../../src/session.js';
import { readZip } from '../extract/zip.js';
import { writeZip } from './zip-write.js';
import { applyEdits, encodeXml, scanDocument } from './xml.js';

/** 只处理这些部件；样式表、编号表、主题等跳过，避免破坏文档结构。 */
const INCLUDE = [
  'word/document.xml',
  'word/footnotes.xml',
  'word/endnotes.xml',
  'word/comments.xml',
  'docProps/core.xml',
  'docProps/app.xml'
];

const INCLUDE_PREFIX = ['word/header', 'word/footer'];

function wants(name) {
  return INCLUDE.includes(name) || INCLUDE_PREFIX.some(prefix => name.startsWith(prefix));
}

/**
 * 就地脱敏一份 docx。
 *
 * @param {Buffer} buffer 原始 docx
 * @param {object} options
 * @param {Array} options.rules 规则数组
 * @param {object} [options.terms] 词表 { 原文: 占位符名 }
 * @param {boolean} [options.enableSemantic]
 * @param {Session} [options.session] 复用已有会话（想跟其它文本共享占位符编号时传）
 * @returns {{ buffer: Buffer, tokens: object, stats: object }}
 */
export function redactDocxBuffer(buffer, options) {
  const { rules, terms = {}, enableSemantic = false } = options;
  const session = options.session ?? new Session({ maxEntries: 20000 });

  const entries = readZip(buffer);
  const stats = {
    parts: 0,
    paragraphs: 0,
    paragraphsChanged: 0,
    looseChanged: 0,
    attrsChanged: 0,
    occurrences: 0
  };

  const rewritten = new Map();

  for (const [name, data] of entries) {
    if (!wants(name)) {
      rewritten.set(name, data);
      continue;
    }

    stats.parts += 1;
    const xml = data.toString('utf8');
    const { paragraphs, looseTexts, authorAttrs } = scanDocument(xml);

    const texts = [
      ...paragraphs.map(p => p.texts.map(t => t.value).join('')),
      ...looseTexts.map(t => t.value),
      ...authorAttrs.map(a => a.value)
    ];

    const results = texts.map(text => (text.length > 0
      ? redact(text, { rules, session, enableSemantic, customTerms: terms })
      : { text, matches: [] }));

    const edits = [];
    let offset = 0;

    for (const paragraph of paragraphs) {
      const result = results[offset];
      offset += 1;
      stats.paragraphs += 1;
      const original = paragraph.texts.map(t => t.value).join('');
      if (result.text === original || !result.text) continue;

      stats.paragraphsChanged += 1;
      stats.occurrences += result.hits.length;

      // 段落级匹配、run 级落笔：第一段文字写新内容，其余清空
      paragraph.texts.forEach((textSpan, index) => {
        const value = index === 0 ? encodeXml(result.text) : '';
        edits.push({ start: textSpan.start, end: textSpan.end, text: value });
      });
    }

    for (const loose of looseTexts) {
      const result = results[offset];
      offset += 1;
      if (result.text === loose.value || !result.text) continue;
      stats.looseChanged += 1;
      stats.occurrences += result.hits.length;
      edits.push({ start: loose.start, end: loose.end, text: encodeXml(result.text) });
    }

    for (const attr of authorAttrs) {
      const result = results[offset];
      offset += 1;
      if (result.text === attr.value || !result.text) continue;
      stats.attrsChanged += 1;
      stats.occurrences += result.hits.length;
      edits.push({ start: attr.start, end: attr.end, text: encodeXml(result.text) });
    }

    rewritten.set(name, Buffer.from(edits.length ? applyEdits(xml, edits) : xml, 'utf8'));
  }

  return {
    buffer: writeZip(rewritten),
    tokens: Object.fromEntries(session.entries()),
    stats
  };
}

/**
 * 生成「系统内建 + 兜底机构名」的规则集。
 * 兜底规则会把 XX公司/医院/大学/研究院/集团 一律替换成 [机构]，用于词表列不全的场景。
 */
export function withOrgFallback(rules) {
  return [
    ...rules,
    {
      id: 'org-fallback',
      label: '机构',
      category: 'identity',
      tier: 'format',
      severity: 'medium',
      token: 'ORG',
      match: [{
        type: 'regex',
        pattern: '[\\u4e00-\\u9fa5A-Za-z0-9]{2,12}(?:股份有限公司|有限责任公司|有限公司|公司|医院|大学|研究院|集团)'
      }]
    }
  ];
}
