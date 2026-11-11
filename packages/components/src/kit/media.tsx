/**
 * User files (L2.12, R-OWN-*): a video, an image or a Lottie animation of the project or the theme, drawn instead of a
 * provided component — full frame (intro, outro, card, interstitial) or in a box over the capture (overlay). Used by
 * studio/media and studio/lottie; workspace components may use them too (e.g. a file inside a custom frame).
 *
 * Deterministic: a video plays from its `from` second at the composition's frame rate (trimmed with `to`), once — then
 * holds its last frame — or looped; a Lottie animation is seeked to the frame of the composition (its own frame rate
 * mapped to the video's); its JSON is loaded once per URL from the renderer's asset server (delayRender).
 */
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Img, Loop, OffthreadVideo, Sequence, cancelRender, continueRender, delayRender, useCurrentFrame, useVideoConfig } from 'remotion';
import { Lottie } from '@remotion/lottie';
import type { LottieAnimationData } from '@remotion/lottie';
import type { LottieMedia, PictureMedia, ThemeTokens, VideoMedia } from '../types.js';
import { backgroundCss, nightTone } from './style.js';
import type { MediaFitMode } from './frame-geometry.js';

/** Frames of a video file's part `[from, to)` at `fps` (at least 1). */
export function videoPartFrames(media: Pick<VideoMedia, 'duration_s'>, fps: number, from = 0, to?: number): number {
  const end = Math.min(to ?? media.duration_s, media.duration_s);
  return Math.max(1, Math.floor((end - Math.max(0, from)) * fps + 1e-6));
}

/** Frames of a Lottie animation at the composition's `fps` (its own frame rate mapped). */
export function lottieFrames(media: Pick<LottieMedia, 'frames' | 'fps'>, fps: number): number {
  return Math.max(1, Math.round((media.frames / media.fps) * fps));
}

/** Natural length (s) of a file use: a video part, a Lottie animation; undefined for an image. */
export function mediaLength(media: VideoMedia | LottieMedia | PictureMedia, params: { from?: unknown; to?: unknown } = {}): number | undefined {
  if (media.kind === 'lottie') return media.duration_s;
  if (media.kind !== 'video') return undefined;
  const from = typeof params.from === 'number' ? params.from : 0;
  const to = typeof params.to === 'number' ? params.to : media.duration_s;
  return Math.max(0, Math.min(to, media.duration_s) - from);
}

/**
 * The CSS background around a full-frame file: `theme` (the theme background), `none` / `transparent`, a theme colour
 * key (`paper`, `accent`, `dark` — the night tone when the theme has no `dark`), or any CSS colour.
 */
export function mediaBackground(theme: Pick<ThemeTokens, 'background' | 'colors'>, value: unknown): string {
  const v = typeof value === 'string' && value.trim() !== '' ? value.trim() : 'theme';
  if (v === 'theme') return backgroundCss(theme);
  if (v === 'none' || v === 'transparent') return 'transparent';
  if (v === 'dark' || v === 'night') return nightTone(theme);
  if (Object.hasOwn(theme.colors, v)) return theme.colors[v];
  return v;
}

/** The gain of frame `f` of a part of `n` frames at `volume`: 4-frame ramps at the part's edges (no clicks). */
export function filePartGain(f: number, n: number, volume: number): number {
  const ramp = Math.min(4, Math.floor(n / 4));
  if (ramp <= 0) return volume;
  const g = Math.min(1, (f + 1) / ramp, (n - f) / ramp);
  return Math.round(volume * Math.max(0, g) * 1e4) / 1e4;
}

/**
 * The video element of a file part. Its gain comes from this element's OWN frame (frame 0 = the part's first frame,
 * inside a loop: of this iteration) — not from the frame Remotion passes to a `volume` callback: that one counts from
 * the first frame of the innermost Sequence chain's window, which restarts at 0 when a transition wraps the segment in
 * `<Sequence from={shift}><Sequence from={-shift}>` (an exiting crossfade / fade-black), so the start ramp would replay
 * mid-sound (a dip and a click) and the end ramp would never come.
 */
function FilePart(props: { media: VideoMedia; silent: boolean; volume: number; start: number; n: number; style: CSSProperties }): ReactNode {
  const f = useCurrentFrame();
  const { media, silent, start, n } = props;
  return (
    <OffthreadVideo
      src={media.url}
      transparent={media.alpha}
      muted={silent}
      {...(silent ? {} : { volume: filePartGain(f, n, props.volume) })}
      trimBefore={start}
      trimAfter={start + n}
      style={props.style}
    />
  );
}

