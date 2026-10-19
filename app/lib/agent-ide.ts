import { type ChatPresentation, parseChatPresentation } from './chat-blocks';
import type { SourceRange } from './types';

export type HintTarget = 'project' | 'editor' | 'chat' | 'search' | 'tools';
export type IdeAction =
  | ({ type: 'showUi' } & ChatPresentation)
  | { type: 'openFile'; path: string; range: SourceRange; version: string }
  | {
      type: 'highlightCode';
      id: string;
      path: string;
      range: SourceRange;
      version: string;
      label?: string;
    }
  | { type: 'showHint'; id: string; target: HintTarget; text: string }
  | { type: 'clearPresentation'; ids?: string[] };
export interface IdeRequest {
  requestId: { connection: number; id: string };
  workspaceRoot: string;
  threadId: string;
  turnId: string;
  action: IdeAction;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function position(value: unknown): value is SourceRange['start'] {
  return (
    record(value) &&
    Number.isSafeInteger(value.line) &&
    Number(value.line) >= 0 &&
    Number.isSafeInteger(value.character) &&
    Number(value.character) >= 0
  );
}
export function validSourceRange(value: unknown): value is SourceRange {
  if (!record(value) || !position(value.start) || !position(value.end)) return false;
  return (
    value.end.line > value.start.line ||
    (value.end.line === value.start.line && value.end.character >= value.start.character)
  );
}

export function parseIdeRequest(value: unknown): IdeRequest | null {
  if (
    !record(value) ||
    !record(value.requestId) ||
    !Number.isSafeInteger(value.requestId.connection) ||
    Number(value.requestId.connection) < 1 ||
    !text(value.requestId.id, 256) ||
    !text(value.workspaceRoot, 4096) ||
    !text(value.threadId, 256) ||
    !text(value.turnId, 256) ||
    !record(value.action)
  )
    return null;
  const action = value.action;
  let parsed: IdeAction;
  if (action.type === 'showUi') {
    const presentation = parseChatPresentation({
      id: action.id,
      title: action.title,
      blocks: action.blocks,
    });
    if (!presentation) return null;
    parsed = { type: 'showUi', ...presentation };
  } else if (action.type === 'openFile' || action.type === 'highlightCode') {
    if (!text(action.path, 4096) || !text(action.version, 256) || !validSourceRange(action.range))
      return null;
    const source = { path: action.path, version: action.version, range: action.range };
    if (action.type === 'highlightCode') {
      if (!text(action.id, 64) || (action.label !== undefined && !text(action.label, 500)))
        return null;
      parsed = { type: action.type, ...source, id: action.id, label: action.label };
    } else parsed = { type: action.type, ...source };
  } else if (action.type === 'showHint') {
    const targets: HintTarget[] = ['project', 'editor', 'chat', 'search', 'tools'];
    if (
      !text(action.id, 64) ||
      !text(action.text, 2000) ||
      !targets.some((target) => target === action.target)
    )
      return null;
    parsed = {
      type: 'showHint',
      id: action.id,
      target: action.target as HintTarget,
      text: action.text,
    };
  } else if (action.type === 'clearPresentation') {
    if (
      action.ids !== undefined &&
      (!Array.isArray(action.ids) ||
        action.ids.length > 64 ||
        !action.ids.every((id) => text(id, 64)))
    )
      return null;
    parsed = { type: 'clearPresentation', ids: action.ids as string[] | undefined };
  } else return null;
  return {
    requestId: {
      connection: Number(value.requestId.connection),
      id: value.requestId.id,
    },
    workspaceRoot: value.workspaceRoot,
    threadId: value.threadId,
    turnId: value.turnId,
    action: parsed,
  };
}

export function requestIsCurrent(
  request: IdeRequest,
  root: string | undefined,
  turn: { threadId: string; turnId: string } | null,
): boolean {
  return (
    !!turn &&
    request.workspaceRoot === root &&
    request.threadId === turn.threadId &&
    request.turnId === turn.turnId
  );
}

export async function waitForIdePresentation(
  current: () => boolean,
  apply: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (!current()) throw new Error('This IDE request is no longer current.');
    if (apply()) return;
    if (Date.now() >= deadline) throw new Error('The IDE could not display this request in time.');
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}
