/**
 * `exportCapture` (L2.13, R-RAW-01…04): the raw package of a run for editing in another tool — one clean clip per
 * scene (per page of a multi-page scene) with the page loads and the loading cut, MP4 (H.264 high, CRF 14) or ProRes
 * 422 HQ at 30 or 60 fps; the cursor baked, absent (data only) or as a transparent layer per clip; cursor and click
 * data (JSON, CSV); markers (FCPXML 1.10, CMX 3600 EDL, OpenTimelineIO, CSV, JSON); an optional selects file; a
 * manifest.json and a README.md. Written under a temporary name and swapped in when complete.
 *
 *   <project>/exports/<run-id>-raw-<format><fps>-<cursor>/
 *     README.md  manifest.json
 *     clips/01-<scene>.mp4 …           (multi-page: 01-<scene>-<page>.mp4)
 *     cursor/cursor.json cursor.csv clicks.csv  (+ 01-<scene>-cursor.mov per clip with --cursor layer)
 *     markers/<scenario>.fcpxml .edl .otio  markers.json markers.csv
 *     selects.mp4                       (with --selects)
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RAW_CURSOR_MODES, RAW_FORMATS, RAW_LAYER_FORMATS, displayRows, editDisplayTable, newerRunMessage, resolveEnvironment, shownText } from '@demo-studio/core';
import type { BrowserConfig, DisplayEntry, LoadedProject, LoadedTemplate, RawCursorMode, RawFormat, RawFps, RawLayerFormat, RunRecord, Timeline } from '@demo-studio/core';
import { kitConfigFor } from '../kit/source.js';
import { clicksCsv, clipClicks, cursorCsv, cursorFrames, cursorJson, cursorTrackOf, type ClipCursorData } from './cursor.js';
import { LAYER_ENCODING, RAW_ENCODING, clipFrameFiles, concatClips, decodeVideoFrames, encodeClip, exportSchedule, probeVideo, readFrameSource, type FrameSource, type ProbedVideo } from './encode.js';
import { encodeCursorLayer, renderCursorAtlas, type CursorAtlas } from './layer.js';
import { MARKER_COLORS, markersCsv, markersJson, rawMarkers, timecode, writeEdl, writeFcpxml, writeOtio, type PackageFiles, type RawMarkerKind } from './markers.js';
import { clipFrameAt, mainSource, planRawExport, sequenceStartOf, trackSource, type RawClipPlan, type RawPlan } from './plan.js';


/** The display table of a run as an edit uses it (core editDisplayTable): project.yaml's current pages, then the run's. */
export function exportDisplayTable(project: Pick<LoadedProject, 'config'>, timeline: Timeline, runEnv: string | undefined): DisplayEntry[] {
  const env = timeline.environment?.name ?? runEnv;
  const current = env !== undefined && Object.hasOwn(project.config.environments ?? {}, env) ? displayRows(resolveEnvironment(project, env)) : undefined;
  return editDisplayTable(timeline.environment?.display, current);
}

/** The timeline with its step and click target descriptions as shown (core shownText): `open http://localhost…` → `open /x`. */
export function shownTargets(timeline: Timeline, table: readonly DisplayEntry[]): Timeline {
  const shown = (d: string) => shownText(d, table);
  return {
    ...timeline,
    events: timeline.events.map((e) => {
      const data = e.data as { clicks?: Array<{ desc?: string }> } | undefined;
      const clicks = Array.isArray(data?.clicks) ? data.clicks.map((c) => (typeof c.desc === 'string' ? { ...c, desc: shown(c.desc) } : c)) : undefined;
      return {
        ...e,
        ...(e.target?.desc !== undefined ? { target: { ...e.target, desc: shown(e.target.desc) } } : {}),
        ...(clicks ? { data: { ...data, clicks } } : {}),
      };
    }),
  };
}

/** A raw export that cannot start (message written for the user). */
export class RawExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RawExportError';
  }
}

