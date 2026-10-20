import { fileUri, uriPath } from './context';
import type { GitDiffRequest } from './git';

export type EditorTab =
  | { id: string; kind: 'file'; path: string; title: string }
  | { id: string; kind: 'markdown-preview'; path: string; title: string }
  | { id: string; kind: 'diff'; request: GitDiffRequest; title: string }
  | {
      id: string;
      kind: 'proposal-diff';
      title: string;
      path: string;
      before: string;
      after: string;
      reviewId: string;
      connectionId?: number;
    };
export interface EditorGroup {
  kind: 'group';
  id: string;
  tabs: string[];
  activeTab: string | null;
}
export interface EditorSplit {
  kind: 'split';
  id: string;
  direction: 'horizontal' | 'vertical';
  children: [EditorNode, EditorNode];
}
export type EditorNode = EditorGroup | EditorSplit;
export interface EditorLayout {
  root: EditorNode;
  activeGroup: string;
  tabs: Record<string, EditorTab>;
}
export const MAX_EDITOR_GROUPS = 8;
export function createEditorLayout(): EditorLayout {
  return {
    root: { kind: 'group', id: 'editor-main', tabs: [], activeTab: null },
    activeGroup: 'editor-main',
    tabs: {},
  };
}
export function editorGroups(node: EditorNode): EditorGroup[] {
  return node.kind === 'group' ? [node] : node.children.flatMap(editorGroups);
}
export function activeEditorTab(layout: EditorLayout): EditorTab | undefined {
  const group = editorGroups(layout.root).find((item) => item.id === layout.activeGroup);
  return group?.activeTab ? layout.tabs[group.activeTab] : undefined;
}
function mapGroups(node: EditorNode, update: (group: EditorGroup) => EditorNode): EditorNode {
  return node.kind === 'group'
    ? update(node)
    : {
        ...node,
        children: node.children.map((child) => mapGroups(child, update)) as [
          EditorNode,
          EditorNode,
        ],
      };
}
function pruneEmpty(node: EditorNode): EditorNode | null {
  if (node.kind === 'group') return node.tabs.length ? node : null;
  const [first, second] = node.children.map(pruneEmpty);
  if (!first) return second;
  if (!second) return first;
  return { ...node, children: [first, second] };
}
function cleanLayout(layout: EditorLayout): EditorLayout {
  const root = pruneEmpty(layout.root) || createEditorLayout().root;
  const groups = editorGroups(root);
  const used = new Set(groups.flatMap((group) => group.tabs));
  return {
    root,
    activeGroup: groups.some((group) => group.id === layout.activeGroup)
      ? layout.activeGroup
      : groups[0].id,
    tabs: Object.fromEntries(Object.entries(layout.tabs).filter(([id]) => used.has(id))),
  };
}
export function openEditorTab(
  layout: EditorLayout,
  tab: EditorTab,
  groupId = layout.activeGroup,
): EditorLayout {
  const target = editorGroups(layout.root).find((group) => group.id === groupId);
  if (!target) return layout;
  return {
    ...layout,
    activeGroup: groupId,
    tabs: { ...layout.tabs, [tab.id]: tab },
    root: mapGroups(layout.root, (group) =>
      group.id === groupId
        ? {
            ...group,
            tabs: group.tabs.includes(tab.id) ? group.tabs : [...group.tabs, tab.id],
            activeTab: tab.id,
          }
        : group,
    ),
  };
}
export function focusEditorGroup(
  layout: EditorLayout,
  groupId: string,
  tabId?: string,
): EditorLayout {
  const target = editorGroups(layout.root).find((group) => group.id === groupId);
  if (!target || (tabId && !target.tabs.includes(tabId))) return layout;
  return {
    ...layout,
    activeGroup: groupId,
    root: mapGroups(layout.root, (group) =>
      group.id === groupId && tabId ? { ...group, activeTab: tabId } : group,
    ),
  };
}
export function closeEditorTab(layout: EditorLayout, groupId: string, tabId: string): EditorLayout {
  return cleanLayout({
    ...layout,
    root: mapGroups(layout.root, (group) => {
      if (group.id !== groupId || !group.tabs.includes(tabId)) return group;
      const index = group.tabs.indexOf(tabId);
      const tabs = group.tabs.filter((id) => id !== tabId);
      return {
        ...group,
        tabs,
        activeTab:
          group.activeTab === tabId
            ? tabs[Math.min(index, tabs.length - 1)] || null
            : group.activeTab,
      };
    }),
  });
}
export function closeEditorGroup(layout: EditorLayout, groupId: string): EditorLayout {
  return cleanLayout({
    ...layout,
    root: mapGroups(layout.root, (group) =>
      group.id === groupId ? { ...group, tabs: [], activeTab: null } : group,
    ),
  });
}
export function moveEditorTab(
  layout: EditorLayout,
  from: string,
  to: string,
  tabId: string,
  beforeId?: string,
): EditorLayout {
  if (from === to && beforeId === tabId) return layout;
  const groups = editorGroups(layout.root);
  if (
    !groups.some((group) => group.id === from && group.tabs.includes(tabId)) ||
    !groups.some((group) => group.id === to)
  )
    return layout;
  const root = mapGroups(layout.root, (group) => {
    if (group.id !== from && group.id !== to) return group;
    const tabs = group.tabs.filter((id) => id !== tabId);
    if (group.id === to) {
      const index = beforeId ? tabs.indexOf(beforeId) : -1;
      tabs.splice(index < 0 ? tabs.length : index, 0, tabId);
      return { ...group, tabs, activeTab: tabId };
    }
    return {
      ...group,
      tabs,
      activeTab: group.activeTab === tabId ? tabs.at(-1) || null : group.activeTab,
    };
  });
  return cleanLayout({ ...layout, root, activeGroup: to });
}
export function splitEditorGroup(
  layout: EditorLayout,
  groupId: string,
  direction: EditorSplit['direction'],
  newGroupId: string,
  tabId?: string,
  move = false,
): EditorLayout {
  const groups = editorGroups(layout.root);
  const target = groups.find((group) => group.id === groupId);
  if (
    !target ||
    groups.length >= MAX_EDITOR_GROUPS ||
    groups.some((group) => group.id === newGroupId)
  )
    return layout;
  const chosen = tabId || target.activeTab;
  if (chosen && !target.tabs.includes(chosen)) return layout;
  const root = mapGroups(layout.root, (group) => {
    if (group.id !== groupId) return group;
    const tabs = move && chosen ? group.tabs.filter((id) => id !== chosen) : group.tabs;
    return {
      kind: 'split',
      id: `split-${newGroupId}`,
      direction,
      children: [
        {
          ...group,
          tabs,
          activeTab: tabs.includes(group.activeTab || '') ? group.activeTab : tabs.at(-1) || null,
        },
        { kind: 'group', id: newGroupId, tabs: chosen ? [chosen] : [], activeTab: chosen || null },
      ],
    };
  });
  // Keep a deliberate empty split until a tab is opened or the group is closed.
  return { ...layout, root, activeGroup: newGroupId };
}
export function editorTabPath(tab: EditorTab | undefined): string | undefined {
  return tab && (tab.kind === 'file' || tab.kind === 'markdown-preview') ? tab.path : undefined;
}
export function editorDocumentPaths(layout: EditorLayout): Set<string> {
  return new Set(
    Object.values(layout.tabs).flatMap((tab) => {
      const path = editorTabPath(tab);
      return path ? [path] : [];
    }),
  );
}
export function editorClosingPaths(layout: EditorLayout, next: EditorLayout): Set<string> {
  const retained = editorDocumentPaths(next);
  return new Set([...editorDocumentPaths(layout)].filter((path) => !retained.has(path)));
}
export function markdownPreviewTab(
  path: string,
  title: string,
): Extract<EditorTab, { kind: 'markdown-preview' }> {
  return { id: `markdown-preview:${path}`, kind: 'markdown-preview', path, title };
}
export function openMarkdownPreview(
  layout: EditorLayout,
  path: string,
  title: string,
  options: { groupId?: string; beside?: boolean; newGroupId?: string } = {},
): EditorLayout {
  const groups = editorGroups(layout.root);
  const groupId = options.groupId ?? layout.activeGroup;
  const target = groups.find((group) => group.id === groupId);
  if (!target) return layout;
  const existing = Object.values(layout.tabs).find(
    (tab) => tab.kind === 'markdown-preview' && tab.path === path,
  );
  const existingElsewhere =
    existing && groups.find((group) => group.id !== groupId && group.tabs.includes(existing.id));
  if (existingElsewhere && existing)
    return focusEditorGroup(layout, existingElsewhere.id, existing.id);
  const preview = existing ?? markdownPreviewTab(path, title);
  const opened = openEditorTab(layout, preview, groupId);
  if (options.beside === false || !target.tabs.some((id) => id !== preview.id)) return opened;
  // Preview placement is product behavior. The shared split reducer preserves
  // tab identity, growth limits, and source selection when the preview moves.
  const newGroupId = options.newGroupId;
  if (
    !newGroupId ||
    groups.length >= MAX_EDITOR_GROUPS ||
    groups.some((group) => group.id === newGroupId)
  )
    return opened;
  const split = splitEditorGroup(opened, groupId, 'horizontal', newGroupId, preview.id, true);
  const sourceTab =
    target.activeTab !== preview.id
      ? target.activeTab
      : (target.tabs.find((id) => {
          const tab = layout.tabs[id];
          return tab?.kind === 'file' && tab.path === path;
        }) ?? target.tabs.find((id) => id !== preview.id));
  if (sourceTab)
    return focusEditorGroup(focusEditorGroup(split, groupId, sourceTab), newGroupId, preview.id);
  return split;
}

