/**
 * core image-size.ts: the declared size of a logo-like image from its bytes (PNG, JPEG, WebP headers; an SVG's
 * width / height, else its viewBox) and the aspect the loader records for a theme's logo. Never throws.
 */
import { describe, expect, it } from 'vitest';
import { IMAGE_SIZE_HEAD_BYTES, aspectOf, imageAspect, rasterSize, svgSize } from '../src/index.js';

/** A PNG signature and IHDR chunk of `w × h` (the rest of the file is not read). */
function pngHead(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/** A JPEG with an APP0 segment then a baseline SOF0 of `w × h`. */
function jpegHead(w: number, h: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(8)]);
}

/** A lossless WebP (VP8L) header of `w × h`. */
function webpHead(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8L', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b[20] = 0x2f;
  b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  return b;
}

describe('image sizes', () => {
  it('PNG, JPEG and WebP sizes come from their headers', () => {
    expect(rasterSize(pngHead(2048, 181))).toEqual({ format: 'png', width: 2048, height: 181 });
    expect(rasterSize(jpegHead(640, 480))).toEqual({ format: 'jpeg', width: 640, height: 480 });
    expect(rasterSize(webpHead(300, 100))).toEqual({ format: 'webp', width: 300, height: 100 });
    expect(rasterSize(new Uint8Array(pngHead(120, 120)))).toEqual({ format: 'png', width: 120, height: 120 });
  });

  it("an SVG's size: width / height, else its viewBox; none gives no size", () => {
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="100px" viewBox="0 0 10 10"/>')).toEqual({ width: 900, height: 100 });
    expect(svgSize('<?xml version="1.0"?>\n<svg viewBox="0 0 1200 300" xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')).toEqual({ width: 1200, height: 300 });
    expect(svgSize('<svg:svg viewBox="0,0,400,100"/>')).toEqual({ width: 400, height: 100 });
    // One side alone is in other units than the viewBox: the other side follows the viewBox's proportions.
    expect(svgSize('<svg width="600" viewBox="0 0 300 100"/>')).toEqual({ width: 600, height: 200 });
    expect(svgSize('<svg height="24" viewBox="0 0 100 100"/>')).toEqual({ width: 24, height: 24 });
    expect(svgSize('<svg width="1100" viewBox="0 0 110 10"/>')).toEqual({ width: 1100, height: 100 });
    expect(svgSize('<svg width="100%" height="24" viewBox="0 0 200 100"/>')).toEqual({ width: 48, height: 24 });
    // A root inside a comment is never read, a closed one or one left open to the end (a truncated head).
    expect(svgSize('<!-- <svg width="1" height="100"> --><svg width="300" height="100"/>')).toEqual({ width: 300, height: 100 });
    expect(svgSize('<?xml version="1.0"?><!-- a long note <svg width="900" height="100">')).toBeUndefined();
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBeUndefined();
    expect(svgSize('<svg width="100%" height="100%"/>')).toBeUndefined();
    expect(svgSize('<svg viewBox="0 0 0 10"/>')).toBeUndefined();
    expect(svgSize('<html></html>')).toBeUndefined();
  });

  it('a truncated or foreign file gives no size, never an error', () => {
    expect(rasterSize(pngHead(10, 10).subarray(0, 20))).toBeUndefined();
    expect(rasterSize(jpegHead(10, 10).subarray(0, 12))).toBeUndefined();
    expect(rasterSize(Buffer.from('GIF89a......'))).toBeUndefined();
    expect(rasterSize(new Uint8Array(0))).toBeUndefined();
    expect(imageAspect(Buffer.from('not an image'), '.png')).toBeUndefined();
    expect(imageAspect(Buffer.from([0xff, 0xfe, 0x00, 0xd8]), '.svg')).toBeUndefined();
    expect(imageAspect(pngHead(0, 0), '.png')).toBeUndefined();
  });

  it('the aspect is width / height to four decimals, by extension (an SVG read as text)', () => {
    expect(imageAspect(pngHead(2048, 181), '.png')).toBe(11.3149);
    expect(imageAspect(pngHead(120, 120), '.PNG')).toBe(1);
    expect(imageAspect(Buffer.from('<svg viewBox="0 0 299 100"/>'), '.svg')).toBe(2.99);
    expect(imageAspect(Buffer.from('<svg viewBox="0 0 300 100"/>'), '.SVG')).toBe(3);
    // The extension decides how the bytes are read: SVG text named .png gives no size.
    expect(imageAspect(Buffer.from('<svg viewBox="0 0 300 100"/>'), '.png')).toBeUndefined();
    expect(IMAGE_SIZE_HEAD_BYTES).toBeGreaterThanOrEqual(64 * 1024);
    // The square mark whose height alone is given reads 1:1 (not 24:100 against the viewBox's width).
    expect(imageAspect(Buffer.from('<svg height="24" viewBox="0 0 100 100"/>'), '.svg')).toBe(1);
  });

  it('a degenerate size gives no aspect: 0, Infinity, beyond 1000:1 either way', () => {
    expect(imageAspect(Buffer.from(`<svg width="${'9'.repeat(400)}" height="10"/>`), '.svg')).toBeUndefined();
    expect(imageAspect(Buffer.from('<svg width="0.00001" height="10"/>'), '.svg')).toBeUndefined();
    expect(imageAspect(Buffer.from('<svg width="0" height="10" viewBox="0 0 10 10"/>'), '.svg')).toBe(1);
    expect(aspectOf(1001, 1)).toBeUndefined();
    expect(aspectOf(1000, 1)).toBe(1000);
    expect(aspectOf(1, 1000)).toBe(0.001);
    expect(aspectOf(1, 1001)).toBeUndefined();
    expect(aspectOf(Number.POSITIVE_INFINITY, 1)).toBeUndefined();
  });
});
