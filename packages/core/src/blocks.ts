/**
 * A scenario read as blocks (L4.2, R-UI-08..10, R-UI-14): the video header, the setup / teardown hooks, the scenes
 * with their steps, the cards and the interstitials, in file order — what the Studio's scenario screen shows, and what
 * L4.3's two-way editor will edit (each block keeps its source range and the comment above it).
 *
 * Pure and tolerant: `scenarioBlocks` never throws. A YAML syntax error gives no blocks (the issues and the text still
 * show); an entry or a step it cannot read becomes an `unknown` block carrying the issues whose path points into it.
 * Every string is as written in the file — a templated `{{shop}}` or `{{env:…}}` stays a reference, never resolved, so
 * no secret value can reach a block —, except that a URL's `user:password@` is left out of what is shown. Values come
 * from core parseYaml (aliases bounded by `maxAliasCount`, a recursive alias refused); the walker never resolves an
 * alias itself: a block written as an alias (`- *step`) is `aliased`, carries the alias's range and no comment, and is
 * never edited through (L4.3).
 */
import { isAlias, isMap, isScalar, isSeq } from 'yaml';
import type { Node } from 'yaml';
import type { DestructiveOptions } from './destructive.js';
import { destructiveReason, hookApprovalReason, hookKind, sqlSource } from './destructive.js';
import type { IssuePath } from './issues.js';
import { scenePageEntries } from './pages.js';
import { stepGuard, stepsDashWhy, stepsLockedWhy } from './step-edits.js';
import { stepFormValues } from './step-forms.js';
import type { StepFormValues } from './step-forms.js';
import { parseScenario } from './scenario.js';
import { isSceneValue, scenarioIdentityOfValue } from './step-match.js';
import type { SceneIdentity } from './step-match.js';
import { normalizeStep, stepActionKeys } from './steps.js';
import { pickTarget, plainTarget } from './targets.js';
import type { ActionName, HookKind, HookStep, ScenePages, ValidationIssue } from './types.js';
import { parseYaml } from './validation/yaml-source.js';
import type { YamlSource } from './validation/yaml-source.js';

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
  /** Written as a YAML alias (`- *x`): its range is the alias's, and L4.3 never edits through it. */
  aliased?: true;
  /** core stepGuard of the step as written (modifiers included): what a block edit names it by (L4.3, critique B2). */
  guard?: string;
  /** Why the Blocks tab cannot move, delete or duplicate it (an alias, a flow list of steps): edited in the YAML view. */
  locked?: string;
  /**
   * Its values for the inspector's form (L4.3 part 3, step-forms.ts): object form, a URL with a password never shown;
   * absent for a step a form does not edit (not one action, `eval` / `emit` / `cursor`).
   */
  form?: StepFormValues;
  issues: ValidationIssue[];
}

/** A user file shown instead of a component (L2.12). */
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
  /** Multi-page scenes (L2.11): the pages filmed at the same time. */
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
  /** Played during the take, left out of the video (L5.8). */
  offscreen?: true;
  note?: string;
  /** Hash of the scene's page, open, pages and persona (core step-match). */
  context: string;
  steps: StepBlock[];
  /** Why no step can be moved into or out of it (its steps written as an alias or a flow list), L4.3. */
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
  /** `step`: an entry of the named hooks (`hooks:`) a `hook: <name>` step runs during the take (L5.8). */
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
export type EndCardBlock =
  | { mode: 'theme' }
  | { mode: 'off' }
  | { mode: 'custom'; component?: string; file?: MediaFileRef; duration?: number; tagline?: string; url?: string };

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
  /** The lines of that comment in the file, as written (what L4.3's editor edits). */
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

// ── Words ───────────────────────────────────────────────────────────────────

/** The badge of an action (R-UI-09). Exhaustive: a new action fails the build until it has one. */
export function actionCategory(action: ActionName): StepCategory {
  switch (action) {
    case 'open':
    case 'new_tab':
    case 'switch_page':
      return 'navigation';
    case 'click':
    case 'double_click':
      return 'click';
    case 'hover':
      return 'hover';
    case 'type':
    case 'press':
    case 'date':
      return 'type';
    case 'select':
      return 'select';
    case 'pick':
      return 'pick';
    case 'menu':
      return 'menu';
    case 'scroll':
      return 'scroll';
    case 'drag':
      return 'drag';
    case 'drop_file':
      return 'drop_file';
    case 'wait':
    case 'wait_for':
    case 'wait_for_email':
      return 'wait';
    case 'hold':
      return 'hold';
    case 'assert':
    case 'screenshot':
    case 'capture_text':
      return 'check';
    case 'eval':
    case 'emit':
    case 'notify':
      return 'script';
    case 'cursor':
      return 'cursor';
    case 'download':
      return 'download';
    case 'hook':
      return 'hook';
    default: {
      const unknown: never = action;
      return unknown;
    }
  }
}

/** "double_click" → "double click". */
export function actionLabel(action: ActionName): string {
  return action.replace(/_/g, ' ');
}

/**
 * A URL's `user:password@` (or `user@`) left out, wherever URLs appear in a text — up to the authority's LAST `@` (a
 * password may hold one: `https://u:p@ss@host/` → `https://host/`, review A #5).
 */
export function stripUrlUserinfo(s: string): string {
  return s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1');
}

