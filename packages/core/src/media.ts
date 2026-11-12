/**
 * User media (L2.12, R-OWN-*): the video, image and Lottie files a scenario or a theme shows instead of a provided
 * component — a segment (intro, outro, card, interstitial) or an overlay over the capture. The scenario writes them as
 * sugar (`intro: {video: assets/intro.mp4}`, `overlay: {video: assets/burst.webm, anchor: target}`); everything below
 * turns that sugar into an ordinary component use (studio/media, studio/lottie) so the rest of the pipeline — planner,
 * composition, review, component switching — treats a user file like any other component.
 *
 * Also here: the file checks shared by validation and planning — container by extension, what ffprobe's answer says of
 * a video (codec, size, length, sound, alpha; read by ffprobe.ts videoProbeFromJson, the probe itself: `@retake/core/io` probeVideoFile) and the metadata of
 * a Lottie file.
 */
import { MEDIA_COMPONENTS, MEDIA_FILE_KINDS } from './types.js';
import type { BBox, MediaFileFields, MediaFileKind, OverlayAnchor, OverlaySpec } from './types.js';

/** Video containers the renderer reads. */
export const VIDEO_FILE_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm'];
/** Image files a segment or an overlay may show. */
export const MEDIA_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.svg'];
/** Lottie animations: the bodymovin JSON (not the zipped .lottie). */
export const LOTTIE_FILE_EXTENSIONS = ['.json'];

/** Video codecs the renderer decodes (Remotion's ffmpeg), as ffprobe names them. */
export const VIDEO_CODECS: Readonly<Record<string, string>> = {
  h264: 'H.264',
  hevc: 'HEVC (H.265)',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  prores: 'ProRes',
};

/** The extensions each kind of file accepts. */
export const MEDIA_EXTENSIONS: Readonly<Record<MediaFileKind, readonly string[]>> = {
  video: VIDEO_FILE_EXTENSIONS,
  image: MEDIA_IMAGE_EXTENSIONS,
  lottie: LOTTIE_FILE_EXTENSIONS,
};

/** The lower-case extension of a path ("" when it has none). */
export function fileExtension(path: string): string {
  return (/\.[A-Za-z0-9]+$/.exec(path.trim())?.[0] ?? '').toLowerCase();
}

/** The file kinds a media spec names (several = a mistake the validation reports). */
export function mediaFileKinds(spec: Partial<MediaFileFields> | undefined | null): MediaFileKind[] {
  if (!spec || typeof spec !== 'object') return [];
  return MEDIA_FILE_KINDS.filter((k) => typeof spec[k] === 'string' && (spec[k] as string).trim() !== '');
}

/** The user file a media spec names (the first of video, image, lottie), or undefined. */
export function mediaFileOf(spec: Partial<MediaFileFields> | undefined | null): { kind: MediaFileKind; path: string } | undefined {
  const kind = mediaFileKinds(spec)[0];
  return kind ? { kind, path: (spec![kind] as string).trim() } : undefined;
}

/** A component use as the planner resolves it: id, params, slots. */
export interface MediaComponentUse {
  id: string;
  params: Record<string, unknown>;
  slots: Record<string, string>;
}

/**
 * The component use behind a segment's file (`intro: {video: …}`): studio/media for a video or an image, studio/lottie
 * for a Lottie file, the file in its `file` slot; `from`, `to`, `volume`, `fit`, `background` become params (over the
 * spec's own `params`). Undefined when the spec names no file.
 */
export function mediaSegmentUse(spec: Partial<MediaFileFields> & { params?: Record<string, unknown> }, opts: { overlay?: boolean; loop?: boolean } = {}): MediaComponentUse | undefined {
  const f = mediaFileOf(spec);
  if (!f) return undefined;
  const params: Record<string, unknown> = structuredClone(spec.params ?? {});
  const fit = spec.fit ?? (opts.overlay ? 'contain' : undefined);
  if (fit !== undefined) params.fit = fit;
  if (spec.background !== undefined && !opts.overlay) params.background = spec.background;
  if (opts.overlay) params.background = 'none';
  if (opts.loop !== undefined) params.loop = opts.loop;
  if (f.kind === 'lottie') return { id: MEDIA_COMPONENTS.lottie, params, slots: { file: f.path } };
  if (f.kind === 'video') {
    if (spec.from !== undefined) params.from = spec.from;
    if (spec.to !== undefined) params.to = spec.to;
    if (spec.volume !== undefined) params.volume = spec.volume;
  }
  return { id: MEDIA_COMPONENTS.media, params, slots: { file: f.path } };
}

/** A step overlay as the runner records it: the component use, and the box of a box-filling overlay. */
export interface OverlayUseSpec {
  component: string;
  slots: Record<string, string>;
  params: Record<string, unknown>;
  box?: { anchor?: OverlayAnchor; rect?: BBox; scale?: number };
}

