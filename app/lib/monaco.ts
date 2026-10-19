import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/features/register.all';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/languages/features/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import 'monaco-editor/languages/definitions/rust/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/ruby/register';
import 'monaco-editor/languages/definitions/go/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/ini/register';
import 'monaco-editor/languages/definitions/yaml/register';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/scss/register';
import 'monaco-editor/languages/definitions/less/register';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/shell/register';
import 'monaco-editor/languages/definitions/xml/register';
import 'monaco-editor/languages/definitions/dockerfile/register';
import 'monaco-editor/languages/definitions/graphql/register';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register';
import 'monaco-editor/languages/features/html/register';
import 'monaco-editor/languages/features/css/register';
import { loader } from '@monaco-editor/react';
import type {
  CompletionList,
  DocumentSymbol,
  Hover,
  LocationLink,
  CompletionItem as LspCompletionItem,
  Location as LspLocation,
  MarkedString,
  MarkupContent,
  SemanticTokens,
  SemanticTokensLegend,
  ServerCapabilities,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
} from 'vscode-languageserver-protocol';
import { invoke } from './backend';
import { uriPath } from './context';
import {
  editorColors,
  editorColorsLight,
  editorTheme,
  editorThemeLight,
  monacoThemeNames,
} from './editor-theme';
import { syncLanguageDocument } from './language-sync';
import { resolvedTheme, subscribeTheme } from './theme';
import type { Location, SourceRange } from './types';
import { languageId } from './utils';

self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new JsonWorker();
    if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker();
    if (['css', 'scss', 'less'].includes(label)) return new CssWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });

// Monaco's bundled JSON service can scope its JSONC dialect through schema associations.
jsonDefaults.setDiagnosticsOptions({
  validate: true,
  allowComments: false,
  comments: 'error',
  trailingCommas: 'error',
  enableSchemaRequest: false,
  schemas: [
    {
      uri: 'workbench://schemas/jsonc',
      fileMatch: [
        '*.jsonc',
        '*.code-workspace',
        '*.code-snippets',
        '**/tsconfig.json',
        '**/tsconfig.*.json',
        '**/jsconfig.json',
        '**/jsconfig.*.json',
        '**/.vscode/settings.json',
        '**/.vscode/launch.json',
        '**/.vscode/tasks.json',
        '**/.vscode/extensions.json',
      ],
      schema: { allowComments: true, allowTrailingCommas: true },
    },
  ],
});
jsonDefaults.setModeConfiguration({ ...jsonDefaults.modeConfiguration, tokens: false });

let syntaxInitialization: Promise<void> | undefined;
export function initializeSyntaxHighlighting() {
  syntaxInitialization ??= Promise.all([import('./highlighting'), import('@shikijs/monaco')]).then(
    async ([syntax, { shikiToMonaco }]) => {
      const highlighter = await syntax.createSyntaxHighlighter();
      const registered = new Set(monaco.languages.getLanguages().map(({ id }) => id));
      for (const id of highlighter.getLoadedLanguages()) {
        if (!registered.has(id)) monaco.languages.register({ id });
      }
      shikiToMonaco(highlighter, monaco, { tokenizeTimeLimit: 100 });
    },
  );
  return syntaxInitialization;
}

// Monaco 0.57 renders menus in a shadow root outside the editor. These variables
// must inherit from the document, since its scoped theme CSS cannot cross it.
function applyEditorChrome() {
  const colors = resolvedTheme() === 'light' ? editorColorsLight : editorColors;
  for (const [name, value] of Object.entries(colors)) {
    document.documentElement.style.setProperty(`--vscode-${name.replaceAll('.', '-')}`, value);
  }
  monaco.editor.setTheme(monacoThemeNames[resolvedTheme()]);
}
applyEditorChrome();
subscribeTheme(applyEditorChrome);

monaco.editor.defineTheme(monacoThemeNames.dark, editorTheme);
monaco.editor.defineTheme(monacoThemeNames.light, editorThemeLight);
monaco.editor.setTheme(monacoThemeNames[resolvedTheme()]);

