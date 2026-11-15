/** The blocks a scenario is read as (blocks.ts): the video header, the hooks, the entries and their steps. */
import type { DestructiveOptions } from './destructive.js';
import type { ValidationIssue } from './issues.js';
import type { StepFormValues } from './step-forms.js';
import type { ActionName } from './types/language.js';
import type { HookKind } from './types/hooks.js';

// ── Model ───────────────────────────────────────────────────────────────────

/** Where a block is in the text: 1-based lines, 0-based character offsets `[start, end)` of its node. */
export interface SourceRange {
  line: number;
  end_line: number;
  start: number;
  end: number;
}

/** The badge of a step (R-UI-09): what kind of action it is. */
export const STEP_CATEGORIES = [
  'navigation',
  'click',
  'hover',
  'type',
  'select',
  'pick',
  'menu',
  'scroll',
  'drag',
  'drop_file',
  'wait',
  'hold',
  'check',
  'script',
  'cursor',
  'download',
  'hook',
] as const;
export type StepCategory = (typeof STEP_CATEGORIES)[number];

/** The modifier chips of a step (R-UI-10). */
export const CHIP_KINDS = ['zoom', 'hold', 'mark', 'caption', 'speed', 'irreversible', 'optional', 'park', 'overlay', 'tutorial', 'page', 'timeout'] as const;
export type ChipKind = (typeof CHIP_KINDS)[number];

/** A chip: its kind and its words (a chip is never only a colour). */
export interface Chip {
  kind: ChipKind;
  label: string;
}

export interface StepBlock {
  /** "<scene id>.<index>": the step's key in a run's timeline. */
  key: string;
  index: number;
  id?: string;
  /** Absent: not a step with exactly one action (`unknown`). */
  action?: ActionName;
  category: StepCategory | 'unknown';
  /** The action in words ("double click", "wait for"), or why the step cannot be read. */
  label: string;
  /** What it acts on, in plain words (core plainTarget). */
  target?: string;
  /** What else matters, in one line: the text typed, the key, the option, the URL, the seconds, the file. */
  summary?: string;
  /** The action's arguments in object form (core normalizeStep), URLs without `user:password@`. */
  args?: unknown;
  chips: Chip[];
  /** core stepFingerprint (action + arguments). */
  fingerprint?: string;
  /** Picture identity (core step-match: fingerprint + `on:` + the scene's context). */
  picture?: string;
  /** Earlier steps of the scene with the same picture identity. */
  occurrence: number;
  range?: SourceRange;
  /** The comment lines just above it, without `#`. */
  comment?: string;
  /** Written as a YAML alias (`- *x`): its range is the alias's, and the editor never edits through it. */
  aliased?: true;
  /** core stepGuard of the step as written (modifiers included): what a block edit names it by. */
  guard?: string;
  /** Why the Blocks tab cannot move, delete or duplicate it (an alias, a flow list of steps): edited in the YAML view. */
  locked?: string;
  /**
   * Its values for the inspector's form (step-forms.ts): object form, a URL with a password never shown;
   * absent for a step a form does not edit (not one action, `eval` / `emit` / `cursor`).
   */
  form?: StepFormValues;
  issues: ValidationIssue[];
}

/** A user file shown instead of a component. */
export interface MediaFileRef {
  kind: 'video' | 'image' | 'lottie';
  path: string;
}

export interface ScenePageBlock {
  id: string;
  page?: string;
  open?: string;
  viewport?: string;
  label?: string;
  persona?: string;
}

export interface SceneBlock {
  type: 'scene';
  /** Index among the scenario's entries (scenes, cards, interstitials). */
  index: number;
  id: string;
  /** The environment page: its own `page`, else the previous scene's (`page_inherited`); absent: the environment's first. */
  page?: string;
  page_inherited?: true;
  /** Multi-page scenes: the pages filmed at the same time. */
  pages?: ScenePageBlock[];
  /** Path or URL opened at the start. */
  open?: string;
  /** Opens nothing: continues from the previous scene's state. */
  continues: boolean;
  persona?: string;
  caption?: { kicker?: string; text: string };
  speed?: number;
  still?: number;
  cursor?: string;
  transition?: string;
  frame?: string;
  tutorial?: string;
  irreversible?: true;
  skip?: true;
  /** Played during the take, left out of the video. */
  offscreen?: true;
  note?: string;
  /** Hash of the scene's page, open, pages and persona (core step-match). */
  context: string;
  steps: StepBlock[];
  /** Why no step can be moved into or out of it (its steps written as an alias or a flow list). */
  steps_locked?: string;
  comment?: string;
  range?: SourceRange;
  aliased?: true;
  issues: ValidationIssue[];
}