export function replaceEditorFile(
  layout: EditorLayout,
  oldPath: string,
  path: string,
  title: string,
): EditorLayout {
  const previous = Object.values(layout.tabs).filter((tab) => editorTabPath(tab) === oldPath);
  if (!previous.length) return layout;
  return {
    ...layout,
    tabs: Object.fromEntries(
      Object.entries(layout.tabs).map(([id, tab]) => [
        id,
        (tab.kind === 'file' || tab.kind === 'markdown-preview') && tab.path === oldPath
          ? { ...tab, path, title }
          : tab,
      ]),
    ),
  };
}
export function fileEditorTab(path: string, title: string): Extract<EditorTab, { kind: 'file' }> {
  return { id: `file:${path}`, kind: 'file', path, title };
}
export function diffEditorTab(
  request: GitDiffRequest,
  title: string,
): Extract<EditorTab, { kind: 'diff' }> {
  return { id: `diff:${JSON.stringify(request)}`, kind: 'diff', request, title };
}
export function proposalDiffTab(proposal: {
  reviewId: string;
  path: string;
  before: string;
  after: string;
  connectionId?: number;
}): Extract<EditorTab, { kind: 'proposal-diff' }> {
  return {
    id: `proposal:${proposal.reviewId}`,
    kind: 'proposal-diff',
    title: proposal.path,
    path: proposal.path,
    before: proposal.before,
    after: proposal.after,
    reviewId: proposal.reviewId,
    connectionId: proposal.connectionId,
  };
}
export function isGitDiffTab(tab: EditorTab): boolean {
  return tab.kind === 'diff';
}
export function isUntitled(path: string): boolean {
  return path.startsWith('untitled:');
}
export function editorModelUri(path: string): string {
  return isUntitled(path) ? path.replace(/^untitled:\/*/, 'untitled:/') : fileUri(path);
}
export function editorPathMatches(path: string, uri: string | undefined): boolean {
  if (!uri) return false;
  return isUntitled(path)
    ? editorModelUri(path) === uri.replace(/^untitled:\/*/, 'untitled:/')
    : uri.startsWith('file:') && uriPath(uri) === path;
}
export function resolveNewFilePath(root: string, input: string): string {
  const path = input.trim();
  const parts = path.split('/');
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    [...path].some((character) => character.charCodeAt(0) < 32) ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Enter a path inside this workspace, such as src/example.ts.');
  }
  return `${root.replace(/\/$/, '')}/${path}`;
}
