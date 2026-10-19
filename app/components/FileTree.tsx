import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileJson,
  Folder,
  FolderOpen,
  MessageSquarePlus,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@/lib/backend';
import { fileUri } from '@/lib/context';
import type { Entry, Workspace } from '@/lib/types';
import { languageId } from '@/lib/utils';
import { Button } from './ui/button';
import { Tooltip } from './ui/tooltip';

export function FileIcon({ path }: { path: string }) {
  if (path.endsWith('.rs')) return <FileCode2 size={15} className="file-rust" />;
  if (/\.tsx?$/.test(path)) return <span className="file-type file-typescript">TS</span>;
  if (/\.pyi?$/.test(path)) return <span className="file-type file-python">PY</span>;
  if (languageId(path) === 'ruby') return <span className="file-type file-ruby">RB</span>;
  if (path.endsWith('.go')) return <span className="file-type file-go">GO</span>;
  if (path.endsWith('.json')) return <FileJson size={15} className="file-json" />;
  return <File size={15} className="muted" />;
}

function TreeItem({
  entry,
  depth,
  activePath,
  onOpen,
  onAttach,
}: {
  entry: Entry;
  depth: number;
  activePath?: string;
  onOpen: (path: string) => void;
  onAttach: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth === 0 && entry.name === 'src');
  const [children, setChildren] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!expanded || entry.kind !== 'directory') return;
    let current = true;
    setError('');
    invoke<Entry[]>('workspace_entries', { path: entry.path })
      .then((entries) => {
        if (current) setChildren(entries);
      })
      .catch((reason) => {
        if (current) setError(String(reason));
      });
    return () => {
      current = false;
    };
  }, [expanded, entry.path, entry.kind]);
  const directory = entry.kind === 'directory';
  return (
    <li>
      <div
        className={`tree-row ${activePath === entry.path ? 'selected' : ''}`}
        style={{ paddingLeft: 10 + depth * 15 }}
      >
        <button
          type="button"
          className="tree-target"
          aria-expanded={directory ? expanded : undefined}
          aria-current={activePath === entry.path ? 'page' : undefined}
          onClick={() => (directory ? setExpanded(!expanded) : onOpen(entry.path))}
          title={entry.path}
          draggable={!directory}
          onDragStart={(event) =>
            event.dataTransfer.setData(
              'application/x-workbench-target',
              JSON.stringify({ uri: fileUri(entry.path), kind: 'file', label: entry.name }),
            )
          }
        >
          {directory ? (
            expanded ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )
          ) : (
            <span className="tree-chevron" />
          )}
          {directory ? (
            expanded ? (
              <FolderOpen size={15} />
            ) : (
              <Folder size={15} />
            )
          ) : (
            <FileIcon path={entry.path} />
          )}
          <span>{entry.name}</span>
        </button>
        {!directory && (
          <Tooltip label="Add file to chat" side="right">
            <Button
              className="tree-attach"
              variant="ghost"
              size="icon"
              aria-label={`Add ${entry.name} to chat`}
              onClick={() => onAttach(entry.path)}
            >
              <MessageSquarePlus size={14} />
            </Button>
          </Tooltip>
        )}
      </div>
      {expanded && directory && (
        <ul>
          {children.map((child) => (
            <TreeItem
              key={child.path}
              entry={child}
              depth={depth + 1}
              activePath={activePath}
              onOpen={onOpen}
              onAttach={onAttach}
            />
          ))}
          {error && <li className="inline-error">{error}</li>}
        </ul>
      )}
    </li>
  );
}
export function FileTree({
  workspace,
  activePath,
  onOpen,
  onAttach,
  onOpenFolder,
}: {
  workspace: Workspace | null;
  activePath?: string;
  onOpen: (path: string) => void;
  onAttach: (path: string) => void;
  onOpenFolder: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [entries, setEntries] = useState<Entry[]>([]);
  const currentWorkspace = useRef(workspace);
  currentWorkspace.current = workspace;
  const refresh = useCallback(async () => {
    if (!workspace) {
      setEntries([]);
      return;
    }
    try {
      const value = await invoke<Entry[]>('workspace_entries', { path: workspace.root });
      if (currentWorkspace.current === workspace) setEntries(value);
    } catch {
      if (currentWorkspace.current === workspace) setEntries(workspace.entries);
    }
  }, [workspace]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <section className="sidebar-panel" aria-label="Project files">
      <header className="panel-header">
        <span>Project</span>
        <div className="header-actions">
          <Tooltip label="Refresh files">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh files"
              onClick={() => {
                setRevision((x) => x + 1);
                void refresh();
              }}
            >
              <RefreshCw size={14} />
            </Button>
          </Tooltip>
          <Tooltip label="Open folder">
            <Button variant="ghost" size="icon" aria-label="Open folder" onClick={onOpenFolder}>
              <FolderOpen size={15} />
            </Button>
          </Tooltip>
        </div>
      </header>
      {workspace ? (
        <div className="tree-scroll">
          <div className="tree-root">
            <ChevronDown size={13} />
            <FolderOpen size={16} />
            <strong>{workspace.name}</strong>
          </div>
          <ul className="file-tree" aria-label={workspace.name} key={workspace.root + revision}>
            {entries.map((entry) => (
              <TreeItem
                key={entry.path}
                entry={entry}
                depth={0}
                activePath={activePath}
                onOpen={onOpen}
                onAttach={onAttach}
              />
            ))}
          </ul>
        </div>
      ) : (
        <div className="sidebar-empty">
          <FolderOpen size={27} />
          <p>Start with your code.</p>
          <Button variant="secondary" onClick={onOpenFolder}>
            Open folder
          </Button>
        </div>
      )}
    </section>
  );
}
