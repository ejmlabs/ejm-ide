import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Search,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { isDesktop } from '@/lib/backend';
import { type ChatList, type ChatThread, chatTitle, mergeChatThreads } from '@/lib/chat-threads';
import { invokeAgent } from '@/lib/providers';
import { Button } from './ui/button';
import { Tooltip } from './ui/tooltip';
import './chat-threads.css';

interface Props {
  activeId: string | null;
  providerId: string;
  busy: boolean;
  changing: boolean;
  revision: number;
  onBack: () => void;
  onStop: () => void;
  onOpen: (threadId: string) => Promise<void>;
  onRename: (thread: ChatThread, title: string) => Promise<void>;
  onArchive: (thread: ChatThread, archived: boolean) => Promise<void>;
}

function updatedAt(seconds: number): string {
  const date = new Date(seconds * 1000);
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function ChatHistory(props: Props) {
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [renaming, setRenaming] = useState<{ thread: ChatThread; title: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const rename = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const operation = useRef(false);
  const canLoad = isDesktop;
  const { revision } = props;
  useEffect(() => {
    search.current?.focus();
  }, []);
  useEffect(() => {
    void renaming?.thread.id;
    rename.current?.focus();
    rename.current?.select();
  }, [renaming?.thread.id]);
  useEffect(() => {
    // Revision invalidates a list after a turn, rename, archive, or restore.
    void revision;
    void reload;
    const id = ++request.current;
    setCursor(null);
    setThreads([]);
    setError('');
    if (!canLoad) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(
      () => {
        void invokeAgent<ChatList>(props.providerId, 'agent_list_chats', {
          archived,
          search: query.trim() || undefined,
        })
          .then((page) => {
            if (request.current !== id) return;
            setThreads(page.data);
            setCursor(page.nextCursor);
          })
          .catch((error) => {
            if (request.current === id) setError(String(error));
          })
          .finally(() => {
            if (request.current === id) setLoading(false);
          });
      },
      query ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      request.current++;
    };
  }, [archived, query, revision, reload, props.providerId]);
  async function loadMore() {
    if (!cursor || loading) return;
    const id = request.current;
    setLoading(true);
    setError('');
    try {
      const page = await invokeAgent<ChatList>(props.providerId, 'agent_list_chats', {
        archived,
        search: query.trim() || undefined,
        cursor,
      });
      if (request.current !== id) return;
      setThreads((current) => mergeChatThreads(current, page.data));
      setCursor(page.nextCursor);
    } catch (error) {
      if (request.current === id) setError(String(error));
    } finally {
      if (request.current === id) setLoading(false);
    }
  }
  async function change(run: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setSaving(true);
    setError('');
    try {
      await run();
    } catch (error) {
      setError(String(error));
    } finally {
      operation.current = false;
      setSaving(false);
    }
  }
  async function open(thread: ChatThread) {
    if (props.busy) {
      setError('Stop the response before switching chats.');
      return;
    }
    await change(async () => {
      if (archived) await props.onArchive(thread, false);
      await props.onOpen(thread.id);
    });
  }
  const blocked = props.changing || saving;
  return (
    <section className="chat-history" aria-label="Chat history">
      <div className="chat-history-heading">
        <Tooltip label="Back to chat">
          <Button variant="ghost" size="icon" aria-label="Back to chat" onClick={props.onBack}>
            <ArrowLeft size={14} />
          </Button>
        </Tooltip>
        <strong>Chats</strong>
        <fieldset className="chat-history-tabs" aria-label="Chat status">
          <button type="button" aria-pressed={!archived} onClick={() => setArchived(false)}>
            Recent
          </button>
          <button type="button" aria-pressed={archived} onClick={() => setArchived(true)}>
            Archived
          </button>
        </fieldset>
      </div>
      <label className="chat-history-search">
        <Search size={13} />
        <input
          ref={search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search chats"
          aria-label="Search workspace chats"
        />
        {query && (
          <button type="button" onClick={() => setQuery('')} aria-label="Clear chat search">
            <X size={12} />
          </button>
        )}
      </label>
      {props.busy && (
        <div className="chat-history-notice">
          <span>Stop the response before switching chats.</span>
          <Button variant="ghost" size="sm" onClick={props.onStop}>
            <Square size={11} /> Stop
          </Button>
        </div>
      )}
      {error && (
        <div className="chat-history-error" role="alert">
          {error}
          <Button variant="ghost" size="sm" onClick={() => setReload((value) => value + 1)}>
            Retry
          </Button>
        </div>
      )}
      <div className="chat-history-list" aria-busy={loading || blocked}>
        {!canLoad ? (
          <p className="chat-history-empty">Open the desktop app to view local workspace chats.</p>
        ) : !threads.length && !loading && !error ? (
          <p className="chat-history-empty">
            {query.trim()
              ? 'No chats match your search.'
              : archived
                ? 'No archived chats in this workspace.'
                : 'Your chats will appear here after your first message.'}
          </p>
        ) : (
          threads.map((thread) => {
            const title = chatTitle(thread);
            return (
              <div
                className={`chat-history-row ${thread.id === props.activeId ? 'active' : ''}`}
                key={thread.id}
              >
                {renaming?.thread.id === thread.id ? (
                  <form
                    className="chat-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!renaming.title.trim() || saving) return;
                      void change(async () => {
                        await props.onRename(thread, renaming.title.trim());
                        setRenaming(null);
                      });
                    }}
                  >
                    <input
                      ref={rename}
                      aria-label="Chat name"
                      value={renaming.title}
                      maxLength={160}
                      disabled={saving}
                      onChange={(event) => setRenaming({ thread, title: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setRenaming(null);
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      type="submit"
                      aria-label="Save chat name"
                      disabled={!renaming.title.trim() || saving}
                    >
                      <Check size={13} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Cancel rename"
                      onClick={() => setRenaming(null)}
                      disabled={saving}
                    >
                      <X size={13} />
                    </Button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className="chat-history-open"
                      aria-current={thread.id === props.activeId ? 'true' : undefined}
                      title={archived ? `Restore and open ${title}` : title}
                      disabled={blocked || props.busy}
                      onClick={() => void open(thread)}
                    >
                      {archived ? <Archive size={14} /> : <MessageSquare size={14} />}
                      <span className="chat-history-copy">
                        <span className="chat-history-title">{title}</span>
                        <span className="chat-history-meta">
                          {thread.name?.trim() && thread.preview
                            ? thread.preview.split('\n')[0]
                            : updatedAt(thread.updatedAt)}
                        </span>
                      </span>
                    </button>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="chat-history-menu"
                          aria-label={`Options for ${title}`}
                          disabled={blocked}
                        >
                          <MoreHorizontal size={14} />
                        </Button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content className="dropdown-content" align="end">
                          <DropdownMenu.Item
                            className="dropdown-item"
                            onSelect={() => setRenaming({ thread, title })}
                          >
                            <Pencil size={13} />
                            Rename
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className="dropdown-item"
                            disabled={props.busy}
                            onSelect={() => void change(() => props.onArchive(thread, !archived))}
                          >
                            {archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                            {archived ? 'Restore' : 'Archive'}
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </>
                )}
              </div>
            );
          })
        )}
        {loading && (
          <div className="chat-history-loading" role="status">
            <LoaderCircle size={13} className="spin" />
            Loading chats
          </div>
        )}
        {cursor && !loading && (
          <Button
            variant="ghost"
            size="sm"
            className="chat-history-more"
            onClick={() => void loadMore()}
          >
            Load more chats
          </Button>
        )}
      </div>
    </section>
  );
}
