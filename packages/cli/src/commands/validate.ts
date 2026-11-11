import { readFile } from 'node:fs/promises';
import { ConfigError, SandboxConfigError, ScenarioError, errorsOf, parseScenario, warningsOf } from '@retake/core';
import { fileFacts, loadProjectTemplate, loadScenario } from '@retake/core/io';
import type { LoadedProject, Template, ValidationIssue, WorkFileFacts } from '@retake/core';
import { EXIT, errorMessage } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { plural } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

export interface ValidateOptions {
  env?: string;
  until?: string;
  json?: boolean;
}

interface FileReport {
  kind: 'project' | 'sandbox' | 'template' | 'scenario';
  name: string;
  file?: string;
  issues: ValidationIssue[];
  /** A failure that is not a list of issues (file not found, unreadable…). */
  error?: string;
}

export function printIssues(ui: Ui, issues: readonly ValidationIssue[], file?: string): void {
  for (const i of issues) ui.line(`  ${ui.issue(i, file)}`);
}

/**
 * `retake validate <project> [scenario|file]`: project.yaml, its sandboxes' sandbox.yaml (L1.8), the project template
 * and the scenario (or every scenario when none is given). Prints `file:line:col severity path: message`; exit 1 when
 * any error.
 */
export async function validateCommand(
  ui: Ui,
  global: GlobalOptions,
  projectArg: string,
  scenarioArg: string | undefined,
  opts: ValidateOptions,
): Promise<ExitCode> {
  const reports: FileReport[] = [];
  let project: LoadedProject;
  let files: WorkFileFacts;
  try {
    const ws = await openWorkspace(global);
    files = fileFacts(ws.policy);
    project = await openProject(ws, projectArg);
  } catch (e) {
    const issues = e instanceof ConfigError ? e.issues : [];
    // A broken sandbox.yaml (L1.8) is reported under its own file.
    const sandbox = e instanceof SandboxConfigError ? e.env : undefined;
    reports.push({
      kind: sandbox !== undefined ? 'sandbox' : 'project',
      name: sandbox ?? projectArg,
      file: e instanceof ConfigError ? e.file : undefined,
      issues,
      ...(issues.length ? {} : { error: errorMessage(e) }),
    });
    return finish(ui, reports, opts);
  }
  reports.push({ kind: 'project', name: project.slug, file: project.file, issues: project.issues ?? [] });
  for (const s of Object.values(project.sandboxes ?? {})) reports.push({ kind: 'sandbox', name: s.env, file: s.file, issues: s.issues });

  let template: Template | undefined;
  try {
    template = (await loadProjectTemplate(project, undefined, { files })).template;
    reports.push({ kind: 'template', name: project.config.template, issues: [] });
  } catch (e) {
    const issues = e instanceof ConfigError ? e.issues : [];
    reports.push({
      kind: 'template',
      name: project.config.template,
      file: e instanceof ConfigError ? e.file : undefined,
      issues,
      ...(issues.length ? {} : { error: errorMessage(e) }),
    });
  }

  const names = scenarioArg !== undefined ? [scenarioArg] : project.scenarios;
  for (const name of names) reports.push(await validateScenarioFile(project, name, { ...opts, template }, files));
  return finish(ui, reports, opts);
}

async function validateScenarioFile(
  project: LoadedProject,
  name: string,
  opts: ValidateOptions & { template?: Template },
  files: WorkFileFacts,
): Promise<FileReport> {
  try {
    const loaded = await loadScenario(project, name, { files, env: opts.env, until: opts.until, template: opts.template });
    return { kind: 'scenario', name: loaded.name, file: loaded.file, issues: loaded.issues };
  } catch (e) {
    if (e instanceof ScenarioError && e.file) {
      // loadScenario only reports errors: re-parse to list the warnings too.
      const text = await readFile(e.file, 'utf8').catch(() => null);
      const issues =
        text === null
          ? e.issues
          : parseScenario(text, { files, file: e.file, project, env: opts.env, until: opts.until, template: opts.template }).issues;
      return { kind: 'scenario', name, file: e.file, issues };
    }
    return { kind: 'scenario', name, issues: [], error: errorMessage(e) };
  }
}

function finish(ui: Ui, reports: FileReport[], opts: ValidateOptions): ExitCode {
  const failed = reports.some((r) => r.error !== undefined || errorsOf(r.issues).length > 0);
  if (opts.json) {
    ui.result(JSON.stringify({ ok: !failed, files: reports }, null, 2));
    return failed ? EXIT.failure : EXIT.ok;
  }
  const c = ui.c;
  for (const r of reports) {
    const errors = errorsOf(r.issues).length;
    const warnings = warningsOf(r.issues).length;
    const label = `${r.kind} ${c.bold(r.name)}`;
    if (r.error !== undefined) {
      ui.line(`${c.red('✗')} ${label}: ${c.red(r.error)}`);
      continue;
    }
    const counts = [errors ? c.red(plural(errors, 'error')) : '', warnings ? c.yellow(plural(warnings, 'warning')) : '']
      .filter(Boolean)
      .join(', ');
    ui.line(`${errors ? c.red('✗') : c.green('✓')} ${label}${r.file ? c.dim(` ${ui.path(r.file)}`) : ''}${counts ? `  ${counts}` : ''}`);
    printIssues(ui, r.issues, r.file);
  }
  if (reports.filter((r) => r.kind === 'scenario').length === 0 && !failed) ui.warn('the project has no scenarios yet (scenarios/<name>.yaml)');
  return failed ? EXIT.failure : EXIT.ok;
}
