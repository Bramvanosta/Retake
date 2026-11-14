/**
 * The encode tools of a render (L7.3): this machine's ffmpeg encoding the frames, the rendering library's own doing
 * everything else.
 *
 * The library takes one folder of programs for a render (its compositor, ffmpeg, ffprobe and their libraries) and
 * cannot be given another ffmpeg for the frames alone. So a render that encodes with ours gets a folder of its own:
 * links to the library's programs and, as `ffmpeg`, a small `/bin/sh` dispatcher — a call that reads frames from the
 * image pipe goes to our ffmpeg, any other call (audio, mux, fast start, probes) to the library's, started as the
 * library starts it. Our ffmpeg has no `zscale`: the frame encode's one filter is rewritten to the `colorspace` filter
 * (`rewritePreStitcher`), and nothing else of the command changes.
 *
 * This file names no library package: the library's folder is handed in (library.ts `compositorDir`).
 *
 * Trust: the folder lives in the Retake home (never in the workspace: an agent can write there), it and its parent are
 * the person's own and private (0700, checked with their owner on every use), it is named by what it holds and checked
 * entry by entry on every use; the two paths the script starts are written single-quoted, and a path that holds a
 * quote, a control character or a newline is refused. What this file says of a refusal (`reason`, an error's message)
 * is one of its own sentences; what a program or the system said is kept apart (`detail`) for the warnings.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { runMediaTool } from '@retake/core/io';

/** The oldest ffmpeg that may encode a render's frames (the one `retake doctor` asks for the other tools). */
export const MIN_ENCODE_FFMPEG = [5, 1] as const;

/** The folder of the encode tools in the Retake home. */
export const ENCODE_TOOLS_DIR = 'encode-tools';

/** The library's frame-encode filter this code knows how to replace: limited-range BT.709 from the full-range JPEG frames. */
export const LIBRARY_FRAME_FILTER = 'zscale=matrix=709:range=limited:primariesin=709:primaries=709:transferin=709:transfer=709';

/**
 * The same conversion with ffmpeg's own `colorspace` filter: the JPEG frames are full-range BT.601 (JFIF), the video is
 * limited-range BT.709, primaries and transfer stay BT.709 (no gamma round trip: `fast`). It tags the frames as the
 * library's filter does. Measured against the library's on real frames (L7.3): luma equal on 98–99 % of the pixels,
 * never off by more than 2; chroma differs at hard colour edges (the library resamples chroma up and down again).
 */
export const OWN_FRAME_FILTER = 'colorspace=space=bt709:ispace=bt470bg:range=tv:irange=pc:primaries=bt709:trc=bt709:iprimaries=bt709:itrc=bt709:fast=1:format=yuv420p';

/** The filters and encoders our ffmpeg must have. */
export const OWN_FRAME_FILTER_NAME = 'colorspace';

/**
 * A failure of the encode tools themselves (never of the render): the render falls back to the library's ffmpeg. The
 * message is a sentence of this file; `detail` is what the system said, for the warnings only.
 */
export class EncodeToolsError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'EncodeToolsError';
  }
}

/** An error code as Node names it (ENOENT), or `error`: never the message. */
function codeOf(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(code) ? code : 'error';
}

/** The first line of what was thrown, for a `detail`. */
function saidBy(e: unknown): string {
  return String((e as Error)?.message ?? e)
    .split('\n')[0]
    .slice(0, 200);
}

/**
 * The arguments of the library's frame encode, for our ffmpeg: the one `-vf` value replaced. Given to the library as
 * its ffmpeg override; a muxing call (`stitcher`) is left as it is. Any shape this code does not know — no image pipe,
 * no filter, another filter, two of them — throws: a library update that changes the command must fail loudly (and
 * the render then uses the library's ffmpeg), never encode something else. Pure.
 */
export function rewritePreStitcher(info: { type: 'pre-stitcher' | 'stitcher'; args: string[] }): string[] {
  if (info.type !== 'pre-stitcher') return info.args;
  const args = info.args;
  if (!readsImagePipe(args)) throw new EncodeToolsError('the frame encode does not read the image pipe (-f image2pipe): not a command this version knows');
  const at = args.reduce<number[]>((all, a, i) => (a === '-vf' || a === '-filter:v' || a === '-filter_complex' || a === '-lavfi' ? [...all, i] : all), []);
  if (at.length !== 1 || args[at[0]] !== '-vf')
    throw new EncodeToolsError(`the frame encode has ${at.length === 0 ? 'no filter' : 'filters this version does not know'}: not a command this version knows`);
  const value = args[at[0] + 1];
  if (value !== LIBRARY_FRAME_FILTER) throw new EncodeToolsError(`the frame encode's filter is "${String(value).slice(0, 120)}": not the one this version knows`);
  const out = [...args];
  out[at[0] + 1] = OWN_FRAME_FILTER;
  return out;
}