/**
 * A video file filling its parent box: plays its part once and holds the last frame (muted) — or loops it. Alpha videos
 * (ProRes 4444, VP8 / VP9 with alpha) are drawn transparent. Its own sound plays at `volume` with 4-frame ramps at the
 * part's edges (no clicks; `filePartGain`); a file without sound is muted.
 */
export function VideoFile(props: { media: VideoMedia; fit?: MediaFitMode; volume?: number; from?: number; to?: number; loop?: boolean; style?: CSSProperties }): ReactNode {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { media } = props;
  const fit = props.fit ?? 'cover';
  const from = Math.max(0, props.from ?? 0);
  const start = Math.round(from * fps);
  const n = videoPartFrames(media, fps, from, props.to);
  const volume = Math.max(0, Math.min(1, props.volume ?? 1));
  const muted = !media.audio || volume <= 0;
  const style: CSSProperties = { width: '100%', height: '100%', display: 'block', objectFit: fit, ...props.style };
  const video = (silent: boolean) => <FilePart media={media} silent={silent} volume={volume} start={start} n={n} style={style} />;
  if (props.loop) {
    return (
      <Loop durationInFrames={n} layout="none" name="file loop">
        {video(muted)}
      </Loop>
    );
  }
  if (frame < n) {
    return (
      <Sequence durationInFrames={n} layout="none" name="file">
        {video(muted)}
      </Sequence>
    );
  }
  // After its end: the last frame, held (a Sequence shifted so the video shows its frame n − 1), without sound.
  return (
    <Sequence from={frame - (n - 1)} layout="none" name="file (held)">
      {video(true)}
    </Sequence>
  );
}

/** An image file filling its parent box. */
export function ImageFile(props: { media: PictureMedia; fit?: MediaFitMode; style?: CSSProperties }): ReactNode {
  return <Img src={props.media.url} style={{ width: '100%', height: '100%', display: 'block', objectFit: props.fit ?? 'cover', ...props.style }} />;
}

// ── Lottie ────────────────────────────────────────────────────────────────────

const lottieCache = new Map<string, Promise<LottieAnimationData>>();

/** The JSON of a Lottie file served at `url`, loaded once per URL (the render waits for it). */
export function useLottieData(url: string | undefined): LottieAnimationData | null {
  const [data, setData] = useState<LottieAnimationData | null>(null);
  const [handle] = useState(() => (url ? delayRender(`Loading the Lottie animation ${url}`) : null));
  useEffect(() => {
    if (!url || handle === null) return;
    let alive = true;
    let p = lottieCache.get(url);
    if (!p) {
      p = fetch(url).then(async (r) => {
        if (!r.ok) throw new Error(`Lottie file ${url}: HTTP ${r.status}`);
        return (await r.json()) as LottieAnimationData;
      });
      lottieCache.set(url, p);
    }
    p.then(
      (d) => {
        if (alive) setData(d);
        continueRender(handle);
      },
      (e: unknown) => cancelRender(e),
    );
    return () => {
      alive = false;
    };
  }, [url, handle]);
  return data;
}

/** #rgb / #rrggbb / rgb(a)(…) → [r, g, b] in 0..1 (undefined when not a colour this understands). */
export function parseColor01(css: string): [number, number, number] | undefined {
  const s = css.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16) / 255) as [number, number, number];
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16) / 255) as [number, number, number];
  m = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/.exec(s);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  return undefined;
}

type Rgb = [number, number, number];

function close(a: readonly number[], b: Rgb, tol: number): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

/**
 * A copy of a Lottie animation with some colours replaced (theme colours on a generic animation): `map` = source colour
 * (CSS, e.g. "#ff5a1f") → new colour (CSS). Replaces static and animated fill / stroke colours (`fl`, `st`), gradient
 * stops (`gf`, `gs`), solid layers (`sc`) and text fill / stroke colours; `tolerance` per channel (0..1, default 0.02).
 */
