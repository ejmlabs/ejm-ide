import { describe, expect, it } from 'vitest';
import {
  activeEditorTab,
  closeEditorGroup,
  closeEditorTab,
  createEditorLayout,
  diffEditorTab,
  editorClosingPaths,
  editorDocumentPaths,
  editorGroups,
  editorModelUri,
  editorPathMatches,
  editorTabPath,
  fileEditorTab,
  focusEditorGroup,
  isGitDiffTab,
  MAX_EDITOR_GROUPS,
  markdownPreviewTab,
  moveEditorTab,
  openEditorTab,
  openMarkdownPreview,
  proposalDiffTab,
  replaceEditorFile,
  resolveNewFilePath,
  splitEditorGroup,
} from './editor-workspace';

const source = fileEditorTab('/repo/main.rs', 'main.rs');
const second = fileEditorTab('/repo/lib.rs', 'lib.rs');
const diff = diffEditorTab({ scope: 'worktree', path: '/repo/main.rs' }, 'main.rs changes');

describe('editor workspace', () => {
  it('opens files and diffs in the same group and returns to the adjacent tab on close', () => {
    let layout = openEditorTab(createEditorLayout(), source);
    layout = openEditorTab(layout, diff);
    expect(activeEditorTab(layout)).toEqual(diff);
    layout = closeEditorTab(layout, layout.activeGroup, diff.id);
    expect(activeEditorTab(layout)).toEqual(source);
    expect(layout.tabs[diff.id]).toBeUndefined();
  });

  it('splits the active file with one shared document identity and separate group selection', () => {
    let layout = openEditorTab(createEditorLayout(), source);
    layout = splitEditorGroup(layout, layout.activeGroup, 'horizontal', 'right');
    expect(editorGroups(layout.root).map((group) => group.tabs)).toEqual([
      [source.id],
      [source.id],
    ]);
    expect(Object.keys(layout.tabs)).toEqual([source.id]);
    expect(layout.activeGroup).toBe('right');
    layout = openEditorTab(layout, second);
    expect(editorGroups(layout.root)[0].activeTab).toBe(source.id);
    expect(activeEditorTab(layout)).toEqual(second);
    layout = focusEditorGroup(layout, 'editor-main');
    expect(activeEditorTab(layout)).toEqual(source);
  });

  it('keeps a file open when its other group tab closes', () => {
    let layout = openEditorTab(createEditorLayout(), source);
    layout = splitEditorGroup(layout, layout.activeGroup, 'vertical', 'lower');
    layout = closeEditorTab(layout, 'lower', source.id);
    expect(editorGroups(layout.root)).toHaveLength(1);
    expect(layout.tabs[source.id]).toEqual(source);
    expect(activeEditorTab(layout)).toEqual(source);
  });

  it('moves a diff to another group and collapses the empty source group', () => {
    let layout = openEditorTab(createEditorLayout(), source);
    layout = splitEditorGroup(layout, layout.activeGroup, 'horizontal', 'right');
    layout = openEditorTab(layout, diff);
    layout = closeEditorTab(layout, 'right', source.id);
    layout = moveEditorTab(layout, 'right', 'editor-main', diff.id);
    expect(editorGroups(layout.root)).toHaveLength(1);
    expect(editorGroups(layout.root)[0].tabs).toEqual([source.id, diff.id]);
    expect(activeEditorTab(layout)).toEqual(diff);
  });

  it('moves to an existing shared tab without duplicating it', () => {
    let layout = openEditorTab(createEditorLayout(), source);
    layout = splitEditorGroup(layout, layout.activeGroup, 'horizontal', 'right');
    layout = moveEditorTab(layout, 'editor-main', 'right', source.id);
    expect(editorGroups(layout.root)).toHaveLength(1);
    expect(editorGroups(layout.root)[0].tabs).toEqual([source.id]);
  });

  it('reorders tabs within a group without changing their identities', () => {
    let layout = openEditorTab(createEditorLayout(), source);
    layout = openEditorTab(layout, second);
    layout = openEditorTab(layout, diff);
    layout = moveEditorTab(layout, layout.activeGroup, layout.activeGroup, diff.id, source.id);
    expect(editorGroups(layout.root)[0].tabs).toEqual([diff.id, source.id, second.id]);
    expect(activeEditorTab(layout)).toEqual(diff);
  });

  it('keeps tab order when a dragged tab is dropped onto itself', () => {
    let layout = openEditorTab(createEditorLayout(), source);
    layout = openEditorTab(layout, second);
    expect(moveEditorTab(layout, 'editor-main', 'editor-main', source.id, source.id)).toBe(layout);
  });

  it('closes a whole group while keeping files shared with another group', () => {
    let layout = openEditorTab(createEditorLayout(), source);
    layout = splitEditorGroup(layout, layout.activeGroup, 'vertical', 'lower');
    layout = openEditorTab(layout, diff);
    layout = closeEditorGroup(layout, 'lower');
    expect(Object.values(layout.tabs)).toEqual([source]);
    expect(activeEditorTab(layout)).toEqual(source);
  });

  it('restores one empty editor group after closing the final editor', () => {
    const layout = closeEditorTab(
      openEditorTab(createEditorLayout(), source),
      'editor-main',
      source.id,
    );
    expect(layout).toEqual(createEditorLayout());
  });

  it('rejects stale group targets and missing drag sources', () => {
    const layout = openEditorTab(createEditorLayout(), source);
    expect(openEditorTab(layout, second, 'closed-group')).toBe(layout);
    expect(moveEditorTab(layout, 'closed-group', layout.activeGroup, source.id)).toBe(layout);
    expect(focusEditorGroup(layout, layout.activeGroup, 'missing-tab')).toBe(layout);
  });

  it('limits group growth and allows the user to close an empty split', () => {
    let layout = createEditorLayout();
    layout = splitEditorGroup(layout, layout.activeGroup, 'horizontal', 'empty');
    expect(editorGroups(layout.root)).toHaveLength(2);
    layout = closeEditorGroup(layout, 'empty');
    expect(editorGroups(layout.root)).toHaveLength(1);
    for (let index = 1; index < MAX_EDITOR_GROUPS; index++)
      layout = splitEditorGroup(layout, layout.activeGroup, 'horizontal', `group-${index}`);
    expect(splitEditorGroup(layout, layout.activeGroup, 'horizontal', 'too-many')).toBe(layout);
  });

  it('remaps every view of an untitled file after Save As while keeping its tab identity', () => {
    const untitled = fileEditorTab('untitled:///draft/Untitled-1', 'Untitled-1');
    let layout = openEditorTab(createEditorLayout(), untitled);
    layout = splitEditorGroup(layout, layout.activeGroup, 'horizontal', 'right');
    layout = replaceEditorFile(layout, untitled.path, '/repo/new.ts', 'new.ts');
    expect(editorGroups(layout.root).every((group) => group.activeTab === untitled.id)).toBe(true);
    expect(activeEditorTab(layout)).toMatchObject({
      id: untitled.id,
      path: '/repo/new.ts',
      title: 'new.ts',
    });
    expect(editorModelUri('untitled:///draft/Untitled-1')).toBe('untitled:/draft/Untitled-1');
    expect(editorModelUri('/repo/new.ts')).toBe('file:///repo/new.ts');
  });
});

