/**
 * L6.13: Shoot: the status bar's actions on the scenario in context, a run's controls and progress, the Cast's
 * sessions and sign-ins. Each op once, typed by StudioOps (data/ops.ts).
 */
import { op, readHook } from './client.js';

export const scenarioActions = op('scenario_actions');
export const scenarioRun = op('scenario_run');
export const useScenarioSessions = readHook('scenario_sessions');
export const runStatus = op('run_status');
export const runCancel = op('run_cancel');
export const runPause = op('run_pause');
export const authLogin = op('auth_login');
export const signInCancel = op('sign_in_cancel');
export const jobList = op('job_list');
