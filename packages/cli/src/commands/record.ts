import { isAccessError, scenarioRef } from '@retake/core';
import { checkAllowWrites, recordScenario } from '@retake/engine';
import type { RecordOutcome, RecordPorts } from '@retake/engine';
import { EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import { onInterrupt } from '../interrupt.js';
import type { Ui } from '../ui.js';
import { formatMs, plural } from '../ui.js';
import { openProject, openWorkspace, workspaceQueue } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';
import { loginCommandFor, retakeCommand } from './auth.js';

export interface RecordCommandOptions {
  env?: string;
  persona?: string;
  page?: string;
  path?: string;
  url?: string;
  allowWrites?: boolean;
  /** `--no-check`: false. */
  check?: boolean;
  json?: boolean;
}

/** Test hooks (not options of the command): Playwright plays the person in a headless "headed" window. */
export type RecordTestHooks = Pick<RecordPorts, 'drive' | 'headless' | 'windowSize'>;

const ACTIONS = new Set(['pointer', 'type', 'key', 'select_native', 'file']);

/**
 * `retake record <project> [name] [--env] [--persona] [--page] [--path | --url] [--allow-writes] [--no-check] [--json]`
 * (L3.4): a browser window opens on the environment's page; the person performs the flow and closes the window (or
 * presses Ctrl-C: stop and keep); a draft scenario is made from it, saved as scenarios/<name>.yaml when the name is free
 * (default recorded-YYYYMMDD-HHMM), then checked by a headless dry replay (a second Ctrl-C stops the check). Typed text
 * goes only to the draft and the recording's folder; this command prints counts, step references and write labels.
 * Exit 1 when nothing was recorded, the draft was not valid, or the check replay failed.
 */
export async function recordCommand(ui: Ui, global: GlobalOptions, projectArg: string, name: string | undefined, opts: RecordCommandOptions, hooks: RecordTestHooks = {}): Promise<ExitCode> {
  if (opts.url !== undefined && (opts.page !== undefined || opts.path !== undefined)) throw new UsageError('--url goes alone (it names the page and the path): leave --page and --path out');
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  if (opts.allowWrites) {
    try {
      checkAllowWrites(project, opts.env);
    } catch (e) {
      if (isAccessError(e)) throw new UsageError(e.message);
      throw e;
    }
  }
  const c = ui.c;
  let actions = 0;
  const recording = () => `${c.red('●')} recording — ${plural(actions, 'action')}; close the window or press Ctrl-C to finish`;
  const interrupt = await onInterrupt(ui, { message: 'stopping the recording: the window closes and what was recorded is kept…' });
  let outcome: RecordOutcome;
  try {
    outcome = await recordScenario(
      ws,
      project,
      {
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.persona !== undefined ? { persona: opts.persona } : {}),
        ...(opts.page !== undefined ? { page: opts.page } : {}),
        ...(opts.path !== undefined ? { path: opts.path } : {}),
        ...(opts.url !== undefined ? { url: opts.url } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(opts.allowWrites ? { allowWrites: true } : {}),
        check: opts.check !== false,
        submittedBy: 'cli',
      },
      {
        queue: workspaceQueue(ws),
        log: (level, msg) => (level === 'warn' || level === 'error' ? ui.warn(msg) : ui.debug(msg)),
        onPhase: (phase) => {
          if (phase === 'preflight') ui.setStatus('checking the session…');
          else if (phase === 'draft') ui.setStatus('making the draft…');
          else if (phase === 'check') {
            // From here a Ctrl-C stops the check replay (the run's own handler); the draft is already kept.
            interrupt.dispose();
            ui.setStatus('checking the draft: a headless dry replay…');
          }
        },
        onOpen: (url) => {
          ui.clearStatus();
          ui.line(`${c.red('●')} a browser window is open on ${url.split(/[?#]/)[0]} — perform the flow, then close the window (or press Ctrl-C) to finish`);
          ui.setStatus(recording());
        },
        onEvent: (e) => {
          if (!ACTIONS.has(e.kind)) return;
          actions++;
          ui.setStatus(recording());
        },
        onCheckProgress: (e) => {
          if (e.type === 'step_end') ui.setStatus(`checking the draft: ${e.scene}.${e.step} ${e.action} ${e.status}`);
        },
        stop: interrupt.signal,
        loginCommand: loginCommandFor(global),
        ...hooks,
      },
    );
  } finally {
    interrupt.dispose();
    ui.clearStatus();
  }
  if (opts.json) {
    ui.result(JSON.stringify(outcome, null, 1));
    return exitOf(outcome);
  }
  printOutcome(ui, global, project.slug, outcome);
  return exitOf(outcome);
}

function exitOf(o: RecordOutcome): ExitCode {
  if (o.not_saved === 'nothing_recorded' || o.not_saved === 'invalid') return EXIT.failure;
  return o.check.status === 'failed' ? EXIT.failure : EXIT.ok;
}

function printOutcome(ui: Ui, global: GlobalOptions, slug: string, o: RecordOutcome): void {
  const c = ui.c;
  const how = o.stop === 'max_duration' ? ' (stopped at the maximum duration)' : o.stop === 'stopped' ? ' (stopped)' : '';
  if (o.not_saved === 'nothing_recorded') {
    ui.error(`nothing recorded${how}: no action was made in the window — no scenario saved`);
    for (const w of o.warnings) ui.warn(w);
    return;
  }
  ui.ok(
    `recorded ${plural(o.counts.actions, 'action')} in ${formatMs(o.ms)}${how} → ${plural(o.stats.scenes, 'scene')}, ${plural(o.stats.steps, 'step')} ${c.dim(`(env ${o.env}, ${o.persona ? `as ${o.persona}` : 'signed out'}, ${o.access})`)}`,
  );
  for (const s of o.scenes) ui.line(`  ${c.dim('scene')} ${s.id.padEnd(16)} ${plural(s.steps, 'step')}${s.opens ? c.dim(' (opens its page)') : ''}`);
  for (const w of o.warnings) ui.warn(w);
  for (const i of o.issues) {
    const at = i.scene !== undefined ? `${i.scene}${i.step !== undefined ? `.${i.step}` : ''}: ` : '';
    if (i.severity === 'error') ui.error(`${at}${i.message}`);
    else if (i.severity === 'warning') ui.warn(`${at}${i.message}`);
    else ui.info(`${at}${i.message}`);
  }
  if (o.writes.total > 0) {
    const where = o.writes.first ? ` — the first sent after step ${o.writes.first.scene}.${o.writes.first.step}` : '';
    ui.warn(
      o.access === 'read-only'
        ? `${plural(o.writes.total, 'write')} stopped or answered by a mock while recording (read-only environment)${where}: the draft notes them`
        : `${plural(o.writes.total, 'write')} reached the product while recording${where} (${o.writes.ambient} not caused by an action): add a setup or reset hook so each take starts from the same data`,
    );
  }
  if (o.saved) ui.ok(`saved ${o.saved.file}`);
  else if (o.not_saved === 'name_taken') ui.warn(`${scenarioRef(o.name)} exists: not saved — the draft is kept in the recording's folder`);
  else if (o.not_saved === 'invalid') ui.error('the draft does not validate: not saved (see the errors above)');
  else if (o.not_saved === 'refused') ui.error('the draft was refused: not saved');
  const k = o.check;
  const scope = k.scope === 'until_write' ? ` (up to ${k.until}, the step before the first write)` : '';
  if (k.status === 'passed') ui.ok(`check replay: ${k.steps_passed}/${k.steps_total} steps passed${scope} — it started from the state the recording left the product in`);
  else if (k.status === 'failed') {
    ui.error(`check replay failed${k.failed_at ? ` at ${k.failed_at.scene}.${k.failed_at.step} (${k.failed_at.action})` : ''}: ${k.steps_passed}/${k.steps_total} steps passed${scope}${k.untrusted ? ` — ${k.untrusted.error}` : ''}`);
  } else if (k.status === 'cancelled') ui.warn('check replay stopped');
  else if (k.reason === 'first_step_writes') ui.info('check replay skipped: the first step already writes');
  else if (k.reason === 'disabled') ui.info('check replay skipped (--no-check)');
  if (o.draft) ui.line(`  ${c.dim('draft')}  ${ui.path(o.draft)}`);
  if (o.saved) ui.line(`  ${c.dim('next')}   ${retakeCommand(global)} run ${slug} ${o.name} --dry`);
}