/** Does this ffmpeg call read frames from the image pipe (`-f image2pipe`, as a pair)? What the dispatcher routes on. Pure. */
export function readsImagePipe(args: readonly string[]): boolean {
  return args.some((a, i) => a === 'image2pipe' && args[i - 1] === '-f');
}

// ── Our ffmpeg ────────────────────────────────────────────────────────────────

/** What our ffmpeg can do, read from the binary itself. */
export interface OwnFfmpegFacts {
  /** Its version word ("9.0.2", "N-…"). */
  version: string;
  libx264: boolean;
  videotoolbox: boolean;
  /** It has the `colorspace` filter. */
  filter: boolean;
}

/** Our ffmpeg, or why it cannot be used: `reason` is a sentence of this file, `detail` what a program or the system said. */
export type OwnFfmpeg = { ok: true; path: string; facts: OwnFfmpegFacts } | { ok: false; reason: string; detail?: string };

/** What was read of a binary, by the file it was read from (`fileId`): a binary replaced in place is read again. */
const facts = new Map<string, Promise<OwnFfmpegFacts | string>>();
/** The binaries that failed at a render's frame encode in this process (`fileId`). */
const failedAtEncode = new Set<string>();

/** Which file this is now: its path, size and time of change. A binary replaced in place is another one. */
export function fileId(path: string): string {
  try {
    const st = statSync(path);
    return `${path}|${st.size}|${st.mtimeMs}`;
  } catch {
    return `${path}|gone`;
  }
}

function run(bin: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runMediaTool(bin, args, { timeoutMs: 10_000, maxBuffer: 4 * 1024 * 1024 });
}

/** Read only when it started and answered: a binary that did not (a timeout on a busy machine) is asked again next time. */
const NOT_STARTING = 'it does not start';

async function readFacts(path: string): Promise<OwnFfmpegFacts | string> {
  const v = await run(path, ['-hide_banner', '-version']);
  if (v.code !== 0) return NOT_STARTING;
  // The version is a word of the binary's own: letters, digits and a few signs only, or it is not taken.
  const version = /^ffmpeg version\s+([\w.+~:-]{1,40})(?=\s|$)/m.exec(v.stdout)?.[1];
  if (!version) return 'it does not say its version';
  // Snapshot builds ("N-…", a date) are not judged, as `retake doctor` does.
  const m = /^n?(\d+)\.(\d+)/.exec(version);
  if (m && (Number(m[1]) < MIN_ENCODE_FFMPEG[0] || (Number(m[1]) === MIN_ENCODE_FFMPEG[0] && Number(m[2]) < MIN_ENCODE_FFMPEG[1]))) {
    return `it is ffmpeg ${version} (needs ${MIN_ENCODE_FFMPEG.join('.')}+)`;
  }
  const [enc, fil] = await Promise.all([run(path, ['-hide_banner', '-encoders']), run(path, ['-hide_banner', '-filters'])]);
  if (enc.code !== 0 || fil.code !== 0) return NOT_STARTING;
  const has = (text: string, name: string) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(text);
  return { version: version.replace(/^n/, ''), libx264: has(enc.stdout, 'libx264'), videotoolbox: has(enc.stdout, 'h264_videotoolbox'), filter: has(fil.stdout, OWN_FRAME_FILTER_NAME) };
}

