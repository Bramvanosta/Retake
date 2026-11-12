/**
 * The Studio's own ops (L4.1): reads in the MCP tool shape (a zod input, a summary and data) so `/v1/call/<op>` runs
 * them through the same `invoke` — but they are not MCP tools: Claude reads files, project_get, run_list and job_list
 * instead, and the MCP server never depends on this package.
 *
 * L7.14: the Studio's read-only queries are the engine's operations (packages/engine/src/operations/): board.ts
 * (`projects_overview`, `project_board`), scenario-screen.ts (`scenario_blocks`, `scenario_actions`, `run_thumbs`,
 * `scenario_forms`, `scenario_sessions`), render-screen.ts (`scenario_renders`, `render_review`, `review_image`); the
 * Studio serves them as they are (studio.ts uiTools). The ops below stay here for now:
 *
 * - `activity_list`: unfinished jobs, live from the queue (derived states included), then finished jobs and CLI
 *   commands from the history — ids, kinds, states and times only (no product text: history lines carry none).
 * - `search`: projects (name, slug, README), scenarios, runs and renders matching every word as a prefix.
 * - `scenario_run` (L4.2): the scenario screen's Dry run and Capture — engine runs.submit with pinned arguments: the
 *   mode, the scenario, an environment of the project; the default hooks (none for a dry run, all for a capture), never
 *   a sandbox reset, never `until`, never a wait. It runs under the `ui` client's agent trust with no approver, so what
 *   the screen showed as a run blocker is refused here too (the submit is the authority) with the `retake run …`
 *   command to type in a terminal. `hash` (the file as the screen showed it) makes a changed file a 409. The engine's
 *   admission rules, the same for MCP (engine admission.ts): a run of the scenario already queued or running makes
 *   another a 409; a capture whose scenario uses a persona whose stored session is invalid (expired, error, never) and
 *   that no run signs in by itself needs `sessions_ack` naming it, else 409 `conflict` with `details.sessions` — a
 *   confirmation against a wasted take, not person presence (the run's own preflight stays the authority and stops
 *   before anything is filmed). Dry runs need none. Not an MCP tool: Claude has run_dry / run_capture.
 * - `run_pause` (L4.4): Pause / Resume of the Run screen — engine runs.pause (a running run of a job pauses before its
 *   next step, a capture without filming the pause; a queued, stopping or finished run is a 409; a terminal's run is
 *   refused).
 * - `sign_in_cancel` (L4.4): the Sessions panel's Cancel — engine auth.cancelSignIn (an `auth_login` job only).
 * - `timeline_view` (L4.5): the timeline screen's read — engine timeline.view and the preview's capability URLs on the
 *   player origin (timelineOps); `timeline_leave` (the page left: its project's preview URLs are revoked once no page
 *   holds a lease) and `preview_allow` (the person allows a workspace component to run in the preview, this session).
 * - `scenario_render`, `render_cancel` (L4.5 part E): Render from the timeline or the scenario screen, and Cancel
 *   (renderOps). L5.12a: `review_export` — the Review report's Export video (MP4): the existing engine `export` job, one
 *   format, the fixed folder; one at a time per render and at most two exports of the workspace at once are the engine's
 *   admission rules (renderOps).
 * - L4.7: the library ops live in library-ops.ts (library_view, library_images, library_render) and the theme ops in
 *   theme-ops.ts (theme_view, theme_edit, theme_copy, theme_create, brand_files, site_list, theme_preview); the
 *   preview pages' leases (preview-leases.ts PreviewLeases) are shared by timeline_view and theme_preview.
 * - L4.8: the Record screen's ops live in record-ops.ts (record_options, record_start, record_view, record_annotate,
 *   record_stop, record_discard, record_save).
 * - L4.6: `timeline_view {proposal}` (the preview of Claude's proposal, through the same workspace-component hold); the
 *   comment ops live in comment-ops.ts; scenario_edit, scenario_render and thread_apply share one op chain (op-chain.ts,
 *   critique B5); the scenario_edit answer no longer carries the file's absolute path.
 */
