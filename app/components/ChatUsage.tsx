import { ReceiptText } from 'lucide-react';
import { billingCopy, type ChatTokenUsage, contextUsage, formatTokenCount } from '@/lib/chat-usage';
import { Tooltip } from './ui/tooltip';
import './chat-usage.css';

export interface ChatUsageProps {
  usage: ChatTokenUsage | null;
  accountType: string | null;
  busy?: boolean;
}

export function ChatUsage({ usage, accountType, busy = false }: ChatUsageProps) {
  const context = contextUsage(usage);
  const billing = billingCopy(accountType);
  const contextLabel =
    context.used !== null && context.limit !== null
      ? `Context: ${context.label}, ${formatTokenCount(context.used)} of ${formatTokenCount(context.limit)} tokens`
      : context.used !== null
        ? `Context: ${formatTokenCount(context.used)} tokens reported, window size unavailable`
        : 'Context usage has not been reported';
  const total = usage?.total;
  return (
    <div className="chat-usage">
      <Tooltip
        side="top"
        label={
          <div className="chat-usage-detail">
            <strong>Context window</strong>
            <p>
              {context.used !== null && context.limit !== null
                ? `${formatTokenCount(context.used)} / ${formatTokenCount(context.limit)} tokens (${context.label})`
                : context.used !== null
                  ? `${formatTokenCount(context.used)} tokens reported. Window size is unavailable.`
                  : 'The provider has not reported usage for this chat yet.'}
            </p>
            <p className="chat-usage-note">
              Latest model response. Excludes the unsent draft and its attachments.
              {busy ? ' Updates as usage is reported during the response.' : ''}
            </p>
          </div>
        }
      >
        <button type="button" className="chat-usage-context" aria-label={contextLabel}>
          <svg
            className={`chat-context-ring ${context.fraction === null ? 'unknown' : ''}`}
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <circle className="chat-context-track" cx="8" cy="8" r="6" strokeWidth="2" />
            {context.fraction !== null && (
              <circle
                className="chat-context-fill"
                cx="8"
                cy="8"
                r="6"
                strokeWidth="2"
                pathLength="100"
                strokeDasharray={`${context.fraction * 100} 100`}
                transform="rotate(-90 8 8)"
              />
            )}
          </svg>
          <span>{context.label}</span>
        </button>
      </Tooltip>
      <Tooltip
        side="top"
        label={
          <div className="chat-usage-detail">
            <strong>{billing.title}</strong>
            <p>{billing.description}</p>
            {total ? (
              <>
                <dl className="chat-token-breakdown">
                  <div>
                    <dt>Input tokens</dt>
                    <dd>{formatTokenCount(total.inputTokens)}</dd>
                  </div>
                  <div>
                    <dt>Cached input</dt>
                    <dd>{formatTokenCount(total.cachedInputTokens)}</dd>
                  </div>
                  {total.cacheWriteInputTokens !== undefined && (
                    <div>
                      <dt>Cache write input</dt>
                      <dd>{formatTokenCount(total.cacheWriteInputTokens)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Output tokens</dt>
                    <dd>{formatTokenCount(total.outputTokens)}</dd>
                  </div>
                  <div>
                    <dt>Reasoning output</dt>
                    <dd>{formatTokenCount(total.reasoningOutputTokens)}</dd>
                  </div>
                  <div className="chat-token-total">
                    <dt>Total reported</dt>
                    <dd>{formatTokenCount(total.totalTokens)}</dd>
                  </div>
                </dl>
                <p className="chat-usage-note">
                  Cumulative token usage reported for this chat. Cache and reasoning counts are part
                  of input/output totals. Their sums may be partial when requests omit these
                  details.
                </p>
              </>
            ) : (
              <p className="chat-usage-note">Token usage appears when the provider reports it.</p>
            )}
          </div>
        }
      >
        <button
          type="button"
          className="chat-usage-billing"
          aria-label={`Token usage and billing: ${billing.title}`}
        >
          <ReceiptText size={12} aria-hidden="true" />
          <span>{billing.label}</span>
        </button>
      </Tooltip>
    </div>
  );
}
