/**
 * The overlay's PNG encoder (src/png.ts): its CRC-32 against known values, and a round trip — the chunks read back,
 * their CRCs checked, the pixels inflated equal to what was encoded.
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, encodePng } from '../src/png.js';

/** A PNG's chunks (type, data), every CRC checked. */
function chunks(png: Buffer): Array<{ type: string; data: Buffer }> {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const out: Array<{ type: string; data: Buffer }> = [];
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('ascii');
    const data = png.subarray(at + 8, at + 8 + len);
    expect(png.readUInt32BE(at + 8 + len)).toBe(crc32(png.subarray(at + 4, at + 8), data));
    out.push({ type, data });
    at += 12 + len;
  }
  return out;
}

describe('the PNG encoder', () => {
  it('CRC-32 (IEEE): known values', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.from('IEND'))).toBe(0xae426082);
    expect(crc32(Buffer.from('1234'), Buffer.from('56789'))).toBe(0xcbf43926);
  });

  it('round trip: IHDR (8-bit RGBA), the pixels back as encoded, IEND', () => {
    const w = 7;
    const h = 5;
    const rgba = new Uint8Array(w * h * 4).map((_, i) => (i * 37) % 256);
    const list = chunks(encodePng(w, h, rgba));
    expect(list.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const ihdr = list[0].data;
    expect([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ihdr[8], ihdr[9]]).toEqual([w, h, 8, 6]);
    const raw = inflateSync(list[1].data);
    expect(raw.length).toBe((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
      expect(raw[y * (w * 4 + 1)]).toBe(0);
      expect([...raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1))]).toEqual([...rgba.subarray(y * w * 4, (y + 1) * w * 4)]);
    }
    expect(() => encodePng(w, h, new Uint8Array(3))).toThrow(/RGBA picture/);
  });
});