export interface ExportCaptureOptions {
  project: LoadedProject;
  /** The run directory (the caller resolves an id, a path or `latest`). */
  runDir: string;
  /** Template the run was captured with: the look of the cursor layer (default look otherwise). */
  template?: LoadedTemplate;
  format?: RawFormat;
  fps?: RawFps;
  cursor?: RawCursorMode;
  layer?: RawLayerFormat;
  selects?: boolean;
  cuts?: boolean;
  /** Package folder (default `<project>/exports/<run-id>-raw-<format><fps>-<cursor>/`). */
  out?: string;
  /** Files the edit of this scenario uses (intro / outro videos, overlays, images…): listed for re-use. */
  editFiles?: string[];
  browser?: BrowserConfig;
  ffmpeg?: string;
  ffprobe?: string;
  signal?: AbortSignal;
  onProgress?: (p: RawExportProgress) => void;
}

export interface RawExportProgress {
  stage: 'plan' | 'clip' | 'layer' | 'selects' | 'files' | 'done';
  done: number;
  total: number;
  message?: string;
}

export interface RawManifestClip {
  file: string;
  name: string;
  scene: string;
  scene_number: number;
  page?: string;
  label?: string;
  /** On the sequence (FCPXML spine, EDL, OTIO V1, selects); the other pages of a scene ride along, disabled. */
  primary: boolean;
  caption?: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  duration_s: number;
  codec: string;
  profile?: string;
  pix_fmt: string;
  timecode: string;
  size_bytes: number;
  seq_start_frame: number;
  seq_start_tc: string;
  /** Capture seconds it covers (cuts inside). */
  capture: { from: number; to: number };
  /** `wait_step`: the wait step whose awaited state ends the cut (absent for a page load the capture held, R-ISS-08). */
  cuts: Array<{ at_frame: number; at_tc: string; capture_from: number; capture_to: number; seconds: number; reason: string; wait_step?: number; after_step?: number }>;
  layer?: { file: string; codec: string; profile?: string; pix_fmt: string; alpha: boolean; frames: number; size_bytes: number };
}

export interface RawManifest {
  version: 1;
  kind: 'demo-studio/raw-capture';
  created_at: string;
  project: { slug: string; name: string };
  scenario: string;
  run: {
    id: string;
    dir: string;
    captured_at: string;
    status?: string;
    env?: string;
    capture: { width: number; height: number; scale: number; fps: number; duration_s: number; frames: number };
    /** Whether the in-page cursor is in the run's pictures. */
    cursor: 'visible' | 'hidden';
  };
  settings: { format: RawFormat; codec: string; fps: RawFps; cursor: RawCursorMode; layer?: RawLayerFormat; layer_codec?: string; cuts: boolean; selects: boolean; frames_from: 'screencast frames' | 'capture video' };
  sequence: { fps: number; frames: number; duration_s: number; start_tc: string; end_tc: string };
  clips: RawManifestClip[];
  selects?: { file: string; frames: number; duration_s: number; codec: string; size_bytes: number };
  cursor: {
    mode: RawCursorMode;
    data: { json: string; csv: string; clicks_csv: string };
    icons: 'recorded' | 'approximated';
    look: { style: string; size: number; ripple_color: string };
    layers: string[];
  };
  markers: { fcpxml: string; edl: string; otio: string; json: string; csv: string; count: Record<RawMarkerKind, number>; colors: Record<RawMarkerKind, string> };
  edit_files: string[];
  notes: string[];
  warnings: string[];
}

export interface RawExportResult {
  dir: string;
  manifest: RawManifest;
  manifestFile: string;
  readme: string;
}

const pick = <T extends string | number>(v: unknown, allowed: readonly T[]): T | undefined => (allowed as readonly unknown[]).includes(v) ? (v as T) : undefined;

