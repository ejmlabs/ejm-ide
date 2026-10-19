import { describe, expect, it } from 'vitest';
import {
  type ChatIdentity,
  type ChatThread,
  type ChatTurn,
  chatTitle,
  hydrateChat,
  mergeChatMessages,
  mergeChatThreads,
  readChatPrompt,
  routeChatEvent,
  upsertChatTool,
} from './chat-threads';
import { makeReference, serializePrompt } from './context';
import { toolActivity } from './tool-calls';
import type { AgentEvent } from './types';

const event = (overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  providerId: 'test-provider',
  method: 'item/agentMessage/delta',
  params: { delta: 'Hello' },
  threadId: 'a',
  connection: 1,
  scope: 'session',
  ...overrides,
});
const turn = (items: ChatTurn['items'], overrides: Partial<ChatTurn> = {}): ChatTurn => ({
  id: 'turn',
  status: 'completed',
  items,
  ...overrides,
});
const show = (id: string, title = 'Summary'): ChatTurn['items'][number] => ({
  id,
  type: 'dynamicToolCall',
  tool: 'workbench_show_ui',
  success: true,
  arguments: { id: 'summary', title, blocks: [{ type: 'markdown', text: title }] },
});

describe('chat event ownership', () => {
  it('rejects delayed output after A to B to A, including tools and approvals', () => {
    const identities: ChatIdentity[] = [
      { threadId: 'a', connection: 1, awaitingThread: false },
      { threadId: 'b', connection: 2, awaitingThread: false },
      { threadId: 'a', connection: 3, awaitingThread: false },
    ];
    expect(routeChatEvent(identities[0], event()).accept).toBe(true);
    for (const identity of identities.slice(1)) {
      for (const method of [
        'item/agentMessage/delta',
        'thread/tokenUsage/updated',
        'turn/diff/updated',
        'item/fileChange/patchUpdated',
        'workbench/toolStarted',
        'server/request',
        'turn/completed',
        'workbench/disconnected',
      ])
        expect(routeChatEvent(identity, event({ method })).accept).toBe(false);
    }
    expect(routeChatEvent(identities[2], event({ connection: 3 })).accept).toBe(true);
    expect(routeChatEvent(identities[2], event({ connection: undefined })).accept).toBe(false);
    expect(routeChatEvent(identities[2], event({ threadId: null })).accept).toBe(false);
  });

  it('only adopts a native identity when starting a new chat', () => {
    const empty: ChatIdentity = { threadId: null, connection: null, awaitingThread: false };
    expect(routeChatEvent(empty, event({ method: 'thread/started' })).accept).toBe(false);
    const pending = { ...empty, awaitingThread: true };
    expect(routeChatEvent(pending, event()).accept).toBe(false);
    expect(routeChatEvent(pending, event({ method: 'thread/started' }))).toEqual({
      accept: true,
      identity: { threadId: 'a', connection: 1, awaitingThread: false },
    });
    expect(
      routeChatEvent(pending, event({ method: 'thread/started', scope: 'control' })).accept,
    ).toBe(false);
  });

  it('adopts a newer connection for the same saved chat only during a pending send', () => {
    const pending: ChatIdentity = { threadId: 'a', connection: 3, awaitingThread: true };
    for (const method of ['thread/tokenUsage/updated', 'thread/started', 'turn/started'])
      expect(routeChatEvent(pending, event({ method, connection: 4 }))).toEqual({
        accept: true,
        identity: { threadId: 'a', connection: 4, awaitingThread: false },
      });
  });

  it('rejects stale, foreign, unowned, and control events while a saved chat reconnects', () => {
    const pending: ChatIdentity = { threadId: 'a', connection: 3, awaitingThread: true };
    for (const overrides of [
      { connection: 1 },
      { connection: 2 },
      { connection: undefined },
      { connection: 4, threadId: 'b' },
      { connection: 4, threadId: null },
      { connection: 4, scope: 'control' as const },
    ])
      expect(
        routeChatEvent(pending, event({ method: 'thread/tokenUsage/updated', ...overrides })),
      ).toEqual({ accept: false });
    expect(
      routeChatEvent(
        { ...pending, awaitingThread: false },
        event({ method: 'thread/tokenUsage/updated', connection: 4 }),
      ),
    ).toEqual({ accept: false });
    expect(
      routeChatEvent(
        { threadId: null, connection: null, awaitingThread: true },
        event({ method: 'thread/tokenUsage/updated', connection: 4 }),
      ),
    ).toEqual({ accept: false });
  });

  it('accepts the current live connection without adopting another identity during a send', () => {
    const pending: ChatIdentity = { threadId: 'a', connection: 3, awaitingThread: true };
    expect(
      routeChatEvent(pending, event({ method: 'thread/tokenUsage/updated', connection: 3 })),
    ).toEqual({ accept: true });
    expect(pending.awaitingThread).toBe(true);
  });

  it('accepts control disconnection and rejects unsupported account events', () => {
    const identity: ChatIdentity = { threadId: 'b', connection: 2, awaitingThread: false };
    expect(
      routeChatEvent(identity, event({ method: 'account/updated', scope: 'control' })),
    ).toEqual({ accept: false });
    expect(
      routeChatEvent(identity, event({ method: 'workbench/disconnected', scope: 'control' })),
    ).toEqual({ accept: true, global: true });
    expect(routeChatEvent(identity, event({ scope: 'control' })).accept).toBe(false);
  });
});

