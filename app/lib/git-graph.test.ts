import { describe, expect, it } from 'vitest';
import type { GitCommit, GitFileChange } from './git';
import { layoutGitGraph, splitGitChanges } from './git-graph';

function commit(id: string, ...parents: string[]): GitCommit {
  return { id, parents, subject: id, author: 'Ada', email: '', date: 0, refs: [] };
}

describe('Git graph lanes', () => {
  it('keeps linear first-parent history in one lane', () => {
    const graph = layoutGitGraph([commit('c', 'b'), commit('b', 'a'), commit('a')]);
    expect(graph.width).toBe(1);
    expect(graph.boundaries).toBe(0);
    expect(graph.rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(graph.rows[1].edges).toContainEqual({
      from: 0,
      to: 0,
      kind: 'incoming',
      color: 0,
    });
    expect(graph.rows[2].edges.filter((edge) => edge.kind === 'parent')).toEqual([]);
  });

  it('branches merge parents, keeps lanes stable, and rejoins a common ancestor', () => {
    const graph = layoutGitGraph([
      commit('merge', 'main', 'topic'),
      commit('main', 'base'),
      commit('topic', 'base'),
      commit('base'),
    ]);
    expect(graph.width).toBe(2);
    expect(graph.rows.map((row) => row.lane)).toEqual([0, 0, 1, 0]);
    expect(graph.rows[0].edges).toContainEqual({ from: 0, to: 1, kind: 'parent', color: 1 });
    expect(graph.rows[1].edges).toContainEqual({ from: 1, to: 1, kind: 'through', color: 1 });
    expect(graph.rows[2].edges).toContainEqual({ from: 1, to: 0, kind: 'parent', color: 0 });
    expect(graph.boundaries).toBe(0);
  });

  it('marks omitted parents without drawing through unrelated filtered rows', () => {
    const graph = layoutGitGraph([commit('latest', 'omitted'), commit('older', 'base')]);
    expect(graph.boundaries).toBe(2);
    expect(graph.rows[0].edges).toEqual([{ from: 0, to: 0, kind: 'boundary', color: 0 }]);
    expect(graph.rows[1].edges.every((edge) => edge.kind === 'boundary')).toBe(true);
  });

  it('handles disconnected roots and octopus merges', () => {
    const graph = layoutGitGraph([
      commit('merge', 'a', 'b', 'c'),
      commit('a', 'base'),
      commit('b', 'base'),
      commit('c', 'base'),
      commit('base'),
      commit('orphan'),
    ]);
    expect(graph.width).toBe(3);
    expect(graph.rows[0].edges.filter((edge) => edge.kind === 'parent')).toHaveLength(3);
    expect(graph.rows.at(-1)?.edges).toEqual([]);
    expect(layoutGitGraph([]).rows).toEqual([]);
  });
});

describe('Git working changes', () => {
  const file = (input: Partial<GitFileChange>): GitFileChange => ({
    path: '/repo/main.ts',
    relativePath: 'main.ts',
    indexStatus: '.',
    worktreeStatus: '.',
    untracked: false,
    conflicted: false,
    ...input,
  });

  it('puts a file with staged and unstaged edits in both groups', () => {
    const both = file({ indexStatus: 'M', worktreeStatus: 'M' });
    const groups = splitGitChanges([both]);
    expect(groups.staged).toEqual([both]);
    expect(groups.worktree).toEqual([both]);
  });

  it('keeps conflicts and untracked files out of the staged commit group', () => {
    const conflict = file({ conflicted: true, indexStatus: 'U', worktreeStatus: 'U' });
    const untracked = file({ untracked: true, indexStatus: '?', worktreeStatus: '?' });
    const groups = splitGitChanges([conflict, untracked, file({ indexStatus: ' ' })]);
    expect(groups.staged).toEqual([]);
    expect(groups.worktree).toEqual([conflict, untracked]);
  });
});
