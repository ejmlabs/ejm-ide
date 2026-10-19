import { describe, expect, it, vi } from 'vitest';
import { emptyReleaseManifest } from './manifest';
import { type DistributionEnv, handleRequest } from './worker';

const hash = 'a'.repeat(64);
const artifact = {
  target: 'darwin-aarch64',
  filename: 'ejm-ide_0.1.0_aarch64.dmg',
  key: `releases/0.1.0/${hash}/ejm-ide_0.1.0_aarch64.dmg`,
  bytes: 5,
  sha256: hash,
};
const manifest = {
  schemaVersion: 1,
  version: '0.1.0',
  publishedAt: '2026-10-18T00:00:00Z',
  artifacts: [artifact],
};

function object(body: string | null = 'abcde', overrides: Record<string, unknown> = {}) {
  return {
    size: 5,
    httpEtag: '"installer-etag"',
    uploaded: new Date('2026-10-18T00:00:00Z'),
    ...(body === null ? {} : { body: new Response(body).body }),
    ...overrides,
  };
}

function setup(release: unknown = manifest, binary: unknown = object()) {
  const get = vi.fn(async (key: string, _options?: unknown) => {
    if (key === 'releases/latest.json') {
      return release === null
        ? null
        : { size: 1000, json: async () => release, body: new Response('{}').body };
    }
    return binary;
  });
  const fetch = vi.fn(async () => new Response('static asset'));
  const env = { RELEASES: { get }, ASSETS: { fetch } } as unknown as DistributionEnv;
  return { env, get, fetch };
}

const downloadPath = `/downloads/darwin-aarch64?sha256=${hash}`;

const request = (path: string, init?: RequestInit) =>
  new Request(`https://ide.ejmlabs.com${path}`, init);