import { z } from 'zod';
import { COMMENT_ENTRY_ID_RE, COMMENT_ID_RE, COMPONENT_ID_RE, FIELD_PATHS, JOB_ID_RE, PALETTE_ACTIONS, SCENARIO_EDIT_MAX_CHARS, SLUG_RE } from '@retake/core';
import { EXPORTS_OPEN_MAX, EngineError, firstErrorLine } from '@retake/engine';
import type { RenderEditSource, TimelineView } from '@retake/engine';
import { READ, defineTool, plural, studioEnv as env, studioProject as project, studioRenderId as renderId, studioRun as run, studioScenario as scenario } from '@retake/engine/contract';
import { PreviewLeases } from './preview-leases.js';
import type { PreviewHeld } from './preview-leases.js';
import type { Live } from './live.js';
import { COMMENT_OPS } from './comment-ops.js';
import { LIBRARY_OPS } from './library-ops.js';
import { THEME_OPS } from './theme-ops.js';
import { RECORD_OPS } from './record-ops.js';
import { UNSAVED_OPS } from './unsaved.js';
import { DESKTOP_OPS } from './desktop.js';
import { SETUP_OPS } from './setup-ops.js';
import { UPDATE_OPS } from './update-ops.js';
import { opChain, scenarioKey } from './op-chain.js';
import type { OpChain } from './op-chain.js';
import type { PlayerServer } from './player.js';
import { COMPONENT_HASH_RE } from './preview-allow.js';
import type { PreviewAllowList } from './preview-allow.js';
import type { ComponentRegistry } from '@retake/components/geometry';

const ActivityInput = z.strictObject({
  project: project.optional().describe('Only this project.'),
  limit: z.number().int().min(1).max(100).optional().describe('At most this many entries (default 20).'),
});

const SearchInput = z.strictObject({
  q: z.string().max(200).describe('Words to find (each one as a prefix): project names and READMEs, scenario names, run and render ids.'),
  project: project.optional().describe('Only this project.'),
  limit: z.number().int().min(1).max(50).optional().describe('At most this many hits (default 20).'),
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
  sessions_ack: z
    .array(z.string().max(100).regex(SLUG_RE, 'a persona name'))
    .max(50)
    .optional()
    .describe('A capture: the personas whose invalid session the person confirmed (scenario_sessions `confirm`); refused (409) while one is missing.'),
});

const PauseInput = z.strictObject({
  project,
  run_id: run,
  paused: z.boolean().describe('true: pause before the next step; false: resume.'),
});
const SignInCancelInput = z.strictObject({ job: z.string().regex(JOB_ID_RE, 'a job id (j_…)').describe('The sign-in job (auth_login answered it).') });

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

/**
 * A timeline switch's place (L4.5, core FieldAt): the video's top level, or a scene / card / interstitial by its id and
 * its guard (timeline_view `choices[…].at`).
 */
const FieldAtInput = z.union([
  z.strictObject({ entry: z.literal('top') }),
  z.strictObject({
    entry: z.enum(['scene', 'card', 'interstitial']),
    id: sceneId,
    guard: z.string().regex(/^[0-9a-f]{16}$/, "the entry's guard as timeline_view gave it (16 hex characters)"),
  }),
]);
/** Every path of core FIELD_PATHS (each an edit value); which entry takes which is checked below, before any read. */
type FieldName = (typeof FIELD_PATHS)[keyof typeof FIELD_PATHS][number];
const FIELD_NAMES = [...new Set(Object.values(FIELD_PATHS).flat())] as [FieldName, ...FieldName[]];
/** A timeline switch's value: a frame, a transition, a component id, a speed or duration, the intro / outro switch. */
const switchValue = z.union([z.string().max(200, 'at most 200 characters'), z.number().finite(), z.boolean()]);
const SetFieldInput = z
  .strictObject({
    kind: z.literal('set_field'),
    at: FieldAtInput,
    field: z.enum(FIELD_NAMES).describe('A value of the edit part (core FIELD_PATHS), never a step, a hook, a var or the environment.'),
    from: switchValue.optional().describe('What the inspector showed there (absent: not written) — applied only while the file still holds it.'),
    to: switchValue.optional().describe("The new value (absent: removed — the theme's default)."),
  })
  .superRefine((e, ctx) => {
    const allowed = FIELD_PATHS[e.at.entry] as readonly string[];
    if (!allowed.includes(e.field)) ctx.addIssue({ code: 'custom', path: ['field'], message: `${e.field} is not a value of ${e.at.entry === 'top' ? 'the video' : `a ${e.at.entry}`} (${allowed.join(', ')})` });
  });

