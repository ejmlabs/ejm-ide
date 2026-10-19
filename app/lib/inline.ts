import type * as Monaco from 'monaco-editor/editor/editor.api';
import { uriPath } from './context';
import { type AgentSelection, invokeAgent } from './providers';

const LANGUAGES = ['rust', 'python', 'typescript', 'javascript', 'ruby', 'go'];
const QUIET_PERIOD = 900;
const PREFIX_LIMIT = 12_000;
const SUFFIX_LIMIT = 4_000;
const INSERT_LIMIT = 2_048;

export type InlineStatus = {
  state: 'idle' | 'waiting' | 'loading' | 'ready' | 'error';
  message?: string;
};
export interface InlineCompletionOptions {
  monaco: typeof Monaco;
  editor: Monaco.editor.IStandaloneCodeEditor;
  enabled: () => boolean;
  selection: () => AgentSelection;
  onStatusChange?: (status: InlineStatus) => void;
}

function splitsSurrogate(text: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[offset])
  );
}

export function completionContext(
  text: string,
  offset: number,
): { prefix: string; suffix: string } | null {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > text.length ||
    splitsSurrogate(text, offset)
  )
    return null;
  let start = Math.max(0, offset - PREFIX_LIMIT);
  let end = Math.min(text.length, offset + SUFFIX_LIMIT);
  if (splitsSurrogate(text, start)) start++;
  if (splitsSurrogate(text, end)) end--;
  return { prefix: text.slice(start, offset), suffix: text.slice(offset, end) };
}

