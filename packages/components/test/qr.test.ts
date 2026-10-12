/**
 * The kit's QR encoder (studio/card-cta, R-STO-05) against the `qrcode` npm package (dev dependency, tests only): same
 * text, version, level and mask → the same modules; and the automatic version / mask choices are valid.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { qrEncode, qrMatrix, qrPath, qrVersionFor } from '@demo-studio/components/kit';
import type { QrLevel } from '@demo-studio/components/kit';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode') as {
  create(data: Array<{ data: string | Uint8Array; mode: 'byte' }>, opts: { errorCorrectionLevel: QrLevel; version?: number; maskPattern?: number }): {
    modules: { size: number; get(row: number, col: number): number };
    version: number;
    maskPattern: number;
  };
};

function reference(text: string, level: QrLevel, version: number, mask: number): boolean[][] {
  const q = QRCode.create([{ data: new TextEncoder().encode(text), mode: 'byte' }], { errorCorrectionLevel: level, version, maskPattern: mask });
  const n = q.modules.size;
  return Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => q.modules.get(y, x) === 1));
}

describe('qrEncode (byte mode) matches the qrcode package', () => {
  const texts = [
    'https://northfield.example/start',
    'HELLO',
    'https://shop.northfield.example/signup?ref=video&utm_source=demo-studio&utm_medium=qr',
    'Café Lumen — 12,50 € ✓',
    'x'.repeat(300),
  ];
  for (const text of texts) {
    for (const level of ['L', 'M', 'Q', 'H'] as QrLevel[]) {
      it(`${JSON.stringify(text.slice(0, 24))} at ${level}`, () => {
        const ours = qrEncode(text, { level });
        expect(ours.size).toBe(ours.version * 4 + 17);
        for (const mask of [0, 3, 5, 7, ours.mask]) {
          expect(qrMatrix(text, { level, version: ours.version, mask }), `mask ${mask}`).toEqual(reference(text, level, ours.version, mask));
        }
        // The smallest version that holds the bytes, as the reference picks it.
        const q = QRCode.create([{ data: new TextEncoder().encode(text), mode: 'byte' }], { errorCorrectionLevel: level });
        expect(ours.version).toBe(q.version);
      });
    }
  }

  it('versions with version information (≥ 7) and many blocks', () => {
    const text = 'https://northfield.example/' + 'a'.repeat(20);
    for (const version of [7, 10, 21, 32, 40]) {
      expect(qrMatrix(text, { level: 'Q', version, mask: 2 }), `v${version}`).toEqual(reference(text, 'Q', version, 2));
    }
  });

  it('refuses what does not fit and draws a path', () => {
    expect(() => qrEncode('x'.repeat(3000), { level: 'H' })).toThrow(/do not fit/);
    expect(() => qrEncode('x'.repeat(30), { version: 1 })).toThrow(/version 1/);
    expect(qrVersionFor(14, 'M')).toBe(1);
    const m = qrMatrix('HI', { level: 'L', version: 1, mask: 0 });
    const path = qrPath(m, 10, 4);
    expect(path.startsWith('M40 40h70v10h-70z')).toBe(true); // the top row of the finder pattern
  });
});
