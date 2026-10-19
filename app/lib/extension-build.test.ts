import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const driver = resolve(root, 'extension-template/host-build.mjs');

describe('fixed extension builder', () => {
  it('bundles the real React template with local CSS', async () => {
    const { stdout } = await exec(process.execPath, [
      driver,
      resolve(root, 'extension-template'),
      'panel.tsx',
    ]);
    const output = JSON.parse(stdout) as { code: string; css: string; files: number };
    expect(output.code.length).toBeGreaterThan(1_000);
    expect(output.css).toContain('--foreground');
    expect(output.files).toBeGreaterThan(2);
  });

  it('rejects native, network, parent-directory, and outside-symlink imports', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'workbench-extension-imports-'));
    try {
      const source = resolve(temporary, 'panel');
      await mkdir(source);
      await writeFile(resolve(temporary, 'outside.ts'), 'export default "private outside data";');
      await symlink(resolve(temporary, 'outside.ts'), resolve(source, 'linked.ts'));
      for (const imported of [
        'node:fs',
        'https://example.com/code.js',
        '../outside.ts',
        './linked.ts',
      ]) {
        await writeFile(
          resolve(source, 'panel.ts'),
          `import value from ${JSON.stringify(imported)}; console.log(value);`,
        );
        await expect(exec(process.execPath, [driver, source, 'panel.ts'])).rejects.toMatchObject({
          code: 1,
        });
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
