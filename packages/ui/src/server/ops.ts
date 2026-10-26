/**
 * The Studio's own ops (L4.1): reads in the MCP tool shape (a zod input, a summary and data) so `/v1/call/<op>` runs
 * them through the same `callTool` — but they are not MCP tools: Claude reads files, project_get, run_list and job_list
 * instead, and the MCP server never depends on this package.
 *
 * - `activity_list`: unfinished jobs, live from the queue (derived states included), then finished jobs and CLI
 *   commands from the history — ids, kinds, states and times only (no product text: history lines carry none).
 * - `search`: projects (name, slug, README), scenarios, runs and renders matching every word as a prefix.
 * - `projects_overview`: what the Projects screen's cards show beyond project_list — every project's environment flags
 *   (project_get's) and last run (run_list's) — in one call (review B L2: a card per project made two calls each, at
 *   every focus and reconnection).
 * - `scenario_blocks` (L4.2): the scenario screen in one read — engine scenarios.view: text, hash, blocks, issues
 *   (without agent trust), run blockers worded for the Studio, scene URLs, the runs (picker), the source run and every
 *   step's binding to it; page text under `untrusted`. Memoised by the engine (file hash, runs' files). Plus `hints`:
 *   the scenario language's description of each action the file uses (the inspector's edit hints).
 * - `scenario_forms` (L4.3): the step forms (core stepForms: each action's fields derived from its schema, the
 *   modifiers, the palette) — static, read once by the scenario screen.
 * - `run_thumbs` (L4.2): base64 JPEGs (≤ 480 px) of up to 24 steps of one run, by the run's own step keys — shown as
 *   `data:image/jpeg;base64,…` (the CSP's `img-src data:`), never stored. Not MCP tools: Claude reads files, run_status
 *   and review contact sheets.
 * - `scenario_run` (L4.2, critique B11): the scenario screen's Dry run and Capture — engine runs.submit with pinned
 *   arguments: the mode, the scenario, an environment of the project; the default hooks (none for a dry run, all for a
 *   capture), never a sandbox reset, never `until`, never a wait. It runs under the `ui` client's agent trust with no
 *   approver, so what the screen showed as a run blocker is refused here too (the submit is the authority) with the
 *   `studio run …` command to type in a terminal. `hash` (the file as the screen showed it) makes a changed file a 409;
 *   a run of the scenario already queued or running makes another a 409 (one submit per scenario at a time). Not an
 *   MCP tool: Claude has run_dry / run_capture.
 */
import { z } from 'zod';
import { ACTION_DESCRIPTIONS, PALETTE_ACTIONS, PROJECT_SLUG_RE, SCENARIO_EDIT_MAX_CHARS, SLUG_RE, stepForms } from '@demo-studio/core';
import type { ActionName } from '@demo-studio/core';
import { EngineError, RUN_ID_RE, RUN_KEY_RE, RUN_THUMBS_MAX_KEYS, firstErrorLine } from '@demo-studio/engine';
import type { EnvironmentView, RunListItem } from '@demo-studio/engine';
import type { ToolDef } from '@demo-studio/mcp';
import type { Live } from './live.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const project = z.string().max(100).regex(PROJECT_SLUG_RE, 'a project slug (project_list names them), never a path');

const ActivityInput = z.strictObject({
  project: project.optional().describe('Only this project.'),
  limit: z.number().int().min(1).max(100).optional().describe('At most this many entries (default 20).'),
});

const SearchInput = z.strictObject({
  q: z.string().max(200).describe('Words to find (each one as a prefix): project names and READMEs, scenario names, run and render ids.'),
  project: project.optional().describe('Only this project.'),
  limit: z.number().int().min(1).max(50).optional().describe('At most this many hits (default 20).'),
});

const scenario = z.string().max(100).regex(SLUG_RE, 'a scenario name (scenarios/<name>.yaml), never a path');
const run = z.string().max(200).regex(RUN_ID_RE, 'a run id (scenario_blocks lists them), never a path');
const env = z.string().max(100).regex(SLUG_RE, 'an environment name of the project');

