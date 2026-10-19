import { describe, expect, it, vi } from 'vitest';
import { parseIdeRequest, requestIsCurrent, waitForIdePresentation } from './agent-ide';

const request = {
  requestId: { connection: 1, id: 'call-1' },
  workspaceRoot: '/workspace',
  threadId: 'thread-1',
  turnId: 'turn-1',
  action: {
    type: 'highlightCode',
    id: 'focus',
    path: '/workspace/main.ts',
    version: 'sha256',
    range: { start: { line: 3, character: 1 }, end: { line: 4, character: 0 } },
  },
};
describe('agent IDE requests', () => {
  it('binds a validated request to its workspace and active turn', () => {
    const parsed = parseIdeRequest(request);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(requestIsCurrent(parsed, '/workspace', { threadId: 'thread-1', turnId: 'turn-1' })).toBe(
      true,
    );
    expect(requestIsCurrent(parsed, '/other', { threadId: 'thread-1', turnId: 'turn-1' })).toBe(
      false,
    );
    expect(requestIsCurrent(parsed, '/workspace', { threadId: 'thread-1', turnId: 'turn-2' })).toBe(
      false,
    );
    expect(requestIsCurrent(parsed, '/workspace', null)).toBe(false);
  });
  it('rejects reversed source ranges and arbitrary overlay selectors', () => {
    expect(
      parseIdeRequest({
        ...request,
        action: {
          ...request.action,
          range: { start: { line: 4, character: 2 }, end: { line: 3, character: 0 } },
        },
      }),
    ).toBeNull();
    expect(
      parseIdeRequest({
        ...request,
        action: { type: 'showHint', id: 'hint', target: 'button:nth-child(3)', text: 'Click this' },
      }),
    ).toBeNull();
  });
  it('rejects executable blocks before handing them to the renderer', () => {
    expect(
      parseIdeRequest({
        ...request,
        action: {
          type: 'showUi',
          id: 'ui',
          title: 'Result',
          blocks: [{ type: 'html', text: '<script>alert(1)</script>' }],
        },
      }),
    ).toBeNull();
  });
  it('accepts the native clear limit and rejects larger requests', () => {
    const clear = (count: number) => ({
      ...request,
      action: { type: 'clearPresentation', ids: Array.from({ length: count }, (_, i) => `id${i}`) },
    });
    expect(parseIdeRequest(clear(64))).not.toBeNull();
    expect(parseIdeRequest(clear(65))).toBeNull();
  });
  it('waits for the editor to apply a request and rejects expired turns', async () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      let applied = false;
      const waiting = waitForIdePresentation(
        () => true,
        () => {
          applied = ready;
          return applied;
        },
      );
      expect(applied).toBe(false);
      ready = true;
      await vi.advanceTimersByTimeAsync(16);
      await waiting;
      expect(applied).toBe(true);
      await expect(
        waitForIdePresentation(
          () => false,
          () => true,
        ),
      ).rejects.toThrow('no longer current');
    } finally {
      vi.useRealTimers();
    }
  });
});
