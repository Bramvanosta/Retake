#!/usr/bin/env node
/**
 * Retake's own ffmpeg (L5.16): a static, relocatable ffmpeg + ffprobe for macOS arm64, GPL with libx264 — built from
 * the archives pinned in scripts/ffmpeg-sources.json (URL + sha256), with nothing of Homebrew linked:
 *   1. the archives are read from a cache folder (`--sources`, else RETAKE_FFMPEG_SOURCES, else
 *      <os temp>/retake-ffmpeg-sources — never the repository); a missing one is downloaded only with `--fetch`; every
 *      archive's sha256 is checked before it is used, a mismatch stops the build;
 *   2. x264, libvpx and opus are built as static libraries into a scratch prefix, found by ffmpeg through pkg-config
 *      with PKG_CONFIG_LIBDIR set to that prefix only (Homebrew's .pc files are never seen);
 *   3. ffmpeg + ffprobe are configured with `--disable-autodetect` (only what is named is built in: VideoToolbox,
 *      AudioToolbox and the system zlib, besides the three libraries) and copied to `--out`, with `buildconf.txt`;
 *   4. the result is checked (`--check <dir>` runs only this on any ffmpeg folder): the configuration has the GPL flags
 *      and no nonfree, the binaries link only system libraries and have no rpath, and every encoder / decoder / muxer /
 *      demuxer / filter / protocol the engine names (ENGINE_NEEDS) is there.
 * Licences and the written source offer for what this builds are in apps/desktop/licenses/ffmpeg/.
 *
 *   node scripts/build-ffmpeg.mjs --fetch --out <dir>     # download what is missing, build, check (≈ 100 s on an M4)
 *   node scripts/build-ffmpeg.mjs --sources <dir> --out <dir> [--work <dir>] [--jobs <n>] [--keep-work]
 *   node scripts/build-ffmpeg.mjs --check <dir>           # check an ffmpeg folder (ffmpeg + ffprobe) without building
 * Tools: clang, make, perl, curl (macOS command-line tools) and pkg-config; nasm is not needed on arm64. The scratch
 * work folder (<os temp>/retake-ffmpeg-build-*) is removed at the end unless `--work` or `--keep-work` is given.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCES_FILE = join(ROOT, 'scripts', 'ffmpeg-sources.json');
/** The libraries the build needs, in build order (ffmpeg last). */
export const SOURCE_NAMES = ['x264', 'libvpx', 'opus', 'ffmpeg'];

/** Flags the configuration must carry (the person's decision: GPL with libx264, the Mac's encoders). */
export const REQUIRED_FLAGS = [
  '--enable-gpl',
  '--enable-libx264',
  '--enable-libvpx',
  '--enable-libopus',
  '--enable-videotoolbox',
  '--enable-audiotoolbox',
  '--disable-nonfree',
  '--disable-autodetect',
  '--disable-network',
];
/** Flags it must never carry: nonfree code (libfdk-aac & co.) and what configure counts as nonfree next to GPL. */
export const FORBIDDEN_FLAGS = ['--enable-nonfree', '--enable-libfdk-aac', '--enable-libfdk_aac', '--enable-openssl', '--enable-decklink', '--enable-cuda-nvcc', '--enable-libnpp'];

/**
 * What the engine asks of ffmpeg / ffprobe, from its own arguments (packages/*\/src): encoders after `-c:v` / `-c:a`
 * and the files they write, decoders of what it reads, `-f` formats and output extensions, filters of its graphs and
 * lavfi sources, protocols of its inputs. build-ffmpeg.test.ts re-derives the literal ones from the sources, so a new
 * codec or format in the engine without an entry here fails there.
 */
