import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicReleaseManifest } from '../../distribution/manifest';
import { detectPlatform, loadReleases, type Platform } from './release';

export type ReleaseState =
  /** The prerendered page, and the moment before the first request starts. It shows what is true with no release data. */
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; manifest: PublicReleaseManifest };

/**
 * The live release list from `/api/releases`, owned by one hook. The first render matches the prerendered HTML, so the
 * request and the platform hint start after hydration. A newer request cancels the one before it, and a cancelled
 * request never changes the state. Leaving the page (or its bfcache entry) cancels the request.
 */
export function useReleases() {
  const [state, setState] = useState<ReleaseState>({ status: 'idle' });
  const [platform, setPlatform] = useState<Platform>();
  const active = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(() => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState({ status: 'loading' });
    loadReleases(controller.signal).then(
      (manifest) => {
        if (!controller.signal.aborted) setState({ status: 'ready', manifest });
      },
      () => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      },
    );
  }, []);

  useEffect(() => {
    const stop = () => active.current?.abort();
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) refresh();
    };
    setPlatform(detectPlatform(navigator.userAgent));
    refresh();
    window.addEventListener('pagehide', stop);
    window.addEventListener('pageshow', restore);
    return () => {
      stop();
      window.removeEventListener('pagehide', stop);
      window.removeEventListener('pageshow', restore);
    };
  }, [refresh]);

  const manifest = state.status === 'ready' ? state.manifest : undefined;
  return { state, manifest, published: (manifest?.artifacts.length ?? 0) > 0, platform, refresh };
}

export type ReleasesState = ReturnType<typeof useReleases>;