/** Every string of a value with stripUrlUserinfo (arrays and objects copied). */
function stripDeep(v: unknown): unknown {
  if (typeof v === 'string') return stripUrlUserinfo(v);
  if (Array.isArray(v)) return v.map(stripDeep);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripDeep(x)]));
  return v;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const q = (s: string) => `“${s}”`;

/** The first line of a text, at most `max` characters (… when cut). */
function oneLine(s: string, max = 160): string {
  const first = s.replace(/^\s*\n/, '').split('\n')[0].trim();
  const cut = first.length > max ? `${first.slice(0, max - 1)}…` : first;
  return s.trim().includes('\n') && cut === first ? `${cut} …` : cut;
}

function shorten(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function seconds(n: number): string {
  return `${n} s`;
}

function captionOf(v: unknown): { kicker?: string; text: string } | undefined {
  if (typeof v === 'string') return { text: v };
  if (isObj(v) && typeof v.text === 'string') return { ...(typeof v.kicker === 'string' ? { kicker: v.kicker } : {}), text: v.text };
  return undefined;
}

/** A tutorial switch in words: "on", "off", "spotlight off, steps on". */
function tutorialWords(v: unknown): string | undefined {
  if (v === true) return 'on';
  if (v === false) return 'off';
  if (!isObj(v)) return undefined;
  const parts = Object.entries(v).map(([k, x]) => `${k} ${x === false ? 'off' : x === true ? 'on' : typeof x === 'string' ? x : 'custom'}`);
  return parts.length ? parts.join(', ') : undefined;
}

/** A transition in words: its kind or its component id. */
function transitionWords(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (isObj(v) && typeof v.component === 'string') return v.component;
  return undefined;
}

function mediaFile(v: Record<string, unknown>): MediaFileRef | undefined {
  for (const kind of ['video', 'image', 'lottie'] as const) if (typeof v[kind] === 'string') return { kind, path: v[kind] as string };
  return undefined;
}

/** The modifier chips of a raw step (R-UI-10); `sceneIrreversible`: its scene is irreversible. */
export function stepChips(step: unknown, o: { sceneIrreversible?: boolean } = {}): Chip[] {
  if (!isObj(step)) return [];
  const chips: Chip[] = [];
  const holdIsAction = stepActionKeys(step).includes('hold');
  const camera = step.camera;
  if (isObj(camera) && num(camera.zoom) !== undefined) chips.push({ kind: 'zoom', label: `zoom ×${camera.zoom}` });
  if (!holdIsAction && num(step.hold) !== undefined) chips.push({ kind: 'hold', label: `hold ${seconds(step.hold as number)}` });
  if (str(step.mark) !== undefined) chips.push({ kind: 'mark', label: `mark ${step.mark}` });
  const caption = captionOf(step.caption);
  if (caption) chips.push({ kind: 'caption', label: `caption ${q(shorten(caption.kicker ?? caption.text, 40))}` });
  if (num(step.speed) !== undefined) chips.push({ kind: 'speed', label: `speed ×${step.speed}` });
  if (step.irreversible === true) chips.push({ kind: 'irreversible', label: 'irreversible' });
  else if (o.sceneIrreversible) chips.push({ kind: 'irreversible', label: 'irreversible (scene)' });
  if (step.optional === true) chips.push({ kind: 'optional', label: 'optional' });
  if (step.park === true) chips.push({ kind: 'park', label: 'park' });
  else if (num(step.park) !== undefined) chips.push({ kind: 'park', label: `park ${seconds(step.park as number)}` });
  if (isObj(step.overlay)) {
    const file = mediaFile(step.overlay);
    const what = str(step.overlay.component) ?? (file ? `${file.kind} file` : undefined);
    chips.push({ kind: 'overlay', label: what ? `overlay ${what}` : 'overlay' });
  }
  const tutorial = tutorialWords(step.tutorial);
  if (tutorial) chips.push({ kind: 'tutorial', label: `tutorial ${tutorial}` });
  if (str(step.on) !== undefined) chips.push({ kind: 'page', label: `on ${step.on}` });
  if (num(step.timeout) !== undefined) chips.push({ kind: 'timeout', label: `timeout ${seconds(step.timeout as number)}` });
  return chips;
}

/** A field named by its label or given as a target, in plain words. */
function fieldWords(v: unknown): string | undefined {
  if (typeof v === 'string') return `field ${q(v)}`;
  if (isObj(v)) return plainTarget(v);
  return undefined;
}

/** What a wait_for / assert waits for or checks, in one line (its `target` / `gone` is the block's target). */
function conditionWords(a: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  if (str(a.text) !== undefined) parts.push(`text ${q(a.text as string)}`);
  if (str(a.not_text) !== undefined) parts.push(`text ${q(a.not_text as string)} gone`);
  if (a.target !== undefined && a.gone !== undefined) parts.push(`${plainTarget(a.gone)} gone`);
  else if (a.gone !== undefined) parts.push('gone');
  if (str(a.url) !== undefined) parts.push(`URL ${a.url}`);
  if (str(a.title) !== undefined) parts.push(`title ${q(a.title as string)}`);
  if (isObj(a.count)) parts.push(`${String(a.count.equals)} × ${plainTarget(a.count.target)}`);
  if (a.network_idle === true) parts.push('network idle');
  if (num(a.timeout) !== undefined) parts.push(`up to ${seconds(a.timeout as number)}`);
  return parts.length ? parts.join(', ') : undefined;
}

/** The target in plain words and the one-line summary of a normalised step (tolerant of malformed arguments). */
function describeStep(action: ActionName, args: unknown): { target?: string; summary?: string } {
  const a = isObj(args) ? args : {};
  const join = (...parts: Array<string | undefined | false>) => parts.filter((p): p is string => typeof p === 'string' && p !== '').join(', ') || undefined;
  switch (action) {
    case 'open':
      return { summary: join(str(a.url), str(a.page) && `on page ${a.page}`) };
    case 'click':
    case 'double_click': {
      const mods = Array.isArray(a.modifiers) ? a.modifiers.filter((m): m is string => typeof m === 'string') : [];
      return { target: plainTarget(pickTarget(a)), summary: join(str(a.button) && a.button !== 'left' && `${a.button} button`, mods.length > 0 && `with ${mods.join('+')}`) };
    }
    case 'hover':
      return { target: plainTarget(pickTarget(a)), summary: num(a.ms) !== undefined ? `${a.ms} ms` : undefined };
    case 'type':
      return {
        target: a.into !== undefined ? plainTarget(a.into) : 'the focused field',
        summary: join(str(a.text) !== undefined && q(oneLine(a.text as string)), a.clear === true && 'clears first', a.enter === true && 'then Enter'),
      };
    case 'press':
      return { summary: str(a.key) !== undefined ? `${a.key}${num(a.times) !== undefined && (a.times as number) > 1 ? ` × ${a.times}` : ''}` : undefined };
    case 'select':
      return { target: a.combobox !== undefined ? plainTarget(a.combobox) : fieldWords(a.field), summary: join(str(a.option) !== undefined && `option ${q(a.option as string)}`, str(a.search) !== undefined && `search ${q(a.search as string)}`) };
    case 'pick': {
      const options = typeof a.option === 'string' ? [a.option] : Array.isArray(a.option) ? a.option.filter((o): o is string => typeof o === 'string') : [];
      return {
        target: fieldWords(a.field),
        summary: join(options.length > 0 && `${options.length > 1 ? 'options' : 'option'} ${options.map(q).join(', ')}`, str(a.search) !== undefined && `search ${q(a.search as string)}`),
      };
    }
    case 'menu':
      return {
        target: a.trigger !== undefined ? plainTarget(a.trigger) : typeof a.row === 'string' ? `the row containing ${q(a.row)}` : isObj(a.row) ? plainTarget(a.row) : undefined,
        summary: join(str(a.item) !== undefined && `item ${q(a.item as string)}`, typeof a.confirm === 'string' ? `confirm ${q(a.confirm)}` : a.confirm === true && 'confirm'),
      };
    case 'date': {
      const days = typeof a.day === 'string' ? [a.day] : Array.isArray(a.day) ? a.day.filter((d): d is string => typeof d === 'string') : [];
      return { target: a.field !== undefined ? fieldWords(a.field) : 'the open calendar', summary: days.length ? `${days.length > 1 ? 'days' : 'day'} ${days.map(q).join(' → ')}` : undefined };
    }
    case 'scroll': {
      const to = a.to;
      const target = isObj(to) || (typeof to === 'string' && to !== 'top' && to !== 'bottom') ? plainTarget(to) : undefined;
      const where = typeof to === 'number' ? `to ${to} px` : to === 'top' || to === 'bottom' ? `to the ${to}` : num(a.by) !== undefined ? `by ${a.by} px` : undefined;
      return { target: target !== undefined && a.in !== undefined ? `${target} in ${plainTarget(a.in)}` : target, summary: join(where, num(a.duration) !== undefined && seconds(a.duration as number)) };
    }
    case 'drag':
      return { target: a.from !== undefined ? plainTarget(a.from) : undefined, summary: a.to !== undefined ? `to ${plainTarget(a.to)}` : undefined };
    case 'drop_file': {
      const file = str(a.name) ?? str(a.path);
      return { target: a.zone !== undefined ? plainTarget(a.zone) : undefined, summary: file !== undefined ? `file ${q(file)}${a.fake === true ? ' (placeholder)' : ''}` : undefined };
    }
    case 'wait':
    case 'hold':
      return { summary: num(a.seconds) !== undefined ? seconds(a.seconds as number) : undefined };
    case 'wait_for':
    case 'assert':
      return { target: a.target !== undefined ? plainTarget(a.target) : a.gone !== undefined ? plainTarget(a.gone) : undefined, summary: conditionWords(a) };
    case 'screenshot':
      return { summary: str(a.name) !== undefined ? `${q(a.name as string)}${a.full_page === true ? ', full page' : ''}` : undefined };
    case 'new_tab':
      return { target: a.target !== undefined ? plainTarget(a.target) : undefined, summary: join(str(a.href), str(a.as) && `as ${a.as}`) };
    case 'switch_page':
      return { summary: join(str(a.to) && `to ${a.to}`, a.close_current === true && 'closes the current page') };
    case 'eval':
      return { summary: str(a.file) ?? (str(a.js) !== undefined ? oneLine(a.js as string) : undefined) };
    case 'notify':
      return { summary: str(a.message) !== undefined ? (str(a.title) !== undefined ? `${a.title}: ${a.message}` : (a.message as string)) : undefined };
    case 'emit':
      return { summary: str(a.name) };
    case 'cursor': {
      const mode = str(a.mode);
      if (mode === 'move') return { target: a.to !== undefined ? plainTarget(a.to) : undefined, summary: join('move', num(a.duration) !== undefined && seconds(a.duration as number)) };
      if (mode === 'set') return { target: a.to !== undefined ? plainTarget(a.to) : undefined, summary: 'set (no travel)' };
      return { summary: mode };
    }
    case 'wait_for_email':
      return {
        summary: join(str(a.to) !== undefined && `to ${q(a.to as string)}`, str(a.from) !== undefined && `from ${q(a.from as string)}`, str(a.subject) !== undefined && `subject ${q(a.subject as string)}`, str(a.as) && `as ${a.as}`),
      };
    case 'download':
      return { target: a.click !== undefined ? plainTarget(pickTarget(isObj(a.click) ? a.click : {})) : undefined, summary: str(a.as) && `as ${a.as}` };
    case 'capture_text':
      return { target: a.target !== undefined ? plainTarget(a.target) : undefined, summary: join(str(a.as) && `as ${a.as}`, str(a.pattern) && `pattern ${a.pattern}`) };
    case 'hook':
      return { target: str(a.name) !== undefined ? `hook ${q(a.name as string)}` : undefined, summary: 'off camera: cut from the video' };
    default: {
      const unknown: never = action;
      return unknown;
    }
  }
}

/** A hook's one-line summary and its rollback's (http method + URL, sql file or first line, shell / js first line). */
export function hookSummary(hook: unknown): { kind?: HookKind; summary: string; rollback?: string } {
  if (!isObj(hook)) return { summary: 'not a hook' };
  let kind: HookKind;
  try {
    if (!['http', 'sql', 'shell', 'js'].some((k) => hook[k] !== undefined)) return { summary: 'unknown hook' };
    kind = hookKind(hook as unknown as HookStep);
  } catch {
    return { summary: 'unknown hook' };
  }
  const spec = hook[kind];
  const sqlWords = (v: unknown): string | undefined => {
    if (typeof v !== 'string' && !isObj(v)) return undefined;
    const { file, query } = typeof v === 'string' ? sqlSource(v) : { file: str(v.file), query: str(v.query) };
    return file ?? (query !== undefined ? oneLine(query, 120) : undefined);
  };
  switch (kind) {
    case 'http': {
      if (!isObj(spec)) return { kind, summary: 'http' };
      const rb = isObj(spec.rollback) ? spec.rollback : undefined;
      return {
        kind,
        summary: `${str(spec.method) ?? 'GET'} ${stripUrlUserinfo(str(spec.url) ?? '')}`.trim(),
        ...(rb ? { rollback: `${str(rb.method) ?? 'GET'} ${stripUrlUserinfo(str(rb.url) ?? '')}`.trim() } : {}),
      };
    }
    case 'sql': {
      const own = sqlWords(spec) ?? 'sql';
      const db = isObj(spec) ? str(spec.db) : undefined;
      const rb = isObj(spec) ? sqlWords(spec.rollback) : undefined;
      return { kind, summary: db !== undefined ? `${own} (database ${db})` : own, ...(rb !== undefined ? { rollback: rb } : {}) };
    }
    case 'shell': {
      const run = typeof spec === 'string' ? spec : isObj(spec) ? str(spec.run) : undefined;
      const rb = isObj(spec) ? str(spec.rollback) : undefined;
      return { kind, summary: run !== undefined ? stripUrlUserinfo(oneLine(run, 120)) : 'shell', ...(rb !== undefined ? { rollback: stripUrlUserinfo(oneLine(rb, 120)) } : {}) };
    }
    case 'js': {
      const code = typeof spec === 'string' ? spec : isObj(spec) ? str(spec.code) : undefined;
      const file = isObj(spec) ? str(spec.file) : undefined;
      const page = isObj(spec) ? str(spec.page) : undefined;
      const rb = isObj(spec) ? str(spec.rollback) : undefined;
      const own = file ?? (code !== undefined ? oneLine(code, 120) : 'js');
      return { kind, summary: page !== undefined ? `${own} (on page ${page})` : own, ...(rb !== undefined ? { rollback: oneLine(rb, 120) } : {}) };
    }
  }
}

// ── The YAML nodes behind the values ────────────────────────────────────────

/** A node of the document, or the alias a value was reached through (then everything under it is that alias). */
interface At {
  node?: Node;
  aliased: boolean;
}

function childAt(at: At, key: string | number): At {
  if (at.aliased || !at.node) return at;
  const n = at.node;
  let c: unknown;
  if (isMap(n)) c = n.items.find((p) => isScalar(p.key) && String(p.key.value) === String(key))?.value;
  else if (isSeq(n) && typeof key === 'number') c = n.items[key];
  if (c === null || c === undefined) return { aliased: false };
  return { node: c as Node, aliased: isAlias(c) };
}

/** The parsed document and its text. */
interface Src {
  yaml: YamlSource;
  text: string;
}

/** A node's range, its end moved back over trailing blank space (a block mapping's range runs to the next line). */
function rangeOf(at: At, src: Src): SourceRange | undefined {
  const r = at.node?.range;
  if (!Array.isArray(r)) return undefined;
  const start = r[0];
  let end = r[1];
  while (end > start && /\s/.test(src.text[end - 1] ?? '')) end--;
  const lc = src.yaml.lineCounter;
  return { line: lc.linePos(start).line, end_line: lc.linePos(Math.max(start, end - 1)).line, start, end };
}

/** The comment lines above item `i` of a sequence (the first item's are the sequence's own). */
function commentOf(seq: At, item: At, i: number): string | undefined {
  if (item.aliased) return undefined;
  const own = item.node?.commentBefore ?? (i === 0 && !seq.aliased && isSeq(seq.node) ? seq.node.commentBefore : undefined);
  return typeof own === 'string' && own !== '' ? stripUrlUserinfo(own.split('\n').map((l) => l.replace(/^ /, '')).join('\n')) : undefined;
}

/** An editor's directive line: `yaml-language-server: $schema=…`, an Emacs `-*- … -*-` or a vim / vi / ex modeline. */
const EDITOR_DIRECTIVE = /^\s*(?:yaml-language-server:|.*-\*-.*-\*-|(?:vim?|ex):)/;

/**
 * The file's top comment as a person reads it (review B M5): the editor directives that lead it left out (and one blank
 * line after them), URLs without their `user:password@`, the comment's hard wraps joined into paragraphs (a blank line
 * starts a new one; a line opening a list item keeps its own line). The comment as written stays in the file, at
 * `comment_lines`.
 */
export function topCommentWords(raw: string): string | undefined {
  const lines = raw.split('\n').map((l) => l.replace(/^ /, ''));
  let i = 0;
  while (i < lines.length && EDITOR_DIRECTIVE.test(lines[i])) i++;
  if (i > 0 && i < lines.length && lines[i].trim() === '') i++;
  const paragraphs: string[] = [];
  let cur: string[] = [];
  for (const line of lines.slice(i)) {
    const t = line.trim();
    if (t === '') {
      if (cur.length) paragraphs.push(cur.join(' '));
      cur = [];
    } else if (cur.length && /^(?:[-*•]|\d+[.)])\s/.test(t)) {
      cur[cur.length - 1] += `\n${t}`;
    } else cur.push(t);
  }
  if (cur.length) paragraphs.push(cur.join(' '));
  const text = stripUrlUserinfo(paragraphs.join('\n\n'));
  return text === '' ? undefined : text;
}

