/**
 * The render policy (L5.15, DESIGN §4r): how every Remotion browser of this process draws, which encoder writes a
 * render, how many frames render at a time — the one place that names a GL, an encoder or a default concurrency for
 * Remotion (render.ts and preview.ts ask here).
 *
 * - Settings: an explicit option (`retake render --concurrency`, a test) → retake.yaml `render:` → `RETAKE_RENDER_*` →
 *   auto (core render-settings.ts; the same order as `ffmpeg`).
 * - GL `auto`: ANGLE on macOS (Metal), today's software raster elsewhere; `gpu` forces ANGLE, `software` forces today's.
 *   ANGLE is checked when the browser opens (CDP SystemInfo, `gpuInfoOf`): no GPU there under `auto` → the browser is
 *   reopened in software (never SwiftShader through ANGLE, `swangle`: measured 10× slower).
 * - Encoder `auto`: the Mac's VideoToolbox when the GPU path is used, the render fits its size limit
 *   (VIDEOTOOLBOX_MAX_SIDE) and the probe passes — the compositor's own ffmpeg, spawned as Remotion spawns it, encoding
 *   a few frames at the render's size; else libx264 at CRF 16 (today's). `videotoolbox` forces it (macOS only: a clear
 *   error elsewhere, never another hardware encoder); `libx264` gives today's encode.
 * - Concurrency: 3 on the GPU path, three quarters of the CPUs (1–8) in software.
 * - The encode ffmpeg (L7.3, `chooseEncode`): `library` — the rendering library's own encodes the frames, as before;
 *   `own` — this machine's ffmpeg does (encode-tools.ts) when it qualifies for the encoder chosen, else the library's
 *   with the reason in the record; `auto` — ours for a render drawn on the GPU, the library's on the software path and
 *   inside the app bundle (AUTO_ENCODE_FFMPEG, `autoEncodeFfmpeg`). Audio, mux and probes stay the library's either
 *   way. A failure while ours encodes takes the one fallback below (`ownEncodeFailure`, or the GPU path's encoder
 *   signs): software, libx264, the library's ffmpeg — and ours is not taken again by this process.
 * - One fallback, on the render path only (render.ts): a failure of the GPU path itself (`gpuPathFailure`) renders the
 *   video once more in software with libx264, from scratch.
 */
import { availableParallelism, cpus as osCpus } from 'node:os';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { RENDER_CONCURRENCY_MAX, RENDER_ENV, RenderSettingsError, agentProgram, gpuInfoOf, programProblem, renderSettingsFromEnv, sandboxSwitchOff } from '@retake/core';
import type { GpuInfo, ProgramPolicyOptions, RenderEncoderSetting, RenderFfmpegSetting, RenderGlSetting, RenderSettings, SystemInfoReply, WorkPolicy } from '@retake/core';
import { bundleInfoOrNull, ffmpegBin, programLookup, retakeHome } from '@retake/core/io';
import { ENCODE_TOOLS_DIR, EncodeToolsError, encodeFolder, fileId, ownEncodeFailedEarlier, ownFfmpeg, probeFrameEncode } from './encode-tools.js';
import type { OwnFfmpeg } from './encode-tools.js';
import { compositorDir, rendererLibrary } from './library.js';
import type { RenderBrowserHandle } from './library.js';
import { RenderCancelledError, RenderError, isDiskFullError } from './types.js';

/** How the render browser draws: ANGLE (the GPU: Metal on macOS) or Chromium's software raster (no `--use-gl`). */
export type RenderGl = 'angle' | 'software';
/** The H.264 encoder of a render (the compositor's ffmpeg). */
export type RenderEncoder = 'h264_videotoolbox' | 'libx264';
/** Where a setting came from. */
export type RenderSettingSource = 'option' | 'retake.yaml' | 'env' | 'default';

/** Frames at a time on the GPU path (measured: as fast as today's 7 at a peak of 4 cores instead of 9 — DESIGN §4r). */
export const GPU_CONCURRENCY = 3;
/** libx264's constant rate factor (today's renders; the software path and the encoder fallback). */
export const RENDER_CRF = 16;
/** VideoToolbox's bitrate per pixel per frame (1080p30 ≈ 8 Mb/s; measured on the fixture's scroll frames, DESIGN §4r). */
export const VIDEOTOOLBOX_BITS_PER_PIXEL = 0.13;
/** The lowest VideoToolbox bitrate (Mb/s): small test renders. */
export const VIDEOTOOLBOX_MIN_MBPS = 1;
/**
 * VideoToolbox's largest side (pixels): measured on an M4 with the compositor's ffmpeg — 4096×4096, 4096×2304 and
 * 2304×4096 encode; 4104×2304, 2304×4104 and 4096×4104 fail ("cannot create compression session: -12903"). Above it a
 * render is encoded with libx264, chosen before the render (an oversize session only fails once frames flow, as a
 * broken pipe).
 */
export const VIDEOTOOLBOX_MAX_SIDE = 4096;

/** Default concurrency in software: three quarters of the CPUs, 1–8 (3 on a 4-CPU machine, ≈ 12 % faster than 2). */
export function defaultConcurrency(n: number = typeof availableParallelism === 'function' ? availableParallelism() : osCpus().length): number {
  return Math.max(1, Math.min(8, Math.floor(n * 0.75)));
}

/** What the settings ask, resolved for this machine before any browser opens (pure: `resolveRenderPolicy`). */
export interface RenderPolicy {
  gl: { asked: RenderGlSetting; resolved: RenderGl; source: RenderSettingSource };
  encoder: { asked: RenderEncoderSetting; source: RenderSettingSource };
  /** Which ffmpeg encodes the frames (L7.3). */
  ffmpeg: { asked: RenderFfmpegSetting; source: RenderSettingSource };
  /** Frames at a time: the setting, else the default of the resolved GL. */
  concurrency: number;
  concurrencySource: RenderSettingSource;
  platform: NodeJS.Platform;
}

