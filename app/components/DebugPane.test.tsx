import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  HarnessContent,
  HarnessEngine,
  HarnessEvent,
  HarnessEventDetail,
} from '@/lib/harness';
import {
  beginHarnessDetailRefresh,
  HarnessActiveWork,
  HarnessEngineStats,
  HarnessEventInspector,
} from './DebugPane';

vi.mock('@/lib/backend', () => ({ invoke: vi.fn(), isDesktop: false }));

const engine: HarnessEngine = {
  name: 'ejm-harness',
  ready: true,
  state: {
    active_agents: 1,
    model_requests: 2,
    waiting_model_requests: 3,
    tools: {
      running: 4,
      queued: 5,
      heavy_running: 1,
      reserved_cpu_millis: 1500,
      reserved_memory_bytes: 67_108_864,
      reserved_processes: 8,
      reserved_output_bytes: 65_536,
    },
  },
};

describe('shared harness governor', () => {
  it('displays shared admission counts with resource units and labels preview data', () => {
    const markup = renderToStaticMarkup(<HarnessEngineStats engine={engine} sampleData />);
    expect(markup).toContain('Sample · Ready');
    expect(markup).toContain('ejm-harness');
    expect(markup).toContain('<dt>Active agents</dt><dd>1</dd>');
    expect(markup).toContain('<dt>Model requests</dt><dd>2</dd>');
    expect(markup).toContain('<dt>Waiting model requests</dt><dd>3</dd>');
    expect(markup).toContain('<dt>Running tools</dt><dd>4</dd>');
    expect(markup).toContain('<dt>Queued tools</dt><dd>5</dd>');
    expect(markup).toContain('<dt>Heavy tools</dt><dd>1</dd>');
    expect(markup).toContain('<dt>Reserved CPU</dt><dd>1,500 mCPU</dd>');
    expect(markup).toContain('<dt>Reserved memory</dt><dd>64.0 MiB</dd>');
    expect(markup).toContain('<dt>Reserved processes</dt><dd>8</dd>');
    expect(markup).toContain('<dt>Reserved output</dt><dd>64.0 KiB</dd>');
    expect(markup).toContain('Reservations are admission estimates, not measured use.');
    expect(renderToStaticMarkup(<HarnessEngineStats engine={engine} />)).not.toContain('Sample');
  });

  it('does not display stale or fabricated counts before the shared engine starts', () => {
    const markup = renderToStaticMarkup(
      <HarnessEngineStats engine={{ ...engine, ready: false }} />,
    );
    expect(markup).toContain('Not started');
    expect(markup).not.toContain('<dl>');
    expect(markup).not.toContain('Reserved CPU');
  });

  it('shows pending when a ready engine has no state or a native snapshot is unavailable', () => {
    for (const pending of [undefined, { ...engine, state: null }]) {
      const markup = renderToStaticMarkup(<HarnessEngineStats engine={pending} />);
      expect(markup).toContain('Pending');
      expect(markup).toContain('Waiting for a shared engine snapshot.');
      expect(markup).not.toContain('<dl>');
    }
  });
});

const toolEvent: HarnessEvent = {
  id: 8,
  at: 1_800_000,
  connectionId: 1,
  kind: 'tool',
  name: 'workbench_show_ui',
  phase: 'completed',
  durationMs: 43,
  bytes: 2048,
  code: null,
  activityId: 7,
  detailVersion: 2,
  hasContent: true,
};

const toolRequest: HarnessContent = {
  text: '<script>throw new Error("payload")</script>\npath = "src/main.rs"',
  format: 'json',
  originalBytes: 2048,
  redactions: 2,
  truncatedBytes: 512,
};

const toolResponse: HarnessContent = {
  text: '{"ok":true,"title":"Call graph"}',
  format: 'json',
  originalBytes: 38,
  redactions: 0,
  truncatedBytes: 0,
};

const toolDetail: HarnessEventDetail = {
  activityId: 7,
  name: 'workbench_show_ui',
  available: true,
  reason: null,
  request: toolRequest,
  response: toolResponse,
  error: null,
};