const EditInput = z.strictObject({
  project,
  name: scenario.describe('The scenario: the file scenario_blocks read (scenarios/<name>.yaml, or an existing .yml).'),
  hash: sha256.describe('The file as the screen showed it (scenario_blocks `hash`): refused (409) when the file changed since.'),
  edit: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('replace_text'), text: editText.describe('The YAML view\'s text (a final line break is added when missing).') }),
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
        action: z.enum(PALETTE_ACTIONS).describe('An action of the palette.'),
        values: z.record(fieldKey, fieldValue).describe("The new step's form values (scenario_forms names the fields).").refine((v) => Object.keys(v).length <= 40, 'at most 40 values'),
      }),
      SetFieldInput,
    ])
    .describe('One edit.'),
});

/** activity_list and search, served from `live`'s index. */
export function indexOps(live: Live) {
  const activity = defineTool({
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
  });
  const search = defineTool({
    name: 'search',
    title: 'Search the workspace',
    description: 'Projects, scenarios, runs and renders matching every word (as a prefix), best first.',
    input: SearchInput,
    annotations: READ,
    async run(a) {
      const hits = (await live.freshIndex()).search(a.q, { ...(a.project ? { project: a.project } : {}), limit: a.limit ?? 20 });
      return { summary: plural(hits.length, 'hit'), data: { q: a.q, hits } };
    },
  });
  return [activity, search] as const;
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
  /** L5.16c fixes (review c B-M2): that worker runs another copy of Retake (its version and folder: the lock's text). */
  untrusted?: { other_copy: { version: string; engine?: string } };
}

/**
 * scenario_run: the scenario screen's Dry run / Capture, arguments pinned. The engine's admission rules (one run of a
 * scenario at a time, the sessions acknowledgement of a capture) are its own, for the Studio and MCP alike.
 */
export function runOps() {
  const run = defineTool({
    name: 'scenario_run',
    title: 'Run a scenario from the Studio',
    description: 'Queue a dry run or a capture of a scenario: default hooks, no sandbox reset, no until; refused (with the retake run command) when a hook needs a person.',
    input: RunInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(a, { engine }) {
      const sub = await engine.runs.submit({
        project: a.project,
        scenario: a.name,
        mode: a.mode,
        ...(a.env ? { env: a.env } : {}),
        ...(a.hash ? { expect_sha256: a.hash } : {}),
        ...(a.mode === 'capture' && a.sessions_ack ? { sessions_ack: a.sessions_ack } : {}),
      });
      const { other, ...worker } = sub.worker ?? { spawned: false };
      const data: ScenarioRunAnswer = { run_id: sub.run_id, job: sub.job.id, state: sub.job.state, mode: a.mode, warnings: sub.warnings, ...(sub.worker ? { worker } : {}), ...(other ? { untrusted: { other_copy: other } } : {}) };
      return { summary: `${a.mode === 'dry' ? 'rehearsal' : 'capture'} ${sub.run_id} queued (job ${sub.job.id})`, data: data };
    },
  });
  return [run] as const;
}

/** The personas a capture's `sessions_ack` must name, and what the capture does with them: the engine's rule. */
export { confirmWhy, sessionsToConfirm } from '@retake/engine';
export type { SessionToConfirm } from '@retake/engine';
/** The read-only queries' answers the app and the tests name (the engine's operations since L7.14). */
export { REVIEW_IMAGES_MAX, reviewAnswer } from '@retake/engine/contract';
export type { ProjectOverview, RenderReviewAnswer } from '@retake/engine/contract';

