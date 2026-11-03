/**
 * The built entry point (`dist/bin.js`) must tell an old Node.js which version it needs instead of failing with a bare
 * SyntaxError (R-MAC-03): no ESM syntax or post-ES2017 syntax may reach the version check. Runs on the build output
 * (`pnpm build` first). RETAKE_TEST_OLD_NODE=/path/to/node (e.g. a Node.js 10) also runs it on that Node.js.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin.js');
const built = existsSync(BIN);

function run(node: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(node, args, { timeout: 30_000 }, (e, out, err) => resolve({ code: e ? Number(e.code ?? 1) : 0, out, err }));
  });
}

describe.skipIf(!built)('dist/bin.js on any Node.js (R-MAC-03)', () => {
  it('has no ESM or post-ES2017 syntax: an old Node.js reads it up to the version check', () => {
    const src = readFileSync(BIN, 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    expect(src).not.toMatch(/^\s*(import|export)\b/m);
    expect(src).not.toMatch(/import\.meta|\?\.|\?\?|^await\b/m);
    expect(src).toContain("new Function('url', 'return import(url)')");
  });

  it('refuses a Node.js older than 22 with the version it needs; loads the CLI on 22+', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'retake-bin-'));
    try {
      const old = join(dir, 'old-node.cjs');
      await writeFile(old, "Object.defineProperty(process.versions, 'node', { value: '18.19.0' });\n");
      const r = await run(process.execPath, ['-r', old, BIN, '--version']);
      expect(r.code).toBe(1);
      expect(r.err).toContain('retake needs Node.js 22 or later; this is v18.19.0');
      expect(r.out).toBe('');
      const ok = await run(process.execPath, [BIN, '--version']);
      expect(ok.code, ok.err).toBe(0);
      expect(ok.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('loads the CLI through a symbolic link to bin.js (ln -s …/dist/bin.js ~/.local/bin/studio)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'retake-bin-'));
    try {
      const link = join(dir, 'studio');
      await symlink(BIN, link);
      const r = await run(process.execPath, [link, '--version']);
      expect(r.code, r.err).toBe(0);
      expect(r.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!process.env.RETAKE_TEST_OLD_NODE)('a real old Node.js prints the message (RETAKE_TEST_OLD_NODE)', async () => {
    const r = await run(process.env.RETAKE_TEST_OLD_NODE!, [BIN, '--version']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^retake needs Node\.js 22 or later; this is v\d+/);
  });
});
