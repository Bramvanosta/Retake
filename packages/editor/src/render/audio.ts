/**
 * A small royalty-free music track made procedurally with ffmpeg (sine chords: C – Am – F – G, two seconds each, a
 * soft pulse, no clicks at the chord changes) — for tests and demos of the music bed (R-ED-17) without committing
 * audio files. Not a product feature: real projects bring their own music.
 */
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ffmpegBin, runMediaTool, stderrLines } from '@retake/core/io';
import type { WorkPolicy } from '@retake/core/policy';

/** Hz of the four chords (root, third, fifth, bass an octave below the root). */
const CHORDS = [
  [261.63, 329.63, 392.0, 130.81],
  [220.0, 261.63, 329.63, 110.0],
  [174.61, 220.0, 261.63, 87.31],
  [196.0, 246.94, 293.66, 98.0],
] as const;

/** ffmpeg aevalsrc expression of the chord loop (8 s period). */
export function testTrackExpression(): string {
  const pick = (voice: number) => {
    const [a, b, c, d] = CHORDS.map((ch) => ch[voice]);
    return `if(lt(mod(t,8),2),${a},if(lt(mod(t,8),4),${b},if(lt(mod(t,8),6),${c},${d})))`;
  };
  const voices = [0, 1, 2].map((v) => `sin(2*PI*${pick(v)}*t)`).join('+');
  const bass = `0.6*sin(2*PI*${pick(3)}*t)`;
  // A pulse per chord, and 20 ms ramps at the chord edges (phase jumps would click).
  const envelope = '(0.55+0.45*sin(PI*mod(t,2)/2))*min(1,mod(t,2)/0.02)*min(1,(2-mod(t,2))/0.02)';
  return `0.08*(${voices}+${bass})*${envelope}`;
}

/**
 * Write a `seconds`-long stereo test track (AAC in .m4a, 48 kHz, ≈ 12 KB/s) to `out`. Needs ffmpeg on PATH (or
 * `ffmpeg`). Returns `out`.
 */
export async function generateTestTrack(out: string, opts: { seconds?: number; ffmpeg?: string; workPolicy: WorkPolicy }): Promise<string> {
  const seconds = opts.seconds ?? 16;
  if (!(seconds > 0 && seconds <= 600)) throw new Error(`test track length ${seconds} s: use 0–600 s`);
  await mkdir(dirname(out), { recursive: true });
  const e = testTrackExpression();
  const tmp = `${out}.tmp-${process.pid}.m4a`;
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=exprs='${e}|${e}':s=48000:d=${seconds}`, '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', tmp];
  await runMediaTool(ffmpegBin(opts.workPolicy, opts.ffmpeg), args)
    .then((r) => {
      if (r.error) throw new Error(`ffmpeg could not make the test track: ${stderrLines(r.stderr, 1, 'first') || r.error.message}`);
    })
    .catch(async (e: unknown) => {
      await rm(tmp, { force: true });
      throw e;
    });
  await rename(tmp, out);
  return out;
}
