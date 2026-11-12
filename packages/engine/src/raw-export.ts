/**
 * A run's raw package for another editing tool (L7.22, U8e) — what `retake export-capture` and `retake run --raw` do,
 * in this process: the run's timeline through the export's own gate (the capture port's `raw.timeline`), the theme the
 * run was captured with (its cursor look; the project's when the run names none; the default look, with a note, when it
 * does not load), the files its edit uses (the editor's planFileRefs / themeFileRefs: listed in the package for
 * re-use), then the package (`raw.export`). The caller resolved the run first (findRunOf: `latest`, an id or a folder)
 * and waited at its heavy-work gate in between; it prints the progress, the note and the result its own way.
 */
import { isAbsolute, join } from 'node:path';
import { loadProjectTemplate, fileFacts } from '@retake/core/io';
import type { LoadedProject, LoadedTemplate, Timeline, WorkFileFacts, WorkPolicy } from '@retake/core';
import type { ExportCaptureOptions, RawExportProgress, RawExportResult } from '@retake/runner-web/types';
import type { CaptureRunner } from './capture/runner.js';
import { editor } from './lazy.js';

/** The package's settings a caller may set (undefined: project.yaml `raw`, else the defaults). */
export type RawExportSettings = Pick<ExportCaptureOptions, 'format' | 'fps' | 'cursor' | 'layer' | 'selects' | 'cuts' | 'out'>;

export interface RawExportWorkOptions {
  /** What exports it: the composition root's capture runner (its `raw`). */
  capture: Pick<CaptureRunner, 'raw'>;
  /** What the work runs under, and the ffmpeg the workspace names. */
  ws: { policy: WorkPolicy; ffmpeg?: string };
  project: LoadedProject;
  /** The run's folder (found by the caller). */
  runDir: string;
  settings: RawExportSettings;
  signal?: AbortSignal;
  /** Said when the run's theme does not load (the cursor layer then takes the default look). */
  onNote?: (note: string) => void;
  onProgress?: (p: RawExportProgress) => void;
}

/** The template a run was captured with (its cursor look), else the project's; a note when it does not load. */
async function runTemplate(project: LoadedProject, timeline: Timeline, files: WorkFileFacts): Promise<{ template?: LoadedTemplate; note?: string }> {
  try {
    return { template: await loadProjectTemplate(project, timeline.video?.template, { files }) };
  } catch (e) {
    return { note: `the run's template could not be loaded (${e instanceof Error ? e.message : String(e)}): the cursor layer uses the default look` };
  }
}

/** Export a run's raw package (see the module comment); the port's refusals are EngineErrors in the export's words. */
export async function rawExportWork(o: RawExportWorkOptions): Promise<RawExportResult> {
  // The gate first: a run it refuses is refused in its words, before the theme is looked for.
  const timeline = await o.capture.raw.timeline(o.runDir);
  const { template, note } = await runTemplate(o.project, timeline, fileFacts(o.ws.policy));
  if (note) o.onNote?.(note);
  const ed = await editor();
  const editFiles = [...ed.planFileRefs(timeline).map((f) => (isAbsolute(f) ? f : join(o.project.dir, f))), ...ed.themeFileRefs(template)];
  return o.capture.raw.export({
    policy: o.ws.policy,
    project: o.project,
    runDir: o.runDir,
    ...(template ? { template } : {}),
    ...o.settings,
    editFiles,
    ffmpeg: o.ws.ffmpeg,
    signal: o.signal,
    onProgress: o.onProgress,
  });
}
