import { describe, expect, it } from 'vitest';
import { bufferVersion, fileUri, sourceExcerpt } from './context';
import {
  extractMarkdownHeadings,
  formatMarkdown,
  lintMarkdown,
  markdownHeadingReference,
  safeMarkdownLink,
} from './markdown';

describe('Markdown headings', () => {
  it('finds formatted and setext headings while ignoring fenced code and frontmatter', () => {
    const content = [
      '---',
      'title: Metadata',
      '---',
      '# Read the `code` and *notes*',
      '',
      '```md',
      '# Not a heading',
      '```',
      '',
      '日本語',
      '------',
      '',
    ].join('\n');
    expect(
      extractMarkdownHeadings(content).map(({ text, depth, range }) => ({ text, depth, range })),
    ).toEqual([
      {
        text: 'Read the code and notes',
        depth: 1,
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 29 } },
      },
      {
        text: '日本語',
        depth: 2,
        range: { start: { line: 9, character: 0 }, end: { line: 10, character: 6 } },
      },
    ]);
  });

  it('captures a section with its children and assigns unique heading anchors', () => {
    const content = '# Guide\n\nIntro\n\n## Setup\n\nInstall\n\n## Setup\n\nRun\n\n# End\n';
    const headings = extractMarkdownHeadings(content);
    expect(headings.map((heading) => heading.id)).toEqual(['guide', 'setup', 'setup-1', 'end']);
    expect(headings[0].content).toBe(content.slice(0, content.indexOf('# End')));
    expect(headings[1].content).toBe('## Setup\n\nInstall\n\n');
    const reference = markdownHeadingReference(headings[1], '/workspace/guide.md', content);
    expect(reference).toMatchObject({
      kind: 'symbol',
      label: 'Setup',
      uri: fileUri('/workspace/guide.md'),
      version: bufferVersion(content),
      ranges: [headings[1].sectionRange],
      content: '## Setup\n\nInstall\n\n',
    });
    expect(sourceExcerpt(content, reference.ranges).split('\n').slice(1).join('\n')).toBe(
      reference.content,
    );
  });

  it('keeps emoji source columns in UTF16 and avoids anchor collisions', () => {
    const headings = extractMarkdownHeadings('# 😀 Name\n# Name\n# Name-1\n# Name\n');
    expect(headings[0].range.end.character).toBe(9);
    expect(headings.map((heading) => heading.id)).toEqual(['name', 'name-1', 'name-1-1', 'name-2']);
  });
});

describe('Markdown tools', () => {
  it('formats GFM without changing code or frontmatter and is idempotent', () => {
    const content = [
      '---',
      'title: "A: guide"',
      'tags: [one, two]',
      '---',
      '# Guide',
      '',
      '* item',
      '* [x] done',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```rust',
      'fn main() {  println!("hello"); }',
      '```',
    ].join('\n');
    const formatted = formatMarkdown(content);
    expect(formatted).toContain('---\ntitle: "A: guide"\ntags: [one, two]\n---\n');
    expect(formatted).toContain('- item\n- [x] done\n');
    expect(formatted).toContain('fn main() {  println!("hello"); }');
    expect(formatMarkdown(formatted)).toBe(formatted);
    expect(lintMarkdown(formatted, '/workspace/guide.markdown')).toEqual([]);
  });

  it('reports broken references with the source path and UTF16 range', () => {
    const content = '# Guide\n\n😀 [docs][missing]\n';
    const diagnostic = lintMarkdown(content, '/workspace/guide.md').find(
      (item) => item.code === 'no-undefined-references',
    );
    expect(diagnostic).toMatchObject({
      uri: fileUri('/workspace/guide.md'),
      source: 'remark-lint',
      severity: 2,
      range: { start: { line: 2, character: 3 } },
    });
    expect(diagnostic?.message).toContain('missing');
    expect(lintMarkdown('# Guide\n\n[docs][ref]\n\n[ref]: ./guide.md\n', '/guide.md')).toEqual([]);
  });
});

describe('Markdown link policy', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,hello',
    'vbscripT:go',
    '//host/path',
    '\\\\host\\path',
    'java\nscript:alert(1)',
  ])('blocks unsafe destinations: %s', (href) => expect(safeMarkdownLink(href)).toBeUndefined());
  it.each([
    '#setup',
    '../guide.md#setup',
    '/workspace/README.md',
    'file:///workspace/README.md',
    'https://example.com/docs',
    'mailto:team@example.com',
  ])('passes safe destinations through to the host callback: %s', (href) =>
    expect(safeMarkdownLink(href)).toBe(href),
  );
});
