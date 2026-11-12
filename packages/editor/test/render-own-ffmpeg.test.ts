/**
 * L7.3 a render whose frames this machine's ffmpeg encodes (editor render/render.ts over render/encode-tools.ts and
 * render/policy.ts `chooseEncode`), on real renders of the synthetic run: the frame encode — and nothing else — reaches
 * our ffmpeg, the record says which ffmpeg encoded, the file is what the library's ffmpeg makes of the same frames
 * (stream facts, audio, SSIM), and a failure of ours at the encode renders the video once more with the library's.
 * `auto` takes ours on the GPU path only; a render that falls back to software mid-way follows the rule of the path
 * its second attempt runs on, and its record says which ffmpeg encoded and why.
 * "Ours" is a script that notes each call and hands it to the real ffmpeg, so a test reads which calls it got.
 * The picture threshold (SSIM ≥ 0.995 on every frame against the library's encode) is asserted on this file's
 * 57-frame synthetic render at a quarter scale, where the worst frame measured 0.9974 with ffmpeg 9.0.2 (software
 * path) — a margin of 0.002; on the busier 1080p fixture render the worst frame measured 0.9954. One machine, one
 * ffmpeg: another version may round otherwise, and a failure here is a fact about that version's colour conversion,
 * to look at before it encodes renders.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import type { RenderSettings } from '@retake/core';
import { renderVideo } from '@retake/editor';
import type { RenderProgress } from '@retake/editor';
import { OWN_FRAME_FILTER, ownEncodeFailedEarlier, ownFfmpeg, readsImagePipe, resetOwnFfmpeg } from '../src/render/encode-tools.js';
import type { OwnFfmpeg } from '../src/render/encode-tools.js';
import { SHARED_CACHE, hasTool, renderWorkspace } from './render-helpers.js';
import type { RenderWorkspace } from './render-helpers.js';

const canRender = process.platform === 'darwin' && hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 400_000;
const SOFTWARE = { gl: 'software', encoder: 'libx264' } as const;

let ws: RenderWorkspace;
const scratch = mkdtempSync(join(tmpdir(), 'retake-own-ffmpeg-'));
const calls = join(scratch, 'calls.log');
const noting = join(scratch, 'noting-ffmpeg');
const failing = join(scratch, 'failing-ffmpeg');
/** The real ffmpeg of this machine, when it qualifies. */
let real: Extract<OwnFfmpeg, { ok: true }> | undefined;

/** The calls our ffmpeg got since the last read, one list of arguments each. */
function taken(): string[][] {
  if (!existsSync(calls)) return [];
  const lines = readFileSync(calls, 'utf8').split('\n').filter(Boolean);
  rmSync(calls);
  return lines.map((l) => JSON.parse(l) as string[]);
}

/** Of the calls our ffmpeg got, the frame encodes of a render (not the probe's three frames, made and encoded to nowhere). */
const frameEncodes = (all: string[][]) => all.filter((a) => readsImagePipe(a) && a[a.indexOf('-i') + 1] === '-' && !(a.at(-2) === 'null' && a.at(-1) === '-'));
/** The probe's calls: its frames (a lavfi source) and its encode to nowhere. */
const probeCalls = (all: string[][]) => all.filter((a) => a.includes('lavfi') || (a.at(-2) === 'null' && a.at(-1) === '-'));
const GPU = { gl: 'auto', encoder: 'auto' } as const;
const never = async (): Promise<OwnFfmpeg> => expect.unreachable("this machine's ffmpeg is not looked at");

/** Our ffmpeg for a render: the noting script (or `path`), with the real one's facts. */
const ours = (path: string) => async (): Promise<OwnFfmpeg> => ({ ok: true, path, facts: real!.facts });

const render = (name: string, settings: RenderSettings, o: Partial<Parameters<typeof renderVideo>[0]> = {}) =>
  renderVideo({
    workPolicy: PERSON_POLICY,
    project: ws.project,
    root: ws.root,
    run: 'latest',
    scenario: 'synthetic',
    overrides: { scale: 0.25 },
    cacheDir: SHARED_CACHE,
    out: join(ws.root, `${name}.mp4`),
    settings,
    ...o,
  });

