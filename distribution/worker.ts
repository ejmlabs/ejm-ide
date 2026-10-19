import {
  artifactContentType,
  emptyReleaseManifest,
  isReleaseTarget,
  parseReleaseManifest,
  type ReleaseArtifact,
  type ReleaseManifest,
  toPublicReleaseManifest,
} from './manifest';

export type DistributionEnv = Pick<Env, 'ASSETS' | 'RELEASES'>;

const manifestKey = 'releases/latest.json';
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

function json(request: Request, value: unknown, status = 200, headers?: HeadersInit): Response {
  const response = Response.json(value, {
    status,
    headers: { ...securityHeaders, 'Cache-Control': 'no-store', ...headers },
  });
  return request.method === 'HEAD' ? new Response(null, response) : response;
}

function unavailable(request: Request): Response {
  return json(
    request,
    {
      error: 'release_unavailable',
      message: 'Downloads are temporarily unavailable. Please retry.',
    },
    503,
    { 'Retry-After': '60' },
  );
}

async function readManifest(bucket: R2Bucket): Promise<ReleaseManifest> {
  const object = await bucket.get(manifestKey);
  if (!object) return emptyReleaseManifest();
  if (object.size > 65_536) {
    await object.body.cancel();
    throw new Error('Release manifest exceeds the supported size.');
  }
  return parseReleaseManifest(await object.json());
}

function conditionalHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  // HTTP gives entity tags precedence over dates. R2 parses the header values.
  if (headers.has('if-match')) headers.delete('if-unmodified-since');
  if (headers.has('if-none-match')) headers.delete('if-modified-since');
  return headers;
}

async function failedConditionStatus(
  bucket: R2Bucket,
  key: string,
  headers: Headers,
): Promise<number> {
  const negative = headers.has('if-none-match') || headers.has('if-modified-since');
  if (!negative) return 412;
  const positive = headers.has('if-match') || headers.has('if-unmodified-since');
  if (!positive) return 304;
  // R2 does not name the failed predicate. Ask its parser about the positive
  // conditions when both kinds were supplied, without reading any binary data.
  const positiveHeaders = new Headers(headers);
  positiveHeaders.delete('if-none-match');
  positiveHeaders.delete('if-modified-since');
  const object = await bucket.get(key, { onlyIf: positiveHeaders });
  if (!object || !('body' in object)) return 412;
  await object.body.cancel();
  return 304;
}

async function download(
  request: Request,
  bucket: R2Bucket,
  artifact: ReleaseArtifact,
): Promise<Response> {
  const conditions = conditionalHeaders(request);
  // R2 owns range parsing. If-Range is not an R2 condition, so those requests
  // safely receive the complete representation rather than an incorrect slice.
  const range =
    request.method === 'GET' && !request.headers.has('if-range') ? request.headers : undefined;
  let object: R2Object | R2ObjectBody | null;
  try {
    object = await bucket.get(artifact.key, { onlyIf: conditions, range });
  } catch (error) {
    // R2's InvalidRange error code. Malformed ranges may instead be ignored by
    // the native API, which is allowed by HTTP and returns a complete response.
    if (range?.has('range') && error instanceof Error && error.message.includes('10039')) {
      return json(
        request,
        { error: 'range_not_satisfiable', message: 'The requested download range is unavailable.' },
        416,
        { 'Content-Range': `bytes */${artifact.bytes}` },
      );
    }
    throw error;
  }
  if (!object) return unavailable(request);
  if (object.size !== artifact.bytes) {
    if ('body' in object) await object.body.cancel();
    return unavailable(request);
  }

  const headers = new Headers(securityHeaders);
  headers.set('Content-Type', artifactContentType(artifact.target, artifact.filename));
  headers.set('Content-Disposition', `attachment; filename="${artifact.filename}"`);
  headers.set('ETag', object.httpEtag);
  headers.set('Last-Modified', object.uploaded.toUTCString());
  headers.set('Accept-Ranges', 'bytes');
  // Query-bound digests keep cached release metadata tied to the same bytes.
  // Keep the short lifetime so removed release pointers stop being offered.
  headers.set('Cache-Control', 'public, max-age=60, s-maxage=60');

  if (!('body' in object)) {
    const status = await failedConditionStatus(bucket, artifact.key, conditions);
    if (status === 412) {
      return json(
        request,
        { error: 'precondition_failed', message: 'The download has changed. Please retry.' },
        status,
        { ETag: object.httpEtag },
      );
    }
    return new Response(null, { status, headers });
  }
  let status = 200;
  let bytes = object.size;
  if (range?.has('range') && object.range) {
    const offset = 'offset' in object.range ? object.range.offset : undefined;
    const length = 'length' in object.range ? object.range.length : undefined;
    if (typeof offset !== 'number' || typeof length !== 'number') {
      await object.body.cancel();
      return unavailable(request);
    }
    bytes = length;
    // R2 may normalize an unsupported or invalid range to the whole object.
    // Treat that as an ignored Range header, as HTTP permits.
    if (offset !== 0 || length !== object.size) {
      status = 206;
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    }
  }
  headers.set('Content-Length', String(bytes));
  if (request.method === 'HEAD') {
    await object.body.cancel();
    return new Response(null, { status, headers });
  }
  return new Response(object.body, { status, headers });
}

export async function handleRequest(request: Request, env: DistributionEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const api = path === '/api' || path.startsWith('/api/');
  const downloads = path === '/downloads' || path.startsWith('/downloads/');
  if (!api && !downloads) return env.ASSETS.fetch(request);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(request, { error: 'method_not_allowed', message: 'Use GET or HEAD.' }, 405, {
      Allow: 'GET, HEAD',
    });
  }
  if (
    path !== '/api/releases' &&
    !(downloads && isReleaseTarget(path.slice('/downloads/'.length)))
  ) {
    return json(request, { error: 'not_found', message: 'This route does not exist.' }, 404);
  }
  try {
    const manifest = await readManifest(env.RELEASES);
    if (path === '/api/releases') {
      return json(request, toPublicReleaseManifest(manifest), 200, {
        'Cache-Control': 'public, max-age=30, s-maxage=30',
      });
    }
    const target = path.slice('/downloads/'.length);
    const artifact = manifest.artifacts.find((entry) => entry.target === target);
    if (!artifact) {
      return json(
        request,
        { error: 'not_released', message: 'A download for this platform has not been released.' },
        404,
      );
    }
    if (url.search !== `?sha256=${artifact.sha256}`) {
      return json(
        request,
        {
          error: 'release_changed',
          message: 'This download link is missing or outdated. Refresh the page and try again.',
        },
        409,
      );
    }
    return await download(request, env.RELEASES, artifact);
  } catch {
    return unavailable(request);
  }
}

export default { fetch: handleRequest } satisfies ExportedHandler<DistributionEnv>;