describe('new file paths', () => {
  it('resolves an explicit new path under the workspace', () => {
    expect(resolveNewFilePath('/repo/', ' src/new file.ts ')).toBe('/repo/src/new file.ts');
  });
  it.each([
    '',
    '../outside.ts',
    '/tmp/outside.ts',
    'src/../outside.ts',
    'src//file.ts',
    './file.ts',
    'src\\file.ts',
    'bad\0name.ts',
  ])('rejects invalid or escaping path %j', (path) => {
    expect(() => resolveNewFilePath('/repo', path)).toThrow();
  });
});

describe('editor model identity', () => {
  it.each([
    ['/repo/(auth)/page.tsx', 'file:///repo/%28auth%29/page.tsx'],
    ["/repo/it's!.ts", 'file:///repo/it%27s%21.ts'],
    ['untitled:///draft/Untitled-1', 'untitled:/draft/Untitled-1'],
    ['untitled:/draft/Untitled-1', 'untitled:/draft/Untitled-1'],
  ])('matches %s after Monaco URI canonicalization', (path, uri) => {
    expect(editorPathMatches(path, uri)).toBe(true);
    expect(editorPathMatches(path, undefined)).toBe(false);
  });
  it('does not confuse two model paths', () => {
    expect(editorPathMatches('/repo/main.rs', 'file:///repo/lib.rs')).toBe(false);
    expect(editorPathMatches('untitled:/draft/Untitled-1', 'untitled:/draft/Untitled-2')).toBe(
      false,
    );
  });
});