const statusWords = (st: { status: string; paused?: { scene: string; step: number }; job?: { pause_requested_at?: string } }) =>
  st.paused ? `paused before step ${st.paused.step + 1} of ${st.paused.scene}` : st.job?.pause_requested_at ? `${st.status}, pausing before its next step` : st.status;

/** run_pause and sign_in_cancel: the Run screen's controls and the Sessions panel's Cancel (L4.4; scenario_sessions is the engine's since L7.14). */
export function liveOps() {
  const pause = defineTool({
    name: 'run_pause',
    title: 'Pause or resume a run',
    description: 'Pause a running run of a job before its next step (a capture does not film the pause), or resume it.',
    input: PauseInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(a, { engine }) {
      const st = await engine.runs.pause(a.project, a.run_id, a.paused);
      return { summary: `${a.run_id}: ${statusWords(st)}`, data: st };
    },
  });
  const cancel = defineTool({
    name: 'sign_in_cancel',
    title: 'Stop a sign-in',
    description: "Stop a sign-in job (its window closes; no session file or status is written — a persona's existing browser profile keeps what the window changed). Any other job is refused.",
    input: SignInCancelInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(a, { engine }) {
      const rec = await engine.auth.cancelSignIn(a.job);
      return { summary: `sign-in ${rec.id}: ${rec.state}${rec.cancel_requested_at && rec.state === 'running' ? ' (stopping)' : ''}`, data: { id: rec.id, kind: rec.kind, state: rec.state, ...(rec.cancel_requested_at ? { cancel_requested_at: rec.cancel_requested_at } : {}) } };
    },
  });
  return [pause, cancel] as const;
}

/**
 * scenario_edit (L4.3): the Studio's one write path for scenarios — engine scenarios.edit under the `ui` client's agent
 * trust ("from the Studio"): the file the view read, `hash` as if_match, refused whole when the file is blocked (the
 * view's `edit` said so first), no hidden character added, hooks and mocks unchanged, validated (errors refuse with
 * their lines, warnings save), atomic with its mode kept, under the write lock. Edits of one file run one at a time in
 * this server (a double click, two tabs): the second then finds the new hash and gets its 409. L4.5 part D: the
 * timeline inspector's `set_field` (SetFieldInput: strict, a field of core FIELD_PATHS that the entry takes, checked
 * before any read). Not an MCP tool: Claude edits a scenario with scenario_save.
 */
export function editOps(oneAtATime: OpChain = opChain()) {
  // L4.6: the Studio passes the chain thread_apply and scenario_render share (critique B5).
  const edit = defineTool({
    name: 'scenario_edit',
    title: 'Edit a scenario from the Studio',
    description: "Apply one edit (the YAML view's text, undo / redo's exact earlier version, a step moved, deleted, duplicated, changed by its form or added from the palette, a timeline switch of an edit value) to a scenario, on the version the screen showed.",
    input: EditInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(a, { engine }) {
      const r = await oneAtATime(scenarioKey(a.project, a.name), () => engine.scenarios.edit(a.project, a.name, { hash: a.hash, edit: a.edit }));
      // Path-free (L4.6, the L4.5 rule for Studio answers): the file's project-relative name, never its absolute path.
      const { path: _path, ...data } = r as typeof r & { path?: string };
      return {
        summary: `${r.label}: ${r.file} (hash ${r.hash})${r.warnings.length ? ` with ${plural(r.warnings.length, 'warning')}` : ''}`,
        data,
      };
    },
  });
  return [edit] as const;
}