describe('Edi chat hydration', () => {
  it('restores captured Git commit context without linking it to current source', () => {
    const reference = makeReference({
      kind: 'git',
      label: 'a61c0e2 Merge safe retries',
      origin: 'Git history',
      content: 'Commit: a61c0e2\nAuthor: Alex\n\nRecorded commit details.',
    });
    const messages = hydrateChat(
      [
        turn([
          {
            id: 'git-question',
            type: 'userMessage',
            content: [{ type: 'text', text: serializePrompt('Explain this commit.', [reference]) }],
          },
        ]),
      ],
      1,
    );
    expect(messages[0].references?.[0]).toMatchObject({
      kind: 'git',
      label: reference.label,
      content: reference.content,
      uri: undefined,
    });
  });
  it('restores text, captured references, assistant replies, and tool failures in stored order', () => {
    const reference = makeReference({
      kind: 'caller',
      label: 'settle_order',
      origin: 'Call hierarchy',
      content: 'fn settle_order() {}',
      uri: 'file:///workspace/src/orders.rs',
      ranges: [{ start: { line: 4, character: 0 }, end: { line: 4, character: 20 } }],
      version: 'saved-sha',
    });
    const messages = hydrateChat(
      [
        turn([
          {
            id: 'user',
            type: 'userMessage',
            content: [{ type: 'text', text: serializePrompt('Explain this caller.', [reference]) }],
          },
          { id: 'reason', type: 'reasoning', text: 'Internal reasoning stays private.' },
          {
            id: 'command',
            type: 'commandExecution',
            command: 'cargo check',
            aggregatedOutput: 'Compilation failed',
            exitCode: 1,
          },
          { id: 'assistant', type: 'agentMessage', text: `See workbench-ref://${reference.id}` },
        ]),
      ],
      1234,
    );
    expect(messages.map((message) => message.id)).toEqual(['user', 'tool:command', 'assistant']);
    expect(messages[0].text).toBe('Explain this caller.');
    expect(messages[0].references?.[0]).toEqual({
      ...reference,
      capturedAt: 1234,
      truncated: false,
    });
    expect(messages[1].tool).toMatchObject({
      status: 'failed',
      arguments: 'cargo check',
      output: 'Compilation failed',
    });
  });

  it('keeps malformed context readable and rejects oversized source snapshots', () => {
    const reference = makeReference({
      kind: 'file',
      label: 'main.rs',
      origin: 'Project',
      content: '',
    });
    const prompt = serializePrompt('Explain this.', [reference]);
    const malformed = prompt.replace('"content": ""', '"content": false');
    expect(readChatPrompt(malformed, 1)).toEqual({ text: malformed });
    const oversized = prompt.replace('"content": ""', `"content": "${'x'.repeat(16_001)}"`);
    expect(readChatPrompt(oversized, 1)).toEqual({ text: oversized });
    expect(readChatPrompt(`${prompt} extra`, 1)).toEqual({ text: `${prompt} extra` });
    expect(readChatPrompt('A literal <workbench_context> tag', 1)).toEqual({
      text: 'A literal <workbench_context> tag',
    });
  });

  it('marks unfinished tools as stopped when opening an interrupted chat', () => {
    const messages = hydrateChat(
      [
        turn(
          [{ id: 'command', type: 'commandExecution', command: 'sleep 20', status: 'inProgress' }],
          { status: 'interrupted' },
        ),
      ],
      1,
    );
    expect(messages[0].tool?.status).toBe('stopped');
  });

  it('rebuilds bounded rich blocks without executing historical IDE actions', () => {
    const messages = hydrateChat(
      [
        turn([
          show('first'),
          {
            id: 'navigate',
            type: 'dynamicToolCall',
            tool: 'workbench_open_file',
            arguments: { path: 'main.rs', line: 1 },
            success: true,
          },
          show('second', 'Updated summary'),
          {
            ...show('invalid'),
            arguments: {
              id: 'unsafe',
              title: 'Unsafe',
              blocks: [{ type: 'html', html: '<script>' }],
            },
          },
        ]),
      ],
      1,
    );
    expect(messages.filter((message) => message.presentation)).toMatchObject([
      { historical: true, presentation: { id: 'summary', title: 'Updated summary' } },
    ]);
    expect(messages.filter((message) => message.tool)).toHaveLength(4);
  });

  it('does not resurrect cleared or replaced displays when loading older pages', () => {
    const older = hydrateChat([turn([show('old')])], 1);
    const replacement = hydrateChat([turn([show('replacement', 'Replacement')])], 1);
    const replaced = mergeChatMessages(older, replacement);
    expect(replaced.filter((message) => message.presentation)).toMatchObject([
      { presentation: { title: 'Replacement' } },
    ]);
    for (const args of [{}, { ids: ['summary'] }]) {
      const cleared = hydrateChat(
        [
          turn([
            {
              id: 'clear',
              type: 'dynamicToolCall',
              tool: 'workbench_clear_presentation',
              arguments: args,
              success: true,
            },
          ]),
        ],
        1,
      );
      expect(mergeChatMessages(older, cleared).some((message) => message.presentation)).toBe(false);
    }
  });

  it('deduplicates overlapping turn pages and preserves the current streamed text', () => {
    const older = hydrateChat(
      [turn([{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Hi' }] }])],
      1,
    );
    const current = [
      ...older,
      { id: 'assistant', role: 'assistant' as const, text: 'Current streamed reply' },
    ];
    expect(mergeChatMessages(older, current)).toEqual(current);
  });

  it('restores actual edit snapshots and retains terminal edit status across a failed turn', () => {
    const messages = hydrateChat(
      [
        turn(
          [
            {
              id: 'completed-edit',
              type: 'fileChange',
              status: 'completed',
              changes: [{ path: 'new.ts', kind: { type: 'add' }, diff: '+literal code\n' }],
            },
            {
              id: 'declined-edit',
              type: 'fileChange',
              status: 'declined',
              changes: [{ path: 'old.ts', kind: { type: 'delete' }, diff: 'keep this\n' }],
            },
            {
              id: 'unfinished-edit',
              type: 'fileChange',
              status: 'inProgress',
              changes: [
                {
                  path: 'main.ts',
                  kind: { type: 'update', move_path: 'renamed.ts' },
                  diff: '@@ -1 +1 @@\n-before\n+after\n\n\nMoved to: renamed.ts',
                },
              ],
            },
          ],
          { id: 'failed-turn', status: 'failed' },
        ),
      ],
      1,
    );
    expect(messages.map((message) => message.tool?.status)).toEqual([
      'completed',
      'declined',
      'failed',
    ]);
    expect(messages.every((message) => message.tool?.turnId === 'failed-turn')).toBe(true);
    expect(messages[0].tool?.fileEdits?.files[0]).toMatchObject({
      path: 'new.ts',
      diff: '+literal code\n',
      format: 'content',
    });
    expect(messages[2].tool?.fileEdits?.files[0]).toMatchObject({
      path: 'main.ts',
      movePath: 'renamed.ts',
      diff: '@@ -1 +1 @@\n-before\n+after\n',
      format: 'patch',
    });
  });

  it('deduplicates stored file edits across overlapping history pages', () => {
    const stored = hydrateChat(
      [
        turn([
          {
            id: 'edit',
            type: 'fileChange',
            status: 'completed',
            changes: [{ path: 'file.ts', kind: { type: 'add' }, diff: 'contents\n' }],
          },
        ]),
      ],
      1,
    );
    const merged = mergeChatMessages(stored, stored);
    expect(merged).toEqual(stored);
    expect(merged[0].tool?.fileEdits?.files[0].diff).toBe('contents\n');
  });
});

describe('chat diff snapshots', () => {
  const aggregate = (turnId = 'turn-a', text = 'after') => {
    const tool = toolActivity('turn/diff/updated', {
      turnId,
      diff: text ? `--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-before\n+${text}\n` : '',
    });
    if (!tool) throw new Error('Valid aggregate fixture must produce an edit snapshot');
    return tool;
  };
  const item = (turnId = 'turn-a') => {
    const tool = toolActivity('item/completed', {
      turnId,
      item: {
        id: `edit:${turnId}`,
        type: 'fileChange',
        status: 'completed',
        changes: [{ path: 'main.ts', kind: { type: 'add' }, diff: 'actual file contents\n' }],
      },
    });
    if (!tool) throw new Error('Valid native item fixture must produce an edit snapshot');
    return tool;
  };

  it('updates one aggregate card in place and clears it when the turn diff is reverted', () => {
    const first = upsertChatTool([], aggregate());
    const replacement = upsertChatTool(first, aggregate('turn-a', 'latest'));
    expect(replacement).toHaveLength(1);
    expect(replacement[0].id).toBe(first[0].id);
    expect(replacement[0].tool?.fileEdits?.files[0].diff).toContain('+latest');
    const reverted = upsertChatTool(replacement, aggregate('turn-a', ''));
    expect(reverted).toHaveLength(1);
    expect(reverted[0].tool?.fileEdits).toEqual({ files: [], truncated: false });
  });

  it('suppresses duplicate aggregate changes when an item diff arrives in either order', () => {
    const aggregateFirst = upsertChatTool(upsertChatTool([], aggregate()), item());
    const itemFirst = upsertChatTool(upsertChatTool([], item()), aggregate());
    expect(aggregateFirst).toEqual(itemFirst);
    expect(itemFirst).toHaveLength(1);
    expect(itemFirst[0].tool?.aggregate).not.toBe(true);
    expect(itemFirst[0].tool?.fileEdits?.files[0].diff).toBe('actual file contents\n');
  });

  it('only suppresses the aggregate belonging to the same turn', () => {
    const messages = upsertChatTool(upsertChatTool([], aggregate('turn-a')), item('turn-b'));
    expect(messages.map((message) => message.tool?.turnId)).toEqual(['turn-a', 'turn-b']);
    const next = upsertChatTool(messages, aggregate('turn-c'));
    expect(next).toHaveLength(3);
  });

  it('keeps an aggregate visible beside unrelated tools in its turn', () => {
    const command = toolActivity('item/completed', {
      turnId: 'turn-a',
      item: { id: 'command', type: 'commandExecution', command: 'cargo check', exitCode: 0 },
    });
    if (!command) throw new Error('Valid command fixture must produce a tool card');
    const messages = upsertChatTool(upsertChatTool([], command), aggregate());
    expect(messages).toHaveLength(2);
    expect(messages[1].tool?.aggregate).toBe(true);
  });

  it('uses stored per-item diffs to suppress a late duplicate aggregate after opening history', () => {
    const stored = hydrateChat(
      [
        turn(
          [
            {
              id: 'stored-edit',
              type: 'fileChange',
              status: 'completed',
              changes: [{ path: 'main.ts', kind: { type: 'add' }, diff: 'stored contents\n' }],
            },
          ],
          { id: 'turn-a' },
        ),
      ],
      1,
    );
    expect(upsertChatTool(stored, aggregate())).toBe(stored);
    expect(stored[0].tool?.fileEdits?.files[0].diff).toBe('stored contents\n');
  });
});

describe('chat history list', () => {
  const thread = (id: string): ChatThread => ({
    id,
    name: null,
    preview: '',
    cwd: '/workspace',
    createdAt: 1,
    updatedAt: 1,
    status: { type: 'idle' },
    turns: [],
  });
  it('uses the saved name, then a short preview, then an empty title', () => {
    expect(chatTitle({ name: 'Renamed', preview: 'Old preview' })).toBe('Renamed');
    expect(chatTitle({ preview: ' First line\nSecond line' })).toBe('First line');
    expect(chatTitle({ preview: '' })).toBe('Untitled chat');
  });
  it('deduplicates overlapping chat pages while keeping the current list order', () => {
    expect(
      mergeChatThreads([thread('a')], [thread('a'), thread('b'), thread('b')]).map(
        (chat) => chat.id,
      ),
    ).toEqual(['a', 'b']);
  });
});
