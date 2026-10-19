import type { TextEdit } from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { invoke } from './backend';
import { fileUri } from './context';
import { syncLanguageDocument } from './language-sync';
import { formatMarkdown } from './markdown';
import type { DiagnosticEntry, EditorDocument } from './types';
import { hasBuiltInLanguageService, isJsonComments, languageId } from './utils';

type FormatResult = {
  content: string;
  tool: string | null;
  status: 'ok' | 'unavailable' | 'unsupported';
  message?: string;
};

export type LintResult = {
  path: string;
  version: string;
  tool: string | null;
  status: 'ok' | 'unavailable' | 'unsupported' | 'stale' | 'error';
  scope: 'file' | 'workspace';
  diagnostics: DiagnosticEntry[];
  message?: string;
};

export function lintForSavedBuffers(
  diagnostics: DiagnosticEntry[],
  documents: EditorDocument[],
): DiagnosticEntry[] {
  const dirty = new Set(
    documents.filter((doc) => doc.content !== doc.savedContent).map((doc) => fileUri(doc.path)),
  );
  return diagnostics.filter((item) => !dirty.has(item.uri));
}

export function applyTextEdits(content: string, edits: TextEdit[]): string {
  // TextDocument normalizes reversed ranges, so reject malformed formatter input first.
  for (const {
    range: { start, end },
  } of edits) {
    if (
      [start.line, start.character, end.line, end.character].some(
        (value) => !Number.isSafeInteger(value) || value < 0,
      ) ||
      end.line < start.line ||
      (end.line === start.line && end.character < start.character)
    )
      throw new Error('The formatter returned an invalid source range.');
  }
  const document = TextDocument.create('', 'plaintext', 0, content);
  // TextDocument 1.0.11 includes EOL in its column clamp; keep oversized columns on their line.
  function clamp({ line, character }: TextEdit['range']['start']) {
    if (line >= document.lineCount) return document.positionAt(content.length);
    const text = document.getText({
      start: { line, character: 0 },
      end: { line: line + 1, character: 0 },
    });
    return { line, character: Math.min(character, text.replace(/[\r\n]+$/, '').length) };
  }
  const bounded = edits.map((edit) => ({
    ...edit,
    range: { start: clamp(edit.range.start), end: clamp(edit.range.end) },
  }));
  try {
    return TextDocument.applyEdits(document, bounded);
  } catch (error) {
    if (error instanceof Error && error.message === 'Overlapping edit')
      throw new Error('The formatter returned overlapping source ranges.', { cause: error });
    throw error;
  }
}

export async function formatDocumentContent(
  path: string,
  content: string,
  version: number,
  options: { lsp: boolean; tabSize: number; insertSpaces: boolean },
): Promise<{ content: string; message?: string }> {
  const language = languageId(path);
  if (language === 'markdown') return { content: formatMarkdown(content) };
  if (hasBuiltInLanguageService(language)) {
    const document = TextDocument.create(fileUri(path), language, version, content);
    const range = { start: document.positionAt(0), end: document.positionAt(content.length) };
    const formatting = { tabSize: options.tabSize, insertSpaces: options.insertSpaces };
    let edits: TextEdit[];
    if (language === 'json') {
      const { getLanguageService } = await import('vscode-json-languageservice');
      const service = getLanguageService({});
      const allowed = isJsonComments(path) ? 'ignore' : 'error';
      const diagnostics = await service.doValidation(
        document,
        service.parseJSONDocument(document),
        {
          comments: allowed,
          trailingCommas: allowed,
          schemaValidation: 'ignore',
          schemaRequest: 'ignore',
        },
      );
      if (diagnostics.some((item) => item.severity === 1))
        return { content, message: 'Formatting was skipped because the JSON has syntax errors.' };
      edits = service.format(document, range, formatting);
    } else if (language === 'html') {
      const { getLanguageService } = await import('vscode-html-languageservice');
      edits = getLanguageService().format(document, range, formatting);
    } else {
      const services = await import('vscode-css-languageservice');
      const service =
        language === 'scss'
          ? services.getSCSSLanguageService()
          : language === 'less'
            ? services.getLESSLanguageService()
            : services.getCSSLanguageService();
      edits = service.format(document, range, formatting);
    }
    return { content: applyTextEdits(content, edits) };
  }
  const result = await invoke<FormatResult>('quality_format', { path, content });
  if (result.status === 'ok') return { content: result.content };
  if (!options.lsp) return { content, message: result.message };
  await syncLanguageDocument(path, content, version);
  const edits = await invoke<TextEdit[] | null>('language_request', {
    path,
    method: 'textDocument/formatting',
    params: {
      textDocument: { uri: fileUri(path) },
      options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
    },
  });
  return { content: applyTextEdits(content, edits || []) };
}
