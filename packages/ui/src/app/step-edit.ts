/**
 * Step editing on the Blocks tab (L4.3 parts 2–3, R-UI-12): the pure parts — where a drop or an Alt+↑/↓ moves a step,
 * the words of an edit (a form's changes and the palette's new step included), and the undo / redo history. The screen (ScenarioScreen.tsx) sends each edit through
 * `scenario_edit` (the server splices the file and verifies it) and re-reads the view; nothing here builds YAML.
 *
 * - Undo / redo (plan §3.7, critique B5): per screen, in memory, at most 50 entries and 16 MiB of text. Each entry keeps
 *   the file's text before the edit and the hashes before / after; undo sends `restore` of the text before (byte-exact,
 *   the server checks its sha256) on the version the edit made, redo `restore`s the text after on the version before.
 *   A version this screen did not make (Claude, an editor, the YAML view) clears the history.
 */

import type { ScenarioEdit } from './data/scenarios.js';

/** A step as a block edit names it (the scenario_blocks key parts and the step's guard). */
export interface StepRef {
  scene: string;
  index: number;
  guard: string;
}

/** A form field's value (scenario_forms). */
export type FieldValue = string | number | boolean;

/** A block edit (scenario_edit's step edits: a move, a delete, a copy, the inspector's form, the palette's new step). */
export type StepEditOp = Extract<ScenarioEdit, { kind: 'move_step' | 'delete_step' | 'duplicate_step' | 'set_step' | 'insert_step' }>;

/** A scene as moves see it: its id, how many steps it has, whether steps can go in or out. */
export interface SceneSlots {
  id: string;
  count: number;
  locked: boolean;
}

/**
 * Where Alt+↑ (`dir` -1) / Alt+↓ (+1) moves a step: one place within its scene; past its first / last step, to the end
 * of the previous / the start of the next scene that takes steps (cards and interstitials are not scenes). Null: nowhere.
 */
export function keyboardMove(scenes: readonly SceneSlots[], from: { scene: string; index: number }, dir: -1 | 1): { scene: string; index: number } | null {
  const k = scenes.findIndex((s) => s.id === from.scene);
  if (k < 0 || scenes[k].locked) return null;
  const to = from.index + dir;
  if (to >= 0 && to < scenes[k].count) return { scene: from.scene, index: to };
  for (let j = k + dir; j >= 0 && j < scenes.length; j += dir) {
    if (scenes[j].locked) continue;
    return { scene: scenes[j].id, index: dir < 0 ? scenes[j].count : 0 };
  }
  return null;
}

/**
 * The move a drop makes: `gap` is the place between rows of the destination scene as it is on screen (0 = above its
 * first step, count = below its last). In the step's own scene the index is counted without it. Null: no move.
 */
export function dropMove(from: { scene: string; index: number }, gap: { scene: string; index: number }): { scene: string; index: number } | null {
  if (gap.scene !== from.scene) return { scene: gap.scene, index: gap.index };
  const to = gap.index > from.index ? gap.index - 1 : gap.index;
  return to === from.index ? null : { scene: from.scene, index: to };
}

/** An edit in words before it is made (the conflict banner: "your edit … was not applied"). */
export function editWords(e: StepEditOp): string {
  switch (e.kind) {
    case 'move_step':
      return e.to.scene === e.from.scene
        ? `Move step ${e.from.index + 1} of ${e.from.scene} to position ${e.to.index + 1}`
        : `Move step ${e.from.index + 1} of ${e.from.scene} to position ${e.to.index + 1} of ${e.to.scene}`;
    case 'delete_step':
      return `Delete step ${e.at.index + 1} of ${e.at.scene}`;
    case 'duplicate_step':
      return `Duplicate step ${e.at.index + 1} of ${e.at.scene}`;
    case 'set_step':
      return `Change ${e.changes.map((c) => c.path.join(' ').replace(/_/g, ' ')).join(', ')} of step ${e.at.index + 1} of ${e.at.scene}`;
    case 'insert_step':
      return `Add a ${e.action.replace(/_/g, ' ')} step at position ${e.to.index + 1} of ${e.to.scene}`;
  }
}

export interface HistoryEntry {
  /** What the edit did ("Moved step 3 of request to position 1"). */
  label: string;
  /** The file's text before it, and its hash. */
  before: string;
  hashBefore: string;
  /** The file's text after it (known once undone: what redo restores), and its hash. */
  after: string | null;
  hashAfter: string;
}

export const HISTORY_MAX_ENTRIES = 50;
export const HISTORY_MAX_CHARS = 16 * 1024 * 1024;

/** The undo / redo stacks of one screen, and the versions it made (a version it did not make clears them). */
export class EditHistory {
  undo: HistoryEntry[] = [];
  redo: HistoryEntry[] = [];
  private readonly made = new Set<string>();

  /** A version this screen wrote (or first read). */
  know(hash: string): void {
    this.made.add(hash);
  }

  /** Whether this screen made (or first read) that version. */
  knows(hash: string): boolean {
    return this.made.has(hash);
  }

  /** A new edit: on the undo stack, the redo stack emptied, the oldest dropped past the caps. */
  push(e: HistoryEntry): void {
    this.made.add(e.hashAfter);
    this.undo.push(e);
    this.redo = [];
    this.trim();
  }

  /** Undo done: the entry moves to the redo stack with the text it undid. */
  undone(after: string): void {
    const e = this.undo.pop();
    if (e) this.redo.push({ ...e, after });
    this.trim();
  }

  /** Redo done: the entry moves back to the undo stack. */
  redone(): void {
    const e = this.redo.pop();
    if (e) this.undo.push(e);
  }

  clear(): void {
    this.undo = [];
    this.redo = [];
  }

  get size(): number {
    return this.undo.length + this.redo.length;
  }

  private trim(): void {
    const chars = () => [...this.undo, ...this.redo].reduce((n, e) => n + e.before.length + (e.after?.length ?? 0), 0);
    while (this.undo.length + this.redo.length > HISTORY_MAX_ENTRIES || (this.undo.length + this.redo.length > 1 && chars() > HISTORY_MAX_CHARS)) {
      if (this.undo.length) this.undo.shift();
      else this.redo.shift();
    }
  }
}

/** Whether a key event's target is a field (undo / redo shortcuts then stay the field's own). */
export function inField(t: EventTarget | null): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null;
  return !!el && (el.isContentEditable === true || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}
