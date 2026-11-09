/**
 * `retake sandbox init | up | down | reset | status | logs` (L1.8) and the sandbox side of `retake run`: `--sandbox` (up if
 * needed, health, reset to the seed, then the capture; the sandbox stays up) and a run on a sandbox environment without
 * it (no reset: the sandbox must be up). The work is @retake/sandbox's; these commands print it.
 */
import { join } from 'node:path';
import { resolveEnvironment, sandboxNames } from '@retake/core';
import type { LoadedProject, RunRecord } from '@retake/core';
import type { ResetResult, Sandbox, SandboxLog, SandboxStatus, ServiceStatus } from '@retake/sandbox';
import { ProjectStore, callerOf, fileWriter, hookRunRecorder, personScope, refuseBesideOldHolder, sandboxUpText } from '@retake/engine';
import { EXIT, UsageError, errorMessage } from '../errors.js';
import type { ExitCode } from '../errors.js';
import { onInterrupt } from '../interrupt.js';
import type { Ui } from '../ui.js';
import { formatMs, plural } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

export interface SandboxCommandOptions {
  env?: string;
  /** up: `--no-seed` sets it to false. */
  seed?: boolean;
  json?: boolean;
  lines?: string;
  /** up (docker-compose): build the images first. */
  build?: boolean;
  /** down (docker-compose): remove the volumes too. */
  volumes?: boolean;
  /** reset: run the seed even when a snapshot could be restored. */
  reseed?: boolean;
  /** logs (docker-compose): keep reading. */
  follow?: boolean;
  /** init: write over an existing sandbox folder. */
  force?: boolean;
}

async function sandboxModule() {
  return import('@retake/sandbox');
}

/** The project and its sandbox (`--env`, default the first one declared). */
async function open(global: GlobalOptions, projectArg: string, env: string | undefined): Promise<{ project: LoadedProject; sb: Sandbox }> {
  const project = await openProject(await openWorkspace(global), projectArg);
  const { openSandbox, SandboxError } = await sandboxModule();
  try {
    return { project, sb: openSandbox(project, env) };
  } catch (e) {
    if (e instanceof SandboxError && env !== undefined) throw new UsageError(e.message);
    throw e;
  }
}

/** Sandbox messages on the terminal: warnings always, the rest with --verbose. */
function uiLog(ui: Ui): SandboxLog {
  return (level, msg) => {
    if (level === 'warn') ui.warn(msg);
    else if (level === 'error') ui.error(msg);
    else ui.debug(msg);
  };
}

function exitOf(e: unknown): ExitCode {
  return (e as { code?: string })?.code === 'interrupted' ? EXIT.interrupted : EXIT.failure;
}

