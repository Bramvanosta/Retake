/**
 * The MCP server's project tools: the engine's operations (engine_info, project_list, project_get,
 * project_update_readme, project_create, project_env_set, project_env_remove, project_prune, project_adopt, project_export — the approver is handed
 * through by invoke), in the
 * order tools/list gives them. `projectPrune` is named for the tests that call it directly.
 */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { Op, ToolDef } from './define.js';

const {
  engine_info: engineInfo,
  project_list: projectList,
  project_get: projectGet,
  project_create: projectCreate,
  project_update_readme: projectUpdateReadme,
  project_env_set: projectEnvSet,
  project_env_remove: projectEnvRemove,
} = OPERATIONS_BY_NAME;
export const projectPrune: Op<'project_prune'> = OPERATIONS_BY_NAME.project_prune;
const { project_adopt: projectAdopt, project_export: projectExport } = OPERATIONS_BY_NAME;

/** The project tools, in the order tools/list gives them. */
export const PROJECT_TOOLS: readonly [
  Op<'engine_info'>,
  Op<'project_list'>,
  Op<'project_get'>,
  Op<'project_create'>,
  Op<'project_update_readme'>,
  Op<'project_env_set'>,
  Op<'project_env_remove'>,
  Op<'project_prune'>,
  Op<'project_adopt'>,
  Op<'project_export'>,
] = [engineInfo, projectList, projectGet, projectCreate, projectUpdateReadme, projectEnvSet, projectEnvRemove, projectPrune, projectAdopt, projectExport] as const satisfies readonly ToolDef[];
