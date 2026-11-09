/**
 * The Studio's comment ops (L4.6 part C, R-UI-27 / R-UI-28 / R-UI-29, plan D8 as amended by the critique): frame
 * comments on a render's own frames, threads, and Claude's proposals — the engine's comments and renders facades under
 * the `ui` client (entries written as the channel `studio`, named by the Studio process: never by the page).
 *
 * Reads: `threads_list` (a scenario's threads, path-free items, the first 300 characters of each comment under
 * `untrusted`), `threads_counts` (open / resolved per scenario from the thread files alone, critique B8: the scenario
 * screen's "Comments (N open)"), `thread_get` (one thread, path-free, its last THREAD_ENTRIES_SHOWN entries, and the
 * newest — or the named — proposal as the engine computes it: the canonical diff of the exact bytes Apply writes, its
 * lines under `untrusted.rows`, and `offer`: what the screen may offer for it, computed here — critique B3),
 * `thread_still` (a thread's still as a JPEG, for a render that is gone), `render_outline` (the viewer's slider:
 * frames, fps, markers, the pins on that render), `render_frame` (one output frame as a JPEG, the video's own fps — the
 * page's session id makes the newest request of a render win, the request's abort signal kills a superseded ffmpeg;
 * queue full → 429 busy, a reused render id → 409), `frame_anchor` (the anchor a comment on that frame would store:
 * the same engine code as `thread_add`, so the chips shown are the anchor written).
 *
 * Writes (strict inputs: no author, via, path, marker, time or proposal field anywhere — a proposal is Claude's, from
 * the MCP only): `thread_add` (the render as the page showed it: id + `created_at`), `thread_reply`, `thread_resolve`,
 * `thread_reopen` and `thread_apply` (each on the thread's hash the page showed: `if_match`). Writes of one thread run
 * one at a time in this server; `thread_apply` also runs on the scenario's key of the chain shared with scenario_edit
 * and scenario_render (critique B5: an apply, an edit and a render submit of one scenario never interleave). Undo apply
 * is scenario_edit `restore` of the answer's `previous` (the base was read by the engine: a version it accepts).
 *
 * Every answer is path-free (the exported mappers drop the still's and the thread file's paths; warnings and problems
 * lose any absolute path) and every text written by a person or an agent stays under `untrusted` (capped at 2,000
 * characters per string by the server: every stored text is at most that by construction).
 */
import { z } from 'zod';
import { COMMENT_ENTRY_ID_RE, COMMENT_ID_RE, COMMENT_TEXT_MAX, PROJECT_SLUG_RE, RENDER_ID_RE, SLUG_RE, isIsoUtcDate, isTemplatePath, parseYaml } from '@retake/core';
import { loadProjectTemplate, fileFacts } from '@retake/core/io';
import { EngineError, openProjectBySlug, renderForWork, withoutPaths } from '@retake/engine';
import type { CommentEntryView, CommentProposalView, CommentView, Engine } from '@retake/engine';
import type { ToolDef } from '@retake/engine/contract';
import { opChain, scenarioKey } from './op-chain.js';
import type { OpChain } from './op-chain.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** Entries a thread answer carries, at most (the newest; `entries_total` says how many there are). */
export const THREAD_ENTRIES_SHOWN = 100;
/** Threads a list answers, at most. */
export const THREADS_LIST_MAX = 200;
/** Characters of a comment's text a list item carries (the thread shows it whole). */
export const THREAD_ITEM_TEXT_MAX = 300;

