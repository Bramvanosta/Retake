/**
 * The Studio's scenario and Run screens' reads (moved from the Studio server's ops.ts in L7.14):
 * - `scenario_blocks` (L4.2): the scenario screen in one read — engine scenarios.view: text, hash, blocks, issues
 *   (without agent trust), run blockers worded for the Studio, scene URLs, the runs (picker), the source run and every
 *   step's binding to it; page text under `untrusted`. Memoised by the engine (file hash, runs' files). Plus `hints`:
 *   the scenario language's description of each action the file uses (the inspector's edit hints).
 * - `scenario_actions` (L5.11a): the status bar's read for the scenario in context — engine scenarios.actions: the
 *   file's hash and validity, the run blockers on the chosen location (each with its gate's `kind`), the runs with the
 *   unfinished one's job, the capture a render edits, a render queued or running. Memoised apart from scenario_blocks
 *   (critique H2: it never evicts the open scenario's view). Path-free but the blockers' commands (`fix`, `fix_node`).
 * - `run_thumbs` (L4.2): base64 JPEGs (≤ 480 px) of up to 24 steps of one run, by the run's own step keys — shown as
 *   `data:image/jpeg;base64,…` (the CSP's `img-src data:`), never stored. Not MCP tools: Claude reads files, run_status
 *   and review contact sheets.
 * - `scenario_forms` (L4.3): the step forms (core stepForms: each action's fields derived from its schema, the
 *   modifiers, the palette) — static, read once by the scenario screen.
 * - `scenario_sessions` (L4.4): the Run screen's preflight panel — engine auth.forScenario (the personas the run signs
 *   in, their stored state, `auto`; no path; the last check's text under `untrusted`) and `confirm`: the personas a
 *   capture's `sessions_ack` must name.
 */
import { z } from 'zod';
import { ACTION_DESCRIPTIONS } from '@retake/core/language';
import { stepForms } from '@retake/core/scenario';
import type { ActionName } from '@retake/core/model';
import { sessionsToConfirm } from '../admission.js';
import type { SessionToConfirm } from '../admission.js';
import type { Engine } from '../engine.js';
import type { ScenarioSessions } from '../facade/types.js';
import { RUN_KEY_RE, RUN_THUMBS_MAX_KEYS } from '../run-thumbs.js';
import { READ } from './annotations.js';
import { defineOperation } from './define.js';
import { studioEnv as env, studioProject as project, studioRun as run, studioScenario as scenario } from './studio-schema.js';
import { plural } from './words.js';

const BlocksInput = z.strictObject({
  project,
  name: scenario.describe('The scenario: scenarios/<name>.yaml of the project.'),
  run: run.optional().describe('The run whose pictures to show (default: the newest complete run with pictures).'),
  env: env.optional().describe("The environment (default: the scenario's env, else the project's default)."),
});

const ActionsInput = z.strictObject({
  project,
  name: scenario.describe('The scenario: scenarios/<name>.yaml of the project.'),
  env: env.optional().describe("The environment (default: the scenario's env, else the project's default)."),
});

const ThumbsInput = z.strictObject({
  project,
  run,
  keys: z
    .array(z.string().max(130).regex(RUN_KEY_RE, 'a step key of the run: "<scene id>.<step index>"'))
    .min(1)
    .max(RUN_THUMBS_MAX_KEYS)
    .describe(`The run's own step keys (scenario_blocks binds today's steps to them), 1 to ${RUN_THUMBS_MAX_KEYS}.`),
});

const SessionsInput = z.strictObject({
  project,
  name: scenario.describe('The scenario: scenarios/<name>.yaml of the project.'),
  env: env.optional().describe("The environment (default: the scenario's env, else the project's default)."),
  mode: z.enum(['dry', 'capture']).optional().describe('capture (default) counts the personas of the hooks\' tabs too.'),
});

const FormsInput = z.strictObject({});

