import type { HarnessEvent, HarnessSpan } from './harness';

export interface HarnessTrace {
  id: string;
  name: string;
  spans: HarnessSpan[];
  startedAt: number;
  durationMs: number;
  status: HarnessSpan['status'];
  failures: number;
  missingParents: number;
}

export interface TraceRow {
  span: HarnessSpan;
  depth: number;
  hasChildren: boolean;
  contextOnly: boolean;
  missingParent: boolean;
}

export function groupHarnessTraces(spans: readonly HarnessSpan[]): HarnessTrace[] {
  const groups = new Map<string, HarnessSpan[]>();
  for (const span of spans) {
    const group = groups.get(span.traceId);
    if (group) group.push(span);
    else groups.set(span.traceId, [span]);
  }
  return [...groups]
    .map<HarnessTrace>(([id, members]) => {
      members.sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
      const ids = new Set(members.map((span) => span.id));
      const root = members.find((span) => span.parentId === null) || members[0];
      const startedAt = members[0].startedAt;
      const failures = members.filter((span) => span.status === 'failed').length;
      return {
        id,
        name: root.name,
        spans: members,
        startedAt,
        durationMs: Math.max(
          ...members.map((span) => span.startedAt - startedAt + span.durationMs),
        ),
        status: members.some((span) => span.status === 'running')
          ? 'running'
          : failures
            ? 'failed'
            : members.some((span) => span.status === 'cancelled')
              ? 'cancelled'
              : 'completed',
        failures,
        missingParents: new Set(
          members
            .filter((span) => span.parentId !== null && !ids.has(span.parentId))
            .map((span) => span.parentId),
        ).size,
      };
    })
    .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
}

// Causal children can outlive their parent; subtract the union across linked descendants.
export function spanSelfTime(span: HarnessSpan, spans: readonly HarnessSpan[]): number {
  const children = new Map<number, HarnessSpan[]>();
  for (const candidate of spans) {
    if (candidate.traceId !== span.traceId || candidate.parentId === null) continue;
    const siblings = children.get(candidate.parentId);
    if (siblings) siblings.push(candidate);
    else children.set(candidate.parentId, [candidate]);
  }
  const visited = new Set([span.id]);
  const pending = [...(children.get(span.id) || [])];
  const intervals: number[][] = [];
  while (pending.length) {
    const descendant = pending.pop();
    if (!descendant || visited.has(descendant.id)) continue;
    visited.add(descendant.id);
    const start = Math.max(0, descendant.startedAt - span.startedAt);
    const end = Math.min(
      span.durationMs,
      descendant.startedAt - span.startedAt + descendant.durationMs,
    );
    if (end > start) intervals.push([start, end]);
    pending.push(...(children.get(descendant.id) || []));
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let occupied = 0;
  let previousEnd = 0;
  for (const [start, end] of intervals) {
    occupied += Math.max(0, end - Math.max(start, previousEnd));
    previousEnd = Math.max(previousEnd, end);
  }
  return Math.max(0, span.durationMs - occupied);
}

function spanMatches(span: HarnessSpan, query: string, errorsOnly: boolean) {
  const metadata = [span.id, span.traceId, span.name, span.kind, span.status, span.code]
    .join(' ')
    .toLowerCase();
  return (
    (!errorsOnly || span.status === 'failed') &&
    query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .every((term) => metadata.includes(term))
  );
}

export function traceMatches(trace: HarnessTrace, query: string, errorsOnly: boolean) {
  return trace.spans.some((span) => spanMatches(span, query, errorsOnly));
}

export function traceRows(
  trace: HarnessTrace,
  collapsed: ReadonlySet<number>,
  query = '',
  errorsOnly = false,
): TraceRow[] {
  const byId = new Map(trace.spans.map((span) => [span.id, span]));
  const children = new Map<number, HarnessSpan[]>();
  const roots: HarnessSpan[] = [];
  for (const span of trace.spans) {
    if (span.parentId !== null && byId.has(span.parentId) && span.parentId !== span.id) {
      const siblings = children.get(span.parentId);
      if (siblings) siblings.push(span);
      else children.set(span.parentId, [span]);
    } else roots.push(span);
  }
  const filtering = !!query.trim() || errorsOnly;
  const matches = new Set(
    trace.spans.filter((span) => spanMatches(span, query, errorsOnly)).map((span) => span.id),
  );
  const included = new Set(matches);
  if (filtering) {
    for (const id of matches) {
      let parent = byId.get(id)?.parentId;
      const visited = new Set([id]);
      while (parent !== null && parent !== undefined && !visited.has(parent) && byId.has(parent)) {
        visited.add(parent);
        included.add(parent);
        parent = byId.get(parent)?.parentId;
      }
    }
  }
  const rows: TraceRow[] = [];
  const visited = new Set<number>();
  function visit(span: HarnessSpan, depth: number) {
    if (visited.has(span.id)) return;
    visited.add(span.id);
    if (filtering && !included.has(span.id)) return;
    const descendants = children.get(span.id) || [];
    rows.push({
      span,
      depth,
      hasChildren: descendants.some((child) => !filtering || included.has(child.id)),
      contextOnly: filtering && !matches.has(span.id),
      missingParent: span.parentId !== null && !byId.has(span.parentId),
    });
    if (filtering || !collapsed.has(span.id)) {
      for (const child of descendants) visit(child, depth + 1);
    } else {
      // Mark the collapsed branch so it cannot reappear as an orphan below.
      function hide(id: number) {
        if (visited.has(id)) return;
        visited.add(id);
        for (const child of children.get(id) || []) hide(child.id);
      }
      for (const child of descendants) hide(child.id);
    }
  }
  for (const root of roots) visit(root, 0);
  // A malformed cycle must not hide retained content or recurse forever.
  for (const span of trace.spans) if (!visited.has(span.id)) visit(span, 0);
  return rows;
}

export function traceSpanEvent(span: HarnessSpan): HarnessEvent {
  return {
    id: span.id,
    at: span.startedAt,
    connectionId: span.connectionId,
    kind: span.kind,
    name: span.name,
    phase: span.status === 'running' ? 'started' : span.status,
    durationMs: span.durationMs,
    bytes: null,
    code: span.code,
    activityId: span.id,
    detailVersion: span.detailVersion,
    hasContent: span.hasContent,
  };
}

export function traceRowNavigation(
  rows: readonly TraceRow[],
  id: number,
  key: string,
  collapsed: ReadonlySet<number>,
): { focus: number; collapse?: boolean } | null {
  const index = rows.findIndex((row) => row.span.id === id);
  if (index < 0) return null;
  const row = rows[index];
  if (key === 'ArrowDown') return { focus: rows[Math.min(index + 1, rows.length - 1)].span.id };
  if (key === 'ArrowUp') return { focus: rows[Math.max(0, index - 1)].span.id };
  if (key === 'Home') return { focus: rows[0].span.id };
  if (key === 'End') return { focus: rows[rows.length - 1].span.id };
  if (key === 'ArrowRight' && row.hasChildren) {
    return collapsed.has(id) ? { focus: id, collapse: false } : { focus: rows[index + 1].span.id };
  }
  if (key === 'ArrowLeft') {
    if (row.hasChildren && !collapsed.has(id)) return { focus: id, collapse: true };
    const parent = rows
      .slice(0, index)
      .reverse()
      .find((candidate) => candidate.depth < row.depth);
    if (parent) return { focus: parent.span.id };
  }
  return null;
}
