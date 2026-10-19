import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  type ExtensionBundle,
  extensionContext,
  extensionDocument,
  extensionHostMessage,
  parseExtensionMessage,
} from './extensions';
import type { ContextReference } from './types';

const session = 'panel-session';
const identity = { channel: 'workbench.extension.v1', session };
const reference: ContextReference = {
  id: 'shared',
  kind: 'selection',
  label: 'Selected method',
  origin: 'editor',
  uri: 'file:///project/main.rs',
  content: 'fn main() {}',
  capturedAt: 1,
};
const bundle: ExtensionBundle = {
  version: 'checked',
  manifest: {
    id: 'notebook',
    name: 'Notebook',
    description: '',
    apiVersion: 1,
    entry: 'panel.tsx',
    capabilities: ['context.read', 'chat.attach', 'source.open'],
    commands: [{ id: 'clear', title: 'Clear' }],
  },
  html: '<div id="root"></div>',
  code: '',
  css: '',
  files: 1,
};

describe('extension host boundary', () => {
  it('requires the current session and the declared capability', () => {
    const navigate = { ...identity, type: 'navigate', referenceId: 'shared' };
    expect(parseExtensionMessage(navigate, 'other-session', ['source.open'])).toBeNull();
    expect(parseExtensionMessage(navigate, session, [])).toBeNull();
    expect(parseExtensionMessage(navigate, session, ['source.open'])).toEqual({
      type: 'navigate',
      referenceId: 'shared',
    });
    expect(
      parseExtensionMessage({ ...identity, type: 'attach', referenceId: 'shared' }, session, [
        'context.read',
      ]),
    ).toBeNull();
    expect(
      parseExtensionMessage({ ...identity, type: 'shell', command: 'whoami' }, session, [
        'source.open',
      ]),
    ).toBeNull();
    expect(parseExtensionMessage(null, session, [])).toBeNull();
  });

  it('bounds notes and shares only a limited explicit context snapshot', () => {
    const attach = { ...identity, type: 'attach', label: 'Note', content: 'Useful detail' };
    expect(parseExtensionMessage(attach, session, ['chat.attach'])).toEqual({
      type: 'attach',
      label: 'Note',
      content: 'Useful detail',
    });
    expect(
      parseExtensionMessage({ ...attach, content: 'x'.repeat(16_001) }, session, ['chat.attach']),
    ).toBeNull();
    expect(parseExtensionMessage({ ...attach, label: ' ' }, session, ['chat.attach'])).toBeNull();
    const references = Array.from({ length: 20 }, (_, index) => ({
      ...reference,
      id: String(index),
      content: 'x'.repeat(4_001),
    }));
    expect(extensionContext(references, [])).toEqual([]);
    const shared = extensionContext(references, ['context.read']);
    expect(shared).toHaveLength(12);
    expect(shared[0].content).toBe(
      `${'x'.repeat(4_000)}\n[Content limited to 4,000 characters for this extension.]`,
    );
    expect(shared[0]).not.toHaveProperty('capturedAt');
    expect(references[0].content).toHaveLength(4_001);
  });

  it('builds a nonce-only script document and contains closing-tag payloads', () => {
    const document = extensionDocument(
      {
        ...bundle,
        code: 'console.log("</script><script>unsafe()</script>")',
        css: '/* </style><script>unsafe()</script> */',
      },
      session,
      'test-nonce',
    );
    expect(document).toContain("script-src 'nonce-test-nonce'");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("frame-src 'none'");
    expect(document).not.toContain('</style><script>unsafe()');
    expect(document.match(/<script /g)).toHaveLength(1);
    expect(document.slice(document.indexOf('<script nonce=')).match(/<\/script>/g)).toHaveLength(1);
  });

  it('exposes only the fixed SDK and accepts host messages from the actual parent', () => {
    const messages: unknown[] = [];
    const listeners: ((event: { source: unknown; data: unknown }) => void)[] = [];
    const parent = { postMessage: (value: unknown) => messages.push(value) };
    const window: Record<string, unknown> = {};
    const document = extensionDocument(bundle, session, 'test-nonce');
    const script = document.match(/<script nonce="test-nonce">([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeDefined();
    if (!script) throw new Error('The extension document has no script.');
    runInNewContext(script, {
      window,
      parent,
      addEventListener: (_type: string, listener: (typeof listeners)[number]) =>
        listeners.push(listener),
    });
    const api = window.workbench as {
      getContext(): readonly unknown[];
      addToChat(value: { referenceId: string }): void;
      openSource(id: string): void;
      onCommand(listener: (command: string) => void): () => void;
    };
    expect(Object.keys(api).sort()).toEqual([
      'addToChat',
      'getContext',
      'onCommand',
      'onContextChange',
      'openSource',
    ]);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(window, 'workbench')).toMatchObject({
      configurable: false,
      writable: false,
    });
    const shared = extensionContext([reference], ['context.read']);
    listeners[0]({ source: {}, data: extensionHostMessage(session, 'context', shared) });
    expect(api.getContext()).toHaveLength(0);
    listeners[0]({ source: parent, data: extensionHostMessage('wrong', 'context', shared) });
    expect(api.getContext()).toHaveLength(0);
    listeners[0]({ source: parent, data: extensionHostMessage(session, 'context', shared) });
    expect(api.getContext()).toHaveLength(1);
    expect(Object.isFrozen(api.getContext()[0])).toBe(true);
    api.openSource('shared');
    api.addToChat({ referenceId: 'shared' });
    expect(messages).toEqual([
      { ...identity, type: 'ready' },
      { ...identity, type: 'navigate', referenceId: 'shared' },
      { ...identity, type: 'attach', referenceId: 'shared' },
    ]);
    const commands: string[] = [];
    const unsubscribe = api.onCommand((command) => commands.push(command));
    listeners[0]({ source: parent, data: extensionHostMessage(session, 'command', 'clear') });
    unsubscribe();
    listeners[0]({ source: parent, data: extensionHostMessage(session, 'command', 'clear') });
    expect(commands).toEqual(['clear']);
  });
});
