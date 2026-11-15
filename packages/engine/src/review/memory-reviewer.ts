/**
 * The Reviewer port in memory, for tests: no ffmpeg, no sharp, no check run. Not exported from the package (a test
 * imports this file). It lives under src, not test, because tests are not type-checked: here `implements Reviewer` is
 * compiled, so the port and its second adapter cannot drift apart unseen.
 *
 * Where: the Outputs port it is handed (`outputs`) — a MemoryOutputs keeps everything in memory, the disk's adapter
 * writes the disk —, never node:fs. The render is found there as a terminal names it (the port's renders `named`: core
 * findNamedRender, as the review package does); its video must be there. What it writes there: a review folder
 * (review/<render id>/, or `out`) with report.json (the result without its thumbnails), report.md, timeline.json and one
 * contact sheet (a 1 × 1 JPEG), written aside and swapped in at the end under the review package's names
 * (`<id>.tmp-<pid>-<hex>`, `<id>.old-<pid>-<hex>`), so that either adapter's `recover` puts the other's leftovers back
 * in order. What it honours of the port: the progress stages in order ending `done`, the signal (ReviewCancelledError,
 * before or between stages: the previous review kept), `thumbnails: false`, `recover`. The frames answer 1 × 1
 * pictures: `at` a PNG per time within `videoS` (null past it), `thumb` / `thumbnailOf` / `still` / `marks` a JPEG —
 * the files they read and write lie in the same outputs. Every call is kept in `calls`.
 */
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { RENDER_VARIANT_SUFFIX } from '@retake/core/ids';
import { isIsoUtcDate } from '@retake/core/comments';
import type { RenderVariant } from '@retake/core/ids';
import { pidExists } from '@retake/core/io';
import { DEFAULT_RULES, NOT_HANDED_PROJECT, NOT_HANDED_REGISTRY, ReviewCancelledError, isHandedProject, isHandedRegistry } from '@retake/review/checks';
import type { Finding, ReviewOptions, ReviewProgress, ReviewResult } from '@retake/review/checks';
import { MEMORY_PNG } from '../render/memory-renderer.js';
import type { OutputFolder, Outputs } from '../outputs/outputs.js';
import type { FrameInput, FrameThumb, FrameThumbOptions, FrameTools, FramesAtOptions, MarkBox, MarksOptions, Reviewer, StillOptions } from './reviewer.js';
import { bestEffort } from '@retake/core/base';

/** A 1 × 1 black JPEG. */
export const MEMORY_JPEG = Buffer.from(
  '/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJ+AD//Z',
  'base64',
);

/** The creation time of a review of a render without its finish time (else: that time — a review comes after its render). */
export const MEMORY_REVIEW_AT = '2026-01-01T00:00:00.000Z';

export type MemoryReviewerCall =
  | { op: 'review'; o: ReviewOptions }
  | { op: 'recover'; dir: string }
  | { op: 'frames.at'; input: FrameInput; seconds: readonly number[]; o: FramesAtOptions }
  | { op: 'frames.thumb'; bytes: Buffer; o?: FrameThumbOptions }
  | { op: 'frames.thumbnailOf'; file: string; maxPx: number }
  | { op: 'frames.still'; video: string; frame: number; out: string; o: StillOptions }
  | { op: 'frames.marks'; png: string | Buffer; boxes: readonly MarkBox[]; out: string; o?: MarksOptions };

export interface MemoryReviewerOptions {
  /** Where the renders are read and the reviews written (a MemoryOutputs: in memory). */
  outputs: Outputs;
  /** The findings every review reports (none by default: a clean review). */
  findings?: Finding[];
  /** Runs while a review runs (after its `frames` progress, before anything is swapped in): wait, abort or throw here. */
  duringReview?: (o: ReviewOptions) => void | Promise<void>;
  /** How long the videos `frames.at` reads are, in seconds (default 10): a time past it has no frame. */
  videoS?: number;
  /** The creation time every review says (default: its render's finish time; no wall clock is read). */
  at?: string;
}

/** A review that cannot start: the review package's class name, so that a shell's test of `e.name` holds for both. */
export class MemoryReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewError';
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const isImage = (b: Buffer) => (b.length >= 4 && b.subarray(0, 4).equals(PNG_MAGIC)) || (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff);

