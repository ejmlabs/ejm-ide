import { parseHTML } from 'linkedom';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PublicReleaseManifest } from '../../distribution/manifest';
import type { Platform } from './release';
import { type ReleaseState, ReleaseTable } from './releases';

const empty: PublicReleaseManifest = {
  schemaVersion: 1,
  version: null,
  publishedAt: null,
  artifacts: [],
};

function table(state: ReleaseState, platform?: Platform) {
  const markup = renderToStaticMarkup(<ReleaseTable state={state} platform={platform} />);
  return parseHTML(`<html><body>${markup}</body></html>`).document;
}

describe('release table claims', () => {
  it.each(['idle', 'loading', 'error'] as const)(
    'does not claim an unpublished installer while status is %s',
    (status) => {
      const document = table({ status });
      expect(document.querySelectorAll('dt')).toHaveLength(4);
      expect(document.querySelector('a')).toBeNull();
      expect(document.body.textContent).not.toMatch(/not published|in development/i);
      expect(document.body.textContent).toMatch(/not been checked|checking|unknown/i);
      expect(document.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe(
        String(status === 'loading'),
      );
    },
  );

  it('marks installers absent only after the release list proves they are absent', () => {
    const document = table({ status: 'ready', manifest: empty });
    expect(document.querySelectorAll('[data-status="pending"]')).toHaveLength(4);
    expect(document.body.textContent?.match(/Installer not published yet/g)).toHaveLength(4);
    expect(document.querySelector('a')).toBeNull();
  });

  it('retains the verified download identity and leaves other platforms unpublished', () => {
    const sha256 = 'a'.repeat(64);
    const url = `/downloads/darwin-aarch64?sha256=${sha256}`;
    const document = table({
      status: 'ready',
      manifest: {
        ...empty,
        version: '0.1.0',
        publishedAt: '2026-10-18T20:00:00Z',
        artifacts: [
          {
            target: 'darwin-aarch64',
            filename: 'ejm-ide-0.1.0-arm64.dmg',
            bytes: 10485760,
            sha256,
            url,
          },
        ],
      },
    });
    expect(document.querySelectorAll('a')).toHaveLength(1);
    expect(document.querySelector('a')?.getAttribute('href')).toBe(url);
    expect(document.body.textContent).toContain('10 MiB');
    expect(document.body.textContent).toContain(`SHA-256 ${sha256}`);
    expect(document.body.textContent?.match(/Installer not published yet/g)).toHaveLength(3);
  });

  it('keeps both Mac CPU choices explicit without claiming to detect either one', () => {
    const labels = Array.from(
      table({ status: 'ready', manifest: empty }, 'macos').querySelectorAll('dt'),
    ).map((label) => label.textContent);
    expect(labels.slice(0, 2)).toEqual(['macOS, Apple Silicon', 'macOS, Intel']);
    expect(labels.join(' ')).not.toMatch(/your/);
  });

  it.each(['windows', 'linux'] as const)('retains the %s operating-system hint', (platform) => {
    const labels = Array.from(
      table({ status: 'ready', manifest: empty }, platform).querySelectorAll('dt'),
    ).map((label) => label.textContent);
    expect(labels.filter((label) => label?.includes('(your OS)'))).toHaveLength(1);
    expect(labels.find((label) => label?.includes('(your OS)'))?.toLowerCase()).toContain(platform);
  });
});
