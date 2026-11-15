/** The draft generator's vocabulary (recording.ts): its context, its output, and the shapes the walk and the later steps share. */
import type { RecordedElement, RecordedEvent, SecretFieldKind } from './recording-events.js';
import type { TargetSpec } from './types/language.js';

/** The value a secret placeholder gets in the draft's `vars` (the warning asks for a showable demo value). */
export const RECORD_SECRET_PLACEHOLDER = 'CHANGE-ME';
/** A pointer target that appeared after a pause at least this long gets a `wait_for` first (ms). */
export const RECORD_WAIT_GAP_MS = 1500;
/** Net scroll (CSS px) below which a scroll is jitter. */
export const RECORD_SCROLL_MIN_PX = 120;
/** A write is attributed to the last action (its note) when it follows it within this time (ms); later ones are ambient. */
export const RECORD_WRITE_WINDOW_MS = 2000;
/** A navigation that follows an action within this time (ms) was caused by it (a redirect, a history move by script). */
export const RECORD_NAV_WINDOW_MS = 1000;

export interface DraftContext {
  /** The scenario's `video` name (its file name). */
  name: string;
  /** The environment recorded; `env:` is written unless it is the project's default. */
  env: string;
  envIsDefault: boolean;
  /** The environment's pages (key → base URL): `open:` paths are made relative to the page's base path. */
  pages: Record<string, string>;
  /** The persona the window was signed in as (null: signed out). */
  persona: string | null;
  /** The persona each page key is signed in as by default (null: none). A first scene names `persona:` only when it differs. */
  defaultPersonas?: Record<string, string | null>;
  /** project.yaml `vars`: a secret placeholder never shadows one of them (the draft uses it instead). */
  projectVars?: Record<string, string>;
  /** The environment's access while recording (read-only: writes were stopped or answered by a mock). */
  access: 'read-only' | 'read-write';
}

/** Something to look at in the draft. Messages never quote page text or a typed value (safe for job.json and logs). */
export interface DraftIssue {
  severity: 'error' | 'warning' | 'info';
  code:
    | 'fallback_target'
    | 'unresolved_press'
    | 'secret_field'
    | 'secret_target'
    | 'one_time_code'
    | 'autofill'
    | 'contenteditable'
    | 'fragile_target'
    | 'fake_file'
    | 'file_cancelled'
    | 'signed_out'
    | 'foreign_page'
    | 'dropped'
    | 'new_page'
    | 'opened_by_address'
    | 'page_changed'
    | 'max_duration'
    | 'middle_click'
    | 'ambient_write'
    | 'template_text'
    | 'secret_path'
    | 'not_saved'
    | 'invalid'
    | 'hidden_text'
    // Studio annotations
    | 'insert_replaced'
    | 'insert_moved'
    | 'insert_unplaced'
    | 'insert_wait_idle';
  message: string;
  /**
   * Where it applies: the scene id and the 0-based index of the step it is about — or, for something that happened
   * between steps (a dropped action, a page change, a write no step caused), of the step that came next (the scene's
   * step count at its end). Absent only for the draft as a whole.
   */
  scene?: string;
  step?: number;
}

/** A write the window sent while recording, and the step that caused it (null: ambient, not caused by an action). */
export interface DraftWrite {
  /** `POST shop:/api/quotes`, `POST api.example.com/orders` (page text through the secret memory: untrusted). */
  label: string;
  outcome: 'blocked' | 'mocked' | 'allowed' | 'passed' | 'exempt';
  scene: string | null;
  step: number | null;
}

export interface RecordingDraft {
  /** The scenario value (what `yaml` holds). */
  scenario: Record<string, unknown>;
  yaml: string;
  issues: DraftIssue[];
  /** Every write the window sent (any host), in order. */
  writes: DraftWrite[];
  /**
   * The first step followed by a write that went through (any host; not one the guard stopped or mocked) — however
   * long after it: the check replay stops before it, so nothing is written twice.
   */
  firstWrite: { scene: string; step: number } | null;
  stats: {
    scenes: number;
    steps: number;
    /** Presses, typing, keys, selects and files that became (part of) a step. */
    actions: number;
    /** Presses on nothing interactive, dropped. */
    noise: number;
    /** Typing in secret fields (placeholders). */
    secrets: number;
    /** Steps on a target the recorder could not verify. */
    fallbacks: number;
  };
  /** Where each step of the draft came from, in draft order (scene by scene). */
  sources: DraftSource[];
  /** Caption / mark / camera inserts waiting for the next action (the recording goes on): not in the draft yet. */
  pending: string[];
  /** The draft's secret placeholders (never a value). */
  placeholders: DraftPlaceholder[];
}

/**
 * The events a draft step came from. `action`: a recorded action (with the events folded into it); `helper`: a
 * `wait_for` or `scroll` the generator put before that action; `insert`: a hold or wait_for the person inserted.
 */
