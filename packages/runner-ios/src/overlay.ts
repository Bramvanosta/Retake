/**
 * The touch overlay of a take written out: for each output frame (n / fps) the touch marks drawn (touch-look.ts,
 * touch-raster.ts), a PNG written only when the picture changes (one transparent picture for every still span, one
 * picture for every repeat of the same marks), and
 * the ffconcat list (ffconcat.ts) the conversion reads.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ffconcatText } from './ffconcat.js';
import type { OverlayEntry } from './ffconcat.js';
import { encodePng } from './png.js';
import type { Rgba } from './touch-look.js';
import { marksKey, touchMarks } from './touch-look.js';
import { clearBox, drawMarks } from './touch-raster.js';
import type { Picture } from './touch-raster.js';
import type { Touch } from './touch-track.js';

export interface OverlayOptions {
  touches: readonly Touch[];
  /** Output frames of the take (round(endT · fps)) and their rate. */
  frames: number;
  fps: number;
  /** The device's screen: points and pixels per point. */
  screen: { width: number; height: number; scale: number };
  ripple: Rgba;
  /** Where the pictures and the list go. */
  dir: string;
}

export interface WrittenOverlay {
  /** The ffconcat list. */
  list: string;
  /** Capture times the overlay changes at (the edit's idle spans end there). */
  changes: number[];
  /** Pictures written. */
  pictures: number;
  files: string[];
}

/** The overlay's frames: which output frames change the picture, and the picture of each. Pure. */
export function overlayPlan(touches: readonly Touch[], frames: number, fps: number): Array<{ frame: number; key: string }> {
  const out: Array<{ frame: number; key: string }> = [];
  let last: string | null = null;
  for (let n = 0; n < frames; n++) {
    const key = marksKey(touchMarks(touches, n / fps));
    if (key === last) continue;
    out.push({ frame: n, key });
    last = key;
  }
  return out;
}

/** Write the overlay's pictures and list into `o.dir`. */
export async function writeOverlay(o: OverlayOptions): Promise<WrittenOverlay> {
  const width = Math.round(o.screen.width * o.screen.scale);
  const height = Math.round(o.screen.height * o.screen.scale);
  const pic: Picture = { width, height, data: new Uint8Array(width * height * 4) };
  const entries: OverlayEntry[] = [];
  const files: string[] = [];
  const changes: number[] = [];
  let clear: string | null = null;
  const written = new Map<string, string>();
  for (const step of overlayPlan(o.touches, o.frames, o.fps)) {
    const t = step.frame / o.fps;
    if (step.frame > 0) changes.push(Math.round(t * 1000) / 1000);
    if (step.key === '') {
      if (!clear) {
        clear = 'clear.png';
        files.push(join(o.dir, clear));
        await writeFile(join(o.dir, clear), encodePng(width, height, pic.data));
      }
      entries.push({ file: clear, frame: step.frame });
      continue;
    }
    // The same marks again (a disc held still): the picture already written.
    const again = written.get(step.key);
    if (again) {
      entries.push({ file: again, frame: step.frame });
      continue;
    }
    const box = drawMarks(pic, touchMarks(o.touches, t), o.screen.scale, o.ripple);
    const name = `touch-${String(step.frame).padStart(6, '0')}.png`;
    files.push(join(o.dir, name));
    await writeFile(join(o.dir, name), encodePng(width, height, pic.data));
    if (box) clearBox(pic, box);
    written.set(step.key, name);
    entries.push({ file: name, frame: step.frame });
  }
  if (!entries.length) {
    clear = 'clear.png';
    files.push(join(o.dir, clear));
    await writeFile(join(o.dir, clear), encodePng(width, height, pic.data));
    entries.push({ file: clear, frame: 0 });
  }
  const list = join(o.dir, 'touches.ffconcat');
  await writeFile(list, ffconcatText(entries, Math.max(1, o.frames), o.fps));
  files.push(list);
  return { list, changes, pictures: files.length - 1, files };
}
