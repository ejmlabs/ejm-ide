import { invoke } from './backend';
import type { LanguageStatus } from './types';

type Buffer = { content: string; version: number };
type Session = { tail: Promise<unknown>; latest: Buffer; synced?: Buffer; closed: boolean };
const sessions = new Map<string, Session>();

async function flush(path: string, session: Session) {
  if (session.closed || sessions.get(path) !== session) return;
  const latest = session.latest;
  if (session.synced?.version === latest.version && session.synced.content === latest.content)
    return;
  await invoke('language_change', { path, ...latest });
  session.synced = latest;
}

export function openLanguageDocument(
  path: string,
  content: string,
  version: number,
): Promise<LanguageStatus> {
  const previous = sessions.get(path);
  if (previous && !previous.closed) void closeLanguageDocument(path);
  const session: Session = { tail: Promise.resolve(), latest: { content, version }, closed: false };
  sessions.set(path, session);
  const start = () => invoke<LanguageStatus>('language_open', { path, content, version });
  const opened = (previous ? previous.tail.catch(() => {}).then(start) : start()).then((status) => {
    session.synced = { content, version };
    return status;
  });
  session.tail = opened;
  return opened;
}

export function syncLanguageDocument(
  path: string,
  content: string,
  version: number,
): Promise<void> {
  const session = sessions.get(path);
  if (!session || session.closed) return Promise.resolve();
  if (version < session.latest.version) return session.tail.then(() => {});
  session.latest = { content, version };
  // Changes wait for didOpen. Queued changes share the newest unsaved buffer.
  const changed = session.tail.catch(() => {}).then(() => flush(path, session));
  session.tail = changed;
  return changed;
}

export function closeLanguageDocument(path: string): Promise<void> {
  const session = sessions.get(path);
  if (!session) return invoke('language_close', { path });
  if (session.closed) return session.tail.then(() => {});
  session.closed = true;
  const closed = session.tail
    .catch(() => {})
    .then(() => invoke<void>('language_close', { path }))
    .then(() => {
      if (sessions.get(path) === session) sessions.delete(path);
    });
  session.tail = closed;
  return closed;
}