// ── scenarioBlocks ──────────────────────────────────────────────────────────

function emptyVideo(): VideoBlock {
  return { intro: { mode: 'theme' }, outro: { mode: 'theme' } };
}

function endCard(v: unknown, outro: boolean): EndCardBlock {
  if (v === false) return { mode: 'off' };
  if (!isObj(v)) return { mode: 'theme' };
  const file = mediaFile(v);
  const out: EndCardBlock = {
    mode: 'custom',
    ...(str(v.component) !== undefined ? { component: v.component as string } : {}),
    ...(file ? { file } : {}),
    ...(num(v.duration) !== undefined ? { duration: v.duration as number } : {}),
    ...(outro && str(v.tagline) !== undefined ? { tagline: v.tagline as string } : {}),
    ...(outro && str(v.url) !== undefined ? { url: stripUrlUserinfo(v.url as string) } : {}),
  };
  return Object.keys(out).length === 1 ? { mode: 'theme' } : out;
}

function videoBlock(sc: Record<string, unknown>, src: Src): VideoBlock {
  const v = emptyVideo();
  if (str(sc.video) !== undefined) v.name = sc.video as string;
  if (isObj(sc.title)) v.title = { ...(str(sc.title.kicker) !== undefined ? { kicker: sc.title.kicker as string } : {}), ...(str(sc.title.text) !== undefined ? { text: sc.title.text as string } : {}) };
  if (str(sc.env) !== undefined) v.env = sc.env as string;
  if (str(sc.template) !== undefined) v.template = sc.template as string;
  if (str(sc.frame) !== undefined) v.frame = sc.frame as string;
  v.intro = endCard(sc.intro, false);
  v.outro = endCard(sc.outro, true);
  if (isObj(sc.music)) {
    const m = sc.music;
    v.music = {
      ...(str(m.file) !== undefined ? { file: m.file as string } : {}),
      ...(num(m.volume) !== undefined ? { volume: m.volume as number } : {}),
      ...(num(m.duck) !== undefined ? { duck: m.duck as number } : {}),
      ...(typeof m.loop === 'boolean' ? { loop: m.loop } : {}),
    };
  }
  const tutorial = tutorialWords(sc.tutorial);
  if (tutorial) v.tutorial = tutorial;
  if (sc.clock === false) v.clock = 'off';
  else if (typeof sc.clock === 'string') v.clock = sc.clock;
  else if (isObj(sc.clock) && str(sc.clock.at) !== undefined) v.clock = `${sc.clock.at}${sc.clock.freeze === true ? ' (frozen)' : ''}`;
  if (isObj(sc.capture)) {
    const c = sc.capture;
    const capture = {
      ...(num(c.width) !== undefined ? { width: c.width as number } : {}),
      ...(num(c.height) !== undefined ? { height: c.height as number } : {}),
      ...(num(c.fps) !== undefined ? { fps: c.fps as number } : {}),
      ...(num(c.scale) !== undefined ? { scale: c.scale as number } : {}),
      ...(typeof c.keep_frames === 'boolean' ? { keep_frames: c.keep_frames } : {}),
    };
    if (Object.keys(capture).length) v.capture = capture;
  }
  if (isObj(sc.pacing) && Object.keys(sc.pacing).length) v.pacing = Object.keys(sc.pacing);
  if (isObj(sc.vars) && Object.keys(sc.vars).length) v.vars = Object.keys(sc.vars);
  if (Array.isArray(sc.mocks)) v.mocks = sc.mocks.length;
  // The file's top comment: the document's own, or (no blank line before the first key) that key's.
  const doc = src.yaml.doc;
  const first = isMap(doc.contents) ? doc.contents.items[0]?.key : undefined;
  const ownTop = typeof doc.commentBefore === 'string' && doc.commentBefore !== '';
  const top = ownTop ? doc.commentBefore : first && typeof first === 'object' ? (first as Node).commentBefore : undefined;
  if (typeof top === 'string' && top !== '') {
    const words = topCommentWords(top);
    if (words !== undefined) v.comment = words;
    // Its lines in the file (L4.3 edits the comment as written): from line 1 to the line before the first key.
    const firstStart = first && typeof first === 'object' ? (first as Node).range?.[0] : undefined;
    const lc = src.yaml.lineCounter;
    const end = firstStart !== undefined ? lc.linePos(firstStart).line - 1 : top.split('\n').length;
    if (end >= 1) v.comment_lines = { line: 1, end_line: end };
  }
  return v;
}

