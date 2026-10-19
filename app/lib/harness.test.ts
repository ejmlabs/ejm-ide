import { describe, expect, it } from 'vitest';
import {
  filterHarnessEvents,
  type HarnessEventDetail,
  harnessBytes,
  harnessDiagnosticReport,
  harnessDuration,
  previewHarnessDetails,
  previewHarnessSnapshot,
} from './harness';

describe('harness event filters', () => {
  it('combines type, error, and case insensitive metadata filters', () => {
    const snapshot = previewHarnessSnapshot(1_800_000);
    const filtered = filterHarnessEvents(snapshot.events, '  TIMEOUT ', 'request', true);
    expect(filtered.map((event) => event.name)).toEqual(['model/review']);
    expect(filterHarnessEvents(snapshot.events, 'workbench_show_ui', 'request', false)).toEqual([]);
    expect(filterHarnessEvents(snapshot.events, 'unmatched', 'tool', false)).toHaveLength(0);
    expect(filterHarnessEvents(snapshot.events, 'workbench_show_ui', 'tool', false)).toHaveLength(
      2,
    );
  });

  it('shows newest first, includes limits as errors, and does not mutate native events', () => {
    const snapshot = previewHarnessSnapshot(1_800_000);
    const original = snapshot.events.map((event) => event.id);
    snapshot.events.push({
      id: snapshot.cursor + 1,
      at: 1_800_001,
      connectionId: null,
      kind: 'transport',
      name: 'frame',
      phase: 'limit',
      durationMs: null,
      bytes: 4_194_305,
      code: 'frame_too_large',
    });
    const errors = filterHarnessEvents(snapshot.events, '', 'all', true);
    expect(errors[0].id).toBe(snapshot.cursor + 1);
    expect(errors.some((event) => event.name === 'model/review' && event.phase === 'failed')).toBe(
      true,
    );
    expect(errors.map((event) => event.id)).toEqual(
      errors.map((event) => event.id).sort((a, b) => b - a),
    );
    expect(snapshot.events.slice(0, -1).map((event) => event.id)).toEqual(original);
  });
});

