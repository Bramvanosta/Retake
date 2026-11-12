/**
 * The record of a render (renders/<id>.json) — a contract shared by the renderer, which writes it, and the review, which
 * reads it — in the editor's types: the states of core render-record.ts with an edit plan, and the ONE place a plan read
 * from a disk is given that type (`withPlan`). Reading the files is core/io render-folder.ts. No I/O.
 */
import type { FinishedRender as CoreFinishedRender, RenderAttempt as CoreRenderAttempt, StoredPlan, StoredRenderRecord, UnknownStatusRender } from '@retake/core/render';
import type { EditOverrides, EditPlan } from './plan-types.js';

/** A render that ended well, as this package writes it: its plan an edit plan. */
export type FinishedRender = CoreFinishedRender<EditPlan, EditOverrides>;
/** A render that failed or was cancelled: what RenderError carries; never on a disk. */
export type RenderAttempt = CoreRenderAttempt<EditPlan, EditOverrides>;
/**
 * renders/<id>.json as this package writes it — a render that ended well, the only state put on a disk (core
 * render-record.ts: the states, the two functions that make one, the reader of what any version left).
 */
export type RenderRecord = FinishedRender;

/** `T` with its plan taken for an edit plan (and its overrides for the editor's). */
type WithPlan<T> = T extends unknown ? Omit<T, 'plan' | 'overrides'> & { plan: EditPlan; overrides: EditOverrides } : never;
/** A record read from a disk whose plan is there: what a review, an export, a comment and the frames work on. */
export type StoredRender = WithPlan<StoredRenderRecord>;
/**
 * A render someone named at a terminal (core/io findNamedRender), its plan there: a stored record, or one of a status
 * Retake never writes (an export refuses it with its status; a review of it starts, as ever).
 */
export type NamedRender = WithPlan<StoredRenderRecord | UnknownStatusRender>;

/**
 * A stored record with its plan as an edit plan — the ONE place a plan read from a disk is given that type. It checks
 * what was always checked: there is a plan, and it is an object; nothing inside it (the plan's inside is the
 * renderer's contract). A record without its plan: refused, naming the member.
 */
export function withPlan<T extends StoredRenderRecord | UnknownStatusRender>(r: T): PlanOf<T> {
  const plan: unknown = r.plan;
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, detail: 'plan' } as PlanOf<T>;
  return { ok: true, value: r as unknown as WithPlan<T> } as PlanOf<T>;
}
/**
 * What withPlan answers: for a record whose plan is there by its type (core CompleteRender, a render someone named:
 * WithStoredPlan) it cannot fail — no caller keeps a branch that never runs; for any other stored record, the plan or
 * the member it lacks.
 */
type PlanOf<T> = [T] extends [{ plan: StoredPlan }] ? { ok: true; value: WithPlan<T> } : { ok: true; value: WithPlan<T> } | { ok: false; detail: 'plan' };
