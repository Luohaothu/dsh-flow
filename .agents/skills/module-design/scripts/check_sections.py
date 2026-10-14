#!/usr/bin/env python3
"""Check the top-level body sections of a module design proposal."""
import argparse
from html.parser import HTMLParser
from pathlib import Path
import re

DEFAULT_SECTIONS = [
    "问题分析", "概念设计/架构设计", "接口设计", "伪代码实现/应用实现", "实施安排",
]


class HTMLSections(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_main = False
        self.saw_main = False
        self.in_heading = False
        self.buffer = []
        self.headings = []

    def handle_starttag(self, tag, attrs):
        if tag == "main":
            self.in_main = self.saw_main = True
        if tag == "h2" and self.in_main:
            self.in_heading = True
            self.buffer = []

    def handle_data(self, data):
        if self.in_heading:
            self.buffer.append(data)

    def handle_endtag(self, tag):
        if tag == "h2" and self.in_heading:
            self.headings.append("".join(self.buffer).strip())
            self.in_heading = False
        if tag == "main":
            self.in_main = False


def markdown_sections(text):
    headings = []
    fence = None
    for line in text.splitlines():
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if marker:
            token, rest = marker.groups()
            if fence is None:
                fence = (token[0], len(token))
            elif token[0] == fence[0] and len(token) >= fence[1] and not rest.strip():
                fence = None
            continue
        if fence:
            continue
        heading = re.match(r"^ {0,3}##[ \t]+(.+?)\s*$", line)
        if heading:
            headings.append(re.sub(r"[ \t]+#+[ \t]*$", "", heading.group(1)).strip())
    return headings


def validate(path, expected):
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() in {".html", ".htm"}:
        parser = HTMLSections()
        parser.feed(text)
        if not parser.saw_main:
            raise ValueError("HTML 方案需要 main 正文容器")
        headings = parser.headings
    elif path.suffix.lower() in {".md", ".markdown"}:
        headings = markdown_sections(text)
    else:
        raise ValueError("方案文件应为 Markdown 或 HTML")
    if headings != expected:
        raise ValueError(f"章节或顺序不符\n期望：{expected}\n实际：{headings}")
    return headings


def main():
    parser = argparse.ArgumentParser(description="校验模块设计方案的正文一级章节")
    parser.add_argument("path", type=Path)
    parser.add_argument("--sections", nargs="+", default=DEFAULT_SECTIONS)
    args = parser.parse_args()
    try:
        headings = validate(args.path, args.sections)
    except (OSError, ValueError) as error:
        parser.exit(1, f"校验失败：{error}\n")
    print(f"校验通过：{len(headings)} 个章节，顺序正确")


if __name__ == "__main__":
    main()
