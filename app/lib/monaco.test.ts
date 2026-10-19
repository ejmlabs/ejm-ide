import type * as Monaco from 'monaco-editor/editor/editor.api';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { CompletionList, Range } from 'vscode-languageserver-protocol';
import {
  configureLanguageModel,
  lspRequest,
  registerLanguageProviders,
  semanticTokenData,
} from './monaco';

const harness = vi.hoisted(() => {
  vi.stubGlobal('self', {});
  vi.stubGlobal('document', {
    documentElement: { dataset: {}, style: { setProperty: vi.fn() } },
  });
  return {
    invoke: vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>(),
    sync: vi.fn<(path: string, content: string, version: number) => Promise<void>>(),
    completions: new Map<string, Monaco.languages.CompletionItemProvider>(),
    signatures: new Map<string, Monaco.languages.SignatureHelpProvider>(),
    semantics: new Map<string, Monaco.languages.DocumentSemanticTokensProvider>(),
  };
});
vi.mock('./backend', () => ({ invoke: harness.invoke }));
vi.mock('./language-sync', () => ({ syncLanguageDocument: harness.sync }));
vi.mock('@monaco-editor/react', () => ({ loader: { config: vi.fn() } }));
vi.mock('monaco-editor/features/register.all', () => ({}));
vi.mock('monaco-editor/editor/editor.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/languages/features/json/json.worker?worker', () => ({
  default: class {
    service = 'json';
  },
}));
vi.mock('monaco-editor/languages/features/html/html.worker?worker', () => ({
  default: class {
    service = 'html';
  },
}));
vi.mock('monaco-editor/languages/features/css/css.worker?worker', () => ({
  default: class {
    service = 'css';
  },
}));
vi.mock('monaco-editor/languages/definitions/rust/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/python/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/ruby/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/go/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/typescript/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/javascript/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/markdown/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/ini/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/yaml/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/html/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/css/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/scss/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/less/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/sql/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/shell/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/xml/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/dockerfile/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/graphql/register', () => ({}));
vi.mock('monaco-editor/languages/features/html/register', () => ({}));
vi.mock('monaco-editor/languages/features/css/register', () => ({}));
vi.mock('monaco-editor/languages/features/json/register', () => ({
  jsonDefaults: {
    modeConfiguration: {},
    setModeConfiguration: vi.fn(),
    setDiagnosticsOptions: vi.fn(),
  },
}));
vi.mock('monaco-editor/editor/editor.api', () => ({
  Emitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  Range: class {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number,
    ) {}
  },
  Uri: { parse: (uri: string) => ({ toString: () => uri }) },
  editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
  languages: {
    CompletionItemKind: { Text: 0, Method: 1, Function: 2 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4, KeepWhitespace: 1 },
    CompletionItemTag: { Deprecated: 1 },
    SymbolTag: { Deprecated: 1 },
    registerHoverProvider: vi.fn(),
    registerDefinitionProvider: vi.fn(),
    registerImplementationProvider: vi.fn(),
    registerReferenceProvider: vi.fn(),
    registerCompletionItemProvider: (
      language: string,
      provider: Monaco.languages.CompletionItemProvider,
    ) => {
      harness.completions.set(language, provider);
      return { dispose() {} };
    },
    registerSignatureHelpProvider: (
      language: string,
      provider: Monaco.languages.SignatureHelpProvider,
    ) => {
      harness.signatures.set(language, provider);
    },
    registerDocumentSymbolProvider: vi.fn(),
    registerDocumentFormattingEditProvider: vi.fn(),
    registerDocumentSemanticTokensProvider: (
      language: string,
      provider: Monaco.languages.DocumentSemanticTokensProvider,
    ) => {
      harness.semantics.set(language, provider);
      return {
        dispose() {
          harness.semantics.delete(language);
        },
      };
    },
  },
}));

const token: Monaco.CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
};
const position = { lineNumber: 1, column: 4 } as Monaco.Position;
const insert: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
const replace: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } };

function model() {
  let version = 1;
  return {
    value: {
      uri: { toString: () => 'file:///tmp/project/source.ts' },
      getValue: () => 'IteRest',
      getVersionId: () => version,
      getWordUntilPosition: () => ({ startColumn: 1, endColumn: 4, word: 'Ite' }),
      isDisposed: () => false,
    } as unknown as Monaco.editor.ITextModel,
    edit() {
      version++;
    },
  };
}

function completionProvider() {
  const provider = harness.completions.get('typescript');
  if (!provider) throw new Error('TypeScript completion provider was not registered.');
  return provider;
}

async function complete(source: Monaco.editor.ITextModel) {
  const result = await completionProvider().provideCompletionItems(
    source,
    position,
    { triggerKind: 0 },
    token,
  );
  if (!result) throw new Error('Expected completion suggestions.');
  return result;
}

beforeAll(registerLanguageProviders);
beforeEach(() => {
  harness.invoke.mockReset();
  harness.sync.mockReset().mockResolvedValue();
  configureLanguageModel('/tmp/project/source.ts', {
    completionProvider: { resolveProvider: true, triggerCharacters: ['.', '[', '@', '<'] },
  });
});
afterAll(() => vi.unstubAllGlobals());

it('cancels only its bound native request and ignores a late language-server response', async () => {
  const controller = new AbortController();
  let reply: ((value: unknown) => void) | undefined;
  harness.invoke.mockImplementation((command) => {
    if (command === 'language_cancel') return Promise.resolve();
    return new Promise((resolve) => {
      reply = resolve;
    });
  });
  const request = lspRequest(
    model().value,
    'textDocument/prepareCallHierarchy',
    {},
    controller.signal,
  );
  await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledOnce());
  const args = harness.invoke.mock.calls[0]?.[1];
  expect(args?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  controller.abort();
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  expect(harness.invoke).toHaveBeenLastCalledWith('language_cancel', {
    requestId: args?.requestId,
  });
  reply?.([{ name: 'stale result' }]);
  await Promise.resolve();
  expect(harness.invoke).toHaveBeenCalledTimes(2);
});

it('does not start language work if cancelled while the buffer is still syncing', async () => {
  const controller = new AbortController();
  let synced: (() => void) | undefined;
  harness.sync.mockImplementation(
    () =>
      new Promise((resolve) => {
        synced = resolve;
      }),
  );
  const request = lspRequest(
    model().value,
    'textDocument/prepareCallHierarchy',
    {},
    controller.signal,
  );
  controller.abort();
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  synced?.();
  await Promise.resolve();
  expect(harness.invoke).not.toHaveBeenCalled();
});

it('removes cancellation listeners when a request has already finished', async () => {
  const controller = new AbortController();
  harness.invoke.mockResolvedValueOnce([{ name: 'result' }]);
  await expect(
    lspRequest(model().value, 'textDocument/prepareCallHierarchy', {}, controller.signal),
  ).resolves.toEqual([{ name: 'result' }]);
  controller.abort();
  expect(harness.invoke).toHaveBeenCalledOnce();
});

it.each(['ruby', 'go'])(
  'connects %s completion providers to the language service',
  async (language) => {
    harness.invoke.mockResolvedValueOnce([
      { label: 'calculateTotal', insertText: 'calculateTotal' },
    ]);
    const provider = harness.completions.get(language);
    if (!provider) throw new Error(`${language} completion provider was not registered.`);
    const result = await provider.provideCompletionItems(
      model().value,
      position,
      { triggerKind: 0 },
      token,
    );
    expect(result?.suggestions[0].label).toBe('calculateTotal');
    expect(harness.invoke).toHaveBeenCalledWith(
      'language_request',
      expect.objectContaining({ method: 'textDocument/completion' }),
    );
    expect(harness.signatures.has(language)).toBe(true);
  },
);