/** The named hooks (`hooks:`, L5.8): each entry of each name, in the file's order, as a block of phase `step`. */
function namedHookBlocks(map: unknown, at: At, src: Src, o: ScenarioBlocksOptions): HookBlock[] {
  if (!isObj(map)) return [];
  return Object.entries(map).flatMap(([name, v]) => {
    const one = childAt(at, name);
    // One entry (not a list): its block has the range of the name's value.
    const range = rangeOf(one, src);
    const blocks = Array.isArray(v) ? hookBlocks('step', v, one, src, o) : hookBlocks('step', [v], { aliased: one.aliased }, src, o).map((b) => ({ ...b, ...(range ? { range } : {}) }));
    return blocks.map((b) => ({ ...b, hook: name, name: b.name ?? name }));
  });
}

function hookBlocks(phase: 'setup' | 'teardown' | 'step', list: unknown, seq: At, src: Src, o: ScenarioBlocksOptions): HookBlock[] {
  if (!Array.isArray(list)) return [];
  return list.map((hook, index) => {
    const at = childAt(seq, index);
    const { kind, summary, rollback } = hookSummary(hook);
    const h = isObj(hook) ? hook : {};
    const flags: HookFlag[] = [];
    let destructive: string | null = null;
    try {
      destructive = kind ? destructiveReason(hook as HookStep, o.hookFiles ?? {}) : null;
    } catch {
      /* malformed: validation reports it */
    }
    if (destructive) flags.push({ kind: 'destructive', label: `destructive: ${destructive}` });
    if (rollback !== undefined) flags.push({ kind: 'rollback', label: 'with rollback' });
    if (h.confirm === true) flags.push({ kind: 'confirm', label: 'confirm' });
    if (h.optional === true) flags.push({ kind: 'optional', label: 'optional' });
    if (h.writes === false) flags.push({ kind: 'reads_only', label: 'reads only (writes: false)' });
    // Every hook of a scenario file counts as the agent's for work it submits (trust `mcp`).
    const needs = kind ? hookApprovalReason(hook as HookStep, phase, { ...(o.hookFiles ?? {}), agentWritten: true }) : null;
    const comment = commentOf(seq, at, index);
    const range = rangeOf(at, src);
    return {
      phase,
      index,
      ...(kind ? { kind } : {}),
      ...(str(h.name) !== undefined ? { name: h.name as string } : {}),
      summary,
      ...(rollback !== undefined ? { rollback } : {}),
      ...(needs ? { needs_person: needs } : {}),
      flags,
      ...(comment !== undefined ? { comment } : {}),
      ...(range ? { range } : {}),
      ...(at.aliased ? { aliased: true as const } : {}),
      issues: [],
    };
  });
}

