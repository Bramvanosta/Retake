/** ffprobe of media files (optional: a render record says what its file holds when ffprobe is on PATH). */
import { execFile } from 'node:child_process';

export interface Probe {
  duration_s: number;
  frames?: number;
  width: number;
  height: number;
  fps: number;
  audio_streams: number;
  video_codec?: string;
  audio_codec?: string;
}

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
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', file]);
  if (r.code !== 0) return undefined;
  try {
    const j = JSON.parse(r.stdout) as { streams: Array<Record<string, string | number>>; format: { duration?: string } };
    const v = j.streams.find((s) => s.codec_type === 'video');
    const a = j.streams.filter((s) => s.codec_type === 'audio');
    const [num, den] = String(v?.r_frame_rate ?? '0/1').split('/').map(Number);
    const out: Probe = {
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
