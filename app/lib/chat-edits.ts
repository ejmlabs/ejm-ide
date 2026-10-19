import { createPatch, formatPatch, OMIT_HEADERS, parsePatch, type StructuredPatch } from 'diff';

export interface ChatFileEdit {
  path: string;
  kind: 'add' | 'delete' | 'update';
  movePath?: string;
  diff: string;
  format: 'content' | 'patch';
  truncated: boolean;
  binary?: boolean;
}
export interface ChatFileEdits {
  files: ChatFileEdit[];
  truncated: boolean;
}
export interface DiffLine {
  type: 'context' | 'add' | 'delete' | 'meta';
  content: string;
  oldLine?: number;
  newLine?: number;
}
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
export interface FileDiffPreview {
  hunks: DiffHunk[];
  additions: number | null;
  deletions: number | null;
  fallback?: string;
  truncated: boolean;
}

const MAX_FILES = 100;
const MAX_FILE_CHARS = 200_000;
const MAX_TOTAL_CHARS = 800_000;
const MAX_PREVIEW_LINES = 600;

function plainPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

/** Retain bounded source snapshots. New and deleted files contain raw content, not patches. */
export function parseFileEdits(changes: unknown): ChatFileEdits {
  const result: ChatFileEdits = { files: [], truncated: false };
  if (!Array.isArray(changes)) return result;
  result.truncated = changes.length > MAX_FILES;
  let remaining = MAX_TOTAL_CHARS;
  for (const change of changes.slice(0, MAX_FILES)) {
    if (
      !change ||
      typeof change !== 'object' ||
      !plainPath(change.path) ||
      (typeof change.diff !== 'string' &&
        (typeof change.before !== 'string' || typeof change.after !== 'string')) ||
      !change.kind ||
      typeof change.kind !== 'object' ||
      !['add', 'delete', 'update'].includes(change.kind.type)
    ) {
      result.truncated = true;
      continue;
    }
    const kind = change.kind.type as ChatFileEdit['kind'];
    const movePath = kind === 'update' ? change.kind.move_path : undefined;
    if (movePath != null && !plainPath(movePath)) {
      result.truncated = true;
      continue;
    }
    let diff: string;
    if (typeof change.before === 'string' && typeof change.after === 'string') {
      if (change.before.length > MAX_FILE_CHARS || change.after.length > MAX_FILE_CHARS) {
        result.truncated = true;
        continue;
      }
      if (kind === 'update') {
        const patch = createPatch(change.path, change.before, change.after, undefined, undefined, {
          context: 3,
          timeout: 100,
        });
        if (patch === undefined) {
          result.truncated = true;
          continue;
        }
        diff = patch;
      } else {
        diff = kind === 'add' ? change.after : change.before;
      }
    } else diff = change.diff;
    if (movePath) {
      const suffix = `\n\nMoved to: ${movePath}`;
      if (diff.endsWith(suffix)) diff = diff.slice(0, -suffix.length);
    }
    const limit = Math.min(MAX_FILE_CHARS, remaining);
    const truncated = diff.length > limit;
    diff = diff.slice(0, limit);
    remaining -= diff.length;
    result.truncated ||= truncated;
    result.files.push({
      path: change.path,
      kind,
      ...(movePath ? { movePath } : {}),
      diff,
      format: kind === 'update' ? 'patch' : 'content',
      truncated,
    });
  }
  return result;
}

