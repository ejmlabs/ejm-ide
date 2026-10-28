import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  AlertCircle,
  Braces,
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  Command,
  Eye,
  FileCode2,
  Files,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  MessageSquarePlus,
  Network,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Puzzle,
  Search,
  Settings2,
  Terminal,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import { AgentHint, type AgentHintValue } from './components/AgentPresentation';
import { CallGraph } from './components/CallGraph';
import { type ChatDisplay, ChatPane } from './components/ChatPane';
import { CodeSearch } from './components/CodeSearch';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { DebugPane } from './components/DebugPane';
import { EditorPreferences } from './components/EditorPreferences';
import { EditorWorkspace } from './components/EditorWorkspace';
import { Extensions } from './components/Extensions';
import { FileIcon, FileTree } from './components/FileTree';
import { GitDiffPane } from './components/GitDiffPane';
import { GitHistoryPane, GitSidebar } from './components/GitPane';
import { MarkdownPane } from './components/MarkdownPane';
import { SourceEditor } from './components/SourceEditor';
import { Problems, TerminalPane } from './components/Tools';
import { Button } from './components/ui/button';
import { Tooltip } from './components/ui/tooltip';
import { parseIdeRequest, requestIsCurrent, waitForIdePresentation } from './lib/agent-ide';
import { invoke, isDesktop, onEvent } from './lib/backend';
import {
  createCallGraphFollower,
  createSemanticCallGraph,
  type DocumentSymbol,
  packCallGraphEvidence,
  resolveCallRoot,
  withCallGraphVersions,
} from './lib/call-graph';
import {
  createIndexCallGraph,
  type IndexNode,
  type IndexStatus,
  symbolKey,
} from './lib/code-index';
import {
  bufferVersion,
  fileUri,
  MAX_CONTEXT,
  makeReference,
  sourceExcerpt,
  sourceMatchesVersion,
  uriPath,
} from './lib/context';
import {
  activeEditorTab,
  closeEditorGroup,
  closeEditorTab,
  createEditorLayout,
  diffEditorTab,
  type EditorLayout,
  type EditorSplit,
  editorClosingPaths,
  editorDocumentPaths,
  editorGroups,
  editorModelUri,
  editorPathMatches,
  editorTabPath,
  fileEditorTab,
  focusEditorGroup,
  isUntitled,
  moveEditorTab,
  openEditorTab,
  openMarkdownPreview,
  replaceEditorFile,
  resolveNewFilePath,
  splitEditorGroup,
} from './lib/editor-workspace';
import type { GitDiffRequest, GitStatus } from './lib/git';
import { useGitLineBlame } from './lib/git-blame';
import { type InlineStatus, installInlineCompletions } from './lib/inline';
import {
  closeLanguageDocument,
  openLanguageDocument,
  syncLanguageDocument,
} from './lib/language-sync';
import { lintMarkdown } from './lib/markdown';
import {
  configureLanguageModel,
  fromRange,
  lspRequest,
  monaco,
  registerLanguageProviders,
  toRange,
} from './lib/monaco';
import {
  eventMatchesProvider,
  invokeAgent,
  saveAgentSelection,
  selectionForProvider,
} from './lib/providers';
import { formatDocumentContent, type LintResult, lintForSavedBuffers } from './lib/save';
import type {
  CallDirection,
  CallHierarchy,
  CallRelation,
  ContextReference,
  Diagnostic,
  DiagnosticEntry,
  Document,
  EditorDocument,
  Entry,
  LanguageStatus,
  SourceRange,
  SymbolItem,
  Workspace,
} from './lib/types';
import { basename, hasBuiltInLanguageService, languageId, relativePath } from './lib/utils';

type Sidebar = 'project' | 'search' | 'changes' | 'extensions';
type Tool = 'hierarchy' | 'problems' | 'terminal' | 'git' | 'debug';
type PendingAction = {
  run: () => void | Promise<void>;
  cancel?: () => void;
  paths?: () => Set<string>;
};
type SourceGuard = { current: () => boolean; version: string };
type LanguageEvent =
  | { root?: string; language: string; method: 'workbench/status'; params: Partial<LanguageStatus> }
  | {
      root?: string;
      language: string;
      method: 'textDocument/publishDiagnostics';
      params: { uri: string; version?: number; diagnostics: Diagnostic[] };
    };
registerLanguageProviders();
let initialWorkspace: Promise<Workspace | null> | undefined;