export const ENGINE_NEEDS = {
  encoders: [
    'libx264', // runner-web encode.ts / stream.ts / raw/encode.ts, editor export.ts (mp4)
    'h264_videotoolbox', // runner-web stream.ts (capture during the take), cli doctor.ts
    'prores_ks', // runner-web raw/encode.ts (ProRes 422 HQ clips)
    'prores_aw', // runner-web raw/layer.ts (ProRes 4444 cursor layers)
    'libvpx-vp9', // editor export.ts (webm), runner-web raw/layer.ts (VP9 alpha layers)
    'libopus', // editor export.ts (webm audio)
    'aac', // editor render.ts (silent track), render/audio.ts (music bed)
    'png', // review thumbs.ts (image2pipe png), editor preview.ts (quantized PNG)
    'mjpeg', // runner-web raw/encode.ts / run.ts (%06d.jpg stills)
    'gif', // editor export.ts (gif_preview)
    'rawvideo', // review ffmpeg.ts / pixels.ts, runner-web stream.ts / raw/layer.ts (raw frames to pipes)
    'wrapped_avframe', // `-f null` (stream.ts / doctor.ts probes)
  ],
  // What it reads back (captures, renders, frames) and the person's videos core media.ts accepts (VIDEO_CODECS: h264,
  // hevc, vp8, vp9, av1, prores). av1 is FFmpeg's native decoder: hardware only (VideoToolbox, M3 and later) — this
  // build has no dav1d, so an AV1 video is probed everywhere but decoded by our ffmpeg only on such a Mac.
  decoders: ['h264', 'hevc', 'vp8', 'prores', 'vp9', 'libvpx-vp9', 'av1', 'png', 'mjpeg', 'aac', 'opus', 'rawvideo', 'gif'],
  // `ipod`: the .m4a test track (editor render/audio.ts); the others by `-f` or by the extension of the file written.
  muxers: ['mp4', 'mov', 'ipod', 'webm', 'gif', 'image2', 'image2pipe', 'rawvideo', 'null'],
  demuxers: ['mov', 'matroska', 'concat', 'image2', 'image2pipe', 'png_pipe', 'rawvideo', 'lavfi'],
  // `colorspace`: a render's frames encoded by our ffmpeg (L7.3, editor render/encode-tools.ts OWN_FRAME_FILTER). Its
  // probe (`probeFrameEncode`) makes three JPEG frames from `color` and runs the frame encode on them: `mjpeg`,
  // `image2pipe` and `null` above.
  filters: ['scale', 'format', 'split', 'select', 'fps', 'palettegen', 'paletteuse', 'color', 'anullsrc', 'aevalsrc', 'null', 'anull', 'colorspace'],
  protocols: ['file', 'pipe', 'fd'],
};

const isSha256 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

/** Problems of a sources document (empty = valid): https URLs only, 64-hex sha256, a version and a plain file name per source. */
export function validateSources(doc) {
  const out = [];
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.sources)) return ['no "sources" array'];
  if (typeof doc.min_macos !== 'string' || !/^\d+\.\d+$/.test(doc.min_macos)) out.push('"min_macos" is not a version like 15.0');
  const names = doc.sources.map((s) => s?.name);
  for (const n of SOURCE_NAMES) if (!names.includes(n)) out.push(`no source "${n}"`);
  if (new Set(names).size !== names.length) out.push('a source is listed twice');
  for (const [i, s] of doc.sources.entries()) {
    const at = `sources[${i}]${typeof s?.name === 'string' ? ` (${s.name})` : ''}`;
    let url;
    try {
      url = new URL(s?.url);
    } catch {
      out.push(`${at}: "url" is not a URL`);
    }
    if (url && url.protocol !== 'https:') out.push(`${at}: "url" is not https`);
    if (!isSha256(s?.sha256)) out.push(`${at}: "sha256" is not 64 lower-case hex digits`);
    if (typeof s?.version !== 'string' || !/\d/.test(s.version)) out.push(`${at}: no "version"`);
    if (typeof s?.license !== 'string' || !s.license.trim()) out.push(`${at}: no "license"`);
    if (typeof s?.file !== 'string' || !/^[\w.+-]+\.(tar\.(xz|gz|bz2))$/.test(s.file)) out.push(`${at}: "file" is not a plain .tar.{xz,gz,bz2} name`);
  }
  return out;
}

