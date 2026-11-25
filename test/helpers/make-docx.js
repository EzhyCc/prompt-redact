// 在纯 JS 里造一份最小但合法的 docx，供自测使用。
// 顺便验证 writeZip：这份 fixture 本身就是用同一个写入器打包出来的。

import { writeZip } from '../../tools/docx/zip-write.js';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

// 正文 12pt(24 半点)，标题 16pt(32 半点) —— 用字号验证「克隆底稿」是否生效
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal">
<w:name w:val="Normal"/><w:rPr><w:sz w:val="24"/></w:rPr>
</w:style>
<w:style w:type="paragraph" w:styleId="Heading1">
<w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>
</w:style>
<w:style w:type="paragraph" w:styleId="Heading5">
<w:name w:val="heading 5"/><w:pPr><w:outlineLvl w:val="4"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="21"/></w:rPr>
</w:style>
</w:styles>`;

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {object} spec
 * @param {Array<{text?:string, style?:'Heading1'|'Heading5'|string, author?:string, fontSize?:number}>} spec.paragraphs
 * @param {string} [spec.creator] docProps 里的作者
 */
export function makeDocx(spec) {
  const body = spec.paragraphs.map(item => {
    const pPr = item.style ? `<w:pPr><w:pStyle w:val="${item.style}"/></w:pPr>` : '';
    const rPr = item.fontSize ? `<w:rPr><w:sz w:val="${item.fontSize}"/></w:rPr>` : '';
    const run = `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(item.text ?? '')}</w:t></w:r>`;
    // 带 author 的段落用修订包裹，用来验证 w:author 属性脱敏
    const content = item.author ? `<w:ins w:id="1" w:author="${escapeXml(item.author)}">${run}</w:ins>` : run;
    return `<w:p>${pPr}${content}</w:p>`;
  }).join('');

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}><w:body>${body}<w:sectPr/></w:body></w:document>`;

  const creator = spec.creator
    ? `<dc:creator>${escapeXml(spec.creator)}</dc:creator><cp:lastModifiedBy>${escapeXml(spec.creator)}</cp:lastModifiedBy>`
    : '<dc:creator></dc:creator>';
  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">${creator}</cp:coreProperties>`;

  return writeZip(new Map([
    ['[Content_Types].xml', Buffer.from(CONTENT_TYPES, 'utf8')],
    ['_rels/.rels', Buffer.from(ROOT_RELS, 'utf8')],
    ['word/_rels/document.xml.rels', Buffer.from(DOC_RELS, 'utf8')],
    ['word/document.xml', Buffer.from(documentXml, 'utf8')],
    ['word/styles.xml', Buffer.from(STYLES, 'utf8')],
    ['docProps/core.xml', Buffer.from(coreXml, 'utf8')]
  ]));
}
