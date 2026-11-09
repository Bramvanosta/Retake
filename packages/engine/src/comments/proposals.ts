/** Claude's proposals on a thread: apply, the diff shown, the preview (see ../comments.ts). */
import { open } from 'node:fs/promises';
import { relative } from 'node:path';
import {
  COMMENT_AUTHOR_MAX,
  COMMENT_ENTRY_ID_RE,
  deriveStatus,
  PROPOSAL_CHANGED_LINES_MAX,
  applyHunks,
  diffLines,
  hunkStats,
  invertHunks,
  joinLines,
  proposalStates,
  sameHunks,
  scenarioSinceRun,
  textEol,
  textLines,
  projectPath,
} from '@retake/core';
import type {
  CommentAuthor,
  CommentEntry,
  CommentProposal,
  CommentThread,
  LoadedProject,
  ProposalState,
  ValidationIssue,
} from '@retake/core';
import type { ComponentRegistry } from '@retake/components';
import { EngineError } from '../errors.js';
import type { StoreScope } from '../store/project-store.js';
import { checkRunId } from '../refs.js';
import { PROPOSAL_CONTEXT_LINES, checkProposedText, diffRows, rebuildProposal } from '../comment-proposals.js';
import type { ProposalRow } from '../comment-proposals.js';
import { editScenario, getScenario } from '../scenarios.js';
import type { ScenarioText } from '../scenarios.js';
import { sha256Hex } from '../storage.js';
import { appendedThread, applyEntryOf, argError, checkIfMatch, locateThread, lockThread, readThread, threadStore } from './store.js';
import { renderIndex, threadView } from './views.js';
import type { CommentView } from './views.js';
import { writeAppended } from './threads.js';
import type { CommentWritten } from './threads.js';

// ── Proposals: apply, the diff shown, the preview (L4.6, R-UI-28) ─────────────

/** The proposal entry of a thread named by `entryId` (default: the newest proposal). */
export function proposalEntry(thread: CommentThread, entryId: string | undefined): CommentEntry & { proposal: CommentProposal } {
  if (entryId !== undefined && (typeof entryId !== 'string' || !COMMENT_ENTRY_ID_RE.test(entryId))) {
    throw argError('entry_id', `invalid entry id "${String(entryId).slice(0, 80)}": r_ + 26 characters (the thread's entries name them)`);
  }
  const withProposal = thread.entries.filter((e): e is CommentEntry & { proposal: CommentProposal } => e.proposal !== undefined);
  if (entryId === undefined) {
    const last = withProposal.at(-1);
    if (!last) throw new EngineError('not_found', `comment ${thread.id} holds no proposal`);
    return last;
  }
  const e = thread.entries.find((x) => x.id === entryId);
  if (!e) throw new EngineError('not_found', `comment ${thread.id} has no entry ${entryId}`);
  if (!e.proposal) throw argError('entry_id', `entry ${entryId} of comment ${thread.id} holds no proposal`);
  return e as CommentEntry & { proposal: CommentProposal };
}

/** Why a proposal cannot be applied or previewed now (its state, the thread's status), as an EngineError; null: it can. */
export function notActionable(thread: CommentThread, entry: CommentEntry & { proposal: CommentProposal }, today: ScenarioText, stage: 'applied' | 'previewed'): EngineError | null {
  const { status } = deriveStatus(thread.entries);
  if (status !== 'open') return new EngineError('conflict', `not ${stage}: comment ${thread.id} is resolved — reopen it first`, { details: { status } });
  const st = proposalStates(thread.entries, today.hash).find((x) => x.entry === entry.id)!;
  if (st.actionable) return null;
  const newest = thread.entries.filter((e) => e.proposal).at(-1)!.id;
  switch (st.state) {
    case 'applied':
      return new EngineError('conflict', `not ${stage}: the proposal of entry ${entry.id} is already applied (${today.file} is its text)`, { details: { state: st.state, current: today.hash } });
    case 'superseded':
    case 'undone':
      return new EngineError('conflict', `not ${stage}: a newer proposal (entry ${newest}) replaces the one of entry ${entry.id}`, { details: { state: st.state, newest } });
    default:
      return new EngineError('conflict', `not ${stage}: ${today.file} changed since this was proposed — ask Claude to propose again on today's file`, { details: { state: st.state, current: today.hash } });
  }
}

export interface CommentApplyRequest {
  /** The reply holding the proposal (the newest proposal of the thread, pending or undone). */
  entry_id: string;
  /** The thread's hash as last read (the version the page showed): a conflict when it changed since. */
  ifMatch?: string;
}

