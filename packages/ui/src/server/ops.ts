/**
 * The Studio's own ops (L4.1): reads in the MCP tool shape (a zod input, a summary and data) so `/v1/call/<op>` runs
 * them through the same `callTool` — but they are not MCP tools: Claude reads files, project_get, run_list and job_list
 * instead, and the MCP server never depends on this package.
 *
 * - `activity_list`: unfinished jobs, live from the queue (derived states included), then finished jobs and CLI
 *   commands from the history — ids, kinds, states and times only (no product text: history lines carry none).
 * - `search`: projects (name, slug, README), scenarios, runs and renders matching every word as a prefix.
 * - `projects_overview`: what the Projects screen's cards show beyond project_list — every project's environment flags
 *   (project_get's) and last run (run_list's) — in one call (review B L2: a card per project made two calls each, at
 *   every focus and reconnection).
 */
import { z } from 'zod';
import { PROJECT_SLUG_RE } from '@demo-studio/core';
import { firstErrorLine } from '@demo-studio/engine';
import type { EnvironmentView, RunListItem } from '@demo-studio/engine';
import type { ToolDef } from '@demo-studio/mcp';
import type { Live } from './live.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const project = z.string().max(100).regex(PROJECT_SLUG_RE, 'a project slug (project_list names them), never a path');

const ActivityInput = z.strictObject({
  project: project.optional().describe('Only this project.'),
  limit: z.number().int().min(1).max(100).optional().describe('At most this many entries (default 20).'),
});

const SearchInput = z.strictObject({
  q: z.string().max(200).describe('Words to find (each one as a prefix): project names and READMEs, scenario names, run and render ids.'),
  project: project.optional().describe('Only this project.'),
  limit: z.number().int().min(1).max(50).optional().describe('At most this many hits (default 20).'),
});

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const OverviewInput = z.strictObject({});

/** A card's extras: environment flags and the last run (or why the project does not open). */
export interface ProjectOverview {
  slug: string;
  environments: Array<Pick<EnvironmentView, 'name' | 'production' | 'access' | 'sandbox'>>;
  last_run: RunListItem | null;
  error?: string;
}

/** projects_overview: engine reads (project_get's environments, run_list's newest run) for every project at once. */
export function overviewOp(): ToolDef {
  const op: ToolDef<typeof OverviewInput> = {
    name: 'projects_overview',
    title: 'Projects overview',
    description: "Every project's environments (production / read-only / sandbox flags) and last run, for the Projects screen.",
    input: OverviewInput,
    annotations: READ,
    async run(_a, { engine }) {
      const list = await engine.projects.list();
      const projects: ProjectOverview[] = await Promise.all(
        list.map(async (p): Promise<ProjectOverview> => {
          if (p.error) return { slug: p.slug, environments: [], last_run: null, error: p.error };
          try {
            const [view, runs] = await Promise.all([engine.projects.get(p.slug), engine.runs.list(p.slug, { limit: 1 })]);
            return { slug: p.slug, environments: view.environments.map((e) => ({ name: e.name, production: e.production, access: e.access, sandbox: e.sandbox })), last_run: runs[0] ?? null };
          } catch (e) {
            return { slug: p.slug, environments: [], last_run: null, error: firstErrorLine(e instanceof Error ? e.message : String(e)) };
          }
        }),
      );
      return { summary: plural(projects.length, 'project'), data: { projects } };
    },
  };
  return op as unknown as ToolDef;
}

/** activity_list and search, served from `live`'s index. */
export function indexOps(live: Live): ToolDef[] {
  const activity: ToolDef<typeof ActivityInput> = {
    name: 'activity_list',
    title: 'Recent activity',
    description: 'Unfinished jobs (live from the queue) then finished jobs and CLI commands (history), newest first.',
    input: ActivityInput,
    annotations: READ,
    async run(a) {
      const items = await (await live.freshIndex()).activity({ ...(a.project ? { project: a.project } : {}), limit: a.limit ?? 20 });
      const open = items.filter((i) => i.source === 'queue').length;
      return { summary: `${plural(items.length, 'entry')} (${open} unfinished)`, data: { items } };
    },
  };
  const search: ToolDef<typeof SearchInput> = {
    name: 'search',
    title: 'Search the workspace',
    description: 'Projects, scenarios, runs and renders matching every word (as a prefix), best first.',
    input: SearchInput,
    annotations: READ,
    async run(a) {
      const hits = (await live.freshIndex()).search(a.q, { ...(a.project ? { project: a.project } : {}), limit: a.limit ?? 20 });
      return { summary: plural(hits.length, 'hit'), data: { q: a.q, hits } };
    },
  };
  return [activity, search] as unknown as ToolDef[];
}

/** The names of the Studio's own ops (not MCP tools). */
export const INDEX_OPS = ['activity_list', 'search'] as const;
export const OWN_OPS = [...INDEX_OPS, 'projects_overview'] as const;