/** `<id>.tmp-<pid>-<hex>` / `<id>.old-<pid>-<hex>`: what a review sets aside (the review package's names). */
function aside(name: string, id: string): { kind: 'tmp' | 'old'; pid: number } | undefined {
  if (!name.startsWith(`${id}.`)) return undefined;
  const m = /^(tmp|old)-(\d+)-[0-9a-f]+$/.exec(name.slice(id.length + 1));
  return m ? { kind: m[1] as 'tmp' | 'old', pid: Number(m[2]) } : undefined;
}

/** A picture a frame tool reads, at most (bytes). */
const IMAGE_READ_MAX = 64 * 1024 * 1024;

/** Whether a file is at `path` of the outputs (links followed). */
async function there(folder: OutputFolder, path: string): Promise<boolean> {
  return (await folder.signature(path, { follow: true })) !== '-';
}

/** `out` written as the review package writes it: its folder must be there. */
async function writeImage(folder: OutputFolder, out: string): Promise<{ width: number; height: number; bytes: number }> {
  if ((await folder.kind(dirname(out))) !== 'folder') throw Object.assign(new Error(`ENOENT: no such folder for '${basename(out)}'`), { code: 'ENOENT' });
  await folder.write(out, MEMORY_JPEG);
  return { width: 1, height: 1, bytes: MEMORY_JPEG.length };
}

export class MemoryReviewer implements Reviewer {
  readonly calls: MemoryReviewerCall[] = [];
  readonly #o: MemoryReviewerOptions;
  readonly frames: FrameTools;

  constructor(o: MemoryReviewerOptions) {
    this.#o = o;
    const calls = this.calls;
    const files = o.outputs.reviews;
    const videos = o.outputs.renders;
    const videoS = o.videoS ?? 10;
    this.frames = {
      async load() {},
      async at(input, seconds, fo) {
        calls.push({ op: 'frames.at', input, seconds, o: fo });
        if (fo.signal?.aborted) throw new Error('cancelled');
        return seconds.map((s) => (s >= 0 && s < videoS ? MEMORY_PNG : null));
      },
      async thumb(bytes, fo): Promise<FrameThumb> {
        calls.push({ op: 'frames.thumb', bytes, ...(fo ? { o: fo } : {}) });
        if (!isImage(bytes)) throw new Error('unsupported image format');
        return { data: MEMORY_JPEG, width: 1, height: 1 };
      },
      async thumbnailOf(file, maxPx) {
        calls.push({ op: 'frames.thumbnailOf', file, maxPx });
        const read = await files.readPlain(file, { max: IMAGE_READ_MAX });
        if (!read.ok) throw new Error(`${basename(file)}: cannot be read (${read.reason})`);
        if (!isImage(read.bytes)) throw new Error(`${basename(file)}: unsupported image format`);
        return { base64: MEMORY_JPEG.toString('base64'), width: 1, height: 1, bytes: MEMORY_JPEG.length };
      },
      async still(video, frame, out, so) {
        calls.push({ op: 'frames.still', video, frame, out, o: so });
        if (!(await there(videos, video))) throw new Error(`${basename(video)}: no such video`);
        return writeImage(files, out);
      },
      async marks(png, boxes, out, mo) {
        calls.push({ op: 'frames.marks', png, boxes, out, ...(mo ? { o: mo } : {}) });
        if (typeof png === 'string' && !(await there(files, png))) throw new Error(`${basename(png)}: no such image`);
        return { ...(await writeImage(files, out)), marks: boxes.length };
      },
    };
  }

  async recover(dir: string): Promise<void> {
    this.calls.push({ op: 'recover', dir });
    const files = this.#o.outputs.reviews;
    const parent = dirname(dir);
    const id = basename(dir);
    for (const name of (await files.names(parent)).sort().reverse()) {
      const a = aside(name, id);
      if (!a || pidExists(a.pid)) continue;
      const leftover = join(parent, name);
      if (a.kind === 'old' && (await files.kind(dir)) === undefined) await bestEffort(files.move(leftover, dir), 'the previous review stays where it was: the new one is written beside it');
      else await files.remove(leftover).catch(() => undefined);
    }
  }

