import { describe, expect, it } from 'vitest';
import {
  approvalActivity,
  collapsedApprovalText,
  enterApproves,
  expiryWarningText,
  retryPrompt,
  showApprovalBadge,
  type WriteApproval,
} from './write-approval';

const MINUTE = 60_000;

function approval(status: WriteApproval['status'], detail?: string): WriteApproval {
  return {
    reviewId: 'review-1',
    path: 'build.rs',
    kind: 'update',
    category: 'build',
    title: 'Approve change to a build file',
    explanation: 'Runs or changes what runs when the project builds or installs.',
    before: 'fn main() {}\n',
    after: 'fn main() { println!("again"); }\n',
    reviewerNote: '',
    deniedEarlier: false,
    expiresAtMs: 0,
    status,
    detail,
  };
}

describe('confirmation deadline warning', () => {
  it('counts down in whole minutes during the last 5 minutes', () => {
    expect(expiryWarningText(5 * MINUTE)).toBe(
      "This request expires in 5 min if you don't respond.",
    );
    expect(expiryWarningText(4 * MINUTE + 1)).toBe(
      "This request expires in 5 min if you don't respond.",
    );
    expect(expiryWarningText(4 * MINUTE)).toBe(
      "This request expires in 4 min if you don't respond.",
    );
    expect(expiryWarningText(1)).toBe("This request expires in 1 min if you don't respond.");
    expect(expiryWarningText(5 * MINUTE + 1)).toBeNull();
    expect(expiryWarningText(0)).toBeNull();
    expect(expiryWarningText(-1)).toBeNull();
  });
});

describe('timed out confirmation', () => {
  it('collapses to the exact expiry line and can ask for the same change', () => {
    const timedOut = approval('timedOut');
    expect(collapsedApprovalText(timedOut)).toBe('Timed out · not applied');
    expect(collapsedApprovalText(approval('cancelled'))).toBe('Cancelled · build.rs · not applied');
    const prompt = retryPrompt(timedOut);
    expect(prompt).toEqual({
      text: [
        'The approval to change build.rs timed out and nothing was written. Propose that same change again.',
        '',
        'Path: build.rs',
        'Previous content:',
        'fn main() {}\n',
        'Proposed content:',
        'fn main() { println!("again"); }\n',
      ].join('\n'),
    });
    expect(enterApproves()).toBe(false);
    expect(enterApproves(0)).toBe(false);
    expect(enterApproves(1)).toBe(true);
  });

  it('refuses a retry prompt that exceeds the agent input limit', () => {
    const huge = approval('timedOut');
    huge.after = 'x'.repeat(256 * 1024);
    expect(retryPrompt(huge)).toEqual({
      error: 'This change is too large to ask Edi to propose again in one message.',
    });
  });
});

describe('pending confirmation chrome', () => {
  it('names the waiting state and badges a hidden chat panel', () => {
    expect(approvalActivity(true)).toBe('Waiting for your approval');
    expect(approvalActivity(false)).toBeNull();
    expect(showApprovalBadge(true, false)).toBe(true);
    expect(showApprovalBadge(true, true)).toBe(false);
    expect(showApprovalBadge(false, false)).toBe(false);
  });
});