function patchPaths(patch: StructuredPatch) {
  let oldPath = patch.oldFileName;
  let newPath = patch.newFileName;
  if (
    patch.isGit ||
    ((oldPath?.startsWith('a/') || oldPath === '/dev/null') &&
      (newPath?.startsWith('b/') || newPath === '/dev/null'))
  ) {
    oldPath = oldPath?.replace(/^a\//, '');
    newPath = newPath?.replace(/^b\//, '');
  }
  return { oldPath, newPath };
}

/** Aggregate notifications replace the previous snapshot, including an empty reverted diff. */
export function parseTurnEdits(diff: unknown): ChatFileEdits | null {
  if (typeof diff !== 'string') return null;
  if (!diff.trim()) return { files: [], truncated: false };
  const clipped = diff.length > MAX_TOTAL_CHARS;
  let patches: StructuredPatch[];
  try {
    patches = parsePatch(diff.slice(0, MAX_TOTAL_CHARS));
  } catch {
    return clipped ? { files: [], truncated: true } : null;
  }
  const result: ChatFileEdits = { files: [], truncated: clipped || patches.length > MAX_FILES };
  let remaining = MAX_TOTAL_CHARS;
  for (const patch of patches.slice(0, MAX_FILES)) {
    const { oldPath, newPath } = patchPaths(patch);
    if (oldPath === undefined && newPath === undefined) continue;
    const kind =
      patch.isCreate || oldPath === '/dev/null'
        ? 'add'
        : patch.isDelete || newPath === '/dev/null'
          ? 'delete'
          : 'update';
    const path = kind === 'add' ? newPath : oldPath;
    const movePath = patch.isRename && newPath !== oldPath ? newPath : undefined;
    if (!plainPath(path) || (movePath !== undefined && !plainPath(movePath))) {
      result.truncated = true;
      continue;
    }
    const snapshot = formatPatch(patch);
    const limit = Math.min(MAX_FILE_CHARS, remaining);
    const truncated = clipped || snapshot.length > limit;
    const content = snapshot.slice(0, limit);
    remaining -= content.length;
    result.truncated ||= truncated;
    result.files.push({
      path,
      kind,
      movePath,
      diff: content,
      format: 'patch',
      truncated,
      ...(patch.isBinary ? { binary: true } : {}),
    });
  }
  if (!result.files.length && !result.truncated) return null;
  return result;
}

function fallbackPreview(edit: ChatFileEdit): FileDiffPreview {
  const lines = edit.diff.split('\n');
  return {
    hunks: [],
    additions: null,
    deletions: null,
    fallback: lines.slice(0, MAX_PREVIEW_LINES).join('\n'),
    truncated: edit.truncated || lines.length > MAX_PREVIEW_LINES,
  };
}

/** The library owns patch parsing; this pass only assigns display rows and line numbers. */
export function fileDiffPreview(edit: ChatFileEdit): FileDiffPreview {
  if (edit.binary)
    return { ...fallbackPreview(edit), fallback: 'Binary file content is unavailable.' };
  let patches: StructuredPatch[];
  try {
    const diff =
      edit.format === 'content'
        ? createPatch(
            edit.path,
            edit.kind === 'delete' ? edit.diff : '',
            edit.kind === 'add' ? edit.diff : '',
          )
        : edit.diff;
    patches = parsePatch(diff);
  } catch {
    return fallbackPreview(edit);
  }
  if (
    patches.length !== 1 ||
    patches[0].isBinary ||
    (!patches[0].hunks.length &&
      !patches[0].oldFileName &&
      edit.format !== 'content' &&
      !(edit.movePath && !edit.diff))
  )
    return fallbackPreview(edit);
  const patch = patches[0];
  const result: FileDiffPreview = {
    hunks: [],
    additions: edit.truncated ? null : 0,
    deletions: edit.truncated ? null : 0,
    truncated: edit.truncated,
  };
  let remaining = MAX_PREVIEW_LINES;
  for (const hunk of patch.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const visible: DiffLine[] = [];
    // Count the hunk header against the same row budget as its contents.
    if (remaining > 1) remaining--;
    else remaining = 0;
    for (const line of hunk.lines) {
      const type = line.startsWith('+')
        ? 'add'
        : line.startsWith('-')
          ? 'delete'
          : line.startsWith('\\')
            ? 'meta'
            : 'context';
      if (type === 'add' && result.additions !== null) result.additions++;
      if (type === 'delete' && result.deletions !== null) result.deletions++;
      if (remaining > 0) {
        visible.push({
          type,
          content: type === 'meta' ? line : line.slice(1),
          ...(type === 'context' || type === 'delete' ? { oldLine } : {}),
          ...(type === 'context' || type === 'add' ? { newLine } : {}),
        });
        remaining--;
      } else result.truncated = true;
      if (type === 'context' || type === 'delete') oldLine++;
      if (type === 'context' || type === 'add') newLine++;
    }
    if (visible.length)
      result.hunks.push({
        header: formatPatch({ ...patch, isGit: false, hunks: [hunk] }, OMIT_HEADERS).split(
          '\n',
          1,
        )[0],
        lines: visible,
      });
  }
  return result;
}
