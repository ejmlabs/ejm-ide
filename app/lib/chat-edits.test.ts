import { createPatch, createTwoFilesPatch } from 'diff';
import { describe, expect, it } from 'vitest';
import { type ChatFileEdit, fileDiffPreview, parseFileEdits, parseTurnEdits } from './chat-edits';

const update = '@@ -3,2 +3,3 @@\n kept\n-before\n+after\n+another\n';
function fileChange(kind: 'add' | 'delete' | 'update', diff: string, path = 'src/main.rs') {
  return { path, kind: { type: kind }, diff };
}
function edit(diff: string, kind: ChatFileEdit['kind'] = 'update'): ChatFileEdit {
  return parseFileEdits([fileChange(kind, diff)]).files[0];
}

describe('agent file edit snapshots', () => {
  it('builds exact diffs from reviewed native before and after snapshots', () => {
    const parsed = parseFileEdits([
      {
        path: 'src/main.rs',
        kind: { type: 'update' },
        before: 'one\ntwo\nthree\n',
        after: 'one\nchanged\nthree\n',
      },
      { path: 'new.txt', kind: { type: 'add' }, before: '', after: 'new content\n' },
    ]);
    expect(parsed.truncated).toBe(false);
    expect(fileDiffPreview(parsed.files[0])).toMatchObject({
      additions: 1,
      deletions: 1,
      truncated: false,
    });
    expect(fileDiffPreview(parsed.files[0]).hunks[0].lines).toContainEqual({
      type: 'context',
      content: 'one',
      oldLine: 1,
      newLine: 1,
    });
    expect(parsed.files[1]).toMatchObject({
      kind: 'add',
      diff: 'new content\n',
      format: 'content',
    });
  });

  it('rejects oversized or incomplete native snapshots without inventing line totals', () => {
    expect(
      parseFileEdits([
        { path: 'a', kind: { type: 'update' }, before: 'a'.repeat(200_001), after: 'b' },
      ]),
    ).toEqual({ files: [], truncated: true });
    expect(parseFileEdits([{ path: 'a', kind: { type: 'update' }, before: 'a' }])).toEqual({
      files: [],
      truncated: true,
    });
  });
  it('keeps native additions and deletions as raw content, including diff-looking code', () => {
    const content = '+actual content\n--- not a header\n@@ still code @@\n';
    for (const kind of ['add', 'delete'] as const) {
      const parsed = edit(content, kind);
      expect(parsed).toMatchObject({ diff: content, format: 'content', kind });
      const preview = fileDiffPreview(parsed);
      expect(preview).toMatchObject({
        additions: kind === 'add' ? 3 : 0,
        deletions: kind === 'delete' ? 3 : 0,
        truncated: false,
      });
      expect(preview.hunks[0].lines.map((line) => line.content)).toEqual([
        '+actual content',
        '--- not a header',
        '@@ still code @@',
      ]);
    }
  });

  it('uses library hunks for headerless updates and correct old and new line numbers', () => {
    const snapshot = edit(update);
    expect(snapshot).toMatchObject({ diff: update, format: 'patch' });
    expect(fileDiffPreview(snapshot)).toEqual({
      additions: 2,
      deletions: 1,
      truncated: false,
      hunks: [
        {
          header: '@@ -3,2 +3,3 @@',
          lines: [
            { type: 'context', content: 'kept', oldLine: 3, newLine: 3 },
            { type: 'delete', content: 'before', oldLine: 4 },
            { type: 'add', content: 'after', newLine: 4 },
            { type: 'add', content: 'another', newLine: 5 },
          ],
        },
      ],
    });
  });

  it('strips only an exact native move annotation, keeping literal content intact', () => {
    const moved = {
      ...fileChange('update', `${update}\n\nMoved to: src/new.rs`),
      kind: { type: 'update', move_path: 'src/new.rs' },
    };
    expect(parseFileEdits([moved]).files[0]).toMatchObject({
      path: 'src/main.rs',
      movePath: 'src/new.rs',
      diff: update,
    });
    expect(
      parseFileEdits([{ ...moved, diff: `${update}\n\nMoved to: src/other.rs` }]).files[0].diff,
    ).toBe(`${update}\n\nMoved to: src/other.rs`);
    const literal = '+Moved to: src/new.rs\n';
    expect(parseFileEdits([{ ...moved, diff: literal }]).files[0].diff).toBe(literal);
    expect(edit(`${update}\n\nMoved to: src/new.rs`).diff).toContain('Moved to:');
  });

  it('keeps no-newline markers as metadata without changing counts or numbers', () => {
    const preview = fileDiffPreview(
      edit('@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n'),
    );
    expect(preview).toMatchObject({ additions: 1, deletions: 1 });
    expect(preview.hunks[0].lines).toEqual([
      { type: 'delete', content: 'old', oldLine: 1 },
      { type: 'meta', content: '\\ No newline at end of file' },
      { type: 'add', content: 'new', newLine: 1 },
      { type: 'meta', content: '\\ No newline at end of file' },
    ]);
    expect(fileDiffPreview(edit('last line', 'add')).hunks[0].lines[0]).toEqual({
      type: 'add',
      content: 'last line',
      newLine: 1,
    });
  });

  it('keeps empty created and deleted files valid with zero changed lines', () => {
    for (const kind of ['add', 'delete'] as const)
      expect(fileDiffPreview(edit('', kind))).toEqual({
        hunks: [],
        additions: 0,
        deletions: 0,
        truncated: false,
      });
  });

  it('rejects malformed entries and control characters in paths with an omission state', () => {
    expect(parseFileEdits(null)).toEqual({ files: [], truncated: false });
    const malformed = [
      null,
      {},
      fileChange('add', '', ''),
      fileChange('add', '', 'line\nbreak.rs'),
      fileChange('add', '', 'null\0.rs'),
      fileChange('add', '', `del${String.fromCharCode(127)}.rs`),
      { path: 'a', kind: 'add', diff: '' },
      { path: 'a', kind: { type: 'unknown' }, diff: '' },
      { path: 'a', kind: { type: 'add' }, diff: null },
      { path: 'a', kind: { type: 'update', move_path: 'b\r.rs' }, diff: update },
    ];
    expect(parseFileEdits(malformed)).toEqual({ files: [], truncated: true });
    expect(
      parseFileEdits([fileChange('add', '<script>text</script>', 'path with spaces.ts')]),
    ).toMatchObject({
      files: [{ path: 'path with spaces.ts', diff: '<script>text</script>' }],
      truncated: false,
    });
  });

  it('bounds stored snapshots by file count, each file, and total characters', () => {
    const many = parseFileEdits(
      Array.from({ length: 101 }, (_, i) => fileChange('add', '', `file-${i}`)),
    );
    expect(many.files).toHaveLength(100);
    expect(many.truncated).toBe(true);
    const large = parseFileEdits(
      Array.from({ length: 6 }, (_, i) => fileChange('add', 'x'.repeat(200_001), `file-${i}`)),
    );
    expect(large.files.every((file) => file.diff.length <= 200_000)).toBe(true);
    expect(large.files.reduce((sum, file) => sum + file.diff.length, 0)).toBe(800_000);
    expect(large.truncated).toBe(true);
    expect(fileDiffPreview(large.files[0])).toMatchObject({ additions: null, deletions: null });
  });

  it('limits rendered rows but reports exact counts from a complete retained snapshot', () => {
    const snapshot = edit('line\n'.repeat(900), 'add');
    const preview = fileDiffPreview(snapshot);
    expect(preview.additions).toBe(900);
    expect(preview.deletions).toBe(0);
    expect(preview.truncated).toBe(true);
    expect(preview.hunks.reduce((sum, hunk) => sum + hunk.lines.length + 1, 0)).toBeLessThanOrEqual(
      600,
    );
    expect(snapshot.diff).toBe('line\n'.repeat(900));
  });

  it('shows malformed patches as bounded text without invented statistics', () => {
    const malformed = fileDiffPreview(edit('@@ -1,99 +1,99 @@\n-incomplete\n'));
    expect(malformed).toMatchObject({
      hunks: [],
      additions: null,
      deletions: null,
      fallback: '@@ -1,99 +1,99 @@\n-incomplete\n',
    });
    const long = fileDiffPreview(edit('not a patch\n'.repeat(700)));
    expect(long.fallback?.split('\n')).toHaveLength(600);
    expect(long.truncated).toBe(true);
    expect(fileDiffPreview(edit('prose only')).additions).toBeNull();
  });
});