/** "console http://localhost:4503 (console.northfield.example) · shop …". */
function pagesLine(project: LoadedProject, env: string): string {
  const resolved = resolveEnvironment(project, env);
  return Object.entries(resolved.pages)
    .map(([k, url]) => `${k} ${url}${resolved.display?.[k] ? ` (${resolved.display[k].replace(/^https:\/\//, '')})` : ''}`)
    .join(' · ');
}

/** "reseed 40 ms · seed 1 step · mailbox emptied" / "snapshot 240 ms · snapshot restored in 212 ms · mailbox emptied". */
function resetText(r: ResetResult): string {
  const parts = [`${r.strategy} ${formatMs(r.ms)}`];
  if (r.snapshot?.action === 'restored') parts.push(`snapshot of ${r.snapshot.database} restored in ${formatMs(r.snapshot.ms)}`);
  else {
    parts.push(`seed ${plural(r.seed.steps, 'step')}${r.seed.steps ? ` (${formatMs(r.seed.ms)})` : ''}`);
    if (r.snapshot) parts.push(`snapshot of ${r.snapshot.database} taken in ${formatMs(r.snapshot.ms)}`);
  }
  if (r.mailbox === 'cleared') parts.push('mailbox emptied');
  if (r.restarted.length) parts.push(`restarted ${r.restarted.join(', ')}`);
  if (r.superseded) parts.push(`${plural(r.superseded, 'pending rollback')} superseded`);
  return parts.join(' · ');
}

/** `--build` / `--volumes` / `--follow` are docker-compose flags: a usage error on a process sandbox. */
function composeOnly(sb: Sandbox, flag: string, why: string): void {
  if (sb.kind !== 'docker-compose') throw new UsageError(`${flag} is for docker-compose sandboxes: sandbox ${sb.env} is provider ${sb.kind} (${why})`);
}

/** Run a lock-holding sandbox call under Ctrl-C: the first signal aborts it (what it started is stopped), a second kills. */
async function interruptible<T>(ui: Ui, sb: Sandbox, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const stop = await onInterrupt(ui, { message: 'interrupted: stopping what this command started…', onQuitSync: () => sb.killStartedSync() });
  try {
    return await fn(stop.signal);
  } finally {
    stop.dispose();
  }
}

export async function sandboxUpCommand(ui: Ui, global: GlobalOptions, projectArg: string, opts: SandboxCommandOptions): Promise<ExitCode> {
  const { project, sb } = await open(global, projectArg, opts.env);
  await refuseBesideOldHolder((await openWorkspace(global)).root, 'sandbox up');
  if (opts.build) composeOnly(sb, '--build', 'its services are programs of this machine');
  const c = ui.c;
  ui.line(`${c.bold(project.slug)} sandbox up ${c.dim(`· ${sb.env} · ${sb.kind}`)}`);
  try {
    const res = await interruptible(ui, sb, (signal) => sb.up({ signal, log: uiLog(ui), recordSeedRun: hookRunRecorder(project.root, callerOf('cli'), { project: project.slug }), seed: opts.seed === false ? 'never' : 'auto', build: opts.build }));
    ui.line(`  ${c.dim('services')}  ${sandboxUpText(res)} ${c.dim(`(${formatMs(res.ms)})`)}`);
    if (res.reset) ui.line(`  ${c.dim('seed')}      ${resetText(res.reset)}`);
    else if (opts.seed === false) ui.line(`  ${c.dim('seed')}      skipped (--no-seed)`);
    ui.line(`  ${c.dim('pages')}     ${pagesLine(project, sb.env)}`);
    ui.ok(`sandbox ${sb.env} is up — retake run ${project.slug} <scenario> --sandbox${sb.env === sandboxNames(project)[0] ? '' : ` --env ${sb.env}`} resets it before each take`);
    return EXIT.ok;
  } catch (e) {
    ui.error(errorMessage(e));
    return exitOf(e);
  }
}

export async function sandboxDownCommand(ui: Ui, global: GlobalOptions, projectArg: string, opts: SandboxCommandOptions): Promise<ExitCode> {
  const { project, sb } = await open(global, projectArg, opts.env);
  if (opts.volumes) composeOnly(sb, '--volumes', 'its data goes with its processes');
  try {
    const res = await interruptible(ui, sb, (signal) => sb.down({ signal, log: uiLog(ui), volumes: opts.volumes }));
    const gone = opts.volumes ? ' · volumes removed (the database and its snapshot: the next up seeds again)' : '';
    if (res.stopped.length) ui.ok(`${project.slug} sandbox ${sb.env} stopped: ${res.stopped.join(', ')}${gone}`);
    else ui.ok(`${project.slug} sandbox ${sb.env} was not running${gone}`);
    return EXIT.ok;
  } catch (e) {
    ui.error(errorMessage(e));
    return exitOf(e);
  }
}

export async function sandboxResetCommand(ui: Ui, global: GlobalOptions, projectArg: string, opts: SandboxCommandOptions): Promise<ExitCode> {
  const { project, sb } = await open(global, projectArg, opts.env);
  await refuseBesideOldHolder((await openWorkspace(global)).root, 'sandbox reset');
  try {
    const res = await interruptible(ui, sb, (signal) => sb.reset({ signal, log: uiLog(ui), reseed: opts.reseed, recordSeedRun: hookRunRecorder(project.root, callerOf('cli'), { project: project.slug }) }));
    ui.ok(`${project.slug} sandbox ${sb.env} reset: ${resetText(res)}`);
    return EXIT.ok;
  } catch (e) {
    ui.error(errorMessage(e));
    return exitOf(e);
  }
}

function since(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toTimeString().slice(0, 8) : `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`;
}

function serviceLine(ui: Ui, s: ServiceStatus): string {
  const c = ui.c;
  const orphan = s.container ? 'no longer in the compose files (the next up or down removes it)' : 'no longer in sandbox.yaml (the next up or down stops it)';
  if (s.state === 'stopped') return `${c.dim('stopped')}${s.container ? ` · container ${s.container}` : ''}${s.orphan ? ` · ${orphan}` : ''}${s.note ? ` · ${s.note}` : ''}`;
  const health = s.healthy === false ? c.yellow(`not healthy: ${s.health}`) : s.healthy ? c.green('healthy') : '';
  const where = s.container ? [`container ${s.container}`, s.docker ? c.dim(s.docker) : ''] : [`pid ${s.pid}`, `since ${since(s.started_at)}`];
  const parts = [s.state === 'running' ? 'running' : c.yellow('starting'), ...where, health];
  if (s.changed) parts.push(c.yellow('changed in sandbox.yaml since it started (down, then up)'));
  if (s.orphan) parts.push(c.yellow(orphan));
  return parts.filter(Boolean).join(' · ');
}

/** `retake sandbox status`: exit 0 when up and healthy, 1 otherwise (scripts). */
export async function sandboxStatusCommand(ui: Ui, global: GlobalOptions, projectArg: string, opts: SandboxCommandOptions): Promise<ExitCode> {
  const { project, sb } = await open(global, projectArg, opts.env);
  const st: SandboxStatus = await sb.status();
  if (opts.json) {
    ui.result(JSON.stringify({ project: project.slug, ...st, pages: resolveEnvironment(project, sb.env).pages }, null, 2));
    return st.state === 'up' ? EXIT.ok : EXIT.failure;
  }
  const c = ui.c;
  const stateText = st.state === 'up' ? c.green('up') : st.state === 'down' ? c.dim('down') : c.yellow('partial');
  ui.line(`${c.bold(project.slug)} sandbox ${c.bold(sb.env)} ${c.dim(`· ${st.provider} ·`)} ${stateText}`);
  const width = Math.max(9, ...st.services.map((s) => s.name.length + 1));
  for (const s of st.services) {
    ui.line(`  ${s.name.padEnd(width)} ${serviceLine(ui, s)}`);
    if (s.command && s.state !== 'stopped') ui.line(`  ${' '.repeat(width)} ${c.dim(s.command)}`);
  }
  ui.line(`  ${c.dim('pages'.padEnd(width))} ${pagesLine(project, sb.env)}`);
  ui.line(`  ${c.dim('seed'.padEnd(width))} ${st.seed ? `${st.seed.hash} · ${since(st.seed.at)}${st.seed.current ? '' : c.yellow(' · sandbox.yaml\'s seed changed since (the next up or reset seeds again)')}` : c.dim('never seeded')}`);
  if (st.last_reset) ui.line(`  ${c.dim('reset'.padEnd(width))} ${st.last_reset.strategy} · ${since(st.last_reset.at)} · ${formatMs(st.last_reset.ms)} · by ${st.last_reset.by}`);
  const { describeLock } = await sandboxModule();
  ui.line(`  ${c.dim('lock'.padEnd(width))} ${st.lock ? c.yellow(`in use: ${describeLock(st.lock)}`) : 'free'}`);
  ui.line(`  ${c.dim('logs'.padEnd(width))} ${ui.path(st.logs)}`);
  for (const n of st.notes) ui.warn(n);
  if (st.state !== 'up') ui.line(c.dim(`  → retake sandbox up ${project.slug}${sb.env === sandboxNames(project)[0] ? '' : ` --env ${sb.env}`}`));
  return st.state === 'up' ? EXIT.ok : EXIT.failure;
}

export async function sandboxLogsCommand(ui: Ui, global: GlobalOptions, projectArg: string, service: string | undefined, opts: SandboxCommandOptions): Promise<ExitCode> {
  const lines = opts.lines === undefined ? 50 : Number(opts.lines);
  if (!Number.isInteger(lines) || lines < 1) throw new UsageError(`--lines must be a positive whole number, got "${opts.lines}"`);
  const { sb } = await open(global, projectArg, opts.env);
  const { SandboxError } = await sandboxModule();
  if (opts.follow) {
    composeOnly(sb, '--follow', `its logs are files: tail -f ${ui.path(sb.paths.logs)}/<service>.log`);
    const stop = await onInterrupt(ui, { message: 'stopped following the logs' });
    try {
      await sb.followLogs({ service, lines, signal: stop.signal, write: (line) => ui.result(line) });
    } catch (e) {
      if (e instanceof SandboxError && /^unknown service/.test(e.message)) throw new UsageError(e.message);
      ui.error(errorMessage(e));
      return EXIT.failure;
    } finally {
      stop.dispose();
    }
    return EXIT.ok;
  }
  let logs;
  try {
    logs = await sb.logs({ service, lines });
  } catch (e) {
    if (e instanceof SandboxError && /^unknown service/.test(e.message)) throw new UsageError(e.message);
    ui.error(errorMessage(e));
    return EXIT.failure;
  }
  for (const l of logs) {
    const where = l.source ?? `${ui.path(l.file)}${l.exists ? '' : ' (no log yet: the service has not been started)'}`;
    ui.line(ui.c.dim(`── ${l.service} · ${where}`));
    if (l.text) ui.result(l.text);
  }
  return EXIT.ok;
}

/** `retake sandbox init`: a docker-compose sandbox scaffold in the project, declared in project.yaml. */
export async function sandboxInitCommand(ui: Ui, global: GlobalOptions, projectArg: string, opts: SandboxCommandOptions): Promise<ExitCode> {
  const project = await openProject(await openWorkspace(global), projectArg);
  const { initSandbox, SandboxError } = await sandboxModule();
  let res;
  try {
    res = await initSandbox(project, { env: opts.env, force: opts.force, write: fileWriter(ProjectStore.of(project, personScope(project.root)), 'sandbox') });
  } catch (e) {
    if (e instanceof SandboxError) throw new UsageError(e.message);
    throw e;
  }
  // The result must load as written: the project with its new sandbox.
  const { loadProject } = await import('@retake/core');
  const reloaded = await loadProject(project.dir);
  const warnings = reloaded.sandboxes?.[res.env]?.issues ?? [];
  const envFlag = sandboxNames(reloaded)[0] === res.env ? '' : ` --env ${res.env}`;
  if (opts.json) {
    ui.result(JSON.stringify({ project: project.slug, ...res, warnings }, null, 2));
    return EXIT.ok;
  }
  const c = ui.c;
  ui.line(`${c.bold(project.slug)} sandbox init ${c.dim(`· ${res.env} · docker-compose`)}`);
  for (const f of res.files) ui.line(`  ${c.dim('wrote')}     ${ui.path(f)}`);
  ui.line(`  ${c.dim('project')}   ${ui.path(project.file)}: ${res.projectYaml === 'added' ? `sandboxes.${res.env} added` : `sandboxes.${res.env} already there`}`);
  ui.line(`  ${c.dim('ports')}     app ${res.ports.app} · Postgres ${res.ports.db} · Mailpit ${res.ports.mailpit} (127.0.0.1)`);
  for (const w of warnings) ui.warn(ui.issue(w, res.manifest));
  ui.ok(`sandbox ${res.env} scaffolded — try it: retake sandbox up ${project.slug}${envFlag}; then put your application in it (${ui.path(join(res.dir, 'README.md'))})`);
  return EXIT.ok;
}

// ── retake run ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The run summary's sandbox line, or undefined. */
export function sandboxSummary(r: RunRecord): string | undefined {
  const s = r.environment?.sandbox;
  if (!s) return undefined;
  if (!s.strategy) return `${s.name} (${s.provider}) · no reset before the take (run without --sandbox)`;
  return `${s.name} (${s.provider}) · reset (${s.strategy}${s.restored ? ', snapshot restored' : ''}) ${formatMs(s.reset_ms ?? 0)} before the take · seed ${s.seed_hash ?? '?'}`;
}
