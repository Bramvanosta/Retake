/**
 * L6.13: Renders and the Review report: a render, the render list, Cancel, the review, its contact sheets, the export.
 * Each op once, typed by StudioOps (data/ops.ts).
 */
import { op, readHook } from './client.js';

export const scenarioRender = op('scenario_render');
export const useScenarioRenders = readHook('scenario_renders');
export const renderCancel = op('render_cancel');
export const useRenderReview = readHook('render_review');
export const reviewImage = op('review_image');
export const reviewExport = op('review_export');