it('keeps insert and replace ranges distinct and preserves defaults for completion resolve', async () => {
  const list: CompletionList = {
    isIncomplete: true,
    itemDefaults: {
      editRange: { insert, replace },
      insertTextFormat: 2,
      commitCharacters: ['('],
      data: { resolveKey: 'module:item' },
    },
    items: [{ label: 'Item', textEditText: 'Item($0)' }],
  };
  harness.invoke.mockResolvedValueOnce(list).mockResolvedValueOnce({
    label: 'Item',
    detail: 'Imported from module',
    additionalTextEdits: [{ range: insert, newText: 'import { Item } from "module";\n' }],
  });
  const source = model();
  const result = await complete(source.value);
  const item = result.suggestions[0];
  expect(result.incomplete).toBe(true);
  expect(item).toMatchObject({
    insertText: 'Item($0)',
    insertTextRules: 4,
    commitCharacters: ['('],
    range: { insert: { startColumn: 1, endColumn: 4 }, replace: { startColumn: 1, endColumn: 8 } },
  });
  const resolved = await completionProvider().resolveCompletionItem?.(item, token);
  expect(harness.invoke).toHaveBeenLastCalledWith(
    'language_request',
    expect.objectContaining({
      method: 'completionItem/resolve',
      params: expect.objectContaining({ data: { resolveKey: 'module:item' } }),
    }),
  );
  expect(harness.invoke.mock.calls[1][1].params).not.toHaveProperty('editRange');
  expect(resolved).toMatchObject({
    detail: 'Imported from module',
    additionalTextEdits: [{ text: 'import { Item } from "module";\n' }],
  });
});

it('lets each item override list edits and commit characters', async () => {
  harness.invoke.mockResolvedValueOnce({
    isIncomplete: false,
    itemDefaults: { editRange: replace, commitCharacters: ['('] },
    items: [
      { label: 'Item', commitCharacters: [], textEdit: { newText: 'actual', insert, replace } },
    ],
  } satisfies CompletionList);
  const result = await complete(model().value);
  expect(result.suggestions[0]).toMatchObject({
    insertText: 'actual',
    commitCharacters: [],
    range: { insert: { endColumn: 4 }, replace: { endColumn: 8 } },
  });
});

it('discards resolved auto-imports when the source version changes while resolving', async () => {
  let resolve!: (value: unknown) => void;
  harness.invoke.mockResolvedValueOnce([{ label: 'Item' }]).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const source = model();
  const item = (await complete(source.value)).suggestions[0];
  const pending = completionProvider().resolveCompletionItem?.(item, token);
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  source.edit();
  resolve({ label: 'Item', additionalTextEdits: [{ range: insert, newText: 'stale import' }] });
  expect(await pending).toBe(item);
});

it('converts nullable signature parameters and keeps server documentation untrusted', async () => {
  harness.invoke.mockResolvedValueOnce({
    signatures: [
      {
        label: 'call(value)',
        activeParameter: null,
        documentation: { kind: 'plaintext', value: '*literal*' },
      },
    ],
  });
  const provider = harness.signatures.get('typescript');
  if (!provider) throw new Error('TypeScript signature provider was not registered.');
  const result = await provider.provideSignatureHelp(model().value, position, token, {
    triggerKind: 1,
    isRetrigger: false,
  });
  expect(result?.value.signatures[0]).toMatchObject({
    activeParameter: undefined,
    documentation: { value: '\\*literal\\*', isTrusted: false, supportHtml: false },
  });
});

it('negotiates trigger characters and sends LSP completion request context', async () => {
  const provider = completionProvider();
  expect(provider.triggerCharacters).toEqual(['.', '[', '@', '<']);
  harness.invoke.mockResolvedValueOnce([{ label: 'Item' }]);
  await provider.provideCompletionItems(
    model().value,
    position,
    { triggerKind: 1, triggerCharacter: '[' },
    token,
  );
  expect(harness.invoke).toHaveBeenCalledWith(
    'language_request',
    expect.objectContaining({
      params: expect.objectContaining({ context: { triggerKind: 2, triggerCharacter: '[' } }),
    }),
  );
});

