/**
 * The MCP server's job tools: job_list (L7.13), job_cancel (L7.15) and job_status (L7.18, with its recording answer)
 * are the engine's operations, served here as these very objects in tools/list order.
 */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { ToolDef } from './define.js';

const { job_list: jobList, job_status: jobStatus, job_cancel: jobCancel } = OPERATIONS_BY_NAME;

export const JOB_TOOLS = [jobList, jobStatus, jobCancel] as const satisfies readonly ToolDef[];
