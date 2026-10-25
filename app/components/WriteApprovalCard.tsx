import { useState } from 'react';
import {
  collapsedApprovalText,
  enterApproves,
  expiryWarningText,
  retryPrompt,
  type WriteApproval,
} from '@/lib/write-approval';
import { ApprovalDiff } from './ApprovalDiff';
import { Button } from './ui/button';

export function WriteApprovalCard({
  approval,
  now = Date.now(),
  onDecide,
  onRetry,
  onOpenDiff,
}: {
  approval: WriteApproval;
  now?: number;
  onDecide: (decision: 'approve' | 'deny', note: string) => void;
  onRetry: (text: string) => void;
  onOpenDiff: (approval: WriteApproval) => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [retryError, setRetryError] = useState('');
  const warning =
    approval.status === 'pending' ? expiryWarningText(approval.expiresAtMs - now) : null;
  if (approval.status !== 'pending') {
    const prompt = approval.status === 'timedOut' ? retryPrompt(approval) : null;
    return (
      <section className="approval-request" aria-label={`Approval needed: ${approval.path}`}>
        <p role="status">{collapsedApprovalText(approval)}</p>
        {approval.status === 'timedOut' && (
          <div>
            <Button
              type="button"
              variant="secondary"
              onClick={(event) => {
                if (!enterApproves(event.detail)) return;
                if (!prompt || 'error' in prompt) {
                  setRetryError(
                    prompt && 'error' in prompt ? prompt.error : 'The change is unavailable.',
                  );
                  return;
                }
                onRetry(prompt.text);
              }}
            >
              Ask agent to try again
            </Button>
          </div>
        )}
        {retryError && <p role="alert">{retryError}</p>}
      </section>
    );
  }
  return (
    <section className="approval-request" aria-label={`Approval needed: ${approval.path}`}>
      <p>
        <strong>{approval.title}</strong>
      </p>
      <p>
        {approval.path} · {approval.kind === 'add' ? 'new file' : 'modified'}
      </p>
      {approval.rawPath && approval.rawPath !== approval.path && (
        <p>Requested as {approval.rawPath}</p>
      )}
      <p>{approval.explanation}</p>
      {approval.ediReason && <p>Edi's reason: {approval.ediReason}</p>}
      {approval.reviewerNote && <p>Reviewer note: {approval.reviewerNote}</p>}
      {approval.deniedEarlier && <p>You denied a change to this file earlier in this run.</p>}
      {warning && <p role="status">{warning}</p>}
      <ApprovalDiff
        path={approval.path}
        before={approval.before}
        after={approval.after}
        label={`${approval.path} diff`}
      />
      <div>
        <Button type="button" variant="secondary" onClick={() => onOpenDiff(approval)}>
          Open side-by-side diff
        </Button>
      </div>
      <div>
        <Button type="button" variant="secondary" onClick={() => onDecide('deny', note)}>
          Deny
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={(event) => {
            if (enterApproves(event.detail)) onDecide('approve', note);
          }}
        >
          Approve
        </Button>
        <Button type="button" variant="ghost" onClick={() => setNoteOpen((open) => !open)}>
          Add a note for Edi
        </Button>
      </div>
      {noteOpen && (
        <textarea
          aria-label="Note for Edi"
          maxLength={1000}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      )}
    </section>
  );
}
