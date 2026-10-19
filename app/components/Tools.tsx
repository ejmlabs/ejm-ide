import {
  AlertCircle,
  Check,
  ChevronRight,
  LoaderCircle,
  MessageSquarePlus,
  Play,
  Terminal,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { invoke } from '@/lib/backend';
import { makeReference, uriPath } from '@/lib/context';
import type { CommandResult, ContextReference, DiagnosticEntry, SourceRange } from '@/lib/types';
import { basename, relativePath } from '@/lib/utils';
import { Button } from './ui/button';
import { Tooltip } from './ui/tooltip';

export function Problems({
  diagnostics,
  root,
  onNavigate,
  onAttach,
}: {
  diagnostics: DiagnosticEntry[];
  root: string;
  onNavigate: (uri: string, range?: SourceRange) => void;
  onAttach: (ref: ContextReference) => void;
}) {
  return (
    <div className="problems-pane">
      {!diagnostics.length ? (
        <div className="tool-empty">
          <Check size={25} className="success" />
          <strong>No problems reported.</strong>
          <p>Language diagnostics appear here as you code.</p>
        </div>
      ) : (
        diagnostics.map((diagnostic) => (
          <div
            className="problem-row"
            key={JSON.stringify([
              diagnostic.uri,
              diagnostic.range,
              diagnostic.source,
              diagnostic.code,
              diagnostic.message,
            ])}
          >
            <button type="button" onClick={() => onNavigate(diagnostic.uri, diagnostic.range)}>
              {diagnostic.severity === 1 ? (
                <AlertCircle size={15} className="error-text" />
              ) : (
                <TriangleAlert size={15} className="warning" />
              )}
              <span className="problem-message">{diagnostic.message}</span>
              <span className="problem-location">
                {relativePath(uriPath(diagnostic.uri), root)}:{diagnostic.range.start.line + 1}
              </span>
            </button>
            <Tooltip label="Add diagnostic to chat">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Add diagnostic to chat"
                onClick={() =>
                  onAttach(
                    makeReference({
                      kind: 'diagnostic',
                      label: diagnostic.message.slice(0, 48),
                      origin: 'Problems',
                      uri: diagnostic.uri,
                      ranges: [diagnostic.range],
                      content: `${diagnostic.source || 'Language server'} ${diagnostic.code || ''}\n${diagnostic.message}\n${diagnostic.uri}:${diagnostic.range.start.line + 1}`,
                    }),
                  )
                }
              >
                <MessageSquarePlus size={14} />
              </Button>
            </Tooltip>
          </div>
        ))
      )}
    </div>
  );
}

export function TerminalPane({
  root,
  onAttach,
}: {
  root: string;
  onAttach: (ref: ContextReference) => void;
}) {
  const [command, setCommand] = useState('');
  const [results, setResults] = useState<(CommandResult & { id: string })[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run() {
    if (!command.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await invoke<CommandResult>('terminal_run', { command });
      const completed = { ...result, id: crypto.randomUUID() };
      setResults((old) => [...old.slice(-19), completed]);
      setCommand('');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function attach() {
    const selected = window.getSelection()?.toString();
    const last = results.at(-1);
    const content =
      selected ||
      results
        .map((result) => `$ ${result.command}\n${result.output}\nExit: ${result.exitCode}`)
        .join('\n\n');
    if (content)
      onAttach(
        makeReference({
          kind: 'terminal',
          label: selected ? 'Terminal selection' : last?.command || 'Terminal output',
          origin: 'Terminal',
          content: `Workspace: ${root}\n${content}`,
        }),
      );
  }
  return (
    <section className="terminal-pane">
      <div className="tool-subheader">
        <span className="muted">
          <Terminal size={13} />
          {basename(root)}
          <span className="terminal-mode">Command runner</span>
        </span>
        <div className="header-actions">
          <Tooltip label="Add selected output or history to chat">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Add terminal output to chat"
              disabled={!results.length}
              onClick={attach}
            >
              <MessageSquarePlus size={14} />
            </Button>
          </Tooltip>
          <Tooltip label="Clear output">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Clear output"
              onClick={() => setResults([])}
            >
              <Trash2 size={14} />
            </Button>
          </Tooltip>
        </div>
      </div>
      <div className="terminal-output">
        {!results.length && (
          <p className="muted">Run a command in this workspace. Output appears when it finishes.</p>
        )}
        {results.map((result) => (
          <div key={result.id} className="terminal-result">
            <div>
              <span className="accent">❯</span> {result.command}
              <span className={`exit-code ${result.exitCode === 0 ? 'success' : 'error-text'}`}>
                exit {result.exitCode ?? '?'}
              </span>
            </div>
            <pre>{result.output || '(no output)'}</pre>
          </div>
        ))}
        {busy && (
          <p className="muted">
            <LoaderCircle size={13} className="spin" />
            Running…
          </p>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
      <form
        className="terminal-input"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <ChevronRight size={15} className="accent" />
        <input
          aria-label="Workspace command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="cargo test, python3 -m pytest, npm test…"
          autoCapitalize="off"
          spellCheck={false}
        />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Run command"
          disabled={busy || !command.trim()}
          type="submit"
        >
          <Play size={14} />
        </Button>
      </form>
    </section>
  );
}
