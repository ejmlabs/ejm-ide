import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  createEditorLayout,
  diffEditorTab,
  type EditorLayout,
  fileEditorTab,
  openEditorTab,
  openMarkdownPreview,
} from '@/lib/editor-workspace';
import { EditorWorkspace } from './EditorWorkspace';

vi.mock('@/lib/backend', () => ({ invoke: vi.fn(), isDesktop: false }));

function renderWorkspace(layout: EditorLayout, dirtyPaths = new Set<string>()) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <EditorWorkspace
        layout={layout}
        dirtyPaths={dirtyPaths}
        onFocus={vi.fn()}
        onClose={vi.fn()}
        onCloseTabs={vi.fn()}
        onCloseGroup={vi.fn()}
        onSplit={vi.fn()}
        onMove={vi.fn()}
        onNew={vi.fn()}
        renderContent={(_, tab) => <div>{tab?.kind ?? 'empty'}</div>}
      />
    </TooltipProvider>,
  );
}

describe('editor tab presentation', () => {
  it('connects real tabs to their active editor panel without making tabs menu buttons', () => {
    let layout = openEditorTab(createEditorLayout(), fileEditorTab('/repo/main.rs', 'main.rs'));
    layout = openEditorTab(
      layout,
      diffEditorTab({ scope: 'worktree', path: '/repo/main.rs' }, 'main.rs changes'),
    );
    const html = renderWorkspace(layout);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="main.rs changes"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-controls=');
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Editor group actions"');
  });

  it('shows preview as an editor tab beside its source and keeps unsaved source visible', () => {
    const path = '/repo/README.md';
    const layout = openMarkdownPreview(
      openEditorTab(createEditorLayout(), fileEditorTab(path, 'README.md')),
      path,
      'README.md',
      { newGroupId: 'preview' },
    );
    const html = renderWorkspace(layout, new Set([path]));
    expect(html).toContain('aria-label="README.md (unsaved)"');
    expect(html).toContain('aria-label="README.md preview"');
    expect(html).toContain('aria-label="Close README.md preview"');
    expect(html).toContain('editor-tab-kind">Preview');
    expect(html.match(/role="tablist"/g)).toHaveLength(2);
    expect(html.match(/class="unsaved-dot"/g)).toHaveLength(1);
  });

  it('disambiguates matching filenames with only the necessary parent path', () => {
    let layout = openEditorTab(
      createEditorLayout(),
      fileEditorTab('/repo/app/index.ts', 'index.ts'),
    );
    layout = openEditorTab(layout, fileEditorTab('/repo/test/index.ts', 'index.ts'));
    layout = openEditorTab(layout, fileEditorTab('/repo/main.rs', 'main.rs'));
    const html = renderWorkspace(layout);
    expect(html).toContain('editor-tab-directory">app');
    expect(html).toContain('editor-tab-directory">test');
    expect(html.match(/editor-tab-directory/g)).toHaveLength(2);
    expect(html).toContain('title="/repo/app/index.ts"');
  });

  it('does not repeat a path hint merely because a source and preview share a filename', () => {
    let layout = openEditorTab(createEditorLayout(), fileEditorTab('/repo/README.md', 'README.md'));
    layout = openMarkdownPreview(layout, '/repo/README.md', 'README.md', { beside: false });
    const html = renderWorkspace(layout);
    expect(html).not.toContain('editor-tab-directory');
    expect(html).not.toContain('aria-label="Open editors"');
  });
});
