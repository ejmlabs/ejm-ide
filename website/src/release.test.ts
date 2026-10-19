import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectPlatform, formatBytes, loadReleases } from './release';

const sha256 = 'a'.repeat(64);
const published = {
  schemaVersion: 1,
  version: '0.1.0',
  publishedAt: '2026-10-18T20:00:00Z',
  sourceUrl: 'https://example.com/ejm-ide',
  artifacts: [
    {
      target: 'darwin-aarch64',
      filename: 'ejm-ide-0.1.0-arm64.dmg',
      bytes: 10485760,
      sha256,
      url: `/downloads/darwin-aarch64?sha256=${sha256}`,
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('download release adapter', () => {
  it('loads only the validated public manifest and passes cancellation to fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(published));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    await expect(loadReleases(controller.signal)).resolves.toEqual(published);
    expect(fetcher).toHaveBeenCalledWith('/api/releases', {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
  });

  it('accepts an honest unpublished release', async () => {
    const empty = { schemaVersion: 1, version: null, publishedAt: null, artifacts: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(empty)));
    await expect(loadReleases()).resolves.toEqual(empty);
  });

  it('rejects a download URL outside the canonical same-origin route', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ...published,
          artifacts: [{ ...published.artifacts[0], url: 'https://example.com/installer.dmg' }],
        }),
      ),
    );
    await expect(loadReleases()).rejects.toThrow('Release download URL is not canonical.');
  });

  it('rejects HTTP errors rather than treating their JSON as release data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Unavailable', { status: 503 })));
    await expect(loadReleases()).rejects.toThrow('Downloads could not be loaded.');
  });

  it('preserves an abort failure so the page can ignore a replaced request', async () => {
    const abort = new DOMException('Request was aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    await expect(loadReleases()).rejects.toBe(abort);
  });
});

describe('platform hint', () => {
  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'macos'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'windows'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'linux'],
    ['Mozilla/5.0 (Linux; Android 15)', undefined],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', undefined],
    ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', undefined],
    ['unknown', undefined],
  ])('uses %s only as a platform hint', (userAgent, expected) => {
    expect(detectPlatform(userAgent)).toBe(expected);
  });

  it('formats installer sizes without exposing byte arithmetic in the page', () => {
    expect(formatBytes(10485760)).toBe('10 MiB');
  });
});
