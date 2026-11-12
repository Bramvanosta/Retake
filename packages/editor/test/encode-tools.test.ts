/**
 * L7.3 the encode tools (editor render/encode-tools.ts): this machine's ffmpeg encoding a render's frames, the
 * rendering library's own doing everything else. The filter rewrite (one value, the frame encode only, an unknown
 * command refused), the dispatcher (which call goes where, started with the environment the library gives), the
 * folder (its entries, private, checked on every use, rebuilt aside and moved into place) and which ffmpeg qualifies.
 * The programs here are small scripts that say who they are; the last test runs the real ones (no render).
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ENCODE_TOOLS_DIR,
  EncodeToolsError,
  LIBRARY_FRAME_FILTER,
  OWN_FRAME_FILTER,
  dispatcherScript,
  encodeFolder,
  encodeFolderName,
  frameEncodeProbeArgs,
  linkedEntries,
  noteOwnEncodeFailed,
  ownEncodeFailedEarlier,
  ownFfmpeg,
  probeFrameEncode,
  probeFramesArgs,
  readsImagePipe,
  resetOwnFfmpeg,
  rewritePreStitcher,
} from '../src/render/encode-tools.js';
import { compositorDir } from '../src/render/library.js';
import { hasTool } from './render-helpers.js';

const posix = process.platform !== 'win32';
const scratch = mkdtempSync(join(tmpdir(), 'retake-encode-tools-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The library's frame encode, as its version in this repository writes it (libx264 and VideoToolbox). */
const frameEncode = (codec: string[]) => [
  '-r',
  '30',
  '-f',
  'image2pipe',
  '-s',
  '1920x1080',
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
  LIBRARY_FRAME_FILTER,
  '-y',
  '/tmp/x/pre-encode.mp4',
];
const X264 = ['-c:v', 'libx264', '-crf', '16', '-preset', 'veryfast'];
const VT = ['-c:v', 'h264_videotoolbox', '-b:v', '8M', '-g', '60'];
/** Calls the library makes that are not the frame encode: audio, the mux, a probe of the encoders. */
const OTHER_CALLS = [
  ['-i', '/tmp/x/audio.wav', '-c:a', 'libfdk_aac', '-b:a', '320k', '-y', '/tmp/x/audio.aac'],
  ['-i', '/tmp/x/pre-encode.mp4', '-i', '/tmp/x/audio.aac', '-c:v', 'copy', '-c:a', 'copy', '-movflags', 'faststart', '-y', '/tmp/x/out.mp4'],
  ['-hide_banner', '-encoders'],
  ['-f', 'lavfi', '-i', 'nullsrc=s=1920x1080:r=30', '-frames:v', '3', '-c:v', 'h264_videotoolbox', '-f', 'null', '-'],
  // Reads its input from the pipe, but not frames: the library's.
  ['-f', 's16le', '-i', '-', '-c:a', 'pcm_s16le', '-y', '/tmp/x/a.wav'],
  // The word alone, or the pair split, is not the frame encode.
  ['-i', 'image2pipe', '-f', 'null', '-'],
  ['-f', 'null', 'image2pipe'],
];

describe("the frame encode's arguments for our ffmpeg (rewritePreStitcher)", () => {
  it('the one filter value is replaced, nothing else moves; the mux call is handed back as it is', () => {
    for (const codec of [X264, VT]) {
      const args = frameEncode(codec);
      const out = rewritePreStitcher({ type: 'pre-stitcher', args });
      expect(out).toHaveLength(args.length);
      const changed = out.map((a, i) => (a === args[i] ? null : i)).filter((i): i is number => i !== null);
      expect(changed).toEqual([args.indexOf('-vf') + 1]);
      expect(out[changed[0]]).toBe(OWN_FRAME_FILTER);
      // The caller's list is not written to.
      expect(args[changed[0]]).toBe(LIBRARY_FRAME_FILTER);
    }
    const mux = ['-i', '/tmp/x/pre-encode.mp4', '-vf', LIBRARY_FRAME_FILTER, '-y', '/tmp/x/out.mp4'];
    expect(rewritePreStitcher({ type: 'stitcher', args: mux })).toBe(mux);
  });

  it('the conversion asked of our ffmpeg: full-range BT.601 JPEG frames to limited-range BT.709, tagged BT.709, 4:2:0', () => {
    expect(LIBRARY_FRAME_FILTER).toBe('zscale=matrix=709:range=limited:primariesin=709:primaries=709:transferin=709:transfer=709');
    expect(OWN_FRAME_FILTER).toBe('colorspace=space=bt709:ispace=bt470bg:range=tv:irange=pc:primaries=bt709:trc=bt709:iprimaries=bt709:itrc=bt709:fast=1:format=yuv420p');
  });

  it('a frame encode this version does not know is refused, never rewritten: no image pipe, no filter, another filter, two filters', () => {
    const base = frameEncode(X264);
    const at = base.indexOf('-vf');
    const without = (from: number, n: number) => [...base.slice(0, from), ...base.slice(from + n)];
    const unknown: Array<[string, string[], RegExp]> = [
      ['no image pipe', base.map((a) => (a === 'image2pipe' ? 'rawvideo' : a)), /does not read the image pipe/],
      ['no filter', without(at, 2), /has no filter/],
      ['another filter', base.map((a) => (a === LIBRARY_FRAME_FILTER ? 'scale=1280:-2' : a)), /filter is "scale=1280:-2": not the one this version knows/],
      ['a longer filter', base.map((a) => (a === LIBRARY_FRAME_FILTER ? `${LIBRARY_FRAME_FILTER},hflip` : a)), /not the one this version knows/],
      ['two filters', [...base.slice(0, -2), '-vf', 'hflip', ...base.slice(-2)], /filters this version does not know/],
      ['a filter graph', [...without(at, 2).slice(0, -2), '-filter_complex', LIBRARY_FRAME_FILTER, ...base.slice(-2)], /filters this version does not know/],
    ];
    for (const [name, args, message] of unknown) {
      expect(() => rewritePreStitcher({ type: 'pre-stitcher', args }), name).toThrow(EncodeToolsError);
      expect(() => rewritePreStitcher({ type: 'pre-stitcher', args }), name).toThrow(message);
    }
  });

  it('what the dispatcher routes on: `-f image2pipe` as a pair, in the frame encode and in no other call', () => {
    expect(readsImagePipe(frameEncode(X264))).toBe(true);
    expect(readsImagePipe(frameEncode(VT))).toBe(true);
    for (const args of OTHER_CALLS) expect(readsImagePipe(args), args.join(' ')).toBe(false);
  });
});

