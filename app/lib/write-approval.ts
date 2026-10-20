export const WARNING_WINDOW_MS = 5 * 60 * 1000;
export const DECISION_DEADLINE_MS = 20 * 60 * 1000;
export const MAX_RETRY_PROMPT = 256 * 1024;

export const PROTECTED_PATHS = [
  'build.rs',
  'Cargo.toml',
  'package.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Makefile',
  'GNUmakefile',
  'Rakefile',
  'Gemfile',
  'Guardfile',
  'Brewfile',
  'rust-toolchain',
  'rust-toolchain.toml',
  '.rubocop.yml',
  'Files matching *.gemspec or *.config.*',
  'Rust files in a package whose nearest Cargo.toml sets proc-macro',
  'Any directory named .cargo, .github, .workbench, .vscode, or scripts',
] as const;

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'timedOut'
  | 'cancelled'
  | 'stale'
  | 'error';

export interface WriteApproval {
  reviewId: string;
  path: string;
  rawPath?: string;
  kind: 'add' | 'update';
  category: string;
  title: string;
  explanation: string;
  before: string;
  after: string;
  reviewerNote: string;
  ediReason?: string;
  deniedEarlier: boolean;
  expiresAtMs: number;
  connectionId?: number;
  status: ApprovalStatus;
  detail?: string;
}

export function expiryMinutes(remainingMs: number): number | null {
  if (remainingMs <= 0 || remainingMs > WARNING_WINDOW_MS) return null;
  return Math.max(1, Math.ceil(remainingMs / 60_000));
}

export function expiryWarningText(remainingMs: number): string | null {
  const minutes = expiryMinutes(remainingMs);
  if (minutes === null) return null;
  return `This request expires in ${minutes} min if you don't respond.`;
}

export function approvalActivity(pending: boolean): string | null {
  return pending ? 'Waiting for your approval' : null;
}

export function showApprovalBadge(pending: boolean, chatOpen: boolean): boolean {
  return pending && !chatOpen;
}

/** Pointer clicks approve. Enter and Space synthesize a click with detail 0. */
export function enterApproves(detail = 0): boolean {
  return detail > 0;
}

export function collapsedApprovalText(approval: WriteApproval): string {
  switch (approval.status) {
    case 'approved':
      return `Approved · ${approval.path}`;
    case 'denied':
      return `Denied · ${approval.path}`;
    case 'timedOut':
      return 'Timed out · not applied';
    case 'cancelled':
      return `Cancelled · ${approval.path} · not applied`;
    case 'stale':
    case 'error':
      return `Couldn't apply change to ${approval.path}: ${approval.detail || 'The file was not written.'}`;
    default:
      return approval.title;
  }
}

export function retryPrompt(
  approval: Pick<WriteApproval, 'path' | 'before' | 'after'>,
): { text: string } | { error: string } {
  const text = [
    `The approval to change ${approval.path} timed out and nothing was written. Propose that same change again.`,
    '',
    `Path: ${approval.path}`,
    'Previous content:',
    approval.before,
    'Proposed content:',
    approval.after,
  ].join('\n');
  if (text.length > MAX_RETRY_PROMPT) {
    return {
      error: 'This change is too large to ask Edi to propose again in one message.',
    };
  }
  return { text };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function parseWriteApproval(params: unknown): WriteApproval | null {
  if (!params || typeof params !== 'object') return null;
  const record = params as Record<string, unknown>;
  const path = text(record.path);
  const reviewId = text(record.reviewId);
  const before = text(record.before);
  const after = text(record.after);
  const title = text(record.title);
  const explanation = text(record.explanation);
  const category = text(record.category);
  const reviewerNote = text(record.reviewerNote);
  const kind = record.kind === 'add' || record.kind === 'update' ? record.kind : null;
  const expiresAtMs = record.expiresAtMs;
  if (
    !path ||
    !reviewId ||
    before === undefined ||
    after === undefined ||
    !title ||
    !explanation ||
    !category ||
    reviewerNote === undefined ||
    !kind ||
    typeof expiresAtMs !== 'number' ||
    !Number.isFinite(expiresAtMs)
  ) {
    return null;
  }
  return {
    reviewId,
    path,
    rawPath: text(record.rawPath),
    kind,
    category,
    title,
    explanation,
    before,
    after,
    reviewerNote,
    ediReason: text(record.ediReason),
    deniedEarlier: record.deniedEarlier === true,
    expiresAtMs,
    status: 'pending',
  };
}

export function approvalStatusFromReview(status: unknown): ApprovalStatus | null {
  switch (status) {
    case 'approved':
    case 'denied':
    case 'timedOut':
    case 'cancelled':
    case 'stale':
      return status;
    default:
      return null;
  }
}
