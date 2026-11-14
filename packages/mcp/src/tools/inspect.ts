/**
 * The MCP server's page_inspect: the engine's operation (L7.15, R-MCP-23 / R-MCP-36), served here as that very object;
 * job_status answers an inspection job with the contract's inspectOutput.
 */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { ToolDef } from './define.js';

const { page_inspect: pageInspect } = OPERATIONS_BY_NAME;

export const INSPECT_TOOLS = [pageInspect] as const satisfies readonly ToolDef[];