function renderInspector(overrides: Partial<ComponentProps<typeof HarnessEventInspector>> = {}) {
  return renderToStaticMarkup(
    <HarnessEventInspector
      event={toolEvent}
      detail={toolDetail}
      loading={false}
      error=""
      {...overrides}
    />,
  );
}

describe('harness event content inspector', () => {
  it('keeps the same activity content mounted while a newer version loads', () => {
    const loaded = {
      activityId: 7,
      key: '7:2:0',
      clearedAt: null,
      detail: toolDetail,
      loading: false,
      error: '',
    };
    const updating = beginHarnessDetailRefresh(loaded, 7, '7:3:0', null);
    expect(updating.detail).toBe(toolDetail);
    expect(updating.loading).toBe(true);
    const markup = renderInspector({
      detail: updating.detail,
      loading: updating.loading,
      error: updating.error,
    });
    expect(markup).toContain('Updating captured content…');
    expect(markup).toContain('aria-label="Arguments content"');
    expect(markup).toContain('aria-label="Result content"');
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).not.toContain('Loading captured content…');
  });

  it('drops retained content when switching activities or clearing capture', () => {
    const loaded = {
      activityId: 7,
      key: '7:2:0',
      clearedAt: null,
      detail: toolDetail,
      loading: false,
      error: '',
    };
    expect(beginHarnessDetailRefresh(loaded, 8, '8:1:0', null).detail).toBeNull();
    expect(beginHarnessDetailRefresh(loaded, 7, '7:3:0', 1_800_001).detail).toBeNull();
  });

  it('shows selectable literal tool arguments and results with copy controls and capture markers', () => {
    const markup = renderInspector();
    expect(markup).toContain('Arguments');
    expect(markup).toContain('Result');
    expect(markup).toContain('aria-label="Copy Arguments"');
    expect(markup).toContain('aria-label="Copy Result"');
    expect(markup).toMatch(
      /<section(?=[^>]*aria-label="Arguments content")(?=[^>]*tabindex="0")[^>]*>/,
    );
    expect(markup).toMatch(
      /<section(?=[^>]*aria-label="Result content")(?=[^>]*tabindex="0")[^>]*>/,
    );
    expect(markup).toContain('<pre>');
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).toContain('\npath = &quot;src/main.rs&quot;');
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('{&quot;ok&quot;:true,&quot;title&quot;:&quot;Call graph&quot;}');
    expect(markup).toContain('Original 2.0 KiB');
    expect(markup).toContain('2 credential values redacted');
    expect(markup).toContain('512 bytes omitted by the capture limit');
  });

  it('labels model request, SSE response, and error content separately', () => {
    const markup = renderInspector({
      event: { ...toolEvent, kind: 'request', name: 'model/complete', phase: 'failed' },
      detail: {
        ...toolDetail,
        name: 'model/complete',
        request: {
          ...toolRequest,
          text: '{"authorization":"[REDACTED]"}',
          redactions: 1,
          truncatedBytes: 0,
        },
        response: {
          ...toolResponse,
          text: 'event: response.output_text.delta\ndata: {"delta":"refresh()"}\n\n',
          format: 'sse',
        },
        error: {
          text: 'Transport error: timeout\n  at retry()',
          format: 'text',
          originalBytes: 44,
          redactions: 0,
          truncatedBytes: 0,
        },
      },
    });
    expect(markup).toContain('aria-label="Copy Request"');
    expect(markup).toContain('aria-label="Copy Response"');
    expect(markup).toContain('aria-label="Copy Error"');
    expect(markup).toContain('aria-label="Request content"');
    expect(markup).toContain('aria-label="Response content"');
    expect(markup).toContain('aria-label="Error content"');
    expect(markup).toContain('1 credential value redacted');
    expect(markup).toContain('event: response.output_text.delta\ndata:');
    expect(markup).toContain('Transport error: timeout\n  at retry()');
    expect(markup).not.toContain('aria-label="Copy Arguments"');
    expect(markup).not.toContain('bytes omitted by the capture limit');
  });

  it('distinguishes no selection from loading content', () => {
    const empty = renderInspector({ event: undefined, detail: null });
    expect(empty).toContain('Select an event to inspect its content.');
    expect(empty).not.toContain('aria-label="Copy Arguments"');
    const loading = renderInspector({ detail: null, loading: true });
    expect(loading).toContain('Loading captured content…');
    expect(loading).not.toContain('&lt;script&gt;');
  });

  it('shows fetch failures with a retry action', () => {
    const markup = renderInspector({
      detail: null,
      error: 'The capture store could not be read.',
      onRetry: vi.fn(),
    });
    expect(markup).toContain('The capture store could not be read.');
    expect(markup).toContain('Retry content');
    expect(markup).not.toContain('&lt;script&gt;');
  });

  it('preserves retained content while explaining why an activity is incomplete', () => {
    const markup = renderInspector({
      detail: {
        ...toolDetail,
        available: false,
        reason: 'The response was evicted from the capture store.',
        response: null,
      },
    });
    expect(markup).toContain('The response was evicted from the capture store.');
    expect(markup).toContain('aria-label="Arguments content"');
    expect(markup).toContain('&lt;script&gt;');
  });

  it('shows a retention fallback and missing content without inventing payloads', () => {
    const markup = renderInspector({
      detail: {
        ...toolDetail,
        available: false,
        reason: null,
        request: null,
        response: null,
      },
    });
    expect(markup).toContain('Content is no longer retained for this activity.');
    expect(markup).not.toContain('<pre');
    const available = renderInspector({
      event: { ...toolEvent, kind: 'request' },
      detail: { ...toolDetail, request: null, response: null },
    });
    expect(available).toContain('No request content recorded.');
    expect(available).toContain('No response content recorded.');
    expect(available).not.toContain('<pre');
  });

  it('explains events with no captured activity', () => {
    const event = { ...toolEvent };
    delete event.activityId;
    delete event.detailVersion;
    delete event.hasContent;
    const markup = renderInspector({ event, detail: null });
    expect(markup).toContain('This event has no request or response payload.');
    expect(markup).not.toContain('<pre');
  });
});

