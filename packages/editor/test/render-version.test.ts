/**
 * The version a render takes (L7.5): 1 + the highest version of the scenario in renders/, at most RENDER_VERSION_MAX.
 * When a file already claims that version or more, a new render of that scenario is refused with the file's name and
 * nothing is reserved; two renders never get the same id. Files in a temp folder; nothing is planned or rendered.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY, RENDER_VERSION_MAX, errorKindOf, formatRenderId, isRenderId, renderLockName } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import { RenderError, nextVersion, renderVideo, reserveVersion, takenVersions, versionLockFile } from '../src/index.js';

const MAX = RENDER_VERSION_MAX;
let tmp: string;
let n = 0;

async function renders(...files: string[]): Promise<string> {
  const dir = join(tmp, `p${++n}`, 'renders');
  await mkdir(dir, { recursive: true });
  for (const f of files) await writeFile(join(dir, f), '');
  return dir;
}

const refusalOf = (file: string, digits: string, name = 'quote') =>
  `renders/ holds ${file}, which claims version ${digits} of ${name}: the highest version is 999999. Remove or rename that file, then render again.`;

/** One render: reserve, write the video under the version, release. The version, or the refusal's message. */
async function render(dir: string, name = 'quote'): Promise<number | string> {
  let r: Awaited<ReturnType<typeof reserveVersion>>;
  try {
    r = await reserveVersion(dir, name, 'a test');
  } catch (e) {
    return (e as Error).message;
  }
  await writeFile(join(dir, `${formatRenderId(name, r.version, 'landscape')}.mp4`), '');
  await r.release();
  return r.version;
}

/** The digits a file claims, as written: one below the bound, the bound, one above, 2^53, 20 digits, 22 digits. */
const CLAIMS = [String(MAX - 1), String(MAX), String(MAX + 1), '9007199254740992', '99999999999999999999', '9999999999999999999999'];
/** The four ways a file of renders/ takes a version. */
const FORMS: Array<(digits: string) => string> = [(d) => `quote-v${d}.json`, (d) => `quote-v${d}.mp4`, (d) => `.quote-v${d}.lock`, (d) => `quote-v${d}-vertical.mp4`];

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'retake-render-version-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('the version of a new render', () => {
  it('the bound is 999999, and a whole number a file name writes in digits', () => {
    expect(MAX).toBe(999_999);
    expect(Number.isSafeInteger(MAX + 1)).toBe(true);
    expect(String(MAX + 1)).toBe('1000000');
  });

  it('two renders in a row never get the same id: below the bound two versions, one below it one render then the refusal, at the bound or above the refusal at once', async () => {
    const below = await renders(`quote-v${MAX - 2}.json`);
    expect([await render(below), await render(below), await render(below)]).toEqual([MAX - 1, MAX, refusalOf(`quote-v${MAX}.mp4`, String(MAX))]);

    for (const digits of CLAIMS) {
      for (const form of FORMS) {
        const planted = form(digits);
        const dir = await renders(planted);
        const first = await render(dir);
        const second = await render(dir);
        if (digits === String(MAX - 1)) {
          expect([planted, first, second]).toEqual([planted, MAX, refusalOf(`quote-v${MAX}.mp4`, String(MAX))]);
        } else {
          expect([planted, first, second]).toEqual([planted, refusalOf(planted, digits), refusalOf(planted, digits)]);
        }
        // Never the same version twice, whatever the folder held.
        expect(typeof first === 'number' && first === second).toBe(false);
        // No name of the folder is written with an exponent, and every video written is a render id.
        const files = await readdir(dir);
        expect(files.filter((f) => f.includes('e+'))).toEqual([]);
        for (const f of files.filter((f) => f !== planted)) expect([f, isRenderId(f.replace(/\.mp4$/, ''))]).toEqual([f, true]);
      }
    }
  });

  it('the refusal names the file that claims the highest version, with its digits as written, and writes no lock', async () => {
    for (const planted of ['quote-v999999.json', 'quote-v0001000000.mp4', '.quote-v9007199254740992.lock', 'quote-v9999999999999999999999-square.json']) {
      const dir = await renders('quote-v3.mp4', planted, 'quote-v12.json', 'catalogue-v2.mp4');
      const before = (await readdir(dir)).sort();
      const digits = /-v(\d+)/.exec(planted)?.[1] ?? '';
      expect(() => nextVersion(dir, 'quote')).toThrow(refusalOf(planted, digits));
      await expect(reserveVersion(dir, 'quote', 'a test')).rejects.toThrow(refusalOf(planted, digits));
      expect((await readdir(dir)).sort()).toEqual(before);
    }
    // Two files that claim the same version: the first by name is the one named.
    const twins = await renders('quote-v1000000.mp4', 'quote-v1000000.json');
    expect(() => nextVersion(twins, 'quote')).toThrow(refusalOf('quote-v1000000.json', '1000000'));
    // The name is the scenario's as the caller wrote it.
    const other = await renders('My_Take-v999999-vertical.mp4');
    expect(() => nextVersion(other, 'My_Take')).toThrow(refusalOf('My_Take-v999999-vertical.mp4', '999999', 'My_Take'));
  });

  it('the refusal is a render error a client is told as invalid, never a reservation that ran out of tries', async () => {
    const dir = await renders('quote-v9007199254740992.json');
    let caught: unknown;
    try {
      await reserveVersion(dir, 'quote', 'a test');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RenderError);
    expect(errorKindOf(caught)).toBe('invalid');
    expect((caught as Error).message).not.toMatch(/could not reserve/);
  });

  it('a file of one scenario never blocks another scenario of the folder', async () => {
    const dir = await renders('quote-v9007199254740992.json', '.quote-v1000000.lock', 'catalogue-v4.mp4');
    expect(nextVersion(dir, 'catalogue')).toBe(5);
    expect([await render(dir, 'catalogue'), await render(dir, 'catalogue')]).toEqual([5, 6]);
    expect(nextVersion(dir, 'quote-v2')).toBe(1);
    expect(await render(dir)).toBe(refusalOf('quote-v9007199254740992.json', '9007199254740992'));
  });

  it('the versions taken are read as before: a file past the bound still counts, so it is never ignored', async () => {
    const dir = await renders('quote-v2.mp4', `quote-v${MAX}.json`, 'quote-v1000000.mp4', 'quote-v9007199254740993.json');
    expect(takenVersions(dir, 'quote')).toEqual([2, MAX, 1_000_000, 9007199254740992]);
    const free = await renders('quote-v2.mp4', `.quote-v${MAX - 1}.lock`);
    expect(takenVersions(free, 'quote')).toEqual([2, MAX - 1]);
    expect(nextVersion(free, 'quote')).toBe(MAX);
    expect(nextVersion(await renders(), 'quote')).toBe(1);
    expect(nextVersion(await renders('quote-v0.mp4'), 'quote')).toBe(1);
  });

  it('renders that start together near the bound: each version once, the others refused', async () => {
    const dir = await renders(`quote-v${MAX - 2}.mp4`);
    const got = await Promise.all(
      [1, 2, 3, 4].map(() =>
        reserveVersion(dir, 'quote', 'a test').then(
          (r) => r.version,
          (e: Error) => e.message,
        ),
      ),
    );
    expect(got.filter((v) => typeof v === 'number').sort()).toEqual([MAX - 1, MAX]);
    expect(got.filter((v) => typeof v === 'string')).toEqual([refusalOf(`.quote-v${MAX}.lock`, String(MAX)), refusalOf(`.quote-v${MAX}.lock`, String(MAX))]);
    expect((await readdir(dir)).sort()).toEqual([`.quote-v${MAX - 1}.lock`, `.quote-v${MAX}.lock`, `quote-v${MAX - 2}.mp4`]);
  });
});

