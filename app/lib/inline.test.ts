import type * as Monaco from 'monaco-editor/editor/editor.api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completionContext, installInlineCompletions } from './inline';

const backend = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./backend', () => backend);

function signal<T>() {
  const listeners = new Set<(event: T) => void>();
  return {
    listen(listener: (event: T) => void) {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    fire(event: T) {
      listeners.forEach((listener) => {
        listener(event);
      });
    },
  };
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(initial = 'const value = ', language = 'typescript') {
  const content = signal<Monaco.editor.IModelContentChangedEvent>();
  const cursor = signal<Monaco.editor.ICursorPositionChangedEvent>();
  const modelChange = signal<Monaco.editor.IModelChangedEvent>();
  const blur = signal<void>();
  const editorDispose = signal<void>();
  const keyDown = signal<Monaco.IKeyboardEvent>();
  let text = initial;
  let version = 1;
  let position = { lineNumber: 1, column: initial.length + 1 };
  let enabled = true;
  let popup = false;
  let selectedProvider = 'selected-provider';
  let provider!: Monaco.languages.InlineCompletionsProvider;
  const model = {
    uri: { scheme: 'file', toString: () => 'file:///tmp/project/unsaved.ts' },
    getLanguageId: () => language,
    isDisposed: () => false,
    getValue: () => text,
    getVersionId: () => version,
    getLineContent: (line: number) => text.split('\n')[line - 1],
    getLineMaxColumn: (line: number) => text.split('\n')[line - 1].length + 1,
    getOffsetAt: (point: Monaco.IPosition) =>
      text
        .split('\n')
        .slice(0, point.lineNumber - 1)
        .reduce((sum, line) => sum + line.length + 1, 0) +
      point.column -
      1,
  } as unknown as Monaco.editor.ITextModel;
  const editor = {
    getPosition: () => position,
    getModel: () => model,
    hasTextFocus: () => true,
    getSelections: () => [{ isEmpty: () => true }],
    getDomNode: () => ({ querySelector: () => (popup ? {} : null) }),
    onDidChangeModelContent: content.listen,
    onDidChangeCursorPosition: cursor.listen,
    onDidChangeModel: modelChange.listen,
    onDidBlurEditorText: blur.listen,
    onDidDispose: editorDispose.listen,
    onKeyDown: keyDown.listen,
    addAction: vi.fn(() => ({ dispose() {} })),
    trigger: vi.fn(),
  } as unknown as Monaco.editor.IStandaloneCodeEditor;
  const monaco = {
    languages: {
      InlineCompletionTriggerKind: { Automatic: 0, Explicit: 1 },
      registerInlineCompletionsProvider: vi.fn((_language, value) => {
        provider = value;
        return { dispose() {} };
      }),
    },
    editor: { CursorChangeReason: { Explicit: 3 } },
    KeyMod: { CtrlCmd: 1, Alt: 2 },
    KeyCode: { Space: 3, Escape: 9, Tab: 2 },
  } as unknown as typeof Monaco;
  const onStatusChange = vi.fn();
  const controller = installInlineCompletions({
    monaco,
    editor,
    enabled: () => enabled,
    selection: () => ({ providerId: selectedProvider, model: 'selected-model', effort: 'low' }),
    onStatusChange,
  });
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  } as Monaco.CancellationToken;
  return {
    editor,
    model,
    controller,
    onStatusChange,
    type(value = 'n') {
      text += value;
      version++;
      position = { lineNumber: 1, column: text.length + 1 };
      content.fire({
        changes: [{ text: value, rangeLength: 0 }],
        isFlush: false,
        isUndoing: false,
        isRedoing: false,
      } as Monaco.editor.IModelContentChangedEvent);
    },
    move() {
      position = { ...position, column: position.column - 1 };
      cursor.fire({ reason: 3, source: 'keyboard' } as Monaco.editor.ICursorPositionChangedEvent);
    },
    switchModel() {
      modelChange.fire({} as Monaco.editor.IModelChangedEvent);
    },
    switchProvider(id = 'other-provider') {
      selectedProvider = id;
      controller.refresh();
    },
    showPopup() {
      popup = true;
    },
    disable() {
      enabled = false;
      controller.refresh();
    },
    escape() {
      keyDown.fire({ keyCode: 9 } as Monaco.IKeyboardEvent);
    },
    request(explicit = false, selectedSuggestionInfo?: Monaco.languages.SelectedSuggestionInfo) {
      return Promise.resolve(
        provider.provideInlineCompletions(
          model,
          position as Monaco.Position,
          {
            triggerKind: explicit ? 1 : 0,
            selectedSuggestionInfo,
          } as Monaco.languages.InlineCompletionContext,
          token,
        ),
      );
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  backend.invoke.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AI inline completions', () => {
  it('accepts ghost text with Tab while preserving suggestion, snippet and focus Tab keys', () => {
    const h = harness();
    const actions = vi.mocked(h.editor.addAction).mock.calls.map(([action]) => action);
    const accept = actions.find((action) => action.id === 'workbench.acceptInlineCompletion');
    expect(accept?.keybindings).toEqual([2]);
    expect(accept?.precondition).toContain('inlineSuggestionVisible');
    expect(accept?.precondition).toContain('!suggestWidgetVisible');
    expect(accept?.precondition).toContain('!inSnippetMode');
    expect(accept?.precondition).toContain('!tabMovesFocus');
    accept?.run(h.editor);
    expect(h.editor.trigger).toHaveBeenCalledWith(
      'workbench',
      'editor.action.inlineSuggest.commit',
      {},
    );
    h.showPopup();
    h.controller.trigger();
    expect(h.editor.trigger).toHaveBeenNthCalledWith(2, 'workbench', 'hideSuggestWidget', {});
    expect(h.editor.trigger).toHaveBeenNthCalledWith(
      3,
      'workbench',
      'editor.action.inlineSuggest.trigger',
      {},
    );
    h.controller.dispose();
  });
  it('uses Monaco UTF16 offsets and does not split surrogate pairs at context bounds', () => {
    expect(completionContext('a😀b\r\nc', 4)).toEqual({ prefix: 'a😀b', suffix: '\r\nc' });
    expect(completionContext('a😀b', 2)).toBeNull();
    const text = `😀${'a'.repeat(11_999)}${'b'.repeat(3_999)}😀`;
    expect(completionContext(text, 12_001)).toEqual({
      prefix: 'a'.repeat(11_999),
      suffix: 'b'.repeat(3_999),
    });
  });

  it.each(['ruby', 'go'])('requests AI inline predictions for %s buffers', async (language) => {
    const h = harness('total = ', language);
    backend.invoke.mockImplementation(async (_command, args) => ({
      requestId: args.requestId,
      text: 'calculate_total()',
    }));
    const result = await h.request(true);
    expect(backend.invoke).toHaveBeenCalledWith(
      'agent_complete',
      expect.objectContaining({ language }),
    );
    expect(result?.items[0].insertText).toBe('calculate_total()');
    h.controller.dispose();
  });

  it('waits 900 ms after typing and sends captured unsaved text and the current selection', async () => {
    const h = harness();
    h.type();
    backend.invoke.mockImplementation(async (_command, args) => ({
      requestId: args.requestId,
      text: 'ew Value()',
    }));
    const request = h.request();
    await vi.advanceTimersByTimeAsync(899);
    expect(backend.invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.invoke).toHaveBeenCalledWith(
      'agent_complete',
      expect.objectContaining({
        path: '/tmp/project/unsaved.ts',
        prefix: 'const value = n',
        suffix: '',
        language: 'typescript',
        providerId: 'selected-provider',
        model: 'selected-model',
        effort: 'low',
      }),
    );
    expect((await request)?.items[0]).toMatchObject({
      insertText: 'ew Value()',
      range: { startColumn: 16, endColumn: 16 },
    });
    expect((await h.request())?.items).toEqual([]);
    expect(backend.invoke).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });

  it.each(['cursor', 'content', 'model', 'disabled'] as const)(
    'cancels %s changes and suppresses a stale native response',
    async (change) => {
      const h = harness();
      const reply = deferred<{ requestId: string; text: string }>();
      backend.invoke.mockImplementation((command) =>
        command === 'agent_complete' ? reply.promise : Promise.resolve(),
      );
      const request = h.request(true);
      const args = backend.invoke.mock.calls[0][1];
      if (change === 'cursor') h.move();
      if (change === 'content') h.type();
      if (change === 'model') h.switchModel();
      if (change === 'disabled') h.disable();
      expect(backend.invoke).toHaveBeenCalledWith('agent_complete_cancel', {
        requestId: args.requestId,
        providerId: 'selected-provider',
      });
      reply.resolve({ requestId: args.requestId, text: 'stale' });
      expect((await request)?.items).toEqual([]);
      expect(h.onStatusChange).not.toHaveBeenCalledWith({ state: 'ready' });
      h.controller.dispose();
    },
  );

  it('cancels the debounce before a cursor move can start a native turn', async () => {
    const h = harness();
    h.type();
    const request = h.request();
    h.move();
    await vi.advanceTimersByTimeAsync(900);
    expect((await request)?.items).toEqual([]);
    expect(backend.invoke).not.toHaveBeenCalled();
    h.controller.dispose();
  });

  it('cancels a pending completion through its original provider after a provider switch', async () => {
    const h = harness();
    const reply = deferred<{ requestId: string; text: string }>();
    backend.invoke.mockImplementation((command) =>
      command === 'agent_complete' ? reply.promise : Promise.resolve(),
    );
    const request = h.request(true);
    const args = backend.invoke.mock.calls[0][1];
    h.switchProvider();
    expect(backend.invoke).toHaveBeenCalledWith('agent_complete_cancel', {
      requestId: args.requestId,
      providerId: 'selected-provider',
    });
    reply.resolve({ requestId: args.requestId, text: 'stale provider result' });
    expect((await request)?.items).toEqual([]);
    backend.invoke.mockImplementation(async (_command, next) => ({
      requestId: next.requestId,
      text: 'fresh result',
    }));
    expect((await h.request(true))?.items[0].insertText).toBe('fresh result');
    expect(backend.invoke).toHaveBeenLastCalledWith(
      'agent_complete',
      expect.objectContaining({
        providerId: 'other-provider',
      }),
    );
    h.controller.dispose();
  });

  it('makes no completion request without a configured provider', async () => {
    const h = harness();
    h.switchProvider('');
    expect((await h.request(true))?.items).toEqual([]);
    expect(backend.invoke).not.toHaveBeenCalled();
    h.controller.dispose();
  });

  it('suppresses popup conflicts and bypasses typing debounce only for an explicit request', async () => {
    const h = harness();
    expect((await h.request())?.items).toEqual([]);
    h.showPopup();
    expect((await h.request(true))?.items).toEqual([]);
    expect(backend.invoke).not.toHaveBeenCalled();
    h.controller.dispose();
    const explicit = harness();
    backend.invoke.mockImplementation(async (_command, args) => ({
      requestId: args.requestId,
      text: 'new Value()\nnext()',
    }));
    expect((await explicit.request(true))?.items[0]?.insertText).toBe('new Value()\nnext()');
    expect(backend.invoke).toHaveBeenCalledTimes(1);
    explicit.controller.dispose();
  });

  it('clears the ghost and pending work when selection changes or Escape dismisses it', async () => {
    const h = harness();
    const reply = deferred<{ requestId: string; text: string }>();
    backend.invoke.mockImplementation((command) =>
      command === 'agent_complete' ? reply.promise : Promise.resolve(),
    );
    const request = h.request(true);
    const args = backend.invoke.mock.calls[0][1];
    h.escape();
    expect(backend.invoke).toHaveBeenCalledWith('agent_complete_cancel', {
      requestId: args.requestId,
      providerId: 'selected-provider',
    });
    reply.resolve({ requestId: args.requestId, text: 'dismissed' });
    expect((await request)?.items).toEqual([]);
    h.controller.refresh();
    expect(h.editor.trigger).toHaveBeenCalledWith(
      'workbench',
      'editor.action.inlineSuggest.hide',
      {},
    );
    h.controller.dispose();
  });

  it('reports a transient failure quietly and does not retry unchanged text automatically', async () => {
    const h = harness();
    h.type();
    backend.invoke.mockRejectedValue(new Error('AI is busy.'));
    const request = h.request();
    await vi.advanceTimersByTimeAsync(900);
    expect((await request)?.items).toEqual([]);
    expect(h.onStatusChange).toHaveBeenCalledWith({ state: 'error', message: 'AI is busy.' });
    expect((await h.request())?.items).toEqual([]);
    expect(backend.invoke).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });
});