it('routes built-in language requests to the correct bundled workers', () => {
  const worker = self.MonacoEnvironment?.getWorker;
  expect(worker?.('workerMain.js', 'json')).toMatchObject({ service: 'json' });
  expect(worker?.('workerMain.js', 'html')).toMatchObject({ service: 'html' });
  for (const language of ['css', 'scss', 'less'])
    expect(worker?.('workerMain.js', language)).toMatchObject({ service: 'css' });
});

it('ignores completion lists that arrive after an edit or cancellation', async () => {
  const source = model();
  let reply!: (value: unknown) => void;
  harness.invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  const pending = completionProvider().provideCompletionItems(
    source.value,
    position,
    { triggerKind: 0 },
    token,
  );
  await vi.waitFor(() => expect(reply).toBeTypeOf('function'));
  source.edit();
  reply([{ label: 'stale' }]);
  expect(await pending).toBeNull();
  harness.invoke.mockClear();
  expect(
    await completionProvider().provideCompletionItems(
      source.value,
      position,
      { triggerKind: 0 },
      { ...token, isCancellationRequested: true },
    ),
  ).toBeNull();
  expect(harness.invoke).not.toHaveBeenCalled();
});

const semanticLegend = {
  tokenTypes: ['function', 'type', 'parameter', 'property'],
  tokenModifiers: ['declaration'],
};
function enableSemanticTokens() {
  configureLanguageModel('/tmp/project/source.ts', {
    semanticTokensProvider: { legend: semanticLegend, full: true },
  });
  const provider = harness.semantics.get('typescript');
  if (!provider) throw new Error('Semantic tokens were not registered.');
  return provider;
}

it('keeps the negotiated semantic legend and decodes full relative token tuples', async () => {
  const provider = enableSemanticTokens();
  const data = [0, 0, 3, 0, 1, 0, 4, 4, 2, 0];
  harness.invoke.mockResolvedValueOnce({ data, resultId: '1' });
  expect(provider.getLegend()).toEqual(semanticLegend);
  const result = await provider.provideDocumentSemanticTokens(model().value, null, token);
  expect(result).toEqual({ data: new Uint32Array(data), resultId: '1' });
  expect(harness.invoke).toHaveBeenCalledWith(
    'language_request',
    expect.objectContaining({ method: 'textDocument/semanticTokens/full' }),
  );
  expect(semanticTokenData([0, 0, 3, 4, 0], semanticLegend)).toBeNull();
  expect(semanticTokenData([0, 0, 3, 0], semanticLegend)).toBeNull();
  expect(semanticTokenData([0, -1, 3, 0, 0], semanticLegend)).toBeNull();
});

it('drops stale semantic responses and stops requests when the server becomes unavailable', async () => {
  const provider = enableSemanticTokens();
  const source = model();
  let reply!: (value: unknown) => void;
  harness.invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  const pending = provider.provideDocumentSemanticTokens(source.value, null, token);
  await vi.waitFor(() => expect(reply).toBeTypeOf('function'));
  source.edit();
  reply({ data: [0, 0, 3, 0, 0] });
  expect(await pending).toBeNull();
  harness.invoke.mockClear();
  configureLanguageModel('/tmp/project/source.ts');
  expect(await provider.provideDocumentSemanticTokens(source.value, null, token)).toBeNull();
  expect(harness.invoke).not.toHaveBeenCalled();
});

it('ignores a semantic response cancelled while the server was working', async () => {
  const provider = enableSemanticTokens();
  const cancellation = { ...token };
  harness.invoke.mockImplementation(async () => {
    cancellation.isCancellationRequested = true;
    return { data: [0, 0, 3, 0, 0] };
  });
  expect(
    await provider.provideDocumentSemanticTokens(model().value, null, cancellation),
  ).toBeNull();
});
