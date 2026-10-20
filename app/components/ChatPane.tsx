import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  AtSign,
  ChevronDown,
  Command,
  FileCode2,
  GitBranch,
  History,
  LoaderCircle,
  MessageSquarePlus,
  Plus,
  RotateCcw,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isDesktop, onEvent } from '@/lib/backend';
import type { ChatPresentation } from '@/lib/chat-blocks';
import {
  type ChatIdentity,
  type ChatList,
  type ChatMessage,
  type ChatThread,
  type ChatTurn,
  chatTitle,
  hydrateChat,
  mergeChatMessages,
  type OpenChat,
  routeChatEvent,
  upsertChatTool,
} from '@/lib/chat-threads';
import { type ChatTokenUsage, parseChatUsage } from '@/lib/chat-usage';
import { MAX_CONTEXT, MAX_REFERENCE, makeReference, serializePrompt } from '@/lib/context';
import {
  type AgentDefaults,
  type AgentModel,
  type AgentSelection,
  eventMatchesProvider,
  invokeAgent,
  listProviders,
  type ProviderProfile,
  providerModelFallback,
  selectionForProvider,
} from '@/lib/providers';
import { finishToolActivity, toolActivity } from '@/lib/tool-calls';
import type { AgentEvent, ContextReference, SourceRange } from '@/lib/types';
import {
  approvalActivity,
  approvalStatusFromReview,
  parseWriteApproval,
  type WriteApproval,
} from '@/lib/write-approval';
import { ToolCall } from './AgentPresentation';
import { ChatBlocks } from './ChatBlocks';
import { ChatHistory } from './ChatHistory';
import { ChatRecovery, ChatSetup } from './ChatRecovery';
import { ChatUsage } from './ChatUsage';
import { ModelPicker } from './ModelPicker';
import { ProviderSettings } from './ProviderSettings';
import { Button } from './ui/button';
import { Tooltip } from './ui/tooltip';
import { WriteApprovalCard } from './WriteApprovalCard';

export interface ChatDisplay extends ChatPresentation {
  revision: string;
}

interface ConnectionResult {
  connected: boolean;
  authenticated: boolean;
  account: { type: string | null; planType?: string | null } | null;
  models?: AgentModel[];
  defaults?: AgentDefaults;
  modelError?: string | null;
}
interface AttachmentTarget {
  uri: string;
  ranges?: SourceRange[];
  kind?: ContextReference['kind'];
  label?: string;
  prefix?: string;
  version?: string;
}
interface Props {
  workspaceRoot?: string;
  providerSettingsOpen: boolean;
  onProviderSettingsOpenChange: (open: boolean) => void;
  presentations: ChatDisplay[];
  onDismissPresentation: (id: string) => void;
  onResetPresentations: () => void;
  onChatChange: (threadId: string | null, connectionId?: number | null) => void;
  references: ContextReference[];
  onRemove: (id: string) => void;
  onClear: () => void;
  onUpdate: (ref: ContextReference) => void;
  isStale: (ref: ContextReference) => boolean;
  onNavigate: (uri: string, range?: SourceRange) => void;
  onPickContext: () => void;
  onOpenReference: (reference: ContextReference) => void;
  selection: AgentSelection;
  onSelectionChange: (selection: AgentSelection) => void;
  onDropTarget: (target: AttachmentTarget) => void;
  onDropReference: (reference: ContextReference) => void;
  onTurnComplete: () => void;
  onBusy: (busy: boolean) => void;
  onApprovalPending: (pending: boolean) => void;
  onOpenProposal: (approval: WriteApproval) => void;
  externalPrompt: { text: string; key: number } | null;
}

function protocolError(error: AgentEvent['params']['error'], fallback: string): string {
  return typeof error === 'string' ? error || fallback : error?.message || fallback;
}
function isSourceRange(value: unknown): value is SourceRange {
  if (!value || typeof value !== 'object' || !('start' in value) || !('end' in value)) return false;
  return [value.start, value.end].every(
    (point) =>
      point &&
      typeof point === 'object' &&
      'line' in point &&
      'character' in point &&
      typeof point.line === 'number' &&
      Number.isInteger(point.line) &&
      point.line >= 0 &&
      typeof point.character === 'number' &&
      Number.isInteger(point.character) &&
      point.character >= 0,
  );
}
function attachmentTarget(value: unknown): AttachmentTarget {
  if (!value || typeof value !== 'object' || !('uri' in value) || typeof value.uri !== 'string')
    throw new Error('Invalid attachment.');
  const target: AttachmentTarget = { uri: value.uri };
  if ('ranges' in value && value.ranges !== undefined) {
    if (!Array.isArray(value.ranges) || !value.ranges.every(isSourceRange))
      throw new Error('Invalid attachment range.');
    target.ranges = value.ranges;
  }
  if ('kind' in value && value.kind !== undefined) {
    const kinds: ContextReference['kind'][] = [
      'file',
      'selection',
      'symbol',
      'caller',
      'callee',
      'diagnostic',
      'diff',
      'git',
      'terminal',
      'graph',
      'extension',
      'presentation',
    ];
    const kind = kinds.find((kind) => kind === value.kind);
    if (!kind) throw new Error('Invalid attachment kind.');
    target.kind = kind;
  }
  if ('label' in value && typeof value.label === 'string') target.label = value.label;
  if ('prefix' in value && typeof value.prefix === 'string') target.prefix = value.prefix;
  if ('version' in value && typeof value.version === 'string') target.version = value.version;
  return target;
}
function attachmentReference(value: unknown): ContextReference {
  const target = attachmentTarget(value);
  if (
    !value ||
    typeof value !== 'object' ||
    !('content' in value) ||
    typeof value.content !== 'string' ||
    value.content.length > MAX_REFERENCE ||
    !target.uri.startsWith('file://') ||
    !target.version ||
    (target.kind !== 'symbol' && target.kind !== 'file')
  )
    throw new Error('Invalid code snapshot.');
  return makeReference({
    kind: target.kind,
    label: target.label?.slice(0, 512) || 'Code snapshot',
    origin: 'Code index',
    uri: target.uri,
    ranges: target.ranges?.slice(0, 12),
    version: target.version.slice(0, 128),
    content: value.content,
  });
}