/** Resolved settings: the call's, else project.yaml `raw`, else the defaults (mp4, 30, cursor as captured). */
export function rawSettings(project: LoadedProject, timeline: Pick<Timeline, 'capture'>, opts: Pick<ExportCaptureOptions, 'format' | 'fps' | 'cursor' | 'layer' | 'selects' | 'cuts'>) {
  const raw = project.config.raw ?? {};
  const hidden = timeline.capture.cursor === 'hidden';
  const format = opts.format ?? raw.format ?? 'mp4';
  const fps = opts.fps ?? raw.fps ?? 30;
  const cursor = opts.cursor ?? raw.cursor ?? (hidden ? 'none' : 'baked');
  const layer = opts.layer ?? raw.layer ?? 'prores';
  if (!pick(format, RAW_FORMATS)) throw new RawExportError(`format "${format}": use ${RAW_FORMATS.join(' or ')}`);
  if (fps !== 30 && fps !== 60) throw new RawExportError(`fps ${fps}: use 30 or 60`);
  if (!pick(cursor, RAW_CURSOR_MODES)) throw new RawExportError(`cursor "${cursor}": use ${RAW_CURSOR_MODES.join(', ')}`);
  if (!pick(layer, RAW_LAYER_FORMATS)) throw new RawExportError(`layer "${layer}": use ${RAW_LAYER_FORMATS.join(' or ')}`);
  return { format, fps: fps as RawFps, cursor, layer, selects: opts.selects ?? raw.selects ?? false, cuts: opts.cuts ?? raw.cuts ?? true, hidden };
}

/** Default package folder of a run. */
export function rawPackageDir(project: Pick<LoadedProject, 'dir'>, runId: string, s: { format: RawFormat; fps: number; cursor: RawCursorMode }): string {
  return join(project.dir, 'exports', `${runId}-raw-${s.format}${s.fps}-${s.cursor}`);
}

