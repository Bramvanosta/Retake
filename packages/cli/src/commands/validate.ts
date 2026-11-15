import { errorsOf, warningsOf } from '@retake/core/base';
import { projectLoadReport, validateProjectFiles } from '@retake/engine/shell';
import type { FileValidation, OpenedWorkspace } from '@retake/engine';
import type { ValidationIssue } from '@retake/core/base';
import { EXIT } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { plural } from '../ui.js';
import { openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

export interface ValidateOptions {
  env?: string;
  until?: string;
  json?: boolean;
}

export function printIssues(ui: Ui, issues: readonly ValidationIssue[], file?: string): void {
  for (const i of issues) ui.line(`  ${ui.issue(i, file)}`);
}

/**
 * `retake validate <project> [scenario|file]`: project.yaml, its sandboxes' sandbox.yaml, the project template
 * and the scenario (or every scenario when none is given). Prints `file:line:col severity path: message`; exit 1 when
 * any error.
 */
export async function validateCommand(ui: Ui, global: GlobalOptions, projectArg: string, scenarioArg: string | undefined, opts: ValidateOptions): Promise<ExitCode> {
  let ws: OpenedWorkspace;
  try {
    ws = await openWorkspace(global);
  } catch (e) {
    return finish(ui, [projectLoadReport(projectArg, e)], opts);
  }
  return finish(ui, await validateProjectFiles(ws, projectArg, scenarioArg, { env: opts.env, until: opts.until }), opts);
}

function finish(ui: Ui, reports: FileValidation[], opts: ValidateOptions): ExitCode {
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
    const counts = [errors ? c.red(plural(errors, 'error')) : '', warnings ? c.yellow(plural(warnings, 'warning')) : ''].filter(Boolean).join(', ');
    ui.line(`${errors ? c.red('✗') : c.green('✓')} ${label}${r.file ? c.dim(` ${ui.path(r.file)}`) : ''}${counts ? `  ${counts}` : ''}`);
    printIssues(ui, r.issues, r.file);
  }
  if (reports.filter((r) => r.kind === 'scenario').length === 0 && !failed) ui.warn('the project has no scenarios yet (scenarios/<name>.yaml)');
  return failed ? EXIT.failure : EXIT.ok;
}
