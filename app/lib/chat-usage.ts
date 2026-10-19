export interface ChatTokenBreakdown {
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number | null;
  totalTokens: number;
  cacheWriteInputTokens?: number;
}

export interface ChatTokenUsage {
  total: ChatTokenBreakdown;
  last: ChatTokenBreakdown | null;
  modelContextWindow: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Omitted and null details mean unreported; a reported zero remains zero. */
function optionalTokenCount(value: unknown): value is number | null | undefined {
  return value === null || value === undefined || tokenCount(value);
}

function breakdown(value: unknown): ChatTokenBreakdown | null {
  const input = record(value);
  if (
    !input ||
    !tokenCount(input.inputTokens) ||
    !optionalTokenCount(input.cachedInputTokens) ||
    !tokenCount(input.outputTokens) ||
    !optionalTokenCount(input.reasoningOutputTokens) ||
    !tokenCount(input.totalTokens) ||
    (input.cacheWriteInputTokens !== undefined && !tokenCount(input.cacheWriteInputTokens))
  )
    return null;
  return {
    inputTokens: input.inputTokens,
    cachedInputTokens: input.cachedInputTokens ?? null,
    outputTokens: input.outputTokens,
    reasoningOutputTokens: input.reasoningOutputTokens ?? null,
    totalTokens: input.totalTokens,
    ...(input.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: input.cacheWriteInputTokens }),
  };
}

/** Parse usage from an open-chat response or notification. Each report replaces its snapshot. */
export function parseChatUsage(params: unknown): ChatTokenUsage | null {
  const input = record(record(params)?.tokenUsage);
  if (!input) return null;
  const total = breakdown(input.total);
  const last = breakdown(input.last);
  if (!total || (!last && input.last !== null)) return null;
  return {
    total,
    last,
    modelContextWindow:
      tokenCount(input.modelContextWindow) && input.modelContextWindow > 0
        ? input.modelContextWindow
        : null,
  };
}

export interface ContextUsage {
  used: number | null;
  limit: number | null;
  fraction: number | null;
  label: string;
}

export function contextUsage(usage: ChatTokenUsage | null): ContextUsage {
  const used = usage?.last?.totalTokens ?? null;
  const limit = usage?.modelContextWindow ?? null;
  if (used === null || limit === null) return { used, limit, fraction: null, label: 'Context' };
  const fraction = used / limit;
  const percent = fraction * 100;
  return {
    used,
    limit,
    fraction: Math.min(fraction, 1),
    label: percent > 100 ? '100%+' : percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`,
  };
}

const tokenFormatter = new Intl.NumberFormat('en-US');
export function formatTokenCount(value: number | null | undefined): string {
  return tokenCount(value) ? tokenFormatter.format(value) : 'Unknown';
}

export interface BillingCopy {
  label: string;
  title: string;
  description: string;
}

export function billingCopy(accountType: string | null): BillingCopy {
  if (accountType === 'chatgpt')
    return {
      label: 'Subscription',
      title: 'ChatGPT subscription usage',
      description:
        'ejm-ide reports token usage for your ChatGPT subscription. Exact dollar charges are unavailable.',
    };
  if (accountType === 'apiKey')
    return {
      label: 'API usage',
      title: 'API usage',
      description:
        'Charges depend on your provider. ejm-ide reports token usage; exact dollar charges are unavailable.',
    };
  return {
    label: 'Usage',
    title: 'Usage and billing',
    description:
      'Connect a model provider to see token usage. Exact dollar charges are unavailable.',
  };
}
