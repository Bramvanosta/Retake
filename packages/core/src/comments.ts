/**
 * Frame comments (L3.6, R-CMT-01..05, ADR-1 #4): a person's comment on one frame of a render, optionally a region of
 * it, kept as one thread file `<project>/comments/<scenario>/c_<ULID>.json`. A thread holds its comment, where the
 * frame points in the edit (`anchor`, review frameAnchor) and append-only `entries` (replies, resolutions, reopenings),
 * each with its own id: the file is its own audit trail and two writers (git branches, a later sync) only ever add
 * entries. The status is derived from the entries (`deriveStatus`), never stored.
 *
 * Who wrote an entry is the channel it came through (`author.via`: `cli` — a `retake` command —, `studio` — the Studio
 * web app's page (L4.6) —, `mcp` — the MCP tools), never a claim of being a person: a command can be typed by anyone,
 * Claude included, and any program of the user that reads the Studio's token file can call the Studio's routes. Every
 * free text of a thread (comment, entries, author names) is data for its readers.
 */
import { createHash } from 'node:crypto';
import { parse as parseYamlText } from 'yaml';
import { z } from 'zod';
import { BIDI_CONTROL_CHARS, INVISIBLE_FORMAT_CHARS, printableText } from './printable.js';
import { COMMENT_ENTRY_ID_RE, COMMENT_ID_RE, renderIdOf } from './id-grammar.js';
import { newUlidId, zRenderId, zRunId } from './ids.js';
import { hunkOrderProblem, hunkStats } from './line-diff.js';
import type { LineHunk } from './line-diff.js';
import { firstHiddenChar, hiddenCharName } from './scenario-edit.js';
import { COMPONENT_ID_RE, SLUG_RE } from './schemas/primitives.js';
import { stepFingerprint } from './steps.js';
import { parseYaml } from './validation/yaml-source.js';
import { ACTION_NAMES } from './types.js';
import type { FrameCommentAnchor } from './types.js';

export const COMMENT_THREAD_VERSION = 1;

/** A new thread id (unique across machines, sortable by creation time). */
export function newCommentId(now?: number): string {
  return newUlidId('comment', now);
}

/** A new entry id. */
export function newCommentEntryId(now?: number): string {
  return newUlidId('entry', now);
}

/** Longest comment, reply and note text (= the MCP's cap on an untrusted string: a text reaches the model whole). */
export const COMMENT_TEXT_MAX = 2000;
/** Longest author name. */
export const COMMENT_AUTHOR_MAX = 80;

/** Control characters but the line feed (C0, DEL, C1), bidi controls and invisible format characters (core brand.ts). */
const FORBIDDEN_CLASS = `[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f${BIDI_CONTROL_CHARS}${INVISIBLE_FORMAT_CHARS}]`;
const FORBIDDEN_TEXT = new RegExp(FORBIDDEN_CLASS, 'u');
const FORBIDDEN_TEXT_G = new RegExp(`${FORBIDDEN_CLASS}+`, 'gu');

/**
 * A comment, reply or note as stored: line breaks normalised to `\n` (kept), tabs as spaces, other control characters
 * (C0, DEL, C1), bidi controls and invisible format characters (zero-width space, word joiner, BOM, tag characters)
 * removed, trailing spaces of each line and blank lines at both ends trimmed. The one sanitiser of the CLI's and the
 * MCP's input; the length is checked after it (`commentTextProblem`).
 */