function streams(file: string): string {
  return execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_name,profile,has_b_frames,pix_fmt,color_range,color_space,color_transfer,color_primaries,time_base,start_time,duration,nb_frames,sample_rate',
      '-of',
      'compact',
      file,
    ],
    { encoding: 'utf8' },
  );
}

const audioMd5 = (file: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-f', 'md5', '-'], { encoding: 'utf8' }).trim();

function ssimFrames(a: string, b: string): number[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', a, '-i', b, '-lavfi', '[0:v][1:v]ssim=stats_file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64e6 }).stdout;
  return out
    .split('\n')
    .map((l) => /All:([\d.]+)/.exec(l)?.[1])
    .filter((x): x is string => !!x)
    .map(Number);
}

beforeAll(async () => {
  if (!canRender) return;
  ws = await renderWorkspace();
  const which = execFileSync('/usr/bin/which', ['ffmpeg'], { encoding: 'utf8' }).trim();
  const { compositorDir } = await import('../src/render/library.js');
  const own = await ownFfmpeg({ resolve: () => which, compositorDir: await compositorDir() });
  if (!own.ok) return;
  real = own;
  // Node scripts the dispatcher starts in place of our ffmpeg: they note their arguments and hand them on.
  writeFileSync(
    noting,
    `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const r = spawnSync(${JSON.stringify(own.path)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status ?? 1);
`,
    { mode: 0o755 },
  );
  // It passes the probe (the real ffmpeg answers it) and fails the render's frame encode.
  writeFileSync(
    failing,
    `#!${process.execPath}
const a = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + '\\n');
if (a.includes('lavfi') || (a.at(-2) === 'null' && a.at(-1) === '-')) process.exit(require('node:child_process').spawnSync(${JSON.stringify(own.path)}, a, { stdio: 'inherit' }).status ?? 1);
process.stderr.write("ffmpeg version ${own.facts.version} Copyright (c) the FFmpeg developers\\nUnrecognized option 'video_track_timescale'.\\nError splitting the argument list: Option not found\\n");
process.exit(8);
`,
    { mode: 0o755 },
  );
}, LONG);
afterAll(async () => {
  resetOwnFfmpeg();
  await ws?.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(!canRender)("a render encoded by this machine's ffmpeg", () => {
  it(
    "own: the frame encode — one call, the library's arguments with our filter — goes to our ffmpeg and nothing else does; the record says so; the file is the library's but for the picture's rounding (SSIM ≥ 0.995, same streams, same audio)",
    async (ctx) => {
      if (!real) return ctx.skip();
      taken();
      const own = await render('own-sw', { ...SOFTWARE, ffmpeg: 'own' }, { seams: { ownFfmpeg: ours(noting) } });
      const all = taken();
      const got = frameEncodes(all);
      expect(got).toHaveLength(1);
      // Before it: the probe — three frames made, the frame encode on them to nowhere — and nothing else reached ours.
      expect(probeCalls(all)).toHaveLength(2);
      expect(all).toHaveLength(3);
      expect(got[0][got[0].indexOf('-vf') + 1]).toBe(OWN_FRAME_FILTER);
      expect(got[0]).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-video_track_timescale', '90000']));
      expect(own.policy?.ffmpeg).toEqual({ asked: 'own', source: 'option', used: 'own', version: real.facts.version });
      expect(own.policy).toMatchObject({ gl: { used: 'software' }, encoder: { used: 'libx264' } });
      expect(own.policy?.fallback).toBeUndefined();
      expect(own.warnings).toEqual([]);
      expect(own.frames).toBe(57);
      // The library's ffmpeg for the same render: no call reaches ours, and the record says which encoded.
      const lib = await render('lib-sw', { ...SOFTWARE, ffmpeg: 'library' }, { seams: { ownFfmpeg: ours(noting) } });
      expect(taken()).toEqual([]);
      expect(lib.policy?.ffmpeg).toEqual({ asked: 'library', source: 'option', used: 'library' });
      expect(lib.warnings).toEqual([]);
      expect(streams(own.file)).toBe(streams(lib.file));
      expect(streams(own.file)).toMatch(/codec_name=h264\|profile=High\|.*pix_fmt=yuv420p\|color_range=tv\|color_space=bt709\|color_transfer=bt709\|color_primaries=bt709\|time_base=1\/90000\|/);
      expect(audioMd5(own.file)).toBe(audioMd5(lib.file));
      const ssim = ssimFrames(own.file, lib.file);
      expect(ssim).toHaveLength(57);
      expect(Math.min(...ssim)).toBeGreaterThanOrEqual(0.995);
    },
    LONG,
  );

  it(
    'own on the GPU path: VideoToolbox is probed with our ffmpeg and encodes through it; a key frame every 2 s as before',
    async (ctx) => {
      if (!real?.facts.videotoolbox) return ctx.skip();
      taken();
      const gpu = await render('own-gpu', { gl: 'auto', encoder: 'auto', ffmpeg: 'own' }, { seams: { ownFfmpeg: ours(noting) } });
      if (gpu.policy?.gl.used !== 'angle') return ctx.skip(); // no GPU for this run (a VM): the software case above covers it
      const all = taken();
      const got = frameEncodes(all);
      expect(got).toHaveLength(1);
      expect(got[0]).toEqual(expect.arrayContaining(['-c:v', 'h264_videotoolbox', '-b:v', '1M', '-g', '60', '-vf', OWN_FRAME_FILTER]));
      // The probe ran the same encoder on ours first, at the render's size.
      expect(probeCalls(all).filter((a) => a.includes('h264_videotoolbox'))).toHaveLength(1);
      expect(gpu.policy).toMatchObject({ encoder: { used: 'h264_videotoolbox' }, ffmpeg: { asked: 'own', used: 'own', version: real.facts.version } });
      expect(gpu.policy?.fallback).toBeUndefined();
      expect(gpu.warnings).toEqual([]);
      expect(readFileSync(gpu.file).includes('x264 - core')).toBe(false);
      expect(streams(gpu.file)).toMatch(
        /codec_name=h264\|profile=High\|has_b_frames=0\|pix_fmt=yuv420p\|color_range=tv\|color_space=bt709\|color_transfer=bt709\|color_primaries=bt709\|time_base=1\/90000\|/,
      );
      const keys = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=key_frame', '-of', 'csv=p=0', gpu.file], { encoding: 'utf8' });
      expect(keys.split('\n').filter((l) => l.trim().split(',')[0] === '1')).toHaveLength(1);
    },
    LONG,
  );

  it(
    "auto on the software path: the library's ffmpeg encodes, ours is not looked at, and the record says it is the rule of that path",
    async (ctx) => {
      if (!real) return ctx.skip();
      taken();
      const res = await render('auto-sw', { ...SOFTWARE, ffmpeg: 'auto' }, { seams: { ownFfmpeg: never } });
      expect(taken()).toEqual([]);
      expect(res.policy?.ffmpeg).toEqual({ asked: 'auto', source: 'option', used: 'library', note: "auto: the rendering library's ffmpeg on the software path" });
      expect(res.warnings).toEqual([]);
      expect(res.frames).toBe(57);
    },
    LONG,
  );

  it(
    "auto on the GPU path: ours encodes; when the GPU path fails mid-way the video is rendered again in software with the library's — the rule of the path it then runs on — and the record says both",
    async (ctx) => {
      if (!real?.facts.videotoolbox) return ctx.skip();
      taken();
      const gpu = await render('auto-gpu', { ...GPU, ffmpeg: 'auto' }, { seams: { ownFfmpeg: ours(noting) } });
      if (gpu.policy?.gl.used !== 'angle') return ctx.skip(); // no GPU for this run (a VM)
      expect(frameEncodes(taken())).toHaveLength(1);
      expect(gpu.policy?.ffmpeg).toEqual({ asked: 'auto', source: 'option', used: 'own', version: real.facts.version });
      expect(gpu.warnings).toEqual([]);
      // The GPU itself fails (not the encoder): ours is not blamed, and the second attempt takes what auto gives in software.
      const res = await render(
        'auto-gpu-lost',
        { ...GPU, ffmpeg: 'auto' },
        { seams: { ownFfmpeg: ours(noting), failAfter: { attempt: 1, frames: 20, message: 'GPU process exited unexpectedly: exit_code=15' } } },
      );
      expect(frameEncodes(taken())).toHaveLength(1);
      expect(res.policy).toMatchObject({ gl: { used: 'software' }, encoder: { used: 'libx264' }, fallback: { reason: 'GPU process exited unexpectedly: exit_code=15' } });
      expect(res.policy?.ffmpeg).toEqual({ asked: 'auto', source: 'option', used: 'library', note: "auto: the rendering library's ffmpeg on the software path" });
      expect(res.warnings).toEqual(['the render failed on the GPU path (GPU process exited unexpectedly: exit_code=15) and was rendered again in software']);
      expect(ownEncodeFailedEarlier(noting)).toBe(false);
      expect(res.frames).toBe(57);
    },
    LONG,
  );

  it(
    'own by name follows its own rule on the second attempt too: after a failure of the GPU itself, ours encodes the software render',
    async (ctx) => {
      if (!real?.facts.videotoolbox || !real.facts.libx264) return ctx.skip();
      taken();
      const res = await render(
        'own-gpu-lost',
        { ...GPU, ffmpeg: 'own' },
        { seams: { ownFfmpeg: ours(noting), failAfter: { attempt: 1, frames: 20, message: 'GPU process exited unexpectedly: exit_code=15' } } },
      );
      if (!res.policy?.fallback) return ctx.skip(); // no GPU for this run: nothing fell back
      const got = frameEncodes(taken());
      expect(got.map((a) => a[a.indexOf('-c:v') + 1])).toEqual(['h264_videotoolbox', 'libx264']);
      expect(res.policy).toMatchObject({ gl: { used: 'software' }, encoder: { used: 'libx264' }, fallback: { reason: 'GPU process exited unexpectedly: exit_code=15' } });
      expect(res.policy.ffmpeg).toEqual({ asked: 'own', source: 'option', used: 'own', version: real.facts.version });
      expect(res.frames).toBe(57);
    },
    LONG,
  );

  it(
    "the hardware encoder's pipe closing while ours ran it is the GPU path's failure and ours at once: the record says both, the retry takes the library's, and ours is not taken again by this process",
    async (ctx) => {
      if (!real?.facts.videotoolbox) return ctx.skip();
      taken();
      try {
        const res = await render('own-gpu-pipe', { ...GPU, ffmpeg: 'auto' }, { seams: { ownFfmpeg: ours(noting), failAfter: { attempt: 1, frames: 20, message: 'write EPIPE' } } });
        if (!res.policy?.fallback) return ctx.skip(); // no GPU for this run
        expect(frameEncodes(taken())).toHaveLength(1);
        expect(res.policy.fallback).toEqual({ reason: 'write EPIPE' });
        expect(res.policy.ffmpeg).toEqual({
          asked: 'auto',
          source: 'option',
          used: 'library',
          version: real.facts.version,
          note: "this machine's ffmpeg failed at the encode: the video was rendered again with the rendering library's",
          failed: 'write EPIPE',
        });
        expect(res.warnings).toEqual(["the render failed on the GPU path (write EPIPE) while this machine's ffmpeg was encoding and was rendered again in software with the rendering library's"]);
        expect(ownEncodeFailedEarlier(noting)).toBe(true);
        // The next render of this process keeps the GPU path, with the library's ffmpeg, and says why.
        const next = await render('own-gpu-after', { ...GPU, ffmpeg: 'auto' }, { seams: { ownFfmpeg: ours(noting) } });
        expect(frameEncodes(taken())).toEqual([]);
        expect(next.policy).toMatchObject({
          gl: { used: 'angle' },
          ffmpeg: { asked: 'auto', used: 'library', note: `this machine's ffmpeg (${real.facts.version}) failed at an encode earlier in this process` },
        });
        expect(next.policy?.fallback).toBeUndefined();
        expect(next.warnings).toEqual([]);
      } finally {
        resetOwnFfmpeg();
      }
    },
    LONG,
  );

  it(
    "our ffmpeg failing at the encode: the video is rendered once more with the library's, said in the record and as a warning; progress never goes back",
    async (ctx) => {
      if (!real) return ctx.skip();
      taken();
      const progress: RenderProgress[] = [];
      const attempts: number[] = [];
      const res = await render('own-fails', { ...SOFTWARE, ffmpeg: 'own' }, { onProgress: (p) => progress.push(p), seams: { ownFfmpeg: ours(failing), beforeRender: (n) => void attempts.push(n) } });
      expect(attempts).toEqual([1, 2]);
      // Ours was started once, for the frames; the second attempt never reached it.
      expect(frameEncodes(taken())).toHaveLength(1);
      expect(res.policy?.ffmpeg).toMatchObject({ asked: 'own', source: 'option', used: 'library' });
      expect(res.policy?.ffmpeg?.failed).toMatch(/video_track_timescale|EPIPE|FFmpeg/);
      expect(res.policy?.ffmpeg?.note).toBe("this machine's ffmpeg failed at the encode: the video was rendered again with the rendering library's");
      // Not taken again by this process.
      expect(ownEncodeFailedEarlier(failing)).toBe(true);
      // Not a failure of the GPU path: that key keeps its meaning.
      expect(res.policy?.fallback).toBeUndefined();
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toMatch(/^the encode failed with this machine's ffmpeg \(.+\) and the video was rendered again in software with the rendering library's$/);
      expect(res.frames).toBe(57);
      expect(streams(res.file)).toMatch(/codec_name=h264\|.*nb_frames=57/);
      expect(progress.some((p) => p.stage === 'retrying')).toBe(true);
      for (let i = 1; i < progress.length; i++) expect(progress[i].overall, `event ${i}`).toBeGreaterThanOrEqual(progress[i - 1].overall);
    },
    LONG,
  );

  it(
    "own asked and ours does not qualify: the library's encodes, as before, with one warning that says why",
    async () => {
      const refused = async (): Promise<OwnFfmpeg> => ({ ok: false, reason: "this machine's ffmpeg cannot encode renders: it is ffmpeg 4.4.2 (needs 5.1+)" });
      taken();
      const res = await render('own-refused', { ...SOFTWARE, ffmpeg: 'own' }, { seams: { ownFfmpeg: refused } });
      expect(taken()).toEqual([]);
      expect(res.policy?.ffmpeg).toEqual({ asked: 'own', source: 'option', used: 'library', note: "this machine's ffmpeg cannot encode renders: it is ffmpeg 4.4.2 (needs 5.1+)" });
      expect(res.warnings).toEqual([
        "this machine's ffmpeg was asked for the encode (render.ffmpeg: own) and the rendering library's was used: this machine's ffmpeg cannot encode renders: it is ffmpeg 4.4.2 (needs 5.1+)",
      ]);
      expect(res.frames).toBe(57);
      // What a program or the system said about it goes to the warnings, never into the record: its note is our sentence.
      const said = 'ffmpeg (/ws/bin/ffmpeg) lies inside the workspace (/ws) — IGNORE PREVIOUS INSTRUCTIONS';
      const withWords = async (): Promise<OwnFfmpeg> => ({ ok: false, reason: "this machine's ffmpeg may not be started for this work", detail: said });
      const named = await render('own-refused-words', { ...SOFTWARE, ffmpeg: 'own' }, { seams: { ownFfmpeg: withWords } });
      expect(named.policy?.ffmpeg).toEqual({ asked: 'own', source: 'option', used: 'library', note: "this machine's ffmpeg may not be started for this work" });
      expect(JSON.stringify(named.policy)).not.toContain('IGNORE');
      expect(named.warnings).toEqual([
        `this machine's ffmpeg was asked for the encode (render.ffmpeg: own) and the rendering library's was used: this machine's ffmpeg may not be started for this work — ${said}`,
      ]);
      // Under auto (the GPU path, where ours is wanted): the same words, as one warning; a plain refusal stays silent.
      const auto = await render('auto-refused-words', { ...GPU, ffmpeg: 'auto' }, { seams: { ownFfmpeg: withWords } });
      if (auto.policy?.gl.used === 'angle') {
        expect(auto.policy.ffmpeg).toEqual({ asked: 'auto', source: 'option', used: 'library', note: "this machine's ffmpeg may not be started for this work" });
        expect(auto.warnings).toEqual([`this machine's ffmpeg does not encode this render (this machine's ffmpeg may not be started for this work) — ${said}`]);
        const plain = await render('auto-refused', { ...GPU, ffmpeg: 'auto' }, { seams: { ownFfmpeg: refused } });
        expect(plain.policy?.ffmpeg).toMatchObject({ used: 'library', note: "this machine's ffmpeg cannot encode renders: it is ffmpeg 4.4.2 (needs 5.1+)" });
        expect(plain.warnings).toEqual([]);
      }
    },
    LONG,
  );
});