  async review(o: ReviewOptions): Promise<ReviewResult> {
    this.calls.push({ op: 'review', o });
    const started = performance.now();
    const emit = o.onProgress ?? (() => undefined);
    const check = () => {
      if (o.signal?.aborted) throw new ReviewCancelledError();
    };
    const stage = (s: ReviewProgress['stage'], progress?: number) => {
      check();
      emit({ stage: s, ...(progress !== undefined ? { progress } : {}) });
    };
    stage('loading');
    const project: unknown = o.project;
    if (!isHandedProject(project)) throw new MemoryReviewError(NOT_HANDED_PROJECT);
    if (!isHandedRegistry(o.registry)) throw new MemoryReviewError(NOT_HANDED_REGISTRY);
    const { renders, reviews: files } = this.#o.outputs;
    const found = await renders.named(renders.dirOf(project.dir), o.render, {
      verb: 'review',
      slug: project.slug,
      videoAlone: true,
      ...(o.scenario !== undefined ? { scenario: o.scenario } : {}),
    });
    if (!found.ok) throw new MemoryReviewError(found.message);
    const record = found.render.record;
    const name = found.render.output;
    if (!(await there(renders, record.file))) throw new MemoryReviewError(`the video of render ${name} is missing: ${record.file}`);
    const fps = o.fps ?? 1;
    if (fps !== 1 && fps !== 2) throw new MemoryReviewError(`fps ${String(fps)}: the contact sheet takes 1 or 2 frames per second`);
    const finalDir = o.out ?? join(files.dirOf(project.dir), name);
    await this.recover(finalDir);
    const tmpDir = `${finalDir}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
    try {
      stage('frames', 0);
      await this.#o.duringReview?.(o);
      stage('frames', 1);
      stage('checks');
      const findings = this.#o.findings ?? [];
      const counts = { error: 0, warning: 0, info: 0 };
      for (const f of findings) counts[f.severity]++;
      stage('sheets');
      const sheet = `sheet_${fps}fps.jpg`;
      await files.write(join(tmpDir, sheet), MEMORY_JPEG);
      stage('writing');
      const variant: RenderVariant = typeof record.variant === 'string' && Object.hasOwn(RENDER_VARIANT_SUFFIX, record.variant) ? (record.variant as RenderVariant) : 'landscape';
      const at = (f: string) => join(finalDir, f);
      const result: Omit<ReviewResult, 'thumbnails'> = {
        version: 1,
        render: {
          id: name,
          file: record.file,
          record: record.record,
          scenario: record.scenario,
          run_id: record.run_id,
          template: record.template,
          duration_s: record.duration_s,
          frames: record.frames,
          fps: record.fps,
          width: record.width,
          height: record.height,
          variant,
        },
        review: { created_at: this.#o.at ?? (isIsoUtcDate(record.finished_at) ? record.finished_at : MEMORY_REVIEW_AT), fps, ms: 0, rules: { ...DEFAULT_RULES, ...o.rules } },
        clean: counts.error === 0 && counts.warning === 0,
        counts,
        findings,
        durations: { total_s: record.duration_s, segments: [] },
        files: { dir: finalDir, sheets: [at(sheet)], scene_sheets: {}, keyframes: {}, timeline: at('timeline.json'), report_json: at('report.json'), report_md: at('report.md') },
      };
      result.review.ms = Math.round(performance.now() - started);
      await files.write(join(tmpDir, 'timeline.json'), '{}\n');
      await files.write(join(tmpDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
      await files.write(join(tmpDir, 'report.md'), `# Review of ${name}\n\n${findings.length} findings\n`);
      // Swapped in as the review package does: the previous review set aside, then removed. Cancelled before: kept.
      check();
      const old = `${finalDir}.old-${process.pid}-${randomBytes(3).toString('hex')}`;
      const hadOld = (await files.kind(finalDir)) !== undefined;
      if (hadOld) await files.move(finalDir, old);
      await files.move(tmpDir, finalDir);
      if (hadOld) await files.remove(old);
      const thumbnails: ReviewResult['thumbnails'] =
        o.thumbnails === false ? [] : [{ name: `sheet_${fps}fps`, file: at(sheet), mime: 'image/jpeg', width: 1, height: 1, bytes: MEMORY_JPEG.length, base64: MEMORY_JPEG.toString('base64') }];
      emit({ stage: 'done', progress: 1 });
      return { ...result, thumbnails };
    } catch (e) {
      await files.remove(tmpDir);
      if (o.signal?.aborted && !(e instanceof ReviewCancelledError)) throw new ReviewCancelledError();
      throw e;
    }
  }
}
