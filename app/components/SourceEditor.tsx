import Editor from '@monaco-editor/react';
import { LoaderCircle } from 'lucide-react';
import { useRef } from 'react';
import { monacoThemeNames } from '@/lib/editor-theme';
import { editorModelUri } from '@/lib/editor-workspace';
import type { monaco } from '@/lib/monaco';
import { useTheme } from '@/lib/theme';
import type { EditorDocument } from '@/lib/types';
import { basename } from '@/lib/utils';

export function SourceEditor({
  group,
  document,
  fontSize,
  inlineEnabled,
  onMount,
  onEdit,
}: {
  group: string;
  document: EditorDocument;
  fontSize: number;
  inlineEnabled: boolean;
  onMount: (group: string, editor: monaco.editor.IStandaloneCodeEditor) => void;
  onEdit: (path: string, value: string | undefined, model: monaco.editor.ITextModel | null) => void;
}) {
  const instance = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  return (
    <div className="monaco-host">
      <Editor
        path={editorModelUri(document.path)}
        value={document.content}
        language={document.language}
        theme={monacoThemeNames[useTheme()]}
        onMount={(editor) => {
          instance.current = editor;
          onMount(group, editor);
        }}
        onChange={(value) => onEdit(document.path, value, instance.current?.getModel() || null)}
        keepCurrentModel
        saveViewState={false}
        options={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize,
          lineHeight: Math.round(fontSize * 1.62),
          padding: { top: 10, bottom: 16 },
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          renderLineHighlight: 'line',
          renderWhitespace: 'selection',
          automaticLayout: true,
          tabSize: 4,
          bracketPairColorization: { enabled: false },
          'semanticHighlighting.enabled': true,
          guides: { indentation: true, bracketPairs: false },
          glyphMargin: true,
          folding: true,
          lineNumbersMinChars: 3,
          overviewRulerBorder: false,
          fixedOverflowWidgets: true,
          hover: { delay: 400, sticky: true },
          quickSuggestions: { other: 'on', comments: 'off', strings: 'off' },
          suggestOnTriggerCharacters: true,
          parameterHints: { enabled: true },
          acceptSuggestionOnEnter: 'smart',
          tabCompletion: 'on',
          inlineSuggest: {
            enabled: inlineEnabled,
            mode: 'subwordSmart',
            suppressSuggestions: false,
            showToolbar: 'onHover',
          },
          suggest: {
            showWords: false,
            localityBonus: true,
            insertMode: 'replace',
            snippetsPreventQuickSuggestions: false,
          },
          wordWrap: document.language === 'markdown' ? 'on' : 'off',
          contextmenu: true,
          ariaLabel: `${basename(document.path)} source editor`,
        }}
        loading={
          <div className="editor-loading">
            <LoaderCircle className="spin" size={20} />
            Opening editor…
          </div>
        }
      />
    </div>
  );
}
