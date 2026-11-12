/**
 * The Studio's Projects and Project screens' reads (moved from the Studio server's ops.ts in L7.14):
 * - `projects_overview`: what the Projects screen's cards show beyond project_list — every project's environment flags
 *   (project_get's) and last run (run_list's) — in one call (review B L2: a card per project made two calls each, at
 *   every focus and reconnection).
 * - `project_board` (L5.10a): the Project screen's poster grid, smart groups and inspector in one read — engine
 *   projects.board (every scenario's file facts, takes, capture "current", render and review, render job, length,
 *   poster), path-free, the video titles under `untrusted`. Its memos are the board's own: reading it never evicts the
 *   open scenario screen's view (critique H1).
 */
import { z } from 'zod';
import type { RunListItem } from '../facade/types.js';
import { firstErrorLine } from '../projects.js';
import type { EnvironmentView } from '../projects.js';
import { READ } from './annotations.js';
import { defineOperation } from './define.js';
import { studioProject as project } from './studio-schema.js';
import { plural } from './words.js';

const OverviewInput = z.strictObject({});
const BoardInput = z.strictObject({ project });

/** A card's extras: environment flags and the last run (or why the project does not open). */
export interface ProjectOverview {
  slug: string;
  environments: Array<Pick<EnvironmentView, 'name' | 'production' | 'access' | 'sandbox'>>;
  last_run: RunListItem | null;
  error?: string;
}

/** projects_overview: engine reads (project_get's environments, run_list's newest run) for every project at once. */
export const projectsOverview = defineOperation({
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
});

export const projectBoard = defineOperation({
  name: 'project_board',
  title: 'Project board',
  description: "Every scenario of a project for the Studio's Project screen: file facts, running and last take, capture, render and review, length and poster.",
  input: BoardInput,
  annotations: READ,
  async run(a, { engine }) {
    const v = await engine.projects.board(a.project);
    return { summary: `${a.project}: ${plural(v.scenarios.length, 'scenario')}${v.truncated ? ` of ${v.truncated.total}` : ''}`, data: v };
  },
});
