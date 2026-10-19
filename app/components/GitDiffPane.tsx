import { DiffEditor } from '@monaco-editor/react';
import { ArrowDown, ArrowUp, Columns2, FileDiff, MessageSquarePlus, WrapText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@/lib/backend';
import { fileUri, makeReference } from '@/lib/context';
import { releaseDiffModelsAfterDispose } from '@/lib/diff-models';
import { monacoThemeNames } from '@/lib/editor-theme';
import type { GitDiff, GitDiffRequest } from '@/lib/git';
import type { monaco } from '@/lib/monaco';
import { useTheme } from '@/lib/theme';
import type { ContextReference } from '@/lib/types';
import { basename, languageId } from '@/lib/utils';
import { Button } from './ui/button';
import { Tooltip } from './ui/tooltip';
import './git-diff.css';

export function GitDiffPane({
  root,
  request,
  title,
  onAttach,
  modelId = 'main',
}: {
  root: string;
  modelId?: string;
  request: GitDiffRequest;
  title: string;
  onAttach: (reference: ContextReference) => void;
}) {
  const theme = useTheme();
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [error, setError] = useState('');
  const [sideBySide, setSideBySide] = useState(() => {
    try {
      return localStorage.getItem('workbench.gitDiff.sideBySide') !== 'false';
    } catch {
      return true;
    }
  });
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  useEffect(() => {
    let current = true;
    setDiff(null);
    setError('');
    void invoke<GitDiff>('git_diff', { request })
      .then((result) => {
        if (current) setDiff(result);
      })
      .catch((reason) => {
        if (current) setError(String(reason));
      });
    return () => {
      current = false;
      editor.current = null;
    };
  }, [request]);
  const path = diff?.path || request.path;
  const fullText = diff && typeof diff.original === 'string' && typeof diff.modified === 'string';
  const identity = encodeURIComponent(`${root}:${modelId}:${JSON.stringify(request)}`);
  return (
    <section className="git-diff-pane" aria-label="Git diff">
      <header className="tool-subheader">
        <span className="git-diff-title" title={title}>
          <FileDiff size={14} />
          {title}
        </span>
        <span className="git-diff-scope">
          {request.scope === 'index'
            ? 'Staged'
            : request.scope === 'worktree'
              ? 'Working tree'
              : request.scope === 'commit'
                ? `Commit ${request.revision?.slice(0, 8) || ''}`
                : `${request.base?.slice(0, 8) || 'Base'} → ${request.head?.slice(0, 8) || 'Head'}`}
        </span>
        <div className="header-actions">
          {fullText && (
            <>
              <Tooltip label="Previous change">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Previous change"
                  onClick={() => editor.current?.goToDiff('previous')}
                >
                  <ArrowUp size={13} />
                </Button>
              </Tooltip>
              <Tooltip label="Next change">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Next change"
                  onClick={() => editor.current?.goToDiff('next')}
                >
                  <ArrowDown size={13} />
                </Button>
              </Tooltip>
              <Tooltip label={sideBySide ? 'Show inline diff' : 'Show side by side'}>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Toggle side by side diff"
                  aria-pressed={sideBySide}
                  onClick={() => {
                    const next = !sideBySide;
                    setSideBySide(next);
                    try {
                      localStorage.setItem('workbench.gitDiff.sideBySide', String(next));
                    } catch {
                      // The current view still works when preference storage is unavailable.
                    }
                  }}
                >
                  {sideBySide ? <Columns2 size={14} /> : <WrapText size={14} />}
                </Button>
              </Tooltip>
            </>
          )}
          <Tooltip label="Add diff to chat">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Add Git diff to chat"
              disabled={!diff}
              onClick={() => {
                if (!diff) return;
                const reference = makeReference({
                  kind: 'diff',
                  label: `${path ? basename(path) : 'Git'} changes`,
                  origin: title,
                  uri: path ? fileUri(path) : undefined,
                  content: `${title}\nScope: ${request.scope}\n${request.revision ? `Commit: ${request.revision}\n` : ''}${request.base ? `Base: ${request.base}\nHead: ${request.head}\n` : ''}\n${diff.text}`,
                });
                onAttach({ ...reference, truncated: reference.truncated || diff.truncated });
              }}
            >
              <MessageSquarePlus size={14} />
            </Button>
          </Tooltip>
        </div>
      </header>
      {error ? (
        <p className="git-diff-notice error-text" role="alert">
          {error}
        </p>
      ) : !diff ? (
        <p className="git-diff-notice" role="status">
          Loading diff…
        </p>
      ) : (
        <>
          {diff.truncated && (
            <p className="git-diff-notice" role="status">
              Preview limited. Large or binary file contents may be omitted.
            </p>
          )}
          {request.scope === 'commit' && (
            <p className="git-diff-caption">
              Commit changes against its first parent. Root commits compare with an empty tree.
            </p>
          )}
          {fullText ? (
            <div className="git-monaco-diff">
              <DiffEditor
                original={diff.original}
                modified={diff.modified}
                originalModelPath={`workbench-git://before/${identity}/${basename(path || 'diff.txt')}`}
                modifiedModelPath={`workbench-git://after/${identity}/${basename(path || 'diff.txt')}`}
                language={languageId(path || 'diff.txt')}
                theme={monacoThemeNames[theme]}
                keepCurrentOriginalModel
                keepCurrentModifiedModel
                onMount={(instance, monacoApi) => {
                  editor.current = instance;
                  releaseDiffModelsAfterDispose(instance, monacoApi.editor.getEditors);
                }}
                options={{
                  readOnly: true,
                  originalEditable: false,
                  renderSideBySide: sideBySide,
                  automaticLayout: true,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 12,
                  lineHeight: 20,
                  renderOverviewRuler: false,
                  diffAlgorithm: 'advanced',
                  maxComputationTime: 1500,
                  hideUnchangedRegions: {
                    enabled: true,
                    contextLineCount: 3,
                    minimumLineCount: 4,
                    revealLineCount: 20,
                  },
                }}
              />
            </div>
          ) : diff.binary ? (
            <p className="git-diff-notice">Binary file. A text diff is unavailable.</p>
          ) : (
            <pre className="git-unified-diff">{diff.text || 'No changes in this comparison.'}</pre>
          )}
        </>
      )}
    </section>
  );
}
