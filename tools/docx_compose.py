#!/usr/bin/env python
"""在【已脱敏的模板 docx】上重建各章正文，产出成品。

章节级重建而不是逐段替换：模板的正文常是自动编号列表项，逐段对应会错位、还会留空编号。
这里保留所有 Heading 1 标题（自动编号、目录引用都不动），删掉该章原有正文段落，
再按正文样式插入新段落。

用法：
    python docx_compose.py --base 模板-脱敏.docx --content 内容.json --out 成品.docx
                          [--style "Body Text First Indent"]

内容 JSON 结构：
    { "项目简介": ["第一段", "第二段"], "初验目的": ["..."] }
章节名按「去掉编号和空格」后比对，所以 "1 项目简介" 和 "项目简介" 都能匹配。
"""
import argparse
import json
import os
import sys

from docx import Document

DEFAULT_STYLE = "Body Text First Indent"


def norm(text):
    """去掉编号、空格、标点再比较——模板里的章节标题是自动编号，正文只有「项目简介」。"""
    return "".join(ch for ch in text if not ch.isdigit() and ch not in " .、．")


def is_chapter(paragraph):
    """只有 Heading 1 才算章节边界；Heading 2/5 是章节内部的小标题。"""
    return paragraph.style is not None and paragraph.style.name == "Heading 1"


def main():
    parser = argparse.ArgumentParser(description="在脱敏模板上填充内容，产出成品 docx")
    parser.add_argument("--base", required=True, help="脱敏后的模板 docx")
    parser.add_argument("--content", required=True, help="内容 JSON")
    parser.add_argument("--out", required=True, help="成品 docx 路径")
    parser.add_argument("--style", default=DEFAULT_STYLE, help="正文段落样式名")
    args = parser.parse_args()

    with open(args.content, "r", encoding="utf-8") as handle:
        content = json.load(handle)

    if not os.path.exists(args.base):
        print(f"找不到基底模板：{args.base}")
        return 1

    document = Document(args.base)
    available = {style.name for style in document.styles}
    style_name = args.style if args.style in available else "Normal"
    if style_name != args.style:
        print(f"提示：样式「{args.style}」不存在，改用 Normal")

    # 1) 定位每个目标章节，收集它下面直到下一个 Heading 1 的所有段落
    paragraphs = document.paragraphs
    targets = {}
    for index, paragraph in enumerate(paragraphs):
        if not is_chapter(paragraph):
            continue
        key = next((name for name in content if norm(name) == norm(paragraph.text)), None)
        if not key:
            continue
        body_paragraphs = []
        cursor = index + 1
        while cursor < len(paragraphs) and not is_chapter(paragraphs[cursor]):
            body_paragraphs.append(paragraphs[cursor])
            cursor += 1
        targets[key] = (paragraph, body_paragraphs)

    matched = sorted(targets)
    missing = [name for name in content if name not in targets]
    print(f"匹配到章节 {len(targets)}/{len(content)}：{'、'.join(matched)}")
    if missing:
        print(f"警告：这些章节在模板里找不到同名标题，已跳过：{'、'.join(missing)}")

    # 2) 删除原正文段落（连带清掉自动编号），再按内容插入新段落
    removed = 0
    inserted = 0
    for key, (heading, body_paragraphs) in targets.items():
        # 留一个空段落当间距，避免标题和正文贴太紧
        keep_blank = len(body_paragraphs) > 1
        first = True
        anchor = heading
        for paragraph in body_paragraphs:
            if keep_blank and first and not paragraph.text.strip():
                first = False
                anchor = paragraph
                continue
            paragraph._element.getparent().remove(paragraph._element)
            removed += 1

        for line in content[key]:
            new_paragraph = document.add_paragraph(line, style=style_name)
            anchor._element.addnext(new_paragraph._element)
            anchor = new_paragraph
            inserted += 1

    document.save(args.out)
    print(f"删除段落 {removed}，插入段落 {inserted}")
    print(f"成品: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
