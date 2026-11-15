/**
 * The MCP server's job tools: job_list, job_cancel and job_status (with its recording answer)
 * are the engine's operations, served here as these very objects in tools/list order.
 */
import { OPERATIONS_BY_NAME } from '@retake/engine/contract';
import type { Op, ToolDef } from './define.js';

const { job_list: jobList, job_status: jobStatus, job_cancel: jobCancel } = OPERATIONS_BY_NAME;

export const JOB_TOOLS: readonly [Op<'job_list'>, Op<'job_status'>, Op<'job_cancel'>] = [jobList, jobStatus, jobCancel] as const satisfies readonly ToolDef[];
