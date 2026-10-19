import * as monaco from 'monaco-editor/editor/editor.api';
import { useEffect } from 'react';
import { invoke } from './backend';
import { uriPath } from './context';
import type { GitBlame } from './git';
import './git-blame.css';

export function useGitLineBlame({
  root,
  path,
  content,
  line,
  enabled,
  editor,
  revision,
}: {
  root?: string;
  path?: string;
  content?: string;
  line: number;
  enabled: boolean;
  editor: monaco.editor.IStandaloneCodeEditor | null;
  revision: number;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: A Git refresh invalidates attribution even when editor text is unchanged.
  useEffect(() => {
    if (!enabled || !root || !path || content === undefined || !editor) return;
    const model = editor.getModel();
    if (!model || uriPath(model.uri.toString()) !== path || line > model.getLineCount()) return;
    let widget: monaco.editor.IContentWidget | undefined;
    const listeners: monaco.IDisposable[] = [];
    let current = true;
    const timer = window.setTimeout(() => {
      void invoke<GitBlame>('git_blame', {
        path,
        startLine: line,
        endLine: line,
        content,
      })
        .then((result) => {
          if (!current || editor.getModel() !== model || model.getValue() !== content) return;
          const blame = result.lines.find((item) => item.line === line);
          if (!blame) return;
          const author = blame.author.replace(/[\r\n\t]/g, ' ');
          const subject = blame.summary.replace(/[\r\n\t]/g, ' ');
          const label = blame.uncommitted ? 'Uncommitted changes' : `${author} · ${subject}`;
          const node = document.createElement('span');
          node.className = 'git-blame-widget';
          node.textContent = label.slice(0, 100);
          node.title = blame.uncommitted
            ? 'Uncommitted changes in the current editor buffer.'
            : `${blame.commit}\n${author}\n${subject}`;
          node.setAttribute('aria-hidden', 'true');
          widget = {
            getId: () => `git-line-blame-${editor.getId()}`,
            getDomNode: () => node,
            suppressMouseDown: true,
            getPosition: () => {
              if (!current || model.isDisposed() || editor.getModel() !== model) return null;
              const position = { lineNumber: line, column: model.getLineMaxColumn(line) };
              const visible = editor.getScrolledVisiblePosition(position);
              if (!visible) return null;
              const layout = editor.getLayoutInfo();
              const space = layout.contentLeft + layout.contentWidth - visible.left - 32;
              if (space < 80) return null;
              node.style.maxWidth = `${Math.min(500, space)}px`;
              node.style.lineHeight = `${editor.getOption(monaco.editor.EditorOption.lineHeight)}px`;
              return {
                position,
                preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
              };
            },
          };
          editor.addContentWidget(widget);
          const layout = () => {
            if (current && widget) editor.layoutContentWidget(widget);
          };
          listeners.push(editor.onDidScrollChange(layout), editor.onDidLayoutChange(layout));
        })
        .catch(() => {
          // Folders without Git have no committed line attribution.
        });
    }, 450);
    return () => {
      current = false;
      window.clearTimeout(timer);
      for (const listener of listeners) listener.dispose();
      if (widget) editor.removeContentWidget(widget);
    };
  }, [root, path, content, line, enabled, editor, revision]);
}