/** A timeline page's lease (random, made by the page): the preview's capability of the project lives while one is held. */
const lease = z.string().regex(/^[A-Za-z0-9_-]{16,43}$/, 'a random lease id of the page (16 to 43 base64url characters)');
const TimelineInput = z.strictObject({
  project,
  name: scenario.describe('The scenario: scenarios/<name>.yaml of the project.'),
  run: run.optional().describe('A capture of the scenario (default: its latest capture; the view lists them in `runs`).'),
  lease: lease.optional().describe("The page's lease (timeline_leave ends it): the project's preview URLs are revoked once no page holds one."),
  proposal: z
    .strictObject({
      comment_id: z.string().max(40).regex(COMMENT_ID_RE, 'a comment id (c_…), never a path'),
      entry_id: z.string().max(40).regex(COMMENT_ENTRY_ID_RE, 'the reply holding the proposal (r_…)'),
    })
    .optional()
    .describe("L4.6: preview Claude's proposal on that thread (its newest pending or undone one) instead of the file: planned on the commented take in memory, nothing written; switches off."),
});
const TimelineLeaveInput = z.strictObject({ project, lease: lease.describe('The lease the page gave timeline_view.') });
const PreviewAllowInput = z.strictObject({
  id: z.string().max(120).regex(COMPONENT_ID_RE, 'a component id "namespace/name" (timeline_view preview_held names them)'),
  hash: z.string().regex(COMPONENT_HASH_RE, 'the folder hash timeline_view preview_held gave (16 hex characters)'),
});

/** The file's text while switches can be written (the engine gives it beside the view): what undo restores (L4.5 part D). */
export interface TimelineText {
  text?: string;
}

/**
 * What timeline_view answers: the engine's view (path-free, plan-free: tracks, pins, choices, capture codec, text under
 * `untrusted`) and the preview's two capability URLs on the player origin — or why the take cannot be planned
 * (`blocked`, with the command a person types), or the view without a preview when the player cannot serve it.
 */
export type TimelineViewAnswer =
  | (TimelineView & TimelineText & PreviewHeld & { frame_url: string; plan_url: string })
  | (TimelineView & TimelineText & PreviewHeld & { preview_error: string })
  | { blocked: { problems: string[]; command?: string }; run_id?: string };

/**
 * timeline_view (L4.5 part C): the timeline screen's one read — engine timeline.view (memoised per file, run,
 * timeline and components: a re-read after an event plans nothing new), then the player origin publishes the view's
 * plan (`publish`: its files registered under the session capability, the preview plan served as plan.json; `forbid`
 * adds the workspace and the home folder) and the answer carries `frame_url` and `plan_url` — never the plan, its
 * folders or any path (critique B4: the plan holds product text and local URLs; it reaches the sandboxed frame by its
 * capability URL only). The two URLs hold the session capability: the page that frames the preview needs them, the
 * server never logs them. Part D: while switches can be written, `text` — the file's text (the view's `hash`), which
 * the screen's undo restores byte for byte (scenario_edit `restore`), the same text scenario_blocks gives the page.
 * L4.5 fixes: the plan is published in the project's own scope (its own capability, review A L3) and the page's `lease`
 * keeps it alive until `timeline_leave`; `preview_held` names the workspace components the take uses that the preview
 * does not run until `preview_allow` (review A H1 c: the Studio's in-memory allow-list, by folder content hash).
 * Not MCP tools: Claude reads plan_preview.
 */
