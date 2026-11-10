/**
 * scripts/build-ffmpeg.mjs (L5.16): Retake's own ffmpeg — the pinned sources (https, sha256), the sha256 check that
 * refuses an altered archive, the configure line (GPL with libx264, never nonfree, no folder of the build machine), the
 * engine's needs re-derived from its own ffmpeg arguments, and — with RETAKE_TEST_FFMPEG_DIR naming a built folder
 * (ffmpeg + ffprobe) — the binary itself: configuration, system-only linkage, every need, a short encode per family.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { VIDEO_CODECS } from '@retake/core';
import {
  ENGINE_NEEDS,
  FORBIDDEN_FLAGS,
  REQUIRED_FLAGS,
  SOURCE_NAMES,
  checkBinaries,
  checkConfiguration,
  checkLinkage,
  ffmpegConfigureArgs,
  foldersInsideRepo,
  libvpxConfigureArgs,
  libvpxMakeVars,
  loadSources,
  machinePaths,
  obtainArchive,
  opusConfigureArgs,
  sha256File,
  validateSources,
  verifyArchive,
  x264ConfigureArgs,
  // @ts-expect-error — a plain .mjs script without types
} from '../../../scripts/build-ffmpeg.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BUILT = process.env.RETAKE_TEST_FFMPEG_DIR?.trim();
const tmp = mkdtempSync(join(tmpdir(), 'retake-build-ffmpeg-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const source = (over: Record<string, unknown> = {}) => ({
  name: 'ffmpeg',
  version: '9.0.2',
  license: 'GPL-2.0-or-later',
  url: 'https://example.com/ffmpeg-9.0.2.tar.xz',
  file: 'ffmpeg-9.0.2.tar.xz',
  sha256: 'a'.repeat(64),
  ...over,
});
const doc = (first: Record<string, unknown> = {}) => ({
  min_macos: '15.0',
  sources: [source(first), ...['x264', 'libvpx', 'opus'].map((name) => source({ name, file: `${name}-1.0.tar.gz` }))],
});

describe('the pinned sources', () => {
  it('scripts/ffmpeg-sources.json: x264, libvpx, opus and ffmpeg, each https with a 64-hex sha256, a version, a licence and a plain archive name', async () => {
    const d = await loadSources();
    expect(validateSources(d)).toEqual([]);
    expect(d.sources.map((s: { name: string }) => s.name).sort()).toEqual([...SOURCE_NAMES].sort());
    for (const s of d.sources) {
      expect(new URL(s.url).protocol, s.name).toBe('https:');
      expect(s.sha256, s.name).toMatch(/^[0-9a-f]{64}$/);
      expect(s.version, s.name).toMatch(/\d/);
    }
    expect(d.sources.find((s: { name: string }) => s.name === 'ffmpeg').version).toBe('9.0.2');
    expect(d.min_macos).toBe('15.0');
  });

  it('a source that is not https, a short or upper-case sha256, no version, a path as file name or a missing library is refused', () => {
    expect(validateSources(doc())).toEqual([]);
    expect(validateSources(doc({ url: 'http://example.com/ffmpeg-9.0.2.tar.xz' }))).toEqual([expect.stringMatching(/not https/)]);
    expect(validateSources(doc({ sha256: 'abc123' }))).toEqual([expect.stringMatching(/sha256/)]);
    expect(validateSources(doc({ sha256: 'A'.repeat(64) }))).toEqual([expect.stringMatching(/sha256/)]);
    expect(validateSources(doc({ version: '' }))).toEqual([expect.stringMatching(/version/)]);
    expect(validateSources(doc({ file: '../ffmpeg.tar.xz' }))).toEqual([expect.stringMatching(/file/)]);
    expect(validateSources({ min_macos: '15.0', sources: doc().sources.slice(1) })).toEqual(['no source "ffmpeg"']);
    expect(validateSources({})).toEqual(['no "sources" array']);
  });

  it('the licence notice offers exactly the pinned archives (URL and sha256 of each)', async () => {
    const notice = readFileSync(join(ROOT, 'apps/desktop/licenses/ffmpeg/README.md'), 'utf8');
    for (const s of (await loadSources()).sources) {
      expect(notice, s.name).toContain(s.url);
      expect(notice, s.name).toContain(s.sha256);
    }
    expect(notice).toContain(`./configure ${ffmpegConfigureArgs({ minMacos: '15.0' }).join(' ')}`);
    for (const f of ['COPYING.GPLv2', 'COPYING.LGPLv2.1', 'ffmpeg-LICENSE.md', 'x264-COPYING', 'libvpx-LICENSE', 'libvpx-PATENTS', 'opus-COPYING']) {
      expect(readFileSync(join(ROOT, 'apps/desktop/licenses/ffmpeg', f), 'utf8').length, f).toBeGreaterThan(1000);
    }
  });
});

describe('the sha256 check', () => {
  it('passes the archive it pins and refuses one with a single byte changed (it is never built)', async () => {
    const file = join(tmp, 'lib-1.0.tar.gz');
    writeFileSync(file, Buffer.from('an archive of a library, version 1.0\n'));
    const pinned = await sha256File(file);
    await expect(verifyArchive(file, pinned)).resolves.toBe(pinned);
    const bytes = readFileSync(file);
    bytes[3] ^= 1;
    writeFileSync(file, bytes);
    await expect(verifyArchive(file, pinned)).rejects.toThrow(/does not match the pinned/);
    await expect(verifyArchive(file, 'not-a-sha')).rejects.toThrow(/no valid pinned sha256/);
  });

  it('a missing archive is never downloaded without --fetch, and a present one is checked before use', async () => {
    const s = source({ file: 'absent-1.0.tar.gz' });
    await expect(obtainArchive(s, tmp)).rejects.toThrow(/missing: run with --fetch/);
    const file = join(tmp, 'present-1.0.tar.gz');
    writeFileSync(file, 'present');
    await expect(obtainArchive(source({ file: 'present-1.0.tar.gz' }), tmp)).rejects.toThrow(/does not match the pinned/);
    await expect(obtainArchive(source({ file: 'present-1.0.tar.gz', sha256: await sha256File(file) }), tmp)).resolves.toBe(file);
  });
});

describe('the configure lines', () => {
  const ff = ffmpegConfigureArgs({ minMacos: '15.0' });

  it('ffmpeg: GPL with libx264, libvpx, libopus, VideoToolbox and AudioToolbox; nonfree off; static, arm64, macOS 15; no ffplay, docs or network', () => {
    for (const f of REQUIRED_FLAGS) expect(ff, f).toContain(f);
    for (const f of FORBIDDEN_FLAGS) expect(ff, f).not.toContain(f);
    expect(ff.filter((a: string) => /nonfree|fdk/.test(a))).toEqual(['--disable-nonfree']);
    for (const f of ['--enable-static', '--disable-shared', '--arch=arm64', '--target-os=darwin', '--disable-ffplay', '--disable-doc', '--enable-zlib', '--extra-cflags=-mmacosx-version-min=15.0', '--extra-ldflags=-mmacosx-version-min=15.0']) expect(ff, f).toContain(f);
    expect(checkConfiguration(ff.join(' '))).toEqual([]);
  });

  it('no folder of the build machine is compiled in: no path in ffmpeg\'s line, no prefix in libvpx\'s (it embeds its own line)', () => {
    expect(ff.filter((a: string) => a.includes('/'))).toEqual([]);
    const lv = libvpxConfigureArgs({ deps: '/scratch/deps', minMacos: '15.0' });
    expect(lv.join(' ')).not.toContain('/scratch');
    expect(libvpxMakeVars('/scratch/deps')).toEqual(['PREFIX=/scratch/deps', 'DIST_DIR=/scratch/deps']);
    expect(x264ConfigureArgs({ deps: '/d', minMacos: '15.0' })).toEqual(expect.arrayContaining(['--prefix=/d', '--enable-static', '--disable-cli', '--extra-cflags=-mmacosx-version-min=15.0']));
    expect(opusConfigureArgs({ deps: '/d', minMacos: '15.0' })).toEqual(expect.arrayContaining(['--prefix=/d', '--enable-static', '--disable-shared']));
    expect(machinePaths(Buffer.from('\0abc\0--prefix=/private/tmp/x/deps --target\0'))).toEqual(['/private/tmp/x/deps --target']);
    expect(machinePaths(Buffer.from('\0/usr/lib/libz.1.dylib\0/System/Library\0'))).toEqual([]);
  });

  it('a configuration without --enable-gpl / libx264, or with nonfree or libfdk-aac, is reported', () => {
    const line = ff.join(' ');
    expect(checkConfiguration(line.replace('--enable-gpl ', ''))).toEqual(['missing --enable-gpl']);
    expect(checkConfiguration(line.replace('--enable-libx264 ', ''))).toEqual(['missing --enable-libx264']);
    expect(checkConfiguration(`${line} --enable-nonfree --enable-libfdk-aac`)).toEqual(['forbidden --enable-nonfree', 'forbidden --enable-libfdk-aac']);
  });

  it('linkage: only /usr/lib and /System; a Homebrew or build-folder library is reported', () => {
    const ok = 'ffmpeg:\n\t/usr/lib/libz.1.dylib (compatibility version 1.0.0)\n\t/System/Library/Frameworks/VideoToolbox.framework/Versions/A/VideoToolbox (compatibility version 1.0.0)\n';
    expect(checkLinkage(ok)).toEqual([]);
    expect(checkLinkage(`${ok}\t/opt/homebrew/opt/x264/lib/libx264.165.dylib (compatibility version 0.0.0)\n\t@rpath/libvpx.dylib (x)\n`)).toEqual(['links /opt/homebrew/opt/x264/lib/libx264.165.dylib', 'links @rpath/libvpx.dylib']);
  });
});

/** The codecs, `-f` formats and filters the engine's sources name in their ffmpeg arguments. */
/** The muxer a file the engine writes needs, by its extension (ffmpeg picks it from the name when no `-f` is given). */
const EXTENSION_MUXERS: Record<string, string> = { m4a: 'ipod', mp4: 'mp4', m4v: 'mp4', mov: 'mov', webm: 'webm', mkv: 'matroska', gif: 'gif' };