const BlocksInput = z.strictObject({
  project,
  name: scenario.describe('The scenario: scenarios/<name>.yaml of the project.'),
  run: run.optional().describe('The run whose pictures to show (default: the newest complete run with pictures).'),
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

const RunInput = z.strictObject({
  project,
  name: scenario.describe('The scenario: scenarios/<name>.yaml of the project.'),
  mode: z.enum(['dry', 'capture']).describe('A dry run (no hooks, a screenshot per step) or a capture (its hooks, the video).'),
  env: env.optional().describe("The environment (default: the scenario's env, else the project's default)."),
  hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'the sha256 of the file as scenario_blocks showed it')
    .optional()
    .describe('The file as the screen showed it (scenario_blocks `hash`): refused (409) when the file checked is another one.'),
});

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256 (64 lower-case hex characters)');
const editText = z.string().max(SCENARIO_EDIT_MAX_CHARS, `at most ${SCENARIO_EDIT_MAX_CHARS.toLocaleString('en')} characters`);

const sceneId = z.string().max(100).regex(SLUG_RE, 'a scene id of the file');
const stepIndex = z.number().int().min(0).max(100_000);
/** A step as the screen showed it: scene id, index, and its guard (scenario_blocks `guard`, critique B2). */
const StepAtInput = z.strictObject({
  scene: sceneId,
  index: stepIndex.describe('Its index in the scene (0-based).'),
  guard: z.string().regex(/^[0-9a-f]{16}$/, 'the step\'s guard as scenario_blocks gave it (16 hex characters)'),
});

/** A form field's value (critique B9 is checked by core, which names the field): one line of text, a number, yes / no. */
const fieldValue = z.union([z.string().max(10_000, 'at most 10,000 characters'), z.number().finite(), z.boolean()]);
const fieldSeg = z.string().regex(/^[a-z][a-z_]{0,39}$/, 'a field name of the form (lower-case letters and _)');
/** A form field's key, dotted ("type.into.label"): at most three levels (a flat target). */
const fieldKey = z.string().max(122).regex(/^[a-z][a-z_]{0,39}(\.[a-z][a-z_]{0,39}){0,2}$/, 'a field key of the form ("type.text", "click.in")');
const FieldChangeInput = z.strictObject({
  path: z.array(fieldSeg).min(1).max(3).describe('The field, as its key split on dots: ["type", "text"], ["caption", "text"], ["hold"].'),
  from: fieldValue.optional().describe('The value the form showed (absent: none) — the change is applied only while the file still holds it.'),
  to: fieldValue.optional().describe('The new value (absent: the value is removed).'),
});

const EditInput = z.strictObject({
  project,
  name: scenario.describe('The scenario: the file scenario_blocks read (scenarios/<name>.yaml, or an existing .yml).'),
  hash: sha256.describe('The file as the screen showed it (scenario_blocks `hash`): refused (409) when the file changed since.'),
  edit: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('replace_text'), text: editText.describe('The YAML tab\'s text (a final line break is added when missing).') }),
      z.strictObject({
        kind: z.literal('restore'),
        text: editText.describe('The exact text of an earlier version (undo / redo).'),
        text_hash: sha256.describe('Its sha256: the text is written byte for byte, checked against it.'),
      }),
      z.strictObject({
        kind: z.literal('move_step'),
        from: StepAtInput,
        to: z.strictObject({ scene: sceneId, index: stepIndex.describe('Its index in that scene once moved (in its own scene: counted without it).') }),
      }),
      z.strictObject({ kind: z.literal('delete_step'), at: StepAtInput }),
      z.strictObject({ kind: z.literal('duplicate_step'), at: StepAtInput.describe('The step to copy (the copy goes right after it, without id or mark, a capture renamed).') }),
      z.strictObject({
        kind: z.literal('set_step'),
        at: StepAtInput,
        changes: z.array(FieldChangeInput).min(1).max(40).describe("The form's changed fields (scenario_forms names them)."),
      }),
      z.strictObject({
        kind: z.literal('insert_step'),
        to: z.strictObject({ scene: sceneId, index: stepIndex.describe('Its index in the scene once added.') }),
        after: z
          .string()
          .regex(/^[0-9a-f]{16}$/, "the guard of the step before that place, as scenario_blocks gave it")
          .nullable()
          .describe('The guard of the step just before that place (null at the start of the scene).'),
        action: z.enum(PALETTE_ACTIONS as unknown as [ActionName, ...ActionName[]]).describe('An action of the palette.'),
        values: z.record(fieldKey, fieldValue).describe("The new step's form values (scenario_forms names the fields).").refine((v) => Object.keys(v).length <= 40, 'at most 40 values'),
      }),
    ])
    .describe('One edit.'),
});

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const OverviewInput = z.strictObject({});
const FormsInput = z.strictObject({});

/** A card's extras: environment flags and the last run (or why the project does not open). */
export interface ProjectOverview {
  slug: string;
  environments: Array<Pick<EnvironmentView, 'name' | 'production' | 'access' | 'sandbox'>>;
  last_run: RunListItem | null;
  error?: string;
}

