import { useState } from 'react';
import { enterApproves } from '@/lib/write-approval';
import { ApprovalDiff } from './ApprovalDiff';
import { Button } from './ui/button';

export function ProposalDiffPane({
  path,
  before,
  after,
  onDecide,
}: {
  path: string;
  before: string;
  after: string;
  onDecide: (decision: 'approve' | 'deny', note: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <section className="git-diff-pane" aria-label={`Proposed change to ${path}`}>
      <header className="tool-subheader">
        <span className="git-diff-title">{path}</span>
        <div className="header-actions">
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
        </div>
      </header>
      <ApprovalDiff path={path} before={before} after={after} label={`${path} diff`} />
      <textarea
        aria-label="Note for Edi"
        maxLength={1000}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
    </section>
  );
}