function engineArguments(): { codecs: Map<string, string>; formats: Map<string, string>; filters: Map<string, string>; muxers: Map<string, string> } {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', 'packages/*/src/*.ts', 'packages/*/src/**/*.ts'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const codecs = new Map<string, string>();
  const formats = new Map<string, string>();
  const filters = new Map<string, string>();
  const muxers = new Map<string, string>();
  for (const f of files) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    if (!/ffmpeg|ffprobe/.test(text)) continue;
    for (const m of text.matchAll(/'-(?:c:v|c:a|vcodec|acodec)',\s*'([\w-]+)'/g)) if (m[1] !== 'copy') codecs.set(m[1], f);
    for (const m of text.matchAll(/'-f',\s*'([\w-]+)'/g)) formats.set(m[1], f);
    for (const m of text.matchAll(/\.(m4a|mp4|m4v|mov|webm|mkv|gif)[`'"]/g)) muxers.set(EXTENSION_MUXERS[m[1]], f);
    for (const line of text.split('\n')) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      if (!/'-vf'|'-filter_complex'|\b(?:vf|main|graph|filter|filters|scale)\s*=\s*[[`']|'lavfi'|filters\.push/.test(line)) continue;
      for (const lit of line.matchAll(/'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
        const s = lit[1] ?? lit[2];
        if (!/[=[]/.test(s)) continue; // a filter graph: name=options, [labels]
        for (const m of s.matchAll(/(?:^|[,;\]])([a-z][a-z0-9_]*)(?=[=[,]|$)/g)) filters.set(m[1], f);
      }
    }
  }
  return { codecs, formats, filters, muxers };
}

describe('the build never writes into the checkout (review A L7)', () => {
  it('--sources, --out and --work inside the repository are refused, links followed; outside folders pass', () => {
    const repo = join(tmp, 'repo');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    const link = join(tmp, 'looks-outside');
    symlinkSync(join(repo, 'scripts'), link);
    expect(foldersInsideRepo({ 'the source cache': join(tmp, 'cache'), '--out': join(tmp, 'out'), '--work': undefined }, repo)).toEqual([]);
    expect(foldersInsideRepo({ '--out': join(link, 'ffmpeg-out'), '--work': join(repo, 'build'), 'the source cache': join(tmp, 'cache') }, repo)).toEqual([`--out (${join(link, 'ffmpeg-out')})`, `--work (${join(repo, 'build')})`]);
  });
});

describe("the engine's needs", () => {
  it('every codec, -f format and filter the engine names in its ffmpeg arguments is in ENGINE_NEEDS (the list the built binary is checked against)', () => {
    const { codecs, formats, filters } = engineArguments();
    // The derivation itself still sees the engine's arguments (a regex gone blind would pass anything).
    expect([...codecs.keys()]).toEqual(expect.arrayContaining(['libx264', 'h264_videotoolbox', 'prores_ks', 'prores_aw', 'libvpx-vp9', 'libopus', 'aac', 'png']));
    expect([...formats.keys()]).toEqual(expect.arrayContaining(['lavfi', 'image2pipe', 'rawvideo', 'concat', 'mp4', 'null']));
    expect([...filters.keys()]).toEqual(expect.arrayContaining(['scale', 'format', 'select', 'split', 'palettegen', 'paletteuse', 'fps', 'anullsrc', 'color']));
    const codecNeeds = new Set([...ENGINE_NEEDS.encoders, ...ENGINE_NEEDS.decoders]);
    const formatNeeds = new Set([...ENGINE_NEEDS.muxers, ...ENGINE_NEEDS.demuxers]);
    expect([...codecs].filter(([c]) => !codecNeeds.has(c))).toEqual([]);
    expect([...formats].filter(([c]) => !formatNeeds.has(c))).toEqual([]);
    // The VideoToolbox probe (L5.15) runs Remotion's compositor ffmpeg through callFf, never ours: its `nullsrc` is that
    // binary's need. The exemption is held to that one file and that one filter, and the file must still go through callFf.
    const compositorOnly: Record<string, string[]> = { 'packages/editor/src/render/policy.ts': ['nullsrc'] };
    for (const file of Object.keys(compositorOnly)) expect(readFileSync(join(ROOT, file), 'utf8')).toMatch(/callFf/);
    expect([...filters].filter(([c, f]) => !ENGINE_NEEDS.filters.includes(c) && !compositorOnly[f]?.includes(c))).toEqual([]);
  });

  it("L7.3: what a render's frame encode asks of our ffmpeg — its colour filter, and what its probe makes and reads three frames with — is in ENGINE_NEEDS", () => {
    const tools = readFileSync(join(ROOT, 'packages/editor/src/render/encode-tools.ts'), 'utf8');
    const name = /export const OWN_FRAME_FILTER_NAME = '([a-z0-9_]+)';/.exec(tools)?.[1];
    expect(name).toBe('colorspace');
    expect(tools).toMatch(new RegExp(`export const OWN_FRAME_FILTER = '${name}=`));
    expect(ENGINE_NEEDS.filters).toContain(name);
    // The probe (probeFrameEncode): three `color` frames written as JPEG to the image pipe, then the frame encode on
    // them, written nowhere.
    expect(/`(color)=c=gray:s=/.exec(tools)?.[1]).toBe('color');
    expect(tools).toMatch(/'-c:v', 'mjpeg', .*'-f', 'image2pipe', '-'\]/);
    expect(tools).toMatch(/'-f', 'image2pipe', .*'-vcodec', 'mjpeg', '-i', '-'/);
    expect(tools).toMatch(/'-f', 'null', '-'/);
    expect(ENGINE_NEEDS.filters).toContain('color');
    expect(ENGINE_NEEDS.encoders).toEqual(expect.arrayContaining(['mjpeg', 'libx264', 'h264_videotoolbox', 'wrapped_avframe']));
    expect(ENGINE_NEEDS.decoders).toContain('mjpeg');
    expect(ENGINE_NEEDS.muxers).toEqual(expect.arrayContaining(['image2pipe', 'null']));
    expect(ENGINE_NEEDS.demuxers).toEqual(expect.arrayContaining(['image2pipe', 'lavfi']));
    // The library's own probe (`nullsrc`) stays the library's ffmpeg's: ours is never asked for that source.
    expect(ENGINE_NEEDS.filters).not.toContain('nullsrc');
    expect(readFileSync(join(ROOT, 'packages/editor/src/render/policy.ts'), 'utf8')).toMatch(/probeFrameEncode\(path, s, frameEncodeCodecArgs\(encoder, s\)\)/);
  });

  it('the muxers of the files it writes (by extension: .m4a needs ipod) and the decoders of the videos a person may bring (core VIDEO_CODECS)', () => {
    const { muxers } = engineArguments();
    expect([...muxers.keys()]).toEqual(expect.arrayContaining(['ipod', 'mp4', 'webm']));
    expect([...muxers].filter(([m]) => !ENGINE_NEEDS.muxers.includes(m))).toEqual([]);
    expect(Object.keys(VIDEO_CODECS).filter((c) => !ENGINE_NEEDS.decoders.includes(c))).toEqual([]);
  });
});

describe.skipIf(!BUILT)('the built ffmpeg (RETAKE_TEST_FFMPEG_DIR)', () => {
  const dir = BUILT ?? '';
  const ffmpeg = join(dir, 'ffmpeg');
  const run = (args: string[]) => spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
  const src = ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=1', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=1'];

  it('GPL configuration without nonfree, only system libraries, no rpath, no build-machine folder, every engine need', () => {
    const version = execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' });
    expect(version).toMatch(/^ffmpeg version 9\.0\.2 /);
    const conf = /^configuration: (.*)$/m.exec(version)?.[1] ?? '';
    expect(checkConfiguration(conf)).toEqual([]);
    expect(conf).not.toMatch(/--enable-nonfree|fdk/);
    expect(checkBinaries(dir)).toEqual([]);
  });

  it('encodes each family the engine writes: H.264 mp4 (libx264, VideoToolbox), ProRes 422 HQ / 4444 mov, VP9 + Opus webm, GIF', () => {
    const out = (n: string) => join(tmp, n);
    for (const [name, args] of [
      ['x264.mp4', [...src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart']],
      ['vt.mp4', [...src, '-c:v', 'h264_videotoolbox', '-q:v', '85', '-profile:v', 'high', '-an']],
      ['hq.mov', [...src, '-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le', '-an']],
      ['alpha.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1,format=rgba', '-vf', 'format=yuva444p10le', '-c:v', 'prores_aw', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-an']],
      ['web.webm', [...src, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k']],
      ['preview.gif', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=12:d=1', '-filter_complex', 'split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', '-loop', '0']],
    ] as const) {
      const r = run([...args, out(name)]);
      expect(r.status, `${name}: ${r.stderr}`).toBe(0);
    }
    const probe = (f: string) => execFileSync(join(dir, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_name,profile', '-of', 'csv=p=0', out(f)], { encoding: 'utf8' }).trim().split('\n');
    expect(probe('x264.mp4')).toEqual(['h264,High', 'aac,LC']);
    expect(probe('hq.mov')).toEqual(['prores,HQ']);
    expect(probe('alpha.mov')).toEqual(['prores,4444']);
    expect(probe('web.webm')).toEqual(['vp9,Profile 0', 'opus,unknown']);
  });
});
