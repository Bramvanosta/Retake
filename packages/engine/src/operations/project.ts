import { z } from 'zod';
import { zThemeName } from '@retake/core/ids';
import { COMPONENT_ID_RE } from '@retake/core/model';
import { sandboxAdvice, sandboxAdviceText } from '@retake/core/sandbox';
import { outsideWorkspace, staleThisEngine, workerOfAnotherCopy } from '../engine-copy.js';
import { heldWork, heldWorkWords } from '../jobs/held.js';
import { README_MAX_CHARS } from '../projects.js';
import type { EnvironmentChangeView } from '../project-env.js';
import { formatBytes } from '../prune.js';
import { READ, WRITE_FILES } from './annotations.js';
import { defineOperation } from './define.js';
import type { ToolAnnotations } from './define.js';
import { envName, ifMatch, projectSlug } from './schema.js';
import { plural } from './words.js';
import { showHiddenCharsLine } from '@retake/core/base';

export const engineInfo = defineOperation({
  name: 'engine_info',
  title: 'Retake engine',
  description:
    "Version, workspace root and features of this Retake engine, its jobs worker (the background process that runs dry runs, captures and the other jobs) and the usage counters of the workspace (captures, dry runs, renders), and started_in: the folder the client started this server in (Claude Code: the session's folder). Call it first to check the server is connected to the right workspace: a started_in outside the workspace root means the registration names another folder than this session's.",
  input: z.strictObject({}),
  annotations: READ,
  async run(_args, { engine, startedIn }) {
    const info = engine.info();
    const projects = await engine.projects.list();
    const w = await engine.jobs.worker();
    // A worker of another copy of Retake (the app and a checkout, two apps) runs this client's jobs.
    const other = workerOfAnotherCopy(w, info.version);
    // Its folder is the lock's text: under `untrusted`; the summary says the version's shape only.
    const worker = w ? { pid: w.pid, since: w.since, build: w.build, ...(w.started_by ? { started_by: w.started_by } : {}), ...(other ? { other_copy: true } : {}) } : null;
    const usage = await engine.usage();
    // What a filming take holds of this workspace's jobs (fixed words and a kind: no other workspace named).
    const held = heldWork(await engine.jobs.list({ states: ['queued', 'running'], limit: 50 }));
    const elsewhere = outsideWorkspace(startedIn, info.root);
    // Hotfix v0.2.5 (field point 20): an engine updated under this process (the app updated, the checkout rebuilt).
    const stale = staleThisEngine(info.version);
    return {
      summary: `${stale ? `STALE: this server runs Retake ${stale.running}, but ${stale.installed} is installed now — it stops after this answer so that the client starts it again on ${stale.installed}. ` : ''}Retake ${info.version} (engine API ${info.api}) · workspace ${info.root} · ${plural(projects.length, 'project')} · jobs worker ${w ? `running (pid ${w.pid}${other ? `, another copy of Retake: ${other.version} (its folder in untrusted.worker_other_copy) — jobs run with its tools` : ''})` : 'idle (started when a job is submitted)'} · history: ${plural(usage.captures, 'capture')}, ${plural(usage.dry_runs, 'dry run')}, ${plural(usage.renders, 'render')}.${held ? ` Captures first: ${heldWorkWords(held)}.` : ''}${elsewhere ? ` Started in ${startedIn}, outside the workspace: if that is this session's folder, the registration (or the plugin's values, shared by every folder it is installed in) names another workspace — ask the user before going on.` : ''} Next: project_list, then project_get.`,
      data: {
        ...info,
        stale,
        started_in: startedIn,
        started_outside_workspace: elsewhere,
        projects: projects.length,
        worker,
        usage,
        held: held ?? null,
        ...(other ? { untrusted: { worker_other_copy: other } } : {}),
      },
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
    const lines = projects.map(
      (p) => `- ${p.slug} (${p.name}): ${p.error ? `does not load: ${p.error}` : `${plural(p.scenarios.length, 'scenario')}${p.scenarios.length ? ` — ${p.scenarios.join(', ')}` : ''}`}`,
    );
    return {
      summary: projects.length
        ? `${plural(projects.length, 'project')} in ${engine.workspace.projectsDir}:\n${lines.join('\n')}`
        : `No project yet in ${engine.workspace.projectsDir}: create one with project_create.`,
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
    const advice = found ? sandboxAdviceText(found, p.slug, 'retake', 'mcp') : null;
    const envs = p.environments.map(
      (e) =>
        `${e.name}${e.production ? ' (production' + (e.access === 'read-only' ? ', read-only)' : ')') : e.access === 'read-only' ? ' (read-only)' : ''}${e.sandbox ? ' (sandbox)' : ''}: pages ${Object.keys(e.pages).join(', ') || 'none'}${e.personas.length ? `; personas ${e.personas.map((x) => x.name).join(', ')}` : ''}`,
    );
    return {
      summary: [
        `${p.name} (${p.slug}) · ${p.dir}`,
        `scenarios: ${p.scenarios.join(', ') || 'none yet'}`,
        `environments:${envs.length ? `\n${envs.map((l) => `- ${l}`).join('\n')}` : ' none'}`,
        p.readme_error
          ? `README.md: ${p.readme_error}`
          : p.readme === null
            ? 'README.md: missing (project_update_readme writes it)'
            : `README.md: ${p.readme.length} characters (readme_hash ${p.readme_hash})`,
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
        // R-FLD-30: a local environment holding state and no sandbox — never reset it by hand between takes.
        ...(advice
          ? [
              `sandbox: ${advice.detail}. Instead of resetting it by hand (SQL, the mailbox's API), offer the user a sandbox — ${advice.hint}, which resets it before every take. compose.yaml and sandbox.yaml are the user's files: propose their text in chat, never write them yourself; sandbox_up pulls their images (ask first).`,
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
  description: "Replace a project's README.md. if_match is required when the README exists: the readme_hash project_get returned (a conflict names the current hash when the file changed meanwhile).",
  input: z.strictObject({
    project: projectSlug,
    markdown: z
      .string()
      .max(README_MAX_CHARS)
      .describe(`The full new README.md (${README_MAX_CHARS.toLocaleString('en')} characters at most, the final line break included).`),
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
    template: zThemeName('a theme name of the workspace or a starter theme (never a path)', { nonEmpty: true })
      .optional()
      .describe('Theme name (a workspace theme or a starter theme); default "default".'),
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

/** What an environment change says: what it wrote, the default before and after, the warnings and what to offer next. */
function envChangeSummary(r: EnvironmentChangeView): string {
  const verb = r.action === 'unchanged' ? 'unchanged (nothing to write)' : r.action === 'removed' ? 'removed from project.yaml' : `${r.action === 'added' ? 'added to' : 'changed in'} project.yaml`;
  const e = r.environment;
  return [
    `Environment ${r.env} of ${r.project} ${verb}${r.approved ? ', as the user approved' : ''}.`,
    ...r.lines.map((l) => `- ${l}`),
    // Page URLs and display URLs as the user wrote them: every hidden character written out.
    ...(e
      ? [
          `now: ${e.production ? 'production, ' : ''}${e.access}; pages ${Object.entries(e.pages)
            .map(([k, u]) => `${k} ${showHiddenCharsLine(u)}${e.display?.[k] ? ` (shown as ${showHiddenCharsLine(e.display[k])})` : ''}`)
            .join(', ')}${e.credentials ? ` (sign-in details in ${e.credentials.join(', ')}: not shown)` : ''}`,
        ]
      : []),
    `default environment (scenarios without env:): ${r.default_env.after ?? 'none'}${r.default_env.before !== r.default_env.after ? ` (was ${r.default_env.before ?? 'none'})` : ''}`,
    ...r.warnings.map((w) => `warning: ${w}`),
    ...(r.removed?.scenarios.length
      ? [
          `${plural(r.removed.scenarios.length, 'scenario')} still name ${r.env} in env: (${r.removed.scenarios.join(', ')}): they no longer run until changed — offer to change them (scenario_get, scenario_save)`,
        ]
      : []),
    // Persona names read from the Retake home's folders: under untrusted.sessions, a count here.
    ...(r.removed?.sessions
      ? [
          `${plural(r.removed.sessions, 'saved session')} of ${r.env} stay${r.removed.sessions === 1 ? 's' : ''} in the Retake home (untrusted.sessions names the personas): nothing uses them now — a person removes them with: ${r.removed.remove_sessions}`,
        ]
      : []),
    ...(r.readme_environments ? ['README.md › "Environments & links" no longer matches the environments: offer to update that section (project_update_readme).'] : []),
  ].join('\n');
}

/** Annotations of `project_env_remove`: it removes an environment of project.yaml. */
const ENV_REMOVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const ENV_RULES =
  "Only when the user asks. Free: pages on origins the project already has (another display, another path), marking an environment production or read-only, display URLs. Asked to the user in an approval form (a client that cannot ask gets needs_approval, a decline is refused — with the `retake env …` command a human runs; do not retry on your own): a page on an origin new to the project (where its captures and hooks may go), removing production or read-only (or a page of such an environment), making a production or read-only environment the one scenarios without env: use, sign-in details (user:password@) in a page URL. Also asked: a production environment that allows writes (access: read-write). Refused: a sandbox environment (its sandbox.yaml), a page of a read-write environment on a production or read-only host of any project, an environment left without pages, a result project.yaml with errors (each issue named). Only environments.<env> and default_env change: every other setting of project.yaml (read_only, auth…) stays the user's, and so do the comments outside that environment — an environment written on one line ({…}) is rewritten in block form.";

export const projectEnvSet = defineOperation({
  name: 'project_env_set',
  title: 'Add or change an environment',
  description: `Add an environment to project.yaml or change one: pages (a page given replaces that page whole; without display it has none), remove_pages, production, access, default (default_env names it; false: no longer). ${ENV_RULES} Returns the environment as written (no user:password@), the default before and after, and when README.md's "Environments & links" no longer matches.`,
  input: z.strictObject({
    project: projectSlug,
    env: envName,
    pages: pageMap.optional(),
    remove_pages: z.array(z.string().min(1).max(100)).max(50).optional().describe('Page keys to remove.'),
    production: z.boolean().optional().describe('true: a production environment (read-only unless access says otherwise; MCP never writes to it).'),
    access: z.enum(['read-only', 'read-write']).optional().describe('read-only stops every write of a run to its hosts.'),
    default: z.boolean().optional().describe('true: the environment scenarios without env: use (default_env).'),
  }),
  annotations: WRITE_FILES,
  async run({ project, env, ...change }, { engine, approver }) {
    const r = await engine.projects.setEnvironment(project, env, change, approver ? { approver } : {});
    return { summary: envChangeSummary(r), data: r };
  },
});

export const projectEnvRemove = defineOperation({
  name: 'project_env_remove',
  title: 'Remove an environment',
  description: `Remove an environment from project.yaml (and default_env when it named it). ${ENV_RULES} Names the scenarios whose env: still names it and counts the saved sessions left in the Retake home (with the command a person runs to remove them): neither is deleted.`,
  input: z.strictObject({ project: projectSlug, env: envName }),
  annotations: ENV_REMOVE,
  async run({ project, env }, { engine, approver }) {
    const r = await engine.projects.removeEnvironment(project, env, approver ? { approver } : {});
    return { summary: envChangeSummary(r), data: r };
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
        ...(r.renders_alone
          ? [
              ((one: boolean) =>
                `${plural(r.renders_alone!.count, 'file')} of renders/ left alone (no render of ${one ? 'its' : 'their'} own name, or a record that lacks a member), with the renders and the takes ${one ? 'it names' : 'they name'} ("untrusted.renders_alone" names ${one ? 'it' : 'them'})`)(
                r.renders_alone.count === 1,
              ),
            ]
          : []),
        // A file of renders/ too big to read: everything stays (the engine's fixed sentence, with a count).
        ...(r.renders_unread ? [r.renders_unread] : []),
        ...(r.skipped?.length
          ? [
              `${plural(r.skipped.length, 'approved item')} kept: something uses ${r.skipped.length === 1 ? 'it' : 'them'} now, or ${r.skipped.length === 1 ? 'it is' : 'they are'} gone (${r.skipped.map((i) => `${i.kind} ${i.id}`).join(', ')})`,
            ]
          : []),
        ...(r.not_asked ? [`${plural(r.not_asked, 'item')} that can go now ${r.not_asked === 1 ? 'was' : 'were'} not in the approval: kept`] : []),
        // Comment threads that could not be read: what stayed for it (the engine's sentence: the slug, scenario names, an error code).
        ...(r.threads_unread ? [r.threads_unread] : []),
        ...r.problems.map((p) => `could not delete ${p}`),
      ].join('\n'),
      data: r,
    };
  },
});

export const projectAdopt = defineOperation({
  name: 'project_adopt',
  title: 'Copy a workspace theme or component into a project',
  description:
    "Make a project carry its own look: each workspace theme named (a folder of the workspace's templates/, by name: template_list says each one's origin) is copied whole into the project's own folder, projects/<slug>/templates/<name>/ — its files verbatim, its provenance kept — so the project folder alone holds it (another Mac, a person it is handed to). Each workspace component named (by id: component_list says each one's source) is copied the same way into projects/<slug>/components/<namespace>/<name>/. The project's copy is found before the workspace's theme or component of that name from then on (for that project only); project.yaml and the scenarios are not changed. Through this server a theme or a component is only copied, never moved, and brand files are never adopted: a person runs retake project adopt <project> --theme <name> / --component <id> to move one (refused while another project uses it) or --brand <path> for brand files. Refused: a starter theme (no workspace theme: make the project's own with template_create_from_brand {project}), a built-in component, a component that does not validate, a name the project already has (conflict). The project's earlier renders made with a theme still match it (the copy has the same content).",
  // Themes, components or both (none named: the engine's own refusal says what to name).
  input: z.strictObject({
    project: projectSlug,
    themes: z.array(zThemeName('a theme name (template_list names them), never a path')).max(20).optional().describe('Workspace themes to copy into the project, by name.'),
    components: z
      .array(z.string().max(120).regex(COMPONENT_ID_RE, 'a component id "namespace/name" (component_list names them), never a path'))
      .max(20)
      .optional()
      .describe('Workspace components to copy into the project, by id.'),
    brand: z.array(z.string().max(1024)).max(20).optional().describe('Refused here (the answer says so): a person adopts brand files with retake project adopt --brand.'),
  }),
  annotations: WRITE_FILES,
  async run({ project, themes, components, brand }, { engine }) {
    const r = await engine.projects.adopt({ project, themes: themes ?? [], ...(components?.length ? { components } : {}), ...(brand?.length ? { brand } : {}), mode: 'copy' });
    const comps = r.components ?? [];
    return {
      summary: [
        ...(r.themes.length || !comps.length
          ? [`${plural(r.themes.length, 'theme')} copied into project ${r.project}: ${r.themes.map((t) => `${t.name} (templates/${t.name}/, ${plural(t.files.length, 'file')})`).join(', ')}`]
          : []),
        ...(comps.length
          ? [`${plural(comps.length, 'component')} copied into project ${r.project}: ${comps.map((c) => `${c.id} (components/${c.id}/, ${plural(c.files.length, 'file')})`).join(', ')}`]
          : []),
        ...r.notes.map((n) => `note: ${n}`),
        comps.length
          ? `next: ${[...(r.themes.length ? [`template_list {project: "${r.project}"}`] : []), `component_list {project: "${r.project}"}`].join(' and ')} show them as the project's own`
          : `next: template_list {project: "${r.project}"} shows them as the project's own`,
      ].join('\n'),
      data: { ...r, themes: r.themes.map(({ dir: _dir, ...t }) => t), ...(r.components ? { components: r.components.map(({ dir: _dir, ...c }) => c) } : {}) },
    };
  },
});

export const projectExport = defineOperation({
  name: 'project_export',
  title: 'Export a project as one ZIP (a project archive)',
  description:
    "Write the project as one ZIP file, a project archive, into its own exports/ folder (exports/<slug>-project-<stamp>.zip): its project.yaml, README, scenarios, hooks, assets and data, its own themes and components, and — so that the archive alone carries its look — the workspace themes and workspace components it uses (they land in the project's own templates/ and components/ when the archive is imported); starters and built-in components are named, not embedded. Never in it: the state folder (.retake/), .env files, sessions, exports/, key and credential files (*.pem, *.key, id_*, .netrc, .npmrc…), the files project.yaml names as a sign-in's saved state, the secrets of its sandbox's compose files. Its manifest (retake-project.json) lists every file with its sha256, and what the project needs on another machine by name only: environment variables and keychain items its {{env:…}} / {{keychain:…}} references name, the variables passed on, the personas to sign in. Values that look like literal tokens are flagged (file and lines, never the value). Through this server: without the runs, renders and reviews, and without the sandbox's compose files, images and env file (a person adds them with retake project export --with-runs / --with-sandbox), at most 1 GB, written at once (no job); dry_run: true says what would go in, writing nothing. A theme named by a path outside the project is refused (copy it into the project first). A person imports the archive elsewhere with retake project import; nothing of an imported project runs until a person trusts it there (retake project trust).",
  input: z.strictObject({
    project: projectSlug,
    dry_run: z.boolean().optional().describe('Only say what would go in (files, bytes, embedded themes and components, needs, exclusions): nothing written.'),
  }),
  annotations: WRITE_FILES,
  async run({ project, dry_run }, { engine }) {
    const r = await engine.projects.exportArchive({ project, ...(dry_run ? { dryRun: true } : {}) });
    const embedded = [...r.embedded.themes.map((t) => `theme ${t}`), ...r.embedded.components.map((c) => `component ${c}`)];
    const left = r.excluded.env.length + r.excluded.sensitive.length + r.excluded.links.length + r.excluded.special.length;
    const tokens = r.warnings.literal_tokens;
    const needs = r.needs.env_vars.length + r.needs.keychain.length + r.needs.sessions.length;
    const { file, ...rest } = r;
    return {
      summary: [
        `${r.dry_run ? 'would export' : 'exported'} project ${r.project}: ${plural(r.files, 'file')}, ${formatBytes(r.bytes)}${r.archive_bytes !== undefined ? ` (${formatBytes(r.archive_bytes)} zipped)` : ''}${embedded.length ? `, with the workspace's ${embedded.join(', ')}` : ''}`,
        ...(left ? [`left out: ${plural(left, 'file')} (.env files, key files, links: their paths in untrusted.excluded)`] : []),
        ...(r.excluded.outside_renders.length
          ? [`left out: ${plural(r.excluded.outside_renders.length, 'render')} rendered with a theme outside the project (re-render after import; ids in untrusted.excluded.outside_renders)`]
          : []),
        ...(needs
          ? [
              `needs on another machine (names in untrusted.needs): ${plural(r.needs.env_vars.length, 'environment variable')}, ${plural(r.needs.keychain.length, 'keychain item')}, ${plural(r.needs.sessions.length, 'persona')} to sign in`,
            ]
          : []),
        ...(tokens.length
          ? [`warning: ${plural(tokens.length, 'file')} hold what looks like a literal token (files and lines in untrusted.warnings) — it is in the archive: move it into {{env:…}} and export again`]
          : []),
        r.dry_run
          ? 'next: project_export {project} without dry_run writes it'
          : "the archive is in the project's exports/ folder (its path in data.file): a person imports it elsewhere with retake project import",
      ].join('\n'),
      data: {
        ...(file !== undefined ? { file } : {}),
        project: rest.project,
        dry_run: rest.dry_run,
        files: rest.files,
        bytes: rest.bytes,
        ...(rest.archive_bytes !== undefined ? { archive_bytes: rest.archive_bytes } : {}),
        embedded: rest.embedded,
        uses: rest.uses,
        // Names read from the project's files (environment variables, personas, paths): project text.
        untrusted: { needs: rest.needs, excluded: rest.excluded, warnings: rest.warnings, code_files: rest.code_files },
      },
    };
  },
});
