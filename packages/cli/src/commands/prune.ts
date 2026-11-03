/**
 * `retake prune <project> [--keep-renders N] [--yes]` (L5.7, R-FLD-28): what the project's runs/, renders/ and review/
 * hold that nothing needs any more — failed takes, dry runs, older captures and renders — and how much deleting it
 * frees (engine prune.ts: the last succeeded capture of each scenario, the takes and renders kept renders and comment
 * threads use, the last N renders of each scenario and whatever a queued or running job names stay). Without --yes it
 * only lists.
 */
import { resolve } from 'node:path';
import { DEFAULT_KEEP_RENDERS, createEngine, formatBytes } from '@retake/engine';
import type { PruneResult } from '@retake/engine';
import { EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { plural } from '../ui.js';
import type { GlobalOptions } from '../workspace.js';

export interface PruneOptions {
  keepRenders?: string;
  yes?: boolean;
  json?: boolean;
}

export async function pruneCommand(ui: Ui, global: GlobalOptions, projectArg: string, opts: PruneOptions): Promise<ExitCode> {
  let keep = DEFAULT_KEEP_RENDERS;
  if (opts.keepRenders !== undefined) {
    if (!/^[1-9]\d*$/.test(opts.keepRenders)) throw new UsageError(`--keep-renders ${opts.keepRenders}: a whole number from 1`);
    keep = Number(opts.keepRenders);
  }
  const engine = await createEngine({ ...(global.root ? { root: resolve(global.root) } : {}), client: 'cli', autoStartWorker: false });
  const r: PruneResult = await engine.projects.prune(projectArg, { keep_renders: keep, dry_run: opts.yes !== true });
  if (opts.json) {
    ui.result(JSON.stringify(r, null, 2));
    return r.problems.length ? EXIT.failure : EXIT.ok;
  }
  const c = ui.c;
  if (!r.items.length) {
    ui.line(`nothing to prune in ${r.project} (kept: ${plural(r.kept.runs, 'take')}, ${plural(r.kept.renders, 'render')}, ${plural(r.kept.reviews, 'review')})`);
    return EXIT.ok;
  }
  for (const it of r.items) {
    ui.line(`  ${r.dry_run ? c.dim('would delete') : c.yellow('deleted')}  ${it.kind.padEnd(6)} ${it.id}  ${c.dim(`${it.reason} · ${formatBytes(it.bytes)}`)}`);
  }
  const what = `${plural(r.items.length, 'item')} (${formatBytes(r.bytes)})`;
  ui.line();
  ui.line(
    r.dry_run
      ? `${what} can go; kept: ${plural(r.kept.runs, 'take')}, ${plural(r.kept.renders, 'render')} (the last ${r.keep_renders} per scenario), ${plural(r.kept.reviews, 'review')} — ${c.bold('retake prune ' + r.project + ' --yes')} deletes them`
      : `${c.green('✓')} ${what} deleted; kept: ${plural(r.kept.runs, 'take')}, ${plural(r.kept.renders, 'render')}, ${plural(r.kept.reviews, 'review')}`,
  );
  for (const p of r.problems) ui.warn(p);
  return r.problems.length ? EXIT.failure : EXIT.ok;
}
