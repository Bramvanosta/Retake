/**
 * A small, dependency-free QR Code encoder (ISO/IEC 18004, model 2) for call-to-action cards: byte mode (UTF-8),
 * versions 1–40, error correction L / M / Q / H, the eight masks scored with the standard penalty rules. Deterministic
 * and pure (no React): `qrMatrix(text)` → rows of booleans (true = dark), without the quiet zone.
 * Tested against the `qrcode` npm package (same version, level and mask → the same modules).
 */

export type QrLevel = 'L' | 'M' | 'Q' | 'H';

/** Error-correction codewords per block, by level (L, M, Q, H) and version (index 1–40). */
const ECC_PER_BLOCK: Record<QrLevel, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

/** Number of error-correction blocks, by level and version. */
const ECC_BLOCKS: Record<QrLevel, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** Format-information bits of each level. */
const LEVEL_BITS: Record<QrLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

export interface QrOptions {
  /** Error-correction level (default M: 15 % of the code may be damaged). */
  level?: QrLevel;
  /** Force a version 1–40 (default: the smallest that fits). */
  version?: number;
  /** Force a mask 0–7 (default: the lowest penalty). */
  mask?: number;
}

export interface QrCode {
  version: number;
  level: QrLevel;
  mask: number;
  size: number;
  /** modules[y][x], true = dark. */
  modules: boolean[][];
}

/** Modules available for data and error correction in a version (all but the function patterns). */
function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver: number, level: QrLevel): number {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[level][ver] * ECC_BLOCKS[level][ver];
}

/** Bits of the byte-mode character count. */
function countBits(ver: number): number {
  return ver <= 9 ? 8 : 16;
}

function utf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    let c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      c = Math.min(c, 0x10ffff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return out;
}

// ── Reed–Solomon over GF(256), primitive polynomial 0x11D ─────────────────────

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= gfMul(coef, factor)));
  }
  return result;
}

// ── Matrix ─────────────────────────────────────────────────────────────────────

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  set(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  alignmentPositions(): number[] {
    const ver = this.version;
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  drawFunctionPatterns(): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(n - 4, 3);
    this.finder(3, n - 4);
    const pos = this.alignmentPositions();
    const k = pos.length;
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === k - 1) || (i === k - 1 && j === 0)) continue;
        this.alignment(pos[i], pos[j]);
      }
    }
    this.drawFormat(LEVEL_BITS.M, 0); // placeholder, overwritten once the mask is known
    this.drawVersion();
  }

  private finder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.set(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  private alignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  drawFormat(levelBits: number, mask: number): void {
    const data = (levelBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i));
    this.set(8, n - 8, true);
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  drawCodewords(data: readonly number[]): void {
    let i = 0;
    const n = this.size;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunction[y][x]) continue;
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  penalty(): number {
    const n = this.size;
    const m = this.modules;
    let result = 0;
    const addHistory = (run: number, history: number[]) => {
      if (history[0] === 0) run += n;
      history.pop();
      history.unshift(run);
    };
    const countPatterns = (h: number[]) => {
      const k = h[1];
      const core = k > 0 && h[2] === k && h[3] === k * 3 && h[4] === k && h[5] === k;
      return (core && h[0] >= k * 4 && h[6] >= k ? 1 : 0) + (core && h[6] >= k * 4 && h[0] >= k ? 1 : 0);
    };
    const terminate = (color: boolean, run: number, history: number[]) => {
      if (color) {
        addHistory(run, history);
        run = 0;
      }
      run += n;
      addHistory(run, history);
      return countPatterns(history);
    };
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < n; a++) {
        let color = false;
        let run = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < n; b++) {
          const v = pass === 0 ? m[a][b] : m[b][a];
          if (v === color) {
            run++;
            if (run === 5) result += 3;
            else if (run > 5) result++;
          } else {
            addHistory(run, history);
            if (!color) result += countPatterns(history) * 40;
            color = v;
            run = 1;
          }
        }
        result += terminate(color, run, history) * 40;
      }
    }
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
      }
    }
    let dark = 0;
    for (const row of m) for (const v of row) if (v) dark++;
    const total = n * n;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  }
}

/** The data codewords of `bytes` for a version and level: mode, count, bytes, terminator, padding. */
function dataBits(bytes: readonly number[], ver: number, level: QrLevel): number[] {
  const bits: number[] = [];
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits(ver));
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(ver, level) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

/** Split into blocks, add each block's error correction, interleave. */
function withEcc(data: readonly number[], ver: number, level: QrLevel): number[] {
  const numBlocks = ECC_BLOCKS[level][ver];
  const eccLen = ECC_PER_BLOCK[level][ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(b[i]);
    });
  }
  return out;
}

/** The smallest version (≥ `min`) whose capacity holds `n` bytes at `level`, or 0. */
export function qrVersionFor(n: number, level: QrLevel = 'M', min = 1): number {
  for (let v = Math.max(1, min); v <= 40; v++) {
    if (4 + countBits(v) + 8 * n <= dataCodewords(v, level) * 8) return v;
  }
  return 0;
}

/** Encode `text` (UTF-8, byte mode) as a QR code. Throws when it does not fit in version 40. */
export function qrEncode(text: string, opts: QrOptions = {}): QrCode {
  const level = opts.level ?? 'M';
  const bytes = utf8(text);
  const version = opts.version ?? qrVersionFor(bytes.length, level);
  if (!version || version < 1 || version > 40 || 4 + countBits(version) + 8 * bytes.length > dataCodewords(version, level) * 8) {
    throw new Error(`QR code: ${bytes.length} bytes do not fit${opts.version ? ` in version ${opts.version}` : ''} at level ${level}`);
  }
  const codewords = withEcc(dataBits(bytes, version, level), version, level);
  const base = new Matrix(version);
  base.drawFunctionPatterns();
  base.drawCodewords(codewords);
  const masks = opts.mask !== undefined ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
  let best: { mask: number; modules: boolean[][]; score: number } | undefined;
  for (const mask of masks) {
    const m = new Matrix(version);
    m.modules.splice(0, m.size, ...base.modules.map((r) => [...r]));
    m.isFunction.splice(0, m.size, ...base.isFunction.map((r) => [...r]));
    m.applyMask(mask);
    m.drawFormat(LEVEL_BITS[level], mask);
    const score = masks.length > 1 ? m.penalty() : 0;
    if (!best || score < best.score) best = { mask, modules: m.modules, score };
  }
  return { version, level, mask: best!.mask, size: base.size, modules: best!.modules };
}

/** The modules of `text` (rows of booleans, true = dark), without the quiet zone. */
export function qrMatrix(text: string, opts: QrOptions = {}): boolean[][] {
  return qrEncode(text, opts).modules;
}

/**
 * An SVG path (`M x y h1 v1 h-1 z` per dark module, merged per row run) of a QR code drawn on a grid of `cell` units
 * with a quiet zone of `quiet` modules: draw it with `fill` in a viewBox of (size + 2 × quiet) × cell.
 */
export function qrPath(modules: readonly (readonly boolean[])[], cell = 1, quiet = 4): string {
  const parts: string[] = [];
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end++;
      parts.push(`M${(x + quiet) * cell} ${(y + quiet) * cell}h${(end - x) * cell}v${cell}h${-(end - x) * cell}z`);
      x = end;
    }
  });
  return parts.join('');
}