/** A path the dispatcher script can hold between single quotes. */
function scriptable(path: string): boolean {
  return isAbsolute(path) && !/['\u0000-\u001f\u007f]/.test(path);
}

/**
 * Our ffmpeg as the encoder of a render's frames: its real path and what it can do, or why it cannot be used.
 * `resolve` gives the ffmpeg this work runs (an absolute path, links followed; a bare name when there is none; it
 * throws when the agent policy refuses it). Refused: older than MIN_ENCODE_FFMPEG, no `colorspace` filter, no H.264
 * encoder at all, the library's own ffmpeg, a path the script cannot hold. Facts are read once per process and file
 * (`fileId`); a binary that did not start is asked again.
 */
export async function ownFfmpeg(o: { resolve: () => string; compositorDir: string; platform?: NodeJS.Platform }): Promise<OwnFfmpeg> {
  // The dispatcher is a /bin/sh script and the routing was measured on macOS only.
  if ((o.platform ?? process.platform) !== 'darwin') return { ok: false, reason: "this machine's ffmpeg encodes renders on macOS only" };
  let path: string;
  try {
    path = o.resolve();
  } catch (e) {
    return { ok: false, reason: "this machine's ffmpeg may not be started for this work", detail: saidBy(e) };
  }
  if (!isAbsolute(path)) return { ok: false, reason: 'no ffmpeg found on this machine' };
  try {
    path = realpathSync(path);
  } catch {
    return { ok: false, reason: "this machine's ffmpeg is not a file that can be read" };
  }
  if (!scriptable(path)) return { ok: false, reason: "the path of this machine's ffmpeg holds a quote or a control character" };
  if (same(path, join(o.compositorDir, 'ffmpeg'))) return { ok: false, reason: "this machine's ffmpeg is the rendering library's own" };
  const id = fileId(path);
  let p = facts.get(id);
  if (!p) {
    p = readFacts(path).catch(() => NOT_STARTING);
    facts.set(id, p);
    void p.then((f) => {
      if (f === NOT_STARTING && facts.get(id) === p) facts.delete(id);
    });
  }
  const f = await p;
  if (typeof f === 'string') return { ok: false, reason: `this machine's ffmpeg cannot encode renders: ${f}` };
  if (!f.filter) return { ok: false, reason: `this machine's ffmpeg (${f.version}) has no ${OWN_FRAME_FILTER_NAME} filter` };
  if (!f.libx264 && !f.videotoolbox) return { ok: false, reason: `this machine's ffmpeg (${f.version}) has no H.264 encoder (libx264, h264_videotoolbox)` };
  return { ok: true, path, facts: f };
}

/** Our ffmpeg at `path` failed at a render's frame encode: it is not taken again by this process, until the file changes. */
export function noteOwnEncodeFailed(path: string): void {
  failedAtEncode.add(fileId(path));
}

/** Did the ffmpeg at `path` fail at an encode earlier in this process (`noteOwnEncodeFailed`)? */
export function ownEncodeFailedEarlier(path: string): boolean {
  return failedAtEncode.has(fileId(path));
}

/** Forget what was read of our ffmpeg, and which failed (tests). */
export function resetOwnFfmpeg(): void {
  facts.clear();
  failedAtEncode.clear();
}

function same(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

/** The first line ffmpeg said of an error. */
function firstError(stderr: string, code: number | null): string {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^Try\b/.test(l));
  return (line ?? `exit ${code ?? '?'}`).slice(0, 200);
}

/**
 * The arguments of the frame-encode probe (pure): the library's frame encode as `rewritePreStitcher` hands it to our
 * ffmpeg — frames from the image pipe, the colour filter, the tags, `codec` (the encoder and its rate) — written
 * nowhere (`-f null`).
 */
export function frameEncodeProbeArgs(s: { width: number; height: number; fps: number }, codec: readonly string[]): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-r',
    String(s.fps),
    '-f',
    'image2pipe',
    '-s',
    `${s.width}x${s.height}`,
    '-vcodec',
    'mjpeg',
    '-i',
    '-',
    ...codec,
    '-pix_fmt',
    'yuv420p',
    '-video_track_timescale',
    '90000',
    '-colorspace:v',
    'bt709',
    '-color_primaries:v',
    'bt709',
    '-color_trc:v',
    'bt709',
    '-color_range',
    'tv',
    '-vf',
    OWN_FRAME_FILTER,
    '-f',
    'null',
    '-',
  ];
}

/** The arguments that make the probe's three JPEG frames (pure): a flat full-range picture at the render's size, on the pipe. */
export function probeFramesArgs(s: { width: number; height: number; fps: number }): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-f',
    'lavfi',
    '-i',
    `color=c=gray:s=${s.width}x${s.height}:r=${s.fps}`,
    '-frames:v',
    '3',
    '-c:v',
    'mjpeg',
    '-q:v',
    '2',
    '-pix_fmt',
    'yuvj420p',
    '-f',
    'image2pipe',
    '-',
  ];
}

/**
 * Can the ffmpeg at `path` run a render's frame encode? The command itself, on three frames it makes first: a version
 * that has the filter and the encoder by name and cannot run the command is refused before a render, not after one.
 * `error` is ffmpeg's own first line (untrusted words: for the warnings).
 */