describe('a render id, a lock name and a video name are written only for a version of the range', () => {
  const RANGE = 'a render version is a whole number from 0 to 999999, not ';

  it('formatRenderId, renderLockName and versionLockFile: 0 and the bound are written, anything else is a RangeError', () => {
    expect(formatRenderId('quote', MAX, 'landscape')).toBe('quote-v999999');
    expect(formatRenderId('quote', MAX, 'vertical')).toBe('quote-v999999-vertical');
    expect(formatRenderId('quote', 0, 'square')).toBe('quote-v0-square');
    expect(renderLockName('quote', MAX)).toBe('.quote-v999999.lock');
    expect(versionLockFile('/renders', 'quote', MAX)).toBe('/renders/.quote-v999999.lock');
    expect(versionLockFile('/renders', 'quote', 0)).toBe('/renders/.quote-v0.lock');
    for (const v of [MAX + 1, 1.5, -1, Number.NaN, 2 ** 53, 1e21, Number.POSITIVE_INFINITY]) {
      expect(() => formatRenderId('quote', v, 'landscape')).toThrow(new RangeError(RANGE + String(v)));
      expect(() => renderLockName('quote', v)).toThrow(new RangeError(RANGE + String(v)));
      expect(() => versionLockFile('/renders', 'quote', v)).toThrow(new RangeError(RANGE + String(v)));
    }
  });

  it('renderVideo: a reserved version outside the range is refused before anything is planned, read or removed', async () => {
    const dir = await renders('quote-v1.mp4');
    const project = { slug: 'p', dir: join(dir, '..'), root: tmp } as unknown as LoadedProject;
    const before = await readdir(dir);
    for (const version of [MAX + 1, 2 ** 53, 1e21, 1.5]) {
      const refused = renderVideo({ workPolicy: PERSON_POLICY, project, run: 'latest', reserved: { scenario: 'quote', version, variant: 'landscape' } });
      await expect(refused).rejects.toThrow(new RenderError(`the reserved render version of quote cannot be used: ${RANGE}${String(version)}`));
    }
    expect(await readdir(dir)).toEqual(before);
  });
});