export function commentText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(FORBIDDEN_TEXT_G, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

/** Why a (sanitised) text is refused, or null: empty when `required`, longer than COMMENT_TEXT_MAX. */
export function commentTextProblem(text: string, o: { what?: string; required?: boolean } = {}): string | null {
  const what = o.what ?? 'the comment';
  if (o.required !== false && text.trim() === '') return `${what} is empty`;
  if (text.length > COMMENT_TEXT_MAX) return `${what} has ${text.length} characters: at most ${COMMENT_TEXT_MAX}`;
  return null;
}

/** An author name as stored (core printableText: control and bidi characters out, spaces collapsed), or null when empty / too long. */
export function commentAuthorName(s: string): string | null {
  const name = printableText(s);
  return name && name.length <= COMMENT_AUTHOR_MAX ? name : null;
}

/** A commented region, 0..1 of the output frame. */
export interface CommentRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

const EPS = 1e-9;

/** Why a region is refused, or null: numbers in 0..1, w and h > 0, inside the frame (x + w ≤ 1, y + h ≤ 1). */
export function regionProblem(r: CommentRegion): string | null {
  const vals = [r.x, r.y, r.w, r.h];
  if (!vals.every((v) => typeof v === 'number' && Number.isFinite(v))) return 'a region is four numbers x, y, w, h';
  if (vals.some((v) => v < 0 || v > 1)) return 'a region is 0..1 of the frame (x, y, w, h)';
  if (r.w <= 0 || r.h <= 0) return 'a region has a width and a height above 0';
  if (r.x + r.w > 1 + EPS || r.y + r.h > 1 + EPS) return 'a region lies inside the frame (x + w ≤ 1, y + h ≤ 1)';
  return null;
}

/**
 * Fingerprint of step `step` of scene `scene` in a scenario's text (the run's `scenario.yaml` snapshot: raw, templated
 * values unexpanded, comparable with today's file) and its occurrence among the scene's earlier steps with the same
 * fingerprint (`n`, 0-based: identical steps in a row). Undefined when the text, the scene or the step cannot be read.
 */
export function scenarioStepFingerprint(scenarioText: string, scene: string, step: number): { fp: string; n: number } | undefined {
  let doc: unknown;
  try {
    doc = parseYamlText(scenarioText);
  } catch {
    return undefined;
  }
  const scenes = (doc as { scenes?: unknown } | null)?.scenes;
  if (!Array.isArray(scenes)) return undefined;
  const entry = scenes.find((e) => e && typeof e === 'object' && (e as { id?: unknown }).id === scene && Array.isArray((e as { steps?: unknown }).steps)) as
    | { steps: unknown[] }
    | undefined;
  if (!entry || !Number.isInteger(step) || step < 0 || step >= entry.steps.length) return undefined;
  const fp = stepFingerprint(entry.steps[step]);
  if (!fp) return undefined;
  let n = 0;
  for (let i = 0; i < step; i++) if (stepFingerprint(entry.steps[i]) === fp) n++;
  return { fp, n };
}

/**
 * Where an anchored step is in today's scenario text (L4.3, critique B10; review B M1): a thread's `step_ref` names the
 * step's place in the run that was rendered, which a reorder (a Studio drag, an edit — into another scene too) moves.
 * Located by its `step_id` in any scene, else by its fingerprint and occurrence (`step_fp`, `step_fp_n`) in the same
 * scene, else by the one step anywhere with that fingerprint: "<scene>.<index>" (what page_inspect's `until` takes),
 * null when today's text has no such step (deleted, changed, several candidates elsewhere, the anchor kept no
 * fingerprint, the text does not parse). Undefined when the anchor names no step.
 */
export function locateAnchorStep(
  scenarioText: string,
  a: Pick<FrameCommentAnchor, 'scene' | 'step' | 'step_id' | 'step_fp' | 'step_fp_n'>,
): string | null | undefined {
  if (a.scene === undefined || a.step === undefined) return undefined;
  const value = parseYaml(scenarioText).value as { scenes?: unknown } | undefined;
  const raw = value && typeof value === 'object' ? value.scenes : undefined;
  if (!Array.isArray(raw)) return null;
  const scenes = raw.filter(
    (e): e is { id: string; steps: unknown[] } => !!e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string' && Array.isArray((e as { steps?: unknown }).steps),
  );
  if (a.step_id !== undefined) {
    for (const sc of scenes) {
      const i = sc.steps.findIndex((s) => s && typeof s === 'object' && (s as { id?: unknown }).id === a.step_id);
      if (i >= 0) return `${sc.id}.${i}`;
    }
    return null;
  }
  if (a.step_fp === undefined) return null;
  const own = scenes.find((sc) => sc.id === a.scene);
  if (own) {
    let n = a.step_fp_n ?? 0;
    for (let i = 0; i < own.steps.length; i++) {
      if (stepFingerprint(own.steps[i]) !== a.step_fp) continue;
      if (n === 0) return `${own.id}.${i}`;
      n--;
    }
  }
  // Moved to another scene: the single step with that fingerprint anywhere else (two or more: which one is unknown).
  const elsewhere: string[] = [];
  for (const sc of scenes) {
    if (sc === own) continue;
    sc.steps.forEach((s, i) => {
      if (stepFingerprint(s) === a.step_fp) elsewhere.push(`${sc.id}.${i}`);
    });
  }
  return elsewhere.length === 1 ? elsewhere[0] : null;
}

// ── The thread file ─────────────────────────────────────────────────────────

/** ISO 8601 UTC, as `Date.toISOString` writes it. */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const isoDate = z.string().max(40).regex(ISO_UTC_RE, 'an ISO 8601 UTC date (2026-10-19T18:00:00.000Z)');

/** An ISO 8601 UTC date as `Date.toISOString` writes it (a render record's `created_at` is checked before it is quoted). */
export function isIsoUtcDate(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 40 && ISO_UTC_RE.test(s);
}
const storedText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !FORBIDDEN_TEXT.test(s), 'control, bidi or invisible characters (only line breaks are kept)');
const anchorString = z.string().min(1).max(200);