export interface ResolvePolicyInput {
  /** An explicit option (the CLI flag, a test): wins over everything. */
  option?: RenderSettings;
  /** retake.yaml `render:`. */
  workspace?: RenderSettings;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  cpus?: number;
}

/** The policy of these settings on this platform (pure); RenderError for a value that cannot work here. */
export function resolveRenderPolicy(o: ResolvePolicyInput = {}): RenderPolicy {
  const platform = o.platform ?? process.platform;
  let fromEnv: RenderSettings;
  try {
    fromEnv = renderSettingsFromEnv(o.env ?? {});
  } catch (e) {
    if (e instanceof RenderSettingsError) throw new RenderError(e.message);
    throw e;
  }
  const pick = <K extends keyof RenderSettings>(k: K): [NonNullable<RenderSettings[K]>, RenderSettingSource] | null => {
    if (o.option?.[k] !== undefined) return [o.option[k]!, 'option'];
    if (o.workspace?.[k] !== undefined) return [o.workspace[k]!, 'retake.yaml'];
    if (fromEnv[k] !== undefined) return [fromEnv[k]!, 'env'];
    return null;
  };
  const [glAsked, glSource] = pick('gl') ?? ['auto', 'default'];
  const resolved: RenderGl = glAsked === 'gpu' ? 'angle' : glAsked === 'software' ? 'software' : platform === 'darwin' ? 'angle' : 'software';
  const [encAsked, encSource] = pick('encoder') ?? ['auto', 'default'];
  if (encAsked === 'videotoolbox' && platform !== 'darwin') {
    throw new RenderError(`render encoder videotoolbox (${sourceWords(encSource, 'encoder')}) works only on macOS: use auto or libx264 here`);
  }
  const c = pick('concurrency');
  let concurrency: number;
  if (c) {
    concurrency = Math.round(c[0]);
    if (!(concurrency >= 1 && concurrency <= RENDER_CONCURRENCY_MAX)) throw new RenderError(`render concurrency ${c[0]} (${sourceWords(c[1], 'concurrency')}) must be from 1 to ${RENDER_CONCURRENCY_MAX}`);
  } else concurrency = resolved === 'angle' ? GPU_CONCURRENCY : defaultConcurrency(o.cpus);
  const [ffAsked, ffSource] = pick('ffmpeg') ?? ['auto', 'default'];
  return { gl: { asked: glAsked, resolved, source: glSource }, encoder: { asked: encAsked, source: encSource }, ffmpeg: { asked: ffAsked, source: ffSource }, concurrency, concurrencySource: c ? c[1] : 'default', platform };
}

/** "retake.yaml render.gl", "$RETAKE_RENDER_GL"… */
export function sourceWords(source: RenderSettingSource, key: keyof RenderSettings): string {
  const env = RENDER_ENV[key];
  return source === 'retake.yaml' ? `retake.yaml render.${key}` : source === 'env' ? `$${env}` : source === 'option' ? 'the command' : 'the default';
}

/** The render policy of a work: its workspace's retake.yaml `render:` (`work`: core WorkPolicy), the environment, then `option`. */
export function renderPolicy(work: WorkPolicy, option?: RenderSettings): RenderPolicy {
  return resolveRenderPolicy({ ...(option ? { option } : {}), workspace: work.render ? { ...work.render } : undefined, env: process.env, platform: process.platform });
}

/** The policy with a GL other than the resolved one (the software reopen, the fallback): its default concurrency follows unless set. */
export function withGl(p: RenderPolicy, gl: RenderGl, o: { keepConcurrency?: boolean } = {}): RenderPolicy {
  const concurrency = p.concurrencySource !== 'default' || o.keepConcurrency ? p.concurrency : gl === 'angle' ? GPU_CONCURRENCY : defaultConcurrency();
  return { ...p, gl: { ...p.gl, resolved: gl }, concurrency };
}

/**
 * The GL a library preview of this process is drawn with, for its cache key (engine library.ts, review M1): the
 * resolved policy before any browser opens — the Studio server and the job process compute the same one from the same
 * retake.yaml and environment. A setting that cannot work gives "invalid" (the preview itself then fails and says why).
 */
export function previewGlKey(work: WorkPolicy): string {
  try {
    return renderPolicy(work).gl.resolved;
  } catch {
    return 'invalid';
  }
}

// ── Encoding ──────────────────────────────────────────────────────────────────

export interface FrameSize {
  width: number;
  height: number;
  fps: number;
}

/** VideoToolbox's bitrate for a render (Mb/s): 0.13 bit per pixel per frame, to 0.5 Mb/s, at least 1. Pure. */
export function videotoolboxMbps(s: FrameSize): number {
  const mbps = (VIDEOTOOLBOX_BITS_PER_PIXEL * s.width * s.height * s.fps) / 1e6;
  return Math.max(VIDEOTOOLBOX_MIN_MBPS, Math.round(mbps * 2) / 2);
}

/** The key-frame interval of a VideoToolbox render: 2 s (ffmpeg's default is 12 frames when none is given). Pure. */
export function gopFrames(fps: number): number {
  return Math.max(1, Math.round(2 * fps));
}

/** Does VideoToolbox take this size (each side ≤ VIDEOTOOLBOX_MAX_SIDE)? Pure. */
export function videotoolboxFits(s: Pick<FrameSize, 'width' | 'height'>): boolean {
  return s.width <= VIDEOTOOLBOX_MAX_SIDE && s.height <= VIDEOTOOLBOX_MAX_SIDE;
}

