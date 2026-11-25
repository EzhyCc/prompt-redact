#!/usr/bin/env python
"""就地脱敏一份 docx，并在同一步写出回填映射表。

覆盖范围（这是重点，早期版本只遍历正文+页眉页脚，脚注/修订/属性全漏）：
  · word/document.xml            正文、表格、文本框、修订内容
  · word/header*.xml             全部页眉（不是只有第 1 个）
  · word/footer*.xml             全部页脚
  · word/footnotes.xml           脚注
  · word/endnotes.xml            尾注
  · word/comments.xml            批注正文
  · docProps/core.xml            标题、作者、最后修改者
  · docProps/app.xml             公司、管理器
  · w:author / w:initials 属性    修订记录的作者名与缩写
  · w:comment/@w:author          批注作者

关键设计：**段落级匹配，run 级落笔**。
Word 会把一句话拆进多个 run（"某大学" + "某医院"），只按 run 替换会跨不过边界。
所以把每个段落的 w:t 拼成整串再脱敏；只有真的改动了，才把结果写进第一个 run、
其余 run 清空。段落样式、编号、页眉页脚都保留；代价是同段内混排格式会被合并。

用法：
    python docx_redact.py --in 模板.docx --out 模板-脱敏.docx [--map 映射.json]
                          [--terms '{"圣格灵":"客户"}'] [--org]
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

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# 只处理这些部件；样式表、编号表、主题等跳过，避免破坏文档结构
INCLUDE = (
    "document.xml",
    "header",
    "footer",
    "footnotes.xml",
    "endnotes.xml",
    "comments.xml",
    "docProps/core.xml",
    "docProps/app.xml",
)

# 这些属性里可能写着人名
AUTHOR_ATTRS = (f"{W}author", f"{W}initials")


def find_node():
    explicit = os.environ.get("PROMPT_REDACT_NODE")
    if explicit and os.path.exists(explicit):
        return explicit
    candidate = os.path.join(
        os.environ.get("LOCALAPPDATA", ""), "Programs", "DeepSeek Harness",
        "resources", "runtime", "primary-runtime", "dependencies", "node", "bin", "node.exe",
    )
    return candidate if os.path.exists(candidate) else "node"


def wanted(part):
    name = str(part.partname)
    return any(token in name for token in INCLUDE)


def collect_units(document):
    """把整份文档拆成可脱敏单元。

    返回三类：
      paragraphs  段落级：整段拼串再脱敏，写回第一个 w:t
      nodes       散文本节点：元素自身的 .text（如 docProps 里的作者）
      attrs       属性：修订作者、批注作者

    注意：不要用 id(element) 去重或判断祖先——lxml 每次遍历返回的是新的代理对象，
    id 不稳定，判断会时灵时不灵。一律按标签判断。
    """
    paragraphs, nodes, attrs = [], [], []

    for part in document.part.package.parts:
        element = getattr(part, "_element", None)
        if element is None or not wanted(part):
            continue

        # 1) 段落级：w:p 内部的文字整段拼起来脱敏，能跨 run 匹配
        paragraphs.extend(element.iter(f"{W}p"))

        # 2) 散落文本：只取叶子节点，且祖先里没有 w:p / w:t
        for node in element.iter():
            if not isinstance(node.tag, str):
                continue
            if node.tag in (f"{W}p", f"{W}t"):
                continue
            if len(node) != 0:
                continue  # 有子元素的不是文本叶子
            if not node.text or not node.text.strip():
                continue
            if has_paragraph_ancestor(node):
                continue  # 已由段落级处理
            nodes.append(node)

        # 3) 属性里的作者名
        for node in element.iter():
            if not isinstance(node.tag, str):
                continue
            for attr in AUTHOR_ATTRS:
                value = node.get(attr)
                if value:
                    attrs.append((node, attr))

    return paragraphs, nodes, attrs


def has_paragraph_ancestor(node):
    parent = node.getparent()
    while parent is not None:
        if parent.tag == f"{W}p":
            return True
        parent = parent.getparent()
    return False


def paragraph_text(paragraph):
    return "".join(node.text or "" for node in paragraph.iter(f"{W}t"))


def main():
    parser = argparse.ArgumentParser(description="就地脱敏 docx（覆盖正文/页眉页脚/脚注/批注/文档属性/修订作者）")
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
    paragraphs, nodes, attrs = collect_units(document)

    texts = (
        [paragraph_text(p) for p in paragraphs]
        + [node.text or "" for node in nodes]
        + [node.get(attr) or "" for node, attr in attrs]
    )

    payload = json.dumps({"texts": texts, "terms": terms, "org": args.org}, ensure_ascii=False)
    result = subprocess.run([find_node(), BRIDGE], input=payload.encode("utf-8"),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        print("脱敏引擎失败:", result.stderr.decode("utf-8", "replace")[:400])
        return 1

    data = json.loads(result.stdout.decode("utf-8"))
    updated = data["texts"]

    offset = 0
    changed_paragraphs = 0
    for paragraph in paragraphs:
        original, new = texts[offset], updated[offset]
        offset += 1
        if new == original or not new:
            continue
        nodes_in_paragraph = list(paragraph.iter(f"{W}t"))
        if not nodes_in_paragraph:
            continue
        nodes_in_paragraph[0].text = new
        for node in nodes_in_paragraph[1:]:
            node.text = ""
        changed_paragraphs += 1

    changed_nodes = 0
    for node in nodes:
        original, new = texts[offset], updated[offset]
        offset += 1
        if new != original and new:
            node.text = new
            changed_nodes += 1

    changed_attrs = 0
    for node, attr in attrs:
        original, new = texts[offset], updated[offset]
        offset += 1
        if new != original and new:
            node.set(attr, new)
            changed_attrs += 1

    document.save(args.target)

    if args.map_path:
        with open(args.map_path, "w", encoding="utf-8") as handle:
            json.dump({"tokens": data.get("tokens", {})}, handle, ensure_ascii=False, indent=2)
            handle.write("\n")

    print(
        f"段落 {len(paragraphs)}（改写 {changed_paragraphs}）"
        f" | 文本节点 {len(nodes)}（改写 {changed_nodes}）"
        f" | 作者属性 {len(attrs)}（改写 {changed_attrs}）"
    )
    print(f"输出: {args.target}")
    if args.map_path:
        print(f"映射: {args.map_path}（{len(data.get('tokens', {}))} 条，含真实值，只留本地）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