describe('Cloudflare distribution Worker', () => {
  it('returns an honest empty state before the first release', async () => {
    const { env } = setup(null);
    const response = await handleRequest(request('/api/releases'), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(emptyReleaseManifest());
    expect(response.headers.get('Cache-Control')).toContain('max-age=30');
  });

  it('returns a public manifest without exposing R2 keys', async () => {
    const { env } = setup();
    const response = await handleRequest(request('/api/releases'), env);
    const body = await response.json();
    expect(body.artifacts[0].url).toBe(downloadPath);
    expect(body.artifacts[0]).not.toHaveProperty('key');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('supports HEAD for the release API without a body', async () => {
    const { env } = setup();
    const response = await handleRequest(request('/api/releases', { method: 'HEAD' }), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Type')).toContain('application/json');
  });

  it.each([
    '/api',
    '/api/unknown',
    '/api/12345/darwin-aarch64',
    '/downloads',
    '/downloads/unknown',
    '/downloads/darwin-aarch64/other',
    '/downloads/%2e%2e%2freleases%2flatest.json',
  ])('does not fall back to the website for unknown API/download paths: %s', async (path) => {
    const { env, fetch, get } = setup();
    const response = await handleRequest(request(path), env);
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(fetch).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('delegates ordinary website paths to Cloudflare static assets', async () => {
    const { env, fetch, get } = setup();
    const response = await handleRequest(request('/styles.css'), env);
    expect(await response.text()).toBe('static asset');
    expect(fetch).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects mutations on release routes', async () => {
    const { env, get } = setup();
    const response = await handleRequest(request('/api/releases', { method: 'POST' }), env);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
    expect(get).not.toHaveBeenCalled();
  });

  it('does not manufacture a download for an unreleased platform', async () => {
    const { env, get } = setup();
    const response = await handleRequest(request('/downloads/windows-x86_64'), env);
    expect(response.status).toBe(404);
    expect(get).toHaveBeenCalledOnce();
    expect((await response.json()).error).toBe('not_released');
  });

  it.each([null, object('abcde', { size: 99 })])(
    'reports a manifest artifact unavailable when its real object is missing or mismatched',
    async (binary) => {
      const { env } = setup(manifest, binary);
      const response = await handleRequest(request(downloadPath), env);
      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Retry-After')).toBe('60');
    },
  );

  it.each([
    '/downloads/darwin-aarch64',
    `/downloads/darwin-aarch64?sha256=${'b'.repeat(64)}`,
    `/downloads/darwin-aarch64?sha256=${hash}&other=true`,
    `/downloads/darwin-aarch64?sha256=${hash}&sha256=${hash}`,
  ])(
    'rejects missing, old, wrong, or noncanonical digests before reading binary data: %s',
    async (path) => {
      const { env, get } = setup();
      const response = await handleRequest(request(path), env);
      expect(response.status).toBe(409);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect((await response.json()).error).toBe('release_changed');
      expect(get).toHaveBeenCalledOnce();
      expect(get.mock.calls[0][0]).toBe('releases/latest.json');
    },
  );

  it('never serves new release bytes through a link cached from the previous manifest', async () => {
    const nextHash = 'c'.repeat(64);
    const next = {
      ...manifest,
      version: '0.2.0',
      artifacts: [
        {
          ...artifact,
          sha256: nextHash,
          key: `releases/0.2.0/${nextHash}/${artifact.filename}`,
        },
      ],
    };
    const { env, get } = setup(next);
    const response = await handleRequest(request(downloadPath), env);
    expect(response.status).toBe(409);
    expect(get).toHaveBeenCalledOnce();
    expect(get.mock.calls[0][0]).toBe('releases/latest.json');
  });

  it('does not turn an unreleased target into an outdated-link error', async () => {
    const { env, get } = setup(null);
    const response = await handleRequest(request('/downloads/darwin-aarch64'), env);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('not_released');
    expect(get).toHaveBeenCalledOnce();
  });

  it('streams a verified installer with safe attachment headers', async () => {
    const { env } = setup();
    const response = await handleRequest(request(downloadPath), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('abcde');
    expect(response.headers.get('Content-Type')).toBe('application/x-apple-diskimage');
    expect(response.headers.get('Content-Length')).toBe('5');
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="ejm-ide_0.1.0_aarch64.dmg"',
    );
  });

  it('supports HEAD and ignores its range without reading the binary', async () => {
    const body = new ReadableStream({ cancel: vi.fn() });
    const cancel = vi.spyOn(body, 'cancel');
    const { env, get } = setup(manifest, object('', { body }));
    const response = await handleRequest(
      request(downloadPath, { method: 'HEAD', headers: { Range: 'bytes=1-2' } }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Length')).toBe('5');
    expect(cancel).toHaveBeenCalledOnce();
    expect(get.mock.calls[1][1]).toHaveProperty('range', undefined);
  });

  it('delegates range parsing to R2 and serves the native returned slice', async () => {
    const { env, get } = setup(manifest, object('bc', { range: { offset: 1, length: 2 } }));
    const response = await handleRequest(
      request(downloadPath, { headers: { Range: 'bytes=1-2' } }),
      env,
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('bc');
    expect(response.headers.get('Content-Range')).toBe('bytes 1-2/5');
    expect(response.headers.get('Content-Length')).toBe('2');
    const options = get.mock.calls[1][1] as { range: Headers };
    expect(options.range.get('range')).toBe('bytes=1-2');
  });

  it('returns 200 when native R2 ignores an invalid range and returns the whole object', async () => {
    const { env } = setup(manifest, object('abcde', { range: { offset: 0, length: 5 } }));
    const response = await handleRequest(
      request(downloadPath, { headers: { Range: 'bytes=999-' } }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.has('Content-Range')).toBe(false);
    expect(await response.text()).toBe('abcde');
  });

  it('falls back to a full representation for If-Range instead of serving an unverified slice', async () => {
    const { env, get } = setup();
    const response = await handleRequest(
      request(downloadPath, {
        headers: { Range: 'bytes=1-2', 'If-Range': '"old-etag"' },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(get.mock.calls[1][1]).toHaveProperty('range', undefined);
  });

  it.each([
    [{ 'If-None-Match': '"installer-etag"' }, 304],
    [{ 'If-Modified-Since': 'Sun, 18 Oct 2026 00:00:00 GMT' }, 304],
    [{ 'If-Match': '"old-etag"' }, 412],
    [{ 'If-Unmodified-Since': 'Sat, 17 Oct 2026 00:00:00 GMT' }, 412],
  ] as const)('respects native R2 conditional results %#', async (headers, status) => {
    const { env } = setup(manifest, object(null));
    const response = await handleRequest(request(downloadPath, { headers }), env);
    expect(response.status).toBe(status);
    if (status === 304) expect(await response.text()).toBe('');
    if (status === 412) expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('uses R2 to distinguish mixed conditions without parsing HTTP ETag values', async () => {
    const { env, get } = setup(manifest, object(null));
    get.mockImplementationOnce(async () => ({
      size: 1000,
      json: async () => manifest,
      body: null,
    }));
    get.mockImplementationOnce(async () => object(null));
    get.mockImplementationOnce(async () => object());
    const response = await handleRequest(
      request(downloadPath, {
        headers: { 'If-Match': '"installer-etag"', 'If-None-Match': '"installer-etag"' },
      }),
      env,
    );
    expect(response.status).toBe(304);
    const options = get.mock.calls[2][1] as { onlyIf: Headers };
    expect(options.onlyIf.has('if-match')).toBe(true);
    expect(options.onlyIf.has('if-none-match')).toBe(false);
  });

  it('maps the native R2 InvalidRange code without implementing a range parser', async () => {
    const { env, get } = setup();
    get.mockImplementationOnce(async () => ({
      size: 1000,
      json: async () => manifest,
      body: null,
    }));
    get.mockRejectedValueOnce(new Error('get: The requested range is not satisfiable (10039)'));
    const response = await handleRequest(
      request(downloadPath, { headers: { Range: 'bytes=999-' } }),
      env,
    );
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */5');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns a non-cacheable error for a malformed manifest without exposing internals', async () => {
    const { env } = setup({ ...manifest, artifacts: [{ ...artifact, key: '../secret' }] });
    const response = await handleRequest(request('/api/releases'), env);
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).not.toContain('secret');
  });

  it('returns a non-cacheable error when R2 fails', async () => {
    const { env, get } = setup();
    get.mockRejectedValue(new Error('internal details'));
    const response = await handleRequest(request('/api/releases'), env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('internal details');
  });
});
