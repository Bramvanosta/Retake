/**
 * L6.13: The project side's reads (Welcome, the Project screen, Lately, the search, the README editor) and the
 * README's write. Each op once, typed by StudioOps (data/ops.ts).
 */
import { op, readHook } from './client.js';
import type { OpResult } from './client.js';

export const engineInfo = op('engine_info');
export const useEngineInfo = readHook('engine_info');
export const useProjectList = readHook('project_list');
export const projectGet = op('project_get');
export const useProjectGet = readHook('project_get');
export const projectUpdateReadme = op('project_update_readme');
export const useProjectsOverview = readHook('projects_overview');
export const activityList = op('activity_list');
export const useActivityList = readHook('activity_list');
export const search = op('search');
export const useRunList = readHook('run_list');

/** The project's reads project-data.ts holds per project (its ProjectOp): its view, its board, its sessions (the Cast). */
const PROJECT_READS = { project_get: projectGet, project_board: op('project_board'), auth_status: op('auth_status') };
export type ProjectRead = keyof typeof PROJECT_READS;

/** One of the project's reads, by name: the op's own function (project_get is projectGet), `{project}` its arguments. */
export function projectRead<K extends ProjectRead>(name: K, args: { project: string }): Promise<OpResult<K>> {
  // PROJECT_READS[K] is OpCall<K>, each taking `{project}`: the checker cannot pick the branch of OpParams<K> for a K.
  const read = PROJECT_READS[name] as unknown as (a: { project: string }) => Promise<OpResult<K>>;
  return read(args);
}
