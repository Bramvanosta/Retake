/**
 * L5.15 `retake doctor`'s "Renders" line (doctor.ts rendersCheck over editor probeRenderPath): the GPU path (the render
 * browser's GPU, VideoToolbox, 3 frames at a time), the software path by choice or by platform, the warnings (auto
 * found no GPU; VideoToolbox does not work), the failure (a setting that cannot work), and where a setting came from.
 * The real probe on this Mac (darwin, opted in to `auto`) says the GPU and VideoToolbox.
 */
import { describe, expect, it } from 'vitest';
import { probeRenderPath, resolveRenderPolicy } from '@retake/editor';
import { rendersCheck } from '../src/commands/doctor.js';
import type { RendersProbe } from '../src/commands/doctor.js';
import { PERSON_POLICY } from '@retake/core';

const metal = { accelerated: true, renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)' };
const mac = (o: Parameters<typeof resolveRenderPolicy>[0] = {}) => resolveRenderPolicy({ platform: 'darwin', cpus: 10, ...o });

describe('the Renders line', () => {
  it('the GPU path: OK with the GPU, the encoder and the frames at a time', () => {
    const r: RendersProbe = { policy: mac(), gpu: metal, gl: 'angle', videotoolbox: { ok: true }, encoder: 'h264_videotoolbox', concurrency: 3 };
    expect(rendersCheck(r)).toEqual({ status: 'ok', name: 'Renders', detail: `GPU (${metal.renderer}) · VideoToolbox H.264 · 3 frames at a time` });
  });

  it('auto found no GPU: WARN, renders in software (and why it matters)', () => {
    const c = rendersCheck({ policy: mac(), gpu: { accelerated: false, renderer: 'SwiftShader' }, gl: 'software', encoder: 'libx264', concurrency: 7 });
    expect(c.status).toBe('warn');
    expect(c.detail).toBe('no GPU found for renders (SwiftShader): software · libx264 CRF 16 · 7 frames at a time');
    expect(c.hint).toMatch(/2\.5× the CPU/);
  });

  it('VideoToolbox not working under auto: WARN with its error; libx264 said', () => {
    const c = rendersCheck({ policy: mac(), gpu: metal, gl: 'angle', videotoolbox: { ok: false, error: 'cannot create compression session: -12903' }, encoder: 'libx264', concurrency: 3 });
    expect(c.status).toBe('warn');
    expect(c.detail).toMatch(/VideoToolbox does not work here \(cannot create compression session: -12903\): libx264 CRF 16 · 3 frames at a time$/);
  });

  it('software by choice or by platform: OK, the setting and its source said', () => {
    const chosen = rendersCheck({ policy: mac({ env: { RETAKE_RENDER_GL: 'software' }, workspace: { concurrency: 4 } }), gl: 'software', encoder: 'libx264', concurrency: 4 });
    expect(chosen).toEqual({
      status: 'ok',
      name: 'Renders',
      detail: 'software · libx264 CRF 16 · 4 frames at a time · set: gl software ($RETAKE_RENDER_GL), concurrency 4 (retake.yaml render.concurrency)',
    });
    const linux = rendersCheck({ policy: resolveRenderPolicy({ platform: 'linux', cpus: 4 }), gl: 'software', encoder: 'libx264', concurrency: 3 });
    expect(linux).toMatchObject({ status: 'ok', detail: 'software (no GPU path on linux) · libx264 CRF 16 · 3 frames at a time' });
  });

  it('a setting that cannot work: FAIL (every render would fail); gpu forced without a GPU: WARN', () => {
    expect(rendersCheck({ error: '$RETAKE_RENDER_GL is "swangle": use auto, gpu, software' })).toMatchObject({ status: 'fail', detail: '$RETAKE_RENDER_GL is "swangle": use auto, gpu, software' });
    const vt = rendersCheck({
      policy: mac({ workspace: { encoder: 'videotoolbox' } }),
      gl: 'angle',
      gpu: metal,
      videotoolbox: { ok: false, error: 'x' },
      error: 'VideoToolbox does not encode here (x)',
      concurrency: 3,
    });
    expect(vt.status).toBe('fail');
    const forced = rendersCheck({ policy: mac({ workspace: { gl: 'gpu' } }), gl: 'angle', gpu: { accelerated: false, renderer: 'SwiftShader' }, encoder: 'libx264', concurrency: 3 });
    expect(forced.status).toBe('warn');
    expect(forced.detail).toMatch(/^ANGLE without a GPU \(SwiftShader\)/);
  });

  it("L7.3 the ffmpeg that encodes the frames: ours named with its version; the library's with the reason when ours was wanted — a WARN only when own was asked by name; nothing more on a line where the library's is the choice", () => {
    const base = { gpu: metal, gl: 'angle' as const, videotoolbox: { ok: true }, encoder: 'h264_videotoolbox' as const, concurrency: 3 };
    const own = rendersCheck({ ...base, policy: mac({ workspace: { ffmpeg: 'own' } }), ffmpeg: { used: 'own', version: '7.1.1' } });
    expect(own).toEqual({
      status: 'ok',
      name: 'Renders',
      detail: `GPU (${metal.renderer}) · VideoToolbox H.264 (this machine's ffmpeg 7.1.1) · 3 frames at a time · set: ffmpeg own (retake.yaml render.ffmpeg)`,
    });
    const software = rendersCheck({
      policy: mac({ env: { RETAKE_RENDER_GL: 'software', RETAKE_RENDER_FFMPEG: 'own' } }),
      gl: 'software',
      encoder: 'libx264',
      concurrency: 7,
      ffmpeg: { used: 'own', version: '7.1.1' },
    });
    expect(software).toEqual({
      status: 'ok',
      name: 'Renders',
      detail: "software · libx264 CRF 16 (this machine's ffmpeg 7.1.1) · 7 frames at a time · set: gl software ($RETAKE_RENDER_GL), ffmpeg own ($RETAKE_RENDER_FFMPEG)",
    });
    // Asked by name and not usable: renders work (the library's), the line warns and says why.
    const refused = rendersCheck({
      ...base,
      policy: mac({ workspace: { ffmpeg: 'own' } }),
      ffmpeg: { used: 'library', version: '4.4.2', note: "this machine's ffmpeg cannot encode renders: it is ffmpeg 4.4.2 (needs 5.1+)" },
    });
    expect(refused.status).toBe('warn');
    expect(refused.detail).toBe(
      `GPU (${metal.renderer}) · VideoToolbox H.264 (the rendering library's ffmpeg: this machine's ffmpeg cannot encode renders: it is ffmpeg 4.4.2 (needs 5.1+)) · 3 frames at a time · set: ffmpeg own (retake.yaml render.ffmpeg)`,
    );
    expect(refused.hint).toMatch(/render ffmpeg: own is set .* they use the rendering library's/);
    // The same under auto: said, no warning (a machine without a usable ffmpeg of its own is ordinary).
    const auto = rendersCheck({ ...base, policy: mac(), ffmpeg: { used: 'library', note: 'no ffmpeg found on this machine' } });
    expect(auto).toEqual({
      status: 'ok',
      name: 'Renders',
      detail: `GPU (${metal.renderer}) · VideoToolbox H.264 (the rendering library's ffmpeg: no ffmpeg found on this machine) · 3 frames at a time`,
    });
    // The library's by choice, or a probe of before L7.3: the line of before.
    const library = rendersCheck({ ...base, policy: mac({ workspace: { ffmpeg: 'library' } }), ffmpeg: { used: 'library' } });
    expect(library).toEqual({ status: 'ok', name: 'Renders', detail: `GPU (${metal.renderer}) · VideoToolbox H.264 · 3 frames at a time · set: ffmpeg library (retake.yaml render.ffmpeg)` });
    expect(rendersCheck({ ...base, policy: mac(), ffmpeg: { used: 'library' } }).detail).toBe(`GPU (${metal.renderer}) · VideoToolbox H.264 · 3 frames at a time`);
    // auto where its rule keeps the library's (the software path, the desktop app): the line of before, no reason to give.
    const byRule = rendersCheck({
      policy: mac({ env: { RETAKE_RENDER_GL: 'software' } }),
      gl: 'software',
      encoder: 'libx264',
      concurrency: 7,
      ffmpeg: { used: 'library', note: "auto: the rendering library's ffmpeg on the software path", byRule: true },
    });
    expect(byRule).toEqual({ status: 'ok', name: 'Renders', detail: 'software · libx264 CRF 16 · 7 frames at a time · set: gl software ($RETAKE_RENDER_GL)' });
    // A warning of the line itself keeps its own hint.
    const noGpu = rendersCheck({
      policy: mac({ workspace: { ffmpeg: 'own' } }),
      gpu: { accelerated: false, renderer: 'SwiftShader' },
      gl: 'software',
      encoder: 'libx264',
      concurrency: 7,
      ffmpeg: { used: 'library', note: 'no ffmpeg found on this machine' },
    });
    expect(noGpu).toMatchObject({ status: 'warn', hint: expect.stringMatching(/2\.5× the CPU/) });
    expect(noGpu.detail).toMatch(/libx264 CRF 16 \(the rendering library's ffmpeg: no ffmpeg found on this machine\)/);
  });
});

describe.skipIf(process.platform !== 'darwin')('the real probe on this Mac', () => {
  it("L7.3 the probe says which ffmpeg would encode, as a render chooses it and without writing its folder: ours when asked and usable, the library's with the reason otherwise", async () => {
    const saved = process.env.RETAKE_RENDER_FFMPEG;
    const facts = { version: '7.1.1', libx264: true, videotoolbox: true, filter: true };
    try {
      process.env.RETAKE_RENDER_FFMPEG = 'own';
      const encodes = async () => ({ ok: true });
      const own = await probeRenderPath({ workPolicy: PERSON_POLICY, ownEncodes: encodes, own: async () => ({ ok: true, path: '/opt/tools/ffmpeg', facts }) });
      expect(own).toMatchObject({ gl: 'software', encoder: 'libx264', ffmpeg: { used: 'own', version: '7.1.1' } });
      expect(own.ffmpeg?.binariesDirectory).toBeUndefined();
      expect(rendersCheck(own).detail).toMatch(/^software · libx264 CRF 16 \(this machine's ffmpeg 7\.1\.1\) · .* ffmpeg own \(\$RETAKE_RENDER_FFMPEG\)$/);
      const none = await probeRenderPath({ workPolicy: PERSON_POLICY, own: async () => ({ ok: false, reason: 'no ffmpeg found on this machine' }) });
      expect(none.ffmpeg).toEqual({ used: 'library', note: 'no ffmpeg found on this machine' });
      expect(rendersCheck(none)).toMatchObject({ status: 'warn', detail: expect.stringMatching(/\(the rendering library's ffmpeg: no ffmpeg found on this machine\)/) });
      // It does not run the frame encode: said, with the warning of a setting that asked for it by name.
      const cannot = await probeRenderPath({
        workPolicy: PERSON_POLICY,
        ownEncodes: async () => ({ ok: false, error: 'Unrecognized option' }),
        own: async () => ({ ok: true, path: '/opt/tools/ffmpeg', facts }),
      });
      expect(cannot.ffmpeg).toMatchObject({ used: 'library', note: "this machine's ffmpeg (7.1.1) does not run the frame encode" });
      expect(rendersCheck(cannot)).toMatchObject({
        status: 'warn',
        detail: expect.stringMatching(/\(the rendering library's ffmpeg: this machine's ffmpeg \(7\.1\.1\) does not run the frame encode\)/),
      });
      process.env.RETAKE_RENDER_FFMPEG = 'library';
      const library = await probeRenderPath({ workPolicy: PERSON_POLICY, own: async () => expect.unreachable('ours is not looked at') });
      expect(library.ffmpeg).toEqual({ used: 'library' });
      // auto on the software path (the suite's): the library's by the rule, ours not looked at, the line of before.
      process.env.RETAKE_RENDER_FFMPEG = 'auto';
      const auto = await probeRenderPath({ workPolicy: PERSON_POLICY, own: async () => expect.unreachable('ours is not looked at') });
      expect(auto).toMatchObject({ gl: 'software', ffmpeg: { used: 'library', note: "auto: the rendering library's ffmpeg on the software path", byRule: true } });
      expect(rendersCheck(auto).detail).toMatch(/^software · libx264 CRF 16 · \d+ frames at a time · set: .*ffmpeg auto \(\$RETAKE_RENDER_FFMPEG\)$/);
    } finally {
      if (saved === undefined) delete process.env.RETAKE_RENDER_FFMPEG;
      else process.env.RETAKE_RENDER_FFMPEG = saved;
    }
  });

  it('auto: the render browser on the GPU (Metal), VideoToolbox at 1080p, 3 frames at a time — one OK line', async () => {
    const saved = { gl: process.env.RETAKE_RENDER_GL, enc: process.env.RETAKE_RENDER_ENCODER };
    try {
      process.env.RETAKE_RENDER_GL = 'auto';
      process.env.RETAKE_RENDER_ENCODER = 'auto';
      const r = await probeRenderPath({ workPolicy: PERSON_POLICY });
      expect(r).toMatchObject({ gl: 'angle', encoder: 'h264_videotoolbox', concurrency: 3, videotoolbox: { ok: true }, gpu: { accelerated: true } });
      const c = rendersCheck(r);
      expect(c.status).toBe('ok');
      expect(c.detail).toMatch(
        /^GPU \(.*Metal.*\) · VideoToolbox H\.264 · 3 frames at a time · set: gl auto \(\$RETAKE_RENDER_GL\), encoder auto \(\$RETAKE_RENDER_ENCODER\)(?:, ffmpeg library \(\$RETAKE_RENDER_FFMPEG\))?$/,
      );
    } finally {
      process.env.RETAKE_RENDER_GL = saved.gl;
      process.env.RETAKE_RENDER_ENCODER = saved.enc;
    }
  }, 120_000);

  it('the suite pin (software): no browser opened, the software line', async () => {
    const r = await probeRenderPath({ workPolicy: PERSON_POLICY, gpuInfo: async () => expect.unreachable('no browser on the software path') });
    expect(r).toMatchObject({ gl: 'software', encoder: 'libx264' });
    expect(r.videotoolbox).toBeUndefined();
    expect(rendersCheck(r).detail).toMatch(/^software · libx264 CRF 16/);
  });
});
