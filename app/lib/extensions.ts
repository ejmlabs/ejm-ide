import type { ContextReference } from './types';

export type ExtensionCapability = 'context.read' | 'chat.attach' | 'source.open';
export interface ExtensionManifest {
  id: string;
  name: string;
  description: string;
  apiVersion: number;
  entry: string;
  capabilities: ExtensionCapability[];
  commands: { id: string; title: string }[];
}
export interface ExtensionSummary {
  id: string;
  manifest: ExtensionManifest | null;
  activeVersion: string | null;
  previousVersion: string | null;
  lastBuild: string | null;
  error: string | null;
}
export interface ExtensionBundle {
  version: string;
  manifest: ExtensionManifest;
  html: string;
  code: string;
  css: string;
  files: number;
}
export interface ExtensionContext {
  id: string;
  kind: string;
  label: string;
  origin: string;
  uri?: string;
  content: string;
}
export type ExtensionMessage =
  | { type: 'ready' }
  | { type: 'navigate'; referenceId: string }
  | { type: 'attach'; referenceId: string }
  | { type: 'attach'; label: string; content: string };

const CHANNEL = 'workbench.extension.v1';
const MAX_NOTE = 16_000;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseExtensionMessage(
  data: unknown,
  session: string,
  capabilities: readonly string[],
): ExtensionMessage | null {
  if (!record(data) || data.channel !== CHANNEL || data.session !== session) return null;
  if (data.type === 'ready') return { type: 'ready' };
  if (
    data.type === 'navigate' &&
    capabilities.includes('source.open') &&
    typeof data.referenceId === 'string' &&
    data.referenceId.length <= 180
  ) {
    return { type: 'navigate', referenceId: data.referenceId };
  }
  if (data.type !== 'attach' || !capabilities.includes('chat.attach')) return null;
  if (typeof data.referenceId === 'string' && data.referenceId.length <= 180)
    return { type: 'attach', referenceId: data.referenceId };
  if (
    typeof data.label !== 'string' ||
    !data.label.trim() ||
    data.label.length > 80 ||
    typeof data.content !== 'string' ||
    !data.content.trim() ||
    data.content.length > MAX_NOTE
  )
    return null;
  return { type: 'attach', label: data.label, content: data.content };
}

export function extensionContext(
  references: readonly ContextReference[],
  capabilities: readonly string[],
): ExtensionContext[] {
  if (!capabilities.includes('context.read')) return [];
  return references.slice(0, 12).map((reference) => ({
    id: reference.id,
    kind: reference.kind,
    label: reference.label.slice(0, 180),
    origin: reference.origin.slice(0, 180),
    uri: reference.uri,
    content:
      reference.content.slice(0, 4_000) +
      (reference.content.length > 4_000
        ? '\n[Content limited to 4,000 characters for this extension.]'
        : ''),
  }));
}

export function extensionHostMessage(
  session: string,
  type: 'context' | 'command',
  value: ExtensionContext[] | string,
) {
  return type === 'context'
    ? { channel: CHANNEL, session, type, references: value }
    : { channel: CHANNEL, session, type, command: value };
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export function extensionDocument(bundle: ExtensionBundle, session: string, nonce: string): string {
  const startup = scriptJson({ channel: CHANNEL, session });
  const sdk = `(() => {
    const identity = ${startup};
    let references = Object.freeze([]);
    const contextListeners = new Set();
    const commandListeners = new Set();
    const send = value => parent.postMessage({ ...identity, ...value }, '*');
    Object.defineProperty(window, 'workbench', { configurable: false, writable: false, value: Object.freeze({
      getContext: () => references,
      onContextChange: listener => { contextListeners.add(listener); return () => contextListeners.delete(listener); },
      onCommand: listener => { commandListeners.add(listener); return () => commandListeners.delete(listener); },
      addToChat: value => send({ ...value, type: 'attach' }),
      openSource: referenceId => send({ type: 'navigate', referenceId }),
    }) });
    addEventListener('message', event => {
      const message = event.data;
      if (event.source !== parent || !message || message.channel !== identity.channel || message.session !== identity.session) return;
      if (message.type === 'context' && Array.isArray(message.references)) {
        references = Object.freeze(message.references.map(reference => Object.freeze(reference)));
        contextListeners.forEach(listener => listener(references));
      }
      if (message.type === 'command' && typeof message.command === 'string') commandListeners.forEach(listener => listener(message.command));
    });
    send({ type: 'ready' });
  })();`;
  const code = `${sdk}\n${bundle.code}`.replace(/<\/script/gi, '<\\/script');
  const css = bundle.css.replace(/<\/style/gi, '<\\/style');
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${extensionTheme()}</style><style>${css}</style></head><body>${bundle.html}<script nonce="${nonce}">${code}</script></body></html>`;
}

// Extension panels run in a sandboxed frame that cannot inherit the host's CSS variables,
// so each panel receives the colors in effect when it is built.
function extensionTheme(): string {
  const root = typeof document === 'undefined' ? undefined : document.documentElement;
  const style = root ? getComputedStyle(root) : undefined;
  const value = (name: string, fallback: string) =>
    style?.getPropertyValue(name).trim() || fallback;
  const dark = root?.dataset.theme !== 'light';
  return `:root{color-scheme:${dark ? 'dark' : 'light'};--background:${value('--ejm-ui-n2', '#1c221d')};--foreground:${value('--ejm-ui-n14', '#e5e7d9')};--muted-foreground:${value('--ejm-ui-n12', '#a8b4a2')};--border:${value('--ejm-ui-n8', '#465349')};--secondary:${value('--ejm-ui-n5', '#29322c')};--primary:${value('--ejm-ui-primary', '#8a9a7b')};}`;
}

export function authoringPrompt(extension?: ExtensionSummary): string {
  const directory = extension
    ? `.workbench/extensions/${extension.id}`
    : '.workbench/extensions/<lowercase-extension-id>';
  return `Build ${extension ? `an update to the ${extension.manifest?.name || extension.id}` : 'a small local'} ejm-ide extension in ${directory}.

Use the existing extension template and read its SKILL.md, extension.json, and sdk.d.ts first. The panel entry is React TSX, bundled with the host's React and React DOM. Local CSS imports work. Keep all changes inside the extension directory. Do not add package scripts, dependencies, native Rust capabilities, network access, shell execution, or another model provider.

The fixed window.workbench SDK can read explicitly shared context, add a shared reference or a plain-text note to chat, and open a shared reference by id. It cannot read arbitrary files or call Tauri. Each manifest capability must be one of context.read, chat.attach, source.open. Commands must be declared in the manifest and handled with onCommand.

Use the attached IDE references as input data. Build a focused tool that helps me inspect and write code. After editing, tell me the changed source files and the checks you ran. I will use Build and preview in Extensions, then Enable or Reload the checked version. A failed build must leave the active version intact.`;
}
