/** The step edits' vocabulary (step-edits.ts): where a step is, the edits, what one gives, its error and its guard. */
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import type { FormValue } from './step-forms.js';
import type { ActionName } from './types/language.js';

/** Where a step is: its scene's id, its index in that scene, and its guard (stepGuard of the step the client showed). */
export interface StepAt {
  scene: string;
  index: number;
  guard: string;
}

/**
 * One field of a step changed (a patch, never the whole step): `path` is the field's key in object form
 * (step-forms.ts: "type.text", "click.in", "caption.text", "hold"); `from` the value the form showed (absent: none),
 * `to` the new one (absent: removed). Applied only while the step still holds `from` there — a field changed meanwhile
 * is never reverted.
 */
export interface FieldChange {
  path: string[];
  from?: FormValue;
  to?: FormValue;
}

export type StepEdit =
  /** `to.index`: the step's index in the destination scene once moved (in its own scene: counted without it). */
  | { kind: 'move_step'; from: StepAt; to: { scene: string; index: number } }
  | { kind: 'delete_step'; at: StepAt }
  | { kind: 'duplicate_step'; at: StepAt }
  /** Change fields of a step (the inspector's form). */
  | { kind: 'set_step'; at: StepAt; changes: FieldChange[] }
  /**
   * Add a step (the palette): `action` with its form `values`, at `to.index` of `to.scene`; `after` is the guard of the
   * step just before that place as the client showed it (null at the start of the scene).
   */
  | { kind: 'insert_step'; to: { scene: string; index: number }; after: string | null; action: ActionName; values: Record<string, FormValue> };

export const STEP_EDIT_KINDS = ['move_step', 'delete_step', 'duplicate_step', 'set_step', 'insert_step'] as const;

export interface StepEditApplied {
  text: string;
  /** The value the text must parse to (the edit applied to the parsed file): what the engine verifies. */
  intended: unknown;
  /** "Moved step 3 of request to position 1". */
  label: string;
  /** The step to select after the edit ("<scene>.<index>"), or null. */
  select: string | null;
  notices: string[];
}

/** Why a step edit cannot be made: `stale` (the file no longer has that step there), `not_editable`, `invalid`. */
export class StepEditError extends Error {
  constructor(
    readonly code: 'stale' | 'not_editable' | 'invalid',
    message: string,
    /** The form field it is about ("type.cps"), when it is about one. */
    readonly field?: string,
  ) {
    super(message);
    this.name = 'StepEditError';
  }
}

/** A step's guard: the first 16 hex characters of the sha256 of its canonical JSON as written. */
export function stepGuard(raw: unknown): string {
  return createHash('sha256').update(canonicalJson(raw)).digest('hex').slice(0, 16);
}

/** The actions whose `as` names a capture that must be unique (checks/scenario: a duplicate is an error). */
export const CAPTURE_AS: Record<string, string> = { capture_text: 'text', download: 'document', wait_for_email: 'email' };
