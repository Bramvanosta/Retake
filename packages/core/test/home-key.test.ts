/**
 * L5.14 review A L2: the Retake home's signing key is made whole before it appears — several processes making it at
 * once all read one key (never a partial one, never an error) — and its folder is closed to others (an existing 0755
 * home included).
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homeKey } from '../src/index.js';

const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url));
let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'retake-home-key-'));
});
afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

/** A process that waits for `at`, then makes (or reads) the key of each file in turn and prints them. */
const CHILD = `const [dist, at, ...files] = process.argv.slice(1);
import(dist).then(async ({ homeKey }) => {
  while (Date.now() < Number(at)) {}
  const out = [];
  for (const f of files) {
    try { out.push((await homeKey(f)).toString('hex')); } catch (e) { out.push('error: ' + e.message); }
  }
  process.stdout.write(JSON.stringify(out));
});`;

function child(at: number, files: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', CHILD, DIST, String(at), ...files], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', () => {
      try {
        resolve(JSON.parse(out) as string[]);
      } catch (e) {
        reject(e);
      }
    });
  });
}

describe('the home key (review A L2)', () => {
  it('several processes making it at once all get the same whole key, round after round', async () => {
    const rounds = 40;
    const files = Array.from({ length: rounds }, (_, i) => join(base, `race-${i}`, 'approvals.key'));
    const at = Date.now() + 1500;
    const outs = await Promise.all(Array.from({ length: 6 }, () => child(at, files)));
    for (let i = 0; i < rounds; i++) {
      const keys = new Set(outs.map((o) => o[i]));
      expect([...keys], `round ${i}`).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
      expect(keys.has((await homeKey(files[i]!)).toString('hex'))).toBe(true);
      // No temporary file left beside it.
      expect(await readdir(join(base, `race-${i}`))).toEqual(['approvals.key']);
    }
  }, 60_000);

  it('the key is 0600; an existing home folder open to others is closed (0700) when the key is made', async () => {
    const home = join(base, 'open-home');
    await mkdir(home, { mode: 0o755 });
    expect((await stat(home)).mode & 0o777).toBe(0o755);
    await homeKey(join(home, 'approvals.key'));
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, 'approvals.key'))).mode & 0o777).toBe(0o600);
  });
});