export const scenarioBlocks = defineOperation({
  name: 'scenario_blocks',
  title: 'Scenario as blocks',
  description: "A scenario's text, blocks, issues and run blockers, its runs, and each step bound to the source run's pictures.",
  input: BlocksInput,
  annotations: READ,
  async run(a, { engine }) {
    const v = await engine.scenarios.view(a.project, a.name, { ...(a.run ? { run: a.run } : {}), ...(a.env ? { env: a.env } : {}) });
    const src = v.source ? `pictures from ${v.source.run}` : 'no run with pictures yet';
    // The inspector's edit hints: what each action of this file does (the scenario language's own descriptions).
    const hints: Partial<Record<ActionName, string>> = {};
    for (const e of v.blocks.entries) if (e.type === 'scene') for (const s of e.steps) if (s.action) hints[s.action] = ACTION_DESCRIPTIONS[s.action];
    return { summary: `${a.name}: ${plural(v.blocks.step_count, 'step')}, ${plural(v.issues.length, 'issue')}, ${src}`, data: { ...v, hints } };
  },
});

export const scenarioActions = defineOperation({
  name: 'scenario_actions',
  title: 'Scenario actions',
  description: "What the Studio's status bar acts on for a scenario: its hash, what would stop a rehearsal or a capture on the location, its runs, the capture a render edits, a render running.",
  input: ActionsInput,
  annotations: READ,
  async run(a, { engine }) {
    const v = await engine.scenarios.actions(a.project, a.name, { ...(a.env ? { env: a.env } : {}) });
    const blocked = v.run_blockers.dry.length + v.run_blockers.capture.length;
    return { summary: `${a.name}: ${v.running ? `a run ${v.running.status}` : 'no run going'}, ${plural(blocked, 'blocker')}`, data: v };
  },
});

export const runThumbs = defineOperation({
  name: 'run_thumbs',
  title: 'Thumbnails of run steps',
  description: "JPEG thumbnails (base64, ≤ 480 px) of a run's steps: dry-run screenshots, error screenshots, the frame at a capture step's end.",
  input: ThumbsInput,
  annotations: READ,
  async run(a, { engine, signal }) {
    const t = await engine.runs.thumbs(a.project, a.run, a.keys, { signal });
    return { summary: `${plural(t.thumbs.length, 'thumbnail')} of ${a.run}${t.missing.length ? `, ${t.missing.length} without one` : ''}`, data: t };
  },
});

export const scenarioForms = defineOperation({
  name: 'scenario_forms',
  title: 'Step forms',
  description: "The inspector's and the palette's forms: each action's fields (from the scenario language's schemas), the modifiers, the palette's actions.",
  input: FormsInput,
  annotations: READ,
  async run() {
    const f = stepForms();
    return { summary: `${plural(f.actions.length, 'action')}, ${plural(f.palette.length, 'palette action')}`, data: f };
  },
});

async function sessionsOf(engine: Engine, a: z.infer<typeof SessionsInput>): Promise<ScenarioSessions & { confirm: SessionToConfirm[] }> {
  const mode = a.mode ?? 'capture';
  const s = await engine.auth.forScenario(a.project, a.name, { ...(a.env ? { env: a.env } : {}), mode });
  return { ...s, confirm: mode === 'capture' ? sessionsToConfirm(s) : [] };
}

export const scenarioSessions = defineOperation({
  name: 'scenario_sessions',
  title: 'Sessions a scenario needs',
  description: "The personas a run of a scenario signs in on an environment, with their stored state (no browser), whether every run signs them in by itself, and those a capture must confirm (`confirm`).",
  input: SessionsInput,
  annotations: READ,
  async run(a, { engine }) {
    const s = await sessionsOf(engine, a);
    return {
      summary: `${a.name} on ${s.env}: ${plural(s.personas.length, 'persona')}${s.confirm.length ? `, ${s.confirm.length} to confirm for a capture` : ''}`,
      data: s,
    };
  },
});