/** The encoding fields of `renderMedia` for an encoder (pure): CRF for libx264; bitrate + GOP + `required` for VideoToolbox. */
export function remotionEncoding(encoder: RenderEncoder, s: FrameSize): { crf: number } | { hardwareAcceleration: 'required'; videoBitrate: string; gopSize: number } {
  if (encoder === 'libx264') return { crf: RENDER_CRF };
  // `required`, never `if-possible` (Remotion would switch to libx264 silently and the record would lie); never `crf`
  // with it (Remotion then keeps libx264, or throws with `required`).
  return { hardwareAcceleration: 'required', videoBitrate: `${videotoolboxMbps(s)}M`, gopSize: gopFrames(s.fps) };
}

/** What a render record says of its encoding (render/types.ts `encoding`). Pure. */
export function encodingRecord(encoder: RenderEncoder, s: FrameSize): { encoder: RenderEncoder; crf?: number; bitrate?: string; gop?: number } {
  return encoder === 'libx264' ? { encoder, crf: RENDER_CRF } : { encoder, bitrate: `${videotoolboxMbps(s)}M`, gop: gopFrames(s.fps) };
}

// ── The VideoToolbox probe ────────────────────────────────────────────────────

/** A probe's answer: works, or why not (ffmpeg's first error line). */
export interface EncoderProbe {
  ok: boolean;
  error?: string;
}

export type VideotoolboxProbe = (s: FrameSize) => Promise<EncoderProbe>;

const probes = new Map<string, Promise<EncoderProbe>>();

/**
 * Can the compositor's ffmpeg — the binary that will encode the render — encode VideoToolbox H.264 at this size? A
 * 3-frame `nullsrc` encode (that ffmpeg has no `color` source) with the render's bitrate and GOP, spawned exactly as
 * Remotion spawns it (RenderInternals.callFf: its folder as cwd, DYLD_LIBRARY_PATH there — without them it aborts in
 * dyld). Cached per process, binaries folder and size. `binariesDirectory`: another compositor folder (tests: a relinked
 * copy, as the app bundle has); default Remotion's own.
 */
export function videotoolboxRenderWorks(s: FrameSize, o: { binariesDirectory?: string | null; platform?: NodeJS.Platform } = {}): Promise<EncoderProbe> {
  if ((o.platform ?? process.platform) !== 'darwin') return Promise.resolve({ ok: false, error: 'VideoToolbox is macOS only' });
  const key = `${o.binariesDirectory ?? ''}|${s.width}x${s.height}@${s.fps}`;
  let p = probes.get(key);
  if (!p) {
    p = runProbe(s, o.binariesDirectory ?? null);
    probes.set(key, p);
  }
  return p;
}

/** The probe's ffmpeg arguments: three `nullsrc` frames at the render's size, bitrate and GOP. Pure. */
export function videotoolboxProbeArgs(s: FrameSize): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', `nullsrc=s=${s.width}x${s.height}:r=${s.fps}`,
    '-frames:v', '3', '-pix_fmt', 'yuv420p',
    '-c:v', 'h264_videotoolbox', '-b:v', `${videotoolboxMbps(s)}M`, '-g', String(gopFrames(s.fps)),
    '-f', 'null', '-',
  ];
}

async function runProbe(s: FrameSize, binariesDirectory: string | null): Promise<EncoderProbe> {
  const args = videotoolboxProbeArgs(s);
  try {
    const { RenderInternals } = await rendererLibrary();
    const res = await RenderInternals.callFf({ bin: 'ffmpeg', args, indent: false, logLevel: 'error', binariesDirectory, cancelSignal: undefined, options: { reject: false, timeout: 15_000, stdin: 'ignore' } });
    if (res.exitCode === 0) return { ok: true };
    const line = String(res.stderr ?? '').split('\n').map((l) => l.trim()).find((l) => l && !/^Try\b/.test(l));
    return { ok: false, error: (line ?? `exit ${res.exitCode ?? res.signal ?? '?'}`).slice(0, 200) };
  } catch (e) {
    return { ok: false, error: `the compositor's ffmpeg did not run: ${String((e as Error)?.message ?? e).split('\n')[0].slice(0, 200)}` };
  }
}

/** Forget the cached probes (tests). */
export function resetVideotoolboxProbes(): void {
  probes.clear();
}

/** The encoder of a render, chosen before it starts. `note`: why `auto` did not take VideoToolbox (a warning of the record). */
export interface EncoderChoice {
  encoder: RenderEncoder;
  note?: string;
}

/**
 * The encoder for a render of this size drawn with `gl` (the GL actually used, after the GPU check). `auto`:
 * VideoToolbox with the GPU path, when the size fits and the probe passes, else libx264 and the note says why;
 * `videotoolbox` forced: a RenderError when it cannot work (the size, the probe); `libx264`: libx264. A cancel
 * (`signal`) ends the wait for the probe at once (RenderCancelledError); the probe itself runs on, bounded by its
 * timeout, and its answer stays cached for the next render.
 */