/** projects_overview: engine reads (project_get's environments, run_list's newest run) for every project at once. */
export function overviewOp(): ToolDef {
  const op: ToolDef<typeof OverviewInput> = {
    name: 'projects_overview',
    title: 'Projects overview',
    description: "Every project's environments (production / read-only / sandbox flags) and last run, for the Projects screen.",
    input: OverviewInput,
    annotations: READ,
    async run(_a, { engine }) {
      const list = await engine.projects.list();
      const projects: ProjectOverview[] = await Promise.all(
        list.map(async (p): Promise<ProjectOverview> => {
          if (p.error) return { slug: p.slug, environments: [], last_run: null, error: p.error };
          try {
            const [view, runs] = await Promise.all([engine.projects.get(p.slug), engine.runs.list(p.slug, { limit: 1 })]);
            return { slug: p.slug, environments: view.environments.map((e) => ({ name: e.name, production: e.production, access: e.access, sandbox: e.sandbox })), last_run: runs[0] ?? null };
          } catch (e) {
            return { slug: p.slug, environments: [], last_run: null, error: firstErrorLine(e instanceof Error ? e.message : String(e)) };
          }
        }),
      );
      return { summary: plural(projects.length, 'project'), data: { projects } };
    },
  };
  return op as unknown as ToolDef;
}

/** activity_list and search, served from `live`'s index. */
export function indexOps(live: Live): ToolDef[] {
  const activity: ToolDef<typeof ActivityInput> = {
    name: 'activity_list',
    title: 'Recent activity',
    description: 'Unfinished jobs (live from the queue) then finished jobs and CLI commands (history), newest first.',
    input: ActivityInput,
    annotations: READ,
    async run(a) {
      const items = await (await live.freshIndex()).activity({ ...(a.project ? { project: a.project } : {}), limit: a.limit ?? 20 });
      const open = items.filter((i) => i.source === 'queue').length;
      return { summary: `${plural(items.length, 'entry')} (${open} unfinished)`, data: { items } };
    },
  };
  const search: ToolDef<typeof SearchInput> = {
    name: 'search',
    title: 'Search the workspace',
    description: 'Projects, scenarios, runs and renders matching every word (as a prefix), best first.',
    input: SearchInput,
    annotations: READ,
    async run(a) {
      const hits = (await live.freshIndex()).search(a.q, { ...(a.project ? { project: a.project } : {}), limit: a.limit ?? 20 });
      return { summary: plural(hits.length, 'hit'), data: { q: a.q, hits } };
    },
  };
  return [activity, search] as unknown as ToolDef[];
}

/** scenario_blocks and run_thumbs: the scenario screen's reads (engine scenarios.view, runs.thumbs). */
export function scenarioOps(): ToolDef[] {
  const blocks: ToolDef<typeof BlocksInput> = {
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
      return { summary: `${a.name}: ${plural(v.blocks.step_count, 'step')}, ${plural(v.issues.length, 'issue')}, ${src}`, data: { ...v, hints } as unknown as Record<string, unknown> };
    },
  };
  const thumbs: ToolDef<typeof ThumbsInput> = {
    name: 'run_thumbs',
    title: 'Thumbnails of run steps',
    description: "JPEG thumbnails (base64, ≤ 480 px) of a run's steps: dry-run screenshots, error screenshots, the frame at a capture step's end.",
    input: ThumbsInput,
    annotations: READ,
    async run(a, { engine, signal }) {
      const t = await engine.runs.thumbs(a.project, a.run, a.keys, { signal });
      return { summary: `${plural(t.thumbs.length, 'thumbnail')} of ${a.run}${t.missing.length ? `, ${t.missing.length} without one` : ''}`, data: t as unknown as Record<string, unknown> };
    },
  };
  const forms: ToolDef<typeof FormsInput> = {
    name: 'scenario_forms',
    title: 'Step forms',
    description: "The inspector's and the palette's forms: each action's fields (from the scenario language's schemas), the modifiers, the palette's actions.",
    input: FormsInput,
    annotations: READ,
    async run() {
      const f = stepForms();
      return { summary: `${plural(f.actions.length, 'action')}, ${plural(f.palette.length, 'palette action')}`, data: f as unknown as Record<string, unknown> };
    },
  };
  return [blocks, thumbs, forms] as unknown as ToolDef[];
}

