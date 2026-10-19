import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Document, Entry, Workspace } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('native and browser backend isolation', () => {
  it('reads the native document through the bridge', async () => {
    const document = { path: '/project/lib.rs', content: 'unsaved sample', version: 'native' };
    const bridge = vi.fn().mockResolvedValue(document);
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, __WORKBENCH_INVOKE__: bridge });
    const { invoke, isDesktop } = await import('./backend');
    expect(isDesktop).toBe(true);
    await expect(invoke('workspace_read', { path: document.path })).resolves.toEqual(document);
    expect(bridge).toHaveBeenCalledWith('workspace_read', { path: document.path });
  });

  it('reports an unavailable native bridge instead of opening a sample workspace', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const { invoke } = await import('./backend');
    await expect(invoke('workspace_current')).rejects.toThrow('native bridge is unavailable');
  });

  it('preserves native errors instead of returning preview content', async () => {
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: {},
      __WORKBENCH_INVOKE__: vi.fn().mockRejectedValue(new Error('Workspace unavailable')),
    });
    const { invoke } = await import('./backend');
    await expect(invoke('workspace_current')).rejects.toThrow('Workspace unavailable');
  });

  it('keeps browser sample files available for navigation, reading, and search', async () => {
    vi.stubGlobal('window', {});
    const { invoke, isDesktop, previewRoot } = await import('./backend');
    expect(isDesktop).toBe(false);
    const workspace = await invoke<Workspace>('workspace_current');
    expect(workspace.root).toBe(previewRoot);
    expect(workspace.entries.map((entry) => entry.name)).toEqual([
      'src',
      'tools',
      'web',
      'Cargo.toml',
      'README.md',
    ]);
    const entries = await invoke<Entry[]>('workspace_entries', { path: `${previewRoot}/src` });
    expect(entries.map((entry) => entry.name)).toEqual([
      'lib.rs',
      'money.rs',
      'orders.rs',
      'payments.rs',
    ]);
    const document = await invoke<Document>('workspace_read', {
      path: `${previewRoot}/src/payments.rs`,
    });
    expect(document.content).toContain('`order.key`');
    expect(document.content).toContain('pub fn charge');
    expect(document.version).toBe('preview');
    const results = await invoke<Array<{ path: string; text: string }>>('workspace_search', {
      query: 'def total_received',
    });
    expect(results).toEqual([
      {
        path: `${previewRoot}/tools/reconcile.py`,
        line: 11,
        text: 'def total_received(receipts: list[Receipt]) -> int:',
      },
    ]);
  });

  it('keeps browser preview read-only and rejects files outside the sample', async () => {
    vi.stubGlobal('window', {});
    const { invoke } = await import('./backend');
    await expect(invoke('workspace_create', { path: '/new.rs' })).rejects.toThrow('read-only');
    await expect(invoke('workspace_save', { path: '/new.rs' })).rejects.toThrow(
      'Open the desktop app',
    );
    await expect(invoke('workspace_read', { path: '/project/lib.rs' })).rejects.toThrow(
      'not in the browser preview',
    );
  });
});