const configurations = new Map<string, ServerCapabilities>();
const completionRegistrations = new Map<
  string,
  {
    provider: monaco.languages.CompletionItemProvider;
    registration: monaco.IDisposable;
  }
>();
const semanticRegistrations = new Map<
  string,
  {
    key: string;
    changed: monaco.Emitter<void>;
    registration: monaco.IDisposable;
  }
>();

function modelCapabilities(model: monaco.editor.ITextModel) {
  return configurations.get(uriPath(model.uri.toString()));
}

export function semanticTokenData(raw: unknown, legend: SemanticTokensLegend): Uint32Array | null {
  if (
    !Array.isArray(raw) ||
    raw.length % 5 !== 0 ||
    raw.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffffffff)
  )
    return null;
  for (let offset = 0; offset < raw.length; offset += 5) {
    if (raw[offset + 2] === 0 || raw[offset + 3] >= legend.tokenTypes.length) return null;
  }
  return new Uint32Array(raw);
}

export function configureLanguageModel(path: string, capabilities?: Record<string, unknown>) {
  if (capabilities) configurations.set(path, capabilities as ServerCapabilities);
  else configurations.delete(path);
  const language = languageId(path);
  const matching = [...configurations]
    .filter(([source]) => languageId(source) === language)
    .map(([, value]) => value);
  const completion = completionRegistrations.get(language);
  if (completion) {
    const triggers = [
      ...new Set(matching.flatMap((value) => value.completionProvider?.triggerCharacters ?? [])),
    ];
    if (JSON.stringify(completion.provider.triggerCharacters) !== JSON.stringify(triggers)) {
      completion.registration.dispose();
      completion.provider.triggerCharacters = triggers;
      completion.registration = monaco.languages.registerCompletionItemProvider(
        language,
        completion.provider,
      );
    }
  }
  const tokens = matching
    .map((value) => value.semanticTokensProvider)
    .find(
      (value) =>
        value &&
        (value.full || value.range) &&
        Array.isArray(value.legend?.tokenTypes) &&
        Array.isArray(value.legend?.tokenModifiers),
    );
  const key = tokens ? JSON.stringify([tokens.legend, tokens.full, tokens.range]) : '';
  const previous = semanticRegistrations.get(language);
  if (previous?.key === key) {
    previous.changed.fire();
    return;
  }
  previous?.registration.dispose();
  previous?.changed.dispose();
  semanticRegistrations.delete(language);
  if (!tokens) return;
  const legend = tokens.legend;
  const changed = new monaco.Emitter<void>();
  const provider: monaco.languages.DocumentSemanticTokensProvider = {
    onDidChange: changed.event,
    getLegend: () => legend,
    async provideDocumentSemanticTokens(model, _lastResultId, cancellation) {
      const currentTokens = modelCapabilities(model)?.semanticTokensProvider;
      if (
        !currentTokens ||
        cancellation.isCancellationRequested ||
        JSON.stringify(currentTokens.legend) !== JSON.stringify(legend)
      )
        return null;
      const version = model.getVersionId();
      try {
        const method = currentTokens.full
          ? 'textDocument/semanticTokens/full'
          : 'textDocument/semanticTokens/range';
        const result = await lspRequest<SemanticTokens | null>(
          model,
          method,
          currentTokens.full ? {} : { range: fromRange(model.getFullModelRange()) },
        );
        if (
          !result ||
          model.isDisposed() ||
          cancellation.isCancellationRequested ||
          model.getVersionId() !== version ||
          modelCapabilities(model)?.semanticTokensProvider !== currentTokens
        )
          return null;
        const data = semanticTokenData(result.data, legend);
        return data ? { data, resultId: result.resultId } : null;
      } catch {
        return null;
      }
    },
    releaseDocumentSemanticTokens() {},
  };
  semanticRegistrations.set(language, {
    key,
    changed,
    registration: monaco.languages.registerDocumentSemanticTokensProvider(language, provider),
  });
}

export function toRange(range: SourceRange): monaco.Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}
export function fromRange(range: monaco.IRange): SourceRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

