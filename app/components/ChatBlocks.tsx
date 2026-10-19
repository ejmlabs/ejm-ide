import { type EdgeLabel, type GraphLabel, graphlib, layout, type NodeLabel } from '@dagrejs/dagre';
import { Controls, MarkerType, type Node, Position, ReactFlow } from '@xyflow/react';
import { CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import Markdown from 'react-markdown';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import remarkGfm from 'remark-gfm';
import type { ChartBlock, ChatBlock, DiagramBlock, TableBlock } from '@/lib/chat-blocks';
import { useTheme } from '@/lib/theme';
import './chat-blocks.css';

const seriesColors = [
  'var(--ejm-ui-accent)',
  'var(--ejm-ui-success)',
  'var(--ejm-ui-warning)',
  'var(--ejm-ui-special)',
];

function DataTable({ columns, rows, caption }: Omit<TableBlock, 'type'>) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll wide tables.
    <section className="chat-block-table-scroll" aria-label="Scrollable data table" tabIndex={0}>
      <table className="chat-block-table" aria-label={caption ? undefined : 'Data table'}>
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th scope="col" key={column.key}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Declarative rows have no IDs or editable state.
            <tr key={index}>
              {columns.map((column) => (
                <td key={column.key}>
                  {row[column.key] == null ? 'Missing' : String(row[column.key])}
                </td>
              ))}
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={columns.length}>No rows.</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function Chart({ block }: { block: ChartBlock }) {
  const axes = [
    <CartesianGrid key="grid" stroke="var(--ejm-ui-n7)" strokeDasharray="3 3" vertical={false} />,
    <XAxis
      key="x"
      dataKey={block.xKey}
      tick={{ fill: 'var(--ejm-ui-n12)', fontSize: 10 }}
      tickLine={false}
      axisLine={{ stroke: 'var(--ejm-ui-n8)' }}
      minTickGap={16}
      height={block.xLabel ? 38 : 24}
      label={
        block.xLabel
          ? {
              value: block.xLabel,
              position: 'insideBottom',
              fontSize: 10,
              fill: 'var(--ejm-ui-n12)',
            }
          : undefined
      }
    />,
    <YAxis
      key="y"
      width={block.yLabel ? 48 : 36}
      tick={{ fill: 'var(--ejm-ui-n12)', fontSize: 10 }}
      tickLine={false}
      axisLine={false}
      label={
        block.yLabel
          ? {
              value: block.yLabel,
              angle: -90,
              position: 'insideLeft',
              fontSize: 10,
              fill: 'var(--ejm-ui-n12)',
            }
          : undefined
      }
    />,
    <Tooltip
      key="tooltip"
      contentStyle={{
        background: 'var(--ejm-ui-n5)',
        border: '1px solid var(--ejm-ui-n8)',
        borderRadius: 4,
        fontSize: 11,
      }}
      labelStyle={{ color: 'var(--ejm-ui-n14)' }}
      cursor={{
        stroke: 'var(--ejm-ui-n8)',
        fill: 'color-mix(in srgb, var(--ejm-ui-text-strong) 2%, transparent)',
      }}
    />,
    <Legend key="legend" wrapperStyle={{ fontSize: 10 }} iconSize={10} />,
  ];
  const columns = [{ key: block.xKey, label: block.xLabel || block.xKey }, ...block.series];
  return (
    <figure className="chat-block-chart" aria-label={block.title || `${block.kind} chart`}>
      {block.title && <figcaption>{block.title}</figcaption>}
      {block.data.length ? (
        <div className="chat-block-chart-frame">
          <ResponsiveContainer
            width="100%"
            height={200}
            minWidth={0}
            initialDimension={{ width: 280, height: 200 }}
          >
            {block.kind === 'bar' ? (
              <BarChart
                data={block.data}
                margin={{ top: 10, right: 8, left: 0, bottom: 0 }}
                accessibilityLayer
              >
                {axes}
                {block.series.map((series, index) => (
                  <Bar
                    key={series.key}
                    dataKey={series.key}
                    name={series.label}
                    fill={seriesColors[index]}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            ) : (
              <LineChart
                data={block.data}
                margin={{ top: 10, right: 8, left: 0, bottom: 0 }}
                accessibilityLayer
              >
                {axes}
                {block.series.map((series, index) => (
                  <Line
                    key={series.key}
                    dataKey={series.key}
                    name={series.label}
                    stroke={seriesColors[index]}
                    strokeWidth={1.6}
                    dot={{ r: 2 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="chat-block-empty">No data.</p>
      )}
      <details className="chat-block-fallback">
        <summary>View data</summary>
        <DataTable columns={columns} rows={block.data} caption={block.title || 'Chart data'} />
      </details>
    </figure>
  );
}

function Diagram({ block }: { block: DiagramBlock }) {
  const mode = useTheme();
  const graph = useMemo(() => {
    const horizontal = block.direction !== 'TB';
    const graph = new graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true });
    graph.setGraph({ rankdir: horizontal ? 'LR' : 'TB', nodesep: 24, ranksep: 48 });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const node of block.nodes) graph.setNode(node.id, { width: 144, height: 48 });
    block.edges.forEach((edge, index) => {
      graph.setEdge(edge.from, edge.to, {}, String(index));
    });
    layout(graph);
    const nodes: Node[] = block.nodes.map((node) => {
      const position = graph.node(node.id);
      return {
        id: node.id,
        data: { label: node.label },
        position: { x: (position?.x ?? 72) - 72, y: (position?.y ?? 24) - 24 },
        sourcePosition: horizontal ? Position.Right : Position.Bottom,
        targetPosition: horizontal ? Position.Left : Position.Top,
        initialWidth: 144,
        initialHeight: 48,
      };
    });
    return {
      nodes,
      edges: block.edges.map((edge, index) => ({
        id: `edge-${index}`,
        source: edge.from,
        target: edge.to,
        label: edge.label,
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--ejm-ui-n11)' },
        style: { stroke: 'var(--ejm-ui-n10)', strokeWidth: 1.6 },
        labelStyle: { fill: 'var(--ejm-ui-n13)', fontSize: 10 },
        labelBgStyle: { fill: 'var(--ejm-ui-n4)' },
      })),
    };
  }, [block]);
  const labels = new Map(block.nodes.map((node) => [node.id, node.label]));
  return (
    <figure
      className="chat-block-diagram-figure"
      aria-label={block.title || 'Relationship diagram'}
    >
      {block.title && <figcaption>{block.title}</figcaption>}
      <div className="chat-block-diagram">
        <ReactFlow
          key={JSON.stringify(block)}
          colorMode={mode}
          nodes={graph.nodes}
          edges={graph.edges}
          fitView
          fitViewOptions={{ padding: 0.2, minZoom: 1, maxZoom: 1 }}
          minZoom={1}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
        >
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <details className="chat-block-fallback">
        <summary>View relationships</summary>
        <ul>
          {block.nodes.map((node) => (
            <li key={node.id}>{node.label}</li>
          ))}
          {block.edges.map((edge, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Parallel edges have no IDs or editable state.
            <li key={index}>
              {labels.get(edge.from)} → {labels.get(edge.to)}
              {edge.label ? `: ${edge.label}` : ''}
            </li>
          ))}
        </ul>
      </details>
    </figure>
  );
}

function Block({ block }: { block: ChatBlock }) {
  switch (block.type) {
    case 'markdown':
      return (
        <div className="chat-block-markdown markdown">
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              a: ({ href, children }) => (
                <span>
                  {children}
                  {href ? ` (${href})` : ''}
                </span>
              ),
              img: ({ alt }) => <span>{alt || 'Image'}</span>,
            }}
          >
            {block.text}
          </Markdown>
        </div>
      );
    case 'callout': {
      const Icon =
        block.tone === 'success' ? CircleCheck : block.tone === 'warning' ? TriangleAlert : Info;
      return (
        <aside className={`chat-block-callout chat-block-callout-${block.tone}`} role="note">
          <Icon size={14} aria-hidden="true" />
          <div>
            {block.title && <strong>{block.title}</strong>}
            <p>{block.text}</p>
          </div>
        </aside>
      );
    }
    case 'table':
      return <DataTable columns={block.columns} rows={block.rows} caption={block.caption} />;
    case 'chart':
      return <Chart block={block} />;
    case 'diagram':
      return <Diagram block={block} />;
  }
}

export function ChatBlocks({ blocks }: { blocks: ChatBlock[] }) {
  return (
    <div className="chat-blocks">
      {blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Blocks are ordered presentation slots with no supplied IDs.
        <Block key={index} block={block} />
      ))}
    </div>
  );
}