/** A step's form values as a block field (absent when a form does not edit it). */
function withForm(raw: unknown): { form?: StepFormValues } {
  const form = stepFormValues(raw);
  return form ? { form } : {};
}

function stepBlock(raw: unknown, index: number, sceneId: string, seq: At, src: Src, sceneIrreversible: boolean, stepsLocked: string | undefined): StepBlock {
  const at = childAt(seq, index);
  const comment = commentOf(seq, at, index);
  const range = rangeOf(at, src);
  const locked = stepsLocked ?? (at.aliased ? 'written as a YAML alias: edit it in the YAML view' : undefined);
  const base = {
    key: `${sceneId}.${index}`,
    index,
    chips: stepChips(raw, { sceneIrreversible }),
    occurrence: 0,
    ...(range ? { range } : {}),
    ...(comment !== undefined ? { comment } : {}),
    ...(at.aliased ? { aliased: true as const } : {}),
    guard: stepGuard(raw),
    ...(locked !== undefined ? { locked } : {}),
    ...withForm(raw),
    issues: [] as ValidationIssue[],
  };
  if (!isObj(raw)) return { ...base, category: 'unknown', label: 'not a step (a step is a mapping with one action)' };
  const id = str(raw.id);
  const keys = stepActionKeys(raw);
  if (keys.length !== 1) {
    return { ...base, ...(id !== undefined ? { id } : {}), category: 'unknown', label: keys.length ? `several actions (${keys.join(', ')})` : 'no action' };
  }
  const action = keys[0];
  let args: unknown;
  let words: { target?: string; summary?: string } = {};
  try {
    args = normalizeStep(raw as Parameters<typeof normalizeStep>[0], index).args;
    words = describeStep(action, args);
  } catch {
    /* malformed arguments: validation reports them; the step still shows its action */
  }
  return {
    ...base,
    ...(id !== undefined ? { id } : {}),
    action,
    category: actionCategory(action),
    label: actionLabel(action),
    ...(words.target !== undefined ? { target: stripUrlUserinfo(words.target) } : {}),
    ...(words.summary !== undefined ? { summary: stripUrlUserinfo(words.summary) } : {}),
    ...(args !== undefined ? { args: stripDeep(args) } : {}),
  };
}

