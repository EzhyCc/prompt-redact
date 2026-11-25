// 最小 XML 扫描器：只做 Office 文档需要的事——按标签栈定位元素、取属性、取文本。
//
// 为什么不用正则：docx 里段落可以嵌套（文本框里的段落套在正文段落里），
// 正则匹配 <w:p>…</w:p> 会在嵌套处断在错误的位置。这里维护一个标签栈，
// 一切判断都基于「当前栈里有没有某个标签」，不用 id(element) —— lxml 的教训。

const NAME_PATTERN = /^[A-Za-z0-9_:.-]+/;

/**
 * 把 XML 切成标签与文本。
 * @param {string} xml
 * @returns {Generator<{kind:'open'|'close'|'empty'|'text', name?:string, raw?:string, start:number, end:number}>}
 */
export function* tokenize(xml) {
  let cursor = 0;
  const length = xml.length;

  while (cursor < length) {
    const lt = xml.indexOf('<', cursor);
    if (lt === -1) {
      if (cursor < length) yield { kind: 'text', start: cursor, end: length };
      return;
    }
    if (lt > cursor) yield { kind: 'text', start: cursor, end: lt };

    // 注释 / CDATA / 处理指令 / DOCTYPE：整体跳过，不当文本
    if (xml.startsWith('<!--', lt)) {
      const close = xml.indexOf('-->', lt + 4);
      cursor = close === -1 ? length : close + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const close = xml.indexOf(']]>', lt + 9);
      cursor = close === -1 ? length : close + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const close = xml.indexOf('>', lt);
      cursor = close === -1 ? length : close + 1;
      continue;
    }

    const gt = xml.indexOf('>', lt);
    if (gt === -1) return; // 截断的尾巴，放弃

    const raw = xml.slice(lt, gt + 1);
    const inner = raw.slice(1, -1);
    const isClose = inner.startsWith('/');
    const isSelfClosing = !isClose && inner.endsWith('/');

    const nameSource = isClose ? inner.slice(1) : inner;
    const match = NAME_PATTERN.exec(nameSource.trim());
    const name = match ? match[0] : '';

    yield {
      kind: isClose ? 'close' : isSelfClosing ? 'empty' : 'open',
      name,
      raw,
      start: lt,
      end: gt + 1
    };
    cursor = gt + 1;
  }
}

const ENTITIES = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]
]);

/** 解开 XML 实体。 */
export function decodeXml(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES.get(body) ?? whole;
  });
}

/** 转义回 XML 文本。只处理必须转义的三个字符，引号在文本里不需要转。 */
export function encodeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 一遍扫完一个 XML 部件，取出脱敏需要的东西。
 *
 * @param {string} xml
 * @returns {{
 *   paragraphs: Array<{start:number, end:number, texts:Array<{start:number,end:number,value:string}>}>,
 *   looseTexts: Array<{start:number, end:number, value:string}>,
 *   authorAttrs: Array<{start:number, end:number, name:string, value:string}>
 * }}
 */
export function scanDocument(xml) {
  const paragraphs = [];
  const looseTexts = [];
  const authorAttrs = [];

  /** 标签栈：元素记的是 { name, start }，段落开口位置用来归属 w:t。 */
  const stack = [];
  /** 段落开口位置 → 段落对象。 */
  const openParagraphs = new Map();

  for (const token of tokenize(xml)) {
    if (token.kind === 'open') {
      if (token.name === 'w:p') {
        const paragraph = { start: token.start, end: -1, texts: [] };
        paragraphs.push(paragraph);
        openParagraphs.set(token.start, paragraph);
      }
      collectAuthorAttrs(token, authorAttrs);
      stack.push({ name: token.name, start: token.start });
      continue;
    }

    if (token.kind === 'empty') {
      collectAuthorAttrs(token, authorAttrs);
      continue;
    }

    if (token.kind === 'close') {
      // 弹到同名标签为止（容忍不配对的脏 XML）
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].name === token.name) {
          const [popped] = stack.splice(index, 1);
          if (token.name === 'w:p' && popped) {
            const paragraph = openParagraphs.get(popped.start);
            if (paragraph && paragraph.end === -1) paragraph.end = token.end;
          }
          break;
        }
      }
      continue;
    }

    // 文本
    const value = decodeXml(xml.slice(token.start, token.end));
    if (!value) continue;

    if (stack.some(entry => entry.name === 'w:t')) {
      const owner = [...stack].reverse().find(entry => entry.name === 'w:p');
      const paragraph = owner ? openParagraphs.get(owner.start) : null;
      if (paragraph) {
        paragraph.texts.push({ start: token.start, end: token.end, value });
        continue;
      }
    }
    if (stack.some(entry => entry.name === 'w:p')) continue; // 段落里的非 w:t 文本交给段落

    looseTexts.push({ start: token.start, end: token.end, value });
  }

  // 没收尾的段落给个保守的结束位置
  for (const paragraph of paragraphs) {
    if (paragraph.end === -1) paragraph.end = xml.length;
  }

  return { paragraphs, looseTexts, authorAttrs };
}

function collectAuthorAttrs(token, out) {
  const raw = token.raw;
  for (const name of ['w:author', 'w:initials']) {
    const pattern = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'g');
    let match;
    while ((match = pattern.exec(raw)) !== null) {
      const valueStart = token.start + match.index + match[0].indexOf('"') + 1;
      out.push({
        start: valueStart,
        end: valueStart + match[1].length,
        name,
        value: decodeXml(match[1])
      });
    }
  }
}

/** 按位置从后往前替换，避免前面的改动影响后面的下标。 */
export function applyEdits(xml, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let output = xml;
  for (const edit of sorted) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  return output;
}