export interface CommentApplied {
  thread: CommentView;
  /** The thread's hash after the apply entry (its hash before when the entry could not be appended). */
  hash: string;
  /** The apply entry, absent when it could not be appended (the state still reads `applied` from the file's hash). */
  entry?: string;
  scenario: {
    name: string;
    file: string;
    /** sha256 of the bytes written (= the proposal's result_sha256). */
    hash: string;
    /** The file before (the proposal's base): Undo apply restores it (scenarios.edit `restore`: a version the engine read). */
    previous: { text: string; hash: string };
  };
  label: string;
  change: 'edit';
  /** The scenario's validation warnings for the text written. */
  warnings: ValidationIssue[];
  /** What went wrong after the write (the apply entry not appended), in words. */
  problems: string[];
}

/**
 * Apply a thread's proposal (L4.6, a person channel: Engine.comments allows `cli` and `ui` only): under the thread's
 * lock, held across the scenario write and the apply entry (critique B5: thread lock → storage write lock, nothing takes
 * them the other way), the thread read with `ifMatch`, open, the entry its newest pending (or undone) proposal; the
 * text rebuilt from today's file and checked (rebuildProposal: base hash, strict hunks, result hash, canonical diff) and
 * edit-only; then written by editScenario itself (`replace_text` with agent trust from the Studio: every L4.3 rule runs
 * again at the moment of the write — a planted thread is refused here); then the apply entry is appended with no
 * second hash check (a failure there is a problem in words, never a failed answer: the file's hash says `applied`).
 */
export async function applyProposal(
  project: LoadedProject,
  id: string,
  req: CommentApplyRequest,
  author: CommentAuthor,
  o: { registry?: () => Promise<ComponentRegistry>; scope?: StoreScope } = {},
): Promise<CommentApplied> {
  // The scenario is written as the caller's (the Studio's by default: a person applies there).
  const scope = o.scope ?? threadStore(project, author).scope;
  if (req.ifMatch !== undefined && (typeof req.ifMatch !== 'string' || !/^[0-9a-f]{64}$/.test(req.ifMatch))) throw argError('if_match', 'if_match is the hash a listing returned (64 hex characters)');
  if (typeof req.entry_id !== 'string' || !COMMENT_ENTRY_ID_RE.test(req.entry_id)) throw argError('entry_id', `invalid entry id "${String(req.entry_id).slice(0, 80)}": r_ + 26 characters`);
  const f = await locateThread(project.dir, id);
  const lock = await lockThread(project.dir, id, 'apply');
  try {
    const r = await readThread(project.dir, f);
    if (!r.ok) throw new EngineError('invalid', `${r.problem} — the file is never overwritten: fix it or remove it`);
    checkIfMatch(f, r.hash, req.ifMatch);
    const entry = proposalEntry(r.thread, req.entry_id);
    const today = await getScenario(project, r.thread.scenario);
    const why = notActionable(r.thread, entry, today, 'applied');
    if (why) throw why;
    const text = rebuildProposal(today, entry.proposal, 'applied');
    // Edit-only and the Studio's checks once more before the write (editScenario repeats the latter while writing).
    await checkProposedText(project, r.thread.scenario, today, text, 'applied', o);
    // The apply entry must fit the thread (entries, size) before the scenario is written (review A L5 / B M3): a full
    // thread refuses with nothing changed. The entry written after names the hash editScenario returns (= this one).
    try {
      appendedThread(id, r, applyEntryOf(author, entry.id, entry.proposal.result_sha256));
    } catch (e) {
      if (e instanceof EngineError) throw new EngineError(e.code, `not applied: ${e.message} — nothing was written`, e.details !== undefined ? { details: e.details } : {});
      throw e;
    }
    let edited: Awaited<ReturnType<typeof editScenario>>;
    try {
      edited = await editScenario(project, r.thread.scenario, { hash: entry.proposal.base_sha256, edit: { kind: 'replace_text', text } }, { agent: true, via: 'studio', ...(o.registry ? { registry: o.registry } : {}), scope });
    } catch (e) {
      if (e instanceof EngineError && e.message.startsWith('not saved: ')) throw new EngineError(e.code, e.message.replace(/^not saved: /, 'not applied: '), { ...(e.details !== undefined ? { details: e.details } : {}), ...(e.fix !== undefined ? { fix: e.fix } : {}) });
      throw e;
    }
    const problems: string[] = [];
    let written: CommentWritten | undefined;
    try {
      written = await writeAppended(project, f, r, applyEntryOf(author, entry.id, edited.hash), scope);
    } catch (e) {
      problems.push(`the apply was written to ${edited.file} but not recorded in the thread (${(e as Error).message.split('\n')[0]}): the thread reads the proposal as applied from the file`);
    }
    const thread = written?.thread ?? (await threadView(project.dir, r.thread, r.hash, await renderIndex(project.dir)));
    return {
      thread,
      hash: written?.hash ?? r.hash,
      ...(written ? { entry: written.entry } : {}),
      scenario: { name: r.thread.scenario, file: edited.file, hash: edited.hash, previous: { text: today.yaml, hash: today.hash } },
      label: `Applied the proposal of comment ${id}`,
      change: 'edit',
      warnings: edited.warnings,
      problems,
    };
  } finally {
    lock.releaseSync();
  }
}

