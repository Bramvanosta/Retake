import { JSON_SCHEMAS, resolveEnvironment } from '@demo-studio/core';
import type { JsonSchemaName } from '@demo-studio/core';
import { CliError, EXIT } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

export const SCHEMA_NAMES = ['scenario', 'project', 'template', 'timeline'] as const satisfies readonly JsonSchemaName[];

/** `studio schema [name]`: the JSON Schema on stdout (for editors and agents). */
export function schemaCommand(ui: Ui, name: JsonSchemaName): ExitCode {
  ui.result(JSON.stringify(JSON_SCHEMAS[name](), null, 2));
  return EXIT.ok;
}

export interface LoginOptions {
  env?: string;
  page?: string;
  url?: string;
}

/** `studio login <project>`: a headed browser on the project's persistent profile, to sign in once. */
export async function loginCommand(ui: Ui, global: GlobalOptions, projectArg: string, opts: LoginOptions): Promise<ExitCode> {
  const project = await openProject(await openWorkspace(global), projectArg);
  const { openLoginBrowser, resolveAuth } = await import('@demo-studio/runner-web');
  const env = resolveEnvironment(project, opts.env);
  if (!resolveAuth(project, env.name).profileDir) {
    throw new CliError(
      `project "${project.slug}" has no browser profile for environment "${env.name}": add auth: {profile: ~/.demo-studio/profiles/${project.slug}} to project.yaml (or auth.${env.name}.profile)`,
    );
  }
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new CliError('studio login opens a browser window and no display is available (DISPLAY / WAYLAND_DISPLAY are not set)');
  }
  ui.line(`opening a browser on the profile of ${ui.c.bold(project.slug)} — sign in, then close the window`);
  const res = await openLoginBrowser({ project, env: env.name, page: opts.page, url: opts.url });
  ui.ok(`profile saved: ${ui.path(res.profileDir)} (runs of ${project.slug} reuse it headless)`);
  return EXIT.ok;
}

/** Commands of later phases: registered so `studio --help` lists them, they only say when they arrive. */
export const LATER_COMMANDS: ReadonlyArray<{ name: string; phase: 2 | 3 | 4; summary: string }> = [
  { name: 'render', phase: 2, summary: 'edit a capture into a finished video (theme, components, captions)' },
  { name: 'review', phase: 2, summary: 'contact sheets, key frames and a report of a render' },
  { name: 'export', phase: 2, summary: 'export a render (4K, webm, vertical 9:16, gif preview)' },
  { name: 'record', phase: 3, summary: 'record a draft scenario by clicking through a site' },
  { name: 'mcp', phase: 3, summary: 'MCP server so a Claude session can drive Demo Studio' },
  { name: 'ui', phase: 4, summary: 'Studio web app (scenario blocks, timeline, frame comments)' },
];

export function laterCommand(ui: Ui, name: string, phase: number): ExitCode {
  ui.error(`studio ${name} is available in phase ${phase}; available now: new, list, validate, run, hooks, env reset, components, schema, login and doctor`);
  return EXIT.failure;
}