// ── Programs that say who they are ─────────────────────────────────────────────

/** A program (a node script, so that macOS hands it DYLD_LIBRARY_PATH: a /bin/sh script never sees it) printing who it is, its arguments, folder and environment. */
function teller(file: string, who: string): void {
  writeFileSync(
    file,
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ who: ${JSON.stringify(who)}, args: process.argv.slice(2), dyld: process.env.DYLD_LIBRARY_PATH ?? null, cwd: process.cwd(), env: Object.keys(process.env).filter((k) => !k.startsWith('__')).sort() }));\n`,
    { mode: 0o755 },
  );
}

/** A folder like the library's: its three programs and two libraries. */
function fakeCompositor(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  teller(join(dir, 'ffmpeg'), 'library');
  teller(join(dir, 'ffprobe'), 'library-ffprobe');
  teller(join(dir, 'remotion'), 'library-compositor');
  writeFileSync(join(dir, 'libavcodec.dylib'), 'x');
  writeFileSync(join(dir, 'libavutil.dylib'), 'x');
  writeFileSync(join(dir, 'README.md'), 'not a program');
  return dir;
}

/** Start `<folder>/<bin>` as the library starts its programs on macOS: in the folder, with nothing in the environment but the library path. */
function start(folder: string, bin: string, args: string[]): { who: string; args: string[]; dyld: string | null; cwd: string; env: string[] } {
  const r = spawnSync(join(folder, bin), args, { cwd: folder, env: { DYLD_LIBRARY_PATH: folder }, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

describe.skipIf(!posix)('the folder a render hands the library (encodeFolder)', () => {
  const compositor = fakeCompositor('compositor');
  const own = join(scratch, 'own-ffmpeg');
  teller(own, 'own');
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(scratch, 'home-'));
  });

  it("holds links to the library's compositor, ffprobe and libraries, and the dispatcher as ffmpeg; private to the person; under <home>/encode-tools", () => {
    const dir = encodeFolder({ home, compositorDir: compositor, ffmpegPath: own });
    expect(dir.startsWith(join(statReal(home), ENCODE_TOOLS_DIR) + '/')).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(['ffmpeg', 'ffprobe', 'libavcodec.dylib', 'libavutil.dylib', 'remotion']);
    expect(linkedEntries(readdirSync(compositor))).toEqual(['ffprobe', 'libavcodec.dylib', 'libavutil.dylib', 'remotion']);
    for (const n of ['ffprobe', 'libavcodec.dylib', 'libavutil.dylib', 'remotion']) {
      expect(lstatSync(join(dir, n)).isSymbolicLink(), n).toBe(true);
      expect(readlinkSync(join(dir, n)), n).toBe(join(compositor, n));
    }
    expect(lstatSync(join(dir, 'ffmpeg')).isFile()).toBe(true);
    expect(statSync(join(dir, 'ffmpeg')).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir, 'ffmpeg'), 'utf8')).toBe(dispatcherScript(compositor, own));
    // Nothing left beside it.
    expect(readdirSync(join(home, ENCODE_TOOLS_DIR))).toHaveLength(1);
  });

  it("the frame encode goes to our ffmpeg; every other call to the library's, with the library path it needs — from an empty environment", () => {
    const dir = encodeFolder({ home, compositorDir: compositor, ffmpegPath: own });
    for (const codec of [X264, VT]) {
      const args = rewritePreStitcher({ type: 'pre-stitcher', args: frameEncode(codec) });
      const r = start(dir, 'ffmpeg', args);
      expect(r.who).toBe('own');
      expect(r.args).toEqual(args);
      // Ours is started without the library's path: it must not load the library's libraries.
      expect(r.dyld).toBeNull();
    }
    for (const args of OTHER_CALLS) {
      const r = start(dir, 'ffmpeg', args);
      expect(r.who, args.join(' ')).toBe('library');
      expect(r.args).toEqual(args);
      // /bin/sh drops DYLD_* on macOS: the script sets it again, to the library's own folder.
      expect(r.dyld, args.join(' ')).toBe(compositor);
    }
    // Arguments pass as they are: spaces, quotes, an empty one, a glob.
    const odd = ['-i', '/tmp/a b/it\'s "x".wav', '', '*', '$HOME', '-y', '/tmp/o p.aac'];
    expect(start(dir, 'ffmpeg', odd).args).toEqual(odd);
    expect(start(dir, 'ffmpeg', ['-metadata', 'a=b c', ...frameEncode(X264)]).args[1]).toBe('a=b c');
    // The other programs are the library's own, through the links.
    expect(start(dir, 'ffprobe', ['-v', 'error']).who).toBe('library-ffprobe');
    expect(start(dir, 'remotion', []).who).toBe('library-compositor');
  });

  it('used as it is when right (the same folder, untouched); anything that differs — the script, a link, one entry more, its mode — and it is made again aside and moved into place', () => {
    const dir = encodeFolder({ home, compositorDir: compositor, ffmpegPath: own });
    const ino = statSync(dir).ino;
    expect(encodeFolder({ home, compositorDir: compositor, ffmpegPath: own })).toBe(dir);
    expect(statSync(dir).ino).toBe(ino);
    const damage: Array<[string, () => void]> = [
      ['the script changed', () => writeFileSync(join(dir, 'ffmpeg'), '#!/bin/sh\nexec /usr/bin/true\n')],
      ['the script open to others', () => chmodSync(join(dir, 'ffmpeg'), 0o755)],
      ['a link pointing elsewhere', () => (rmSync(join(dir, 'ffprobe')), symlinkSync('/usr/bin/true', join(dir, 'ffprobe')))],
      ['a link replaced by a file', () => (rmSync(join(dir, 'remotion')), writeFileSync(join(dir, 'remotion'), '#!/bin/sh\n', { mode: 0o755 }))],
      ['one entry more', () => writeFileSync(join(dir, 'libextra.dylib'), 'x')],
      ['one entry less', () => rmSync(join(dir, 'libavutil.dylib'))],
      ['the folder open to others', () => chmodSync(dir, 0o755)],
    ];
    let last = ino;
    for (const [name, harm] of damage) {
      harm();
      expect(encodeFolder({ home, compositorDir: compositor, ffmpegPath: own }), name).toBe(dir);
      // A new folder moved into place, never the damaged one repaired in place (another render may be reading it).
      const now = statSync(dir).ino;
      expect(now, name).not.toBe(last);
      last = now;
      expect(readFileSync(join(dir, 'ffmpeg'), 'utf8'), name).toBe(dispatcherScript(compositor, own));
      expect(readdirSync(dir).sort(), name).toEqual(['ffmpeg', 'ffprobe', 'libavcodec.dylib', 'libavutil.dylib', 'remotion']);
      expect(statSync(dir).mode & 0o777, name).toBe(0o700);
      expect(start(dir, 'ffmpeg', frameEncode(X264)).who, name).toBe('own');
      expect(readdirSync(join(home, ENCODE_TOOLS_DIR)), name).toHaveLength(1);
    }
  });

  it('one folder per pair of programs: another ffmpeg of ours, or another library folder, gets its own', () => {
    const other = join(scratch, 'own-ffmpeg-2');
    teller(other, 'own-2');
    const a = encodeFolder({ home, compositorDir: compositor, ffmpegPath: own });
    const b = encodeFolder({ home, compositorDir: compositor, ffmpegPath: other });
    const c = encodeFolder({ home, compositorDir: fakeCompositor('compositor-2'), ffmpegPath: own });
    expect(new Set([a, b, c]).size).toBe(3);
    expect(start(a, 'ffmpeg', frameEncode(X264)).who).toBe('own');
    expect(start(b, 'ffmpeg', frameEncode(X264)).who).toBe('own-2');
    expect(start(c, 'ffmpeg', ['-encoders']).dyld).toBe(join(scratch, 'compositor-2'));
  });

  it('named by what it holds — the script and the links: another script for the same two programs (another version of this code) or one library more is another folder, never this one made again', () => {
    const dir = encodeFolder({ home, compositorDir: compositor, ffmpegPath: own });
    const script = dispatcherScript(compositor, own);
    const links = linkedEntries(readdirSync(compositor));
    expect(basename(dir)).toBe(encodeFolderName(script, links));
    expect(basename(dir)).toMatch(/^[0-9a-f]{16}$/);
    expect(encodeFolderName(`${script}# v2\n`, links)).not.toBe(basename(dir));
    expect(encodeFolderName(script, [...links, 'libswscale.dylib'])).not.toBe(basename(dir));
    // The two paths alone do not name it: the same pair with another content is another name.
    expect(encodeFolderName(script, links)).toBe(encodeFolderName(dispatcherScript(compositor, own), [...links]));
    const ino = statSync(dir).ino;
    // The library gains a library: its folder is another one, and the first is left as it is (a render may be using it).
    writeFileSync(join(compositor, 'libswscale.dylib'), 'x');
    try {
      const next = encodeFolder({ home, compositorDir: compositor, ffmpegPath: own });
      expect(next).not.toBe(dir);
      expect(statSync(dir).ino).toBe(ino);
      expect(readdirSync(dir).sort()).toEqual(['ffmpeg', 'ffprobe', 'libavcodec.dylib', 'libavutil.dylib', 'remotion']);
    } finally {
      rmSync(join(compositor, 'libswscale.dylib'));
    }
  });

  it('made by several processes at the same instant: every one gets the same right folder, none fails, and no program of it is ever missing while the others make it', async () => {
    const built = fileURLToPath(new URL('../dist/render/encode-tools.js', import.meta.url));
    expect(existsSync(built), 'packages/editor/dist/render/encode-tools.js is missing: run pnpm build first').toBe(true);
    const child = join(scratch, 'race-child.mjs');
    writeFileSync(
      child,
      `import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const [built, home, compositor, own, at] = process.argv.slice(2);
const { encodeFolder } = await import(built);
while (Date.now() < Number(at)) {}
let dir = '';
const failed = [];
try {
  dir = encodeFolder({ home, compositorDir: compositor, ffmpegPath: own });
  // Start its programs while the other processes are still making theirs: as a render does right after.
  for (let i = 0; i < 25; i++) {
    const r = spawnSync(join(dir, 'ffmpeg'), i % 2 ? ['-f', 'image2pipe', '-i', '-'] : ['-version'], { cwd: dir, env: { DYLD_LIBRARY_PATH: dir }, encoding: 'utf8' });
    if (r.status !== 0 || r.error) failed.push(String(r.error?.code ?? r.status));
  }
} catch (e) {
  failed.push(e.name + ': ' + e.message);
}
process.stdout.write(JSON.stringify({ dir, failed }));
`,
    );
    const N = 8;
    for (let round = 0; round < 6; round++) {
      const raceHome = mkdtempSync(join(scratch, 'race-home-'));
      const at = String(Date.now() + 400);
      const results = await Promise.all(
        Array.from(
          { length: N },
          () =>
            new Promise<{ dir: string; failed: string[] }>((done, fail) =>
              execFile(process.execPath, [child, built, raceHome, compositor, own, at], { encoding: 'utf8' }, (err, stdout) => (err ? fail(err) : done(JSON.parse(stdout)))),
            ),
        ),
      );
      expect(
        results.flatMap((r) => r.failed),
        `round ${round}`,
      ).toEqual([]);
      expect(new Set(results.map((r) => r.dir)).size, `round ${round}`).toBe(1);
      // One folder, nothing built aside or moved aside left behind.
      expect(readdirSync(join(raceHome, ENCODE_TOOLS_DIR)), `round ${round}`).toEqual([basename(results[0].dir)]);
      expect(readFileSync(join(results[0].dir, 'ffmpeg'), 'utf8')).toBe(dispatcherScript(compositor, own));
    }
  }, 120_000);

  it("its parent is this account's private folder or nothing is made: one others can write in, or a link to elsewhere, is refused — and a folder of another content is never taken", () => {
    const parent = join(home, ENCODE_TOOLS_DIR);
    mkdirSync(parent, { mode: 0o700 });
    chmodSync(parent, 0o777);
    expect(() => encodeFolder({ home, compositorDir: compositor, ffmpegPath: own })).toThrow(/not a private folder of this account/);
    expect(readdirSync(parent)).toEqual([]);
    chmodSync(parent, 0o755);
    expect(encodeFolder({ home, compositorDir: compositor, ffmpegPath: own })).toContain(parent.replace(/^\/var\//, '/private/var/'));
    const linkedHome = mkdtempSync(join(scratch, 'home-'));
    const elsewhere = mkdtempSync(join(scratch, 'elsewhere-'));
    symlinkSync(elsewhere, join(linkedHome, ENCODE_TOOLS_DIR));
    expect(() => encodeFolder({ home: linkedHome, compositorDir: compositor, ffmpegPath: own })).toThrow(EncodeToolsError);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('when a folder is made, what no render can use any more is removed: folders left aside and folders whose script starts a program that is gone, each older than a day — nothing else', () => {
    const parent = join(home, ENCODE_TOOLS_DIR);
    mkdirSync(parent, { mode: 0o700 });
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    const make = (name: string, script: string, aged: boolean) => {
      mkdirSync(join(parent, name), { mode: 0o700 });
      writeFileSync(join(parent, name, 'ffmpeg'), script, { mode: 0o700 });
      if (aged) utimesSync(join(parent, name), old, old);
    };
    const gone = dispatcherScript(compositor, join(scratch, 'upgraded-away', 'ffmpeg'));
    const here = dispatcherScript(compositor, own);
    make('00000000000000a1', gone, true); // its ffmpeg is gone, old: removed
    make('00000000000000a2', gone, false); // its ffmpeg is gone, made today: left (a day is the margin)
    make('00000000000000a3', here, true); // its programs exist: left, however old
    make('00000000000000a4.tmp-0a0b0c', here, true); // built aside and left there, old: removed
    make('00000000000000a5.old-0a0b0c', here, true); // moved aside and left there, old: removed
    make('00000000000000a6.tmp-0d0e0f', here, false); // another process is building it now: left
    make('notes', 'not ours', true); // not a name of ours: left
    const dir = encodeFolder({ home, compositorDir: compositor, ffmpegPath: own });
    expect(readdirSync(parent).sort()).toEqual(['00000000000000a2', '00000000000000a3', '00000000000000a6.tmp-0d0e0f', basename(dir), 'notes'].sort());
  });

  it('refused with EncodeToolsError, nothing left behind: a path with a quote or a control character, a library folder without its programs, a home that cannot hold it', () => {
    for (const bad of [join(scratch, "it's", 'ffmpeg'), join(scratch, 'a\nb', 'ffmpeg'), join(scratch, 'a\u0007b'), 'ffmpeg']) {
      expect(() => dispatcherScript(compositor, bad), JSON.stringify(bad)).toThrow(EncodeToolsError);
      expect(() => dispatcherScript(bad, own), JSON.stringify(bad)).toThrow(EncodeToolsError);
      expect(() => encodeFolder({ home, compositorDir: compositor, ffmpegPath: bad }), JSON.stringify(bad)).toThrow(/a quote or a control character/);
    }
    // Paths the shell would read otherwise stay text between the quotes.
    const script = dispatcherScript('/opt/lib $(x)/`y`', '/opt/my "ffmpeg" $HOME/ffmpeg');
    expect(script).toContain(`exec '/opt/my "ffmpeg" $HOME/ffmpeg' "$@"`);
    expect(script).toContain("DYLD_LIBRARY_PATH='/opt/lib $(x)/`y`'");
    const empty = join(scratch, 'not-a-compositor');
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, 'ffmpeg'), 'x');
    expect(() => encodeFolder({ home, compositorDir: empty, ffmpegPath: own })).toThrow(/does not hold its programs/);
    expect(() => encodeFolder({ home, compositorDir: join(scratch, 'missing'), ffmpegPath: own })).toThrow(/cannot be listed \(ENOENT\)/);
    const file = join(scratch, 'home-is-a-file');
    writeFileSync(file, 'x');
    expect(() => encodeFolder({ home: file, compositorDir: compositor, ffmpegPath: own })).toThrow(/the encode tools folder cannot be made/);
    expect(existsSync(join(home, ENCODE_TOOLS_DIR))).toBe(false);
  });
});

