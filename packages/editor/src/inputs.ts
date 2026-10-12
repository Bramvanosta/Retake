/**
 * The project files a plan needs (L2.10), read before planning — `planEdit` itself does no I/O: the CSV / TSV text of
 * `data:` slots and the pixel size of image files named by card and overlay slots (`logo:`, `before:` …).
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isImagePath } from '@demo-studio/core';
import type { LoadedProject, Timeline } from '@demo-studio/core';
import type { PlanInputFile } from './plan.js';

const DATA_RE = /\.(csv|tsv)$/i;

/** Slot values of the timeline's cards and step overlays that name a project file (data or image). */
export function planFileRefs(timeline: Pick<Timeline, 'scenes' | 'events'>): string[] {
  const out = new Set<string>();
  const add = (slots: Record<string, string> | undefined) => {
    for (const v of Object.values(slots ?? {})) {
      const s = String(v).trim();
      if (!s || /^(https?:|data:|ds-asset:)/.test(s)) continue;
      if (DATA_RE.test(s) || isImagePath(s)) out.add(s);
    }
  };
  for (const s of timeline.scenes) add(s.card?.slots);
  for (const e of timeline.events) add(e.overlay?.slots);
  return [...out].sort();
}

/** Pixel size of a PNG, JPEG, GIF or SVG (width/height or viewBox); undefined when unknown. */
export function imageFileSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'GIF') return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      const len = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return undefined;
  }
  const head = bytes.toString('utf8', 0, Math.min(bytes.length, 4096));
  if (/<svg[\s>]/i.test(head)) {
    const tag = /<svg[^>]*>/i.exec(head)?.[0] ?? '';
    const num = (name: string) => {
      const m = new RegExp(`\\b${name}\\s*=\\s*["']?([\\d.]+)(px)?["']?`, 'i').exec(tag);
      return m ? Number(m[1]) : undefined;
    };
    const w = num('width');
    const h = num('height');
    if (w && h) return { width: w, height: h };
    const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
    if (vb) return { width: Number(vb[1]), height: Number(vb[2]) };
  }
  return undefined;
}

/** Read the project files the plan of `timeline` needs (`PlanEditInput.files`). Missing files are marked, not thrown. */
export async function planInputFiles(timeline: Pick<Timeline, 'scenes' | 'events'>, project: Pick<LoadedProject, 'dir'>): Promise<Record<string, PlanInputFile>> {
  const out: Record<string, PlanInputFile> = {};
  for (const ref of planFileRefs(timeline)) {
    const file = isAbsolute(ref) ? ref : join(project.dir, ref);
    try {
      const bytes = await readFile(file);
      if (DATA_RE.test(ref)) out[ref] = { file, text: bytes.toString('utf8') };
      else out[ref] = { file, ...(imageFileSize(bytes) ?? {}) };
    } catch {
      out[ref] = { file, missing: true };
    }
  }
  return out;
}
