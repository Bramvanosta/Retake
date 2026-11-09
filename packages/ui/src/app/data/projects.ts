/**
 * L6.13: The project side's reads (Welcome, the Project screen, Lately, the search, the README editor) and the
 * README's write. Each op once, typed by StudioOps (data/ops.ts).
 */
import { call } from '../api.js';
import { op, readHook } from './client.js';

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

/** The project reads project-data.ts loads by its own table (ProjectOp): a project's view, its board, its sessions. */
export function projectRead(name: 'project_get' | 'project_board' | 'auth_status', args: { project: string }): Promise<unknown> {
  return call(name, args);
}