/** What scenario_run answers: the run reserved and its job (the screen follows it with run_status and the events). */
export interface ScenarioRunAnswer {
  run_id: string;
  job: string;
  state: string;
  mode: 'dry' | 'capture';
  warnings: string[];
  /** The worker serving the queue: started now, or already running (absent: not started — tests). */
  worker?: { pid?: number; spawned: boolean };
}

/** scenario_run: the scenario screen's Dry run / Capture, arguments pinned (B11). */
export function runOps(): ToolDef[] {
  // One submit of a scenario at a time in this Studio (two tabs, a double click), and none while a run of it waits or
  // runs (review B L2: two dry runs queued, or a capture's hooks run twice).
  const chains = new Map<string, Promise<unknown>>();
  const oneAtATime = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const next = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return next;
  };
  const run: ToolDef<typeof RunInput> = {
    name: 'scenario_run',
    title: 'Run a scenario from the Studio',
    description: 'Queue a dry run or a capture of a scenario: default hooks, no sandbox reset, no until; refused (with the studio run command) when a hook needs a person.',
    input: RunInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(a, { engine }) {
      const sub = await oneAtATime(`${a.project}\0${a.name}`, async () => {
        const open = await engine.jobs.list({ project: a.project, kinds: ['run'], states: ['queued', 'running'] });
        const busy = open.find((j) => j.input.kind === 'run' && j.input.scenario === a.name);
        if (busy && busy.input.kind === 'run') {
          throw new EngineError('conflict', `a ${busy.input.mode === 'dry' ? 'dry run' : 'capture'} of ${a.name} is ${busy.state} (${busy.input.run_id}): wait for it to end, or cancel it`, {
            details: { run_id: busy.input.run_id, job: busy.id },
          });
        }
        return engine.runs.submit({ project: a.project, scenario: a.name, mode: a.mode, ...(a.env ? { env: a.env } : {}), ...(a.hash ? { expect_sha256: a.hash } : {}) });
      });
      const data: ScenarioRunAnswer = { run_id: sub.run_id, job: sub.job.id, state: sub.job.state, mode: a.mode, warnings: sub.warnings, ...(sub.worker ? { worker: sub.worker } : {}) };
      return { summary: `${a.mode === 'dry' ? 'dry run' : 'capture'} ${sub.run_id} queued (job ${sub.job.id})`, data: data as unknown as Record<string, unknown> };
    },
  };
  return [run] as unknown as ToolDef[];
}

/**
 * scenario_edit (L4.3): the Studio's one write path for scenarios — engine scenarios.edit under the `ui` client's agent
 * trust ("from the Studio"): the file the view read, `hash` as if_match, refused whole when the file is blocked (the
 * view's `edit` said so first), no hidden character added, hooks and mocks unchanged, validated (errors refuse with
 * their lines, warnings save), atomic with its mode kept, under the write lock. Edits of one file run one at a time in
 * this server (a double click, two tabs): the second then finds the new hash and gets its 409. Not an MCP tool:
 * Claude edits a scenario with scenario_save.
 */
export function editOps(): ToolDef[] {
  const chains = new Map<string, Promise<unknown>>();
  const oneAtATime = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const next = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return next;
  };
  const edit: ToolDef<typeof EditInput> = {
    name: 'scenario_edit',
    title: 'Edit a scenario from the Studio',
    description: "Apply one edit (the YAML tab's text, undo / redo's exact earlier version, a step moved, deleted, duplicated, changed by its form or added from the palette) to a scenario, on the version the screen showed.",
    input: EditInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(a, { engine }) {
      const r = await oneAtATime(`${a.project}\0${a.name}`, () => engine.scenarios.edit(a.project, a.name, { hash: a.hash, edit: a.edit }));
      return {
        summary: `${r.label}: ${r.file} (hash ${r.hash})${r.warnings.length ? ` with ${plural(r.warnings.length, 'warning')}` : ''}`,
        data: r as unknown as Record<string, unknown>,
      };
    },
  };
  return [edit] as unknown as ToolDef[];
}

/** The names of the Studio's own ops (not MCP tools). */
export const INDEX_OPS = ['activity_list', 'search'] as const;
export const SCENARIO_OPS = ['scenario_blocks', 'run_thumbs', 'scenario_forms'] as const;
export const RUN_OPS = ['scenario_run'] as const;
export const EDIT_OPS = ['scenario_edit'] as const;
export const OWN_OPS = [...INDEX_OPS, 'projects_overview', ...SCENARIO_OPS, ...RUN_OPS, ...EDIT_OPS] as const;
