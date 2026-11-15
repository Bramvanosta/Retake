/**
 * engine brand/tar.ts: the in-memory reader of a gzipped ustar archive the font fetch uses — the entries asked for,
 * by their effective name (ustar prefix, pax path, GNU long name), each under its cap; the archive refused as a whole
 * for a link, a name going out, a wrong checksum, a base-256 or non-octal size, a wanted name twice, too many entries,
 * too many bytes once unpacked, a pax size, or no end-of-archive block. Archives are synthetic (test-support fontsource.ts).
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { readTarGz } from '../src/brand/tar.js';
import { paxPath, tgzOf } from '@retake/test-support/fontsource';
import type { TarEntry } from '@retake/test-support/fontsource';

const limits = (want: Record<string, number>, o: { maxUnpacked?: number; maxEntries?: number } = {}) => ({
  maxUnpacked: o.maxUnpacked ?? 10 * 1024 * 1024,
  maxEntries: o.maxEntries ?? 100,
  want: (name: string) => want[name],
});

async function refusal(entries: TarEntry[], want: Record<string, number> = { 'package/a': 1000 }, o: { end?: boolean; maxUnpacked?: number; maxEntries?: number } = {}): Promise<string> {
  const e = await readTarGz(tgzOf(entries, { end: o.end }), limits(want, o)).then(
    () => null,
    (x: Error) => x,
  );
  if (!e) throw new Error('expected a refusal');
  expect((e as { code?: string }).code).toBe('refused');
  return e.message;
}

describe('readTarGz', () => {
  it('regular files by name and size: only the wanted ones are kept, the others skipped (a folder, a big file)', async () => {
    const big = Buffer.alloc(70_000, 7);
    const tgz = tgzOf([{ name: 'package/', type: '5' }, { name: 'package/a', data: 'hello' }, { name: 'package/big', data: big }, { name: 'package/b', data: Buffer.alloc(513, 1) }]);
    const out = await readTarGz(tgz, limits({ 'package/a': 10, 'package/b': 600 }));
    expect([...out.keys()]).toEqual(['package/a', 'package/b']);
    expect(out.get('package/a')!.toString()).toBe('hello');
    expect(out.get('package/b')!.length).toBe(513);
  });

  it('the ustar prefix field, a pax path and a GNU long name give the entry its name', async () => {
    const long = `package/files/${'a'.repeat(64)}-latin-900-italic.woff2`;
    expect(long.length).toBeGreaterThan(100);
    const tgz = tgzOf([
      { name: `${'a'.repeat(64)}-latin-900-italic.woff2`, prefix: 'package/files', data: 'by prefix' },
      paxPath('package/by-pax'),
      { name: 'ignored-name', data: 'by pax' },
      { name: '././@LongLink', type: 'L', data: 'package/by-long\0' },
      { name: 'cut', data: 'by long name' },
      { name: 'package/after', data: 'plain again' },
    ]);
    const out = await readTarGz(tgz, limits({ [long]: 100, 'package/by-pax': 100, 'package/by-long': 100, 'package/after': 100, 'ignored-name': 100, cut: 100 }));
    expect(Object.fromEntries([...out].map(([k, v]) => [k, v.toString()]))).toEqual({ [long]: 'by prefix', 'package/by-pax': 'by pax', 'package/by-long': 'by long name', 'package/after': 'plain again' });
  });

  it('truncated archives and over-cap entries are refused', async () => {
    expect(await refusal([{ name: 'package/a', data: 'x' }], {}, { end: false })).toMatch(/cut short/);
    const whole = tgzOf([{ name: 'package/a', data: Buffer.alloc(4000, 1) }]);
    const cut = gzipSync(gunzipSync(whole).subarray(0, 2048));
    await expect(readTarGz(cut, limits({ 'package/a': 5000 }))).rejects.toThrow(/cut short/);
    expect(await refusal([{ name: 'package/a', data: 'too long' }], { 'package/a': 3 })).toMatch(/more than 3/);
    await expect(readTarGz(Buffer.from('not gzip at all'), limits({}))).rejects.toThrow(/not a gzip stream/);
  });

  it('links, names going out, a wrong checksum, base-256 and non-octal sizes are refused', async () => {
    expect(await refusal([{ name: 'package/a', type: '2', data: '' }])).toMatch(/a link/);
    expect(await refusal([{ name: 'package/a', type: '1', data: '' }])).toMatch(/a link/);
    expect(await refusal([{ name: '././@LongLink', type: 'K', data: 'x' }])).toMatch(/a link/);
    expect(await refusal([{ name: 'package/../../etc/x', data: 'x' }], {})).toMatch(/goes out/);
    expect(await refusal([{ name: '/etc/x', data: 'x' }], {})).toMatch(/an entry named/);
    expect(await refusal([{ name: 'package\\a', data: 'x' }], {})).toMatch(/an entry named/);
    expect(await refusal([{ name: 'package/a', data: 'x', badChecksum: true }])).toMatch(/checksum/);
    expect(await refusal([{ name: 'package/a', data: 'x', base256: true }])).toMatch(/base-256/);
    expect(await refusal([{ name: 'package/a', data: 'x', sizeText: '00000000z01\0' }])).toMatch(/not octal/);
  });

  it('a wanted name twice is refused (never "last wins"); a skipped name twice is fine', async () => {
    expect(await refusal([{ name: 'package/a', data: 'one' }, { name: 'package/a', data: 'two' }])).toMatch(/"package\/a" twice/);
    expect(await refusal([{ name: 'package/a', data: 'one' }, paxPath('package/a'), { name: 'other', data: 'two' }])).toMatch(/twice/);
    const out = await readTarGz(tgzOf([{ name: 'package/x', data: '1' }, { name: 'package/x', data: '2' }, { name: 'package/a', data: 'a' }]), limits({ 'package/a': 9 }));
    expect([...out.keys()]).toEqual(['package/a']);
  });

  it('too many entries, too many bytes once unpacked, a pax header giving a size are refused', async () => {
    expect(await refusal([{ name: 'package/a', data: '1' }, { name: 'package/b', data: '2' }, { name: 'package/c', data: '3' }], {}, { maxEntries: 2 })).toMatch(/more than 2 entries/);
    // A small archive of many zeros: refused as soon as gunzip's output passes the cap, without holding it.
    expect(await refusal([{ name: 'package/zeros', data: Buffer.alloc(3 * 1024 * 1024) }], {}, { maxUnpacked: 1024 * 1024 })).toMatch(/once unpacked/);
    expect(await refusal([{ name: 'PaxHeader', type: 'x', data: '13 size=1000\n' }, { name: 'package/a', data: 'x' }])).toMatch(/gives a size/);
  });

  it('stops at the end-of-archive block: a long tail of zeros after it is never unpacked nor held (time and memory bound)', async () => {
    const tar = gunzipSync(tgzOf([{ name: 'package/a', data: 'kept' }]));
    const tgz = gzipSync(Buffer.concat([tar, Buffer.alloc(50 * 1024 * 1024)]));
    expect(tgz.length).toBeLessThan(200 * 1024);
    const before = process.memoryUsage().rss;
    const t0 = performance.now();
    // A cap below the tail: the reader must stop at the end block, not unpack on to the cap.
    const out = await readTarGz(tgz, limits({ 'package/a': 10 }, { maxUnpacked: 20 * 1024 * 1024 }));
    const ms = performance.now() - t0;
    expect(out.get('package/a')!.toString()).toBe('kept');
    expect(ms).toBeLessThan(1500);
    expect(process.memoryUsage().rss - before).toBeLessThan(150 * 1024 * 1024);
  });

  it("an entry's name in a refusal is the archive's text with every hidden character written out", async () => {
    const msg = await refusal([{ name: 'package/../\u202ex', data: 'x' }], {});
    expect(msg).toContain('\\u{202e}');
    expect(msg).not.toContain('\u202e');
  });
});
