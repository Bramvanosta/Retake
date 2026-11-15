/** The stages of a raw export (exportCapture): the clips, the cursor data and layers, the selects and the markers. */
import { fileBase, round3 } from './settings.js';
import type { ExportCaptureOptions, RawExportProgress, RawManifest, rawSettings } from './settings.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RawFormat } from '@retake/core/project';
import type { Timeline } from '@retake/core/run';
import type { H264Encoder } from '@retake/core/io';
import type { kitConfigFor } from '../kit/source.js';
import { clicksCsv, clipClicks, cursorCsv, cursorFrames, cursorJson, cursorTrackOf, type ClipCursorData } from './cursor.js';
import {
  type RAW_ENCODING,
  clipFrameFiles,
  concatClips,
  decodeVideoFrames,
  encodeClip,
  exportSchedule,
  probeVideo,
  rawCodecLabel,
  readFrameSource,
  type FrameSource,
  type ProbedVideo,
} from './encode.js';
import { encodeCursorLayer, renderCursorAtlas, type CursorAtlas } from './layer.js';
import { markersCsv, markersJson, rawMarkers, timecode, writeEdl, writeFcpxml, writeOtio, type PackageFiles } from './markers.js';
import { clipFrameAt, sequenceStartOf, type RawClipPlan, type RawPlan } from './plan.js';

/** One export in progress: what every stage reads, and what the clips stage learns (`fromVideo`, `h264`). */
export interface RawJob {
  opts: ExportCaptureOptions;
  runDir: string;
  timeline: Timeline;
  s: ReturnType<typeof rawSettings>;
  plan: RawPlan;
  emit: (p: RawExportProgress) => void;
  ffmpeg: string;
  notes: string[];
  warnings: string[];
  /** The screencast frames of every source, read before the plan (null: the run did not keep them). */
  frameSources: Map<string, FrameSource | null>;
  /** The package folder, and the folder it is written in before the swap (with its scratch `.tmp`). */
  dir: string;
  work: string;
  tmp: string;
  enc: (typeof RAW_ENCODING)[RawFormat];
  clipRel: (c: RawClipPlan) => string;
  layerRel: (c: RawClipPlan) => string;
  /** A clip was made from the run's CFR video (no screencast frames). */
  fromVideo: boolean;
  /** The H.264 encoder the MP4 clips were really made with (one ffmpeg: the same for every clip) names their codec. */
  h264: H264Encoder | undefined;
}

/** The notes the settings and the run's pictures call for. */
export function settingsNotes(s: ReturnType<typeof rawSettings>, notes: string[]): void {
  if (!s.hidden && s.cursor === 'layer')
    notes.push('the clips show the cursor as captured (this run was captured with it): the layer duplicates it — capture with `run --raw --cursor layer` for clean clips under the layer');
  if (s.hidden) notes.push('captured without the in-page cursor: the clips show no cursor; its track, icon, presses and ripples are in cursor/ (and the layers with --cursor layer)');
  if (s.cursor === 'layer' && s.layer === 'webm') {
    notes.push(
      'cursor layers in VP9 WebM: no timecode (media time from 0), alpha kept in a VP9 side channel (ffmpeg needs -c:v libvpx-vp9 to decode it), not read by Final Cut Pro or Premiere Pro — left out of the FCPXML, in the OTIO; use --layer prores for those tools',
    );
  }
}

/** A clip's frame source and its export schedule, read once per source (the run's CFR video when it kept no frames). */
async function clipSource(job: RawJob, sources: Map<string, { source: FrameSource; schedule: string[] }>, c: RawClipPlan): Promise<{ source: FrameSource; schedule: string[] }> {
  const { timeline, s } = job;
  let entry = sources.get(c.source.track);
  if (!entry) {
    let source = job.frameSources.get(c.source.track) ?? (await readFrameSource(job.runDir, c.source));
    if (!source) {
      source = await decodeVideoFrames(job.runDir, c.source, { fps: timeline.capture.fps, tmp: job.tmp, ffmpeg: job.ffmpeg, signal: job.opts.signal });
      job.fromVideo = true;
      job.notes.push(
        `${c.source.track === 'main' ? 'the capture' : `page ${c.source.track}`}: the run did not keep its screencast frames (capture.keep_frames) — clips made from ${c.source.video}${s.fps > timeline.capture.fps ? ` at ${timeline.capture.fps} fps, each frame repeated for ${s.fps} fps (not interpolated)` : ''}`,
      );
    }
    entry = { source, schedule: exportSchedule(source, timeline.capture.duration, s.fps) };
    sources.set(c.source.track, entry);
  }
  return entry;
}