export interface DraftSource {
  scene: string;
  /** 0-based index in the scene. */
  step: number;
  /** The first and last event seq the step came from (an insert: its position, twice). */
  seqs: [number, number];
  role: 'action' | 'helper' | 'insert';
  /** A helper row's kind: the recorder's `wait_for` before its action, or its `scroll` to it. */
  helper?: 'wait' | 'scroll';
  /**
   * The row's identity, stable while the draft regenerates: `a<first seq>` an action, `w<seq>` the
   * recorder's wait before the action at that event, `s<first seq>` its scroll, `i:<id>` an insert. The Record screen
   * keys its cursor by it, never by the row's index.
   */
  row: string;
  /** The events whose recorded target is the step's main target (click, double_click, type into, select combobox, drop_file zone). */
  target_seqs?: number[];
  /** Where the person picks an alternative for this step: the latest of `target_seqs` whose element has one. */
  target_seq?: number;
  /** The choice in effect (the latest of `target_seqs` that has one; index 0 = the recorder's suggestion). */
  chosen?: { seq: number; index: number };
  /** An inserted step's insert id. */
  insert?: string;
  /** The caption / mark / camera inserts applied to this step. */
  modifiers?: string[];
}

/** A secret placeholder of the draft: `{{vars.<name>}}`. */
export interface DraftPlaceholder {
  name: string;
  kind: SecretFieldKind;
  /** project.yaml's vars has a value of that name: the draft uses it (no CHANGE-ME var). */
  project_var: boolean;
  scene: string;
  step: number;
}

export type Step = Record<string, unknown>;
export type El = RecordedElement;
export type Ev = RecordedEvent;
export type EvOf<K extends Ev['kind']> = Extract<Ev, { kind: K }>;

export interface DraftScene {
  page: string;
  open?: string;
  /** The path the scene starts on (its id). */
  path: string;
  /** The seq of the event the scene starts at (the scene an insert goes to when no action follows it). */
  seq: number;
  /** `tw`: the times a merged typing step was committed (each a time a write may follow it; default [t1]). */
  steps: Array<{ step: Step; t0: number; t1: number; tw?: number[] }>;
}

/** Where a draft step came from (DraftSource, while building). */
export interface StepMeta {
  seqs: [number, number];
  role: 'action' | 'helper' | 'insert';
  /** A helper's action. */
  group?: Step;
  /** The main target as built from the recorded targets (fold and merge decisions compare these). */
  target?: TargetSpec;
  /** The events whose `el.target` gave `target` (only where the step's main target is that element's target). */
  targetSeqs?: number[];
  /** Where `target` is written in the step (a pick is substituted there when the draft is emitted). */
  site?: 'click' | 'double_click' | 'type' | 'select' | 'drop_file';
  /** A type step that may take the next typing on the same field (a Studio visit committed it): the type event's stream index. */
  typeIdx?: number;
  /** A secret type step's kind (a split secret typing on the same field stays one placeholder). */
  secretKind?: string;
  /** The picked target written instead of `target`. */
  emitted?: TargetSpec;
  chosen?: { seq: number; index: number };
  insert?: string;
  modifiers?: string[];
}

export type Raw = Omit<DraftIssue, 'scene' | 'step'>;

/**
 * An issue in the order raised (`t`), located once scene ids and step indexes are known: about a step (`step`), or
 * between steps — after `after` in `scene` (null: at its start; no scene yet: the draft's start) — or already located
 * (`at`), or about the whole draft.
 */
export interface Raised {
  issue: Raw;
  t: number;
  step?: Step;
  scene?: DraftScene | null;
  after?: Step | null;
  at?: { scene: string; step: number };
}

/** A secret field's typing step and its placeholder. */
export interface SecretStep {
  step: Step;
  name: string;
  kind: SecretFieldKind;
  project_var: boolean;
}

/** Scrolling not yet written as a step (it goes before the next action, when it moved far enough). */
export interface PendingScroll {
  dy: number;
  dx: number;
  container: 'document' | 'element';
  el: El | null;
  seqs: [number, number];
}

/** What the event walk made, which the later steps read and change. */
export interface Walked {
  readonly scenes: DraftScene[];
  readonly meta: Map<Step, StepMeta>;
  readonly secretSteps: SecretStep[];
  readonly stats: RecordingDraft['stats'];
  readonly vars: Record<string, string>;
  readonly raised: Raised[];
}

/** The kept scenes, their unique ids, and where each step is in the draft. */
export interface KeptScenes {
  scenes: DraftScene[];
  ids: string[];
  where: Map<Step, { scene: string; step: number }>;
  /** The scenes before empty ones were dropped (an issue raised in a dropped scene goes to the next kept one). */
  all: DraftScene[];
}
