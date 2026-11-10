/**
 * `retake prune <project> [--keep-renders N] [--yes]` (L5.7, R-FLD-28): what the project's runs/, renders/ and review/
 * hold that nothing needs any more — failed takes, dry runs, older captures and renders — and how much deleting it
 * frees (engine prune.ts: the last succeeded capture of each scenario, the takes and renders kept renders and comment
 * threads use, the last N renders of each scenario and whatever a queued or running job names stay; when comment
 * threads cannot be read, the renders and takes they may name stay too, and a warning says so). A capture that stays
 * only because it is the last one of its scenario that can be edited, or the last complete one, and a run folder
 * prune leaves alone (a link, a take of a newer Retake) get a line `kept` with the reason
 * (L7.7: the list is shorter, and says why) — per reason the first five, newest first, then how many more (their
 * names: --json). Without --yes it only lists.
 */
import { resolve } from 'node:path';
import { printableText } from '@retake/core';
import { DEFAULT_KEEP_RENDERS, createEngine, formatBytes } from '@retake/engine';
import type { PruneResult } from '@retake/engine';
import { EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { plural } from '../ui.js';
import type { GlobalOptions } from '../workspace.js';

/** How many takes kept for one reason `retake prune` names (it counts the others), as a notice names the captures `latest` passed over. */
export const KEPT_NAMED = 5;

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
  // The takes that stay for a reason the list does not show: a folder's name, said printable; the engine's fixed words.
  // Reason by reason in the order the reasons are met, the first KEPT_NAMED takes of each named and the rest counted
  // (a project may hold any number of linked folders, and each is said on every pass).
  const kept = (): void => {
    const by = new Map<string, NonNullable<PruneResult['kept_takes']>>();
    for (const k of r.kept_takes ?? []) by.set(k.why, [...(by.get(k.why) ?? []), k]);
    const line = (what: string, reason: string): void => ui.line(`  ${c.dim('kept'.padEnd(12))}  ${'run'.padEnd(6)} ${what}  ${c.dim(reason)}`);
    for (const takes of by.values()) {
      for (const k of takes.slice(0, KEPT_NAMED)) line(printableText(k.id), k.reason);
      if (takes.length > KEPT_NAMED) line(`and ${takes.length - KEPT_NAMED} more (--json names them)`, takes[0].reason);
    }
  };
  if (!r.items.length) {
    ui.line(`nothing to prune in ${r.project} (kept: ${plural(r.kept.runs, 'take')}, ${plural(r.kept.renders, 'render')}, ${plural(r.kept.reviews, 'review')})`);
    kept();
    if (r.threads_unread) ui.warn(r.threads_unread);
    return EXIT.ok;
  }
  for (const it of r.items) {
    ui.line(`  ${r.dry_run ? c.dim('would delete') : c.yellow('deleted')}  ${it.kind.padEnd(6)} ${it.id}  ${c.dim(`${it.reason} · ${formatBytes(it.bytes)}`)}`);
  }
  kept();
  const what = `${plural(r.items.length, 'item')} (${formatBytes(r.bytes)})`;
  ui.line();
  ui.line(
    r.dry_run
      ? `${what} can go; kept: ${plural(r.kept.runs, 'take')}, ${plural(r.kept.renders, 'render')} (the last ${r.keep_renders} per scenario), ${plural(r.kept.reviews, 'review')} — ${c.bold('retake prune ' + r.project + ' --yes')} deletes them`
      : `${c.green('✓')} ${what} deleted; kept: ${plural(r.kept.runs, 'take')}, ${plural(r.kept.renders, 'render')}, ${plural(r.kept.reviews, 'review')}`,
  );
  // Comment threads that could not be read: what stayed for it (not a failure: nothing that could matter was deleted).
  if (r.threads_unread) ui.warn(r.threads_unread);
  for (const p of r.problems) ui.warn(p);
  return r.problems.length ? EXIT.failure : EXIT.ok;
}
