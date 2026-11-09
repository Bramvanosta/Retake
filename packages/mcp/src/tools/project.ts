import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { engineLocation, newVarName, pathInside, sandboxAdvice, sandboxAdviceText } from '@retake/core';
import { README_MAX_CHARS, formatBytes, heldWork, heldWorkWords, otherCopy } from '@retake/engine';
import { envName, ifMatch, projectSlug } from '../schema.js';
import { plural } from '../result.js';
import { READ, WRITE_FILES, defineTool } from './define.js';
import type { ToolDef } from './define.js';
import type { ToolAnnotations } from '../server.js';

/** The real path of `x` (macOS /tmp → /private/tmp; the case as given), or `x` itself when it does not resolve. */
function realOrSame(x: string): string {
  try {
    return realpathSync(x);
  } catch {
    return x;
  }
}

export const engineInfo = defineTool({
  name: 'engine_info',
  title: 'Retake engine',
  description: "Version, workspace root and features of this Retake engine, its jobs worker (the background process that runs dry runs, captures and the other jobs) and the usage counters of the workspace (captures, dry runs, renders), and started_in: the folder the client started this server in (Claude Code: the session's folder). Call it first to check the server is connected to the right workspace: a started_in outside the workspace root means the registration names another folder than this session's.",
  input: z.strictObject({}),
  annotations: READ,
  async run(_args, { engine }) {
    const info = engine.info();
    const projects = await engine.projects.list();
    const w = await engine.jobs.worker();
    // L5.16c (critique M6): a worker of another copy of Retake (the app and a checkout, two apps) runs this client's jobs.
    const other = otherCopy(w, { engine: engineLocation(), version: info.version });
    // Its folder is the lock's text (review c A-L4): under `untrusted`; the summary says the version's shape only.
    const worker = w ? { pid: w.pid, since: w.since, build: w.build, ...(w.started_by ? { started_by: w.started_by } : {}), ...(other ? { other_copy: true } : {}) } : null;
    const usage = await engine.usage();
    // L5.14: what a filming take holds of this workspace's jobs (fixed words and a kind: no other workspace named).
    const held = heldWork(await engine.jobs.list({ states: ['queued', 'running'], limit: 50 }));
    const startedIn = process.cwd();
    const elsewhere = !pathInside(startedIn, info.root, { real: realOrSame, dotDotPrefix: true });
    return {
      summary: `Retake ${info.version} (engine API ${info.api}) · workspace ${info.root} · ${plural(projects.length, 'project')} · jobs worker ${w ? `running (pid ${w.pid}${other ? `, another copy of Retake: ${other.version} (its folder in untrusted.worker_other_copy) — jobs run with its tools` : ''})` : 'idle (started when a job is submitted)'} · history: ${plural(usage.captures, 'capture')}, ${plural(usage.dry_runs, 'dry run')}, ${plural(usage.renders, 'render')}.${held ? ` Captures first: ${heldWorkWords(held)}.` : ''}${elsewhere ? ` Started in ${startedIn}, outside the workspace: if that is this session's folder, the registration (or the plugin's values, shared by every folder it is installed in) names another workspace — ask the user before going on.` : ''}${info.legacy?.old_home ? ` The signed-in sessions from before the rename (${info.legacy.old_home}${info.legacy.old_home_var ? `, the folder ${info.legacy.old_home_var} names` : ''}) are not read: personas show as never signed in until the user ${info.legacy.old_home_var ? 'sets RETAKE_HOME to that folder or moves it' : 'moves them'} (retake doctor, in their terminal, says how).` : ''}${info.legacy?.old_vars ? ` This server's environment sets ${info.legacy.old_vars.join(', ')} (names from before the rename), no longer read: ask the user to rename ${info.legacy.old_vars.length === 1 ? 'it' : 'them'} ${info.legacy.old_vars.map(newVarName).join(', ')} where set (their shell profile, this MCP registration's env).` : ''} Next: project_list, then project_get.`,
      data: { ...info, started_in: startedIn, started_outside_workspace: elsewhere, projects: projects.length, worker, usage, held: held ?? null, ...(other ? { untrusted: { worker_other_copy: other } } : {}) },
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
    const found = sandboxAdvice(p);
    const advice = found ? sandboxAdviceText(found, p.slug) : null;
    const envs = p.environments.map((e) => `${e.name}${e.production ? ' (production' + (e.access === 'read-only' ? ', read-only)' : ')') : e.access === 'read-only' ? ' (read-only)' : ''}${e.sandbox ? ' (sandbox)' : ''}: pages ${Object.keys(e.pages).join(', ') || 'none'}${e.personas.length ? `; personas ${e.personas.map((x) => x.name).join(', ')}` : ''}`);
    return {
      summary: [
        `${p.name} (${p.slug}) · ${p.dir}`,
        `scenarios: ${p.scenarios.join(', ') || 'none yet'}`,
        `environments:${envs.length ? `\n${envs.map((l) => `- ${l}`).join('\n')}` : ' none'}`,
        p.readme_error ? `README.md: ${p.readme_error}` : p.readme === null ? 'README.md: missing (project_update_readme writes it)' : `README.md: ${p.readme.length} characters (readme_hash ${p.readme_hash})`,
        ...(p.warnings.length ? [`project.yaml: ${plural(p.warnings.length, 'warning')}`] : []),
        // L5.8 (R-FLD-30): a local environment holding state and no sandbox — never reset it by hand between takes.
        ...(advice
          ? [
              `sandbox: ${advice.detail}. Instead of resetting it by hand (SQL, the mailbox's API), ask the user for a sandbox — ${advice.hint}; then run_capture {sandbox: true} resets it before every take. sandbox.yaml is the user's file (never written through this server).`,
            ]
          : []),
      ].join('\n'),
      data: { ...(p as unknown as Record<string, unknown>), ...(advice ? { sandbox_advice: advice } : {}) },
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
    readme: z.string().max(README_MAX_CHARS).optional().describe('Full README.md content (default: a skeleton).'),
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
    markdown: z.string().max(README_MAX_CHARS).describe(`The full new README.md (${README_MAX_CHARS.toLocaleString('en')} characters at most, the final line break included).`),
    if_match: ifMatch.describe('readme_hash from project_get; null or absent only when the project has no README.md.'),
  }),
  annotations: WRITE_FILES,
  async run({ project, markdown, if_match }, { engine }) {
    const r = await engine.projects.updateReadme(project, markdown, if_match);
    return { summary: `README.md of ${project} written (${r.path}); its new hash is ${r.hash}.`, data: { project, ...r } };
  },
});

