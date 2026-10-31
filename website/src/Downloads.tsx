import { Table, type TableRow } from '@ejm/ui/components/Table';
import { Badge } from '@ejm/ui/components/ui/badge';
import { Button } from '@ejm/ui/components/ui/button';
import { Callout } from '@ejm/ui/docs/Callout';
import {
  ContentGroup,
  FileDetail,
  FocusRegion,
  InlineLink,
  VisuallyHidden,
} from '@ejm/ui/layout/SiteContent';
import { type ReactNode, useRef } from 'react';
import type { ReleaseTarget } from '../../distribution/manifest';
import { formatBytes, type Platform } from './release';
import type { ReleasesState } from './useReleases';

const installers: { target: ReleaseTarget; platform: Platform; name: string }[] = [
  { target: 'darwin-aarch64', platform: 'macos', name: 'macOS, Apple Silicon' },
  { target: 'darwin-x86_64', platform: 'macos', name: 'macOS, Intel' },
  { target: 'windows-x86_64', platform: 'windows', name: 'Windows, 64-bit' },
  { target: 'linux-x86_64', platform: 'linux', name: 'Linux, 64-bit' },
];

const columns = [
  { key: 'platform', label: 'Platform' },
  { key: 'installer', label: 'Installer' },
  { key: 'status', label: 'Status' },
];

function rows({ manifest, platform }: Pick<ReleasesState, 'manifest' | 'platform'>): TableRow[] {
  return installers.map((installer) => {
    const artifact = manifest?.artifacts.find((item) => item.target === installer.target);
    return {
      platform: (
        <>
          {installer.name}
          {installer.platform === platform && (
            <>
              {' '}
              <Badge separator="dot">your platform</Badge>
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
}

function messageFor({ state, manifest, published }: ReleasesState): string {
  if (state.status === 'loading') return 'Checking available downloads…';
  if (state.status === 'error') return 'Downloads could not be loaded. Please try again.';
  if (manifest && published) {
    const version = manifest.version ? `Version ${manifest.version}. ` : '';
    return `${version}Free download. No ejmlabs account required.`;
  }
  return 'We’re preparing the first desktop release. The download will appear here when it’s ready.';
}

/**
 * The installer table and its status, live from `/api/releases`. The prerendered page shows the same table with no
 * installer, which is true until a release is published, and a note that links the plain release list for visitors
 * without scripts.
 */
export function Downloads({
  releases,
  children,
}: {
  releases: ReleasesState;
  children?: ReactNode;
}) {
  const { state, manifest, refresh } = releases;
  const table = useRef<HTMLDivElement>(null);
  const failed = state.status === 'error';
  const retry = () => {
    refresh();
    // Loading removes the button, so focus returns to the table.
    table.current?.focus();
  };
  return (
    <ContentGroup>
      <FocusRegion ref={table} tabIndex={-1}>
        <Table
          label="Installers by platform"
          caption="ejm-ide installers by platform"
          columns={columns}
          rows={rows(releases)}
          rowHeader="platform"
          truncate={false}
        />
      </FocusRegion>
      <div role="status" aria-live="polite">
        <Callout kind={failed ? 'warning' : 'note'}>
          <p>{messageFor(releases)}</p>
          {manifest?.sourceUrl && (
            <p>
              <InlineLink href={manifest.sourceUrl} external>
                Source
              </InlineLink>
            </p>
          )}
        </Callout>
        {failed && (
          <Button variant="secondary" onClick={retry}>
            Try again
          </Button>
        )}
      </div>
      <noscript>
        <Callout kind="warning">
          <p>
            Enable JavaScript to check for new installers. Without it,{' '}
            <a href="/api/releases">the release list</a> names every published installer with its
            checksum.
          </p>
        </Callout>
      </noscript>
      {children}
    </ContentGroup>
  );
}
