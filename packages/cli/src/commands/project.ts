import { createProject, listProjects, listTemplates } from '@demo-studio/core';
import type { ProjectConfig } from '@demo-studio/core';
import { EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { plural } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

export interface NewOptions {
  name?: string;
  template?: string;
  /** Repeatable: "staging=console:https://console.staging.example.com,shop:https://shop.staging.example.com". */
  env?: string[];
}

/** Parse `--env name=key:url,key:url` values into project environments. */
export function parseEnvOptions(values: readonly string[]): ProjectConfig['environments'] {
  const out: ProjectConfig['environments'] = {};
  for (const value of values) {
    const eq = value.indexOf('=');
    if (eq <= 0) throw new UsageError(`--env "${value}": expected name=key:url[,key:url…]`);
    const name = value.slice(0, eq).trim();
    const pages: Record<string, string> = {};
    for (const item of value.slice(eq + 1).split(',')) {
      const colon = item.indexOf(':');
      const key = colon > 0 ? item.slice(0, colon).trim() : '';
      const url = colon > 0 ? item.slice(colon + 1).trim() : '';
      if (!key || !/^https?:\/\//i.test(url)) {
        throw new UsageError(`--env "${value}": "${item}" is not key:url (e.g. app:https://app.staging.example.com)`);
      }
      pages[key] = url;
    }
    out[name] = { ...out[name], ...pages };
  }
  return out;
}

export async function newCommand(ui: Ui, global: GlobalOptions, slug: string, opts: NewOptions): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const environments = parseEnvOptions(opts.env ?? []);
  const project = await createProject(ws.root, {
    name: opts.name ?? slug,
    slug,
    template: opts.template,
    environments,
  });
  const c = ui.c;
  ui.ok(`created project ${c.bold(project.slug)} in ${ui.path(project.dir)}`);
  ui.line(c.dim('  README.md     what the product is, audience, goals, tone, accounts (by reference)'));
  ui.line(c.dim('  project.yaml  environments, capture size, template, auth profile'));
  ui.line(c.dim('  scenarios/    one <name>.yaml per video'));
  ui.line(c.dim('  hooks/        sql / http / js / sh files used by setup and teardown'));
  if (Object.keys(environments).length === 0) ui.warn('no environment yet: add one under `environments:` in project.yaml');
  ui.line(`next: write scenarios/<name>.yaml, then ${c.bold(`studio validate ${project.slug} <name>`)}`);
  return EXIT.ok;
}

export async function listCommand(ui: Ui, global: GlobalOptions, opts: { json?: boolean }): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const projects = await listProjects(ws.root);
  const templates = await listTemplates(ws.root);
  const detailed = await Promise.all(
    projects.map(async (p) => {
      try {
        const loaded = await openProject(ws, p.dir);
        return { ...p, scenarios: loaded.scenarios, environments: Object.keys(loaded.config.environments), error: undefined };
      } catch (e) {
        return { ...p, scenarios: [] as string[], environments: [] as string[], error: (e as Error).message.split('\n')[0] };
      }
    }),
  );
  if (opts.json) {
    ui.result(JSON.stringify({ root: ws.root, projects: detailed, templates }, null, 2));
    return EXIT.ok;
  }
  const c = ui.c;
  ui.result(`${c.bold('Projects')} ${c.dim(ui.path(ws.projectsDir))}`);
  if (detailed.length === 0) ui.result(c.dim('  none yet — create one with `studio new <slug>`'));
  const width = Math.max(0, ...detailed.map((p) => p.slug.length));
  for (const p of detailed) {
    const info = p.error
      ? c.red(p.error)
      : `${p.name}  ${c.dim(`${plural(p.scenarios.length, 'scenario')}${p.scenarios.length ? `: ${p.scenarios.join(', ')}` : ''}`)}`;
    ui.result(`  ${c.bold(p.slug.padEnd(width))}  ${info}`);
  }
  ui.result(`${c.bold('Templates')} ${c.dim(ui.path(ws.templatesDir))}`);
  ui.result(templates.length ? `  ${templates.map((t) => t.name).join(', ')}` : c.dim('  none'));
  return EXIT.ok;
}