export function timelineOps(o: { player: () => PlayerServer; forbid: () => readonly string[]; allow?: PreviewAllowList; registry?: () => Promise<ComponentRegistry>; leases?: PreviewLeases }) {
  // L4.7: the theme editor's preview pages hold leases of the same set (theme-ops.ts), so timeline_leave ends theirs too.
  const leases = o.leases ?? new PreviewLeases((p) => o.player().release(p));
  /** The workspace components a plan uses that are not allowed (empty without an allow-list: every one runs). */
  const heldOf = async (plan: Parameters<PlayerServer['publish']>[0]['plan']): Promise<NonNullable<PreviewHeld['preview_held']>> => {
    if (!o.allow || !o.registry) return [];
    const { usedComponentIds } = await import('@retake/editor');
    const used = new Set(usedComponentIds(plan));
    const { workspaceComponents } = await import('../player/bundle-player.js');
    return (await workspaceComponents(await o.registry())).filter((c) => used.has(c.id) && !o.allow!.has(c.id, c.hash));
  };
  const view = defineTool({
    name: 'timeline_view',
    title: "A scenario's timeline",
    description: "A capture of a scenario as the timeline shows it: its tracks, comment pins, the inspector's choices, the capture's codec, and the preview's capability URLs.",
    input: TimelineInput,
    annotations: READ,
    async run(a, { engine }) {
      // No capture yet: said plainly (the planner's own error names the runs folder).
      if (!a.run && (await engine.runs.list(a.project, { scenario: a.name, mode: 'capture', limit: 1 })).length === 0) {
        throw new EngineError('not_found', `${a.name} has no capture yet: a capture films the take its timeline shows (Capture from the status bar or Shoot)`);
      }
      const r = await engine.timeline.view({ project: a.project, scenario: a.name, ...(a.run ? { run_id: a.run } : {}), ...(a.proposal ? { proposal: a.proposal } : {}) });
      if (!('view' in r)) {
        const data: TimelineViewAnswer = { blocked: r.blocked, ...(r.run_id ? { run_id: r.run_id } : {}) };
        return { summary: `${a.name}: the take cannot be previewed from the Studio (${plural(r.blocked.problems.length, 'problem')})`, data: data };
      }
      const v = r.view;
      // The file's text, for undo (L4.5 part D: L4.3's `restore` of the exact bytes) — as scenario_blocks gives it.
      const text = r.text !== undefined ? { text: r.text } : {};
      const head = `${a.name}: ${v.run_id}, ${plural(v.model.segments.length, 'segment')}, ${plural(v.model.frames, 'frame')}${v.proposal ? `, previewing the proposal of ${v.proposal.comment_id}` : ''}`;
      leases.prune();
      if (a.lease) leases.hold(a.project, a.lease);
      // The proposal's plan too (critique B9 c): a workspace component a proposal adds is held until the person allows it.
      const held = await heldOf(r.plan);
      const heldPart: PreviewHeld = held.length ? { preview_held: held } : {};
      try {
        // Each project its own capability (review A L3): a page of one project never holds URLs of another's files.
        const p = await o.player().publish(r, { forbid: o.forbid(), scope: a.project });
        const data: TimelineViewAnswer = { ...v, ...text, ...heldPart, frame_url: p.frame_url, plan_url: p.plan_url };
        return { summary: head, data: data };
      } catch (e) {
        // The tracks still show; the preview says why it cannot (the player's words: asset ids, never a path).
        const data: TimelineViewAnswer = { ...v, ...text, ...heldPart, preview_error: firstErrorLine(e instanceof Error ? e.message : String(e)) };
        return { summary: `${head}, no preview`, data: data };
      }
    },
  });
  const leave = defineTool({
    name: 'timeline_leave',
    title: 'Leave a timeline',
    description: "A timeline page left: its lease ends; once no page holds one, the project's preview URLs answer 404 (the next view gets new ones).",
    input: TimelineLeaveInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(a) {
      const others = leases.leave(a.project, a.lease);
      const revoked = others === 0;
      leases.prune();
      return { summary: revoked ? `${a.project}: preview URLs revoked` : `${a.project}: ${plural(others, 'other page')} still on a timeline or a theme preview`, data: { project: a.project, revoked } };
    },
  });
  const allow = defineTool({
    name: 'preview_allow',
    title: 'Allow a workspace component in the preview',
    description: 'The person allows one workspace component, at the folder hash shown, to run in the sandboxed preview for this Studio session (in memory only).',
    input: PreviewAllowInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(a) {
      if (!o.allow || !o.registry) throw new EngineError('refused', 'this Studio runs every component in its preview');
      const { workspaceComponents } = await import('../player/bundle-player.js');
      const c = (await workspaceComponents(await o.registry())).find((x) => x.id === a.id);
      if (!c) throw new EngineError('not_found', `${a.id} is not a workspace component (a built-in component always runs)`);
      if (c.hash !== a.hash) throw new EngineError('conflict', `${a.id} changed since the timeline showed it (its folder is now ${c.hash}): look at it again, then allow it`, { details: { id: a.id, hash: c.hash } });
      if (!o.allow.allow(a.id, a.hash)) throw new EngineError('refused', 'too many components were allowed in this session: restart the Studio');
      return { summary: `${a.id} (${a.hash}) runs in the preview until the Studio stops`, data: { id: a.id, hash: a.hash, allowed: true } };
    },
  });
  return [view, leave, allow] as const;
}

