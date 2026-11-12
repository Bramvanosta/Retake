/** The Record screen's draft as rows, the cursor, and what a recording's body is handed (pure: a test reads them). */
import type { DraftIssue, DraftSource, RecordAnnotationChange, RecordInsert, RecordInsertAt, StepBlock } from '@retake/core';
import type { RecordViewAnswer } from '../../server/record-ops.js';
import { stepWords } from '../scenario-words.js';
import type { MarkState } from '../ui-kit/index.js';
import { insertAnchor } from '../record-words.js';

/** A note's tone as a mark. */
export const TONE_MARK: Record<'info' | 'warning' | 'danger', MarkState> = { info: 'idle', warning: 'warn', danger: 'fail' };

/**
 * Where the next insert goes: after the newest event (the default; it follows new actions), or right after one row —
 * by the row's identity (DraftSource.row), never its index: the line stays on that row while the draft regenerates.
 * The row the cursor is after is the selected row (its alternatives, the inspector's step).
 */
export type Cursor = { at: 'end' } | { at: 'after'; row: string };

type Untrusted = NonNullable<RecordViewAnswer['untrusted']>;
type Alt = Untrusted['alternatives'][number];

/** The rows of the draft, scene by scene: each step with where it came from and its alternatives. */
export interface DraftRow {
  key: string;
  /** The row's identity (its source's `row`; its key when it has no source). */
  id: string;
  scene: string;
  step: StepBlock;
  source?: DraftSource;
  alt?: Alt;
  insert?: RecordInsert;
  modifiers: RecordInsert[];
}

export function draftRows(u: Untrusted): Array<{ scene: string; page?: string; open?: string; rows: DraftRow[] }> {
  const inserts = new Map(u.inserts.map((i) => [i.id, i]));
  const sources = new Map(u.sources.map((s) => [`${s.scene}\u0000${s.step}`, s]));
  const alts = new Map(u.alternatives.map((a) => [`${a.scene}\u0000${a.step}`, a]));
  const out: Array<{ scene: string; page?: string; open?: string; rows: DraftRow[] }> = [];
  for (const e of u.blocks.entries) {
    if (e.type !== 'scene') continue;
    out.push({
      scene: e.id,
      ...(e.page !== undefined ? { page: e.page } : {}),
      ...(e.open !== undefined ? { open: e.open } : {}),
      rows: e.steps.map((step) => {
        const k = `${e.id}\u0000${step.index}`;
        const source = sources.get(k);
        const insert = source?.insert !== undefined ? inserts.get(source.insert) : undefined;
        const alt = alts.get(k);
        return {
          key: step.key,
          id: source?.row ?? step.key,
          scene: e.id,
          step,
          ...(source ? { source } : {}),
          ...(alt ? { alt } : {}),
          ...(insert ? { insert } : {}),
          modifiers: (source?.modifiers ?? []).flatMap((id) => (inserts.has(id) ? [inserts.get(id)!] : [])),
        };
      }),
    });
  }
  return out;
}

/** The handlers a recording's body calls (the screen sends the ops; a test renders the body with none). */
export interface RecordingActions {
  annotate: (change: RecordAnnotationChange) => void;
  stop: () => void;
  discard: () => void;
  save: (name: string) => void;
  onSignedIn: () => void;
  /** Open or close the Discard sheet (its answer is the screen's: the palette's Discard… opens it too). */
  confirm: (open: boolean) => void;
}

export interface RecordingUi {
  busy: boolean;
  /** The last action's refusal or result, in words. */
  note: { tone: 'info' | 'warning' | 'danger'; text: string; issues?: DraftIssue[]; fix?: string } | null;
  /** Save's refusal for a taken name. */
  taken: string | null;
  discarding: boolean;
  /** The Discard sheet is open. */
  confirming: boolean;
  now: number;
  /** In the desktop app: the key caps shown (⌘.). */
  inApp?: boolean;
}

/** The row the cursor is on (by its identity), with its words and the anchor an insert there gets; null at the end. */
export function cursorRow(u: Untrusted | null, cursor: Cursor): { label: string; at: RecordInsertAt } | null {
  if (cursor.at !== 'after' || !u) return null;
  for (const s of draftRows(u)) {
    for (const r of s.rows) if (r.source && r.id === cursor.row) return { label: stepWords(s.scene, r.step.index), at: insertAnchor(r.source) };
  }
  return null;
}

/** The selected row itself (the inspector's step), or null. */
export function selectedRow(u: Untrusted | null, cursor: Cursor): { row: DraftRow; scene: { scene: string; page?: string; open?: string } } | null {
  if (cursor.at !== 'after' || !u) return null;
  for (const s of draftRows(u)) for (const r of s.rows) if (r.source && r.id === cursor.row) return { row: r, scene: s };
  return null;
}

/** Which target a row shows as chosen (critique B1 of L4.8: a pick made on an earlier press of the same target is the one in effect). */
export function chosenOf(row: DraftRow): { checked: number; picked: boolean } {
  const alt = row.alt!;
  const earlier = row.source?.chosen !== undefined && row.source.chosen.seq !== alt.seq && row.source.chosen.index > 0;
  const checked = alt.chosen > 0 || !earlier ? alt.chosen : (alt.options.find((o) => o.words === row.step.target)?.index ?? -1);
  return { checked, picked: alt.chosen > 0 || earlier };
}
