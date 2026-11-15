/**
 * Where an export goes and its manifest (render/export-manifest.ts): the engine's, on the Outputs port's exports — the
 * folder exports/<render-id>/ or the caller's output folder, and manifest.json: the formats made now beside the ones
 * exported earlier into the folder whose file is still there, in the formats' order, stamped by the clock, in the
 * form the editor wrote it (two-space indent, a final newline). On the disk's adapter and the memory's.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExportMade, ExportOutput } from '@retake/editor/plan';
import { ManualClock, MemoryOutputs, diskOutputs } from '../src/index.js';
import type { Outputs } from '../src/index.js';
import { exportPlace, writeExportManifest } from '../src/render/export-manifest.js';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'retake-export-manifest-')));
afterAll(() => rm(temp, { recursive: true, force: true }));

const output = (dir: string, format: ExportOutput['format'], method: ExportOutput['method'] = 'transcode'): ExportOutput => ({
  format,
  file: join(dir, `quote-v1-${format}.mp4`),
  method,
  width: 1920,
  height: 1080,
  duration_s: 12.5,
  fps: 30,
  audio_streams: 1,
  size_bytes: 1234,
  ms: 10,
  warnings: [],
});

const made = (dir: string, outputs: ExportOutput[]): ExportMade => ({
  version: 1,
  project: 'demo',
  render: 'quote-v1',
  scenario: 'quote',
  run_id: '20261114-093000-quote',
  master: { file: '/p/renders/quote-v1.mp4', record: '/p/renders/quote-v1.json', variant: 'landscape', width: 1920, height: 1080, duration_s: 12.5, fps: 30 },
  dir,
  outputs,
  failures: [{ format: 'gif_preview', error: 'ffmpeg failed' }],
});

describe('the place of an export', () => {
  it('is exports/<render id>/ of the project, or the output folder the caller names (resolved), whatever the render', () => {
    expect(exportPlace(diskOutputs.exports, '/w/projects/demo', undefined)('quote-v1')).toBe('/w/projects/demo/exports/quote-v1');
    expect(exportPlace(diskOutputs.exports, '/w/projects/demo', '/elsewhere/out/')('quote-v1')).toBe('/elsewhere/out');
  });
});

const adapters: Array<[string, () => Promise<{ outputs: Outputs; seed: (path: string, text: string) => Promise<void>; read: (path: string) => Promise<string | undefined> }>]> = [
  [
    'disk',
    async () => ({
      outputs: diskOutputs,
      seed: async (path, text) => {
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, text);
      },
      read: (path) => readFile(path, 'utf8').catch(() => undefined),
    }),
  ],
  [
    'memory',
    async () => {
      const m = new MemoryOutputs();
      return { outputs: m, seed: async (path, text) => void m.seed(path, text), read: (path) => m.exports.readText(path) };
    },
  ],
];

let n = 0;
for (const [name, make] of adapters) {
  describe(`the manifest of an export (${name})`, () => {
    it('is the result: the made formats in their order, stamped by the clock, in the form the editor wrote (two-space indent, a final newline)', async () => {
      const { outputs, read } = await make();
      const dir = join(temp, `m${++n}`, 'exports', 'quote-v1');
      const r = await writeExportManifest(outputs.exports, made(dir, [output(dir, 'webm'), output(dir, 'mp4_1080p', 'copy')]), new ManualClock('2026-11-14T09:30:00.000Z'));
      expect(r.manifest).toBe(join(dir, 'manifest.json'));
      expect(r.created_at).toBe('2026-11-14T09:30:00.000Z');
      expect(r.outputs.map((o) => o.format)).toEqual(['mp4_1080p', 'webm']);
      expect(Object.keys(r)).toEqual(['version', 'project', 'render', 'scenario', 'run_id', 'master', 'dir', 'manifest', 'created_at', 'outputs', 'failures']);
      expect(await read(r.manifest)).toBe(`${JSON.stringify(r, null, 2)}\n`);
    });

    it('keeps the formats exported earlier into the folder whose file is there, drops a missing one, one made again and another render’s', async () => {
      const { outputs, seed, read } = await make();
      const dir = join(temp, `m${++n}`, 'exports', 'quote-v1');
      const kept = output(dir, 'vertical_9x16', 'render');
      const gone = output(dir, 'square_1x1', 'render');
      const again = { ...output(dir, 'webm'), size_bytes: 1 };
      await seed(kept.file, 'vertical');
      await seed(again.file, 'old webm');
      await seed(join(dir, 'manifest.json'), JSON.stringify({ render: 'quote-v1', outputs: [kept, gone, again] }));
      const r = await writeExportManifest(outputs.exports, made(dir, [output(dir, 'webm')]), new ManualClock());
      expect(r.outputs).toEqual([output(dir, 'webm'), kept]);
      expect(JSON.parse((await read(r.manifest))!)).toEqual(r);

      // Another render's manifest in the folder (an output folder used twice): nothing of it is kept.
      await seed(join(dir, 'manifest.json'), JSON.stringify({ render: 'tour-v2', outputs: [kept] }));
      expect((await writeExportManifest(outputs.exports, made(dir, [output(dir, 'webm')]), new ManualClock())).outputs).toEqual([output(dir, 'webm')]);
      // A manifest that does not read: none kept, a new one written.
      await seed(join(dir, 'manifest.json'), '{ torn');
      expect((await writeExportManifest(outputs.exports, made(dir, [output(dir, 'webm')]), new ManualClock())).outputs).toEqual([output(dir, 'webm')]);
    });
  });
}

it('on the memory adapter nothing of the manifest reaches the disk', async () => {
  const m = new MemoryOutputs();
  const dir = join(temp, 'memory-only', 'exports', 'quote-v1');
  const r = await writeExportManifest(m.exports, made(dir, [output(dir, 'webm')]), new ManualClock());
  expect(existsSync(r.manifest)).toBe(false);
  expect(await m.exports.readText(r.manifest)).toBeDefined();
});