/** The channels an entry is written through (CommentAuthorSchema.via). */
export const COMMENT_VIAS = ['cli', 'studio', 'mcp'] as const;
export type CommentVia = (typeof COMMENT_VIAS)[number];

export const CommentAuthorSchema = z.strictObject({
  /**
   * The channel that wrote it: `cli` (a `retake` command), `studio` (the Studio web app, L4.6: written through its page,
   * which holds the session token `retake ui` handed to the browser), `mcp` (the MCP tools). Never a claim of who typed
   * it (BL-106: person presence).
   */
  via: z.enum(COMMENT_VIAS),
  name: z
    .string()
    .min(1)
    .max(COMMENT_AUTHOR_MAX)
    .refine((s) => printableText(s) === s, 'a printable name (no control or bidi characters, single spaces)'),
});
export type CommentAuthor = z.output<typeof CommentAuthorSchema>;

export const CommentRegionSchema = z
  .strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
  .superRefine((r, ctx) => {
    const p = regionProblem(r);
    if (p) ctx.addIssue({ code: 'custom', message: p });
  });

/**
 * The stored anchor: its shape and number ranges. Its ids are strings here (a hand-edited file stays readable); a
 * reader checks each against its pattern (`trustedAnchor`) before showing it as trusted.
 */
export const FrameCommentAnchorSchema = z.strictObject({
  segment: anchorString,
  kind: z.enum(['intro', 'outro', 'clip', 'card', 'interstitial']),
  component: anchorString.optional(),
  area: z.enum(['screen', 'caption', 'brandmark', 'card']).optional(),
  scene: anchorString.optional(),
  step: z.number().int().min(0).max(100_000).optional(),
  step_id: anchorString.optional(),
  step_ref: anchorString.optional(),
  step_fp: anchorString.optional(),
  step_fp_n: z.number().int().min(0).max(100_000).optional(),
  action: anchorString.optional(),
  page: anchorString.optional(),
  src_time_s: z.number().min(0).max(1e7).optional(),
  marker: anchorString.optional(),
  overlays: z.array(anchorString).max(50).optional(),
  transition: z
    .strictObject({ kind: z.enum(['crossfade', 'fade-black']), from: anchorString.optional(), to: anchorString.optional() })
    .optional(),
});
// The schema and the interface (types.ts) describe the same object.
const anchorSchemaMatches: z.ZodType<FrameCommentAnchor> = FrameCommentAnchorSchema;
void anchorSchemaMatches;