describe('Markdown editor tabs', () => {
  const path = '/repo/README.md';
  const markdown = fileEditorTab(path, 'README.md');
  const preview = markdownPreviewTab(path, 'README.md');

  it('opens a preview to the right while retaining the active source in its group', () => {
    let layout = openEditorTab(createEditorLayout(), markdown);
    layout = openEditorTab(layout, second);
    layout = focusEditorGroup(layout, 'editor-main', markdown.id);
    layout = openMarkdownPreview(layout, path, 'README.md', { newGroupId: 'preview' });
    expect(
      editorGroups(layout.root).map((group) => [group.id, group.tabs, group.activeTab]),
    ).toEqual([
      ['editor-main', [markdown.id, second.id], markdown.id],
      ['preview', [preview.id], preview.id],
    ]);
    expect(activeEditorTab(layout)).toEqual(preview);
    expect(layout.activeGroup).toBe('preview');
  });

  it('moves a current-group preview beside the source once and reuses that view thereafter', () => {
    let layout = openMarkdownPreview(
      openEditorTab(createEditorLayout(), markdown),
      path,
      'README.md',
      { beside: false },
    );
    layout = focusEditorGroup(layout, 'editor-main', markdown.id);
    layout = openMarkdownPreview(layout, path, 'README.md', { newGroupId: 'preview' });
    expect(
      editorGroups(layout.root).map((group) => [group.id, group.tabs, group.activeTab]),
    ).toEqual([
      ['editor-main', [markdown.id], markdown.id],
      ['preview', [preview.id], preview.id],
    ]);
    layout = focusEditorGroup(layout, 'editor-main', markdown.id);
    const reopened = openMarkdownPreview(layout, path, 'README.md', { newGroupId: 'unused' });
    expect(editorGroups(reopened.root)).toHaveLength(2);
    expect(reopened.activeGroup).toBe('preview');
    expect(activeEditorTab(reopened)).toEqual(preview);
    expect(Object.keys(reopened.tabs)).toHaveLength(2);
  });

  it('does not leave an empty source group when the group contains only its preview', () => {
    let layout = openMarkdownPreview(createEditorLayout(), path, 'README.md', { beside: false });
    layout = openMarkdownPreview(layout, path, 'README.md', { newGroupId: 'unused' });
    expect(editorGroups(layout.root)).toHaveLength(1);
    expect(activeEditorTab(layout)).toEqual(preview);
    expect(editorGroups(layout.root)[0].tabs).toEqual([preview.id]);
  });

  it('retains the matching source when moving an active preview beside a group of files', () => {
    let layout = openEditorTab(createEditorLayout(), markdown);
    layout = openEditorTab(layout, second);
    layout = openMarkdownPreview(layout, path, 'README.md', { beside: false });
    layout = openMarkdownPreview(layout, path, 'README.md', { newGroupId: 'preview' });
    expect(editorGroups(layout.root)[0].activeTab).toBe(markdown.id);
    expect(activeEditorTab(layout)).toEqual(preview);
  });

  it('focuses an existing preview elsewhere even when the requested group has a shared view', () => {
    let layout = openMarkdownPreview(
      openEditorTab(createEditorLayout(), markdown),
      path,
      'README.md',
      { beside: false },
    );
    layout = splitEditorGroup(layout, 'editor-main', 'horizontal', 'shared-preview', preview.id);
    layout = focusEditorGroup(layout, 'editor-main', markdown.id);
    layout = openMarkdownPreview(layout, path, 'README.md', { newGroupId: 'unused' });
    expect(editorGroups(layout.root)).toHaveLength(2);
    expect(layout.activeGroup).toBe('shared-preview');
  });

  it('focuses a preview in another group and allows an explicit current-group preview', () => {
    const initial = openEditorTab(createEditorLayout(), markdown);
    const together = openMarkdownPreview(initial, path, 'README.md', { beside: false });
    expect(editorGroups(together.root)[0].tabs).toEqual([markdown.id, preview.id]);
    let beside = openMarkdownPreview(initial, path, 'README.md', { newGroupId: 'preview' });
    beside = focusEditorGroup(beside, 'editor-main', markdown.id);
    const reopened = openMarkdownPreview(beside, path, 'README.md', { newGroupId: 'unused' });
    expect(editorGroups(reopened.root)).toHaveLength(2);
    expect(reopened.activeGroup).toBe('preview');
  });

  it('keeps the shared document open while either source or preview remains', () => {
    let layout = openMarkdownPreview(
      openEditorTab(createEditorLayout(), markdown),
      path,
      'README.md',
      { newGroupId: 'preview' },
    );
    expect(editorDocumentPaths(layout)).toEqual(new Set([path]));
    expect(editorTabPath(preview)).toBe(path);
    expect(editorTabPath(diff)).toBeUndefined();
    expect(editorTabPath(undefined)).toBeUndefined();
    layout = closeEditorTab(layout, 'editor-main', markdown.id);
    expect(editorDocumentPaths(layout)).toEqual(new Set([path]));
    layout = closeEditorTab(layout, 'preview', preview.id);
    expect(editorDocumentPaths(layout)).toEqual(new Set());
  });

  it('remaps both source and preview paths on Save As and reuses the preserved preview ID', () => {
    let layout = openMarkdownPreview(
      openEditorTab(createEditorLayout(), markdown),
      path,
      'README.md',
      { newGroupId: 'preview' },
    );
    layout = replaceEditorFile(layout, path, '/repo/Guide.md', 'Guide.md');
    expect(layout.tabs[markdown.id]).toEqual({
      ...markdown,
      path: '/repo/Guide.md',
      title: 'Guide.md',
    });
    expect(layout.tabs[preview.id]).toEqual({
      ...preview,
      path: '/repo/Guide.md',
      title: 'Guide.md',
    });
    expect(editorDocumentPaths(layout)).toEqual(new Set(['/repo/Guide.md']));
    layout = openMarkdownPreview(layout, '/repo/Guide.md', 'Guide.md', { newGroupId: 'unused' });
    expect(editorGroups(layout.root)).toHaveLength(2);
    expect(activeEditorTab(layout)?.id).toBe(preview.id);
  });

  it('opens in the requested group at the group limit without losing the source or preview', () => {
    let layout = openEditorTab(createEditorLayout(), markdown);
    for (let index = 1; index < MAX_EDITOR_GROUPS; index++) {
      layout = splitEditorGroup(layout, layout.activeGroup, 'horizontal', `group-${index}`);
    }
    layout = openMarkdownPreview(layout, path, 'README.md', {
      groupId: 'editor-main',
      newGroupId: 'too-many',
    });
    expect(editorGroups(layout.root)).toHaveLength(MAX_EDITOR_GROUPS);
    expect(editorGroups(layout.root)[0].tabs).toEqual([markdown.id, preview.id]);
    expect(activeEditorTab(layout)).toEqual(preview);
    expect(editorDocumentPaths(layout)).toEqual(new Set([path]));
  });

  it('focuses an existing current-group preview at the group limit', () => {
    let layout = openMarkdownPreview(
      openEditorTab(createEditorLayout(), markdown),
      path,
      'README.md',
      { beside: false },
    );
    for (let index = 1; index < MAX_EDITOR_GROUPS; index++) {
      layout = splitEditorGroup(layout, 'editor-main', 'horizontal', `group-${index}`, markdown.id);
    }
    layout = focusEditorGroup(layout, 'editor-main', markdown.id);
    layout = openMarkdownPreview(layout, path, 'README.md', { newGroupId: 'too-many' });
    expect(editorGroups(layout.root)).toHaveLength(MAX_EDITOR_GROUPS);
    expect(layout.activeGroup).toBe('editor-main');
    expect(activeEditorTab(layout)).toEqual(preview);
  });

  it('falls back to the source group when no new group ID is available', () => {
    const layout = openMarkdownPreview(
      openEditorTab(createEditorLayout(), markdown),
      path,
      'README.md',
    );
    expect(editorGroups(layout.root)).toHaveLength(1);
    expect(editorGroups(layout.root)[0].tabs).toEqual([markdown.id, preview.id]);
    expect(activeEditorTab(layout)).toEqual(preview);
  });
});

