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
    expect(chosen).toEqual({ status: 'ok', name: 'Renders', detail: 'software · libx264 CRF 16 · 4 frames at a time · set: gl software ($RETAKE_RENDER_GL), concurrency 4 (retake.yaml render.concurrency)' });
    const linux = rendersCheck({ policy: resolveRenderPolicy({ platform: 'linux', cpus: 4 }), gl: 'software', encoder: 'libx264', concurrency: 3 });
    expect(linux).toMatchObject({ status: 'ok', detail: 'software (no GPU path on linux) · libx264 CRF 16 · 3 frames at a time' });
  });

  it('a setting that cannot work: FAIL (every render would fail); gpu forced without a GPU: WARN', () => {
    expect(rendersCheck({ error: '$RETAKE_RENDER_GL is "swangle": use auto, gpu, software' })).toMatchObject({ status: 'fail', detail: '$RETAKE_RENDER_GL is "swangle": use auto, gpu, software' });
    const vt = rendersCheck({ policy: mac({ workspace: { encoder: 'videotoolbox' } }), gl: 'angle', gpu: metal, videotoolbox: { ok: false, error: 'x' }, error: 'VideoToolbox does not encode here (x)', concurrency: 3 });
    expect(vt.status).toBe('fail');
    const forced = rendersCheck({ policy: mac({ workspace: { gl: 'gpu' } }), gl: 'angle', gpu: { accelerated: false, renderer: 'SwiftShader' }, encoder: 'libx264', concurrency: 3 });
    expect(forced.status).toBe('warn');
    expect(forced.detail).toMatch(/^ANGLE without a GPU \(SwiftShader\)/);
  });
});

describe.skipIf(process.platform !== 'darwin')('the real probe on this Mac', () => {
  it('auto: the render browser on the GPU (Metal), VideoToolbox at 1080p, 3 frames at a time — one OK line', async () => {
    const saved = { gl: process.env.RETAKE_RENDER_GL, enc: process.env.RETAKE_RENDER_ENCODER };
    try {
      process.env.RETAKE_RENDER_GL = 'auto';
      process.env.RETAKE_RENDER_ENCODER = 'auto';
      const r = await probeRenderPath({ workPolicy: PERSON_POLICY });
      expect(r).toMatchObject({ gl: 'angle', encoder: 'h264_videotoolbox', concurrency: 3, videotoolbox: { ok: true }, gpu: { accelerated: true } });
      const c = rendersCheck(r);
      expect(c.status).toBe('ok');
      expect(c.detail).toMatch(/^GPU \(.*Metal.*\) · VideoToolbox H\.264 · 3 frames at a time · set: gl auto \(\$RETAKE_RENDER_GL\), encoder auto \(\$RETAKE_RENDER_ENCODER\)$/);
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
