import { Channel } from '@tauri-apps/api/core';

declare global {
  interface Window {
    __WORKBENCH_INVOKE__?: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
  }
}

export const isDesktop = '__TAURI_INTERNALS__' in window;
export const previewRoot = '/sample/harbor';
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isDesktop) {
    if (!window.__WORKBENCH_INVOKE__)
      throw new Error('The native bridge is unavailable. Restart ejm-ide.');
    return window.__WORKBENCH_INVOKE__<T>(command, args);
  }
  const { invokePreview } = await import('./backend-preview');
  return invokePreview<T>(command, args, previewRoot);
}

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
let subscription: Promise<void> | undefined;
function subscribe() {
  if (!isDesktop) return Promise.resolve();
  if (!subscription) {
    const channel = new Channel<{ event: string; payload: unknown }>();
    channel.onmessage = ({ event, payload }) => {
      handlers.get(event)?.forEach((fn) => {
        fn(payload);
      });
    };
    subscription = invoke<void>('host_subscribe', { channel }).catch((error) => {
      subscription = undefined;
      throw error;
    });
  }
  return subscription;
}
export async function onEvent<T>(event: string, fn: (payload: T) => void): Promise<() => void> {
  const handler: Handler = (payload) => fn(payload as T);
  const set = handlers.get(event) || new Set<Handler>();
  set.add(handler);
  handlers.set(event, set);
  try {
    await subscribe();
  } catch (error) {
    set.delete(handler);
    throw error;
  }
  return () => {
    set.delete(handler);
  };
}