/** Annotations of `project_prune`: it deletes takes and renders (with dry_run: false). */
const PRUNE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

export const projectPrune = defineTool({
  name: 'project_prune',
  title: 'Free disk space',
  description:
    "What a project's runs/, renders/ and review/ hold that nothing needs any more, and how much deleting it frees: failed, cancelled and interrupted captures, dry runs, older captures nothing uses, renders beyond the last keep_renders (default 3) of each scenario and variant, failed renders and the reviews of renders that go. Always kept: the last succeeded capture of each scenario, every capture a kept render or a comment thread uses, every render a thread was made or resolved on, whatever a queued or running job names; exports/ is never touched. dry_run (default true) only lists. dry_run: false — only when the user asked to free space — asks the user first in an approval form (how many items, how much, by kind, the first 20 listed and how many more, and the `retake prune <project> --yes` command), then deletes the items of that approval — all of them, listed or counted — that can still go at that moment, each with the files it had when listed; a decline is refused and a client that cannot ask gets needs_approval: nothing is deleted, do not retry on your own.",
  input: z.strictObject({
    project: projectSlug,
    keep_renders: z.number().int().min(1).max(100).optional().describe('Renders kept per scenario and variant, with their reviews (default 3).'),
    dry_run: z.boolean().optional().describe('Default true: delete nothing, list what would go. false deletes.'),
  }),
  annotations: PRUNE,
  async run({ project, keep_renders, dry_run }, { engine, approver }) {
    const r = await engine.projects.prune(project, { ...(keep_renders !== undefined ? { keep_renders } : {}), dry_run: dry_run !== false }, approver ? { approver } : {});
    const size = formatBytes(r.bytes);
    const lines = r.items.slice(0, 40).map((i) => `- ${i.kind} ${i.id}: ${i.reason} (${formatBytes(i.bytes)})`);
    const head = !r.items.length
      ? `nothing to prune in ${r.project}`
      : r.dry_run
        ? `${plural(r.items.length, 'item')} of ${r.project} can go (${size}); call again with dry_run: false to delete them (only when the user asked to free space)`
        : `${plural(r.items.length, 'item')} of ${r.project} deleted (${size} freed)${r.skipped ? ', as the user approved' : ''}`;
    return {
      summary: [
        head,
        ...lines,
        ...(r.items.length > 40 ? [`… and ${r.items.length - 40} more (data.items)`] : []),
        `kept: ${plural(r.kept.runs, 'take')}, ${plural(r.kept.renders, 'render')}, ${plural(r.kept.reviews, 'review')}`,
        ...(r.skipped?.length ? [`${plural(r.skipped.length, 'approved item')} kept: something uses ${r.skipped.length === 1 ? 'it' : 'them'} now, or ${r.skipped.length === 1 ? 'it is' : 'they are'} gone (${r.skipped.map((i) => `${i.kind} ${i.id}`).join(', ')})`] : []),
        ...(r.not_asked ? [`${plural(r.not_asked, 'item')} that can go now ${r.not_asked === 1 ? 'was' : 'were'} not in the approval: kept`] : []),
        ...r.problems.map((p) => `could not delete ${p}`),
      ].join('\n'),
      data: r as unknown as Record<string, unknown>,
    };
  },
});

export const PROJECT_TOOLS: ToolDef[] = [engineInfo, projectList, projectGet, projectCreate, projectUpdateReadme, projectPrune];
