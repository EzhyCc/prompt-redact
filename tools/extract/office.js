// 从 docx / xlsx / pptx 里抽出可读文本。只读取，不写回。
// 目标不是还原格式，是让模型能看到「内容」，所以输出是纯文本。
import { readZip } from './zip.js';

const XML_ENTITIES = new Map([
  ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&apos;', "'"]
]);

function unescapeXml(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => XML_ENTITIES.get(`&${name};`));
}

/** docx：按段落切行，段落内的 <w:t> 拼接。 */
function extractDocx(zip) {
  const xml = zip.get('word/document.xml');
  if (!xml) throw new Error('docx 里没有 word/document.xml');
  const text = xml.toString('utf8');

  // 表格里的单元格也要能分出来，先把 </w:tc> 变成制表符
  const withCells = text
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n');

  const chunks = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|([\n\t])/g;
  let match;
  while ((match = re.exec(withCells)) !== null) {
    chunks.push(match[1] !== undefined ? unescapeXml(match[1]) : match[2]);
  }

  return chunks.join('').replace(/\t+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** xlsx：共享字符串 + 每个工作表，按行输出为制表符分隔的文本。 */
function extractXlsx(zip) {
  const shared = [];
  const sharedXml = zip.get('xl/sharedStrings.xml');
  if (sharedXml) {
    const text = sharedXml.toString('utf8');
    for (const si of text.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const parts = [...si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => unescapeXml(m[1]));
      shared.push(parts.join(''));
    }
  }

  const sheets = [...zip.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort();
  if (sheets.length === 0) throw new Error('xlsx 里没有工作表');

  const out = [];
  for (const sheet of sheets) {
    out.push(`--- ${sheet.replace('xl/worksheets/', '').replace('.xml', '')} ---`);
    const xml = zip.get(sheet).toString('utf8');
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cell of row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cell[1];
        const body = cell[2];
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (type === 's') {
          cells.push(shared[Number(value)] ?? '');
        } else if (type === 'inlineStr') {
          const inline = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => unescapeXml(m[1])).join('');
          cells.push(inline);
        } else if (value !== undefined) {
          cells.push(unescapeXml(value));
        } else {
          cells.push('');
        }
      }
      if (cells.some(c => c !== '')) out.push(cells.join('\t'));
    }
    out.push('');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** pptx：按幻灯片拆页，每页的 <a:t> 拼成行。 */
function extractPptx(zip) {
  const slides = [...zip.keys()].filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]));
  if (slides.length === 0) throw new Error('pptx 里没有幻灯片');

  const out = [];
  for (const slide of slides) {
    out.push(`--- slide ${/\d+/.exec(slide)[0]} ---`);
    const xml = zip.get(slide).toString('utf8');
    const lines = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => unescapeXml(m[1]));
    out.push(...lines);
    out.push('');
  }
  return out.join('\n').trim();
}

/**
 * 按扩展名从 Office 文档里抽文本。
 * @param {Buffer} buffer
 * @param {string} ext 含点的小写扩展名
 * @returns {string}
 */
export function extractOfficeText(buffer, ext) {
  const zip = readZip(buffer);
  if (ext === '.docx') return extractDocx(zip);
  if (ext === '.xlsx') return extractXlsx(zip);
  if (ext === '.pptx') return extractPptx(zip);
  throw new Error(`不支持的扩展名：${ext}`);
}