function pagesOf(pages: unknown): ScenePageBlock[] | undefined {
  if (pages === undefined || pages === null) return undefined;
  if (!Array.isArray(pages) && !isObj(pages)) return undefined;
  let entries: ReturnType<typeof scenePageEntries>;
  try {
    entries = scenePageEntries(pages as ScenePages);
  } catch {
    return undefined;
  }
  return entries.map(({ id, spec }) => {
    const s = isObj(spec) ? spec : {};
    const viewport = typeof s.viewport === 'string' ? s.viewport : isObj(s.viewport) ? `${String(s.viewport.width)} × ${String(s.viewport.height)}` : undefined;
    return {
      id: String(id),
      ...(str(s.page) !== undefined ? { page: s.page as string } : {}),
      ...(str(s.open) !== undefined ? { open: stripUrlUserinfo(s.open as string) } : {}),
      ...(viewport !== undefined ? { viewport } : {}),
      ...(str(s.label) !== undefined ? { label: s.label as string } : {}),
      ...(str(s.persona) !== undefined ? { persona: s.persona as string } : {}),
    };
  });
}

function entryBlock(entry: unknown, index: number, scenes: At, src: Src, page: string | undefined): EntryBlock {
  const at = childAt(scenes, index);
  const comment = commentOf(scenes, at, index);
  const range = rangeOf(at, src);
  const where = {
    index,
    ...(comment !== undefined ? { comment } : {}),
    ...(range ? { range } : {}),
    ...(at.aliased ? { aliased: true as const } : {}),
    issues: [] as ValidationIssue[],
  };
  if (!isObj(entry)) return { type: 'unknown', ...where };
  const id = str(entry.id);
  if (entry.interstitial !== undefined) {
    const s = isObj(entry.interstitial) ? entry.interstitial : {};
    const file = mediaFile(s);
    return {
      type: 'interstitial',
      ...where,
      id: id ?? `interstitial-${index}`,
      ...(str(s.text) !== undefined ? { text: s.text as string } : {}),
      ...(str(s.kicker) !== undefined ? { kicker: s.kicker as string } : {}),
      ...(num(s.duration) !== undefined ? { duration: s.duration as number } : {}),
      ...(str(s.component) !== undefined ? { component: s.component as string } : {}),
      ...(file ? { file } : {}),
    };
  }
  if (entry.card !== undefined) {
    const s = isObj(entry.card) ? entry.card : {};
    const file = mediaFile(s);
    const slots = isObj(s.slots) ? Object.fromEntries(Object.entries(s.slots).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, stripUrlUserinfo(v as string)])) : undefined;
    const transition = transitionWords(s.transition);
    return {
      type: 'card',
      ...where,
      id: id ?? `card-${index}`,
      ...(str(s.component) !== undefined ? { component: s.component as string } : {}),
      ...(slots && Object.keys(slots).length ? { slots } : {}),
      ...(s.params !== undefined ? { params: stripDeep(s.params) } : {}),
      ...(file ? { file } : {}),
      ...(num(s.duration) !== undefined ? { duration: s.duration as number } : {}),
      ...(transition !== undefined ? { transition } : {}),
    };
  }
  if (!isSceneValue(entry)) return { type: 'unknown', ...where };
  const sceneId = entry.id;
  const irreversible = entry.irreversible === true;
  const stepsAt = childAt(at, 'steps');
  const stepsLocked = stepsLockedWhy(stepsAt.node, stepsAt.aliased) ?? stepsDashWhy(src.text, stepsAt.node);
  const steps = (Array.isArray(entry.steps) ? entry.steps : []).map((raw, i) => stepBlock(raw, i, sceneId, stepsAt, src, irreversible, stepsLocked));
  const pages = pagesOf(entry.pages);
  const open = str(entry.open);
  const caption = captionOf(entry.caption);
  const cursor = entry.cursor === undefined ? undefined : typeof entry.cursor === 'string' && (entry.cursor === 'auto' || entry.cursor === 'keep') ? entry.cursor : plainTarget(entry.cursor);
  const transition = transitionWords(entry.transition);
  const tutorial = tutorialWords(entry.tutorial);
  const multi = pages !== undefined;
  return {
    type: 'scene',
    ...where,
    id: sceneId,
    ...(!multi && page !== undefined ? { page } : {}),
    ...(!multi && page !== undefined && str(entry.page) === undefined ? { page_inherited: true as const } : {}),
    ...(pages ? { pages } : {}),
    ...(open !== undefined ? { open: stripUrlUserinfo(open) } : {}),
    continues: multi ? pages.every((p) => p.open === undefined) : open === undefined,
    ...(str(entry.persona) !== undefined ? { persona: entry.persona as string } : {}),
    ...(caption ? { caption } : {}),
    ...(num(entry.speed) !== undefined ? { speed: entry.speed as number } : {}),
    ...(num(entry.still) !== undefined ? { still: entry.still as number } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(transition !== undefined ? { transition } : {}),
    ...(str(entry.frame) !== undefined ? { frame: entry.frame as string } : {}),
    ...(tutorial !== undefined ? { tutorial } : {}),
    ...(irreversible ? { irreversible: true as const } : {}),
    ...(entry.skip === true ? { skip: true as const } : {}),
    ...(entry.offscreen === true ? { offscreen: true as const } : {}),
    ...(str(entry.note) !== undefined ? { note: entry.note as string } : {}),
    context: '',
    steps,
    ...(stepsLocked !== undefined ? { steps_locked: stepsLocked } : {}),
  };
}

