import { ACTION_NAMES, isCaptureScene, isCard, isInterstitial } from './types.js';
import type {
  ActionName,
  NormalizedArgsMap,
  NormalizedStep,
  Scenario,
  Scene,
  Step,
  StepCommon,
  TargetObject,
  TargetSpec,
} from './types.js';
import { isPoint, normalizeTarget } from './targets.js';

export class StepError extends Error {
  constructor(
    message: string,
    public readonly index?: number,
  ) {
    super(message);
    this.name = 'StepError';
  }
}

const COMMON_KEYS: ReadonlyArray<keyof StepCommon> = [
  'id',
  'caption',
  'speed',
  'hold',
  'camera',
  'overlay',
  'tutorial',
  'mark',
  'timeout',
  'optional',
  'irreversible',
  'note',
];

const ACTION_SET = new Set<string>(ACTION_NAMES);

/**
 * The action keys present on a raw step object. `hold` is also a modifier ("seconds of stillness
 * after the step"): next to another action it is the modifier, alone it is the action.
 */
export function stepActionKeys(step: Record<string, unknown>): ActionName[] {
  const keys = Object.keys(step).filter((k) => ACTION_SET.has(k)) as ActionName[];
  return keys.length > 1 ? keys.filter((k) => k !== 'hold') : keys;
}

/** String targets are expanded; object targets are copied (explicit keys win). */
function targetOrObject(v: TargetSpec): TargetObject {
  return typeof v === 'string' ? normalizeTarget(v) : { ...v };
}

function normalizeArgs(action: ActionName, v: unknown): NormalizedArgsMap[ActionName] {
  switch (action) {
    case 'open':
      return typeof v === 'string' ? { url: v } : { ...(v as object) } as NormalizedArgsMap['open'];
    case 'click':
    case 'double_click':
    case 'hover':
      return targetOrObject(v as TargetSpec);
    case 'type':
      if (typeof v === 'string') return { text: v };
      return { ...(v as NormalizedArgsMap['type']) };
    case 'press':
      return typeof v === 'string' ? { key: v } : { ...(v as NormalizedArgsMap['press']) };
    case 'select':
    case 'pick':
    case 'menu':
    case 'drag':
    case 'drop_file':
      return { ...(v as object) } as NormalizedArgsMap['select'];
    case 'scroll':
      if (typeof v === 'number') return { to: v };
      if (typeof v === 'string') return v === 'top' || v === 'bottom' ? { to: v } : { to: normalizeTarget(v) };
      return { ...(v as NormalizedArgsMap['scroll']) };
    case 'wait':
    case 'hold':
      return { seconds: Number(v) };
    case 'wait_for':
      return typeof v === 'string' ? { text: v } : { ...(v as NormalizedArgsMap['wait_for']) };
    case 'assert':
      return typeof v === 'string' ? { text: v } : { ...(v as NormalizedArgsMap['assert']) };
    case 'screenshot':
      return typeof v === 'string' ? { name: v } : { ...(v as NormalizedArgsMap['screenshot']) };
    case 'new_tab': {
      if (typeof v === 'string') {
        return /^(https?:)?\/\//.test(v) || v.startsWith('/') ? { href: v } : { target: normalizeTarget(v) };
      }
      const o = v as Record<string, unknown>;
      if ('target' in o || 'href' in o || 'as' in o) return { ...(o as NormalizedArgsMap['new_tab']) };
      return { target: o as TargetObject };
    }
    case 'switch_page':
      return typeof v === 'string' ? { to: v } : { ...(v as NormalizedArgsMap['switch_page']) };
    case 'eval':
      return typeof v === 'string' ? { js: v } : { ...(v as NormalizedArgsMap['eval']) };
    case 'notify':
      return typeof v === 'string' ? { message: v } : { ...(v as NormalizedArgsMap['notify']) };
    case 'emit':
      return typeof v === 'string' ? { name: v } : { ...(v as NormalizedArgsMap['emit']) };
    case 'wait_for_email':
      return { ...(v as NormalizedArgsMap['wait_for_email']) };
    case 'capture_text':
      return { ...(v as NormalizedArgsMap['capture_text']) };
    case 'download': {
      const o = v as { click: TargetSpec; as: string; timeout?: number };
      return { ...o, click: targetOrObject(o.click) } as NormalizedArgsMap['download'];
    }
    case 'cursor': {
      if (v === 'show' || v === 'hide') return { mode: v };
      const o = v as { move?: unknown; set?: unknown; duration?: number; show?: boolean };
      if (o.set !== undefined) return { mode: 'set', to: o.set as NormalizedArgsMap['cursor']['to'], duration: o.duration };
      if (o.move !== undefined) {
        const to = isPoint(o.move) ? o.move : normalizeTarget(o.move as TargetSpec);
        return { mode: 'move', to, duration: o.duration };
      }
      return { mode: o.show === false ? 'hide' : 'show' };
    }
  }
}

