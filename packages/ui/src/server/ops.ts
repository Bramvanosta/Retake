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
 * - L7.15: the submits and job controls — `scenario_run`, `run_pause`, `sign_in_cancel`, `scenario_render`,
 *   `render_cancel`, `review_export` — are the engine's operations (operations/studio-jobs.ts); their answer types are
 *   re-exported here for the app and the tests.
 * - `timeline_view` (L4.5): the timeline screen's read — engine timeline.view and the preview's capability URLs on the
 *   player origin (timelineOps); `timeline_leave` (the page left: its project's preview URLs are revoked once no page
 *   holds a lease) and `preview_allow` (the person allows a workspace component to run in the preview, this session).
 * - L4.7: the library ops live in library-ops.ts (library_view, library_images, library_render) and the theme ops in
 *   theme-ops.ts (theme_view, theme_edit, theme_copy, theme_create, brand_files, site_list, theme_preview); the
 *   preview pages' leases (preview-leases.ts PreviewLeases) are shared by timeline_view and theme_preview.
 * - L4.8: the Record screen's ops (record_options, record_start, record_view, record_annotate, record_stop,
 *   record_discard, record_save): the engine's operations since L7.18 (operations/record.ts; record-ops.ts names them).
 * - L4.6: `timeline_view {proposal}` (the preview of Claude's proposal, through the same workspace-component hold); the
 *   comment ops live in comment-ops.ts; scenario_edit, scenario_render and thread_apply share one op chain (op-chain.ts,
 *   critique B5; since L7.15 it is the engine's operation chain, which scenario_render runs on by its `serialize`).
 * - L7.18: scenario_edit (the Studio's one scenario write) is the engine's operation (operations/scenario-edit.ts, on
 *   the engine's operation chain by its `serialize`); its answer carries no absolute path.
 */
import { z } from 'zod';
import { COMPONENT_ID_RE } from '@retake/core/model';
import { COMMENT_ENTRY_ID_RE, COMMENT_ID_RE } from '@retake/core/ids';
import { EngineError, firstErrorLine } from '@retake/engine';
import type { TimelineView } from '@retake/engine';
import { READ, defineTool, plural, studioProject as project, studioRun as run, studioScenario as scenario } from '@retake/engine/contract';
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
      return { summary: `${items.length} ${items.length === 1 ? 'entry' : 'entries'} (${open} unfinished)`, data: { items } };
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

/** The personas a capture's `sessions_ack` must name, and what the capture does with them: the engine's rule. */
export { confirmWhy, sessionsToConfirm } from '@retake/engine';
export type { SessionToConfirm } from '@retake/engine';
/** The read-only queries' answers the app and the tests name (the engine's operations since L7.14). */
export { REVIEW_IMAGES_MAX, reviewAnswer } from '@retake/engine/contract';
export type { ProjectOverview, RenderReviewAnswer } from '@retake/engine/contract';
/** The submits' and job controls' answers and constants the app and the tests name (the engine's operations since L7.15). */
export { REVIEW_EXPORTS_OPEN, REVIEW_EXPORT_FORMATS } from '@retake/engine/contract';
export type { ReviewExportAnswer, ScenarioRenderAnswer, ScenarioRunAnswer } from '@retake/engine/contract';

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
      return {
        summary: revoked ? `${a.project}: preview URLs revoked` : `${a.project}: ${plural(others, 'other page')} still on a timeline or a theme preview`,
        data: { project: a.project, revoked },
      };
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
      if (c.hash !== a.hash)
        throw new EngineError('conflict', `${a.id} changed since the timeline showed it (its folder is now ${c.hash}): look at it again, then allow it`, { details: { id: a.id, hash: c.hash } });
      if (!o.allow.allow(a.id, a.hash)) throw new EngineError('refused', 'too many components were allowed in this session: restart the Studio');
      return { summary: `${a.id} (${a.hash}) runs in the preview until the Studio stops`, data: { id: a.id, hash: a.hash, allowed: true } };
    },
  });
  return [view, leave, allow] as const;
}

/** The names of the Studio's own ops (not MCP tools; the read-only queries among them are the engine's operations since L7.14). */
export const TIMELINE_OPS = ['timeline_view', 'timeline_leave', 'preview_allow'] as const;
export const RENDER_OPS = ['scenario_render', 'scenario_renders', 'render_cancel', 'render_review', 'review_image', 'review_export'] as const;
export const INDEX_OPS = ['activity_list', 'search'] as const;
export const SCENARIO_OPS = ['scenario_blocks', 'scenario_actions', 'run_thumbs', 'scenario_forms'] as const;
export const RUN_OPS = ['scenario_run'] as const;
export const EDIT_OPS = ['scenario_edit'] as const;
export const LIVE_OPS = ['run_pause', 'scenario_sessions', 'sign_in_cancel'] as const;
export const OWN_OPS = [
  ...INDEX_OPS,
  'projects_overview',
  'project_board',
  ...SCENARIO_OPS,
  ...RUN_OPS,
  ...EDIT_OPS,
  ...LIVE_OPS,
  ...TIMELINE_OPS,
  ...RENDER_OPS,
  ...COMMENT_OPS,
  ...LIBRARY_OPS,
  ...THEME_OPS,
  ...RECORD_OPS,
  ...UNSAVED_OPS,
  ...DESKTOP_OPS,
  ...SETUP_OPS,
  ...UPDATE_OPS,
] as const;
