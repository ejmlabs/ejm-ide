import { DiffEditor } from '@monaco-editor/react';
import { releaseDiffModelsAfterDispose } from '@/lib/diff-models';
import { monacoThemeNames } from '@/lib/editor-theme';
import { useTheme } from '@/lib/theme';
import { basename, languageId } from '@/lib/utils';

export function ApprovalDiff({
  path,
  before,
  after,
  label,
}: {
  path: string;
  before: string;
  after: string;
  label: string;
}) {
  const theme = useTheme();
  const identity = encodeURIComponent(`${label}:${path}`);
  return (
    <section className="approval-diff git-monaco-diff" aria-label={label}>
      <DiffEditor
        original={before}
        modified={after}
        originalModelPath={`workbench-proposal://before/${identity}/${basename(path || 'diff.txt')}`}
        modifiedModelPath={`workbench-proposal://after/${identity}/${basename(path || 'diff.txt')}`}
        language={languageId(path || 'diff.txt')}
        theme={monacoThemeNames[theme]}
        keepCurrentOriginalModel
        keepCurrentModifiedModel
        onMount={(instance, monacoApi) => {
          releaseDiffModelsAfterDispose(instance, monacoApi.editor.getEditors);
        }}
        options={{
          readOnly: true,
          originalEditable: false,
          renderSideBySide: true,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 12,
          lineHeight: 20,
          renderOverviewRuler: false,
          diffAlgorithm: 'advanced',
        }}
      />
    </section>
  );
}