export async function lspRequest<T = unknown>(
  model: monaco.editor.ITextModel,
  method: string,
  params: object = {},
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const path = uriPath(model.uri.toString());
  await abortable(syncLanguageDocument(path, model.getValue(), model.getVersionId()), signal);
  signal?.throwIfAborted();
  const requestId = signal ? crypto.randomUUID() : undefined;
  return abortable(
    invoke<T>('language_request', {
      path,
      method,
      params: method.startsWith('textDocument/')
        ? { textDocument: { uri: model.uri.toString() }, ...params }
        : params,
      ...(requestId ? { requestId } : {}),
    }),
    signal,
    () => {
      void invoke('language_cancel', { requestId }).catch(() => {});
    },
  );
}

function abortable<T>(task: Promise<T>, signal?: AbortSignal, cancel?: () => void): Promise<T> {
  if (!signal) return task;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cancel?.();
      reject(new DOMException('Language request cancelled.', 'AbortError'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(new DOMException('Language request cancelled.', 'AbortError'));
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function markdown(
  value: MarkupContent | MarkedString | MarkedString[] | undefined,
): monaco.IMarkdownString[] {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => ({
    value:
      typeof item === 'string'
        ? item
        : 'language' in item
          ? `\`\`\`${item.language}\n${item.value}\n\`\`\``
          : item.kind === 'plaintext'
            ? item.value.replace(/[\\`*_{}[\]()#+.!|>~-]/g, '\\$&')
            : item.value,
    isTrusted: false,
    supportHtml: false,
  }));
}
type NavigationResult = LspLocation | LspLocation[] | LocationLink[] | null;
function locations(raw: NavigationResult): monaco.languages.Location[] {
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).flatMap((item) => {
    const uri = 'targetUri' in item ? item.targetUri : item.uri;
    const range = 'targetSelectionRange' in item ? item.targetSelectionRange : item.range;
    return uri.startsWith('file://') ? [{ uri: monaco.Uri.parse(uri), range: toRange(range) }] : [];
  });
}

let registered = false;
const completionKinds = [
  monaco.languages.CompletionItemKind.Text,
  monaco.languages.CompletionItemKind.Method,
  monaco.languages.CompletionItemKind.Function,
  monaco.languages.CompletionItemKind.Constructor,
  monaco.languages.CompletionItemKind.Field,
  monaco.languages.CompletionItemKind.Variable,
  monaco.languages.CompletionItemKind.Class,
  monaco.languages.CompletionItemKind.Interface,
  monaco.languages.CompletionItemKind.Module,
  monaco.languages.CompletionItemKind.Property,
  monaco.languages.CompletionItemKind.Unit,
  monaco.languages.CompletionItemKind.Value,
  monaco.languages.CompletionItemKind.Enum,
  monaco.languages.CompletionItemKind.Keyword,
  monaco.languages.CompletionItemKind.Snippet,
  monaco.languages.CompletionItemKind.Color,
  monaco.languages.CompletionItemKind.File,
  monaco.languages.CompletionItemKind.Reference,
  monaco.languages.CompletionItemKind.Folder,
  monaco.languages.CompletionItemKind.EnumMember,
  monaco.languages.CompletionItemKind.Constant,
  monaco.languages.CompletionItemKind.Struct,
  monaco.languages.CompletionItemKind.Event,
  monaco.languages.CompletionItemKind.Operator,
  monaco.languages.CompletionItemKind.TypeParameter,
];
export function registerLanguageProviders() {
  if (registered) return;
  registered = true;
  for (const language of ['rust', 'python', 'typescript', 'javascript', 'ruby', 'go']) {
    monaco.languages.registerHoverProvider(language, {
      async provideHover(model, position, token) {
        try {
          const result = await lspRequest<Hover | null>(model, 'textDocument/hover', {
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          });
          if (!result || token.isCancellationRequested) return null;
          return {
            contents: markdown(result.contents),
            range: result.range ? toRange(result.range) : undefined,
          };
        } catch {
          return null;
        }
      },
    });
    const navigation =
      (method: 'textDocument/definition' | 'textDocument/implementation') =>
      async (model: monaco.editor.ITextModel, position: monaco.Position) => {
        try {
          return locations(
            await lspRequest<NavigationResult>(model, method, {
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            }),
          );
        } catch {
          return [];
        }
      };
    monaco.languages.registerDefinitionProvider(language, {
      provideDefinition: navigation('textDocument/definition'),
    });
    monaco.languages.registerImplementationProvider(language, {
      provideImplementation: navigation('textDocument/implementation'),
    });
    monaco.languages.registerReferenceProvider(language, {
      async provideReferences(model, position, context) {
        try {
          return locations(
            await lspRequest<LspLocation[] | null>(model, 'textDocument/references', {
              position: { line: position.lineNumber - 1, character: position.column - 1 },
              context,
            }),
          );
        } catch {
          return [];
        }
      },
    });
    const completionSources = new WeakMap<
      monaco.languages.CompletionItem,
      { model: monaco.editor.ITextModel; item: LspCompletionItem; version: number }
    >();
    const completionProvider: monaco.languages.CompletionItemProvider = {
      triggerCharacters: [],
      async provideCompletionItems(model, position, context, token) {
        if (!modelCapabilities(model)?.completionProvider || token.isCancellationRequested)
          return null;
        const version = model.getVersionId();
        try {
          const result = await lspRequest<LspCompletionItem[] | CompletionList | null>(
            model,
            'textDocument/completion',
            {
              position: { line: position.lineNumber - 1, character: position.column - 1 },
              context: {
                triggerKind: context.triggerKind + 1,
                triggerCharacter: context.triggerCharacter,
              },
            },
          );
          if (
            token.isCancellationRequested ||
            model.isDisposed() ||
            model.getVersionId() !== version
          )
            return null;
          const word = model.getWordUntilPosition(position);
          const defaults = Array.isArray(result) ? undefined : result?.itemDefaults;
          const items = Array.isArray(result) ? result : (result?.items ?? []);
          return {
            incomplete: Array.isArray(result) ? false : result?.isIncomplete,
            suggestions: items.map((raw) => {
              const item: LspCompletionItem = {
                ...raw,
                commitCharacters: raw.commitCharacters ?? defaults?.commitCharacters,
                insertTextFormat: raw.insertTextFormat ?? defaults?.insertTextFormat,
                insertTextMode: raw.insertTextMode ?? defaults?.insertTextMode,
                data: raw.data ?? defaults?.data,
              };
              const editRange = item.textEdit
                ? 'range' in item.textEdit
                  ? item.textEdit.range
                  : { insert: item.textEdit.insert, replace: item.textEdit.replace }
                : defaults?.editRange;
              const completion: monaco.languages.CompletionItem = {
                label: item.labelDetails ? { label: item.label, ...item.labelDetails } : item.label,
                kind:
                  completionKinds[(item.kind || 1) - 1] ?? monaco.languages.CompletionItemKind.Text,
                detail: item.detail,
                documentation: markdown(item.documentation)[0],
                sortText: item.sortText,
                filterText: item.filterText,
                insertText:
                  item.textEdit?.newText ?? item.textEditText ?? item.insertText ?? item.label,
                insertTextRules:
                  (item.insertTextFormat === 2
                    ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                    : 0) |
                  (item.insertTextMode === 1
                    ? monaco.languages.CompletionItemInsertTextRule.KeepWhitespace
                    : 0),
                range: editRange
                  ? 'insert' in editRange
                    ? { insert: toRange(editRange.insert), replace: toRange(editRange.replace) }
                    : toRange(editRange)
                  : {
                      startLineNumber: position.lineNumber,
                      endLineNumber: position.lineNumber,
                      startColumn: word.startColumn,
                      endColumn: word.endColumn,
                    },
                additionalTextEdits: item.additionalTextEdits?.map((edit) => ({
                  range: toRange(edit.range),
                  text: edit.newText,
                })),
                commitCharacters: item.commitCharacters,
                preselect: item.preselect,
                tags:
                  item.deprecated || item.tags?.includes(1)
                    ? [monaco.languages.CompletionItemTag.Deprecated]
                    : undefined,
              };
              completionSources.set(completion, { model, item, version });
              return completion;
            }),
          };
        } catch {
          return { suggestions: [] };
        }
      },
      async resolveCompletionItem(completion, token) {
        const source = completionSources.get(completion);
        if (
          !source ||
          token.isCancellationRequested ||
          source.model.isDisposed() ||
          source.model.getVersionId() !== source.version ||
          !modelCapabilities(source.model)?.completionProvider?.resolveProvider
        )
          return completion;
        try {
          const result = await lspRequest<LspCompletionItem>(
            source.model,
            'completionItem/resolve',
            source.item,
          );
          if (
            !result ||
            token.isCancellationRequested ||
            source.model.isDisposed() ||
            source.model.getVersionId() !== source.version
          )
            return completion;
          return {
            ...completion,
            detail: result.detail ?? completion.detail,
            documentation: markdown(result.documentation)[0] ?? completion.documentation,
            additionalTextEdits:
              result.additionalTextEdits?.map((edit) => ({
                range: toRange(edit.range),
                text: edit.newText,
              })) ?? completion.additionalTextEdits,
          };
        } catch {
          return completion;
        }
      },
    };
    completionRegistrations.set(language, {
      provider: completionProvider,
      registration: monaco.languages.registerCompletionItemProvider(language, completionProvider),
    });
    monaco.languages.registerSignatureHelpProvider(language, {
      signatureHelpTriggerCharacters: ['(', ','],
      signatureHelpRetriggerCharacters: [','],
      async provideSignatureHelp(model, position) {
        try {
          const result = await lspRequest<SignatureHelp | null>(
            model,
            'textDocument/signatureHelp',
            { position: { line: position.lineNumber - 1, character: position.column - 1 } },
          );
          if (!result?.signatures?.length) return null;
          return {
            value: {
              activeSignature: result.activeSignature ?? 0,
              activeParameter: result.activeParameter ?? 0,
              signatures: result.signatures.map((signature) => ({
                label: signature.label,
                activeParameter: signature.activeParameter ?? undefined,
                documentation: markdown(signature.documentation)[0],
                parameters:
                  signature.parameters?.map((parameter) => ({
                    label: parameter.label,
                    documentation: markdown(parameter.documentation)[0],
                  })) ?? [],
              })),
            },
            dispose() {},
          };
        } catch {
          return null;
        }
      },
    });
    monaco.languages.registerDocumentSymbolProvider(language, {
      async provideDocumentSymbols(model) {
        const convert = (
          item: DocumentSymbol | SymbolInformation,
        ): monaco.languages.DocumentSymbol => {
          const range = 'range' in item ? item.range : item.location.range;
          return {
            name: item.name,
            detail: 'detail' in item ? (item.detail ?? '') : '',
            kind: Math.max(0, item.kind - 1),
            tags:
              item.deprecated || item.tags?.includes(1)
                ? [monaco.languages.SymbolTag.Deprecated]
                : [],
            range: toRange(range),
            selectionRange: toRange('selectionRange' in item ? item.selectionRange : range),
            children: 'children' in item ? item.children?.map(convert) : undefined,
          };
        };
        try {
          const items = await lspRequest<DocumentSymbol[] | SymbolInformation[] | null>(
            model,
            'textDocument/documentSymbol',
          );
          return items?.map(convert) ?? [];
        } catch {
          return [];
        }
      },
    });
    monaco.languages.registerDocumentFormattingEditProvider(language, {
      async provideDocumentFormattingEdits(model, options) {
        try {
          return (
            (
              await lspRequest<TextEdit[] | null>(model, 'textDocument/formatting', { options })
            )?.map((item) => ({ range: toRange(item.range), text: item.newText })) ?? []
          );
        } catch {
          return [];
        }
      },
    });
  }
}
export type { Location };
export { monaco };
