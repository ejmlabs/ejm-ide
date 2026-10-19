import {
  AlertCircle,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Check,
  ChevronDown,
  FileClock,
  FileCode2,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  History,
  LoaderCircle,
  MessageSquarePlus,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Tag,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isDesktop } from '@/lib/backend';
import { fileUri, makeReference } from '@/lib/context';
import type {
  GitBlame,
  GitBlameLine,
  GitCommit,
  GitCommitDetail,
  GitCompare,
  GitDiff,
  GitDiffRequest,
  GitFileChange,
  GitFileStat,
  GitHistory,
  GitRef,
  GitStatus,
} from '@/lib/git';
import { type GitGraphRow, layoutGitGraph, splitGitChanges } from '@/lib/git-graph';
import type { ContextReference } from '@/lib/types';
import { basename, relativePath } from '@/lib/utils';
import { FileIcon } from './FileTree';
import { Button } from './ui/button';
import { Tooltip } from './ui/tooltip';
import './git.css';

type OnDiff = (request: GitDiffRequest, title: string) => void;
type OnAttach = (reference: ContextReference) => void;
type OnOpen = (path: string, line?: number) => void;

export interface GitSidebarProps {
  root: string;
  activePath: string;
  refreshToken: number;
  visible?: boolean;
  onStatus: (status: GitStatus) => void;
  onDiff: OnDiff;
  onHistory: (path?: string) => void;
  onAttach: OnAttach;
  onOpen: OnOpen;
}

