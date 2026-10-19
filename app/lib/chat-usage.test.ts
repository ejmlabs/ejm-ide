import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatUsage } from '../components/ChatUsage';
import {
  billingCopy,
  type ChatTokenBreakdown,
  contextUsage,
  formatTokenCount,
  parseChatUsage,
} from './chat-usage';

// Expose the existing tooltip's content to assert the user-visible breakdown.
vi.mock('../components/ui/tooltip', () => ({
  Tooltip: ({ children, label }: { children: ReactNode; label: ReactNode }) =>
    createElement(Fragment, null, children, label),
}));

const counts: ChatTokenBreakdown = {
  inputTokens: 1_000,
  cachedInputTokens: 700,
  outputTokens: 120,
  reasoningOutputTokens: 20,
  totalTokens: 1_120,
};
function notification() {
  return {
    threadId: 'thread',
    turnId: 'turn',
    tokenUsage: {
      total: { ...counts, inputTokens: 10_000, totalTokens: 10_120 },
      last: { ...counts },
      modelContextWindow: 10_000,
    },
  };
}

describe('provider token usage reports', () => {
  it('keeps the cumulative and last snapshots separate without summing reports', () => {
    const first = parseChatUsage(notification());
    const repeated = parseChatUsage(notification());
    expect(repeated).toEqual(first);
    expect(repeated?.total.totalTokens).toBe(10_120);
    expect(repeated?.last?.totalTokens).toBe(1_120);
    expect(contextUsage(repeated)).toEqual({
      used: 1_120,
      limit: 10_000,
      fraction: 0.112,
      label: '11%',
    });
  });

  it('retains valid totals when cache and reasoning details are missing or null', () => {
    const partial = { inputTokens: 1_000, outputTokens: 120, totalTokens: 1_120 };
    for (const details of [
      {},
      { cachedInputTokens: null, reasoningOutputTokens: null },
      { cachedInputTokens: 0, reasoningOutputTokens: null },
      { cachedInputTokens: null, reasoningOutputTokens: 0 },
    ]) {
      const snapshot = { ...partial, ...details };
      const usage = parseChatUsage({
        tokenUsage: { total: snapshot, last: snapshot, modelContextWindow: 10_000 },
      });
      expect(usage?.total).toEqual({
        ...partial,
        cachedInputTokens: details.cachedInputTokens ?? null,
        reasoningOutputTokens: details.reasoningOutputTokens ?? null,
      });
      expect(usage?.last).toEqual(usage?.total);
      expect(contextUsage(usage)).toMatchObject({ used: 1_120, label: '11%' });
    }
  });

  it('does not fill unreported details from an earlier snapshot', () => {
    expect(parseChatUsage(notification())?.last?.cachedInputTokens).toBe(700);
    const next = parseChatUsage({
      tokenUsage: {
        total: { ...counts, cachedInputTokens: 700, reasoningOutputTokens: 20 },
        last: { inputTokens: 100, outputTokens: 12, totalTokens: 112 },
        modelContextWindow: 10_000,
      },
    });
    expect(next?.total.cachedInputTokens).toBe(700);
    expect(next?.last?.cachedInputTokens).toBeNull();
    expect(next?.last?.reasoningOutputTokens).toBeNull();
    expect(next?.last?.totalTokens).toBe(112);
  });

  it('retains optional cache write tokens, including a zero count', () => {
    const params = notification();
    const withCache = {
      ...params,
      tokenUsage: {
        ...params.tokenUsage,
        total: { ...counts, cacheWriteInputTokens: 25 },
        last: { ...counts, cacheWriteInputTokens: 0 },
      },
    };
    expect(parseChatUsage(withCache)?.total.cacheWriteInputTokens).toBe(25);
    expect(parseChatUsage(withCache)?.last?.cacheWriteInputTokens).toBe(0);
  });

  it('rejects malformed payloads and missing breakdown fields', () => {
    for (const params of [null, undefined, [], {}, { tokenUsage: [] }, { tokenUsage: counts }])
      expect(parseChatUsage(params)).toBeNull();
    const params = notification();
    expect(parseChatUsage({ tokenUsage: { ...params.tokenUsage, total: null } })).toBeNull();
    expect(
      parseChatUsage({ tokenUsage: { ...params.tokenUsage, last: { inputTokens: 12 } } }),
    ).toBeNull();
    expect(parseChatUsage({ tokenUsage: { total: counts } })).toBeNull();
  });

  it('restores total usage without inventing a last response or context count', () => {
    const usage = parseChatUsage({
      tokenUsage: { total: counts, last: null, modelContextWindow: null },
    });
    expect(usage?.total).toEqual(counts);
    expect(usage?.last).toBeNull();
    expect(contextUsage(usage)).toEqual({
      used: null,
      limit: null,
      fraction: null,
      label: 'Context',
    });
  });

  it('rejects non-integer, negative, non-finite, and unsafe token counts in every field', () => {
    const invalidCounts = [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '12', null];
    for (const snapshot of ['last', 'total'] as const) {
      for (const key of [...Object.keys(counts), 'cacheWriteInputTokens']) {
        for (const value of invalidCounts) {
          if (value === null && (key === 'cachedInputTokens' || key === 'reasoningOutputTokens'))
            continue;
          const params = notification();
          expect(
            parseChatUsage({
              tokenUsage: {
                ...params.tokenUsage,
                [snapshot]: { ...params.tokenUsage[snapshot], [key]: value },
              },
            }),
          ).toBeNull();
        }
      }
    }
  });

  it('accepts zero usage and safe integer counts without inventing a model window', () => {
    const zero = Object.fromEntries(Object.keys(counts).map((key) => [key, 0]));
    const usage = parseChatUsage({
      tokenUsage: { last: zero, total: zero, modelContextWindow: null },
    });
    expect(usage?.last?.totalTokens).toBe(0);
    expect(contextUsage(usage)).toEqual({ used: 0, limit: null, fraction: null, label: 'Context' });
    const params = notification();
    expect(
      parseChatUsage({
        tokenUsage: {
          ...params.tokenUsage,
          last: { ...counts, totalTokens: Number.MAX_SAFE_INTEGER },
        },
      })?.last?.totalTokens,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('treats an absent or invalid model window as unknown while keeping valid usage', () => {
    for (const limit of [
      undefined,
      null,
      0,
      -1,
      1.1,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      '128000',
    ]) {
      const params = notification();
      const usage = parseChatUsage({
        tokenUsage: { ...params.tokenUsage, modelContextWindow: limit },
      });
      expect(usage?.last?.totalTokens).toBe(1_120);
      expect(usage?.modelContextWindow).toBeNull();
      expect(contextUsage(usage).fraction).toBeNull();
    }
  });

  it('distinguishes unknown, empty, tiny, full, and exceeded context usage', () => {
    expect(contextUsage(null)).toEqual({
      used: null,
      limit: null,
      fraction: null,
      label: 'Context',
    });
    const params = notification();
    for (const [count, label, fraction] of [
      [0, '0%', 0],
      [1, '<1%', 0.0001],
      [10_000, '100%', 1],
      [12_000, '100%+', 1],
    ] as const) {
      const usage = parseChatUsage({
        tokenUsage: { ...params.tokenUsage, last: { ...counts, totalTokens: count } },
      });
      expect(contextUsage(usage)).toMatchObject({ used: count, label, fraction });
    }
  });

  it('formats exact token counts without treating bad data as zero', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(123_456)).toBe('123,456');
    expect(formatTokenCount(-1)).toBe('Unknown');
    expect(formatTokenCount(Number.NaN)).toBe('Unknown');
    expect(formatTokenCount(null)).toBe('Unknown');
    expect(formatTokenCount(undefined)).toBe('Unknown');
  });
});

describe('usage billing copy', () => {
  it('keeps unknown account billing explicit', () => {
    const copy = billingCopy('unknown');
    expect(copy.label).toBe('Usage');
    expect(copy.title).toBe('Usage and billing');
    expect(copy.description).toContain('Connect a model provider');
    expect(copy.description).toContain('Exact dollar charges are unavailable');
    expect(copy.description).not.toContain('$');
    expect(copy.description).not.toContain('free');
  });

  it('identifies ChatGPT subscription usage without requesting another connection', () => {
    const copy = billingCopy('chatgpt');
    expect(copy.label).toBe('Subscription');
    expect(copy.title).toBe('ChatGPT subscription usage');
    expect(copy.description).toContain('your ChatGPT subscription');
    expect(copy.description).toContain('Exact dollar charges are unavailable');
    expect(copy.description).not.toContain('Connect');
    expect(copy.description).not.toContain('$');
    expect(copy.description).not.toContain('free');
  });

  it('names API billing and leaves charges unknown', () => {
    expect(billingCopy('apiKey')).toEqual({
      label: 'API usage',
      title: 'API usage',
      description:
        'Charges depend on your provider. ejm-ide reports token usage; exact dollar charges are unavailable.',
    });
    expect(billingCopy(null).title).toBe('Usage and billing');
    expect(billingCopy('future-auth').label).toBe('Usage');
  });
});

describe('chat usage details', () => {
  it('renders unknown detail and reported zero while retaining context and total counts', () => {
    const usage = parseChatUsage({
      tokenUsage: {
        total: { ...counts, cachedInputTokens: null, reasoningOutputTokens: 0 },
        last: { ...counts, cachedInputTokens: null, reasoningOutputTokens: 0 },
        modelContextWindow: 10_000,
      },
    });
    expect(usage).not.toBeNull();
    const markup = renderToStaticMarkup(
      createElement(ChatUsage, { usage, accountType: 'chatgpt' }),
    );
    expect(markup).toContain('<dt>Cached input</dt><dd>Unknown</dd>');
    expect(markup).toContain('<dt>Reasoning output</dt><dd>0</dd>');
    expect(markup).toContain('<dt>Total reported</dt><dd>1,120</dd>');
    expect(markup).toContain('Context: 11%, 1,120 of 10,000 tokens');
    expect(markup).toContain('Their sums may be partial when requests omit these details.');
    expect(markup).toContain('ChatGPT subscription usage');
    expect(markup).not.toContain('Connect a model provider');
  });

  it('renders reported subsets without adding them to input and output totals', () => {
    const usage = parseChatUsage(notification());
    const markup = renderToStaticMarkup(createElement(ChatUsage, { usage, accountType: 'apiKey' }));
    expect(markup).toContain('<dt>Input tokens</dt><dd>10,000</dd>');
    expect(markup).toContain('<dt>Cached input</dt><dd>700</dd>');
    expect(markup).toContain('<dt>Output tokens</dt><dd>120</dd>');
    expect(markup).toContain('<dt>Reasoning output</dt><dd>20</dd>');
    expect(markup).toContain('<dt>Total reported</dt><dd>10,120</dd>');
    expect(markup).toContain('input/output totals.');
  });
});
