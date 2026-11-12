import { z } from 'zod';
import { zThemeName } from '@retake/core';
import { README_MAX_CHARS, formatBytes } from '@retake/engine';
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import { envName, projectSlug } from '../schema.js';
import { plural } from '../result.js';
import { WRITE_FILES, defineTool } from './define.js';
import type { ToolDef } from './define.js';
import type { ToolAnnotations } from '../server.js';

const pageUrl = z.string().min(1).max(2000);
const pageMap = z
  .record(z.string().min(1).max(100), z.union([pageUrl, z.strictObject({ url: pageUrl, display: z.string().min(1).max(2000).optional() })]))
  .describe('Page key → base URL, or {url, display} (display: the URL the browser frame shows instead, e.g. the production host for a local page), e.g. {"app": "https://app.staging.example.com"}.');

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

export const projectPrune = defineTool({
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

const { engine_info: engineInfo, project_list: projectList, project_get: projectGet, project_update_readme: projectUpdateReadme } = OPERATIONS_BY_NAME;

/** The project tools, in the order tools/list gives them: the engine's operations (L7.13) and MCP's own. */
export const PROJECT_TOOLS = [engineInfo, projectList, projectGet, projectCreate, projectUpdateReadme, projectPrune] as const satisfies readonly ToolDef[];