/** The render a thread was made on, as it was then: tells a reused render id (renders/ cleaned) from that render. */
export const CommentRenderSchema = z.strictObject({
  id: zRenderId('a render id (<scenario>-v<N>[-vertical|-square])'),
  /** The render record's `created_at`. */
  created_at: isoDate,
  run_id: zRunId('a run folder name'),
  variant: z.enum(['landscape', 'vertical', 'square']),
  fps: z.number().positive().max(240),
  frames: z.number().int().min(1),
  width: z.number().int().min(1).max(16384),
  height: z.number().int().min(1).max(16384),
});
export type CommentRender = z.output<typeof CommentRenderSchema>;

// ── Proposals (L4.6, R-UI-28; critique B1 / B2 / B10 / B13) ─────────────────

/** Changed lines (removed + added) of one proposal, at most (critique B13: a frame comment asks for a small change). */
export const PROPOSAL_CHANGED_LINES_MAX = 200;
/** Characters (UTF-16 units) of a proposal's removed and added lines together, at most. */
export const PROPOSAL_CHARS_MAX = 30_000;
/**
 * Longest line of a proposal, in UTF-16 units (= COMMENT_TEXT_MAX: the MCP's and the Studio's cap on one untrusted
 * string, which would cut a longer line — and the person would read something else than what Apply writes).
 */
export const PROPOSAL_LINE_MAX = COMMENT_TEXT_MAX;
/** Past this share of the file's lines a proposal says how much of the file it rewrites (critique B13). */
export const PROPOSAL_REWRITE_NOTE_PCT = 25;

/**
 * Why one line of a proposal is refused, or null: longer than PROPOSAL_LINE_MAX UTF-16 units, a line break inside it,
 * half of a character (a lone surrogate: its UTF-8 bytes would be U+FFFD), or a character that reads as nothing or as a
 * line break (scenario-edit's input rules: controls but the tab, direction controls, invisible and default-ignorable
 * characters, a byte-order mark anywhere — an emoji's joiner and variation selector are fine). A person reads every line
 * of a proposal: none may hide anything.
 */
export function proposalLineProblem(line: string): string | null {
  if (typeof line !== 'string') return 'a line is a text';
  if (line.length > PROPOSAL_LINE_MAX) return `a line of ${line.length} characters (UTF-16 units): at most ${PROPOSAL_LINE_MAX}`;
  if (/[\r\n]/.test(line)) return 'a line break inside a line';
  // A lone surrogate is no character: written as UTF-8 it becomes U+FFFD — Apply would write another line than the one shown.
  if (/\p{Cs}/u.test(line)) return 'half of a character (a lone UTF-16 surrogate)';
  const hidden = line.includes('\ufeff') ? '\ufeff' : firstHiddenChar(line);
  return hidden ? `it holds ${hiddenCharName(hidden)}` : null;
}

/**
 * Why a proposal's hunks are refused, or null (line-diff.ts): sorted and separated by an unchanged line, none empty;
 * at most PROPOSAL_CHANGED_LINES_MAX changed lines and PROPOSAL_CHARS_MAX characters; every line passing
 * proposalLineProblem. Whether they are the canonical diff of the exact bytes is checked against the file (engine).
 */
export function proposalHunksProblem(hunks: readonly LineHunk[]): string | null {
  if (hunks.length === 0) return 'a proposal changes at least one line';
  const order = hunkOrderProblem(hunks);
  if (order) return order;
  const st = hunkStats(hunks);
  if (st.changed > PROPOSAL_CHANGED_LINES_MAX) return `${st.changed} changed lines (removed + added): a proposal changes at most ${PROPOSAL_CHANGED_LINES_MAX}`;
  if (st.chars > PROPOSAL_CHARS_MAX) return `${st.chars.toLocaleString('en')} characters of changed lines: a proposal holds at most ${PROPOSAL_CHARS_MAX.toLocaleString('en')}`;
  for (const [i, h] of hunks.entries()) {
    for (const [side, lines] of [['removed', h.del], ['added', h.add]] as const) {
      for (const [j, l] of lines.entries()) {
        const p = proposalLineProblem(l);
        if (p) return `hunk ${i + 1}, ${side} line ${j + 1}: ${p}`;
      }
    }
  }
  return null;
}

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256 (64 lower-case hex characters)');
/** A line of a proposal as stored (proposalLineProblem). */
const proposalLine = z.string().superRefine((l, ctx) => {
  const p = proposalLineProblem(l);
  if (p) ctx.addIssue({ code: 'custom', message: p });
});

