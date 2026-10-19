import {
  type PublicReleaseManifest,
  parsePublicReleaseManifest,
} from '../../distribution/manifest';

export type Platform = 'macos' | 'windows' | 'linux';

export function detectPlatform(userAgent: string): Platform | undefined {
  if (/Android|iPhone|iPad|iPod/i.test(userAgent)) return undefined;
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos';
  if (/Linux|X11/i.test(userAgent)) return 'linux';
  return undefined;
}

export async function loadReleases(signal?: AbortSignal): Promise<PublicReleaseManifest> {
  const response = await fetch('/api/releases', {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Downloads could not be loaded.');
  return parsePublicReleaseManifest(await response.json());
}

export function formatBytes(bytes: number): string {
  return `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(bytes / 1_048_576)} MiB`;
}
