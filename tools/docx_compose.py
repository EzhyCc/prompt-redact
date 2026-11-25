#!/usr/bin/env python
"""在【已脱敏的模板 docx】上重建各章正文，产出成品。

章节级重建 + 段落级克隆：
- 保留所有 Heading 1 标题（自动编号、目录引用都不动）
- 删掉该章原有正文段落，再用该章原有正文段落做「格式底稿」克隆出新段落
  —— 这样字号、行距、缩进、首行缩进都跟模板正文一模一样，不靠样式名去猜
- 模板该章若没有正文段落，就借用全文第一个正文段落当底稿

用法：
    python docx_compose.py --base 模板-脱敏.docx --content 内容.json --out 成品.docx
"""
import argparse
import json
import os
import sys
from copy import deepcopy

from docx import Document
from docx.text.paragraph import Paragraph


def norm(text):
    """去掉编号、空格、标点再比较——模板里的章节标题是自动编号，正文只有「项目简介」。"""
    return "".join(ch for ch in text if not ch.isdigit() and ch not in " .、．")


def is_chapter(paragraph):
    """只有 Heading 1 才算章节边界；Heading 2/5 是章节内部的小标题。"""
    return paragraph.style is not None and paragraph.style.name == "Heading 1"


def is_heading(paragraph):
    return paragraph.style is not None and paragraph.style.name.startswith("Heading")


def is_body(paragraph):
    """正文段落：不是任何级别的标题，且有文字。Heading 2/5 是章节内小标题，不能当正文底稿。"""
    return not is_heading(paragraph) and paragraph.text.strip() != ""


def clone_with_text(donor, text, parent):
    """照抄 donor 段落的全部格式，只把文字换掉。"""
    element = deepcopy(donor._p)
    paragraph = Paragraph(element, parent)

    # 去掉列表编号：内容里的（1）（2）是手写的，克隆过来的自动编号会造成重复
    pPr = element.pPr
    if pPr is not None and pPr.numPr is not None:
        pPr.remove(pPr.numPr)

    if paragraph.runs:
        paragraph.runs[0].text = text
        for run in paragraph.runs[1:]:
            run.text = ""
    else:
        paragraph.add_run(text)
    return paragraph


def main():
    parser = argparse.ArgumentParser(description="在脱敏模板上填充内容，产出成品 docx")
    parser.add_argument("--base", required=True, help="脱敏后的模板 docx")
    parser.add_argument("--content", required=True, help="内容 JSON")
    parser.add_argument("--out", required=True, help="成品 docx 路径")
    args = parser.parse_args()

    with open(args.content, "r", encoding="utf-8") as handle:
        content = json.load(handle)

    if not os.path.exists(args.base):
        print(f"找不到基底模板：{args.base}")
        return 1

    document = Document(args.base)
    paragraphs = document.paragraphs

    # 全文兜底底稿：第一个有文字的正文段落
    global_donor = next((p for p in paragraphs if is_body(p)), None)
    if global_donor is None:
        print("模板里找不到任何正文段落，无法确定格式底稿")
        return 1

    # 1) 定位目标章节，收集其下直到下一个 Heading 1 的所有段落
    targets = {}
    for index, paragraph in enumerate(paragraphs):
        if not is_chapter(paragraph):
            continue
        key = next((name for name in content if norm(name) == norm(paragraph.text)), None)
        if not key:
            continue
        body = []
        cursor = index + 1
        while cursor < len(paragraphs) and not is_chapter(paragraphs[cursor]):
            body.append(paragraphs[cursor])
            cursor += 1
        targets[key] = (paragraph, body)

    matched = sorted(targets)
    missing = [name for name in content if name not in targets]
    print(f"匹配到章节 {len(targets)}/{len(content)}：{'、'.join(matched)}")
    if missing:
        print(f"警告：模板里找不到同名标题，已跳过：{'、'.join(missing)}")

    # 2) 每章：先挑格式底稿，再删旧正文，最后克隆插入
    removed = 0
    inserted = 0
    donors = {}
    for key, (heading, body) in targets.items():
        # 格式底稿优先用本章自己的正文段落，保证和原文同字号
        donor = next((p for p in body if is_body(p)), global_donor)
        donors[key] = donor

        keep_blank = len(body) > 1
        first = True
        anchor = heading
        for paragraph in body:
            if keep_blank and first and not paragraph.text.strip():
                first = False
                anchor = paragraph
                continue
            paragraph._element.getparent().remove(paragraph._element)
            removed += 1

        for line in content[key]:
            new_paragraph = clone_with_text(donor, line, heading._parent)
            anchor._element.addnext(new_paragraph._element)
            anchor = new_paragraph
            inserted += 1

    document.save(args.out)

    print(f"删除段落 {removed}，插入段落 {inserted}")
    for key, donor in donors.items():
        size = donor.style.font.size.pt if donor.style.font.size else None
        run_size = donor.runs[0].font.size.pt if donor.runs and donor.runs[0].font.size else None
        print(f"  格式底稿 | {key:<8} 样式={donor.style.name:<24} 样式字号={size} run字号={run_size}")
    print(f"成品: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