function insertionText(text: string, atLineEnd: boolean): string {
  if (text.includes('\0') || /^\s*```/.test(text)) return '';
  let bounded = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .slice(0, atLineEnd ? 16 : 1)
    .join('\n');
  let end = Math.min(bounded.length, INSERT_LIMIT);
  if (splitsSurrogate(bounded, end)) end--;
  bounded = bounded.slice(0, end);
  return bounded.trim() ? bounded : '';
}

type Pending = {
  model: Monaco.editor.ITextModel;
  version: number;
  position: Monaco.IPosition;
  generation: number;
  requestId: string;
  selection: AgentSelection;
  started: boolean;
  cancelled: boolean;
  stopWaiting?: () => void;
};

export function installInlineCompletions({
  monaco,
  editor,
  enabled,
  selection,
  onStatusChange,
}: InlineCompletionOptions) {
  const generations = new WeakMap<Monaco.editor.ITextModel, number>();
  const attempted = new WeakMap<Monaco.editor.ITextModel, string>();
  const disposables: Monaco.IDisposable[] = [];
  let disposed = false;
  let pending: Pending | undefined;
  let lastEdit:
    | { model: Monaco.editor.ITextModel; version: number; at: number; typed: boolean }
    | undefined;
  let status: InlineStatus = { state: 'idle' };

  function report(next: InlineStatus) {
    if (status.state === next.state && status.message === next.message) return;
    status = next;
    onStatusChange?.(next);
  }
  function cancel(request: Pending) {
    if (request.cancelled) return;
    request.cancelled = true;
    request.stopWaiting?.();
    if (request.started)
      void invokeAgent(request.selection.providerId, 'agent_complete_cancel', {
        requestId: request.requestId,
      }).catch(() => {});
    if (pending === request) {
      pending = undefined;
      generations.set(request.model, request.generation + 1);
      report({ state: 'idle' });
    }
  }
  function invalidate() {
    if (pending) cancel(pending);
    else report({ state: 'idle' });
  }
  function popupVisible() {
    // A loading suggestions popup has no selectedSuggestionInfo yet.
    return !!editor.getDomNode()?.querySelector('.suggest-widget.visible');
  }
  function usable(model: Monaco.editor.ITextModel, position: Monaco.IPosition) {
    const cursor = editor.getPosition();
    const selections = editor.getSelections();
    return (
      !disposed &&
      enabled() &&
      !model.isDisposed() &&
      editor.getModel() === model &&
      editor.hasTextFocus() &&
      cursor?.lineNumber === position.lineNumber &&
      cursor.column === position.column &&
      selections?.length === 1 &&
      selections[0].isEmpty() &&
      !popupVisible()
    );
  }
  function current(request: Pending) {
    return (
      !request.cancelled &&
      pending === request &&
      generations.get(request.model) === request.generation &&
      request.model.getVersionId() === request.version &&
      usable(request.model, request.position)
    );
  }
  function trigger() {
    invalidate();
    if (!disposed && enabled()) {
      if (popupVisible()) editor.trigger('workbench', 'hideSuggestWidget', {});
      editor.trigger('workbench', 'editor.action.inlineSuggest.trigger', {});
    }
  }

  disposables.push(
    editor.onDidChangeModelContent((event) => {
      invalidate();
      const model = editor.getModel();
      if (model)
        lastEdit = {
          model,
          version: model.getVersionId(),
          at: Date.now(),
          typed:
            !event.isFlush &&
            !event.isUndoing &&
            !event.isRedoing &&
            event.changes.some(
              (change) =>
                change.rangeLength === 0 && change.text.length > 0 && change.text.length <= 2,
            ),
        };
    }),
  );
  disposables.push(
    editor.onDidChangeCursorPosition((event) => {
      invalidate();
      if (event.reason === monaco.editor.CursorChangeReason.Explicit || event.source === 'api')
        lastEdit = undefined;
    }),
  );
  disposables.push(
    editor.onDidChangeModel(() => {
      invalidate();
      lastEdit = undefined;
    }),
  );
  disposables.push(
    editor.onDidBlurEditorText(() => {
      invalidate();
      lastEdit = undefined;
    }),
  );
  disposables.push(
    editor.onKeyDown((event) => {
      if (event.keyCode === monaco.KeyCode.Escape) {
        invalidate();
        lastEdit = undefined;
      }
    }),
  );
  disposables.push(
    editor.addAction({
      id: 'workbench.inlineComplete',
      label: 'Request AI Completion',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.Space],
      precondition: 'editorTextFocus && !editorReadonly',
      run: trigger,
    }),
  );
  disposables.push(
    editor.addAction({
      id: 'workbench.acceptInlineCompletion',
      label: 'Accept AI Completion',
      keybindings: [monaco.KeyCode.Tab],
      precondition:
        'editorTextFocus && !editorReadonly && inlineSuggestionVisible && !suggestWidgetVisible && !inSnippetMode && !tabMovesFocus',
      run() {
        editor.trigger('workbench', 'editor.action.inlineSuggest.commit', {});
        report({ state: 'idle' });
      },
    }),
  );

  const provider: Monaco.languages.InlineCompletionsProvider = {
    displayName: 'AI',
    debounceDelayMs: QUIET_PERIOD,
    async provideInlineCompletions(model, position, context, token) {
      const empty = { items: [] };
      if (
        !LANGUAGES.includes(model.getLanguageId()) ||
        model.uri.scheme !== 'file' ||
        context.selectedSuggestionInfo ||
        !usable(model, position) ||
        token.isCancellationRequested
      )
        return empty;
      const explicit =
        context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
      const version = model.getVersionId();
      const key = `${version}:${position.lineNumber}:${position.column}`;
      if (!explicit) {
        const line = model
          .getLineContent(position.lineNumber)
          .slice(0, position.column - 1)
          .trim();
        if (
          !lastEdit?.typed ||
          lastEdit.model !== model ||
          lastEdit.version !== version ||
          line.length < 3 ||
          !/[\p{L}\p{N}_]/u.test(line) ||
          attempted.get(model) === key
        )
          return empty;
      }
      const capturedSelection = { ...selection() };
      if (!capturedSelection.providerId) return empty;
      const captured = completionContext(model.getValue(), model.getOffsetAt(position));
      if (!captured) return empty;
      invalidate();
      const generation = (generations.get(model) || 0) + 1;
      generations.set(model, generation);
      const request: Pending = {
        model,
        version,
        position: { lineNumber: position.lineNumber, column: position.column },
        generation,
        requestId: crypto.randomUUID(),
        selection: capturedSelection,
        started: false,
        cancelled: false,
      };
      pending = request;
      const cancellation = token.onCancellationRequested(() => cancel(request));
      try {
        if (!explicit) {
          report({ state: 'waiting' });
          const delay = Math.max(0, QUIET_PERIOD - (Date.now() - (lastEdit?.at ?? Date.now())));
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            request.stopWaiting = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          request.stopWaiting = undefined;
        }
        if (!current(request)) {
          cancel(request);
          return empty;
        }
        attempted.set(model, key);
        request.started = true;
        report({ state: 'loading' });
        const response = await invokeAgent<{ requestId: string; text: string }>(
          request.selection.providerId,
          'agent_complete',
          {
            path: uriPath(model.uri.toString()),
            ...captured,
            language: model.getLanguageId(),
            requestId: request.requestId,
            model: request.selection.model || undefined,
            effort: request.selection.effort || undefined,
          },
        );
        if (!current(request) || response.requestId !== request.requestId) {
          cancel(request);
          return empty;
        }
        const text = insertionText(
          response.text,
          position.column === model.getLineMaxColumn(position.lineNumber),
        );
        pending = undefined;
        report({ state: text ? 'ready' : 'idle' });
        return {
          items: text
            ? [
                {
                  insertText: text,
                  range: {
                    startLineNumber: position.lineNumber,
                    endLineNumber: position.lineNumber,
                    startColumn: position.column,
                    endColumn: position.column,
                  },
                  completeBracketPairs: false,
                  doNotLog: true,
                },
              ]
            : [],
          enableForwardStability: false,
          suppressSuggestions: false,
        };
      } catch (error) {
        if (current(request)) {
          pending = undefined;
          report({
            state: 'error',
            message: String(error instanceof Error ? error.message : error).slice(0, 300),
          });
        } else cancel(request);
        return empty;
      } finally {
        cancellation.dispose();
      }
    },
    disposeInlineCompletions() {},
  };
  for (const language of LANGUAGES)
    disposables.push(monaco.languages.registerInlineCompletionsProvider(language, provider));

  function dispose() {
    if (disposed) return;
    disposed = true;
    invalidate();
    disposables.forEach((disposable) => {
      disposable.dispose();
    });
  }
  disposables.push(editor.onDidDispose(dispose));
  return {
    trigger,
    refresh() {
      invalidate();
      editor.trigger('workbench', 'editor.action.inlineSuggest.hide', {});
    },
    dispose,
  };
}
