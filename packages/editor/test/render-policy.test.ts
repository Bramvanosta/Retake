/**
 * L5.15 render policy (editor render/policy.ts), pure parts: the settings order (option → retake.yaml → env → auto),
 * what `auto` resolves to per platform (ANGLE on macOS, software elsewhere — never swangle), the defaults (3 frames at
 * a time on the GPU path, ¾ of the CPUs in software), the variables' errors, VideoToolbox's bitrate / GOP / size gate,
 * Remotion's encoding fields (`required`, never `crf` with it), the encoder choice and the fallback's classifier.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY, WorkspaceFileSchema, renderSettingsFromEnv, workPolicyFrom } from '@retake/core';
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
  renderSandboxOff,
  remotionEncoding,
  resolveRenderPolicy,
  videotoolboxFits,
  videotoolboxMbps,
  withGl,
} from '@retake/editor';

import { nodeFileFacts } from '@retake/core/io';
import { EncodeToolsError, noteOwnEncodeFailed, resetOwnFfmpeg } from '../src/render/encode-tools.js';
import type { OwnFfmpeg } from '../src/render/encode-tools.js';
import {
  AUTO_ENCODE_FFMPEG,
  AUTO_LIBRARY_NOTES,
  RETRY_LIBRARY_NOTE,
  autoEncodeFfmpeg,
  chooseEncode,
  frameEncodeCodecArgs,
  gpuPathFailureOf,
  ownEncodeFailure,
  workFfmpeg,
} from '../src/render/policy.js';

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
    for (const [w, h] of [
      [3840, 2160],
      [4096, 2304],
      [2304, 4096],
      [4096, 4096],
    ])
      expect(videotoolboxFits({ width: w, height: h }), `${w}x${h}`).toBe(true);
    for (const [w, h] of [
      [4104, 2304],
      [2304, 4104],
      [5760, 3240],
    ])
      expect(videotoolboxFits({ width: w, height: h }), `${w}x${h}`).toBe(false);
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

describe("the render browser's sandbox, read from its own command line", () => {
  const browserWith = (argv: string[], closed: string[], name: string) => ({
    connection: { send: async (method: string) => (method === 'Browser.getBrowserCommandLine' ? { arguments: argv } : {}) },
    close: async () => void closed.push(name),
  });
  const REMOTION = ['--headless=old', '--remote-debugging-port=0', '--no-zygote', '--site-per-process', '--user-data-dir=/x'];

  it("on macOS a browser whose command line turns its sandbox or site isolation off is closed and refused; Remotion's own switches are not", async () => {
    const closed: string[] = [];
    for (const off of ['--no-sandbox', '--disable-site-isolation-trials', '--disable-features=Translate,IsolateOrigins']) {
      await expect(openRenderBrowser({ policy: linux(), platform: 'darwin', launch: async () => browserWith([...REMOTION, off], closed, off) })).rejects.toThrow(
        new RegExp(
          `the render browser runs with ${off.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} on its command line, which turns its sandbox or site isolation off — its executable adds switches itself`,
        ),
      );
    }
    expect(closed).toEqual(['--no-sandbox', '--disable-site-isolation-trials', '--disable-features=Translate,IsolateOrigins']);
    const kept = await openRenderBrowser({ policy: linux(), platform: 'darwin', launch: async () => browserWith(REMOTION, closed, 'ok') });
    expect(kept.gl).toBe('software');
    expect(closed).not.toContain('ok');
  });

  it('the browser opened again in software is checked too; elsewhere than macOS nothing is read (Linux renders run as Remotion starts them)', async () => {
    const closed: string[] = [];
    let n = 0;
    await expect(
      openRenderBrowser({
        policy: mac(),
        platform: 'darwin',
        launch: async () => browserWith(++n === 1 ? REMOTION : [...REMOTION, '--no-sandbox'], closed, `b${n}`),
        gpuInfo: async () => ({ accelerated: false }),
      }),
    ).rejects.toThrow(/runs with --no-sandbox/);
    expect(closed).toEqual(['b1', 'b2']);
    expect((await openRenderBrowser({ policy: linux(), platform: 'linux', launch: async () => browserWith([...REMOTION, '--no-sandbox'], closed, 'linux') })).gl).toBe('software');
    expect(await renderSandboxOff(browserWith(['--no-sandbox'], [], 'x'), 'linux')).toEqual([]);
    expect(
      await renderSandboxOff(
        {
          connection: {
            send: async () => {
              throw new Error('no');
            },
          },
        },
        'darwin',
      ),
    ).toEqual([]);
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
    expect(gpuPathFailure(new Error(`${banner}[h264_videotoolbox @ 0x1] Error: cannot create compression session: -12903\n[vost#0:0] Error while opening encoder`), gpu)).toBe(
      '[h264_videotoolbox @ 0x1] Error: cannot create compression session: -12903',
    );
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
      '[in#1 @ 0x1] Error opening input: Invalid data found when processing input',
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
  const run = (mode: string) =>
    spawnSync(process.execPath, ['--conditions=source', '--import', 'tsx', join(HERE, 'fixtures', 'pipe-guard.mts'), mode], { cwd: join(HERE, '..'), encoding: 'utf8', timeout: 60_000 });

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

describe('the encode ffmpeg (L7.3)', () => {
  const hd = { width: 1920, height: 1080, fps: 30 };
  const vtOk = async () => ({ ok: true });
  const vtNo = async () => ({ ok: false, error: 'cannot create compression session: -12903' });
  const never = async (): Promise<OwnFfmpeg> => expect.unreachable("this machine's ffmpeg is not looked at");
  const scratch = mkdtempSync(join(tmpdir(), 'retake-encode-choice-'));
  const ffmpegPath = join(scratch, 'ffmpeg');
  writeFileSync(ffmpegPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const ours =
    (facts: Partial<{ libx264: boolean; videotoolbox: boolean }> = {}) =>
    async (): Promise<OwnFfmpeg> => ({ ok: true, path: ffmpegPath, facts: { version: '7.1.1', libx264: true, videotoolbox: true, filter: true, ...facts } });
  const refused = async (): Promise<OwnFfmpeg> => ({ ok: false, reason: "this machine's ffmpeg cannot encode renders: it is ffmpeg 4.4.2 (needs 5.1+)" });
  /** The frame-encode probe of a test: our ffmpeg here is a script, taken at its word. */
  const encodes = async () => ({ ok: true });
  const encodesNot = async () => ({ ok: false, error: "Unrecognized option 'video_track_timescale'." });
  const own = (o: Parameters<typeof mac>[0] = {}) => mac({ workspace: { ffmpeg: 'own' }, ...o });
  const software = (p: ReturnType<typeof mac>) => resolveRenderPolicy({ platform: 'darwin', cpus: 10, workspace: { gl: 'software', ffmpeg: p.ffmpeg.asked } });
  let home = '';
  const fresh = () => (home = mkdtempSync(join(scratch, 'home-')));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('the setting: auto, own or library — an option over retake.yaml over $RETAKE_RENDER_FFMPEG; a bad value names the variable; retake.yaml takes the key, enumerated', () => {
    expect(mac().ffmpeg).toEqual({ asked: 'auto', source: 'default' });
    expect(mac({ env: { RETAKE_RENDER_FFMPEG: 'own' } }).ffmpeg).toEqual({ asked: 'own', source: 'env' });
    expect(mac({ env: { RETAKE_RENDER_FFMPEG: 'own' }, workspace: { ffmpeg: 'library' } }).ffmpeg).toEqual({ asked: 'library', source: 'retake.yaml' });
    expect(mac({ env: { RETAKE_RENDER_FFMPEG: 'own' }, workspace: { ffmpeg: 'library' }, option: { ffmpeg: 'auto' } }).ffmpeg).toEqual({ asked: 'auto', source: 'option' });
    expect(linux({ env: { RETAKE_RENDER_FFMPEG: ' library ' } }).ffmpeg).toEqual({ asked: 'library', source: 'env' });
    expect(() => mac({ env: { RETAKE_RENDER_FFMPEG: 'mine' } })).toThrow(/\$RETAKE_RENDER_FFMPEG is "mine": use auto, own, library/);
    expect(() => mac({ env: { RETAKE_RENDER_FFMPEG: 'mine' } })).toThrow(RenderError);
    expect(renderSettingsFromEnv({ RETAKE_RENDER_FFMPEG: '  ' })).toEqual({});
    for (const ffmpeg of ['auto', 'own', 'library']) expect(WorkspaceFileSchema.safeParse({ render: { ffmpeg } }).success, ffmpeg).toBe(true);
    for (const ffmpeg of ['system', '/opt/bin/ffmpeg', true]) expect(WorkspaceFileSchema.safeParse({ render: { ffmpeg } }).success, String(ffmpeg)).toBe(false);
  });

  it("library: the rendering library's ffmpeg, ours never looked at — the encoder chosen as before", async () => {
    const p = mac({ workspace: { ffmpeg: 'library' } });
    expect(await chooseEncode(p, 'angle', hd, { workPolicy: PERSON_POLICY, videotoolbox: vtOk, own: never })).toEqual({ encoder: 'h264_videotoolbox', ffmpeg: { used: 'library' } });
    expect(await chooseEncode(p, 'angle', hd, { workPolicy: PERSON_POLICY, videotoolbox: vtNo, own: never })).toEqual({ ...(await chooseEncoder(p, 'angle', hd, vtNo)), ffmpeg: { used: 'library' } });
    expect(await chooseEncode(software(p), 'software', hd, { workPolicy: PERSON_POLICY, own: never })).toEqual({ encoder: 'libx264', ffmpeg: { used: 'library' } });
    // The second attempt of a render whose first failed while ours encoded takes the library's whatever was asked, and says so.
    expect(await chooseEncode(own(), 'angle', hd, { workPolicy: PERSON_POLICY, videotoolbox: vtOk, own: never, library: true })).toEqual({
      encoder: 'h264_videotoolbox',
      ffmpeg: { used: 'library', note: RETRY_LIBRARY_NOTE, byRule: true },
    });
    expect((await chooseEncode(software(mac()), 'software', hd, { workPolicy: PERSON_POLICY, own: never, library: true })).ffmpeg).toEqual({ used: 'library', note: RETRY_LIBRARY_NOTE, byRule: true });
    expect(RETRY_LIBRARY_NOTE).toBe("this machine's ffmpeg failed at the encode: the video was rendered again with the rendering library's");
    expect((await chooseEncode(software(p), 'software', hd, { workPolicy: PERSON_POLICY, own: never, library: true })).ffmpeg).toEqual({ used: 'library' });
  });

  it('own: ours encodes when it qualifies and has the encoder chosen — through a folder of its own in the Retake home', async () => {
    fresh();
    const c = await chooseEncode(own(), 'angle', hd, { workPolicy: PERSON_POLICY, videotoolbox: vtOk, own: ours(), home });
    expect(c).toMatchObject({ encoder: 'h264_videotoolbox', ffmpeg: { used: 'own', version: '7.1.1', path: ffmpegPath } });
    expect(c.ffmpeg.note).toBeUndefined();
    const dir = c.ffmpeg.binariesDirectory!;
    expect(dir.startsWith(join(realpathSync(home), 'encode-tools') + '/')).toBe(true);
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(['ffmpeg', 'ffprobe', 'remotion']));
    expect(readFileSync(join(dir, 'ffmpeg'), 'utf8')).toContain(`exec '${ffmpegPath}' "$@"`);
    // The same folder for the next render.
    // By name, ours encodes on the software path too — once it has run the frame encode itself, with the encoder chosen.
    const probed: Array<[string, string]> = [];
    const again = await chooseEncode(software(own()), 'software', hd, {
      workPolicy: PERSON_POLICY,
      own: ours(),
      home,
      ownEncodes: async (path, _s, encoder) => (probed.push([path, encoder]), { ok: true }),
    });
    expect(again).toEqual({ encoder: 'libx264', ffmpeg: { used: 'own', version: '7.1.1', path: ffmpegPath, binariesDirectory: dir } });
    expect(probed).toEqual([[ffmpegPath, 'libx264']]);
    // VideoToolbox: the same probe, with that encoder, at the render's size.
    probed.length = 0;
    const vt = await chooseEncode(own(), 'angle', hd, {
      workPolicy: PERSON_POLICY,
      own: ours(),
      home,
      ownEncodes: async (path, x, encoder) => (probed.push([path, `${encoder} ${x.width}x${x.height}`]), { ok: true }),
    });
    expect(vt).toMatchObject({ encoder: 'h264_videotoolbox', ffmpeg: { used: 'own' } });
    expect(probed).toEqual([[ffmpegPath, 'h264_videotoolbox 1920x1080']]);
    expect(frameEncodeCodecArgs('libx264', hd)).toEqual(['-c:v', 'libx264', '-crf', '16']);
    expect(frameEncodeCodecArgs('h264_videotoolbox', hd)).toEqual(['-c:v', 'h264_videotoolbox', '-b:v', '8M', '-g', '60']);
  });

  it("own, and the library's encodes with the reason — never an error: ours refused, without the encoder chosen, VideoToolbox not working with ours", async () => {
    fresh();
    const o = { workPolicy: PERSON_POLICY, home, ownEncodes: encodes };
    expect(await chooseEncode(own(), 'angle', hd, { ...o, videotoolbox: vtOk, own: refused })).toEqual({
      encoder: 'h264_videotoolbox',
      ffmpeg: { used: 'library', note: "this machine's ffmpeg cannot encode renders: it is ffmpeg 4.4.2 (needs 5.1+)" },
    });
    expect(await chooseEncode(own(), 'angle', hd, { ...o, videotoolbox: vtOk, own: ours({ videotoolbox: false }) })).toEqual({
      encoder: 'h264_videotoolbox',
      ffmpeg: { used: 'library', version: '7.1.1', note: "this machine's ffmpeg (7.1.1) does not encode VideoToolbox here" },
    });
    expect(await chooseEncode(software(own()), 'software', hd, { ...o, own: ours({ libx264: false }) })).toEqual({
      encoder: 'libx264',
      ffmpeg: { used: 'library', version: '7.1.1', note: "this machine's ffmpeg (7.1.1) has no libx264" },
    });
    // It has the encoder and the filter by name and does not run the command: refused before the render, its words kept apart.
    expect(await chooseEncode(software(own()), 'software', hd, { ...o, own: ours(), ownEncodes: encodesNot })).toEqual({
      encoder: 'libx264',
      ffmpeg: { used: 'library', version: '7.1.1', note: "this machine's ffmpeg (7.1.1) does not run the frame encode", detail: "Unrecognized option 'video_track_timescale'." },
    });
    // VideoToolbox with ours does not pass its probe: the library's is probed and encodes, as before.
    const libVt = await chooseEncode(own(), 'angle', hd, { workPolicy: PERSON_POLICY, home, own: ours(), ownEncodes: async () => ({ ok: false, error: 'cannot create compression session: -12903' }) });
    if (libVt.encoder === 'h264_videotoolbox')
      expect(libVt.ffmpeg).toEqual({ used: 'library', version: '7.1.1', note: "this machine's ffmpeg (7.1.1) does not encode VideoToolbox here", detail: 'cannot create compression session: -12903' });
    // VideoToolbox does not encode here at all: libx264, said as before, and ours encodes it.
    const x264 = await chooseEncode(own(), 'angle', hd, { ...o, videotoolbox: vtNo, own: ours() });
    expect(x264).toMatchObject({ encoder: 'libx264', note: expect.stringMatching(/^VideoToolbox does not encode here/), ffmpeg: { used: 'own' } });
    // The library's programs not found, or ours not readable: the library's, said.
    const thrown = await chooseEncode(own(), 'angle', hd, { ...o, videotoolbox: vtOk, own: async () => Promise.reject(new Error('no such folder\nat x')) });
    expect(thrown.ffmpeg).toEqual({ used: 'library', note: "the rendering library's programs were not found", detail: 'no such folder' });
    // A refusal's own words (a path, a program's line) never make the note: they are kept apart for the warnings.
    const policyRefused = async (): Promise<OwnFfmpeg> => ({
      ok: false,
      reason: "this machine's ffmpeg may not be started for this work",
      detail: 'ffmpeg (/ws/bin/ffmpeg) lies inside the workspace (/ws)',
    });
    expect((await chooseEncode(own(), 'angle', hd, { ...o, videotoolbox: vtOk, own: policyRefused })).ffmpeg).toEqual({
      used: 'library',
      note: "this machine's ffmpeg may not be started for this work",
      detail: 'ffmpeg (/ws/bin/ffmpeg) lies inside the workspace (/ws)',
    });
    // A forced VideoToolbox that cannot work stays the error it was.
    await expect(chooseEncode(mac({ workspace: { ffmpeg: 'own', encoder: 'videotoolbox' } }), 'angle', hd, { ...o, videotoolbox: vtNo, own: ours() })).rejects.toThrow(
      /VideoToolbox does not encode here .*render encoder videotoolbox, retake\.yaml render\.encoder/,
    );
  });

  it('nothing is written when ours is not used, for `retake doctor` (dry), in a Retake home inside the workspace of an agent job, or where the folder cannot be made', async () => {
    fresh();
    const o = { workPolicy: PERSON_POLICY, home, videotoolbox: vtOk, ownEncodes: encodes };
    await chooseEncode(own(), 'angle', hd, { ...o, own: refused });
    await chooseEncode(mac({ workspace: { ffmpeg: 'library' } }), 'angle', hd, { ...o, own: never });
    expect(await chooseEncode(own(), 'angle', hd, { ...o, own: ours(), dry: true })).toEqual({ encoder: 'h264_videotoolbox', ffmpeg: { used: 'own', version: '7.1.1', path: ffmpegPath } });
    expect(readdirSync(home)).toEqual([]);
    // An agent can write in the workspace: a program of ours never lies there.
    const agent = workPolicyFrom([realpathSync(scratch)]);
    expect((await chooseEncode(own(), 'angle', hd, { ...o, workPolicy: agent, own: ours() })).ffmpeg).toEqual({
      used: 'library',
      version: '7.1.1',
      note: 'the encode tools would lie inside the workspace (the Retake home is there)',
    });
    expect(readdirSync(home)).toEqual([]);
    // `retake doctor` says the same of that job as its render would do (and writes nothing either).
    expect((await chooseEncode(own(), 'angle', hd, { ...o, workPolicy: agent, own: ours(), dry: true })).ffmpeg).toMatchObject({
      used: 'library',
      note: 'the encode tools would lie inside the workspace (the Retake home is there)',
    });
    expect(readdirSync(home)).toEqual([]);
    // The same home for a person's command: made.
    expect((await chooseEncode(own(), 'angle', hd, { ...o, own: ours() })).ffmpeg.used).toBe('own');
    const file = join(scratch, 'a-file');
    writeFileSync(file, 'x');
    const unmade = await chooseEncode(own(), 'angle', hd, { ...o, home: file, own: ours() });
    // The note names the system's error by its code; what the system said is kept apart.
    expect(unmade.ffmpeg).toEqual({ used: 'library', version: '7.1.1', note: 'the encode tools folder cannot be made (ENOTDIR)', detail: expect.stringMatching(/ENOTDIR/) });
    const quoted = async (): Promise<OwnFfmpeg> => ({ ok: true, path: join(scratch, "it's", 'ffmpeg'), facts: { version: '7.1.1', libx264: true, videotoolbox: true, filter: true } });
    expect((await chooseEncode(own(), 'angle', hd, { ...o, own: quoted })).ffmpeg).toMatchObject({ used: 'library', note: 'a path of the encode tools holds a quote or a control character' });
    expect(existsSync(join(scratch, "it's"))).toBe(false);
  });

  it("our ffmpeg failing at the encode (the one retry is with the library's): the library's own words for a frame encode that quit or is gone, its pipe, a command the tools refuse, a program of the folder that did not start; never a cancel, a full disk, a timeout, memory, the plan, or the final file's ffmpeg failing", () => {
    const own = { version: '7.1.1', folder: '/home/u/.retake/encode-tools/0123456789abcdef' };
    // The library's messages for the frame encode (its ffmpeg quit while frames were piped to it), as it writes them.
    const piping = (banner: string, lines: string[]) =>
      new Error(`FFmpeg quit with code 8 while piping frame 3. Stderr: ffmpeg version ${banner} Copyright (c) the FFmpeg developers\n  built with Apple clang\n${lines.join('\n')}`);
    expect(ownEncodeFailure(piping('7.1.1', ["[AVFilterGraph @ 0x1] No such filter: 'colorspace'", 'Error opening output files: Filter not found']), own)).toBe(
      "[AVFilterGraph @ 0x1] No such filter: 'colorspace'",
    );
    expect(ownEncodeFailure(piping('7.1.1', ["Unrecognized option 'video_track_timescale'."]), own)).toBe("Unrecognized option 'video_track_timescale'.");
    expect(ownEncodeFailure(new Error('FFmpeg quit with code 1 (signal SIGSEGV) while piping frame 12. Stderr: '), own)).toBe('FFmpeg quit with code 1 (signal SIGSEGV) while piping frame 12');
    expect(ownEncodeFailure(new Error('FFmpeg already quit while trying to pipe frame 0 to it. Stderr: Error opening output'), own)).toBe('Error opening output');
    expect(ownEncodeFailure(new Error('FFmpeg is not available while trying to pipe frame 4 to it.'), own)).toBe('FFmpeg is not available while trying to pipe frame 4 to it.');
    expect(ownEncodeFailure(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), own)).toBe('write EPIPE');
    expect(ownEncodeFailure(new EncodeToolsError('the frame encode\'s filter is "scale=1": not the one this version knows'), own)).toBe(
      'the frame encode\'s filter is "scale=1": not the one this version knows',
    );
    // A program of the tools folder that could not be started (the folder gone under the render): ours, so the retry fires.
    expect(ownEncodeFailure(Object.assign(new Error(`spawn ${own.folder}/ffmpeg ENOENT`), { code: 'ENOENT', path: `${own.folder}/ffmpeg` }), own)).toBe(
      'a program of the encode tools could not be started (ENOENT)',
    );
    expect(ownEncodeFailure(Object.assign(new Error(`spawn ${own.folder}/ffmpeg EACCES`), { code: 'EACCES' }), own)).toBe('a program of the encode tools could not be started (EACCES)');
    // Another file that is missing is not ours to answer for.
    expect(ownEncodeFailure(Object.assign(new Error("ENOENT: no such file or directory, open '/ws/assets/music.mp3'"), { code: 'ENOENT', path: '/ws/assets/music.mp3' }), own)).toBeNull();
    expect(ownEncodeFailure(Object.assign(new Error(`spawn ${own.folder}/ffmpeg ENOENT`), { code: 'ENOENT' }), { version: '7.1.1' })).toBeNull();
    // The final file's ffmpeg (the library's own, at the audio or the mux) says "The FFmpeg output was": it would fail
    // again — even on a machine whose ffmpeg has the library's version, and even when its pipe closed.
    const mux = (banner: string, lines: string[]) =>
      new Error(['FFmpeg quit with code 1  The FFmpeg output was ffmpeg version ' + banner + ' Copyright (c) the FFmpeg developers', '  built with Apple clang', ...lines].join('\n'));
    expect(ownEncodeFailure(mux('n7.1', ['[in#1 @ 0x1] Error opening input: Invalid data found when processing input']), own)).toBeNull();
    expect(ownEncodeFailure(mux('n7.1', ['Error opening output files']), { ...own, version: '7.1' })).toBeNull();
    expect(ownEncodeFailure(mux('7.1.1', ['av_interleaved_write_frame(): Broken pipe EPIPE']), own)).toBeNull();
    // The second guard: a frame encode's output that names another ffmpeg than ours.
    expect(ownEncodeFailure(piping('n7.1', ['Error opening output files']), own)).toBeNull();
    expect(ownEncodeFailure(piping('n7.1.1', ['Error opening output files']), own)).toBe('Error opening output files');
    expect(ownEncodeFailure(new RenderCancelledError(), own)).toBeNull();
    expect(ownEncodeFailure(Object.assign(new Error('FFmpeg quit with code 255 while piping frame 2. Stderr: aborted'), { name: 'AbortError' }), own)).toBeNull();
    expect(ownEncodeFailure(new Error('FFmpeg quit with code 255 while piping frame 2. Stderr: the render was cancelled'), own)).toBeNull();
    expect(ownEncodeFailure(Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' }), own)).toBeNull();
    expect(ownEncodeFailure(new RenderDiskFullError('frames'), own)).toBeNull();
    expect(ownEncodeFailure(new Error('Timeout (90000ms) exceeded rendering the component at frame 12'), own)).toBeNull();
    expect(ownEncodeFailure(new Error('FFmpeg quit with code 1 while piping frame 2. Stderr: Cannot allocate memory'), own)).toBeNull();
    expect(ownEncodeFailure(new Error('Page crashed!'), own)).toBeNull();
    expect(ownEncodeFailure(new RenderError('files of the plan are missing: x.mp4'), own)).toBeNull();
    expect(ownEncodeFailure(new Error('Cannot read properties of undefined (reading "x")'), own)).toBeNull();
    // A bare "FFmpeg quit with code" (not the frame encode's sentence) is no longer taken for ours.
    expect(ownEncodeFailure(new Error('FFmpeg quit with code 1'), own)).toBeNull();
  });

  it("the GPU path's failure says which sign told: the hardware encoder's (its lines, its pipe — also how the ffmpeg that runs it fails) or the GL's", () => {
    const path = { gl: 'angle', encoder: 'h264_videotoolbox' } as const;
    expect(gpuPathFailureOf(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), path)).toEqual({ reason: 'write EPIPE', sign: 'encoder' });
    expect(gpuPathFailureOf(new Error('ffmpeg version 7.1\n[h264_videotoolbox @ 0x1] Error: cannot create compression session: -12903'), path)).toEqual({
      reason: '[h264_videotoolbox @ 0x1] Error: cannot create compression session: -12903',
      sign: 'encoder',
    });
    expect(gpuPathFailureOf(new Error('GPU process exited unexpectedly'), path)).toEqual({ reason: 'GPU process exited unexpectedly', sign: 'gl' });
    expect(gpuPathFailureOf(new Error('GPU process exited unexpectedly'), { gl: 'angle', encoder: 'libx264' })?.sign).toBe('gl');
    expect(gpuPathFailureOf(new Error('Page crashed!'), path)).toBeNull();
    expect(gpuPathFailure(new Error('GPU process exited unexpectedly'), path)).toBe('GPU process exited unexpectedly');
  });

  it("auto: ours on the GPU path only, when it qualifies — the library's on the software path and inside the app bundle, each said by the rule's own words; own by name takes ours on any of them", async () => {
    fresh();
    const o = { workPolicy: PERSON_POLICY, videotoolbox: vtOk, home, ownEncodes: encodes };
    expect(AUTO_ENCODE_FFMPEG).toEqual({ gpu: 'own', software: 'library', app: 'library' });
    expect(autoEncodeFfmpeg('angle', false)).toEqual({ want: 'own' });
    expect(autoEncodeFfmpeg('software', false)).toEqual({ want: 'library', note: "auto: the rendering library's ffmpeg on the software path" });
    expect(autoEncodeFfmpeg('angle', true)).toEqual({ want: 'library', note: "auto: the rendering library's ffmpeg inside the desktop app" });
    expect(autoEncodeFfmpeg('software', true)).toEqual({ want: 'library', note: AUTO_LIBRARY_NOTES.app });
    // The GPU path: ours, with VideoToolbox or (where it does not encode) libx264.
    expect((await chooseEncode(mac(), 'angle', hd, { ...o, own: ours(), inApp: false })).ffmpeg).toMatchObject({ used: 'own', version: '7.1.1' });
    expect(await chooseEncode(mac(), 'angle', hd, { ...o, videotoolbox: vtNo, own: ours(), inApp: false })).toMatchObject({ encoder: 'libx264', ffmpeg: { used: 'own' } });
    // A machine without a usable ffmpeg of its own renders as before; the record says why ours did not encode.
    expect((await chooseEncode(mac(), 'angle', hd, { ...o, own: refused, inApp: false })).ffmpeg).toEqual({
      used: 'library',
      note: "this machine's ffmpeg cannot encode renders: it is ffmpeg 4.4.2 (needs 5.1+)",
    });
    // The software path — a setting, no GPU, or the second attempt of a render that failed on the GPU path: the
    // library's, ours never looked at; the record says it is the rule, not a refusal.
    expect(await chooseEncode(software(mac()), 'software', hd, { ...o, own: never, inApp: false })).toEqual({
      encoder: 'libx264',
      ffmpeg: { used: 'library', note: AUTO_LIBRARY_NOTES.software, byRule: true },
    });
    expect((await chooseEncode(mac(), 'software', hd, { ...o, own: never, inApp: false })).ffmpeg).toEqual({ used: 'library', note: AUTO_LIBRARY_NOTES.software, byRule: true });
    // Inside the app bundle: the library's on both paths.
    expect(await chooseEncode(mac(), 'angle', hd, { ...o, own: never, inApp: true })).toEqual({
      encoder: 'h264_videotoolbox',
      ffmpeg: { used: 'library', note: AUTO_LIBRARY_NOTES.app, byRule: true },
    });
    expect((await chooseEncode(software(mac()), 'software', hd, { ...o, own: never, inApp: true })).ffmpeg).toEqual({ used: 'library', note: AUTO_LIBRARY_NOTES.app, byRule: true });
    // By name: ours in software and in the app.
    expect((await chooseEncode(software(own()), 'software', hd, { ...o, own: ours(), inApp: false })).ffmpeg.used).toBe('own');
    expect((await chooseEncode(own(), 'angle', hd, { ...o, own: ours(), inApp: true })).ffmpeg.used).toBe('own');
    expect((await chooseEncode(software(own()), 'software', hd, { ...o, own: ours(), inApp: true })).ffmpeg.used).toBe('own');
    // This process is not the app: the default reads that by itself.
    expect((await chooseEncode(mac(), 'angle', hd, { ...o, own: ours() })).ffmpeg.used).toBe('own');
  });

  it('the work\'s ffmpeg by its path: a bare name looked up in the PATH; one the PATH finds through a relative folder is refused with those words (never "none found"); none on the PATH is the bare name', (ctx) => {
    if (process.env.RETAKE_FFMPEG?.trim() || process.platform === 'win32') return ctx.skip();
    const files = nodeFileFacts;
    const lookup = (path: string, has: string) => ({ path, files, exists: (f: string) => f === has });
    expect(workFfmpeg(PERSON_POLICY, lookup('/no-such-root/tools/bin', '/no-such-root/tools/bin/ffmpeg'))).toBe('/no-such-root/tools/bin/ffmpeg');
    expect(workFfmpeg(PERSON_POLICY, lookup('/no-such-root/tools/bin', '/elsewhere/ffmpeg'))).toBe('ffmpeg');
    expect(() => workFfmpeg(PERSON_POLICY, lookup('tools/bin', join(process.cwd(), 'tools/bin/ffmpeg')))).toThrow(/ffmpeg \(ffmpeg\) is found through the relative PATH folder "tools\/bin"/);
  });

  it("an ffmpeg of ours that failed at an encode is not taken again by this process: the next render keeps its path, with the library's, and says why", async () => {
    fresh();
    resetOwnFfmpeg();
    const o = { workPolicy: PERSON_POLICY, videotoolbox: vtOk, home, ownEncodes: encodes, inApp: false };
    try {
      expect((await chooseEncode(mac(), 'angle', hd, { ...o, own: ours() })).ffmpeg.used).toBe('own');
      noteOwnEncodeFailed(ffmpegPath);
      const next = await chooseEncode(mac(), 'angle', hd, { ...o, own: ours() });
      expect(next).toEqual({ encoder: 'h264_videotoolbox', ffmpeg: { used: 'library', version: '7.1.1', note: "this machine's ffmpeg (7.1.1) failed at an encode earlier in this process" } });
      expect((await chooseEncode(software(own()), 'software', hd, { ...o, own: ours() })).ffmpeg).toMatchObject({ used: 'library', note: expect.stringMatching(/failed at an encode earlier/) });
      // Its own VideoToolbox probe is not run again either.
      const noProbe = await chooseEncode(mac(), 'angle', hd, { workPolicy: PERSON_POLICY, home, inApp: false, own: ours(), ownEncodes: async () => expect.unreachable('not probed again') });
      expect(noProbe.ffmpeg.used).toBe('library');
    } finally {
      resetOwnFfmpeg();
    }
    expect((await chooseEncode(mac(), 'angle', hd, { ...o, own: ours() })).ffmpeg.used).toBe('own');
  });
});
