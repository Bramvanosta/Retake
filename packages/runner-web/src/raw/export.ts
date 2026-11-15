/**
 * `exportCapture` (R-RAW-01…04): the raw package of a run for editing in another tool — one clean clip per
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
import { basename, join, resolve } from 'node:path';
import { displayRows, editDisplayTable, resolveEnvironment, shownText } from '@retake/core/environment';
import { namedRunProblem, takeWords, timelineProblem } from '@retake/core/run';
import { ffmpegBin, readNamedRun } from '@retake/core/io';
import type { LoadedProject } from '@retake/core/project';
import type { Timeline } from '@retake/core/run';
import type { DisplayEntry } from '@retake/core/environment';
import type { RunFolderFacts } from '@retake/core/run';
import { kitConfigFor } from '../kit/source.js';
import { LAYER_ENCODING, RAW_ENCODING, readFrameSource, type FrameSource } from './encode.js';
import { mainSource, planRawExport, trackSource, type RawClipPlan } from './plan.js';
import { RawExportError, rawPackageDir, rawSettings } from './settings.js';
import type { ExportCaptureOptions, RawExportResult } from './settings.js';
import { encodeClips, encodeLayers, settingsNotes, writeCursorData, writeMarkers, writeSelects } from './stages.js';
import type { RawJob } from './stages.js';
import { packageReadme, rawManifest } from './manifest.js';

export { RawExportError, rawPackageDir, rawSettings } from './settings.js';
export type { ExportCaptureOptions, RawExportProgress, RawExportResult, RawManifest, RawManifestClip } from './settings.js';
export { packageReadme } from './manifest.js';

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

/**
 * The run folder a person named, through the core's one reader and the named run's rule (core take.ts): the refusal
 * of a run that has no timeline, whose timeline does not read, that is a dry run or whose run.json a newer Retake
 * wrote — else its timeline and what its record says (`status` and `env`, for the manifest and the display table). The
 * record's status is not judged: a failed take exports, and its manifest says `failed`.
 */
export async function rawExportRun(runDir: string): Promise<{ recorded: Timeline; record: { status?: string; env?: string } | undefined }> {
  const { facts, timeline: whole } = await readNamedRun(runDir);
  // The run as its timeline names it (what the sentences and the package have always said), else the folder's name.
  const run = (facts.timeline.ok ? facts.timeline.value.run_id : undefined) ?? basename(runDir);
  const problem = namedRunProblem(facts, { trust: 'author', inside: true });
  // A film that is missing is not the gate's: the clips are made from the run's screencast frames when it kept them
  // (the video is the fallback, and its absence is said where it is needed).
  if (problem && problem.why !== 'no-film') throw new RawExportError(takeWords(problem, { run, verb: 'export', dir: runDir }));
  // The head reads and the whole does not: its lists are not lists.
  if (!whole.ok) throw new RawExportError(takeWords(timelineProblem(whole) ?? { why: 'no-timeline' }, { run, verb: 'export', dir: runDir }));
  return { recorded: whole.value, record: recordOf(facts) };
}

/** What the run's record says, when it reads: a status Retake never writes is still the record's (the manifest names it). */
function recordOf(facts: RunFolderFacts): { status?: string; env?: string } | undefined {
  const r = facts.record;
  return r.ok ? r.value : r.problem === 'unknown-status' ? r.record : undefined;
}

/** A cursor mode the run's pictures cannot give is refused: baked needs the cursor in them, none needs it absent. */
function checkCursorMode(opts: ExportCaptureOptions, timeline: Timeline, s: ReturnType<typeof rawSettings>): void {
  if (s.hidden && s.cursor === 'baked') {
    throw new RawExportError(`run ${timeline.run_id} was captured without its cursor (run --raw --cursor none|layer): export it with --cursor none or --cursor layer`);
  }
  if (!s.hidden && s.cursor === 'none') {
    throw new RawExportError(
      `run ${timeline.run_id} has the cursor in its pictures: --cursor none needs a run captured without it — \`retake run ${opts.project.slug} ${timeline.scenario} --raw --cursor none\` (or --cursor layer / baked for this run)`,
    );
  }
}

/** Export a run as a raw package for editors. */
export async function exportCapture(opts: ExportCaptureOptions): Promise<RawExportResult> {
  const runDir = resolve(opts.runDir);
  const { recorded, record } = await rawExportRun(runDir);
  // What the package names (step markers, click targets) as the video shows it: URLs through the display table
  // an edit would use, a local one reduced to its path — the real URLs stay in the run's timeline.json.
  const timeline = shownTargets(recorded, exportDisplayTable(opts.project, recorded, record?.env));
  const s = rawSettings(opts.project, timeline, opts);
  checkCursorMode(opts, timeline, s);
  const emit = opts.onProgress ?? (() => undefined);
  const ffmpeg = ffmpegBin(opts.policy, opts.ffmpeg);
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
  settingsNotes(s, notes);

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
  const job: RawJob = { opts, runDir, timeline, s, plan, emit, ffmpeg, notes, warnings, frameSources, dir, work, tmp, enc, clipRel, layerRel, fromVideo: false, h264: undefined };
  try {
    const probes = await encodeClips(job);
    const kit = kitConfigFor(opts.template);
    const { data, approximated } = await writeCursorData(job);
    const layerProbes = await encodeLayers(job, kit, data);
    const selects = await writeSelects(job);
    emit({ stage: 'files', done: 0, total: 1 });
    const { markers, mk } = await writeMarkers(job);
    const manifest = rawManifest(job, { record, kit, probes, layerProbes, approximated, selects, markers, mk });
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
export async function assertReplaceable(dir: string): Promise<void> {
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
    if (m.kind === 'retake/raw-capture') return;
  } catch {
    /* not a package */
  }
  throw new RawExportError(`${dir} already holds other files (it is not a raw package): choose another --out — it would be replaced`);
}
