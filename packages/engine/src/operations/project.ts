/**
 * The project operations (moved from the MCP server's tools/project.ts): engine_info, project_list, project_get,
 * project_update_readme, which the shells share (L7.13); project_create and project_prune, MCP's (L7.18).
 */
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { pathInside } from '@retake/core/base';
import { zThemeName } from '@retake/core/ids';
import { sandboxAdvice, sandboxAdviceText } from '@retake/core/sandbox';
import { engineLocation, staleEngine } from '@retake/core/io';
import { heldWork, heldWorkWords } from '../jobs/held.js';
import { otherCopy } from '../jobs/lock.js';
import { README_MAX_CHARS } from '../projects.js';
import { formatBytes } from '../prune.js';
import { READ, WRITE_FILES } from './annotations.js';
import { defineOperation } from './define.js';
import type { ToolAnnotations } from './define.js';
import { envName, ifMatch, projectSlug } from './schema.js';
import { plural } from './words.js';

/**
 * The real path of `x` (macOS /tmp → /private/tmp; the case as given), or `x` itself when it does not resolve. Kept
 * instead of core's realPathOf (the native call: the case as stored on disk, a missing tail joined to its real parent)
 * so that engine_info's "started outside the workspace" answers exactly as before; core test/path-inside.test.ts pins
 * them.
 */
function realOrSame(x: string): string {
  try {
    return realpathSync(x);
  } catch {
    return x;
  }
}

export const engineInfo = defineOperation({
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
    // Hotfix v0.2.5 (field point 20): an engine updated under this process (the app updated, the checkout rebuilt).
    const stale = staleEngine(info.version);
    return {
      summary: `${stale ? `STALE: this server runs Retake ${stale.running}, but ${stale.installed} is installed now — it stops after this answer so that the client starts it again on ${stale.installed}. ` : ''}Retake ${info.version} (engine API ${info.api}) · workspace ${info.root} · ${plural(projects.length, 'project')} · jobs worker ${w ? `running (pid ${w.pid}${other ? `, another copy of Retake: ${other.version} (its folder in untrusted.worker_other_copy) — jobs run with its tools` : ''})` : 'idle (started when a job is submitted)'} · history: ${plural(usage.captures, 'capture')}, ${plural(usage.dry_runs, 'dry run')}, ${plural(usage.renders, 'render')}.${held ? ` Captures first: ${heldWorkWords(held)}.` : ''}${elsewhere ? ` Started in ${startedIn}, outside the workspace: if that is this session's folder, the registration (or the plugin's values, shared by every folder it is installed in) names another workspace — ask the user before going on.` : ''} Next: project_list, then project_get.`,
      data: { ...info, stale, started_in: startedIn, started_outside_workspace: elsewhere, projects: projects.length, worker, usage, held: held ?? null, ...(other ? { untrusted: { worker_other_copy: other } } : {}) },
    };
  },
});

export const projectList = defineOperation({
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

export const projectGet = defineOperation({
  name: 'project_get',
  title: 'Read a project',
  description:
    'A project: README (product, audience, goals, tone — read it before writing scenarios), readme_hash (the if_match of project_update_readme), scenarios, environments (pages, display URLs, production / read-only access, sandbox, persona names) and project.yaml with its defaults applied; readme_environments when the README\'s "Environments & links" section no longer matches them. Never returns session files or login steps.',
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
        ...(p.readme_environments
          ? [
              `README.md › "Environments & links" is out of date (it was written when the project was created): ${[
                p.readme_environments.missing.length ? `it does not mention ${p.readme_environments.missing.map((l) => l.replace(/^- /, '')).join('; ')}` : '',
                p.readme_environments.gone.length ? `it still lists ${p.readme_environments.gone.map((l) => l.replace(/^- /, '')).join('; ')}` : '',
              ]
                .filter(Boolean)
                .join(' — ')}. Offer to update that section (project_update_readme).`,
            ]
          : []),
        ...(p.warnings.length ? [`project.yaml: ${plural(p.warnings.length, 'warning')}`] : []),
        // L5.8 (R-FLD-30): a local environment holding state and no sandbox — never reset it by hand between takes.
        ...(advice
          ? [
              `sandbox: ${advice.detail}. Instead of resetting it by hand (SQL, the mailbox's API), ask the user for a sandbox — ${advice.hint}; then run_capture {sandbox: true} resets it before every take. sandbox.yaml is the user's file (never written through this server).`,
            ]
          : []),
      ].join('\n'),
      data: { ...p, ...(advice ? { sandbox_advice: advice } : {}) },
    };
  },
});