export interface CardBlock {
  type: 'card';
  index: number;
  /** Its `id`, else "card-<index>". */
  id: string;
  component?: string;
  slots?: Record<string, string>;
  params?: unknown;
  file?: MediaFileRef;
  /** Seconds; absent: the component's (or the file's) own. */
  duration?: number;
  transition?: string;
  comment?: string;
  range?: SourceRange;
  aliased?: true;
  issues: ValidationIssue[];
}

export interface InterstitialBlock {
  type: 'interstitial';
  index: number;
  /** Its `id`, else "interstitial-<index>". */
  id: string;
  text?: string;
  kicker?: string;
  duration?: number;
  component?: string;
  file?: MediaFileRef;
  comment?: string;
  range?: SourceRange;
  aliased?: true;
  issues: ValidationIssue[];
}

/** An entry that is neither a scene (with a string id), a card nor an interstitial. */
export interface UnknownEntryBlock {
  type: 'unknown';
  index: number;
  comment?: string;
  range?: SourceRange;
  aliased?: true;
  issues: ValidationIssue[];
}

export type EntryBlock = SceneBlock | CardBlock | InterstitialBlock | UnknownEntryBlock;

export interface HookFlag {
  kind: 'destructive' | 'rollback' | 'confirm' | 'optional' | 'reads_only';
  label: string;
}

export interface HookBlock {
  /** `step`: an entry of the named hooks (`hooks:`) a `hook: <name>` step runs during the take. */
  phase: 'setup' | 'teardown' | 'step';
  index: number;
  /** A named hook's name (phase `step`). */
  hook?: string;
  /** Absent: not a hook the file format knows. */
  kind?: HookKind;
  name?: string;
  /** One line: http method + URL; sql file or first line; the shell command's first line; js file or first line. */
  summary: string;
  /** Its rollback in one line. */
  rollback?: string;
  /** Why work an agent submits (the MCP server, the Studio) needs a person to approve it first (core hookApprovalReason). */
  needs_person?: string;
  flags: HookFlag[];
  comment?: string;
  range?: SourceRange;
  aliased?: true;
  issues: ValidationIssue[];
}

/** The intro or the outro: the theme's, none, or overridden. */
export type EndCardBlock = { mode: 'theme' } | { mode: 'off' } | { mode: 'custom'; component?: string; file?: MediaFileRef; duration?: number; tagline?: string; url?: string };

export interface VideoBlock {
  /** `video:`. */
  name?: string;
  title?: { kicker?: string; text?: string };
  env?: string;
  template?: string;
  frame?: string;
  intro: EndCardBlock;
  outro: EndCardBlock;
  music?: { file?: string; volume?: number; duck?: number; loop?: boolean };
  tutorial?: string;
  /** "off", or the instant as written (+ " (frozen)"). */
  clock?: string;
  capture?: { width?: number; height?: number; fps?: number; scale?: number; keep_frames?: boolean };
  /** Pacing keys the scenario overrides. */
  pacing?: string[];
  /** Names of its `vars` (values are shown in the YAML, not here). */
  vars?: string[];
  /** How many mocks it declares. */
  mocks?: number;
  /** The comment at the top of the file, as a person reads it (topCommentWords: no editor directive, paragraphs). */
  comment?: string;
  /** The lines of that comment in the file, as written (what the editor edits). */
  comment_lines?: { line: number; end_line: number };
}

export interface ScenarioBlocks {
  /** false: the YAML does not parse — no blocks; `issues` say why and the text still shows. */
  parsed: boolean;
  video: VideoBlock;
  hooks: { setup: HookBlock[]; teardown: HookBlock[]; named: HookBlock[] };
  entries: EntryBlock[];
  /** Steps of the capture scenes (skipped ones included). */
  step_count: number;
  /** Issues no block holds (the file, the video keys). Every issue is in exactly one place. */
  issues: ValidationIssue[];
}

export interface ScenarioBlocksOptions {
  /**
   * The text's validation issues (the engine's project-aware validation). Absent: the text is validated here without a
   * project (core parseScenario: syntax, schema, project-free checks).
   */
  issues?: readonly ValidationIssue[];
  /** Lets the hooks strip read the project's SQL files to tell destructive ones (core destructiveReason). */
  hookFiles?: DestructiveOptions;
}
