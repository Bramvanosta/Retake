import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { LoadedProject, LoadedScenario, LoadedTemplate, Pacing, Scenario, Timeline } from '@retake/core';
import { DEFAULT_CAPTURE } from '@retake/core';

export const execFileP = promisify(execFile);

export interface TestServer {
  url: string;
  /** Every request served, in order (method and path without the query). */
  hits: Array<{ method: string; path: string }>;
  close(): Promise<void>;
}

/** A served path: html (or a function of the request headers), or a response with its type, status and a delay. */
export type ServerEntry =
  | string
  | ((headers: IncomingHttpHeaders) => string)
  | { body: string | ((headers: IncomingHttpHeaders) => string); type?: string; status?: number; delay_ms?: number };

/** Serves fixed pages (path → entry) on 127.0.0.1 with a random port. */
export async function startServer(pages: Record<string, ServerEntry>): Promise<TestServer> {
  const hits: TestServer['hits'] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    hits.push({ method: req.method ?? 'GET', path });
    const entry = pages[path];
    if (entry === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const spec = typeof entry === 'object' ? entry : { body: entry };
    const body = typeof spec.body === 'function' ? spec.body(req.headers) : spec.body;
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(spec.status ?? 200, { 'content-type': spec.type ?? 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };
    if (spec.delay_ms) setTimeout(send, spec.delay_ms);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Fast pacing for functional tests (the acceptance test uses the real defaults). */
export const FAST: Partial<Pacing> = {
  scene_start_still: 0.1,
  move_base_ms: 60,
  move_ms_per_px: 0.05,
  move_min_ms: 60,
  move_max_ms: 160,
  nudge_ms: 60,
  nudge_hover_ms: 30,
  hover_ms: 40,
  press_ms: 30,
  after_click_ms: 80,
  after_popup_ms: 120,
  after_navigation_ms: 150,
  popup_fallback_ms: 300,
  popup_timeout_ms: 400,
  type_cps: 60,
  scroll_duration: 0.3,
  jitter: 0,
  settle_ms: 300,
};

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

export function makeScenario(name: string, scenario: Omit<Scenario, 'video'> & { video?: string }): LoadedScenario {
  const s: Scenario = { video: name, ...scenario };
  return { name, file: `/virtual/${name}.yaml`, text: JSON.stringify(s, null, 2), scenario: s, issues: [] };
}

export function debugTemplate(): LoadedTemplate {
  return {
    name: 'debug',
    dir: '/virtual/templates/debug',
    template: { cursor: { style: 'debug', ripple_color: 'rgba(0,0,0,.2)' } } as LoadedTemplate['template'],
    assets: { logo: '', display: '', body: [] },
  };
}

export async function readTimeline(file: string): Promise<Timeline> {
  return JSON.parse(await readFile(file, 'utf8')) as Timeline;
}

export async function ffprobeDuration(file: string): Promise<number> {
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(stdout.trim());
}

/** Decode one frame of a video at time t (seconds) as raw RGB24. */
export async function frameAt(file: string, t: number, width: number, height: number): Promise<Buffer> {
  const { stdout } = await execFileP(
    'ffmpeg',
    ['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer', maxBuffer: width * height * 3 + 1024 },
  );
  return stdout as unknown as Buffer;
}

/**
 * Centroid and bounding box of the pure-magenta debug hotspot (the 6×6 CSS px square of `cursor.style: debug`) in an
 * RGB24 frame (null when absent).
 */
export function magentaCentroid(
  rgb: Buffer,
  width: number,
  height: number,
): { x: number; y: number; n: number; box: { x: number; y: number; w: number; h: number } } | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const r = rgb[i];
      const g = rgb[i + 1];
      const b = rgb[i + 2];
      if (r > 170 && b > 170 && g < 90) {
        sx += x;
        sy += y;
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return n >= 6 ? { x: sx / n + 0.5, y: sy / n + 0.5, n, box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } } : null;
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
