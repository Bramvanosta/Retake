/**
 * Which step of a run a step of today's scenario is (L4.2, critique B4): the Studio shows each step with the frame a run
 * captured of it, and a scenario edited since that run must not keep a picture that is no longer true.
 *
 * A step's picture identity is its fingerprint (core `stepFingerprint`: action + normalised arguments, modifiers left
 * out), the page it acts on (`on:`) and its scene's context — the scene's page (inherited from the scene before when it
 * names none), `open`, `pages` and `persona`. A change to any of them is a change of what the frame shows; a change to
 * a modifier only (caption, hold, speed, camera, mark, overlay…) keeps the picture. Identical steps of a scene are told
 * apart by their occurrence (`n`: how many earlier steps of the scene have the same identity), so reordering identical
 * steps maps them in order.
 */
import { createHash } from 'node:crypto';
import { canonicalJson, stepFingerprintOf } from './comments.js';
import { parseYaml } from './validation/yaml-source.js';

/** One step's identity in its scene. */
export interface StepIdentity {
  /** core stepFingerprint; undefined: the step has no single action (it never matches). */
  fp?: string;
  /** Its action (a changed step is paired with a run step of the same action first). */
  action?: string;
  /** The picture identity: fingerprint + `on:` + the scene's context (12 hex characters). */
  picture?: string;
  /** Earlier steps of the scene with the same picture identity. */
  n: number;
}

/** A scene's context and the identity of each of its steps, by step index. */
export interface SceneIdentity {
  /** Hash of the scene's page (inherited included), open, pages and persona. */
  context: string;
  steps: StepIdentity[];
}

/** Scene id → its identity (capture scenes only; a scene id seen twice keeps its first scene). */
export type ScenarioIdentity = Map<string, SceneIdentity>;