export function recolorLottie<T>(data: T, map: Record<string, string>, tolerance = 0.02): T {
  const pairs: Array<{ from: Rgb; to: Rgb; hex: string }> = [];
  for (const [a, b] of Object.entries(map)) {
    const from = parseColor01(a);
    const to = parseColor01(b);
    if (from && to) pairs.push({ from, to, hex: `#${to.map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}` });
  }
  if (pairs.length === 0) return data;
  const swap = (rgb: number[]): number[] | undefined => {
    const p = pairs.find((x) => close(rgb, x.from, tolerance));
    return p ? [...p.to, ...rgb.slice(3)] : undefined;
  };
  /** A colour property {a, k}: static [r,g,b,a?] or keyframes with s / e arrays. */
  const colorProp = (prop: unknown): void => {
    if (!prop || typeof prop !== 'object') return;
    const k = (prop as { k?: unknown }).k;
    if (Array.isArray(k) && typeof k[0] === 'number') {
      const n = swap(k as number[]);
      if (n) (prop as { k: unknown }).k = n;
    } else if (Array.isArray(k)) {
      for (const kf of k as Array<Record<string, unknown>>) {
        for (const key of ['s', 'e'] as const) {
          if (Array.isArray(kf?.[key]) && typeof (kf[key] as number[])[0] === 'number') {
            const n = swap(kf[key] as number[]);
            if (n) kf[key] = n;
          }
        }
      }
    }
  };
  /** Gradient stops: flat [offset, r, g, b, offset, r, g, b, … (alpha stops)] of `p` colour stops. */
  const gradient = (g: unknown): void => {
    if (!g || typeof g !== 'object') return;
    const count = (g as { p?: number }).p ?? 0;
    const fix = (arr: number[]) => {
      for (let i = 0; i < count && i * 4 + 3 < arr.length; i++) {
        const n = swap(arr.slice(i * 4 + 1, i * 4 + 4));
        if (n) arr.splice(i * 4 + 1, 3, n[0], n[1], n[2]);
      }
    };
    const k = (g as { k?: { k?: unknown } }).k?.k;
    if (Array.isArray(k) && typeof k[0] === 'number') fix(k as number[]);
    else if (Array.isArray(k)) for (const kf of k as Array<Record<string, unknown>>) for (const key of ['s', 'e'] as const) if (Array.isArray(kf?.[key])) fix(kf[key] as number[]);
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if ((o.ty === 'fl' || o.ty === 'st') && o.c) colorProp(o.c);
    if ((o.ty === 'gf' || o.ty === 'gs') && o.g) gradient(o.g);
    if (typeof o.sc === 'string') {
      const rgb = parseColor01(o.sc);
      const p = rgb ? pairs.find((x) => close(rgb, x.from, tolerance)) : undefined;
      if (p) o.sc = p.hex;
    }
    // Text documents: fill colour `fc`, stroke colour `sc` as [r, g, b] arrays.
    for (const key of ['fc', 'sc'] as const) {
      if (Array.isArray(o[key]) && typeof (o[key] as number[])[0] === 'number') {
        const n = swap(o[key] as number[]);
        if (n) o[key] = n;
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  const copy = structuredClone(data);
  walk(copy);
  return copy;
}

/**
 * The colour map of a `colors` param (source colour → theme colour key or CSS colour) with every theme key resolved to
 * its CSS colour (`dark` = the night tone when the theme has none).
 */
export function themeColorMap(theme: Pick<ThemeTokens, 'colors'>, colors: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)) return out;
  for (const [from, to] of Object.entries(colors as Record<string, unknown>)) {
    if (typeof to !== 'string') continue;
    out[from] = to === 'dark' || to === 'night' ? nightTone(theme) : Object.hasOwn(theme.colors, to) ? theme.colors[to] : to;
  }
  return out;
}

/**
 * A Lottie file filling its parent box, its own frame rate mapped to the composition's, played once (holding its last
 * frame) or looped; `colors` replaces colours of the animation (already resolved to CSS, see `themeColorMap`).
 */
export function LottieFile(props: { media: LottieMedia; fit?: MediaFitMode; loop?: boolean; colors?: Record<string, string>; style?: CSSProperties }): ReactNode {
  const { fps } = useVideoConfig();
  const raw = useLottieData(props.media.url);
  const colorsKey = JSON.stringify(props.colors ?? {});
  const data = useMemo(() => (raw ? recolorLottie(raw, props.colors ?? {}) : null), [raw, colorsKey]);
  if (!data) return null;
  const rate = props.media.fps / fps;
  const style: CSSProperties = { width: '100%', height: '100%', ...props.style };
  const player = (
    <Lottie
      animationData={data}
      playbackRate={rate}
      preserveAspectRatio={props.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet'}
      style={style}
    />
  );
  if (props.loop) {
    return (
      <Loop durationInFrames={lottieFrames(props.media, fps)} layout="none" name="lottie loop">
        {player}
      </Loop>
    );
  }
  return player;
}
