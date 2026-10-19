import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import type { ReactFlowProps } from '@xyflow/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CallHierarchy, CallRelation, SymbolItem } from '@/lib/types';
import { CallGraph, hierarchyContent } from './CallGraph';

vi.mock('@/lib/backend', () => ({ invoke: vi.fn() }));
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    ReactFlow: (props: ReactFlowProps) => (
      <actual.ReactFlow
        {...props}
        width={6000}
        height={6000}
        defaultViewport={{ x: 3000, y: 3000, zoom: 1 }}
      />
    ),
  };
});

const symbol = (id: number): SymbolItem => ({
  name: `function_${id}`,
  kind: 12,
  uri: 'file:///workspace/example.rs',
  range: { start: { line: id * 5, character: 0 }, end: { line: id * 5 + 4, character: 1 } },
  selectionRange: {
    start: { line: id * 5, character: 3 },
    end: { line: id * 5, character: 15 },
  },
});
const call = (from: SymbolItem, to: SymbolItem): CallRelation => ({
  from,
  to,
  fromRanges: [from.range],
  evidence: 'verified',
});
const root = symbol(0);
const branches = Array.from({ length: 12 }, (_, index) => symbol(index + 1));
const shared = symbol(20);
const deep = symbol(21);
const outgoing = branches.map((target) => call(root, target));
const incoming = [call(deep, root)];
const hierarchy: CallHierarchy = {
  root,
  incoming,
  outgoing,
  relations: [
    ...outgoing,
    call(branches[0], shared),
    call(branches[1], shared),
    call(shared, deep),
    ...incoming,
    outgoing[0],
  ],
  traversal: { state: 'complete', visited: 15, pending: 0, boundaries: [], reasons: [] },
};

function render(value: CallHierarchy) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <CallGraph
        hierarchy={value}
        loading={false}
        onInspect={vi.fn()}
        onOpen={vi.fn()}
        onAttach={vi.fn()}
        onCenter={vi.fn()}
        onExpand={vi.fn()}
        onAttachGraph={vi.fn()}
        onCancel={vi.fn()}
      />
    </TooltipProvider>,
  );
}

describe('call graph', () => {
  it('retains more than eight branches, deep links, shared callees, and recursion', () => {
    const content = hierarchyContent(hierarchy);
    expect(content.nodes).toHaveLength(15);
    expect(content.relations).toHaveLength(16);
    expect(content.nodes).toContain(deep);
    expect(content.relations).toContain(incoming[0]);
    expect(content.relations.filter((relation) => relation.to === shared)).toHaveLength(2);
  });

  it('retains legacy direct hierarchies without duplicating recursive roots', () => {
    const recursive = call(root, root);
    const content = hierarchyContent({ root, incoming: [recursive], outgoing: [recursive] });
    expect(content.nodes).toEqual([root]);
    expect(content.relations).toEqual([recursive]);
  });

  it('draws every link before DOM measurement, including shared paths and recursion', () => {
    const markup = render({
      ...hierarchy,
      relations: [...(hierarchy.relations || []), call(deep, deep)],
    });
    expect(markup.match(/class="react-flow__edge-path"/g) || []).toHaveLength(17);
  });

  it('anchors the root at the same position as later branches arrive', () => {
    const initial = render({ root, incoming: [], outgoing: [] });
    const completed = render(hierarchy);
    const rootStyle = (markup: string) =>
      markup.match(/class="react-flow__node react-flow__node-function[^"]*" style="([^"]+)"/)?.[1];
    expect(rootStyle(initial)).toContain('transform:translate(0px,0px)');
    expect(rootStyle(completed)).toContain('transform:translate(0px,0px)');
  });

  it('shows complete graph counts separately from direct callers and callees, with pan controls', () => {
    const markup = render(hierarchy);
    expect(markup).toContain('15');
    expect(markup).toContain('symbols · 16');
    expect(markup).toContain('links');
    expect(markup).toContain('12');
    expect(markup).toContain('callees');
    expect(markup).toContain('Reported traversal complete');
    expect(markup).toContain('react-flow__controls');
    expect(markup).toContain('aria-label="Fit View"');
    expect(markup.match(/class="function-node/g)).toHaveLength(15);
    expect(markup).toContain('function_21');
  });

  it('shows partial boundaries and a stop action while a crawl is running', () => {
    const partial = render({
      ...hierarchy,
      traversal: {
        state: 'loading',
        visited: 15,
        pending: 2,
        boundaries: [
          { symbol: deep, direction: 'outgoing', reason: 'Dependency source is unavailable.' },
        ],
        reasons: ['One request was unsupported.'],
      },
    });
    expect(partial).toContain('Crawling reported branches');
    expect(partial).toContain('Stop graph crawl');
    expect(partial).toContain('1 branch boundary');
    expect(partial).toContain('Dependency source is unavailable.');
    expect(partial).toContain('One request was unsupported.');
  });

  it('shows directional reveal controls and never calls an expandable graph complete', () => {
    const markup = render({
      ...hierarchy,
      traversal: {
        state: 'ready',
        visited: 4,
        pending: 2,
        batchSize: 20,
        boundaries: [],
        reasons: [],
        frontier: [
          { symbol: root, direction: 'outgoing', remaining: 55 },
          { symbol: deep, direction: 'incoming' },
        ],
      },
    });
    expect(markup).toContain('2 branches to explore · +20 per click');
    expect(markup).toContain('aria-label="Reveal up to 20 more callees of function_0"');
    expect(markup).toContain('55 direct callees remain.');
    expect(markup).toContain('aria-label="Reveal up to 20 more callers of function_21"');
    expect(markup).toContain('This branch has not been explored yet.');
    expect(markup).not.toContain('traversal complete');
    expect(markup.match(/class="react-flow__edge-path"/g) || []).toHaveLength(16);
  });
});
