import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CallGraphRequest,
  type CallGraphSession,
  type CallGraphTarget,
  createCallGraphFollower,
  createSemanticCallGraph,
  enclosingCallable,
  packCallGraphEvidence,
  resolveCallRoot,
  withCallGraphVersions,
} from './call-graph';
import type { CallHierarchy, SourceRange, SymbolItem } from './types';

vi.mock('./backend', () => ({ invoke: vi.fn() }));

const range = (start: number, end = start + 5): SourceRange => ({
  start: { line: start, character: 0 },
  end: { line: end, character: 0 },
});
const symbol = (name: string): SymbolItem => ({
  name,
  kind: 12,
  uri: `file:///code/${name}.ts`,
  range: range(0),
  selectionRange: range(0, 1),
});
const graph = (name: string): CallHierarchy => ({
  root: symbol(name),
  incoming: [],
  outgoing: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function server(links: [string, string][]) {
  const calls: string[] = [];
  const request: CallGraphRequest = async <T>(method: string, params: object) => {
    const name = (params as { item: SymbolItem }).item.name;
    const incoming = method === 'callHierarchy/incomingCalls';
    calls.push(`${incoming ? 'in' : 'out'}:${name}`);
    return links
      .filter(([from, to]) => (incoming ? to === name : from === name))
      .map(([from, to]) => ({
        [incoming ? 'from' : 'to']: symbol(incoming ? from : to),
        fromRanges: [range(1, 2)],
      })) as T;
  };
  return { request, calls };
}

async function exhaust(session: CallGraphSession, signal = new AbortController().signal) {
  let result = await session.load(signal, () => {});
  let count = 0;
  while (result.traversal?.frontier?.length) {
    const frontier = result.traversal.frontier[0];
    result = await session.expand(frontier.symbol, frontier.direction, signal, () => {});
    if (++count > 1000) throw new Error('Graph exploration did not terminate.');
  }
  return result;
}

describe('progressive semantic call graph traversal', () => {
  it('starts with two hops and leaves deeper branches unexplored', async () => {
    const fixture = server([
      ['ancestor', 'parent'],
      ['parent', 'root'],
      ['root', 'child'],
      ['child', 'grandchild'],
      ['grandchild', 'deep'],
      ['parent', 'sibling'],
    ]);
    const session = createSemanticCallGraph(symbol('root'), fixture.request);
    const result = await session.load(new AbortController().signal, () => {});
    expect(result.nodes?.map((item) => item.name).sort()).toEqual([
      'ancestor',
      'child',
      'grandchild',
      'parent',
      'root',
    ]);
    expect(result.traversal).toMatchObject({ state: 'ready', batchSize: 20, pending: 2 });
    expect(result.traversal?.frontier).toEqual([
      { symbol: symbol('ancestor'), direction: 'incoming', remaining: undefined },
      { symbol: symbol('grandchild'), direction: 'outgoing', remaining: undefined },
    ]);
    expect(fixture.calls).not.toContain('out:grandchild');
    expect(fixture.calls).not.toContain('in:ancestor');
  });

  it('reveals at most twenty new symbols in the chosen direction', async () => {
    const links: [string, string][] = Array.from({ length: 90 }, (_, i) => [`n${i}`, `n${i + 1}`]);
    links.push(['parent', 'n0'], ['ancestor', 'parent'], ['older', 'ancestor']);
    const fixture = server(links);
    const session = createSemanticCallGraph(symbol('n0'), fixture.request);
    const signal = new AbortController().signal;
    const initial = await session.load(signal, () => {});
    const outgoing = initial.traversal?.frontier?.find((item) => item.direction === 'outgoing');
    if (!outgoing) throw new Error('Missing outgoing frontier.');
    const result = await session.expand(outgoing.symbol, outgoing.direction, signal, () => {});
    expect((result.nodes?.length || 0) - (initial.nodes?.length || 0)).toBe(20);
    expect(result.nodes?.some((item) => item.name === 'n22')).toBe(true);
    expect(result.nodes?.some((item) => item.name === 'older')).toBe(false);
    expect(fixture.calls).not.toContain('in:ancestor');
    expect(fixture.calls).not.toContain('out:n22');
  });

  it('retains wide unread batches and every branch can be revealed later', async () => {
    const fixture = server(
      Array.from({ length: 105 }, (_, i): [string, string] => ['root', `leaf${i}`]),
    );
    const session = createSemanticCallGraph(symbol('root'), fixture.request);
    const signal = new AbortController().signal;
    let result = await session.load(signal, () => {});
    expect(result.nodes?.length).toBeLessThanOrEqual(41);
    expect(result.outgoing).toHaveLength(20);
    expect(result.traversal?.frontier).toContainEqual({
      symbol: symbol('root'),
      direction: 'outgoing',
      remaining: 85,
    });
    while (result.traversal?.frontier?.some((item) => item.symbol.name === 'root')) {
      const before = result.nodes?.length || 0;
      result = await session.expand(symbol('root'), 'outgoing', signal, () => {});
      expect((result.nodes?.length || 0) - before).toBeLessThanOrEqual(20);
    }
    expect(result.outgoing).toHaveLength(105);
    expect(new Set(result.outgoing.map((item) => item.to.name)).size).toBe(105);
    expect(fixture.calls.filter((item) => item === 'out:root')).toHaveLength(1);
  });

  it('bounds the initial preview even when both directions have wide branches', async () => {
    const fixture = server([
      ...Array.from({ length: 60 }, (_, i): [string, string] => [`parent${i}`, 'root']),
      ...Array.from({ length: 60 }, (_, i): [string, string] => ['root', `child${i}`]),
    ]);
    const result = await createSemanticCallGraph(symbol('root'), fixture.request).load(
      new AbortController().signal,
      () => {},
    );
    expect(result.nodes).toHaveLength(41);
    expect(result.incoming).toHaveLength(20);
    expect(result.outgoing).toHaveLength(20);
    expect(fixture.calls).toEqual(['in:root', 'out:root']);
  });

  it('can exhaust deep chains without a permanent depth cutoff', async () => {
    const links: [string, string][] = Array.from({ length: 180 }, (_, i) => [`n${i}`, `n${i + 1}`]);
    const fixture = server(links);
    const result = await exhaust(createSemanticCallGraph(symbol('n0'), fixture.request));
    expect(result.nodes).toHaveLength(181);
    expect(result.relations).toHaveLength(180);
    expect(result.traversal).toMatchObject({ state: 'complete', visited: 181, pending: 0 });
  });

  it('retains diamond, cycle, and self-call edges while visiting once per direction', async () => {
    const fixture = server([
      ['root', 'left'],
      ['root', 'right'],
      ['left', 'shared'],
      ['right', 'shared'],
      ['shared', 'root'],
      ['shared', 'shared'],
    ]);
    const result = await exhaust(createSemanticCallGraph(symbol('root'), fixture.request));
    expect(result.nodes).toHaveLength(4);
    expect(result.relations).toHaveLength(6);
    expect(new Set(fixture.calls).size).toBe(fixture.calls.length);
    expect(fixture.calls).toHaveLength(8);
  });

  it('walks ancestors and descendants without pulling in unrelated sibling paths', async () => {
    const fixture = server([
      ['ancestor', 'parent'],
      ['parent', 'root'],
      ['parent', 'sibling'],
      ['root', 'child'],
      ['child', 'grandchild'],
      ['unrelated', 'child'],
    ]);
    const result = await exhaust(createSemanticCallGraph(symbol('root'), fixture.request));
    expect(result.nodes?.map((item) => item.name).sort()).toEqual([
      'ancestor',
      'child',
      'grandchild',
      'parent',
      'root',
    ]);
    expect(result.relations).toHaveLength(4);
  });

  it('keeps resolved branches and reports errors as explicit boundaries', async () => {
    const fixture = server([
      ['root', 'unavailable'],
      ['root', 'working'],
      ['working', 'deep'],
    ]);
    const request: CallGraphRequest = (method, params, signal) =>
      (params as { item: SymbolItem }).item.name === 'unavailable'
        ? Promise.reject(new Error('Dependency source is unavailable.'))
        : fixture.request(method, params, signal);
    const result = await exhaust(createSemanticCallGraph(symbol('root'), request));
    expect(result.relations).toHaveLength(3);
    expect(result.traversal).toMatchObject({
      state: 'partial',
      boundaries: [{ symbol: symbol('unavailable'), direction: 'outgoing' }],
    });
  });

  it('does not publish late batches after cancellation', async () => {
    const controller = new AbortController();
    const pending = deferred<never>();
    const progress = vi.fn();
    const result = createSemanticCallGraph(symbol('root'), () => pending.promise).load(
      controller.signal,
      progress,
    );
    controller.abort();
    pending.reject(new Error('Late server response'));
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toHaveBeenCalledTimes(1);
  });
});

describe('cursor root discovery', () => {
  const uri = 'file:///code/source.rs';
  const outline = [
    {
      name: 'outer',
      kind: 12,
      range: range(0, 40),
      selectionRange: range(0, 1),
      children: [{ name: 'inner', kind: 6, range: range(8, 20), selectionRange: range(8, 9) }],
    },
  ];
  it('chooses the smallest enclosing callable and excludes its ending position', () => {
    expect(enclosingCallable(outline, uri, { line: 12, character: 2 })?.name).toBe('inner');
    expect(enclosingCallable(outline, uri, { line: 20, character: 0 })?.name).toBe('outer');
    expect(enclosingCallable(outline, uri, { line: 40, character: 0 })).toBeNull();
  });
  it('uses document symbols to prepare at the function name when clicking its body', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(outline)
      .mockResolvedValueOnce([symbol('inner')]);
    const result = await resolveCallRoot(
      request,
      uri,
      { line: 12, character: 2 },
      new AbortController().signal,
    );
    expect(result?.name).toBe('inner');
    expect(request.mock.calls[2][1]).toEqual({ position: { line: 8, character: 0 } });
  });
  it('uses the identifier range from a cached outline instead of the declaration start', async () => {
    const root = symbol('graphHub');
    const request = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce([root]);
    const outline = vi.fn().mockResolvedValue([
      {
        name: 'graphHub',
        kind: 12,
        range: range(4, 27),
        selectionRange: {
          start: { line: 4, character: 16 },
          end: { line: 4, character: 24 },
        },
      },
    ]);
    expect(
      await resolveCallRoot(
        request,
        uri,
        { line: 5, character: 17 },
        new AbortController().signal,
        outline,
      ),
    ).toBe(root);
    expect(outline).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1]).toEqual({ position: { line: 4, character: 16 } });
  });
  it('prefers the callable under the pointer over the enclosing function', async () => {
    const request = vi.fn().mockResolvedValueOnce([symbol('called')]);
    expect(
      (
        await resolveCallRoot(
          request,
          uri,
          { line: 12, character: 2 },
          new AbortController().signal,
        )
      )?.name,
    ).toBe('called');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('captured graph source versions', () => {
  it('versions every display endpoint without changing exact language-server items', () => {
    const root = { ...symbol('root'), data: { item: 'server-owned-root' } };
    const child = { ...symbol('child'), data: { item: 'server-owned-child' } };
    const relation = { from: root, to: child, fromRanges: [range(1, 2)] };
    const raw: CallHierarchy = {
      root,
      incoming: [],
      outgoing: [relation],
      nodes: [root, child],
      relations: [relation],
      traversal: {
        state: 'partial',
        visited: 2,
        pending: 0,
        boundaries: [{ symbol: child, direction: 'outgoing', reason: 'No source.' }],
        reasons: [],
      },
    };
    const before = JSON.stringify(raw);
    const display = withCallGraphVersions(
      raw,
      new Map([
        [root.uri, 'captured-root-buffer'],
        [child.uri, 'captured-child-buffer'],
      ]),
    );
    expect(display.root.version).toBe('captured-root-buffer');
    expect(display.outgoing[0].from).toBe(display.root);
    expect(display.outgoing[0].to.version).toBe('captured-child-buffer');
    expect(display.nodes?.[1]).toBe(display.outgoing[0].to);
    expect(display.traversal?.boundaries[0].symbol.version).toBe('captured-child-buffer');
    expect(JSON.stringify(raw)).toBe(before);
    expect('version' in root).toBe(false);
    expect('version' in child).toBe(false);
    expect(display.root.data).toBe(root.data);
  });
});

describe('shared graph evidence batches', () => {
  const relation = (sites: number) => ({
    from: symbol('from'),
    to: symbol('to'),
    fromRanges: Array.from({ length: sites }, (_, line) => range(line, line + 1)),
  });

  it('keeps dense call sites within the native range budget without dropping links', () => {
    const links = [relation(3000), relation(1000), relation(500), relation(3000)];
    const batches = packCallGraphEvidence(links);
    expect(batches.map((batch) => batch.length)).toEqual([2, 2]);
    expect(batches.flat()).toEqual(links);
    for (const batch of batches)
      expect(batch.reduce((count, item) => count + item.fromRanges.length, 0)).toBeLessThanOrEqual(
        4096,
      );
  });

  it('limits wide batches to 128 links and preserves every relation', () => {
    const links = Array.from({ length: 260 }, () => relation(1));
    const batches = packCallGraphEvidence(links);
    expect(batches.map((batch) => batch.length)).toEqual([128, 128, 4]);
    expect(batches.flat()).toEqual(links);
  });

  it('rejects an oversized link explicitly instead of sharing only its final sites', () => {
    expect(() => packCallGraphEvidence([relation(4097)])).toThrow('4,096 call sites');
  });
});

describe('live graph following', () => {
  afterEach(() => vi.useRealTimers());
  function harness() {
    vi.useFakeTimers();
    const callbacks = { onGraph: vi.fn(), onLoading: vi.fn(), onError: vi.fn() };
    return { ...callbacks, follower: createCallGraphFollower(callbacks) };
  }
  const target = (name: string, load?: CallGraphTarget['load']): CallGraphTarget => ({
    key: name,
    load: load || (async () => graph(name)),
  });
  it('debounces cursor motion and ignores stale symbol discovery', async () => {
    const h = harness();
    const stale = deferred<CallGraphTarget>();
    const first = vi.fn(() => stale.promise);
    h.follower.select('same source', first);
    await vi.advanceTimersByTimeAsync(180);
    h.follower.select('same source', async () => target('current'));
    await vi.advanceTimersByTimeAsync(180);
    stale.resolve(target('stale'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onGraph.mock.lastCall?.[0]?.root.name).toBe('current');
  });
  it('reuses a running and completed crawl for moves within the same function', async () => {
    const h = harness();
    const pending = deferred<CallHierarchy>();
    const load = vi.fn(() => pending.promise);
    h.follower.select('revision1', async () => target('same', load));
    await vi.advanceTimersByTimeAsync(180);
    h.follower.select('revision1', async () => target('same', load));
    await vi.advanceTimersByTimeAsync(180);
    pending.resolve(graph('same'));
    await vi.advanceTimersByTimeAsync(0);
    h.follower.select('revision1', async () => target('same', load));
    await vi.advanceTimersByTimeAsync(180);
    expect(load).toHaveBeenCalledTimes(1);
    expect(h.onLoading).toHaveBeenLastCalledWith(false);
    expect(h.onGraph).toHaveBeenLastCalledWith(graph('same'));
  });
  it('cancels old work immediately when an edit or tab changes the source revision', async () => {
    const h = harness();
    const pending = deferred<CallHierarchy>();
    let firstSignal: AbortSignal | undefined;
    h.follower.select('tab1:revision1', async () =>
      target('a', (signal) => {
        firstSignal = signal;
        return pending.promise;
      }),
    );
    await vi.advanceTimersByTimeAsync(180);
    h.follower.select('tab2:revision1', async () => target('b'));
    expect(firstSignal?.aborted).toBe(true);
    expect(h.onGraph).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(180);
    pending.resolve(graph('a'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onGraph).toHaveBeenLastCalledWith(graph('b'));
  });
  it('retains a crawl error if the cursor moves while loading', async () => {
    const h = harness();
    const pending = deferred<CallHierarchy>();
    const next = deferred<CallGraphTarget>();
    h.follower.select('revision1', async () => target('same', () => pending.promise));
    await vi.advanceTimersByTimeAsync(180);
    h.follower.select('revision1', () => next.promise);
    await vi.advanceTimersByTimeAsync(180);
    pending.reject(new Error('Index changed'));
    await vi.advanceTimersByTimeAsync(0);
    next.resolve(target('same'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onLoading).toHaveBeenLastCalledWith(false);
    expect(h.onError).toHaveBeenLastCalledWith('Index changed');
  });
  it('stops publishing after clear and can follow again', async () => {
    const h = harness();
    const load = vi.fn();
    h.follower.select('revision1', async () => target('unused', load));
    h.follower.clear();
    await vi.advanceTimersByTimeAsync(200);
    expect(load).not.toHaveBeenCalled();
    h.follower.select('revision2', async () => target('new'));
    await vi.advanceTimersByTimeAsync(180);
    expect(h.onGraph).toHaveBeenLastCalledWith(graph('new'));
  });
  it('keeps revealed branches within the same root and cancels stale expansions on edits', async () => {
    const h = harness();
    const pending = deferred<CallHierarchy>();
    let expansionSignal: AbortSignal | undefined;
    const expand = vi.fn((_symbol, _direction, signal) => {
      expansionSignal = signal;
      return pending.promise;
    });
    const current = { ...target('same'), expand };
    h.follower.select('revision1', async () => current);
    await vi.advanceTimersByTimeAsync(180);
    const task = h.follower.expand(symbol('same'), 'outgoing');
    h.follower.select('revision1', async () => target('same'));
    await vi.advanceTimersByTimeAsync(180);
    expect(expansionSignal?.aborted).toBe(false);
    h.follower.select('revision2', async () => target('changed'));
    expect(expansionSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(180);
    pending.resolve(graph('late-expansion'));
    await task;
    expect(h.onGraph).toHaveBeenLastCalledWith(graph('changed'));
    expect(expand).toHaveBeenCalledTimes(1);
  });
});
