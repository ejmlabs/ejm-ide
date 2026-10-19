import { describe, expect, it } from 'vitest';
import {
  finishToolActivity,
  mergeToolActivity,
  type ToolActivity,
  toolActivity,
} from './tool-calls';

describe('tool activity', () => {
  it('merges native lifecycle events by original call ID without losing arguments', () => {
    const started = toolActivity('workbench/toolStarted', {
      callId: 'call-1',
      tool: 'workbench_open_file',
      arguments: { path: 'src/main.rs', line: 5 },
    });
    const completed = toolActivity('workbench/toolCompleted', {
      callId: 'call-1',
      tool: 'workbench_open_file',
      success: false,
      output: 'The source changed.',
    });
    expect(started).not.toBeNull();
    expect(completed).not.toBeNull();
    if (!started || !completed) return;
    const result = mergeToolActivity(started, completed);
    expect(result.id).toBe('call-1');
    expect(result.status).toBe('failed');
    expect(result.arguments).toContain('src/main.rs');
    expect(result.output).toBe('The source changed.');
  });
  it('shows command failures and bounds streamed output', () => {
    const command = toolActivity('item/completed', {
      item: {
        id: 'command-1',
        type: 'commandExecution',
        command: 'cargo check',
        exitCode: 1,
        aggregatedOutput: 'error: failed to compile',
      },
    });
    expect(command?.status).toBe('failed');
    expect(command?.arguments).toBe('cargo check');
    const delta = toolActivity('item/commandExecution/outputDelta', {
      itemId: 'command-1',
      delta: 'x'.repeat(20_000),
    });
    expect(delta?.output?.length).toBeLessThan(16_100);
    expect(delta?.output).toContain('Output truncated');
    if (command && delta) expect(mergeToolActivity(command, delta).status).toBe('failed');
  });
  it('ignores reasoning and regular assistant messages', () => {
    expect(
      toolActivity('item/started', { item: { id: 'reason-1', type: 'reasoning' } }),
    ).toBeNull();
    expect(
      toolActivity('item/completed', { item: { id: 'msg-1', type: 'agentMessage', text: 'Done' } }),
    ).toBeNull();
  });

  it('retains structured native edit snapshots rather than treating source as tool output', () => {
    const content = '+actual code\n';
    const patch = '@@ -1 +1 @@\n-old\n+new\n';
    const tool = toolActivity('item/completed', {
      turnId: 'turn-edits',
      item: {
        id: 'edit-1',
        type: 'fileChange',
        status: 'completed',
        changes: [
          { path: 'new.ts', kind: { type: 'add' }, diff: content },
          { path: 'old.ts', kind: { type: 'delete' }, diff: 'removed\n' },
          { path: 'main.ts', kind: { type: 'update' }, diff: patch },
        ],
      },
    });
    expect(tool).toMatchObject({
      id: 'edit-1',
      status: 'completed',
      turnId: 'turn-edits',
      fileEdits: {
        truncated: false,
        files: [
          { path: 'new.ts', kind: 'add', format: 'content', diff: content },
          { path: 'old.ts', kind: 'delete', format: 'content', diff: 'removed\n' },
          { path: 'main.ts', kind: 'update', format: 'patch', diff: patch },
        ],
      },
    });
    expect(tool?.output).toBeUndefined();
  });

  it('retains command metadata and explicitly supplied edits on the same tool', () => {
    const patch = '@@ -1 +1 @@\n-before\n+after\n';
    const command = toolActivity('item/completed', {
      turnId: 'turn-edits',
      item: {
        id: 'command-edit',
        type: 'commandExecution',
        command: 'apply_patch < change.patch',
        exitCode: 0,
        aggregatedOutput: 'Updated main.ts',
        changes: [{ path: 'main.ts', kind: { type: 'update' }, diff: patch }],
      },
    });
    expect(command).toMatchObject({
      id: 'command-edit',
      name: 'Command',
      status: 'completed',
      turnId: 'turn-edits',
      arguments: 'apply_patch < change.patch',
      output: 'Updated main.ts',
      fileEdits: {
        truncated: false,
        files: [{ path: 'main.ts', kind: 'update', format: 'patch', diff: patch }],
      },
    });
    expect(command?.aggregate).toBeUndefined();
  });

  it('only accepts explicit change arrays outside native file-change records', () => {
    const patch = '--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-before\n+after\n';
    for (const changes of [undefined, null, patch, { diff: patch }]) {
      const command = toolActivity('item/completed', {
        item: {
          id: 'ordinary-command',
          type: 'commandExecution',
          command: `printf '%s' '${patch}'`,
          aggregatedOutput: patch,
          changes,
        },
      });
      expect(command?.fileEdits).toBeUndefined();
      expect(command?.output).toBe(patch);
    }
    for (const changes of [undefined, []]) {
      const edit = toolActivity('item/completed', {
        item: { id: 'empty-edit', type: 'fileChange', status: 'completed', changes },
      });
      expect(edit?.fileEdits).toEqual({ files: [], truncated: false });
    }
  });

  it('keeps tool identity and metadata when item-bound patches arrive in either order', () => {
    const completed = toolActivity('item/completed', {
      turnId: 'turn-edits',
      item: {
        id: 'patch-tool',
        type: 'dynamicToolCall',
        tool: 'apply_patch',
        status: 'completed',
        arguments: { patch: 'requested changes' },
        result: 'Updated main.ts',
      },
    });
    const patch = toolActivity('item/fileChange/patchUpdated', {
      itemId: 'patch-tool',
      turnId: 'turn-edits',
      changes: [{ path: 'main.ts', kind: { type: 'add' }, diff: 'after\n' }],
    });
    if (!completed || !patch) throw new Error('Valid tool fixtures must produce activity');
    const patchLast = mergeToolActivity(completed, patch);
    const patchFirst = mergeToolActivity(patch, completed);
    expect(patchLast).toEqual(patchFirst);
    expect(patchLast).toMatchObject({
      id: 'patch-tool',
      name: 'apply_patch',
      status: 'completed',
      turnId: 'turn-edits',
      arguments: JSON.stringify({ patch: 'requested changes' }, null, 2),
      output: 'Updated main.ts',
      fileEdits: { files: [{ path: 'main.ts', diff: 'after\n' }] },
    });
    expect(patchLast.patchOnly).toBeUndefined();
  });

  it('preserves a specific tool name and edits through late command output updates', () => {
    const original: ToolActivity = {
      id: 'patch-command',
      name: 'apply_patch',
      status: 'failed',
      arguments: 'requested changes',
      output: 'First result. ',
      fileEdits: { files: [], truncated: false },
    };
    const delta = toolActivity('item/commandExecution/outputDelta', {
      itemId: 'patch-command',
      delta: 'Last result.',
    });
    if (!delta) throw new Error('Valid output fixture must produce activity');
    expect(mergeToolActivity(original, delta)).toMatchObject({
      id: 'patch-command',
      name: 'apply_patch',
      status: 'failed',
      arguments: 'requested changes',
      output: 'First result. Last result.',
      fileEdits: original.fileEdits,
    });
  });

  it('replaces patch snapshots while preserving the completed or declined lifecycle state', () => {
    for (const status of ['completed', 'declined'] as const) {
      const original = toolActivity('item/completed', {
        turnId: 'turn-edits',
        item: {
          id: 'edit-1',
          type: 'fileChange',
          status,
          changes: [{ path: 'main.ts', kind: { type: 'add' }, diff: 'before\n' }],
        },
      });
      const updated = toolActivity('item/fileChange/patchUpdated', {
        itemId: 'edit-1',
        changes: [{ path: 'main.ts', kind: { type: 'add' }, diff: 'after\n' }],
      });
      expect(original).not.toBeNull();
      expect(updated).not.toBeNull();
      if (!original || !updated) return;
      const merged = mergeToolActivity(original, updated);
      expect(merged).toMatchObject({
        id: 'edit-1',
        turnId: 'turn-edits',
        status,
        fileEdits: { files: [{ diff: 'after\n' }] },
      });
      expect(merged.fileEdits?.files).toHaveLength(1);
      expect(merged.patchOnly).toBeUndefined();
    }
  });

  it('keeps a declined file edit visible without reporting that it was applied', () => {
    const declined = toolActivity('item/completed', {
      item: {
        id: 'edit-declined',
        type: 'fileChange',
        status: 'declined',
        changes: [{ path: 'main.rs', kind: { type: 'delete' }, diff: 'fn main() {}\n' }],
      },
    });
    expect(declined?.status).toBe('declined');
    expect(declined?.fileEdits?.files[0]).toMatchObject({ path: 'main.rs', kind: 'delete' });
    expect(toolActivity('item/fileChange/patchUpdated', { changes: [] })).toBeNull();
  });

  it('uses a stable turn diff identity and replaces the aggregate instead of appending it', () => {
    const diff = (after: string) =>
      `--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-before\n+${after}\n`;
    const first = toolActivity('turn/diff/updated', { turnId: 'turn-edits', diff: diff('first') });
    const second = toolActivity('turn/diff/updated', {
      turnId: 'turn-edits',
      diff: diff('second'),
    });
    const reverted = toolActivity('turn/diff/updated', { turnId: 'turn-edits', diff: '' });
    expect(first).toMatchObject({
      id: 'turn-diff:turn-edits',
      turnId: 'turn-edits',
      aggregate: true,
    });
    expect(second).not.toBeNull();
    expect(reverted).not.toBeNull();
    if (!first || !second || !reverted) return;
    const replaced = mergeToolActivity(first, second);
    expect(replaced.fileEdits?.files).toHaveLength(1);
    expect(replaced.fileEdits?.files[0].diff).toContain('+second');
    expect(replaced.fileEdits?.files[0].diff).not.toContain('+first');
    expect(mergeToolActivity(replaced, reverted).fileEdits).toEqual({
      files: [],
      truncated: false,
    });
    expect(toolActivity('turn/diff/updated', { diff: diff('missing turn') })).toBeNull();
    expect(toolActivity('turn/diff/updated', { turnId: 'turn-edits', diff: 'invalid' })).toBeNull();
  });
});

