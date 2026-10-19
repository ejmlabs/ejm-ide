import { describe, expect, it } from 'vitest';
import {
  emptyReleaseManifest,
  parsePublicReleaseManifest,
  parseReleaseManifest,
  toPublicReleaseManifest,
} from './manifest';

const hash = 'a'.repeat(64);
const artifact = {
  target: 'darwin-aarch64',
  filename: 'ejm-ide_0.1.0_aarch64.dmg',
  key: `releases/0.1.0/${hash}/ejm-ide_0.1.0_aarch64.dmg`,
  bytes: 42,
  sha256: hash,
};
const manifest = {
  schemaVersion: 1,
  version: '0.1.0',
  publishedAt: '2026-10-18T00:00:00Z',
  artifacts: [artifact],
};

describe('release manifest', () => {
  it('accepts the canonical empty state without claiming a release exists', () => {
    expect(parseReleaseManifest(emptyReleaseManifest())).toEqual(emptyReleaseManifest());
    expect(emptyReleaseManifest()).not.toBe(emptyReleaseManifest());
  });

  it('accepts a release and omits storage keys from its public form', () => {
    const release = parseReleaseManifest(manifest);
    const publicRelease = toPublicReleaseManifest(release);
    expect(publicRelease.artifacts[0]).not.toHaveProperty('key');
    expect(publicRelease.artifacts[0].url).toBe(`/downloads/darwin-aarch64?sha256=${hash}`);
    expect(parsePublicReleaseManifest(publicRelease)).toEqual(publicRelease);
  });

  it.each([
    null,
    [],
    {},
    { ...manifest, schemaVersion: 2 },
    { ...manifest, artifacts: null },
    { ...manifest, version: null },
    { ...manifest, version: '../0.1.0' },
    { ...manifest, publishedAt: null },
    { ...manifest, publishedAt: '2026-02-31T00:00:00Z' },
    { ...manifest, publishedAt: 'not-a-date' },
    { ...manifest, publishedAt: '2026-10-18' },
    { ...manifest, artifacts: [] },
    { ...emptyReleaseManifest(), publishedAt: manifest.publishedAt },
    { ...manifest, sourceUrl: 'http://example.com/repo' },
    { ...manifest, sourceUrl: 'https://secret@example.com/repo' },
    { ...manifest, sourceUrl: 'javascript:alert(1)' },
  ])('rejects malformed or conflicting release state %#', (value) => {
    expect(() => parseReleaseManifest(value)).toThrow();
  });

  it.each([
    { target: 'unknown' },
    { filename: '../installer.dmg' },
    { filename: 'foo\r\nContent-Type: text/html.dmg' },
    { filename: 'ejm-ide_debug.dmg' },
    { filename: 'ejm-ide.exe' },
    { key: '../installer.dmg' },
    { key: 'releases/latest.json' },
    { key: `releases/0.1.0/${hash}/%2e%2e/ejm-ide.dmg` },
    { bytes: 0 },
    { bytes: -1 },
    { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { bytes: 1.5 },
    { sha256: '' },
    { sha256: 'A'.repeat(64) },
    { sha256: undefined },
  ])('rejects unsafe or inconsistent artifacts %#', (change) => {
    expect(() =>
      parseReleaseManifest({ ...manifest, artifacts: [{ ...artifact, ...change }] }),
    ).toThrow();
  });

  it('rejects duplicate targets and storage keys', () => {
    expect(() => parseReleaseManifest({ ...manifest, artifacts: [artifact, artifact] })).toThrow();
    expect(() =>
      parseReleaseManifest({
        ...manifest,
        artifacts: [artifact, { ...artifact, target: 'darwin-x86_64' }],
      }),
    ).toThrow();
  });

  it('accepts release metadata for a verified source URL', () => {
    expect(
      parseReleaseManifest({ ...manifest, sourceUrl: 'https://example.com/project' }).sourceUrl,
    ).toBe('https://example.com/project');
  });

  it.each([
    'https://untrusted.example/installer',
    '//untrusted.example/installer',
    '/downloads/darwin-aarch64?redirect=https://untrusted.example',
    '/downloads/../index.html',
    '/downloads/windows-x86_64',
    '/downloads/darwin-aarch64',
    `/downloads/darwin-aarch64?sha256=${'b'.repeat(64)}`,
    `/downloads/darwin-aarch64?sha256=${hash}&other=true`,
    `/downloads/darwin-aarch64?sha256=${hash}&sha256=${hash}`,
    `/downloads/darwin-aarch64?sha256=${hash.toUpperCase()}`,
  ])('rejects a public artifact URL that is not its known relative route: %s', (url) => {
    const publicRelease = toPublicReleaseManifest(parseReleaseManifest(manifest));
    expect(() =>
      parsePublicReleaseManifest({
        ...publicRelease,
        artifacts: [{ ...publicRelease.artifacts[0], url }],
      }),
    ).toThrow();
  });
});
