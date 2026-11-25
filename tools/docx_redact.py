#!/usr/bin/env python
"""就地脱敏一份 docx，格式尽量不动。

关键设计：**段落级匹配，run 级落笔**。
Word 会把一句话拆进多个 run（"南方医科大学" + "深圳医院"），只按 run 替换会跨不过边界。
所以这里把每个段落的 w:t 拼成整串再脱敏；只有真的改动了，才把结果写进第一个 run、
其余 run 清空。段落样式、行距、缩进、编号、页眉页脚都保留；同段内的混排格式（比如句中加粗）
会在该段被合并——这是为了正确性做的取舍。

用法：
    python docx_redact.py <输入.docx> <输出.docx> [词表JSON] [--org]
"""
import json
import os
import subprocess
import sys

from docx import Document
from docx.oxml.ns import qn

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, ".."))
BRIDGE = os.path.join(PROJECT, "tools", "redact-batch.mjs")
NODE = os.path.join(
    os.environ.get("LOCALAPPDATA", ""),
    "Programs", "DeepSeek Harness", "resources", "runtime",
    "primary-runtime", "dependencies", "node", "bin", "node.exe",
)


def collect_paragraph_elements(document):
    """所有段落元素：正文 + 表格 + 文本框 + 页眉 + 页脚。"""
    roots = [document.element.body]
    for section in document.sections:
        for part in (section.header, section.footer,
                     section.first_page_header, section.first_page_footer,
                     section.even_page_header, section.even_page_footer):
            try:
                if part is not None and not part.is_linked_to_previous:
                    roots.append(part._element)
            except Exception:
                continue

    paragraphs = []
    seen = set()
    for root in roots:
        for paragraph in root.iter(qn("w:p")):
            if id(paragraph) in seen:
                continue
            seen.add(id(paragraph))
            paragraphs.append(paragraph)
    return paragraphs


def paragraph_text_nodes(paragraph):
    return [node for node in paragraph.iter(qn("w:t"))]


def paragraph_text(paragraph):
    return "".join(node.text or "" for node in paragraph_text_nodes(paragraph))


def main():
    if len(sys.argv) < 3:
        print("用法: python docx_redact.py <输入.docx> <输出.docx> [词表JSON] [--org]")
        return 1

    source, target = sys.argv[1], sys.argv[2]
    terms = {}
    org = False
    for arg in sys.argv[3:]:
        if arg == "--org":
            org = True
        else:
            terms = json.loads(arg)

    document = Document(source)
    paragraphs = collect_paragraph_elements(document)
    texts = [paragraph_text(p) for p in paragraphs]

    payload = json.dumps({"texts": texts, "terms": terms, "org": org}, ensure_ascii=False)
    result = subprocess.run([NODE, BRIDGE], input=payload.encode("utf-8"),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        print("脱敏桥失败:", result.stderr.decode("utf-8", "replace")[:400])
        return 1

    data = json.loads(result.stdout.decode("utf-8"))

    rewritten = 0
    for paragraph, original, updated in zip(paragraphs, texts, data["texts"]):
        if updated == original or not updated:
            continue
        nodes = paragraph_text_nodes(paragraph)
        if not nodes:
            continue
        nodes[0].text = updated
        for node in nodes[1:]:
            node.text = ""
        rewritten += 1

    document.save(target)
    print(f"段落 {len(paragraphs)} 个，改写 {rewritten} 个")
    print(f"已保存: {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