/** Put each issue on the block its path points into (a step, an entry, a hook), else on the scenario. */
function attachIssues(b: ScenarioBlocks, issues: readonly ValidationIssue[]): void {
  for (const issue of issues) {
    const p: IssuePath = Array.isArray(issue.path) ? issue.path : [];
    if (p[0] === 'scenes' && typeof p[1] === 'number' && b.entries[p[1]]) {
      const entry = b.entries[p[1]];
      if (entry.type === 'scene' && p[2] === 'steps' && typeof p[3] === 'number' && entry.steps[p[3]]) entry.steps[p[3]].issues.push(issue);
      else entry.issues.push(issue);
      continue;
    }
    if ((p[0] === 'setup' || p[0] === 'teardown') && typeof p[1] === 'number' && b.hooks[p[0]][p[1]]) {
      b.hooks[p[0]][p[1]].issues.push(issue);
      continue;
    }
    if (p[0] === 'hooks' && typeof p[1] === 'string') {
      const named = b.hooks.named.filter((h) => h.hook === p[1]);
      const h = named[typeof p[2] === 'number' ? p[2] : 0];
      if (h) {
        h.issues.push(issue);
        continue;
      }
    }
    b.issues.push(issue);
  }
}

/**
 * A scenario's text as blocks (see the file's comment). Never throws: an unexpected failure gives no blocks and an
 * issue saying so.
 */