export interface CommentProposalView {
  project: string;
  comment_id: string;
  scenario: string;
  /** The reply holding it. */
  entry: string;
  status: 'open' | 'resolved';
  /** The thread's hash (the `if_match` of an apply). */
  hash: string;
  state: ProposalState;
  actionable: boolean;
  delta: CommentProposal['delta'];
  base_sha256: string;
  result_sha256: string;
  /** sha256 of today's file (null: not readable). */
  today_sha256: string | null;
  added: number;
  removed: number;
  hunks: number;
  /** Changed lines over the lines of both versions, in % (critique B13: say it past PROPOSAL_REWRITE_NOTE_PCT). */
  rewrites_pct?: number;
  /**
   * The rows are the canonical diff of the exact bytes (critique B1: rebuilt from today's file — pending, undone or
   * applied — and checked: result hash, canonical hunks), with context lines. False: the hunks as stored (the file is
   * neither its base nor its result), no context.
   */
  verified: boolean;
  /**
   * Pending or undone: the proposed text's filmed part equals the commented run's snapshot — it renders on that take
   * (critique B2: "Apply and re-render", "Preview change"); false when it does not or the run is gone.
   */
  same_take?: boolean;
  /**
   * Actionable, yet Apply would refuse it now (review A L4): the same checks as Apply's before its write — the text
   * rebuilt (base, strict hunks, result hash, canonical, rows), the Studio's write checks, edit-only, no theme change,
   * the apply entry fitting the thread — in the tool's words, project-relative. Absent: Apply would go ahead.
   */
  blocked?: string;
  rows: ProposalRow[];
  /** Data written by an agent: the text of each row (rows[i] ↔ untrusted.rows[i]; '' for a gap). */
  untrusted: { rows: string[] };
}

/**
 * A proposal as a person reads it (critique B1, B15): its state and the diff computed by the engine from the file —
 * rebuilt from today's file when it is the base (pending, undone) or the result (applied), checked (result hash,
 * canonical hunks) and shown with context; otherwise the stored hunks, unverified. Lines are data (`untrusted.rows`).
 */
