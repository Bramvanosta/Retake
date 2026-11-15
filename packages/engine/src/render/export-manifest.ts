/**
 * Where an export goes and its manifest, the engine's (the editor's exportRender writes the formats into the folder it
 * is handed and says what it made): exports/<render-id>/ of the project on the Outputs port's exports, or the
 * caller's output folder; `manifest.json` keeps the entries of the formats exported earlier into the same folder whose
 * file is still there, is stamped by the Clock port and written whole (the port's writeJson: two-space indent, a final
 * newline).
 */
import { join, resolve } from 'node:path';
import { EXPORT_FORMAT_NAMES } from '@retake/core/render';
import type { ExportMade, ExportOutput, ExportPlace, ExportResult } from '@retake/editor/plan';
import type { Clock } from '../clock.js';
import { stampOf } from '../clock.js';
import type { OutputFolder } from '../outputs/outputs.js';

/** The folder of an export: `out` when the caller names one, else exports/<name>/ of the project. */
export function exportPlace(exports: Pick<OutputFolder, 'dirOf'>, projectDir: string, out: string | undefined): ExportPlace {
  return (name) => resolve(out ?? join(exports.dirOf(projectDir), name));
}

/** The formats of the manifest already in `manifest` for the render `render`, but those exported again, whose file is still there. */
async function earlierOutputs(exports: OutputFolder, manifest: string, made: ExportMade): Promise<ExportOutput[]> {
  try {
    const text = await exports.readText(manifest);
    if (text === undefined) return [];
    const old = JSON.parse(text) as { render?: unknown; outputs?: ExportOutput[] };
    if (old.render !== made.render) return [];
    const kept: ExportOutput[] = [];
    for (const o of old.outputs ?? []) {
      if (made.outputs.some((n) => n.format === o.format)) continue;
      if ((await exports.kind(o.file)) === 'file') kept.push(o);
    }
    return kept;
  } catch {
    // no manifest that reads: none kept
    return [];
  }
}

/** Write the manifest of what the export made (with the formats exported earlier kept): the export's result. */
export async function writeExportManifest(exports: OutputFolder, made: ExportMade, clock: Clock): Promise<ExportResult> {
  const manifest = join(made.dir, 'manifest.json');
  const previous = await earlierOutputs(exports, manifest, made);
  const order = EXPORT_FORMAT_NAMES as readonly string[];
  const result: ExportResult = {
    version: made.version,
    project: made.project,
    render: made.render,
    scenario: made.scenario,
    run_id: made.run_id,
    master: made.master,
    dir: made.dir,
    manifest,
    created_at: stampOf(clock),
    outputs: [...previous, ...made.outputs].sort((a, b) => order.indexOf(a.format) - order.indexOf(b.format)),
    failures: made.failures,
  };
  await exports.writeJson(manifest, result);
  return result;
}
