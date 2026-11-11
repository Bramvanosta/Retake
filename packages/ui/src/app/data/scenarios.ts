/**
 * L6.13: The scenario screen's reads (its view, the step forms, a run's pictures), the YAML check and the scenario's
 * one write (scenario_edit). Each op once, typed by StudioOps (data/ops.ts).
 */
import { op, readHook } from './client.js';
import type { OpArgs, OpResult } from './client.js';

export const scenarioBlocks = op('scenario_blocks');
export const useScenarioBlocks = readHook('scenario_blocks');
export const scenarioForms = op('scenario_forms');
export const scenarioValidate = op('scenario_validate');
export const scenarioEdit = op('scenario_edit');
export const runThumbs = op('run_thumbs');

/** One edit of scenario_edit (its input's `edit`: the YAML text, an earlier version, a step moved, changed or added, a switch). */
export type ScenarioEdit = OpArgs<'scenario_edit'>['edit'];
/** What scenario_edit answers (the version written, its label, what to select, the warnings and notices). */
export type ScenarioEditAnswer = OpResult<'scenario_edit'>;
