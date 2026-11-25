// 最小 ZIP 读取器：只做「列出条目 + 取出解压后的内容」，够解析 docx/xlsx 用。
// 不写 zip、不支持加密、不支持 zip64（Office 文档基本用不到）。
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** 从尾部往前找中央目录结束记录（EOCD 后面最多带 65535 字节注释）。 */
function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  for (let at = buffer.length - 22; at >= min; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIG) return at;
  }
  throw new Error('不是有效的 ZIP：找不到中央目录结束记录');
}

/**
 * 读取 zip 里的全部条目。
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>} 条目名 → 解压后的内容
 */
export function readZip(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  const entries = new Map();
  let cursor = directoryOffset;

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CEN_SIG) break;

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    // 有些 zip 生成器（例如 PowerShell 的 Compress-Archive）用反斜杠做分隔符，
    // 真实 Office 文件用正斜杠。统一成正斜杠再判断。
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8').replace(/\\/g, '/');

    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue; // 目录条目

    // 不在这里按目录过滤：抽文本的调用方自己按名字取，但「核查整包是否干净」需要看到
    // docProps/、customXml/、_rels/ 这些部件——早期在这里过滤，导致文档属性里的作者名
    // 从来没被检查过。

    if (buffer.readUInt32LE(localOffset) !== LOC_SIG) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    try {
      entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    } catch {
      /* 单个条目坏了就跳过，不影响其它部分 */
    }
  }

  return entries;
}