function statReal(p: string): string {
  return execFileSync(process.execPath, ['-e', 'process.stdout.write(require("fs").realpathSync(process.argv[1]))', p], { encoding: 'utf8' });
}

// ── Which ffmpeg qualifies ─────────────────────────────────────────────────────

/** An ffmpeg that answers `-version`, `-encoders` and `-filters` as told. */
function fakeFfmpeg(name: string, o: { version?: string; encoders?: string[]; filters?: string[]; fail?: boolean }): string {
  const file = join(scratch, name);
  const enc = (o.encoders ?? ['libx264', 'h264_videotoolbox']).map((e) => ` V....D ${e}              an encoder`).join('\n');
  const fil = (o.filters ?? ['colorspace', 'scale']).map((f) => ` TS ${f}        V->V       a filter`).join('\n');
  writeFileSync(
    file,
    `#!${process.execPath}
const a = process.argv.slice(2);
if (${o.fail ? 'true' : 'false'}) process.exit(3);
if (a.includes('-version')) console.log('ffmpeg version ${o.version ?? '7.1'} Copyright (c) the FFmpeg developers\\nbuilt with a compiler');
else if (a.includes('-encoders')) console.log(${JSON.stringify(`Encoders:\n ------\n${enc}`)});
else if (a.includes('-filters')) console.log(${JSON.stringify(`Filters:\n${fil}`)});
else process.exit(1);
`,
    { mode: 0o755 },
  );
  return file;
}