const RenderInput = z.strictObject({
  project,
  name: scenario.describe('The scenario: scenarios/<name>.yaml of the project.'),
  run: run.describe('The capture to render (the timeline shows it: timeline_view `run_id`).'),
  expect_edit_sha256: sha256.describe('The scenario file as the screen showed it (timeline_view / scenario_blocks `hash`): refused (409) when it changed since.'),
});
const RenderCancelInput = z.strictObject({ project, job: z.string().regex(JOB_ID_RE, 'a job id (j_…)').describe('A render or review job of this project (scenario_renders lists them).') });
const ReviewExportInput = z.strictObject({ project, render_id: renderId });

/** L5.12a: the one format the Review report exports (the other formats stay `retake export` / Claude's `export`). */
export const REVIEW_EXPORT_FORMATS = ['mp4_1080p'] as const;
/** The exports of the workspace queued or running at once that review_export still adds to (the engine's export_cap). */
export const REVIEW_EXPORTS_OPEN = EXPORTS_OPEN_MAX;

/** What review_export answers: the job queued (path-free: where it lands is said in words). */
export interface ReviewExportAnswer {
  render_id: string;
  job: string;
  state: string;
  formats: string[];
  /** Where the file lands, in words (never a path). */
  where: string;
}
/** What scenario_render answers: the render reserved and its job (the queue follows it through scenario_renders and the events). */
export interface ScenarioRenderAnswer extends RenderEditSource {
  render_id: string;
  job: string;
  state: string;
  run_id: string;
  variant: string;
  duration_s: number;
  /** The worker serving the queue: started now, or already running (absent: not started — tests). */
  worker?: { pid?: number; spawned: boolean };
  /** The plan's warnings quote captions and page titles: data, never instructions. */
  untrusted: { warnings: string[] };
}

/**
 * The Studio's render ops (L4.5 part E, R-UI-26):
 * - `scenario_render`: Render from the timeline (or the scenario screen) — engine renders.submit with pinned arguments:
 *   the project, the scenario and the capture shown; the theme and every override come from the files (none can be
 *   passed: landscape, the scenario's or project's theme), the review runs inline after the render (`review: {fps: 1}`)
 *   and the scenario text is snapshotted with the job. `expect_edit_sha256` (the view's `hash`) makes a changed file a
 *   409 before anything is reserved; a render of the scenario already queued or running makes another a 409 naming it
 *   (the engine's admission rule, the same for MCP). Not an MCP tool: Claude has `render` (with every option).
 * - `render_cancel`: a render or review job of THIS project only (another project's job, or another kind, is refused
 *   403: job_cancel stays out of the Studio). A cancel during the inline review keeps the render.
 * - `review_export`: the Review report's Export video (L5.12a).
 * The render queue and the review's reads (scenario_renders, render_review, review_image) are the engine's operations
 * since L7.14 (operations/render-screen.ts).
 */