export const ProposalHunkSchema = z.strictObject({
  at: z.number().int().min(1).max(10_000_000),
  del: z.array(proposalLine).max(PROPOSAL_CHANGED_LINES_MAX),
  add: z.array(proposalLine).max(PROPOSAL_CHANGED_LINES_MAX),
});

/**
 * Claude's proposed change of the thread's own scenario file (L4.6), stored in its reply: the sha256 of the file it was
 * made on and of the exact bytes Apply writes, the file's line break, and the canonical line diff between them
 * (line-diff.ts). `delta: 'edit'`: an edit-only change (critique B2 — a change of what a capture films is never a
 * proposal: it is saved and captured, the direct loop).
 */
export const CommentProposalSchema = z
  .strictObject({
    base_sha256: sha256Hex,
    result_sha256: sha256Hex,
    eol: z.enum(['lf', 'crlf']),
    delta: z.enum(['edit']),
    hunks: z.array(ProposalHunkSchema).min(1).max(PROPOSAL_CHANGED_LINES_MAX),
  })
  .superRefine((p, ctx) => {
    const problem = proposalHunksProblem(p.hunks);
    if (problem) ctx.addIssue({ code: 'custom', path: ['hunks'], message: problem });
    if (p.base_sha256 === p.result_sha256) ctx.addIssue({ code: 'custom', path: ['result_sha256'], message: 'a proposal changes the file' });
  });
export type CommentProposal = z.output<typeof CommentProposalSchema>;

export const COMMENT_ENTRY_KINDS = ['reply', 'resolve', 'reopen', 'apply'] as const;
export type CommentEntryKind = (typeof COMMENT_ENTRY_KINDS)[number];

export const CommentEntrySchema = z
  .strictObject({
    id: z.string().regex(COMMENT_ENTRY_ID_RE, 'an entry id (r_ + a ULID)'),
    kind: z.enum(COMMENT_ENTRY_KINDS),
    author: CommentAuthorSchema,
    /** The reply, the resolution note (required), the reopening note and the apply's (may be empty). */
    text: storedText(COMMENT_TEXT_MAX),
    created_at: isoDate,
    /** A resolution: the render that answers the comment, with its record's `created_at` (render ids can be reused). */
    render_id: zRenderId('a render id').optional(),
    render_created_at: isoDate.optional(),
    /** A reply's proposed change of the thread's scenario file (L4.6). */
    proposal: CommentProposalSchema.optional(),
    /** An apply (L4.6): the reply whose proposal was applied, and the sha256 of the scenario file written. */
    applies: z.string().regex(COMMENT_ENTRY_ID_RE, 'an entry id (r_ + a ULID)').optional(),
    scenario_sha256: sha256Hex.optional(),
  })
  .superRefine((e, ctx) => {
    if (e.kind !== 'reopen' && e.kind !== 'apply' && e.text.trim() === '') ctx.addIssue({ code: 'custom', path: ['text'], message: `a ${e.kind} has a text` });
    if (e.kind !== 'resolve' && (e.render_id !== undefined || e.render_created_at !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['render_id'], message: 'only a resolution names a render' });
    }
    if ((e.render_id === undefined) !== (e.render_created_at === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['render_created_at'], message: 'render_id and render_created_at go together' });
    }
    if (e.proposal !== undefined && e.kind !== 'reply') ctx.addIssue({ code: 'custom', path: ['proposal'], message: 'only a reply holds a proposal' });
    if (e.kind === 'apply') {
      if (e.applies === undefined || e.scenario_sha256 === undefined) ctx.addIssue({ code: 'custom', path: ['applies'], message: 'an apply names the reply it applied (applies) and the file written (scenario_sha256)' });
    } else if (e.applies !== undefined || e.scenario_sha256 !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['applies'], message: 'only an apply names a proposal applied' });
    }
  });