export async function getProposal(project: LoadedProject, id: string, entryId?: string, o: { registry?: () => Promise<ComponentRegistry> } = {}): Promise<CommentProposalView> {
  const f = await locateThread(project.dir, id);
  const r = await readThread(project.dir, f);
  if (!r.ok) throw new EngineError('invalid', r.problem);
  const entry = proposalEntry(r.thread, entryId);
  const p = entry.proposal;
  let today: ScenarioText | null = null;
  try {
    today = await getScenario(project, r.thread.scenario);
  } catch (e) {
    if (!(e instanceof EngineError && e.code === 'not_found')) throw e;
  }
  const { status } = deriveStatus(r.thread.entries);
  const st = proposalStates(r.thread.entries, today?.hash ?? null).find((x) => x.entry === entry.id)!;
  const stats = hunkStats(p.hunks);
  let base: string[] | undefined;
  let result: string[] | undefined;
  if (today && (st.state === 'pending' || st.state === 'undone')) {
    try {
      const text = rebuildProposal(today, p, 'previewed');
      base = textLines(today.yaml);
      result = textLines(text);
    } catch {
      /* a tampered proposal: shown unverified */
    }
  } else if (today && st.state === 'applied') {
    // Today's file is the result: the base is the hunks undone, checked against the base hash and the canonical diff.
    const eol = textEol(today.yaml);
    try {
      const after = textLines(today.yaml);
      const before = applyHunks(after, invertHunks(p.hunks));
      const canonical = diffLines(before, after, { maxChanged: PROPOSAL_CHANGED_LINES_MAX });
      // The base may have had no final line break (Apply writes one): both spellings of the base are its hash (review B L1).
      const baseOk = sha256Hex(joinLines(before, eol)) === p.base_sha256 || sha256Hex(before.join(eol)) === p.base_sha256;
      if (baseOk && canonical && sameHunks(canonical, p.hunks)) {
        base = before;
        result = after;
      }
    } catch {
      /* shown unverified */
    }
  }
  const verified = base !== undefined && result !== undefined;
  // What Apply would say now (review A L4): its checks before the write, run only for a proposal it would take.
  let blocked: string | undefined;
  if (today && status === 'open' && st.actionable) {
    try {
      const text = rebuildProposal(today, p, 'applied');
      await checkProposedText(project, r.thread.scenario, today, text, 'applied', o);
      appendedThread(r.thread.id, r, applyEntryOf({ via: 'studio', name: 'x'.repeat(COMMENT_AUTHOR_MAX) }, entry.id, p.result_sha256)); // the longest name: never offered when Apply would not fit
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      const words = e.message.split(`${project.dir}/`).join('').split(project.dir).join('.');
      blocked = words.startsWith('not applied: ') ? words : `not applied: ${words}`;
    }
  }
  const { rows, texts } = verified
    ? diffRows(base!, p.hunks, PROPOSAL_CONTEXT_LINES)
    : (() => {
        const out: { rows: ProposalRow[]; texts: string[] } = { rows: [], texts: [] };
        for (const h of p.hunks) {
          h.del.forEach((l, j) => (out.rows.push({ kind: 'del', base: h.at + j }), out.texts.push(l)));
          h.add.forEach((l) => (out.rows.push({ kind: 'add' }), out.texts.push(l)));
        }
        return out;
      })();
  let sameTake: boolean | undefined;
  if (verified && (st.state === 'pending' || st.state === 'undone')) {
    let since: ReturnType<typeof scenarioSinceRun>;
    try {
      since = scenarioSinceRun(project, projectPath(project.dir, 'runs', checkRunId(r.thread.render.run_id)), r.thread.scenario, joinLines(result!, textEol(today!.yaml)));
    } catch {
      since = undefined;
    }
    sameTake = since !== undefined && since.filmed !== undefined && since.filmed.length === 0;
  }
  return {
    project: project.slug,
    comment_id: r.thread.id,
    scenario: r.thread.scenario,
    entry: entry.id,
    status,
    hash: r.hash,
    state: st.state,
    actionable: st.actionable && status === 'open',
    delta: p.delta,
    base_sha256: p.base_sha256,
    result_sha256: p.result_sha256,
    today_sha256: today?.hash ?? null,
    added: stats.added,
    removed: stats.removed,
    hunks: p.hunks.length,
    ...(verified ? { rewrites_pct: Math.round((100 * stats.changed) / Math.max(1, base!.length + result!.length)) } : {}),
    verified,
    ...(sameTake !== undefined ? { same_take: sameTake } : {}),
    ...(blocked !== undefined ? { blocked } : {}),
    rows,
    untrusted: { rows: texts },
  };
}

/** A proposal checked for the timeline's preview (critique B9): the text to plan and where it comes from. */
export interface ProposalPreview {
  comment_id: string;
  entry: string;
  /** The exact bytes Apply would write (never registered as a version of the file). */
  text: string;
  result_sha256: string;
  /** The commented take: the preview plans the proposed text on it. */
  run_id: string;
  /** Today's file hash (the proposal's base). */
  base_sha256: string;
  thread: CommentThread;
}

/**
 * The proposed text of a thread's actionable proposal for the timeline's preview (critique B9): the thread of
 * `scenario`, open, the entry its newest pending (or undone) proposal, today's file its base, the text rebuilt and
 * checked (rebuildProposal) and passed through the Studio's full write checks (prepareScenarioEdit: agent trust,
 * hooks, vars / env) — nothing written, no version remembered. Run on every preview (outside any memo).
 */
export async function proposalForPreview(
  project: LoadedProject,
  scenario: string,
  req: { comment_id: string; entry_id: string },
  o: { registry?: () => Promise<ComponentRegistry> } = {},
): Promise<ProposalPreview> {
  const f = await locateThread(project.dir, req.comment_id);
  const r = await readThread(project.dir, f);
  if (!r.ok) throw new EngineError('invalid', r.problem);
  if (r.thread.scenario !== scenario) throw argError('proposal', `comment ${r.thread.id} is a comment on ${r.thread.scenario}, not on ${scenario}`);
  if (typeof req.entry_id !== 'string' || !COMMENT_ENTRY_ID_RE.test(req.entry_id)) throw argError('entry_id', `invalid entry id "${String(req.entry_id).slice(0, 80)}": r_ + 26 characters`);
  const entry = proposalEntry(r.thread, req.entry_id);
  const today = await getScenario(project, scenario);
  const why = notActionable(r.thread, entry, today, 'previewed');
  if (why) throw why;
  const text = rebuildProposal(today, entry.proposal, 'previewed');
  await checkProposedText(project, scenario, today, text, 'previewed', o);
  return { comment_id: r.thread.id, entry: entry.id, text, result_sha256: entry.proposal.result_sha256, run_id: checkRunId(r.thread.render.run_id), base_sha256: today.hash, thread: r.thread };
}
