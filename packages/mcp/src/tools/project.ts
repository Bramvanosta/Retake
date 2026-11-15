/**
 * The MCP server's project tools: the engine's operations (engine_info, project_list, project_get,
 * project_update_readme, project_create, project_prune — the approver is handed through by invoke), in the
 * order tools/list gives them. `projectPrune` is named for the tests that call it directly.
 */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { Op, ToolDef } from './define.js';

const { engine_info: engineInfo, project_list: projectList, project_get: projectGet, project_create: projectCreate, project_update_readme: projectUpdateReadme } = OPERATIONS_BY_NAME;
export const projectPrune: Op<'project_prune'> = OPERATIONS_BY_NAME.project_prune;

/** The project tools, in the order tools/list gives them. */
export const PROJECT_TOOLS: readonly [Op<'engine_info'>, Op<'project_list'>, Op<'project_get'>, Op<'project_create'>, Op<'project_update_readme'>, Op<'project_prune'>] = [
  engineInfo,
  projectList,
  projectGet,
  projectCreate,
  projectUpdateReadme,
  projectPrune,
] as const satisfies readonly ToolDef[];