/** The clips, one per planned clip, each probed (a frame count off the plan is warned). */
export async function encodeClips(job: RawJob): Promise<Map<number, ProbedVideo>> {
  const { opts, plan, s, work, clipRel } = job;
  const sources = new Map<string, { source: FrameSource; schedule: string[] }>();
  const probes = new Map<number, ProbedVideo>();
  for (const c of plan.clips) {
    opts.signal?.throwIfAborted();
    job.emit({ stage: 'clip', done: c.index, total: plan.clips.length, message: clipRel(c) });
    const { source, schedule } = await clipSource(job, sources, c);
    const out = join(work, clipRel(c));
    job.h264 =
      (await encodeClip({
        source,
        files: clipFrameFiles(c, schedule),
        fps: s.fps,
        width: c.source.width,
        height: c.source.height,
        format: s.format,
        timecode: timecode(sequenceStartOf(plan, c), s.fps),
        out,
        tmp: job.tmp,
        ffmpeg: job.ffmpeg,
        policy: opts.policy,
        signal: opts.signal,
      })) ?? job.h264;
    const p = await probeVideo(out, { ffprobe: opts.ffprobe, policy: opts.policy });
    if (p.frames !== c.frames) job.warnings.push(`${clipRel(c)}: ${p.frames} frames written, ${c.frames} planned`);
    probes.set(c.index, p);
  }
  job.emit({ stage: 'clip', done: plan.clips.length, total: plan.clips.length });
  return probes;
}

/** The cursor data of every clip (every mode), written to cursor/. */
export async function writeCursorData(job: RawJob): Promise<{ data: ClipCursorData[]; approximated: boolean }> {
  const { plan, s, timeline, work, clipRel } = job;
  const data: ClipCursorData[] = plan.clips.map((c) => {
    const { frames, approximated } = cursorFrames(c, s.fps, cursorTrackOf(timeline, c));
    return { clip: c, file: clipRel(c), frames, clicks: clipClicks(c, (t) => clipFrameAt(c, t, s.fps)), approximated };
  });
  const approximated = data.some((d) => d.approximated);
  if (approximated) job.notes.push('this run did not record the cursor icon (an older capture format): the icon (arrow / hand / text beam), presses and ripples are approximated from the steps');
  await writeFile(join(work, 'cursor', 'cursor.json'), cursorJson(plan, data, { run: timeline.run_id, mode: s.cursor }));
  await writeFile(join(work, 'cursor', 'cursor.csv'), cursorCsv(plan, data));
  await writeFile(join(work, 'cursor', 'clicks.csv'), clicksCsv(plan, data));
  return { data, approximated };
}

