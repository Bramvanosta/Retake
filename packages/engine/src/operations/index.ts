/**
 * The engine's operations (U7, from L7.13): every operation a shell serves that is defined here, in catalogue order,
 * each with its input, answer and name types (`OperationsByName`). The MCP server serves those it serves as these very
 * objects (its TOOLS), the Studio those it serves as they are or with its pinned arguments (pinArguments); both run them
 * through invoke.ts. Later lots move the other families here (U7: L7.15–L7.19).
 */
import { authLogin, authStatus } from './auth.js';
import { projectBoard, projectsOverview } from './board.js';
import type { ToolsByName } from './define.js';
import { jobList } from './jobs.js';
import { engineInfo, projectGet, projectList, projectUpdateReadme } from './project.js';
import { scenarioGet, scenarioValidate } from './reads.js';
import { renderReview, reviewImage, scenarioRenders } from './render-screen.js';
import { planPreview, renderStatus } from './renders.js';
import { reviewGet } from './reviews.js';
import { runCancel, runList, runStatus } from './runs.js';
import { runThumbs, scenarioActions, scenarioBlocks, scenarioForms, scenarioSessions } from './scenario-screen.js';

/**
 * Every engine operation, in catalogue order: the eleven MCP and the Studio share (L7.13); MCP's reads of scenarios,
 * plans, renders and reviews, and the Studio's screen reads (L7.14).
 */
export const OPERATIONS = [
  engineInfo,
  projectList,
  projectGet,
  projectUpdateReadme,
  scenarioGet,
  scenarioValidate,
  runList,
  runStatus,
  runCancel,
  planPreview,
  renderStatus,
  reviewGet,
  jobList,
  authStatus,
  authLogin,
  projectsOverview,
  projectBoard,
  scenarioBlocks,
  scenarioActions,
  runThumbs,
  scenarioForms,
  scenarioSessions,
  scenarioRenders,
  renderReview,
  reviewImage,
] as const;

/** The engine's operations by name, as types (an operation's arguments and answer: ToolArgs / ToolData of its entry). */
export type OperationsByName = ToolsByName<(typeof OPERATIONS)[number]>;

/** The engine's operations by name: the same objects as OPERATIONS. */
export const OPERATIONS_BY_NAME: OperationsByName = Object.freeze(Object.fromEntries(OPERATIONS.map((o) => [o.name, o]))) as unknown as OperationsByName;