export async function probeFrameEncode(path: string, s: { width: number; height: number; fps: number }, codec: readonly string[]): Promise<{ ok: boolean; error?: string }> {
  const frames = await runMediaTool(path, probeFramesArgs(s), { encoding: 'buffer', timeoutMs: 15_000, maxBuffer: 64 * 1024 * 1024 });
  if (frames.code !== 0 || frames.stdout.length === 0) return { ok: false, error: firstError(frames.stderr, frames.code) };
  const r = await runMediaTool(path, frameEncodeProbeArgs(s, codec), { input: frames.stdout, timeoutMs: 15_000, maxBuffer: 4 * 1024 * 1024 });
  return r.code === 0 ? { ok: true } : { ok: false, error: firstError(r.stderr, r.code) };
}

// ── The folder ────────────────────────────────────────────────────────────────

/** The dispatcher script (pure): frames from the image pipe → our ffmpeg; anything else → the library's, as the library starts it. */
export function dispatcherScript(compositorDir: string, ffmpegPath: string): string {
  if (!scriptable(compositorDir) || !scriptable(ffmpegPath)) throw new EncodeToolsError('a path of the encode tools holds a quote or a control character');
  return [
    '#!/bin/sh',
    "# Retake encode tools (generated; made again when it differs). The frames of a render go to this machine's ffmpeg,",
    "# every other call to the rendering library's own, started as the library starts it.",
    'p=',
    'for a in "$@"; do',
    `  if [ "$p" = "-f" ] && [ "$a" = "image2pipe" ]; then unset DYLD_LIBRARY_PATH; exec '${ffmpegPath}' "$@"; fi`,
    '  p=$a',
    'done',
    `DYLD_LIBRARY_PATH='${compositorDir}'`,
    'export DYLD_LIBRARY_PATH',
    `exec '${join(compositorDir, 'ffmpeg')}' "$@"`,
    '',
  ].join('\n');
}

/** What the folder links from the library's: everything it starts or loads but `ffmpeg` (pure, given the folder's listing). */
export function linkedEntries(compositorEntries: readonly string[]): string[] {
  return compositorEntries.filter((n) => n === 'remotion' || n === 'ffprobe' || /\.dylib$/.test(n)).sort();
}

/** The folder's name (pure): what it holds — the script, with both paths in it, and the names it links. */
export function encodeFolderName(script: string, links: readonly string[]): string {
  return createHash('sha256')
    .update([script, ...links].join('\0'))
    .digest('hex')
    .slice(0, 16);
}

/** This person's own (where the system says who owns a file). */
function mine(st: { uid: number }): boolean {
  return typeof process.getuid !== 'function' || st.uid === process.getuid();
}

function folderIsRight(dir: string, links: readonly string[], compositorDir: string, script: string): boolean {
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || (st.mode & 0o077) !== 0 || !mine(st)) return false;
    const names = readdirSync(dir).sort();
    const want = [...links, 'ffmpeg'].sort();
    if (names.length !== want.length || names.some((n, i) => n !== want[i])) return false;
    for (const n of links) {
      if (!lstatSync(join(dir, n)).isSymbolicLink() || readlinkSync(join(dir, n)) !== join(compositorDir, n) || !existsSync(join(compositorDir, n))) return false;
    }
    const f = lstatSync(join(dir, 'ffmpeg'));
    return f.isFile() && mine(f) && (f.mode & 0o777) === 0o700 && readFileSync(join(dir, 'ffmpeg'), 'utf8') === script;
  } catch {
    return false;
  }
}

/** Remove what was built aside; never the reason a render fails (a home that is not a folder throws here too). */
function drop(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Nothing was made there.
  }
}

/** `<home>/encode-tools`: made private when missing; refused unless it is a folder of this person's that no one else can write in. */
function ownParent(parent: string): void {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const st = lstatSync(parent);
  if (!st.isDirectory() || !mine(st) || (st.mode & 0o022) !== 0) throw new EncodeToolsError('the encode tools folder of the Retake home is not a private folder of this account');
}

/** Folders of other programs, older than this, are removed when a folder is made (an ffmpeg upgraded since, a build that stopped half-way). */
const STALE_MS = 24 * 3600 * 1000;

/**
 * Remove what no render can be using any more beside `keep`: folders built aside or moved aside and left there, and
 * folders whose script starts a program that is gone — each older than a day. Never `keep`, never a folder whose
 * programs still exist, never anything that is not a folder of this person's. Never throws.
 */
