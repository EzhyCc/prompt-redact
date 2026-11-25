// 纯 JS 的 compose：在脱敏模板上重建各章正文。
// 与 Python 版行为对齐：保留 Heading 1 章节标题，删掉该章旧正文，
// 用该章原有正文段落做「格式底稿」克隆出新段落（字号、行距、缩进全部继承）。

import { readZip } from '../extract/zip.js';
import { writeZip } from './zip-write.js';
import { applyEdits, encodeXml, scanDocument } from './xml.js';

/** 去掉编号、空格、标点再比较——模板里的章节标题是自动编号，正文只有「项目简介」。 */
export function normalizeTitle(text) {
  return String(text).replace(/[\d\s.、．]/g, '');
}

/**
 * 从 styles.xml 解析 styleId → 样式名（小写）。
 * Word 内部名是 "heading 1"，中文版界面显示「标题 1」，这里统一按内部名判断。
 */
function readStyleNames(entries) {
  const data = entries.get('word/styles.xml');
  const map = new Map();
  if (!data) return map;

  const xml = data.toString('utf8');
  for (const match of xml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const [, styleId, body] = match;
    const nameMatch = /<w:name\b[^>]*w:val="([^"]+)"/.exec(body);
    map.set(styleId, (nameMatch?.[1] ?? '').toLowerCase());
  }
  return map;
}

/** 取段落自己的样式 id（不看继承，Office 文档里标题都写在 pPr 上）。 */
function paragraphStyleId(xml, paragraph) {
  const fragment = xml.slice(paragraph.start, Math.min(paragraph.end, paragraph.start + 2000));
  const match = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(fragment);
  return match?.[1] ?? '';
}

function isHeading(styleName, styleId) {
  return /^heading\s*\d+$/.test(styleName) || /^Heading\d+$/.test(styleId);
}

function isChapter(styleName, styleId) {
  return styleName === 'heading 1' || /^Heading1$/.test(styleId) || styleId === '1';
}

/** 把某个段落的文字整段替换掉：第一段文字写新内容，其余清空。 */
function setParagraphText(fragment, text) {
  const { paragraphs } = scanDocument(fragment);
  const target = paragraphs.find(item => item.texts.length > 0);
  if (!target) return fragment;

  const edits = target.texts.map((span, index) => ({
    start: span.start,
    end: span.end,
    text: index === 0 ? encodeXml(text) : ''
  }));
  return applyEdits(fragment, edits);
}

/** 去掉列表编号：内容里的（1）（2）是手写的，克隆过来的自动编号会重复。 */
function stripNumbering(fragment) {
  return fragment.replace(/<w:numPr>[\s\S]*?<\/w:numPr>/g, '');
}

/**
 * 在脱敏模板上重建各章正文。
 *
 * @param {Buffer} buffer 脱敏后的模板 docx
 * @param {Record<string, string[]>} content 章节名 → 段落数组
 * @returns {{ buffer: Buffer, stats: object }}
 */
export function composeDocxBuffer(buffer, content) {
  const entries = readZip(buffer);
  const documentXml = entries.get('word/document.xml');
  if (!documentXml) throw new Error('这个文件里没有 word/document.xml，可能不是 docx');

  const styleNames = readStyleNames(entries);
  const xml = documentXml.toString('utf8');
  const { paragraphs } = scanDocument(xml);

  // 给每个段落标注样式，并找出章节边界
  const annotated = paragraphs.map(paragraph => {
    const styleId = paragraphStyleId(xml, paragraph);
    const styleName = styleNames.get(styleId) ?? '';
    return { ...paragraph, styleId, styleName };
  });

  const bodyText = paragraph => paragraph.texts.map(t => t.value).join('');

  const chapters = [];
  annotated.forEach((paragraph, index) => {
    if (!isChapter(paragraph.styleName, paragraph.styleId)) return;
    const title = normalizeTitle(bodyText(paragraph));
    const key = Object.keys(content).find(name => normalizeTitle(name) === title);
    if (!key) return;

    const body = [];
    for (let cursor = index + 1; cursor < annotated.length; cursor += 1) {
      const next = annotated[cursor];
      if (isChapter(next.styleName, next.styleId)) break;
      body.push(next);
    }
    chapters.push({ key, heading: paragraph, body });
  });

  const matched = chapters.map(item => item.key);
  const missing = Object.keys(content).filter(name => !matched.includes(name));

  // 没有正文段落的章节，借用全文第一个正文段落当格式底稿
  const globalDonor = annotated.find(p => !isHeading(p.styleName, p.styleId) && bodyText(p).trim());
  if (!globalDonor) throw new Error('模板里找不到任何正文段落，无法确定格式底稿');

  const edits = [];
  let removed = 0;
  let inserted = 0;

  for (const chapter of chapters) {
    const donor = chapter.body.find(p => !isHeading(p.styleName, p.styleId) && bodyText(p).trim()) ?? globalDonor;
    const donorXml = stripNumbering(xml.slice(donor.start, donor.end));

    // 删掉旧正文
    for (const paragraph of chapter.body) {
      edits.push({ start: paragraph.start, end: paragraph.end, text: '' });
      removed += 1;
    }

    // 在标题后面插入新段落
    const blocks = (content[chapter.key] ?? [])
      .map(line => setParagraphText(donorXml, line))
      .join('');
    edits.push({ start: chapter.heading.end, end: chapter.heading.end, text: blocks });
    inserted += (content[chapter.key] ?? []).length;
  }

  entries.set('word/document.xml', Buffer.from(applyEdits(xml, edits), 'utf8'));

  return {
    buffer: writeZip(entries),
    stats: { chapters: chapters.length, matched, missing, removed, inserted }
  };
}
