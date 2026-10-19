import { realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { envName, ifMatch, projectSlug } from '../schema.js';
import { plural } from '../result.js';
import { READ, WRITE_FILES, defineTool } from './define.js';
import type { ToolDef } from './define.js';

/** Whether `p` is `root` or inside it (real paths: macOS /tmp → /private/tmp). */
function isInside(p: string, root: string): boolean {
  const real = (x: string) => {
    try {
      return realpathSync(x);
    } catch {
      return x;
    }
  };
  const rel = relative(real(root), real(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export const engineInfo = defineTool({
  name: 'engine_info',
  title: 'Demo Studio engine',
  description: "Version, workspace root and features of this Demo Studio engine, its jobs worker (the background process that runs dry runs, captures and the other jobs) and the usage counters of the workspace (captures, dry runs, renders), and started_in: the folder the client started this server in (Claude Code: the session's folder). Call it first to check the server is connected to the right workspace: a started_in outside the workspace root means the registration names another folder than this session's.",
  input: z.strictObject({}),
  annotations: READ,
  async run(_args, { engine }) {
    const info = engine.info();
    const projects = await engine.projects.list();
    const w = await engine.jobs.worker();
    const worker = w ? { pid: w.pid, since: w.since, build: w.build } : null;
    const usage = await engine.usage();
    const startedIn = process.cwd();
    const elsewhere = !isInside(startedIn, info.root);
    return {
      summary: `Demo Studio ${info.version} (engine API ${info.api}) · workspace ${info.root} · ${plural(projects.length, 'project')} · jobs worker ${w ? `running (pid ${w.pid})` : 'idle (started when a job is submitted)'} · history: ${plural(usage.captures, 'capture')}, ${plural(usage.dry_runs, 'dry run')}, ${plural(usage.renders, 'render')}.${elsewhere ? ` Started in ${startedIn}, outside the workspace: if that is this session's folder, the registration (or the plugin's values, shared by every folder it is installed in) names another workspace — ask the user before going on.` : ''} Next: project_list, then project_get.`,
      data: { ...info, started_in: startedIn, started_outside_workspace: elsewhere, projects: projects.length, worker, usage },
    };
  },
});

export const projectList = defineTool({
  name: 'project_list',
  title: 'List projects',
  description: 'The projects of the workspace: slug, name, folder, scenarios and environments. A project that does not load is listed with its error.',
  input: z.strictObject({}),
  annotations: READ,
  async run(_args, { engine }) {
    const projects = await engine.projects.list();
    const lines = projects.map((p) => `- ${p.slug} (${p.name}): ${p.error ? `does not load: ${p.error}` : `${plural(p.scenarios.length, 'scenario')}${p.scenarios.length ? ` — ${p.scenarios.join(', ')}` : ''}`}`);
    return {
      summary: projects.length ? `${plural(projects.length, 'project')} in ${engine.workspace.projectsDir}:\n${lines.join('\n')}` : `No project yet in ${engine.workspace.projectsDir}: create one with project_create.`,
      data: { root: engine.root, projects_dir: engine.workspace.projectsDir, projects },
    };
  },
});

export const projectGet = defineTool({
  name: 'project_get',
  title: 'Read a project',
  description:
    'A project: README (product, audience, goals, tone — read it before writing scenarios), readme_hash (the if_match of project_update_readme), scenarios, environments (pages, display URLs, production / read-only access, sandbox, persona names) and project.yaml with its defaults applied. Never returns session files or login steps.',
  input: z.strictObject({ project: projectSlug }),
  annotations: READ,
  async run({ project }, { engine }) {
    const p = await engine.projects.get(project);
    const envs = p.environments.map((e) => `${e.name}${e.production ? ' (production' + (e.access === 'read-only' ? ', read-only)' : ')') : e.access === 'read-only' ? ' (read-only)' : ''}${e.sandbox ? ' (sandbox)' : ''}: pages ${Object.keys(e.pages).join(', ') || 'none'}${e.personas.length ? `; personas ${e.personas.map((x) => x.name).join(', ')}` : ''}`);
    return {
      summary: [
        `${p.name} (${p.slug}) · ${p.dir}`,
        `scenarios: ${p.scenarios.join(', ') || 'none yet'}`,
        `environments:${envs.length ? `\n${envs.map((l) => `- ${l}`).join('\n')}` : ' none'}`,
        p.readme === null ? 'README.md: missing (project_update_readme writes it)' : `README.md: ${p.readme.length} characters (readme_hash ${p.readme_hash})`,
        ...(p.warnings.length ? [`project.yaml: ${plural(p.warnings.length, 'warning')}`] : []),
      ].join('\n'),
      data: p as unknown as Record<string, unknown>,
    };
  },
});

const pageMap = z.record(z.string().min(1).max(100), z.string().min(1).max(2000)).describe('Page key → base URL, e.g. {"app": "https://app.staging.example.com"}.');

export const projectCreate = defineTool({
  name: 'project_create',
  title: 'Create a project',
  description:
    'Create a project folder: README.md (the given markdown, else a skeleton with the sections to fill), project.yaml, scenarios/, hooks/, assets/ and .gitignore. Refuses an existing slug. Environments created here are neither production nor read-only: a human marks production environments in project.yaml.',
  input: z.strictObject({
    name: z.string().min(1).max(200).describe('Display name of the product.'),
    slug: projectSlug.optional().describe('Folder name (default: from the name).'),
    readme: z.string().max(200_000).optional().describe('Full README.md content (default: a skeleton).'),
    environments: z.record(envName, pageMap).optional().describe('Environment name → its pages, e.g. {"staging": {"app": "https://app.staging.example.com"}}.'),
    template: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'a template name of the workspace (never a path)').optional().describe('Template (theme) name; default "default".'),
  }),
  annotations: WRITE_FILES,
  async run(args, { engine }) {
    const p = await engine.projects.create(args);
    return {
      summary: `Created project ${p.slug} in ${p.dir}. Next: fill README.md (project_update_readme with if_match ${p.readme_hash}), then write scenarios (scenario_validate, scenario_save).`,
      data: p as unknown as Record<string, unknown>,
    };
  },
});

export const projectUpdateReadme = defineTool({
  name: 'project_update_readme',
  title: 'Replace a project README',
  description:
    "Replace a project's README.md. if_match is required when the README exists: the readme_hash project_get returned (a conflict names the current hash when the file changed meanwhile).",
  input: z.strictObject({
    project: projectSlug,
    markdown: z.string().max(200_000).describe('The full new README.md.'),
    if_match: ifMatch.describe('readme_hash from project_get; null or absent only when the project has no README.md.'),
  }),
  annotations: WRITE_FILES,
  async run({ project, markdown, if_match }, { engine }) {
    const r = await engine.projects.updateReadme(project, markdown, if_match);
    return { summary: `README.md of ${project} written (${r.path}); its new hash is ${r.hash}.`, data: { project, ...r } };
  },
});

export const PROJECT_TOOLS: ToolDef[] = [engineInfo, projectList, projectGet, projectCreate, projectUpdateReadme];
