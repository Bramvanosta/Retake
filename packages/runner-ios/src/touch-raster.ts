/**
 * The touch marks (touch-look.ts) drawn into an RGBA picture of the device's pixels (straight alpha, anti-aliased),
 * for the overlay burnt into capture.mp4. Pure: a buffer in, the box it drew in out (the caller clears it after use).
 */
import type { Rgba, TouchMark } from './touch-look.js';
import { TOUCH_LOOK } from './touch-look.js';

/** A box of pixels (x0, y0 inclusive; x1, y1 exclusive). */
export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** An RGBA picture: width × height pixels, 4 bytes each. */
export interface Picture {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Composite a colour of alpha `a` (0–1) over pixel `i` (straight alpha). */
function over(p: Uint8Array, i: number, c: Rgba, a: number): void {
  if (a <= 0) return;
  const da = p[i + 3] / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  const k = (da * (1 - a)) / oa;
  const s = a / oa;
  p[i] = Math.round(c[0] * s + p[i] * k);
  p[i + 1] = Math.round(c[1] * s + p[i + 1] * k);
  p[i + 2] = Math.round(c[2] * s + p[i + 2] * k);
  p[i + 3] = Math.round(oa * 255);
}

/** The box of a disc of radius `r` around (cx, cy), inside the picture. */
function discBox(pic: Picture, cx: number, cy: number, r: number): PixelBox {
  return {
    x0: Math.max(0, Math.floor(cx - r - 1)),
    y0: Math.max(0, Math.floor(cy - r - 1)),
    x1: Math.min(pic.width, Math.ceil(cx + r + 1)),
    y1: Math.min(pic.height, Math.ceil(cy + r + 1)),
  };
}

/** Each pixel of a disc's box with its distance to the centre (pixel centres). */
function eachInDisc(pic: Picture, cx: number, cy: number, r: number, f: (i: number, d: number) => void): PixelBox {
  const b = discBox(pic, cx, cy, r);
  for (let y = b.y0; y < b.y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = b.x0; x < b.x1; x++) {
      const dx = x + 0.5 - cx;
      f((y * pic.width + x) * 4, Math.sqrt(dx * dx + dy * dy));
    }
  }
  return b;
}

const coverage = (r: number, d: number) => Math.min(1, Math.max(0, r - d + 0.5));

/** The touch disc: its soft shadow, its fill, its ring. */
function drawDot(pic: Picture, m: Extract<TouchMark, { kind: 'dot' }>, scale: number): PixelBox {
  const L = TOUCH_LOOK;
  const cx = m.x * scale;
  const cy = m.y * scale;
  const r = (L.dotDiameter / 2) * m.scale * scale;
  const ring = L.ringWidth * scale;
  const blur = L.shadow.blur * scale;
  const sy = cy + L.shadow.dy * scale;
  const shadow: Rgba = [0, 0, 0, 1];
  const a = eachInDisc(pic, cx, sy, r + blur, (i, d) => {
    // A shadow that fades from the disc's edge to `blur` past it.
    const k = d <= r - blur ? 1 : Math.max(0, (r + blur - d) / (2 * blur));
    over(pic.data, i, shadow, L.shadow.alpha * k * k * m.opacity);
  });
  const b = eachInDisc(pic, cx, cy, r, (i, d) => {
    const inside = coverage(r, d);
    if (inside <= 0) return;
    over(pic.data, i, L.fill, L.fill[3] * inside * m.opacity);
    const inRing = inside * (1 - coverage(r - ring, d));
    over(pic.data, i, L.ring, L.ring[3] * inRing * m.opacity);
  });
  return union(a, b);
}

function drawRipple(pic: Picture, m: Extract<TouchMark, { kind: 'ripple' }>, scale: number, color: Rgba): PixelBox {
  const r = m.radius * scale;
  return eachInDisc(pic, m.x * scale, m.y * scale, r, (i, d) => over(pic.data, i, color, color[3] * coverage(r, d) * m.opacity));
}

function union(a: PixelBox | null, b: PixelBox): PixelBox {
  if (!a) return b;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/**
 * Draw `marks` (points) into `pic` (pixels: `scale` per point) over what it holds; returns the box drawn in (null:
 * nothing drawn). Pure but for the buffer.
 */
export function drawMarks(pic: Picture, marks: readonly TouchMark[], scale: number, ripple: Rgba): PixelBox | null {
  let box: PixelBox | null = null;
  for (const m of marks) box = union(box, m.kind === 'dot' ? drawDot(pic, m, scale) : drawRipple(pic, m, scale, ripple));
  return box && box.x1 > box.x0 && box.y1 > box.y0 ? box : null;
}

/** Clear a box of the picture back to transparent. */
export function clearBox(pic: Picture, box: PixelBox): void {
  for (let y = box.y0; y < box.y1; y++) pic.data.fill(0, (y * pic.width + box.x0) * 4, (y * pic.width + box.x1) * 4);
}
