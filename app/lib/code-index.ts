import { invoke } from './backend';
import { CALL_GRAPH_BATCH_SIZE, createCallGraphSession } from './call-graph';
import { makeReference } from './context';
import type { CallHierarchy, ContextReference, SourceRange, SymbolItem } from './types';

export interface IndexStatus {
  root: string;
  state: 'idle' | 'indexing' | 'ready' | 'error';
  files: number;
  chunks: number;
  symbols: number;
  edges: number;
  verifiedEdges: number;
  indexedBytes: number;
  skipped: number;
  limited: boolean;
  stale: boolean;
  generation: number;
  updatedAt: number | null;
  lastError: string | null;
}
export interface IndexHit {
  id: string;
  kind: 'symbol' | 'chunk';
  symbolKind?: string | null;
  path: string;
  uri: string;
  range: SourceRange;
  selectionRange?: SourceRange | null;
  name?: string | null;
  qualifiedName?: string | null;
  content: string;
  version: string;
  score: number;
  reasons: string[];
}
export interface IndexNode {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  path: string;
  uri: string;
  range: SourceRange;
  selectionRange: SourceRange;
  version: string;
}
export interface IndexEdge {
  id: string;
  from: string;
  to: string;
  kind: 'call';
  evidence: 'inferred' | 'ambiguous' | 'verified';
  ranges: SourceRange[];
  sourceVersion: string;
  targetVersion: string;
}
export type IndexNeighborhood = { nodes: IndexNode[]; edges: IndexEdge[] };
export interface IndexTraversalPage extends IndexNeighborhood {
  generation: number;
  nextCursor: string | null;
  traversalComplete: boolean;
  indexLimited: boolean;
  stale: boolean;
  skippedStale: number;
}

export function symbolKey(symbol: SymbolItem): string {
  const { start, end } = symbol.selectionRange;
  return encodeURIComponent(
    JSON.stringify([symbol.uri, start.line, start.character, end.line, end.character]),
  );
}

export function indexReference(hit: IndexHit): ContextReference {
  return makeReference({
    kind: hit.kind === 'symbol' ? 'symbol' : 'file',
    label:
      hit.qualifiedName || hit.name || `${hit.path.split('/').pop()}:${hit.range.start.line + 1}`,
    origin: 'Code index',
    uri: hit.uri,
    ranges: [hit.range],
    version: hit.version,
    content: hit.content,
  });
}
export function indexHierarchy(rootId: string, graph: IndexNeighborhood): CallHierarchy | null {
  const symbols = new Map<string, SymbolItem>(
    graph.nodes.map((node) => [
      node.id,
      {
        name: node.qualifiedName || node.name,
        kind: 12,
        uri: node.uri,
        range: node.range,
        selectionRange: node.selectionRange,
        version: node.version,
        data: { indexId: node.id },
      },
    ]),
  );
  const root = symbols.get(rootId);
  if (!root) return null;
  const relations = graph.edges.flatMap((edge) => {
    const from = symbols.get(edge.from),
      to = symbols.get(edge.to);
    return from && to ? [{ from, to, fromRanges: edge.ranges, evidence: edge.evidence }] : [];
  });
  return {
    root,
    origin: 'index',
    incoming: relations.filter((edge) => edge.to === root),
    outgoing: relations.filter((edge) => edge.from === root),
    nodes: [...symbols.values()],
    relations,
  };
}

export function createIndexCallGraph(root: IndexNode) {
  const initial = indexHierarchy(root.id, { nodes: [root], edges: [] });
  if (!initial) throw new Error('The indexed call root is unavailable. Refresh the graph.');
  let generation: number | undefined;
  return createCallGraphSession(
    initial.root,
    async (symbol, direction, signal, cursor) => {
      signal.throwIfAborted();
      const symbolId = (symbol.data as { indexId: string }).indexId;
      const page = await invoke<IndexTraversalPage>('index_traverse', {
        symbolId,
        direction,
        direct: true,
        limit: CALL_GRAPH_BATCH_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      signal.throwIfAborted();
      if (generation !== undefined && generation !== page.generation)
        throw new Error('The code index changed during exploration. Refresh the graph.');
      generation = page.generation;
      const hierarchy = indexHierarchy(symbolId, page);
      const reasons: string[] = [];
      if (page.indexLimited) reasons.push('Workspace indexing reached a size or time limit.');
      if (page.stale) reasons.push('Some saved source changed. Refresh the code index.');
      if (page.skippedStale)
        reasons.push(
          `${page.skippedStale} changed ${page.skippedStale === 1 ? 'link was' : 'links were'} skipped.`,
        );
      if (!page.traversalComplete && !page.nextCursor && !page.stale)
        reasons.push('The index stopped before this branch was resolved.');
      return {
        relations: hierarchy?.relations || [],
        nextCursor: page.nextCursor,
        reasons,
      };
    },
    'index',
  );
}

export async function loadIndexHierarchy(
  rootId: string,
  onProgress?: (hierarchy: CallHierarchy) => void,
  signal?: AbortSignal,
): Promise<CallHierarchy | null> {
  const nodes = new Map<string, IndexNode>();
  const edges = new Map<string, IndexEdge>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let generation: number | undefined;
  let indexLimited = false;
  let stale = false;
  let skippedStale = 0;
  let hierarchy: CallHierarchy | null = null;
  do {
    signal?.throwIfAborted();
    const page = await invoke<IndexTraversalPage>('index_traverse', {
      symbolId: rootId,
      direction: 'both',
      limit: 250,
      ...(cursor ? { cursor } : {}),
    });
    signal?.throwIfAborted();
    if (generation !== undefined && generation !== page.generation)
      throw new Error('The code index changed during traversal. Refresh the graph.');
    generation = page.generation;
    for (const node of page.nodes) nodes.set(node.id, node);
    for (const edge of page.edges) edges.set(edge.id, edge);
    indexLimited ||= page.indexLimited;
    stale ||= page.stale;
    skippedStale += page.skippedStale;
    hierarchy = indexHierarchy(rootId, { nodes: [...nodes.values()], edges: [...edges.values()] });
    if (hierarchy) {
      const reasons: string[] = [];
      if (indexLimited) reasons.push('Workspace indexing reached a size or time limit.');
      if (stale) reasons.push('Some saved source changed. Refresh the code index.');
      if (skippedStale)
        reasons.push(
          `${skippedStale} changed ${skippedStale === 1 ? 'link was' : 'links were'} skipped.`,
        );
      if (!page.traversalComplete && !page.nextCursor)
        reasons.push('The index stopped before every branch was visited.');
      hierarchy.traversal = {
        state: page.nextCursor
          ? 'loading'
          : page.traversalComplete && !reasons.length
            ? 'complete'
            : 'partial',
        visited: nodes.size,
        pending: page.nextCursor ? 1 : 0,
        boundaries: [],
        reasons,
      };
      onProgress?.(hierarchy);
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      if (cursors.has(cursor))
        throw new Error('The index repeated a graph page. Refresh the graph.');
      cursors.add(cursor);
    }
  } while (cursor);
  return hierarchy;
}
