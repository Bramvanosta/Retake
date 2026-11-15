/**
 * `retake validate <project> [scenario]`: the files of a project checked — its project.yaml, its sandboxes'
 * sandbox.yaml, its theme and its scenarios (one, or every one) — each as a report of its issues, or of the failure
 * that is not a list of issues (a file not found, unreadable…). Read through the workspace's WorkspaceReads; a shell
 * prints the reports and turns an error into its exit code.
 */
import { ConfigError, errorMessage } from '@retake/core/base';
import { SandboxConfigError } from '@retake/core/sandbox';
import { ScenarioError, parseScenario } from '@retake/core/scenario';
import type { LoadedProject } from '@retake/core/project';
import type { Template } from '@retake/core/theme';
import type { ValidationIssue } from '@retake/core/base';
import type { WorkFileFacts } from '@retake/core/model';
import type { OpenedWorkspace } from './workspace.js';
import { openProject } from './workspace.js';

/** One file's report. */
export interface FileValidation {
  kind: 'project' | 'sandbox' | 'template' | 'scenario';
  name: string;
  file?: string;
  issues: ValidationIssue[];
  /** A failure that is not a list of issues (file not found, unreadable…). */
  error?: string;
}

export interface FileValidationOptions {
  /** Check the scenarios' page keys against this environment. */
  env?: string;
  /** Check that this step reference resolves. */
  until?: string;
}

/** A workspace or a project that does not load: the project's report (a broken sandbox.yaml under its own file). */
export function projectLoadReport(projectArg: string, e: unknown): FileValidation {
  const issues = e instanceof ConfigError ? e.issues : [];
  const sandbox = e instanceof SandboxConfigError ? e.env : undefined;
  return {
    kind: sandbox !== undefined ? 'sandbox' : 'project',
    name: sandbox ?? projectArg,
    file: e instanceof ConfigError ? e.file : undefined,
    issues,
    ...(issues.length ? {} : { error: errorMessage(e) }),
  };
}

/** The reports of a project's files, in order: the project, its sandboxes, its theme, then each scenario (`scenario`, else all). */
export async function validateProjectFiles(ws: OpenedWorkspace, projectArg: string, scenario: string | undefined, opts: FileValidationOptions = {}): Promise<FileValidation[]> {
  const files = ws.reads.fileFacts(ws.policy);
  let project: LoadedProject;
  try {
    project = await openProject(ws, projectArg);
  } catch (e) {
    return [projectLoadReport(projectArg, e)];
  }
  const reports: FileValidation[] = [{ kind: 'project', name: project.slug, file: project.file, issues: project.issues ?? [] }];
  for (const s of Object.values(project.sandboxes ?? {})) reports.push({ kind: 'sandbox', name: s.env, file: s.file, issues: s.issues });

  let template: Template | undefined;
  try {
    template = (await ws.reads.loadProjectTemplate(project, undefined, { files })).template;
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

  const names = scenario !== undefined ? [scenario] : project.scenarios;
  for (const name of names) reports.push(await validateScenarioFile(ws, project, name, { ...opts, template }, files));
  return reports;
}

async function validateScenarioFile(ws: OpenedWorkspace, project: LoadedProject, name: string, opts: FileValidationOptions & { template?: Template }, files: WorkFileFacts): Promise<FileValidation> {
  try {
    const loaded = await ws.reads.loadScenario(project, name, { files, env: opts.env, until: opts.until, template: opts.template });
    return { kind: 'scenario', name: loaded.name, file: loaded.file, issues: loaded.issues };
  } catch (e) {
    if (e instanceof ScenarioError && e.file) {
      // The loader reports errors only: the file parsed again lists the warnings too.
      const text = await ws.reads.disk.readFile(e.file).then(
        (b) => b.toString('utf8'),
        () => null,
      );
      const issues = text === null ? e.issues : parseScenario(text, { files, file: e.file, project, env: opts.env, until: opts.until, template: opts.template }).issues;
      return { kind: 'scenario', name, file: e.file, issues };
    }
    return { kind: 'scenario', name, issues: [], error: errorMessage(e) };
  }
}
