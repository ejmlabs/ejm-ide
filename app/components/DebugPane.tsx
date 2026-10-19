import {
  Activity,
  AlertCircle,
  Check,
  ChevronRight,
  Copy,
  Download,
  LoaderCircle,
  Pause,
  Play,
  Plug,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { invoke, isDesktop } from '@/lib/backend';
import {
  filterHarnessEvents,
  type HarnessContent,
  type HarnessDiagnostics,
  type HarnessEngine,
  type HarnessEvent,
  type HarnessEventDetail,
  type HarnessEventKind,
  type HarnessSnapshot,
  type HarnessSpan,
  harnessBytes,
  harnessDiagnosticReport,
  harnessDuration,
  previewHarnessDetails,
  previewHarnessSnapshot,
} from '@/lib/harness';
import {
  groupHarnessTraces,
  spanSelfTime,
  traceMatches,
  traceRows,
  traceSpanEvent,
} from '@/lib/harness-traces';
import { TraceWaterfall } from './TraceWaterfall';
import { Button } from './ui/button';
import { Tooltip } from './ui/tooltip';
import './debug.css';

const views = ['Traces', 'Activity', 'Connections', 'Tools', 'Limits'] as const;
type DebugView = (typeof views)[number];

interface HarnessDetailState {
  activityId: number;
  key: string;
  clearedAt: number | null;
  detail: HarnessEventDetail | null;
  loading: boolean;
  error: string;
}

export function beginHarnessDetailRefresh(
  previous: HarnessDetailState | null,
  activityId: number,
  key: string,
  clearedAt: number | null,
): HarnessDetailState {
  return {
    activityId,
    key,
    clearedAt,
    detail:
      previous?.activityId === activityId && previous.clearedAt === clearedAt
        ? previous.detail
        : null,
    loading: true,
    error: '',
  };
}

function clockTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function EventIcon({ event }: { event: HarnessEvent }) {
  if (event.phase === 'failed' || event.phase === 'limit') return <AlertCircle size={13} />;
  if (event.kind === 'tool') return <Wrench size={13} />;
  if (event.kind === 'connection' || event.kind === 'transport') return <Plug size={13} />;
  return <ChevronRight size={13} />;
}

function ContentBlock({ label, content }: { label: string; content: HarnessContent }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(content.text);
      setError('');
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch (reason) {
      setError(`Could not copy ${label.toLowerCase()}: ${String(reason)}`);
    }
  }
  return (
    <section className="debug-content-block" aria-label={label}>
      <div className="debug-content-heading">
        <h3>{label}</h3>
        <span>{content.format.toUpperCase()}</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Copy ${label}`}
          onClick={() => void copy()}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </Button>
      </div>
      <div className="debug-content-markers">
        <span>Original {harnessBytes(content.originalBytes)}</span>
        {content.redactions > 0 && (
          <span className="debug-content-redaction">
            {content.redactions.toLocaleString()} credential value
            {content.redactions === 1 ? '' : 's'} redacted
          </span>
        )}
        {content.truncatedBytes > 0 && (
          <span className="debug-content-truncation">
            {content.truncatedBytes.toLocaleString()} bytes omitted by the capture limit
          </span>
        )}
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Captured payloads need keyboard focus for scrolling and text selection. */}
      <section className="debug-content-text" aria-label={`${label} content`} tabIndex={0}>
        <pre>{content.text}</pre>
      </section>
      {error && (
        <p className="debug-content-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function HarnessEventInspector({
  event,
  span,
  selfTimeMs,
  traceStartedAt,
  detail,
  loading,
  error,
  onRetry,
}: {
  event: HarnessEvent | undefined;
  span?: HarnessSpan;
  selfTimeMs?: number;
  traceStartedAt?: number;
  detail: HarnessEventDetail | null;
  loading: boolean;
  error: string;
  onRetry?: () => void;
}) {
  if (!event) return <p className="debug-empty-detail">Select an event to inspect its content.</p>;
  const requestLabel = event.kind === 'tool' ? 'Arguments' : 'Request';
  const responseLabel = event.kind === 'tool' ? 'Result' : 'Response';
  return (
    <div className="debug-event-detail">
      <strong>{event.name}</strong>
      <dl>
        <dt>{span ? 'Span' : 'Event'}</dt>
        <dd>#{event.id}</dd>
        <dt>Type</dt>
        <dd>{event.kind}</dd>
        <dt>Status</dt>
        <dd className={`debug-phase-${event.phase}`}>{span?.status || event.phase}</dd>
        <dt>{span ? 'Started' : 'Time'}</dt>
        <dd>{new Date(event.at).toLocaleString()}</dd>
        {span && (
          <>
            <dt>Trace</dt>
            <dd>
              <code>{span.traceId}</code>
            </dd>
            <dt>Parent</dt>
            <dd>{span.parentId === null ? 'Root span' : `#${span.parentId}`}</dd>
            {traceStartedAt !== undefined && (
              <>
                <dt title="From the first retained span in this trace.">Start offset</dt>
                <dd>{harnessDuration(Math.max(0, span.startedAt - traceStartedAt))}</dd>
              </>
            )}
            {selfTimeMs !== undefined && (
              <>
                <dt>Self time</dt>
                <dd title="Excludes the union of retained descendant intervals.">
                  {harnessDuration(selfTimeMs)}
                </dd>
              </>
            )}
            <dt>Ended</dt>
            <dd>
              {span.endedAt === null ? 'Still running' : new Date(span.endedAt).toLocaleString()}
            </dd>
          </>
        )}
        <dt>Connection</dt>
        <dd>
          {event.connectionId === null
            ? event.kind === 'operation'
              ? 'Local IDE'
              : 'None'
            : `#${event.connectionId}`}
        </dd>
        {event.activityId !== null && event.activityId !== undefined && (
          <>
            <dt>Activity</dt>
            <dd>#{event.activityId}</dd>
          </>
        )}
        {event.durationMs !== null && (
          <>
            <dt>Duration</dt>
            <dd>{harnessDuration(event.durationMs)}</dd>
          </>
        )}
        {event.bytes !== null && (
          <>
            <dt>Transfer</dt>
            <dd>{harnessBytes(event.bytes)}</dd>
          </>
        )}
        {event.code && (
          <>
            <dt>Code</dt>
            <dd>
              <code>{event.code}</code>
            </dd>
          </>
        )}
      </dl>
      {loading && (
        <p className="debug-content-state" role="status">
          {detail ? 'Updating captured content…' : 'Loading captured content…'}
        </p>
      )}
      {error && (
        <div className="debug-content-error" role="alert">
          <p>{error}</p>
          {onRetry && (
            <Button variant="ghost" size="sm" onClick={onRetry}>
              Retry content
            </Button>
          )}
        </div>
      )}
      {!loading && !error && !detail && (
        <p className="debug-content-state">This event has no request or response payload.</p>
      )}
      {detail && (
        <div className="debug-content-sections">
          {(!detail.available || detail.reason) && (
            <p className="debug-content-state">
              {detail.reason || 'Content is no longer retained for this activity.'}
            </p>
          )}
          {detail.request ? (
            <ContentBlock label={requestLabel} content={detail.request} />
          ) : (
            <p className="debug-content-state">No {requestLabel.toLowerCase()} content recorded.</p>
          )}
          {detail.response ? (
            <ContentBlock label={responseLabel} content={detail.response} />
          ) : (
            <p className="debug-content-state">
              No {responseLabel.toLowerCase()} content recorded.
            </p>
          )}
          {detail.error && <ContentBlock label="Error" content={detail.error} />}
        </div>
      )}
    </div>
  );
}

