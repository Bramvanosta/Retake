/**
 * L5.15 render policy (editor render/policy.ts), pure parts: the settings order (option → retake.yaml → env → auto),
 * what `auto` resolves to per platform (ANGLE on macOS, software elsewhere — never swangle), the defaults (3 frames at
 * a time on the GPU path, ¾ of the CPUs in software), the variables' errors, VideoToolbox's bitrate / GOP / size gate,
 * Remotion's encoding fields (`required`, never `crf` with it), the encoder choice and the fallback's classifier.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkspaceFileSchema, renderSettingsFromEnv } from '@retake/core';
import {
  GPU_CONCURRENCY,
  RenderCancelledError,
  RenderDiskFullError,
  RenderError,
  VIDEOTOOLBOX_MAX_SIDE,
  chooseEncoder,
  defaultConcurrency,
  encodingRecord,
  exportRenderWarnings,
  gopFrames,
  gpuPathFailure,
  openRenderBrowser,
  remotionEncoding,
  resolveRenderPolicy,
  videotoolboxFits,
  videotoolboxMbps,
  withGl,
} from '@retake/editor';

const mac = (o: Parameters<typeof resolveRenderPolicy>[0] = {}) => resolveRenderPolicy({ platform: 'darwin', cpus: 10, ...o });
const linux = (o: Parameters<typeof resolveRenderPolicy>[0] = {}) => resolveRenderPolicy({ platform: 'linux', cpus: 4, ...o });

describe('the settings', () => {
  it('auto: ANGLE on macOS at 3 frames at a time; software elsewhere at ¾ of the CPUs (1–8)', () => {
    expect(mac()).toMatchObject({ gl: { asked: 'auto', resolved: 'angle', source: 'default' }, encoder: { asked: 'auto' }, concurrency: GPU_CONCURRENCY, concurrencySource: 'default' });
    expect(GPU_CONCURRENCY).toBe(3);
    expect(linux()).toMatchObject({ gl: { asked: 'auto', resolved: 'software' }, concurrency: 3 });
    expect(resolveRenderPolicy({ platform: 'win32', cpus: 16 })).toMatchObject({ gl: { resolved: 'software' }, concurrency: 8 });
    expect(defaultConcurrency(10)).toBe(7);
    expect(defaultConcurrency(1)).toBe(1);
    expect(defaultConcurrency(64)).toBe(8);
  });

  it('gpu forces ANGLE anywhere, software forces the software path (and its default concurrency)', () => {
    expect(linux({ env: { RETAKE_RENDER_GL: 'gpu' } })).toMatchObject({ gl: { asked: 'gpu', resolved: 'angle', source: 'env' }, concurrency: 3 });
    expect(mac({ env: { RETAKE_RENDER_GL: 'software' } })).toMatchObject({ gl: { asked: 'software', resolved: 'software' }, concurrency: 7 });
  });

  it('the order: an option over retake.yaml over the environment over auto (as `ffmpeg`)', () => {
    const env = { RETAKE_RENDER_GL: 'gpu', RETAKE_RENDER_ENCODER: 'libx264', RETAKE_RENDER_CONCURRENCY: '5' };
    expect(mac({ env })).toMatchObject({ gl: { asked: 'gpu', source: 'env' }, encoder: { asked: 'libx264', source: 'env' }, concurrency: 5, concurrencySource: 'env' });
    const workspace = { gl: 'software' as const, concurrency: 2 };
    expect(mac({ env, workspace })).toMatchObject({ gl: { asked: 'software', source: 'retake.yaml' }, encoder: { asked: 'libx264', source: 'env' }, concurrency: 2, concurrencySource: 'retake.yaml' });
    expect(mac({ env, workspace, option: { concurrency: 9, gl: 'auto' } })).toMatchObject({ gl: { asked: 'auto', source: 'option', resolved: 'angle' }, concurrency: 9, concurrencySource: 'option' });
  });

  it('a bad variable names itself; blank ones are unset; videotoolbox outside macOS is a clear error, never another encoder', () => {
    expect(() => mac({ env: { RETAKE_RENDER_GL: 'swangle' } })).toThrow(/\$RETAKE_RENDER_GL is "swangle": use auto, gpu, software/);
    expect(() => mac({ env: { RETAKE_RENDER_ENCODER: 'nvenc' } })).toThrow(/\$RETAKE_RENDER_ENCODER is "nvenc"/);
    for (const v of ['0', '17', '2.5', 'many']) expect(() => mac({ env: { RETAKE_RENDER_CONCURRENCY: v } }), v).toThrow(/\$RETAKE_RENDER_CONCURRENCY is ".*": use a whole number from 1 to 16/);
    expect(() => mac({ env: { RETAKE_RENDER_GL: 'swangle' } })).toThrow(RenderError);
    expect(renderSettingsFromEnv({ RETAKE_RENDER_GL: '  ', RETAKE_RENDER_ENCODER: '' })).toEqual({});
    expect(() => linux({ env: { RETAKE_RENDER_ENCODER: 'videotoolbox' } })).toThrow(/videotoolbox \(\$RETAKE_RENDER_ENCODER\) works only on macOS/);
    expect(() => linux({ workspace: { encoder: 'videotoolbox' } })).toThrow(/retake\.yaml render\.encoder/);
    expect(() => mac({ workspace: { concurrency: 40 } })).toThrow(/from 1 to 16/);
  });

  it('retake.yaml render: takes the three keys, enumerated, and nothing else', () => {
    const ok = WorkspaceFileSchema.safeParse({ render: { gl: 'software', encoder: 'libx264', concurrency: 4 } });
    expect(ok.success).toBe(true);
    for (const bad of [{ gl: 'swangle' }, { encoder: 'h264_nvenc' }, { concurrency: 0 }, { concurrency: 17 }, { concurrency: 2.5 }, { crf: 18 }]) {
      expect(WorkspaceFileSchema.safeParse({ render: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('another GL keeps a set concurrency and takes the default of its own otherwise; the fallback keeps it', () => {
    const p = mac();
    expect(withGl(p, 'software').concurrency).toBe(defaultConcurrency());
    expect(withGl(p, 'software', { keepConcurrency: true }).concurrency).toBe(3);
    expect(withGl(mac({ workspace: { concurrency: 5 } }), 'software').concurrency).toBe(5);
  });
});

describe('VideoToolbox encoding', () => {
  it('bitrate: 0.13 bit per pixel per frame, to 0.5 Mb/s, at least 1 Mb/s; GOP 2 s', () => {
    expect(videotoolboxMbps({ width: 1920, height: 1080, fps: 30 })).toBe(8);
    expect(videotoolboxMbps({ width: 3840, height: 2160, fps: 30 })).toBe(32.5);
    expect(videotoolboxMbps({ width: 1080, height: 1920, fps: 30 })).toBe(8);
    expect(videotoolboxMbps({ width: 1080, height: 1080, fps: 30 })).toBe(4.5);
    expect(videotoolboxMbps({ width: 1920, height: 1080, fps: 60 })).toBe(16);
    expect(videotoolboxMbps({ width: 480, height: 270, fps: 30 })).toBe(1);
    expect(gopFrames(30)).toBe(60);
    expect(gopFrames(60)).toBe(120);
    expect(gopFrames(25)).toBe(50);
  });

  it('the size gate: each side at most 4096 (measured)', () => {
    expect(VIDEOTOOLBOX_MAX_SIDE).toBe(4096);
    for (const [w, h] of [[3840, 2160], [4096, 2304], [2304, 4096], [4096, 4096]]) expect(videotoolboxFits({ width: w, height: h }), `${w}x${h}`).toBe(true);
    for (const [w, h] of [[4104, 2304], [2304, 4104], [5760, 3240]]) expect(videotoolboxFits({ width: w, height: h }), `${w}x${h}`).toBe(false);
  });

  it("Remotion's fields: CRF 16 for libx264; required + bitrate + GOP for VideoToolbox, never crf with it", () => {
    const hd = { width: 1920, height: 1080, fps: 30 };
    expect(remotionEncoding('libx264', hd)).toEqual({ crf: 16 });
    const vt = remotionEncoding('h264_videotoolbox', hd);
    expect(vt).toEqual({ hardwareAcceleration: 'required', videoBitrate: '8M', gopSize: 60 });
    expect(vt).not.toHaveProperty('crf');
    expect(remotionEncoding('h264_videotoolbox', { width: 3840, height: 2160, fps: 30 })).toMatchObject({ videoBitrate: '32.5M' });
    expect(encodingRecord('h264_videotoolbox', hd)).toEqual({ encoder: 'h264_videotoolbox', bitrate: '8M', gop: 60 });
    expect(encodingRecord('libx264', hd)).toEqual({ encoder: 'libx264', crf: 16 });
  });
});

describe('the encoder choice', () => {
  const hd = { width: 1920, height: 1080, fps: 30 };
  const big = { width: 5760, height: 3240, fps: 30 };
  const ok = async () => ({ ok: true });
  const no = async () => ({ ok: false, error: 'cannot create compression session: -12903' });
  let probed = 0;
  const counting = async () => {
    probed++;
    return { ok: true };
  };

  it('auto: VideoToolbox with the GPU path when the size fits and the probe passes; libx264 otherwise, saying why', async () => {
    expect(await chooseEncoder(mac(), 'angle', hd, ok)).toEqual({ encoder: 'h264_videotoolbox' });
    expect(await chooseEncoder(mac(), 'software', hd, ok)).toEqual({ encoder: 'libx264' });
    probed = 0;
    const over = await chooseEncoder(mac(), 'angle', big, counting);
    expect(over.encoder).toBe('libx264');
    expect(over.note).toMatch(/VideoToolbox encodes at most 4096 pixels a side and this render is 5760×3240: encoded with libx264/);
    expect(probed).toBe(0); // chosen before any encode: an oversize session only fails once frames flow
    const failing = await chooseEncoder(mac(), 'angle', hd, no);
    expect(failing).toEqual({ encoder: 'libx264', note: 'VideoToolbox does not encode here (cannot create compression session: -12903): encoded with libx264' });
    expect(await chooseEncoder(linux({ env: { RETAKE_RENDER_GL: 'gpu' } }), 'angle', hd, ok)).toEqual({ encoder: 'libx264' });
  });

  it('videotoolbox forced: used with the software GL too; a RenderError when it cannot work; libx264 forced: libx264', async () => {
    const forced = mac({ workspace: { encoder: 'videotoolbox', gl: 'software' } });
    expect(await chooseEncoder(forced, 'software', hd, ok)).toEqual({ encoder: 'h264_videotoolbox' });
    await expect(chooseEncoder(forced, 'software', big, ok)).rejects.toThrow(/5760×3240 \(render encoder videotoolbox, retake\.yaml render\.encoder\)/);
    await expect(chooseEncoder(forced, 'software', hd, no)).rejects.toThrow(RenderError);
    expect(await chooseEncoder(mac({ env: { RETAKE_RENDER_ENCODER: 'libx264' } }), 'angle', hd, ok)).toEqual({ encoder: 'libx264' });
  });

  it('review A L1: a cancel ends the wait for the probe at once (a probe that never answers)', async () => {
    const stop = new AbortController();
    const hanging = () => new Promise<never>(() => undefined);
    const t0 = Date.now();
    const waiting = chooseEncoder(mac(), 'angle', hd, hanging, { signal: stop.signal });
    setTimeout(() => stop.abort(), 50);
    await expect(waiting).rejects.toBeInstanceOf(RenderCancelledError);
    expect(Date.now() - t0).toBeLessThan(2000);
    // Already cancelled: no wait at all; without a signal the probe's answer is awaited as before.
    await expect(chooseEncoder(mac(), 'angle', hd, hanging, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(RenderCancelledError);
    expect(await chooseEncoder(mac(), 'angle', hd, ok, { signal: new AbortController().signal })).toEqual({ encoder: 'h264_videotoolbox' });
  });
});

describe('the GPU check of a browser', () => {
  const fake = () => {
    const launched: Array<{ gl?: string }> = [];
    const closed: number[] = [];
    return {
      launched,
      closed,
      launch: async (chromium: { gl?: 'angle' }) => {
        const n = launched.push(chromium);
        return { connection: { n }, close: async () => void closed.push(n) };
      },
    };
  };
  const swiftshader = async () => ({ accelerated: false, renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)' });
  const metal = async () => ({ accelerated: true, renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)' });

  it('software: no chromiumOptions at all (byte for byte the renders of before), no check', async () => {
    const f = fake();
    let asked = 0;
    const b = await openRenderBrowser({ policy: linux(), launch: f.launch, gpuInfo: async () => (asked++, undefined) });
    expect(f.launched).toEqual([{}]);
    expect(asked).toBe(0);
    expect(b).toMatchObject({ gl: 'software', chromium: {}, warnings: [] });
  });

  it('auto with a GPU: ANGLE kept; without one: closed and opened again in software, said once (never swangle)', async () => {
    const f = fake();
    const b = await openRenderBrowser({ policy: mac(), launch: f.launch, gpuInfo: metal });
    expect(f.launched).toEqual([{ gl: 'angle' }]);
    expect(b).toMatchObject({ gl: 'angle', chromium: { gl: 'angle' }, gpu: { accelerated: true }, warnings: [] });
    const g = fake();
    const s = await openRenderBrowser({ policy: mac(), launch: g.launch, gpuInfo: swiftshader });
    expect(g.launched).toEqual([{ gl: 'angle' }, {}]);
    expect(g.closed).toEqual([1]);
    expect(s.gl).toBe('software');
    expect(s.chromium).toEqual({});
    expect((s.puppeteer.connection as { n: number }).n).toBe(2);
    expect(s.warnings).toEqual(['no GPU for this render (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)): rendered in software']);
    const h = fake();
    expect((await openRenderBrowser({ policy: mac(), launch: h.launch, gpuInfo: async () => undefined })).warnings[0]).toMatch(/it reported no GPU status/);
  });

  it('gpu forced without a GPU: kept on ANGLE, with a warning', async () => {
    const f = fake();
    const b = await openRenderBrowser({ policy: mac({ workspace: { gl: 'gpu' } }), launch: f.launch, gpuInfo: swiftshader });
    expect(f.launched).toEqual([{ gl: 'angle' }]);
    expect(b.gl).toBe('angle');
    expect(b.warnings[0]).toMatch(/found no GPU .*drawn with ANGLE anyway \(render gl: gpu, retake\.yaml render\.gl\)/);
  });
});

describe("the fallback's classifier", () => {
  const gpu = { gl: 'angle' as const, encoder: 'h264_videotoolbox' as const };
  const angleX264 = { gl: 'angle' as const, encoder: 'libx264' as const };
  const software = { gl: 'software' as const, encoder: 'libx264' as const };
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

  it('the GPU path failing: the GPU process, the GL context, the hardware encoder or its pipe', () => {
    expect(gpuPathFailure(new Error('GPU process exited unexpectedly: exit_code=15'), gpu)).toBe('GPU process exited unexpectedly: exit_code=15');
    expect(gpuPathFailure(new Error('WebGL context lost\nat frame 40'), angleX264)).toBe('WebGL context lost');
    expect(gpuPathFailure(epipe, gpu)).toBe('write EPIPE');
    expect(gpuPathFailure(new Error('[h264_videotoolbox @ 0x1] Error: cannot create compression session: -12903'), gpu)).toMatch(/compression session/);
    expect(gpuPathFailure(new Error('Error while opening encoder for output stream #0:0'), gpu)).toMatch(/opening encoder/);
    // ffmpeg's banner first (its configuration names videotoolbox on every build): the reason is the error's own line.
    const banner = 'ffmpeg version n7.1 Copyright (c) 2000-2024 the FFmpeg developers\n  built with Apple clang\n  configuration: --prefix=remotion --enable-videotoolbox\n';
    expect(gpuPathFailure(new Error(`${banner}[h264_videotoolbox @ 0x1] Error: cannot create compression session: -12903\n[vost#0:0] Error while opening encoder`), gpu)).toBe('[h264_videotoolbox @ 0x1] Error: cannot create compression session: -12903');
    // Review B L2: the encoder's pipe by its code, whatever the message says.
    expect(gpuPathFailure(Object.assign(new Error('the encoder stopped reading frames'), { code: 'EPIPE' }), gpu)).toBe('the encoder stopped reading frames');
  });

  it('never: the software path, a cancel, a full disk, a timeout, memory, a crashed page, an error of the plan', () => {
    expect(gpuPathFailure(new Error('GPU process exited unexpectedly'), software)).toBeNull();
    expect(gpuPathFailure(epipe, angleX264)).toBeNull(); // libx264's pipe: not the hardware encoder
    expect(gpuPathFailure(new RenderCancelledError(), gpu)).toBeNull();
    // A cancel is a cancel even when the GPU is named in it.
    expect(gpuPathFailure(Object.assign(new Error('GPU process: the render was aborted'), { name: 'AbortError' }), gpu)).toBeNull();
    expect(gpuPathFailure(new Error('GPU process exited: the render was cancelled'), gpu)).toBeNull();
    expect(gpuPathFailure(Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' }), gpu)).toBeNull();
    expect(gpuPathFailure(new RenderDiskFullError('frames'), gpu)).toBeNull();
    expect(gpuPathFailure(new Error('Timeout (90000ms) exceeded rendering the component at frame 12 (GPU process busy)'), gpu)).toBeNull();
    expect(gpuPathFailure(new Error('A delayRender() "x" was called but not cleared after 28000ms'), gpu)).toBeNull();
    expect(gpuPathFailure(new Error('Page crashed! (Metal)'), gpu)).toBeNull();
    expect(gpuPathFailure(new Error('Out of memory in the GPU process'), gpu)).toBeNull();
    expect(gpuPathFailure(new RenderError('files of the plan are missing: x.mp4 (ANGLE)'), gpu)).toBeNull();
    expect(gpuPathFailure(new Error('The render was cancelled'), gpu)).toBeNull();
    expect(gpuPathFailure(new Error('Cannot read properties of undefined (reading "x")'), gpu)).toBeNull();
    // Only the banner names videotoolbox: another ffmpeg failure, not the encoder's.
    expect(gpuPathFailure(new Error('ffmpeg version n7.1\n  configuration: --enable-videotoolbox\n[aac @ 0x1] Too many channels'), gpu)).toBeNull();
    // Review B M2: a stitch or audio failure that merely names the encoder — the input's `encoder` metadata of a video
    // VideoToolbox wrote, an audio encoder that does not open — is not a GPU failure (no second render).
    const stitch = [
      'FFmpeg quit with code 1 (null) The FFmpeg output was',
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/tmp/pre-encoded.mp4':",
      '  Metadata:',
      '    encoder         : Lavc61.19.100 h264_videotoolbox',
      '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 480x270, 1012 kb/s, 30 fps',
      '      handler_name    : VideoHandler',
      "[in#1 @ 0x1] Error opening input: Invalid data found when processing input",
      'Error opening input file /tmp/audio.wav.',
    ].join('\n');
    expect(gpuPathFailure(new Error(stitch), gpu)).toBeNull();
    expect(gpuPathFailure(new Error('encoder : Lavc61.19.100 h264_videotoolbox'), gpu)).toBeNull();
    expect(gpuPathFailure(new Error('[aost#0:1/aac @ 0x1] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height'), gpu)).toBeNull();
    expect(gpuPathFailure(new Error('h264_videotoolbox: the muxer could not write the moov atom'), gpu)).toBeNull();
  });
});

describe('what an export passes on of a re-render (review B L5)', () => {
  it("the policy's words — no GPU, VideoToolbox's limit or probe, the fallback — and the file warnings (upscaled, missing, blocked); nothing else", async () => {
    const big = await chooseEncoder(mac(), 'angle', { width: 5760, height: 3240, fps: 30 }, async () => ({ ok: true }));
    const probe = await chooseEncoder(mac(), 'angle', { width: 1920, height: 1080, fps: 30 }, async () => ({ ok: false, error: 'cannot create compression session: -12903' }));
    const passed = [
      'no GPU for this render (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)): rendered in software',
      big.note!,
      probe.note!,
      'the render failed on the GPU path (GPU process exited unexpectedly) and was rendered again in software',
      'the render browser left the GPU during the render (SwiftShader): part of it was drawn in software',
      'the image slot logo is upscaled 3× (blurry)',
      'the render blocked a request to http://127.0.0.1:4100: a render through MCP loads only the files of its plan',
    ];
    expect(exportRenderWarnings([...passed, 'scene b: the caption is long (12 words)'])).toEqual(passed);
  });
});

describe("the encoder pipe's guard (a process with no handler of its own)", () => {
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  const run = (mode: string) => spawnSync(process.execPath, ['--conditions=source', '--import', 'tsx', join(HERE, 'fixtures', 'pipe-guard.mts'), mode], { cwd: join(HERE, '..'), encoding: 'utf8', timeout: 60_000 });

  it('an EPIPE rejected unhandled does not end the process (installed once); any other rejection still does', () => {
    const epipe = run('epipe');
    expect(epipe.status, epipe.stderr).toBe(0);
    expect(epipe.stdout.trim()).toBe('alive 1');
    const other = run('other');
    expect(other.status).not.toBe(0);
    expect(other.stdout).not.toContain('alive');
    expect(other.stderr).toContain('something else');
  }, 120_000);
});
