import { Badge, Button, Callout, Table, type TableColumn } from '@ejm/ui';
import { FileDetail, InlineLink, VisuallyHidden } from '@ejm/ui/layout/SiteContent';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicReleaseManifest, ReleaseTarget } from '../../distribution/manifest';
import { detectPlatform, formatBytes, loadReleases, type Platform } from './release';

const installers: { target: ReleaseTarget; platform: Platform; name: string }[] = [
  { target: 'darwin-aarch64', platform: 'macos', name: 'macOS, Apple Silicon' },
  { target: 'darwin-x86_64', platform: 'macos', name: 'macOS, Intel' },
  { target: 'windows-x86_64', platform: 'windows', name: 'Windows, 64-bit' },
  { target: 'linux-x86_64', platform: 'linux', name: 'Linux, 64-bit' },
];

/** `pending` is the prerendered state, before any script runs; it reads the same as an empty release list. */
export type ReleaseState =
  | { status: 'pending' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; manifest: PublicReleaseManifest };

/** Loads `/api/releases` after hydration, again when the page returns from the back-forward cache, and on retry. */
export function useReleases(): { state: ReleaseState; retry: () => void } {
  const [state, setState] = useState<ReleaseState>({ status: 'pending' });
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
    refresh();
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) refresh();
    };
    const onHide = () => active.current?.abort();
    window.addEventListener('pageshow', onShow);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pageshow', onShow);
      window.removeEventListener('pagehide', onHide);
      active.current?.abort();
    };
  }, [refresh]);

  return { state, retry: refresh };
}

export function hasRelease(state: ReleaseState): boolean {
  return state.status === 'ready' && state.manifest.artifacts.length > 0;
}

const columns: readonly TableColumn[] = [
  { key: 'platform', label: 'Platform' },
  { key: 'installer', label: 'Installer' },
  { key: 'status', label: 'Status' },
];

function message(state: ReleaseState): string {
  if (state.status === 'loading') return 'Checking available downloads…';
  if (state.status === 'ready' && hasRelease(state)) {
    const version = state.manifest.version ? `Version ${state.manifest.version}. ` : '';
    return `${version}Free download. No ejmlabs account required.`;
  }
  return 'We’re preparing the first desktop release. The download will appear here when it’s ready.';
}

/** The installer table and its status line. Rows say "In development" until a signed installer is listed. */
export function Downloads({ state, retry }: { state: ReleaseState; retry: () => void }) {
  const [yourPlatform, setYourPlatform] = useState<Platform | undefined>(undefined);
  useEffect(() => setYourPlatform(detectPlatform(navigator.userAgent)), []);
  const manifest = state.status === 'ready' ? state.manifest : undefined;

  const rows = installers.map((installer) => {
    const artifact = manifest?.artifacts.find((item) => item.target === installer.target);
    return {
      id: installer.target,
      platform: (
        <>
          {installer.name}
          {installer.platform === yourPlatform && (
            <>
              {' '}
              <Badge>your platform</Badge>
            </>
          )}
        </>
      ),
      installer: artifact ? (
        <>
          {artifact.filename} · {formatBytes(artifact.bytes)}
          <FileDetail>SHA-256 {artifact.sha256}</FileDetail>
        </>
      ) : (
        'Installer not published yet'
      ),
      status: artifact ? (
        <Button asChild>
          <a href={artifact.url}>
            Download<VisuallyHidden> for {installer.name}</VisuallyHidden>
          </a>
        </Button>
      ) : (
        'In development'
      ),
    };
  });

  return (
    <>
      <Table
        label="Installers by platform"
        caption="ejm-ide installers by platform"
        columns={columns}
        rows={rows}
        rowHeader="platform"
        rowKey="id"
        truncate={false}
        state={state.status === 'error' ? 'error' : 'default'}
        message={
          state.status === 'error' ? 'Downloads could not be loaded. Please try again.' : undefined
        }
        action={state.status === 'error' ? { label: 'Try again' } : undefined}
        onAction={retry}
      />
      {state.status !== 'error' && (
        <div role="status" aria-live="polite">
          <Callout>
            {message(state)}
            {manifest?.sourceUrl && (
              <>
                {' '}
                <InlineLink href={manifest.sourceUrl} external>
                  Source
                </InlineLink>
              </>
            )}
          </Callout>
        </div>
      )}
      <noscript>
        <Callout kind="warning">Enable JavaScript to check for new installers.</Callout>
      </noscript>
    </>
  );
}
