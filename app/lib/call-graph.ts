import { symbolKey } from './code-index';
import type {
  CallDirection,
  CallHierarchy,
  CallRelation,
  Position,
  SourceRange,
  SymbolItem,
} from './types';

export type CallGraphRequest = <T>(
  method: string,
  params: object,
  signal: AbortSignal,
) => Promise<T>;

export type DocumentSymbol = {
  name: string;
  kind: number;
  detail?: string;
  range?: SourceRange;
  selectionRange?: SourceRange;
  uri?: string;
  location?: { uri: string; range: SourceRange };
  children?: DocumentSymbol[];
};

export function containsPosition(range: SourceRange, position: Position): boolean {
  const afterStart =
    position.line > range.start.line ||
    (position.line === range.start.line && position.character >= range.start.character);
  const beforeEnd =
    position.line < range.end.line ||
    (position.line === range.end.line && position.character < range.end.character);
  return afterStart && beforeEnd;
}

export function withCallGraphVersions(
  graph: CallHierarchy,
  versions: ReadonlyMap<string, string>,
): CallHierarchy {
  const symbols = new Map<string, SymbolItem>();
  const capture = (symbol: SymbolItem): SymbolItem => {
    const key = symbolKey(symbol);
    let result = symbols.get(key);
    if (!result) {
      const version = versions.get(symbol.uri);
      result = version ? { ...symbol, version } : symbol;
      symbols.set(key, result);
    }
    return result;
  };
  const relation = (item: CallRelation): CallRelation => ({
    ...item,
    from: capture(item.from),
    to: capture(item.to),
  });
  return {
    ...graph,
    root: capture(graph.root),
    incoming: graph.incoming.map(relation),
    outgoing: graph.outgoing.map(relation),
    nodes: graph.nodes?.map(capture),
    relations: graph.relations?.map(relation),
    traversal: graph.traversal && {
      ...graph.traversal,
      boundaries: graph.traversal.boundaries.map((item) => ({
        ...item,
        symbol: capture(item.symbol),
      })),
      frontier: graph.traversal.frontier?.map((item) => ({
        ...item,
        symbol: capture(item.symbol),
      })),
    },
  };
}

