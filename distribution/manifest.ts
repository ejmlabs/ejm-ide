/** The release contract is shared by the website, Worker, and publisher. */
export const releaseTargets = [
  'darwin-aarch64',
  'darwin-x86_64',
  'windows-x86_64',
  'linux-x86_64',
] as const;

export type ReleaseTarget = (typeof releaseTargets)[number];

export interface ReleaseArtifact {
  target: ReleaseTarget;
  filename: string;
  key: string;
  bytes: number;
  sha256: string;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  version: string | null;
  publishedAt: string | null;
  sourceUrl?: string;
  artifacts: ReleaseArtifact[];
}

export interface PublicReleaseArtifact extends Omit<ReleaseArtifact, 'key'> {
  url: string;
}

export interface PublicReleaseManifest extends Omit<ReleaseManifest, 'artifacts'> {
  artifacts: PublicReleaseArtifact[];
}

export function emptyReleaseManifest(): ReleaseManifest {
  return { schemaVersion: 1, version: null, publishedAt: null, artifacts: [] };
}

export function isReleaseTarget(value: unknown): value is ReleaseTarget {
  return typeof value === 'string' && releaseTargets.some((target) => target === value);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Release data must be an object.');
  }
  return value as Record<string, unknown>;
}

function sourceUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('Source URL must be an HTTPS URL.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Source URL must be an HTTPS URL without credentials or a fragment.');
  }
  return url.href;
}

function releaseHeader(value: unknown) {
  const data = record(value);
  if (data.schemaVersion !== 1 || !Array.isArray(data.artifacts)) {
    throw new Error('Unsupported release manifest.');
  }
  const empty = data.artifacts.length === 0;
  if (empty ? data.version !== null || data.publishedAt !== null : false) {
    throw new Error('An empty release must have no version or publication date.');
  }
  if (
    !empty &&
    (typeof data.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9][a-zA-Z0-9.-]*)?$/.test(data.version) ||
      typeof data.publishedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(data.publishedAt) ||
      !Number.isFinite(Date.parse(data.publishedAt)) ||
      new Date(data.publishedAt).toISOString().replace('.000Z', 'Z') !==
        data.publishedAt.replace('.000Z', 'Z'))
  ) {
    throw new Error('Published releases need a safe version and a valid UTC publication date.');
  }
  const url = sourceUrl(data.sourceUrl);
  return {
    schemaVersion: 1 as const,
    version: data.version as string | null,
    publishedAt: data.publishedAt as string | null,
    ...(url ? { sourceUrl: url } : {}),
    artifacts: data.artifacts as unknown[],
  };
}

export function artifactContentType(target: ReleaseTarget, filename: string): string {
  if (target.startsWith('darwin-') && filename.endsWith('.dmg')) {
    return 'application/x-apple-diskimage';
  }
  if (target === 'windows-x86_64') {
    if (filename.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
    if (filename.endsWith('.msi')) return 'application/x-msi';
  }
  if (target === 'linux-x86_64') {
    if (filename.endsWith('.AppImage')) return 'application/vnd.appimage';
    if (filename.endsWith('.deb')) return 'application/vnd.debian.binary-package';
    if (filename.endsWith('.rpm')) return 'application/x-rpm';
  }
  throw new Error('Release artifact must be a supported platform installer.');
}

function artifactFields(value: unknown): Omit<ReleaseArtifact, 'key'> {
  const data = record(value);
  if (!isReleaseTarget(data.target)) throw new Error('Unknown release target.');
  if (
    typeof data.filename !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,159}$/.test(data.filename) ||
    data.filename.includes('..') ||
    /(?:^|[-_.])debug(?:[-_.]|$)/i.test(data.filename)
  ) {
    throw new Error('Release filenames must be safe installer basenames without debug markers.');
  }
  artifactContentType(data.target, data.filename);
  if (!Number.isSafeInteger(data.bytes) || (data.bytes as number) <= 0) {
    throw new Error('Release artifacts must have a positive byte count.');
  }
  if (typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256)) {
    throw new Error('Release artifacts must have a lowercase SHA-256 digest.');
  }
  return {
    target: data.target,
    filename: data.filename,
    bytes: data.bytes as number,
    sha256: data.sha256,
  };
}

function uniqueTargets(artifacts: { target: ReleaseTarget }[]): void {
  if (new Set(artifacts.map((artifact) => artifact.target)).size !== artifacts.length) {
    throw new Error('Each release target may appear only once.');
  }
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const header = releaseHeader(value);
  const artifacts = header.artifacts.map((value) => {
    const data = record(value);
    const artifact = artifactFields(data);
    const expectedKey = `releases/${header.version}/${artifact.sha256}/${artifact.filename}`;
    if (data.key !== expectedKey) throw new Error('Release artifact key is not canonical.');
    return { ...artifact, key: expectedKey };
  });
  uniqueTargets(artifacts);
  if (new Set(artifacts.map((artifact) => artifact.key)).size !== artifacts.length) {
    throw new Error('Release artifact keys must be unique.');
  }
  return { ...header, artifacts };
}

export function toPublicReleaseManifest(manifest: ReleaseManifest): PublicReleaseManifest {
  return {
    ...manifest,
    artifacts: manifest.artifacts.map(({ key: _key, ...artifact }) => ({
      ...artifact,
      url: `/downloads/${artifact.target}?sha256=${artifact.sha256}`,
    })),
  };
}

export function parsePublicReleaseManifest(value: unknown): PublicReleaseManifest {
  const header = releaseHeader(value);
  const artifacts = header.artifacts.map((value) => {
    const data = record(value);
    const artifact = artifactFields(data);
    const url = `/downloads/${artifact.target}?sha256=${artifact.sha256}`;
    if (data.url !== url) throw new Error('Release download URL is not canonical.');
    return { ...artifact, url };
  });
  uniqueTargets(artifacts);
  return { ...header, artifacts };
}