export const projectUpdateReadme = defineOperation({
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

const pageUrl = z.string().min(1).max(2000);
const pageMap = z
  .record(z.string().min(1).max(100), z.union([pageUrl, z.strictObject({ url: pageUrl, display: z.string().min(1).max(2000).optional() })]))
  .describe('Page key → base URL, or {url, display} (display: the URL the browser frame shows instead, e.g. the production host for a local page), e.g. {"app": "https://app.staging.example.com"}.');

export const projectCreate = defineOperation({
  name: 'project_create',
  title: 'Create a project',
  description:
    'Create a project folder: README.md (the given markdown, else a skeleton with the sections to fill), project.yaml, scenarios/, hooks/, assets/ and .gitignore. Refuses an existing slug. Environments created here are neither production nor read-only: a human marks production environments in project.yaml.',
  input: z.strictObject({
    name: z.string().min(1).max(200).describe('Display name of the product.'),
    slug: projectSlug.optional().describe('Folder name (default: from the name).'),
    readme: z.string().max(README_MAX_CHARS).optional().describe('Full README.md content (default: a skeleton).'),
    environments: z.record(envName, pageMap).optional().describe('Environment name → its pages, e.g. {"staging": {"app": "https://app.staging.example.com"}}.'),
    default_env: envName.optional().describe('The environment used when a scenario does not say (one of `environments`; default: the first one).'),
    template: zThemeName('a theme name of the workspace or a starter theme (never a path)', { nonEmpty: true }).optional().describe('Theme name (a workspace theme or a starter theme); default "default".'),
  }),
  annotations: WRITE_FILES,
  async run(args, { engine }) {
    const p = await engine.projects.create(args);
    return {
      summary: `Created project ${p.slug} in ${p.dir}. Next: fill README.md (project_update_readme with if_match ${p.readme_hash}), then write scenarios (scenario_validate, scenario_save).`,
      data: p,
    };
  },
});

/**
 * The record files of renders/ that stay, in words: the renders, and — when some are files that are no render of
 * their own name — those apart (a count: "untrusted.renders_alone" names them), never counted as renders.
 */
function keptRenders(r: { kept: { renders: number }; renders_alone?: { reasons: Array<{ why: string; count: number }> } }): string {
  const other = (r.renders_alone?.reasons ?? []).filter((x) => x.why !== 'incomplete').reduce((n, x) => n + x.count, 0);
  const renders = plural(r.kept.renders - other, 'render');
  return other ? `${renders} and ${plural(other, 'other file')} of renders/` : renders;
}

/**
 * What prune kept beyond its list, one line per reason in the order the reasons are met: the fixed words of the reason
 * and how many takes — never a folder's name (a folder of runs/ is named by whoever can write there).
 */
function keptLines(kept: ReadonlyArray<{ why: string; reason: string }>): string[] {
  const by = new Map<string, { reason: string; count: number }>();
  for (const k of kept) by.set(k.why, { reason: k.reason, count: (by.get(k.why)?.count ?? 0) + 1 });
  return [...by.values()].map((x) => `kept: ${x.reason} — ${plural(x.count, 'take')}`);
}

/** Annotations of `project_prune`: it deletes takes and renders (with dry_run: false). */
const PRUNE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

export const projectPrune = defineOperation({
  name: 'project_prune',
  title: 'Free disk space',
  description:
    "What a project's runs/, renders/ and review/ hold that nothing needs any more, and how much deleting it frees: failed, cancelled and interrupted captures, dry runs, older captures nothing uses, renders beyond the last keep_renders (default 3) of each scenario and variant, failed renders and the reviews of renders that go. Always kept: the last succeeded capture of each scenario, the last one that can still be edited and the last complete one, every capture a kept render or a comment thread uses, every render a thread was made or resolved on, whatever a queued or running job names; a run folder that is a link and a capture written by a newer Retake are left alone; a file of renders/ that is no render of its own name (renamed or copied by hand, a link, a newer format, a record that lacks a member or does not read) is left alone with the render and the take it names, and while a file of renders/ is too big to read every render, review and take stays; exports/ is never touched. dry_run (default true) only lists. dry_run: false — only when the user asked to free space — asks the user first in an approval form (how many items, how much, by kind, the first 20 listed and how many more, and the `retake prune <project> --yes` command), then deletes the items of that approval — all of them, listed or counted — that can still go at that moment, each with the files it had when listed; a decline is refused and a client that cannot ask gets needs_approval: nothing is deleted, do not retry on your own.",
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
        `kept: ${plural(r.kept.runs, 'take')}, ${keptRenders(r)}, ${plural(r.kept.reviews, 'review')}`,
        // The takes that stay for a reason the list does not show: the engine's fixed words and a count (their names: data.kept_takes).
        ...keptLines(r.kept_takes ?? []),
        // The files of renders/ left alone: a count (their names are text anyone who can write renders/ chose: data.untrusted.renders_alone).
        ...(r.renders_alone ? [((one: boolean) => `${plural(r.renders_alone!.count, 'file')} of renders/ left alone (no render of ${one ? 'its' : 'their'} own name, or a record that lacks a member), with the renders and the takes ${one ? 'it names' : 'they name'} ("untrusted.renders_alone" names ${one ? 'it' : 'them'})`)(r.renders_alone.count === 1)] : []),
        // A file of renders/ too big to read: everything stays (the engine's fixed sentence, with a count).
        ...(r.renders_unread ? [r.renders_unread] : []),
        ...(r.skipped?.length ? [`${plural(r.skipped.length, 'approved item')} kept: something uses ${r.skipped.length === 1 ? 'it' : 'them'} now, or ${r.skipped.length === 1 ? 'it is' : 'they are'} gone (${r.skipped.map((i) => `${i.kind} ${i.id}`).join(', ')})`] : []),
        ...(r.not_asked ? [`${plural(r.not_asked, 'item')} that can go now ${r.not_asked === 1 ? 'was' : 'were'} not in the approval: kept`] : []),
        // Comment threads that could not be read: what stayed for it (the engine's sentence: the slug, scenario names, an error code).
        ...(r.threads_unread ? [r.threads_unread] : []),
        ...r.problems.map((p) => `could not delete ${p}`),
      ].join('\n'),
      data: r,
    };
  },
});
