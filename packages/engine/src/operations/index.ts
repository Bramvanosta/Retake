/**
 * The engine's operations (U7, from L7.13): every operation a shell serves that is defined here, in catalogue order,
 * each with its input, answer and name types (`OperationsByName`). The MCP server serves those it serves as these very
 * objects (its TOOLS), the Studio those it serves as they are or with its pinned arguments (pinArguments); both run them
 * through invoke.ts. Later lots move the other families here.
 */
import { authLogin, authStatus } from './auth.js';
import type { ToolsByName } from './define.js';
import { jobList } from './jobs.js';
import { engineInfo, projectGet, projectList, projectUpdateReadme } from './project.js';
import { scenarioValidate } from './reads.js';
import { runCancel, runList, runStatus } from './runs.js';

/** Every engine operation, in catalogue order. */
export const OPERATIONS = [engineInfo, projectList, projectGet, projectUpdateReadme, scenarioValidate, runList, runStatus, runCancel, jobList, authStatus, authLogin] as const;

/** The engine's operations by name, as types (an operation's arguments and answer: ToolArgs / ToolData of its entry). */
export type OperationsByName = ToolsByName<(typeof OPERATIONS)[number]>;

/** The engine's operations by name: the same objects as OPERATIONS. */
export const OPERATIONS_BY_NAME: OperationsByName = Object.freeze(Object.fromEntries(OPERATIONS.map((o) => [o.name, o]))) as unknown as OperationsByName;
