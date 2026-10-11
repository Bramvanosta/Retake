import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LoadedProject, LoadedScenario, LoadedTemplate, Pacing, Scenario, Timeline } from '@demo-studio/core';
import { DEFAULT_CAPTURE } from '@demo-studio/core';

export const execFileP = promisify(execFile);

export interface TestServer {
  url: string;
  close(): Promise<void>;
}

/** Serves fixed HTML pages (path → html) on 127.0.0.1 with a random port. */
export async function startServer(pages: Record<string, string>): Promise<TestServer> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const body = pages[path];
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
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
  hover_ms: 40,
  press_ms: 30,
  after_click_ms: 80,
  after_popup_ms: 120,
  popup_timeout_ms: 400,
  type_cps: 60,
  scroll_duration: 0.3,
  jitter: 0,
  settle_ms: 300,
};

export async function tempDir(prefix = 'rw-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export function makeProject(dir: string, pages: Record<string, string>, opts: { width?: number; height?: number } = {}): LoadedProject {
  return {
    slug: 'northfield',
    dir,
    root: dir,
    config: {
      name: 'Northfield',
      environments: { test: pages },
      capture: { ...DEFAULT_CAPTURE, width: opts.width ?? 800, height: opts.height ?? 600 },
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

/** Centroid of the pure-magenta debug hotspot in an RGB24 frame (null when absent). */
export function magentaCentroid(rgb: Buffer, width: number, height: number): { x: number; y: number; n: number } | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
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
      }
    }
  }
  return n >= 6 ? { x: sx / n + 0.5, y: sy / n + 0.5, n } : null;
}
