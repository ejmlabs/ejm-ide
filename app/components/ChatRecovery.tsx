import { Check, Copy, LoaderCircle, WrapText, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from './ui/button';
import './chat-recovery.css';

type RecoveryAction = 'reconnect' | 'connections';
interface Recovery {
  summary: string;
  hint?: string;
  action?: RecoveryAction;
}

// Classify only known recovery paths. Keep the complete source error in Details.
export function chatRecovery(error: string): Recovery {
  if (/browser (?:view|preview)|models connect in the desktop app/i.test(error))
    return { summary: 'Models connect in the desktop app.' };
  if (/chat history could not open|open a saved chat or reconnect/i.test(error))
    return { summary: 'Chat history could not open.', action: 'reconnect' };
  if (
    /HTTP\s+(?:401|403)\b|401\s+unauthorized|403\s+forbidden|(?:status|status_code)\s*[:=]?\s*(?:401|403)\b|invalid[_ ]api[_ ]key|incorrect api key|authentication (?:failed|error|required)|not authenticated|sign(?:ed)?[ -]out|subscription access unavailable|no (?:api key|credential|provider)|missing (?:api key|credential|provider)|account.*(?:unavailable|expired)|token (?:has )?expired/i.test(
      error,
    )
  )
    return {
      summary: 'This connection needs attention.',
      hint: 'Check your sign-in or API key.',
      action: 'connections',
    };
  if (
    /HTTP\s+429\b|429\s+too many requests|(?:status|status_code)\s*[:=]?\s*429\b|rate[_ -]?limit|insufficient[_ ]quota|quota (?:exceeded|exhausted)|insufficient[_ ]credits/i.test(
      error,
    )
  )
    return {
      summary: 'The provider has reached a usage limit.',
      hint: 'Check the details before sending another request.',
      action: 'connections',
    };
  if (
    /invalid_request_error|(?:HTTP\s+)?400\s+bad request|model(?:[^\n]{0,70})(?:not found|not supported|unsupported|unavailable)|reasoning_effort.*not supported/i.test(
      error,
    )
  )
    return {
      summary: 'The provider rejected this request.',
      hint: 'Check the model and connection settings.',
      action: 'connections',
    };
  if (
    /disconnected|connection (?:failed|refused|reset|closed|lost)|failed to fetch|fetch failed|network (?:error|request failed|unavailable|failure)|timed? ?out|timeout|(?:HTTP\s+)?50[0234]\s|service unavailable|failed to send request|error sending request/i.test(
      error,
    )
  )
    return { summary: 'The provider connection was interrupted.', action: 'reconnect' };
  const firstLine = error
    .replace(/^Error:\s*/i, '')
    .split('\n', 1)[0]
    ?.trim();
  if (firstLine && firstLine.length <= 160 && !/^(?:\{|\[|HTTP\b)|[<>]/i.test(firstLine))
    return { summary: firstLine };
  return { summary: 'This action could not finish.' };
}

export function ChatSetup({
  preview,
  disabled,
  onConnect,
}: {
  preview: boolean;
  disabled: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="chat-setup">
      <strong>Connect to start a chat</strong>
      <p>Choose Codex, Anthropic, or an API key.</p>
      <Button size="sm" onClick={onConnect} disabled={disabled}>
        Connect
      </Button>
      {preview && <p className="chat-preview-note">Browser preview. Connect in the desktop app.</p>}
    </div>
  );
}

export function ChatRecovery({
  error,
  disabled,
  connecting,
  onReconnect,
  onManageConnections,
  onDismiss,
  models = false,
}: {
  error: string;
  disabled: boolean;
  connecting: boolean;
  onReconnect: () => void;
  onManageConnections: () => void;
  onDismiss?: () => void;
  models?: boolean;
}) {
  const recovery = models
    ? { summary: 'Models could not load.', action: 'reconnect' as const }
    : chatRecovery(error);
  const [wrap, setWrap] = useState(true);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(error);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }
  return (
    <div
      className={`chat-recovery${models ? ' chat-recovery-models' : ''}`}
      role={models ? 'status' : 'alert'}
    >
      <div className="chat-recovery-heading">
        <strong>{recovery.summary}</strong>
        {onDismiss && (
          <Button variant="ghost" size="icon" onClick={onDismiss} aria-label="Dismiss chat error">
            <X size={13} />
          </Button>
        )}
      </div>
      {'hint' in recovery && recovery.hint && <p>{recovery.hint}</p>}
      <div className="chat-recovery-actions">
        {recovery.action && (
          <Button
            variant="ghost"
            size="sm"
            className="chat-recovery-action"
            disabled={disabled || connecting}
            onClick={recovery.action === 'reconnect' ? onReconnect : onManageConnections}
            title={
              recovery.action === 'reconnect'
                ? 'Reconnect without resending the request'
                : undefined
            }
          >
            {recovery.action === 'reconnect' && connecting && (
              <LoaderCircle size={12} className="spin" />
            )}
            {recovery.action === 'reconnect'
              ? connecting
                ? 'Connecting…'
                : 'Reconnect'
              : 'Manage connections'}
          </Button>
        )}
        <details className="chat-recovery-details">
          <summary>Details</summary>
          <div className="chat-recovery-detail-controls">
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={wrap}
              aria-label="Wrap error details"
              onClick={() => setWrap((value) => !value)}
            >
              <WrapText size={12} />
              Wrap
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copy()}
              aria-label="Copy error details"
            >
              {copyStatus === 'copied' ? <Check size={12} /> : <Copy size={12} />}
              {copyStatus === 'copied' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {copyStatus === 'failed' && (
            <p role="status">Could not copy. Select the details to copy them.</p>
          )}
          <pre className={wrap ? 'chat-error-wrap' : undefined}>{error}</pre>
        </details>
      </div>
    </div>
  );
}