export async function chooseEncoder(
  policy: RenderPolicy,
  gl: RenderGl,
  s: FrameSize,
  probe: VideotoolboxProbe = (x) => videotoolboxRenderWorks(x, { platform: policy.platform }),
  o: { signal?: AbortSignal } = {},
): Promise<EncoderChoice> {
  const asked = policy.encoder.asked;
  if (asked === 'libx264') return { encoder: 'libx264' };
  if (asked === 'auto' && (gl !== 'angle' || policy.platform !== 'darwin')) return { encoder: 'libx264' };
  const where = sourceWords(policy.encoder.source, 'encoder');
  if (!videotoolboxFits(s)) {
    const why = `VideoToolbox encodes at most ${VIDEOTOOLBOX_MAX_SIDE} pixels a side and this render is ${s.width}×${s.height}`;
    if (asked === 'videotoolbox') throw new RenderError(`${why} (render encoder videotoolbox, ${where}): use auto or libx264 for it`);
    return { encoder: 'libx264', note: `${why}: encoded with libx264` };
  }
  const r = await untilCancelled(probe(s), o.signal);
  if (r.ok) return { encoder: 'h264_videotoolbox' };
  const why = `VideoToolbox does not encode here (${r.error ?? 'the probe failed'})`;
  if (asked === 'videotoolbox') throw new RenderError(`${why} (render encoder videotoolbox, ${where}): use auto or libx264`);
  return { encoder: 'libx264', note: `${why}: encoded with libx264` };
}

