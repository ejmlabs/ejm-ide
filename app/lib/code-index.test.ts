import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from './backend';
import {
  createIndexCallGraph,
  type IndexNode,
  type IndexTraversalPage,
  indexHierarchy,
  indexReference,
  loadIndexHierarchy,
  symbolKey,
} from './code-index';

vi.mock('./backend', () => ({ invoke: vi.fn() }));

const range = { start: { line: 1, character: 0 }, end: { line: 3, character: 0 } };
const node = (id: string): IndexNode => ({
  id,
  name: id,
  qualifiedName: `Billing.${id}`,
  kind: 'method',
  path: '/code/billing.rb',
  uri: `file:///code/${id}.rb`,
  range,
  selectionRange: range,
  version: `hash-${id}`,
});

describe('indexed context', () => {
  it('keeps inferred and ambiguous edges distinct from verified calls', () => {
    const graph = indexHierarchy('total', {
      nodes: [node('settle'), node('total'), node('round')],
      edges: [
        {
          id: 'one',
          from: 'settle',
          to: 'total',
          kind: 'call',
          evidence: 'ambiguous',
          ranges: [range],
          sourceVersion: 'hash-settle',
          targetVersion: 'hash-total',
        },
        {
          id: 'two',
          from: 'total',
          to: 'round',
          kind: 'call',
          evidence: 'verified',
          ranges: [range],
          sourceVersion: 'hash-total',
          targetVersion: 'hash-round',
        },
        {
          id: 'missing',
          from: 'not-returned',
          to: 'total',
          kind: 'call',
          evidence: 'inferred',
          ranges: [range],
          sourceVersion: 'unknown',
          targetVersion: 'hash-total',
        },
      ],
    });
    expect(graph?.incoming).toHaveLength(1);
    expect(graph?.incoming[0].evidence).toBe('ambiguous');
    expect(graph?.outgoing[0].evidence).toBe('verified');
    expect(graph?.nodes).toHaveLength(3);
    expect(graph?.relations).toHaveLength(2);
    expect(graph?.root.version).toBe('hash-total');
    expect(graph?.root.data).toEqual({ indexId: 'total' });
  });
  it('shares the indexed snippet and version without recapturing changed source', () => {
    const reference = indexReference({
      id: 'hit',
      kind: 'symbol',
      path: '/code/total.rb',
      uri: 'file:///code/total.rb',
      range,
      name: 'total',
      content: 'def total\n  1\nend',
      version: 'captured-hash',
      score: 0.1,
      reasons: ['exact symbol'],
    });
    expect(reference.content).toBe('def total\n  1\nend');
    expect(reference.version).toBe('captured-hash');
    expect(reference.ranges).toEqual([range]);
    expect(reference.origin).toBe('Code index');
  });
});

const edge = (from: string, to: string) => ({
  id: `${from}-${to}`,
  from,
  to,
  kind: 'call' as const,
  evidence: 'verified' as const,
  ranges: [range],
  sourceVersion: `hash-${from}`,
  targetVersion: `hash-${to}`,
});
const page = (value: Partial<IndexTraversalPage>): IndexTraversalPage => ({
  nodes: [],
  edges: [],
  generation: 1,
  nextCursor: null,
  traversalComplete: true,
  indexLimited: false,
  stale: false,
  skippedStale: 0,
  ...value,
});

describe('progressive indexed graph exploration', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('requests direct neighbors, stops after two hops, and expands only the chosen direction', async () => {
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const { symbolId, direction } = args as { symbolId: string; direction: string };
      const links =
        direction === 'incoming'
          ? symbolId === 'root'
            ? [edge('parent', 'root')]
            : []
          : symbolId === 'root'
            ? [edge('root', 'child')]
            : symbolId === 'child'
              ? [edge('child', 'deep')]
              : symbolId === 'deep'
                ? [edge('deep', 'leaf')]
                : [];
      const ids = new Set([symbolId, ...links.flatMap((link) => [link.from, link.to])]);
      return page({ nodes: [...ids].map(node), edges: links });
    });
    const session = createIndexCallGraph(node('root'));
    const signal = new AbortController().signal;
    const initial = await session.load(signal, () => {});
    expect(initial.nodes).toHaveLength(4);
    expect(initial.traversal?.state).toBe('ready');
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(invoke).toHaveBeenCalledWith('index_traverse', {
      symbolId: 'root',
      direction: 'outgoing',
      direct: true,
      limit: 20,
    });
    const frontier = initial.traversal?.frontier?.find((item) => item.direction === 'outgoing');
    if (!frontier) throw new Error('Missing indexed frontier.');
    const next = await session.expand(frontier.symbol, frontier.direction, signal, () => {});
    expect(next.nodes).toHaveLength(5);
    expect(next.relations).toHaveLength(4);
    expect(next.nodes?.find((item) => item.name === 'Billing.leaf')?.version).toBe('hash-leaf');
    expect(next.traversal?.state).toBe('complete');
    expect(invoke).toHaveBeenCalledTimes(6);
  });

  it('keeps wide indexed pages at their node until the user asks for the next batch', async () => {
    const leaves = Array.from({ length: 45 }, (_, index) => `leaf${index}`);
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const { symbolId, direction, cursor } = args as {
        symbolId: string;
        direction: string;
        cursor?: string;
      };
      if (symbolId !== 'root' || direction !== 'outgoing') return page({ nodes: [node(symbolId)] });
      const offset = Number(cursor || 0);
      const batch = leaves.slice(offset, offset + 20);
      return page({
        nodes: [node('root'), ...batch.map(node)],
        edges: batch.map((id) => edge('root', id)),
        nextCursor: offset + 20 < leaves.length ? `${offset + 20}` : null,
        traversalComplete: offset + 20 >= leaves.length,
      });
    });
    const session = createIndexCallGraph(node('root'));
    const signal = new AbortController().signal;
    const first = await session.load(signal, () => {});
    expect(first.outgoing).toHaveLength(20);
    expect(invoke).not.toHaveBeenCalledWith(
      'index_traverse',
      expect.objectContaining({ cursor: '20' }),
    );
    const second = await session.expand(first.root, 'outgoing', signal, () => {});
    expect(second.outgoing).toHaveLength(40);
    const last = await session.expand(first.root, 'outgoing', signal, () => {});
    expect(last.outgoing).toHaveLength(45);
    expect(invoke).toHaveBeenCalledWith('index_traverse', {
      symbolId: 'root',
      direction: 'outgoing',
      direct: true,
      limit: 20,
      cursor: '40',
    });
  });

  it('keeps the preview and reports a stale expansion as a boundary', async () => {
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const { symbolId, direction } = args as { symbolId: string; direction: string };
      const target = symbolId === 'root' ? 'child' : 'deep';
      return page({
        nodes: [node(symbolId), node(target)],
        edges: direction === 'outgoing' ? [edge(symbolId, target)] : [],
      });
    });
    const session = createIndexCallGraph(node('root'));
    const signal = new AbortController().signal;
    const first = await session.load(signal, () => {});
    vi.mocked(invoke).mockResolvedValue(page({ generation: 2, nodes: [node('deep')] }));
    const frontier = first.traversal?.frontier?.[0];
    if (!frontier) throw new Error('Missing indexed frontier.');
    const next = await session.expand(frontier.symbol, frontier.direction, signal, () => {});
    expect(next.relations).toEqual(first.relations);
    expect(next.traversal?.state).toBe('partial');
    expect(next.traversal?.boundaries[0].reason).toContain('index changed');
  });
});