function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [trustPrompt, setTrustPrompt] = useState<string | null>(null);
  const [trustWorking, setTrustWorking] = useState(false);
  const [trustError, setTrustError] = useState('');
  const [documents, setDocuments] = useState<EditorDocument[]>([]);
  const [activePath, setActivePath] = useState('');
  const [editorLayout, setEditorLayout] = useState(createEditorLayout);
  const layoutRef = useRef(editorLayout);
  layoutRef.current = editorLayout;
  const editorInstances = useRef(new Map<string, monaco.editor.IStandaloneCodeEditor>());
  const pendingEditorFocus = useRef<{ group: string; path: string } | null>(null);
  const untitledCount = useRef(0);
  const orphanModels = useRef(new Set<string>());
  const [saveAs, setSaveAs] = useState<{
    path: string;
    input: string;
    error: string;
    working: boolean;
  } | null>(null);
  const saveAsRequest = useRef<{
    path: string;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);
  const [sidebar, setSidebar] = useState<Sidebar>('project');
  const [showSidebar, setShowSidebar] = useState(true);
  const [showChat, setShowChat] = useState(true);
  const [showTools, setShowTools] = useState(false);
  const [presentations, setPresentations] = useState<ChatDisplay[]>([]);
  const [agentHint, setAgentHint] = useState<AgentHintValue | null>(null);
  const [highlights, setHighlights] = useState<
    { id: string; path: string; range: SourceRange; version: string; label?: string }[]
  >([]);
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const agentTurn = useRef<{ threadId: string; turnId: string } | null>(null);
  const activeChat = useRef<string | null>(null);
  const activeChatConnection = useRef<number | null>(null);
  const agentDecorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const dismissAgentHint = useCallback(() => setAgentHint(null), []);
  const resetPresentations = useCallback(() => {
    agentTurn.current = null;
    setPresentations([]);
    setAgentHint(null);
    setHighlights([]);
  }, []);
  const [tool, setTool] = useState<Tool>('hierarchy');
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [languageStates, setLanguageStates] = useState<Record<string, LanguageStatus>>({});
  const [diagnostics, setDiagnostics] = useState<Record<string, Diagnostic[]>>({});
  const [builtinDiagnostics, setBuiltinDiagnostics] = useState<Record<string, Diagnostic[]>>({});
  const [lintDiagnostics, setLintDiagnostics] = useState<Record<string, DiagnosticEntry[]>>({});
  const [hierarchy, setHierarchy] = useState<CallHierarchy | null>(null);
  const [hierarchyLoading, setHierarchyLoading] = useState(false);
  const [hierarchyError, setHierarchyError] = useState('');
  const [graphRevision, setGraphRevision] = useState(0);
  const [editorRevision, setEditorRevision] = useState(0);
  const graphFollower = useMemo(
    () =>
      createCallGraphFollower({
        onGraph: setHierarchy,
        onLoading: setHierarchyLoading,
        onError: setHierarchyError,
      }),
    [],
  );
  const [references, setReferences] = useState<ContextReference[]>([]);
  const [palette, setPalette] = useState<'files' | 'commands' | 'context' | null>(null);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [fileIndex, setFileIndex] = useState<Entry[]>([]);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitRefreshToken, setGitRefreshToken] = useState(0);
  const [gitHistoryPath, setGitHistoryPath] = useState<string>();
  const [lineBlameEnabled, setLineBlameEnabled] = useState(
    () => localStorage.getItem('workbench.lineBlame') !== 'false',
  );
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const saves = useRef(new Map<string, Promise<void>>());
  const lintRequests = useRef(new Map<string, number>());
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const pendingActionRef = useRef<PendingAction | null>(null);
  const [snapshot, setSnapshot] = useState<{ reference: ContextReference; reason: string } | null>(
    null,
  );
  const [externalPrompt, setExternalPrompt] = useState<{ text: string; key: number } | null>(null);
  const changeChat = useCallback(
    (threadId: string | null, connectionId?: number | null) => {
      const turn = agentTurn.current;
      const keepTurn =
        turn?.threadId === threadId && activeChatConnection.current === (connectionId ?? null);
      activeChat.current = threadId;
      activeChatConnection.current = connectionId ?? null;
      resetPresentations();
      if (keepTurn) agentTurn.current = turn;
      setReferences([]);
      setExternalPrompt(null);
    },
    [resetPresentations],
  );
  const [extensionCommands, setExtensionCommands] = useState<
    { id: string; label: string; run: () => void }[]
  >([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [fontSize, setFontSize] = useState(
    () => Number(localStorage.getItem('workbench.fontSize')) || 13,
  );
  const [inlineEnabled, setInlineEnabled] = useState(
    () => localStorage.getItem('workbench.inlineEnabled') !== 'false',
  );
  const [formatOnSave, setFormatOnSave] = useState(
    () => localStorage.getItem('workbench.formatOnSave') !== 'false',
  );
  const [lintOnSave, setLintOnSave] = useState(
    () => localStorage.getItem('workbench.lintOnSave') !== 'false',
  );
  const [inlineStatus, setInlineStatus] = useState<InlineStatus>({ state: 'idle' });
  const [agentSelection, setAgentSelection] = useState(() =>
    selectionForProvider(localStorage.getItem('workbench.agent.provider') || ''),
  );
  const activeProvider = useRef(agentSelection.providerId);
  activeProvider.current = agentSelection.providerId;
  const completionSettings = useRef({ enabled: inlineEnabled, selection: agentSelection });
  completionSettings.current = { enabled: inlineEnabled, selection: agentSelection };
  const inlineProvider = useRef<ReturnType<typeof installInlineCompletions> | null>(null);
  useEffect(() => {
    completionSettings.current = { enabled: inlineEnabled, selection: agentSelection };
    inlineProvider.current?.refresh();
  }, [inlineEnabled, agentSelection]);
  useEffect(
    () => () => {
      inlineProvider.current?.dispose();
    },
    [],
  );
  const sidebarPanel = usePanelRef();
  const chatPanel = usePanelRef();
  const toolsPanel = usePanelRef();
  useEffect(() => {
    if (showSidebar) sidebarPanel.current?.expand();
    else sidebarPanel.current?.collapse();
  }, [showSidebar, sidebarPanel]);
  useEffect(() => {
    if (showChat) chatPanel.current?.expand();
    else chatPanel.current?.collapse();
  }, [showChat, chatPanel]);
  useEffect(() => {
    const panel = toolsPanel.current;
    if (showTools) {
      panel?.expand();
      if (tool === 'git' && panel && panel.getSize().inPixels < 280) panel.resize('360px');
    } else panel?.collapse();
  }, [showTools, tool, toolsPanel]);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const editorController = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const editorViews = useRef(new Map<string, monaco.editor.ICodeEditorViewState>());
  const docsRef = useRef(documents);
  docsRef.current = documents;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const activeRef = useRef(activePath);
  activeRef.current = activePath;
  const actionsRef = useRef<Record<string, () => void>>({});
  const graphOutline = useRef<{
    model: monaco.editor.ITextModel;
    version: number;
    symbols: DocumentSymbol[] | null;
  } | null>(null);
  const pendingLocation = useRef<{
    path: string;
    range?: SourceRange;
    guard?: SourceGuard;
  } | null>(null);
  const historyRef = useRef<{ path: string; range?: SourceRange }[]>([]);
  const historyIndex = useRef(-1);
  const document = documents.find((doc) => doc.path === activePath);
  useGitLineBlame({
    root: workspace?.root,
    path: document?.path,
    content: document?.content,
    line: cursor.line,
    enabled: lineBlameEnabled && !isUntitled(activePath),
    editor: editorRef.current,
    revision: editorRevision + gitRefreshToken,
  });
  const dirty = documents.filter((doc) => doc.content !== doc.savedContent);
  const pendingPaths = pendingAction?.paths?.();
  const pendingDirty = pendingPaths ? dirty.filter((doc) => pendingPaths.has(doc.path)) : dirty;
  const currentEditorTab = activeEditorTab(editorLayout);
  const activeLanguage = languageStates[activePath];
  const semanticCallHierarchy =
    activeLanguage?.status === 'ready' && !!activeLanguage.capabilities?.callHierarchyProvider;
  const allDiagnostics = useMemo<DiagnosticEntry[]>(
    () => [
      ...Object.entries(diagnostics).flatMap(([uri, values]) =>
        values.map((item) => ({ ...item, uri })),
      ),
      ...Object.entries(builtinDiagnostics).flatMap(([uri, values]) =>
        values.map((item) => ({ ...item, uri })),
      ),
      ...Object.values(lintDiagnostics).flat(),
    ],
    [diagnostics, builtinDiagnostics, lintDiagnostics],
  );
  const errorCount = allDiagnostics.filter((d) => d.severity === 1).length;
  const warningCount = allDiagnostics.filter((d) => d.severity !== 1).length;

  useEffect(() => {
    const listener = monaco.editor.onDidChangeMarkers((resources) => {
      setBuiltinDiagnostics((old) => {
        const next = { ...old };
        for (const resource of resources) {
          const uri = resource.toString();
          const path = uriPath(uri);
          const doc = docsRef.current.find((item) => item.path === path);
          if (!doc || !hasBuiltInLanguageService(doc.language)) {
            delete next[uri];
            continue;
          }
          next[uri] = monaco.editor
            .getModelMarkers({ resource })
            .filter((item) => ['json', 'css', 'scss', 'less', 'html'].includes(item.owner))
            .map((item) => ({
              range: fromRange(item),
              message: item.message,
              severity:
                item.severity === monaco.MarkerSeverity.Error
                  ? 1
                  : item.severity === monaco.MarkerSeverity.Warning
                    ? 2
                    : item.severity === monaco.MarkerSeverity.Info
                      ? 3
                      : 4,
              source: item.source || item.owner,
              code: typeof item.code === 'object' ? item.code.value : item.code,
            }));
        }
        return next;
      });
    });
    return () => listener.dispose();
  }, []);

  const notify = useCallback((text: string, error = false) => {
    setNotice({ text, error });
  }, []);
  const notifyError = useCallback((text: string) => notify(text, true), [notify]);
  const refreshChanges = useCallback(async () => {
    const root = workspaceRef.current?.root;
    if (!root) return;
    try {
      const status = await invoke<GitStatus>('git_status');
      if (workspaceRef.current?.root === root) setGitStatus(status);
    } catch {
      if (workspaceRef.current?.root === root) setGitStatus(null);
    } finally {
      if (workspaceRef.current?.root === root) setGitRefreshToken((value) => value + 1);
    }
  }, []);
  const openGitHistory = useCallback((path?: string) => {
    setGitHistoryPath(path);
    setTool('git');
    setShowTools(true);
  }, []);
  const updateEditorLayout = useCallback((next: EditorLayout, focus = false) => {
    layoutRef.current = next;
    setEditorLayout(next);
    const tab = activeEditorTab(next);
    const path = editorTabPath(tab) || '';
    if (focus && tab?.kind === 'file')
      pendingEditorFocus.current = { group: next.activeGroup, path };
    else if (
      tab?.kind !== 'file' ||
      pendingEditorFocus.current?.group !== next.activeGroup ||
      pendingEditorFocus.current.path !== path
    )
      pendingEditorFocus.current = null;
    activeRef.current = path;
    setActivePath(path);
    const editor = editorInstances.current.get(next.activeGroup);
    const matches = editor && editorPathMatches(path, editor.getModel()?.uri.toString());
    if (tab?.kind !== 'file' || !matches) {
      inlineProvider.current?.dispose();
      inlineProvider.current = null;
      agentDecorations.current?.clear();
      editorRef.current = null;
      editorController.current = null;
    } else {
      editorRef.current = editor;
      if (focus) {
        editor.focus();
        pendingEditorFocus.current = null;
      }
    }
    setEditorRevision((value) => value + 1);
  }, []);
  const openGitDiff = useCallback(
    (request: GitDiffRequest, title: string) => {
      updateEditorLayout(openEditorTab(layoutRef.current, diffEditorTab(request, title)));
    },
    [updateEditorLayout],
  );
  const startLanguageDocument = useCallback((doc: EditorDocument) => {
    const workspace = workspaceRef.current;
    const { path, language } = doc;
    if (!workspace?.trusted) {
      configureLanguageModel(path);
      setLanguageStates((old) => ({
        ...old,
        [path]: {
          language,
          status: 'untrusted',
          message: 'Trust this workspace to enable language tools.',
        },
      }));
      return;
    }
    setLanguageStates((old) => ({ ...old, [path]: { language, status: 'starting' } }));
    void openLanguageDocument(path, doc.content, doc.modelVersion)
      .then((status) => {
        if (
          workspace !== workspaceRef.current ||
          !docsRef.current.some((item) => item.path === path)
        )
          return;
        configureLanguageModel(path, status.status === 'ready' ? status.capabilities : undefined);
        setLanguageStates((old) => ({ ...old, [path]: status }));
      })
      .catch((error) => {
        if (
          workspace !== workspaceRef.current ||
          !docsRef.current.some((item) => item.path === path)
        )
          return;
        configureLanguageModel(path);
        setLanguageStates((old) => ({
          ...old,
          [path]: { language, status: 'error', message: String(error) },
        }));
      });
  }, []);
  const openDocument = useCallback(
    async (path: string, range?: SourceRange, remember = true, guard?: SourceGuard) => {
      const openedRoot = workspaceRef.current?.root;
      const targetGroup = layoutRef.current.activeGroup;
      try {
        let doc = docsRef.current.find((item) => item.path === path);
        if (!doc) {
          if (isUntitled(path)) throw new Error('This unsaved editor has been closed.');
          const result = await invoke<Document>('workspace_read', { path });
          if (
            workspaceRef.current?.root !== openedRoot ||
            !editorGroups(layoutRef.current.root).some((group) => group.id === targetGroup) ||
            (guard && !guard.current())
          )
            return false;
          doc = docsRef.current.find((item) => item.path === path);
          if (!doc) {
            if (guard && !sourceMatchesVersion(result, guard.version)) return false;
            doc = {
              ...result,
              savedContent: result.content,
              modelVersion: 1,
              language: languageId(path),
            };
            docsRef.current = [...docsRef.current, doc];
            setDocuments(docsRef.current);
            startLanguageDocument(doc);
          }
        }
        if (guard && (!guard.current() || !sourceMatchesVersion(doc, guard.version))) return false;
        pendingLocation.current = { path, range, guard };
        const tab =
          Object.values(layoutRef.current.tabs).find(
            (item) => item.kind === 'file' && item.path === path,
          ) || fileEditorTab(path, basename(path));
        updateEditorLayout(openEditorTab(layoutRef.current, tab, targetGroup), true);
        if (remember) {
          historyRef.current = [
            ...historyRef.current.slice(0, historyIndex.current + 1),
            { path, range },
          ];
          historyIndex.current = historyRef.current.length - 1;
        }
        const model = editorRef.current?.getModel();
        if (model && uriPath(model.uri.toString()) === path && range) {
          editorRef.current?.setPosition({
            lineNumber: range.start.line + 1,
            column: range.start.character + 1,
          });
          editorRef.current?.revealRangeInCenter(toRange(range));
          editorRef.current?.focus();
          pendingLocation.current = null;
        }
        return true;
      } catch (e) {
        notify(String(e), true);
        return false;
      }
    },
    [notify, startLanguageDocument, updateEditorLayout],
  );
  function showMarkdownPreview(
    path = activeRef.current,
    groupId = layoutRef.current.activeGroup,
    beside = true,
  ) {
    const source = docsRef.current.find((item) => item.path === path);
    if (source?.language !== 'markdown') return;
    updateEditorLayout(
      openMarkdownPreview(layoutRef.current, path, basename(path), {
        groupId,
        beside,
        newGroupId: crypto.randomUUID(),
      }),
    );
  }
  function openMarkdownSource(path: string, range?: SourceRange) {
    const layout = layoutRef.current;
    const source = Object.values(layout.tabs).find(
      (tab) => tab.kind === 'file' && tab.path === path,
    );
    const sourceGroup =
      source && editorGroups(layout.root).find((group) => group.tabs.includes(source.id));
    if (sourceGroup) updateEditorLayout(focusEditorGroup(layout, sourceGroup.id, source.id));
    void openDocument(path, range);
  }
  function openMarkdownLink(path: string, href: string) {
    try {
      const target = new URL(href, fileUri(path));
      if (target.protocol === 'file:' && !target.host) {
        target.hash = '';
        void openDocument(uriPath(target.href));
      } else if (['https:', 'http:', 'mailto:'].includes(target.protocol)) {
        if (isDesktop)
          void invoke('host_open_external', { url: target.href }).catch((error) =>
            notify(String(error), true),
          );
        else window.open(target.href, '_blank', 'noopener,noreferrer');
      }
    } catch {
      notify('This Markdown link could not be opened.', true);
    }
  }
  const refreshAgentHighlights = useCallback((items: typeof highlights) => {
    const model = editorRef.current?.getModel();
    const path = model ? uriPath(model.uri.toString()) : '';
    const doc = docsRef.current.find((item) => item.path === path);
    if (!model || !doc || model.getValue() !== doc.content) {
      agentDecorations.current?.clear();
      return;
    }
    agentDecorations.current?.set(
      items
        .filter((item) => item.path === path && sourceMatchesVersion(doc, item.version))
        .map((item) => ({
          range: toRange(item.range),
          options: {
            className: 'agent-source-highlight',
            hoverMessage: item.label
              ? { value: item.label, isTrusted: false, supportHtml: false }
              : undefined,
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        })),
    );
  }, []);
  const revealPendingLocation = useCallback((editor: monaco.editor.IStandaloneCodeEditor) => {
    const location = pendingLocation.current;
    const model = editor.getModel();
    if (!location?.range || !model || uriPath(model.uri.toString()) !== location.path) return;
    const source = docsRef.current.find((doc) => doc.path === location.path);
    if (
      location.guard &&
      (!location.guard.current() ||
        !source ||
        !sourceMatchesVersion(source, location.guard.version) ||
        model.getValue() !== source.content)
    ) {
      pendingLocation.current = null;
      return;
    }
    editor.setPosition({
      lineNumber: location.range.start.line + 1,
      column: location.range.start.character + 1,
    });
    editor.revealRangeInCenter(toRange(location.range));
    pendingLocation.current = null;
  }, []);
  useEffect(() => {
    if (documents.some((item) => item.path === activePath)) refreshAgentHighlights(highlights);
  }, [highlights, activePath, documents, refreshAgentHighlights]);
  useEffect(() => {
    let live = true;
    let off: (() => void) | undefined;
    onEvent<{
      providerId: string;
      threadId?: string | null;
      connection?: number;
      method: string;
      params: Record<string, unknown>;
    }>('agent:event', (event) => {
      if (!eventMatchesProvider(activeProvider.current, event)) return;
      const p = event.params;
      if (
        !event.threadId ||
        event.threadId !== activeChat.current ||
        event.connection !== activeChatConnection.current
      )
        return;
      if (event.method === 'turn/started') {
        const turn = p.turn as { id?: string } | undefined;
        if (typeof p.threadId === 'string' && typeof turn?.id === 'string')
          agentTurn.current = { threadId: p.threadId, turnId: turn.id };
      } else if (event.method === 'turn/completed') {
        const turn = p.turn as { id?: string } | undefined;
        if (p.threadId === agentTurn.current?.threadId && turn?.id === agentTurn.current?.turnId)
          agentTurn.current = null;
      } else if (event.method === 'workbench/disconnected') {
        if (p.scope === 'session' && p.cwd === workspaceRef.current?.root) agentTurn.current = null;
      } else if (event.method === 'workbench/ideRequest') {
        const request = parseIdeRequest(p);
        const current = () =>
          live &&
          !!request &&
          request.threadId === activeChat.current &&
          request.requestId.connection === activeChatConnection.current &&
          requestIsCurrent(request, workspaceRef.current?.root, agentTurn.current);
        const apply = async () => {
          if (!request || !current()) throw new Error('This IDE request is no longer current.');
          const action = request.action;
          const revision = `${request.requestId.connection}:${request.requestId.id}`;
          if (action.type === 'showUi') {
            setShowChat(true);
            setPresentations((old) => [
              ...old.filter((item) => item.id !== action.id).slice(-7),
              { id: action.id, title: action.title, blocks: action.blocks, revision },
            ]);
            await waitForIdePresentation(current, () =>
              [...window.document.querySelectorAll<HTMLElement>('[data-ide-presentation]')].some(
                (element) =>
                  element.dataset.idePresentation === action.id &&
                  element.dataset.ideRevision === revision &&
                  element.getBoundingClientRect().width > 0,
              ),
            );
          } else if (action.type === 'openFile' || action.type === 'highlightCode') {
            if (
              !(await openDocument(action.path, action.range, true, {
                current,
                version: action.version,
              }))
            )
              throw new Error('The source changed or could not be opened. Read the current code.');
            if (!current()) throw new Error('This IDE request is no longer current.');
            if (action.type === 'highlightCode')
              setHighlights((old) => [
                ...old.filter((item) => item.id !== action.id).slice(-15),
                action,
              ]);
            await waitForIdePresentation(current, () => {
              const source = docsRef.current.find((doc) => doc.path === action.path);
              if (!source || !sourceMatchesVersion(source, action.version))
                throw new Error('The source changed before the IDE could display it.');
              const editor = editorRef.current;
              const model = editor?.getModel();
              if (
                !editor ||
                !model ||
                uriPath(model.uri.toString()) !== action.path ||
                model.getValue() !== source.content
              )
                return false;
              if (action.type === 'highlightCode') {
                if (
                  !agentDecorations.current ||
                  !highlightsRef.current.some((item) => item === action)
                )
                  return false;
                refreshAgentHighlights(highlightsRef.current);
              }
              editor.setPosition({
                lineNumber: action.range.start.line + 1,
                column: action.range.start.character + 1,
              });
              editor.revealRangeInCenter(toRange(action.range));
              editor.focus();
              pendingLocation.current = null;
              return true;
            });
          } else if (action.type === 'showHint') {
            if (action.target === 'project' || action.target === 'search') {
              setSidebar(action.target);
              setShowSidebar(true);
            } else if (action.target === 'chat') setShowChat(true);
            else if (action.target === 'tools') setShowTools(true);
            setAgentHint({ id: action.id, target: action.target, text: action.text, revision });
            await waitForIdePresentation(current, () =>
              [...window.document.querySelectorAll<HTMLElement>('[data-ide-hint]')].some(
                (element) =>
                  element.dataset.ideHint === action.id && element.dataset.ideRevision === revision,
              ),
            );
          } else {
            const ids = action.ids;
            setPresentations((old) => (ids ? old.filter((item) => !ids.includes(item.id)) : []));
            setHighlights((old) => (ids ? old.filter((item) => !ids.includes(item.id)) : []));
            setAgentHint((old) => (old && ids && !ids.includes(old.id) ? old : null));
            await waitForIdePresentation(
              current,
              () =>
                !highlightsRef.current.some((item) => !ids || ids.includes(item.id)) &&
                ![
                  ...window.document.querySelectorAll<HTMLElement>(
                    '[data-ide-presentation], [data-ide-hint]',
                  ),
                ].some((element) => {
                  const id = element.dataset.idePresentation || element.dataset.ideHint;
                  return id && (!ids || ids.includes(id));
                }),
            );
          }
          if (!current()) throw new Error('This IDE request is no longer current.');
          await invokeAgent(event.providerId, 'agent_ide_ack', {
            requestId: request.requestId,
            status: 'applied',
          });
        };
        void apply().catch((error) => {
          void invokeAgent(event.providerId, 'agent_ide_ack', {
            requestId: request?.requestId || p.requestId,
            status: 'rejected',
            message: String(error),
          }).catch(() => {});
        });
      }
    })
      .then((unsubscribe) => {
        if (live) off = unsubscribe;
        else unsubscribe();
      })
      .catch((error) => notify(String(error), true));
    return () => {
      live = false;
      off?.();
    };
  }, [openDocument, notify, refreshAgentHighlights]);
  const navigate = useCallback(
    (uri: string, range?: SourceRange) => {
      void openDocument(uriPath(uri), range);
    },
    [openDocument],
  );
  const navigateReference = useCallback(
    async (reference: ContextReference) => {
      if (reference.kind === 'git') {
        setSnapshot({
          reference,
          reason: 'This is the Git context captured when it was added to chat.',
        });
        return;
      }
      const openedRoot = workspaceRef.current?.root;
      try {
        if (reference.uri && reference.version) {
          const path = uriPath(reference.uri);
          const source =
            docsRef.current.find((doc) => doc.path === path) ||
            (await invoke<Document>('workspace_read', { path }));
          if (workspaceRef.current?.root !== openedRoot) return;
          if (sourceMatchesVersion(source, reference.version)) {
            navigate(reference.uri, reference.ranges?.[0]);
            return;
          }
        }
        setSnapshot({
          reference,
          reason: reference.version
            ? 'The source has changed. This is the captured version.'
            : 'This is the captured context. Its original position cannot be verified.',
        });
      } catch {
        if (workspaceRef.current?.root !== openedRoot) return;
        setSnapshot({
          reference,
          reason: 'The original source is unavailable. This snapshot is still available.',
        });
      }
    },
    [navigate],
  );
  const openSymbol = useCallback(
    async (symbol: SymbolItem) => {
      const openedRoot = workspaceRef.current?.root;
      const path = uriPath(symbol.uri);
      if (symbol.version) {
        try {
          const source =
            docsRef.current.find((doc) => doc.path === path) ||
            (await invoke<Document>('workspace_read', { path }));
          if (workspaceRef.current?.root !== openedRoot) return;
          if (!sourceMatchesVersion(source, symbol.version)) {
            notify('This symbol changed. Refresh the index to follow its new position.');
            await openDocument(path);
            return;
          }
        } catch (error) {
          notify(String(error), true);
          return;
        }
      }
      await openDocument(path, symbol.selectionRange);
    },
    [openDocument, notify],
  );
  const addReference = useCallback((reference: ContextReference) => {
    setReferences((old) => {
      if (
        old.reduce((sum, item) => sum + item.content.length, 0) + reference.content.length >
        MAX_CONTEXT
      ) {
        setNotice({
          text: 'Context is limited to 64,000 characters. Remove an attachment first.',
          error: true,
        });
        return old;
      }
      if (
        old.some(
          (item) =>
            item.kind === reference.kind &&
            item.uri === reference.uri &&
            item.version === reference.version &&
            item.label === reference.label &&
            item.content === reference.content,
        )
      )
        return old;
      return [...old, reference];
    });
    setShowChat(true);
  }, []);
  const attachTarget = useCallback(
    async (target: {
      uri: string;
      ranges?: SourceRange[];
      kind?: ContextReference['kind'];
      label?: string;
      prefix?: string;
      version?: string;
    }) => {
      const attachedRoot = workspaceRef.current?.root;
      const attachedThread = activeChat.current;
      const attachedConnection = activeChatConnection.current;
      try {
        const path = uriPath(target.uri);
        const current = docsRef.current.find((doc) => doc.path === path);
        const source = current || (await invoke<Document>('workspace_read', { path }));
        if (
          workspaceRef.current?.root !== attachedRoot ||
          activeChat.current !== attachedThread ||
          activeChatConnection.current !== attachedConnection
        )
          return;
        if (target.version && !sourceMatchesVersion(source, target.version)) {
          notify('This source changed. Refresh the graph or search again before attaching it.');
          return;
        }
        const label =
          target.label ||
          (target.ranges?.length
            ? `${basename(path)}:${target.ranges[0].start.line + 1}-${target.ranges[0].end.line + 1}`
            : basename(path));
        addReference(
          makeReference({
            kind: target.kind || 'file',
            label,
            origin: 'Editor',
            uri: target.uri,
            ranges: target.ranges,
            version: bufferVersion(source.content),
            content: (target.prefix || '') + sourceExcerpt(source.content, target.ranges),
          }),
        );
      } catch (e) {
        notify(String(e), true);
      }
    },
    [addReference, notify],
  );
  const attachFile = useCallback(
    (path: string) => {
      void attachTarget({ uri: fileUri(path), kind: 'file' });
    },
    [attachTarget],
  );
  const attachSelection = useCallback(() => {
    const editor = editorRef.current,
      model = editor?.getModel(),
      selection = editor?.getSelection();
    if (!model || !selection) {
      setPalette('context');
      return;
    }
    void attachTarget({
      uri: model.uri.toString(),
      kind: selection.isEmpty() ? 'file' : 'selection',
      ranges: selection.isEmpty() ? undefined : [fromRange(selection)],
    });
    setShowChat(true);
    setTimeout(() => window.dispatchEvent(new Event('workbench:focus-chat')), 50);
  }, [attachTarget]);

  const inspect = useCallback(
    async (symbol?: SymbolItem) => {
      if (symbol) await openSymbol(symbol);
      setTool('hierarchy');
      setShowTools(true);
      setGraphRevision((value) => value + 1);
    },
    [openSymbol],
  );
  const graphSource = JSON.stringify([
    workspace?.root,
    activePath,
    documents.map((doc) => [
      doc.path,
      doc.modelVersion,
      doc.version,
      doc.content === doc.savedContent,
    ]),
    activeLanguage,
    graphRevision,
    editorRevision,
  ]);
  useEffect(() => {
    const model = editorRef.current?.getModel();
    const doc = docsRef.current.find((item) => item.path === activePath);
    if (
      !showTools ||
      tool !== 'hierarchy' ||
      !workspace ||
      !doc ||
      isUntitled(doc.path) ||
      !model ||
      uriPath(model.uri.toString()) !== activePath
    ) {
      graphFollower.clear();
      setHierarchy(null);
      setHierarchyLoading(false);
      setHierarchyError('');
      return;
    }
    if (activeLanguage?.status === 'starting') {
      graphFollower.clear();
      setHierarchy(null);
      setHierarchyLoading(true);
      return;
    }
    const position = { line: cursor.line - 1, character: cursor.column - 1 };
    const buffers = docsRef.current.filter((item) => !isUntitled(item.path));
    const savedVersions = new Map(
      buffers
        .filter((item) => item.content === item.savedContent)
        .map((item) => [fileUri(item.path), item.version]),
    );
    const sourceVersions = new Map(
      buffers.map((item) => [fileUri(item.path), bufferVersion(item.content)]),
    );
    graphFollower.select(graphSource, async (signal) => {
      signal.throwIfAborted();
      if (semanticCallHierarchy) {
        const language = doc.language === 'javascript' ? 'typescript' : doc.language;
        await Promise.all(
          buffers
            .filter(
              (item) =>
                (item.language === 'javascript' ? 'typescript' : item.language) === language,
            )
            .map((item) => syncLanguageDocument(item.path, item.content, item.modelVersion)),
        );
        signal.throwIfAborted();
        const request = <T,>(method: string, params: object, requestSignal: AbortSignal) =>
          lspRequest<T>(model, method, params, requestSignal);
        const uri = model.uri.toString();
        const modelVersion = model.getVersionId();
        const outline = async () => {
          const cached = graphOutline.current;
          if (cached?.model === model && cached.version === modelVersion) return cached.symbols;
          const symbols = await request<DocumentSymbol[] | null>(
            'textDocument/documentSymbol',
            {},
            signal,
          );
          signal.throwIfAborted();
          if (!model.isDisposed() && model.getVersionId() === modelVersion)
            graphOutline.current = { model, version: modelVersion, symbols };
          return symbols;
        };
        const root = await resolveCallRoot(request, uri, position, signal, outline);
        if (!root) return null;
        const session = createSemanticCallGraph(root, request);
        let versions = new Map(savedVersions);
        let evidenceError = '';
        let displayVersions = new Map([...versions, ...sourceVersions]);
        let latestGraph: CallHierarchy | undefined;
        const shared = new Set<string>();
        const display = (value: CallHierarchy) => {
          latestGraph = value;
          const next = withCallGraphVersions(value, displayVersions);
          if (evidenceError && next.traversal)
            next.traversal = {
              ...next.traversal,
              state: next.traversal.state === 'complete' ? 'partial' : next.traversal.state,
              reasons: [...next.traversal.reasons, evidenceError],
            };
          return next;
        };
        const finish = (
          next: CallHierarchy,
          crawlSignal: AbortSignal,
          onProgress: (hierarchy: CallHierarchy) => void,
        ) => {
          const relations = (next.relations || []).filter(
            (edge) =>
              !shared.has(
                JSON.stringify([symbolKey(edge.from), symbolKey(edge.to), edge.fromRanges]),
              ),
          );
          // Share each revealed internal relation; unopened branches stay unexplored.
          if (isDesktop && !evidenceError) {
            void (async () => {
              for (const batch of packCallGraphEvidence(relations)) {
                crawlSignal.throwIfAborted();
                const uris = new Set(batch.flatMap((edge) => [edge.from.uri, edge.to.uri]));
                const batchVersions = Object.fromEntries(
                  [...versions].filter(([uri]) => uris.has(uri)),
                );
                await invoke('index_record_graph', {
                  graph: { root, incoming: [], outgoing: [], relations: batch },
                  versions: batchVersions,
                });
                for (const edge of batch)
                  shared.add(
                    JSON.stringify([symbolKey(edge.from), symbolKey(edge.to), edge.fromRanges]),
                  );
              }
            })().catch((error) => {
              if (crawlSignal.aborted) return;
              evidenceError = `Call evidence could not be shared with the code index: ${String(error).replace(/^Error: /, '')}`;
              onProgress(display(latestGraph || next));
            });
          }
          return display(next);
        };
        return {
          key: `semantic:${symbolKey(root)}`,
          load: async (crawlSignal, onProgress) => {
            if (isDesktop) {
              try {
                const manifest = await invoke<Record<string, string>>('index_source_versions');
                crawlSignal.throwIfAborted();
                versions = new Map(Object.entries(manifest));
                for (const buffer of buffers) {
                  const uri = fileUri(buffer.path);
                  if (buffer.content !== buffer.savedContent) versions.delete(uri);
                  else versions.set(uri, buffer.version);
                }
              } catch (error) {
                crawlSignal.throwIfAborted();
                evidenceError = `Shared call evidence is unavailable: ${String(error).replace(/^Error: /, '')}`;
              }
            }
            displayVersions = new Map([...versions, ...sourceVersions]);
            return finish(
              await session.load(crawlSignal, (value) => onProgress(display(value))),
              crawlSignal,
              onProgress,
            );
          },
          expand: async (
            symbol: SymbolItem,
            direction: CallDirection,
            crawlSignal: AbortSignal,
            onProgress: (value: CallHierarchy) => void,
          ) =>
            finish(
              await session.expand(symbol, direction, crawlSignal, (value) =>
                onProgress(display(value)),
              ),
              crawlSignal,
              onProgress,
            ),
        };
      }
      if (!isDesktop) throw new Error('Open the desktop app for live call hierarchy.');
      if (buffers.some((item) => item.content !== item.savedContent))
        throw new Error(
          'This language uses the saved-source call index. Save your edits to refresh its graph.',
        );
      const root = await invoke<IndexNode | null>('index_symbol_at', { path: doc.path, position });
      signal.throwIfAborted();
      if (!root) return null;
      return { key: `index:${root.id}`, ...createIndexCallGraph(root) };
    });
  }, [
    showTools,
    tool,
    workspace,
    activePath,
    activeLanguage,
    semanticCallHierarchy,
    graphSource,
    cursor.line,
    cursor.column,
    graphFollower,
  ]);
  useEffect(() => () => graphFollower.clear(), [graphFollower]);
  useEffect(() => {
    const refresh = () => setGraphRevision((value) => value + 1);
    window.addEventListener('workbench:files-changed', refresh);
    return () => window.removeEventListener('workbench:files-changed', refresh);
  }, []);
  useEffect(() => {
    if (!isDesktop || !workspace || !showTools || tool !== 'hierarchy') return;
    let live = true;
    let off: (() => void) | undefined;
    void onEvent<IndexStatus>('index:changed', (status) => {
      if (
        live &&
        status.root === workspace.root &&
        (status.state === 'ready' || status.state === 'error')
      )
        setGraphRevision((value) => value + 1);
    })
      .then((unsubscribe) => {
        if (live) off = unsubscribe;
        else unsubscribe();
      })
      .catch((error) => {
        if (live) notify(String(error), true);
      });
    return () => {
      live = false;
      off?.();
    };
  }, [workspace, showTools, tool, notify]);
  const attachSymbol = useCallback(
    (symbol: SymbolItem, relation?: CallRelation) => {
      if (relation)
        void attachTarget({
          uri: relation.from.uri,
          ranges: relation.fromRanges,
          kind: 'caller',
          version: relation.from.version,
          label: `${relation.from.name} → ${relation.to.name}`,
          prefix: `Caller: ${relation.from.name}\nTarget: ${relation.to.name}\nEvidence: ${relation.evidence || 'language server'}\nCall sites (${relation.fromRanges.length}):\n`,
        });
      else
        void attachTarget({
          uri: symbol.uri,
          ranges: [symbol.range],
          kind: 'symbol',
          version: symbol.version,
          label: symbol.name,
        });
    },
    [attachTarget],
  );
  function lintSavedDocument(doc: EditorDocument, root: string) {
    if (doc.language !== 'markdown' && !workspaceRef.current?.trusted) return;
    const request = (lintRequests.current.get(doc.path) || 0) + 1;
    lintRequests.current.set(doc.path, request);
    const lint =
      doc.language === 'markdown'
        ? Promise.resolve().then(
            (): LintResult => ({
              path: doc.path,
              version: doc.version,
              tool: 'remark-lint',
              status: 'ok',
              scope: 'file',
              diagnostics: lintMarkdown(doc.content, doc.path),
            }),
          )
        : invoke<LintResult>('quality_lint', { path: doc.path, version: doc.version });
    void lint
      .then((result) => {
        if (
          workspaceRef.current?.root !== root ||
          lintRequests.current.get(doc.path) !== request ||
          result.status === 'stale'
        )
          return;
        const key = `${result.tool}:${result.scope === 'workspace' ? root : doc.path}`;
        const current = docsRef.current.find((item) => item.path === doc.path);
        if (
          result.scope === 'file' &&
          current &&
          (current.content !== doc.content || current.version !== doc.version)
        )
          return;
        const visible = lintForSavedBuffers(result.diagnostics, docsRef.current);
        setLintDiagnostics((old) => ({
          ...old,
          [key]: result.status === 'ok' ? visible : [],
        }));
        const model = monaco.editor.getModel(monaco.Uri.parse(editorModelUri(doc.path)));
        if (model && current?.content === doc.content)
          monaco.editor.setModelMarkers(
            model,
            'quality',
            visible
              .filter((item) => uriPath(item.uri) === doc.path)
              .map((item) => ({
                ...toRange(item.range),
                message: item.message,
                severity:
                  item.severity === 1 ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
                source: item.source,
                code: item.code === undefined ? undefined : String(item.code),
              })),
          );
        if (result.message && result.status !== 'unsupported')
          notify(`${basename(doc.path)} saved. ${result.message}`, result.status === 'error');
      })
      .catch((error) => {
        if (workspaceRef.current?.root === root)
          notify(`${basename(doc.path)} saved. Lint could not finish: ${String(error)}`, true);
      });
  }
  async function saveDocument(path = activeRef.current) {
    let pending = saves.current.get(path);
    while (pending) {
      await pending.catch(() => {});
      pending = saves.current.get(path);
    }
    const root = workspaceRef.current?.root;
    const original = docsRef.current.find((item) => item.path === path);
    if (!original || !root) return;
    if (isUntitled(path)) {
      if (saveAsRequest.current) throw new Error('Finish saving the other new file first.');
      return new Promise<void>((resolve, reject) => {
        saveAsRequest.current = { path, resolve, reject };
        setSaveAs({ path, input: '', error: '', working: false });
      });
    }
    const task = (async () => {
      let formatMessage: string | undefined;
      if (formatOnSave) {
        const model = monaco.editor.getModel(monaco.Uri.parse(editorModelUri(path)));
        const modelOptions = model?.getOptions();
        try {
          const formatted = await formatDocumentContent(
            path,
            original.content,
            original.modelVersion,
            {
              lsp: !!languageStates[path]?.capabilities?.documentFormattingProvider,
              trusted: workspaceRef.current?.trusted === true,
              tabSize: modelOptions?.tabSize || 4,
              insertSpaces: modelOptions?.insertSpaces ?? true,
            },
          );
          const current = docsRef.current.find((item) => item.path === path);
          if (workspaceRef.current?.root !== root || !current) return;
          if (
            current.content !== original.content ||
            current.modelVersion !== original.modelVersion
          ) {
            formatMessage = 'Formatting was skipped because the file changed while it was running.';
          } else if (formatted.content !== original.content) {
            if (model && !model.isDisposed()) {
              model.pushStackElement();
              model.pushEditOperations(
                [],
                [{ range: model.getFullModelRange(), text: formatted.content }],
                () => null,
              );
              model.pushStackElement();
            }
            docsRef.current = docsRef.current.map((item) =>
              item.path === path
                ? {
                    ...item,
                    content: formatted.content,
                    modelVersion: model?.getVersionId() || item.modelVersion + 1,
                  }
                : item,
            );
            setDocuments(docsRef.current);
          }
          formatMessage ||= formatted.message;
        } catch (error) {
          formatMessage = `Formatting could not finish: ${String(error)}`;
        }
      }
      const current = docsRef.current.find((item) => item.path === path);
      if (workspaceRef.current?.root !== root || !current) return;
      const captured = current.content;
      const result = await invoke<Document>('workspace_save', {
        path,
        content: captured,
        expectedVersion: current.version,
      });
      if (workspaceRef.current?.root !== root) return;
      docsRef.current = docsRef.current.map((item) =>
        item.path === path ? { ...item, savedContent: captured, version: result.version } : item,
      );
      setDocuments(docsRef.current);
      void syncLanguageDocument(path, captured, current.modelVersion)
        .then(() => {
          const latest = docsRef.current.find((item) => item.path === path);
          if (latest?.content === captured && latest.modelVersion === current.modelVersion)
            return invoke('language_save', {
              path,
              content: captured,
              version: current.modelVersion,
            });
        })
        .catch(() => {});
      if (lintOnSave)
        lintSavedDocument({ ...current, content: captured, version: result.version }, root);
      if (formatMessage) notify(`${basename(path)} saved. ${formatMessage}`);
      window.dispatchEvent(new Event('workbench:files-changed'));
      void refreshChanges();
    })()
      .catch((error) => {
        notify(`${basename(path)} was not saved. ${String(error)}`, true);
        throw error;
      })
      .finally(() => {
        saves.current.delete(path);
        setSaving(saves.current.size > 0);
      });
    saves.current.set(path, task);
    setSaving(true);
    await task;
  }
  function cancelSaveAs() {
    if (saveAs?.working) return;
    saveAsRequest.current?.reject(new Error('Save As was canceled.'));
    saveAsRequest.current = null;
    setSaveAs(null);
  }
  async function createUntitledFile() {
    const request = saveAsRequest.current;
    const root = workspaceRef.current?.root;
    if (!request || !saveAs || saveAs.working || !root) return;
    try {
      const path = resolveNewFilePath(root, saveAs.input);
      const current = docsRef.current.find((doc) => doc.path === request.path);
      if (!current) throw new Error('This unsaved editor has been closed.');
      if (docsRef.current.some((doc) => doc.path === path))
        throw new Error('This file is already open. Choose a new path.');
      setSaveAs((value) => value && { ...value, working: true, error: '' });
      const created = await invoke<Document>('workspace_create', {
        path,
        content: current.content,
      });
      if (workspaceRef.current?.root !== root)
        throw new Error('The workspace changed while creating this file.');
      const latest = docsRef.current.find((doc) => doc.path === request.path);
      if (!latest) throw new Error('This unsaved editor has been closed.');
      const language = languageId(created.path);
      const realModel =
        monaco.editor.getModel(monaco.Uri.parse(editorModelUri(created.path))) ||
        monaco.editor.createModel(
          latest.content,
          language,
          monaco.Uri.parse(editorModelUri(created.path)),
        );
      const next: EditorDocument = {
        ...latest,
        modelVersion: realModel.getVersionId(),
        path: created.path,
        language,
        version: created.version,
        savedContent: created.content,
      };
      docsRef.current = docsRef.current.map((doc) => (doc.path === request.path ? next : doc));
      setDocuments(docsRef.current);
      updateEditorLayout(
        replaceEditorFile(layoutRef.current, request.path, created.path, basename(created.path)),
      );
      startLanguageDocument(next);
      queueModelDisposal(request.path);
      saveAsRequest.current = null;
      setSaveAs(null);
      // The regular save path applies the configured formatter and linter now that a real file exists.
      try {
        await saveDocument(created.path);
        request.resolve();
      } catch (error) {
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
      window.dispatchEvent(new Event('workbench:files-changed'));
    } catch (error) {
      setSaveAs((value) => value && { ...value, working: false, error: String(error) });
    }
  }
  const refreshDocuments = useCallback(async () => {
    const refreshedRoot = workspaceRef.current?.root;
    const results = await Promise.allSettled(
      docsRef.current
        .filter((doc) => !isUntitled(doc.path))
        .map(async (doc) => {
          const disk = await invoke<Document>('workspace_read', { path: doc.path });
          if (workspaceRef.current?.root !== refreshedRoot) return;
          if (disk.version === doc.version) return;
          const current = docsRef.current.find((d) => d.path === doc.path);
          if (!current || current.version !== doc.version) return;
          if (current.content !== current.savedContent) {
            notify(
              `${basename(doc.path)} changed on disk. Your unsaved edits are kept. Compare or reload before saving.`,
              true,
            );
            return;
          }
          const model = monaco.editor.getModel(monaco.Uri.parse(editorModelUri(doc.path)));
          if (model && model.getValue() !== disk.content) model.setValue(disk.content);
          const modelVersion = model?.getVersionId() ?? current.modelVersion + 1;
          docsRef.current = docsRef.current.map((item) =>
            item.path === doc.path
              ? { ...item, ...disk, savedContent: disk.content, modelVersion }
              : item,
          );
          setDocuments(docsRef.current);
          void syncLanguageDocument(doc.path, disk.content, modelVersion).catch((error) =>
            notify(String(error), true),
          );
        }),
    );
    results.forEach((result) => {
      if (result.status === 'rejected') console.warn(result.reason);
    });
    window.dispatchEvent(new Event('workbench:files-changed'));
    void refreshChanges();
  }, [notify, refreshChanges]);
  const queueAction = useCallback(
    (run: PendingAction['run'], cancel?: PendingAction['cancel'], paths?: () => Set<string>) => {
      pendingActionRef.current?.cancel?.();
      const next = { run, cancel, paths };
      pendingActionRef.current = next;
      setPendingAction(next);
    },
    [],
  );
  function cancelPendingAction() {
    pendingActionRef.current?.cancel?.();
    pendingActionRef.current = null;
    setPendingAction(null);
  }
  async function finishPendingAction(action: PendingAction | null) {
    if (!action || pendingActionRef.current !== action) return;
    pendingActionRef.current = null;
    setPendingAction(null);
    await action.run();
  }
  function guarded(action: () => void) {
    if (docsRef.current.some((doc) => doc.content !== doc.savedContent)) queueAction(action);
    else action();
  }
  async function openFolder() {
    if (busy) {
      notify('Stop the current response before changing workspaces.');
      return;
    }
    guarded(() => {
      void invoke<Workspace>('workspace_open')
        .then((next) => {
          if (!next) return;
          graphFollower.clear();
          graphOutline.current = null;
          workspaceRef.current = next;
          activeChat.current = null;
          activeChatConnection.current = null;
          resetPresentations();
          setExternalPrompt(null);
          docsRef.current.forEach((doc) => {
            if (!isUntitled(doc.path)) {
              configureLanguageModel(doc.path);
              void closeLanguageDocument(doc.path).catch(() => {});
            }
            queueModelDisposal(doc.path);
          });
          docsRef.current = [];
          editorViews.current.clear();
          setDocuments([]);
          updateEditorLayout(createEditorLayout());
          setReferences([]);
          graphFollower.clear();
          setHierarchyLoading(false);
          setHierarchy(null);
          setDiagnostics({});
          setBuiltinDiagnostics({});
          setLintDiagnostics({});
          lintRequests.current.clear();
          setFileIndex([]);
          setGitStatus(null);
          setGitHistoryPath(undefined);
          setWorkspace(next);
          setTrustPrompt(null);
          setTrustError('');
          historyRef.current = [];
          historyIndex.current = -1;
        })
        .catch((e) => notify(String(e), true));
    });
  }
  async function trustWorkspace() {
    const root = trustPrompt;
    if (!root) return;
    setTrustWorking(true);
    setTrustError('');
    try {
      await invoke('workspace_trust', { root });
      const current = workspaceRef.current;
      if (!current || current.root !== root)
        throw new Error('The workspace changed. Review the current folder.');
      const next = { ...current, trusted: true };
      workspaceRef.current = next;
      setWorkspace(next);
      setTrustPrompt(null);
      for (const doc of docsRef.current) {
        if (!isUntitled(doc.path)) startLanguageDocument(doc);
      }
      setTimeout(() => editorRef.current?.focus(), 0);
    } catch (error) {
      setTrustError(String(error));
    } finally {
      setTrustWorking(false);
    }
  }
  function flushModelDisposals() {
    for (const uri of orphanModels.current) {
      if (docsRef.current.some((doc) => editorModelUri(doc.path) === uri)) {
        orphanModels.current.delete(uri);
        continue;
      }
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (model && monaco.editor.getEditors().some((editor) => editor.getModel() === model))
        continue;
      model?.dispose();
      orphanModels.current.delete(uri);
    }
  }
  function queueModelDisposal(path: string) {
    orphanModels.current.add(editorModelUri(path));
    setTimeout(flushModelDisposals, 0);
  }
  function releaseClosedDocuments(next: EditorLayout) {
    const paths = editorDocumentPaths(next);
    const closed = docsRef.current.filter((doc) => !paths.has(doc.path));
    docsRef.current = docsRef.current.filter((doc) => paths.has(doc.path));
    setDocuments(docsRef.current);
    for (const doc of closed) {
      if (!isUntitled(doc.path)) {
        configureLanguageModel(doc.path);
        void closeLanguageDocument(doc.path).catch(() => {});
      }
      queueModelDisposal(doc.path);
    }
  }
  function closeEditorViews(nextLayout: () => EditorLayout) {
    const closingPaths = () => editorClosingPaths(layoutRef.current, nextLayout());
    const paths = closingPaths();
    const unsaved = docsRef.current.some(
      (doc) => paths.has(doc.path) && doc.content !== doc.savedContent,
    );
    const close = () => {
      const latest = nextLayout();
      updateEditorLayout(latest);
      releaseClosedDocuments(latest);
      graphFollower.clear();
    };
    if (unsaved) queueAction(close, undefined, closingPaths);
    else close();
  }
  function closeEditorTabs(group: string, tabs: string[]) {
    if (!tabs.length) return;
    closeEditorViews(() =>
      tabs.reduce((layout, tab) => closeEditorTab(layout, group, tab), layoutRef.current),
    );
  }
  function closeEditor(group: string, tab: string) {
    closeEditorTabs(group, [tab]);
  }
  function closeGroup(group: string) {
    closeEditorViews(() => closeEditorGroup(layoutRef.current, group));
  }
  function splitGroup(
    group: string,
    direction: EditorSplit['direction'],
    tab?: string,
    move = false,
  ) {
    updateEditorLayout(
      splitEditorGroup(layoutRef.current, group, direction, crypto.randomUUID(), tab, move),
    );
  }
  function newEditor(group = layoutRef.current.activeGroup) {
    const title = `Untitled-${++untitledCount.current}`;
    const path = `untitled:/${crypto.randomUUID()}/${title}`;
    const doc: EditorDocument = {
      path,
      content: '',
      savedContent: '',
      version: '',
      modelVersion: 1,
      language: 'plaintext',
    };
    docsRef.current = [...docsRef.current, doc];
    setDocuments(docsRef.current);
    updateEditorLayout(openEditorTab(layoutRef.current, fileEditorTab(path, title), group));
  }
  function _goHistory(delta: number) {
    const next = historyIndex.current + delta;
    const target = historyRef.current[next];
    if (target) {
      historyIndex.current = next;
      void openDocument(target.path, target.range, false);
    }
  }

  useEffect(() => {
    let live = true;
    initialWorkspace ||= invoke<Workspace | null>('workspace_current');
    initialWorkspace
      .then((value) => {
        if (live && value && !workspaceRef.current) {
          workspaceRef.current = value;
          setWorkspace(value);
          const path = value.root.endsWith('/harbor') ? `${value.root}/src/orders.rs` : '';
          if (path) void openDocument(path);
        }
      })
      .catch((e) => notify(String(e), true));
    const handles: (() => void)[] = [];
    onEvent<LanguageEvent>('language:event', (event) => {
      if (event.root && event.root !== workspaceRef.current?.root) return;
      if (event.method === 'workbench/status') {
        for (const doc of docsRef.current) {
          if (
            doc.language !== event.language &&
            !(doc.language === 'javascript' && event.language === 'typescript')
          )
            continue;
          if (event.params.status && event.params.status !== 'ready')
            configureLanguageModel(doc.path);
          else if (event.params.capabilities)
            configureLanguageModel(doc.path, event.params.capabilities);
        }
        setLanguageStates((old) =>
          Object.fromEntries(
            Object.entries(old).map(([path, value]) => [
              path,
              value.language === event.language ? { ...value, ...event.params } : value,
            ]),
          ),
        );
      }
      if (event.method === 'textDocument/publishDiagnostics') {
        const { uri, version, diagnostics: values } = event.params;
        const current = docsRef.current.find((doc) => doc.path === uriPath(uri));
        if (version !== undefined && current && current.modelVersion !== version) return;
        setDiagnostics((old) => ({ ...old, [uri]: values || [] }));
        const model = monaco.editor.getModel(monaco.Uri.parse(uri));
        if (model)
          monaco.editor.setModelMarkers(
            model,
            'lsp',
            (values || []).map((item: Diagnostic) => ({
              ...toRange(item.range),
              message: item.message,
              severity:
                item.severity === 1
                  ? monaco.MarkerSeverity.Error
                  : item.severity === 2
                    ? monaco.MarkerSeverity.Warning
                    : monaco.MarkerSeverity.Info,
              source: item.source,
              code: item.code === undefined ? undefined : String(item.code),
            })),
          );
      }
    })
      .then((off) => {
        if (live) handles.push(off);
        else off();
      })
      .catch((e) => notify(String(e), true));
    onEvent<{ kind: 'window' | 'app'; requestId: string }>(
      'workbench:close-requested',
      (request) => {
        const confirm = async () => {
          try {
            await invoke('host_confirm_close', { requestId: request.requestId });
          } catch (error) {
            notify(String(error), true);
          }
        };
        const cancel = () => {
          void invoke('host_cancel_close', { requestId: request.requestId }).catch(() => {});
        };
        if (docsRef.current.some((doc) => doc.content !== doc.savedContent))
          queueAction(confirm, cancel);
        else void confirm();
      },
    )
      .then((off) => {
        if (live) handles.push(off);
        else off();
      })
      .catch((e) => notify(String(e), true));
    return () => {
      live = false;
      handles.forEach((off) => {
        off();
      });
    };
  }, [openDocument, notify, queueAction]);
  useEffect(() => {
    if (!workspace) return;
    void refreshChanges();
    let live = true,
      visited = 0;
    const files: Entry[] = [];
    async function scan(path: string) {
      if (!live || ++visited > 150 || files.length > 3000) return;
      const entries = await invoke<Entry[]>('workspace_entries', { path });
      for (const entry of entries) {
        if (!live) return;
        if (entry.kind === 'file') files.push(entry);
        else if (
          !['node_modules', 'target', '.git', '.venv', 'venv', '.workbench', 'dist'].includes(
            entry.name,
          )
        )
          await scan(entry.path);
      }
    }
    scan(workspace.root)
      .then(() => {
        if (live) setFileIndex(files);
      })
      .catch((e) => notify(String(e), true));
    return () => {
      live = false;
    };
  }, [workspace, refreshChanges, notify]);
  useEffect(() => {
    if (notice && !notice.error) {
      const timer = setTimeout(() => setNotice(null), 4500);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  useEffect(() => {
    if (!document) return;
    if (editorRef.current) revealPendingLocation(editorRef.current);
  }, [document, revealPendingLocation]);

  actionsRef.current = {
    new: () => newEditor(),
    preview: () => showMarkdownPreview(activeRef.current, layoutRef.current.activeGroup, false),
    previewSide: () => showMarkdownPreview(),
    split: () => splitGroup(layoutRef.current.activeGroup, 'horizontal'),
    close: () => {
      const tab = activeEditorTab(layoutRef.current);
      if (tab) closeEditor(layoutRef.current.activeGroup, tab.id);
    },
    save: () => {
      void saveDocument().catch(() => {});
    },
    attach: attachSelection,
    inspect: () => {
      void inspect();
    },
    open: () => {
      void openFolder();
    },
    files: () => {
      setPalette('files');
      setPaletteQuery('');
    },
    commands: () => {
      setPalette('commands');
      setPaletteQuery('');
    },
    context: () => {
      setPalette('context');
      setPaletteQuery('');
    },
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      if (event.key.toLowerCase() === 'n' && !event.shiftKey) {
        event.preventDefault();
        actionsRef.current.new();
      } else if (event.key === '\\') {
        event.preventDefault();
        actionsRef.current.split();
      } else if (event.key.toLowerCase() === 'w' && !event.shiftKey) {
        event.preventDefault();
        actionsRef.current.close();
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        actionsRef.current.save();
      } else if (event.key.toLowerCase() === 'k' && !event.shiftKey) {
        event.preventDefault();
        actionsRef.current.commands();
      } else if (event.key.toLowerCase() === 'p') {
        event.preventDefault();
        actionsRef.current.files();
      } else if (event.key.toLowerCase() === 'l' && !event.shiftKey) {
        event.preventDefault();
        actionsRef.current.attach();
      } else if (event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setShowTools((value) => !value);
      } else if (event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setShowSidebar((value) => !value);
      } else if (event.key.toLowerCase() === 'f' && event.shiftKey) {
        event.preventDefault();
        setShowSidebar(true);
        setSidebar('search');
      } else if (event.key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    const onFocus = () => {
      void refreshDocuments();
    };
    window.addEventListener('focus', onFocus);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (docsRef.current.some((doc) => doc.content !== doc.savedContent)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [refreshDocuments]);
  function activateEditor(
    group: string,
    editor: monaco.editor.IStandaloneCodeEditor,
    focus = false,
  ) {
    const layout = layoutRef.current;
    const target = editorGroups(layout.root).find((item) => item.id === group);
    const selected = target?.activeTab ? layout.tabs[target.activeTab] : undefined;
    if (
      selected?.kind !== 'file' ||
      !editorPathMatches(selected.path, editor.getModel()?.uri.toString())
    )
      return;
    if (layoutRef.current.activeGroup !== group) {
      updateEditorLayout(focusEditorGroup(layoutRef.current, group));
    }
    if (editorController.current !== editor || !inlineProvider.current) {
      agentDecorations.current?.clear();
      agentDecorations.current = editor.createDecorationsCollection();
      inlineProvider.current?.dispose();
      editorRef.current = editor;
      editorController.current = editor;
      inlineProvider.current = installInlineCompletions({
        monaco,
        editor,
        enabled: () =>
          isDesktop &&
          completionSettings.current.enabled &&
          !!completionSettings.current.selection.providerId &&
          !isUntitled(activeRef.current),
        selection: () => completionSettings.current.selection,
        onStatusChange: setInlineStatus,
      });
    }
    revealPendingLocation(editor);
    refreshAgentHighlights(highlightsRef.current);
    const position = editor.getPosition();
    setCursor({ line: position?.lineNumber || 1, column: position?.column || 1 });
    setEditorRevision((value) => value + 1);
    if (
      focus ||
      (pendingEditorFocus.current?.group === group &&
        pendingEditorFocus.current.path === selected.path)
    ) {
      pendingEditorFocus.current = null;
      editor.focus();
    }
  }
  const activateEditorRef = useRef(activateEditor);
  activateEditorRef.current = activateEditor;
  useEffect(() => {
    const editor = editorInstances.current.get(editorLayout.activeGroup);
    const tab = activeEditorTab(editorLayout);
    if (
      editor &&
      tab?.kind === 'file' &&
      editorPathMatches(tab.path, editor.getModel()?.uri.toString())
    ) {
      activateEditorRef.current(editorLayout.activeGroup, editor);
    }
  }, [editorLayout]);
  function onEditorMount(group: string, editor: monaco.editor.IStandaloneCodeEditor) {
    editorInstances.current.set(group, editor);
    const rememberView = () => {
      const model = editor.getModel();
      const state = editor.saveViewState();
      if (model && state) editorViews.current.set(`${group}:${model.uri.toString()}`, state);
    };
    const restoreView = () => {
      const model = editor.getModel();
      const state = model && editorViews.current.get(`${group}:${model.uri.toString()}`);
      if (state) editor.restoreViewState(state);
    };
    restoreView();
    editor.onWillChangeModel(rememberView);
    editor.onDidScrollChange(rememberView);
    editor.onDidBlurEditorWidget(rememberView);
    editor.onDidChangeModel(() => {
      restoreView();
      setTimeout(flushModelDisposals, 0);
    });
    editor.onDidFocusEditorWidget(() => activateEditorRef.current(group, editor));
    editor.onDidChangeModel(() => {
      if (layoutRef.current.activeGroup !== group) return;
      graphFollower.clear();
      graphOutline.current = null;
      activateEditorRef.current(group, editor);
    });
    editor.addAction({
      id: 'workbench.attach',
      label: 'Add Selection to Chat',
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 4,
      run: () => {
        activateEditorRef.current(group, editor);
        actionsRef.current.attach();
      },
    });
    editor.addAction({
      id: 'workbench.hierarchy',
      label: 'Show Callers and Callees',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyH],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.5,
      run: () => {
        activateEditorRef.current(group, editor);
        actionsRef.current.inspect();
      },
    });
    editor.addAction({
      id: 'workbench.markdownPreview',
      label: 'Markdown: Open Preview',
      precondition: 'editorLangId == markdown',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyV],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: () => {
        activateEditorRef.current(group, editor);
        actionsRef.current.preview();
      },
    });
    editor.addAction({
      id: 'workbench.markdownPreviewSide',
      label: 'Markdown: Open Preview to the Side',
      precondition: 'editorLangId == markdown',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.1,
      run: () => {
        activateEditorRef.current(group, editor);
        actionsRef.current.previewSide();
      },
    });
    editor.addAction({
      id: 'workbench.gitHistory',
      label: 'Git: File History',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 2,
      run: () => {
        activateEditorRef.current(group, editor);
        openGitHistory(activeRef.current);
      },
    });
    editor.onDidChangeCursorPosition((event) => {
      rememberView();
      if (layoutRef.current.activeGroup === group)
        setCursor({ line: event.position.lineNumber, column: event.position.column });
    });
    const opener = monaco.editor.registerEditorOpener({
      async openCodeEditor(source, resource, selection) {
        if (source !== editor || resource.scheme !== 'file') return false;
        activateEditorRef.current(group, editor);
        const range =
          selection && 'startLineNumber' in selection
            ? fromRange(selection)
            : selection
              ? {
                  start: { line: selection.lineNumber - 1, character: selection.column - 1 },
                  end: { line: selection.lineNumber - 1, character: selection.column - 1 },
                }
              : undefined;
        await openDocument(uriPath(resource.toString()), range);
        return true;
      },
    });
    editor.onDidDispose(() => {
      opener.dispose();
      setTimeout(flushModelDisposals, 0);
      if (editorInstances.current.get(group) === editor) editorInstances.current.delete(group);
      if (editorRef.current === editor) {
        editorRef.current = null;
        editorController.current = null;
        inlineProvider.current?.dispose();
        inlineProvider.current = null;
      }
    });
    if (layoutRef.current.activeGroup === group) activateEditorRef.current(group, editor);
  }
  function onEdit(path: string, value: string | undefined, model: monaco.editor.ITextModel | null) {
    if (value === undefined || !model || !editorPathMatches(path, model.uri.toString())) return;
    const previous = docsRef.current.find((doc) => doc.path === path);
    if (!previous || (previous.content === value && previous.modelVersion === model.getVersionId()))
      return;
    graphFollower.clear();
    docsRef.current = docsRef.current.map((doc) =>
      doc.path === path ? { ...doc, content: value, modelVersion: model.getVersionId() } : doc,
    );
    setDocuments(docsRef.current);
    if (isUntitled(path)) return;
    lintRequests.current.set(path, (lintRequests.current.get(path) || 0) + 1);
    setLintDiagnostics((old) =>
      Object.fromEntries(
        Object.entries(old).map(([key, values]) => [
          key,
          values.filter((item) => uriPath(item.uri) !== path),
        ]),
      ),
    );
    monaco.editor.setModelMarkers(model, 'quality', []);
    void syncLanguageDocument(path, value, model.getVersionId()).catch(() => {});
  }
  const commands = [
    { id: 'new-file', label: 'New file', hint: '⌘ N', run: () => newEditor() },
    {
      id: 'split-right',
      label: 'Split editor right',
      hint: '⌘ \\',
      run: () => splitGroup(layoutRef.current.activeGroup, 'horizontal'),
    },
    {
      id: 'split-down',
      label: 'Split editor down',
      hint: '',
      run: () => splitGroup(layoutRef.current.activeGroup, 'vertical'),
    },
    ...(document?.language === 'markdown'
      ? [
          {
            id: 'markdown-preview',
            label: 'Markdown: Open Preview',
            hint: '⇧ ⌘ V',
            run: () => showMarkdownPreview(activeRef.current, layoutRef.current.activeGroup, false),
          },
          {
            id: 'markdown-preview-side',
            label: 'Markdown: Open Preview to the Side',
            hint: '',
            run: () => showMarkdownPreview(),
          },
        ]
      : []),
    { id: 'open', label: 'Open folder', hint: '', run: () => void openFolder() },
    { id: 'save', label: 'Save file', hint: '⌘ S', run: () => void saveDocument().catch(() => {}) },
    { id: 'attach', label: 'Add selection to chat', hint: '⌘ L', run: attachSelection },
    {
      id: 'git-history',
      label: 'Git: Commit graph and history',
      hint: '',
      run: () => openGitHistory(),
    },
    {
      id: 'git-file-history',
      label: 'Git: File history and blame',
      hint: '',
      run: () => openGitHistory(activePath),
    },
    {
      id: 'hierarchy',
      label: 'Show callers and callees',
      hint: '⌘ ⌥ H',
      run: () => void inspect(),
    },
    {
      id: 'definition',
      label: 'Go to definition',
      hint: 'F12',
      run: () => void editorRef.current?.getAction('editor.action.revealDefinition')?.run(),
    },
    {
      id: 'implementation',
      label: 'Go to implementation',
      hint: '⌘ F12',
      run: () => void editorRef.current?.getAction('editor.action.goToImplementation')?.run(),
    },
    {
      id: 'references',
      label: 'Find references',
      hint: '⇧ F12',
      run: () => void editorRef.current?.getAction('editor.action.referenceSearch.trigger')?.run(),
    },
    {
      id: 'format',
      label: 'Format document',
      hint: '⇧ ⌥ F',
      run: () => void editorRef.current?.getAction('editor.action.formatDocument')?.run(),
    },
    {
      id: 'inline',
      label: 'Request AI completion',
      hint: '⌘ ⌥ Space',
      run: () => inlineProvider.current?.trigger(),
    },
    {
      id: 'debug',
      label: 'Open harness debug panel',
      hint: '',
      run: () => {
        setTool('debug');
        setShowTools(true);
      },
    },
    { id: 'chat', label: 'Toggle chat panel', hint: '', run: () => setShowChat((v) => !v) },
    {
      id: 'terminal',
      label: 'Open command runner',
      hint: '⌘ J',
      run: () => {
        setShowTools(true);
        setTool('terminal');
      },
    },
    {
      id: 'extensions',
      label: 'Manage extensions',
      hint: '',
      run: () => {
        setSidebar('extensions');
        setShowSidebar(true);
      },
    },
    {
      id: 'connections',
      label: 'Manage model connections',
      hint: '',
      run: () => {
        if (busy) {
          notify('Stop the response before changing connections.');
          return;
        }
        setShowChat(true);
        setProviderSettingsOpen(true);
      },
    },
    { id: 'settings', label: 'Preferences', hint: '⌘ ,', run: () => setSettingsOpen(true) },
    ...extensionCommands.map((command) => ({ ...command, hint: 'Extension' })),
  ];
  const paletteShowsCommands = palette === 'commands' || paletteQuery.startsWith('>');
  const paletteCommands: PaletteAction[] = commands
    .filter((command) =>
      command.label.toLowerCase().includes(paletteQuery.replace(/^>/, '').trim().toLowerCase()),
    )
    .map((command) => ({ ...command, icon: <Command size={14} />, shortcut: command.hint }));
  const paletteFiles = fileIndex
    .filter((file) =>
      relativePath(file.path, workspace?.root || '')
        .toLowerCase()
        .includes(paletteQuery.toLowerCase()),
    )
    .slice(0, 50)
    .map(
      (file): PaletteAction => ({
        id: file.path,
        label: basename(file.path),
        detail: relativePath(file.path, workspace?.root || ''),
        icon: <FileIcon path={file.path} />,
        run: () => {
          if (palette === 'context') attachFile(file.path);
          else void openDocument(file.path);
        },
      }),
    );
  const paletteContext: PaletteAction[] =
    palette === 'context' && !paletteQuery
      ? [
          {
            id: 'context:selection',
            label: 'Editor selection or current file',
            shortcut: '⌘ L',
            icon: <MessageSquarePlus size={15} />,
            run: attachSelection,
          },
          ...(hierarchy
            ? [
                {
                  id: 'context:symbol',
                  label: hierarchy.root.name,
                  detail: 'Symbol',
                  icon: <Braces size={15} />,
                  run: () => attachSymbol(hierarchy.root),
                },
              ]
            : []),
        ]
      : [];
  const selectSidebar = (next: Sidebar) => {
    if (sidebar === next && showSidebar) setShowSidebar(false);
    else {
      setSidebar(next);
      setShowSidebar(true);
    }
  };

  return (
    <main className="workbench" data-native={isDesktop}>
      <header className="titlebar" data-tauri-drag-region>
        <div className="window-controls" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <button type="button" className="workspace-selector" onClick={openFolder} disabled={busy}>
          <FolderOpen size={15} />
          <span>{workspace?.name || 'Open folder'}</span>
          <ChevronDown size={12} />
        </button>
        {workspace?.branch && (
          <span className="branch-selector">
            <GitBranch size={14} />
            {workspace.branch}
          </span>
        )}
        {workspace && !workspace.trusted && (
          <Dialog.Root
            open={!!trustPrompt}
            onOpenChange={(open) => {
              if (trustWorking) return;
              setTrustError('');
              setTrustPrompt(open ? workspace.root : null);
            }}
          >
            <Dialog.Trigger asChild>
              <Button variant="secondary" size="sm">
                Trust workspace
              </Button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content className="dialog-content trust-dialog">
                <Dialog.Title>Enable project tools?</Dialog.Title>
                <Dialog.Description>
                  Language servers, formatters, and linters may run project code with your
                  permissions. Trust this folder only if you know its source. Editing works while
                  these tools are off.
                </Dialog.Description>
                <pre className="reference-snapshot">{trustPrompt}</pre>
                {trustError && (
                  <p className="error-text" role="alert">
                    {trustError}
                  </p>
                )}
                <div className="dialog-footer">
                  <Dialog.Close asChild>
                    <Button variant="ghost" size="sm" disabled={trustWorking}>
                      Keep tools off
                    </Button>
                  </Dialog.Close>
                  <Button size="sm" disabled={trustWorking} onClick={() => void trustWorkspace()}>
                    {trustWorking ? 'Enabling…' : 'Trust workspace'}
                  </Button>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        )}
        <div className="title-spacer" data-tauri-drag-region />
        <button
          type="button"
          className="command-search"
          aria-label="Search files and commands"
          onClick={() => actionsRef.current.files()}
        >
          <Search size={14} />
          <span>Search…</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="layout-controls">
          <Tooltip label="Toggle project panel (⌘B)">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle project panel"
              aria-pressed={showSidebar}
              onClick={() => setShowSidebar((v) => !v)}
            >
              <PanelLeft size={16} />
            </Button>
          </Tooltip>
          <Tooltip label="Toggle tool window (⌘J)">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle tool window"
              aria-pressed={showTools}
              onClick={() => setShowTools((v) => !v)}
            >
              <PanelBottom size={16} />
            </Button>
          </Tooltip>
          <Tooltip label="Toggle chat">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle chat panel"
              aria-pressed={showChat}
              onClick={() => setShowChat((v) => !v)}
            >
              <PanelRight size={16} />
            </Button>
          </Tooltip>
        </div>
      </header>
      <div className="workbench-body">
        <nav className="activity-rail" aria-label="Tool windows">
          {(
            [
              { id: 'project', icon: Files, label: 'Project' },
              { id: 'search', icon: Search, label: 'Search' },
              { id: 'changes', icon: GitBranch, label: 'Source control' },
              { id: 'extensions', icon: Puzzle, label: 'Extensions' },
            ] as const
          ).map((item) => (
            <Tooltip key={item.id} label={item.label} side="right">
              <button
                type="button"
                aria-label={item.label}
                aria-pressed={sidebar === item.id && showSidebar}
                className={sidebar === item.id && showSidebar ? 'active' : ''}
                onClick={() => selectSidebar(item.id)}
              >
                <item.icon size={20} />
                {item.id === 'changes' && !!gitStatus?.changes.length && (
                  <span className="rail-badge">{gitStatus.changes.length}</span>
                )}
              </button>
            </Tooltip>
          ))}
          <div className="rail-spacer" />
          <Tooltip label="Terminal" side="right">
            <button
              type="button"
              aria-label="Show terminal"
              aria-pressed={showTools && tool === 'terminal'}
              className={showTools && tool === 'terminal' ? 'active' : ''}
              onClick={() => {
                setTool('terminal');
                setShowTools((visible) => tool !== 'terminal' || !visible);
              }}
            >
              <Terminal size={20} />
            </button>
          </Tooltip>
          <Tooltip label="Settings (⌘,)" side="right">
            <button type="button" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={20} />
            </button>
          </Tooltip>
        </nav>
        <Group orientation="horizontal" className="main-panels">
          <Panel
            id="project"
            panelRef={sidebarPanel}
            collapsible
            collapsedSize="0px"
            defaultSize="200px"
            minSize="170px"
            maxSize="420px"
            className="sidebar"
          >
            <div
              className={sidebar === 'project' ? 'sidebar-content' : 'hidden'}
              data-ide-surface="project"
            >
              <FileTree
                workspace={workspace}
                activePath={activePath}
                onOpen={(path) => void openDocument(path)}
                onAttach={attachFile}
                onOpenFolder={openFolder}
              />
            </div>
            <div
              className={sidebar === 'search' ? 'sidebar-content' : 'hidden'}
              data-ide-surface="search"
            >
              <CodeSearch
                key={workspace?.root || 'none'}
                workspace={workspace}
                onOpen={(reference) => void navigateReference(reference)}
                onAttach={addReference}
                onError={notifyError}
                onGraph={(value) => {
                  if (workspaceRef.current?.root !== workspace?.root) return;
                  void inspect(value.root);
                }}
              />
            </div>
            {sidebar === 'changes' && workspace && (
              <GitSidebar
                key={workspace.root}
                root={workspace.root}
                activePath={activePath}
                visible={showSidebar}
                refreshToken={gitRefreshToken}
                onStatus={setGitStatus}
                onDiff={openGitDiff}
                onHistory={openGitHistory}
                onAttach={addReference}
                onOpen={(path, line) =>
                  void openDocument(
                    path,
                    line
                      ? {
                          start: { line: line - 1, character: 0 },
                          end: { line: line - 1, character: 0 },
                        }
                      : undefined,
                  )
                }
              />
            )}
            <div className={sidebar === 'extensions' ? 'sidebar-content' : 'hidden'}>
              <Extensions
                workspace={workspace}
                context={references}
                onAttach={addReference}
                onNavigate={navigate}
                onOpenReference={(reference) => void navigateReference(reference)}
                onBuildWithAgent={(text) => {
                  setShowChat(true);
                  setExternalPrompt({ text, key: Date.now() });
                }}
                onCommandsChange={setExtensionCommands}
              />
            </div>
          </Panel>
          <Separator
            className={showSidebar ? 'pane-separator' : 'hidden'}
            disabled={!showSidebar}
          />
          <Panel id="editor" minSize="380px" className="editor-column">
            <Group orientation="vertical">
              <Panel
                id="source"
                minSize="180px"
                defaultSize="72%"
                className="source-panel"
                data-ide-surface="editor"
              >
                <EditorWorkspace
                  layout={editorLayout}
                  dirtyPaths={new Set(dirty.map((doc) => doc.path))}
                  onFocus={(group, tab, focusEditor = true) => {
                    const next = focusEditorGroup(layoutRef.current, group, tab);
                    updateEditorLayout(next, focusEditor);
                    const editor = editorInstances.current.get(group);
                    const selected = activeEditorTab(next);
                    if (
                      editor &&
                      selected?.kind === 'file' &&
                      editorPathMatches(selected.path, editor?.getModel()?.uri.toString())
                    )
                      activateEditor(group, editor, focusEditor);
                  }}
                  onClose={closeEditor}
                  onCloseTabs={closeEditorTabs}
                  onCloseGroup={closeGroup}
                  onSplit={splitGroup}
                  onMove={(from, to, tab, before) =>
                    updateEditorLayout(moveEditorTab(layoutRef.current, from, to, tab, before))
                  }
                  onNew={newEditor}
                  renderActions={(group, tab) => {
                    if (tab?.kind === 'markdown-preview')
                      return (
                        <Tooltip label="Open Markdown source">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Open Markdown source"
                            onClick={() => openMarkdownSource(tab.path)}
                          >
                            <FileCode2 size={14} />
                          </Button>
                        </Tooltip>
                      );
                    const source = documents.find((doc) => doc.path === editorTabPath(tab));
                    if (tab?.kind !== 'file' || source?.language !== 'markdown') return null;
                    return (
                      <Tooltip label="Open Markdown preview to the side">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Open Markdown preview to the side"
                          onClick={() => showMarkdownPreview(source.path, group.id)}
                        >
                          <Eye size={14} />
                        </Button>
                      </Tooltip>
                    );
                  }}
                  renderMenuActions={(group, tab) => {
                    const path = editorTabPath(tab);
                    if (!path) return null;
                    const source = documents.find((doc) => doc.path === path);
                    if (!source) return null;
                    const focus = () => {
                      updateEditorLayout(focusEditorGroup(layoutRef.current, group.id));
                      const editor = editorInstances.current.get(group.id);
                      if (tab?.kind === 'file' && editor) activateEditor(group.id, editor);
                    };
                    return (
                      <>
                        {tab?.kind === 'file' && source.language === 'markdown' && (
                          <DropdownMenu.Item
                            className="dropdown-item"
                            onSelect={() => showMarkdownPreview(path, group.id, false)}
                          >
                            <Eye size={13} /> Open preview
                            <span className="editor-menu-key">⇧ ⌘ V</span>
                          </DropdownMenu.Item>
                        )}
                        <DropdownMenu.Item
                          className="dropdown-item"
                          onSelect={() => {
                            focus();
                            if (tab?.kind === 'file') attachSelection();
                            else attachFile(path);
                          }}
                        >
                          <MessageSquarePlus size={13} />
                          {tab?.kind === 'file'
                            ? 'Add selection or file to chat'
                            : 'Add file to chat'}
                        </DropdownMenu.Item>
                        {!isUntitled(path) && (
                          <>
                            <DropdownMenu.Item
                              className="dropdown-item"
                              onSelect={() => {
                                focus();
                                openGitHistory(path);
                              }}
                            >
                              <GitCommitHorizontal size={13} /> File history
                            </DropdownMenu.Item>
                            {tab?.kind === 'file' && (
                              <DropdownMenu.CheckboxItem
                                className="dropdown-item"
                                checked={lineBlameEnabled}
                                onCheckedChange={(enabled) => {
                                  focus();
                                  setLineBlameEnabled(enabled);
                                  localStorage.setItem('workbench.lineBlame', String(enabled));
                                }}
                              >
                                <GitCommitHorizontal size={13} /> Show line blame
                                <DropdownMenu.ItemIndicator className="editor-menu-key">
                                  <Check size={13} />
                                </DropdownMenu.ItemIndicator>
                              </DropdownMenu.CheckboxItem>
                            )}
                          </>
                        )}
                      </>
                    );
                  }}
                  renderContent={(group, tab) => {
                    if (tab?.kind === 'diff' && workspace)
                      return (
                        <GitDiffPane
                          key={`${workspace.root}:${tab.id}:${group.id}`}
                          root={workspace.root}
                          request={tab.request}
                          title={tab.title}
                          modelId={group.id}
                          onAttach={addReference}
                        />
                      );
                    const source = documents.find((doc) => doc.path === editorTabPath(tab));
                    if (tab?.kind === 'markdown-preview' && source)
                      return (
                        <MarkdownPane
                          key={`${tab.id}:${group.id}`}
                          path={source.path}
                          content={source.content}
                          onNavigateHeading={(range) => openMarkdownSource(source.path, range)}
                          onAttachHeading={addReference}
                          onOpenLink={(href) => openMarkdownLink(source.path, href)}
                        />
                      );
                    if (!source)
                      return (
                        <div className="editor-group-empty">
                          <span>
                            {workspace
                              ? 'Open a file or start a new one.'
                              : 'Open a folder to start coding.'}
                          </span>
                          <div>
                            <Button variant="secondary" onClick={() => newEditor(group.id)}>
                              New file
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => {
                                updateEditorLayout(focusEditorGroup(layoutRef.current, group.id));
                                actionsRef.current.files();
                              }}
                            >
                              Go to file <kbd>⌘ P</kbd>
                            </Button>
                          </div>
                        </div>
                      );
                    const status = languageStates[source.path];
                    return (
                      <>
                        <div className="breadcrumbs">
                          {isUntitled(source.path) ? (
                            <span className="editor-untitled-hint">New file · Save with ⌘ S</span>
                          ) : (
                            relativePath(source.path, workspace?.root || '')
                              .split('/')
                              .map((part, index, parts) => (
                                <span key={parts.slice(0, index + 1).join('/')}>
                                  {index > 0 && <ChevronRight size={12} />}
                                  {index === parts.length - 1 && <FileIcon path={source.path} />}
                                  {part}
                                </span>
                              ))
                          )}
                          {hierarchy && uriPath(hierarchy.root.uri) === source.path && (
                            <span>
                              <ChevronRight size={12} />
                              <Braces size={13} className="violet" />
                              {hierarchy.root.name}
                            </span>
                          )}
                          <span className="breadcrumb-spacer" />
                          {!isUntitled(source.path) && (
                            <Tooltip
                              label={
                                hasBuiltInLanguageService(source.language)
                                  ? 'Built-in language service: completion and formatting'
                                  : status?.message ||
                                    `Language server: ${status?.status || 'starting'}`
                              }
                            >
                              <span
                                className={`language-indicator ${status?.status === 'ready' ? 'success' : 'muted'}`}
                              >
                                {status?.status === 'starting' ? (
                                  <LoaderCircle className="spin" size={11} />
                                ) : (
                                  <span className="small-dot" />
                                )}
                                {hasBuiltInLanguageService(source.language)
                                  ? 'Built-in'
                                  : status?.status === 'ready'
                                    ? 'LSP'
                                    : status?.status === 'unavailable'
                                      ? 'Syntax only'
                                      : status?.status || 'Starting'}
                              </span>
                            </Tooltip>
                          )}
                        </div>
                        <SourceEditor
                          key={group.id}
                          group={group.id}
                          document={source}
                          fontSize={fontSize}
                          inlineEnabled={inlineEnabled}
                          onMount={onEditorMount}
                          onEdit={onEdit}
                        />
                      </>
                    );
                  }}
                />
              </Panel>
              <Separator
                className={showTools ? 'pane-separator horizontal' : 'hidden'}
                disabled={!showTools}
              />
              <Panel
                id="tools"
                panelRef={toolsPanel}
                collapsible
                collapsedSize="0px"
                defaultSize="28%"
                minSize="160px"
                maxSize="65%"
                className="tools-panel"
              >
                <div
                  className="tool-tabs"
                  role="tablist"
                  aria-label="Tool window"
                  data-ide-surface="tools"
                >
                  {(
                    [
                      { id: 'hierarchy', icon: Network, label: 'Call hierarchy' },
                      { id: 'problems', icon: TriangleAlert, label: 'Problems' },
                      { id: 'terminal', icon: Terminal, label: 'Terminal' },
                      { id: 'git', icon: GitBranch, label: 'Git' },
                      { id: 'debug', icon: Bug, label: 'Debug' },
                    ] as const
                  ).map((tab) => (
                    <button
                      type="button"
                      key={tab.id}
                      role="tab"
                      aria-selected={tool === tab.id}
                      className={tool === tab.id ? 'active' : ''}
                      onClick={() => setTool(tab.id)}
                    >
                      <tab.icon size={14} />
                      {tab.label}
                      {tab.id === 'problems' && allDiagnostics.length > 0 && (
                        <span className="tool-count">{allDiagnostics.length}</span>
                      )}
                    </button>
                  ))}
                  <div className="tabs-spacer" />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Close tool window"
                    onClick={() => setShowTools(false)}
                  >
                    <X size={14} />
                  </Button>
                </div>
                <div className={tool === 'hierarchy' ? 'tool-content' : 'hidden'}>
                  <CallGraph
                    hierarchy={hierarchy}
                    loading={hierarchyLoading}
                    error={hierarchyError}
                    onInspect={inspect}
                    onOpen={openSymbol}
                    onAttach={attachSymbol}
                    onCenter={inspect}
                    onExpand={graphFollower.expand}
                    onCancel={() => {
                      graphFollower.clear();
                      setHierarchyLoading(false);
                      setHierarchy(
                        (value) =>
                          value && {
                            ...value,
                            traversal: {
                              state: 'partial',
                              visited: value.traversal?.visited || value.nodes?.length || 1,
                              pending: 0,
                              boundaries: value.traversal?.boundaries || [],
                              reasons: [
                                ...(value.traversal?.reasons || []),
                                'Traversal stopped. Refresh to continue.',
                              ],
                            },
                          },
                      );
                    }}
                    onAttachGraph={() =>
                      hierarchy &&
                      addReference(
                        makeReference({
                          kind: 'graph',
                          label: `${hierarchy.root.name} call graph`,
                          origin: 'Call hierarchy',
                          uri: hierarchy.root.uri,
                          ranges: [hierarchy.root.range],
                          content: JSON.stringify(hierarchy, null, 2),
                        }),
                      )
                    }
                  />
                </div>
                <div className={tool === 'problems' ? 'tool-content' : 'hidden'}>
                  <Problems
                    diagnostics={allDiagnostics}
                    root={workspace?.root || ''}
                    onNavigate={navigate}
                    onAttach={addReference}
                  />
                </div>
                <div className={tool === 'debug' ? 'tool-content' : 'hidden'}>
                  <DebugPane visible={showTools && tool === 'debug'} />
                </div>
                <div className={tool === 'terminal' ? 'tool-content' : 'hidden'}>
                  <TerminalPane
                    key={workspace?.root}
                    root={workspace?.root || ''}
                    onAttach={addReference}
                  />
                </div>
                {workspace && (
                  <div className={tool === 'git' ? 'tool-content' : 'hidden'}>
                    <GitHistoryPane
                      key={`${workspace.root}:${gitHistoryPath || ''}`}
                      root={workspace.root}
                      path={gitHistoryPath}
                      visible={showTools && tool === 'git'}
                      activePath={activePath}
                      activeContent={document?.content}
                      line={cursor.line}
                      onDiff={openGitDiff}
                      onAttach={addReference}
                      onOpen={(path, line) =>
                        void openDocument(
                          path,
                          line
                            ? {
                                start: { line: line - 1, character: 0 },
                                end: { line: line - 1, character: 0 },
                              }
                            : undefined,
                        )
                      }
                    />
                  </div>
                )}
              </Panel>
            </Group>
          </Panel>
          <Separator className={showChat ? 'pane-separator' : 'hidden'} disabled={!showChat} />
          <Panel
            id="agent"
            panelRef={chatPanel}
            collapsible
            collapsedSize="0px"
            defaultSize="320px"
            minSize="290px"
            maxSize="50%"
            className="agent-panel"
          >
            <ChatPane
              key={`${workspace?.root || ''}:${agentSelection.providerId}`}
              workspaceRoot={workspace?.root}
              providerSettingsOpen={providerSettingsOpen}
              onProviderSettingsOpenChange={setProviderSettingsOpen}
              presentations={presentations}
              onDismissPresentation={(id) =>
                setPresentations((old) => old.filter((item) => item.id !== id))
              }
              onResetPresentations={resetPresentations}
              onChatChange={changeChat}
              references={references}
              onRemove={(id) => setReferences((old) => old.filter((ref) => ref.id !== id))}
              onClear={() => setReferences([])}
              onUpdate={(reference) => {
                if (!reference.uri) return;
                setReferences((old) => old.filter((ref) => ref.id !== reference.id));
                const current = docsRef.current.find(
                  (doc) => doc.path === uriPath(reference.uri || ''),
                );
                const staleRange =
                  reference.ranges?.length &&
                  (!reference.version ||
                    !current ||
                    !sourceMatchesVersion(current, reference.version));
                void attachTarget({
                  uri: reference.uri,
                  ranges: staleRange ? undefined : reference.ranges,
                  kind: staleRange ? 'file' : reference.kind,
                  label: staleRange ? basename(uriPath(reference.uri)) : reference.label,
                });
                if (staleRange)
                  notify('Attached the current file. Select code to capture a new range.');
              }}
              isStale={(reference) => {
                if (reference.kind === 'git') return false;
                const doc = documents.find((item) => item.path === uriPath(reference.uri || ''));
                return !!(
                  doc &&
                  reference.version &&
                  !sourceMatchesVersion(doc, reference.version)
                );
              }}
              onNavigate={navigate}
              onOpenReference={(reference) => void navigateReference(reference)}
              selection={agentSelection}
              onSelectionChange={(selection) => {
                if (busy && selection.providerId !== activeProvider.current) {
                  notify('Stop the response before switching providers.');
                  return;
                }
                const changed = selection.providerId !== activeProvider.current;
                activeProvider.current = selection.providerId;
                setAgentSelection(selection);
                saveAgentSelection(selection);
                if (changed) changeChat(null, null);
              }}
              onPickContext={() => {
                setPalette('context');
                setPaletteQuery('');
              }}
              onDropTarget={(target) => void attachTarget(target)}
              onDropReference={addReference}
              onTurnComplete={() => void refreshDocuments()}
              onBusy={setBusy}
              externalPrompt={externalPrompt}
            />
          </Panel>
        </Group>
      </div>
      {agentHint && <AgentHint hint={agentHint} onDismiss={dismissAgentHint} />}
      <footer className="statusbar">
        <button
          type="button"
          onClick={() => {
            setTool('problems');
            setShowTools(true);
          }}
          aria-label="Show problems"
        >
          <AlertCircle size={12} />
          {errorCount}
          <TriangleAlert size={12} />
          {warningCount}
        </button>
        {!isDesktop && <span className="preview-status">Browser preview</span>}
        <div className="status-spacer" />
        <Tooltip
          label={
            inlineStatus.message ||
            (inlineEnabled
              ? 'AI Tab completion. Click to turn off. ⌘⌥Space requests a prediction.'
              : 'Turn on AI Tab completion')
          }
        >
          <button
            type="button"
            className={`completion-status ${inlineStatus.state === 'error' ? 'warning' : ''}`}
            aria-label="Toggle chat Tab completion"
            aria-pressed={inlineEnabled}
            onClick={() => {
              const enabled = !inlineEnabled;
              setInlineEnabled(enabled);
              localStorage.setItem('workbench.inlineEnabled', String(enabled));
            }}
          >
            {inlineStatus.state === 'loading' ? (
              <LoaderCircle size={11} className="spin" />
            ) : (
              <Command size={11} />
            )}
            {!inlineEnabled
              ? 'Tab off'
              : inlineStatus.state === 'ready'
                ? 'Tab to accept'
                : inlineStatus.state === 'loading'
                  ? 'Completing'
                  : 'AI Tab'}
          </button>
        </Tooltip>
        {saving ? (
          <span>
            <LoaderCircle size={12} className="spin" />
            Saving
          </span>
        ) : document?.content !== document?.savedContent && document ? (
          <span className="muted">Unsaved</span>
        ) : document ? (
          <span className="muted">
            <Check size={11} />
            Saved
          </span>
        ) : null}
        {currentEditorTab?.kind === 'file' && (
          <button
            type="button"
            onClick={() => editorRef.current?.trigger('keyboard', 'editor.action.gotoLine', null)}
          >
            Ln {cursor.line}, Col {cursor.column}
          </button>
        )}
        <span>UTF-8</span>
        <span>{document?.content.includes('\r\n') ? 'CRLF' : 'LF'}</span>
        <span className="status-language">
          {document
            ? document.language === 'typescript'
              ? 'TypeScript'
              : document.language[0].toUpperCase() + document.language.slice(1)
            : ''}
        </span>
      </footer>
      {notice && (
        <div
          className={`toast ${notice.error ? 'toast-error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.error ? <AlertCircle size={15} /> : <Check size={15} />}
          <span>{notice.text}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
          >
            <X size={14} />
          </Button>
        </div>
      )}
      <Dialog.Root
        open={!!snapshot}
        onOpenChange={(open) => {
          if (!open) setSnapshot(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content reference-dialog">
            <div className="dialog-heading">
              <div>
                <Dialog.Title>{snapshot?.reference.label}</Dialog.Title>
                <Dialog.Description>{snapshot?.reason}</Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button variant="ghost" size="icon" aria-label="Close captured context">
                  <X size={17} />
                </Button>
              </Dialog.Close>
            </div>
            <pre className="reference-snapshot">{snapshot?.reference.content}</pre>
            {snapshot?.reference.truncated && (
              <p className="muted">
                This snapshot contains the 16,000 characters attached to chat.
              </p>
            )}
            <div className="dialog-footer">
              {snapshot?.reference.uri && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    if (snapshot.reference.uri) navigate(snapshot.reference.uri);
                    setSnapshot(null);
                  }}
                >
                  Open current file
                </Button>
              )}
              <Dialog.Close asChild>
                <Button size="sm">Done</Button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <CommandPalette
        mode={palette}
        query={paletteQuery}
        onQueryChange={setPaletteQuery}
        onClose={() => setPalette(null)}
        groups={
          paletteShowsCommands
            ? [{ label: 'Commands', items: paletteCommands }]
            : [
                { label: 'Current context', items: paletteContext },
                { label: 'Files', items: paletteFiles },
              ]
        }
      />
      <Dialog.Root
        open={!!pendingAction}
        onOpenChange={(open) => {
          if (!open) cancelPendingAction();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content unsaved-dialog">
            <Dialog.Title>Save your changes?</Dialog.Title>
            <Dialog.Description>
              {pendingDirty.map((doc) => basename(doc.path)).join(', ')}{' '}
              {pendingDirty.length === 1 ? 'has' : 'have'} unsaved changes.
            </Dialog.Description>
            <div className="dialog-footer">
              <Button variant="ghost" onClick={cancelPendingAction}>
                Cancel
              </Button>
              <Button
                variant="secondary"
                disabled={saving}
                onClick={() => void finishPendingAction(pendingAction)}
              >
                Discard changes
              </Button>
              <Button
                disabled={saving}
                onClick={async () => {
                  const action = pendingAction;
                  try {
                    for (const doc of pendingDirty) await saveDocument(doc.path);
                    const stillDirty = () => {
                      const paths = action?.paths?.();
                      return docsRef.current.some(
                        (doc) =>
                          (!paths || paths.has(doc.path)) && doc.content !== doc.savedContent,
                      );
                    };
                    if (stillDirty()) {
                      notify('New edits were made while saving. Save again before closing.');
                      return;
                    }
                    if (stillDirty()) return;
                    await finishPendingAction(action);
                  } catch {
                    /* Keep the dialog and edits open when saving fails. */
                  }
                }}
              >
                {saving ? 'Saving…' : 'Save all'}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={!!saveAs}
        onOpenChange={(open) => {
          if (!open) cancelSaveAs();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="dialog-content unsaved-dialog"
            onEscapeKeyDown={(event) => {
              if (saveAs?.working) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (saveAs?.working) event.preventDefault();
            }}
          >
            <Dialog.Title>Save new file</Dialog.Title>
            <Dialog.Description>
              Enter a path relative to {workspace?.name || 'this workspace'}. The parent folder must
              exist. Existing files are kept.
            </Dialog.Description>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void createUntitledFile();
              }}
            >
              <label className="save-as-field">
                File path
                <input
                  value={saveAs?.input || ''}
                  placeholder="src/example.ts"
                  disabled={saveAs?.working}
                  onChange={(event) =>
                    setSaveAs(
                      (value) => value && { ...value, input: event.target.value, error: '' },
                    )
                  }
                />
              </label>
              {saveAs?.error && (
                <p className="error-text" role="alert">
                  {saveAs.error}
                </p>
              )}
              <div className="dialog-footer">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={saveAs?.working}
                  onClick={cancelSaveAs}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={saveAs?.working || !saveAs?.input.trim()}>
                  {saveAs?.working ? 'Saving…' : 'Save file'}
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <EditorPreferences
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        fontSize={fontSize}
        onFontSizeChange={(size) => {
          setFontSize(size);
          localStorage.setItem('workbench.fontSize', String(size));
        }}
        formatOnSave={formatOnSave}
        onFormatOnSaveChange={(enabled) => {
          setFormatOnSave(enabled);
          localStorage.setItem('workbench.formatOnSave', String(enabled));
        }}
        lintOnSave={lintOnSave}
        onLintOnSaveChange={(enabled) => {
          setLintOnSave(enabled);
          localStorage.setItem('workbench.lintOnSave', String(enabled));
        }}
        inlineEnabled={inlineEnabled}
        onInlineEnabledChange={(enabled) => {
          setInlineEnabled(enabled);
          localStorage.setItem('workbench.inlineEnabled', String(enabled));
        }}
        connectionsDisabled={busy}
        onManageConnections={() => {
          setSettingsOpen(false);
          setShowChat(true);
          setProviderSettingsOpen(true);
        }}
        shortcuts={commands.filter((item) => item.hint && item.hint !== 'Extension')}
      />
    </main>
  );
}
export default App;