export function packCallGraphEvidence(relations: CallRelation[]): CallRelation[][] {
  const batches: CallRelation[][] = [];
  let batch: CallRelation[] = [];
  let ranges = 0;
  for (const relation of relations) {
    if (relation.fromRanges.length > 4096)
      throw new Error('A call link exceeds the shared index limit of 4,096 call sites.');
    if (batch.length === 128 || ranges + relation.fromRanges.length > 4096) {
      batches.push(batch);
      batch = [];
      ranges = 0;
    }
    batch.push(relation);
    ranges += relation.fromRanges.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function enclosingCallable(
  symbols: DocumentSymbol[],
  uri: string,
  position: Position,
): SymbolItem | null {
  const candidates: SymbolItem[] = [];
  const visit = (items: DocumentSymbol[]) => {
    for (const item of items) {
      const range = item.range || item.location?.range;
      const sourceUri = item.uri || item.location?.uri || uri;
      if (
        range &&
        sourceUri === uri &&
        containsPosition(range, position) &&
        [6, 9, 12].includes(item.kind)
      )
        candidates.push({
          name: item.name,
          kind: item.kind,
          detail: item.detail,
          uri: sourceUri,
          range,
          selectionRange: item.selectionRange || range,
        });
      if (item.children) visit(item.children);
    }
  };
  visit(symbols);
  candidates.sort(
    (left, right) =>
      right.range.start.line - left.range.start.line ||
      right.range.start.character - left.range.start.character ||
      left.range.end.line - right.range.end.line ||
      left.range.end.character - right.range.end.character,
  );
  return candidates[0] || null;
}

export async function resolveCallRoot(
  request: CallGraphRequest,
  uri: string,
  position: Position,
  signal: AbortSignal,
  outline?: () => Promise<DocumentSymbol[] | null>,
): Promise<SymbolItem | null> {
  signal.throwIfAborted();
  const direct = await request<SymbolItem[] | null>(
    'textDocument/prepareCallHierarchy',
    { position },
    signal,
  );
  signal.throwIfAborted();
  if (direct?.length) return direct[0];
  const symbols = outline
    ? await outline()
    : await request<DocumentSymbol[] | null>('textDocument/documentSymbol', {}, signal);
  signal.throwIfAborted();
  const enclosing = enclosingCallable(symbols || [], uri, position);
  if (!enclosing) return null;
  const candidates = await request<SymbolItem[] | null>(
    'textDocument/prepareCallHierarchy',
    { position: enclosing.selectionRange.start },
    signal,
  );
  signal.throwIfAborted();
  return candidates?.[0] || null;
}

function rangeKey(range: SourceRange) {
  return `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}

export const CALL_GRAPH_INITIAL_DEPTH = 2;
export const CALL_GRAPH_BATCH_SIZE = 20;

export interface CallGraphPage {
  relations: CallRelation[];
  nextCursor?: string | null;
  reasons?: string[];
}
export type CallGraphNeighbors = (
  symbol: SymbolItem,
  direction: CallDirection,
  signal: AbortSignal,
  cursor?: string,
) => Promise<CallGraphPage>;
export interface CallGraphSession {
  load: (
    signal: AbortSignal,
    onProgress: (hierarchy: CallHierarchy) => void,
  ) => Promise<CallHierarchy>;
  expand: (
    symbol: SymbolItem,
    direction: CallDirection,
    signal: AbortSignal,
    onProgress: (hierarchy: CallHierarchy) => void,
  ) => Promise<CallHierarchy>;
}

/** Each direction keeps its own frontier so upstream walks never pull in sibling branches. */
export function createCallGraphSession(
  root: SymbolItem,
  read: CallGraphNeighbors,
  origin: NonNullable<CallHierarchy['origin']>,
): CallGraphSession {
  type Branch = {
    symbol: SymbolItem;
    direction: CallDirection;
    depth: number;
    fetched: boolean;
    relations: CallRelation[];
    offset: number;
    cursor?: string;
    cursors: Set<string>;
    done: boolean;
    failed: boolean;
  };
  const nodes = new Map([[symbolKey(root), root]]);
  const relations = new Map<string, CallRelation>();
  const branches = new Map<string, Branch>();
  const visited = new Set<string>();
  const boundaries: NonNullable<CallHierarchy['traversal']>['boundaries'] = [];
  const reasons = new Set<string>();
  let running = false;
  const branchKey = (symbol: SymbolItem, direction: CallDirection) =>
    `${direction}:${symbolKey(symbol)}`;
  const ensure = (symbol: SymbolItem, direction: CallDirection, depth: number): Branch => {
    const key = branchKey(symbol, direction);
    let branch = branches.get(key);
    if (!branch) {
      branch = {
        symbol,
        direction,
        depth,
        fetched: false,
        relations: [],
        offset: 0,
        cursors: new Set(),
        done: false,
        failed: false,
      };
      branches.set(key, branch);
    } else branch.depth = Math.min(depth, branch.depth);
    return branch;
  };
  const incoming = ensure(root, 'incoming', 0);
  const outgoing = ensure(root, 'outgoing', 0);
  const snapshot = (): CallHierarchy => {
    const edges = [...relations.values()];
    const key = symbolKey(root);
    const frontier = [...branches.values()]
      .filter((branch) => !branch.done && !branch.failed)
      .map((branch) => ({
        symbol: branch.symbol,
        direction: branch.direction,
        remaining:
          branch.fetched && !branch.cursor ? branch.relations.length - branch.offset : undefined,
      }));
    return {
      root,
      origin,
      incoming: edges.filter((edge) => symbolKey(edge.to) === key),
      outgoing: edges.filter((edge) => symbolKey(edge.from) === key),
      nodes: [...nodes.values()],
      relations: edges,
      traversal: {
        state: running
          ? 'loading'
          : boundaries.length || reasons.size
            ? 'partial'
            : frontier.length
              ? 'ready'
              : 'complete',
        visited: visited.size,
        pending: frontier.length,
        frontier,
        batchSize: CALL_GRAPH_BATCH_SIZE,
        boundaries: [...boundaries],
        reasons: [...reasons],
      },
    };
  };
  const fetch = async (branch: Branch, signal: AbortSignal) => {
    if (branch.done || branch.failed || branch.offset < branch.relations.length) return;
    signal.throwIfAborted();
    try {
      const page = await read(branch.symbol, branch.direction, signal, branch.cursor);
      signal.throwIfAborted();
      if (page.nextCursor && branch.cursors.has(page.nextCursor))
        throw new Error('The index repeated a graph page. Refresh the graph.');
      if (page.nextCursor) branch.cursors.add(page.nextCursor);
      branch.relations = page.relations;
      branch.offset = 0;
      branch.cursor = page.nextCursor || undefined;
      branch.fetched = true;
      visited.add(symbolKey(branch.symbol));
      for (const reason of page.reasons || []) reasons.add(reason);
      branch.done = !branch.relations.length && !branch.cursor;
    } catch (error) {
      signal.throwIfAborted();
      branch.failed = true;
      boundaries.push({
        symbol: branch.symbol,
        direction: branch.direction,
        reason: String(error).replace(/^Error: /, ''),
      });
    }
  };
  const run = async (
    initial: Branch[],
    depth: number,
    nodeBudget: number,
    signal: AbortSignal,
    onProgress: (hierarchy: CallHierarchy) => void,
  ): Promise<CallHierarchy> => {
    signal.throwIfAborted();
    if (running) return snapshot();
    running = true;
    const queue = [...initial];
    const queued = new Set(initial.map((branch) => branchKey(branch.symbol, branch.direction)));
    let added = 0;
    let links = 0;
    let offset = 0;
    onProgress(snapshot());
    try {
      // Link and request budgets also bound dense cyclic graphs that reveal few new symbols.
      while (offset < queue.length && added < nodeBudget && links < nodeBudget * 2) {
        signal.throwIfAborted();
        const batch = queue.slice(offset, offset + 4);
        offset += batch.length;
        await Promise.all(batch.map((branch) => fetch(branch, signal)));
        signal.throwIfAborted();
        for (const branch of batch) {
          let revealed = 0;
          while (
            !branch.failed &&
            branch.offset < branch.relations.length &&
            added < nodeBudget &&
            links < nodeBudget * 2 &&
            revealed < CALL_GRAPH_BATCH_SIZE
          ) {
            const relation = branch.relations[branch.offset++];
            const next = branch.direction === 'incoming' ? relation.from : relation.to;
            const key = symbolKey(next);
            if (!nodes.has(key)) {
              nodes.set(key, next);
              added++;
            }
            const relationKey = `${symbolKey(relation.from)}→${symbolKey(relation.to)}`;
            const previous = relations.get(relationKey);
            const ranges = new Map(
              [...(previous?.fromRanges || []), ...relation.fromRanges].map((range) => [
                rangeKey(range),
                range,
              ]),
            );
            relations.set(relationKey, { ...relation, fromRanges: [...ranges.values()] });
            const child = ensure(next, branch.direction, branch.depth + 1);
            const childKey = branchKey(next, branch.direction);
            if (!child.done && !child.failed && child.depth < depth && !queued.has(childKey)) {
              queue.push(child);
              queued.add(childKey);
            }
            links++;
            revealed++;
          }
          branch.done =
            !branch.failed &&
            branch.fetched &&
            branch.offset === branch.relations.length &&
            !branch.cursor;
        }
        onProgress(snapshot());
      }
      signal.throwIfAborted();
    } finally {
      running = false;
    }
    const result = snapshot();
    signal.throwIfAborted();
    onProgress(result);
    return result;
  };
  return {
    load: (signal, onProgress) =>
      run(
        [incoming, outgoing],
        CALL_GRAPH_INITIAL_DEPTH,
        CALL_GRAPH_BATCH_SIZE * 2,
        signal,
        onProgress,
      ),
    expand: (symbol, direction, signal, onProgress) => {
      const branch = branches.get(branchKey(symbol, direction));
      if (!branch || branch.done || branch.failed) return Promise.resolve(snapshot());
      return run([branch], Number.POSITIVE_INFINITY, CALL_GRAPH_BATCH_SIZE, signal, onProgress);
    },
  };
}

export function createSemanticCallGraph(
  root: SymbolItem,
  request: CallGraphRequest,
): CallGraphSession {
  return createCallGraphSession(
    root,
    async (symbol, direction, signal) => {
      type Incoming = { from: SymbolItem; fromRanges: SourceRange[] };
      type Outgoing = { to: SymbolItem; fromRanges: SourceRange[] };
      const response = await request<Incoming[] | Outgoing[] | null>(
        `callHierarchy/${direction}Calls`,
        { item: symbol },
        signal,
      );
      return {
        relations: (response || []).map((item) => ({
          from: 'from' in item ? item.from : symbol,
          to: 'to' in item ? item.to : symbol,
          fromRanges: item.fromRanges,
          evidence: 'verified',
        })),
      };
    },
    'language-server',
  );
}

export interface CallGraphTarget {
  key: string;
  load: (
    signal: AbortSignal,
    onProgress: (hierarchy: CallHierarchy) => void,
  ) => Promise<CallHierarchy | null>;
  expand?: CallGraphSession['expand'];
}

/** Cursor discovery can change while an unchanged function keeps its existing crawl. */
export function createCallGraphFollower(callbacks: {
  onGraph: (hierarchy: CallHierarchy | null) => void;
  onLoading: (loading: boolean) => void;
  onError: (message: string) => void;
}) {
  let sequence = 0;
  let resolvedSequence = 0;
  let source = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let discovery: AbortController | undefined;
  let active:
    | {
        key: string;
        abort: AbortController;
        graph: CallHierarchy | null;
        loading: boolean;
        error: string;
        target: CallGraphTarget;
      }
    | undefined;
  const clear = () => {
    sequence++;
    clearTimeout(timer);
    discovery?.abort();
    active?.abort.abort();
    active = undefined;
    source = '';
  };
  const progress = (job: NonNullable<typeof active>, graph: CallHierarchy | null) => {
    if (active !== job || job.abort.signal.aborted) return;
    job.graph = graph;
    job.loading = graph?.traversal?.state === 'loading';
    if (resolvedSequence !== sequence) return;
    callbacks.onGraph(graph);
    callbacks.onLoading(job.loading);
  };
  const failed = (job: NonNullable<typeof active>, error: unknown) => {
    if (active !== job || job.abort.signal.aborted) return;
    job.loading = false;
    job.error = String(error).replace(/^Error: /, '');
    if (resolvedSequence !== sequence) return;
    callbacks.onGraph(job.graph);
    callbacks.onLoading(false);
    callbacks.onError(job.error);
  };
  return {
    clear,
    async expand(symbol: SymbolItem, direction: CallDirection) {
      const job = active;
      if (!job?.target.expand || job.loading || resolvedSequence !== sequence) return;
      job.loading = true;
      job.error = '';
      callbacks.onLoading(true);
      callbacks.onError('');
      try {
        progress(
          job,
          await job.target.expand(symbol, direction, job.abort.signal, (graph) =>
            progress(job, graph),
          ),
        );
      } catch (error) {
        failed(job, error);
      }
    },
    select(
      nextSource: string,
      resolve: (signal: AbortSignal) => Promise<CallGraphTarget | null>,
      delay = 180,
    ) {
      const request = ++sequence;
      clearTimeout(timer);
      discovery?.abort();
      if (source !== nextSource) {
        active?.abort.abort();
        active = undefined;
        callbacks.onGraph(null);
      }
      source = nextSource;
      const controller = new AbortController();
      discovery = controller;
      callbacks.onError('');
      callbacks.onLoading(true);
      timer = setTimeout(() => {
        void (async () => {
          let target: CallGraphTarget | null;
          try {
            target = await resolve(controller.signal);
          } catch (error) {
            if (request !== sequence || controller.signal.aborted) return;
            active?.abort.abort();
            active = undefined;
            callbacks.onGraph(null);
            callbacks.onLoading(false);
            callbacks.onError(String(error).replace(/^Error: /, ''));
            return;
          }
          if (request !== sequence || controller.signal.aborted) return;
          resolvedSequence = request;
          if (!target) {
            active?.abort.abort();
            active = undefined;
            callbacks.onGraph(null);
            callbacks.onLoading(false);
            return;
          }
          if (active?.key === target.key) {
            callbacks.onGraph(active.graph);
            callbacks.onLoading(active.loading);
            callbacks.onError(active.error);
            return;
          }
          active?.abort.abort();
          const job = {
            key: target.key,
            abort: new AbortController(),
            graph: null as CallHierarchy | null,
            loading: true,
            error: '',
            target,
          };
          active = job;
          callbacks.onGraph(null);
          try {
            const graph = await target.load(job.abort.signal, (graph) => progress(job, graph));
            progress(job, graph);
          } catch (error) {
            failed(job, error);
          }
        })();
      }, delay);
    },
  };
}