const project = z.string().max(100).regex(PROJECT_SLUG_RE, 'a project slug (project_list names them), never a path');
const scenario = z.string().max(100).regex(SLUG_RE, 'a scenario name (scenarios/<name>.yaml), never a path');
const commentId = z.string().max(40).regex(COMMENT_ID_RE, 'a comment id (c_…, threads_list names them), never a path');
const entryId = z.string().max(40).regex(COMMENT_ENTRY_ID_RE, 'an entry id of the thread (r_…)');
const renderId = z.string().max(200).regex(RENDER_ID_RE, 'a render id (scenario_renders lists them), never a path');
const createdAt = z.string().max(40).refine((s) => isIsoUtcDate(s), "the render's created_at as the page read it (an ISO 8601 UTC date)");
const frame = z.number().int().min(0).max(10_000_000).describe('An output frame of the render (0-based).');
const ifMatch = z.string().regex(/^[0-9a-f]{64}$/, 'the thread hash the page showed (thread_get / threads_list `hash`)');
const unit = z.number().finite().min(0).max(1);
const region = z.strictObject({ x: unit, y: unit, w: unit, h: unit }).describe('A rectangle of the frame in 0..1 (left, top, width, height).');
const text = (what: string) => z.string().min(1).max(COMMENT_TEXT_MAX).describe(`${what} (≤ ${COMMENT_TEXT_MAX} characters; control characters removed).`);
/** The page's session (made by the page, per tab): the newest frame request of a render in it wins. */
const session = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "the page's session id (1 to 64 base64url characters)");