function sweep(parent: string, keep: string): void {
  try {
    for (const name of readdirSync(parent)) {
      const at = join(parent, name);
      if (at === keep) continue;
      try {
        const st = lstatSync(at);
        if (!st.isDirectory() || !mine(st) || Date.now() - st.mtimeMs < STALE_MS) continue;
        if (/^[0-9a-f]{16}\.(?:tmp|old)-[0-9a-f]+$/.test(name)) drop(at);
        else if (/^[0-9a-f]{16}$/.test(name)) {
          const targets = [...readFileSync(join(at, 'ffmpeg'), 'utf8').matchAll(/exec '([^']+)' "\$@"/g)].map((m) => m[1]);
          if (targets.length === 0 || targets.some((t) => !existsSync(t))) drop(at);
        }
      } catch {
        // Not a folder of ours to judge: left.
      }
    }
  } catch {
    // Nothing to sweep.
  }
}

/**
 * The folder a render hands the library so that our ffmpeg encodes its frames: `<home>/encode-tools/<name>/`, named by
 * what it holds (`encodeFolderName`: the script and the links), with links to the library's `remotion`, `ffprobe` and
 * libraries, and the dispatcher as `ffmpeg`. Used as it is when right. Else built beside it and renamed into place —
 * a rename that cannot take the place of a folder another render made in the meantime: that one is checked and used.
 * A folder that is right is never removed or moved; one found damaged under this name (no version of the code makes
 * another content for it) is moved aside first, and put back if it turns out right after all. Returns the folder's
 * real path; EncodeToolsError when it cannot be made.
 */
export function encodeFolder(o: { home: string; compositorDir: string; ffmpegPath: string }): string {
  const script = dispatcherScript(o.compositorDir, o.ffmpegPath);
  let links: string[];
  try {
    links = linkedEntries(readdirSync(o.compositorDir));
  } catch (e) {
    throw new EncodeToolsError(`the rendering library's programs cannot be listed (${codeOf(e)})`, saidBy(e));
  }
  if (!links.includes('remotion') || !links.includes('ffprobe') || !existsSync(join(o.compositorDir, 'ffmpeg')))
    throw new EncodeToolsError("the rendering library's folder does not hold its programs");
  const parent = join(o.home, ENCODE_TOOLS_DIR);
  const dir = join(parent, encodeFolderName(script, links));
  const right = (at: string = dir) => folderIsRight(at, links, o.compositorDir, script);
  let tmp = '';
  try {
    ownParent(parent);
    if (right()) return realpathSync(dir);
    tmp = `${dir}.tmp-${randomBytes(6).toString('hex')}`;
    mkdirSync(tmp, { mode: 0o700 });
    chmodSync(tmp, 0o700);
    for (const n of links) symlinkSync(join(o.compositorDir, n), join(tmp, n));
    writeFileSync(join(tmp, 'ffmpeg'), script, { mode: 0o700, flag: 'wx' });
    chmodSync(join(tmp, 'ffmpeg'), 0o700);
    place(tmp, dir, right);
  } catch (e) {
    if (tmp) drop(tmp);
    if (e instanceof EncodeToolsError) throw e;
    throw new EncodeToolsError(`the encode tools folder cannot be made (${codeOf(e)})`, saidBy(e));
  }
  drop(tmp);
  if (!right()) throw new EncodeToolsError('the encode tools folder is not as it was written');
  sweep(parent, dir);
  return realpathSync(dir);
}

/**
 * Put the folder built at `tmp` at `dir`, or leave `dir` when it is right (another render's). The rename succeeds only
 * where nothing is (or an empty folder): it never replaces a folder that holds entries. What stands there and is not
 * right is moved aside, judged again where it was moved — a right folder that came in between is put back, not
 * removed — and the rename is tried again.
 */
function place(tmp: string, dir: string, right: (at?: string) => boolean): void {
  for (let i = 0; i < 4; i++) {
    if (right()) return;
    try {
      renameSync(tmp, dir);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOTDIR' && code !== 'EISDIR' && code !== 'EPERM') throw e;
    }
    if (right()) return;
    const old = `${dir}.old-${randomBytes(6).toString('hex')}`;
    try {
      renameSync(dir, old);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    if (right(old)) {
      // Another render's right folder came in between the check and the move: back where it was (or ours takes the place).
      try {
        renameSync(old, dir);
        continue;
      } catch {
        // Something stands there again: the next turn judges it; this copy is one too many.
      }
    }
    drop(old);
  }
  if (!right()) throw new EncodeToolsError('the encode tools folder cannot be made (it keeps changing)');
}