describe('pending editor closes', () => {
  it('resolves the latest Save As path before closing after a failed final save', () => {
    const untitled = fileEditorTab('untitled:///draft/Untitled-1', 'Untitled-1');
    const finalPath = '/repo/notes.md';
    let layout = openEditorTab(createEditorLayout(), untitled);
    const pendingClose = () =>
      editorClosingPaths(layout, closeEditorTab(layout, 'editor-main', untitled.id));
    expect(pendingClose()).toEqual(new Set([untitled.path]));
    layout = replaceEditorFile(layout, untitled.path, finalPath, 'notes.md');
    const dirtyPaths = new Set([finalPath]);
    expect(pendingClose()).toEqual(new Set([finalPath]));
    expect([...pendingClose()].filter((path) => dirtyPaths.has(path))).toEqual([finalPath]);
    expect(layout.tabs[untitled.id]).toMatchObject({ id: untitled.id, path: finalPath });
  });

  it('excludes the document while either a source or preview view still references it', () => {
    const source = fileEditorTab('untitled:///draft/Untitled-1.md', 'Untitled-1.md');
    let layout = openMarkdownPreview(
      openEditorTab(createEditorLayout(), source),
      source.path,
      source.title,
      { newGroupId: 'preview' },
    );
    const pendingSourceClose = () =>
      editorClosingPaths(layout, closeEditorTab(layout, 'editor-main', source.id));
    layout = replaceEditorFile(layout, source.path, '/repo/saved.md', 'saved.md');
    expect(pendingSourceClose()).toEqual(new Set());
    const previewId = editorGroups(layout.root).find((group) => group.id === 'preview')?.activeTab;
    expect(previewId).toBeDefined();
    expect(editorClosingPaths(layout, closeEditorGroup(layout, 'preview'))).toEqual(new Set());
    const withoutSource = closeEditorTab(layout, 'editor-main', source.id);
    expect(editorClosingPaths(withoutSource, closeEditorGroup(withoutSource, 'preview'))).toEqual(
      new Set(['/repo/saved.md']),
    );
  });
});

describe('proposal diff tabs', () => {
  it('keeps a proposed write out of the Git diff request', () => {
    const proposal = proposalDiffTab({
      reviewId: 'review-1',
      path: 'build.rs',
      before: 'fn main() {}\n',
      after: 'fn main() { println!("no"); }\n',
      connectionId: 4,
    });
    expect(proposal.kind).toBe('proposal-diff');
    expect(isGitDiffTab(proposal)).toBe(false);
    expect(proposal).not.toHaveProperty('request');
    expect(editorTabPath(proposal)).toBeUndefined();
    const layout = openEditorTab(createEditorLayout(), proposal);
    expect(activeEditorTab(layout)).toEqual(proposal);
    expect(editorDocumentPaths(layout)).toEqual(new Set());
    const closed = closeEditorTab(layout, layout.activeGroup, proposal.id);
    expect(closed.tabs[proposal.id]).toBeUndefined();
  });
});
