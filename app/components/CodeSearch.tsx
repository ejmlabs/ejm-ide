import {
  Braces,
  Heading,
  LoaderCircle,
  MessageSquarePlus,
  Network,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isDesktop, onEvent } from '@/lib/backend';
import { type IndexHit, type IndexStatus, indexReference } from '@/lib/code-index';
import { fileUri, makeReference } from '@/lib/context';
import type { CallHierarchy, ContextReference, SearchMatch, Workspace } from '@/lib/types';
import { basename, relativePath } from '@/lib/utils';
import { Button } from './ui/button';
import { Tooltip } from './ui/tooltip';

interface Props {
  workspace: Workspace | null;
  onOpen: (reference: ContextReference) => void;
  onAttach: (reference: ContextReference) => void;
  onGraph: (hierarchy: CallHierarchy) => void;
  onError: (message: string) => void;
}

export function CodeSearch({ workspace, onOpen, onAttach, onGraph, onError }: Props) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'code' | 'text'>('code');
  const [hits, setHits] = useState<IndexHit[]>([]);
  const [textHits, setTextHits] = useState<SearchMatch[]>([]);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const root = workspace?.root;
  const rootRef = useRef(root);
  rootRef.current = root;
  const mounted = useRef(true);
  const refreshPending = useRef(false);
  const refreshTask = useRef<Promise<void> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(() => {
    if (!isDesktop || !root) return Promise.resolve();
    refreshPending.current = true;
    if (refreshTask.current) return refreshTask.current;
    const task = (async () => {
      setRefreshing(true);
      const deadline = Date.now() + 35_000;
      while (refreshPending.current && mounted.current && rootRef.current === root) {
        refreshPending.current = false;
        try {
          const value = await invoke<IndexStatus>('index_refresh');
          if (mounted.current && rootRef.current === root && value.root === root) {
            setStatus(value);
            setRevision((value) => value + 1);
          }
        } catch (error) {
          if (!mounted.current || rootRef.current !== root) break;
          if (String(error).includes('already running') && Date.now() < deadline) {
            refreshPending.current = true;
            await new Promise((resolve) => setTimeout(resolve, 500));
          } else {
            refreshPending.current = false;
            onError(String(error));
          }
        }
      }
    })().finally(() => {
      refreshTask.current = null;
      if (mounted.current && rootRef.current === root) setRefreshing(false);
    });
    refreshTask.current = task;
    return task;
  }, [root, onError]);
  useEffect(() => {
    if (!isDesktop || !root) return;
    let live = true;
    void refresh();
    void invoke<IndexStatus>('index_status')
      .then((value) => {
        if (live) setStatus(value);
      })
      .catch((error) => onError(String(error)));
    let unsubscribe: (() => void) | undefined;
    void onEvent<IndexStatus>('index:changed', (value) => {
      if (live && value.root === root) {
        setStatus(value);
        setRevision((value) => value + 1);
      }
    })
      .then((off) => {
        if (live) unsubscribe = off;
        else off();
      })
      .catch((error) => onError(String(error)));
    const changed = () => {
      void refresh();
    };
    window.addEventListener('workbench:files-changed', changed);
    return () => {
      live = false;
      unsubscribe?.();
      window.removeEventListener('workbench:files-changed', changed);
    };
  }, [root, onError, refresh]);
  useEffect(() => {
    const generation = revision;
    if (!root || !query.trim()) {
      setHits([]);
      setTextHits([]);
      setLoading(false);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      setLoading(true);
      const request =
        mode === 'code' && isDesktop
          ? invoke<IndexHit[]>('index_search', { query, limit: 40 }).then((value) => {
              if (live && generation === revisionRef.current) setHits(value);
            })
          : invoke<SearchMatch[]>('workspace_search', { query }).then((value) => {
              if (live && generation === revisionRef.current) setTextHits(value);
            });
      void request
        .catch((error) => {
          if (live) onError(String(error));
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [root, query, mode, onError, revision]);
  function showGraph(hit: IndexHit) {
    onGraph({
      root: {
        name: hit.qualifiedName || hit.name || basename(hit.path),
        kind: 12,
        uri: hit.uri,
        range: hit.range,
        selectionRange: hit.selectionRange || hit.range,
        version: hit.version,
        data: { indexId: hit.id },
      },
      incoming: [],
      outgoing: [],
      origin: 'index',
    });
  }
  const codeMode = mode === 'code' && isDesktop;
  return (
    <section className="sidebar-panel code-search">
      <header className="panel-header">
        <span>Search</span>
        <Tooltip label="Refresh code index">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh code index"
            disabled={refreshing || !isDesktop}
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} className={refreshing ? 'spin' : ''} />
          </Button>
        </Tooltip>
      </header>
      <div className="sidebar-search">
        <Search size={14} />
        <input
          aria-label="Search workspace"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find code, symbols, paths…"
        />
      </div>
      <fieldset className="search-modes" aria-label="Search mode">
        <button type="button" aria-pressed={mode === 'code'} onClick={() => setMode('code')}>
          Code
        </button>
        <button type="button" aria-pressed={mode === 'text'} onClick={() => setMode('text')}>
          Text
        </button>
        <span>
          {loading ? (
            <LoaderCircle size={11} className="spin" />
          ) : query.trim() ? (
            `${codeMode ? hits.length : textHits.length} results`
          ) : (
            ''
          )}
        </span>
      </fieldset>
      <div className="search-results">
        {codeMode
          ? hits.map((hit) => (
              <div className="index-result" key={hit.id}>
                <button
                  type="button"
                  draggable
                  onDragStart={(event) =>
                    event.dataTransfer.setData(
                      'application/x-workbench-reference',
                      JSON.stringify(indexReference(hit)),
                    )
                  }
                  title={hit.reasons.join(' · ')}
                  onClick={() => onOpen(indexReference(hit))}
                >
                  <span>
                    {hit.symbolKind === 'heading' ? <Heading size={12} /> : <Braces size={12} />}
                    {hit.qualifiedName || hit.name || basename(hit.path)}
                  </span>
                  <small>
                    {hit.symbolKind === 'heading' ? 'Heading · ' : ''}
                    {relativePath(hit.path, root || '')}:{hit.range.start.line + 1}
                  </small>
                  <code>{hit.content.trim().slice(0, 160)}</code>
                </button>
                <div className="index-result-actions">
                  {hit.kind === 'symbol' && hit.symbolKind !== 'heading' && (
                    <Tooltip label="Show call graph">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Show graph for ${hit.name || basename(hit.path)}`}
                        onClick={() => showGraph(hit)}
                      >
                        <Network size={13} />
                      </Button>
                    </Tooltip>
                  )}
                  <Tooltip label="Add search result to chat">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Add ${hit.name || basename(hit.path)} to chat`}
                      onClick={() => onAttach(indexReference(hit))}
                    >
                      <MessageSquarePlus size={13} />
                    </Button>
                  </Tooltip>
                </div>
              </div>
            ))
          : textHits.map((hit) => {
              const reference = makeReference({
                kind: 'file',
                label: `${basename(hit.path)}:${hit.line}`,
                origin: 'Text search',
                uri: fileUri(hit.path),
                content: hit.text,
                ranges: [
                  {
                    start: { line: hit.line - 1, character: 0 },
                    end: { line: hit.line - 1, character: hit.text.length },
                  },
                ],
              });
              return (
                <div className="index-result" key={`${hit.path}:${hit.line}`}>
                  <button type="button" onClick={() => onOpen(reference)}>
                    <span>
                      {relativePath(hit.path, root || '')}:{hit.line}
                    </span>
                    <code>{hit.text}</code>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Add ${basename(hit.path)} line ${hit.line} to chat`}
                    onClick={() => onAttach(reference)}
                  >
                    <MessageSquarePlus size={13} />
                  </Button>
                </div>
              );
            })}
        {!query.trim() && (
          <div className="sidebar-empty">
            <Search size={22} />
            <p>Find symbols, code, and related calls.</p>
          </div>
        )}
        {!!query.trim() && !loading && !(codeMode ? hits.length : textHits.length) && (
          <div className="sidebar-empty">
            <p>No results found.</p>
          </div>
        )}
      </div>
      <footer
        className="index-status"
        title={
          status?.lastError ||
          `${status?.edges || 0} call links, ${status?.verifiedEdges || 0} verified by a language server`
        }
      >
        {!isDesktop
          ? 'Text search preview'
          : refreshing || status?.state === 'indexing'
            ? 'Indexing code…'
            : status?.state === 'error'
              ? 'Index needs attention'
              : `${status?.files || 0} files · ${status?.symbols || 0} symbols`}
        {status?.limited && <span>Index size limit reached</span>}
      </footer>
    </section>
  );
}