function hash12(v: unknown): string {
  return createHash('sha256').update(canonicalJson(v)).digest('hex').slice(0, 12);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A capture scene of a scenario value (an object with a string id, not a card or an interstitial). */
export function isSceneValue(e: unknown): e is Record<string, unknown> & { id: string } {
  return isPlainObject(e) && e.interstitial === undefined && e.card === undefined && typeof e.id === 'string';
}

/**
 * The identity of every capture scene and step of a scenario's data (the parsed YAML value; tolerant: malformed parts
 * get no fingerprint). `onScene` sees each capture scene (by its index among the entries) with its effective page (its
 * own, else the previous capture scene's) and its identity.
 */
export function scenarioIdentityOfValue(value: unknown, onScene?: (sceneIndex: number, page: string | undefined, identity: SceneIdentity) => void): ScenarioIdentity {
  const out: ScenarioIdentity = new Map();
  const scenes = isPlainObject(value) && Array.isArray(value.scenes) ? value.scenes : [];
  let page: string | undefined;
  scenes.forEach((entry, i) => {
    if (!isSceneValue(entry)) return;
    if (typeof entry.page === 'string') page = entry.page;
    const context = hash12({ page: page ?? null, open: entry.open ?? null, pages: entry.pages ?? null, persona: entry.persona ?? null });
    const seen = new Map<string, number>();
    const steps: StepIdentity[] = (Array.isArray(entry.steps) ? entry.steps : []).map((raw) => {
      const f = stepFingerprintOf(raw);
      if (!f) return { n: 0 };
      const { fp, action } = f;
      const on = isPlainObject(raw) && typeof raw.on === 'string' ? raw.on : null;
      const picture = hash12({ fp, on, context });
      const n = seen.get(picture) ?? 0;
      seen.set(picture, n + 1);
      return { fp, action, picture, n };
    });
    onScene?.(i, page, { context, steps });
    if (!out.has(entry.id)) out.set(entry.id, { context, steps });
  });
  return out;
}

/**
 * The identity of a scenario text (a run's `scenario.yaml` snapshot, or today's file), parsed once (core parseYaml:
 * aliases bounded, recursive ones refused); undefined when it does not parse.
 */
export function sceneStepFingerprints(text: string): ScenarioIdentity | undefined {
  const { value } = parseYaml(text);
  return value === undefined ? undefined : scenarioIdentityOfValue(value);
}

/**
 * How one step of today's scenario relates to a run: `run_index` — the same step at that index of the run's scene (its
 * picture is true); otherwise why it has none: `changed` (its action, arguments or `on:` changed — `run_index` then
 * names the run's step it replaced), `new` (added since the run), `scene_changed` (the scene's page, open, pages or
 * persona changed), `scene_not_in_run` (no scene of that id in the run), `unreadable` (no single action today).
 */
export type RunStepMatch =
  | { run_index: number }
  | { missing: 'changed'; run_index: number }
  | { missing: 'new' | 'scene_changed' | 'scene_not_in_run' | 'unreadable' };

/**
 * Today's steps matched to a run's (both from scenarioIdentityOfValue / sceneStepFingerprints), keyed
 * "<scene id>.<step index>" of today's file. A step matches the run's step of its scene with the same picture
 * identity and occurrence. A step that matches nothing is `changed` when an unmatched step of the run sits between the
 * same matched neighbours (one of the same action first, else in order), else `new`.
 */
export function matchRunSteps(current: ScenarioIdentity, run: ScenarioIdentity): Map<string, RunStepMatch> {
  const out = new Map<string, RunStepMatch>();
  for (const [scene, now] of current) {
    const key = (i: number) => `${scene}.${i}`;
    const then = run.get(scene);
    if (!then) {
      now.steps.forEach((_s, i) => out.set(key(i), { missing: 'scene_not_in_run' }));
      continue;
    }
    if (then.context !== now.context) {
      now.steps.forEach((_s, i) => out.set(key(i), { missing: 'scene_changed' }));
      continue;
    }
    const byIdentity = new Map<string, number>();
    then.steps.forEach((s, j) => {
      if (s.picture) byIdentity.set(`${s.picture}#${s.n}`, j);
    });
    const matched: Array<number | undefined> = now.steps.map((s) => (s.picture ? byIdentity.get(`${s.picture}#${s.n}`) : undefined));
    const used = new Set(matched.filter((j): j is number => j !== undefined));
    const free = then.steps.map((_s, j) => j).filter((j) => !used.has(j));
    let i = 0;
    while (i < now.steps.length) {
      const j = matched[i];
      if (j !== undefined) {
        out.set(key(i), { run_index: j });
        i++;
        continue;
      }
      // A gap of unmatched steps [i, k): pair them with the run's free steps between the matched neighbours.
      let k = i;
      while (k < now.steps.length && matched[k] === undefined) k++;
      const lo = i > 0 ? (matched[i - 1] as number) : -1;
      const hi = k < now.steps.length ? (matched[k] as number) : then.steps.length;
      const candidates = free.filter((f) => f > lo && f < hi);
      for (let g = i; g < k; g++) {
        if (!now.steps[g].fp) {
          out.set(key(g), { missing: 'unreadable' });
          continue;
        }
        // A run step of the same action first (review B L1: a changed click is not the wait before it), else in order.
        const same = candidates.findIndex((f) => now.steps[g].action !== undefined && then.steps[f].action === now.steps[g].action);
        const c = same >= 0 ? candidates.splice(same, 1)[0] : candidates.shift();
        if (c !== undefined) {
          free.splice(free.indexOf(c), 1);
          out.set(key(g), { missing: 'changed', run_index: c });
        } else {
          out.set(key(g), { missing: 'new' });
        }
      }
      i = k;
    }
  }
  return out;
}

/**
 * The steps of today's file that kept their run picture but moved since the run (L4.3, plan §3.9): in each scene, the
 * bound steps (a `run_index` without `missing`) whose run index is not in the longest increasing run of the scene's
 * run indexes in today's order — the fewest steps that explain the new order. Their picture shows them at their old
 * place (what the page looked like then), so the screen says so. Keys "<scene>.<index>" of today's file.
 */
export function movedSteps(current: ScenarioIdentity, matches: Map<string, RunStepMatch>): Set<string> {
  const out = new Set<string>();
  for (const [scene, now] of current) {
    const bound: Array<{ key: string; j: number }> = [];
    now.steps.forEach((_s, i) => {
      const m = matches.get(`${scene}.${i}`);
      if (m && !('missing' in m)) bound.push({ key: `${scene}.${i}`, j: m.run_index });
    });
    // Longest strictly increasing subsequence of the run indexes (patience sorting, O(n log n)).
    const tails: number[] = [];
    const prev: number[] = new Array(bound.length).fill(-1);
    bound.forEach((b, i) => {
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (bound[tails[mid]].j < b.j) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) prev[i] = tails[lo - 1];
      tails[lo] = i;
    });
    const keep = new Set<number>();
    for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);
    bound.forEach((b, i) => {
      if (!keep.has(i)) out.add(b.key);
    });
  }
  return out;
}
