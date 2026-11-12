/**
 * The engine's operations (U7, from L7.13): every operation a shell serves that is defined here, in catalogue order,
 * each with its input, answer and name types (`OperationsByName`). The MCP server serves those it serves as these very
 * objects (its TOOLS), the Studio those it serves as they are or with its pinned arguments (pinArguments); both run them
 * through invoke.ts. Later lots move the other families here (U7: L7.16, L7.18, L7.19).
 */
import { authLogin, authStatus } from './auth.js';
import { projectBoard, projectsOverview } from './board.js';
import { componentCreate, componentGet, componentList, componentPreview, componentValidate } from './components.js';
import type { ToolsByName } from './define.js';
import { envReset, hooksRun } from './hooks.js';
import { pageInspect } from './inspect.js';
import { jobCancel, jobList } from './jobs.js';
import { libraryComponent, libraryImages, libraryRender, libraryView } from './library.js';
import { engineInfo, projectGet, projectList, projectUpdateReadme } from './project.js';
import { scenarioGet, scenarioValidate } from './reads.js';
import { renderReview, reviewImage, scenarioRenders } from './render-screen.js';
import { planPreview, renderStatus } from './renders.js';
import { reviewGet } from './reviews.js';
import { runCancel, runList, runStatus } from './runs.js';
import { sandboxReset, sandboxStatus, sandboxUp } from './sandbox.js';
import { runThumbs, scenarioActions, scenarioBlocks, scenarioForms, scenarioSessions } from './scenario-screen.js';
import { renderCancel, reviewExport, runPause, scenarioRender, scenarioRun, signInCancel } from './studio-jobs.js';
import { exportRender, render, review, runCapture, runDry } from './submit.js';
import { brandFiles, siteList, templateCreateFromBrand, templateFromSite, templateList, templatePreview, themeCopy, themeCreate, themeEdit, themeList, themeView } from './themes.js';

/**
 * Every engine operation, in catalogue order: the eleven MCP and the Studio share (L7.13); MCP's reads of scenarios,
 * plans, renders and reviews, and the Studio's screen reads (L7.14); the themes, components and the library (L7.17);
 * the submits and job controls of both (L7.15); MCP's hooks, environment reset and sandboxes (L7.19).
 */
export const OPERATIONS = [
  engineInfo,
  projectList,
  projectGet,
  projectUpdateReadme,
  scenarioGet,
  scenarioValidate,
  pageInspect,
  runList,
  runStatus,
  runDry,
  runCapture,
  runCancel,
  planPreview,
  render,
  renderStatus,
  review,
  reviewGet,
  exportRender,
  templateList,
  templatePreview,
  templateFromSite,
  templateCreateFromBrand,
  componentList,
  componentGet,
  componentValidate,
  componentPreview,
  componentCreate,
  jobList,
  jobCancel,
  hooksRun,
  envReset,
  authStatus,
  authLogin,
  sandboxStatus,
  sandboxUp,
  sandboxReset,
  projectsOverview,
  projectBoard,
  scenarioBlocks,
  scenarioActions,
  runThumbs,
  scenarioForms,
  scenarioRun,
  runPause,
  scenarioSessions,
  signInCancel,
  scenarioRender,
  scenarioRenders,
  renderCancel,
  renderReview,
  reviewImage,
  reviewExport,
  libraryView,
  libraryImages,
  libraryRender,
  libraryComponent,
  themeList,
  themeView,
  themeEdit,
  themeCopy,
  themeCreate,
  brandFiles,
  siteList,
] as const;

/** The engine's operations by name, as types (an operation's arguments and answer: ToolArgs / ToolData of its entry). */
export type OperationsByName = ToolsByName<(typeof OPERATIONS)[number]>;

/** The engine's operations by name: the same objects as OPERATIONS. */
export const OPERATIONS_BY_NAME: OperationsByName = Object.freeze(Object.fromEntries(OPERATIONS.map((o) => [o.name, o]))) as unknown as OperationsByName;
