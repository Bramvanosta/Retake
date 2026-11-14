/**
 * The versions of a renders folder, on the Outputs port's renders (engine render/versions.ts; moved from the editor
 * with the render use case): which files of renders/ take a version, the next free one and its lock, and the bound —
 * a version is at most RENDER_VERSION_MAX: when a file already claims that version or more, a new render of that
 * scenario is refused with the file's name and nothing is reserved; two renders never get the same id. Files in a
 * temp folder through the disk's outputs; nothing is rendered (the render use case is refused before it plans).
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY, RENDER_VERSION_MAX, errorKindOf, formatRenderId, isRenderId, renderLockName } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import { RenderError } from '@retake/editor';
import { systemClock } from '../src/clock.js';
import { diskOutputs } from '../src/outputs/disk-outputs.js';
import { diskWorkspaceReads } from '../src/workspace-reads/disk-reads.js';
import { MemoryRenderer } from '../src/render/memory-renderer.js';
import { nextVersion, reserveVersion, takenVersions, versionLockFile } from '../src/render/versions.js';
import { renderWork } from '../src/render/work.js';

/** The renders of the disk's outputs: what the versions are read and reserved through. */
const R = diskOutputs.renders;

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
    r = await reserveVersion(R, dir, name, 'a test');
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
      await expect(nextVersion(R, dir, 'quote')).rejects.toThrow(refusalOf(planted, digits));
      await expect(reserveVersion(R, dir, 'quote', 'a test')).rejects.toThrow(refusalOf(planted, digits));
      expect((await readdir(dir)).sort()).toEqual(before);
    }
    // Two files that claim the same version: the first by name is the one named.
    const twins = await renders('quote-v1000000.mp4', 'quote-v1000000.json');
    await expect(nextVersion(R, twins, 'quote')).rejects.toThrow(refusalOf('quote-v1000000.json', '1000000'));
    // The name is the scenario's as the caller wrote it.
    const other = await renders('My_Take-v999999-vertical.mp4');
    await expect(nextVersion(R, other, 'My_Take')).rejects.toThrow(refusalOf('My_Take-v999999-vertical.mp4', '999999', 'My_Take'));
  });

  it('the refusal is a render error a client is told as invalid, never a reservation that ran out of tries', async () => {
    const dir = await renders('quote-v9007199254740992.json');
    let caught: unknown;
    try {
      await reserveVersion(R, dir, 'quote', 'a test');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RenderError);
    expect(errorKindOf(caught)).toBe('invalid');
    expect((caught as Error).message).not.toMatch(/could not reserve/);
  });

  it('a file of one scenario never blocks another scenario of the folder', async () => {
    const dir = await renders('quote-v9007199254740992.json', '.quote-v1000000.lock', 'catalogue-v4.mp4');
    expect(await nextVersion(R, dir, 'catalogue')).toBe(5);
    expect([await render(dir, 'catalogue'), await render(dir, 'catalogue')]).toEqual([5, 6]);
    expect(await nextVersion(R, dir, 'quote-v2')).toBe(1);
    expect(await render(dir)).toBe(refusalOf('quote-v9007199254740992.json', '9007199254740992'));
  });

  it('the versions taken are read as before: a file past the bound still counts, so it is never ignored', async () => {
    const dir = await renders('quote-v2.mp4', `quote-v${MAX}.json`, 'quote-v1000000.mp4', 'quote-v9007199254740993.json');
    expect(await takenVersions(R, dir, 'quote')).toEqual([2, MAX, 1_000_000, 9007199254740992]);
    const free = await renders('quote-v2.mp4', `.quote-v${MAX - 1}.lock`);
    expect(await takenVersions(R, free, 'quote')).toEqual([2, MAX - 1]);
    expect(await nextVersion(R, free, 'quote')).toBe(MAX);
    expect(await nextVersion(R, await renders(), 'quote')).toBe(1);
    expect(await nextVersion(R, await renders('quote-v0.mp4'), 'quote')).toBe(1);
  });

  it('renders that start together near the bound: each version once, the others refused', async () => {
    const dir = await renders(`quote-v${MAX - 2}.mp4`);
    const got = await Promise.all(
      [1, 2, 3, 4].map(() =>
        reserveVersion(R, dir, 'quote', 'a test').then(
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
      const refused = renderWork({
        workPolicy: PERSON_POLICY,
        project,
        run: 'latest',
        reserved: { scenario: 'quote', version, variant: 'landscape' },
        renderer: new MemoryRenderer(),
        ws: { outputs: diskOutputs, reads: diskWorkspaceReads },
        clock: systemClock,
      });
      await expect(refused).rejects.toThrow(new RenderError(`the reserved render version of quote cannot be used: ${RANGE}${String(version)}`));
    }
    expect(await readdir(dir)).toEqual(before);
  });
});

