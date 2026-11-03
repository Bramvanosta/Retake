/**
 * The project files a plan needs (L2.10), read before planning — `planEdit` itself does no I/O: the CSV / TSV text of
 * `data:` slots and the pixel size of image files named by card and overlay slots (`logo:`, `before:` …). L2.12: the
 * user files of segments and overlays (`intro: {video: …}`, `overlay: {lottie: …}`) and of the theme
 * (`components.intro: {video: …}`): videos are probed (ffprobe: size, length, sound, alpha), Lottie files parsed.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  LOTTIE_FILE_EXTENSIONS,
  MEDIA_COMPONENTS,
  VIDEO_FILE_EXTENSIONS,
  fileExtension,
  isImagePath,
  mediaFileOf,
  probeVideoFile,
  readLottieMeta,
  resolveThemeComponents,
} from '@retake/core';
import type { LoadedProject, LoadedTemplate, MediaFileFields, Timeline } from '@retake/core';
import type { PlanInputFile } from './plan.js';

const DATA_RE = /\.(csv|tsv)$/i;

/** A project file the plan of a timeline reads, with where the timeline names it. */
export interface PlanFileUse {
  ref: string;
  /** "scene a, card slot logo", "video intro (video file)", "step a.2 overlay (lottie file)". */
  where: string;
}

type PlanTimeline = Pick<Timeline, 'scenes' | 'events'> & Partial<Pick<Timeline, 'video'>>;

/**
 * Every project file the plan of `timeline` reads, where it is named: slot values of cards and step overlays that name
 * a data or image file, and the user files of segments and overlays (L2.12). Remote and served values excluded.
 */
export function planFileUses(timeline: PlanTimeline): PlanFileUse[] {
  const out: PlanFileUse[] = [];
  const add = (slots: Record<string, string> | undefined, where: string) => {
    for (const [name, v] of Object.entries(slots ?? {})) {
      const s = String(v).trim();
      if (!s || /^(https?:|data:|ds-asset:)/.test(s)) continue;
      if (DATA_RE.test(s) || isImagePath(s)) out.push({ ref: s, where: `${where} slot ${name}` });
    }
  };
  const file = (spec: Partial<MediaFileFields> | false | undefined, where: string) => {
    const f = spec ? mediaFileOf(spec) : undefined;
    if (f) out.push({ ref: f.path, where: `${where} (${f.kind} file)` });
  };
  for (const s of timeline.scenes) {
    add(s.card?.slots, `scene ${s.id}, card`);
    file(s.card, `scene ${s.id}, card`);
    file(s.interstitial, `scene ${s.id}, interstitial`);
  }
  file(timeline.video?.intro, 'video intro');
  file(timeline.video?.outro, 'video outro');
  for (const e of timeline.events) {
    const where = `step ${e.scene}.${e.step}${e.id ? ` (${e.id})` : ''} overlay`;
    add(e.overlay?.slots, where);
    const o = e.overlay;
    if (o && (o.component === MEDIA_COMPONENTS.media || o.component === MEDIA_COMPONENTS.lottie) && o.slots.file) out.push({ ref: o.slots.file.trim(), where: `${where} (file)` });
  }
  return out;
}

/** Slot values of the timeline's cards and step overlays that name a project file (data or image), and the user files of its segments and overlays (L2.12). */
export function planFileRefs(timeline: PlanTimeline): string[] {
  return [...new Set(planFileUses(timeline).map((u) => u.ref))].sort();
}

/** Slot values of cards and step overlays that are remote URLs (http: / https:), where they are named. */
export function remoteSlotUses(timeline: PlanTimeline): PlanFileUse[] {
  const out: PlanFileUse[] = [];
  const add = (slots: Record<string, string> | undefined, where: string) => {
    for (const [name, v] of Object.entries(slots ?? {})) if (/^https?:/i.test(String(v).trim())) out.push({ ref: String(v).trim(), where: `${where} slot ${name}` });
  };
  for (const s of timeline.scenes) add(s.card?.slots, `scene ${s.id}, card`);
  for (const e of timeline.events) add(e.overlay?.slots, `step ${e.scene}.${e.step}${e.id ? ` (${e.id})` : ''} overlay`);
  return out;
}

/** The theme's own files (`components.intro: {video: …}`, L2.12), absolute. */
export function themeFileRefs(template: LoadedTemplate | undefined): string[] {
  if (!template) return [];
  const out: string[] = [];
  for (const c of Object.values(resolveThemeComponents(template.template))) if (c?.file) out.push(resolve(template.dir, c.file.path));
  return out;
}

/** Read one user / project file for the planner (L2.12 videos and Lottie files included). */
async function readInputFile(ref: string, file: string): Promise<PlanInputFile> {
  const ext = fileExtension(ref);
  if (VIDEO_FILE_EXTENSIONS.includes(ext)) {
    try {
      const v = probeVideoFile(file);
      return { file, width: v.width, height: v.height, video: v };
    } catch (e) {
      const reason = (e as { reason?: string }).reason;
      return reason === 'unreadable' && /not found/.test((e as Error).message) ? { file, missing: true } : { file, error: (e as Error).message };
    }
  }
  const bytes = await readFile(file);
  if (DATA_RE.test(ref)) return { file, text: bytes.toString('utf8') };
  if (LOTTIE_FILE_EXTENSIONS.includes(ext)) {
    try {
      const l = readLottieMeta(bytes.toString('utf8'));
      return { file, width: l.width, height: l.height, lottie: l };
    } catch (e) {
      return { file, error: (e as Error).message };
    }
  }
  return { file, ...(imageFileSize(bytes) ?? {}) };
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

/**
 * Read the project files the plan of `timeline` needs (`PlanEditInput.files`) — and the theme's own files when the
 * template is given. Missing files are marked, unusable ones carry an `error`; nothing is thrown.
 */
export async function planInputFiles(
  timeline: Pick<Timeline, 'scenes' | 'events'> & Partial<Pick<Timeline, 'video'>>,
  project: Pick<LoadedProject, 'dir'>,
  template?: LoadedTemplate,
): Promise<Record<string, PlanInputFile>> {
  const out: Record<string, PlanInputFile> = {};
  for (const ref of [...planFileRefs(timeline), ...themeFileRefs(template)]) {
    const file = isAbsolute(ref) ? ref : join(project.dir, ref);
    try {
      out[ref] = await readInputFile(ref, file);
    } catch {
      out[ref] = { file, missing: true };
    }
  }
  return out;
}