describe('full indexed graph traversal', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('keeps deep branches, shared callees, and cycles across pages', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(
        page({
          nodes: [node('root'), node('left'), node('right')],
          edges: [edge('root', 'left'), edge('root', 'right')],
          nextCursor: 'next-page',
          traversalComplete: false,
        }),
      )
      .mockResolvedValueOnce(
        page({
          nodes: [node('root'), node('left'), node('right'), node('shared'), node('deep')],
          edges: [
            edge('root', 'left'),
            edge('left', 'shared'),
            edge('right', 'shared'),
            edge('shared', 'deep'),
            edge('deep', 'root'),
          ],
        }),
      );
    const progress = vi.fn();
    const hierarchy = await loadIndexHierarchy('root', progress);
    expect(hierarchy?.nodes).toHaveLength(5);
    expect(hierarchy?.relations).toHaveLength(6);
    expect(hierarchy?.incoming).toHaveLength(1);
    expect(hierarchy?.outgoing).toHaveLength(2);
    expect(progress.mock.calls[0][0].nodes).toHaveLength(3);
    expect(progress.mock.calls[0][0].traversal.state).toBe('loading');
    expect(hierarchy?.traversal?.state).toBe('complete');
    expect(invoke).toHaveBeenNthCalledWith(1, 'index_traverse', {
      symbolId: 'root',
      direction: 'both',
      limit: 250,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'index_traverse', {
      symbolId: 'root',
      direction: 'both',
      limit: 250,
      cursor: 'next-page',
    });
  });

  it('reports stale and limited source coverage as partial', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(
      page({ nodes: [node('root')], indexLimited: true, stale: true, skippedStale: 2 }),
    );
    const hierarchy = await loadIndexHierarchy('root');
    expect(hierarchy?.traversal?.state).toBe('partial');
    expect(hierarchy?.traversal?.reasons).toEqual([
      'Workspace indexing reached a size or time limit.',
      'Some saved source changed. Refresh the code index.',
      '2 changed links were skipped.',
    ]);
  });

  it('never combines pages from different index generations', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(
        page({ nodes: [node('root')], nextCursor: 'next', traversalComplete: false }),
      )
      .mockResolvedValueOnce(page({ generation: 2, nodes: [node('different')] }));
    const progress = vi.fn();
    await expect(loadIndexHierarchy('root', progress)).rejects.toThrow('code index changed');
    expect(progress).toHaveBeenCalledTimes(1);
  });

  it('does not publish a page or request the next one after cancellation', async () => {
    let finish: ((value: IndexTraversalPage) => void) | undefined;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const progress = vi.fn();
    const task = loadIndexHierarchy('root', progress, controller.signal);
    controller.abort();
    finish?.(page({ nodes: [node('root')], nextCursor: 'next', traversalComplete: false }));
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects repeated cursors instead of looping forever', async () => {
    vi.mocked(invoke).mockResolvedValue(
      page({ nodes: [node('root')], nextCursor: 'repeated', traversalComplete: false }),
    );
    await expect(loadIndexHierarchy('root')).rejects.toThrow('repeated a graph page');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('distinguishes methods by source location instead of their display names', () => {
    const first = indexHierarchy('first', { nodes: [node('first')], edges: [] })?.root;
    if (!first) throw new Error('Missing test symbol.');
    const second = {
      ...first,
      name: first.name,
      selectionRange: { start: { line: 10, character: 0 }, end: { line: 10, character: 5 } },
    };
    expect(symbolKey(first)).not.toBe(symbolKey(second));
    expect(symbolKey(first)).toBe(symbolKey({ ...first, name: 'Renamed display' }));
    expect(symbolKey(first)).not.toMatch(/["\\[\]]/);
  });
});
