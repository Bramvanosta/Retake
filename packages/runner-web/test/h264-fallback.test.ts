/**
 * L5.16a — the H.264 sites with an ffmpeg that has no libx264 (a foreign build, the system's when the app carries none):
 * the capture encoder (resolveEncoder: run.ts takes its answer as is), the raw export's MP4 clips (encodeClip, and the
 * package's codec label), the 1080p export (transcodeMp4) and the frames encode (encodeFrames: the synthetic-run test
 * harness, no production caller) never ask for libx264 then. Fake ffmpeg scripts print an encoder list and record their
 * arguments; each site is driven itself, not only its argument builder (review B M1).
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mp4TranscodeArgs, transcodeMp4 } from '@retake/editor';
import { encodeFrames, resolveEncoder } from '../src/index.js';
import { RAW_ENCODING, clipArgs, encodeClip, rawCodecLabel } from '../src/raw/encode.js';
import { PERSON_POLICY } from '@retake/core';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-h264-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const LIST = (x264: boolean) =>
  `Encoders:\n ------\n${x264 ? ' V....D libx264              libx264 H.264\n' : ''} V....D h264_videotoolbox    VideoToolbox H.264 Encoder\n A....D aac                  AAC\n`;

let n = 0;
/** A fake ffmpeg: `-encoders` prints the list; any other call records its arguments and exits `code`. */
function fakeFfmpeg(o: { x264: boolean; vtWorks: boolean }): { bin: string; log: string } {
  const dir = join(tmp, `ff${n++}`);
  mkdirSync(dir);
  const log = join(dir, 'args.log');
  const bin = join(dir, 'ffmpeg');
  writeFileSync(
    bin,
    `#!/bin/sh
case "$*" in
  *-encoders*) cat <<'EOF'
${LIST(o.x264)}EOF
  exit 0;;
  *"-c:v h264_videotoolbox -f null"*) exit ${o.vtWorks ? 0 : 1};;
esac
echo "$*" >> '${log}'
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

describe('capture encoder (resolveEncoder)', () => {
  it.runIf(process.platform === 'darwin')('libx264 asked, absent → VideoToolbox; neither → a clear error naming the ffmpeg', async () => {
    expect(await resolveEncoder('libx264', fakeFfmpeg({ x264: true, vtWorks: true }).bin, PERSON_POLICY)).toBe('libx264');
    expect(await resolveEncoder('libx264', fakeFfmpeg({ x264: false, vtWorks: true }).bin, PERSON_POLICY)).toBe('videotoolbox');
    expect(await resolveEncoder('auto', fakeFfmpeg({ x264: true, vtWorks: false }).bin, PERSON_POLICY)).toBe('libx264');
    const none = fakeFfmpeg({ x264: false, vtWorks: false }).bin;
    await expect(resolveEncoder('auto', none, PERSON_POLICY)).rejects.toThrow(new RegExp(`${none.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} has no libx264`));
  });
});

describe('the frames encode, the raw clips and the 1080p export', () => {
  it('encodeFrames: libx264 when present, else h264_videotoolbox', async () => {
    const frames = join(tmp, 'frames');
    mkdirSync(frames);
    writeFileSync(join(frames, 'a.jpg'), 'x');
    for (const x264 of [true, false]) {
      const ff = fakeFfmpeg({ x264, vtWorks: true });
      await encodeFrames(frames, [{ file: 'a.jpg', t: 0 }], join(tmp, 'out.mp4'), { policy: PERSON_POLICY, fps: 30, endT: 0.1, crf: 18, ffmpeg: ff.bin });
      const args = readFileSync(ff.log, 'utf8');
      expect(args).toContain(x264 ? '-c:v libx264' : '-c:v h264_videotoolbox -q:v 85 -profile:v high');
      if (!x264) expect(args).not.toContain('libx264');
      expect(args).toContain('-color_primaries bt709');
    }
  });

  it('raw MP4 clips keep -g, yuv420p and faststart with VideoToolbox; ProRes is untouched', () => {
    const base = { seq: '/s', ext: 'jpg', jpeg: true, fps: 30, frames: 10, width: 1280, height: 720, timecode: '00:00:00:00', out: '/o.mp4' };
    const vt = clipArgs({ ...base, format: 'mp4', h264: 'h264_videotoolbox' }).join(' ');
    expect(vt).toContain('-c:v h264_videotoolbox -q:v 85 -profile:v high -g 30 -pix_fmt yuv420p -movflags +faststart');
    expect(vt).not.toContain('libx264');
    expect(clipArgs({ ...base, format: 'mp4' }).join(' ')).toContain('-c:v libx264 -profile:v high');
    expect(clipArgs({ ...base, format: 'prores', h264: 'h264_videotoolbox' }).join(' ')).toContain('-c:v prores_ks');
  });

  it('encodeClip (each raw MP4 clip) asks the ffmpeg and returns the encoder it used; ProRes is untouched', async () => {
    const frames = join(tmp, 'clip-frames');
    mkdirSync(frames);
    for (const f of ['a.jpg', 'b.jpg']) writeFileSync(join(frames, f), 'x');
    const source = { dir: frames, frames: [{ file: 'a.jpg', t: 0 }, { file: 'b.jpg', t: 0.1 }], ext: 'jpg', jpeg: true, fromVideo: false };
    for (const x264 of [true, false]) {
      const ff = fakeFfmpeg({ x264, vtWorks: true });
      const work = join(tmp, `clip-work-${n}`);
      mkdirSync(work);
      const used = await encodeClip({ policy: PERSON_POLICY, source, files: ['a.jpg', 'b.jpg'], fps: 30, width: 1280, height: 720, format: 'mp4', timecode: '00:00:00:00', out: join(work, 'c.mp4'), tmp: work, ffmpeg: ff.bin });
      expect(used).toBe(x264 ? 'libx264' : 'h264_videotoolbox');
      const args = readFileSync(ff.log, 'utf8');
      expect(args).toContain(x264 ? '-c:v libx264 -profile:v high' : '-c:v h264_videotoolbox -q:v 85 -profile:v high -g 30');
      if (!x264) expect(args).not.toContain('libx264');
    }
    const ff = fakeFfmpeg({ x264: false, vtWorks: true });
    const work = join(tmp, 'clip-prores');
    mkdirSync(work);
    expect(await encodeClip({ policy: PERSON_POLICY, source, files: ['a.jpg'], fps: 30, width: 1280, height: 720, format: 'prores', timecode: '00:00:00:00', out: join(work, 'c.mov'), tmp: work, ffmpeg: ff.bin })).toBeUndefined();
    expect(readFileSync(ff.log, 'utf8')).toContain('-c:v prores_ks');
  });

  it("the raw package's codec label names the encoder really used (never CRF 14 for VideoToolbox files)", () => {
    expect(rawCodecLabel('mp4', 'libx264')).toBe(RAW_ENCODING.mp4.label);
    expect(rawCodecLabel('mp4')).toBe(RAW_ENCODING.mp4.label);
    expect(rawCodecLabel('mp4', 'h264_videotoolbox')).toBe('H.264 high profile (VideoToolbox q:v 85), yuv420p, faststart');
    expect(rawCodecLabel('mp4', 'h264_videotoolbox')).not.toMatch(/CRF/);
    expect(rawCodecLabel('prores', 'h264_videotoolbox')).toBe(RAW_ENCODING.prores.label);
  });

  it('transcodeMp4 (the 1080p export of a master at another size) asks the ffmpeg too', async () => {
    for (const x264 of [true, false]) {
      const ff = fakeFfmpeg({ x264, vtWorks: true });
      expect(await transcodeMp4(ff.bin, join(tmp, 'in.mp4'), [1920, 1080], join(tmp, 'o.mp4'))).toBe(x264 ? 'libx264' : 'h264_videotoolbox');
      const args = readFileSync(ff.log, 'utf8');
      expect(args).toContain(x264 ? '-c:v libx264 -crf 18' : '-c:v h264_videotoolbox -q:v 85 -profile:v high -pix_fmt yuv420p');
      if (!x264) expect(args).not.toContain('libx264');
    }
  });

  it('the 1080p export transcode', () => {
    expect(mp4TranscodeArgs('in.mp4', [1920, 1080], 'libx264', 'o.mp4').join(' ')).toContain('-c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p');
    const vt = mp4TranscodeArgs('in.mp4', [1920, 1080], 'h264_videotoolbox', 'o.mp4').join(' ');
    expect(vt).toContain('-c:v h264_videotoolbox -q:v 85 -profile:v high -pix_fmt yuv420p -color_range tv');
    expect(vt).not.toContain('libx264');
  });
});
