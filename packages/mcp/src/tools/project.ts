/**
 * The MCP server's project tools: the engine's operations (L7.13: engine_info, project_list, project_get,
 * project_update_readme; L7.18: project_create, project_prune — the approver is handed through by invoke), in the
 * order tools/list gives them. `projectPrune` is named for the tests that call it directly.
 */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { ToolDef } from './define.js';

const { engine_info: engineInfo, project_list: projectList, project_get: projectGet, project_create: projectCreate, project_update_readme: projectUpdateReadme } = OPERATIONS_BY_NAME;
export const { project_prune: projectPrune } = OPERATIONS_BY_NAME;

/** The project tools, in the order tools/list gives them. */
export const PROJECT_TOOLS = [engineInfo, projectList, projectGet, projectCreate, projectUpdateReadme, projectPrune] as const satisfies readonly ToolDef[];
