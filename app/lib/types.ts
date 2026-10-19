export interface Entry {
  path: string;
  name: string;
  kind: 'file' | 'directory';
}
export interface Workspace {
  root: string;
  name: string;
  entries: Entry[];
  branch?: string | null;
}
export interface Document {
  path: string;
  content: string;
  version: string;
}
export interface EditorDocument extends Document {
  savedContent: string;
  modelVersion: number;
  language: string;
}
export interface Position {
  line: number;
  character: number;
}
export interface SourceRange {
  start: Position;
  end: Position;
}
export interface Location {
  uri: string;
  range: SourceRange;
}
export interface Diagnostic {
  range: SourceRange;
  message: string;
  severity?: number;
  source?: string;
  code?: string | number;
}
export interface DiagnosticEntry extends Diagnostic {
  uri: string;
}
export interface LanguageStatus {
  language: string;
  status: string;
  capabilities?: Record<string, unknown>;
  message?: string;
}
export interface SymbolItem {
  name: string;
  kind: number;
  uri: string;
  range: SourceRange;
  selectionRange: SourceRange;
  detail?: string;
  data?: unknown;
  children?: SymbolItem[];
  version?: string;
}
export interface CallRelation {
  from: SymbolItem;
  to: SymbolItem;
  fromRanges: SourceRange[];
  evidence?: 'inferred' | 'ambiguous' | 'verified';
}
export type CallDirection = 'incoming' | 'outgoing';
export interface CallGraphFrontier {
  symbol: SymbolItem;
  direction: CallDirection;
  remaining?: number;
}
export interface CallHierarchy {
  root: SymbolItem;
  incoming: CallRelation[];
  outgoing: CallRelation[];
  origin?: 'index' | 'language-server';
  nodes?: SymbolItem[];
  relations?: CallRelation[];
  traversal?: {
    state: 'loading' | 'ready' | 'complete' | 'partial';
    visited: number;
    pending: number;
    frontier?: CallGraphFrontier[];
    batchSize?: number;
    boundaries: {
      symbol: SymbolItem;
      direction: 'incoming' | 'outgoing';
      reason: string;
    }[];
    reasons: string[];
  };
}
export type ReferenceKind =
  | 'file'
  | 'selection'
  | 'symbol'
  | 'caller'
  | 'callee'
  | 'diagnostic'
  | 'diff'
  | 'git'
  | 'terminal'
  | 'graph'
  | 'presentation'
  | 'extension';
export interface ContextReference {
  id: string;
  kind: ReferenceKind;
  label: string;
  origin: string;
  uri?: string;
  ranges?: SourceRange[];
  version?: string;
  content: string;
  capturedAt: number;
  truncated?: boolean;
}
export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}
export interface GitChange {
  path: string;
  status: string;
}
export interface CommandResult {
  command: string;
  output: string;
  exitCode: number | null;
}
export interface AgentEvent {
  providerId: string;
  method: string;
  threadId?: string | null;
  connection?: number;
  scope?: 'control' | 'session';
  cwd?: string | null;
  params: {
    success?: boolean;
    error?: string | { message?: string } | null;
    itemId?: string;
    item_id?: string;
    turnId?: string;
    delta?: string;
    item?: { id: string; type: string; text?: string };
    turn?: { status?: string; error?: string | { message?: string } | null };
    reviewId?: string;
    review?: { status?: string; rationale?: string };
    action?: unknown;
    message?: string;
    willRetry?: boolean;
    scope?: 'control' | 'session';
  };
  requestId?: unknown;
}
