import { type ChatFileEdits, parseFileEdits, parseTurnEdits } from './chat-edits';

export interface ToolActivity {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'declined';
  arguments?: string;
  output?: string;
  appendOutput?: boolean;
  turnId?: string;
  fileEdits?: ChatFileEdits;
  aggregate?: boolean;
  patchOnly?: boolean;
}
const LIMIT = 16_000;
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function toolText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const result = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return result.length > LIMIT ? `${result.slice(0, LIMIT)}\n…Output truncated` : result;
  } catch {
    return 'This tool result could not be displayed.';
  }
}
export function toolActivity(method: string, params: unknown): ToolActivity | null {
  const p = object(params);
  const turnId = typeof p.turnId === 'string' ? p.turnId : undefined;
  if (method === 'turn/diff/updated') {
    if (!turnId) return null;
    const fileEdits = parseTurnEdits(p.diff);
    return fileEdits
      ? {
          id: `turn-diff:${turnId}`,
          name: 'Changes this turn',
          status: 'running',
          turnId,
          fileEdits,
          aggregate: true,
        }
      : null;
  }
  if (method === 'item/fileChange/patchUpdated') {
    if (typeof p.itemId !== 'string') return null;
    return {
      id: p.itemId,
      name: 'File changes',
      status: 'running',
      turnId,
      fileEdits: parseFileEdits(p.changes),
      patchOnly: true,
    };
  }
  if (method === 'workbench/toolStarted' || method === 'workbench/toolCompleted') {
    if (typeof p.callId !== 'string' || typeof p.tool !== 'string') return null;
    return {
      id: p.callId,
      name: p.tool,
      status:
        method === 'workbench/toolStarted'
          ? 'running'
          : p.success === false
            ? 'failed'
            : 'completed',
      arguments: toolText(p.arguments),
      output: toolText(p.output),
      turnId,
    };
  }
  if (method === 'item/commandExecution/outputDelta') {
    if (typeof p.itemId !== 'string' || typeof p.delta !== 'string') return null;
    return {
      id: p.itemId,
      name: 'Command',
      status: 'running',
      output: toolText(p.delta),
      appendOutput: true,
      turnId,
    };
  }
  if (method !== 'item/started' && method !== 'item/completed') return null;
  const item = object(p.item);
  const names: Record<string, string> = {
    commandExecution: 'Command',
    fileChange: 'File changes',
    mcpToolCall: 'Tool',
    dynamicToolCall: 'Tool',
    webSearch: 'Web search',
    imageView: 'View image',
    computerUse: 'Computer',
  };
  if (typeof item.type !== 'string' || !names[item.type]) return null;
  const id = item.callId || item.id;
  if (typeof id !== 'string') return null;
  const tool = item.tool || item.name;
  const name =
    typeof tool === 'string'
      ? `${typeof item.server === 'string' ? `${item.server} / ` : ''}${tool}`
      : names[item.type];
  const failed =
    item.status === 'failed' ||
    item.status === 'declined' ||
    item.success === false ||
    (typeof item.exitCode === 'number' && item.exitCode !== 0) ||
    !!item.error;
  return {
    id,
    name,
    status:
      method === 'item/started'
        ? 'running'
        : item.status === 'declined'
          ? 'declined'
          : failed
            ? 'failed'
            : 'completed',
    arguments: toolText(item.arguments ?? item.command ?? item.query),
    output: toolText(item.error ?? item.result ?? item.contentItems ?? item.aggregatedOutput),
    turnId,
    ...(item.type === 'fileChange' || Array.isArray(item.changes)
      ? { fileEdits: parseFileEdits(item.changes) }
      : {}),
  };
}

export function mergeToolActivity(current: ToolActivity, next: ToolActivity): ToolActivity {
  return {
    ...current,
    ...next,
    name: next.appendOutput || next.patchOnly ? current.name : next.name,
    status: next.appendOutput || next.patchOnly ? current.status : next.status,
    turnId: next.turnId ?? current.turnId,
    fileEdits: next.fileEdits ?? current.fileEdits,
    arguments: next.arguments ?? current.arguments,
    output: next.appendOutput
      ? toolText((current.output || '') + (next.output || ''))
      : (next.output ?? current.output),
    appendOutput: undefined,
    patchOnly: undefined,
  };
}

/** A turn ending does not prove that an unfinished tool succeeded. */
export function finishToolActivity(tool: ToolActivity, status?: string): ToolActivity {
  if (tool.status !== 'running') return tool;
  return {
    ...tool,
    status:
      status === 'failed'
        ? 'failed'
        : tool.aggregate && status === 'completed'
          ? 'completed'
          : 'stopped',
  };
}
