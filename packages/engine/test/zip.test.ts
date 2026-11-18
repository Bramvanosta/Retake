import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { crc32, deflateRawSync } from 'node:zlib';
import { archiveNameProblem, foldedArchiveKey } from '@retake/core/base';
import { centralHeaderOf, craftZip, eocdOf, extraField, zip64Field } from '@retake/test-support/zip-craft';
import type { CraftEntry, CraftOptions } from '@retake/test-support/zip-craft';
import { createZip } from '../src/archive/zip-write.js';
import { CENTRAL_HEADER_MAX, openZip } from '../src/archive/zip-read.js';
import type { ZipArchive } from '../src/archive/zip-read.js';

const dir = mkdtempSync(join(tmpdir(), 'retake-zip-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = (ext = '.zip') => join(dir, `f${++n}${ext}`);
const T = new Date(2026, 10, 18, 12, 30, 10);

async function readEverything(a: ZipArchive): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  for (const e of a.entries) out[e.name] = await a.readAll(e, 1 << 30);
  return out;
}

/** The refusal an archive's open (or, when it opens, the read of every entry) ends with. */
async function refusal(bytes: Buffer, limits?: Parameters<typeof openZip>[1]): Promise<string> {
  const file = fresh();
  writeFileSync(file, bytes);
  let a: ZipArchive;
  try {
    a = await openZip(file, limits);
  } catch (e) {
    return (e as Error).message;
  }
  try {
    await readEverything(a);
  } catch (e) {
    return (e as Error).message;
  } finally {
    await a.close();
  }
  return 'opened';
}

const plain = (name: string, data = 'x', more: Partial<CraftEntry> = {}): CraftEntry => ({ name, data: Buffer.from(data), ...more });
const crafted = (entries: CraftEntry[], o?: CraftOptions) => craftZip(entries, o);

describe('archive names', () => {
  it('takes plain relative names and refuses every other shape', () => {
    expect(archiveNameProblem('project/scenarios/quote.yaml')).toBeUndefined();
    expect(archiveNameProblem('project/é.txt')).toBeUndefined();
    expect(archiveNameProblem('project/', { dir: true })).toBeUndefined();
    const refused = [
      '',
      '/x',
      'C:x',
      'a\\b',
      'a\u0000b',
      'a\u200bb',
      'a\u202eb',
      'a\u0007',
      'a\u0085',
      '../x',
      'a/./b',
      'a//b',
      'a/',
      'a.',
      'a /b',
      `${'x'.repeat(256)}`,
      `${'a/'.repeat(32)}a`,
      'x'.repeat(1025),
    ];
    for (const name of refused) expect(archiveNameProblem(name), JSON.stringify(name)).toBeDefined();
    expect(archiveNameProblem('a', { dir: true })).toMatch(/trailing/);
  });
  it('folds case and normal forms into one key', () => {
    expect(foldedArchiveKey('A.txt')).toBe(foldedArchiveKey('a.TXT'));
    expect(foldedArchiveKey('caf\u00e9')).toBe(foldedArchiveKey('cafe\u0301'));
  });
});

describe('the ZIP writer and reader', () => {
  it('round-trips stored and deflated entries, an empty one, a UTF-8 name, an executable, from files and bytes', async () => {
    const src = fresh('.txt');
    writeFileSync(src, 'hello '.repeat(5000));
    const png = fresh('.png');
    writeFileSync(png, Buffer.from([1, 2, 3, 4]));
    const empty = fresh('.txt');
    writeFileSync(empty, '');
    const file = fresh();
    const w = await createZip(file);
    const a1 = await w.add('project/a.txt', { file: src }, { mode: 0o644, mtime: T });
    await w.add('project/b.png', { file: png }, { mode: 0o644, mtime: T });
    await w.add('project/c.txt', { file: empty }, { mode: 0o644, mtime: T });
    await w.add('project/hooks/run.sh', { data: Buffer.from('#!/bin/sh\necho hi\n') }, { mode: 0o755, mtime: T });
    await w.add('project/z\u00e9.txt', { data: Buffer.alloc(0) }, { mode: 0o644, mtime: T });
    const done = await w.close();
    expect(done.entries).toBe(5);
    expect(a1.size).toBe(30000);
    const a = await openZip(file);
    const byName = Object.fromEntries(a.entries.map((e) => [e.name, e]));
    expect(byName['project/a.txt']!.method).toBe(8);
    expect(byName['project/a.txt']!.compressedSize).toBeLessThan(30000);
    expect(byName['project/b.png']!.method).toBe(0);
    expect(byName['project/hooks/run.sh']!.mode).toBe(0o755);
    expect(byName['project/a.txt']!.mode).toBe(0o644);
    expect(byName['project/a.txt']!.mtime.getTime()).toBe(T.getTime());
    const all = await readEverything(a);
    expect(all['project/a.txt']!.toString()).toBe('hello '.repeat(5000));
    expect([...all['project/b.png']!]).toEqual([1, 2, 3, 4]);
    expect(all['project/c.txt']!.length).toBe(0);
    expect(all['project/z\u00e9.txt']!.length).toBe(0);
    await a.close();
  });

  it('writes and reads every ZIP64 field (zip64: always)', async () => {
    const file = fresh();
    const w = await createZip(file, { zip64: 'always' });
    await w.add('a.txt', { data: Buffer.from('one '.repeat(100)) }, { mode: 0o644, mtime: T });
    const src = fresh('.txt');
    writeFileSync(src, 'two');
    await w.add('b.txt', { file: src }, { mode: 0o644, mtime: T });
    await w.close();
    const bytes = readFileSync(file);
    expect(bytes.readUInt32LE(bytes.length - 22 - 20)).toBe(0x07064b50);
    const a = await openZip(file);
    expect((await readEverything(a))['b.txt']!.toString()).toBe('two');
    await a.close();
  });

  it('writes the ZIP64 end records for exactly 65 535 entries (the count sentinel itself) and reads them back', async () => {
    const file = fresh();
    const w = await createZip(file);
    const names = Array.from({ length: 0xffff }, (_, i) => `f/${String(i).padStart(6, '0')}`);
    for (const name of names) await w.add(name, { data: Buffer.alloc(0) }, { mode: 0o644, mtime: T });
    await w.close();
    const bytes = readFileSync(file);
    expect(bytes.readUInt16LE(bytes.length - 22 + 10)).toBe(0xffff);
    const a = await openZip(file);
    expect(a.entries.length).toBe(0xffff);
    await a.close();
  }, 60_000);

  it('refuses names out of order, a bad name, and a file that changes while it is read', async () => {
    const file = fresh();
    const w = await createZip(file);
    await w.add('b', { data: Buffer.from('1') }, { mode: 0o644, mtime: T });
    await expect(w.add('a', { data: Buffer.from('1') }, { mode: 0o644, mtime: T })).rejects.toThrow(/ascending/);
    await expect(w.add('c/../d', { data: Buffer.from('1') }, { mode: 0o644, mtime: T })).rejects.toThrow(/cannot be named/);
    const big = fresh('.txt');
    writeFileSync(big, Buffer.alloc(32 * 1024 * 1024, 1));
    const p = w.add('c.txt', { file: big }, { mode: 0o644, mtime: T });
    // Grown once its header is written (its size was read), while its bytes are being streamed.
    while (statSync(file).size < 40) await new Promise((r) => setImmediate(r));
    appendFileSync(big, Buffer.alloc(1024 * 1024, 2));
    await expect(p).rejects.toThrow(/changed while it was archived/);
    await expect(w.close()).rejects.toThrow(/abort/);
    await w.abort();
  });

  it('never writes over a file', async () => {
    const file = fresh();
    writeFileSync(file, 'mine');
    await expect(createZip(file)).rejects.toThrow(/EEXIST/);
    expect(readFileSync(file, 'utf8')).toBe('mine');
  });
});

describe('the ZIP reader refuses what our writer never writes', () => {
  it('opens a plain crafted archive (the craft itself is sound)', async () => {
    expect(await refusal(crafted([plain('a'), plain('b', 'yy', { deflate: true })]))).toBe('opened');
  });

  const names: Array<[string, string | Buffer, RegExp]> = [
    ['a climbing name', '../x', /"\.\." segment/],
    ['an absolute name', '/x', /absolute/],
    ['a drive letter', 'C:x', /drive letter/],
    ['a backslash', 'a\\b', /backslash/],
    ['a NUL', 'a\u0000b', /NUL/],
    ['a zero-width character', 'a\u200bb', /invisible/],
    ['a name that is not UTF-8', Buffer.from([0x61, 0xff, 0x62]), /not UTF-8/],
  ];
  for (const [what, name, re] of names) {
    it(`refuses ${what}`, async () => {
      expect(await refusal(crafted([plain(name as string)]))).toMatch(re);
    });
  }

  it('refuses duplicates: the same name, two cases, two normal forms, a file and a folder, a file used as a folder', async () => {
    expect(await refusal(crafted([plain('a'), plain('a')]))).toMatch(/two entries of one name/);
    expect(await refusal(crafted([plain('A'), plain('a')]))).toMatch(/two entries of one name/);
    expect(await refusal(crafted([plain('caf\u00e9'), plain('cafe\u0301')]))).toMatch(/two entries of one name/);
    expect(await refusal(crafted([plain('a/', '', { mode: 0o040755 }), plain('A')]))).toMatch(/two entries of one name/);
    expect(await refusal(crafted([plain('a'), plain('A/b')]))).toMatch(/folder that is a file/);
  });

  it('refuses links, devices and other permissions; takes a folder', async () => {
    expect(await refusal(crafted([plain('l', 'target', { mode: 0o120777 })]))).toMatch(/not a plain file/);
    expect(await refusal(crafted([plain('d', '', { mode: 0o020644 })]))).toMatch(/not a plain file/);
    expect(await refusal(crafted([plain('s', 'x', { mode: 0o104755 })]))).toMatch(/permissions/);
    expect(await refusal(crafted([plain('a/', '', { mode: 0o040755 }), plain('a/b')]))).toBe('opened');
    expect(await refusal(crafted([plain('x', 'x', { madeBy: 20 })]))).toMatch(/not made on Unix/);
  });

  it('refuses encryption, a data descriptor, a name not marked UTF-8, a newer version, another method', async () => {
    expect(await refusal(crafted([plain('a', 'x', { flags: 0x0801 })]))).toMatch(/flags/);
    expect(await refusal(crafted([plain('a', 'x', { flags: 0x0808 })]))).toMatch(/flags/);
    expect(await refusal(crafted([plain('a', 'x', { flags: 0 })]))).toMatch(/flags/);
    expect(await refusal(crafted([plain('a', 'x', { version: 63 })]))).toMatch(/newer ZIP reader/);
    expect(await refusal(crafted([plain('a', 'x', { method: 12 })]))).toMatch(/compression method/);
    expect(await refusal(crafted([plain('a', 'xy', { size: 5 })]))).toMatch(/stored with two sizes/);
  });

  it('refuses an extra field other than ZIP64, and a ZIP64 field of the wrong length', async () => {
    const unicodePath = extraField(0x7075, Buffer.concat([Buffer.from([1, 0, 0, 0, 0]), Buffer.from('evil')]));
    expect(await refusal(crafted([plain('a', 'x', { centralExtra: unicodePath })]))).toMatch(/0x7075/);
    expect(await refusal(crafted([plain('a', 'x', { localExtra: unicodePath })]))).toMatch(/extra field/);
    expect(await refusal(crafted([plain('a', 'x', { size: 0xffffffff, centralExtra: zip64Field([1, 1]) })]))).toMatch(/ZIP64 field whose length/);
  });

  it('refuses a gap, an overlap, prepended bytes, trailing bytes, a comment and a misplaced directory', async () => {
    expect(await refusal(crafted([plain('a', 'x', { gapAfter: Buffer.from('zz') }), plain('b')]))).toMatch(/does not start where the previous entry ends/);
    expect(await refusal(crafted([plain('a'), plain('b', 'x', { offset: 0 })]))).toMatch(/does not start where the previous entry ends/);
    expect(await refusal(crafted([plain('a')], { prefix: Buffer.from('MZ') }))).toMatch(/does not start where the previous entry ends/);
    expect(await refusal(crafted([plain('a')], { trailing: Buffer.from('junk') }))).toMatch(/does not end with a ZIP end record/);
    expect(await refusal(crafted([plain('a')], { comment: Buffer.from('hi') }))).toMatch(/does not end with a ZIP end record/);
    expect(await refusal(crafted([plain('a', 'x', { gapAfter: Buffer.from('zz') })]))).toMatch(/does not follow its last entry/);
    expect(await refusal(crafted([plain('a'), plain('b')], { count: 1 }))).toMatch(/holds more than its entries/);
  });

  it('reads a crafted ZIP64 end and refuses one out of place', async () => {
    expect(await refusal(crafted([plain('a')], { zip64End: true }))).toBe('opened');
    const b = crafted([plain('a')], { zip64End: true });
    b.writeUInt32LE(0, b.length - 22 - 20); // the locator's signature gone
    expect(await refusal(b)).toMatch(/ZIP64 locator/);
  });

  it('refuses a local header that differs from its central one', async () => {
    expect(await refusal(crafted([plain('a', 'x', { localName: 'b' })]))).toMatch(/differs from its central one/);
    expect(await refusal(crafted([plain('a', 'xy', { localSize: 1, localCompressedSize: 1 })]))).toMatch(/differs from its central one|stored/);
    expect(await refusal(crafted([plain('a', 'x', { localFlags: 0x0800 | 0x0008 })]))).toMatch(/flags/);
  });

  it('refuses a bomb, a truncated entry and a bad checksum while reading', async () => {
    const big = Buffer.alloc(1024 * 1024, 0x61);
    expect(await refusal(crafted([{ name: 'a', data: big, deflate: true, size: 1024, crc32: crc32(big.subarray(0, 1024)) }]))).toMatch(/inflates past its declared size/);
    const small = Buffer.from('hello world');
    expect(await refusal(crafted([{ name: 'a', data: small, deflate: true, size: 100 }]))).toMatch(/truncated/);
    expect(await refusal(crafted([plain('a', 'hello', { crc32: 1 })]))).toMatch(/checksum/);
    expect(await refusal(crafted([{ name: 'a', body: Buffer.from([0xff, 0xff, 0xff]), method: 8, size: 3 }]))).toMatch(/damaged compressed data/);
  });

  it('refuses entries over the limits: count, size, total, ratio', async () => {
    expect(await refusal(crafted([plain('a'), plain('b')]), { entries: 1 })).toMatch(/more than 1 entries/);
    expect(await refusal(crafted([plain('a', 'xyz')]), { entryMax: () => 2 })).toMatch(/larger than an entry may be/);
    expect(await refusal(crafted([plain('a', 'xyz'), plain('b', 'xyz')]), { totalMax: 5 })).toMatch(/more than 5 bytes/);
    const data = Buffer.alloc(20 * 1024 * 1024);
    const body = deflateRawSync(data);
    expect(body.length * 1000).toBeLessThan(data.length);
    expect(await refusal(crafted([{ name: 'a', body, method: 8, size: data.length, crc32: crc32(data) }]))).toMatch(/inflates more than 1000 times/);
  });
});

describe('the writer and the reader keep one rule', () => {
  it('a 20 MB file of zeros, past the bomb ratio once deflated, is stored: the export round-trips through the import', async () => {
    const src = fresh('.bin');
    writeFileSync(src, Buffer.alloc(20 * 1024 * 1024));
    const file = fresh();
    const z = await createZip(file);
    await z.add('silence.csv', { file: src }, { mode: 0o644, mtime: T });
    await z.add('small.csv', { data: Buffer.alloc(11 * 1024 * 1024) }, { mode: 0o644, mtime: T });
    await z.close();
    const a = await openZip(file);
    try {
      expect(a.entries.map((e) => [e.name, e.method, e.size])).toEqual([
        ['silence.csv', 0, 20 * 1024 * 1024],
        ['small.csv', 0, 11 * 1024 * 1024],
      ]);
      expect((await a.readAll(a.entries[0]!, 1 << 30)).equals(Buffer.alloc(20 * 1024 * 1024))).toBe(true);
    } finally {
      await a.close();
    }
  });

  it('a central directory longer than its headers could be is refused before it is read', async () => {
    // One sound header padded past what a header of ours can be: refused on its size, not after reading it.
    const header = centralHeaderOf({ name: 'a', data: Buffer.alloc(0) }, 0);
    const cd = Buffer.concat([header, Buffer.alloc(4000)]);
    const bytes = Buffer.concat([cd, eocdOf({ count: 1, cdSize: cd.length, cdOffset: 0 })]);
    expect(await refusal(bytes)).toBe('the project archive is refused: its central directory is damaged');
    expect(CENTRAL_HEADER_MAX).toBeLessThan(1200);
  });
});

const python = spawnSync('python3', ['-c', 'import zipfile'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!python)('interop with Python zipfile', () => {
  it('Python reads and tests our archive, ZIP64 included', async () => {
    for (const zip64 of ['auto', 'always'] as const) {
      const file = fresh();
      const w = await createZip(file, { zip64 });
      await w.add('project/a.txt', { data: Buffer.from('hello '.repeat(100)) }, { mode: 0o644, mtime: T });
      await w.add('project/b.sh', { data: Buffer.from('echo') }, { mode: 0o755, mtime: T });
      await w.close();
      expect(execFileSync('python3', ['-I', '-m', 'zipfile', '-t', file], { encoding: 'utf8' })).toMatch(/Done testing/);
    }
  });

  it('we read a ZIP64 archive Python wrote (UTF-8 names), and refuse its ASCII names (not marked UTF-8)', async () => {
    const src = fresh('.txt');
    writeFileSync(src, 'data '.repeat(50));
    chmodSync(src, 0o644);
    const script = 'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:\n  z.write(sys.argv[2], sys.argv[3])\n';
    const write = (name: string) => {
      const out = fresh();
      const forced = script.replace(
        'z.write(sys.argv[2], sys.argv[3])',
        'zi = zipfile.ZipInfo.from_file(sys.argv[2], sys.argv[3])\n  with open(sys.argv[2], "rb") as f, z.open(zi, "w", force_zip64=True) as d: d.write(f.read())',
      );
      execFileSync('python3', ['-I', '-c', forced, out, src, name]);
      return out;
    };
    const a = await openZip(write('project/caf\u00e9.txt'));
    expect((await readEverything(a))['project/caf\u00e9.txt']!.toString()).toBe('data '.repeat(50));
    await a.close();
    await expect(openZip(write('project/plain.txt'))).rejects.toThrow(/name not marked UTF-8/);
  });
});