export function scenarioBlocks(text: string, o: ScenarioBlocksOptions = {}): ScenarioBlocks {
  const empty = (issues: ValidationIssue[]): ScenarioBlocks => ({ parsed: false, video: emptyVideo(), hooks: { setup: [], teardown: [], named: [] }, entries: [], step_count: 0, issues });
  try {
    const parsed = parseYaml(text);
    const issues = o.issues ? [...o.issues] : parseScenario(text).issues;
    if (parsed.value === undefined) {
      // Syntax errors (they are among the validation issues; when the caller's are not, the parser's own say it).
      return empty(issues.length ? issues : parsed.issues.map((i) => ({ severity: i.severity, path: i.path, message: i.message, ...(i.line !== undefined ? { line: i.line, col: i.col } : {}) })));
    }
    const src: Src = { yaml: parsed.source, text };
    const root: At = { node: parsed.source.doc.contents as Node | undefined, aliased: false };
    const sc = isObj(parsed.value) ? parsed.value : {};
    const scenes = new Map<number, { page: string | undefined; identity: SceneIdentity }>();
    scenarioIdentityOfValue(sc, (i, page, identity) => scenes.set(i, { page, identity }));
    const scenesAt = childAt(root, 'scenes');
    const entries = (Array.isArray(sc.scenes) ? sc.scenes : []).map((entry, i) => entryBlock(entry, i, scenesAt, src, scenes.get(i)?.page));
    let stepCount = 0;
    entries.forEach((e, i) => {
      const id = scenes.get(i)?.identity;
      if (e.type !== 'scene' || !id) return;
      stepCount += e.steps.length;
      e.context = id.context;
      e.steps.forEach((s, j) => {
        const x = id.steps[j];
        if (x?.fp) s.fingerprint = x.fp;
        if (x?.picture) s.picture = x.picture;
        s.occurrence = x?.n ?? 0;
      });
    });
    const out: ScenarioBlocks = {
      parsed: true,
      video: videoBlock(sc, src),
      hooks: {
        setup: hookBlocks('setup', sc.setup, childAt(root, 'setup'), src, o),
        teardown: hookBlocks('teardown', sc.teardown, childAt(root, 'teardown'), src, o),
        named: namedHookBlocks(sc.hooks, childAt(root, 'hooks'), src, o),
      },
      entries,
      step_count: stepCount,
      issues: [],
    };
    attachIssues(out, issues);
    return out;
  } catch (e) {
    return empty([{ severity: 'error', path: [], message: `the scenario could not be read as blocks: ${e instanceof Error ? e.message : String(e)}` }]);
  }
}