/** Export a run as a raw package for editors. */
export async function exportCapture(opts: ExportCaptureOptions): Promise<RawExportResult> {
  const runDir = resolve(opts.runDir);
  const tlFile = join(runDir, 'timeline.json');
  if (!existsSync(tlFile)) throw new RawExportError(`${runDir} has no timeline.json (not a run, or the run did not finish)`);
  const recorded = JSON.parse(await readFile(tlFile, 'utf8')) as Timeline;
  if (recorded.mode !== 'capture') throw new RawExportError(`run ${recorded.run_id} is a dry run: it has no capture to export`);
  const newer = newerRunMessage(runDir);
  if (newer) throw new RawExportError(`run ${recorded.run_id}: ${newer}`);
  let record: RunRecord | undefined;
  try {
    record = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunRecord;
  } catch {
    record = undefined;
  }
  // What the package names (step markers, click targets) as the video shows it (L1.7): URLs through the display table
  // an edit would use, a local one reduced to its path — the real URLs stay in the run's timeline.json.
  const timeline = shownTargets(recorded, exportDisplayTable(opts.project, recorded, record?.env));
  const s = rawSettings(opts.project, timeline, opts);
  if (s.hidden && s.cursor === 'baked') {
    throw new RawExportError(`run ${timeline.run_id} was captured without its cursor (run --raw --cursor none|layer): export it with --cursor none or --cursor layer`);
  }
  if (!s.hidden && s.cursor === 'none') {
    throw new RawExportError(
      `run ${timeline.run_id} has the cursor in its pictures: --cursor none needs a run captured without it — \`studio run ${opts.project.slug} ${timeline.scenario} --raw --cursor none\` (or --cursor layer / baked for this run)`,
    );
  }
  const emit = opts.onProgress ?? (() => undefined);
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  const notes: string[] = [];
  const warnings: string[] = [];
  emit({ stage: 'plan', done: 0, total: 1 });
  // The screencast frames of every source (main capture, page tracks): they pace the resume after a loading cut and
  // make the clips (a run that did not keep them falls back to its CFR video below).
  const frameSources = new Map<string, FrameSource | null>();
  for (const src of [mainSource(timeline), ...(timeline.tracks ?? []).map((t) => trackSource(timeline, t.id)!)]) {
    frameSources.set(src.track, await readFrameSource(runDir, src));
  }
  const plan = planRawExport(timeline, { fps: s.fps, cuts: s.cuts, frameTimes: (track) => frameSources.get(track)?.frames.map((f) => f.t) });
  notes.push(...plan.notes);
  warnings.push(...plan.warnings);
  if (plan.clips.length === 0) throw new RawExportError(`run ${timeline.run_id}: no captured scene to export${plan.warnings.length ? ` (${plan.warnings.join('; ')})` : ''}`);
  if (!s.hidden && s.cursor === 'layer') notes.push('the clips show the cursor as captured (this run was captured with it): the layer duplicates it — capture with `run --raw --cursor layer` for clean clips under the layer');
  if (s.hidden) notes.push('captured without the in-page cursor: the clips show no cursor; its track, icon, presses and ripples are in cursor/ (and the layers with --cursor layer)');
  if (s.cursor === 'layer' && s.layer === 'webm') {
    notes.push('cursor layers in VP9 WebM: no timecode (media time from 0), alpha kept in a VP9 side channel (ffmpeg needs -c:v libvpx-vp9 to decode it), not read by Final Cut Pro or Premiere Pro — left out of the FCPXML, in the OTIO; use --layer prores for those tools');
  }

  const dir = resolve(opts.out ?? rawPackageDir(opts.project, timeline.run_id, s));
  await assertReplaceable(dir);
  const work = `${dir}.partial-${process.pid}`;
  await rm(work, { recursive: true, force: true });
  await mkdir(join(work, 'clips'), { recursive: true });
  await mkdir(join(work, 'cursor'), { recursive: true });
  await mkdir(join(work, 'markers'), { recursive: true });
  const tmp = join(work, '.tmp');
  await mkdir(tmp, { recursive: true });
  const enc = RAW_ENCODING[s.format];
  const clipRel = (c: RawClipPlan) => `clips/${c.name}${enc.ext}`;
  const layerRel = (c: RawClipPlan) => `cursor/${c.name}-cursor${LAYER_ENCODING[s.layer].ext}`;
  try {
    // ── Clips ────────────────────────────────────────────────────────────────
    const sources = new Map<string, { source: FrameSource; schedule: string[] }>();
    let fromVideo = false;
    const sourceOf = async (c: RawClipPlan) => {
      let entry = sources.get(c.source.track);
      if (!entry) {
        let source = frameSources.get(c.source.track) ?? (await readFrameSource(runDir, c.source));
        if (!source) {
          source = await decodeVideoFrames(runDir, c.source, timeline.capture.fps, tmp, ffmpeg, opts.signal);
          fromVideo = true;
          notes.push(`${c.source.track === 'main' ? 'the capture' : `page ${c.source.track}`}: the run did not keep its screencast frames (capture.keep_frames) — clips made from ${c.source.video}${s.fps > timeline.capture.fps ? ` at ${timeline.capture.fps} fps, each frame repeated for ${s.fps} fps (not interpolated)` : ''}`);
        }
        entry = { source, schedule: exportSchedule(source, timeline.capture.duration, s.fps) };
        sources.set(c.source.track, entry);
      }
      return entry;
    };
    const probes = new Map<number, ProbedVideo>();
    for (const c of plan.clips) {
      opts.signal?.throwIfAborted();
      emit({ stage: 'clip', done: c.index, total: plan.clips.length, message: clipRel(c) });
      const { source, schedule } = await sourceOf(c);
      const out = join(work, clipRel(c));
      await encodeClip({
        source,
        files: clipFrameFiles(c, schedule),
        fps: s.fps,
        width: c.source.width,
        height: c.source.height,
        format: s.format,
        timecode: timecode(sequenceStartOf(plan, c), s.fps),
        out,
        tmp,
        ffmpeg,
        signal: opts.signal,
      });
      const p = await probeVideo(out, { ffprobe: opts.ffprobe });
      if (p.frames !== c.frames) warnings.push(`${clipRel(c)}: ${p.frames} frames written, ${c.frames} planned`);
      probes.set(c.index, p);
    }
    emit({ stage: 'clip', done: plan.clips.length, total: plan.clips.length });

    // ── Cursor data (every mode) and layers ──────────────────────────────────
    const kit = kitConfigFor(opts.template);
    const data: ClipCursorData[] = plan.clips.map((c) => {
      const { frames, approximated } = cursorFrames(c, s.fps, cursorTrackOf(timeline, c));
      return { clip: c, file: clipRel(c), frames, clicks: clipClicks(c, s.fps, (t) => clipFrameAt(c, t, s.fps)), approximated };
    });
    const approximated = data.some((d) => d.approximated);
    if (approximated) notes.push('this run was captured before L2.13: the cursor icon (arrow / hand / text beam), presses and ripples are approximated from the steps');
    await writeFile(join(work, 'cursor', 'cursor.json'), cursorJson(plan, data, { run: timeline.run_id, mode: s.cursor }));
    await writeFile(join(work, 'cursor', 'cursor.csv'), cursorCsv(plan, data));
    await writeFile(join(work, 'cursor', 'clicks.csv'), clicksCsv(plan, data));
    const layerProbes = new Map<number, ProbedVideo>();
    if (s.cursor === 'layer') {
      const atlases = new Map<number, CursorAtlas>();
      for (const c of plan.clips) {
        opts.signal?.throwIfAborted();
        emit({ stage: 'layer', done: c.index, total: plan.clips.length, message: layerRel(c) });
        let atlas = atlases.get(c.source.scale);
        if (!atlas) {
          atlas = await renderCursorAtlas({ kit, scale: c.source.scale, browser: opts.browser ?? opts.project.config.browser, ffmpeg });
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
          ffmpeg,
          signal: opts.signal,
        });
        // WebM keeps no frame count in its header: the layer's frames are counted.
        const p = await probeVideo(out, { ffprobe: opts.ffprobe, count: s.layer === 'webm' });
        if (p.frames !== c.frames) warnings.push(`${layerRel(c)}: ${p.frames} frames written, ${c.frames} planned`);
        if (!p.alpha) warnings.push(`${layerRel(c)}: ffprobe sees no alpha channel`);
        layerProbes.set(c.index, p);
      }
      emit({ stage: 'layer', done: plan.clips.length, total: plan.clips.length });
    }

    // ── Selects ──────────────────────────────────────────────────────────────
    let selects: RawManifest['selects'];
    if (s.selects) {
      const primaries = plan.sequence.map((q) => plan.clips[q.clip]);
      const sizes = new Set(primaries.map((c) => `${c.source.width}x${c.source.height}`));
      if (sizes.size > 1) {
        warnings.push(`no selects file: the sequence clips have different sizes (${[...sizes].join(', ')})`);
      } else {
        emit({ stage: 'selects', done: 0, total: 1 });
        const rel = `selects${enc.ext}`;
        await concatClips(primaries.map((c) => join(work, clipRel(c))), join(work, rel), tmp, ffmpeg, opts.signal);
        const p = await probeVideo(join(work, rel), { ffprobe: opts.ffprobe });
        if (p.frames !== plan.frames) warnings.push(`${rel}: ${p.frames} frames, the sequence has ${plan.frames}`);
        selects = { file: rel, frames: p.frames, duration_s: round3(p.frames / s.fps), codec: enc.label, size_bytes: p.size_bytes };
      }
    }

    // ── Markers ──────────────────────────────────────────────────────────────
    emit({ stage: 'files', done: 0, total: 1 });
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

    // ── Manifest + README ────────────────────────────────────────────────────
    const count = { scene: 0, step: 0, mark: 0, caption: 0, cut: 0 } as Record<RawMarkerKind, number>;
    for (const m of markers) count[m.kind]++;
    const cap = timeline.capture;
    const manifest: RawManifest = {
      version: 1,
      kind: 'demo-studio/raw-capture',
      created_at: new Date().toISOString(),
      project: { slug: opts.project.slug, name: opts.project.config.name },
      scenario: timeline.scenario,
      run: {
        id: timeline.run_id,
        dir: runDir,
        captured_at: timeline.created_at,
        ...(record?.status ? { status: record.status } : {}),
        ...(record?.env ? { env: record.env } : {}),
        capture: { width: cap.width, height: cap.height, scale: cap.scale, fps: cap.fps, duration_s: cap.duration, frames: cap.frames },
        cursor: s.hidden ? 'hidden' : 'visible',
      },
      settings: {
        format: s.format,
        codec: enc.label,
        fps: s.fps,
        cursor: s.cursor,
        ...(s.cursor === 'layer' ? { layer: s.layer, layer_codec: LAYER_ENCODING[s.layer].label } : {}),
        cuts: s.cuts,
        selects: s.selects,
        frames_from: fromVideo ? 'capture video' : 'screencast frames',
      },
      sequence: { fps: s.fps, frames: plan.frames, duration_s: round3(plan.frames / s.fps), start_tc: timecode(0, s.fps), end_tc: timecode(plan.frames, s.fps) },
      clips: plan.clips.map((c) => {
        const p = probes.get(c.index)!;
        const start = sequenceStartOf(plan, c);
        const lp = layerProbes.get(c.index);
        return {
          file: clipRel(c),
          name: c.name,
          scene: c.scene,
          scene_number: c.number,
          ...(c.page !== undefined ? { page: c.page } : {}),
          ...(c.label !== undefined ? { label: c.label } : {}),
          primary: c.primary,
          ...(c.caption ? { caption: c.caption.kicker ? `${c.caption.kicker} — ${c.caption.text}` : c.caption.text } : {}),
          width: p.width,
          height: p.height,
          fps: p.fps,
          frames: p.frames,
          duration_s: round3(p.frames / s.fps),
          codec: p.codec,
          ...(p.profile ? { profile: p.profile } : {}),
          pix_fmt: p.pix_fmt,
          timecode: p.timecode ?? timecode(start, s.fps),
          size_bytes: p.size_bytes,
          seq_start_frame: start,
          seq_start_tc: timecode(start, s.fps),
          capture: { from: c.t0, to: c.t1 },
          cuts: c.cuts.map((x) => ({ at_frame: x.at, at_tc: timecode(start + x.at, s.fps), capture_from: x.from, capture_to: x.to, seconds: round3(x.to - x.from), reason: x.reason, ...(x.wait_step !== undefined ? { wait_step: x.wait_step } : {}), ...(x.after_step !== undefined ? { after_step: x.after_step } : {}) })),
          ...(lp ? { layer: { file: layerRel(c), codec: lp.codec, ...(lp.profile ? { profile: lp.profile } : {}), pix_fmt: lp.alpha && !/^yuva/.test(lp.pix_fmt) ? `${lp.pix_fmt} + alpha` : lp.pix_fmt, alpha: lp.alpha, frames: lp.frames, size_bytes: lp.size_bytes } } : {}),
        };
      }),
      ...(selects ? { selects } : {}),
      cursor: {
        mode: s.cursor,
        data: { json: 'cursor/cursor.json', csv: 'cursor/cursor.csv', clicks_csv: 'cursor/clicks.csv' },
        icons: approximated ? 'approximated' : 'recorded',
        look: { style: kit.cursor.style, size: kit.cursor.size, ripple_color: kit.cursor.ripple_color },
        layers: s.cursor === 'layer' ? plan.clips.map(layerRel) : [],
      },
      markers: { ...mk, count, colors: MARKER_COLORS },
      edit_files: [...new Set(opts.editFiles ?? [])].sort(),
      notes,
      warnings,
    };
    await writeFile(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(join(work, 'README.md'), packageReadme(manifest, plan));
    await rm(tmp, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
    await rename(work, dir);
    emit({ stage: 'done', done: 1, total: 1, message: dir });
    return { dir, manifest, manifestFile: join(dir, 'manifest.json'), readme: join(dir, 'README.md') };
  } catch (e) {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

/** The package folder is replaced at the end: only when it is new, empty, or an earlier raw package. */
async function assertReplaceable(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    throw new RawExportError(`${dir} exists and is not a folder: choose another --out`);
  }
  if (entries.length === 0) return;
  try {
    const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { kind?: string };
    if (m.kind === 'demo-studio/raw-capture') return;
  } catch {
    /* not a package */
  }
  throw new RawExportError(`${dir} already holds other files (it is not a raw package): choose another --out — it would be replaced`);
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const fileBase = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'sequence';
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** README.md of a package: what it holds and how to bring it into an editing tool. */
export function packageReadme(m: RawManifest, plan: RawPlan): string {
  const fps = m.sequence.fps;
  const rows = m.clips.map(
    (c) =>
      `| \`${c.file}\` | ${c.scene}${c.page ? ` · ${c.page}${c.label ? ` (${c.label})` : ''}` : ''}${c.primary ? '' : ' *(other page)*'} | ${c.width}×${c.height} | ${c.frames} (${c.duration_s.toFixed(2)} s) | ${c.seq_start_tc} | ${c.cuts.length ? c.cuts.map((x) => `${x.seconds.toFixed(1)} s ${x.reason} at ${x.at_tc}`).join('; ') : '—'} |`,
  );
  const webm = m.settings.layer === 'webm';
  const cursor =
    m.cursor.mode === 'baked'
      ? 'The cursor is **in the pictures** (as captured).'
      : m.cursor.mode === 'none'
        ? 'The clips have **no cursor** (captured without it). Its position, icon, presses and ripples on every frame are in `cursor/cursor.json` / `cursor/cursor.csv`, the clicks with their step and target box in `cursor/clicks.csv` (clip pixels, clip-relative seconds).'
        : webm
          ? `Each clip has a **transparent cursor layer** (\`cursor/<clip>-cursor.webm\`, ${m.settings.layer_codec}) with the cursor and its click ripples, same size, frame rate and length as its clip: put it on the track above, aligned with its clip's start. WebM has **no timecode**: the layer's media time starts at 0 (00:00:00:00), not at its clip's timecode. VP9 WebM with alpha is for web players and ffmpeg-based tools (ffmpeg decodes its alpha with \`-c:v libvpx-vp9\` only); **Final Cut Pro and Premiere Pro do not read it** — export with \`--layer prores\` (ProRes 4444, timecoded like the clips) for them.${m.run.cursor === 'visible' ? ' (This run was captured with its cursor, so the clips show it too.)' : ''} The same data is in \`cursor/\` as JSON / CSV.`
          : `Each clip has a **transparent cursor layer** (\`cursor/<clip>-cursor.mov\`, ${m.settings.layer_codec}) with the cursor and its click ripples, same size, frame rate, length and start timecode as its clip: put it on the track above.${m.run.cursor === 'visible' ? ' (This run was captured with its cursor, so the clips show it too.)' : ''} The same data is in \`cursor/\` as JSON / CSV.`;
  return [
    `# Raw capture — ${m.scenario}`,
    '',
    `Run \`${m.run.id}\` of project ${m.project.name} (captured ${m.run.captured_at}), exported ${m.created_at} by Demo Studio for editing in another tool.`,
    '',
    `- **Clips:** ${m.clips.length} (${plan.sequence.length} on the sequence), ${m.settings.codec}, **${fps} fps** constant frame rate (real frame timing of the capture, nothing interpolated), BT.709.`,
    `- **Sequence:** ${m.sequence.frames} frames = ${m.sequence.duration_s.toFixed(2)} s, ${m.sequence.start_tc} → ${m.sequence.end_tc}. Every clip's embedded start timecode is its place on the sequence, so source and record timecodes agree.`,
    `- **Cuts:** the page loads before each scene are never in a clip${m.settings.cuts ? '; the loading inside a scene (a wait for the product after a click) is cut — a jump cut marked with a magenta marker' : '; loading inside scenes is kept (--no-cuts)'}. Real time otherwise (no speed changes).`,
    `- **Cursor (${m.cursor.mode}):** ${cursor}`,
    m.selects ? `- **Selects:** \`${m.selects.file}\` — the sequence clips back to back in one file (${m.selects.frames} frames).` : '',
    '',
    '| Clip | Scene | Size | Frames | Starts at | Cuts |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Markers',
    `Scenes (blue, chapter markers in Final Cut Pro), steps (green), marks (red), captions (yellow, lasting until the next one) and loading cuts (magenta) — ${Object.entries(m.markers.count).map(([k, v]) => `${v} ${k}`).join(', ')}.`,
    '',
    `- \`${m.markers.fcpxml}\` — **Final Cut Pro** (File → Import → XML…; FCPXML 1.10): an event with one project, the clips on the primary storyline, markers on them${m.cursor.mode === 'layer' ? (webm ? ' (the WebM cursor layers are not in it: Final Cut Pro cannot read them — they are in the OTIO)' : ', the cursor layers connected above') : ''}${m.clips.some((c) => !c.primary) ? ', the other page of a multi-page scene connected and disabled (enable it for a split screen)' : ''}. **DaVinci Resolve** imports it too (File → Import → Timeline…).`,
    `- \`${m.markers.otio}\` — **OpenTimelineIO** (DaVinci Resolve: File → Import → Timeline…; any OTIO tool or adapter, e.g. to Premiere via otio adapters): track V1 with the clips${m.cursor.mode === 'layer' ? `, a Cursor track above${webm ? ' (WebM layers referenced from media time 0)' : ''}` : ''}, markers with names, colours and comments.`,
    `- \`${m.markers.edl}\` — **CMX 3600 EDL** (Premiere Pro: File → Import; Resolve; Avid): one event per sequence clip, markers as \`* LOC:\` locators, ${fps} fps non-drop. An EDL has one picture track: other pages and cursor layers are in the FCPXML / OTIO only.`,
    `- \`${m.markers.csv}\` / \`${m.markers.json}\` — every marker in clip-relative and sequence time (frames, seconds, timecode) for spreadsheets, After Effects scripts or Claude.`,
    '',
    'The interchange files point at the clips by absolute path (file:// URLs in the FCPXML and OTIO); if you move this folder, relink to `clips/` (names are unique). In Premiere Pro, import the clips folder and the EDL, or convert the OTIO with an OTIO adapter (e.g. otio-fcp-adapter to FCP 7 XML).',
    '',
    ...(m.edit_files.length ? ['## Files the edit used', 'Your own media the Demo Studio edit of this scenario uses (intro / outro videos, overlays, images) — reuse them in your tool:', '', ...m.edit_files.map((f) => `- \`${f}\``), ''] : []),
    ...(m.notes.length ? ['## Notes', ...m.notes.map((n) => `- ${n}`), ''] : []),
    ...(m.warnings.length ? ['## Warnings', ...m.warnings.map((n) => `- ${n}`), ''] : []),
    `Sizes: clips ${mb(m.clips.reduce((n, c) => n + c.size_bytes, 0))}${m.cursor.mode === 'layer' ? `, layers ${mb(m.clips.reduce((n, c) => n + (c.layer?.size_bytes ?? 0), 0))}` : ''}. Everything is described in \`manifest.json\`.`,
    '',
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
}