function GitError({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="git-error" role="alert">
      <AlertCircle size={14} />
      <span>{message}</span>
      {retry && (
        <Button variant="ghost" size="sm" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

function GitLoading({ label = 'Loading Git data…' }: { label?: string }) {
  return (
    <div className="git-loading" role="status">
      <LoaderCircle size={13} className="spin" />
      {label}
    </div>
  );
}

function GitLimit({ children }: { children: React.ReactNode }) {
  return <p className="git-limit">{children}</p>;
}

function shortId(id: string) {
  return id.slice(0, 8);
}

function gitDate(timestamp: number) {
  const value = new Date(timestamp * 1000);
  return Number.isNaN(value.getTime())
    ? 'Unknown date'
    : value.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function commitCapture(commit: GitCommit, message = commit.subject) {
  return `Commit: ${commit.id}\nParents: ${commit.parents.join(', ') || 'Root commit'}\nAuthor: ${commit.author} <${commit.email}>\nDate: ${new Date(commit.date * 1000).toISOString()}\nRefs: ${commit.refs.join(', ') || 'None'}\n\n${message}`;
}

function attachCommit(commit: GitCommit, onAttach: OnAttach, message?: string) {
  onAttach(
    makeReference({
      kind: 'git',
      label: `${shortId(commit.id)} ${commit.subject}`,
      origin: 'Git history',
      version: commit.id,
      content: commitCapture(commit, message),
    }),
  );
}

export function GitSidebar({
  root,
  activePath,
  refreshToken,
  visible = true,
  onStatus,
  onDiff,
  onHistory,
  onAttach,
  onOpen,
}: GitSidebarProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [message, setMessage] = useState('');
  const [writing, setWriting] = useState(false);
  const [attaching, setAttaching] = useState('');
  const [result, setResult] = useState('');
  const container = useRef<HTMLElement>(null);
  const currentRoot = useRef(root);
  currentRoot.current = root;
  const currentPath = useRef(activePath);
  currentPath.current = activePath;
  const statusCallback = useRef(onStatus);
  statusCallback.current = onStatus;
  const task = useRef<{ root: string; promise: Promise<void> } | null>(null);
  const mutation = useRef(false);
  const lastRoot = useRef(root);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(() => {
    if (task.current?.root === root) return task.current.promise;
    const current = () => mounted.current && currentRoot.current === root;
    setLoading(true);
    const promise = invoke<GitStatus>('git_status')
      .then((next) => {
        if (!current()) return;
        setStatus(next);
        setError('');
        statusCallback.current(next);
      })
      .catch((reason) => {
        if (current()) setError(String(reason));
      })
      .finally(() => {
        if (task.current?.promise === promise) task.current = null;
        if (current()) setLoading(false);
      });
    task.current = { root, promise };
    return promise;
  }, [root]);
  useEffect(() => {
    if (lastRoot.current === root) return;
    lastRoot.current = root;
    setStatus(null);
    setError('');
    setActionError('');
    setResult('');
    setMessage('');
    setWriting(false);
    setAttaching('');
    mutation.current = false;
  }, [root]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Saves and agent edits invalidate this status through refreshToken.
  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);
  useEffect(() => {
    const refreshVisible = () => {
      if (visible && !document.hidden && container.current?.getClientRects().length) void refresh();
    };
    const timer = window.setInterval(refreshVisible, 5000);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [refresh, visible]);
  const groups = splitGitChanges(status?.changes || []);
  const hasConflicts = status?.changes.some((change) => change.conflicted);

  async function write(command: 'git_stage' | 'git_unstage' | 'git_commit', paths?: string[]) {
    if (!isDesktop || !status || mutation.current) return;
    const capturedRoot = root;
    mutation.current = true;
    setWriting(true);
    setActionError('');
    setResult('');
    try {
      await invoke(command, {
        expectedRoot: root,
        ...(command === 'git_commit'
          ? {
              message: message.trim(),
              expectedHead: status.head,
              expectedIndex: status.indexVersion,
            }
          : { paths }),
      });
      if (currentRoot.current !== capturedRoot || !mounted.current) return;
      if (command === 'git_commit') {
        setMessage('');
        setResult('Staged changes committed.');
      }
      window.dispatchEvent(new Event('workbench:files-changed'));
      if (task.current?.root === capturedRoot) await task.current.promise;
      await refresh();
    } catch (reason) {
      if (currentRoot.current === capturedRoot && mounted.current) setActionError(String(reason));
    } finally {
      if (currentRoot.current === capturedRoot && mounted.current) {
        mutation.current = false;
        setWriting(false);
      }
    }
  }

  async function attachDiff(change: GitFileChange, scope: 'worktree' | 'index') {
    const capturedRoot = root;
    const capturedPath = activePath;
    setAttaching(`${scope}:${change.path}`);
    setActionError('');
    try {
      const diff = await invoke<GitDiff>('git_diff', {
        request: { scope, path: change.path, originalPath: change.originalPath },
      });
      if (
        currentRoot.current !== capturedRoot ||
        currentPath.current !== capturedPath ||
        !mounted.current
      )
        return;
      onAttach(
        makeReference({
          kind: 'diff',
          label: `${basename(change.path)} ${scope === 'index' ? 'staged' : 'unstaged'} changes`,
          origin: 'Git changes',
          uri: fileUri(change.path),
          content: `Repository: ${status?.repositoryRoot}\nScope: ${scope}\nPath: ${change.relativePath}\n${diff.truncated ? 'Patch preview is truncated.\n' : ''}\n${diff.text}`,
        }),
      );
    } catch (reason) {
      if (currentRoot.current === capturedRoot && mounted.current) setActionError(String(reason));
    } finally {
      if (currentRoot.current === capturedRoot && mounted.current) setAttaching('');
    }
  }

  function changeGroup(title: string, changes: GitFileChange[], scope: 'worktree' | 'index') {
    return (
      <details className="git-change-group" open>
        <summary>
          <ChevronDown size={12} className="git-group-chevron" />
          <strong className="git-group-title">{title}</strong>
          <span className="git-count">{changes.length}</span>
          {changes.length > 0 && (
            <Tooltip label={scope === 'index' ? 'Unstage all' : 'Stage all non-conflicting files'}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={
                  scope === 'index' ? 'Unstage all files' : 'Stage all non-conflicting files'
                }
                disabled={
                  !isDesktop || writing || !!error || changes.every((change) => change.conflicted)
                }
                onClick={(event) => {
                  event.preventDefault();
                  void write(
                    scope === 'index' ? 'git_unstage' : 'git_stage',
                    changes.filter((change) => !change.conflicted).map((change) => change.path),
                  );
                }}
              >
                {scope === 'index' ? <Minus size={13} /> : <Plus size={13} />}
              </Button>
            </Tooltip>
          )}
        </summary>
        {changes.length === 0 ? (
          <p className="git-group-empty">
            {scope === 'index' ? 'No staged files' : 'No unstaged files'}
          </p>
        ) : (
          changes.map((change) => {
            const code = change.conflicted
              ? 'U'
              : change.untracked
                ? '?'
                : scope === 'index'
                  ? change.indexStatus
                  : change.worktreeStatus;
            return (
              <div
                className={`git-change-row ${change.conflicted ? 'conflicted' : ''}`}
                key={change.path}
              >
                <button
                  type="button"
                  className="git-change-file"
                  title={`${change.relativePath}${change.originalPath ? ` (from ${change.originalPath})` : ''}`}
                  onClick={() =>
                    onDiff(
                      { scope, path: change.path, originalPath: change.originalPath },
                      `${basename(change.path)} · ${scope === 'index' ? 'Staged' : 'Changes'}`,
                    )
                  }
                >
                  <FileIcon path={change.path} />
                  <span>{change.relativePath}</span>
                  <small data-status={code}>{code}</small>
                </button>
                <div className="git-row-actions">
                  <Tooltip label="Open file">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Open ${change.relativePath}`}
                      disabled={code === 'D'}
                      onClick={() => onOpen(change.path)}
                    >
                      <FileCode2 size={12} />
                    </Button>
                  </Tooltip>
                  <Tooltip label="Add diff to chat">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Add ${change.relativePath} ${scope === 'index' ? 'staged' : 'unstaged'} diff to chat`}
                      disabled={!!attaching}
                      onClick={() => void attachDiff(change, scope)}
                    >
                      {attaching === `${scope}:${change.path}` ? (
                        <LoaderCircle size={12} className="spin" />
                      ) : (
                        <MessageSquarePlus size={12} />
                      )}
                    </Button>
                  </Tooltip>
                  <Tooltip
                    label={
                      scope === 'index'
                        ? 'Unstage file'
                        : change.conflicted
                          ? 'Stage resolved file'
                          : 'Stage file'
                    }
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${scope === 'index' ? 'Unstage' : 'Stage'} ${change.relativePath}`}
                      disabled={!isDesktop || writing || !!error}
                      onClick={() =>
                        void write(scope === 'index' ? 'git_unstage' : 'git_stage', [change.path])
                      }
                    >
                      {scope === 'index' ? <Minus size={13} /> : <Plus size={13} />}
                    </Button>
                  </Tooltip>
                </div>
              </div>
            );
          })
        )}
      </details>
    );
  }

  return (
    <section className="git-sidebar" ref={container} aria-label="Git changes">
      <header className="panel-header">
        <span>Git</span>
        <div className="git-header-actions">
          <Tooltip label="Commit history">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open Git history"
              onClick={() => onHistory()}
            >
              <History size={14} />
            </Button>
          </Tooltip>
          <Tooltip label="Refresh Git">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh Git"
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </Button>
          </Tooltip>
        </div>
      </header>
      {error && <GitError message={error} retry={() => void refresh()} />}
      {!status && loading && <GitLoading label="Reading repository…" />}
      {status && !status.available && !error && (
        <div className="git-empty">
          <GitBranch size={23} />
          <strong>No Git repository</strong>
          <p>Open a folder inside a Git repository to see its changes and history.</p>
        </div>
      )}
      {status?.available && (
        <>
          <div className="git-branch-summary">
            <GitBranch size={14} />
            <strong title={status.branch || status.head || ''}>
              {status.branch ||
                (status.head ? `Detached ${shortId(status.head)}` : 'No commits yet')}
            </strong>
            {status.upstream && (
              <span className="git-sync-count" title={`Compared with ${status.upstream}`}>
                <ArrowUp size={11} />
                {status.ahead}
                <ArrowDown size={11} />
                {status.behind}
              </span>
            )}
            <Tooltip label="Add branch to chat">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Add branch to chat"
                onClick={() =>
                  onAttach(
                    makeReference({
                      kind: 'git',
                      label:
                        status.branch || (status.head ? shortId(status.head) : 'Unborn branch'),
                      origin: 'Git branch',
                      version: status.head || undefined,
                      content: `Repository: ${status.repositoryRoot}\nBranch: ${status.branch || 'Detached HEAD'}\nHEAD: ${status.head || 'No commits'}\nUpstream: ${status.upstream || 'None'}\nAhead: ${status.ahead}\nBehind: ${status.behind}`,
                    }),
                  )
                }
              >
                <MessageSquarePlus size={12} />
              </Button>
            </Tooltip>
          </div>
          <div className="git-upstream" title={status.upstream || 'No upstream configured'}>
            {status.upstream || 'No upstream'}
          </div>
          {!isDesktop && (
            <p className="git-preview-note">Preview data. Editing Git needs the desktop app.</p>
          )}
          {actionError && <GitError message={actionError} />}
          {result && (
            <p className="git-result" role="status">
              <Check size={12} /> {result}
            </p>
          )}
          <form
            className="git-commit-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                message.trim() &&
                groups.staged.length &&
                !hasConflicts &&
                !error &&
                !status.truncated
              )
                void write('git_commit');
            }}
          >
            <textarea
              aria-label="Commit message"
              placeholder="Commit message"
              rows={2}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              disabled={!isDesktop || writing}
            />
            <Button
              type="submit"
              size="sm"
              disabled={
                !isDesktop ||
                writing ||
                !message.trim() ||
                !groups.staged.length ||
                hasConflicts ||
                !!error ||
                status.truncated
              }
            >
              {writing ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />}
              Commit staged
              <span className="git-commit-count">{groups.staged.length}</span>
            </Button>
          </form>
          {hasConflicts && <GitLimit>Resolve conflicts, then stage the resolved files.</GitLimit>}
          <div className="git-changes-scroll">
            {changeGroup('Staged', groups.staged, 'index')}
            {changeGroup('Changes', groups.worktree, 'worktree')}
            {!status.changes.length && !status.truncated && !error && (
              <div className="git-clean" role="status">
                <Check size={14} /> Working tree clean
              </div>
            )}
            {status.truncated && (
              <GitLimit>
                Only part of the change list is shown. Commit is disabled. Refresh after narrowing
                the changes.
              </GitLimit>
            )}
          </div>
          <footer className="git-sidebar-footer">
            <button type="button" onClick={() => onHistory()}>
              <History size={13} /> History
            </button>
            <button type="button" disabled={!activePath} onClick={() => onHistory(activePath)}>
              <FileClock size={13} /> File history
            </button>
          </footer>
        </>
      )}
    </section>
  );
}

interface GitRead<T> {
  data: T | null;
  loading: boolean;
  error: string;
}

function useGitRead<T>(
  command: string,
  args: Record<string, unknown>,
  root: string,
  enabled = true,
  delay = 0,
) {
  const key = JSON.stringify([root, command, args]);
  const [state, setState] = useState<GitRead<T> & { key: string }>({
    key: '',
    data: null,
    loading: enabled,
    error: '',
  });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const [, request, input] = JSON.parse(key) as [string, string, Record<string, unknown>];
    setState({ key, data: null, loading: true, error: '' });
    const read = () => {
      void invoke<T>(request, input)
        .then((data) => {
          if (live) setState({ key, data, loading: false, error: '' });
        })
        .catch((reason) => {
          if (live) setState({ key, data: null, loading: false, error: String(reason) });
        });
    };
    const timer = delay ? window.setTimeout(read, delay) : undefined;
    if (!delay) read();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [key, enabled, delay]);
  return enabled && state.key === key ? state : { data: null, loading: enabled, error: '' };
}

const HISTORY_PAGE = 60;
const HISTORY_LIMIT = 600;

function useGitHistory(
  root: string,
  path: string | undefined,
  query: string,
  enabled: boolean,
  revision: number,
) {
  const key = JSON.stringify({ root, path, query, revision });
  const currentKey = useRef(key);
  currentKey.current = key;
  const moreTask = useRef<string | null>(null);
  const [state, setState] = useState<GitHistory & { key: string; loading: boolean; error: string }>(
    {
      key: '',
      commits: [],
      hasMore: false,
      truncated: false,
      loading: true,
      error: '',
    },
  );
  useEffect(() => {
    if (!enabled) return;
    currentKey.current = key;
    let live = true;
    const input = JSON.parse(key) as { path?: string; query: string };
    setState({ key, commits: [], hasMore: false, truncated: false, loading: true, error: '' });
    void invoke<GitHistory>('git_history', {
      path: input.path,
      query: input.query || undefined,
      skip: 0,
      limit: HISTORY_PAGE,
    })
      .then((data) => {
        if (live && currentKey.current === key)
          setState({ ...data, key, loading: false, error: '' });
      })
      .catch((reason) => {
        if (live && currentKey.current === key)
          setState({
            key,
            commits: [],
            hasMore: false,
            truncated: false,
            loading: false,
            error: String(reason),
          });
      });
    return () => {
      live = false;
      if (currentKey.current === key) currentKey.current = '';
    };
  }, [key, enabled]);
  async function loadMore() {
    if (
      state.key !== key ||
      state.loading ||
      !state.hasMore ||
      moreTask.current === key ||
      state.commits.length >= HISTORY_LIMIT
    )
      return;
    moreTask.current = key;
    setState((previous) => ({ ...previous, loading: true, error: '' }));
    try {
      const next = await invoke<GitHistory>('git_history', {
        path,
        query: query || undefined,
        skip: state.commits.length,
        limit: Math.min(HISTORY_PAGE, HISTORY_LIMIT - state.commits.length),
      });
      if (currentKey.current !== key) return;
      setState((previous) => {
        if (previous.key !== key) return previous;
        const known = new Set(previous.commits.map((commit) => commit.id));
        return {
          key,
          commits: [...previous.commits, ...next.commits.filter((commit) => !known.has(commit.id))],
          hasMore: next.hasMore,
          truncated: previous.truncated || next.truncated,
          loading: false,
          error: '',
        };
      });
    } catch (reason) {
      if (currentKey.current === key)
        setState((previous) => ({ ...previous, loading: false, error: String(reason) }));
    } finally {
      if (moreTask.current === key) moreTask.current = null;
    }
  }
  return {
    ...(state.key === key
      ? state
      : { commits: [], hasMore: false, truncated: false, loading: enabled, error: '' }),
    loadMore,
  };
}

const laneColors = [
  'var(--ejm-ui-hue-1)',
  'var(--ejm-ui-hue-2)',
  'var(--ejm-ui-hue-3)',
  'var(--ejm-ui-hue-4)',
  'var(--ejm-ui-hue-5)',
  'var(--ejm-ui-hue-6)',
];

export function GitGraphCell({ row, lanes }: { row: GitGraphRow; lanes: number }) {
  const step = Math.min(12, 88 / Math.max(1, lanes));
  const x = (lane: number) => 7 + lane * step;
  return (
    <svg
      width={Math.max(22, 14 + lanes * step)}
      height={32}
      className="git-graph-cell"
      aria-hidden="true"
    >
      {row.edges.map((edge, index) => {
        const from = x(edge.from);
        const to = x(edge.to);
        const path =
          edge.kind === 'through'
            ? `M${from} 0V32`
            : edge.kind === 'incoming'
              ? `M${from} 0V16`
              : from === to
                ? `M${from} 16V32`
                : `M${from} 16C${from} 25 ${to} 23 ${to} 32`;
        return (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: Edges are immutable geometry for this commit snapshot.
            key={index}
            d={path}
            fill="none"
            stroke={laneColors[edge.color % laneColors.length]}
            strokeWidth={1.4}
            strokeDasharray={edge.kind === 'boundary' ? '2 2' : undefined}
          />
        );
      })}
      <circle cx={x(row.lane)} cy={16} r={3} fill={laneColors[row.lane % laneColors.length]} />
    </svg>
  );
}

function RefLabel({ label }: { label: string }) {
  const tag = label.startsWith('tag: ');
  return (
    <span className={`git-ref-label ${label.startsWith('HEAD') ? 'head' : ''}`} title={label}>
      {tag ? <Tag size={9} /> : <GitBranch size={9} />}
      {label.replace(/^tag: /, '').replace(/^HEAD -> /, '')}
    </span>
  );
}

function FileStats({
  files,
  root,
  onDiff,
  request,
  onOpen,
}: {
  files: GitFileStat[];
  root: string;
  onDiff: OnDiff;
  request: (file: GitFileStat) => GitDiffRequest;
  onOpen: OnOpen;
}) {
  return (
    <section className="git-detail-files" aria-label="Changed files">
      {files.map((file) => (
        <div className="git-stat-row" key={file.path}>
          <button
            type="button"
            onClick={() => onDiff(request(file), basename(file.path))}
            title={file.path}
          >
            <FileIcon path={file.path} />
            <span>{relativePath(file.path, root)}</span>
            <small className="git-file-status">{file.status}</small>
            {file.additions === null || file.deletions === null ? (
              <small className="git-binary">binary</small>
            ) : (
              <span className="git-line-stats">
                <small className="git-added">+{file.additions}</small>
                <small className="git-deleted">−{file.deletions}</small>
              </span>
            )}
          </button>
          <Tooltip label="Open working file">
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Open working file ${relativePath(file.path, root)}`}
              disabled={file.status === 'D'}
              onClick={() => onOpen(file.path)}
            >
              <FileCode2 size={12} />
            </Button>
          </Tooltip>
        </div>
      ))}
      {!files.length && <p className="git-inline-empty">No file changes in this view.</p>}
    </section>
  );
}

function CommitDetails({
  detail,
  root,
  onDiff,
  onAttach,
  onOpen,
}: {
  detail: GitCommitDetail;
  root: string;
  onDiff: OnDiff;
  onAttach: OnAttach;
  onOpen: OnOpen;
}) {
  const { commit } = detail;
  return (
    <section className="git-commit-details" aria-label="Commit details">
      <div className="git-detail-heading">
        <GitCommitHorizontal size={14} />
        <code title={commit.id}>{shortId(commit.id)}</code>
        <span className="git-detail-refs">
          {commit.refs.map((ref) => (
            <RefLabel key={ref} label={ref} />
          ))}
        </span>
        <Tooltip label="Add commit to chat">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Add commit to chat"
            onClick={() => attachCommit(commit, onAttach, detail.message)}
          >
            <MessageSquarePlus size={13} />
          </Button>
        </Tooltip>
        <Tooltip label="Show commit diff">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Show commit diff"
            onClick={() =>
              onDiff(
                { scope: 'commit', revision: commit.id },
                `${shortId(commit.id)} · ${commit.subject}`,
              )
            }
          >
            <FileDiff size={13} />
          </Button>
        </Tooltip>
      </div>
      <div className="git-detail-author">
        <span title={commit.email}>{commit.author}</span>
        <time dateTime={new Date(commit.date * 1000).toISOString()}>{gitDate(commit.date)}</time>
      </div>
      <pre className="git-commit-message">{detail.message}</pre>
      {commit.parents.length > 1 && (
        <GitLimit>Merge commit. Files and diffs compare with its first parent.</GitLimit>
      )}
      <FileStats
        files={detail.files}
        root={root}
        onDiff={onDiff}
        onOpen={onOpen}
        request={(file) => ({
          scope: 'commit',
          revision: commit.id,
          path: file.path,
          originalPath: file.originalPath,
        })}
      />
      {detail.truncated && <GitLimit>Commit file list is truncated.</GitLimit>}
    </section>
  );
}

type HistoryTab = 'history' | 'file' | 'compare' | 'blame';

export interface GitHistoryPaneProps {
  root: string;
  path?: string;
  visible?: boolean;
  activePath: string;
  activeContent?: string;
  line: number;
  onDiff: OnDiff;
  onAttach: OnAttach;
  onOpen: OnOpen;
}

export function GitHistoryPane({
  root,
  path,
  visible = true,
  activePath,
  activeContent,
  line,
  onDiff,
  onAttach,
  onOpen,
}: GitHistoryPaneProps) {
  const [tab, setTab] = useState<HistoryTab>(path ? 'file' : 'history');
  const [filePath, setFilePath] = useState(path || activePath);
  const lastActivePath = useRef(activePath);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [selection, setSelection] = useState({ scope: '', id: '' });
  const [revision, setRevision] = useState(0);
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [comparison, setComparison] = useState<{ base: string; head: string } | null>(null);
  const selectionScope = JSON.stringify([root, tab, filePath, filter]);
  const selected = selection.scope === selectionScope ? selection.id : '';
  function setSelected(id: string) {
    setSelection({ scope: selectionScope, id });
  }
  useEffect(() => {
    if (activePath !== lastActivePath.current) {
      lastActivePath.current = activePath;
      setFilePath(activePath);
    }
  }, [activePath]);
  useEffect(() => {
    const timer = window.setTimeout(() => setFilter(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const changed = () => setRevision((value) => value + 1);
    window.addEventListener('workbench:files-changed', changed);
    window.addEventListener('focus', changed);
    return () => {
      window.removeEventListener('workbench:files-changed', changed);
      window.removeEventListener('focus', changed);
    };
  }, []);
  const showingHistory = tab === 'history' || tab === 'file';
  const history = useGitHistory(
    root,
    tab === 'file' ? filePath : undefined,
    filter,
    visible && showingHistory && (tab !== 'file' || !!filePath),
    revision,
  );
  const graph = useMemo(() => layoutGitGraph(history.commits), [history.commits]);
  const detail = useGitRead<GitCommitDetail>(
    'git_commit_detail',
    { revision: selected },
    `${root}:${revision}`,
    visible && !!selected,
  );
  const refs = useGitRead<GitRef[]>(
    'git_refs',
    {},
    `${root}:${revision}`,
    visible && tab === 'compare',
  );
  useEffect(() => {
    if (!refs.data?.length) return;
    const current = refs.data.find((ref) => ref.current);
    setHead((previous) => previous || current?.fullName || 'HEAD');
    setBase(
      (previous) =>
        previous || current?.upstream || refs.data?.find((ref) => !ref.current)?.fullName || 'HEAD',
    );
  }, [refs.data]);
  const compare = useGitRead<GitCompare>(
    'git_compare',
    { base: comparison?.base, head: comparison?.head },
    `${root}:${revision}`,
    visible && tab === 'compare' && !!comparison,
  );
  const blameStart = Math.max(1, line - 6);
  const blame = useGitRead<GitBlame>(
    'git_blame',
    {
      path: filePath,
      startLine: blameStart,
      endLine: line + 8,
      content: tab === 'blame' && filePath === activePath ? activeContent : undefined,
    },
    `${root}:${revision}`,
    visible && tab === 'blame' && !!filePath,
    180,
  );
  const selectedCommit = history.commits.find((commit) => commit.id === selected);

  function showBlameCommit(blameLine: GitBlameLine) {
    if (blameLine.uncommitted) return;
    setSelected(blameLine.commit);
  }

  function attachBlame(blameLine: GitBlameLine) {
    onAttach(
      makeReference({
        kind: 'git',
        label: `${basename(filePath)}:${blameLine.line} attribution`,
        origin: 'Git blame',
        uri: fileUri(filePath),
        ranges: [
          {
            start: { line: blameLine.line - 1, character: 0 },
            end: { line: blameLine.line - 1, character: 0 },
          },
        ],
        version: blameLine.commit,
        content: `File: ${filePath}\nLine: ${blameLine.line}\nOriginal line: ${blameLine.originalLine}\nCommit: ${blameLine.uncommitted ? 'Uncommitted working changes' : blameLine.commit}\nAuthor: ${blameLine.author}\nDate: ${gitDate(blameLine.date)}\nSummary: ${blameLine.summary}`,
      }),
    );
  }

  return (
    <section className="git-history-pane" aria-label="Git history and inspection">
      <div className="git-view-tabs" role="tablist" aria-label="Git views">
        {(
          [
            { id: 'history', label: 'History', icon: History },
            { id: 'file', label: 'File history', icon: FileClock },
            { id: 'compare', label: 'Compare', icon: GitCompareArrows },
            { id: 'blame', label: 'Blame', icon: GitCommitHorizontal },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            id={`git-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls="git-view-panel"
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => {
              const tabs: HistoryTab[] = ['history', 'file', 'compare', 'blame'];
              const index = tabs.indexOf(tab);
              const next =
                event.key === 'ArrowRight'
                  ? tabs[(index + 1) % tabs.length]
                  : event.key === 'ArrowLeft'
                    ? tabs[(index + tabs.length - 1) % tabs.length]
                    : event.key === 'Home'
                      ? tabs[0]
                      : event.key === 'End'
                        ? tabs.at(-1)
                        : undefined;
              if (!next) return;
              event.preventDefault();
              setTab(next);
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>(`#git-tab-${next}`)
                ?.focus();
            }}
          >
            <item.icon size={12} />
            {item.label}
          </button>
        ))}
        <div className="git-tabs-space" />
        <Tooltip label="Refresh Git view">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh Git view"
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={12} />
          </Button>
        </Tooltip>
      </div>
      <div
        className="git-view-panel"
        id="git-view-panel"
        role="tabpanel"
        aria-labelledby={`git-tab-${tab}`}
      >
        {showingHistory && (
          <>
            <div className="git-history-toolbar">
              {tab === 'file' && (
                <span className="git-follow-file" title={filePath}>
                  <FileClock size={12} />
                  {filePath ? relativePath(filePath, root) : 'Select a file in the editor'}
                </span>
              )}
              <label className="git-filter">
                <Search size={12} />
                <input
                  aria-label="Filter commit history"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter commits…"
                />
              </label>
              <span className="git-history-count">{history.commits.length} commits</span>
            </div>
            <div className="git-history-split">
              <div className="git-log">
                {history.error && (
                  <GitError
                    message={history.error}
                    retry={() => setRevision((value) => value + 1)}
                  />
                )}
                {history.loading && !history.commits.length && (
                  <GitLoading label="Loading commit history…" />
                )}
                {tab === 'file' && !filePath && (
                  <p className="git-inline-empty">Open a file to follow its history.</p>
                )}
                {!history.loading &&
                  !history.error &&
                  !history.commits.length &&
                  (tab !== 'file' || filePath) && (
                    <p className="git-inline-empty">
                      {filter ? 'No commits match this filter.' : 'No commits to show.'}
                    </p>
                  )}
                {graph.rows.map((row) => (
                  <button
                    className={`git-commit-row ${selected === row.commit.id ? 'selected' : ''}`}
                    type="button"
                    key={row.commit.id}
                    onClick={() => setSelected(row.commit.id)}
                    aria-label={`${row.commit.subject}, ${row.commit.author}, ${shortId(row.commit.id)}`}
                  >
                    <GitGraphCell row={row} lanes={graph.width} />
                    <span className="git-commit-subject">
                      <span className="git-row-refs">
                        {row.commit.refs.map((ref) => (
                          <RefLabel key={ref} label={ref} />
                        ))}
                      </span>
                      <span>{row.commit.subject}</span>
                    </span>
                    <span className="git-commit-author" title={row.commit.author}>
                      {row.commit.author}
                    </span>
                    <time dateTime={new Date(row.commit.date * 1000).toISOString()}>
                      {gitDate(row.commit.date)}
                    </time>
                    <code>{shortId(row.commit.id)}</code>
                  </button>
                ))}
                {(history.hasMore ||
                  history.truncated ||
                  graph.boundaries > 0 ||
                  !!filter ||
                  tab === 'file') &&
                  history.commits.length > 0 && (
                    <GitLimit>
                      {history.truncated ? 'History output is truncated. ' : ''}
                      {tab === 'file'
                        ? 'File history shows matching commits. '
                        : filter
                          ? 'Filtered history shows matching commits. '
                          : ''}
                      Dashed lines lead to parents outside this view.
                    </GitLimit>
                  )}
                {history.hasMore && history.commits.length < HISTORY_LIMIT && (
                  <Button
                    className="git-load-more"
                    variant="ghost"
                    size="sm"
                    disabled={history.loading}
                    onClick={() => void history.loadMore()}
                  >
                    {history.loading ? (
                      <LoaderCircle className="spin" size={12} />
                    ) : (
                      <ChevronDown size={12} />
                    )}
                    Load {HISTORY_PAGE} more commits
                  </Button>
                )}
                {history.hasMore && history.commits.length >= HISTORY_LIMIT && (
                  <GitLimit>
                    Showing {HISTORY_LIMIT} commits. Filter the history to narrow this view.
                  </GitLimit>
                )}
              </div>
              <div className="git-inspector">
                {detail.loading && <GitLoading label="Loading commit…" />}
                {detail.error && <GitError message={detail.error} />}
                {detail.data && (
                  <CommitDetails
                    detail={detail.data}
                    root={root}
                    onDiff={onDiff}
                    onAttach={onAttach}
                    onOpen={onOpen}
                  />
                )}
                {!selected && (
                  <div className="git-inspector-empty">
                    <GitCommitHorizontal size={22} />
                    <p>Select a commit to inspect its changes.</p>
                  </div>
                )}
                {selected && !detail.loading && !detail.data && !detail.error && selectedCommit && (
                  <p className="git-inline-empty">{selectedCommit.subject}</p>
                )}
              </div>
            </div>
          </>
        )}
        {tab === 'compare' && (
          <div className="git-compare-view">
            <form
              className="git-compare-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (base.trim() && head.trim())
                  setComparison({ base: base.trim(), head: head.trim() });
              }}
            >
              <label>
                Base
                <input
                  aria-label="Comparison base ref"
                  list="git-ref-options"
                  value={base}
                  onChange={(event) => setBase(event.target.value)}
                  placeholder="main"
                />
              </label>
              <Tooltip label="Swap comparison refs">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Swap comparison refs"
                  onClick={() => {
                    setBase(head);
                    setHead(base);
                  }}
                >
                  <ArrowLeftRight size={13} />
                </Button>
              </Tooltip>
              <label>
                Head
                <input
                  aria-label="Comparison head ref"
                  list="git-ref-options"
                  value={head}
                  onChange={(event) => setHead(event.target.value)}
                  placeholder="HEAD"
                />
              </label>
              <datalist id="git-ref-options">
                {refs.data?.map((ref) => (
                  <option key={ref.fullName} value={ref.fullName}>
                    {ref.name}
                  </option>
                ))}
              </datalist>
              <Button
                type="submit"
                size="sm"
                disabled={!base.trim() || !head.trim() || compare.loading}
              >
                <GitCompareArrows size={12} />
                Compare
              </Button>
            </form>
            {refs.error && (
              <GitError message={`Refs could not load. Enter a ref directly. ${refs.error}`} />
            )}
            {compare.loading && <GitLoading label="Comparing refs…" />}
            {compare.error && <GitError message={compare.error} />}
            {!comparison && !compare.loading && (
              <p className="git-inline-empty">Choose refs or commit IDs to compare their trees.</p>
            )}
            {compare.data && (
              <>
                <div className="git-comparison-summary">
                  <span title={compare.data.base}>{shortId(compare.data.base)}</span>
                  <ArrowLeftRight size={13} />
                  <span title={compare.data.head}>{shortId(compare.data.head)}</span>
                  <span className="git-comparison-counts">
                    <ArrowUp size={11} />
                    {compare.data.ahead} ahead <ArrowDown size={11} />
                    {compare.data.behind} behind
                  </span>
                  <Tooltip label="Add comparison to chat">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Add comparison to chat"
                      onClick={() => {
                        const data = compare.data;
                        if (data)
                          onAttach(
                            makeReference({
                              kind: 'git',
                              label: `${comparison?.base} → ${comparison?.head}`,
                              origin: 'Git compare',
                              content: `Base: ${data.base}\nHead: ${data.head}\nMerge base: ${data.mergeBase || 'None'}\nAhead: ${data.ahead}\nBehind: ${data.behind}\n${data.truncated ? 'File list truncated.\n' : ''}\n${data.files.map((file) => `${file.status} ${file.path} +${file.additions ?? 'binary'} -${file.deletions ?? 'binary'}`).join('\n')}`,
                            }),
                          );
                      }}
                    >
                      <MessageSquarePlus size={13} />
                    </Button>
                  </Tooltip>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      onDiff(
                        { scope: 'compare', base: compare.data?.base, head: compare.data?.head },
                        `${comparison?.base} → ${comparison?.head}`,
                      )
                    }
                  >
                    <FileDiff size={12} />
                    Full diff
                  </Button>
                </div>
                <p className="git-merge-base" title={compare.data.mergeBase || undefined}>
                  Merge base: {compare.data.mergeBase ? shortId(compare.data.mergeBase) : 'None'}
                </p>
                <FileStats
                  files={compare.data.files}
                  root={root}
                  onDiff={onDiff}
                  onOpen={onOpen}
                  request={(file) => ({
                    scope: 'compare',
                    base: compare.data?.base,
                    head: compare.data?.head,
                    path: file.path,
                    originalPath: file.originalPath,
                  })}
                />
                {compare.data.truncated && <GitLimit>Comparison file list is truncated.</GitLimit>}
              </>
            )}
          </div>
        )}
        {tab === 'blame' && (
          <div className="git-blame-view">
            <div className="git-history-toolbar">
              <span className="git-follow-file" title={filePath}>
                <GitCommitHorizontal size={12} />
                {filePath
                  ? `${relativePath(filePath, root)}:${line}`
                  : 'Select a file in the editor'}
              </span>
              <span className="git-history-count">Follows cursor</span>
            </div>
            <div className="git-history-split">
              <div className="git-blame-lines">
                {blame.loading && <GitLoading label="Reading line history…" />}
                {blame.error && <GitError message={blame.error} />}
                {!filePath && (
                  <p className="git-inline-empty">Open a file to inspect line authorship.</p>
                )}
                {blame.data?.lines.map((item) => (
                  <div
                    className={`git-blame-row ${item.line === line ? 'current' : ''}`}
                    key={item.line}
                  >
                    <button
                      className="git-blame-line-number"
                      type="button"
                      aria-label={`Go to line ${item.line}`}
                      onClick={() => onOpen(filePath, item.line)}
                    >
                      {item.line}
                    </button>
                    <button
                      className="git-blame-commit"
                      type="button"
                      disabled={item.uncommitted}
                      onClick={() => showBlameCommit(item)}
                      title={item.commit}
                    >
                      <code>{item.uncommitted ? 'Working' : shortId(item.commit)}</code>
                      <span title={item.summary}>{item.summary}</span>
                      <small title={item.author}>{item.author}</small>
                    </button>
                    <Tooltip label="Add line attribution to chat">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Add line ${item.line} attribution to chat`}
                        onClick={() => attachBlame(item)}
                      >
                        <MessageSquarePlus size={12} />
                      </Button>
                    </Tooltip>
                  </div>
                ))}
                {blame.data && !blame.data.lines.length && (
                  <p className="git-inline-empty">
                    No line attribution is available in this range.
                  </p>
                )}
                {blame.data?.truncated && <GitLimit>Line attribution is truncated.</GitLimit>}
              </div>
              <div className="git-inspector">
                {detail.loading && <GitLoading label="Loading commit…" />}
                {detail.error && <GitError message={detail.error} />}
                {detail.data && (
                  <CommitDetails
                    detail={detail.data}
                    root={root}
                    onDiff={onDiff}
                    onAttach={onAttach}
                    onOpen={onOpen}
                  />
                )}
                {!selected && (
                  <div className="git-inspector-empty">
                    <GitCommitHorizontal size={22} />
                    <p>Select a line's commit to inspect it.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