describe('selected trace span content', () => {
  it('shows explicit trace identity, causal parent, elapsed offset and retained-child self time', () => {
    const markup = renderInspector({
      span: {
        id: 7,
        traceId: 'a'.repeat(32),
        parentId: 4,
        connectionId: 1,
        kind: 'tool',
        name: 'workbench_show_ui',
        startedAt: toolEvent.at,
        endedAt: toolEvent.at + 43,
        durationMs: 43,
        status: 'completed',
        code: null,
        detailVersion: 2,
        hasContent: true,
      },
      selfTimeMs: 25,
      traceStartedAt: toolEvent.at - 100,
    });
    expect(markup).toContain('<dt>Span</dt>');
    expect(markup).toContain('<dt>Trace</dt>');
    expect(markup).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(markup).toContain('<dt>Parent</dt><dd>#4</dd>');
    expect(markup).toContain('Start offset</dt><dd>100 ms</dd>');
    expect(markup).toContain('<dt>Self time</dt>');
    expect(markup).toContain('25 ms');
    expect(markup).toContain('retained descendant intervals');
    expect(markup).toContain('aria-label="Arguments content"');
    expect(markup).toContain('aria-label="Result content"');
  });
});

describe('running IDE operation capture', () => {
  it('renders a connectionless operation beside transport work without inventing a connection', () => {
    const markup = renderToStaticMarkup(
      <HarnessActiveWork
        active={[
          {
            id: 41,
            connectionId: null,
            kind: 'operation',
            name: 'file/save',
            startedAt: 1000,
            elapsedMs: 120,
          },
          {
            id: 42,
            connectionId: 9,
            kind: 'request',
            name: 'model/complete',
            startedAt: 1000,
            elapsedMs: 250,
          },
        ]}
      />,
    );
    expect(markup).toContain('aria-label="Active harness work"');
    expect(markup).toContain('title="operation in local IDE"');
    expect(markup).toContain('<code>file/save</code><span>IDE</span><span>120 ms</span>');
    expect(markup).toContain('title="request on connection #9"');
    expect(markup).not.toContain('#null');
  });
});
