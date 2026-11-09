/** ffprobe of media files (optional: a render record says what its file holds when ffprobe is on PATH). */
import { execFile } from 'node:child_process';
import { ffprobeBin, ffprobeSummaryArgs, parseFfprobeSummary } from '@retake/core';
import type { FfprobeSummary } from '@retake/core';

/** What ffprobe says of a media file (core's summary: size, frame rate, frames, audio streams, codecs, length). */
export type Probe = FfprobeSummary;

/** Run a command; never throws (code 127 when it cannot start). */
export function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((ok) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 127) : 0;
      ok({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** ffprobe of a media file; undefined when ffprobe is not available. */
export async function probeMedia(file: string): Promise<Probe | undefined> {
  const r = await run(ffprobeBin(), ffprobeSummaryArgs(file));
  if (r.code !== 0) return undefined;
  return parseFfprobeSummary(r.stdout);
}