describe.skipIf(!posix)('which ffmpeg of ours may encode a render (ownFfmpeg)', () => {
  const compositor = fakeCompositor('compositor-q');
  const ask = (path: string | (() => string), platform: NodeJS.Platform = 'darwin') => ownFfmpeg({ resolve: typeof path === 'string' ? () => path : path, compositorDir: compositor, platform });
  beforeEach(() => resetOwnFfmpeg());

  it('a recent one with the colorspace filter and an H.264 encoder: its real path and what it has', async () => {
    const good = fakeFfmpeg('ff-good', { version: '7.1.1' });
    const link = join(scratch, 'ff-link');
    symlinkSync(good, link);
    const r = await ask(link);
    expect(r).toEqual({ ok: true, path: statReal(good), facts: { version: '7.1.1', libx264: true, videotoolbox: true, filter: true } });
    expect(await ask(fakeFfmpeg('ff-novt', { version: 'n6.0', encoders: ['libx264', 'h264_videotoolbox_extra'] }))).toMatchObject({
      ok: true,
      facts: { version: '6.0', libx264: true, videotoolbox: false },
    });
    expect(await ask(fakeFfmpeg('ff-nox264', { version: '5.1', encoders: ['h264_videotoolbox'] }))).toMatchObject({ ok: true, facts: { libx264: false, videotoolbox: true } });
    // A snapshot build is not judged on its version (as `retake doctor`).
    expect(await ask(fakeFfmpeg('ff-snapshot', { version: 'N-118900-gabc' }))).toMatchObject({ ok: true, facts: { version: 'N-118900-gabc' } });
  });

  it("refused, each with its reason: too old, no colorspace filter, no H.264 encoder, the library's own, not starting, none found, a path with a quote, elsewhere than macOS", async () => {
    const reason = async (r: ReturnType<typeof ask>) => {
      const x = await r;
      expect(x.ok).toBe(false);
      return x.ok ? '' : x.reason;
    };
    expect(await reason(ask(fakeFfmpeg('ff-old', { version: '4.4.2' })))).toBe("this machine's ffmpeg cannot encode renders: it is ffmpeg 4.4.2 (needs 5.1+)");
    expect(await reason(ask(fakeFfmpeg('ff-old-50', { version: '5.0.3' })))).toMatch(/it is ffmpeg 5\.0\.3 \(needs 5\.1\+\)/);
    expect(await reason(ask(fakeFfmpeg('ff-nofilter', { version: '7.0', filters: ['scale', 'colorspace_extra'] })))).toBe("this machine's ffmpeg (7.0) has no colorspace filter");
    expect(await reason(ask(fakeFfmpeg('ff-noenc', { version: '7.0', encoders: ['mpeg4', 'libx265'] })))).toBe("this machine's ffmpeg (7.0) has no H.264 encoder (libx264, h264_videotoolbox)");
    expect(await reason(ask(join(compositor, 'ffmpeg')))).toBe("this machine's ffmpeg is the rendering library's own");
    const linked = join(scratch, 'to-the-library');
    symlinkSync(join(compositor, 'ffmpeg'), linked);
    expect(await reason(ask(linked))).toBe("this machine's ffmpeg is the rendering library's own");
    expect(await reason(ask(fakeFfmpeg('ff-broken', { fail: true })))).toBe("this machine's ffmpeg cannot encode renders: it does not start");
    expect(await reason(ask('ffmpeg'))).toBe('no ffmpeg found on this machine');
    expect(await reason(ask(join(scratch, 'gone', 'ffmpeg')))).toBe("this machine's ffmpeg is not a file that can be read");
    expect(
      await reason(
        ask(() => {
          throw new Error('ffmpeg (/ws/bin/ffmpeg) lies inside the workspace (/ws)\nmore');
        }),
      ),
    ).toBe("this machine's ffmpeg may not be started for this work");
    // What the refusal itself said is kept apart, for the warnings: the reason is always a sentence of this code.
    expect(
      await ask(() => {
        throw new Error('ffmpeg (/ws/bin/ffmpeg) lies inside the workspace (/ws)\nmore');
      }),
    ).toEqual({ ok: false, reason: "this machine's ffmpeg may not be started for this work", detail: 'ffmpeg (/ws/bin/ffmpeg) lies inside the workspace (/ws)' });
    // A version word that is more than a version is not taken.
    expect(await reason(ask(fakeFfmpeg('ff-odd-version', { version: '7.1;$(x)' })))).toBe("this machine's ffmpeg cannot encode renders: it does not say its version");
    mkdirSync(join(scratch, "it's"), { recursive: true });
    const quoted = join(scratch, "it's", 'ffmpeg');
    writeFileSync(quoted, readFileSync(fakeFfmpeg('ff-q', {})), { mode: 0o755 });
    expect(await reason(ask(quoted))).toBe("the path of this machine's ffmpeg holds a quote or a control character");
    for (const platform of ['linux', 'win32'] as const) expect(await reason(ask(fakeFfmpeg('ff-good-2', {}), platform))).toBe("this machine's ffmpeg encodes renders on macOS only");
  });

  it('read again when the file changed, and when it did not start: only an answer is kept', async () => {
    const flag = join(scratch, 'ff-busy.flag');
    const busy = join(scratch, 'ff-busy');
    writeFileSync(busy, readFileSync(fakeFfmpeg('ff-b', { version: '7.1' }), 'utf8').replace('const a = ', `if (require('fs').existsSync(${JSON.stringify(flag)})) process.exit(3);\nconst a = `), {
      mode: 0o755,
    });
    writeFileSync(flag, '');
    expect(await ask(busy)).toEqual({ ok: false, reason: "this machine's ffmpeg cannot encode renders: it does not start" });
    // The same file, a moment later (a busy machine let the first try time out): asked again.
    rmSync(flag);
    expect(await ask(busy)).toMatchObject({ ok: true, facts: { version: '7.1' } });
    // Replaced in place by another build: its own facts, not the ones read before.
    const replaced = join(scratch, 'ff-replaced');
    writeFileSync(replaced, readFileSync(fakeFfmpeg('ff-r1', { version: '6.1' })), { mode: 0o755 });
    expect(await ask(replaced)).toMatchObject({ ok: true, facts: { version: '6.1', filter: true } });
    writeFileSync(replaced, readFileSync(fakeFfmpeg('ff-r2', { version: '8.0.1', filters: ['scale'] })), { mode: 0o755 });
    expect(await ask(replaced)).toEqual({ ok: false, reason: "this machine's ffmpeg (8.0.1) has no colorspace filter" });
  });

  it('one that failed at an encode is remembered by its file, for this process: the same path with another file is not', () => {
    const f = join(scratch, 'ff-failed');
    writeFileSync(f, readFileSync(fakeFfmpeg('ff-f1', { version: '7.1' })), { mode: 0o755 });
    expect(ownEncodeFailedEarlier(f)).toBe(false);
    noteOwnEncodeFailed(f);
    expect(ownEncodeFailedEarlier(f)).toBe(true);
    expect(ownEncodeFailedEarlier(join(scratch, 'ff-f1'))).toBe(false);
    writeFileSync(f, readFileSync(fakeFfmpeg('ff-f2', { version: '7.1.2' })), { mode: 0o755 });
    expect(ownEncodeFailedEarlier(f)).toBe(false);
    noteOwnEncodeFailed(f);
    resetOwnFfmpeg();
    expect(ownEncodeFailedEarlier(f)).toBe(false);
  });

  it("the frame-encode probe: the library's frame encode with our filter on three frames the same ffmpeg makes, written nowhere; an ffmpeg that cannot is told so with its own first line", async () => {
    const s = { width: 320, height: 180, fps: 30 };
    const args = frameEncodeProbeArgs(s, ['-c:v', 'libx264', '-crf', '16']);
    // The command a render runs (rewritePreStitcher), but for its output.
    const render = rewritePreStitcher({ type: 'pre-stitcher', args: frameEncode(['-c:v', 'libx264', '-crf', '16']).map((a) => (a === '1920x1080' ? '320x180' : a)) });
    expect(args.slice(3, -3)).toEqual(render.slice(0, -2));
    expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
    expect(readsImagePipe(args)).toBe(true);
    expect(probeFramesArgs(s)).toEqual(expect.arrayContaining(['-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=30', '-frames:v', '3', '-c:v', 'mjpeg', '-f', 'image2pipe', '-']));
    // An ffmpeg that makes no frames, and one that makes them and fails the encode.
    const mute = join(scratch, 'ff-mute');
    writeFileSync(mute, `#!${process.execPath}\nprocess.stderr.write('Unknown encoder\\n'); process.exit(1);\n`, { mode: 0o755 });
    expect(await probeFrameEncode(mute, s, ['-c:v', 'libx264'])).toEqual({ ok: false, error: 'Unknown encoder' });
    // One that cannot make the frames is not taken at the word of its encode.
    const noFrames = join(scratch, 'ff-noframes');
    writeFileSync(
      noFrames,
      `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a.includes('lavfi')) { process.stderr.write("Unknown encoder 'mjpeg'\\n"); process.exit(1); }\nprocess.stdin.resume();\n`,
      { mode: 0o755 },
    );
    expect(await probeFrameEncode(noFrames, s, ['-c:v', 'libx264'])).toEqual({ ok: false, error: "Unknown encoder 'mjpeg'" });
    const half = join(scratch, 'ff-half');
    writeFileSync(
      half,
      `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a.includes('lavfi')) { process.stdout.write('JPEG'); process.exit(0); }\nprocess.stderr.write("[AVFilterGraph] No such filter: 'colorspace'\\nmore\\n"); process.exit(8);\n`,
      { mode: 0o755 },
    );
    expect(await probeFrameEncode(half, s, ['-c:v', 'libx264'])).toEqual({ ok: false, error: "[AVFilterGraph] No such filter: 'colorspace'" });
    const fine = join(scratch, 'ff-fine');
    writeFileSync(fine, `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a.includes('lavfi')) process.stdout.write('JPEG');\nelse process.stdin.resume();\n`, { mode: 0o755 });
    expect(await probeFrameEncode(fine, s, ['-c:v', 'libx264'])).toEqual({ ok: true });
  });

  it('read once per path and process', async () => {
    const counted = join(scratch, 'ff-counted');
    const log = join(scratch, 'ff-counted.log');
    writeFileSync(counted, readFileSync(fakeFfmpeg('ff-c', {}), 'utf8').replace('const a = ', `require('fs').appendFileSync(${JSON.stringify(log)}, 'x');\nconst a = `), { mode: 0o755 });
    expect((await ask(counted)).ok).toBe(true);
    const runs = readFileSync(log, 'utf8').length;
    expect(runs).toBe(3);
    expect((await ask(counted)).ok).toBe(true);
    expect(readFileSync(log, 'utf8').length).toBe(runs);
  });
});