export type CommentEntry = z.output<typeof CommentEntrySchema>;

/** Entries of one thread, at most (a thread is a conversation about one frame). */
export const COMMENT_ENTRIES_MAX = 500;

/** A thread file, `<project>/comments/<scenario>/<id>.json` (version 1). */
export const CommentThreadSchema = z
  .strictObject({
    version: z.literal(COMMENT_THREAD_VERSION),
    id: z.string().regex(COMMENT_ID_RE, 'a thread id (c_ + a ULID)'),
    scenario: z.string().max(100).regex(SLUG_RE, 'a scenario name'),
    render: CommentRenderSchema,
    /** Output frame of the render, and its time (frame / fps). */
    frame: z.number().int().min(0),
    time_s: z.number().min(0),
    region: CommentRegionSchema.optional(),
    /** The marker the frame was picked by (`retake comment add --marker`). */
    marker: z.string().max(100).regex(SLUG_RE, 'a marker name').optional(),
    text: storedText(COMMENT_TEXT_MAX).refine((s) => s.trim() !== '', 'a comment has a text'),
    author: CommentAuthorSchema,
    created_at: isoDate,
    anchor: FrameCommentAnchorSchema,
    /** Append-only, in the order written. */
    entries: z.array(CommentEntrySchema).max(COMMENT_ENTRIES_MAX),
  })
  .superRefine((t, ctx) => {
    if (t.frame >= t.render.frames) ctx.addIssue({ code: 'custom', path: ['frame'], message: `frame ${t.frame} is past the render's last frame (${t.render.frames - 1})` });
    if (renderIdOf(t.render.id, t.scenario) === null) {
      ctx.addIssue({ code: 'custom', path: ['render', 'id'], message: `render ${t.render.id} is not a render of scenario ${t.scenario}` });
    }
    const seen = new Set<string>();
    const proposals = new Set<string>();
    t.entries.forEach((e, i) => {
      if (seen.has(e.id)) ctx.addIssue({ code: 'custom', path: ['entries', i, 'id'], message: `entry ${e.id} appears twice` });
      seen.add(e.id);
      if (e.proposal) proposals.add(e.id);
      if (e.kind === 'apply' && e.applies !== undefined && !proposals.has(e.applies)) {
        ctx.addIssue({ code: 'custom', path: ['entries', i, 'applies'], message: 'an apply names an earlier reply of the thread holding a proposal' });
      }
    });
  });
export type CommentThread = z.output<typeof CommentThreadSchema>;

/** Where a thread stands, from its entries alone: the last resolve or reopen entry decides. */
export interface CommentStatus {
  status: 'open' | 'resolved';
  /** The resolve entry in force. */
  resolution?: { entry: string; by: CommentAuthor; note: string; at: string; render_id?: string; render_created_at?: string };
}

export function deriveStatus(entries: readonly CommentEntry[]): CommentStatus {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'reopen') return { status: 'open' };
    if (e.kind === 'resolve') {
      return {
        status: 'resolved',
        resolution: {
          entry: e.id,
          by: e.author,
          note: e.text,
          at: e.created_at,
          ...(e.render_id !== undefined ? { render_id: e.render_id, render_created_at: e.render_created_at } : {}),
        },
      };
    }
  }
  return { status: 'open' };
}

/**
 * Where a proposal stands (critique B4), from today's file first: `applied` (the file is its result — for an older
 * proposal, only when an apply entry names it), `undone` (it was
 * applied — an apply entry names it — and the file is its base again: Undo apply), `superseded` (a later proposal
 * exists), `stale` (the file is no longer its base, or cannot be read), else `pending`.
 */
export type ProposalState = 'pending' | 'applied' | 'undone' | 'superseded' | 'stale';

export interface ProposalStateOf {
  /** The reply holding the proposal. */
  entry: string;
  state: ProposalState;
  /** Only the newest proposal, pending or undone, can be applied (or previewed). */
  actionable: boolean;
  /** The apply entries that name it, in order. */
  applied_by: string[];
}

