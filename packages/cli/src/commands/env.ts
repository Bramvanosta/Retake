/**
 * `retake env add | set | remove`: the environments of an existing project.yaml (R-ENV-06), written through the engine's
 * façade (`projects.setEnvironment` / `removeEnvironment`, client `cli`) — only the environment's node and `default_env`
 * change. A person's
 * command is their own act: nothing is asked; a page of a read-write environment on a production or read-only host is
 * written with a warning. Refused: a sandbox environment, a result project.yaml with errors.
 */
import { resolve } from 'node:path';
import { EngineError, createEngine } from '@retake/engine';
import type { Engine } from '@retake/engine';
import type { EnvironmentChange, EnvironmentPageInput } from '@retake/core/project';
import { EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { showHiddenCharsLine as printable } from '@retake/core/base';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

type EnvironmentChangeView = Awaited<ReturnType<Engine['projects']['setEnvironment']>>;
type EnvironmentChangeRequest = { mode: 'add' | 'set'; env: string; change: EnvironmentChange } | { mode: 'remove'; env: string };

export interface EnvEditOptions {
  /** Repeatable: "key=url" or "key=url,display=host". */
  page?: string[];
  /** Repeatable page keys (env set). */
  removePage?: string[];
  /** --production / --no-production. */
  production?: boolean;
  readOnly?: boolean;
  readWrite?: boolean;
  /** --default / --no-default. */
  default?: boolean;
  json?: boolean;
}

/** `--page key=url[,display=host]` values as pages. */
export function parsePageOptions(values: readonly string[]): Record<string, EnvironmentPageInput> {
  const out: Record<string, EnvironmentPageInput> = {};
  for (const value of values) {
    const m = /^([^=,\s]+)=(\S+?)(?:,display=(\S+))?$/.exec(value.trim());
    if (!m || !/^https?:\/\//i.test(m[2])) throw new UsageError(`--page "${value}": expected key=url or key=url,display=host (e.g. app=https://app.staging.example.com)`);
    if (Object.hasOwn(out, m[1])) throw new UsageError(`--page ${m[1]} is given twice`);
    out[m[1]] = m[3] !== undefined ? { url: m[2], display: m[3] } : m[2];
  }
  return out;
}

function changeOf(opts: EnvEditOptions): EnvironmentChange {
  if (opts.readOnly && opts.readWrite) throw new UsageError('--read-only and --read-write: give one');
  return {
    ...(opts.page?.length ? { pages: parsePageOptions(opts.page) } : {}),
    ...(opts.removePage?.length ? { remove_pages: opts.removePage } : {}),
    ...(opts.production !== undefined ? { production: opts.production } : {}),
    ...(opts.readOnly ? { access: 'read-only' as const } : opts.readWrite ? { access: 'read-write' as const } : {}),
    ...(opts.default !== undefined ? { default: opts.default } : {}),
  };
}

function print(ui: Ui, r: EnvironmentChangeView, json: boolean | undefined): void {
  if (json) {
    ui.result(JSON.stringify(r, null, 2));
    return;
  }
  const c = ui.c;
  ui.line(`${c.bold(r.project)} env ${r.env} ${c.dim(`· ${r.file}`)}`);
  for (const l of r.lines) ui.line(`  ${l}`);
  for (const w of r.warnings) ui.warn(w);
  if (r.removed?.scenarios.length) ui.warn(`scenarios still naming ${r.env} in env: ${r.removed.scenarios.join(', ')} (they no longer run until changed)`);
  if (r.removed?.sessions) ui.line(`  ${c.dim('sessions')}  saved sessions of ${r.env} stay in the Retake home (${(r.untrusted?.sessions ?? []).map(printable).join(', ')}): ${r.removed.remove_sessions ?? ''}`);
  if (r.readme_environments) ui.line(`  ${c.dim('README')}    "Environments & links" no longer matches the environments: update it`);
  ui.ok(r.action === 'unchanged' ? 'nothing to change' : `project.yaml written (default environment: ${r.default_env.after ?? 'none'})`);
}

async function run(ui: Ui, global: GlobalOptions, projectArg: string, req: EnvironmentChangeRequest, json: boolean | undefined): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  const engine = await createEngine({ root: resolve(ws.root), client: 'cli', autoStartWorker: false, ports: global.ports });
  let r: EnvironmentChangeView;
  try {
    r =
      req.mode === 'remove'
        ? await engine.projects.removeEnvironment(project.slug, req.env)
        : await engine.projects.setEnvironment(project.slug, req.env, req.change, { mode: req.mode });
  } catch (e) {
    if (e instanceof EngineError && (e.code === 'invalid' || e.code === 'not_found' || e.code === 'conflict')) throw new UsageError(e.message);
    throw e;
  }
  print(ui, r, json);
  return EXIT.ok;
}

/** `retake env add <project> <env>`: a new environment (refuses an existing one). */
export function envAddCommand(ui: Ui, global: GlobalOptions, projectArg: string, env: string, opts: EnvEditOptions): Promise<ExitCode> {
  if (!opts.page?.length) throw new UsageError('env add needs its pages: --page key=url (repeatable)');
  if (opts.removePage?.length) throw new UsageError('--remove-page is for env set');
  return run(ui, global, projectArg, { mode: 'add', env, change: changeOf(opts) }, opts.json);
}

/** `retake env set <project> <env>`: change an environment (refuses a missing one). */
export function envSetCommand(ui: Ui, global: GlobalOptions, projectArg: string, env: string, opts: EnvEditOptions): Promise<ExitCode> {
  return run(ui, global, projectArg, { mode: 'set', env, change: changeOf(opts) }, opts.json);
}

/** `retake env remove <project> <env>`. */
export function envRemoveCommand(ui: Ui, global: GlobalOptions, projectArg: string, env: string, opts: Pick<EnvEditOptions, 'json'>): Promise<ExitCode> {
  return run(ui, global, projectArg, { mode: 'remove', env }, opts.json);
}