const ListInput = z.strictObject({
  project,
  name: scenario.describe('The scenario: its threads (comments/<name>/).'),
  status: z.enum(['open', 'resolved', 'all']).optional().describe('Default open.'),
  render: renderId.optional().describe('Only threads made on this render as it is now.'),
  limit: z.number().int().min(1).max(THREADS_LIST_MAX).optional().describe(`At most this many (default ${THREADS_LIST_MAX}).`),
});
const CountsInput = z.strictObject({ project, name: scenario.optional().describe('Only this scenario.') });
const GetInput = z.strictObject({
  project,
  comment_id: commentId,
  entry_id: entryId.optional().describe("A proposal's reply (default: the thread's newest proposal)."),
});
const StillInput = z.strictObject({ project, comment_id: commentId });
const OutlineInput = z.strictObject({ project, render_id: renderId, created_at: createdAt.optional() });
const FrameInput = z.strictObject({ project, render_id: renderId, created_at: createdAt, frame, session });
const AnchorInput = z.strictObject({ project, render_id: renderId, created_at: createdAt, frame, region: region.optional() });
const AddInput = z.strictObject({ project, render_id: renderId, created_at: createdAt, frame, region: region.optional(), text: text('The comment') });
const ReplyInput = z.strictObject({ project, comment_id: commentId, text: text('The reply') });
const ResolveInput = z.strictObject({
  project,
  comment_id: commentId,
  note: text('What was changed'),
  render_id: renderId.optional().describe('A later succeeded render of the same scenario and variant that answers it.'),
  if_match: ifMatch,
});
const ReopenInput = z.strictObject({ project, comment_id: commentId, note: z.string().max(COMMENT_TEXT_MAX).optional().describe('Why (optional).'), if_match: ifMatch });
const ApplyInput = z.strictObject({ project, comment_id: commentId, entry_id: entryId.describe("The reply holding the proposal (thread_get's proposal `entry`)."), if_match: ifMatch });

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A text of the tool (a warning, a problem) without any absolute path: the workspace's cut off, any other shortened. */
export function pathFree(text: string, root: string): string {
  const cut = text.split(`${root}/`).join('').split(root).join('.');
  return /(?:^|[\s'"`(<=:])(?:file:\/\/)?\/[^\s/]|\b[A-Za-z]:\\/.test(cut) ? withoutPaths(cut) : cut;
}

/** A thread as a list shows it (threads_list): trusted fields, the newest proposal's state, the first words of the comment. */
export interface ThreadItem {
  id: string;
  scenario: string;
  status: CommentView['status'];
  render_id: string;
  render_created_at: string;
  render_present: boolean;
  variant: CommentView['variant'];
  run_id: string;
  frame: number;
  time_s: number;
  timecode: string;
  region?: CommentView['region'];
  anchor: CommentView['anchor'];
  step_now?: string | null;
  via: CommentView['via'];
  created_at: string;
  /** The newest entry (kind, channel, time), null when there is none. */
  last: { kind: CommentEntryView['kind']; via: CommentEntryView['via']; created_at: string } | null;
  entries_total: number;
  newer_renders: string[];
  /** The thread's hash (if_match). */
  hash: string;
  /** The newest proposal of the thread: its reply, state and whether Apply is offered for it. */
  proposal?: { entry: string; state: NonNullable<CommentEntryView['proposal']>['state']; actionable: boolean };
  untrusted: { text: string; author: string };
}

/** engine CommentView → a list item (no path, the comment's first THREAD_ITEM_TEXT_MAX characters). */
export function threadItem(v: CommentView): ThreadItem {
  const last = v.entries.at(-1);
  const newest = [...v.entries].reverse().find((e) => e.proposal);
  return {
    id: v.id,
    scenario: v.scenario,
    status: v.status,
    render_id: v.render_id,
    render_created_at: v.render_created_at,
    render_present: v.render_present,
    variant: v.variant,
    run_id: v.run_id,
    frame: v.frame,
    time_s: v.time_s,
    timecode: v.timecode,
    ...(v.region ? { region: { x: v.region.x, y: v.region.y, w: v.region.w, h: v.region.h } } : {}),
    anchor: v.anchor,
    ...(v.step_now !== undefined ? { step_now: v.step_now } : {}),
    via: v.via,
    created_at: v.created_at,
    last: last ? { kind: last.kind, via: last.via, created_at: last.created_at } : null,
    entries_total: v.entries.length,
    newer_renders: v.newer_renders,
    hash: v.hash,
    ...(newest?.proposal ? { proposal: { entry: newest.id, state: newest.proposal.state, actionable: newest.proposal.actionable } } : {}),
    untrusted: { text: v.untrusted.text.slice(0, THREAD_ITEM_TEXT_MAX), author: v.untrusted.author },
  };
}

/** A thread as the Studio shows it: the engine's view without its paths (`still` says whether there is one; no file or ref). */
export interface ThreadAnswer extends Omit<CommentView, 'still' | 'file' | 'ref' | 'untrusted'> {
  still: boolean;
  /** Entries of the thread; `entries` holds the newest THREAD_ENTRIES_SHOWN. */
  entries_total: number;
  untrusted: CommentView['untrusted'];
}

/** engine CommentView → the thread answer (no `file`, `ref` or still path; the newest THREAD_ENTRIES_SHOWN entries). */
export function threadAnswer(v: CommentView): ThreadAnswer {
  const { still, file: _file, ref: _ref, entries, untrusted, ...rest } = v;
  const shown = entries.slice(-THREAD_ENTRIES_SHOWN);
  const ids = new Set(shown.map((e) => e.id));
  return {
    ...rest,
    ...(v.region ? { region: { x: v.region.x, y: v.region.y, w: v.region.w, h: v.region.h } } : {}),
    entries: shown,
    entries_total: entries.length,
    still: still !== null,
    untrusted: { ...untrusted, entries: untrusted.entries.filter((e) => ids.has(e.id)) },
  };
}

/**
 * What the thread screen offers for a proposal (critique B2 / B3 / B4), computed by the server:
 * - `apply`: the newest proposal, pending or undone (Undo apply makes it actionable again), on an open thread;
 * - `preview` (Preview change): apply, and the proposed text renders on the commented take (verified, same take);
 * - `apply_render` (Apply and re-render): preview, and the Studio's render can answer the thread — it renders
 *   landscape with the files' theme and no option (scenario_render's pinned arguments), so only a landscape thread
 *   whose render used the files' theme and no override;
 * - none of them when Apply's own checks before its write would refuse it now (the engine's `blocked`: the Studio's write
 *   checks, edit-only, no theme change, the apply entry fitting the thread — review A L4);
 * - `why`: what is not offered and why, in the tool's own words (Apply's refusal quoted on its first line, path-free).
 */
export interface ProposalOffer {
  apply: boolean;
  preview: boolean;
  apply_render: boolean;
  why?: string;
}

const LATER = 'apply it, then render it from your terminal or ask Claude';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The first line of Apply's refusal, at most 300 characters (the engine's words, project-relative). */
function blockedWords(blocked: string): string {
  const line = blocked.split('\n')[0].replace(/^not applied: /, '');
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

/** Why a proposal is not actionable, in words (its state; a resolved thread). */
function notActionableWhy(p: CommentProposalView): string {
  if (p.status !== 'open') return 'The thread is resolved: reopen it to apply a proposal';
  switch (p.state) {
    case 'applied':
      return 'Applied: the scenario holds it';
    case 'superseded':
      return 'A newer proposal replaces it';
    case 'stale':
      return 'The scenario changed since it was proposed: ask Claude to propose again';
    default:
      return 'Not the newest proposal of the thread';
  }
}

/** The facts the Apply-and-re-render rule reads (critique B3): the commented render as it is now and the files' theme. */
export interface OfferFacts {
  variant: CommentView['variant'];
  /** The commented render's record (by id and created_at), or why it cannot be read. */
  render: { template: string; overrides: string[] } | { missing: string };
  /** The theme a Studio render would use (the scenario's `template:`, else the project's), or why it cannot be read. */
  files_theme: { name: string } | { missing: string };
}

/** Facts not read (the proposal is not actionable or does not render on the commented take: they decide nothing). */
const UNREAD: OfferFacts = { variant: 'landscape', render: { missing: 'not read' }, files_theme: { missing: 'not read' } };

/** The offer of a proposal from its view and the facts (pure: the rule). */
export function proposalOffer(p: CommentProposalView, f: OfferFacts): ProposalOffer {
  if (!p.actionable) return { apply: false, preview: false, apply_render: false, why: notActionableWhy(p) };
  // Apply's own checks before its write said no (review A L4): nothing is offered that the server would refuse.
  if (typeof p.blocked === 'string') return { apply: false, preview: false, apply_render: false, why: `Apply would refuse it now (${blockedWords(p.blocked)}): ask Claude to propose again` };
  if (!p.verified || p.same_take !== true) {
    return { apply: true, preview: false, apply_render: false, why: "It does not render on the commented take (the take is gone, or the scenario's filmed part changed since): apply it, then capture again" };
  }
  const no = (why: string): ProposalOffer => ({ apply: true, preview: true, apply_render: false, why });
  if (f.variant !== 'landscape') return no(`The comment is on a ${f.variant} render and the Studio renders landscape only: ${LATER}`);
  if ('missing' in f.render) return no(`${f.render.missing}: ${LATER}`);
  if (f.render.overrides.length) return no(`The commented render used options beyond the files' (${f.render.overrides.join(', ')}): ${LATER}`);
  if ('missing' in f.files_theme) return no(`${f.files_theme.missing}: ${LATER}`);
  if (f.render.template !== f.files_theme.name) {
    const named = NAME_RE.test(f.render.template) && NAME_RE.test(f.files_theme.name);
    return no(`The commented render used ${named ? `the theme ${f.render.template}, not the files' ${f.files_theme.name}` : "another theme than the files'"}: ${LATER}`);
  }
  return { apply: true, preview: true, apply_render: true };
}

/** Override keys a record may carry that a Studio render never sets (the theme is compared by name). */
const OVERRIDE_KEY = /^[a-z][a-z_]{0,39}$/;

/** The facts for proposalOffer: the thread's render record (renderForWork: a succeeded render inside the project) and the files' theme. */
async function offerFacts(engine: Engine, slug: string, t: CommentView): Promise<OfferFacts> {
  const p = await openProjectBySlug(engine.workspace, slug);
  let render: OfferFacts['render'];
  if (!t.render_present) render = { missing: 'The commented render is gone: its theme and options are unknown' };
  else {
    try {
      const rec = await renderForWork(p, t.render_id, { scenario: t.scenario });
      if (rec.created_at !== t.render_created_at) render = { missing: 'The commented render was replaced since' };
      else {
        const o = rec.overrides && typeof rec.overrides === 'object' ? (rec.overrides as Record<string, unknown>) : {};
        const overrides = Object.keys(o).filter((k) => k !== 'theme' && o[k] !== undefined).map((k) => (OVERRIDE_KEY.test(k) ? k : 'an option')).sort();
        render = typeof rec.template === 'string' ? { template: rec.template, overrides } : { missing: "The commented render's theme cannot be read" };
      }
    } catch {
      render = { missing: "The commented render's record cannot be read" };
    }
  }
  let files: OfferFacts['files_theme'];
  try {
    const today = await engine.scenarios.get(slug, t.scenario);
    const doc = parseYaml(today.yaml).value as { template?: unknown } | null | undefined;
    const ref = doc && typeof doc === 'object' && typeof doc.template === 'string' ? doc.template : undefined;
    // A theme folder named by the scenario is refused by the Studio's render (a theme is named): never read here.
    if (ref !== undefined && isTemplatePath(ref) && ref !== p.config.template) files = { missing: "The scenario's template: is a folder" };
    else files = { name: (await loadProjectTemplate(p, ref, { files: fileFacts(engine.workspace.policy) })).name };
  } catch {
    files = { missing: "The files' theme cannot be read" };
  }
  return { variant: t.variant, render, files_theme: files };
}

/** A proposal as thread_get answers it: the engine's view (rows; lines under untrusted.rows) and the offer. */
export type ProposalAnswer = CommentProposalView & { offer: ProposalOffer };

/** What thread_get answers. */
export interface ThreadGetAnswer {
  thread: ThreadAnswer;
  /** The newest proposal of the thread (or the one named), absent when it has none. */
  proposal?: ProposalAnswer;
}

/** What thread_apply answers: the thread after the apply entry, the scenario written and what Undo apply restores. */
export interface ThreadApplyAnswer {
  thread: ThreadAnswer;
  hash: string;
  entry?: string;
  scenario: { name: string; file: string; hash: string; previous: { text: string; hash: string } };
  label: string;
  change: 'edit';
  warnings: unknown[];
  problems: string[];
}

/** What threads_list answers. */
export interface ThreadsListAnswer {
  project: string;
  scenario: string;
  threads: ThreadItem[];
  total: number;
  /** Open and resolved threads of the scenario (every status, before `limit`). */
  counts: { open: number; resolved: number };
  problems: number;
}

/** commentOps: the shared chain is the one scenario_edit and scenario_render use (critique B5). */
export function commentOps(o: { chain?: OpChain } = {}): ToolDef[] {
  const chain = o.chain ?? opChain();
  const threadKey = (slug: string, id: string) => `thread\0${slug}\0${id}`;
  const root = (engine: Engine) => engine.workspace.root;

  const list: ToolDef<typeof ListInput> = {
    name: 'threads_list',
    title: "A scenario's comment threads",
    description: "A scenario's frame comment threads (open, resolved or all), open first: where each points, its state and its newest proposal's; the comment's first words as untrusted data.",
    input: ListInput,
    annotations: READ,
    async run(a, { engine }) {
      const [v, c] = await Promise.all([
        engine.comments.list(a.project, { scenario: a.name, status: a.status ?? 'open', limit: a.limit ?? THREADS_LIST_MAX, ...(a.render ? { render: a.render } : {}) }),
        engine.comments.counts(a.project, { scenario: a.name }),
      ]);
      const counts = c.scenarios[a.name] ?? { open: 0, resolved: 0 };
      const data: ThreadsListAnswer = { project: a.project, scenario: a.name, threads: v.threads.map(threadItem), total: v.total, counts, problems: v.problems.length };
      return { summary: `${a.name}: ${plural(data.threads.length, 'thread')} (${counts.open} open, ${counts.resolved} resolved)`, data: data as unknown as Record<string, unknown> };
    },
  };
  const counts: ToolDef<typeof CountsInput> = {
    name: 'threads_counts',
    title: 'Comment counts',
    description: 'Open and resolved frame comment threads per scenario, from the thread files alone (no render, no view).',
    input: CountsInput,
    annotations: READ,
    async run(a, { engine }) {
      const c = await engine.comments.counts(a.project, a.name ? { scenario: a.name } : {});
      const open = Object.values(c.scenarios).reduce((n, s) => n + s.open, 0);
      return { summary: `${a.project}${a.name ? `/${a.name}` : ''}: ${open} open`, data: c as unknown as Record<string, unknown> };
    },
  };
  const get: ToolDef<typeof GetInput> = {
    name: 'thread_get',
    title: 'A comment thread',
    description: "One frame comment thread without any path: where it points, its entries (texts as untrusted data), and its newest proposal as the canonical diff of what Apply writes, with what may be offered for it.",
    input: GetInput,
    annotations: READ,
    async run(a, { engine }) {
      const v = await engine.comments.get(a.project, a.comment_id);
      const data: ThreadGetAnswer = { thread: threadAnswer(v) };
      const proposed = a.entry_id ?? [...v.entries].reverse().find((e) => e.proposal)?.id;
      if (proposed) {
        const view = await engine.comments.proposal(a.project, a.comment_id, proposed);
        const p = view.blocked !== undefined ? { ...view, blocked: pathFree(view.blocked, root(engine)) } : view;
        // The render record and the files' theme are read only when they decide (critique B3).
        const decides = p.actionable && p.blocked === undefined && p.verified && p.same_take === true;
        data.proposal = { ...p, offer: proposalOffer(p, decides ? await offerFacts(engine, a.project, v) : UNREAD) };
      }
      const pr = data.proposal ? `, proposal ${data.proposal.state}` : '';
      return { summary: `${v.id} on ${v.render_id} at ${v.timecode}: ${v.status}, ${plural(v.entries.length, 'entry')}${pr}`, data: data as unknown as Record<string, unknown> };
    },
  };
  const still: ToolDef<typeof StillInput> = {
    name: 'thread_still',
    title: "A thread's still",
    description: "The still made when a thread was written (its region outlined) as a base64 JPEG (≤ 1280 px): what it showed when its render is gone.",
    input: StillInput,
    annotations: READ,
    async run(a, { engine }) {
      const v = await engine.comments.get(a.project, a.comment_id);
      if (v.still === null) throw new EngineError('not_found', `comment ${v.id} has no still (made on another machine, or it failed)`);
      const t = await engine.thumbnail(v.still, 1280);
      return { summary: `still of ${v.id} (${t.width}×${t.height})`, data: { comment_id: v.id, mime: 'image/jpeg', base64: t.base64, width: t.width, height: t.height } };
    },
  };
  const outline: ToolDef<typeof OutlineInput> = {
    name: 'render_outline',
    title: "A render's frames",
    description: "A succeeded render's frames, fps, size, markers (names as untrusted data) and the threads made on it as it is now.",
    input: OutlineInput,
    annotations: READ,
    async run(a, { engine }) {
      const v = await engine.renders.outline(a.project, { render_id: a.render_id, ...(a.created_at ? { created_at: a.created_at } : {}) });
      return { summary: `${v.render_id}: ${plural(v.frames, 'frame')} at ${v.fps} fps, ${plural(v.pins.length, 'thread')}`, data: v as unknown as Record<string, unknown> };
    },
  };
  const frameOp: ToolDef<typeof FrameInput> = {
    name: 'render_frame',
    title: 'A frame of a render',
    description: "One output frame of a succeeded render as a base64 JPEG (≤ 1280 px), at the video's own fps; the page's newest request of a render wins.",
    input: FrameInput,
    annotations: READ,
    async run(a, { engine, signal }) {
      const v = await engine.renders.frame(a.project, { render_id: a.render_id, created_at: a.created_at, frame: a.frame }, { session: a.session, ...(signal ? { signal } : {}) });
      return { summary: `${v.render_id} frame ${v.frame} (${v.timecode})`, data: v as unknown as Record<string, unknown> };
    },
  };
  const anchor: ToolDef<typeof AnchorInput> = {
    name: 'frame_anchor',
    title: 'Where a frame comment points',
    description: "The anchor a comment on that frame (and region) would store — the same engine code as thread_add — and where its step is in today's file; nothing written.",
    input: AnchorInput,
    annotations: READ,
    async run(a, { engine }) {
      const v = await engine.comments.anchorAt(a.project, { render: a.render_id, render_created_at: a.created_at, frame: a.frame, ...(a.region ? { region: a.region } : {}) });
      return { summary: `${v.render_id} frame ${v.frame}: ${v.anchor.kind} ${v.anchor.segment}`, data: { ...v, warnings: v.warnings.map((w) => pathFree(w, root(engine))) } as unknown as Record<string, unknown> };
    },
  };
  const add: ToolDef<typeof AddInput> = {
    name: 'thread_add',
    title: 'Comment a frame',
    description: 'A new thread on one frame of the render the page showed (its id and created_at), optionally a region: written as the channel studio, its still made after it.',
    input: AddInput,
    annotations: WRITE,
    async run(a, { engine }) {
      const r = await engine.comments.add(a.project, { render: a.render_id, render_created_at: a.created_at, frame: a.frame, ...(a.region ? { region: a.region } : {}), text: a.text });
      const data = { thread: threadAnswer(r.thread), warnings: r.warnings.map((w) => pathFree(w, root(engine))) };
      return { summary: `${r.thread.id} on ${r.thread.render_id} at ${r.thread.timecode}${r.warnings.length ? ` with ${plural(r.warnings.length, 'warning')}` : ''}`, data };
    },
  };
  const written = (r: { thread: CommentView; entry: string; hash: string }) => ({ thread: threadAnswer(r.thread), entry: r.entry, hash: r.hash });
  const reply: ToolDef<typeof ReplyInput> = {
    name: 'thread_reply',
    title: 'Reply to a thread',
    description: 'A reply on a thread, written as the channel studio (never a proposal: proposals are Claude\'s).',
    input: ReplyInput,
    annotations: WRITE,
    async run(a, { engine }) {
      const r = await chain(threadKey(a.project, a.comment_id), () => engine.comments.reply(a.project, a.comment_id, a.text));
      return { summary: `${a.comment_id}: reply ${r.entry}`, data: written(r) };
    },
  };
  const resolve: ToolDef<typeof ResolveInput> = {
    name: 'thread_resolve',
    title: 'Resolve a thread',
    description: 'Resolve an open thread on the version the page showed (if_match), with a note and optionally the render that answers it.',
    input: ResolveInput,
    annotations: WRITE,
    async run(a, { engine }) {
      const r = await chain(threadKey(a.project, a.comment_id), () =>
        engine.comments.resolve(a.project, a.comment_id, { note: a.note, if_match: a.if_match, ...(a.render_id ? { render_id: a.render_id } : {}) }),
      );
      return { summary: `${a.comment_id}: resolved`, data: written(r) };
    },
  };
  const reopen: ToolDef<typeof ReopenInput> = {
    name: 'thread_reopen',
    title: 'Reopen a thread',
    description: 'Reopen a resolved thread on the version the page showed (if_match).',
    input: ReopenInput,
    annotations: WRITE,
    async run(a, { engine }) {
      const r = await chain(threadKey(a.project, a.comment_id), () => engine.comments.reopen(a.project, a.comment_id, a.note, { if_match: a.if_match }));
      return { summary: `${a.comment_id}: reopened`, data: written(r) };
    },
  };
  const apply: ToolDef<typeof ApplyInput> = {
    name: 'thread_apply',
    title: "Apply Claude's proposal",
    description: "Apply a thread's newest proposal (pending, or undone) on the version the page showed (if_match): the text rebuilt and checked, written by the Studio's own write path; `previous` is what Undo apply restores (scenario_edit restore).",
    input: ApplyInput,
    annotations: WRITE,
    async run(a, { engine }) {
      const t = await engine.comments.get(a.project, a.comment_id);
      const r = await chain(scenarioKey(a.project, t.scenario), () => chain(threadKey(a.project, a.comment_id), () => engine.comments.apply(a.project, a.comment_id, { entry_id: a.entry_id, if_match: a.if_match })));
      const data: ThreadApplyAnswer = {
        thread: threadAnswer(r.thread),
        hash: r.hash,
        ...(r.entry ? { entry: r.entry } : {}),
        scenario: { name: r.scenario.name, file: pathFree(r.scenario.file, root(engine)), hash: r.scenario.hash, previous: { text: r.scenario.previous.text, hash: r.scenario.previous.hash } },
        label: r.label,
        change: r.change,
        warnings: r.warnings,
        problems: r.problems.map((p) => pathFree(p, root(engine))),
      };
      return { summary: `${r.label}: ${data.scenario.file} (hash ${r.scenario.hash})${r.problems.length ? ` — ${r.problems.length} problem` : ''}`, data: data as unknown as Record<string, unknown> };
    },
  };
  return [list, counts, get, still, outline, frameOp, anchor, add, reply, resolve, reopen, apply] as unknown as ToolDef[];
}

/** The names of the comment ops (the Studio's own, never an MCP tool's name). */
export const COMMENT_OPS = ['threads_list', 'threads_counts', 'thread_get', 'thread_still', 'render_outline', 'render_frame', 'frame_anchor', 'thread_add', 'thread_reply', 'thread_resolve', 'thread_reopen', 'thread_apply'] as const;
