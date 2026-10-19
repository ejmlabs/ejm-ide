import { describe, expect, it } from 'vitest';
import type { HarnessSpan } from './harness';
import {
  groupHarnessTraces,
  spanSelfTime,
  traceMatches,
  traceRowNavigation,
  traceRows,
  traceSpanEvent,
} from './harness-traces';

function span(id: number, overrides: Partial<HarnessSpan> = {}): HarnessSpan {
  return {
    id,
    traceId: 'a'.repeat(32),
    parentId: null,
    connectionId: 1,
    kind: 'turn',
    name: `span ${id}`,
    startedAt: 1000,
    endedAt: 2000,
    durationMs: 1000,
    status: 'completed',
    code: null,
    detailVersion: 1,
    hasContent: false,
    ...overrides,
  };
}

const root = span(1);
const child = span(2, {
  parentId: 1,
  name: 'model/complete',
  kind: 'request',
  startedAt: 1100,
  durationMs: 700,
});
const tool = span(3, {
  parentId: 2,
  name: 'read_file',
  kind: 'tool',
  startedAt: 1850,
  durationMs: 100,
});

describe('trace identity and hierarchy', () => {
  it('groups only explicit trace IDs, sorts newest first, and preserves causal links outside parent intervals', () => {
    const unrelated = span(4, { traceId: 'b'.repeat(32), startedAt: 1100 });
    const input = [tool, unrelated, child, root];
    const traces = groupHarnessTraces(input);
    expect(traces.map((trace) => trace.id)).toEqual(['b'.repeat(32), 'a'.repeat(32)]);
    expect(traces[1].spans.map((entry) => entry.id)).toEqual([1, 2, 3]);
    expect(traceRows(traces[1], new Set()).map((row) => [row.span.id, row.depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    expect(input).toEqual([tool, unrelated, child, root]);
  });

  it('marks missing parents and retains descendants whose ancestors were evicted', () => {
    const trace = groupHarnessTraces([child, tool])[0];
    expect(trace.missingParents).toBe(1);
    const rows = traceRows(trace, new Set());
    expect(rows.map((row) => [row.span.id, row.depth, row.missingParent])).toEqual([
      [2, 0, true],
      [3, 1, false],
    ]);
  });

  it('does not let malformed cycles or self references hide content or recurse forever', () => {
    const cyclic = groupHarnessTraces([
      span(1, { parentId: 2 }),
      span(2, { parentId: 1 }),
      span(3, { parentId: 3 }),
    ])[0];
    const rows = traceRows(cyclic, new Set());
    expect(new Set(rows.map((row) => row.span.id))).toEqual(new Set([1, 2, 3]));
    expect(rows).toHaveLength(3);
  });

  it('computes elapsed trace time from span measurements, including running spans', () => {
    const running = span(2, {
      parentId: 1,
      startedAt: 1900,
      endedAt: null,
      durationMs: 500,
      status: 'running',
    });
    const trace = groupHarnessTraces([root, running])[0];
    expect(trace.durationMs).toBe(1400);
    expect(trace.status).toBe('running');
    expect(groupHarnessTraces([root, { ...child, status: 'failed' }])[0].status).toBe('failed');
    expect(groupHarnessTraces([root, { ...child, status: 'cancelled' }])[0].status).toBe(
      'cancelled',
    );
  });
});

describe('retained descendant self time', () => {
  it('unions overlapping descendants without counting nested intervals twice', () => {
    expect(
      spanSelfTime(root, [
        root,
        span(2, { parentId: 1, startedAt: 1100, durationMs: 600 }),
        span(3, { parentId: 1, startedAt: 1400, durationMs: 400 }),
        span(4, { parentId: 2, startedAt: 1200, durationMs: 100 }),
      ]),
    ).toBe(300);
  });

  it('intersects child intervals with the parent and ignores later causal children', () => {
    expect(
      spanSelfTime(root, [
        span(2, { parentId: 1, startedAt: 900, durationMs: 300 }),
        span(3, { parentId: 1, startedAt: 1900, durationMs: 900 }),
        span(4, { parentId: 1, startedAt: 2100, durationMs: 100 }),
        span(5, { parentId: 1, traceId: 'b'.repeat(32), durationMs: 1000 }),
      ]),
    ).toBe(700);
    expect(spanSelfTime(child, [tool])).toBe(700);
  });

  it('excludes causal tool work from a containing turn after its producing model request ended', () => {
    const firstModel = span(2, { parentId: 1, startedAt: 1000, durationMs: 600 });
    const causalTool = span(3, { parentId: 2, startedAt: 1600, durationMs: 300 });
    const nextModel = span(4, { parentId: 1, startedAt: 1900, durationMs: 100 });
    const spans = [root, firstModel, causalTool, nextModel];
    expect(spanSelfTime(root, spans)).toBe(0);
    expect(spanSelfTime(firstModel, spans)).toBe(600);
  });

  it('bounds descendant traversal when malformed links contain a cycle', () => {
    const cyclicRoot = { ...root, parentId: 3 };
    expect(
      spanSelfTime(cyclicRoot, [
        cyclicRoot,
        span(2, { parentId: 1, startedAt: 1100, durationMs: 200 }),
        span(3, { parentId: 2, startedAt: 1400, durationMs: 200 }),
      ]),
    ).toBe(600);
  });

  it('handles disjoint, zero-length, and live intervals without negative self time', () => {
    expect(
      spanSelfTime(root, [
        span(2, { parentId: 1, startedAt: 1100, durationMs: 100 }),
        span(3, { parentId: 1, startedAt: 1300, durationMs: 200 }),
        span(4, { parentId: 1, startedAt: 1100, durationMs: 0 }),
      ]),
    ).toBe(700);
    expect(
      spanSelfTime({ ...root, endedAt: null, status: 'running' }, [
        span(2, { parentId: 1, durationMs: 2000 }),
      ]),
    ).toBe(0);
    expect(spanSelfTime({ ...root, durationMs: 0 }, [child])).toBe(0);
  });
});

describe('trace filtering and keyboard navigation', () => {
  const trace = groupHarnessTraces([
    root,
    child,
    tool,
    span(4, {
      parentId: 1,
      name: 'save rust',
      kind: 'operation',
      startedAt: 1900,
      status: 'failed',
      code: 'lint_error',
    }),
  ])[0];
  it('hides collapsed branches, but includes matching descendants and their ancestors when filtering', () => {
    expect(traceRows(trace, new Set([2])).map((row) => row.span.id)).toEqual([1, 2, 4]);
    expect(
      traceRows(trace, new Set([1, 2]), 'READ file').map((row) => [row.span.id, row.contextOnly]),
    ).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
    expect(traceRows(trace, new Set(), '', true).map((row) => row.span.id)).toEqual([1, 4]);
    expect(traceMatches(trace, 'RUST lint_error', true)).toBe(true);
    expect(traceMatches(trace, 'read', true)).toBe(false);
  });

  it('supports tree navigation, expansion, collapse, and stable boundaries', () => {
    const expanded = traceRows(trace, new Set());
    expect(traceRowNavigation(expanded, 1, 'ArrowRight', new Set())).toEqual({ focus: 2 });
    expect(traceRowNavigation(expanded, 2, 'ArrowLeft', new Set())).toEqual({
      focus: 2,
      collapse: true,
    });
    expect(traceRowNavigation(expanded, 3, 'ArrowLeft', new Set())).toEqual({ focus: 2 });
    expect(traceRowNavigation(expanded, 1, 'ArrowUp', new Set())).toEqual({ focus: 1 });
    expect(traceRowNavigation(expanded, 4, 'ArrowDown', new Set())).toEqual({ focus: 4 });
    expect(traceRowNavigation(expanded, 2, 'Home', new Set())).toEqual({ focus: 1 });
    expect(traceRowNavigation(expanded, 2, 'End', new Set())).toEqual({ focus: 4 });
    expect(traceRowNavigation(expanded, 2, 'Escape', new Set())).toBeNull();
    const collapsed = traceRows(trace, new Set([2]));
    expect(traceRowNavigation(collapsed, 2, 'ArrowRight', new Set([2]))).toEqual({
      focus: 2,
      collapse: false,
    });
  });

  it('uses span identity for lazy payload lookup without requiring a retained event', () => {
    expect(
      traceSpanEvent({
        ...tool,
        status: 'running',
        endedAt: null,
        detailVersion: 5,
        hasContent: true,
      }),
    ).toMatchObject({
      id: 3,
      activityId: 3,
      phase: 'started',
      name: 'read_file',
      detailVersion: 5,
      hasContent: true,
    });
  });
});
