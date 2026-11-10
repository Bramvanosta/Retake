/**
 * The renderer port in memory, for tests: no bundle, no browser, no encoder and no probe. Not exported from the
 * package (a test imports this file). It lives under src, not test, because tests are not type-checked: here
 * `implements Renderer` is compiled, so the port and its second adapter cannot drift apart unseen.
 *
 * What it writes: `video` writes a few bytes to `out` (a marker, not a playable file: whole on success, nothing after
 * a failure or a cancel) and answers a software / libx264 record with no `probe`; `stills` writes a 1 × 1 PNG per
 * frame; a preview session writes a 1 × 1 PNG (`still`) or GIF (`gif`). What it honours of the port: the signal
 * (`cancelled`), a frame outside the plan (`invalid`), the progress order, `onProcess` at most once, a session closed.
 * Every request is kept in `calls`.
 */
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EngineError } from '../errors.js';
import type {
  PreviewBundle,
  PreviewBundleRequest,
  PreviewOpenRequest,
  PreviewRendering,
  PreviewSession,
  RenderProcess,
  RenderStillsRequest,
  RenderVideoRequest,
  RenderVideoResult,
  Renderer,
} from './renderer.js';

/** A 1 × 1 transparent PNG. */
export const MEMORY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
/** A 1 × 1 GIF. */
export const MEMORY_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
/** What `video` writes at `out`. */
export const MEMORY_VIDEO = Buffer.from('retake memory renderer: not a video\n');

export type MemoryRendererCall =
  | { op: 'video'; req: RenderVideoRequest }
  | { op: 'stills'; req: RenderStillsRequest }
  | { op: 'previews.bundle'; req: PreviewBundleRequest }
  | { op: 'previews.open'; req: PreviewOpenRequest };

export interface MemoryRendererOptions {
  /** Runs while a video renders (after its first `rendering` progress, before the file is written): wait, abort or throw here. */
  duringVideo?: (req: RenderVideoRequest) => void | Promise<void>;
  /** The process a render reports (`onProcess`); none by default. */
  process?: RenderProcess;
  /** Warnings every render and session reports. */
  warnings?: string[];
}

const cancelledError = (): Error => new EngineError('cancelled', 'render cancelled: no output written');

async function writeWhole(out: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(out), { recursive: true });
  const tmp = `${out}.memory-tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, out);
}

export class MemoryRenderer implements Renderer {
  readonly calls: MemoryRendererCall[] = [];
  readonly #o: MemoryRendererOptions;
  readonly #bundles = new WeakSet<PreviewBundle>();
  readonly #seen = new Set<string>();

  constructor(o: MemoryRendererOptions = {}) {
    this.#o = o;
  }

  async video(req: RenderVideoRequest): Promise<RenderVideoResult> {
    this.calls.push({ op: 'video', req });
    const started = Date.now();
    const [first, last] = req.frameRange ?? [0, req.plan.durationInFrames - 1];
    const total = last - first + 1;
    const emit = req.onProgress ?? (() => undefined);
    if (req.signal?.aborted) throw cancelledError();
    emit({ stage: 'bundling', progress: 0, overall: 0 });
    emit({ stage: 'bundling', progress: 1, overall: 0.1, cached: false });
    if (this.#o.process) req.onProcess?.(this.#o.process);
    emit({ stage: 'rendering', progress: 0, overall: 0.1, totalFrames: total, renderedFrames: 0, encodedFrames: 0 });
    try {
      await this.#o.duringVideo?.(req);
      if (req.signal?.aborted) throw cancelledError();
      emit({ stage: 'rendering', progress: 1, overall: 0.95, totalFrames: total, renderedFrames: total, encodedFrames: 0 });
      await writeWhole(req.out, MEMORY_VIDEO);
      emit({ stage: 'encoding', progress: 1, overall: 1, totalFrames: total, renderedFrames: total, encodedFrames: total });
    } catch (e) {
      // The failure is the render's: a place that cannot even be cleared (under a regular file) does not replace it.
      await rm(req.out, { force: true }).catch(() => undefined);
      throw e;
    }
    return {
      file: req.out,
      size_bytes: MEMORY_VIDEO.length,
      concurrency: req.concurrency ?? 1,
      bundle: { hash: 'memory', cached: false, ms: 0 },
      browser: { path: null, source: 'none' },
      bundle_ms: 0,
      render_ms: Date.now() - started,
      warnings: [...(this.#o.warnings ?? [])],
      path: {
        gl: { asked: 'software', source: 'option', resolved: 'software', used: 'software' },
        encoder: { asked: 'libx264', source: 'option', used: 'libx264' },
        concurrency_source: req.concurrency === undefined ? 'default' : 'option',
      },
      encoding: { encoder: 'libx264' },
    };
  }

  async stills(req: RenderStillsRequest): Promise<string[]> {
    this.calls.push({ op: 'stills', req });
    for (const f of req.frames) {
      const frame = Math.round(f.frame);
      if (!(frame >= 0 && frame < req.plan.durationInFrames)) {
        throw new EngineError('invalid', `frame ${f.frame} is outside the video (0–${req.plan.durationInFrames - 1})`);
      }
    }
    if (this.#o.process) req.onProcess?.(this.#o.process);
    for (const f of req.frames) await writeWhole(f.out, MEMORY_PNG);
    req.onWarnings?.([...(this.#o.warnings ?? [])]);
    return req.frames.map((f) => f.out);
  }

  readonly previews: PreviewRendering = {
    bundle: async (o: PreviewBundleRequest): Promise<PreviewBundle> => {
      this.calls.push({ op: 'previews.bundle', req: o });
      if (o.signal?.aborted) throw cancelledError();
      const hash = createHash('sha256').update(JSON.stringify(o.components.map((c) => [c.id, c.kind, c.entry, c.defaults]))).digest('hex').slice(0, 16);
      const bundle: PreviewBundle = Object.freeze({ hash, cached: this.#seen.has(hash) });
      this.#seen.add(hash);
      this.#bundles.add(bundle);
      return bundle;
    },
    open: async (bundle: PreviewBundle, o: PreviewOpenRequest): Promise<PreviewSession> => {
      this.calls.push({ op: 'previews.open', req: o });
      if (!this.#bundles.has(bundle)) throw new EngineError('invalid', 'this preview bundle was made by another renderer');
      if (o.signal?.aborted) throw cancelledError();
      if (this.#o.process) o.onProcess?.(this.#o.process);
      let closed = false;
      const ready = (): void => {
        if (closed) throw new EngineError('invalid', 'this preview session is closed');
        if (o.signal?.aborted) throw cancelledError();
      };
      const warnings = [...(this.#o.warnings ?? [])];
      return {
        still: async (_spec, out) => {
          ready();
          await writeWhole(out, MEMORY_PNG);
        },
        gif: async (_spec, out) => {
          ready();
          await writeWhole(out, MEMORY_GIF);
        },
        warnings: () => [...warnings],
        close: async () => {
          closed = true;
        },
      };
    },
  };
}
