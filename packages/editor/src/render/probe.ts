/** ffprobe of media files (optional: a render record says what its file holds when ffprobe is on PATH). */
import { ffprobeSummaryArgs, parseFfprobeSummary } from '@retake/core';
import { ffprobeBin, runMediaTool } from '@retake/core/io';
import type { FfprobeSummary, WorkPolicy } from '@retake/core';

/** What ffprobe says of a media file (core's summary: size, frame rate, frames, audio streams, codecs, length). */
export type Probe = FfprobeSummary;

/** ffprobe of a media file; undefined when ffprobe is not available. */
export async function probeMedia(file: string, work: WorkPolicy): Promise<Probe | undefined> {
  const r = await runMediaTool(ffprobeBin(work), ffprobeSummaryArgs(file), { maxBuffer: 16 * 1024 * 1024 });
  if (r.code !== 0) return undefined;
  return parseFfprobeSummary(r.stdout);
}