/**
 * The component use of a step `overlay`: its component as written, or — for a user file (`video`, `image`, `lottie`) —
 * studio/media or studio/lottie with the file in its `file` slot. A file, or any overlay with `anchor` / `rect` /
 * `scale`, gets a box (default anchor decided by the planner: the target when the step has one, else the centre).
 */
export function overlayUseOf(spec: OverlaySpec): OverlayUseSpec {
  const file = mediaSegmentUse(spec, { overlay: true, ...(spec.loop !== undefined ? { loop: spec.loop } : {}) });
  const out: OverlayUseSpec = file
    ? { component: file.id, slots: { ...(spec.slots ?? {}), ...file.slots }, params: file.params }
    : { component: spec.component ?? '', slots: { ...(spec.slots ?? {}) }, params: structuredClone(spec.params ?? {}) };
  if (file || spec.anchor !== undefined || spec.rect !== undefined || spec.scale !== undefined) {
    const box: NonNullable<OverlayUseSpec['box']> = {};
    if (spec.anchor !== undefined) box.anchor = spec.anchor;
    if (spec.rect !== undefined) box.rect = { ...spec.rect };
    if (spec.scale !== undefined) box.scale = spec.scale;
    out.box = box;
  }
  return out;
}

// ── Probing ───────────────────────────────────────────────────────────────────

/** What ffprobe says about a video file. */
export interface VideoProbe {
  /** ffprobe's format name (e.g. "mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm"). */
  container: string;
  /** Video codec as ffprobe names it (h264, vp9, prores…). */
  codec: string;
  profile?: string;
  pix_fmt?: string;
  width: number;
  height: number;
  /** Seconds. */
  duration_s: number;
  fps: number;
  /** The file has a sound track. */
  audio: boolean;
  /** The video carries an alpha channel (ProRes 4444 with alpha, VP8 / VP9 with alpha). */
  alpha: boolean;
}

/** A video file that cannot be probed or read. */
export class MediaProbeError extends Error {
  constructor(
    message: string,
    /** `no-ffprobe`: ffprobe is not installed (the file could not be checked); `unreadable`: not a video ffprobe reads. */
    readonly reason: 'no-ffprobe' | 'unreadable' | 'no-video',
  ) {
    super(message);
    this.name = 'MediaProbeError';
  }
}


/** What a Lottie file says about itself. */
export interface LottieMeta {
  /** bodymovin version that exported it. */
  version: string;
  name?: string;
  width: number;
  height: number;
  /** Frames per second of the animation. */
  fps: number;
  /** Frames (op − ip). */
  frames: number;
  duration_s: number;
  /** Image assets that point at external files (not embedded as data URIs): they will not show. */
  external_images: number;
}

/** Parse a Lottie (bodymovin) JSON file's text and read its metadata. Throws an Error saying what is wrong. */
export function readLottieMeta(text: string): LottieMeta {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`not a JSON file (${(e as Error).message})`);
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not a Lottie animation: the JSON is not an object');
  const num = (k: string) => (typeof j[k] === 'number' && Number.isFinite(j[k]) ? (j[k] as number) : undefined);
  const missing = ['fr', 'ip', 'op', 'w', 'h'].filter((k) => num(k) === undefined);
  if (missing.length > 0 || !Array.isArray(j.layers)) {
    const keys = [...missing, ...(Array.isArray(j.layers) ? [] : ['layers'])];
    throw new Error(`not a Lottie (bodymovin) animation: ${keys.join(', ')} missing — export the animation as Lottie JSON (bodymovin)`);
  }
  const fps = num('fr')!;
  const frames = num('op')! - num('ip')!;
  if (!(fps > 0)) throw new Error(`its frame rate fr = ${fps} is not > 0`);
  if (!(frames > 0)) throw new Error(`it has no frames (ip ${num('ip')}, op ${num('op')})`);
  if (!(num('w')! > 0 && num('h')! > 0)) throw new Error(`its size ${num('w')}×${num('h')} is not > 0`);
  const assets = Array.isArray(j.assets) ? (j.assets as Array<Record<string, unknown>>) : [];
  const external = assets.filter((a) => typeof a.p === 'string' && !/^data:/.test(a.p as string) && a.e !== 1).length;
  const out: LottieMeta = {
    version: typeof j.v === 'string' ? j.v : 'unknown',
    width: num('w')!,
    height: num('h')!,
    fps,
    frames,
    duration_s: Math.round((frames / fps) * 1000) / 1000,
    external_images: external,
  };
  if (typeof j.nm === 'string') out.name = j.nm;
  return out;
}
