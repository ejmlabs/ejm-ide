import { Fact, Facts, Status } from '@ejm/ui/layout';
import { FileDetail, FocusRegion, InlineLink, VisuallyHidden } from '@ejm/ui/layout/SiteContent';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { PublicReleaseManifest, ReleaseTarget } from '../../distribution/manifest';
import { detectPlatform, formatBytes, loadReleases, type Platform } from './release';

export const installers: { target: ReleaseTarget; platform: Platform; name: string }[] = [
  { target: 'darwin-aarch64', platform: 'macos', name: 'macOS, Apple Silicon' },
  { target: 'darwin-x86_64', platform: 'macos', name: 'macOS, Intel' },
  { target: 'windows-x86_64', platform: 'windows', name: 'Windows, 64-bit' },
  { target: 'linux-x86_64', platform: 'linux', name: 'Linux, 64-bit' },
];

/** idle is what the server renders and the first client render shows, so hydration matches and no-script readers get a true page. */
export type ReleaseState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; manifest: PublicReleaseManifest };

const uncheckedStatus = {
  idle: { label: 'Not checked', detail: 'Availability has not been checked.' },
  loading: { label: 'Checking', detail: 'Checking installer availability.' },
  error: { label: 'Status unavailable', detail: 'Availability is unknown. Try again below.' },
} as const;

export function useReleases() {
  const [state, setState] = useState<ReleaseState>({ status: 'idle' });
  const [platform, setPlatform] = useState<Platform | undefined>();
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
    setPlatform(detectPlatform(navigator.userAgent));
    refresh();
    const stop = () => active.current?.abort();
    const again = (event: PageTransitionEvent) => {
      if (event.persisted) refresh();
    };
    window.addEventListener('pagehide', stop);
    window.addEventListener('pageshow', again);
    return () => {
      stop();
      window.removeEventListener('pagehide', stop);
      window.removeEventListener('pageshow', again);
    };
  }, [refresh]);

  const manifest = state.status === 'ready' ? state.manifest : undefined;
  const anyRelease = (manifest?.artifacts.length ?? 0) > 0;
  return { state, manifest, anyRelease, platform, refresh };
}

/** One sentence about the release list, true in every state. */
export function releaseMessage(
  state: ReleaseState,
  manifest: PublicReleaseManifest | undefined,
): string {
  switch (state.status) {
    case 'idle':
      return 'Installer availability has not been checked. Enable JavaScript to check.';
    case 'loading':
      return 'Checking available downloads.';
    case 'error':
      return 'Downloads could not be loaded. Please try again.';
    case 'ready': {
      if (manifest && manifest.artifacts.length > 0) {
        const version = manifest.version ? `Version ${manifest.version}. ` : '';
        return `${version}Free download. No ejmlabs account required.`;
      }
      return 'The first desktop release is being prepared. The download will appear here when it is ready.';
    }
  }
}

/** Only a validated release list can prove an installer is published or absent. */
export function ReleaseTable({
  state,
  platform,
  region,
}: {
  state: ReleaseState;
  platform: Platform | undefined;
  region?: React.Ref<HTMLDivElement>;
}) {
  const manifest = state.status === 'ready' ? state.manifest : undefined;
  const unchecked = state.status === 'ready' ? undefined : uncheckedStatus[state.status];
  return (
    <FocusRegion ref={region} tabIndex={-1} aria-busy={state.status === 'loading'}>
      <Facts>
        {installers.map((installer) => {
          const artifact = manifest?.artifacts.find((item) => item.target === installer.target);
          const mine = installer.platform === platform && platform !== 'macos';
          let value: ReactNode;
          if (artifact) {
            value = (
              <>
                <InlineLink href={artifact.url} external>
                  Download {artifact.filename} <VisuallyHidden>for {installer.name}</VisuallyHidden>
                </InlineLink>
                <FileDetail>{formatBytes(artifact.bytes)}</FileDetail>
                <FileDetail>SHA-256 {artifact.sha256}</FileDetail>
              </>
            );
          } else if (unchecked) {
            value = (
              <>
                <Status
                  status={state.status === 'error' ? 'warn' : 'pending'}
                  label={unchecked.label}
                />
                <FileDetail>{unchecked.detail}</FileDetail>
              </>
            );
          } else {
            value = (
              <>
                <Status status="pending" label="In development" />
                <FileDetail>Installer not published yet</FileDetail>
              </>
            );
          }
          return (
            <Fact
              key={installer.target}
              label={mine ? `${installer.name} (your OS)` : installer.name}
            >
              {value}
            </Fact>
          );
        })}
      </Facts>
    </FocusRegion>
  );
}
