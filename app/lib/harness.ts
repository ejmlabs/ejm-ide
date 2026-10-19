export type HarnessEventKind =
  | 'connection'
  | 'request'
  | 'turn'
  | 'tool'
  | 'transport'
  | 'operation';
export type HarnessPhase = 'started' | 'completed' | 'failed' | 'cancelled' | 'closed' | 'limit';

export interface HarnessEvent {
  id: number;
  at: number;
  connectionId: number | null;
  kind: HarnessEventKind;
  name: string;
  phase: HarnessPhase;
  durationMs: number | null;
  bytes: number | null;
  code: string | null;
  activityId?: number | null;
  detailVersion?: number;
  hasContent?: boolean;
}

export interface HarnessSpan {
  id: number;
  traceId: string;
  parentId: number | null;
  connectionId: number | null;
  kind: 'request' | 'turn' | 'tool' | 'operation';
  name: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  code: string | null;
  detailVersion: number;
  hasContent: boolean;
}

export interface HarnessContent {
  text: string;
  format: 'json' | 'text' | 'sse';
  originalBytes: number;
  redactions: number;
  truncatedBytes: number;
}

export interface HarnessEventDetail {
  activityId: number;
  name: string;
  available: boolean;
  reason: string | null;
  request: HarnessContent | null;
  response: HarnessContent | null;
  error: HarnessContent | null;
}

export interface HarnessDiagnostics {
  snapshot: HarnessSnapshot;
  details: HarnessEventDetail[];
}

export interface HarnessEngine {
  name: 'ejm-harness';
  ready: boolean;
  state: {
    active_agents: number;
    model_requests: number;
    waiting_model_requests: number;
    tools: {
      running: number;
      queued: number;
      heavy_running: number;
      reserved_cpu_millis: number;
      reserved_memory_bytes: number;
      reserved_processes: number;
      reserved_output_bytes: number;
    };
  } | null;
}

export interface HarnessSnapshot {
  schemaVersion: 1;
  capturedAt: number;
  cursor: number;
  droppedEvents: number;
  activeOmitted: number;
  clearedAt: number | null;
  transport: 'workbench/http-sse';
  approvalPolicy: 'auto-review';
  engine: HarnessEngine;
  limits: {
    eventCapacity: number;
    activityCapacity: number;
    connectionCapacity: number;
    rpcTimeoutMs: number;
    writeTimeoutMs: number;
    approvalTimeoutMs: number;
    maxFrameBytes: number;
    maxInputBytes: number;
    maxTurnOutputBytes: number;
    maxTurnEvents: number;
    maxPendingRequests: number;
    maxModelRounds?: number;
    maxToolCalls?: number;
  };
  counters: {
    connectionsOpened: number;
    connectionsClosed: number;
    requestsStarted: number;
    requestsCompleted: number;
    requestsFailed: number;
    requestsCancelled: number;
    turnsStarted: number;
    turnsCompleted: number;
    turnsFailed: number;
    turnsCancelled: number;
    toolsStarted: number;
    toolsCompleted: number;
    toolsFailed: number;
    toolsCancelled: number;
    bytesSent: number;
    bytesReceived: number;
    notificationsReceived: number;
  };
  connections: {
    id: number;
    kind: 'control' | 'chat' | 'completion';
    state: 'connected' | 'closed';
    openedAt: number;
    closedAt: number | null;
    requests: number;
    bytesSent: number;
    bytesReceived: number;
  }[];
  active: {
    id: number;
    connectionId: number | null;
    kind: 'request' | 'turn' | 'tool' | 'operation';
    name: string;
    startedAt: number;
    elapsedMs: number;
  }[];
  events: HarnessEvent[];
  spans?: HarnessSpan[];
  droppedSpans?: number;
  tools: { name: string; kind: 'index' | 'presentation' | 'file' }[];
  capture: {
    storedBytes: number;
    maxBytes: number;
    retainedActivities: number;
    evictedActivities: number;
    maxContentBytes: number;
  };
  privacy: { localOnly: true; contentLogged: true; credentialsRedacted: true };
}

export function filterHarnessEvents(
  events: HarnessEvent[],
  query: string,
  kind: HarnessEventKind | 'all',
  errorsOnly: boolean,
) {
  const needle = query.trim().toLowerCase();
  return events
    .filter(
      (event) =>
        (kind === 'all' || event.kind === kind) &&
        (!errorsOnly || event.phase === 'failed' || event.phase === 'limit') &&
        (!needle ||
          [event.name, event.kind, event.phase, event.code, event.connectionId]
            .join(' ')
            .toLowerCase()
            .includes(needle)),
    )
    .sort((a, b) => b.id - a.id);
}

