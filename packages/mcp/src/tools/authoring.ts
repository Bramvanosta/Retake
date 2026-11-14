/**
 * The MCP server's authoring tools: scenario_record and scenario_from_script are the engine's operations since L7.18
 * (packages/engine/src/operations/authoring.ts, with `recordOutput`, which job_status answers a recording with), served
 * here as these very objects in tools/list order.
 */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { ToolDef } from './define.js';

const { scenario_record: scenarioRecord, scenario_from_script: scenarioFromScript } = OPERATIONS_BY_NAME;

export const AUTHORING_TOOLS = [scenarioRecord, scenarioFromScript] as const satisfies readonly ToolDef[];
