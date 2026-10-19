import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseChatPresentation } from '@/lib/chat-blocks';
import { ChatBlocks } from './ChatBlocks';

function render(blocks: unknown[]) {
  const presentation = parseChatPresentation({ id: 'test', title: 'Test blocks', blocks });
  if (!presentation) throw new Error('Invalid test blocks.');
  return renderToStaticMarkup(<ChatBlocks blocks={presentation.blocks} />);
}

describe('chat block rendering', () => {
  it('renders Markdown and callouts without executing HTML, URLs, or remote images', () => {
    const markup = render([
      {
        type: 'markdown',
        text: '**Summary**\n\n<script>alert(1)</script>\n\n[Bad link](javascript:alert(1))\n\n![Remote image](https://example.com/tracker.png)',
      },
      {
        type: 'callout',
        tone: 'warning',
        title: '<img src=x onerror=alert(1)>',
        text: '<script>unsafe()</script>',
      },
    ]);
    expect(markup).toContain('<strong>Summary</strong>');
    expect(markup).toContain('role="note"');
    expect(markup).toContain('&lt;script&gt;unsafe()&lt;/script&gt;');
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('href="javascript:');
    expect(markup).not.toContain('src="https://example.com');
    expect(markup).toContain('Remote image');
  });

  it('renders scrollable tables with headers, captions, null values, and escaped cells', () => {
    const markup = render([
      {
        type: 'table',
        caption: 'Comparison',
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'value', label: 'Value' },
        ],
        rows: [
          { name: '<script />', value: false },
          { name: 'Missing value', value: null },
        ],
      },
    ]);
    expect(markup).toContain('aria-label="Scrollable data table" tabindex="0"');
    expect(markup).toContain('<caption>Comparison</caption>');
    expect(markup).toContain('<th scope="col">Value</th>');
    expect(markup).toContain('&lt;script /&gt;');
    expect(markup).toContain('<td>false</td>');
    expect(markup).toContain('<td>Missing</td>');
    expect(markup).not.toContain('<script');
  });

  it.each(['bar', 'line'])(
    'keeps the complete %s chart data available as a semantic table',
    (kind) => {
      const markup = render([
        {
          type: 'chart',
          kind,
          title: 'Orders',
          xKey: 'month',
          xLabel: 'Month',
          yLabel: 'Count',
          series: [{ key: 'paid', label: 'Paid orders' }],
          data: [{ month: 'June', paid: 12 }, { month: 'July' }],
        },
      ]);
      expect(markup).toContain('aria-label="Orders"');
      expect(markup).toContain('View data');
      expect(markup).toContain('<th scope="col">Month</th>');
      expect(markup).toContain('Paid orders');
      expect(markup).toContain('<td>12</td>');
      expect(markup).toContain('<td>Missing</td>');
      expect(markup).toContain('recharts-responsive-container');
    },
  );

  it.each(['LR', 'TB'])(
    'lays out a %s diagram with pan/zoom controls and relationship text',
    (direction) => {
      const markup = render([
        {
          type: 'diagram',
          direction,
          title: 'Order flow',
          nodes: [
            { id: 'order', label: 'Order' },
            { id: 'charge', label: 'Charge' },
          ],
          edges: [
            { from: 'order', to: 'charge', label: 'Calls' },
            { from: 'charge', to: 'order', label: 'Returns' },
          ],
        },
      ]);
      expect(markup).toContain('aria-label="Order flow"');
      expect(markup).toContain('react-flow__controls');
      expect(markup).toContain('View relationships');
      expect(markup).toContain('Order → Charge: Calls');
      expect(markup).toContain('Charge → Order: Returns');
    },
  );

  it('provides readable empty data states', () => {
    const markup = render([
      { type: 'table', columns: [{ key: 'value', label: 'Value' }], rows: [] },
      { type: 'chart', kind: 'line', xKey: 'x', series: [{ key: 'y', label: 'Y' }], data: [] },
      { type: 'diagram', nodes: [{ id: 'only', label: 'Only node' }], edges: [] },
    ]);
    expect(markup).toContain('No rows.');
    expect(markup).toContain('No data.');
    expect(markup).toContain('<li>Only node</li>');
  });
});
