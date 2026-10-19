import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { HarnessSpan } from '@/lib/harness';
import { groupHarnessTraces } from '@/lib/harness-traces';
import { TraceWaterfall } from './TraceWaterfall';

const root: HarnessSpan = {
  id: 1,
  traceId: 'a'.repeat(32),
  parentId: null,
  connectionId: 1,
  kind: 'turn',
  name: 'turn',
  startedAt: 1000,
  endedAt: 2000,
  durationMs: 1000,
  status: 'completed',
  code: null,
  detailVersion: 1,
  hasContent: true,
};
const child: HarnessSpan = {
  ...root,
  id: 2,
  parentId: 1,
  name: 'model <request>',
  kind: 'request',
  startedAt: 1100,
  endedAt: 1800,
  durationMs: 700,
  status: 'failed',
};
const trace = groupHarnessTraces([root, child])[0];

function render(spans = [root, child], selectedId = 2) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <TraceWaterfall
        trace={groupHarnessTraces(spans)[0]}
        selectedId={selectedId}
        onSelect={vi.fn()}
      />
    </TooltipProvider>,
  );
}

describe('compact trace waterfall', () => {
  it('exposes a keyboard treegrid with nested rows, current selection and common relative timing', () => {
    const markup = render();
    expect(markup).toContain('role="treegrid" aria-label="Trace spans"');
    expect(markup).toContain('aria-rowcount="3" aria-colcount="3"');
    expect(markup).toMatch(/<tr[^>]+aria-level="1"[^>]+aria-expanded="true"/);
    expect(markup).toMatch(/<tr[^>]+aria-level="2"[^>]+aria-selected="true"[^>]+tabindex="0"/);
    expect(markup).toContain('model &lt;request&gt;');
    expect(markup).not.toContain('model <request>');
    expect(markup).toContain('starts 100 ms, duration 700 ms, failed');
    expect(markup).toContain('left:10%;width:70%');
    expect(markup).toContain('aria-label="Collapse turn"');
    expect(markup).toContain('aria-label="Copy trace ID"');
    expect(markup).toContain('aria-label="Fit waterfall"');
    expect(markup).toContain('aria-label="Zoom in waterfall"');
    expect(markup).not.toContain('critical path');
  });

  it('keeps missing ancestors explicit and distinguishes running and cancelled spans', () => {
    const markup = render([
      { ...root, status: 'running', endedAt: null },
      { ...child, parentId: 404, status: 'cancelled' },
    ]);
    expect(markup).toContain('Incomplete trace: 1 parent span is no longer retained.');
    expect(markup).toContain('aria-label="Parent not retained"');
    expect(markup).toContain('aria-label="running"');
    expect(markup).toContain('aria-label="cancelled"');
    expect(trace.status).toBe('failed');
  });
});