describe('diagnostic export content', () => {
  it('preserves all supplied metadata, exact bodies, and capture markers', () => {
    const snapshot = previewHarnessSnapshot(1_800_000);
    snapshot.active.push({
      id: 12,
      connectionId: 1,
      kind: 'turn',
      name: 'turn',
      startedAt: 1,
      elapsedMs: 2,
    });
    const details: HarnessEventDetail[] = [
      {
        activityId: 4,
        name: 'model/complete',
        available: true,
        reason: null,
        request: {
          text: '{"messages":[{"role":"user","content":"Explain <Customer>"}],"authorization":"[REDACTED]"}',
          format: 'json',
          originalBytes: 768,
          redactions: 1,
          truncatedBytes: 128,
        },
        response: {
          text: 'event: response.output_text.delta\ndata: {"delta":"Use refresh()"}\n\n',
          format: 'sse',
          originalBytes: 89,
          redactions: 0,
          truncatedBytes: 0,
        },
        error: {
          text: 'Error: stream interrupted\n  at retry()',
          format: 'text',
          originalBytes: 42,
          redactions: 0,
          truncatedBytes: 0,
        },
      },
    ];
    const futureMetadata = { futureField: { revision: 2, values: [0, false, null, 'visible'] } };
    for (const target of [
      snapshot,
      snapshot.limits,
      snapshot.counters,
      snapshot.capture,
      snapshot.privacy,
      snapshot.engine,
      ...(snapshot.engine.state ? [snapshot.engine.state, snapshot.engine.state.tools] : []),
      ...snapshot.connections,
      ...snapshot.active,
      ...snapshot.events,
      ...(snapshot.spans || []),
      ...snapshot.tools,
      ...details,
      ...details.flatMap((detail) =>
        [detail.request, detail.response, detail.error].filter((content) => content !== null),
      ),
    ]) {
      Object.assign(target, futureMetadata);
    }
    const expectedSnapshot = structuredClone(snapshot);
    const expectedDetails = structuredClone(details);
    const parsed = JSON.parse(harnessDiagnosticReport(snapshot, true, details));
    expect(parsed).toEqual({
      ...expectedSnapshot,
      format: 'workbench-harness-diagnostics/v1',
      sampleData: true,
      details: expectedDetails,
    });
    expect(parsed.details[0].request.text).toBe(details[0].request?.text);
    expect(parsed.details[0].request.redactions).toBe(1);
    expect(parsed.details[0].request.originalBytes).toBe(768);
    expect(parsed.details[0].request.truncatedBytes).toBe(128);
    expect(parsed.details[0].response.text).toBe(details[0].response?.text);
    expect(parsed.details[0].error.text).toBe(details[0].error?.text);
    expect(snapshot).toEqual(expectedSnapshot);
    expect(details).toEqual(expectedDetails);
    expect(JSON.parse(harnessDiagnosticReport(snapshot)).sampleData).toBe(false);
    expect(JSON.parse(harnessDiagnosticReport(snapshot)).details).toEqual([]);
  });

  it('preserves unavailable content and optional activity references without inventing payloads', () => {
    const snapshot = previewHarnessSnapshot(1_800_000);
    snapshot.events[0] = {
      ...snapshot.events[0],
      activityId: 17,
      detailVersion: 2,
      hasContent: true,
    };
    const detail: HarnessEventDetail = {
      activityId: 17,
      name: 'model/complete',
      available: false,
      reason: 'Content was evicted from the bounded capture store.',
      request: null,
      response: null,
      error: null,
    };
    const parsed = JSON.parse(harnessDiagnosticReport(snapshot, false, [detail]));
    expect(parsed.details).toEqual([detail]);
    expect(parsed.events[0]).toMatchObject({
      activityId: 17,
      detailVersion: 2,
      hasContent: true,
    });
  });

  it('preserves an engine that has not started without inventing resource counts', () => {
    const snapshot = previewHarnessSnapshot(1_800_000);
    snapshot.engine = { name: 'ejm-harness', ready: false, state: null };
    expect(JSON.parse(harnessDiagnosticReport(snapshot)).engine).toEqual({
      name: 'ejm-harness',
      ready: false,
      state: null,
    });
  });

  it('provides preview payloads for request, tool, and failed activities that exist in the timeline', () => {
    const snapshot = previewHarnessSnapshot(1_800_000);
    const details = previewHarnessDetails();
    for (const kind of ['request', 'tool'] as const) {
      expect(
        details.some(
          (detail) =>
            detail.request !== null &&
            detail.response !== null &&
            snapshot.events.some(
              (event) => event.activityId === detail.activityId && event.kind === kind,
            ),
        ),
      ).toBe(true);
    }
    expect(
      details.some(
        (detail) =>
          detail.error !== null &&
          snapshot.events.some(
            (event) => event.activityId === detail.activityId && event.phase === 'failed',
          ),
      ),
    ).toBe(true);
  });
});

describe('harness metadata formatting', () => {
  it('preserves a missing duration and formats small and large measurements', () => {
    expect(harnessDuration(null)).toBe('');
    expect(harnessDuration(0)).toBe('0 ms');
    expect(harnessDuration(1250)).toBe('1.3 s');
    expect(harnessDuration(45_000)).toBe('45 s');
    expect(harnessBytes(34)).toBe('34 B');
    expect(harnessBytes(2048)).toBe('2.0 KiB');
    expect(harnessBytes(4_194_304)).toBe('4.0 MiB');
  });
});

describe('sample trace consistency', () => {
  it('marks nested success and failure samples and provides their payloads', () => {
    const snapshot = previewHarnessSnapshot(1_800_000);
    const spans = snapshot.spans || [];
    const details = previewHarnessDetails();
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(2);
    expect(spans.some((span) => span.parentId === null && span.status === 'completed')).toBe(true);
    expect(spans.some((span) => span.parentId === null && span.status === 'failed')).toBe(true);
    for (const span of spans) {
      expect(details.some((detail) => detail.activityId === span.id)).toBe(true);
      expect(snapshot.events.some((event) => event.activityId === span.id)).toBe(true);
      if (span.parentId !== null) {
        expect(spans.find((parent) => parent.id === span.parentId)?.traceId).toBe(span.traceId);
      }
    }
  });
});
