/**
 * Checks of user files (L2.12): a segment (intro, outro, card, interstitial — in a scenario or a theme) or a step overlay
 * that shows a video, an image or a Lottie file instead of a component. Positioned issues: one file per use, the right
 * container for its kind, the file exists, the renderer can decode it (ffprobe: codec, length), `from` / `to` inside it,
 * an overlay video with an alpha channel, and the fields that only apply to some kinds.
 */
import { resolve } from 'node:path';
import { needFiles, needProber } from '../file-facts.js';
import type { FileFacts } from '../file-facts.js';
import type { IssuePath } from '../issues.js';
import { MEDIA_EXTENSIONS, MediaProbeError, VIDEO_CODECS, fileExtension, mediaFileKinds, readLottieMeta } from '../media.js';
import type { LottieMeta, VideoProbe } from '../media.js';
import type { MediaFileKind } from '../types.js';
import type { CheckContext } from './context.js';
import { isObj } from './context.js';

const DOC = 'docs/BRING-YOUR-OWN-MOTION.md';

/** What the checks learnt about a use's file (for the caller's own checks). */
export interface MediaCheckResult {
  kind?: MediaFileKind;
  path?: string;
  /** The file exists. */
  exists?: boolean;
  video?: VideoProbe;
  lottie?: LottieMeta;
}

export interface MediaCheckOptions {
  /** A step overlay (no `background`; a video should carry alpha). */
  overlay?: boolean;
  /** Directory relative paths resolve against (default: the context's project directory). */
  dir?: string;
}

function article(kind: MediaFileKind): string {
  return kind === 'image' ? 'an image' : kind === 'lottie' ? 'a Lottie file' : 'a video';
}

/** Does an image file's content match its extension? (PNG, JPEG, WebP, SVG signatures.) */
function imageMatches(files: FileFacts, file: string, ext: string): boolean {
  const b = files.readHead(file, 256);
  if (b.length === 0) return false;
  if (ext === '.png') return b.length >= 8 && b.readUInt32BE(0) === 0x89504e47;
  if (ext === '.jpg' || ext === '.jpeg') return b[0] === 0xff && b[1] === 0xd8;
  if (ext === '.webp') return b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  if (ext === '.svg') return /<svg[\s>]|<\?xml/i.test(b.toString('utf8'));
  return true;
}

/** Hint for a file written under the wrong key or in an unsupported container. */
function containerHint(kind: MediaFileKind, ext: string): string {
  for (const other of ['video', 'image', 'lottie'] as const) {
    if (other !== kind && MEDIA_EXTENSIONS[other].includes(ext)) return ` — it looks like ${article(other)}: write \`${other}:\``;
  }
  if (ext === '.gif') return ' — convert an animated GIF to .mp4 or .webm (ffmpeg -i in.gif out.mp4)';
  if (ext === '.lottie') return ' — a .lottie file is a zipped dotLottie: export the Lottie JSON (bodymovin) instead';
  if (kind === 'video') return ` — convert it with ffmpeg (see ${DOC})`;
  return '';
}

/**
 * Check the user-file fields of a use (`video` / `image` / `lottie` and what goes with them) at `p`. Returns what it
 * learnt about the file. `ctx.projectDir` (or `opts.dir`) is where relative paths resolve.
 */
