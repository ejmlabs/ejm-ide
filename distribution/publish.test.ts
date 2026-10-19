import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyReleaseManifest, parseReleaseManifest } from './manifest';
import { hashFile, publishRelease, stageArtifacts } from './publish';

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ejm-ide-publish-test-'));
  temporary.push(directory);
  const contents = 'local test fixture, never published';
  const filename = 'ejm-ide_0.1.0_aarch64.dmg';
  const sha256 = createHash('sha256').update(contents).digest('hex');
  await writeFile(join(directory, filename), contents);
  const manifest = parseReleaseManifest({
    schemaVersion: 1,
    version: '0.1.0',
    publishedAt: '2026-10-18T00:00:00Z',
    artifacts: [
      {
        target: 'darwin-aarch64',
        filename,
        key: `releases/0.1.0/${sha256}/${filename}`,
        bytes: Buffer.byteLength(contents),
        sha256,
      },
    ],
  });
  const snapshots = join(directory, 'snapshots');
  await mkdir(snapshots);
  return { directory, contents, filename, sha256, manifest, snapshots };
}

describe('release publisher verification', () => {
  it('hashes a private snapshot and returns its verified path', async () => {
    const value = await fixture();
    expect(await hashFile(join(value.directory, value.filename))).toEqual({
      bytes: Buffer.byteLength(value.contents),
      sha256: value.sha256,
    });
    const paths = await stageArtifacts(value.manifest, value.directory, value.snapshots);
    const snapshot = paths.get('darwin-aarch64');
    expect(snapshot).toBe(join(value.snapshots, `darwin-aarch64-${value.filename}`));
    expect(await hashFile(snapshot as string)).toEqual({
      bytes: Buffer.byteLength(value.contents),
      sha256: value.sha256,
    });
  });

  it('refuses changed installer bytes before uploading anything', async () => {
    const value = await fixture();
    await writeFile(join(value.directory, value.filename), 'changed');
    await expect(stageArtifacts(value.manifest, value.directory, value.snapshots)).rejects.toThrow(
      'does not match',
    );
  });

  it('refuses an empty release', async () => {
    const value = await fixture();
    await expect(
      stageArtifacts(emptyReleaseManifest(), value.directory, value.snapshots),
    ).rejects.toThrow('real release');
  });

  it('refuses a symbolic link outside the artifact directory', async () => {
    const value = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'ejm-ide-publish-outside-'));
    temporary.push(outside);
    const path = join(value.directory, value.filename);
    const source = join(outside, value.filename);
    await writeFile(source, value.contents);
    await rm(path);
    await symlink(source, path);
    await expect(stageArtifacts(value.manifest, value.directory, value.snapshots)).rejects.toThrow(
      'inside the artifact directory',
    );
  });
  it('uploads frozen validated bytes when the original installer changes before PUT', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const value = await fixture();
    const manifestPath = join(value.directory, 'release.json');
    await writeFile(manifestPath, JSON.stringify(value.manifest));
    const originalPath = join(value.directory, value.filename);
    const key = `ejmlabs-ide-releases/${value.manifest.artifacts[0].key}`;
    const remote = new Map<string, Buffer>([[key, Buffer.from(value.contents)]]);
    const changed = value.contents.replace('fixture', 'FIXTURE');
    const operations: string[] = [];
    let uploadedSnapshot: string | undefined;
    const run = vi.fn(async (args: string[]) => {
      const operation = args[2];
      const objectKey = args[3];
      const file = args[args.indexOf('--file') + 1];
      operations.push(`${operation}:${objectKey}`);
      if (operation === 'put') {
        if (objectKey === key) {
          // This is after all snapshot validation but before Wrangler reopens
          // its upload path, reproducing a concurrent native rebuild.
          await writeFile(originalPath, changed);
          uploadedSnapshot = file;
          expect(file).not.toBe(originalPath);
          expect(await readFile(file, 'utf8')).toBe(value.contents);
        }
        remote.set(objectKey, await readFile(file));
      } else if (operation === 'get') {
        const content = remote.get(objectKey);
        if (!content) throw new Error('Missing mock object.');
        await writeFile(file, content);
      }
    });
    await publishRelease(manifestPath, value.directory, true, run);
    expect(await readFile(originalPath, 'utf8')).toBe(changed);
    expect(remote.get(key)?.toString()).toBe(value.contents);
    expect(operations.at(-1)).toBe('put:ejmlabs-ide-releases/releases/latest.json');
    expect(remote.has('ejmlabs-ide-releases/releases/latest.json')).toBe(true);
    expect(uploadedSnapshot).toBeDefined();
    await expect(access(uploadedSnapshot as string)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('verifies every staged installer before any PUT and leaves latest untouched on mismatch', async () => {
    const value = await fixture();
    const filename = 'ejm-ide_0.1.0_x64.exe';
    const contents = 'second local fixture with unexpected bytes';
    await writeFile(join(value.directory, filename), contents);
    const sha256 = 'b'.repeat(64);
    const manifest = parseReleaseManifest({
      ...value.manifest,
      artifacts: [
        ...value.manifest.artifacts,
        {
          target: 'windows-x86_64',
          filename,
          key: `releases/0.1.0/${sha256}/${filename}`,
          bytes: Buffer.byteLength(contents),
          sha256,
        },
      ],
    });
    const manifestPath = join(value.directory, 'release.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    const run = vi.fn(async (_args: string[]) => {});
    await expect(publishRelease(manifestPath, value.directory, true, run)).rejects.toThrow(
      'does not match',
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('removes private snapshots after an upload failure without publishing latest', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const value = await fixture();
    const manifestPath = join(value.directory, 'release.json');
    await writeFile(manifestPath, JSON.stringify(value.manifest));
    let snapshot: string | undefined;
    const run = vi.fn(async (args: string[]) => {
      snapshot = args[args.indexOf('--file') + 1];
      throw new Error('Upload failed.');
    });
    await expect(publishRelease(manifestPath, value.directory, true, run)).rejects.toThrow(
      'Upload failed',
    );
    expect(run).toHaveBeenCalledOnce();
    expect(snapshot).toBeDefined();
    await expect(access(snapshot as string)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