describe('finishing tool activity', () => {
  const tool = (status: ToolActivity['status'], aggregate?: boolean): ToolActivity => ({
    id: 'call-1',
    name: 'File changes',
    status,
    ...(aggregate ? { aggregate: true } : {}),
  });

  it('preserves each terminal tool outcome when its containing turn fails or is interrupted', () => {
    for (const status of ['completed', 'failed', 'stopped', 'declined'] as const) {
      const terminal = tool(status);
      for (const turnStatus of ['completed', 'failed', 'interrupted', undefined])
        expect(finishToolActivity(terminal, turnStatus)).toBe(terminal);
    }
  });

  it('never infers that a running item succeeded merely because the turn ended', () => {
    const running = tool('running');
    expect(finishToolActivity(running, 'failed').status).toBe('failed');
    for (const status of ['completed', 'interrupted', undefined])
      expect(finishToolActivity(running, status).status).toBe('stopped');
    expect(running.status).toBe('running');
  });

  it('marks an aggregate complete only when its whole turn completed', () => {
    const aggregate = tool('running', true);
    expect(finishToolActivity(aggregate, 'completed').status).toBe('completed');
    expect(finishToolActivity(aggregate, 'failed').status).toBe('failed');
    expect(finishToolActivity(aggregate, 'interrupted').status).toBe('stopped');
  });
});
