import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { type ChatTurn, hydrateChat } from '@/lib/chat-threads';
import { type ToolActivity, toolActivity } from '@/lib/tool-calls';
import { ToolCall } from './AgentPresentation';

const change = {
  path: 'main.ts',
  kind: { type: 'update' },
  diff: '@@ -1 +1 @@\n-before\n+after\n',
};

function render(tool: ToolActivity) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ToolCall tool={tool} root="/workspace" onNavigate={vi.fn()} onAttach={vi.fn()} />
    </TooltipProvider>,
  );
}

function summary(markup: string) {
  const result = markup.match(/<summary>([\s\S]*?)<\/summary>/)?.[1];
  if (!result) throw new Error('The tool must have an accessible disclosure summary.');
  return result;
}

function savedEdit(itemStatus: string, turnStatus: ChatTurn['status']) {
  const messages = hydrateChat(
    [
      {
        id: 'saved-turn',
        status: turnStatus,
        items: [{ id: 'saved-edit', type: 'fileChange', status: itemStatus, changes: [change] }],
      },
    ],
    1,
  );
  const tool = messages[0]?.tool;
  if (!tool) throw new Error('Stored file changes must hydrate as a tool.');
  return tool;
}

describe('tool call rendering', () => {
  it('keeps explicit edits, tool details, and file actions in one expandable tool', () => {
    const tool = toolActivity('item/completed', {
      turnId: 'turn-edit',
      item: {
        id: 'patch-tool',
        type: 'dynamicToolCall',
        tool: 'apply_patch',
        status: 'completed',
        arguments: { patch: 'requested edit snapshot' },
        result: 'Patch applied once.',
        changes: [change],
      },
    });
    if (!tool) throw new Error('The edit fixture must produce a tool.');
    const markup = render(tool);
    const heading = summary(markup);
    expect(heading).toContain('title="apply_patch"');
    expect(heading).toContain('apply patch');
    expect(heading).toContain('role="status">Applied');
    expect(heading).toContain('1 file');
    expect(heading).toContain('+1');
    expect(heading).toContain('−1');
    expect(markup).toContain('aria-label="Edi file changes"');
    expect(markup).toContain('aria-label="main.ts diff"');
    expect(markup).toContain('before');
    expect(markup).toContain('after');
    expect(markup).toContain('Tool details');
    expect(markup).toContain('<strong>Arguments</strong>');
    expect(markup).toContain('requested edit snapshot');
    expect(markup).toContain('<strong>Result</strong>');
    expect(markup.split('Patch applied once.')).toHaveLength(2);
    expect(markup).toContain('aria-label="Add main.ts diff to chat"');
    expect(markup).toContain('aria-label="Open main.ts in editor"');
  });

  it('uses the same tool and diff view for saved native edits', () => {
    const tool = savedEdit('completed', 'completed');
    const markup = render(tool);
    expect(tool.id).toBe('saved-edit');
    expect(summary(markup)).toContain('File changes');
    expect(summary(markup)).toContain('role="status">Applied');
    expect(markup).toContain('aria-label="main.ts diff"');
    expect(markup).toContain('before');
    expect(markup).toContain('after');
    expect(markup).toContain('aria-label="Add main.ts diff to chat"');
    expect(markup).not.toContain('Tool details');
  });

  it.each([
    ['failed', 'failed', 'Failed'],
    ['inProgress', 'interrupted', 'Stopped'],
    ['declined', 'completed', 'Declined'],
  ] as const)('never calls a %s saved edit applied', (itemStatus, turnStatus, label) => {
    const markup = render(savedEdit(itemStatus, turnStatus));
    expect(summary(markup)).toContain(`role="status">${label}`);
    expect(markup).not.toContain('Applied');
    expect(markup).toContain('aria-label="main.ts diff"');
  });

  it('keeps an ordinary command as command details without inventing a diff', () => {
    const tool = toolActivity('item/completed', {
      item: {
        id: 'command',
        type: 'commandExecution',
        command: 'git diff -- main.ts',
        exitCode: 0,
        aggregatedOutput: '--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-before\n+after\n',
      },
    });
    if (!tool) throw new Error('The command fixture must produce a tool.');
    const markup = render(tool);
    expect(summary(markup)).toContain('Command');
    expect(summary(markup)).toContain('role="status">completed');
    expect(markup).toContain('git diff -- main.ts');
    expect(markup).toContain('--- a/main.ts');
    expect(markup).not.toContain('aria-label="Edi file changes"');
    expect(markup).not.toContain('Tool details');
    expect(markup).not.toContain('diff to chat');
  });

  it.each([
    { label: 'omitted files', changes: [change, null] },
    { label: 'an unavailable patch', changes: [{ ...change, diff: 'Patch unavailable.' }] },
  ])('does not report exact totals for $label', ({ changes }) => {
    const tool = toolActivity('item/completed', {
      item: { id: 'partial-edit', type: 'fileChange', status: 'completed', changes },
    });
    if (!tool) throw new Error('The partial edit fixture must produce a tool.');
    const markup = render(tool);
    const heading = summary(markup);
    expect(heading).not.toContain('lines added');
    expect(heading).not.toContain('lines removed');
    expect(heading).not.toMatch(/[+−]\d/);
    expect(markup).toContain('aria-label="Edi file changes"');
  });
});
