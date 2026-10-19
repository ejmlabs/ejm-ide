import { createTwoFilesPatch } from 'diff';
import type {
  GitBlame,
  GitCommit,
  GitCommitDetail,
  GitCompare,
  GitDiff,
  GitDiffRequest,
  GitFileStat,
  GitHistory,
  GitRef,
  GitStatus,
} from './git';

const ids = ['a61c0e2', 'b37e194', 'c82ad61', 'd410b58', 'e22c930', 'f70a4d1'].map((id) =>
  id.padEnd(40, '0'),
);
const commits: GitCommit[] = [
  {
    id: ids[0],
    parents: [ids[1], ids[2]],
    subject: 'Merge retry-safe payments',
    author: 'Alex Chen',
    email: 'alex@example.test',
    date: 1792267200,
    refs: ['HEAD -> main', 'origin/main'],
  },
  {
    id: ids[1],
    parents: [ids[3]],
    subject: 'Keep totals in integer cents',
    author: 'Sam Rivera',
    email: 'sam@example.test',
    date: 1792256400,
    refs: [],
  },
  {
    id: ids[2],
    parents: [ids[3]],
    subject: 'Reuse receipts when an order is retried',
    author: 'Alex Chen',
    email: 'alex@example.test',
    date: 1792252800,
    refs: ['feature/safe-retries'],
  },
  {
    id: ids[3],
    parents: [ids[4]],
    subject: 'Clamp percentage discounts',
    author: 'Sam Rivera',
    email: 'sam@example.test',
    date: 1792170000,
    refs: ['tag: v0.2.0'],
  },
  {
    id: ids[4],
    parents: [ids[5]],
    subject: 'Add payment reconciliation',
    author: 'Alex Chen',
    email: 'alex@example.test',
    date: 1792083600,
    refs: [],
  },
  {
    id: ids[5],
    parents: [],
    subject: 'Create the Harbor workspace',
    author: 'Sam Rivera',
    email: 'sam@example.test',
    date: 1791997200,
    refs: [],
  },
];

/** Explicit read-only sample data for the browser, never a fallback for native Git failures. */
export function previewGit(
  command: string,
  args: Record<string, unknown>,
  root: string,
  files: Record<string, string>,
): unknown {
  const absolute = (path: string) => `${root}/${path}`;
  const relative = (path: string) => path.replace(`${root}/`, '');
  const stats: GitFileStat[] = [
    { path: absolute('src/orders.rs'), status: 'M', additions: 4, deletions: 0 },
    { path: absolute('src/money.rs'), status: 'M', additions: 1, deletions: 1 },
  ];
  const resolve = (revision: string) =>
    commits.find((commit) => commit.id === revision || commit.id.startsWith(revision)) ||
    commits[revision.includes('safe-retries') ? 2 : 0];
  switch (command) {
    case 'git_status':
      return {
        available: true,
        repositoryRoot: root,
        branch: 'main',
        head: ids[0],
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        indexVersion: 'preview-index',
        truncated: false,
        changes: [
          {
            path: absolute('src/orders.rs'),
            relativePath: 'src/orders.rs',
            indexStatus: 'M',
            worktreeStatus: 'M',
            untracked: false,
            conflicted: false,
          },
          {
            path: absolute('src/money.rs'),
            relativePath: 'src/money.rs',
            indexStatus: '.',
            worktreeStatus: 'M',
            untracked: false,
            conflicted: false,
          },
          {
            path: absolute('README.md'),
            relativePath: 'README.md',
            indexStatus: '?',
            worktreeStatus: '?',
            untracked: true,
            conflicted: false,
          },
        ],
      } satisfies GitStatus;
    case 'git_refs':
      return [
        {
          name: 'main',
          fullName: 'refs/heads/main',
          kind: 'branch',
          current: true,
          upstream: 'origin/main',
          id: ids[0],
        },
        {
          name: 'feature/safe-retries',
          fullName: 'refs/heads/feature/safe-retries',
          kind: 'branch',
          current: false,
          upstream: null,
          id: ids[2],
        },
        {
          name: 'origin/main',
          fullName: 'refs/remotes/origin/main',
          kind: 'remote',
          current: false,
          upstream: null,
          id: ids[0],
        },
        {
          name: 'v0.2.0',
          fullName: 'refs/tags/v0.2.0',
          kind: 'tag',
          current: false,
          upstream: null,
          id: ids[3],
        },
      ] satisfies GitRef[];
    case 'git_history': {
      const query = String(args.query || '').toLowerCase();
      const filtered = commits.filter((commit) =>
        `${commit.subject} ${commit.author} ${commit.id}`.toLowerCase().includes(query),
      );
      const start = Number(args.skip) || 0;
      const limit = Number(args.limit) || 60;
      return {
        commits: filtered.slice(start, start + limit),
        hasMore: start + limit < filtered.length,
        truncated: false,
      } satisfies GitHistory;
    }
    case 'git_commit_detail': {
      const commit = resolve(String(args.revision));
      return {
        commit,
        message: `${commit.subject}\n\nRecorded in the read-only Harbor browser preview.`,
        files: stats,
        truncated: false,
      } satisfies GitCommitDetail;
    }
    case 'git_compare': {
      const base = resolve(String(args.base)).id;
      const head = resolve(String(args.head)).id;
      const same = base === head;
      return {
        base,
        head,
        mergeBase: same ? base : ids[3],
        ahead: same ? 0 : 2,
        behind: same ? 0 : 1,
        files: same ? [] : stats,
        truncated: false,
      } satisfies GitCompare;
    }
    case 'git_diff': {
      const request = args.request as GitDiffRequest;
      const path = request.path || absolute('src/orders.rs');
      const name = relative(path);
      const modified = files[name] || '';
      let original = modified;
      if (name === 'src/orders.rs') {
        original =
          request.scope === 'worktree'
            ? modified.replace(
                'The order key also identifies the payment, so a retry is safe.',
                'The order key identifies the payment.',
              )
            : modified.replace(
                '    if let Some(receipt) = store.find_receipt(&order.key)? {\n        return Ok(receipt);\n    }\n\n',
                '',
              );
      } else if (name === 'src/money.rs') {
        original = modified.replace('percent.min(100)', 'percent');
      } else if (name === 'README.md') {
        original = '';
      }
      return {
        path,
        original,
        modified,
        text: createTwoFilesPatch(`a/${name}`, `b/${name}`, original, modified),
        binary: false,
        truncated: false,
      } satisfies GitDiff;
    }
    case 'git_blame': {
      const path = String(args.path);
      const saved = files[relative(path)] || '';
      const content = typeof args.content === 'string' ? args.content : saved;
      const source = content.split('\n');
      const start = Math.max(1, Number(args.startLine) || 1);
      const end = Math.min(source.length, Number(args.endLine) || source.length);
      return {
        path,
        truncated: false,
        lines: source.slice(start - 1, end).map((_, offset) => {
          const line = start + offset;
          const uncommitted = source[line - 1] !== saved.split('\n')[line - 1];
          return {
            line,
            originalLine: line,
            commit: uncommitted ? '0'.repeat(40) : ids[2],
            author: uncommitted ? 'You' : 'Alex Chen',
            date: uncommitted ? 0 : commits[2].date,
            summary: uncommitted ? 'Uncommitted changes' : commits[2].subject,
            uncommitted,
          };
        }),
      } satisfies GitBlame;
    }
    default:
      throw new Error(
        'The browser preview is read-only. Use the desktop app to change Git history or staging.',
      );
  }
}
