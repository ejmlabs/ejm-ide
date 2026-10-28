import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./backend', () => ({ invoke }));

import { closeLanguageDocument, openLanguageDocument, syncLanguageDocument } from './language-sync';

beforeEach(() => invoke.mockReset());
describe('language document startup', () => {
  it('finishes didClose before reopening a path with a fresh version', async () => {
    let finishChange!: () => void;
    let finishClose!: () => void;
    invoke.mockImplementation((command) => {
      if (command === 'language_change')
        return new Promise<void>((resolve) => {
          finishChange = resolve;
        });
      if (command === 'language_close')
        return new Promise<void>((resolve) => {
          finishClose = resolve;
        });
      return Promise.resolve({ language: 'rust', status: 'ready' });
    });
    await openLanguageDocument('/reopen.rs', 'saved', 1);
    const changed = syncLanguageDocument('/reopen.rs', 'discarded', 2);
    await vi.waitFor(() => expect(finishChange).toBeTypeOf('function'));
    const closed = closeLanguageDocument('/reopen.rs');
    const reopened = openLanguageDocument('/reopen.rs', 'saved', 1);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'language_open',
      'language_change',
    ]);
    finishChange();
    await vi.waitFor(() => expect(finishClose).toBeTypeOf('function'));
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'language_open',
      'language_change',
      'language_close',
    ]);
    finishClose();
    await Promise.all([changed, closed, reopened]);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'language_open',
      'language_change',
      'language_close',
      'language_open',
    ]);
    invoke.mockResolvedValue(undefined);
    await closeLanguageDocument('/reopen.rs');
  });
  it('does not replace a newer buffer with an earlier save snapshot', async () => {
    invoke.mockResolvedValue({ language: 'rust', status: 'ready' });
    await openLanguageDocument('/versions.rs', 'old', 1);
    await syncLanguageDocument('/versions.rs', 'new', 3);
    await syncLanguageDocument('/versions.rs', 'old saved snapshot', 2);
    expect(invoke.mock.calls.filter(([command]) => command === 'language_change')).toEqual([
      ['language_change', { path: '/versions.rs', content: 'new', version: 3 }],
    ]);
    await closeLanguageDocument('/versions.rs');
  });
  it('keeps a same-path restart behind earlier initialization even when another folder finishes first', async () => {
    const path = '/workspace-a/main.ts';
    const otherPath = '/workspace-b/main.ts';
    let rejectOld!: (error: Error) => void;
    let finishCurrent!: (value: unknown) => void;
    let starts = 0;
    invoke.mockImplementation((command, args) => {
      if (command !== 'language_open') return Promise.resolve();
      if (args.path === otherPath)
        return Promise.resolve({ language: 'typescript', status: 'ready' });
      return new Promise((resolve, reject) => {
        if (++starts === 1) rejectOld = reject;
        else finishCurrent = resolve;
      });
    });
    const old = openLanguageDocument(path, 'old workspace', 1);
    const failed = expect(old).rejects.toThrow('Old workspace closed.');
    const closed = closeLanguageDocument(path);
    await openLanguageDocument(otherPath, 'other folder', 1);
    const current = openLanguageDocument(path, 'returned workspace', 1);
    expect(invoke.mock.calls.filter(([command]) => command === 'language_open')).toEqual([
      ['language_open', { path, content: 'old workspace', version: 1 }],
      ['language_open', { path: otherPath, content: 'other folder', version: 1 }],
    ]);
    rejectOld(new Error('Old workspace closed.'));
    await failed;
    await closed;
    await vi.waitFor(() => expect(finishCurrent).toBeTypeOf('function'));
    expect(invoke.mock.calls.slice(-2)).toEqual([
      ['language_close', { path }],
      ['language_open', { path, content: 'returned workspace', version: 1 }],
    ]);
    finishCurrent({ language: 'typescript', status: 'ready' });
    await expect(current).resolves.toMatchObject({ status: 'ready' });
    await Promise.all([closeLanguageDocument(path), closeLanguageDocument(otherPath)]);
  });
  it('waits for the server and sends the latest edits typed during startup', async () => {
    let ready!: (value: unknown) => void;
    invoke.mockImplementation((command) =>
      command === 'language_open'
        ? new Promise((resolve) => {
            ready = resolve;
          })
        : Promise.resolve(),
    );
    const opened = openLanguageDocument('/startup.rs', 'old', 1);
    const first = syncLanguageDocument('/startup.rs', 'first edit', 2);
    const latest = syncLanguageDocument('/startup.rs', 'latest edit', 3);
    expect(invoke).toHaveBeenCalledTimes(1);
    ready({ language: 'rust', status: 'ready' });
    await Promise.all([opened, first, latest]);
    expect(invoke.mock.calls.filter(([command]) => command === 'language_change')).toEqual([
      ['language_change', { path: '/startup.rs', content: 'latest edit', version: 3 }],
    ]);
    await closeLanguageDocument('/startup.rs');
  });
  it('does not send queued edits after the document has closed', async () => {
    let ready!: (value: unknown) => void;
    invoke.mockImplementation((command) =>
      command === 'language_open'
        ? new Promise((resolve) => {
            ready = resolve;
          })
        : Promise.resolve(),
    );
    const opened = openLanguageDocument('/closed.py', 'old', 1);
    const changed = syncLanguageDocument('/closed.py', 'new', 2);
    const closed = closeLanguageDocument('/closed.py');
    ready({ language: 'python', status: 'ready' });
    await Promise.all([opened, changed, closed]);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'language_open',
      'language_close',
    ]);
  });
});
