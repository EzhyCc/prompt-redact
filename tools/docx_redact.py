#!/usr/bin/env python
"""就地脱敏一份 docx，并在同一步写出回填映射表。

关键设计：**段落级匹配，run 级落笔**。
Word 会把一句话拆进多个 run（"某大学" + "某医院"），只按 run 替换会跨不过边界。
所以把每个段落的 w:t 拼成整串再脱敏；只有真的改动了，才把结果写进第一个 run、
其余 run 清空。段落样式、编号、页眉页脚都保留；代价是同段内的混排格式会被合并。

用法：
    python docx_redact.py --in 模板.docx --out 模板-脱敏.docx [--map 映射.json]
                          [--terms '{"圣格灵":"客户"}'] [--org]

不带 --map 时不写映射文件。
"""
import argparse
import json
import os
import subprocess
import sys

from docx import Document
from docx.oxml.ns import qn

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "redact-batch.mjs")


def find_node():
    """找 node 可执行文件：环境变量优先，其次 PATH。"""
    explicit = os.environ.get("PROMPT_REDACT_NODE")
    if explicit and os.path.exists(explicit):
        return explicit
    for candidate in (
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "DeepSeek Harness",
                     "resources", "runtime", "primary-runtime", "dependencies", "node", "bin", "node.exe"),
    ):
        if candidate and os.path.exists(candidate):
            return candidate
    return "node"


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


def nodes_of(paragraph):
    return list(paragraph.iter(qn("w:t")))


def text_of(paragraph):
    return "".join(node.text or "" for node in nodes_of(paragraph))


def main():
    parser = argparse.ArgumentParser(description="就地脱敏 docx（段落级匹配，格式不动）")
    parser.add_argument("--in", dest="source", required=True)
    parser.add_argument("--out", dest="target", required=True)
    parser.add_argument("--map", dest="map_path", default=None)
    parser.add_argument("--terms", dest="terms", default="{}")
    parser.add_argument("--org", action="store_true")
    args = parser.parse_args()

    try:
        terms = json.loads(args.terms)
    except json.JSONDecodeError as error:
        print(f"--terms 不是合法 JSON：{error}")
        return 1

    document = Document(args.source)
    paragraphs = collect_paragraph_elements(document)
    texts = [text_of(p) for p in paragraphs]

    payload = json.dumps({"texts": texts, "terms": terms, "org": args.org}, ensure_ascii=False)
    result = subprocess.run([find_node(), BRIDGE], input=payload.encode("utf-8"),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        print("脱敏引擎失败:", result.stderr.decode("utf-8", "replace")[:400])
        return 1

    data = json.loads(result.stdout.decode("utf-8"))

    rewritten = 0
    for paragraph, original, updated in zip(paragraphs, texts, data["texts"]):
        if updated == original or not updated:
            continue
        nodes = nodes_of(paragraph)
        if not nodes:
            continue
        nodes[0].text = updated
        for node in nodes[1:]:
            node.text = ""
        rewritten += 1

    document.save(args.target)

    if args.map_path:
        with open(args.map_path, "w", encoding="utf-8") as handle:
            json.dump({"tokens": data.get("tokens", {})}, handle, ensure_ascii=False, indent=2)
            handle.write("\n")

    print(f"段落 {len(paragraphs)} 个，改写 {rewritten} 个")
    print(f"输出: {args.target}")
    if args.map_path:
        print(f"映射: {args.map_path}（{len(data.get('tokens', {}))} 条，含真实值，只留本地）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