export async function loadSources(file = SOURCES_FILE) {
  const doc = JSON.parse(await readFile(file, 'utf8'));
  const problems = validateSources(doc);
  if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`);
  return doc;
}

export async function sha256File(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/** Throws unless `file`'s sha256 is `expected` (a missing or altered archive is never built). */
export async function verifyArchive(file, expected) {
  if (!isSha256(expected)) throw new Error(`no valid pinned sha256 for ${file}`);
  const got = await sha256File(file);
  if (got !== expected) throw new Error(`${file}: sha256 ${got} does not match the pinned ${expected} — refusing to build from it`);
  return got;
}

/** The archive of `source` in `cacheDir`, downloaded first when missing and `fetch` is set; always sha256-checked. */
export async function obtainArchive(source, cacheDir, { fetch: allowFetch = false, log = () => {} } = {}) {
  const file = join(cacheDir, source.file);
  if (!existsSync(file)) {
    if (!allowFetch) throw new Error(`${file} is missing: run with --fetch to download ${source.url}, or put the archive there`);
    if (new URL(source.url).protocol !== 'https:') throw new Error(`refusing a non-https download: ${source.url}`);
    await mkdir(cacheDir, { recursive: true });
    log(`downloading ${source.url}`);
    // curl (part of macOS), https only even across redirects; some forges refuse Node's own fetch (HTTP 406).
    const part = `${file}.partial-${process.pid}`;
    try {
      await sh('curl', ['-fsSL', '--proto', '=https', '--proto-redir', '=https', '--retry', '3', '-o', part, source.url]);
      await verifyArchive(part, source.sha256);
    } catch (e) {
      await rm(part, { force: true });
      throw e;
    }
    await rename(part, file);
  }
  await verifyArchive(file, source.sha256);
  return file;
}

const minFlag = (min) => `-mmacosx-version-min=${min}`;

export function x264ConfigureArgs({ deps, minMacos }) {
  return [
    `--prefix=${deps}`,
    '--enable-static',
    '--enable-pic',
    '--disable-cli',
    '--disable-opencl',
    '--disable-avs',
    '--disable-swscale',
    '--disable-lavf',
    '--disable-ffms',
    '--disable-gpac',
    '--disable-lsmash',
    `--extra-cflags=${minFlag(minMacos)}`,
    `--extra-ldflags=${minFlag(minMacos)}`,
  ];
}

export function libvpxConfigureArgs({ minMacos }) {
  // darwin24 = macOS 15, the bundle's minimum; the explicit -mmacosx-version-min keeps it whatever the target says.
  // No --prefix: libvpx compiles its configure line into the library (vpx_codec_build_config), so a prefix would put
  // a folder of the build machine into ffmpeg; the scratch prefix goes to `make` (libvpxMakeVars).
  return [
    '--target=arm64-darwin24-gcc',
    '--enable-static',
    '--disable-shared',
    '--enable-pic',
    '--disable-examples',
    '--disable-tools',
    '--disable-docs',
    '--disable-unit-tests',
    `--extra-cflags=${minFlag(minMacos)}`,
  ];
}

/** `make` variables of libvpx: its prefix (written into vpx.pc) and install folder, outside its configure line. */
export const libvpxMakeVars = (deps) => [`PREFIX=${deps}`, `DIST_DIR=${deps}`];

export function opusConfigureArgs({ deps, minMacos }) {
  return [`--prefix=${deps}`, '--enable-static', '--disable-shared', '--with-pic', '--disable-doc', '--disable-extra-programs', `CFLAGS=-O2 ${minFlag(minMacos)}`];
}

/**
 * ffmpeg's configure line. No path in it: the libraries come through pkg-config (PKG_CONFIG_LIBDIR = the scratch
 * prefix), and the default prefix is never installed to — so `-buildconf` names no folder of the build machine.
 */
export function ffmpegConfigureArgs({ minMacos }) {
  return [
    '--cc=clang',
    '--arch=arm64',
    '--target-os=darwin',
    '--enable-static',
    '--disable-shared',
    '--disable-autodetect',
    '--enable-gpl',
    '--disable-nonfree',
    '--enable-libx264',
    '--enable-libvpx',
    '--enable-libopus',
    '--enable-videotoolbox',
    '--enable-audiotoolbox',
    '--enable-zlib',
    '--disable-network',
    '--disable-ffplay',
    '--disable-doc',
    '--disable-debug',
    '--pkg-config=pkg-config',
    '--pkg-config-flags=--static',
    `--extra-cflags=${minFlag(minMacos)}`,
    `--extra-ldflags=${minFlag(minMacos)}`,
  ];
}

/** Problems of an ffmpeg configuration (the `configuration:` line or `-buildconf`): a required flag missing, a forbidden one present. */
export function checkConfiguration(text) {
  const flags = new Set(
    String(text)
      .split(/\s+/)
      .filter((t) => t.startsWith('--')),
  );
  const out = [];
  for (const f of REQUIRED_FLAGS) if (!flags.has(f)) out.push(`missing ${f}`);
  for (const f of flags) if (FORBIDDEN_FLAGS.includes(f) || /^--enable-(nonfree|libfdk)/.test(f)) out.push(`forbidden ${f}`);
  return out;
}

/**
 * The names of an `ffmpeg -encoders | -decoders | -filters | -muxers | -demuxers | -protocols` listing. Formats list
 * comma-separated aliases ("mov,mp4,m4a,…"): each counts.
 */
export function parseListing(kind, text) {
  const names = new Set();
  const lines = String(text).split('\n');
  if (kind === 'protocols') {
    let section = null;
    for (const l of lines) {
      if (/^\s*Input:/.test(l)) section = 'in';
      else if (/^\s*Output:/.test(l)) section = 'out';
      else if (section && /^\s+[\w-]+\s*$/.test(l)) names.add(l.trim());
    }
    return names;
  }
  // After the legend's dashes: codecs " V....D name", filters " TS name" (2 flags here, 3 in older builds), formats
  // " DEd name" with blanks for absent flags.
  const row = kind === 'filters' ? /^ [A-Z.|]{2,3} +(\S+) / : kind === 'muxers' || kind === 'demuxers' ? /^ [D. ][E. ][d. ] +(\S+)/ : /^ [A-Z.]{6} +(\S+) /;
  let started = false;
  for (const l of lines) {
    if (!started) {
      started = /^\s*-{3,}\s*$/.test(l);
      continue;
    }
    const m = row.exec(l);
    if (m) for (const n of m[1].split(',')) names.add(n);
  }
  return names;
}

/** Problems of an `otool -L` listing: any library outside /usr/lib and /System (Homebrew's, a build folder's). */
export function checkLinkage(otoolText) {
  const out = [];
  for (const l of String(otoolText).split('\n').slice(1)) {
    const lib = l.trim().split(' (')[0];
    if (lib && !lib.startsWith('/usr/lib/') && !lib.startsWith('/System/')) out.push(`links ${lib}`);
  }
  return out;
}

/** Folders of a build machine a distributed binary must not carry (a home, a temp or Homebrew folder): the first of each. */
export function machinePaths(buf) {
  const out = [];
  for (const p of ['/Users/', '/private/tmp/', '/private/var/', '/var/folders/', '/opt/homebrew/', '/usr/local/Cellar/']) {
    const i = buf.indexOf(p);
    if (i >= 0)
      out.push(
        buf
          .subarray(i, Math.min(buf.length, i + 80))
          .toString('latin1')
          .split('\0')[0],
      );
  }
  return out;
}

function sh(cmd, args, opts = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { stdio: opts.log ? ['ignore', 'pipe', 'pipe'] : 'inherit', cwd: opts.cwd, env: opts.env ?? process.env });
    let tail = '';
    if (opts.log) {
      const out = createWriteStream(opts.log, { flags: 'a' });
      for (const s of [child.stdout, child.stderr])
        s.on('data', (d) => {
          out.write(d);
          tail = (tail + d).slice(-4000);
        });
      child.on('close', () => out.end());
    }
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(' ')} exited ${code}${opts.log ? ` (log: ${opts.log})\n${tail}` : ''}`))));
  });
}

