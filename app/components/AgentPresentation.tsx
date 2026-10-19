import { Check, ChevronRight, LoaderCircle, Terminal, TriangleAlert, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { HintTarget } from '@/lib/agent-ide';
import { fileDiffPreview } from '@/lib/chat-edits';
import type { ToolActivity } from '@/lib/tool-calls';
import type { ContextReference } from '@/lib/types';
import { ChatEdits } from './ChatEdits';
import { Button } from './ui/button';
import './agent-presentation.css';

export function ToolCall({
  tool,
  root,
  onNavigate,
  onAttach,
}: {
  tool: ToolActivity;
  root?: string;
  onNavigate: (uri: string) => void;
  onAttach: (reference: ContextReference) => void;
}) {
  const edits = tool.fileEdits;
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const counts = useMemo(() => {
    if (!edits || edits.truncated) return null;
    let additions = 0;
    let deletions = 0;
    for (const edit of edits.files) {
      const preview = fileDiffPreview(edit);
      if (preview.additions === null || preview.deletions === null) return null;
      additions += preview.additions;
      deletions += preview.deletions;
    }
    return { additions, deletions };
  }, [edits]);
  const status = edits
    ? tool.status === 'running'
      ? tool.aggregate
        ? 'Turn in progress'
        : 'Editing'
      : tool.status === 'completed'
        ? tool.aggregate
          ? 'Recorded'
          : 'Applied'
        : tool.status === 'failed'
          ? 'Failed'
          : tool.status === 'declined'
            ? 'Declined'
            : 'Stopped'
    : tool.status;
  const details = (
    <>
      {tool.arguments && (
        <div className="chat-tool-data">
          <strong>Arguments</strong>
          <pre>{tool.arguments}</pre>
        </div>
      )}
      {tool.output && (
        <div className="chat-tool-data">
          <strong>Result</strong>
          <pre>{tool.output}</pre>
        </div>
      )}
    </>
  );
  return (
    <details
      className={`chat-tool-call${edits ? ' has-edits' : ''}`}
      open={expanded ?? !!edits}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <ChevronRight className="tool-disclosure" size={12} aria-hidden="true" />
        {tool.status === 'running' ? (
          <LoaderCircle className="spin" size={13} aria-hidden="true" />
        ) : tool.status === 'failed' || tool.status === 'declined' ? (
          <TriangleAlert className="warning" size={13} aria-hidden="true" />
        ) : tool.status === 'completed' ? (
          <Check size={13} aria-hidden="true" />
        ) : (
          <Terminal size={13} aria-hidden="true" />
        )}
        <span className="chat-tool-name" title={tool.name}>
          {tool.name.replace(/^workbench_/, '').replaceAll('_', ' ')}
        </span>
        {edits && (
          <span className="chat-tool-changes">
            <span>
              {edits.truncated
                ? edits.files.length
                  ? `${edits.files.length}+ files`
                  : 'Partial diff'
                : `${edits.files.length} ${edits.files.length === 1 ? 'file' : 'files'}`}
            </span>
            {counts && edits.files.length > 0 && (
              <>
                <span className="chat-edit-added">
                  +{counts.additions}
                  <span className="sr-only"> lines added</span>
                </span>
                <span className="chat-edit-removed">
                  −{counts.deletions}
                  <span className="sr-only"> lines removed</span>
                </span>
              </>
            )}
          </span>
        )}
        <small className={edits ? `chat-edit-status ${tool.status}` : undefined} role="status">
          {status}
        </small>
      </summary>
      {edits ? (
        <>
          <ChatEdits tool={tool} root={root} onNavigate={onNavigate} onAttach={onAttach} />
          {(tool.arguments || tool.output) && (
            <details className="chat-tool-details">
              <summary>
                <ChevronRight size={11} aria-hidden="true" />
                Tool details
              </summary>
              {details}
            </details>
          )}
        </>
      ) : (
        details
      )}
      {!edits && !tool.output && tool.status === 'running' && <p>Waiting for the tool result…</p>}
    </details>
  );
}

export interface AgentHintValue {
  id: string;
  target: HintTarget;
  text: string;
  revision: string;
}
export function AgentHint({ hint, onDismiss }: { hint: AgentHintValue; onDismiss: () => void }) {
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const target = document.querySelector<HTMLElement>(`[data-ide-surface="${hint.target}"]`);
    if (!target) return;
    const update = () => {
      const rect = target.getBoundingClientRect();
      const width = Math.min(280, rect.width - 20);
      if (width < 120 || rect.height < 24) {
        setPosition(null);
        return;
      }
      setPosition({
        left: Math.max(10, Math.min(rect.left + (rect.width - width) / 2, innerWidth - width - 10)),
        top: Math.min(rect.top + 12, innerHeight - 130),
        width,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [hint]);
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 30_000);
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', dismiss);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', dismiss);
    };
  }, [onDismiss]);
  if (!position) return null;
  return (
    <aside
      className="agent-hint"
      style={position}
      aria-label="Edi hint"
      role="status"
      data-ide-hint={hint.id}
      data-ide-revision={hint.revision}
    >
      <div>
        <strong>Edi</strong>
        <Button variant="ghost" size="icon" aria-label="Dismiss Edi hint" onClick={onDismiss}>
          <X size={13} />
        </Button>
      </div>
      <p>{hint.text}</p>
    </aside>
  );
}
