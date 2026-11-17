/**
 * The movie's own duration of a QuickTime file (src/mov-box.ts): `moov/mvhd`'s duration over its timescale (version 0
 * and 1), found before or after the media data; a file without one says null.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { moovDuration, movieDuration } from '../src/mov-box.js';

const dir = mkdtempSync(join(tmpdir(), 'retake-mov-box-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function box(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

/** An mvhd payload: version 0 (32-bit times) or 1 (64-bit). */
function mvhd(version: 0 | 1, scale: number, duration: number): Buffer {
  if (version === 0) {
    const b = Buffer.alloc(100);
    b.writeUInt32BE(scale, 12);
    b.writeUInt32BE(duration, 16);
    return box('mvhd', b);
  }
  const b = Buffer.alloc(112);
  b.writeUInt8(1, 0);
  b.writeUInt32BE(scale, 20);
  b.writeBigUInt64BE(BigInt(duration), 24);
  return box('mvhd', b);
}

describe("a movie's duration", () => {
  it('mvhd version 0 and 1, among the moov boxes', () => {
    expect(moovDuration(Buffer.concat([box('trak', Buffer.alloc(20)), mvhd(0, 600, 1201)]))).toBeCloseTo(2.00167, 5);
    expect(moovDuration(mvhd(1, 90000, 270000))).toBe(3);
    expect(moovDuration(box('trak', Buffer.alloc(4)))).toBeNull();
  });

  it('read from a file: the moov before or after the media data; none without one', async () => {
    const ftyp = box('ftyp', Buffer.from('qt  \0\0\0\0qt  ', 'latin1'));
    const mdat = box('mdat', Buffer.alloc(5000, 7));
    const front = join(dir, 'front.mov');
    writeFileSync(front, Buffer.concat([ftyp, box('moov', mvhd(0, 600, 917)), box('wide', Buffer.alloc(0)), mdat]));
    expect(await movieDuration(front)).toBeCloseTo(917 / 600, 6);
    const back = join(dir, 'back.mov');
    writeFileSync(back, Buffer.concat([ftyp, mdat, box('moov', mvhd(0, 600, 1200))]));
    expect(await movieDuration(back)).toBe(2);
    const none = join(dir, 'none.mov');
    writeFileSync(none, Buffer.concat([ftyp, mdat]));
    expect(await movieDuration(none)).toBeNull();
    expect(await movieDuration(join(dir, 'missing.mov'))).toBeNull();
  });
});