const capture = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 << 20 });
  if (r.error) throw r.error;
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
};

/** Problems of an ffmpeg folder (ffmpeg + ffprobe): configuration, linkage, rpaths, and every ENGINE_NEEDS entry. */
export function checkBinaries(dir, needs = ENGINE_NEEDS) {
  const problems = [];
  const ffmpeg = join(dir, 'ffmpeg');
  const ffprobe = join(dir, 'ffprobe');
  for (const bin of [ffmpeg, ffprobe]) {
    if (!existsSync(bin)) {
      problems.push(`${bin} is missing`);
      continue;
    }
    const v = capture(bin, ['-hide_banner', '-buildconf']);
    if (v.code !== 0) problems.push(`${bin} -buildconf exited ${v.code}`);
    else problems.push(...checkConfiguration(v.stdout).map((p) => `${bin}: ${p}`));
    problems.push(...checkLinkage(capture('otool', ['-L', bin]).stdout).map((p) => `${bin}: ${p}`));
    if (/LC_RPATH/.test(capture('otool', ['-l', bin]).stdout)) problems.push(`${bin}: has an LC_RPATH`);
    problems.push(...machinePaths(readFileSync(bin)).map((p) => `${bin}: names a folder of the build machine (${p})`));
  }
  if (!existsSync(ffmpeg)) return problems;
  for (const [kind, names] of Object.entries(needs)) {
    const have = parseListing(kind, capture(ffmpeg, ['-hide_banner', `-${kind}`]).stdout);
    for (const n of names) if (!have.has(n)) problems.push(`ffmpeg has no ${kind.replace(/s$/, '')} "${n}"`);
  }
  const lic = capture(ffmpeg, ['-hide_banner', '-L']).stdout;
  if (!/GNU General Public License/.test(lic) || /nonfree|unredistributable/i.test(lic)) problems.push('ffmpeg -L does not say GPL (or says nonfree)');
  return problems;
}

