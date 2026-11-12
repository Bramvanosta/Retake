/**
 * `retake render` and `retake still` on a synthetic run (a tiny colour-coded capture, quarter size): the summary,
 * the files, `--json`, and the usage / lookup errors. Needs ffmpeg and a Chromium headless shell.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scenarioChangedMessage } from '@retake/core';
import { EXIT, main, memoryIo } from '../src/index.js';
import { encodingWords, glWords } from '../src/commands/render.js';
import { hasTool } from '@retake/test-support/repo';
import { renderWorkspace } from '@retake/test-support/render';
import type { RenderWorkspace } from '@retake/test-support/render';

const canRender = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 400_000;
let ws: RenderWorkspace;

async function retake(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', ws.root, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

beforeAll(async () => {
  if (canRender) ws = await renderWorkspace();
}, LONG);
afterAll(async () => {
  await ws?.cleanup();
});

describe("the summary's words for the render path (L5.15, review B L6)", () => {
  const encoding = { codec: 'h264', pixel_format: 'yuv420p', faststart: true, audio: 'silent' } as const;
  const policy = (used: 'angle' | 'software', fallback?: string) =>
    ({
      gl: { asked: 'auto', source: 'default', resolved: 'angle', used },
      encoder: { asked: 'auto', source: 'default', used: used === 'angle' ? 'h264_videotoolbox' : 'libx264' },
      concurrency_source: 'default',
      ...(fallback ? { fallback: { reason: fallback } } : {}),
    }) as const;
  it('on the GPU, in software, in software after a GPU failure (never its reason); an old record: libx264 CRF 16, in software', () => {
    expect(glWords({ policy: policy('angle') })).toBe('on the GPU');
    expect(glWords({ policy: policy('software') })).toBe('in software');
    expect(glWords({ policy: policy('software', 'WebGL context lost — said by a component') })).toBe('in software after a GPU failure');
    expect(glWords({})).toBe('in software');
    expect(encodingWords({ encoding: { ...encoding, encoder: 'h264_videotoolbox', bitrate: '8M', gop: 60 } })).toBe('h264 VideoToolbox 8M');
    expect(encodingWords({ encoding: { ...encoding, encoder: 'libx264', crf: 16 } })).toBe('h264 crf 16');
    // A record of before L5.15: no encoder, its crf.
    expect(encodingWords({ encoding: { ...encoding, crf: 16 } })).toBe('h264 crf 16');
    expect(encodingWords({ encoding: { ...encoding } })).toBe('h264 crf 16');
  });

  it("L7.3: a render rendered again after this machine's ffmpeg failed at the encode says so (never the failure's words); one it encoded reads as any other", () => {
    const ffmpeg = { asked: 'auto', source: 'default' } as const;
    expect(glWords({ policy: { ...policy('software'), ffmpeg: { ...ffmpeg, used: 'library', version: '7.1.1', failed: 'Unrecognized option — said by a file name' } } })).toBe(
      "in software after this machine's ffmpeg failed at the encode",
    );
    expect(glWords({ policy: { ...policy('angle'), ffmpeg: { ...ffmpeg, used: 'own', version: '7.1.1' } } })).toBe('on the GPU');
    expect(glWords({ policy: { ...policy('software'), ffmpeg: { ...ffmpeg, used: 'library', note: 'no ffmpeg found on this machine' } } })).toBe('in software');
    // The GPU path's own failure keeps its words.
    expect(glWords({ policy: { ...policy('software', 'WebGL context lost'), ffmpeg: { ...ffmpeg, used: 'library' } } })).toBe('in software after a GPU failure');
  });
});

describe.skipIf(!canRender)('retake render / still', () => {
  it(
    'renders the latest capture of a scenario into renders/<scenario>-v1.mp4 with a summary',
    async () => {
      const r = await retake('render', 'demo', 'synthetic', '--scale', '0.25', '--concurrency', '2');
      expect(r.code, r.err).toBe(EXIT.ok);
      expect(r.err).toMatch(/✓ rendered synthetic-v1 → .*renders\/synthetic-v1\.mp4/);
      expect(r.err).toMatch(/1\.90 s · 57 frames @ 30 fps · 480×270 · [\d.]+ KB · h264 crf 16, silent audio · checked: 1\.9\d s, 480×270, 1 audio track/);
      expect(r.err).toMatch(/theme editorial · run 20260101-120000-synthetic · bundle (cached|built in .*) · render .* \(concurrency 2\) in software/);
      expect(r.err).not.toContain('changed since'); // no scenario file: nothing to compare
      const renders = join(ws.project.dir, 'renders');
      expect((await readdir(renders)).sort()).toEqual(['synthetic-v1.json', 'synthetic-v1.mp4']);
    },
    LONG,
  );

  it(
    '--json prints the record without the plan; the next render takes the next version; a filmed part changed since the capture is warned about first (L3.8, L5.5)',
    async () => {
      // The run's snapshot and a scenario file edited since: the render shows the run as captured, and says so on stderr.
      const snapshot = 'video: Synthetic\nscenes:\n  - id: a\n    page: app\n    open: /\n    steps:\n      - hold: 1\n';
      await writeFile(join(ws.runDir, 'scenario.yaml'), snapshot);
      await mkdir(join(ws.project.dir, 'scenarios'), { recursive: true });
      await writeFile(join(ws.project.dir, 'scenarios', 'synthetic.yml'), snapshot.replace('hold: 1', 'hold: 3'));
      const r = await retake('render', 'demo', 'synthetic', '--scale', '0.25', '--no-intro', '--json');
      expect(r.code, r.err).toBe(EXIT.ok);
      expect(r.err).toContain(`! ${scenarioChangedMessage('synthetic', '20260101-120000-synthetic', '`retake run demo synthetic`', ['scene a: step a.0 changed'])}`);
      const rec = JSON.parse(r.out) as Record<string, unknown>;
      expect(rec).toMatchObject({ id: 'synthetic-v2', status: 'succeeded', frames: 57, width: 480, height: 270, overrides: { scale: 0.25, intro: false } });
      expect(rec.plan).toBeUndefined();
      expect(existsSync(rec.file as string)).toBe(true);
      await rm(join(ws.project.dir, 'scenarios'), { recursive: true, force: true });
    },
    LONG,
  );

  it.skipIf(process.platform !== 'darwin')(
    'L5.15: on the GPU path (this Mac, opted in), the summary says VideoToolbox and the GPU',
    async () => {
      const saved = { gl: process.env.RETAKE_RENDER_GL, enc: process.env.RETAKE_RENDER_ENCODER };
      try {
        process.env.RETAKE_RENDER_GL = 'auto';
        process.env.RETAKE_RENDER_ENCODER = 'auto';
        const r = await retake('render', 'demo', 'synthetic', '--scale', '0.25', '--out', join(ws.root, 'gpu.mp4'));
        expect(r.code, r.err).toBe(EXIT.ok);
        expect(r.err).toMatch(/480×270 · [\d.]+ KB · h264 VideoToolbox 1M, silent audio/);
        expect(r.err).toMatch(/render .* \(concurrency 3\) on the GPU · total/);
      } finally {
        process.env.RETAKE_RENDER_GL = saved.gl;
        process.env.RETAKE_RENDER_ENCODER = saved.enc;
      }
    },
    LONG,
  );

  it(
    'still: one frame as a PNG (renders/stills/ by default)',
    async () => {
      const r = await retake('still', 'demo', 'synthetic', '--frame', '40', '--json');
      expect(r.code, r.err).toBe(EXIT.ok);
      const res = JSON.parse(r.out) as { file: string; frame: number; segment: string; width: number };
      expect(res).toMatchObject({ frame: 40, segment: 'b', width: 1920 });
      expect(res.file).toBe(join(ws.project.dir, 'renders', 'stills', 'synthetic-f00040.png'));
      expect(existsSync(res.file)).toBe(true);
      const human = await retake('still', 'demo', 'synthetic', '--frame', '3', '--out', join(ws.root, 'f3.png'));
      expect(human.code, human.err).toBe(EXIT.ok);
      expect(human.err).toMatch(/✓ frame 3 \(0\.10 s, clip a\) → /);
    },
    LONG,
  );

  it(
    'reports bad options and unknown runs',
    async () => {
      const frame = await retake('render', 'demo', 'synthetic', '--frame', 'Fancy Frame');
      expect(frame.code).toBe(EXIT.usage);
      expect(frame.err).toContain('--frame "Fancy Frame"');
      const scale = await retake('render', 'demo', 'synthetic', '--scale', '0');
      expect(scale.code).toBe(EXIT.usage);
      expect(scale.err).toContain('--scale "0"');
      const run = await retake('render', 'demo', 'synthetic', '--run', 'nope');
      expect(run.code).toBe(EXIT.failure);
      expect(run.err).toContain('run "nope" not found');
      const scenario = await retake('render', 'demo', 'ghost');
      expect(scenario.code).toBe(EXIT.failure);
      expect(scenario.err).toContain('no capture run of scenario "ghost"');
      expect((await retake('still', 'demo', 'synthetic')).code).toBe(EXIT.usage);
      const past = await retake('still', 'demo', 'synthetic', '--frame', '999');
      expect(past.code).toBe(EXIT.failure);
      expect(past.err).toContain('past the end of the video (57 frames');
    },
    LONG,
  );

  it(
    '--review reviews the render right after it',
    async () => {
      const r = await retake('render', 'demo', 'synthetic', '--scale', '0.25', '--concurrency', '2', '--review');
      expect(r.code, r.err).toBe(EXIT.ok);
      const id = /✓ rendered (synthetic-v\d+)/.exec(r.err)?.[1];
      expect(id).toBeDefined();
      // Every frame of the colour-coded capture is one solid colour: the review sees blank screens (errors), and a
      // 1.9 s video far from the 1–2 min target.
      expect(r.err).toMatch(new RegExp(`✗ review ${id} \\(1\\.90 s, 2 segments\\) → .*review/${id}`));
      expect(r.err).toMatch(/error {3}\[00:00\.0 · f0 · a\] scene "a" starts on a blank screen \(capture frame 30\)/);
      expect(r.err).toMatch(/warning the video lasts 1\.9 s/);
      expect(existsSync(join(ws.project.dir, 'review', id!, 'report.json'))).toBe(true);
      const json = await retake('render', 'demo', 'synthetic', '--scale', '0.25', '--concurrency', '2', '--review', '--json', '--no-intro');
      expect(json.code, json.err).toBe(EXIT.ok);
      const rec = JSON.parse(json.out) as { id: string; review: { render: { id: string }; clean: boolean; files: { report_md: string } } };
      expect(rec.review.render.id).toBe(rec.id);
      expect(rec.review.clean).toBe(false);
      expect(existsSync(rec.review.files.report_md)).toBe(true);
    },
    LONG,
  );
  it(
    'export: the master transcoded (WebM, GIF) into exports/<render>/ + manifest.json; --square renders a square variant',
    async () => {
      const r = await retake('export', 'demo', 'synthetic-v1', '--formats', 'webm,gif_preview');
      expect(r.code, r.err).toBe(EXIT.ok);
      expect(r.err).toMatch(/export synthetic-v1 \(480×270, 1\.90 s\) → .*exports\/synthetic-v1/);
      expect(r.err).toMatch(/✓ WebM \(VP9\) {3}.*synthetic-v1\.webm {2}1920×1080 vp9 \+ opus, 1\.9\d s/);
      expect(r.err).toMatch(/✓ GIF preview {3}.*synthetic-v1-preview\.gif {2}480×270 gif, 1\.9\d s, 0\.0–1\.9 s \(first\)/);
      const dir = join(ws.project.dir, 'exports', 'synthetic-v1');
      expect((await readdir(dir)).sort()).toEqual(['manifest.json', 'synthetic-v1-preview.gif', 'synthetic-v1.webm']);
      const json = await retake('export', 'demo', 'latest', '--formats', 'gif_preview', '--gif-start', '0.5', '--json');
      expect(json.code, json.err).toBe(EXIT.ok);
      const m = JSON.parse(json.out) as { render: string; outputs: Array<{ format: string; window?: { start_s: number } }> };
      expect(m.outputs.find((o) => o.format === 'gif_preview')?.window?.start_s).toBe(0.5);
      const sq = await retake('render', 'demo', 'synthetic', '--square', '--scale', '0.25', '--concurrency', '2', '--json');
      expect(sq.code, sq.err).toBe(EXIT.ok);
      expect(JSON.parse(sq.out)).toMatchObject({ variant: 'square', width: 270, height: 270 });
      expect((await retake('render', 'demo', 'synthetic', '--square', '--vertical')).code).toBe(EXIT.usage);
    },
    LONG,
  );
});