/**
 * Normalise a raw step: identify its single action, expand shorthands to object form,
 * keep the common modifiers. Throws StepError on 0 or >1 action keys.
 */
export function normalizeStep(step: Step, index: number): NormalizedStep {
  if (step === null || typeof step !== 'object' || Array.isArray(step)) {
    throw new StepError(`step ${index} must be a mapping with one action key`, index);
  }
  const keys = stepActionKeys(step as Record<string, unknown>);
  if (keys.length === 0) {
    throw new StepError(
      `step ${index} has no action (expected one of: ${ACTION_NAMES.join(', ')}); keys: ${Object.keys(step).join(', ') || '(none)'}`,
      index,
    );
  }
  if (keys.length > 1) {
    throw new StepError(`step ${index} has several actions (${keys.join(', ')}); split it into separate steps`, index);
  }
  const action = keys[0];
  const out: NormalizedStep = {
    action,
    args: normalizeArgs(action, (step as Record<string, unknown>)[action]) as NormalizedStep['args'],
    index,
    raw: step,
  };
  for (const k of COMMON_KEYS) {
    if (k === action) continue; // a `hold` action is not also a hold modifier
    const v = (step as Record<string, unknown>)[k];
    if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Id of a scenario entry: its `id`, else "interstitial-<index>" / "card-<index>" for interstitials and cards. */
export function sceneId(entry: Scenario['scenes'][number], index: number): string {
  if (isInterstitial(entry)) return entry.id ?? `interstitial-${index}`;
  if (isCard(entry)) return entry.id ?? `card-${index}`;
  return entry.id;
}

export interface ListedStep {
  scene: Scene;
  sceneIndex: number;
  step: NormalizedStep;
  /** "<sceneId>.<stepId|index>" */
  ref: string;
}

/** Every step of every captured (non-skipped) scene, in execution order; cards and interstitials have no steps. */
export function listSteps(s: Scenario, opts: { includeSkipped?: boolean } = {}): ListedStep[] {
  const out: ListedStep[] = [];
  s.scenes.forEach((entry, sceneIndex) => {
    if (!isCaptureScene(entry)) return;
    if (entry.skip && !opts.includeSkipped) return;
    (entry.steps ?? []).forEach((raw, i) => {
      const step = normalizeStep(raw, i);
      out.push({ scene: entry, sceneIndex, step, ref: `${entry.id}.${step.id ?? i}` });
    });
  });
  return out;
}

/**
 * Resolve a step reference used by `--until`:
 *  "sceneId.stepId" | "sceneId.3" | "stepId" (unique across the scenario) | "sceneId" (= last step of that scene).
 */
export function resolveStepRef(s: Scenario, ref: string): { sceneIndex: number; stepIndex: number } | null {
  const scenes = s.scenes;
  const findScene = (id: string) =>
    scenes.findIndex((e, i) => isCaptureScene(e) && sceneId(e, i) === id);

  const dot = ref.indexOf('.');
  if (dot > 0) {
    const sid = ref.slice(0, dot);
    const rest = ref.slice(dot + 1);
    const si = findScene(sid);
    if (si >= 0) {
      const scene = scenes[si] as Scene;
      const steps = scene.steps ?? [];
      const byId = steps.findIndex((st) => st.id === rest);
      if (byId >= 0) return { sceneIndex: si, stepIndex: byId };
      if (/^\d+$/.test(rest)) {
        const n = Number(rest);
        if (n < steps.length) return { sceneIndex: si, stepIndex: n };
      }
      return null;
    }
  }
  // step id across the scenario
  const hits: Array<{ sceneIndex: number; stepIndex: number }> = [];
  scenes.forEach((e, si) => {
    if (!isCaptureScene(e)) return;
    (e.steps ?? []).forEach((st, i) => {
      if (st.id === ref) hits.push({ sceneIndex: si, stepIndex: i });
    });
  });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return null;
  const si = findScene(ref);
  if (si >= 0) {
    const n = ((scenes[si] as Scene).steps ?? []).length;
    return { sceneIndex: si, stepIndex: Math.max(0, n - 1) };
  }
  return null;
}
