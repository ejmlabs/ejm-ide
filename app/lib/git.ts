export interface GitFileChange {
  path: string;
  relativePath: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  available: boolean;
  repositoryRoot: string | null;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  indexVersion: string;
  changes: GitFileChange[];
  truncated: boolean;
}

export interface GitCommit {
  id: string;
  parents: string[];
  subject: string;
  author: string;
  email: string;
  date: number;
  refs: string[];
}

export interface GitHistory {
  commits: GitCommit[];
  hasMore: boolean;
  truncated: boolean;
}

export interface GitRef {
  name: string;
  fullName: string;
  kind: 'branch' | 'remote' | 'tag';
  current: boolean;
  upstream: string | null;
  id: string;
}

export interface GitFileStat {
  path: string;
  originalPath?: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface GitCommitDetail {
  commit: GitCommit;
  message: string;
  files: GitFileStat[];
  truncated: boolean;
}

export interface GitCompare {
  base: string;
  head: string;
  mergeBase: string | null;
  ahead: number;
  behind: number;
  files: GitFileStat[];
  truncated: boolean;
}

export interface GitBlameLine {
  line: number;
  originalLine: number;
  commit: string;
  author: string;
  date: number;
  summary: string;
  uncommitted: boolean;
}

export interface GitBlame {
  path: string;
  lines: GitBlameLine[];
  truncated: boolean;
}

export interface GitDiffRequest {
  scope: 'worktree' | 'index' | 'commit' | 'compare';
  path?: string;
  originalPath?: string;
  revision?: string;
  base?: string;
  head?: string;
}

export interface GitDiff {
  text: string;
  path?: string;
  original?: string;
  modified?: string;
  binary: boolean;
  truncated: boolean;
}