/** With `--cursor layer`: a transparent cursor layer per clip, each probed (frames and alpha checked). */
export async function encodeLayers(job: RawJob, kit: ReturnType<typeof kitConfigFor>, data: ClipCursorData[]): Promise<Map<number, ProbedVideo>> {
  const { opts, plan, s, work, layerRel } = job;
  const layerProbes = new Map<number, ProbedVideo>();
  if (s.cursor !== 'layer') return layerProbes;
  const atlases = new Map<number, CursorAtlas>();
  for (const c of plan.clips) {
    opts.signal?.throwIfAborted();
    job.emit({ stage: 'layer', done: c.index, total: plan.clips.length, message: layerRel(c) });
    let atlas = atlases.get(c.source.scale);
    if (!atlas) {
      atlas = await renderCursorAtlas({ kit, scale: c.source.scale, browser: opts.browser ?? opts.project.config.browser, ffmpeg: job.ffmpeg, policy: opts.policy });
      atlases.set(c.source.scale, atlas);
    }
    const out = join(work, layerRel(c));
    await encodeCursorLayer({
      atlas,
      frames: data[c.index].frames,
      width: c.source.width,
      height: c.source.height,
      pxScale: c.source.scale,
      fps: s.fps,
      format: s.layer,
      out,
      timecode: timecode(sequenceStartOf(plan, c), s.fps),
      ffmpeg: job.ffmpeg,
      policy: opts.policy,
      signal: opts.signal,
    });
    // WebM keeps no frame count in its header: the layer's frames are counted.
    const p = await probeVideo(out, { ffprobe: opts.ffprobe, count: s.layer === 'webm', policy: opts.policy });
    if (p.frames !== c.frames) job.warnings.push(`${layerRel(c)}: ${p.frames} frames written, ${c.frames} planned`);
    if (!p.alpha) job.warnings.push(`${layerRel(c)}: ffprobe sees no alpha channel`);
    layerProbes.set(c.index, p);
  }
  job.emit({ stage: 'layer', done: plan.clips.length, total: plan.clips.length });
  return layerProbes;
}

/** With `--selects`: the sequence clips joined into one file (refused, warned, when their sizes differ). */
export async function writeSelects(job: RawJob): Promise<RawManifest['selects']> {
  const { opts, plan, s, work, clipRel } = job;
  if (!s.selects) return undefined;
  const primaries = plan.sequence.map((q) => plan.clips[q.clip]);
  const sizes = new Set(primaries.map((c) => `${c.source.width}x${c.source.height}`));
  if (sizes.size > 1) {
    job.warnings.push(`no selects file: the sequence clips have different sizes (${[...sizes].join(', ')})`);
    return undefined;
  }
  job.emit({ stage: 'selects', done: 0, total: 1 });
  const rel = `selects${job.enc.ext}`;
  await concatClips(
    primaries.map((c) => join(work, clipRel(c))),
    join(work, rel),
    job.tmp,
    job.ffmpeg,
    opts.signal,
  );
  const p = await probeVideo(join(work, rel), { ffprobe: opts.ffprobe, policy: opts.policy });
  if (p.frames !== plan.frames) job.warnings.push(`${rel}: ${p.frames} frames, the sequence has ${plan.frames}`);
  return { file: rel, frames: p.frames, duration_s: round3(p.frames / s.fps), codec: rawCodecLabel(s.format, job.h264), size_bytes: p.size_bytes };
}

/** The markers in every format, written to markers/; their files as the manifest names them. */
export async function writeMarkers(job: RawJob): Promise<{ markers: ReturnType<typeof rawMarkers>; mk: { fcpxml: string; edl: string; otio: string; json: string; csv: string } }> {
  const { opts, plan, s, timeline, dir, work, clipRel, layerRel } = job;
  const markers = rawMarkers(plan);
  const files: PackageFiles = {
    clips: plan.clips.map((c) => join(dir, clipRel(c))),
    ...(s.cursor === 'layer' ? { layers: plan.clips.map((c) => join(dir, layerRel(c))), layersTimecoded: s.layer !== 'webm' } : {}),
  };
  const base = fileBase(timeline.scenario);
  const meta = { title: `${timeline.scenario} raw (${timeline.run_id})`, event: `${opts.project.config.name} raw`, uid: timeline.run_id };
  const mk = {
    fcpxml: `markers/${base}.fcpxml`,
    edl: `markers/${base}.edl`,
    otio: `markers/${base}.otio`,
    json: 'markers/markers.json',
    csv: 'markers/markers.csv',
  };
  await writeFile(join(work, mk.fcpxml), writeFcpxml(plan, markers, files, meta));
  await writeFile(join(work, mk.edl), writeEdl(plan, markers, files, meta));
  await writeFile(join(work, mk.otio), writeOtio(plan, markers, files, meta));
  await writeFile(join(work, mk.json), markersJson(plan, markers, clipRel));
  await writeFile(join(work, mk.csv), markersCsv(plan, markers, clipRel));
  return { markers, mk };
}