export function HarnessEngineStats({
  engine,
  sampleData = false,
}: {
  engine: HarnessEngine | undefined;
  sampleData?: boolean;
}) {
  const state = engine?.ready ? engine.state : null;
  const status = engine && !engine.ready ? 'Not started' : state ? 'Ready' : 'Pending';
  return (
    <section className="debug-engine" aria-label="Shared harness governor">
      <div className="debug-engine-heading">
        <h3>Shared engine</h3>
        <code>{engine?.name || 'ejm-harness'}</code>
        <span>
          {sampleData && 'Sample · '}
          {status}
        </span>
      </div>
      {state ? (
        <>
          <dl>
            <dt>Active agents</dt>
            <dd>{state.active_agents.toLocaleString()}</dd>
            <dt>Running tools</dt>
            <dd>{state.tools.running.toLocaleString()}</dd>
            <dt>Model requests</dt>
            <dd>{state.model_requests.toLocaleString()}</dd>
            <dt>Queued tools</dt>
            <dd>{state.tools.queued.toLocaleString()}</dd>
            <dt>Waiting model requests</dt>
            <dd>{state.waiting_model_requests.toLocaleString()}</dd>
            <dt>Heavy tools</dt>
            <dd>{state.tools.heavy_running.toLocaleString()}</dd>
            <dt>Reserved CPU</dt>
            <dd>{state.tools.reserved_cpu_millis.toLocaleString()} mCPU</dd>
            <dt>Reserved memory</dt>
            <dd>{harnessBytes(state.tools.reserved_memory_bytes)}</dd>
            <dt>Reserved processes</dt>
            <dd>{state.tools.reserved_processes.toLocaleString()}</dd>
            <dt>Reserved output</dt>
            <dd>{harnessBytes(state.tools.reserved_output_bytes)}</dd>
          </dl>
          <p className="debug-note">Reservations are admission estimates, not measured use.</p>
        </>
      ) : (
        <p className="debug-note">
          {engine && !engine.ready
            ? 'Resource counts appear when the shared engine starts.'
            : 'Waiting for a shared engine snapshot.'}
        </p>
      )}
    </section>
  );
}

