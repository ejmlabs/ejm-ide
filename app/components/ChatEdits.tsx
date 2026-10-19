import { ArrowUpRight, ChevronRight, MessageSquarePlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ThemedToken } from 'shiki';
import { type ChatFileEdit, fileDiffPreview } from '@/lib/chat-edits';
import { fileUri, makeReference } from '@/lib/context';
import { monacoThemeNames } from '@/lib/editor-theme';
import { useTheme } from '@/lib/theme';
import type { ToolActivity } from '@/lib/tool-calls';
import type { ContextReference } from '@/lib/types';
import { basename, isJsonComments, languageId } from '@/lib/utils';
import { Tooltip } from './ui/tooltip';
import './chat-edits.css';

function EditFile({
  edit,
  first,
  root,
  applied,
  status,
  onNavigate,
  onAttach,
}: {
  edit: ChatFileEdit;
  first: boolean;
  root?: string;
  applied: boolean;
  status: ToolActivity['status'];
  onNavigate: (uri: string) => void;
  onAttach: (reference: ContextReference) => void;
}) {
  const mode = useTheme();
  const [open, setOpen] = useState(first);
  const preview = useMemo(() => fileDiffPreview(edit), [edit]);
  const [tokens, setTokens] = useState<ThemedToken[][][]>([]);
  const destination = applied && edit.movePath ? edit.movePath : edit.path;
  const path = destination.startsWith('/') ? destination : root ? `${root}/${destination}` : null;
  const label =
    root && edit.path.startsWith(`${root}/`) ? edit.path.slice(root.length + 1) : edit.path;
  useEffect(() => {
    setTokens([]);
    if (!open || edit.diff.length > 40_000) return;
    let current = true;
    void import('@/lib/highlighting')
      .then(({ createSyntaxHighlighter }) => createSyntaxHighlighter())
      .then((highlighter) => {
        const language = languageId(edit.path);
        const lang = /\.tsx$/i.test(edit.path)
          ? 'tsx'
          : /\.jsx$/i.test(edit.path)
            ? 'jsx'
            : isJsonComments(edit.path)
              ? 'jsonc'
              : language === 'shell'
                ? 'shellscript'
                : language;
        if (!current || !highlighter.getLoadedLanguages().includes(lang)) return;
        const highlighted = preview.hunks.map((hunk) => {
          const before = highlighter.codeToTokens(
            hunk.lines
              .filter((line) => line.type === 'context' || line.type === 'delete')
              .map((line) => line.content)
              .join('\n'),
            { lang, theme: monacoThemeNames[mode] },
          ).tokens;
          const after = highlighter.codeToTokens(
            hunk.lines
              .filter((line) => line.type === 'context' || line.type === 'add')
              .map((line) => line.content)
              .join('\n'),
            { lang, theme: monacoThemeNames[mode] },
          ).tokens;
          let oldLine = 0,
            newLine = 0;
          return hunk.lines.map((line) => {
            const result =
              line.type === 'delete' ? before[oldLine] : line.type === 'meta' ? [] : after[newLine];
            if (line.type === 'context' || line.type === 'delete') oldLine++;
            if (line.type === 'context' || line.type === 'add') newLine++;
            return result || [];
          });
        });
        if (current) setTokens(highlighted);
      })
      .catch(() => {
        /* Plain text remains readable if highlighting is unavailable. */
      });
    return () => {
      current = false;
    };
  }, [edit, mode, open, preview]);
  return (
    <details
      className="chat-edit-file"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ChevronRight className="edit-disclosure" size={11} aria-hidden="true" />
        <span
          className="chat-edit-path"
          title={edit.movePath ? `${edit.path} → ${edit.movePath}` : edit.path}
        >
          {label}
        </span>
        <span className="chat-edit-kind">
          {edit.movePath
            ? 'Moved'
            : edit.kind === 'add'
              ? 'Added'
              : edit.kind === 'delete'
                ? 'Deleted'
                : ''}
        </span>
        {preview.additions !== null && (
          <span className="chat-edit-added" title={`${preview.additions} lines added`}>
            +{preview.additions}
            <span className="sr-only"> lines added</span>
          </span>
        )}
        {preview.deletions !== null && (
          <span className="chat-edit-removed" title={`${preview.deletions} lines removed`}>
            −{preview.deletions}
            <span className="sr-only"> lines removed</span>
          </span>
        )}
        <Tooltip label="Add diff to chat">
          <button
            type="button"
            className="chat-edit-action"
            aria-label={`Add ${basename(edit.path)} diff to chat`}
            onClick={(event) => {
              event.preventDefault();
              const reference = makeReference({
                kind: 'diff',
                label: `${basename(edit.path)} changes`,
                origin: `Edi edit (${status})`,
                uri: path ? fileUri(path) : undefined,
                content: `${edit.kind}: ${edit.path}${edit.movePath ? `\nDestination: ${edit.movePath}` : ''}\nResult: ${status}\nFormat: ${edit.format === 'content' ? 'Full file contents' : 'Unified diff'}\n\n${edit.diff}`,
              });
              onAttach({ ...reference, truncated: reference.truncated || edit.truncated });
            }}
          >
            <MessageSquarePlus size={12} />
          </button>
        </Tooltip>
        {path && !(applied && edit.kind === 'delete') && (
          <Tooltip label="Open file in editor">
            <button
              type="button"
              className="chat-edit-action"
              aria-label={`Open ${basename(destination)} in editor`}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(fileUri(path));
              }}
            >
              <ArrowUpRight size={12} />
            </button>
          </Tooltip>
        )}
      </summary>
      {open && (
        <>
          {edit.movePath && <p className="chat-edit-note">Destination: {edit.movePath}</p>}
          {preview.hunks.length > 0 && (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the diff.
            <section className="chat-edit-code" tabIndex={0} aria-label={`${label} diff`}>
              <table>
                <caption className="sr-only">
                  Recorded changes to {label}. Old and new line numbers precede the code.
                </caption>
                <tbody>
                  {preview.hunks.map((hunk, hunkIndex) => (
                    <DiffHunkRows key={hunk.header} hunk={hunk} tokens={tokens[hunkIndex]} />
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {preview.fallback && <pre className="chat-edit-fallback">{preview.fallback}</pre>}
          {!preview.hunks.length && !preview.fallback && (
            <p className="chat-edit-note">
              {edit.movePath
                ? 'File moved without a text change.'
                : 'No text changes in this record.'}
            </p>
          )}
          {preview.truncated && (
            <p className="chat-edit-note">Preview limited. Open the file for the current source.</p>
          )}
        </>
      )}
    </details>
  );
}

function DiffHunkRows({
  hunk,
  tokens,
}: {
  hunk: ReturnType<typeof fileDiffPreview>['hunks'][number];
  tokens?: ThemedToken[][];
}) {
  return (
    <>
      <tr className="chat-edit-hunk">
        <td colSpan={3}>{hunk.header}</td>
      </tr>
      {hunk.lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Rows are fixed lines in a text snapshot with no local state.
        <tr key={index} className={`chat-edit-line ${line.type}`}>
          <td className="chat-edit-number">{line.oldLine ?? ''}</td>
          <td className="chat-edit-number">{line.newLine ?? ''}</td>
          <td className="chat-edit-source">
            <span className="chat-edit-sign" aria-hidden="true">
              {line.type === 'add' ? '+' : line.type === 'delete' ? '−' : ' '}
            </span>
            {tokens?.[index]?.length
              ? tokens[index].map((token) => (
                  <span key={token.offset} style={{ color: token.color }}>
                    {token.content}
                  </span>
                ))
              : line.content || ' '}
          </td>
        </tr>
      ))}
    </>
  );
}

export function ChatEdits({
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
  if (!edits) return null;
  return (
    <section className="chat-edits" aria-label="Edi file changes">
      {tool.status === 'running' && !tool.aggregate && (
        <p className="chat-edit-note">Changes are in progress. The result is not confirmed yet.</p>
      )}
      {(tool.status === 'failed' || tool.status === 'declined' || tool.status === 'stopped') && (
        <p className="chat-edit-note">
          {tool.status === 'declined'
            ? 'The edit was declined.'
            : 'Some edits may remain in the workspace. This record is not proof of their current state.'}
        </p>
      )}
      {edits.files.map((edit, index) => (
        <EditFile
          key={edit.path}
          edit={edit}
          first={index === 0}
          root={root}
          applied={tool.status === 'completed'}
          status={tool.status}
          onNavigate={onNavigate}
          onAttach={onAttach}
        />
      ))}
      {!edits.files.length && !edits.truncated && (
        <p className="chat-edit-note">No recorded text changes.</p>
      )}
      {edits.truncated && (
        <p className="chat-edit-note">
          Some change details were omitted because they were too large or invalid.
        </p>
      )}
    </section>
  );
}