export function ReferenceChip({
  reference,
  stale,
  onRemove,
  onUpdate,
  onOpenReference,
}: {
  reference: ContextReference;
  stale?: boolean;
  onRemove?: () => void;
  onUpdate?: () => void;
  onOpenReference: Props['onOpenReference'];
}) {
  return (
    <span className={`reference-chip ${stale ? 'stale' : ''}`}>
      <Dialog.Root>
        <Dialog.Trigger asChild>
          <button type="button" className="reference-label" title={`Preview ${reference.label}`}>
            {reference.kind === 'git' ? <GitBranch size={12} /> : <FileCode2 size={12} />}
            <span>{reference.label}</span>
            {stale && <span className="stale-dot" role="img" aria-label="Source changed" />}
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content reference-dialog">
            <div className="dialog-heading">
              <div>
                <Dialog.Title>{reference.label}</Dialog.Title>
                <Dialog.Description>
                  {reference.origin} · Captured{' '}
                  {new Date(reference.capturedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {stale ? ' · Source has changed' : ''}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button variant="ghost" size="icon" aria-label="Close preview">
                  <X size={17} />
                </Button>
              </Dialog.Close>
            </div>
            <pre className="reference-snapshot">{reference.content}</pre>
            {reference.truncated && (
              <p className="muted">
                This attachment was limited to 16,000 characters. The preview shows exactly what is
                sent.
              </p>
            )}
            <div className="dialog-footer">
              {reference.uri && (
                <Dialog.Close asChild>
                  <Button variant="secondary" size="sm" onClick={() => onOpenReference(reference)}>
                    <ArrowUpRight size={13} />
                    Open source
                  </Button>
                </Dialog.Close>
              )}
              {stale && onUpdate && (
                <Dialog.Close asChild>
                  <Button size="sm" onClick={onUpdate}>
                    <RotateCcw size={13} />
                    Update snapshot
                  </Button>
                </Dialog.Close>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {onRemove && (
        <button
          type="button"
          className="reference-remove"
          onClick={onRemove}
          aria-label={`Remove ${reference.label}`}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

type ChatDraft = { text: string; references: ContextReference[] };
const workspaceDrafts = new Map<string, Map<string, ChatDraft>>();
function draftsForWorkspace(root = ''): Map<string, ChatDraft> {
  let drafts = workspaceDrafts.get(root);
  if (!drafts) {
    drafts = new Map();
    workspaceDrafts.set(root, drafts);
  }
  if (workspaceDrafts.size > 12) workspaceDrafts.delete(workspaceDrafts.keys().next().value || '');
  return drafts;
}

export function ChatPane(props: Props) {
  const providerId = props.selection.providerId;
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const providerSettingsOpen = props.providerSettingsOpen;
  const provider = providers.find((profile) => profile.id === providerId);
  const draftCache = draftsForWorkspace(props.workspaceRoot);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState(() => draftCache.get('draft')?.text || '');
  const [connected, setConnected] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [account, setAccount] = useState<ConnectionResult['account']>(null);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [defaults, setDefaults] = useState<AgentDefaults>({});
  const [modelError, setModelError] = useState('');
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<ChatTokenUsage | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [activity, setActivity] = useState('');
  const [approval, setApproval] = useState<WriteApproval | null>(null);
  const [approvalNow, setApprovalNow] = useState(() => Date.now());
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [activeChat, setActiveChat] = useState<ChatThread | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [changingChat, setChangingChat] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const olderScroll = useRef<{ height: number; top: number } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const allReferences = useRef(new Map<string, ContextReference>());
  const livePresentations = useRef(new Map<string, string>());
  const dismissedPresentations = useRef(new Set<string>());
  const busyRef = useRef(false);
  const identity = useRef<ChatIdentity>({
    threadId: null,
    connection: null,
    awaitingThread: false,
  });
  const chatRevision = useRef(0);
  const changingChatRef = useRef(false);
  const openingUsage = useRef<{
    threadId: string;
    snapshot?: { connection: number; usage: ChatTokenUsage };
  } | null>(null);
  const historyLoadingRef = useRef(false);
  const initializedChats = useRef(false);
  const mounted = useRef(false);
  const drafts = useRef(draftCache);
  const promptRef = useRef(prompt);
  const pendingTitle = useRef('');
  promptRef.current = prompt;
  useEffect(() => {
    propsRef.current.onApprovalPending(approval?.status === 'pending');
  }, [approval?.status]);
  useEffect(() => {
    if (approval?.status !== 'pending') return;
    const timer = window.setInterval(() => setApprovalNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [approval?.status]);
  const setRunning = useCallback((value: boolean) => {
    busyRef.current = value;
    setBusy(value);
    propsRef.current.onBusy(value);
  }, []);
  const setProviderSettingsOpen = useCallback((open: boolean) => {
    propsRef.current.onProviderSettingsOpenChange(
      open && !busyRef.current && !changingChatRef.current,
    );
  }, []);
  useEffect(() => {
    if (providerSettingsOpen && (busy || changingChat)) setProviderSettingsOpen(false);
  }, [providerSettingsOpen, busy, changingChat, setProviderSettingsOpen]);

  const saveDraft = useCallback(() => {
    if (drafts.current.size > 40) drafts.current.delete(drafts.current.keys().next().value || '');
    drafts.current.set(identity.current.threadId || 'draft', {
      text: promptRef.current,
      references: [...propsRef.current.references],
    });
  }, []);
  const activateChat = useCallback(
    (
      thread: ChatThread | null,
      connection: number | null,
      history: ChatMessage[] = [],
      restoredUsage: ChatTokenUsage | null = null,
    ) => {
      const threadId = thread?.id || null;
      const pending = openingUsage.current;
      const sameIdentity =
        threadId !== null &&
        identity.current.threadId === threadId &&
        identity.current.connection === connection;
      const snapshot =
        restoredUsage ??
        (pending?.threadId === threadId && pending.snapshot?.connection === connection
          ? pending.snapshot.usage
          : null);
      setUsage((current) => snapshot ?? (sameIdentity ? current : null));
      identity.current = { threadId, connection, awaitingThread: false };
      initializedChats.current = true;
      setActiveChat(thread);
      setMessages(history);
      followBottom.current = true;
      setAtBottom(true);
      olderScroll.current = null;
      setActivity('');
      setError('');
      allReferences.current.clear();
      dismissedPresentations.current.clear();
      for (const message of history)
        for (const reference of message.references || [])
          allReferences.current.set(reference.id, reference);
      propsRef.current.onChatChange(threadId, connection);
      const draft = drafts.current.get(threadId || 'draft');
      setPrompt(draft?.text || '');
      for (const reference of draft?.references || []) propsRef.current.onDropReference(reference);
      setShowHistory(false);
      setHistoryRevision((value) => value + 1);
    },
    [],
  );
  useEffect(() => {
    let current = true;
    void listProviders()
      .then((profiles) => {
        if (!current) return;
        setProviders(profiles);
        providersRef.current = profiles;
        if (!profiles.some((profile) => profile.id === providerId) && isDesktop)
          propsRef.current.onSelectionChange(selectionForProvider(profiles[0]?.id || ''));
      })
      .catch((error) => {
        if (current) setError(String(error));
      });
    return () => {
      current = false;
    };
  }, [providerId]);
  const openChat = useCallback(
    async (threadId: string) => {
      if (busyRef.current) throw new Error('Stop the response before switching chats.');
      if (changingChatRef.current) throw new Error('Wait for this chat to open.');
      changingChatRef.current = true;
      setChangingChat(true);
      saveDraft();
      const revision = ++chatRevision.current;
      openingUsage.current = { threadId };
      try {
        const result = await invokeAgent<OpenChat>(providerId, 'agent_open_chat', { threadId });
        if (!mounted.current || revision !== chatRevision.current) return;
        activateChat(
          result.thread,
          result.connection,
          hydrateChat(result.thread.turns || [], result.thread.createdAt * 1000),
          parseChatUsage(result),
        );
        setHistoryCursor(result.nextCursor);
      } finally {
        if (mounted.current && revision === chatRevision.current) {
          openingUsage.current = null;
          changingChatRef.current = false;
          setChangingChat(false);
        }
      }
    },
    [activateChat, saveDraft, providerId],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      saveDraft();
      mounted.current = false;
      chatRevision.current++;
      initializedChats.current = false;
    };
  }, [saveDraft]);
  useEffect(() => {
    // Reconnect retries a failed local history load.
    void historyRevision;
    if (!isDesktop || initializedChats.current) return;
    initializedChats.current = true;
    changingChatRef.current = true;
    setChangingChat(true);
    const revision = ++chatRevision.current;
    const current = () => mounted.current && revision === chatRevision.current;
    void invokeAgent<ChatList>(providerId, 'agent_list_chats')
      .then(async (page) => {
        if (!current()) return;
        if (page.activeThreadId) {
          openingUsage.current = { threadId: page.activeThreadId };
          const result = await invokeAgent<OpenChat>(providerId, 'agent_open_chat', {
            threadId: page.activeThreadId,
          });
          if (!current()) return;
          activateChat(
            result.thread,
            result.connection,
            hydrateChat(result.thread.turns || [], result.thread.createdAt * 1000),
            parseChatUsage(result),
          );
          setHistoryCursor(result.nextCursor);
        } else activateChat(null, null);
      })
      .catch((error) => {
        if (current()) {
          initializedChats.current = false;
          setConnected(false);
          setError(`Chat history could not open. Reconnect to retry. ${String(error)}`);
        }
      })
      .finally(() => {
        if (!current()) return;
        openingUsage.current = null;
        changingChatRef.current = false;
        setChangingChat(false);
      });
  }, [providerId, activateChat, historyRevision]);

  const connect = useCallback(async () => {
    if (!providerId) {
      setProviderSettingsOpen(true);
      return;
    }
    if (!isDesktop) {
      setError('Models connect in the desktop app. This browser view previews the interface.');
      return;
    }
    setConnecting(true);
    setError('');
    try {
      const result = await invokeAgent<ConnectionResult>(providerId, 'agent_connect');
      if (!mounted.current) return;
      setConnected(result.connected);
      setAuthenticated(result.authenticated);
      setAccount(result.account);
      const profile = providersRef.current.find((item) => item.id === providerId);
      setModels(
        result.models?.length ? result.models : profile ? providerModelFallback(profile) : [],
      );
      setDefaults(result.defaults || {});
      setModelError(result.modelError || '');
      if (!initializedChats.current) setHistoryRevision((value) => value + 1);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setConnecting(false);
    }
  }, [providerId, setProviderSettingsOpen]);
  const reconnect = useCallback(() => {
    if (!busyRef.current && !changingChatRef.current && !connecting) void connect();
  }, [connect, connecting]);
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    onEvent<AgentEvent>('agent:event', (event) => {
      if (!eventMatchesProvider(providerId, event)) return;
      const pendingUsage = openingUsage.current;
      if (
        changingChatRef.current &&
        pendingUsage &&
        pendingUsage.threadId === event.threadId &&
        event.scope === 'session' &&
        typeof event.connection === 'number' &&
        event.method === 'thread/tokenUsage/updated'
      ) {
        const snapshot = parseChatUsage(event.params);
        if (snapshot) pendingUsage.snapshot = { connection: event.connection, usage: snapshot };
        return;
      }
      const route = routeChatEvent(identity.current, event);
      if (!route.accept || (!route.global && changingChatRef.current)) return;
      if (route.identity) {
        if (identity.current.connection !== route.identity.connection) setUsage(null);
        if (!identity.current.threadId) drafts.current.delete('draft');
        identity.current = route.identity;
        const threadId = route.identity.threadId;
        propsRef.current.onChatChange(threadId, route.identity.connection);
        if (threadId)
          setActiveChat((current) =>
            current?.id === threadId
              ? current
              : {
                  id: threadId,
                  preview: pendingTitle.current,
                  cwd: event.cwd || '',
                  createdAt: Date.now() / 1000,
                  updatedAt: Date.now() / 1000,
                  status: { type: 'active' },
                  turns: [],
                },
          );
      }
      const p = event.params;
      if (event.method === 'thread/tokenUsage/updated') {
        const snapshot = parseChatUsage(p);
        if (snapshot) setUsage(snapshot);
        return;
      }
      if (event.method === 'item/autoApprovalReview/awaitingUser') {
        const next = parseWriteApproval(p);
        if (next) {
          setApproval({ ...next, connectionId: event.connection });
          setApprovalNow(Date.now());
          setActivity(approvalActivity(true) || 'Waiting for your approval');
        }
        return;
      }
      if (event.method === 'item/autoApprovalReview/completed') {
        const status = approvalStatusFromReview(p.review?.status);
        setApproval((current) =>
          current && current.reviewId === p.reviewId
            ? {
                ...current,
                status: status || 'error',
                detail: p.review?.rationale || current.detail,
              }
            : current,
        );
        if (busyRef.current) setActivity('Working');
        return;
      }
      const tool = toolActivity(event.method, p);
      if (tool) {
        setMessages((old) => upsertChatTool(old, tool));
        if (busyRef.current)
          setActivity(
            tool.status !== 'running'
              ? 'Working'
              : tool.fileEdits && !tool.aggregate
                ? 'Editing files'
                : tool.aggregate
                  ? 'Working'
                  : `Running ${tool.name}`,
          );
        return;
      }
      if (event.method === 'item/agentMessage/delta') {
        const id = String(p.itemId || p.item_id || p.turnId || 'assistant');
        setMessages((old) => {
          const found = old.some((item) => item.id === id);
          return found
            ? old.map((item) =>
                item.id === id ? { ...item, text: item.text + (p.delta || '') } : item,
              )
            : [...old, { id, role: 'assistant', text: p.delta || '' }];
        });
        setActivity('Writing');
      } else if (event.method === 'item/completed' && p.item?.type === 'agentMessage') {
        const item = p.item;
        setMessages((old) =>
          old.some((message) => message.id === item.id)
            ? old.map((message) =>
                message.id === item.id ? { ...message, text: item.text || message.text } : message,
              )
            : [...old, { id: item.id, role: 'assistant', text: item.text || '' }],
        );
      } else if (event.method === 'turn/started') {
        setRunning(true);
        setActivity('Thinking');
      } else if (event.method === 'turn/completed') {
        setApproval((current) =>
          current?.status === 'pending'
            ? { ...current, status: 'cancelled', detail: 'The response ended.' }
            : current,
        );
        setMessages((old) =>
          old.map((item) =>
            item.tool
              ? {
                  ...item,
                  tool: finishToolActivity(item.tool, p.turn?.error ? 'failed' : p.turn?.status),
                }
              : item,
          ),
        );
        setRunning(false);
        setActivity(p.turn?.status === 'interrupted' ? 'Stopped' : '');
        if (p.turn?.error)
          setError(protocolError(p.turn.error, 'The Edi response did not finish.'));
        propsRef.current.onTurnComplete();
        setHistoryRevision((value) => value + 1);
      } else if (event.method === 'item/started') {
        const type = p.item?.type;
        if (type === 'commandExecution') setActivity('Running a command');
        else if (type === 'fileChange') setActivity('Editing files');
        else if (type === 'reasoning') setActivity('Thinking');
      } else if (event.method === 'workbench/permissionDenied')
        setError(p.message || 'Edi could not apply this action.');
      else if (event.method === 'error') {
        setError(p.message || protocolError(p.error, 'The Edi connection failed.'));
        if (!p.willRetry) {
          setMessages((old) =>
            old.map((item) =>
              item.tool ? { ...item, tool: finishToolActivity(item.tool, 'failed') } : item,
            ),
          );
          setRunning(false);
        }
      } else if (event.method === 'workbench/disconnected') {
        if (event.scope === 'control' || p.scope === 'control') {
          setConnected(false);
          return;
        }
        setMessages((old) =>
          old.map((item) =>
            item.tool ? { ...item, tool: finishToolActivity(item.tool, 'interrupted') } : item,
          ),
        );
        if (busyRef.current) {
          setRunning(false);
          setError(String(p.message || 'Edi disconnected. Reconnect to continue.'));
        }
      }
    })
      .then((unsubscribe) => {
        if (disposed) unsubscribe();
        else {
          off = unsubscribe;
          if (isDesktop && providerId) void connect();
        }
      })
      .catch((e) => setError(String(e)));
    const focus = () => textarea.current?.focus();
    window.addEventListener('workbench:focus-chat', focus);
    return () => {
      disposed = true;
      off?.();
      window.removeEventListener('workbench:focus-chat', focus);
    };
  }, [connect, setRunning, providerId]);
  useEffect(() => {
    if (
      props.presentations.some(
        (presentation) => livePresentations.current.get(presentation.id) !== presentation.revision,
      )
    )
      setShowHistory(false);
    livePresentations.current = new Map(
      props.presentations.map((presentation) => [presentation.id, presentation.revision]),
    );
    setMessages((old) => {
      const remaining = new Map(props.presentations.map((item) => [item.id, item]));
      const next = old.flatMap((message) => {
        if (!message.presentation) return [message];
        const presentation = remaining.get(message.presentation.id);
        remaining.delete(message.presentation.id);
        return presentation
          ? [{ ...message, presentation, historical: false }]
          : message.historical
            ? [message]
            : [];
      });
      return [
        ...next,
        ...[...remaining.values()].map((presentation) => ({
          id: `ui:${presentation.id}`,
          role: 'assistant' as const,
          text: '',
          presentation,
        })),
      ];
    });
  }, [props.presentations]);
  useLayoutEffect(() => {
    void messages;
    const scroll = olderScroll.current;
    if (!scroll || !viewport.current) return;
    viewport.current.scrollTop = scroll.top + viewport.current.scrollHeight - scroll.height;
    olderScroll.current = null;
  }, [messages]);
  useEffect(() => {
    if (followBottom.current && (messages.length || activity))
      bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [messages, activity]);
  useEffect(() => {
    if (props.externalPrompt) {
      setPrompt(props.externalPrompt.text);
      textarea.current?.focus();
    }
  }, [props.externalPrompt]);
  async function sendText(text: string, references: ContextReference[]) {
    if (!text.trim() || busyRef.current || changingChatRef.current) return;
    if (!connected || !authenticated) {
      await connect();
      return;
    }
    if (isDesktop && !initializedChats.current) {
      setError('Open a saved chat or reconnect Edi before sending.');
      return;
    }
    references.forEach((ref) => {
      allReferences.current.set(ref.id, ref);
    });
    const id = crypto.randomUUID();
    const revision = chatRevision.current;
    pendingTitle.current = text;
    identity.current.awaitingThread = true;
    followBottom.current = true;
    setAtBottom(true);
    setMessages((old) => [...old, { id, role: 'user', text, references }]);
    setPrompt('');
    setError('');
    setRunning(true);
    setActivity('Starting');
    try {
      const result = await invokeAgent<{ threadId: string; connection: number }>(
        providerId,
        'agent_send',
        {
          text: serializePrompt(text, references),
          model: props.selection.model || undefined,
          effort: props.selection.effort || undefined,
        },
      );
      if (!mounted.current || revision !== chatRevision.current) return;
      identity.current.awaitingThread = false;
      drafts.current.delete(identity.current.threadId || 'draft');
      if (
        identity.current.threadId !== result.threadId ||
        identity.current.connection !== result.connection
      ) {
        if (identity.current.connection !== result.connection) setUsage(null);
        identity.current = {
          threadId: result.threadId,
          connection: result.connection,
          awaitingThread: false,
        };
        propsRef.current.onChatChange(result.threadId, result.connection);
        setActiveChat((thread) =>
          thread?.id === result.threadId
            ? thread
            : {
                id: result.threadId,
                preview: text,
                cwd: '',
                createdAt: Date.now() / 1000,
                updatedAt: Date.now() / 1000,
                status: { type: 'active' },
                turns: [],
              },
        );
      }
      references.forEach((ref) => {
        propsRef.current.onRemove(ref.id);
      });
    } catch (e) {
      if (!mounted.current || revision !== chatRevision.current) return;
      identity.current.awaitingThread = false;
      setMessages((old) => old.filter((message) => message.id !== id));
      setError(String(e));
      setRunning(false);
      setActivity('');
      setPrompt(text);
    }
  }
  function send() {
    void sendText(prompt.trim(), [...props.references]);
  }
  async function retryApproval(text: string) {
    if (busyRef.current) {
      try {
        await invokeAgent(providerId, 'agent_cancel');
      } catch {
        // The turn may already have finished.
      }
      for (let attempt = 0; attempt < 20 && busyRef.current; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
    }
    if (busyRef.current) {
      setError('Stop the response, then ask Edi to try the change again.');
      return;
    }
    await sendText(text, []);
  }
  async function decideApproval(decision: 'approve' | 'deny', note: string) {
    if (!approval) return;
    try {
      await invokeAgent(providerId, 'agent_write_decision', {
        reviewId: approval.reviewId,
        decision,
        note: note.trim() || null,
        connectionId: approval.connectionId,
      });
    } catch (error) {
      setApproval((current) =>
        current ? { ...current, status: 'error', detail: String(error) } : current,
      );
    }
  }
  async function cancel() {
    try {
      await invokeAgent(providerId, 'agent_cancel');
      setActivity('Stopping');
    } catch (e) {
      setError(String(e));
    }
  }
  async function newChat() {
    if (busyRef.current) {
      setError('Stop the response before starting a new chat.');
      return;
    }
    if (changingChatRef.current) return;
    changingChatRef.current = true;
    setChangingChat(true);
    saveDraft();
    const revision = ++chatRevision.current;
    try {
      if (isDesktop) await invokeAgent(providerId, 'agent_new_chat');
      if (!mounted.current || revision !== chatRevision.current) return;
      activateChat(null, null);
      setHistoryCursor(null);
    } catch (e) {
      if (mounted.current && revision === chatRevision.current) setError(String(e));
    } finally {
      if (mounted.current && revision === chatRevision.current) {
        changingChatRef.current = false;
        setChangingChat(false);
      }
    }
  }
  async function renameChat(thread: ChatThread, title: string) {
    await invokeAgent(providerId, 'agent_rename_chat', { threadId: thread.id, title });
    if (!mounted.current) return;
    setActiveChat((active) => (active?.id === thread.id ? { ...active, name: title } : active));
    setHistoryRevision((value) => value + 1);
  }
  async function archiveChat(thread: ChatThread, archived: boolean) {
    if (busyRef.current) throw new Error('Stop the response before archiving or restoring chats.');
    if (changingChatRef.current) throw new Error('Wait for this chat to open.');
    changingChatRef.current = true;
    setChangingChat(true);
    saveDraft();
    const revision = ++chatRevision.current;
    try {
      await invokeAgent(providerId, 'agent_archive_chat', { threadId: thread.id, archived });
      if (!mounted.current || revision !== chatRevision.current) return;
      if (archived && identity.current.threadId === thread.id) {
        activateChat(null, null);
        setHistoryCursor(null);
        setShowHistory(true);
      } else setHistoryRevision((value) => value + 1);
    } finally {
      if (mounted.current && revision === chatRevision.current) {
        changingChatRef.current = false;
        setChangingChat(false);
      }
    }
  }
  async function loadOlder() {
    const { threadId, connection } = identity.current;
    if (!threadId || !historyCursor || historyLoadingRef.current || changingChatRef.current) return;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    const revision = chatRevision.current;
    try {
      const page = await invokeAgent<{ data: ChatTurn[]; nextCursor: string | null }>(
        providerId,
        'agent_chat_turns',
        {
          threadId,
          cursor: historyCursor,
        },
      );
      if (
        !mounted.current ||
        revision !== chatRevision.current ||
        identity.current.threadId !== threadId ||
        identity.current.connection !== connection
      )
        return;
      const older = hydrateChat(page.data, (activeChat?.createdAt || 0) * 1000).filter(
        (message) =>
          !message.presentation || !dismissedPresentations.current.has(message.presentation.id),
      );
      for (const message of older)
        for (const reference of message.references || [])
          if (!allReferences.current.has(reference.id))
            allReferences.current.set(reference.id, reference);
      if (viewport.current)
        olderScroll.current = {
          height: viewport.current.scrollHeight,
          top: viewport.current.scrollTop,
        };
      followBottom.current = false;
      setAtBottom(false);
      setMessages((current) => mergeChatMessages(older, current));
      setHistoryCursor(page.nextCursor);
    } catch (error) {
      if (mounted.current && revision === chatRevision.current) setError(String(error));
    } finally {
      historyLoadingRef.current = false;
      if (mounted.current) setHistoryLoading(false);
    }
  }
  function dismissPresentation(id: string) {
    dismissedPresentations.current.add(id);
    setMessages((current) => current.filter((message) => message.presentation?.id !== id));
    props.onDismissPresentation(id);
  }
  function openLink(href?: string) {
    if (!href) return;
    if (href.startsWith('workbench-ref://')) {
      const ref = allReferences.current.get(href.slice('workbench-ref://'.length));
      if (ref) props.onOpenReference(ref);
      else setError('This reference is in an earlier message. Load older messages to open it.');
    } else if (href.startsWith('file://') || href.startsWith('/')) {
      const match = href.match(/^(.*?)(?:#L|:)(\d+)(?::\d+)?$/);
      props.onNavigate(
        match ? match[1] : href,
        match
          ? {
              start: { line: Number(match[2]) - 1, character: 0 },
              end: { line: Number(match[2]) - 1, character: 0 },
            }
          : undefined,
      );
    }
  }
  const totalContext = props.references.reduce((sum, ref) => sum + ref.content.length, 0);
  return (
    <section
      className={`chat-pane ${dragOver ? 'chat-dragover' : ''}`}
      aria-label="Edi chat"
      data-ide-surface="chat"
      onDragOver={(e) => {
        if (
          e.dataTransfer.types.some((type) =>
            ['application/x-workbench-target', 'application/x-workbench-reference'].includes(type),
          )
        ) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        try {
          const reference = e.dataTransfer.getData('application/x-workbench-reference');
          if (reference) {
            props.onDropReference(attachmentReference(JSON.parse(reference)));
            return;
          }
          props.onDropTarget(
            attachmentTarget(JSON.parse(e.dataTransfer.getData('application/x-workbench-target'))),
          );
        } catch {
          setError('This item could not be attached. Use Add to chat.');
        }
      }}
    >
      <header className="chat-header">
        <div className="chat-header-identity">
          <Command size={16} />
          <strong title={activeChat ? chatTitle(activeChat) : provider?.name || 'Edi'}>
            {activeChat ? chatTitle(activeChat) : provider?.name || 'Edi'}
          </strong>
          <span
            className={`connection-dot ${connected && authenticated ? 'online' : ''}`}
            title={connected && authenticated ? 'Connected' : 'Disconnected'}
          />
        </div>
        <div className="header-actions">
          <Tooltip label="Chat history">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Chat history"
              aria-pressed={showHistory}
              data-active={showHistory}
              onClick={() => setShowHistory((value) => !value)}
            >
              <History size={15} />
            </Button>
          </Tooltip>
          <Tooltip label={busy ? 'Stop the response before starting a new chat' : 'New chat'}>
            <Button
              variant="ghost"
              size="icon"
              aria-label="New chat"
              onClick={newChat}
              disabled={busy || changingChat}
            >
              <Plus size={18} />
            </Button>
          </Tooltip>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button variant="ghost" size="icon" aria-label="Chat options">
                <ChevronDown size={15} />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="dropdown-content" align="end">
                <DropdownMenu.Item className="dropdown-item" onSelect={() => setShowHistory(true)}>
                  <History size={14} />
                  Chat history
                </DropdownMenu.Item>
                {activeChat && (
                  <DropdownMenu.Item
                    className="dropdown-item"
                    disabled={busy || changingChat}
                    onSelect={() =>
                      void archiveChat(activeChat, true).catch((error) => setError(String(error)))
                    }
                  >
                    <Archive size={14} />
                    Archive chat
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Item
                  className="dropdown-item"
                  disabled={connecting || busy || changingChat}
                  onSelect={reconnect}
                >
                  <RotateCcw size={14} className={connecting ? 'spin' : undefined} />
                  {connecting ? 'Connecting…' : 'Reconnect provider'}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="dropdown-item"
                  disabled={busy || changingChat}
                  onSelect={() => setProviderSettingsOpen(true)}
                >
                  Manage connections…
                </DropdownMenu.Item>
                <DropdownMenu.Item className="dropdown-item" onSelect={props.onPickContext}>
                  <AtSign size={14} />
                  Add context
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>
      {showHistory ? (
        <ChatHistory
          activeId={activeChat?.id || null}
          providerId={providerId}
          busy={busy}
          changing={changingChat}
          revision={historyRevision}
          onBack={() => setShowHistory(false)}
          onStop={() => void cancel()}
          onOpen={openChat}
          onRename={renameChat}
          onArchive={archiveChat}
        />
      ) : (
        <div
          className="chat-messages"
          ref={viewport}
          onScroll={() => {
            const element = viewport.current;
            if (element) {
              followBottom.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 80;
              setAtBottom(followBottom.current);
            }
          }}
        >
          {changingChat && (
            <div className="chat-loading" role="status">
              <LoaderCircle size={13} className="spin" />
              Opening chat
            </div>
          )}
          {historyCursor && !changingChat && (
            <Button
              variant="ghost"
              size="sm"
              className="chat-history-older"
              disabled={historyLoading}
              onClick={() => void loadOlder()}
            >
              {historyLoading && <LoaderCircle size={12} className="spin" />}
              Load older messages
            </Button>
          )}
          {!providerId && !changingChat && (
            <ChatSetup
              preview={!isDesktop}
              disabled={busy || changingChat}
              onConnect={() => setProviderSettingsOpen(true)}
            />
          )}
          {!isDesktop && providerId && (
            <p className="chat-preview-note">Browser preview. Connect in the desktop app.</p>
          )}
          {providerId && !messages.length && !changingChat && (
            <p className="chat-empty">Ask about your code.</p>
          )}
          {messages.map((message) =>
            message.tool ? (
              <ToolCall
                key={message.id}
                tool={message.tool}
                root={props.workspaceRoot}
                onNavigate={props.onNavigate}
                onAttach={props.onDropReference}
              />
            ) : (
              <article
                className={`chat-message ${message.role}`}
                key={message.id}
                data-ide-presentation={message.presentation?.id}
                data-ide-revision={message.presentation?.revision}
              >
                <div className="message-author">
                  {message.role === 'assistant' ? (
                    <Command size={15} />
                  ) : (
                    <span className="you-marker" />
                  )}
                  <strong>{message.role === 'assistant' ? 'Edi' : 'You'}</strong>
                </div>
                {message.references?.length ? (
                  <div className="message-context">
                    {message.references.map((ref) => (
                      <ReferenceChip
                        key={ref.id}
                        reference={ref}
                        onOpenReference={props.onOpenReference}
                      />
                    ))}
                  </div>
                ) : null}
                {message.presentation ? (
                  <>
                    <div className="chat-presentation-heading">
                      <h3>{message.presentation.title}</h3>
                      <Tooltip label="Add display to chat">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Add ${message.presentation.title} to chat`}
                          onClick={() =>
                            props.onDropReference(
                              makeReference({
                                kind: 'presentation',
                                label: message.presentation?.title || 'Edi display',
                                origin: 'Edi display',
                                content: JSON.stringify({
                                  id: message.presentation?.id,
                                  title: message.presentation?.title,
                                  blocks: message.presentation?.blocks,
                                }),
                              }),
                            )
                          }
                        >
                          <MessageSquarePlus size={14} />
                        </Button>
                      </Tooltip>
                      <Tooltip label="Dismiss display">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Dismiss ${message.presentation.title}`}
                          onClick={() =>
                            message.presentation && dismissPresentation(message.presentation.id)
                          }
                        >
                          <X size={13} />
                        </Button>
                      </Tooltip>
                    </div>
                    <ChatBlocks blocks={message.presentation.blocks} />
                  </>
                ) : (
                  <div className="markdown">
                    <Markdown
                      remarkPlugins={[remarkGfm]}
                      urlTransform={(url) => url}
                      components={{
                        a: ({ href, children }) =>
                          href?.startsWith('https://') || href?.startsWith('http://') ? (
                            <span className="muted">
                              {children} ({href})
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="source-link"
                              onClick={() => openLink(href)}
                            >
                              {children}
                              <ArrowUpRight size={11} />
                            </button>
                          ),
                      }}
                    >
                      {message.text}
                    </Markdown>
                  </div>
                )}
              </article>
            ),
          )}
          {approval && (
            <WriteApprovalCard
              approval={approval}
              now={approvalNow}
              onDecide={(decision, note) => void decideApproval(decision, note)}
              onRetry={(text) => void retryApproval(text)}
              onOpenDiff={props.onOpenProposal}
            />
          )}
          {(busy || approval?.status === 'pending') && (
            <div className="chat-activity" role="status" aria-live="polite">
              <LoaderCircle size={13} className="spin" />
              {approvalActivity(approval?.status === 'pending') || activity || 'Working'}
              <span className="activity-dots" />
            </div>
          )}
          {error && (
            <ChatRecovery
              key={error}
              error={error}
              disabled={busy || changingChat}
              connecting={connecting}
              onReconnect={reconnect}
              onManageConnections={() => setProviderSettingsOpen(true)}
              onDismiss={() => setError('')}
            />
          )}
          <div ref={bottom} />
        </div>
      )}
      {showHistory && error && (
        <ChatRecovery
          key={error}
          error={error}
          disabled={busy || changingChat}
          connecting={connecting}
          onReconnect={reconnect}
          onManageConnections={() => setProviderSettingsOpen(true)}
          onDismiss={() => setError('')}
        />
      )}
      {!showHistory && (
        <div className="chat-bottom">
          {!atBottom && (
            <button
              type="button"
              className="chat-jump-latest"
              onClick={() => {
                followBottom.current = true;
                setAtBottom(true);
                bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
              }}
            >
              <ArrowDown size={12} aria-hidden="true" />
              Jump to latest
            </button>
          )}
          <div className="composer-context">
            {props.references.map((reference) => (
              <ReferenceChip
                key={reference.id}
                reference={reference}
                stale={props.isStale(reference)}
                onRemove={() => props.onRemove(reference.id)}
                onUpdate={() => props.onUpdate(reference)}
                onOpenReference={props.onOpenReference}
              />
            ))}
          </div>
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={textarea}
              id="agent-composer"
              aria-label="Message Edi"
              value={prompt}
              disabled={changingChat}
              rows={2}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
                if (e.key === '@' && !prompt) {
                  e.preventDefault();
                  props.onPickContext();
                }
              }}
              placeholder="Ask a question or describe a change…"
            />
            <div className="composer-toolbar">
              <Tooltip label="Add context (@)">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Add context"
                  className="composer-icon"
                  type="button"
                  onClick={props.onPickContext}
                >
                  <AtSign size={16} />
                </Button>
              </Tooltip>
              <ModelPicker
                models={models}
                selection={props.selection}
                defaults={defaults}
                disabled={busy || changingChat}
                onChange={props.onSelectionChange}
                providers={providers}
                onProviderChange={(id) => {
                  if (!busyRef.current && !changingChatRef.current && id !== providerId)
                    props.onSelectionChange(selectionForProvider(id));
                }}
                onManageProviders={() => setProviderSettingsOpen(true)}
              />
              <ChatUsage usage={usage} accountType={account?.type ?? null} busy={busy} />
              <div className="composer-spacer" />
              <Tooltip label="Edi reviews proposed file edits before applying them. Workspace and source-version checks also apply.">
                <span
                  className="auto-review-status"
                  role="img"
                  aria-label="Automatic file edit review"
                >
                  <ShieldCheck size={12} aria-hidden="true" />
                </span>
              </Tooltip>
              {busy ? (
                <Button
                  variant="secondary"
                  size="icon"
                  type="button"
                  aria-label="Stop response"
                  className="send-button"
                  onClick={cancel}
                >
                  <Square size={13} fill="currentColor" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  type="submit"
                  aria-label="Send message"
                  className="send-button"
                  disabled={changingChat || !prompt.trim() || totalContext > MAX_CONTEXT}
                >
                  <ArrowUp size={17} />
                </Button>
              )}
            </div>
          </form>
          {modelError && (
            <ChatRecovery
              key={modelError}
              error={modelError}
              models
              disabled={busy || changingChat}
              connecting={connecting}
              onReconnect={reconnect}
              onManageConnections={() => setProviderSettingsOpen(true)}
            />
          )}
          {totalContext > MAX_CONTEXT && (
            <p className="composer-notice" role="alert">
              Context limit exceeded. Remove an attachment to send.
            </p>
          )}
        </div>
      )}
      {dragOver && (
        <div className="drop-hint">
          <MessageSquarePlus size={23} />
          Add this to your conversation
        </div>
      )}
      <ProviderSettings
        open={providerSettingsOpen && !busy && !changingChat}
        onOpenChange={setProviderSettingsOpen}
        profiles={providers}
        activeProviderId={providerId}
        onChanged={async (selected) => {
          const next = await listProviders();
          providersRef.current = next;
          setProviders(next);
          const id =
            selected ||
            (next.some((profile) => profile.id === providerId) ? providerId : next[0]?.id || '');
          if (id !== providerId) props.onSelectionChange(selectionForProvider(id));
          else {
            await connect();
          }
        }}
      />
    </section>
  );
}
