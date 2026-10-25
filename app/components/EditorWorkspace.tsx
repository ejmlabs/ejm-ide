import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tabs from '@radix-ui/react-tabs';
import {
  BookOpen,
  Check,
  ChevronDown,
  Columns2,
  FileDiff,
  MoreHorizontal,
  Plus,
  Rows2,
  X,
} from 'lucide-react';
import {
  type Dispatch,
  Fragment,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import {
  type EditorGroup,
  type EditorLayout,
  type EditorNode,
  type EditorSplit,
  type EditorTab,
  editorGroups,
  editorTabPath,
  MAX_EDITOR_GROUPS,
} from '@/lib/editor-workspace';
import { FileIcon } from './FileTree';
import { Button } from './ui/button';
import { Tooltip } from './ui/tooltip';
import './editor-workspace.css';

interface EditorWorkspaceProps {
  layout: EditorLayout;
  dirtyPaths: Set<string>;
  onFocus: (group: string, tab?: string, focusEditor?: boolean) => void;
  onClose: (group: string, tab: string) => void;
  onCloseTabs: (group: string, tabs: string[]) => void;
  onCloseGroup: (group: string) => void;
  onSplit: (
    group: string,
    direction: EditorSplit['direction'],
    tab?: string,
    move?: boolean,
  ) => void;
  onMove: (from: string, to: string, tab: string, before?: string) => void;
  onNew: (group: string) => void;
  renderContent: (group: EditorGroup, tab: EditorTab | undefined) => ReactNode;
  renderActions?: (group: EditorGroup, tab: EditorTab | undefined) => ReactNode;
  renderMenuActions?: (group: EditorGroup, tab: EditorTab | undefined) => ReactNode;
}

type TabDrag = { group: string; tab: string } | null;
type DropTarget = { group: string; edge: 'center' | 'right' | 'bottom'; before?: string } | null;

export function EditorWorkspace(props: EditorWorkspaceProps) {
  const [drag, setDrag] = useState<TabDrag>(null);
  const [drop, setDrop] = useState<DropTarget>(null);
  const groups = editorGroups(props.layout.root);
  const canSplit = groups.length < MAX_EDITOR_GROUPS;
  function renderNode(node: EditorNode): ReactNode {
    if (node.kind === 'split') {
      return (
        <Group key={node.id} orientation={node.direction} className="editor-split">
          {node.children.map((child, index) => (
            <Fragment key={child.id}>
              {index > 0 && (
                <Separator
                  className={`pane-separator ${node.direction === 'vertical' ? 'horizontal' : ''}`}
                />
              )}
              <Panel
                id={child.id}
                defaultSize="50%"
                minSize={node.direction === 'vertical' ? '140px' : '200px'}
              >
                {renderNode(child)}
              </Panel>
            </Fragment>
          ))}
        </Group>
      );
    }
    return (
      <EditorGroupView
        key={node.id}
        group={node}
        groups={groups}
        workspace={props}
        canSplit={canSplit}
        drag={drag}
        setDrag={setDrag}
        drop={drop}
        setDrop={setDrop}
      />
    );
  }
  return <div className="editor-workspace">{renderNode(props.layout.root)}</div>;
}

function EditorGroupView({
  group,
  groups,
  workspace,
  canSplit,
  drag,
  setDrag,
  drop,
  setDrop,
}: {
  group: EditorGroup;
  groups: EditorGroup[];
  workspace: EditorWorkspaceProps;
  canSplit: boolean;
  drag: TabDrag;
  setDrag: Dispatch<SetStateAction<TabDrag>>;
  drop: DropTarget;
  setDrop: Dispatch<SetStateAction<DropTarget>>;
}) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const active = group.activeTab ? workspace.layout.tabs[group.activeTab] : undefined;
  const focused = workspace.layout.activeGroup === group.id;
  const number = groups.findIndex((item) => item.id === group.id) + 1;
  const tabs = group.tabs.flatMap((id) => {
    const tab = workspace.layout.tabs[id];
    return tab ? [tab] : [];
  });
  useEffect(() => {
    const list = tabsRef.current;
    if (!list || !group.tabs.length) {
      setOverflowing(false);
      return;
    }
    const measure = () => setOverflowing(list.scrollWidth > list.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    for (const child of list.children) observer.observe(child);
    return () => observer.disconnect();
  }, [group.tabs]);
  useEffect(() => {
    if (!group.activeTab || !group.tabs.includes(group.activeTab)) return;
    const selected = tabsRef.current?.querySelector<HTMLElement>(
      '[role="tab"][data-state="active"]',
    );
    selected?.closest('.editor-tab')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [group.activeTab, group.tabs]);
  function finishDrag() {
    setDrag(null);
    setDrop(null);
  }
  function dropTab(event: React.DragEvent, before?: string) {
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    workspace.onMove(drag.group, group.id, drag.tab, before);
    finishDrag();
  }
  function contentDropTarget(event: React.DragEvent<HTMLDivElement>): NonNullable<DropTarget> {
    const bounds = event.currentTarget.getBoundingClientRect();
    const canDropSplit = canSplit && drag?.group === group.id;
    const right = canDropSplit && event.clientX - bounds.left > bounds.width * 0.75;
    const bottom = canDropSplit && event.clientY - bounds.top > bounds.height * 0.75;
    return { group: group.id, edge: right ? 'right' : bottom ? 'bottom' : 'center' };
  }
  return (
    <Tabs.Root
      asChild
      value={group.activeTab ?? ''}
      onValueChange={(tab) => workspace.onFocus(group.id, tab, false)}
    >
      <section
        className={`editor-group ${focused ? 'focused' : ''}`}
        aria-label={`Editor group ${number}`}
        onFocusCapture={() => {
          if (!focused) workspace.onFocus(group.id, undefined, false);
        }}
      >
        <div className="editor-group-header">
          <Tabs.List
            ref={tabsRef}
            className="editor-tabs"
            aria-label={`Open editors in group ${number}`}
          >
            {tabs.map((tab, index) => (
              <EditorTabItem
                key={tab.id}
                tab={tab}
                detail={tabDirectory(tab, Object.values(workspace.layout.tabs))}
                active={group.activeTab === tab.id}
                dirty={tab.kind === 'file' && workspace.dirtyPaths.has(tab.path)}
                dropBefore={drop?.group === group.id && drop.before === tab.id}
                canSplit={canSplit}
                groups={groups
                  .map((item, groupIndex) => ({ ...item, number: groupIndex + 1 }))
                  .filter((item) => item.id !== group.id)}
                onSelect={() => workspace.onFocus(group.id, tab.id, false)}
                onOpen={() => workspace.onFocus(group.id, tab.id, true)}
                onClose={() => workspace.onClose(group.id, tab.id)}
                onCloseOthers={() =>
                  workspace.onCloseTabs(
                    group.id,
                    group.tabs.filter((id) => id !== tab.id),
                  )
                }
                onCloseRight={() => workspace.onCloseTabs(group.id, group.tabs.slice(index + 1))}
                hasOthers={tabs.length > 1}
                hasRight={index < tabs.length - 1}
                onSplit={(direction) => workspace.onSplit(group.id, direction, tab.id)}
                onMove={(target) => workspace.onMove(group.id, target, tab.id)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('application/x-workbench-editor', tab.id);
                  setDrag({ group: group.id, tab: tab.id });
                }}
                onDragEnd={finishDrag}
                onDrop={(event) => dropTab(event, tab.id)}
                onDragOver={(event) => {
                  if (!drag) return;
                  event.preventDefault();
                  setDrop({ group: group.id, edge: 'center', before: tab.id });
                }}
              />
            ))}
            <button
              className="editor-tab-space"
              type="button"
              tabIndex={-1}
              aria-label="Double click to create a new editor"
              title="Double click for a new file"
              onClick={() => workspace.onFocus(group.id)}
              onDoubleClick={() => workspace.onNew(group.id)}
              onDragOver={(event) => {
                if (!drag) return;
                event.preventDefault();
                setDrop({ group: group.id, edge: 'center' });
              }}
              onDrop={(event) => dropTab(event)}
            />
          </Tabs.List>
          <div className="editor-group-actions">
            {overflowing && (
              <DropdownMenu.Root>
                <Tooltip label="Open editors">
                  <DropdownMenu.Trigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Open editors">
                      <ChevronDown size={14} />
                    </Button>
                  </DropdownMenu.Trigger>
                </Tooltip>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="dropdown-content editor-open-menu"
                    align="end"
                    sideOffset={4}
                  >
                    <DropdownMenu.Label className="dropdown-label">Open editors</DropdownMenu.Label>
                    {tabs.map((tab) => (
                      <DropdownMenu.Item
                        className="dropdown-item"
                        key={tab.id}
                        onSelect={() => workspace.onFocus(group.id, tab.id)}
                      >
                        <span className="editor-menu-check">
                          {group.activeTab === tab.id && <Check size={13} />}
                        </span>
                        <TabIcon tab={tab} />
                        <span className="editor-open-name">{tabLabel(tab)}</span>
                        {tab.kind === 'file' && workspace.dirtyPaths.has(tab.path) && (
                          <span className="unsaved-dot" />
                        )}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
            {workspace.renderActions?.(group, active)}
            <Tooltip label="Split editor right">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Split editor right"
                disabled={!canSplit}
                onClick={() => workspace.onSplit(group.id, 'horizontal')}
              >
                <Columns2 size={14} />
              </Button>
            </Tooltip>
            <DropdownMenu.Root>
              <Tooltip label="Editor actions">
                <DropdownMenu.Trigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Editor group actions">
                    <MoreHorizontal size={14} />
                  </Button>
                </DropdownMenu.Trigger>
              </Tooltip>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="dropdown-content editor-tab-menu"
                  align="end"
                  sideOffset={4}
                >
                  {workspace.renderMenuActions?.(group, active)}
                  <DropdownMenu.Item
                    className="dropdown-item"
                    onSelect={() => workspace.onNew(group.id)}
                  >
                    <Plus size={13} />
                    New file<span className="editor-menu-key">⌘ N</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="dropdown-item"
                    disabled={!canSplit}
                    onSelect={() => workspace.onSplit(group.id, 'horizontal')}
                  >
                    <Columns2 size={13} />
                    Split right<span className="editor-menu-key">⌘ \</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="dropdown-item"
                    disabled={!canSplit}
                    onSelect={() => workspace.onSplit(group.id, 'vertical')}
                  >
                    <Rows2 size={13} />
                    Split down
                  </DropdownMenu.Item>
                  {groups.length > 1 && (
                    <>
                      <DropdownMenu.Separator className="dropdown-separator" />
                      <DropdownMenu.Item
                        className="dropdown-item"
                        onSelect={() => workspace.onCloseGroup(group.id)}
                      >
                        <X size={13} />
                        Close group
                      </DropdownMenu.Item>
                    </>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
        <Tabs.Content value={group.activeTab ?? ''} asChild>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Drag has equivalent keyboard-accessible move and split menu actions. */}
          <div
            className="editor-group-content"
            onDragOver={(event) => {
              if (!drag) return;
              event.preventDefault();
              setDrop(contentDropTarget(event));
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
            }}
            onDrop={(event) => {
              if (!drag) return;
              event.preventDefault();
              const target = contentDropTarget(event);
              if (target.edge !== 'center') {
                workspace.onSplit(
                  group.id,
                  target.edge === 'right' ? 'horizontal' : 'vertical',
                  drag.tab,
                  true,
                );
              } else workspace.onMove(drag.group, group.id, drag.tab);
              finishDrag();
            }}
          >
            {workspace.renderContent(group, active)}
            {drag && drop?.group === group.id && !drop.before && (
              <div className={`editor-drop-hint ${drop.edge}`}>
                <span>
                  {drop.edge === 'right'
                    ? 'Split right'
                    : drop.edge === 'bottom'
                      ? 'Split down'
                      : 'Move editor here'}
                </span>
              </div>
            )}
          </div>
        </Tabs.Content>
      </section>
    </Tabs.Root>
  );
}

function tabLabel(tab: EditorTab): string {
  return tab.kind === 'markdown-preview' ? `${tab.title} preview` : tab.title;
}

function tabDirectory(tab: EditorTab, tabs: EditorTab[]): string | undefined {
  const path = editorTabPath(tab);
  if (!path) return undefined;
  const others = tabs.flatMap((other) => {
    const otherPath = editorTabPath(other);
    return other.title === tab.title && otherPath && otherPath !== path ? [otherPath] : [];
  });
  if (!others.length) return undefined;
  const directory = path.split('/').slice(0, -1);
  for (let length = 1; length <= directory.length; length++) {
    const suffix = directory.slice(-length).join('/');
    if (others.every((other) => other.split('/').slice(0, -1).slice(-length).join('/') !== suffix))
      return suffix;
  }
  return directory.join('/');
}

function TabIcon({ tab }: { tab: EditorTab }) {
  if (tab.kind === 'diff' || tab.kind === 'proposal-diff') return <FileDiff size={14} />;
  if (tab.kind === 'markdown-preview') return <BookOpen size={14} />;
  return <FileIcon path={tab.path} />;
}

function EditorTabItem({
  tab,
  detail,
  active,
  dirty,
  dropBefore,
  canSplit,
  groups,
  hasOthers,
  hasRight,
  onSelect,
  onOpen,
  onClose,
  onCloseOthers,
  onCloseRight,
  onSplit,
  onMove,
  onDragStart,
  onDragEnd,
  onDrop,
  onDragOver,
}: {
  tab: EditorTab;
  detail: string | undefined;
  active: boolean;
  dirty: boolean;
  dropBefore: boolean;
  canSplit: boolean;
  groups: (EditorGroup & { number: number })[];
  hasOthers: boolean;
  hasRight: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseRight: () => void;
  onSplit: (direction: EditorSplit['direction']) => void;
  onMove: (group: string) => void;
  onDragStart: React.DragEventHandler;
  onDragEnd: React.DragEventHandler;
  onDrop: React.DragEventHandler;
  onDragOver: React.DragEventHandler;
}) {
  const label = tabLabel(tab);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Tabs and the context menu provide keyboard alternatives to dragging and middle click. */}
        <div
          className={`editor-tab ${active ? 'active' : ''} ${dirty ? 'dirty' : ''} ${dropBefore ? 'drop-before' : ''}`}
          draggable
          onContextMenu={onSelect}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              onClose();
            }
          }}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDrop={onDrop}
          onDragOver={onDragOver}
        >
          <Tabs.Trigger
            value={tab.id}
            onClick={onOpen}
            title={`${editorTabPath(tab) ?? tab.title}${tab.kind === 'markdown-preview' ? ' (Preview)' : ''}`}
            aria-label={`${label}${dirty ? ' (unsaved)' : ''}`}
          >
            <TabIcon tab={tab} />
            <span className="editor-tab-name">{tab.title}</span>
            {tab.kind === 'markdown-preview' && <span className="editor-tab-kind">Preview</span>}
            {tab.kind === 'diff' && <span className="editor-tab-kind">Changes</span>}
            {tab.kind === 'proposal-diff' && <span className="editor-tab-kind">Proposal</span>}
            {detail && <span className="editor-tab-directory">{detail}</span>}
          </Tabs.Trigger>
          <button
            type="button"
            tabIndex={-1}
            className="tab-close"
            aria-label={`Close ${label}${dirty ? ' (unsaved)' : ''}`}
            onClick={onClose}
          >
            {dirty && <span className="unsaved-dot" />}
            <X size={13} />
          </button>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="dropdown-content editor-tab-menu">
          <ContextMenu.Item className="dropdown-item" onSelect={onClose}>
            <X size={13} />
            Close editor<span className="editor-menu-key">⌘ W</span>
          </ContextMenu.Item>
          <ContextMenu.Item
            className="dropdown-item"
            disabled={!hasOthers}
            onSelect={onCloseOthers}
          >
            Close others
          </ContextMenu.Item>
          <ContextMenu.Item className="dropdown-item" disabled={!hasRight} onSelect={onCloseRight}>
            Close to the right
          </ContextMenu.Item>
          <ContextMenu.Separator className="dropdown-separator" />
          <ContextMenu.Item
            className="dropdown-item"
            disabled={!canSplit}
            onSelect={() => onSplit('horizontal')}
          >
            <Columns2 size={13} />
            Split right
          </ContextMenu.Item>
          <ContextMenu.Item
            className="dropdown-item"
            disabled={!canSplit}
            onSelect={() => onSplit('vertical')}
          >
            <Rows2 size={13} />
            Split down
          </ContextMenu.Item>
          {groups.length > 0 && <ContextMenu.Separator className="dropdown-separator" />}
          {groups.map((group) => (
            <ContextMenu.Item
              className="dropdown-item"
              key={group.id}
              onSelect={() => onMove(group.id)}
            >
              Move to group {group.number}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