/** A project folder with an empty renders/ (these calls read renders/ only). */
async function project(): Promise<{ dir: string }> {
  const dir = join(tmp, `p${++n}`);
  await mkdir(join(dir, 'renders'), { recursive: true });
  return { dir };
}

const VERSION_FILES = [
  'quote-v2.mp4',
  '.quote-v3.lock',
  '.quote-v3.mp4',
  '.quote-v4.json',
  'quote-v5.lock',
  '.quote-v6-square.lock',
  'quote-v7-vertical.lock',
  'quote-v007.json',
  'quote-v4-square.json',
  'quote-v11-vertical.mp4',
  // not counted for quote:
  'Quote-v90.json',
  'quote-v2-v91.json',
  'xquote-v92.json',
  'quote-v93.webm',
  'quote-v94-tall.mp4',
  'quote-v95.json.tmp',
  'quote-v96-vertical-square.mp4',
  'quote-V97.mp4',
  'quote-v.mp4',
  'quote-v98.mp4\n',
  '..quote-v99.lock',
  'quote_-v100.mp4',
  'aXb-v1.json',
];

describe('the versions taken in renders/', () => {
  it('a version is taken by <name>-v<N>[-vertical|-square] with .mp4, .json or .lock, with or without a leading dot', async () => {
    const p = await project();
    const dir = join(p.dir, 'renders');
    for (const f of VERSION_FILES) await writeFile(join(dir, f), '');
    expect(await takenVersions(R, dir, 'quote')).toEqual([2, 3, 4, 5, 6, 7, 11]);
    expect(await nextVersion(R, dir, 'quote')).toBe(12);
    // The name is read as it is written: its "." is a dot, an upper-case letter is not its lower-case one.
    expect(await takenVersions(R, dir, 'a.b')).toEqual([]);
    expect(await takenVersions(R, dir, 'aXb')).toEqual([1]);
    expect(await takenVersions(R, dir, 'Quote')).toEqual([90]);
    expect(await takenVersions(R, dir, 'quote-v2')).toEqual([91]);
    expect(await takenVersions(R, dir, 'quote_')).toEqual([100]);
    expect(await takenVersions(R, dir, 'catalogue')).toEqual([]);
    expect(await nextVersion(R, dir, 'catalogue')).toBe(1);
    expect(await takenVersions(R, join(dir, 'missing'), 'quote')).toEqual([]);
  });

  it('the lock of a version is .<name>-v<N>.lock, whatever the variant', async () => {
    expect(versionLockFile('/renders', 'quote', 3)).toBe('/renders/.quote-v3.lock');
    expect(versionLockFile('/renders', 'Quote_2', 12)).toBe('/renders/.Quote_2-v12.lock');
    const p = await project();
    const dir = join(p.dir, 'renders');
    const r = await reserveVersion(R, dir, 'quote', 'a test');
    expect([r.version, await readdir(dir)]).toEqual([1, ['.quote-v1.lock']]);
    const second = await reserveVersion(R, dir, 'quote', 'a test');
    expect(second.version).toBe(2);
    await r.release();
    await second.release();
    expect(await readdir(dir)).toEqual([]);
  });

  /**
   * Two renders in a row on a folder holding `planted`: the version each got — or the refusal, as "refused: <file
   * named> <version it claims>" —, and the lock names seen while a version was held.
   */
  async function twoRenders(planted: string): Promise<{ versions: string[]; locks: string[] }> {
    const p = await project();
    const dir = join(p.dir, 'renders');
    await writeFile(join(dir, planted), '');
    const versions: string[] = [];
    const locks: string[] = [];
    for (let i = 0; i < 2; i++) {
      try {
        const r = await reserveVersion(R, dir, 'quote', 'a test');
        versions.push(String(r.version));
        locks.push(...(await readdir(dir)).filter((f) => f.endsWith('.lock') && f !== planted));
        await writeFile(join(dir, `quote-v${r.version}.mp4`), '');
        await r.release();
      } catch (e) {
        const m = /^renders\/ holds (\S+), which claims version (\d+) of quote: the highest version is 999999\. Remove or rename that file, then render again\.$/.exec((e as Error).message);
        versions.push(m ? `refused: ${m[1]} ${m[2]}` : `another error: ${(e as Error).message}`);
        locks.push(...(await readdir(dir)).filter((f) => f.endsWith('.lock') && f !== planted));
      }
    }
    return { versions, locks };
  }

  it('two renders in a row get two versions, each one above every file of the folder, up to version 999999', async () => {
    expect(await twoRenders('quote-v999997.json')).toEqual({ versions: ['999998', '999999'], locks: ['.quote-v999998.lock', '.quote-v999999.lock'] });
    // L7.5 G (the version bound): 999999 is the last version handed out; a file that claims it or more is named by the
    // refusal, and no lock is written.
    expect(await twoRenders('quote-v999998.json')).toEqual({ versions: ['999999', 'refused: quote-v999999.mp4 999999'], locks: ['.quote-v999999.lock'] }); // G
    expect(await twoRenders('quote-v999999.mp4')).toEqual({ versions: ['refused: quote-v999999.mp4 999999', 'refused: quote-v999999.mp4 999999'], locks: [] }); // G
    expect(await twoRenders('.quote-v1000000.lock')).toEqual({ versions: ['refused: .quote-v1000000.lock 1000000', 'refused: .quote-v1000000.lock 1000000'], locks: [] }); // G
    expect((await twoRenders('quote-v9007199254740990-vertical.mp4')).versions).toEqual([
      'refused: quote-v9007199254740990-vertical.mp4 9007199254740990',
      'refused: quote-v9007199254740990-vertical.mp4 9007199254740990',
    ]); // G
  });

  it('a file that claims a version past what a number holds is named with its digits as written, and nothing is reserved', async () => {
    // L7.5 G (the version bound): two renders never get the same version.
    expect(await twoRenders('quote-v9007199254740992.json')).toEqual({
      versions: ['refused: quote-v9007199254740992.json 9007199254740992', 'refused: quote-v9007199254740992.json 9007199254740992'],
      locks: [],
    }); // G
    expect((await twoRenders('quote-v9007199254740993.mp4')).versions).toEqual(['refused: quote-v9007199254740993.mp4 9007199254740993', 'refused: quote-v9007199254740993.mp4 9007199254740993']); // G
    expect((await twoRenders('.quote-v99999999999999999999.lock')).versions).toEqual([
      'refused: .quote-v99999999999999999999.lock 99999999999999999999',
      'refused: .quote-v99999999999999999999.lock 99999999999999999999',
    ]); // G
    expect(await twoRenders('quote-v9999999999999999999999-vertical.mp4')).toEqual({
      versions: ['refused: quote-v9999999999999999999999-vertical.mp4 9999999999999999999999', 'refused: quote-v9999999999999999999999-vertical.mp4 9999999999999999999999'],
      locks: [],
    }); // G
  });

  it('a file of one scenario never changes the versions of another', async () => {
    const p = await project();
    const dir = join(p.dir, 'renders');
    await writeFile(join(dir, 'quote-v9007199254740992.json'), '');
    expect(await nextVersion(R, dir, 'catalogue')).toBe(1);
    const r = await reserveVersion(R, dir, 'catalogue', 'a test');
    expect(r.version).toBe(1);
    await r.release();
  });
});

describe('render versions and records', () => {
  it('versions: next free N over mp4, json and locks of both variants; reservations never collide', async () => {
    const dir = join(tmp, 'renders');
    await mkdir(dir, { recursive: true });
    expect(await nextVersion(R, dir, 'quote')).toBe(1);
    for (const f of ['quote-v1.mp4', 'quote-v1.json', 'quote-v3-vertical.mp4', 'quote-extra-v9.mp4', 'catalogue-v7.mp4', '.quote-v4.lock']) await writeFile(join(dir, f), '');
    expect(await takenVersions(R, dir, 'quote')).toEqual([1, 3, 4]);
    expect(await nextVersion(R, dir, 'quote')).toBe(5);
    expect(await nextVersion(R, dir, 'catalogue')).toBe(8);
    const rs = await Promise.all([reserveVersion(R, dir, 'quote'), reserveVersion(R, dir, 'quote'), reserveVersion(R, dir, 'quote')]);
    expect(rs.map((r) => r.version).sort()).toEqual([5, 6, 7]);
    for (const r of rs) await r.release();
    expect(await nextVersion(R, dir, 'quote')).toBe(5);
    expect(await nextVersion(R, join(tmp, 'nope'), 'quote')).toBe(1);
  });
});
