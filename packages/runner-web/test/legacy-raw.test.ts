/**
 * old-name: this whole file (the guard test allows it).
 *
 * L5.13 (D0): a raw package exported before the rename (manifest kind `demo-studio/raw-capture`) is still a raw
 * package — a new export to its folder replaces it; a folder holding anything else is still refused.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertReplaceable } from '../src/index.js';

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'retake-legacy-raw-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function folder(name: string, manifest: object | null): Promise<string> {
  const dir = join(tmp, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'clip-01.mp4'), 'x');
  if (manifest) await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

describe('replacing a raw package', () => {
  it('an earlier package of either name is replaced; anything else is refused', async () => {
    await expect(assertReplaceable(await folder('old', { version: 1, kind: 'demo-studio/raw-capture' }))).resolves.toBeUndefined();
    await expect(assertReplaceable(await folder('new', { version: 1, kind: 'retake/raw-capture' }))).resolves.toBeUndefined();
    const other = await folder('other', { kind: 'someone-else/package' });
    await expect(assertReplaceable(other)).rejects.toThrow(`${other} already holds other files (it is not a raw package): choose another --out — it would be replaced`);
    await expect(assertReplaceable(await folder('plain', null))).rejects.toThrow(/not a raw package/);
  });
});