// ── The real programs ──────────────────────────────────────────────────────────

const real = process.platform === 'darwin' && hasTool('ffmpeg') && hasTool('ffprobe');

describe.skipIf(!real)("this machine's ffmpeg and the library's, through the real folder (no render)", () => {
  it("the frame encode as the library writes it is encoded by ours and tagged as the library's; any other call is answered by the library's ffmpeg", async () => {
    const which = execFileSync('/usr/bin/which', ['ffmpeg'], { encoding: 'utf8' }).trim();
    const lib = await compositorDir();
    const own = await ownFfmpeg({ resolve: () => which, compositorDir: lib });
    if (!own.ok) {
      // A machine whose ffmpeg does not qualify renders with the library's: nothing more to check here.
      expect(own.reason).toMatch(/ffmpeg/);
      return;
    }
    // What the library's folder holds in the version installed: the three programs and seven libraries the folder
    // stands for (a version that adds a program or a library it loads must be looked at here first).
    const programs = readdirSync(lib)
      .filter((n) => !/^(?:README\.md|package\.json|index\.(?:js|mjs|d\.ts))$/.test(n))
      .sort();
    expect(programs).toEqual([
      'ffmpeg',
      'ffprobe',
      'libavcodec.dylib',
      'libavdevice.dylib',
      'libavfilter.dylib',
      'libavformat.dylib',
      'libavutil.dylib',
      'libswresample.dylib',
      'libswscale.dylib',
      'remotion',
    ]);
    expect(linkedEntries(readdirSync(lib))).toEqual(programs.filter((n) => n !== 'ffmpeg'));
    // The probe a render makes before it takes ours: the frame encode itself, with each encoder ours has.
    const size = { width: 320, height: 180, fps: 30 };
    if (own.facts.libx264) expect(await probeFrameEncode(own.path, size, ['-c:v', 'libx264', '-crf', '16'])).toEqual({ ok: true });
    const bad = await probeFrameEncode(own.path, size, ['-c:v', 'no_such_encoder']);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/no_such_encoder|encoder/i);
    const home = mkdtempSync(join(scratch, 'real-home-'));
    const dir = encodeFolder({ home, compositorDir: lib, ffmpegPath: own.path });
    const env = { DYLD_LIBRARY_PATH: dir };
    // Another call: the library's own ffmpeg answers (its version is not ours), started from the folder as the library does.
    const version = (bin: string) => /^ffmpeg version\s+(\S+)/m.exec(spawnSync(bin, ['-hide_banner', '-version'], { cwd: dir, env, encoding: 'utf8' }).stdout)?.[1];
    expect(version(join(dir, 'ffmpeg'))).toBe(version(join(lib, 'ffmpeg')));
    expect(version(join(dir, 'ffmpeg'))).not.toBe(version(own.path));
    expect(spawnSync(join(dir, 'ffprobe'), ['-version'], { cwd: dir, env, encoding: 'utf8' }).stdout).toMatch(/^ffprobe version/);
    // The frame encode: six full-range JPEG frames down the pipe, the library's arguments with the filter rewritten.
    const jpegs = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30', '-frames:v', '6', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '2', '-'], {
      maxBuffer: 64e6,
    });
    const out = join(home, 'pre-encode.mp4');
    const args = rewritePreStitcher({
      type: 'pre-stitcher',
      args: frameEncode(own.facts.libx264 ? X264 : ['-c:v', 'h264_videotoolbox', '-b:v', '1M', '-g', '60']).map((a) => (a === '1920x1080' ? '320x180' : a === '/tmp/x/pre-encode.mp4' ? out : a)),
    });
    const r = spawnSync(join(dir, 'ffmpeg'), args, { cwd: dir, env, input: jpegs, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const probe = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-count_frames',
        '-show_entries',
        'stream=codec_name,pix_fmt,color_range,color_space,color_transfer,color_primaries,time_base,nb_read_frames',
        '-of',
        'default=nw=1',
        out,
      ],
      { encoding: 'utf8' },
    );
    expect(
      Object.fromEntries(
        probe
          .trim()
          .split('\n')
          .map((l) => l.split('=')),
      ),
    ).toEqual({
      codec_name: 'h264',
      pix_fmt: 'yuv420p',
      color_range: 'tv',
      color_space: 'bt709',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      time_base: '1/90000',
      nb_read_frames: '6',
    });
  }, 60_000);
});
