/**
 * `retake project adopt <project> --theme <name>… [--brand <path>…] [--copy] [--json]`: the project takes
 * workspace themes into its own `templates/` and brand files into its own `brand/`, so its folder alone carries its look.
 * By default it MOVES them: refused while another project or scenario uses the theme (listed), or while a job is queued
 * or running; the workspace's folder is set aside under `.retake/adopted/` (never deleted: a person removes it).
 * `--copy` leaves the workspace's. The engine's projects.adopt (project-adopt.ts) does the work, as the person (trust
 * author): MCP's project_adopt copies themes only.
 */
import { resolve } from 'node:path';
import { EngineError, createEngine } from '@retake/engine';
import type { AdoptResult } from '@retake/engine';
import { CliError, EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

export interface AdoptOptions {
  theme?: string[];
  brand?: string[];
  copy?: boolean;
  json?: boolean;
}

function print(ui: Ui, r: AdoptResult): void {
  const k = ui.c;
  const verb = r.mode === 'move' ? 'moved' : 'copied';
  for (const t of r.themes) {
    ui.ok(`theme ${k.bold(t.name)} ${verb} into project ${r.project}: ${ui.path(t.dir)} (${t.files.length} files)`);
    if (t.moved_to) ui.line(k.dim(`  the workspace's folder is set aside in ${t.moved_to} — remove it once you no longer need it`));
  }
  for (const b of r.brand) {
    ui.ok(`${b.from} ${verb} into project ${r.project}: ${b.files.join(', ')}`);
    if (b.moved_to) ui.line(k.dim(`  the original is set aside in ${b.moved_to}`));
  }
  for (const n of r.notes) ui.line(`  note: ${n}`);
}

/** `retake project adopt` (see the header). */
export async function projectAdoptCommand(ui: Ui, global: GlobalOptions, projectArg: string, opts: AdoptOptions): Promise<ExitCode> {
  const themes = opts.theme ?? [];
  const brand = opts.brand ?? [];
  if (!themes.length && !brand.length) throw new UsageError('name what the project adopts: --theme <name> (a workspace theme) and / or --brand <path> (brand files of the workspace)');
  const ws = await openWorkspace(global);
  const engine = await createEngine({ root: resolve(ws.root), client: 'cli', autoStartWorker: false, ports: global.ports });
  let r: AdoptResult;
  try {
    r = await engine.projects.adopt({ project: projectArg, themes, brand, mode: opts.copy ? 'copy' : 'move' });
  } catch (e) {
    if (e instanceof EngineError) throw new CliError(`${e.message}${e.fix ? `\n  fix: ${e.fix}` : ''}`);
    throw e;
  }
  if (opts.json) {
    ui.result(JSON.stringify(r, null, 2));
    return EXIT.ok;
  }
  print(ui, r);
  return EXIT.ok;
}