/** Each proposal of a thread's entries, in order, with its state against today's file hash (null: no readable file). */
export function proposalStates(entries: readonly CommentEntry[], todayHash: string | null | undefined): ProposalStateOf[] {
  const withProposal = entries.filter((e): e is CommentEntry & { proposal: CommentProposal } => e.proposal !== undefined);
  const applies = new Map<string, string[]>();
  for (const e of entries) if (e.kind === 'apply' && e.applies !== undefined) applies.set(e.applies, [...(applies.get(e.applies) ?? []), e.id]);
  const today = todayHash ?? null;
  return withProposal.map((e, i) => {
    const p = e.proposal;
    const appliedBy = applies.get(e.id) ?? [];
    const newest = i === withProposal.length - 1;
    // An older proposal is `applied` only when an apply names it (a newer one with the same result may have been applied).
    const state: ProposalState =
      today !== null && today === p.result_sha256 && (newest || appliedBy.length > 0)
        ? 'applied'
        : appliedBy.length && today !== null && today === p.base_sha256
          ? 'undone'
          : !newest
            ? 'superseded'
            : today === null || today !== p.base_sha256
              ? 'stale'
              : 'pending';
    return { entry: e.id, state, actionable: newest && (state === 'pending' || state === 'undone'), applied_by: appliedBy };
  });
}

// ── Reading a stored anchor ─────────────────────────────────────────────────

const ANCHOR_ACTIONS = new Set<string>([...ACTION_NAMES, 'scene_open', 'scene_still', 'notification']);
const PAGE_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const STEP_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9][A-Za-z0-9_-]*$/;
const STEP_FP_RE = /^[0-9a-f]{12}$/;
/** Shown in place of a stored anchor value that fails its pattern (the value itself goes under `untrusted`). */
export const ANCHOR_UNKNOWN = 'unknown';

/**
 * A stored anchor with every id checked against its pattern (segment / scene / step_id / marker / transition sides:
 * SLUG_RE; component and overlays: COMPONENT_ID_RE; action: an action name; page, step_ref, step_fp: theirs). A
 * failing value shows as `unknown` and is returned under `untrusted` (a hand-edited file, or one written by anything
 * that is not the tool): the trusted copy only ever holds ids of a known shape.
 */
export function trustedAnchor(a: FrameCommentAnchor): { anchor: FrameCommentAnchor; untrusted?: Record<string, unknown> } {
  const out: FrameCommentAnchor = { ...a };
  const bad: Record<string, unknown> = {};
  const check = (key: 'segment' | 'scene' | 'step_id' | 'marker' | 'component' | 'action' | 'page' | 'step_ref' | 'step_fp', ok: (v: string) => boolean) => {
    const v = a[key];
    if (v === undefined || ok(v)) return;
    bad[key] = v;
    out[key] = ANCHOR_UNKNOWN;
  };
  const slug = (v: string) => SLUG_RE.test(v);
  check('segment', slug);
  check('scene', slug);
  check('step_id', slug);
  check('marker', slug);
  check('component', (v) => COMPONENT_ID_RE.test(v));
  check('action', (v) => ANCHOR_ACTIONS.has(v));
  check('page', (v) => PAGE_ID_RE.test(v));
  check('step_ref', (v) => STEP_REF_RE.test(v));
  check('step_fp', (v) => STEP_FP_RE.test(v));
  if (a.overlays?.some((o) => !COMPONENT_ID_RE.test(o))) {
    bad.overlays = a.overlays;
    out.overlays = a.overlays.map((o) => (COMPONENT_ID_RE.test(o) ? o : ANCHOR_UNKNOWN));
  }
  if (a.transition) {
    const t = { ...a.transition };
    for (const side of ['from', 'to'] as const) {
      const v = a.transition[side];
      if (v !== undefined && !SLUG_RE.test(v)) {
        bad.transition = a.transition;
        t[side] = ANCHOR_UNKNOWN;
      }
    }
    out.transition = t;
  }
  return Object.keys(bad).length ? { anchor: out, untrusted: bad } : { anchor: out };
}