export function HarnessActiveWork({ active }: { active: HarnessSnapshot['active'] }) {
  if (!active.length) return null;
  return (
    <section className="debug-active" aria-label="Active harness work">
      {active.map((item) => (
        <span
          key={item.id}
          title={
            item.connectionId === null
              ? `${item.kind} in local IDE`
              : `${item.kind} on connection #${item.connectionId}`
          }
        >
          <LoaderCircle size={11} className="spin" />
          <code>{item.name}</code>
          {item.connectionId === null && <span>IDE</span>}
          <span>{harnessDuration(item.elapsedMs)}</span>
        </span>
      ))}
    </section>
  );
}

export function DebugPane({ visible = true }: { visible?: boolean }) {
  const [snapshot, setSnapshot] = useState<HarnessSnapshot | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [paused, setPaused] = useState(false);
  const [view, setView] = useState<DebugView>('Traces');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<HarnessEventKind | 'all'>('all');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [selectedSpanId, setSelectedSpanId] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [detailRetry, setDetailRetry] = useState(0);
  const [detailState, setDetailState] = useState<HarnessDetailState | null>(null);
  const exportPending = useRef(false);
  const mounted = useRef(false);
  const pending = useRef<Promise<void> | null>(null);
  const clearingRef = useRef(false);
  const hasSnapshot = useRef(false);
  const copyTimer = useRef<number | undefined>(undefined);
  const ids = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(copyTimer.current);
    };
  }, []);

  const refresh = useCallback(() => {
    if (pending.current) return pending.current;
    if (clearingRef.current) return Promise.resolve();
    if (!hasSnapshot.current) setLoading(true);
    const task = (
      isDesktop
        ? invoke<HarnessSnapshot>('harness_snapshot')
        : Promise.resolve(previewHarnessSnapshot())
    )
      .then((next) => {
        if (!mounted.current) return;
        hasSnapshot.current = true;
        setSnapshot(next);
        setError('');
      })
      .catch((reason) => {
        if (mounted.current) setError(String(reason));
      })
      .finally(() => {
        if (pending.current === task) pending.current = null;
        if (mounted.current) setLoading(false);
      });
    pending.current = task;
    return task;
  }, []);

  useEffect(() => {
    const refreshVisible = () => {
      if (visible && !paused && !document.hidden) void refresh();
    };
    refreshVisible();
    const timer = window.setInterval(refreshVisible, 1500);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('focus', refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('focus', refreshVisible);
    };
  }, [visible, paused, refresh]);

  const events = useMemo(
    () => filterHarnessEvents(snapshot?.events || [], query, kind, errorsOnly),
    [snapshot?.events, query, kind, errorsOnly],
  );
  const traces = useMemo(() => groupHarnessTraces(snapshot?.spans || []), [snapshot?.spans]);
  const matchingTraces = useMemo(
    () => traces.filter((trace) => traceMatches(trace, query, errorsOnly)),
    [traces, query, errorsOnly],
  );
  const selectedTrace =
    matchingTraces.find((trace) => trace.id === selectedTraceId) || matchingTraces[0];
  const matchingSpans = useMemo(
    () =>
      selectedTrace
        ? traceRows(selectedTrace, new Set(), query, errorsOnly).map((row) => row.span)
        : [],
    [selectedTrace, query, errorsOnly],
  );
  const selectedSpan = matchingSpans.find((span) => span.id === selectedSpanId) || matchingSpans[0];
  const selected =
    view === 'Traces'
      ? selectedSpan
        ? traceSpanEvent(selectedSpan)
        : undefined
      : events.find((event) => event.id === selectedId) || events[0];
  const selectedActivityId = selected?.activityId ?? null;
  const selectedDetailVersion = selected?.detailVersion ?? 0;
  const detailKey = `${selectedActivityId}:${selectedDetailVersion}:${detailRetry}`;
  const clearedAt = snapshot?.clearedAt ?? null;
  const detailEnabled = visible && (view === 'Activity' || view === 'Traces') && !clearing;
  useEffect(() => {
    if (selectedActivityId === null || clearing) {
      setDetailState(null);
      return;
    }
    if (!detailEnabled) {
      setDetailState((previous) =>
        previous?.activityId === selectedActivityId && previous.clearedAt === clearedAt
          ? previous
          : null,
      );
      return;
    }
    let current = true;
    const key = detailKey;
    setDetailState((previous) =>
      beginHarnessDetailRefresh(previous, selectedActivityId, key, clearedAt),
    );
    const request = isDesktop
      ? invoke<HarnessEventDetail>('harness_event_detail', { activityId: selectedActivityId })
      : Promise.resolve(
          previewHarnessDetails().find((item) => item.activityId === selectedActivityId) || {
            activityId: selectedActivityId,
            name: 'Sample activity',
            available: false,
            reason: 'No sample content is retained for this activity.',
            request: null,
            response: null,
            error: null,
          },
        );
    void request
      .then((detail) => {
        if (current)
          setDetailState({
            activityId: selectedActivityId,
            key,
            clearedAt,
            detail,
            loading: false,
            error: '',
          });
      })
      .catch((reason) => {
        if (current)
          setDetailState((previous) => ({
            ...beginHarnessDetailRefresh(previous, selectedActivityId, key, clearedAt),
            loading: false,
            error: String(reason),
          }));
      });
    return () => {
      current = false;
    };
  }, [selectedActivityId, detailKey, clearedAt, detailEnabled, clearing]);
  const selectedDetail =
    !clearing &&
    detailState?.activityId === selectedActivityId &&
    detailState.clearedAt === clearedAt
      ? detailState
      : null;
  const connected =
    snapshot?.connections.filter((connection) => connection.state === 'connected').length || 0;
  const failures = snapshot
    ? snapshot.counters.requestsFailed +
      snapshot.counters.turnsFailed +
      snapshot.counters.toolsFailed
    : 0;

  async function clear() {
    if (!isDesktop || clearingRef.current || exportPending.current) return;
    clearingRef.current = true;
    setClearing(true);
    setActionError('');
    try {
      await pending.current;
      await invoke('harness_clear');
      if (mounted.current) {
        setSelectedId(null);
        setSelectedTraceId(null);
        setSelectedSpanId(null);
        clearingRef.current = false;
        await refresh();
      }
    } catch (reason) {
      if (mounted.current) setActionError(String(reason));
    } finally {
      clearingRef.current = false;
      if (mounted.current) setClearing(false);
    }
  }

  async function exportReport(mode: 'copy' | 'download') {
    if (!snapshot || exportPending.current || clearingRef.current) return;
    exportPending.current = true;
    setExporting(true);
    setActionError('');
    try {
      const report = isDesktop
        ? await invoke<HarnessDiagnostics>('harness_diagnostics')
        : { snapshot, details: previewHarnessDetails() };
      if (!mounted.current) return;
      const text = harnessDiagnosticReport(report.snapshot, !isDesktop, report.details);
      if (mode === 'copy') {
        await navigator.clipboard.writeText(text);
        if (!mounted.current) return;
        setCopied(true);
        window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
      } else {
        const url = URL.createObjectURL(
          new Blob([text], { type: 'application/json;charset=utf-8' }),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = `ejm-ide-diagnostics-${new Date(report.snapshot.capturedAt).toISOString().replaceAll(':', '-')}.json`;
        try {
          link.click();
        } finally {
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      }
    } catch (reason) {
      if (mounted.current) setActionError(`Could not ${mode} diagnostics: ${String(reason)}`);
    } finally {
      exportPending.current = false;
      if (mounted.current) setExporting(false);
    }
  }

  return (
    <section className="debug-pane" aria-label="Harness debug panel">
      <div className="debug-toolbar">
        <div className="debug-connection-status">
          <span className={`debug-status-dot ${connected && !error ? 'connected' : ''}`} />
          <span>
            {!isDesktop
              ? 'Sample data'
              : error
                ? 'Diagnostics unavailable'
                : connected
                  ? 'Agent connected'
                  : snapshot
                    ? 'Agent idle'
                    : 'ejm-harness'}
          </span>
          {paused && <span className="debug-paused">View paused</span>}
        </div>
        <div className="debug-actions">
          <Tooltip label={paused ? 'Resume live view' : 'Pause live view'}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={paused ? 'Resume live view' : 'Pause live view'}
              aria-pressed={paused}
              onClick={() => setPaused(!paused)}
            >
              {paused ? <Play size={13} /> : <Pause size={13} />}
            </Button>
          </Tooltip>
          <Tooltip label="Refresh diagnostics">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh diagnostics"
              disabled={clearing || loading}
              onClick={() => void refresh()}
            >
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </Button>
          </Tooltip>
          <span className="debug-action-divider" />
          <Tooltip label={copied ? 'Diagnostics copied' : 'Copy diagnostics'}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={copied ? 'Diagnostics copied' : 'Copy diagnostics'}
              disabled={!snapshot || exporting || clearing}
              onClick={() => void exportReport('copy')}
            >
              {exporting ? (
                <LoaderCircle size={13} className="spin" />
              ) : copied ? (
                <Check size={13} />
              ) : (
                <Copy size={13} />
              )}
            </Button>
          </Tooltip>
          <Tooltip label="Download diagnostics">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Download diagnostics"
              disabled={!snapshot || exporting || clearing}
              onClick={() => void exportReport('download')}
            >
              <Download size={13} />
            </Button>
          </Tooltip>
          <Tooltip label="Clear timeline and all retained content. Counters and active work continue.">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Clear timeline"
              disabled={!isDesktop || !snapshot || clearing || exporting}
              onClick={() => void clear()}
            >
              {clearing ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}
            </Button>
          </Tooltip>
        </div>
      </div>
      {(error || actionError) && (
        <div className="debug-error" role="alert">
          <AlertCircle size={13} />
          <span>{actionError || error}</span>
          {error && (
            <Button variant="ghost" size="sm" onClick={() => void refresh()}>
              Retry
            </Button>
          )}
        </div>
      )}
      {!snapshot ? (
        <div className="debug-empty" role="status">
          <Activity size={22} />
          <strong>{loading ? 'Connecting to the harness…' : 'Diagnostics unavailable'}</strong>
          <p>
            {loading
              ? 'Loading local activity and captured content.'
              : 'Refresh to try the native harness again.'}
          </p>
        </div>
      ) : (
        <>
          {view !== 'Traces' && (
            <div className="debug-summary">
              <span>
                <Activity size={12} />
                <strong>{snapshot.active.length + snapshot.activeOmitted}</strong> active
              </span>
              <span>
                <strong>{snapshot.counters.requestsCompleted}</strong> requests completed
              </span>
              <span className={failures ? 'debug-phase-failed' : ''}>
                <strong>{failures}</strong> failed
              </span>
              <span className="debug-summary-transfer">
                ↑ {harnessBytes(snapshot.counters.bytesSent)}
                <span>↓ {harnessBytes(snapshot.counters.bytesReceived)}</span>
              </span>
            </div>
          )}
          <div className="debug-tabs" role="tablist" aria-label="Debug views">
            {views.map((item) => (
              <button
                type="button"
                key={item}
                id={`${ids}-${item}`}
                role="tab"
                aria-selected={view === item}
                aria-controls={`${ids}-panel`}
                tabIndex={view === item ? 0 : -1}
                onClick={() => setView(item)}
                onKeyDown={(event) => {
                  const index = views.indexOf(item);
                  const next =
                    event.key === 'ArrowRight'
                      ? views[(index + 1) % views.length]
                      : event.key === 'ArrowLeft'
                        ? views[(index + views.length - 1) % views.length]
                        : event.key === 'Home'
                          ? views[0]
                          : event.key === 'End'
                            ? views.at(-1)
                            : undefined;
                  if (!next) return;
                  event.preventDefault();
                  setView(next);
                  document.getElementById(`${ids}-${next}`)?.focus();
                }}
              >
                {item}
                {item === 'Tools' && <span>{snapshot.tools.length}</span>}
              </button>
            ))}
            <span className="debug-capture-time">
              {paused ? 'Captured' : 'Updated'} {clockTime(snapshot.capturedAt)}
            </span>
          </div>
          <div
            className="debug-view"
            id={`${ids}-panel`}
            role="tabpanel"
            aria-labelledby={`${ids}-${view}`}
          >
            {view === 'Traces' &&
              (snapshot.spans === undefined ? (
                <div className="debug-empty">
                  <Activity size={20} />
                  <strong>This host does not provide trace spans yet.</strong>
                  <p>Use Activity to inspect captured requests and tool calls.</p>
                  <Button variant="ghost" size="sm" onClick={() => setView('Activity')}>
                    View activity
                  </Button>
                </div>
              ) : (
                <>
                  <div className="debug-filterbar debug-trace-filterbar">
                    <select
                      aria-label="Select trace"
                      value={selectedTrace?.id || ''}
                      onChange={(event) => {
                        setSelectedTraceId(event.target.value);
                        setSelectedSpanId(null);
                      }}
                    >
                      {!matchingTraces.length && (
                        <option value="">
                          {traces.length ? 'No matching traces' : 'No traces yet'}
                        </option>
                      )}
                      {matchingTraces.map((trace) => (
                        <option key={trace.id} value={trace.id}>
                          {trace.name} · {harnessDuration(trace.durationMs)} · {trace.status} ·{' '}
                          {trace.id.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                    <label className="debug-search">
                      <Search size={12} />
                      <input
                        aria-label="Search trace spans"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Filter spans…"
                        spellCheck={false}
                      />
                    </label>
                    <button
                      type="button"
                      className="debug-error-filter"
                      aria-pressed={errorsOnly}
                      onClick={() => setErrorsOnly(!errorsOnly)}
                    >
                      <AlertCircle size={12} /> Errors
                    </button>
                    <span className="debug-event-count">
                      {matchingTraces.length} {matchingTraces.length === 1 ? 'trace' : 'traces'}
                    </span>
                  </div>
                  {!!snapshot.droppedSpans && (
                    <p className="debug-trace-notice">
                      {snapshot.droppedSpans.toLocaleString()} older spans dropped. Earlier traces
                      may be incomplete.
                    </p>
                  )}
                  {selectedTrace && selectedSpan ? (
                    <div className="debug-trace-split">
                      <TraceWaterfall
                        key={selectedTrace.id}
                        trace={selectedTrace}
                        selectedId={selectedSpan.id}
                        query={query}
                        errorsOnly={errorsOnly}
                        onSelect={(id) => {
                          setSelectedTraceId(selectedTrace.id);
                          setSelectedSpanId(id);
                        }}
                      />
                      <aside className="debug-inspector" aria-label="Selected span content">
                        <HarnessEventInspector
                          event={selected}
                          span={selectedSpan}
                          selfTimeMs={spanSelfTime(selectedSpan, selectedTrace.spans)}
                          traceStartedAt={selectedTrace.startedAt}
                          detail={selectedDetail?.detail || null}
                          loading={
                            selectedActivityId !== null &&
                            (!selectedDetail ||
                              selectedDetail.loading ||
                              selectedDetail.key !== detailKey)
                          }
                          error={selectedDetail?.error || ''}
                          onRetry={() => setDetailRetry((value) => value + 1)}
                        />
                      </aside>
                    </div>
                  ) : (
                    <div className="debug-empty">
                      <Activity size={20} />
                      <strong>
                        {traces.length ? 'No matching traces' : 'No traces captured yet'}
                      </strong>
                      <p>
                        {traces.length
                          ? 'Change the filter to see more spans.'
                          : 'Chat, model requests, tools, and IDE operations appear here as they run.'}
                      </p>
                    </div>
                  )}
                </>
              ))}
            {view === 'Activity' && (
              <>
                <div className="debug-filterbar">
                  <label className="debug-search">
                    <Search size={12} />
                    <input
                      aria-label="Search harness events"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Filter events…"
                      spellCheck={false}
                    />
                  </label>
                  <select
                    aria-label="Filter event type"
                    value={kind}
                    onChange={(event) => setKind(event.target.value as HarnessEventKind | 'all')}
                  >
                    <option value="all">All types</option>
                    {(
                      ['connection', 'request', 'turn', 'tool', 'operation', 'transport'] as const
                    ).map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="debug-error-filter"
                    aria-pressed={errorsOnly}
                    onClick={() => setErrorsOnly(!errorsOnly)}
                  >
                    <AlertCircle size={12} /> Errors
                  </button>
                  <span className="debug-event-count">
                    {events.length} {events.length === 1 ? 'event' : 'events'}
                  </span>
                </div>
                <HarnessActiveWork active={snapshot.active} />
                <div className="debug-activity-split">
                  <section className="debug-timeline" aria-label="Harness event timeline">
                    {!events.length && (
                      <div className="debug-empty">
                        <Activity size={20} />
                        <strong>
                          {snapshot.events.length
                            ? 'No matching events'
                            : 'No activity captured yet'}
                        </strong>
                        <p>
                          {snapshot.events.length
                            ? 'Change the filter to see more events.'
                            : 'Chat, completions, and IDE tools appear here as they run.'}
                        </p>
                      </div>
                    )}
                    {events.map((event) => (
                      <button
                        type="button"
                        key={event.id}
                        className={`debug-event-row ${selected?.id === event.id ? 'selected' : ''} debug-phase-${event.phase}`}
                        aria-pressed={selected?.id === event.id}
                        onClick={() => setSelectedId(event.id)}
                      >
                        <time>{clockTime(event.at)}</time>
                        <EventIcon event={event} />
                        <span className="debug-event-name" title={event.name}>
                          {event.name}
                        </span>
                        <span className="debug-event-kind">{event.kind}</span>
                        <span className="debug-event-phase">{event.phase}</span>
                        <span className="debug-event-duration">
                          {harnessDuration(event.durationMs)}
                        </span>
                      </button>
                    ))}
                  </section>
                  <aside className="debug-inspector" aria-label="Selected event content">
                    <HarnessEventInspector
                      event={selected}
                      detail={selectedDetail?.detail || null}
                      loading={
                        selectedActivityId !== null &&
                        (!selectedDetail ||
                          selectedDetail.loading ||
                          selectedDetail.key !== detailKey)
                      }
                      error={selectedDetail?.error || ''}
                      onRetry={() => setDetailRetry((value) => value + 1)}
                    />
                  </aside>
                </div>
              </>
            )}
            {view === 'Connections' && (
              <div className="debug-scroll">
                <table className="debug-table">
                  <caption>Agent transport connections</caption>
                  <thead>
                    <tr>
                      <th scope="col">Connection</th>
                      <th scope="col">State</th>
                      <th scope="col">Requests</th>
                      <th scope="col">Sent</th>
                      <th scope="col">Received</th>
                      <th scope="col">Lifetime</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.connections.map((connection) => (
                      <tr key={connection.id}>
                        <td>
                          <code>#{connection.id}</code> {connection.kind}
                        </td>
                        <td>{connection.state}</td>
                        <td>{connection.requests}</td>
                        <td>{harnessBytes(connection.bytesSent)}</td>
                        <td>{harnessBytes(connection.bytesReceived)}</td>
                        <td>
                          {harnessDuration(
                            (connection.closedAt ?? snapshot.capturedAt) - connection.openedAt,
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!snapshot.connections.length && (
                  <p className="debug-inline-empty">No transport connections captured yet.</p>
                )}
                <p className="debug-note">
                  Transport: {snapshot.transport}. Connections open while the agent runs.
                </p>
              </div>
            )}
            {view === 'Tools' && (
              <div className="debug-scroll">
                <p className="debug-note">
                  Tools available to the agent. Each call appears in the activity timeline.
                </p>
                {(['index', 'file', 'presentation'] as const).map((group) => (
                  <div className="debug-tool-group" key={group}>
                    <h3>
                      {group === 'index'
                        ? 'Code intelligence'
                        : group === 'file'
                          ? 'Workspace files'
                          : 'IDE and rich chat'}
                    </h3>
                    {snapshot.tools
                      .filter((tool) => tool.kind === group)
                      .map((tool) => (
                        <div className="debug-tool" key={tool.name}>
                          <Wrench size={12} />
                          <code>{tool.name}</code>
                        </div>
                      ))}
                  </div>
                ))}
                {!snapshot.tools.length && (
                  <p className="debug-inline-empty">No Edi tools registered.</p>
                )}
              </div>
            )}
            {view === 'Limits' && (
              <div className="debug-scroll debug-limits">
                <HarnessEngineStats engine={snapshot.engine} sampleData={!isDesktop} />
                {snapshot.capture && (
                  <div>
                    <h3>Local capture</h3>
                    <dl>
                      <dt>Retained content</dt>
                      <dd>{harnessBytes(snapshot.capture.storedBytes)}</dd>
                      <dt>Capture capacity</dt>
                      <dd>{harnessBytes(snapshot.capture.maxBytes)}</dd>
                      <dt>Individual content limit</dt>
                      <dd>{harnessBytes(snapshot.capture.maxContentBytes)}</dd>
                      <dt>Retained activities</dt>
                      <dd>{snapshot.capture.retainedActivities.toLocaleString()}</dd>
                      <dt>Evicted activities</dt>
                      <dd>{snapshot.capture.evictedActivities.toLocaleString()}</dd>
                    </dl>
                    <p className="debug-note">
                      Full local bodies are retained within these limits. Each payload shows any
                      credential redactions or omitted bytes.
                    </p>
                  </div>
                )}
                <div>
                  <h3>Execution</h3>
                  <dl>
                    <dt>Model timeout</dt>
                    <dd>{harnessDuration(snapshot.limits.rpcTimeoutMs)}</dd>
                    {snapshot.limits.writeTimeoutMs > 0 && (
                      <>
                        <dt>Write timeout</dt>
                        <dd>{harnessDuration(snapshot.limits.writeTimeoutMs)}</dd>
                      </>
                    )}
                    <dt>Review timeout</dt>
                    <dd>{harnessDuration(snapshot.limits.approvalTimeoutMs)}</dd>
                    <dt>Pending requests</dt>
                    <dd>{snapshot.limits.maxPendingRequests}</dd>
                    <dt>Turn events</dt>
                    <dd>{snapshot.limits.maxTurnEvents.toLocaleString()}</dd>
                    {snapshot.limits.maxModelRounds !== undefined && (
                      <>
                        <dt>Model rounds per turn</dt>
                        <dd>{snapshot.limits.maxModelRounds}</dd>
                      </>
                    )}
                    {snapshot.limits.maxToolCalls !== undefined && (
                      <>
                        <dt>Tool calls per turn</dt>
                        <dd>{snapshot.limits.maxToolCalls}</dd>
                      </>
                    )}
                  </dl>
                </div>
                <div>
                  <h3>Memory bounds</h3>
                  <dl>
                    <dt>Captured events</dt>
                    <dd>{snapshot.limits.eventCapacity}</dd>
                    <dt>Active records</dt>
                    <dd>{snapshot.limits.activityCapacity}</dd>
                    <dt>Connection records</dt>
                    <dd>{snapshot.limits.connectionCapacity}</dd>
                    <dt>Input limit</dt>
                    <dd>{harnessBytes(snapshot.limits.maxInputBytes)}</dd>
                    <dt>Transport frame</dt>
                    <dd>{harnessBytes(snapshot.limits.maxFrameBytes)}</dd>
                    <dt>Turn output limit</dt>
                    <dd>{harnessBytes(snapshot.limits.maxTurnOutputBytes)}</dd>
                  </dl>
                </div>
              </div>
            )}
          </div>
          <div className="debug-footer">
            <span>
              <ShieldCheck size={11} /> Local content · Credentials redacted
            </span>
            <span>
              {snapshot.capture &&
                `${harnessBytes(snapshot.capture.storedBytes)} / ${harnessBytes(snapshot.capture.maxBytes)} retained · `}
              {!!snapshot.capture?.evictedActivities &&
                `${snapshot.capture.evictedActivities.toLocaleString()} activities evicted · `}
              {snapshot.droppedEvents
                ? `${snapshot.droppedEvents.toLocaleString()} older events dropped · `
                : ''}
              {snapshot.activeOmitted ? `${snapshot.activeOmitted} active records omitted · ` : ''}
              Latest {snapshot.limits.eventCapacity} events{!isDesktop && ' · Preview'}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
