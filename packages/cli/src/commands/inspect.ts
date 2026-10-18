import { resolve } from 'node:path';
import { InspectTargetSchema, parseYaml, resolveEnvironment } from '@demo-studio/core';
import type { TargetSpec } from '@demo-studio/core';
import { INSPECT_KEEP, appendHistory, inspectRoot, newInspectId, pageOfUrl, prepareInspect, pruneInspections, runInspection } from '@demo-studio/engine';
import type { InspectSourceDraft } from '@demo-studio/engine';
import { EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { plural } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';
import { loginCommandFor } from './auth.js';

export interface InspectCommandOptions {
  env?: string;
  path?: string;
  until?: string;
  persona?: string;
  within?: string;
  target?: string[];
  limit?: string;
  images?: 'marked' | 'none';
  json?: boolean;
  out?: string;
}

/** A target given on the command line: YAML (`{role: button, name: Save}`), else the plain string. */
function targetArg(flag: string, text: string): TargetSpec {
  let value: unknown = parseYaml(text).value ?? text;
  if (typeof value !== 'string' && (value === null || typeof value !== 'object')) value = text;
  const parsed = InspectTargetSchema.safeParse(value);
  if (!parsed.success) throw new UsageError(`${flag} ${JSON.stringify(text)}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  return parsed.data;
}

/**
 * `studio inspect <project> <page|scenario|url>` (L3.3): replay a page (an environment page key, with --path, or a URL
 * of one of the environment's origins) or a saved scenario (up to --until) as a dry run, then list the page's visible
 * interactive elements with a target the runner resolves to each — what page_inspect gives an MCP client, in a
 * terminal. The files go to <project>/.demo-studio/inspect/<id>/ (or --out). Exit 1 unless the page was inspected.
 */
export async function inspectCommand(ui: Ui, global: GlobalOptions, projectArg: string, what: string, opts: InspectCommandOptions): Promise<ExitCode> {
  const limit = opts.limit === undefined ? undefined : Number(opts.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 300)) throw new UsageError(`--limit must be a whole number from 1 to 300, got "${opts.limit}"`);
  const within = opts.within !== undefined ? targetArg('--within', opts.within) : undefined;
  const targets = (opts.target ?? []).map((t) => targetArg('--target', t));
  if (targets.length > 20) throw new UsageError('at most 20 --target');
  const ws = await openWorkspace(global);
  const project = await openProject(ws, projectArg);
  const env = resolveEnvironment(project, opts.env);
  let source: InspectSourceDraft;
  if (/^[a-z][a-z0-9+.-]*:/i.test(what)) {
    if (opts.until !== undefined || opts.path !== undefined) throw new UsageError('--until and --path do not go with a URL');
    source = { kind: 'page', ...pageOfUrl(what, env.pages, env.name), ...(opts.persona !== undefined ? { persona: opts.persona } : {}) };
  } else if (opts.until === undefined && Object.hasOwn(env.pages, what)) {
    source = { kind: 'page', page: what, path: opts.path ?? '/', ...(opts.persona !== undefined ? { persona: opts.persona } : {}) };
  } else if (project.scenarios.includes(what)) {
    if (opts.path !== undefined || opts.persona !== undefined) throw new UsageError('--path and --persona go with a page (a scenario names its own pages and personas)');
    source = { kind: 'scenario', scenario: what, ...(opts.until !== undefined ? { until: opts.until } : {}) };
  } else if (Object.hasOwn(env.pages, what)) {
    throw new UsageError(`"${what}" is a page of environment ${env.name}: --until goes with a scenario (the step to stop at); a page takes --path`);
  } else {
    throw new UsageError(
      `"${what}" is neither a page of environment ${env.name} (${Object.keys(env.pages).join(', ') || 'none'}) nor a scenario of ${project.slug} (${project.scenarios.join(', ') || 'none'})`,
    );
  }
  const prepared = await prepareInspect(ws, project, source, opts.env);
  const runsDir = opts.out !== undefined ? resolve(opts.out) : inspectRoot(project);
  const id = newInspectId();
  if (!opts.json) ui.setStatus(`inspecting ${source.kind === 'page' ? `page ${source.page} ${source.path}` : `scenario ${source.scenario}${source.until ? ` until ${source.until}` : ''}`} on ${prepared.env}…`);
  const started = Date.now();
  let run;
  try {
    run = await runInspection({
      prepared,
      runsDir,
      id,
      ...(within !== undefined ? { within } : {}),
      ...(targets.length ? { targets } : {}),
      ...(limit !== undefined ? { limit } : {}),
      images: opts.images ?? 'marked',
      loginCommand: loginCommandFor(global),
    });
  } finally {
    ui.clearStatus();
  }
  if (opts.out === undefined) await pruneInspections(project, INSPECT_KEEP, [id], ws.root);
  const r = run.report;
  await appendHistory(ws.root, {
    kind: 'inspect',
    project: project.slug,
    submitted_by: 'cli',
    state: run.record.status === 'cancelled' ? 'cancelled' : 'succeeded',
    ms: Date.now() - started,
    inspect: { id, source: source.kind, status: r ? r.status : 'failed', reported: r !== null },
    counted: { captures: 0, dry_runs: 0, renders: 0 },
  });
  if (opts.json) {
    ui.result(JSON.stringify(r ? { ...r, marked: run.marked } : { reported: false, run_status: run.record.status, dir: run.record.dir, ...(run.signIn ? { sign_in: run.signIn } : {}), error: run.record.error?.message ?? null }, null, 1));
    return r?.status === 'ok' ? EXIT.ok : EXIT.failure;
  }
  if (!r) {
    ui.error(`not inspected: the replay ended first (${run.record.status})${run.record.error ? `: ${run.record.error.message}` : ''}`);
    return EXIT.failure;
  }
  const c = ui.c;
  if (r.replay.failed) ui.warn(`the replay failed at ${r.replay.failed.scene}.${r.replay.failed.step} (${r.replay.failed.action}): inspected there — ${r.untrusted.error ?? ''}`);
  if (r.status === 'landed_elsewhere') {
    ui.error(`the page ended on another origin (${r.untrusted.landed_host ?? '?'}): nothing of it was taken`);
    return EXIT.failure;
  }
  if (r.status === 'failed') {
    ui.error(`inspection failed: ${r.untrusted.error ?? 'unknown error'}`);
    return EXIT.failure;
  }
  ui.line(`${c.bold(r.untrusted.title || r.untrusted.url)} ${c.dim(r.untrusted.url)}`);
  for (const p of r.popups) ui.line(`${c.yellow('▣')} ${p.kind} open${p.untrusted.name ? `: ${p.untrusted.name}` : ''}`);
  for (const e of r.elements) {
    const t = e.untrusted.target_yaml ?? c.dim('(no verified target)');
    const flags = [e.in !== 'page' ? `in ${e.in}` : '', e.in_view ? '' : 'below the fold', e.fragile.length ? `fragile: ${e.fragile.join(',')}` : '', e.matches > 1 ? `${e.matches} matches` : '', e.state.disabled ? 'disabled' : '', e.state.covered ? 'covered (not marked)' : ''].filter(Boolean).join(' · ');
    ui.line(`${String(e.mark).padStart(3)}  ${e.action.padEnd(9)} ${t}${flags ? `  ${c.dim(flags)}` : ''}`);
  }
  for (const t of r.targets_checked) ui.line(`${c.dim(`target ${t.index + 1}:`)} ${t.count === 1 ? c.green('1 match') : c.red(`${t.count} matches`)} ${c.dim(t.untrusted.desc)}`);
  for (const w of r.untrusted.warnings) ui.warn(w);
  const k = r.counts;
  ui.line();
  ui.line(
    `${plural(k.interactive, 'interactive element')} (${k.listed} listed, ${k.in_view} in view, ${k.suggested} with a verified target, ${k.ambiguous} by position) ${c.dim('·')} ${run.marked ?? r.screenshot ?? ''} ${c.dim('·')} ${r.file}`,
  );
  return EXIT.ok;
}