export function checkMediaFields(spec: unknown, p: IssuePath, ctx: CheckContext, opts: MediaCheckOptions = {}): MediaCheckResult {
  if (!isObj(spec) || ctx.broken(p)) return {};
  const kinds = mediaFileKinds(spec);
  if (kinds.length > 1) {
    ctx.error([...p, kinds[1]], `one file per use: ${kinds.map((k) => `\`${k}\``).join(' and ')} are both set`);
  }
  const kind = kinds[0];
  if (kind === undefined) {
    for (const key of ['from', 'to', 'volume'] as const) {
      if (spec[key] !== undefined) ctx.error([...p, key], `\`${key}\` applies to a video file (\`video:\`)`);
    }
    for (const key of ['fit', 'background'] as const) {
      if (spec[key] !== undefined) ctx.error([...p, key], `\`${key}\` applies to a file (\`video:\`, \`image:\` or \`lottie:\`)`);
    }
    if (opts.overlay && spec.loop !== undefined) ctx.warning([...p, 'loop'], '`loop` applies to a video or Lottie file: ignored');
    return {};
  }
  const path = String(spec[kind]).trim();
  const out: MediaCheckResult = { kind, path };
  if (spec.component !== undefined) {
    ctx.error([...p, 'component'], `\`component\` and \`${kind}\` exclude each other: the file replaces the component (its \`params\` go to ${kind === 'lottie' ? 'studio/lottie' : 'studio/media'})`);
  }
  if (opts.overlay && spec.background !== undefined) ctx.error([...p, 'background'], '`background` applies to a full-frame file (intro, outro, card, interstitial), not to an overlay');
  if (kind !== 'video') {
    for (const key of ['from', 'to', 'volume'] as const) {
      if (spec[key] !== undefined) ctx.error([...p, key], `\`${key}\` applies to a video (this is ${article(kind)})`);
    }
    if (kind === 'image' && opts.overlay && spec.loop !== undefined) ctx.warning([...p, 'loop'], '`loop` applies to a video or Lottie file: ignored for an image');
  }
  const from = typeof spec.from === 'number' ? spec.from : undefined;
  const to = typeof spec.to === 'number' ? spec.to : undefined;
  if (from !== undefined && to !== undefined && to <= from) ctx.error([...p, 'to'], `\`to\` (${to} s) must be after \`from\` (${from} s)`);

  const ext = fileExtension(path);
  if (!MEDIA_EXTENSIONS[kind].includes(ext)) {
    ctx.error([...p, kind], `"${path}": ${article(kind)} must be a ${MEDIA_EXTENSIONS[kind].join(', ')} file${ext ? ` (not ${ext})` : ''}${containerHint(kind, ext)}`);
    return out;
  }
  const dir = opts.dir ?? ctx.projectDir;
  if (!dir) {
    ctx.warning([...p, kind], `cannot check that ${kind} file "${path}" exists: no project given`);
    return out;
  }
  const abs = resolve(dir, path);
  const before = ctx.out.length;
  ctx.file(path, [...p, kind], `${kind} file`, 'error', dir);
  out.exists = ctx.out.length === before;
  if (!out.exists) return out;
  const files = needFiles(ctx.files, 'a media file check');

  if (kind === 'image') {
    if (!imageMatches(files, abs, ext)) ctx.error([...p, kind], `"${path}" is not ${ext === '.svg' ? 'an SVG' : `a ${ext.slice(1).toUpperCase()}`} image (its content does not match its extension)`);
    return out;
  }
  if (kind === 'lottie') {
    try {
      out.lottie = readLottieMeta(files.readText(abs));
    } catch (e) {
      ctx.error([...p, kind], `"${path}": ${(e as Error).message}`);
      return out;
    }
    if (out.lottie.external_images > 0) {
      ctx.warning(
        [...p, kind],
        `"${path}" refers to ${out.lottie.external_images} image file${out.lottie.external_images > 1 ? 's' : ''} that ${out.lottie.external_images > 1 ? 'are' : 'is'} not embedded: they will not show — export with images embedded (base64)`,
      );
    }
    return out;
  }

  const prober = needProber(files, 'a video file check');
  let v: VideoProbe;
  try {
    v = prober.probeVideo(abs);
  } catch (e) {
    // What ffprobe cannot say of the file is reported; anything else (a bug, a missing port) is not a file problem.
    if (!(e instanceof MediaProbeError)) throw e;
    if (e.reason === 'no-ffprobe') ctx.warning([...p, kind], `cannot check "${path}": ${e.message} (the render needs it too)`);
    else ctx.error([...p, kind], `"${path}" is not a video the renderer can read: ${e.message}`);
    return out;
  }
  out.video = v;
  if (!Object.hasOwn(VIDEO_CODECS, v.codec)) {
    ctx.error(
      [...p, kind],
      `"${path}": the video codec "${v.codec}" is not supported — use ${Object.values(VIDEO_CODECS).join(', ')} (e.g. ffmpeg -i in -c:v libx264 -pix_fmt yuv420p out.mp4; see ${DOC})`,
    );
  }
  if (ext === '.webm' && !/webm|matroska/.test(v.container)) ctx.error([...p, kind], `"${path}" is not a WebM file (ffprobe: ${v.container})`);
  const dur = v.duration_s;
  if (dur > 0) {
    if (from !== undefined && from >= dur) ctx.error([...p, 'from'], `\`from\` (${from} s) is past the end of "${path}" (${dur} s)`);
    if (to !== undefined && to > dur + 0.05) ctx.error([...p, 'to'], `\`to\` (${to} s) is past the end of "${path}" (${dur} s)`);
    const part = Math.max(0, Math.min(to ?? dur, dur) - (from ?? 0));
    const d = typeof spec.duration === 'number' ? spec.duration : undefined;
    if (d !== undefined && part > 0 && d > part + 0.05 && spec.loop !== true) {
      ctx.warning(
        [...p, 'duration'],
        `the video part lasts ${Math.round(part * 100) / 100} s: its last frame is held for ${Math.round((d - part) * 100) / 100} s${opts.overlay ? ' (`loop: true` replays it instead)' : ''}`,
      );
    }
  }
  if (opts.overlay && !v.alpha) {
    ctx.warning([...p, kind], `"${path}" has no alpha channel: it covers the capture inside its box — export ProRes 4444 (.mov) or VP9 with alpha (.webm) for a transparent overlay (${DOC})`);
  }
  if (typeof spec.volume === 'number' && spec.volume > 0 && !v.audio) ctx.warning([...p, 'volume'], `"${path}" has no sound: \`volume\` changes nothing`);
  return out;
}
