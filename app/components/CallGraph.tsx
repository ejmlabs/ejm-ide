import { type EdgeLabel, type GraphLabel, graphlib, layout, type NodeLabel } from '@dagrejs/dagre';
import {
  Controls,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Braces,
  GitFork,
  List,
  LoaderCircle,
  LocateFixed,
  MessageSquarePlus,
  Network,
  Square,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { symbolKey } from '@/lib/code-index';
import { useTheme } from '@/lib/theme';
import type {
  CallDirection,
  CallGraphFrontier,
  CallHierarchy,
  CallRelation,
  SymbolItem,
} from '@/lib/types';
import { basename } from '@/lib/utils';
import { Button } from './ui/button';
import { Tooltip } from './ui/tooltip';

type GraphData = {
  label: string;
  file: string;
  isRoot: boolean;
  boundary?: string;
  symbol: SymbolItem;
  onOpen: (symbol: SymbolItem) => void;
  onAttach: () => void;
  onCenter: () => void;
  onExpand: (direction: CallDirection) => void;
  frontier: CallGraphFrontier[];
  batchSize: number;
  loading: boolean;
};
const NODE_WIDTH = 196;
const NODE_HEIGHT = 52;
const EXPLORE_HEIGHT = 25;

function BranchButton({
  frontier,
  batchSize,
  disabled,
  onExpand,
}: {
  frontier: CallGraphFrontier;
  batchSize: number;
  disabled: boolean;
  onExpand: (symbol: SymbolItem, direction: CallDirection) => void;
}) {
  const callers = frontier.direction === 'incoming';
  const direction = callers ? 'callers' : 'callees';
  const amount = Math.min(frontier.remaining ?? batchSize, batchSize);
  const label = `Reveal up to ${amount} more ${direction} of ${frontier.symbol.name}`;
  return (
    <button
      type="button"
      className="graph-explore nodrag nopan"
      disabled={disabled}
      aria-label={label}
      title={`${label}.${frontier.remaining === undefined ? ' This branch has not been explored yet.' : ` ${frontier.remaining} direct ${direction} remain.`}`}
      onClick={() => onExpand(frontier.symbol, frontier.direction)}
    >
      {callers ? <ArrowDownLeft size={11} /> : <ArrowUpRight size={11} />}
      <span>{callers ? 'Callers' : 'Callees'}</span>
      <small>{frontier.remaining === undefined ? '…' : `+${amount}`}</small>
    </button>
  );
}
function FunctionNode({ data }: NodeProps<Node<GraphData>>) {
  return (
    <div
      className={`function-node ${data.isRoot ? 'root-node' : ''} ${data.boundary ? 'boundary-node' : ''}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="function-main">
        <button
          type="button"
          className="function-open nodrag"
          onClick={() => data.onOpen(data.symbol)}
          onDoubleClick={data.onCenter}
          onKeyDown={(event) => {
            if (event.altKey && event.key === 'Enter') {
              event.preventDefault();
              data.onCenter();
            }
          }}
          aria-keyshortcuts="Alt+Enter"
          title={
            data.boundary || `Open ${data.label}. Double-click or Alt+Enter to center this symbol.`
          }
          draggable
          onDragStart={(event) =>
            event.dataTransfer.setData(
              'application/x-workbench-target',
              JSON.stringify({
                uri: data.symbol.uri,
                ranges: [data.symbol.range],
                kind: 'symbol',
                label: data.symbol.name,
                version: data.symbol.version,
              }),
            )
          }
        >
          <Braces size={17} />
          <span>
            <strong>{data.label}</strong>
            <small>
              {data.file}
              {data.boundary ? ' · boundary' : ''}
            </small>
          </span>
        </button>
        <Tooltip label="Add to chat">
          <Button
            variant="ghost"
            size="icon"
            className="node-attach nodrag"
            aria-label={`Add ${data.label} to chat`}
            onClick={data.onAttach}
          >
            <MessageSquarePlus size={13} />
          </Button>
        </Tooltip>
      </div>
      {!!data.frontier.length && (
        <div className="function-frontier">
          {data.frontier.map((frontier) => (
            <BranchButton
              key={frontier.direction}
              frontier={frontier}
              batchSize={data.batchSize}
              disabled={data.loading}
              onExpand={(_, direction) => data.onExpand(direction)}
            />
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { function: FunctionNode };
interface Props {
  hierarchy: CallHierarchy | null;
  loading: boolean;
  error?: string;
  onInspect: () => void;
  onOpen: (symbol: SymbolItem) => void;
  onAttach: (symbol: SymbolItem, relation?: CallRelation) => void;
  onCenter: (symbol: SymbolItem) => void;
  onExpand: (symbol: SymbolItem, direction: CallDirection) => void;
  onAttachGraph: () => void;
  onCancel?: () => void;
}

export function hierarchyContent(hierarchy: CallHierarchy) {
  const nodes = new Map<string, SymbolItem>([[symbolKey(hierarchy.root), hierarchy.root]]);
  const relations = new Map<string, CallRelation>();
  for (const symbol of hierarchy.nodes || []) nodes.set(symbolKey(symbol), symbol);
  for (const relation of hierarchy.relations || [...hierarchy.incoming, ...hierarchy.outgoing]) {
    const from = symbolKey(relation.from),
      to = symbolKey(relation.to);
    if (!nodes.has(from)) nodes.set(from, relation.from);
    if (!nodes.has(to)) nodes.set(to, relation.to);
    const key = JSON.stringify([from, to, relation.fromRanges]);
    const previous = relations.get(key);
    if (!previous || relation.evidence === 'verified') relations.set(key, relation);
  }
  return { nodes: [...nodes.values()], relations: [...relations.values()] };
}

function sourceLabel(symbol: SymbolItem) {
  try {
    return `${basename(decodeURIComponent(new URL(symbol.uri).pathname))}:${symbol.selectionRange.start.line + 1}`;
  } catch {
    return symbol.uri;
  }
}

export function CallGraph({
  hierarchy,
  loading,
  error,
  onInspect,
  onOpen,
  onAttach,
  onCenter,
  onExpand,
  onAttachGraph,
  onCancel,
}: Props) {
  const mode = useTheme();
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const [direction, setDirection] = useState<'all' | 'incoming' | 'outgoing'>('all');
  const content = useMemo(
    () => (hierarchy ? hierarchyContent(hierarchy) : { nodes: [], relations: [] }),
    [hierarchy],
  );
  const rootKey = hierarchy ? symbolKey(hierarchy.root) : '';
  const traversal = hierarchy?.traversal;
  const crawling = loading || traversal?.state === 'loading';
  const graph = useMemo(() => {
    if (!hierarchy) return { nodes: [], edges: [] };
    const dag = new graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true });
    dag.setGraph({ rankdir: 'LR', ranksep: 72, nodesep: 24, marginx: 18, marginy: 18 });
    dag.setDefaultEdgeLabel(() => ({}));
    const frontiers = new Map<string, CallGraphFrontier[]>();
    for (const frontier of hierarchy.traversal?.frontier || []) {
      const key = symbolKey(frontier.symbol);
      frontiers.set(key, [...(frontiers.get(key) || []), frontier]);
    }
    for (const symbol of content.nodes)
      dag.setNode(symbolKey(symbol), {
        width: NODE_WIDTH,
        height: NODE_HEIGHT + (frontiers.has(symbolKey(symbol)) ? EXPLORE_HEIGHT : 0),
      });
    content.relations.forEach((relation, index) => {
      dag.setEdge(symbolKey(relation.from), symbolKey(relation.to), {}, String(index));
    });
    layout(dag);
    const anchor = dag.node(rootKey);
    const boundaries = new Map(
      hierarchy.traversal?.boundaries.map((item) => [symbolKey(item.symbol), item.reason]),
    );
    return {
      nodes: content.nodes.map((symbol): Node<GraphData> => {
        const id = symbolKey(symbol),
          position = dag.node(id);
        const frontier = frontiers.get(id) || [];
        const height = NODE_HEIGHT + (frontier.length ? EXPLORE_HEIGHT : 0);
        return {
          id,
          type: 'function',
          position: {
            x: (position?.x ?? 0) - (anchor?.x ?? 0),
            y: (position?.y ?? 0) - (anchor?.y ?? 0),
          },
          width: NODE_WIDTH,
          height,
          measured: { width: NODE_WIDTH, height },
          // Static handles survive streamed node replacements and offscreen virtualization.
          handles: [
            {
              type: 'target',
              position: Position.Left,
              x: 0,
              y: height / 2 - 0.5,
              width: 1,
              height: 1,
            },
            {
              type: 'source',
              position: Position.Right,
              x: NODE_WIDTH - 1,
              y: height / 2 - 0.5,
              width: 1,
              height: 1,
            },
          ],
          data: {
            label: symbol.name,
            file: sourceLabel(symbol),
            isRoot: id === rootKey,
            boundary: boundaries.get(id),
            symbol,
            onOpen,
            onAttach: () => onAttach(symbol),
            onCenter: () => onCenter(symbol),
            onExpand: (direction) => onExpand(symbol, direction),
            frontier,
            batchSize: hierarchy.traversal?.batchSize || 20,
            loading: crawling,
          },
        };
      }),
      edges: content.relations.map((relation) => ({
        id: encodeURIComponent(
          JSON.stringify([symbolKey(relation.from), symbolKey(relation.to), relation.fromRanges]),
        ),
        source: symbolKey(relation.from),
        target: symbolKey(relation.to),
        type: 'default',
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: 'var(--ejm-ui-n11)',
          width: 14,
          height: 14,
        },
        label: relation.evidence === 'ambiguous' ? 'ambiguous' : undefined,
        labelStyle: { fill: 'var(--ejm-ui-n13)', fontSize: 10 },
        labelBgStyle: { fill: 'var(--ejm-ui-n4)' },
        style: {
          stroke: 'var(--ejm-ui-n10)',
          strokeWidth: 1.6,
          strokeDasharray:
            relation.evidence && relation.evidence !== 'verified' ? '5 4' : undefined,
        },
      })),
    };
  }, [hierarchy, content, rootKey, onOpen, onAttach, onCenter, onExpand, crawling]);
  const relations = direction === 'all' ? content.relations : hierarchy?.[direction] || [];
  return (
    <section className="hierarchy-pane" aria-label="Call hierarchy">
      <div className="tool-subheader">
        <div className="symbol-heading">
          <Braces size={15} className="accent" />
          <strong>{hierarchy?.root.name || 'At the cursor'}</strong>
          {hierarchy && (
            <span className="muted">
              {hierarchy.incoming.length}
              {traversal?.frontier?.some(
                (item) => item.direction === 'incoming' && symbolKey(item.symbol) === rootKey,
              )
                ? '+'
                : ''}{' '}
              callers · {hierarchy.outgoing.length}
              {traversal?.frontier?.some(
                (item) => item.direction === 'outgoing' && symbolKey(item.symbol) === rootKey,
              )
                ? '+'
                : ''}{' '}
              callees
            </span>
          )}
        </div>
        <div className="header-actions">
          {crawling && onCancel && (
            <Tooltip label="Stop graph crawl">
              <Button variant="ghost" size="icon" aria-label="Stop graph crawl" onClick={onCancel}>
                <Square size={12} />
              </Button>
            </Tooltip>
          )}
          <Tooltip label="Inspect function at cursor">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Inspect function at cursor"
              onClick={onInspect}
              disabled={crawling}
            >
              {crawling ? <LoaderCircle size={14} className="spin" /> : <LocateFixed size={15} />}
            </Button>
          </Tooltip>
          {hierarchy && (
            <Tooltip label="Add graph to chat">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Add graph to chat"
                onClick={onAttachGraph}
              >
                <MessageSquarePlus size={15} />
              </Button>
            </Tooltip>
          )}
          <div className="view-toggle">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Graph view"
              aria-pressed={view === 'graph'}
              onClick={() => setView('graph')}
            >
              <Network size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="List view"
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              <List size={14} />
            </Button>
          </div>
        </div>
      </div>
      {hierarchy && (
        <div className="graph-status" role="status" aria-live="polite" aria-atomic="true">
          <span>
            {content.nodes.length} symbols · {content.relations.length} links
          </span>
          <span className={traversal?.state === 'partial' ? 'graph-partial' : 'muted'}>
            {crawling
              ? `Crawling ${hierarchy.origin === 'index' ? 'indexed' : 'reported'} branches…`
              : traversal?.state === 'partial'
                ? `Partial graph${traversal.frontier?.length ? ` · ${traversal.frontier.length} branches to explore` : ''}`
                : traversal?.state === 'ready'
                  ? `${traversal.frontier?.length || 0} branches to explore · +${traversal.batchSize || 20} per click`
                  : traversal?.state === 'complete'
                    ? `${hierarchy.origin === 'index' ? 'Index' : 'Reported'} traversal complete`
                    : 'Direct calls'}
          </span>
        </div>
      )}
      {hierarchy && (error || !!traversal?.reasons.length || !!traversal?.boundaries.length) && (
        <details className="graph-boundaries">
          <summary>
            {error ||
              (traversal?.boundaries.length
                ? `${traversal.boundaries.length} branch ${traversal.boundaries.length === 1 ? 'boundary' : 'boundaries'}`
                : 'Graph details')}
          </summary>
          <ul>
            {traversal?.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
            {traversal?.boundaries.map((boundary) => (
              <li key={`${symbolKey(boundary.symbol)}:${boundary.direction}`}>
                <strong>{boundary.symbol.name}</strong>: {boundary.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {loading && !hierarchy ? (
        <div className="tool-empty">
          <LoaderCircle className="spin" size={24} />
          <p>Following the call hierarchy…</p>
        </div>
      ) : error && !hierarchy ? (
        <div className="tool-empty">
          <GitFork size={24} />
          <p>{error}</p>
          <Button variant="secondary" size="sm" onClick={onInspect}>
            Try again
          </Button>
        </div>
      ) : !hierarchy ? (
        <div className="tool-empty">
          <Network size={28} />
          <strong>Follow the code.</strong>
          <p>Click a function to follow its callers and callees.</p>
          <Button variant="secondary" size="sm" onClick={onInspect}>
            <LocateFixed size={14} />
            Inspect at cursor
          </Button>
        </div>
      ) : view === 'graph' ? (
        <div className="graph-canvas">
          <ReactFlow
            key={rootKey}
            colorMode={mode}
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.22, minZoom: 0.08, maxZoom: 1 }}
            defaultViewport={{ x: 0, y: 0, zoom: 0.85 }}
            minZoom={0.08}
            maxZoom={1.5}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            onlyRenderVisibleElements
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
          >
            <Controls position="bottom-left" showInteractive={false} />
            <div className="graph-hint">
              {hierarchy.origin === 'index'
                ? 'Index · Dashed links are inferred'
                : traversal?.frontier?.length
                  ? 'Click Callers or Callees to explore'
                  : 'Double-click to center a symbol'}{' '}
              · Drag to pan
            </div>
          </ReactFlow>
        </div>
      ) : (
        <div className="hierarchy-list">
          <div className="text-tabs">
            <button
              type="button"
              className={direction === 'all' ? 'active' : ''}
              onClick={() => setDirection('all')}
            >
              <Network size={13} />
              All links ({content.relations.length})
            </button>
            <button
              type="button"
              className={direction === 'incoming' ? 'active' : ''}
              onClick={() => setDirection('incoming')}
            >
              <ArrowDownLeft size={13} />
              Callers ({hierarchy.incoming.length})
            </button>
            <button
              type="button"
              className={direction === 'outgoing' ? 'active' : ''}
              onClick={() => setDirection('outgoing')}
            >
              <ArrowUpRight size={13} />
              Callees ({hierarchy.outgoing.length})
            </button>
          </div>
          {relations.map((relation) => {
            return (
              <div
                className="relation-row graph-relation"
                key={JSON.stringify([
                  relation.from.uri,
                  relation.fromRanges,
                  relation.to.uri,
                  relation.to.selectionRange,
                ])}
              >
                <div className="relation-endpoints">
                  {(
                    [
                      { symbol: relation.from, side: 'from' },
                      { symbol: relation.to, side: 'to' },
                    ] as const
                  ).map(({ symbol, side }) => (
                    <span key={side}>
                      {side === 'to' && <ArrowRight size={12} className="muted" />}
                      <button
                        type="button"
                        onClick={() => onOpen(symbol)}
                        title={`Open ${symbol.name} in ${sourceLabel(symbol)}`}
                        draggable
                        onDragStart={(event) =>
                          event.dataTransfer.setData(
                            'application/x-workbench-target',
                            JSON.stringify({
                              uri: symbol.uri,
                              ranges: [symbol.range],
                              kind: 'symbol',
                              label: symbol.name,
                              version: symbol.version,
                            }),
                          )
                        }
                      >
                        <Braces size={13} className="accent" />
                        <strong>{symbol.name}</strong>
                        <small>{sourceLabel(symbol)}</small>
                      </button>
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  className="muted call-site-count"
                  title="Add or drag call sites to chat"
                  aria-label={`Add call sites from ${relation.from.name} to ${relation.to.name} to chat`}
                  onClick={() => onAttach(relation.from, relation)}
                  draggable
                  onDragStart={(event) =>
                    event.dataTransfer.setData(
                      'application/x-workbench-target',
                      JSON.stringify({
                        uri: relation.from.uri,
                        ranges: relation.fromRanges,
                        kind: 'caller',
                        label: `${relation.from.name} → ${relation.to.name}`,
                        version: relation.from.version,
                        prefix: `Call evidence: ${relation.evidence || 'language server'}\n`,
                      }),
                    )
                  }
                >
                  {relation.evidence && relation.evidence !== 'verified'
                    ? `${relation.evidence} · `
                    : ''}
                  {relation.fromRanges.length} {relation.fromRanges.length === 1 ? 'site' : 'sites'}
                </button>
                <Tooltip label="Add call sites to chat">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Add call ${relation.from.name} to ${relation.to.name} to chat`}
                    onClick={() => onAttach(relation.from, relation)}
                  >
                    <MessageSquarePlus size={15} />
                  </Button>
                </Tooltip>
              </div>
            );
          })}
          {relations.length === 0 && (
            <div className="empty-line">
              No {direction === 'all' ? 'calls' : direction === 'incoming' ? 'callers' : 'callees'}{' '}
              reported by {hierarchy.origin === 'index' ? 'the index' : 'the language server'}.
            </div>
          )}
          {!!traversal?.frontier?.length && (
            <section className="graph-frontier-list" aria-label="Unexplored branches">
              {traversal.frontier.map((frontier) => (
                <div key={`${symbolKey(frontier.symbol)}:${frontier.direction}`}>
                  <button type="button" onClick={() => onOpen(frontier.symbol)}>
                    {frontier.symbol.name}
                  </button>
                  <BranchButton
                    frontier={frontier}
                    batchSize={traversal.batchSize || 20}
                    disabled={crawling}
                    onExpand={onExpand}
                  />
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
