/**
 * The project operations the shells share (moved from the MCP server's tools/project.ts in L7.13): engine_info,
 * project_list, project_get, project_update_readme.
 */
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { pathInside, sandboxAdvice, sandboxAdviceText } from '@retake/core';
import { engineLocation, staleEngine } from '@retake/core/io';
import { heldWork, heldWorkWords } from '../jobs/held.js';
import { otherCopy } from '../jobs/lock.js';
import { README_MAX_CHARS } from '../projects.js';
import { READ, WRITE_FILES } from './annotations.js';
import { defineOperation } from './define.js';
import { ifMatch, projectSlug } from './schema.js';
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
