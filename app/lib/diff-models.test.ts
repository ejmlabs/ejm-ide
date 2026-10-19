import { describe, expect, it, vi } from 'vitest';
import { releaseDiffModelsAfterDispose } from './diff-models';

function fixture() {
  const order: string[] = [];
  const live: { getModel: () => ReturnType<typeof trackedModel> | null }[] = [];
  function trackedModel(name: string) {
    let disposed = false;
    const text = {
      isDisposed: () => disposed,
      dispose: vi.fn(() => {
        if (live.some((editor) => editor.getModel() === text))
          throw new Error('Model still attached');
        order.push(name);
        disposed = true;
      }),
    };
    return text;
  }
  const original = trackedModel('original model');
  const modified = trackedModel('modified model');
  const models = { original, modified };
  function mount(name: string) {
    const listeners: (() => void)[] = [];
    const holders = [{ getModel: () => original }, { getModel: () => modified }];
    live.push(...holders);
    const editor = {
      getModel: () => models,
      getOriginalEditor: () => ({
        onDidDispose(listener: () => void) {
          listeners.push(listener);
          return {
            dispose() {
              const index = listeners.indexOf(listener);
              if (index >= 0) listeners.splice(index, 1);
            },
          };
        },
      }),
    };
    releaseDiffModelsAfterDispose(editor, () => live);
    return () => {
      order.push(`${name} widget disposing`);
      for (const holder of holders) live.splice(live.indexOf(holder), 1);
      for (const listener of listeners) listener();
      order.push(`${name} widget disposed`);
    };
  }
  return { order, original, modified, mount };
}

describe('diff model ownership', () => {
  it('releases both models only after the diff widget finishes disposing', async () => {
    const current = fixture();
    current.mount('diff')();
    expect(current.original.dispose).not.toHaveBeenCalled();
    expect(current.modified.dispose).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(current.order).toEqual([
      'diff widget disposing',
      'diff widget disposed',
      'original model',
      'modified model',
    ]);
    expect(current.original.dispose).toHaveBeenCalledOnce();
    expect(current.modified.dispose).toHaveBeenCalledOnce();
  });

  it('keeps shared models alive until the final split pane closes', async () => {
    const current = fixture();
    const closeFirst = current.mount('first');
    const closeSecond = current.mount('second');
    closeFirst();
    await Promise.resolve();
    expect(current.original.dispose).not.toHaveBeenCalled();
    expect(current.modified.dispose).not.toHaveBeenCalled();
    closeSecond();
    await Promise.resolve();
    expect(current.original.dispose).toHaveBeenCalledOnce();
    expect(current.modified.dispose).toHaveBeenCalledOnce();
  });

  it('protects models reused by an immediate remount before queued cleanup runs', async () => {
    const current = fixture();
    current.mount('before')();
    const closeRemount = current.mount('after');
    await Promise.resolve();
    expect(current.original.dispose).not.toHaveBeenCalled();
    closeRemount();
    await Promise.resolve();
    expect(current.original.dispose).toHaveBeenCalledOnce();
    expect(current.modified.dispose).toHaveBeenCalledOnce();
  });

  it('does not release either model twice when multiple owners close in the same turn', async () => {
    const current = fixture();
    const closeFirst = current.mount('first');
    const closeSecond = current.mount('second');
    closeFirst();
    closeSecond();
    await Promise.resolve();
    expect(current.original.dispose).toHaveBeenCalledOnce();
    expect(current.modified.dispose).toHaveBeenCalledOnce();
  });

  it('does not register a release callback before a model pair exists', () => {
    const onDidDispose = vi.fn();
    const getEditors = vi.fn(() => []);
    releaseDiffModelsAfterDispose(
      { getModel: () => null, getOriginalEditor: () => ({ onDidDispose }) },
      getEditors,
    );
    expect(onDidDispose).not.toHaveBeenCalled();
    expect(getEditors).not.toHaveBeenCalled();
  });
});