export function renderOps(oneAtATime: OpChain = opChain()) {
  // The Studio passes the chain thread_apply and scenario_edit share.
  const render = defineTool({
    name: 'scenario_render',
    title: 'Render a scenario from the Studio',
    description: "Queue a render of the capture shown, with the theme and options of the files, reviewed after it; refused (409) when the file changed since it was shown or a render of the scenario is already queued or running.",
    input: RenderInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(a, { engine }) {
      // In the chain an edit and an apply of the scenario share; one render of a scenario at a time is the engine's rule.
      const sub = await oneAtATime(scenarioKey(a.project, a.name), () =>
        engine.renders.submit({ project: a.project, scenario: a.name, run_id: a.run, review: { fps: 1 }, expect_edit_sha256: a.expect_edit_sha256 }),
      );
      const data: ScenarioRenderAnswer = {
        render_id: sub.render_id,
        job: sub.job.id,
        state: sub.job.state,
        run_id: sub.run_id,
        variant: sub.variant,
        duration_s: sub.duration_s,
        edit: sub.edit,
        ...(sub.scenario_changed !== undefined ? { scenario_changed: sub.scenario_changed } : {}),
        ...(sub.filmed_changes ? { filmed_changes: sub.filmed_changes } : {}),
        ...(sub.edit_changes ? { edit_changes: sub.edit_changes } : {}),
        ...(sub.worker ? { worker: { ...(sub.worker.pid !== undefined ? { pid: sub.worker.pid } : {}), spawned: sub.worker.spawned } } : {}),
        untrusted: { warnings: sub.warnings, ...(sub.worker?.other ? { other_copy: sub.worker.other } : {}) },
      };
      return { summary: `render ${sub.render_id} queued (job ${sub.job.id})`, data: data };
    },
  });
  const cancel = defineTool({
    name: 'render_cancel',
    title: 'Cancel a render',
    description: 'Cancel a render or review job of this project (a cancel during the inline review keeps the render). Any other job is refused.',
    input: RenderCancelInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(a, { engine }) {
      const job = await engine.jobs.get(a.job);
      const input = job.input;
      if ((input.kind !== 'render' && input.kind !== 'review') || input.project !== a.project) {
        throw new EngineError('refused', `job ${a.job} is not a render or a review of ${a.project}: the Studio cancels only those`);
      }
      const rec = await engine.jobs.cancel(a.job);
      const id = rec.input.kind === 'render' || rec.input.kind === 'review' ? rec.input.render_id : '';
      return {
        summary: `${rec.kind} ${id}: ${rec.state}${rec.cancel_requested_at && rec.state === 'running' ? ' (stopping)' : ''}`,
        data: { id: rec.id, kind: rec.kind, render_id: id, state: rec.state, ...(rec.cancel_requested_at ? { cancel_requested_at: rec.cancel_requested_at } : {}) },
      };
    },
  });
  const exportOp = defineTool({
    name: 'review_export',
    title: 'Export a render as MP4 from the Studio',
    description:
      "Queue an export of one render of the project to MP4 (1080p) in its fixed folder, exports/<render id>/ — the engine's export job, nothing else to choose; refused (409) while an export of that render is queued or running, and while two exports of the workspace are. Path-free.",
    input: ReviewExportInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(a, { engine }) {
      // One export of a render at a time, at most two of the workspace: the engine's export_cap rule.
      const sub = await engine.exports.submit({ project: a.project, render_id: a.render_id, formats: [...REVIEW_EXPORT_FORMATS] });
      const data: ReviewExportAnswer = { render_id: sub.render_id, job: sub.job.id, state: sub.job.state, formats: [...sub.formats], where: `the project's exports folder, under ${sub.render_id}` };
      return { summary: `export of ${sub.render_id} queued (job ${sub.job.id}): ${sub.formats.join(', ')}`, data: data };
    },
  });
  return [render, cancel, exportOp] as const;
}

/** The names of the Studio's own ops (not MCP tools; the read-only queries among them are the engine's operations since L7.14). */
export const TIMELINE_OPS = ['timeline_view', 'timeline_leave', 'preview_allow'] as const;
export const RENDER_OPS = ['scenario_render', 'scenario_renders', 'render_cancel', 'render_review', 'review_image', 'review_export'] as const;
export const INDEX_OPS = ['activity_list', 'search'] as const;
export const SCENARIO_OPS = ['scenario_blocks', 'scenario_actions', 'run_thumbs', 'scenario_forms'] as const;
export const RUN_OPS = ['scenario_run'] as const;
export const EDIT_OPS = ['scenario_edit'] as const;
export const LIVE_OPS = ['run_pause', 'scenario_sessions', 'sign_in_cancel'] as const;
export const OWN_OPS = [...INDEX_OPS, 'projects_overview', 'project_board', ...SCENARIO_OPS, ...RUN_OPS, ...EDIT_OPS, ...LIVE_OPS, ...TIMELINE_OPS, ...RENDER_OPS, ...COMMENT_OPS, ...LIBRARY_OPS, ...THEME_OPS, ...RECORD_OPS, ...UNSAVED_OPS, ...DESKTOP_OPS, ...SETUP_OPS, ...UPDATE_OPS] as const;
