/** The MCP server's scenario tools: the engine's operations (scenario_get L7.14, scenario_validate L7.13, scenario_save L7.18), in tools/list order. */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { Op, ToolDef } from './define.js';

const { scenario_get: scenarioGet, scenario_validate: scenarioValidate, scenario_save: scenarioSave } = OPERATIONS_BY_NAME;

export const SCENARIO_TOOLS: readonly [Op<'scenario_get'>, Op<'scenario_validate'>, Op<'scenario_save'>] = [scenarioGet, scenarioValidate, scenarioSave] as const satisfies readonly ToolDef[];
