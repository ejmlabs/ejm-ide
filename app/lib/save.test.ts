import { describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./backend', () => ({ invoke }));
vi.mock('./language-sync', () => ({ syncLanguageDocument: vi.fn(async () => {}) }));

import { applyTextEdits, formatDocumentContent, lintForSavedBuffers } from './save';

describe('save formatting', () => {
  it('formats strict JSON without changing large integers or numeric spelling', async () => {
    const original = '{"id":9007199254740993,"amount":1.00,"label":"😀"}';
    const result = await formatDocumentContent('/package.json', original, 4, {
      lsp: false,
      tabSize: 2,
      insertSpaces: true,
    });
    expect(result).toEqual({
      content: '{\n  "id": 9007199254740993,\n  "amount": 1.00,\n  "label": "😀"\n}',
    });
  });

  it.each(['/settings.jsonc', '/tsconfig.build.json', '/.vscode/settings.json'])(
    'preserves comments and trailing commas in %s',
    async (path) => {
      const result = await formatDocumentContent(path, '{// keep this note\n"enabled":true,}', 2, {
        lsp: false,
        tabSize: 2,
        insertSpaces: true,
      });
      expect(result.message).toBeUndefined();
      expect(result.content).toContain('// keep this note');
      expect(result.content).toContain('"enabled": true,');
      expect(result.content).toContain('\n  "enabled"');
    },
  );

  it.each([
    ['/package.json', '{"enabled":true,}'],
    ['/package.json', '{// comments need JSONC\n"enabled":true}'],
    ['/settings.jsonc', '{"unfinished":'],
  ])('saves invalid %s unchanged when formatting cannot safely parse it', async (path, content) => {
    await expect(
      formatDocumentContent(path, content, 3, {
        lsp: false,
        tabSize: 2,
        insertSpaces: true,
      }),
    ).resolves.toEqual({
      content,
      message: 'Formatting was skipped because the JSON has syntax errors.',
    });
  });

  it('formats HTML while preserving preformatted content', async () => {
    const result = await formatDocumentContent(
      '/index.html',
      '<div><span>Ready</span><pre>  keep\n this</pre></div>',
      1,
      { lsp: false, tabSize: 2, insertSpaces: true },
    );
    expect(result.content).toContain('<span>Ready</span>\n  <pre>');
    expect(result.content).toContain('<pre>  keep\n this</pre>');
  });

  it.each([
    ['/style.css', 'body{color:red}', 'color: red'],
    ['/style.scss', '$accent:red;.item{color:$accent}', 'color: $accent'],
    ['/style.less', '@accent:red;.item{color:@accent}', 'color: @accent'],
  ])('uses the matching CSS service for %s', async (path, content, declaration) => {
    const result = await formatDocumentContent(path, content, 1, {
      lsp: false,
      tabSize: 2,
      insertSpaces: true,
    });
    expect(result.content).toContain(`\n  ${declaration}`);
  });

  it('formats Markdown through the local document parser', async () => {
    await expect(
      formatDocumentContent('/readme.markdown', '#Title\n\n* one\n* two', 1, {
        lsp: false,
        tabSize: 2,
        insertSpaces: true,
      }),
    ).resolves.toEqual({ content: '\\#Title\n\n- one\n- two\n' });
  });
  it('keeps workspace lint results from overwriting diagnostics for dirty buffers', () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    const saved = { uri: 'file:///saved.rs', range, message: 'saved warning' };
    const dirty = { uri: 'file:///dirty.rs', range, message: 'old disk warning' };
    expect(
      lintForSavedBuffers(
        [saved, dirty],
        [
          {
            path: '/saved.rs',
            content: 'saved',
            savedContent: 'saved',
            version: '1',
            modelVersion: 1,
            language: 'rust',
          },
          {
            path: '/dirty.rs',
            content: 'edited',
            savedContent: 'old',
            version: '1',
            modelVersion: 2,
            language: 'rust',
          },
        ],
      ),
    ).toEqual([saved]);
  });
  it('applies independent edits against the original UTF-16 source', () => {
    expect(
      applyTextEdits('😀foo\r\nbar', [
        {
          range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } },
          newText: 'longer',
        },
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
          newText: 'short',
        },
      ]),
    ).toBe('😀longer\r\nshort');
  });

  it.each(['\n', '\r\n', '\r'])(
    'keeps line endings outside an oversized column range: %j',
    (eol) => {
      expect(
        applyTextEdits(`ab${eol}cd`, [
          {
            range: { start: { line: 0, character: 1 }, end: { line: 0, character: 99 } },
            newText: 'X',
          },
        ]),
      ).toBe(`aX${eol}cd`);
    },
  );

  it('preserves the provider order for insertions at the same position', () => {
    const range = { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } };
    expect(
      applyTextEdits('ab', [
        { range, newText: 'X' },
        { range, newText: 'Y' },
      ]),
    ).toBe('aXYb');
  });

  it.each([
    { start: { line: 1, character: 0 }, end: { line: 0, character: 1 } },
    { start: { line: 0, character: 2 }, end: { line: 0, character: 1 } },
    { start: { line: 0, character: 0 }, end: { line: 0, character: -1 } },
    { start: { line: 0, character: 0 }, end: { line: 0, character: 0.5 } },
    { start: { line: 0, character: 0 }, end: { line: 0, character: Number.NaN } },
    { start: { line: 0, character: 0 }, end: { line: Number.MAX_SAFE_INTEGER + 1, character: 0 } },
  ])('rejects malformed or reversed ranges before applying edits: %j', (range) => {
    expect(() => applyTextEdits('ab\ncd', [{ range, newText: 'X' }])).toThrow('invalid');
  });

  it('rejects overlapping or invalid formatter edits', () => {
    const edit = {
      range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } },
      newText: 'x',
    };
    expect(() => applyTextEdits('abcd', [edit, edit])).toThrow('overlapping');
    expect(() =>
      applyTextEdits('a', [
        { ...edit, range: { ...edit.range, start: { line: -1, character: 0 } } },
      ]),
    ).toThrow('invalid');
  });

  it('accepts the full-file range Ruby LSP uses when the last line has no newline', () => {
    expect(
      applyTextEdits('def total; 1; end', [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
          newText: 'def total\n  1\nend\n',
        },
      ]),
    ).toBe('def total\n  1\nend\n');
  });

  it('uses a dedicated formatter without a language service', async () => {
    invoke.mockResolvedValueOnce({ status: 'ok', content: 'const value = 1;\n', tool: 'Biome' });
    await expect(
      formatDocumentContent('/code/file.ts', 'const value=1', 2, {
        lsp: false,
        tabSize: 2,
        insertSpaces: true,
      }),
    ).resolves.toEqual({ content: 'const value = 1;\n' });
  });

  it('falls back to the language server when a dedicated formatter is unsupported', async () => {
    invoke.mockResolvedValueOnce({ status: 'unsupported', content: 'a', tool: '' });
    invoke.mockResolvedValueOnce([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        newText: 'b',
      },
    ]);
    await expect(
      formatDocumentContent('/code/file.rs', 'a', 2, {
        lsp: true,
        tabSize: 4,
        insertSpaces: true,
      }),
    ).resolves.toEqual({ content: 'b' });
  });
});
