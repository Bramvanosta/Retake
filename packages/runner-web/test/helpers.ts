/** Test helpers of the runner's own tests (what other packages' tests share with them: @retake/test-support/capture). */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { LoadedProject, Timeline } from '@retake/core';
import { DEFAULT_CAPTURE } from '@retake/core';
import { Journal, runHooks } from '@retake/hooks';
import type { CaptureHookRunner, HookJournal } from '@retake/core';

/**
 * The hook runner a test's run hands the runner (RunOptions.hookRunner, L7.12): the hooks package's runHooks and Journal,
 * as the engine's package hook runner calls them (the runner never loads the hooks package itself).
 */
export function testHookRunner(): CaptureHookRunner {
  const own = (journal: HookJournal): Journal => {
    if (journal instanceof Journal) return journal;
    throw new Error('a hooks journal the test hook runner did not open');
  };
  return {
    load: async () => undefined,
    run: (hooks, ctx, o) => runHooks([...hooks], ctx, { phase: o.phase, journal: own(o.journal), ...(o.agentWritten !== undefined ? { agentWritten: o.agentWritten } : {}) }),
    journals: { open: (file) => Journal.open(file) },
  };
}

export async function tempDir(prefix = 'rw-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * A project of the runner tests. Its captures keep their screencast frames (`keepFrames`, default true: most tests read
 * them — the encoder fed during the take is checked against them); `keepFrames: false` is the default of real projects.
 */
export function makeProject(dir: string, pages: Record<string, string>, opts: { width?: number; height?: number; keepFrames?: boolean } = {}): LoadedProject {
  return {
    slug: 'northfield',
    dir,
    root: dir,
    config: {
      name: 'Northfield',
      environments: { test: pages },
      capture: { ...DEFAULT_CAPTURE, width: opts.width ?? 800, height: opts.height ?? 600, keep_frames: opts.keepFrames ?? true },
      frame: 'raw',
      template: 'editorial',
    },
    readme: null,
    scenarios: [],
    file: join(dir, 'project.yaml'),
  };
}

export async function readTimeline(file: string): Promise<Timeline> {
  return JSON.parse(await readFile(file, 'utf8')) as Timeline;
}

/** Width/height from a JPEG's SOF marker. */
export function jpegSize(b: Buffer): [number, number] {
  let i = 2;
  while (i < b.length) {
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xc2) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + b.readUInt16BE(i + 2);
  }
  return [0, 0];
}

/** An RGB24 image: `data[(y * w + x) * 3 + c]`. */
export interface RgbImage {
  w: number;
  h: number;
  data: Buffer;
}

/** Decode a PNG (a screenshot, a golden image) to RGB24 with ffmpeg: no image library in the runner's tests. */
export async function decodePng(png: Buffer): Promise<RgbImage> {
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const data = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-f', 'png_pipe', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err += String(d)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg could not decode the PNG: ${err.trim()}`))));
    child.stdin.end(png);
  });
  if (data.length !== w * h * 3) throw new Error(`decoded PNG has ${data.length} bytes, expected ${w}×${h}×3`);
  return { w, h, data };
}
