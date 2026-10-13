/**
 * Tutorial overlays (L2.10): the switches of a scenario, a scene and a step merged into the effective state of each
 * overlay. Pure; the edit planner uses it on the switches the runner copied into timeline.json.
 */
import { TUTORIAL_COMPONENTS, TUTORIAL_FEATURES } from './types.js';
import type { ChapterMode, ComponentId, SpotlightMode, TutorialFeatureName, TutorialSpec, TutorialSwitch } from './types.js';

/** The effective state of one tutorial overlay. */
export interface TutorialFeatureState {
  on: boolean;
  /** Component drawing it (default: the built-in one, TUTORIAL_COMPONENTS). */
  component: ComponentId;
  /** Params given by the scenario (merged level by level; the component's defaults apply under them). */
  params: Record<string, unknown>;
  /** spotlight: steps | clicks; progress: scenes | cards. */
  mode?: SpotlightMode | ChapterMode;
}

export type ResolvedTutorial = Record<TutorialFeatureName, TutorialFeatureState>;

/** Where a switch is written: `progress` is a video-wide switch (scenario level only). */
export type TutorialLevel = 'scenario' | 'scene' | 'step';

const DEFAULT_MODE: Partial<Record<TutorialFeatureName, SpotlightMode | ChapterMode>> = { spotlight: 'steps', progress: 'scenes' };

/** Every tutorial overlay off (the default of a scenario without `tutorial`). */
export function tutorialOff(): ResolvedTutorial {
  const out = {} as ResolvedTutorial;
  for (const f of TUTORIAL_FEATURES) {
    out[f] = { on: false, component: TUTORIAL_COMPONENTS[f], params: {} };
    const mode = DEFAULT_MODE[f];
    if (mode) out[f].mode = mode;
  }
  return out;
}

const isMode = (f: TutorialFeatureName, v: unknown): v is SpotlightMode | ChapterMode =>
  (f === 'spotlight' && (v === 'steps' || v === 'clicks')) || (f === 'progress' && (v === 'scenes' || v === 'cards'));

/** One feature's value (`true`, `false`, a mode, `{component?, params?, on?|chapters?}`) applied over its state. */
function applyFeature(f: TutorialFeatureName, state: TutorialFeatureState, v: unknown): TutorialFeatureState {
  if (v === undefined) return state;
  if (typeof v === 'boolean') return { ...state, on: v };
  if (isMode(f, v)) return { ...state, on: true, mode: v };
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as { component?: ComponentId; params?: Record<string, unknown>; on?: unknown; chapters?: unknown };
    const next: TutorialFeatureState = { ...state, on: true, params: { ...state.params, ...(o.params ?? {}) } };
    if (o.component) next.component = o.component;
    const mode = f === 'spotlight' ? o.on : f === 'progress' ? o.chapters : undefined;
    if (isMode(f, mode)) next.mode = mode;
    return next;
  }
  return state;
}

/**
 * A level's switch applied over the state of the level above: `true` turns every overlay on, `false` every overlay
 * off, an object sets the overlays it names. `progress` is only read at the scenario level.
 */
export function applyTutorial(base: ResolvedTutorial, sw: TutorialSwitch | undefined, level: TutorialLevel = 'scenario'): ResolvedTutorial {
  if (sw === undefined) return base;
  const out = { ...base };
  for (const f of TUTORIAL_FEATURES) {
    if (f === 'progress' && level !== 'scenario') continue;
    const v = typeof sw === 'boolean' ? sw : (sw as TutorialSpec)[f];
    out[f] = applyFeature(f, base[f], v);
  }
  return out;
}

/** The effective tutorial overlays of a step: scenario → scene → step (the most specific switch wins). */
export function resolveTutorial(scenario?: TutorialSwitch, scene?: TutorialSwitch, step?: TutorialSwitch): ResolvedTutorial {
  return applyTutorial(applyTutorial(applyTutorial(tutorialOff(), scenario, 'scenario'), scene, 'scene'), step, 'step');
}

/** The overlays a switch names explicitly (true / false names them all, except progress below the scenario level). */
export function tutorialFeaturesNamed(sw: TutorialSwitch | undefined, level: TutorialLevel): TutorialFeatureName[] {
  if (sw === undefined) return [];
  if (typeof sw === 'boolean') return TUTORIAL_FEATURES.filter((f) => f !== 'progress' || level === 'scenario');
  return TUTORIAL_FEATURES.filter((f) => (sw as TutorialSpec)[f] !== undefined);
}

/** Actions whose target a spotlight follows (the step's target box, as the runner measured it). */
export const SPOTLIGHT_ACTIONS: readonly string[] = ['click', 'double_click', 'hover', 'type', 'select', 'pick', 'menu', 'date', 'drag', 'drop_file', 'download'];
/** Actions that click a target: each gets a numbered badge (a `type` step only when it clicks into a field first). */
export const BADGE_ACTIONS: readonly string[] = ['click', 'double_click', 'type', 'select', 'pick', 'menu', 'date', 'download'];
/** Actions a shortcut overlay shows (the keys of a `press` step). */
export const SHORTCUT_ACTIONS: readonly string[] = ['press'];
/** Actions a typing loupe magnifies (the focused field). */
export const LOUPE_ACTIONS: readonly string[] = ['type'];

// ── Frame references (before/after cards) ────────────────────────────────────

/**
 * A reference to an image for a card slot such as `before:` / `after:` — a frame of the capture or an image file:
 *  - `mark:<name>` or `<name>`: the screen once the marked step is done (its hold, else just after it);
 *  - `start:<scene>` / `end:<scene>`: the first visible / the last frame of a scene;
 *  - `<seconds>s` (e.g. `12.5s`): that capture time;
 *  - a file with an image extension (relative to the project), e.g. `assets/before.png`.
 */
export type FrameRef =
  | { kind: 'mark'; name: string }
  | { kind: 'scene'; at: 'start' | 'end'; scene: string }
  | { kind: 'time'; t: number }
  | { kind: 'file'; path: string };

/** Image files a frame / image slot accepts. */
export const IMAGE_FILE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];

export function isImagePath(value: string): boolean {
  const m = /\.[A-Za-z0-9]+$/.exec(value.trim());
  return !!m && IMAGE_FILE_EXTENSIONS.includes(m[0].toLowerCase());
}

/** Parse a frame reference; undefined when the value matches none of the forms. */
export function parseFrameRef(value: string): FrameRef | undefined {
  const v = value.trim();
  if (v === '') return undefined;
  if (isImagePath(v)) return { kind: 'file', path: v };
  const time = /^(\d+(?:\.\d+)?)\s*s$/.exec(v);
  if (time) return { kind: 'time', t: Number(time[1]) };
  const scene = /^(start|end):([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(v);
  if (scene) return { kind: 'scene', at: scene[1] as 'start' | 'end', scene: scene[2] };
  const mark = /^(?:mark:)?([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(v);
  if (mark) return { kind: 'mark', name: mark[1] };
  return undefined;
}
