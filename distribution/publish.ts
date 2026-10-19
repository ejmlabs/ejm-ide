import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL as NodeURL, pathToFileURL } from 'node:url';
import { artifactContentType, parseReleaseManifest, type ReleaseManifest } from './manifest.ts';

const bucket = 'ejmlabs-ide-releases';
const configPath = fileURLToPath(new NodeURL('./wrangler.jsonc', import.meta.url));

export async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

export async function stageArtifacts(
  manifest: ReleaseManifest,
  artifactDirectory: string,
  stagingDirectory: string,
): Promise<Map<string, string>> {
  if (!manifest.version || manifest.artifacts.length === 0) {
    throw new Error('Publishing requires a real release with at least one platform installer.');
  }
  const directory = await realpath(artifactDirectory);
  const paths = new Map<string, string>();
  for (const artifact of manifest.artifacts) {
    const path = await realpath(join(directory, artifact.filename));
    if (dirname(path) !== directory || !(await stat(path)).isFile()) {
      throw new Error(
        `Artifact must be a file inside the artifact directory: ${artifact.filename}`,
      );
    }
    // The source may be rebuilt while publishing. Hash and upload a private
    // copy, so Wrangler never reopens the mutable source path after validation.
    const snapshot = join(stagingDirectory, `${artifact.target}-${artifact.filename}`);
    await copyFile(path, snapshot, constants.COPYFILE_EXCL);
    await chmod(snapshot, 0o400);
    const actual = await hashFile(snapshot);
    if (actual.bytes !== artifact.bytes || actual.sha256 !== artifact.sha256) {
      throw new Error(`Artifact size or SHA-256 does not match the manifest: ${artifact.filename}`);
    }
    paths.set(artifact.target, snapshot);
  }
  return paths;
}

async function wrangler(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('wrangler', [...args, '--config', configPath], {
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Wrangler exited with status ${code ?? 'unknown'}.`));
    });
  });
}

export async function publishRelease(
  manifestPath: string,
  artifactDirectory: string,
  publish: boolean,
  runWrangler: (args: string[]) => Promise<void> = wrangler,
): Promise<void> {
  const manifest = parseReleaseManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const temporary = await mkdtemp(join(tmpdir(), 'ide-release-'));
  try {
    const snapshots = join(temporary, 'installers');
    await mkdir(snapshots, { mode: 0o700 });
    const paths = await stageArtifacts(manifest, artifactDirectory, snapshots);
    const content = `${JSON.stringify(manifest, null, 2)}\n`;
    const digest = createHash('sha256').update(content).digest('hex');
    const archiveKey = `releases/${manifest.version}/manifest-${digest}.json`;
    console.info(`Verified ${manifest.artifacts.length} installer(s) for ide ${manifest.version}.`);
    console.info(`Manifest archive: ${archiveKey}`);
    if (!publish) {
      console.info(
        'Dry run complete. Pass --publish to upload and verify installers, then publish latest.',
      );
      return;
    }

    for (const artifact of manifest.artifacts) {
      const path = paths.get(artifact.target);
      if (!path) throw new Error(`Verified artifact is missing: ${artifact.filename}`);
      await runWrangler([
        'r2',
        'object',
        'put',
        `${bucket}/${artifact.key}`,
        '--remote',
        '--file',
        path,
        '--content-type',
        artifactContentType(artifact.target, artifact.filename),
        '--content-disposition',
        `attachment; filename="${artifact.filename}"`,
        '--cache-control',
        'public, max-age=31536000, immutable',
      ]);
      const downloaded = join(temporary, artifact.filename);
      await runWrangler([
        'r2',
        'object',
        'get',
        `${bucket}/${artifact.key}`,
        '--remote',
        '--file',
        downloaded,
      ]);
      const actual = await hashFile(downloaded);
      if (actual.bytes !== artifact.bytes || actual.sha256 !== artifact.sha256) {
        throw new Error(`Uploaded artifact failed verification: ${artifact.filename}`);
      }
      await rm(downloaded);
    }
    const file = join(temporary, 'manifest.json');
    await writeFile(file, content, { encoding: 'utf8', mode: 0o400 });
    for (const key of [archiveKey, 'releases/latest.json']) {
      await runWrangler([
        'r2',
        'object',
        'put',
        `${bucket}/${key}`,
        '--remote',
        '--file',
        file,
        '--content-type',
        'application/json',
        '--cache-control',
        key === 'releases/latest.json' ? 'no-cache' : 'public, max-age=31536000, immutable',
      ]);
    }
    console.info(`Published ide ${manifest.version}.`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main(args: string[]): Promise<void> {
  const publish = args.includes('--publish');
  const positional = args.filter((arg) => arg !== '--publish');
  if (positional.length !== 2 || positional.some((arg) => arg.startsWith('--'))) {
    throw new Error(
      'Usage: node distribution/publish.ts MANIFEST.json ARTIFACT_DIRECTORY [--publish]',
    );
  }
  await publishRelease(resolve(positional[0]), resolve(positional[1]), publish);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Release publication failed.');
    process.exitCode = 1;
  });
}
