import { describe, expect, it } from 'vitest';
import { type ChartBlock, parseChatPresentation } from './chat-blocks';

function presentation(block: unknown) {
  return { id: 'review_1', title: 'Révision ✨', blocks: [block] };
}
const table = {
  type: 'table',
  columns: [
    { key: 'name', label: 'Name' },
    { key: 'value', label: 'Value' },
  ],
  rows: [
    { name: 'Alpha', value: 42 },
    { name: 'Beta', value: null },
  ],
};
const chart = {
  type: 'chart',
  kind: 'line',
  xKey: 'month',
  series: [{ key: 'orders', label: 'Orders' }],
  data: [{ month: 'June', orders: 4 }, { month: 'July' }],
};
const diagram = {
  type: 'diagram',
  nodes: [
    { id: 'source', label: 'Source' },
    { id: 'target', label: 'Target' },
  ],
  edges: [{ from: 'source', to: 'target', label: 'Calls' }],
};

describe('chat presentation boundary', () => {
  it('accepts the five declarative block types and copies their data', () => {
    const input = {
      id: 'review',
      title: 'Unicode: 日本語',
      blocks: [
        { type: 'markdown', text: '**Read this**' },
        { type: 'callout', tone: 'warning', title: 'Check this', text: 'A note.' },
        table,
        chart,
        diagram,
      ],
    };
    const parsed = parseChatPresentation(input);
    if (!parsed) throw new Error('Valid presentation was rejected.');
    expect(parsed?.blocks.map((block) => block.type)).toEqual([
      'markdown',
      'callout',
      'table',
      'chart',
      'diagram',
    ]);
    expect(parsed?.title).toBe('Unicode: 日本語');
    expect(parsed?.blocks[2]).not.toBe(table);
    expect((parsed.blocks[3] as ChartBlock).data[1]).toEqual({ month: 'July', orders: null });
  });

  it('rejects unsupported fields, executable blocks, and non-record inputs', () => {
    for (const value of [
      null,
      [],
      new Date(),
      {},
      { ...presentation(table), html: '<script />' },
    ]) {
      expect(parseChatPresentation(value)).toBeNull();
    }
    for (const block of [
      { type: 'html', html: '<script />' },
      { type: 'markdown', text: 'Safe', javascript: 'alert(1)' },
      { type: 'callout', tone: 'danger', text: 'Wrong tone' },
      { type: 'markdown', text: () => 'Executable' },
    ]) {
      expect(parseChatPresentation(presentation(block))).toBeNull();
    }
  });

  it('bounds IDs and labels while allowing Unicode text', () => {
    for (const id of ['', 'with space', '日本語', 'x'.repeat(65), '__proto__', 'constructor']) {
      expect(parseChatPresentation({ ...presentation(table), id })).toBeNull();
    }
    expect(parseChatPresentation({ ...presentation(table), id: 'a'.repeat(64) })).not.toBeNull();
    expect(parseChatPresentation({ ...presentation(table), title: 'x'.repeat(257) })).toBeNull();
    expect(
      parseChatPresentation(presentation({ type: 'markdown', text: 'x'.repeat(32_769) })),
    ).toBeNull();
  });

  it('caps block count and the serialized UTF-8 payload, including JSON overhead', () => {
    const block = { type: 'markdown', text: '短い内容' };
    expect(
      parseChatPresentation({ ...presentation(block), blocks: Array(12).fill(block) }),
    ).not.toBeNull();
    expect(
      parseChatPresentation({ ...presentation(block), blocks: Array(13).fill(block) }),
    ).toBeNull();
    const full = { type: 'markdown', text: 'x'.repeat(32_768) };
    expect(
      parseChatPresentation({ ...presentation(full), blocks: Array(4).fill(full) }),
    ).toBeNull();
    const unicode = { type: 'markdown', text: '界'.repeat(30_000) };
    expect(
      parseChatPresentation({ ...presentation(unicode), blocks: [unicode, unicode] }),
    ).toBeNull();
  });

  it('rejects inherited records and cyclic input without throwing', () => {
    expect(parseChatPresentation(presentation(Object.create({ ...table })))).toBeNull();
    const cyclic: Record<string, unknown> = { type: 'markdown' };
    cyclic.text = cyclic;
    expect(parseChatPresentation(presentation(cyclic))).toBeNull();
  });

  it('requires unique table keys and bounded finite scalar cells', () => {
    const invalidTables = [
      { ...table, columns: Array(9).fill(table.columns[0]) },
      { ...table, columns: [table.columns[0], table.columns[0]] },
      { ...table, columns: [{ key: 'name.path', label: 'Name' }] },
      { ...table, rows: Array(101).fill(table.rows[0]) },
      { ...table, rows: [{ extra: 'Unsupported' }] },
      ...[Infinity, NaN, {}, [], undefined, 'x'.repeat(4097)].map((value) => ({
        ...table,
        rows: [{ name: 'Alpha', value }],
      })),
    ];
    for (const block of invalidTables) {
      expect(parseChatPresentation(presentation(block))).toBeNull();
    }
    expect(
      parseChatPresentation(presentation({ ...table, rows: [{ name: '', value: false }, {}] })),
    ).not.toBeNull();
    expect(
      parseChatPresentation(presentation({ ...table, rows: Array(100).fill(table.rows[0]) })),
    ).not.toBeNull();
  });

  it('accepts null and missing chart samples as gaps without coercing strings or booleans', () => {
    const parsed = parseChatPresentation(presentation({ ...chart, data: [{ month: null }, {}] }));
    if (!parsed) throw new Error('Valid chart was rejected.');
    expect((parsed.blocks[0] as ChartBlock).data).toEqual([
      { month: null, orders: null },
      { month: null, orders: null },
    ]);
    for (const data of [
      [{ month: true }],
      [{ month: 'June', orders: '4' }],
      [{ orders: false }],
      [{ orders: Infinity }],
    ]) {
      expect(parseChatPresentation(presentation({ ...chart, data }))).toBeNull();
    }
    expect(parseChatPresentation(presentation({ ...chart, kind: 'pie' }))).toBeNull();
  });

  it('bounds chart size and requires separate unique x and series keys', () => {
    for (const block of [
      { ...chart, series: Array(5).fill(chart.series[0]) },
      { ...chart, series: [chart.series[0], chart.series[0]] },
      { ...chart, series: [{ key: 'month', label: 'Month' }] },
      { ...chart, data: Array(101).fill(chart.data[0]) },
      { ...chart, data: [{ month: 'June', unknown: 5 }] },
    ]) {
      expect(parseChatPresentation(presentation(block))).toBeNull();
    }
    expect(
      parseChatPresentation(presentation({ ...chart, data: Array(100).fill(chart.data[0]) })),
    ).not.toBeNull();
  });

  it('requires unique graph IDs, valid endpoints, and bounded graph size', () => {
    for (const block of [
      { ...diagram, nodes: [diagram.nodes[0], diagram.nodes[0]] },
      { ...diagram, edges: [{ from: 'source', to: 'missing' }] },
      {
        ...diagram,
        nodes: Array.from({ length: 41 }, (_, id) => ({ id: `n${id}`, label: 'Node' })),
      },
      { ...diagram, edges: Array(81).fill(diagram.edges[0]) },
      { ...diagram, direction: 'horizontal' },
    ]) {
      expect(parseChatPresentation(presentation(block))).toBeNull();
    }
    expect(
      parseChatPresentation(
        presentation({ ...diagram, edges: [{ from: 'source', to: 'source' }] }),
      ),
    ).not.toBeNull();
    expect(
      parseChatPresentation(
        presentation({ ...diagram, direction: 'TB', edges: Array(80).fill(diagram.edges[0]) }),
      ),
    ).not.toBeNull();
  });
});
