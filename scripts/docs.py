#!/usr/bin/env python3
"""Format and validate repository documentation without a backlog service.

The frontmatter contract is a flat string dictionary: sorted keys and quoted
values, status/audience required, dates for active/reference pages, and a
replacement for superseded pages. Markdown bodies are preserved byte for byte.
"""
import argparse
import datetime
import re
import subprocess
import sys
import unittest
from pathlib import Path


def _parse(text):
    lines = text.split('\n')
    if lines[0] != '---':
        raise ValueError('missing frontmatter opening ---')
    header = {}
    for index, line in enumerate(lines[1:], 1):
        if line == '---':
            return header, '\n'.join(lines[index + 1:])
        match = re.fullmatch(r'([a-z0-9]+(?:_[a-z0-9]+)*):(.*)', line)
        if not match:
            raise ValueError('invalid flat frontmatter line')
        key, raw = match.groups()
        if key in header:
            raise ValueError('duplicate frontmatter key: ' + key)
        value = raw.strip()
        if value.startswith('"'):
            if len(value) < 2 or not value.endswith('"'):
                raise ValueError('unterminated quoted value')
            value = value[1:-1]
            # A tiny scanner avoids YAML coercion and JSON escape extensions.
            result = []
            pos = 0
            while pos < len(value):
                ch = value[pos]
                if ch == '\\':
                    if pos + 1 == len(value) or value[pos + 1] not in '\\"':
                        raise ValueError('unsupported escape')
                    pos += 1
                    ch = value[pos]
                elif ch == '"':
                    raise ValueError('unescaped quote')
                result.append(ch)
                pos += 1
            value = ''.join(result)
        header[key] = value
    raise ValueError('missing frontmatter closing ---')


def _canonical(header):
    def quote(value):
        return value.replace('\\', '\\\\').replace('"', '\\"')
    return '---\n' + ''.join(f'{key}: "{quote(header[key])}"\n' for key in sorted(header)) + '---\n'


def _validate(header):
    if not header.get('audience', '').strip():
        raise ValueError('audience is required')
    status = header.get('status')
    if status not in {'active', 'reference', 'superseded', 'archived'}:
        raise ValueError('invalid or missing status')
    if status in {'active', 'reference'} and 'last_reviewed' not in header:
        raise ValueError('last_reviewed is required')
    if status == 'superseded' and not header.get('superseded_by', '').strip():
        raise ValueError('superseded_by is required')
    if 'last_reviewed' in header:
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', header['last_reviewed']):
            raise ValueError('last_reviewed must be YYYY-MM-DD')
        datetime.date.fromisoformat(header['last_reviewed'])


def _run(root, mode):
    failures = []
    count = 0
    for path in sorted((root / 'docs').glob('*.md')):
        if path.name in {'README.md', 'AGENTS.md', 'CLAUDE.md'}:
            continue
        try:
            raw = path.read_bytes().decode('utf-8')
            header, body = _parse(raw)
            _validate(header)
            canonical = _canonical(header) + body
            if mode == 'fmt' and canonical != raw:
                path.write_bytes(canonical.encode('utf-8'))
            elif mode == 'check' and canonical != raw:
                raise ValueError('noncanonical frontmatter; run docs.py fmt')
            count += 1
        except (ValueError, OSError) as error:
            failures.append(f'{path.relative_to(root)}: {error}')
    names = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-co', '--exclude-standard', '-z']).decode().split('\0')
    for name in sorted(set(names)):
        path = root / name
        if path.name != 'AGENTS.md' or not path.is_file() or path.is_symlink():
            continue
        sibling = path.with_name('CLAUDE.md')
        if not sibling.is_file() or sibling.read_text().strip() != '@AGENTS.md':
            failures.append(f'{name}: CLAUDE.md must contain only @AGENTS.md')
    for failure in failures:
        print(failure, file=sys.stderr)
    print(f'Documentation {mode}: {count} pages; {len(failures)} errors')
    return int(bool(failures))


def _self_test():
    class ContractTests(unittest.TestCase):
        def test_roundtrip_preserves_body_and_quoted_values(self):
            header = {'status': 'reference', 'audience': 'a "reader" \\ operator', 'last_reviewed': '2024-02-29'}
            body = '\n# Body\n\nKeep trailing spaces.  \n'
            parsed, actual = _parse(_canonical(header) + body)
            self.assertEqual((parsed, actual), (header, body))
            _validate(parsed)

        def test_rejects_malformed_headers(self):
            for text in ['Body', '---\nstatus: active', '---\nstatus: active\nstatus: archived\n---\n', '---\naudience: "bad\\n"\n---\n', '---\naudience: "bad"quote"\n---\n']:
                with self.subTest(text=text), self.assertRaises(ValueError):
                    _parse(text)

        def test_rejects_invalid_metadata(self):
            for header in [{}, {'status':'active','audience':'readers'}, {'status':'superseded','audience':'readers'}, {'status':'active','audience':'readers','last_reviewed':'2026-02-30'}, {'status':'archived','audience':''}]:
                with self.subTest(header=header), self.assertRaises(ValueError):
                    _validate(header)

        def test_formats_without_changing_prose(self):
            raw = '---\nstatus: archived\naudience: readers\n---\n\nBody\n'
            header, body = _parse(raw)
            _validate(header)
            self.assertEqual(_canonical(header) + body, '---\naudience: "readers"\nstatus: "archived"\n---\n\nBody\n')
    return int(not unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(ContractTests)).wasSuccessful())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['fmt', 'check', 'self-test'])
    args = parser.parse_args()
    sys.exit(_self_test() if args.mode == 'self-test' else _run(Path(__file__).resolve().parent.parent, args.mode))
