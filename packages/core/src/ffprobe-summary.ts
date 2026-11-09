/**
 * The summary ffprobe gives of a media file — its first video stream's size, frame rate and frame count, its audio
 * streams, the codecs and the file's length — as the render's record and the review read it. Pure: the arguments and
 * the parsing; each caller runs ffprobe itself.
 */

/** What ffprobe says of a media file (`ffprobeSummaryArgs`). */
export interface FfprobeSummary {
  duration_s: number;
  frames?: number;
  width: number;
  height: number;
  /** The video stream's `r_frame_rate`, to 3 decimals (0 when it has none). */
  fps: number;
  audio_streams: number;
  video_codec?: string;
  audio_codec?: string;
}

/** ffprobe's arguments for the summary of `file`, as JSON on stdout. */
export function ffprobeSummaryArgs(file: string): string[] {
  return ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', file];
}

/** The summary in ffprobe's answer to `ffprobeSummaryArgs`; undefined when it is not JSON of that shape. */
export function parseFfprobeSummary(stdout: string): FfprobeSummary | undefined {
  try {
    const j = JSON.parse(stdout) as { streams: Array<Record<string, string | number>>; format: { duration?: string } };
    const v = j.streams.find((s) => s.codec_type === 'video');
    const a = j.streams.filter((s) => s.codec_type === 'audio');
    const [num, den] = String(v?.r_frame_rate ?? '0/1').split('/').map(Number);
    const out: FfprobeSummary = {
      duration_s: Number(j.format.duration ?? 0),
      width: Number(v?.width ?? 0),
      height: Number(v?.height ?? 0),
      fps: den ? Math.round((num / den) * 1000) / 1000 : 0,
      audio_streams: a.length,
    };
    if (v?.nb_frames !== undefined) out.frames = Number(v.nb_frames);
    if (v?.codec_name) out.video_codec = String(v.codec_name);
    if (a[0]?.codec_name) out.audio_codec = String(a[0].codec_name);
    return out;
  } catch {
    return undefined;
  }
}
