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
 * - One fallback, on the render path only (render.ts): a failure of the GPU path itself (`gpuPathFailure`) renders the
 *   video once more in software with libx264, from scratch.
 */
import { availableParallelism, cpus as osCpus } from 'node:os';
import { RENDER_CONCURRENCY_MAX, RenderSettingsError, gpuInfoOf, renderSettingsFromEnv, workspaceRenderSettings } from '@retake/core';
import type { GpuInfo, RenderEncoderSetting, RenderGlSetting, RenderSettings, SystemInfoReply } from '@retake/core';
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
  return { gl: { asked: glAsked, resolved, source: glSource }, encoder: { asked: encAsked, source: encSource }, concurrency, concurrencySource: c ? c[1] : 'default', platform };
}

/** "retake.yaml render.gl", "$RETAKE_RENDER_GL"… */
export function sourceWords(source: RenderSettingSource, key: keyof RenderSettings): string {
  const env = { gl: 'RETAKE_RENDER_GL', encoder: 'RETAKE_RENDER_ENCODER', concurrency: 'RETAKE_RENDER_CONCURRENCY' }[key];
  return source === 'retake.yaml' ? `retake.yaml render.${key}` : source === 'env' ? `$${env}` : source === 'option' ? 'the command' : 'the default';
}

/** This process's policy: the open workspace's retake.yaml `render:`, the environment, then `option`. */
export function renderPolicy(option?: RenderSettings): RenderPolicy {
  return resolveRenderPolicy({ ...(option ? { option } : {}), workspace: workspaceRenderSettings(), env: process.env, platform: process.platform });
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
export function previewGlKey(): string {
  try {
    return renderPolicy().gl.resolved;
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

async function runProbe(s: FrameSize, binariesDirectory: string | null): Promise<EncoderProbe> {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', `nullsrc=s=${s.width}x${s.height}:r=${s.fps}`,
    '-frames:v', '3', '-pix_fmt', 'yuv420p',
    '-c:v', 'h264_videotoolbox', '-b:v', `${videotoolboxMbps(s)}M`, '-g', String(gopFrames(s.fps)),
    '-f', 'null', '-',
  ];
  try {
    const { RenderInternals } = await import('@remotion/renderer');
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

// ── The GPU check ─────────────────────────────────────────────────────────────

/** The render browser's GPU status (CDP SystemInfo.getInfo on its connection), undefined when it does not say. */
export async function renderGpuInfo(browser: { connection: unknown }): Promise<GpuInfo | undefined> {
  const conn = browser.connection as { send(method: string, params?: unknown): Promise<unknown> };
  try {
    const r = (await conn.send('SystemInfo.getInfo')) as { value?: unknown };
    return gpuInfoOf(((r as { value?: unknown })?.value ?? r) as SystemInfoReply);
  } catch {
    return undefined;
  }
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
export async function openRenderBrowser<B extends { connection: unknown; close(o: { silent: boolean }): Promise<unknown> }>(o: {
  policy: RenderPolicy;
  launch: (chromium: { gl?: 'angle' }) => Promise<B>;
  gpuInfo?: (browser: B) => Promise<GpuInfo | undefined>;
}): Promise<PolicyBrowser<B>> {
  const warnings: string[] = [];
  let gl = o.policy.gl.resolved;
  let puppeteer = await o.launch(gl === 'angle' ? { gl: 'angle' } : {});
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
        puppeteer = await o.launch({});
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
    return useful.find((l) => strongEncoder.test(l))?.slice(0, 200) ?? useful.find(encoderOpen)?.slice(0, 200) ?? said();
  }
  const glSign = /GPU process|gpu[-_ ]process|GPU (?:crash|lost|exited)|context (?:was )?lost|CONTEXT_LOST|GL context|WebGL|\bEGL\b|\bANGLE\b|\bMetal\b/i;
  if (path.gl === 'angle' && useful.some((l) => glSign.test(l))) return said(glSign);
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
}

/**
 * The render path of this machine as a 1080p30 render would take it — the same checks, nothing written: the policy,
 * the render browser opened as renders open it (ANGLE: its GPU), and the VideoToolbox probe. Never throws.
 */
export async function probeRenderPath(o: { gpuInfo?: (b: { connection: unknown }) => Promise<GpuInfo | undefined>; videotoolbox?: VideotoolboxProbe } = {}): Promise<RenderPathProbe> {
  let policy: RenderPolicy;
  try {
    policy = renderPolicy();
  } catch (e) {
    return { error: (e as Error).message };
  }
  const out: RenderPathProbe = { policy, gl: policy.gl.resolved };
  if (policy.gl.resolved === 'angle') {
    try {
      const { renderBrowser } = await import('./browser.js');
      const { openBrowser } = await import('@remotion/renderer');
      const b = renderBrowser();
      if (!b.path) out.browserError = 'no render browser to open (see the Render browser line)';
      else {
        const browser = await openBrowser('chrome', { browserExecutable: b.path, chromeMode: 'headless-shell', logLevel: 'error', chromiumOptions: { gl: 'angle' } });
        try {
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
    out.encoder = (await chooseEncoder(p, gl, size, async () => out.videotoolbox ?? { ok: false, error: 'not probed' })).encoder;
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}
