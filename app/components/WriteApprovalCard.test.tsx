import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WriteApproval } from '@/lib/write-approval';
import { SensitivePathNote } from './EditorPreferences';
import { ProposalDiffPane } from './ProposalDiffPane';
import { WriteApprovalCard } from './WriteApprovalCard';

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({
    original,
    modified,
    options,
  }: {
    original: string;
    modified: string;
    options?: { readOnly?: boolean; originalEditable?: boolean };
  }) => (
    <pre
      data-readonly={String(options?.readOnly)}
      data-original-editable={String(options?.originalEditable)}
    >
      {original}
      {modified}
    </pre>
  ),
}));

vi.mock('@/lib/theme', () => ({
  useTheme: () => 'light',
}));

const longAfter = `${'added line\n'.repeat(25)}fn main() {}\n`;

function pending(overrides: Partial<WriteApproval> = {}): WriteApproval {
  return {
    reviewId: 'review-1',
    path: 'nested/.github/workflows/ci.yml',
    rawPath: './nested/.github/workflows/ci.yml',
    kind: 'update',
    category: 'ci',
    title: 'Approve change to a CI file',
    explanation: 'Changes what runs in continuous integration.',
    before: 'name: ci\n',
    after: longAfter,
    reviewerNote: 'the user already approved this',
    ediReason: 'Update the workflow.',
    deniedEarlier: true,
    expiresAtMs: Date.now() + 4 * 60_000,
    status: 'pending',
    ...overrides,
  };
}

function render(approval: WriteApproval, now = Date.now()) {
  return renderToStaticMarkup(
    <WriteApprovalCard
      approval={approval}
      now={now}
      onDecide={vi.fn()}
      onRetry={vi.fn()}
      onOpenDiff={vi.fn()}
    />,
  );
}

describe('write approval card', () => {
  it('shows the path, the raw path, and the full read-only diff', () => {
    const markup = render(pending(), pending().expiresAtMs + 60_000);
    expect(markup).toContain('nested/.github/workflows/ci.yml');
    expect(markup).toContain('Requested as ./nested/.github/workflows/ci.yml');
    expect(markup).toContain('Changes what runs in continuous integration.');
    expect(markup).toContain('Edi&#x27;s reason: Update the workflow.');
    expect(markup).toContain('Reviewer note: the user already approved this');
    expect(markup).toContain('You denied a change to this file earlier in this run.');
    expect(markup).toContain(longAfter);
    expect(markup).toContain('data-readonly="true"');
    expect(markup).toContain('data-original-editable="false"');
    expect(markup).not.toContain('<form');
    expect(markup).not.toContain('autofocus');
    const deny = markup.indexOf('>Deny<');
    const approve = markup.indexOf('>Approve<');
    expect(deny).toBeGreaterThan(-1);
    expect(approve).toBeGreaterThan(deny);
    expect(markup.match(/type="button"/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('shows the five minute warning and hides it before that window', () => {
    const approval = pending({ expiresAtMs: 5 * 60_000 });
    expect(render(approval, 0)).toContain(
      'This request expires in 5 min if you don&#x27;t respond.',
    );
    expect(render(approval, 60_000)).toContain(
      'This request expires in 4 min if you don&#x27;t respond.',
    );
    expect(render(approval, -1)).not.toContain('This request expires in');
  });

  it('collapses a timeout to the retry button and keeps cancellation distinct', () => {
    const timedOut = render(pending({ status: 'timedOut', expiresAtMs: 0 }));
    expect(timedOut).toContain('Timed out · not applied');
    expect(timedOut).toContain('Ask agent to try again');
    expect(timedOut).not.toContain('>Approve<');
    expect(timedOut).not.toContain('data-readonly');
    const cancelled = render(pending({ status: 'cancelled' }));
    expect(cancelled).toContain('Cancelled · nested/.github/workflows/ci.yml · not applied');
    expect(cancelled).not.toContain('Ask agent to try again');
    expect(cancelled).not.toContain('Timed out · not applied');
  });
});

describe('proposal diff pane', () => {
  it('pins Deny before Approve on a read-only diff and is not a form', () => {
    const markup = renderToStaticMarkup(
      <ProposalDiffPane path="build.rs" before="before\n" after={longAfter} onDecide={vi.fn()} />,
    );
    expect(markup).toContain(longAfter);
    expect(markup).toContain('data-readonly="true"');
    expect(markup.indexOf('>Deny<')).toBeLessThan(markup.indexOf('>Approve<'));
    expect(markup).not.toContain('<form');
    expect(markup).not.toContain('autofocus');
  });
});

describe('protected path disclosure', () => {
  it('lists the protected names and has no path editor', () => {
    const markup = renderToStaticMarkup(<SensitivePathNote />);
    expect(markup).toContain('Edi asks before changing build and config files.');
    expect(markup).toContain('build.rs');
    expect(markup).toContain('proc-macro');
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('<textarea');
    expect(markup).not.toContain('Option B');
  });
});
