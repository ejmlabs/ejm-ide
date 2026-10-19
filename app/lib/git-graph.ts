import type { GitCommit, GitFileChange } from './git';

export interface GitGraphEdge {
  from: number;
  to: number;
  kind: 'incoming' | 'through' | 'parent' | 'boundary';
  color: number;
}

export interface GitGraphRow {
  commit: GitCommit;
  lane: number;
  edges: GitGraphEdge[];
}

export interface GitGraph {
  rows: GitGraphRow[];
  width: number;
  boundaries: number;
}

/** Preserve first-parent lanes and join shared parents without inventing omitted history. */
export function layoutGitGraph(commits: GitCommit[]): GitGraph {
  const visible = new Set(commits.map((commit) => commit.id));
  const lanes: (string | null)[] = [];
  let width = 1;
  let boundaries = 0;
  const rows = commits.map((commit): GitGraphRow => {
    let lane = lanes.indexOf(commit.id);
    const incoming = lane !== -1;
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) lane = lanes.length;
      lanes[lane] = commit.id;
    }
    const edges: GitGraphEdge[] = [];
    for (let index = 0; index < lanes.length; index++) {
      if (lanes[index] && index !== lane)
        edges.push({ from: index, to: index, kind: 'through', color: index });
    }
    if (incoming) edges.push({ from: lane, to: lane, kind: 'incoming', color: lane });
    lanes[lane] = null;
    for (const parent of new Set(commit.parents)) {
      if (!visible.has(parent)) {
        boundaries++;
        edges.push({ from: lane, to: lane, kind: 'boundary', color: lane });
        continue;
      }
      let target = lanes.indexOf(parent);
      if (target === -1) {
        target = lanes[lane] === null ? lane : lanes.indexOf(null);
        if (target === -1) target = lanes.length;
        lanes[target] = parent;
      }
      edges.push({ from: lane, to: target, kind: 'parent', color: target });
    }
    width = Math.max(width, lanes.length, lane + 1);
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    return { commit, lane, edges };
  });
  return { rows, width, boundaries };
}

export function splitGitChanges(changes: GitFileChange[]) {
  const changed = (status: string) => !['', '.', ' ', '?'].includes(status);
  return {
    staged: changes.filter(
      (change) => !change.untracked && !change.conflicted && changed(change.indexStatus),
    ),
    worktree: changes.filter(
      (change) => change.untracked || change.conflicted || changed(change.worktreeStatus),
    ),
  };
}
