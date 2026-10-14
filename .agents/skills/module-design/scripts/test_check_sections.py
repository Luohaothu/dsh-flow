"""Behavioral tests for proposal section validation; uses only the standard library."""
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from check_sections import DEFAULT_SECTIONS, validate


class SectionValidationTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def proposal(self, suffix, text):
        path = self.root / f"proposal{suffix}"
        path.write_text(text, encoding="utf-8")
        return path

    def markdown(self, sections=DEFAULT_SECTIONS):
        return "# 模块方案\n\n" + "\n\n".join(f"## {title}\n正文" for title in sections)

    def test_markdown_allows_subheadings_and_ignores_fenced_headings(self):
        text = self.markdown() + "\n### 局部说明\n````text\n## 示例标题\n```\n## 仍在示例内\n````\n"
        self.assertEqual(validate(self.proposal('.md', text), DEFAULT_SECTIONS), DEFAULT_SECTIONS)

    def test_missing_section_is_rejected(self):
        with self.assertRaises(ValueError):
            validate(self.proposal('.md', self.markdown(DEFAULT_SECTIONS[:-1])), DEFAULT_SECTIONS)

    def test_extra_section_is_rejected(self):
        with self.assertRaises(ValueError):
            validate(self.proposal('.md', self.markdown() + '\n## 附录\n'), DEFAULT_SECTIONS)

    def test_reordered_sections_are_rejected(self):
        sections = DEFAULT_SECTIONS.copy()
        sections[1], sections[2] = sections[2], sections[1]
        with self.assertRaises(ValueError):
            validate(self.proposal('.md', self.markdown(sections)), DEFAULT_SECTIONS)

    def test_html_heading_markup_is_preserved_without_counting_subheadings(self):
        sections = ''.join(f'<section><h2><span>{title}</span></h2><h3>细节</h3></section>' for title in DEFAULT_SECTIONS)
        path = self.proposal('.html', f'<!doctype html><main><h1>模块方案</h1>{sections}</main>')
        self.assertEqual(validate(path, DEFAULT_SECTIONS), DEFAULT_SECTIONS)

    def test_html_requires_main(self):
        with self.assertRaises(ValueError):
            validate(self.proposal('.html', '<h2>问题分析</h2>'), DEFAULT_SECTIONS)

    def test_user_sections_override_defaults(self):
        sections = ['现状', '目标接口', '迁移步骤']
        self.assertEqual(validate(self.proposal('.md', self.markdown(sections)), sections), sections)

    def test_cli_fails_for_extra_section(self):
        path = self.proposal('.md', self.markdown() + '\n## 附录\n')
        command = [sys.executable, '-B', str(Path(__file__).with_name('check_sections.py')), str(path)]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('实际', result.stderr)


if __name__ == '__main__':
    unittest.main()