/** `p`, or RenderCancelledError as soon as `signal` aborts (the work behind `p` is not stopped). */
function untilCancelled<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new RenderCancelledError());
  return new Promise<T>((done, fail) => {
    const onAbort = () => fail(new RenderCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(done, fail).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// ── The encode ffmpeg (L7.3) ──────────────────────────────────────────────────

/**
 * What `auto` means for the encode ffmpeg, by where the render runs. Ours on the GPU path — the one path where it was
 * measured to pass the lot's threshold (about a fifth less CPU; no measured gain in time). The library's on the
 * software path (the gain measured there is under the threshold) and inside the app bundle (not checked there: the
 * dispatcher and the linked compositor under the hardened runtime were not run). `render.ffmpeg: own` asks for ours on
 * any of them.
 */
export const AUTO_ENCODE_FFMPEG: { readonly gpu: 'own' | 'library'; readonly software: 'own' | 'library'; readonly app: 'own' | 'library' } = { gpu: 'own', software: 'library', app: 'library' };

/** The record's words when `auto` takes the library's by its rule (not because ours was refused). */
export const AUTO_LIBRARY_NOTES = {
  software: "auto: the rendering library's ffmpeg on the software path",
  app: "auto: the rendering library's ffmpeg inside the desktop app",
} as const;
/** The record's words on the second attempt of a render whose first failed while our ffmpeg encoded. */
export const RETRY_LIBRARY_NOTE = "this machine's ffmpeg failed at the encode: the video was rendered again with the rendering library's";

/** Which ffmpeg `auto` takes for a render drawn with `gl` (pure). */
export function autoEncodeFfmpeg(gl: RenderGl, inApp: boolean): { want: 'own' | 'library'; note?: string } {
  const where = inApp ? 'app' : gl === 'angle' ? 'gpu' : 'software';
  const want = AUTO_ENCODE_FFMPEG[where];
  return want === 'library' && where !== 'gpu' ? { want, note: AUTO_LIBRARY_NOTES[where] } : { want };
}

/** Which ffmpeg encodes a render's frames, chosen before it starts. */
export interface EncodeFfmpegChoice {
  used: 'own' | 'library';
  /** Our ffmpeg's version, when it was looked at. */
  version?: string;
  /** Our ffmpeg's real path (`used: 'own'`). */
  path?: string;
  /** The folder the library is given for the render (`used: 'own'`; absent from a dry choice). */
  binariesDirectory?: string;
  /**
   * Why the library's encodes although the setting is not `library`: one of this code's own sentences (with our
   * ffmpeg's version at most), never what a program or the system said — the record keeps it.
   */
  note?: string;
  /** The library's is what the setting's rule gives here (`auto` on the software path, in the app; the second attempt): ours was not wanted. */
  byRule?: true;
  /** What a program or the system said about `note` (untrusted words: for the warnings, never the record). */
  detail?: string;
}

/** The encoder and the ffmpeg of a render (`chooseEncode`). */
export interface EncodeChoice extends EncoderChoice {
  ffmpeg: EncodeFfmpegChoice;
}

/** The frame-encode probe of our ffmpeg (encode-tools.ts `probeFrameEncode`), for whichever encoder was chosen. */
export type OwnEncodeProbe = (path: string, s: FrameSize, encoder: RenderEncoder) => Promise<EncoderProbe>;

export interface ChooseEncodeOptions {
  workPolicy: WorkPolicy;
  /** The VideoToolbox probe of a test: answers for whichever ffmpeg would encode. */
  videotoolbox?: VideotoolboxProbe;
  signal?: AbortSignal;
  /** The library's ffmpeg whatever the setting: the second attempt of a render whose first failed while ours encoded. */
  library?: boolean;
  /** Decide without writing the encode tools folder (`retake doctor`). */
  dry?: boolean;
  /** Our ffmpeg, for tests (default: the work's, read from the binary). */
  own?: (compositor: string) => Promise<OwnFfmpeg>;
  /** The frame-encode probe of our ffmpeg, for tests (default: the command itself on three frames, cached). */
  ownEncodes?: OwnEncodeProbe;
  /** The Retake home the folder is made in (default: this process's). */
  home?: string;
  /** This process runs from the app bundle (default: read from where it runs; tests). */
  inApp?: boolean;
}

/**
 * The ffmpeg this work runs, as an absolute path (a bare PATH name looked up; the bare name when the PATH has none).
 * Throws when the agent policy refuses it, or when the PATH finds it through a folder no program is started from.
 */
export function workFfmpeg(work: WorkPolicy, lookup: ProgramPolicyOptions = programLookup()): string {
  const bin = ffmpegBin(work);
  if (isAbsolute(bin)) return bin;
  const found = agentProgram(bin, 'ffmpeg', [], lookup);
  if (found.problem) throw new Error(found.problem);
  return found.program;
}

/** `p` with the part of it that exists resolved (links, /var → /private/var): where a file not made yet will really lie. */
function realTarget(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realTarget(parent), basename(p));
  }
}

/** The encoder and rate of a frame encode, as the library writes them for `remotionEncoding` (pure). */
export function frameEncodeCodecArgs(encoder: RenderEncoder, s: FrameSize): string[] {
  return encoder === 'libx264' ? ['-c:v', 'libx264', '-crf', String(RENDER_CRF)] : ['-c:v', 'h264_videotoolbox', '-b:v', `${videotoolboxMbps(s)}M`, '-g', String(gopFrames(s.fps))];
}

/**
 * Can our ffmpeg run this render's frame encode — the command itself, with the encoder chosen, on three frames at the
 * render's size (so VideoToolbox is tried as the render will use it)? Cached per process, file, encoder and size; an
 * answer that is no answer (the probe did not finish) is asked again.
 */
function ownEncodes(path: string, s: FrameSize, encoder: RenderEncoder): Promise<EncoderProbe> {
  const key = `own:${fileId(path)}|${encoder}|${s.width}x${s.height}@${s.fps}`;
  let p = probes.get(key);
  if (!p) {
    p = probeFrameEncode(path, s, frameEncodeCodecArgs(encoder, s));
    probes.set(key, p);
    void p.then((r) => {
      if (!r.ok && /^exit \?$/.test(r.error ?? '') && probes.get(key) === p) probes.delete(key);
    });
  }
  return p;
}

/**
 * The encoder (`chooseEncoder`) and the ffmpeg that encodes the frames. Ours is taken only when the setting asks for it
 * — `own`, or `auto` for a render drawn on the GPU outside the app bundle (`autoEncodeFfmpeg`) —, it qualifies
 * (encode-tools.ts `ownFfmpeg`), it has not failed at an encode in this process, it runs the frame encode itself with
 * the encoder chosen (`ownEncodes`; VideoToolbox: when ours cannot, the library's is probed and encodes, exactly as
 * before) and its folder can be made outside the workspace. In every other case the library's encodes and `note` says
 * why: never an error, a render works without our ffmpeg as it did before L7.3.
 */
export async function chooseEncode(policy: RenderPolicy, gl: RenderGl, s: FrameSize, o: ChooseEncodeOptions): Promise<EncodeChoice> {
  const asked = policy.ffmpeg.asked;
  const rule: { want: 'own' | 'library'; note?: string } = o.library
    ? { want: 'library', ...(asked === 'library' ? {} : { note: RETRY_LIBRARY_NOTE }) }
    : asked === 'auto'
      ? autoEncodeFfmpeg(gl, o.inApp ?? bundleInfoOrNull() !== null)
      : { want: asked };
  const signal = o.signal ? { signal: o.signal } : {};
  const libraryProbe: VideotoolboxProbe = o.videotoolbox ?? ((x) => videotoolboxRenderWorks(x, { platform: policy.platform }));
  if (rule.want === 'library') return { ...(await chooseEncoder(policy, gl, s, libraryProbe, signal)), ffmpeg: { used: 'library', ...(rule.note ? { note: rule.note, byRule: true as const } : {}) } };
  let dir = '';
  let own: OwnFfmpeg;
  try {
    dir = await compositorDir();
    own = await (o.own ?? ((c: string) => ownFfmpeg({ resolve: () => workFfmpeg(o.workPolicy), compositorDir: c, platform: policy.platform })))(dir);
  } catch (e) {
    own = { ok: false, reason: "the rendering library's programs were not found", detail: firstLine(e) };
  }
  const encodes: OwnEncodeProbe = o.ownEncodes ?? ownEncodes;
  let ownEncodesVideotoolbox = false;
  let ownSaid: string | undefined;
  const probe: VideotoolboxProbe = async (x) => {
    if (own.ok && own.facts.videotoolbox && !ownEncodeFailedEarlier(own.path)) {
      const r = await (o.videotoolbox ?? ((y: FrameSize) => encodes(own.path, y, 'h264_videotoolbox')))(x);
      if (r.ok || o.videotoolbox) {
        ownEncodesVideotoolbox = r.ok;
        return r;
      }
      ownSaid = r.error;
    }
    return libraryProbe(x);
  };
  const choice = await chooseEncoder(policy, gl, s, probe, signal);
  const library = (note: string, detail?: string): EncodeChoice => ({ ...choice, ffmpeg: { used: 'library', ...(own.ok ? { version: own.facts.version } : {}), note, ...(detail ? { detail } : {}) } });
  if (!own.ok) return library(own.reason, own.detail);
  if (ownEncodeFailedEarlier(own.path)) return library(`this machine's ffmpeg (${own.facts.version}) failed at an encode earlier in this process`);
  if (choice.encoder === 'h264_videotoolbox' && !ownEncodesVideotoolbox) return library(`this machine's ffmpeg (${own.facts.version}) does not encode VideoToolbox here`, ownSaid);
  if (choice.encoder === 'libx264') {
    if (!own.facts.libx264) return library(`this machine's ffmpeg (${own.facts.version}) has no libx264`);
    const r = await untilCancelled(encodes(own.path, s, 'libx264'), o.signal);
    if (!r.ok) return library(`this machine's ffmpeg (${own.facts.version}) does not run the frame encode`, r.error);
  }
  // Judged before anything is written, and for `retake doctor` too: a Retake home inside the workspace gets no program of ours.
  const home = o.home ?? retakeHome();
  try {
    if (programProblem(o.workPolicy, realTarget(join(home, ENCODE_TOOLS_DIR, 'ffmpeg')), 'the encode tools', programLookup())) return library('the encode tools would lie inside the workspace (the Retake home is there)');
    if (o.dry) return { ...choice, ffmpeg: { used: 'own', version: own.facts.version, path: own.path } };
    const folder = encodeFolder({ home, compositorDir: dir, ffmpegPath: own.path });
    return { ...choice, ffmpeg: { used: 'own', version: own.facts.version, path: own.path, binariesDirectory: folder } };
  } catch (e) {
    if (e instanceof EncodeToolsError) return library(e.message, e.detail);
    return library('the encode tools folder cannot be made', firstLine(e));
  }
}

function firstLine(e: unknown): string {
  return String((e as Error)?.message ?? e).split('\n')[0].slice(0, 200);
}

/** The library's own messages when the frame encode's ffmpeg is gone or quits while frames are piped to it. */
const FRAME_ENCODE_FAILED = /FFmpeg already quit while trying to pipe frame|FFmpeg quit with code [^\n]*? while piping frame|FFmpeg is not available while trying to pipe frame/;

/**
 * Is this failure our ffmpeg's own at the frame encode — so that the same render with the library's ffmpeg would
 * succeed? Yes for: the encode tools refusing the command (`rewritePreStitcher`), the library saying the frame encode's
 * ffmpeg quit or is gone while frames were piped to it, its pipe closing (EPIPE), a program of the tools folder
 * (`folder`) that could not be started (ENOENT, EACCES). Never a cancel, a full disk, a timeout, an out-of-memory, an
 * error of the plan; never the final file's ffmpeg failing ("The FFmpeg output was": the library's own, at the audio or
 * the mux — it would fail again); never an output whose banner names another version than ours (`version`). Returns
 * the reason (one line) or null. Pure.
 */
export function ownEncodeFailure(e: unknown, own: { version?: string; folder?: string } = {}): string | null {
  if (e instanceof EncodeToolsError) return e.message.slice(0, 200);
  if (e instanceof RenderCancelledError || isDiskFullError(e) || e instanceof RenderError) return null;
  const err = e as { message?: unknown; name?: unknown; code?: unknown; path?: unknown } | null;
  const message = typeof err?.message === 'string' ? err.message : String(e ?? '');
  if (err?.name === 'AbortError' || /cancel/i.test(message)) return null;
  if (/time(?:d)? ?out|timeout|out of memory|\bOOM\b|ENOMEM|cannot allocate|page crashed|aw, snap|delayRender/i.test(message)) return null;
  const notStarted = /\b(ENOENT|EACCES)\b/.exec(`${typeof err?.code === 'string' ? err.code : ''} ${message}`)?.[1];
  if (notStarted && own.folder && (message.includes(own.folder) || (typeof err?.path === 'string' && err.path.startsWith(own.folder)))) return `a program of the encode tools could not be started (${notStarted})`;
  if (message.includes('The FFmpeg output was')) return null;
  if (err?.code !== 'EPIPE' && !/\bEPIPE\b/.test(message) && !FRAME_ENCODE_FAILED.test(message)) return null;
  // A second guard: the output of another ffmpeg than ours (its banner names its version).
  const banner = /^(?:.*Stderr: )?ffmpeg version\s+n?(\S+)/m.exec(message)?.[1];
  if (banner && own.version && banner !== own.version.replace(/^n/, '')) return null;
  const lines = message.split('\n').map((l) => l.replace(/^.*?Stderr: /, '').trim()).filter(Boolean);
  const said = lines.find((l) => /error|invalid|unrecognized|unknown|no such|not found|cannot|unable|failed/i.test(l) && !/^FFmpeg (?:quit|already|is not)/.test(l));
  // Else the library's own sentence, without the output it quotes.
  const head = message.split('\n')[0].replace(/\.? Stderr:.*$/, '').trim();
  return (said ?? (head || 'the frame encode failed')).slice(0, 200);
}

// ── The GPU check ─────────────────────────────────────────────────────────────

/** The render browser's GPU status (CDP SystemInfo.getInfo on its connection), undefined when it does not say. */
export async function renderGpuInfo(browser: RenderBrowserHandle): Promise<GpuInfo | undefined> {
  const conn = browser.connection as { send(method: string, params?: unknown): Promise<unknown> };
  try {
    const r = (await conn.send('SystemInfo.getInfo')) as { value?: unknown };
    return gpuInfoOf(((r as { value?: unknown })?.value ?? r) as SystemInfoReply);
  } catch {
    return undefined;
  }
}

/**
 * On macOS, the switches of the render browser's own command line (CDP Browser.getBrowserCommandLine: what it was
 * really started with, those a wrapper executable adds included) that turn its sandbox or site isolation off — core
 * sandboxSwitchOff, the Linux-only ones aside (Remotion passes `--no-zygote`; macOS has no zygote); Remotion's other
 * switches (its debugging port) are its own. Empty elsewhere (Linux renders run as Remotion starts them) and when the
 * browser does not report its command line.
 */
export async function renderSandboxOff(browser: RenderBrowserHandle, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (platform !== 'darwin') return [];
  const conn = browser.connection as { send(method: string, params?: unknown): Promise<unknown> };
  try {
    const r = (await conn.send('Browser.getBrowserCommandLine')) as { value?: { arguments?: unknown }; arguments?: unknown };
    const argv = (r?.value?.arguments ?? r?.arguments) as unknown;
    return Array.isArray(argv) ? argv.filter((a): a is string => typeof a === 'string' && sandboxSwitchOff(a, { platform }) !== null) : [];
  } catch {
    return [];
  }
}

/** The refusal of a render browser that runs without its sandbox or site isolation (renderSandboxOff). */
export function renderSandboxRefusal(off: readonly string[]): string {
  return (
    `the render browser runs with ${off.map((a) => (a.length > 80 ? `${a.slice(0, 77)}…` : a)).join(' ')} on its command line, which turns its sandbox or site isolation off — ` +
    'its executable adds switches itself (RETAKE_CHROMIUM_HEADLESS_SHELL): use one that starts Chromium as it is given'
  );
}

/** A Remotion browser opened by the policy (`openRenderBrowser`). */
export interface PolicyBrowser<B> {
  puppeteer: B;
  /** How it draws, after the GPU check. */
  gl: RenderGl;
  /** What it reported (ANGLE only). */
  gpu?: GpuInfo;
  /** "no GPU for this render (…): rendered in software", or the `gpu` setting kept without one. */
  warnings: string[];
  /** The `chromiumOptions` of its Remotion calls (a browser Remotion replaces after a crash draws the same way). */
  chromium: { gl?: 'angle' };
}

/**
 * Open a Remotion browser as the policy says — every Remotion browser of this process is opened here (renders, stills,
 * previews). Software: no `chromiumOptions` (the renders of before L5.15, byte for byte). ANGLE: its GPU is checked
 * (CDP SystemInfo); none under `auto` → closed and opened again in software, `gpu` → kept, with a warning. The caller
 * reports the browser (`onBrowser`) and arms its network guard after this, on the browser that will render.
 */
export async function openRenderBrowser<B extends RenderBrowserHandle & { close(o: { silent: boolean }): Promise<unknown> }>(o: {
  policy: RenderPolicy;
  launch: (chromium: { gl?: 'angle' }) => Promise<B>;
  gpuInfo?: (browser: B) => Promise<GpuInfo | undefined>;
  /** The platform the sandbox check reads for (renderSandboxOff; default this process's). */
  platform?: NodeJS.Platform;
}): Promise<PolicyBrowser<B>> {
  const warnings: string[] = [];
  let gl = o.policy.gl.resolved;
  // Every browser opened here is refused when its own command line turns its sandbox or site isolation off.
  const launch = async (chromium: { gl?: 'angle' }): Promise<B> => {
    const b = await o.launch(chromium);
    const off = await renderSandboxOff(b, o.platform);
    if (off.length) {
      await b.close({ silent: true }).catch(() => undefined);
      throw new RenderError(renderSandboxRefusal(off));
    }
    return b;
  };
  let puppeteer = await launch(gl === 'angle' ? { gl: 'angle' } : {});
  let gpu: GpuInfo | undefined;
  if (gl === 'angle') {
    gpu = await (o.gpuInfo ?? renderGpuInfo)(puppeteer);
    if (!gpu?.accelerated) {
      const seen = rendererWords(gpu) ?? 'it reported no GPU status';
      if (o.policy.gl.asked === 'gpu') warnings.push(`the render browser found no GPU (${seen}): drawn with ANGLE anyway (render gl: gpu, ${sourceWords(o.policy.gl.source, 'gl')})`);
      else {
        warnings.push(`no GPU for this render (${seen}): rendered in software`);
        await puppeteer.close({ silent: true }).catch(() => undefined);
        gl = 'software';
        gpu = undefined;
        puppeteer = await launch({});
      }
    }
  }
  return { puppeteer, gl, ...(gpu ? { gpu } : {}), warnings, chromium: gl === 'angle' ? { gl: 'angle' } : {} };
}

/** A renderer name for a record (plain text, at most 200 characters). Pure. */
export function rendererWords(info: GpuInfo | undefined): string | undefined {
  const r = info?.renderer?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return r ? r.slice(0, 200) : undefined;
}

// ── The fallback ──────────────────────────────────────────────────────────────

/**
 * Is this failure the GPU path's own — the GPU process lost, the GL context gone, the hardware encoder (or its pipe)
 * failing — so that the same render in software would succeed? Never a cancel, a full disk, a frame timeout, an
 * out-of-memory, a crashed page (usually memory), or an error of the plan (a RenderError of ours). Returns the reason
 * (its first line) or null. Pure.
 */
export function gpuPathFailure(e: unknown, path: { gl: RenderGl; encoder: RenderEncoder }): string | null {
  return gpuPathFailureOf(e, path)?.reason ?? null;
}

/**
 * `gpuPathFailure` with the sign that told: `encoder` — the hardware encoder's own lines or its pipe closing, which is
 * also how the ffmpeg that runs it fails (render.ts: when ours was encoding, the record says so) — or `gl`.
 */
export function gpuPathFailureOf(e: unknown, path: { gl: RenderGl; encoder: RenderEncoder }): { reason: string; sign: 'encoder' | 'gl' } | null {
  if (path.gl !== 'angle' && path.encoder !== 'h264_videotoolbox') return null;
  if (e instanceof RenderCancelledError || isDiskFullError(e)) return null;
  if (e instanceof RenderError) return null;
  const err = e as { message?: unknown; name?: unknown; code?: unknown } | null;
  const message = typeof err?.message === 'string' ? err.message : String(e ?? '');
  if (err?.name === 'AbortError' || /cancel/i.test(message)) return null;
  if (/time(?:d)? ?out|timeout|out of memory|\bOOM\b|ENOMEM|cannot allocate|page crashed|aw, snap|delayRender/i.test(message)) return null;
  // ffmpeg's errors come after its banner, whose configuration line names videotoolbox on every build: only the
  // other lines count, and the reason is the line that says it.
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  const banner = /^(?:ffmpeg version|built with|configuration:|lib(?:av|sw|post)\w*\s|Input #|Output #|Stream #|Duration:|Metadata:|Stream mapping|Press \[q\]|(?:encoder|handler_name|vendor_id|major_brand|compatible_brands|minor_version|creation_time)\s*:)/i;
  const useful = lines.filter((l) => !banner.test(l));
  const said = (...res: RegExp[]) => {
    for (const re of res) {
      const l = useful.find((x) => re.test(x));
      if (l) return l.slice(0, 200);
    }
    return (useful[0] ?? lines[0] ?? 'unknown error').slice(0, 200);
  };
  // Strong signs only (review B M2): a line that merely names the encoder — a stream's `encoder : Lavc… h264_videotoolbox`
  // metadata quoted by a stitch or audio failure — is not one; nor is an audio encoder that does not open.
  const strongEncoder = /\[h264_videotoolbox @|compression session|VTCompressionSession|-1290\d|\bEPIPE\b/i;
  const encoderOpen = (l: string) => /Error while opening encoder/i.test(l) && !/aost#|\baac\b|audio/i.test(l);
  if (path.encoder === 'h264_videotoolbox' && (err?.code === 'EPIPE' || useful.some((l) => strongEncoder.test(l) || encoderOpen(l)))) {
    return { reason: useful.find((l) => strongEncoder.test(l))?.slice(0, 200) ?? useful.find(encoderOpen)?.slice(0, 200) ?? said(), sign: 'encoder' };
  }
  const glSign = /GPU process|gpu[-_ ]process|GPU (?:crash|lost|exited)|context (?:was )?lost|CONTEXT_LOST|GL context|WebGL|\bEGL\b|\bANGLE\b|\bMetal\b/i;
  if (path.gl === 'angle' && useful.some((l) => glSign.test(l))) return { reason: said(glSign), sign: 'gl' };
  return null;
}

// ── Doctor ────────────────────────────────────────────────────────────────────

/** What `retake doctor`'s "Renders" line reads (`probeRenderPath`). */
export interface RenderPathProbe {
  /** The policy of this process, or why it cannot be used. */
  policy?: RenderPolicy;
  error?: string;
  /** With ANGLE: what the render browser reported (opened as a render opens it), or why it did not start. */
  gpu?: GpuInfo;
  browserError?: string;
  /** How a render would draw here. */
  gl?: RenderGl;
  /** The VideoToolbox probe at 1920×1080, 30 fps (asked only when the encoder may be VideoToolbox). */
  videotoolbox?: EncoderProbe;
  /** The encoder a 1080p render would use. */
  encoder?: RenderEncoder;
  /** Frames at a time for that GL. */
  concurrency?: number;
  /** The ffmpeg that would encode the frames (L7.3; nothing written). */
  ffmpeg?: EncodeFfmpegChoice;
}

/**
 * The render path of this machine as a 1080p30 render would take it — the same checks, nothing written: the policy,
 * the render browser opened as renders open it (ANGLE: its GPU), and the VideoToolbox probe. Never throws.
 */
export async function probeRenderPath(o: { workPolicy: WorkPolicy; gpuInfo?: (b: RenderBrowserHandle) => Promise<GpuInfo | undefined>; videotoolbox?: VideotoolboxProbe; own?: ChooseEncodeOptions['own']; ownEncodes?: ChooseEncodeOptions['ownEncodes'] }): Promise<RenderPathProbe> {
  let policy: RenderPolicy;
  try {
    policy = renderPolicy(o.workPolicy);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const out: RenderPathProbe = { policy, gl: policy.gl.resolved };
  if (policy.gl.resolved === 'angle') {
    try {
      const { renderBrowser } = await import('./browser.js');
      const { openBrowser } = await rendererLibrary();
      const b = renderBrowser();
      if (!b.path) out.browserError = 'no render browser to open (see the Render browser line)';
      else {
        const browser = await openBrowser('chrome', { browserExecutable: b.path, chromeMode: 'headless-shell', logLevel: 'error', chromiumOptions: { gl: 'angle' } });
        try {
          const off = await renderSandboxOff(browser);
          if (off.length) throw new Error(renderSandboxRefusal(off));
          out.gpu = (await (o.gpuInfo ?? renderGpuInfo)(browser)) ?? undefined;
        } finally {
          await browser.close({ silent: true }).catch(() => undefined);
        }
      }
    } catch (e) {
      out.browserError = String((e as Error)?.message ?? e).split('\n')[0].slice(0, 200);
    }
    if (!out.gpu?.accelerated && policy.gl.asked !== 'gpu') out.gl = 'software';
  }
  const gl = out.gl!;
  const p = gl === policy.gl.resolved ? policy : withGl(policy, gl);
  out.concurrency = p.concurrency;
  const size = { width: 1920, height: 1080, fps: 30 };
  const maybeVt = policy.encoder.asked === 'videotoolbox' || (policy.encoder.asked === 'auto' && gl === 'angle' && policy.platform === 'darwin');
  if (maybeVt) out.videotoolbox = await (o.videotoolbox ?? ((s: FrameSize) => videotoolboxRenderWorks(s, { platform: policy.platform })))(size);
  try {
    // The encoder and which ffmpeg would encode: the same choice a render makes, without writing its folder.
    const c = await chooseEncode(p, gl, size, { workPolicy: o.workPolicy, dry: true, ...(o.videotoolbox ? { videotoolbox: o.videotoolbox } : {}), ...(o.own ? { own: o.own } : {}), ...(o.ownEncodes ? { ownEncodes: o.ownEncodes } : {}) });
    out.encoder = c.encoder;
    out.ffmpeg = c.ffmpeg;
    // VideoToolbox through our ffmpeg where the library's does not encode it: the line says what renders do.
    if (c.encoder === 'h264_videotoolbox' && c.ffmpeg.used === 'own' && out.videotoolbox && !out.videotoolbox.ok) out.videotoolbox = { ok: true };
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}
