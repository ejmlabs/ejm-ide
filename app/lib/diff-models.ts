import type { monaco } from './monaco';

type DiffTextModel = Pick<monaco.editor.ITextModel, 'isDisposed' | 'dispose'>;
type ModelHolder = { getModel(): DiffTextModel | null };
type DiffModelOwner = {
  getModel(): { original: DiffTextModel; modified: DiffTextModel } | null;
  getOriginalEditor(): {
    onDidDispose(listener: () => void): monaco.IDisposable;
  };
};

// Monaco React disposes models before the diff widget unless its keepCurrent flags are set.
export function releaseDiffModelsAfterDispose(
  editor: DiffModelOwner,
  getEditors: () => readonly ModelHolder[],
) {
  const models = editor.getModel();
  if (!models) return;
  editor.getOriginalEditor().onDidDispose(() => {
    // Finish the whole widget's synchronous disposal before releasing its models.
    queueMicrotask(() => {
      for (const model of new Set([models.original, models.modified])) {
        if (model.isDisposed() || getEditors().some((live) => live.getModel() === model)) continue;
        model.dispose();
      }
    });
  });
}