describe('aggregate turn edit snapshots', () => {
  it('splits multiple library patches and derives add, update, and delete paths', () => {
    const snapshot = [
      createTwoFilesPatch('/dev/null', 'new.ts', '', 'new\n'),
      createPatch('changed.ts', 'old\n', 'changed\n'),
      createTwoFilesPatch('gone.ts', '/dev/null', 'gone\n', ''),
    ].join('');
    const parsed = parseTurnEdits(snapshot);
    expect(parsed?.truncated).toBe(false);
    expect(parsed?.files.map(({ path, kind, format }) => ({ path, kind, format }))).toEqual([
      { path: 'new.ts', kind: 'add', format: 'patch' },
      { path: 'changed.ts', kind: 'update', format: 'patch' },
      { path: 'gone.ts', kind: 'delete', format: 'patch' },
    ]);
    expect(
      parsed?.files.map(fileDiffPreview).map(({ additions, deletions }) => [additions, deletions]),
    ).toEqual([
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
  });

  it('understands quoted Git names, renames, and metadata-only changes through the library', () => {
    const parsed = parseTurnEdits(
      'diff --git "a/old name.ts" "b/new name.ts"\nsimilarity index 100%\nrename from old name.ts\nrename to new name.ts\n',
    );
    expect(parsed?.files[0]).toMatchObject({
      path: 'old name.ts',
      movePath: 'new name.ts',
      kind: 'update',
    });
    expect(parsed && fileDiffPreview(parsed.files[0])).toMatchObject({
      hunks: [],
      additions: 0,
      deletions: 0,
    });
    const invalidPath = parseTurnEdits(
      'diff --git "a/line\\nname.ts" "b/line\\nname.ts"\nold mode 100644\nnew mode 100755\n',
    );
    expect(invalidPath).toEqual({ files: [], truncated: true });
  });

  it('represents an empty reverted diff and rejects malformed or unidentifiable snapshots', () => {
    expect(parseTurnEdits('')).toEqual({ files: [], truncated: false });
    expect(parseTurnEdits(' \n')).toEqual({ files: [], truncated: false });
    for (const value of [null, {}, [], 'not a diff', update])
      expect(parseTurnEdits(value)).toBeNull();
    expect(parseTurnEdits('--- a/a.ts\n+++ b/a.ts\n@@ -1,9 +1,9 @@\n+x\n')).toBeNull();
  });

  it('marks binary changes as unavailable text with unknown line totals', () => {
    const parsed = parseTurnEdits('diff --git a/image.png b/image.png\nBinary files differ\n');
    expect(parsed?.files[0].path).toBe('image.png');
    expect(parsed && fileDiffPreview(parsed.files[0])).toMatchObject({
      additions: null,
      deletions: null,
      hunks: [],
    });
  });

  it('bounds aggregate snapshots, keeping omitted or clipped totals unknown', () => {
    const largeFile = parseTurnEdits(createPatch('large.ts', '', 'line\n'.repeat(35_000)));
    expect(largeFile?.files[0].diff.length).toBe(200_000);
    expect(largeFile?.files[0].truncated).toBe(true);
    expect(largeFile && fileDiffPreview(largeFile.files[0]).additions).toBeNull();
    const clipped = parseTurnEdits(createPatch('huge.ts', '', 'line\n'.repeat(150_000)));
    expect(clipped).toEqual({ files: [], truncated: true });
    const many = parseTurnEdits(
      Array.from({ length: 101 }, (_, i) => createPatch(`file-${i}`, '', 'new\n')).join(''),
    );
    expect(many?.files).toHaveLength(100);
    expect(many?.truncated).toBe(true);
  });
});
