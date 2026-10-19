import { AlertCircle, Check, ChevronRight, Copy, LoaderCircle, Minus, Plus } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { harnessDuration } from '@/lib/harness';
import { type HarnessTrace, traceRowNavigation, traceRows } from '@/lib/harness-traces';
import { Button } from './ui/button';
import { Tooltip } from './ui/tooltip';

export function TraceWaterfall({
  trace,
  selectedId,
  query = '',
  errorsOnly = false,
  onSelect,
}: {
  trace: HarnessTrace;
  selectedId: number;
  query?: string;
  errorsOnly?: boolean;
  onSelect: (id: number) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const [zoom, setZoom] = useState(1);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const rowElements = useRef(new Map<number, HTMLTableRowElement>());
  const rows = useMemo(
    () => traceRows(trace, collapsed, query, errorsOnly),
    [trace, collapsed, query, errorsOnly],
  );
  const tabId = rows.some((row) => row.span.id === selectedId) ? selectedId : rows[0]?.span.id;
  const filtering = !!query.trim() || errorsOnly;
  const duration = Math.max(1, trace.durationMs);

  function toggle(id: number, close: boolean) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (close) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function copyTrace() {
    try {
      await navigator.clipboard.writeText(trace.id);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <div className="debug-waterfall">
      <div className="debug-trace-heading">
        <span className={`debug-trace-status debug-span-${trace.status}`}>
          {trace.status === 'running' && <LoaderCircle size={11} className="spin" />}
          {trace.status === 'failed' && <AlertCircle size={11} />}
          {trace.status}
        </span>
        <strong title="Duration across retained spans">{harnessDuration(trace.durationMs)}</strong>
        <span>{trace.spans.length} spans</span>
        {!!trace.failures && trace.status !== 'failed' && (
          <span className="debug-phase-failed">{trace.failures} failed</span>
        )}
        <Tooltip label={`Trace ${trace.id}`}>
          <button
            type="button"
            className="debug-trace-id"
            onClick={() => void copyTrace()}
            aria-label={copyState === 'copied' ? 'Trace ID copied' : 'Copy trace ID'}
          >
            <code>{trace.id.slice(0, 8)}</code>
            {copyState === 'copied' ? <Check size={10} /> : <Copy size={10} />}
          </button>
        </Tooltip>
        <fieldset className="debug-trace-zoom" aria-label="Waterfall scale">
          <Tooltip label="Zoom out">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Zoom out waterfall"
              disabled={zoom === 1}
              onClick={() => setZoom((value) => Math.max(1, value / 2))}
            >
              <Minus size={11} />
            </Button>
          </Tooltip>
          <button type="button" aria-label="Fit waterfall" onClick={() => setZoom(1)}>
            {zoom === 1 ? 'Fit' : `${zoom}×`}
          </button>
          <Tooltip label="Zoom in">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Zoom in waterfall"
              disabled={zoom === 8}
              onClick={() => setZoom((value) => Math.min(8, value * 2))}
            >
              <Plus size={11} />
            </Button>
          </Tooltip>
        </fieldset>
      </div>
      {copyState === 'failed' && (
        <p className="debug-trace-notice" role="alert">
          Could not copy the trace ID.
        </p>
      )}
      {!!trace.missingParents && (
        <p className="debug-trace-notice">
          Incomplete trace: {trace.missingParents} parent{' '}
          {trace.missingParents === 1 ? 'span is' : 'spans are'} no longer retained.
        </p>
      )}
      <div className="debug-waterfall-scroll">
        <table
          className="debug-waterfall-grid"
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: WAI-ARIA treegrids use semantic tables with focusable rows.
          role="treegrid"
          aria-label="Trace spans"
          aria-rowcount={rows.length + 1}
          aria-colcount={3}
          style={{ width: `${zoom * 100}%` }}
        >
          <thead>
            <tr className="debug-waterfall-header">
              <th scope="col" className="debug-span-label">
                Span
              </th>
              <th
                scope="col"
                className="debug-waterfall-axis"
                aria-label="Elapsed time from first retained span"
              >
                {[0, 0.25, 0.5, 0.75, 1].map((part) => (
                  <span key={part} style={{ left: `${part * 100}%` }}>
                    {harnessDuration(trace.durationMs * part)}
                  </span>
                ))}
              </th>
              <th scope="col" className="debug-span-duration">
                Duration
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ span, depth, hasChildren, contextOnly, missingParent }, index) => (
              <tr
                key={span.id}
                aria-level={depth + 1}
                aria-rowindex={index + 2}
                aria-selected={span.id === selectedId}
                aria-expanded={hasChildren ? filtering || !collapsed.has(span.id) : undefined}
                tabIndex={span.id === tabId ? 0 : -1}
                ref={(element) => {
                  if (element) rowElements.current.set(span.id, element);
                  else rowElements.current.delete(span.id);
                }}
                className={`debug-waterfall-row debug-span-${span.status} ${span.id === selectedId ? 'selected' : ''} ${contextOnly ? 'context-only' : ''}`}
                onClick={() => {
                  onSelect(span.id);
                  rowElements.current.get(span.id)?.focus();
                }}
                onFocus={() => onSelect(span.id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(span.id);
                    return;
                  }
                  const next = traceRowNavigation(
                    rows,
                    span.id,
                    event.key,
                    filtering ? new Set() : collapsed,
                  );
                  if (!next) return;
                  event.preventDefault();
                  if (next.collapse !== undefined && !filtering) toggle(span.id, next.collapse);
                  onSelect(next.focus);
                  rowElements.current.get(next.focus)?.focus();
                }}
              >
                <td className="debug-span-label" style={{ paddingLeft: `${8 + depth * 12}px` }}>
                  {hasChildren ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`${!filtering && collapsed.has(span.id) ? 'Expand' : 'Collapse'} ${span.name}`}
                      aria-expanded={filtering || !collapsed.has(span.id)}
                      disabled={filtering}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle(span.id, !collapsed.has(span.id));
                        onSelect(span.id);
                        rowElements.current.get(span.id)?.focus();
                      }}
                    >
                      <ChevronRight
                        size={11}
                        className={filtering || !collapsed.has(span.id) ? 'expanded' : ''}
                      />
                    </button>
                  ) : (
                    <span className="debug-span-indent" />
                  )}
                  <span
                    className={`debug-span-dot debug-kind-${span.kind}`}
                    role="img"
                    aria-label={span.status}
                  />
                  <span className="debug-span-name" title={`${span.name} (#${span.id})`}>
                    {span.name}
                  </span>
                  {missingParent && (
                    <span
                      title={`Parent #${span.parentId} is no longer retained`}
                      role="img"
                      aria-label="Parent not retained"
                    >
                      …
                    </span>
                  )}
                </td>
                <td
                  className="debug-waterfall-lane"
                  aria-label={`${span.name}: starts ${harnessDuration(Math.max(0, span.startedAt - trace.startedAt))}, duration ${harnessDuration(span.durationMs)}, ${span.status}`}
                >
                  {[0, 0.25, 0.5, 0.75, 1].map((part) => (
                    <span
                      key={part}
                      aria-hidden="true"
                      className="debug-waterfall-guide"
                      style={{ left: `${part * 100}%` }}
                    />
                  ))}
                  <span
                    className={`debug-waterfall-bar debug-kind-${span.kind}`}
                    aria-hidden="true"
                    style={{
                      left: `${(Math.max(0, span.startedAt - trace.startedAt) / duration) * 100}%`,
                      width: `${(span.durationMs / duration) * 100}%`,
                    }}
                  />
                </td>
                <td className="debug-span-duration">{harnessDuration(span.durationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="debug-waterfall-hint">↑↓ navigate · ←→ collapse or expand · Enter inspect</p>
    </div>
  );
}