async function extract(archive, into) {
  await mkdir(into, { recursive: true });
  await sh('tar', ['-xf', archive, '-C', into]);
  const [top] = (await readdir(into)).filter((n) => !n.startsWith('.'));
  return join(into, top);
}

/** `p` with its links followed (a folder not created yet: by its nearest existing parent). */
function realOf(p) {
  try {
    return realpathSync.native(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realOf(parent), basename(p));
  }
}

/**
 * The folders the build writes or reads archives from (`--sources`, `--out`, `--work`) that lie inside the repository
 * (links followed), as `name (path)`: the build never writes into the checkout (`repo`: tests).
 */
export function foldersInsideRepo(folders, repo = ROOT) {
  const root = realOf(resolve(repo));
  return Object.entries(folders)
    .filter(([, p]) => p)
    .filter(([, p]) => {
      const rel = relative(root, realOf(resolve(p)));
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    })
    .map(([name, p]) => `${name} (${p})`);
}

function parseArgs(argv) {
  const o = { fetch: false, keepWork: false, jobs: availableParallelism() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--fetch') o.fetch = true;
    else if (a === '--keep-work') o.keepWork = true;
    else if (a === '--sources') o.sources = resolve(val());
    else if (a === '--out') o.out = resolve(val());
    else if (a === '--work') o.work = resolve(val());
    else if (a === '--check') o.check = resolve(val());
    else if (a === '--jobs') o.jobs = Math.max(1, Number(val()) || 1);
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function report(problems) {
  if (problems.length === 0) return console.log('check: ok (configuration, linkage, no rpath, every engine need)');
  console.error(`check: ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exitCode = 1;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.check) return report(checkBinaries(o.check));
  if (!o.out) throw new Error('--out <dir> is required (or --check <dir>)');
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('this build is for macOS arm64');
  const t0 = Date.now();
  const doc = await loadSources();
  const min = doc.min_macos;
  const cache = o.sources ?? (process.env.RETAKE_FFMPEG_SOURCES?.trim() ? resolve(process.env.RETAKE_FFMPEG_SOURCES.trim()) : join(tmpdir(), 'retake-ffmpeg-sources'));
  const inside = foldersInsideRepo({ 'the source cache': cache, '--out': o.out, '--work': o.work });
  if (inside.length) throw new Error(`${inside.join(', ')} inside the repository: use folders outside it`);
  const byName = Object.fromEntries(doc.sources.map((s) => [s.name, s]));
  const archives = {};
  for (const n of SOURCE_NAMES) archives[n] = await obtainArchive(byName[n], cache, { fetch: o.fetch, log: console.log });
  console.log(`sources: ${SOURCE_NAMES.map((n) => `${n} ${byName[n].version}`).join(', ')} (sha256 ok)`);

  const work = o.work ?? (await mkdtemp(join(tmpdir(), 'retake-ffmpeg-build-')));
  const deps = join(work, 'deps');
  const logs = join(work, 'logs');
  await mkdir(logs, { recursive: true });
  // Only the scratch prefix's .pc files, the system compiler, and no Homebrew include / library folder.
  // The system's tools first; pkg-config (not part of macOS) through a link of its own, so no other folder of the
  // machine (Homebrew's bin) is on the build's PATH.
  const pkgConfig = capture('/bin/sh', ['-c', 'command -v pkg-config']).stdout.trim();
  if (!pkgConfig) throw new Error("pkg-config is not on PATH (it finds the static libraries for ffmpeg's configure)");
  const bin = join(work, 'bin');
  await mkdir(bin, { recursive: true });
  await symlink(pkgConfig, join(bin, 'pkg-config')).catch((e) => {
    if (e.code !== 'EEXIST') throw e;
  });
  const env = {
    PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${bin}`,
    HOME: process.env.HOME ?? work,
    PKG_CONFIG_LIBDIR: join(deps, 'lib', 'pkgconfig'),
    CC: 'clang',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LC_ALL: 'C',
  };
  const make = ['-j', String(o.jobs)];
  const step = async (name, args, makeVars = []) => {
    const t = Date.now();
    const cwd = await extract(archives[name], join(work, 'src', name));
    const log = join(logs, `${name}.log`);
    await sh('./configure', args, { cwd, env, log });
    await sh('make', [...make, ...makeVars], { cwd, env, log });
    if (name !== 'ffmpeg') await sh('make', ['install', ...makeVars], { cwd, env, log });
    console.log(`${name}: built in ${Math.round((Date.now() - t) / 1000)} s`);
    return cwd;
  };
  await step('x264', x264ConfigureArgs({ deps, minMacos: min }));
  await step('libvpx', libvpxConfigureArgs({ minMacos: min }), libvpxMakeVars(deps));
  await step('opus', opusConfigureArgs({ deps, minMacos: min }));
  const ff = await step('ffmpeg', ffmpegConfigureArgs({ minMacos: min }));

  await mkdir(o.out, { recursive: true });
  for (const b of ['ffmpeg', 'ffprobe']) await copyFile(join(ff, b), join(o.out, b));
  await writeFile(join(o.out, 'buildconf.txt'), capture(join(o.out, 'ffmpeg'), ['-hide_banner', '-buildconf']).stdout);
  const sizes = await Promise.all(['ffmpeg', 'ffprobe'].map(async (b) => `${b} ${((await stat(join(o.out, b))).size / 1e6).toFixed(1)} MB`));
  console.log(`out: ${o.out} — ${sizes.join(', ')}; ${Math.round((Date.now() - t0) / 1000)} s in all (${o.jobs} jobs)`);
  if (!o.keepWork && !o.work) await rm(work, { recursive: true, force: true });
  report(checkBinaries(o.out));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`build-ffmpeg: ${e.message}`);
    process.exit(1);
  });
}