export function harnessDuration(milliseconds: number | null) {
  if (milliseconds === null) return '';
  return milliseconds < 1000
    ? `${Math.round(milliseconds)} ms`
    : `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}

export function harnessBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// Native capture owns credential redaction. Preserve all supplied fields in local exports.
export function harnessDiagnosticReport(
  snapshot: HarnessSnapshot,
  sampleData = false,
  details: HarnessEventDetail[] = [],
) {
  return JSON.stringify(
    {
      ...snapshot,
      format: 'workbench-harness-diagnostics/v1',
      sampleData,
      details,
    },
    null,
    2,
  );
}

export function previewHarnessSnapshot(now = Date.now()): HarnessSnapshot {
  const start = now - 28_000;
  const details = previewHarnessDetails();
  const spans = previewHarnessSpans(now);
  const events: HarnessEvent[] = [
    {
      id: 1,
      at: start,
      connectionId: 1,
      kind: 'connection',
      name: 'chat',
      phase: 'started',
      durationMs: null,
      bytes: null,
      code: null,
    },
  ];
  for (const span of spans) {
    const event: HarnessEvent = {
      id: 0,
      at: span.startedAt,
      connectionId: span.connectionId,
      kind: span.kind,
      name: span.name,
      phase: 'started',
      durationMs: null,
      bytes: null,
      code: null,
      activityId: span.id,
      detailVersion: span.detailVersion,
      hasContent: span.hasContent,
    };
    events.push(event);
    if (span.status !== 'running')
      events.push({
        ...event,
        at: span.endedAt ?? span.startedAt + span.durationMs,
        phase: span.status,
        durationMs: span.durationMs,
        code: span.code,
      });
  }
  events.sort((a, b) => a.at - b.at);
  events.forEach((event, index) => {
    event.id = index + 1;
  });
  return {
    schemaVersion: 1,
    capturedAt: now,
    cursor: events.length,
    droppedEvents: 0,
    activeOmitted: 0,
    clearedAt: null,
    transport: 'workbench/http-sse',
    approvalPolicy: 'auto-review',
    engine: {
      name: 'ejm-harness',
      ready: true,
      state: {
        active_agents: 0,
        model_requests: 0,
        waiting_model_requests: 0,
        tools: {
          running: 0,
          queued: 0,
          heavy_running: 0,
          reserved_cpu_millis: 0,
          reserved_memory_bytes: 0,
          reserved_processes: 0,
          reserved_output_bytes: 0,
        },
      },
    },
    limits: {
      eventCapacity: 400,
      activityCapacity: 96,
      connectionCapacity: 16,
      rpcTimeoutMs: 120_000,
      writeTimeoutMs: 0,
      approvalTimeoutMs: 120_000,
      maxFrameBytes: 4_194_304,
      maxInputBytes: 262_144,
      maxTurnOutputBytes: 16_777_216,
      maxTurnEvents: 20_000,
      maxPendingRequests: 4,
      maxModelRounds: 24,
      maxToolCalls: 64,
    },
    counters: {
      connectionsOpened: 1,
      connectionsClosed: 0,
      requestsStarted: 4,
      requestsCompleted: 3,
      requestsFailed: 1,
      requestsCancelled: 0,
      turnsStarted: 1,
      turnsCompleted: 1,
      turnsFailed: 0,
      turnsCancelled: 0,
      toolsStarted: 2,
      toolsCompleted: 1,
      toolsFailed: 1,
      toolsCancelled: 0,
      bytesSent: 4200,
      bytesReceived: 14_800,
      notificationsReceived: 12,
    },
    connections: [
      {
        id: 1,
        kind: 'chat',
        state: 'connected',
        openedAt: start,
        closedAt: null,
        requests: 4,
        bytesSent: 4200,
        bytesReceived: 14_800,
      },
    ],
    active: [],
    events,
    spans,
    droppedSpans: 0,
    tools: [
      { name: 'workbench_search_code', kind: 'index' },
      { name: 'workbench_code_neighbors', kind: 'index' },
      { name: 'workbench_show_ui', kind: 'presentation' },
      { name: 'workbench_open_file', kind: 'presentation' },
      { name: 'workbench_highlight_code', kind: 'presentation' },
      { name: 'workbench_show_hint', kind: 'presentation' },
      { name: 'workbench_clear_presentation', kind: 'presentation' },
      { name: 'workbench_read_file', kind: 'file' },
      { name: 'workbench_write_file', kind: 'file' },
    ],
    capture: {
      storedBytes: details.reduce(
        (total, detail) =>
          total +
          [detail.request, detail.response, detail.error].reduce(
            (bytes, content) =>
              bytes + (content ? new TextEncoder().encode(content.text).length : 0),
            0,
          ),
        0,
      ),
      maxBytes: 134_217_728,
      retainedActivities: details.length,
      evictedActivities: 0,
      maxContentBytes: 33_554_432,
    },
    privacy: { localOnly: true, contentLogged: true, credentialsRedacted: true },
  };
}

export function previewHarnessSpans(now = Date.now()): HarnessSpan[] {
  const start = now - 28_000;
  const success = 'b56b29644a0648609de7b3c068710d39';
  const failed = 'd721473190b740e4a0eb9aa4b2164aca';
  const span = (
    id: number,
    traceId: string,
    parentId: number | null,
    kind: HarnessSpan['kind'],
    name: string,
    offset: number,
    durationMs: number,
    status: HarnessSpan['status'] = 'completed',
    code: string | null = null,
  ): HarnessSpan => ({
    id,
    traceId,
    parentId,
    connectionId: 1,
    kind,
    name,
    startedAt: start + offset,
    endedAt: start + offset + durationMs,
    durationMs,
    status,
    code,
    detailVersion: 2,
    hasContent: true,
  });
  return [
    span(6, success, null, 'turn', 'Explain order validation', 0, 4700),
    span(2, success, 6, 'request', 'model/list', 4, 42),
    span(4, success, 6, 'request', 'model/complete', 55, 1200),
    span(7, success, 4, 'tool', 'workbench_show_ui', 1450, 43),
    span(12, success, 7, 'operation', 'editor/open_file', 1452, 20),
    span(13, success, 6, 'request', 'model/complete', 1600, 3100),
    span(
      14,
      failed,
      null,
      'operation',
      'Apply proposed edit',
      6000,
      2300,
      'failed',
      'review_timeout',
    ),
    span(15, failed, 14, 'tool', 'workbench_write_file', 6050, 2150, 'failed', 'review_timeout'),
    span(10, failed, 15, 'request', 'model/review', 6100, 2000, 'failed', 'timeout'),
  ];
}

export function previewHarnessDetails(): HarnessEventDetail[] {
  const content = (
    text: string,
    format: HarnessContent['format'],
    redactions = 0,
  ): HarnessContent => ({
    text,
    format,
    originalBytes: new TextEncoder().encode(text).length,
    redactions,
    truncatedBytes: 0,
  });
  const json = (value: unknown, redactions = 0) =>
    content(JSON.stringify(value, null, 2), 'json', redactions);
  return [
    {
      activityId: 2,
      name: 'model/list',
      available: true,
      reason: null,
      request: json({ method: 'model/list', params: {} }),
      response: json({ models: [{ id: 'sample-model', efforts: ['low', 'medium', 'high'] }] }),
      error: null,
    },
    {
      activityId: 4,
      name: 'model/complete',
      available: true,
      reason: null,
      request: json(
        {
          method: 'POST',
          url: 'https://api.example.test/v1/responses',
          headers: { Authorization: 'Bearer [REDACTED:credential]' },
          body: {
            model: 'sample-model',
            messages: [{ role: 'user', content: 'Explain the order validation flow.' }],
            reasoning: { effort: 'medium' },
          },
        },
        1,
      ),
      response: content(
        'event: response.output_text.delta\ndata: {"delta":"Orders are validated before payment."}\n\nevent: response.completed\ndata: {"status":"completed"}\n\n',
        'sse',
      ),
      error: null,
    },
    {
      activityId: 6,
      name: 'turn',
      available: true,
      reason: null,
      request: json({ input: 'Show how an order is validated.', context: ['src/orders.rs:18'] }),
      response: json({
        status: 'completed',
        output: 'Validation checks stock and payment details.',
      }),
      error: null,
    },
    {
      activityId: 7,
      name: 'workbench_show_ui',
      available: true,
      reason: null,
      request: json({
        title: 'Order validation',
        blocks: [
          { type: 'table', columns: ['Stage', 'Status'], rows: [['Validation', 'Complete']] },
        ],
      }),
      response: json({ shown: true, blocks: 1 }),
      error: null,
    },
    {
      activityId: 10,
      name: 'model/review',
      available: true,
      reason: null,
      request: json({
        policy: 'auto-review',
        tool: 'workbench_write_file',
        arguments: {
          path: 'src/orders.rs',
          content: 'pub fn validate_order() -> bool { true }',
        },
      }),
      response: null,
      error: json({
        code: 'timeout',
        message: 'The sample review request timed out after 2000 ms.',
      }),
    },
    {
      activityId: 12,
      name: 'editor/open_file',
      available: true,
      reason: null,
      request: json({ path: 'src/orders.rs', line: 18 }),
      response: json({ opened: true, pane: 'main' }),
      error: null,
    },
    {
      activityId: 13,
      name: 'model/complete',
      available: true,
      reason: null,
      request: json({
        model: 'sample-model',
        input: [{ type: 'function_call_output', call_id: 'sample-call', output: { shown: true } }],
      }),
      response: content(
        'event: response.output_text.delta\ndata: {"delta":"The table shows each validation stage."}\n\nevent: response.completed\ndata: {"status":"completed"}\n\n',
        'sse',
      ),
      error: null,
    },
    {
      activityId: 14,
      name: 'Apply proposed edit',
      available: true,
      reason: null,
      request: json({ path: 'src/orders.rs', source: 'agent' }),
      response: null,
      error: json({
        code: 'review_timeout',
        message: 'The edit was not applied because auto review timed out.',
      }),
    },
    {
      activityId: 15,
      name: 'workbench_write_file',
      available: true,
      reason: null,
      request: json({ path: 'src/orders.rs', content: 'pub fn validate_order() -> bool { true }' }),
      response: null,
      error: json({ code: 'review_timeout', applied: false }),
    },
  ];
}
