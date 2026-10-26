/**
 * The filmed part of a scenario (L5.5, R-FLD-01 / R-FLD-02): what drives the browser during a take, as opposed to the
 * edit, which a render re-plans from today's file on an existing run.
 *
 * Filmed: the environment (`env`), the setup and teardown hooks, the capture settings, the pacing, the product clock,
 * the write mocks, the vars that a filmed part uses, the capture scenes (their ids, order and `skip`), each scene's
 * page (inherited included), `open`, `pages` (page labels left out), `persona`, `still` and `cursor`, and each step's
 * action and arguments (core stepFingerprint: shorthands and object forms agree) with the modifiers that act on the
 * page — `hold`, `park`, `on`.
 *
 * Everything else is edit: title, intro / outro, frame, template, music, tutorial switches, target length; cards and
 * interstitials (their text, duration, place between scenes); a scene's caption, speed, transition, frame, tutorial and
 * page labels; a step's caption, speed, camera, mark, overlay, tutorial and id. `timeout`, `optional` and
 * `irreversible` change nothing a successful take filmed and are left out; `note`s are ignored.
 *
 * The comparison reads both texts as data (core parseYaml: comments, quoting, key order are no change) and tolerates
 * malformed parts (a step without a single action is compared by its data). Messages name only keys, scene ids (slugs)
 * and step indexes, never a value of the file: they reach trusted summaries.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, stepFingerprintOf } from './comments.js';
import { readPlainFile } from './plain-file.js';
import { SLUG_RE } from './schemas/primitives.js';
import type { LoadedProject } from './types.js';
import { listTemplateTokens } from './templating.js';
import { parseYaml } from './validation/yaml-source.js';

/** The largest scenario file or snapshot compared (a scenario_save takes 500,000 characters). */
export const SCENARIO_COMPARE_MAX_BYTES = 2 * 1024 * 1024;

/** Top-level keys that drive the take, with the words a change of them is reported in. */
const FILMED_TOP: ReadonlyArray<[string, string]> = [
  ['env', 'the environment (env)'],
  ['setup', 'the setup hooks'],
  ['teardown', 'the teardown hooks'],
  ['capture', 'the capture settings'],
  ['pacing', 'the pacing'],
  ['clock', 'the product clock (clock)'],
  ['mocks', 'the write mocks (mocks)'],
];

/** Scene keys that drive the take (besides the steps). */
const FILMED_SCENE_KEYS = ['page', 'open', 'pages', 'persona', 'still', 'cursor'] as const;

/** Step modifiers that act on the page (the action and its arguments are compared by fingerprint). */
const FILMED_STEP_MODIFIERS = ['hold', 'park', 'on'] as const;

/** Step keys that are edit or change nothing filmed: a step without a single action is compared without them. */
const EDIT_STEP_KEYS = new Set(['id', 'caption', 'speed', 'camera', 'mark', 'overlay', 'tutorial', 'note', 'timeout', 'optional', 'irreversible']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isCaptureSceneValue(e: unknown): e is Record<string, unknown> {
  return isPlainObject(e) && e.card === undefined && e.interstitial === undefined;
}

/** `pages:` without the page labels (a label is text a layout shows). */
function pagesWithoutLabels(pages: unknown): unknown {
  const strip = (p: unknown) => {
    if (!isPlainObject(p)) return p;
    const { label: _label, ...rest } = p;
    return rest;
  };
  if (Array.isArray(pages)) return pages.map(strip);
  if (isPlainObject(pages)) return Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, strip(v)]));
  return pages;
}

/** The filmed identity of one raw step. */
function filmedStep(raw: unknown): string {
  const f = stepFingerprintOf(raw);
  const mods = isPlainObject(raw) ? Object.fromEntries(FILMED_STEP_MODIFIERS.map((k) => [k, raw[k]])) : {};
  if (f) return canonicalJson({ fp: f.fp, ...mods });
  const rest = isPlainObject(raw) ? Object.fromEntries(Object.entries(raw).filter(([k]) => !EDIT_STEP_KEYS.has(k))) : raw;
  return canonicalJson({ raw: rest ?? null });
}

/** One capture scene's filmed part. */
interface FilmedScene {
  id: string;
  /** Key → canonical value (page is the effective one: its own, else the previous capture scene's). */
  keys: Record<string, string>;
  steps: string[];
  /** Strings of the filmed part (steps included), for the vars they use. */
  strings: string[];
}

/** The filmed part of a scenario's data (the parsed YAML value). */
export interface FilmedParts {
  top: Record<string, string>;
  scenes: FilmedScene[];
  /** Vars of the scenario (name → canonical value). */
  vars: Record<string, string>;
  /** Var names a filmed part uses ({{vars.x}}, or {{x}} for a var of the scenario). */
  used: Set<string>;
}

function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (isPlainObject(v)) for (const [k, x] of Object.entries(v)) if (k !== 'note') collectStrings(x, out);
}

/** The filmed part of a scenario value (tolerant: a malformed scenario gives what can be read). */
export function filmedPartsOf(value: unknown): FilmedParts {
  const doc = isPlainObject(value) ? value : {};
  const top: Record<string, string> = {};
  const topStrings: string[] = [];
  for (const [k] of FILMED_TOP) {
    top[k] = canonicalJson(doc[k] ?? null);
    collectStrings(doc[k], topStrings);
  }
  const scenes: FilmedScene[] = [];
  let page: unknown = null;
  for (const [i, entry] of (Array.isArray(doc.scenes) ? doc.scenes : []).entries()) {
    if (!isCaptureSceneValue(entry)) continue;
    if (entry.page !== undefined) page = entry.page;
    const own: Record<string, unknown> = { page, open: entry.open, pages: pagesWithoutLabels(entry.pages), persona: entry.persona, still: entry.still, cursor: entry.cursor };
    const keys: Record<string, string> = { skip: canonicalJson(entry.skip === true) };
    for (const k of FILMED_SCENE_KEYS) keys[k] = canonicalJson(own[k] ?? null);
    const rawSteps = Array.isArray(entry.steps) ? entry.steps : [];
    const strings: string[] = [];
    collectStrings(own, strings);
    for (const s of rawSteps) {
      if (!isPlainObject(s)) continue;
      collectStrings(Object.fromEntries(Object.entries(s).filter(([k]) => !EDIT_STEP_KEYS.has(k) || k === 'overlay' || k === 'camera').map(([k, v]) => [k, k === 'overlay' || k === 'camera' ? (isPlainObject(v) ? v.target : undefined) : v])), strings);
    }
    scenes.push({ id: typeof entry.id === 'string' ? entry.id : `#${i}`, keys, steps: rawSteps.map(filmedStep), strings });
  }
  const vars: Record<string, string> = {};
  if (isPlainObject(doc.vars)) for (const [k, v] of Object.entries(doc.vars)) vars[k] = canonicalJson(v);
  const used = new Set<string>();
  for (const s of [...topStrings, ...scenes.flatMap((sc) => sc.strings)]) {
    for (const token of listTemplateTokens(s)) {
      const path = token.split('.').map((p) => p.trim());
      if (path[0] === 'vars' && path[1]) used.add(path[1]);
      else if (path[0] && Object.hasOwn(vars, path[0])) used.add(path[0]);
    }
  }
  return { top, scenes, vars, used };
}

/** The ids of a scene list, safe to name in a message (a slug), else "a scene". */
function sceneName(id: string): string {
  return SLUG_RE.test(id) && id.length <= 64 ? id : 'a scene';
}

/** Today's steps against the run's: today's indexes changed or added, and how many of the run's were removed. */
function stepChanges(now: string[], then: string[]): { changed: number[]; added: number[]; removed: number } {
  // Longest common subsequence of the filmed step identities: the steps that stayed, in order.
  const n = now.length;
  const m = then.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = now[i] === then[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const keptNow = new Set<number>();
  const keptThen = new Set<number>();
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (now[i] === then[j]) {
      keptNow.add(i++);
      keptThen.add(j++);
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const changed: number[] = [];
  const added: number[] = [];
  let removed = 0;
  // Within each gap between kept steps, a step of today paired with a run step that left is a change.
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const gapNow: number[] = [];
    const gapThen: number[] = [];
    while (i < n && !keptNow.has(i)) gapNow.push(i++);
    while (j < m && !keptThen.has(j)) gapThen.push(j++);
    const paired = Math.min(gapNow.length, gapThen.length);
    changed.push(...gapNow.slice(0, paired));
    added.push(...gapNow.slice(paired));
    removed += gapThen.length - paired;
    if (i < n && j < m) {
      i++;
      j++;
    } else if (gapNow.length === 0 && gapThen.length === 0) break;
  }
  return { changed, added, removed };
}

function stepList(scene: string, idx: number[]): string {
  return idx.map((k) => `${scene}.${k}`).join(', ');
}

/** What changed in the filmed part between two scenario values (today, the run's); empty: nothing filmed changed. */
export function filmedChangesOf(now: unknown, then: unknown): string[] {
  const a = filmedPartsOf(now);
  const b = filmedPartsOf(then);
  const out: string[] = [];
  for (const [k, words] of FILMED_TOP) if (a.top[k] !== b.top[k]) out.push(words);
  const vars = [...new Set([...a.used, ...b.used])].filter((v) => a.vars[v] !== b.vars[v]).sort();
  if (vars.length) out.push(`vars the take uses: ${vars.map((v) => (SLUG_RE.test(v) && v.length <= 64 ? v : '(a var)')).join(', ')}`);
  const idsNow = a.scenes.map((s) => s.id);
  const idsThen = b.scenes.map((s) => s.id);
  for (const id of idsNow) if (!idsThen.includes(id)) out.push(`scene ${sceneName(id)} added`);
  for (const id of idsThen) if (!idsNow.includes(id)) out.push(`scene ${sceneName(id)} removed`);
  const common = idsNow.filter((id) => idsThen.includes(id));
  if (canonicalJson(common) !== canonicalJson(idsThen.filter((id) => idsNow.includes(id)))) out.push('capture scenes reordered');
  for (const id of common) {
    const sa = a.scenes.find((s) => s.id === id)!;
    const sb = b.scenes.find((s) => s.id === id)!;
    const name = sceneName(id);
    const keys = Object.keys(sa.keys).filter((k) => sa.keys[k] !== sb.keys[k]);
    if (keys.length) out.push(`scene ${name}: ${keys.join(', ')}`);
    if (canonicalJson(sa.steps) === canonicalJson(sb.steps)) continue;
    const c = stepChanges(sa.steps, sb.steps);
    const parts: string[] = [];
    if (c.changed.length) parts.push(`step${c.changed.length > 1 ? 's' : ''} ${stepList(name, c.changed)} changed`);
    if (c.added.length) parts.push(`step${c.added.length > 1 ? 's' : ''} ${stepList(name, c.added)} added`);
    if (c.removed) parts.push(`${c.removed} step${c.removed > 1 ? 's' : ''} removed`);
    out.push(`scene ${name}: ${parts.join(', ') || 'steps reordered'}`);
  }
  return out;
}

/** filmedChangesOf on two texts (today's file, the run's snapshot); undefined when either does not parse. */
export function filmedChanges(now: string, then: string): string[] | undefined {
  const a = parseYaml(now);
  const b = parseYaml(then);
  if (a.value === undefined || b.value === undefined || a.issues.some((i) => i.severity === 'error') || b.issues.some((i) => i.severity === 'error')) return undefined;
  return filmedChangesOf(a.value, b.value);
}

/**
 * A small regular file read whole, or undefined: missing, a symbolic link, not a regular file (a FIFO or a device
 * would block the reader), over `max` bytes or unreadable (core readPlainFile).
 */
function readSmallPlainFile(file: string, max: number): string | undefined {
  const r = readPlainFile(file, max);
  return r.ok ? r.bytes.toString('utf8') : undefined;
}

/** `scenarios/<name>.yaml`, else `.yml` (as a name resolves). */
function scenarioFileOf(project: Pick<LoadedProject, 'dir'>, scenario: string): string | undefined {
  return [join(project.dir, 'scenarios', `${scenario}.yaml`), join(project.dir, 'scenarios', `${scenario}.yml`)].find((f) => existsSync(f));
}

/** A run's scenario against today's file (L5.5). */
export interface ScenarioSinceRun {
  /** Today's file. */
  file: string;
  /** Today's file text. */
  now: string;
  /** The run's snapshot `<run>/scenario.yaml`. */
  then: string;
  /** Whether the data differs at all (comments and formatting are no change). */
  changed: boolean;
  /** What changed in the filmed part (empty: the edit alone changed, or nothing); undefined: a text does not parse. */
  filmed?: string[];
}

/**
 * Today's scenario file of a project against a run's snapshot. Undefined when either file is missing, a symbolic link,
 * not a regular file, over SCENARIO_COMPARE_MAX_BYTES or unreadable: a run of a file elsewhere, a scenario since
 * deleted, a run without a snapshot. `scenario` is a name, never a path.
 */
export function scenarioSinceRun(project: Pick<LoadedProject, 'dir'>, runDir: string, scenario: string): ScenarioSinceRun | undefined {
  if (scenario === '' || /[\\/]/.test(scenario)) return undefined;
  const file = scenarioFileOf(project, scenario);
  if (!file) return undefined;
  const now = readSmallPlainFile(file, SCENARIO_COMPARE_MAX_BYTES);
  const then = now === undefined ? undefined : readSmallPlainFile(join(runDir, 'scenario.yaml'), SCENARIO_COMPARE_MAX_BYTES);
  if (now === undefined || then === undefined) return undefined;
  const a = parseYaml(now).value;
  const b = parseYaml(then).value;
  const changed = now !== then && (a === undefined || b === undefined || canonicalJson(a) !== canonicalJson(b));
  const filmed = changed ? filmedChanges(now, then) : [];
  return { file, now, then, changed, ...(filmed !== undefined ? { filmed } : {}) };
}

/**
 * Whether the filmed part of a scenario changed since a run captured it (L5.5): true when it did (or a text no longer
 * parses), false when only the edit changed or nothing did, undefined when either file is missing or unreadable.
 */
export function scenarioChangedSinceRun(project: Pick<LoadedProject, 'dir'>, runDir: string, scenario: string): boolean | undefined {
  const s = scenarioSinceRun(project, runDir, scenario);
  return s === undefined ? undefined : s.filmed === undefined || s.filmed.length > 0;
}

/**
 * What a plan or a render of a run says when the filmed part of its scenario changed since the capture: the render
 * shows the take as captured, its edit included; `recapture` films the change.
 * It names the scenario, the run id and the filmed parts that changed (keys, scene ids, step indexes).
 */
export function scenarioChangedMessage(scenario: string, runId: string, recapture: string, filmed?: readonly string[]): string {
  const what = filmed === undefined ? 'the file no longer reads as YAML' : filmed.slice(0, 8).join('; ') + (filmed.length > 8 ? `; and ${filmed.length - 8} more` : '');
  return `the filmed part of scenario ${scenario} changed since run ${runId} was captured (${what}): a render shows that take as it was captured, its edit included — a change to what the browser does (steps, pages, hooks, capture settings) shows only in a new capture: ${recapture}, then render; a change to the edit alone (captions, cards, overlays, durations, title, intro/outro, template) renders on the existing take`;
}

/** What a plan or a render says when only the edit changed since the capture: it renders on this take. */
export function editReplannedMessage(scenario: string, runId: string): string {
  return `edit re-planned from today's scenario ${scenario} on run ${runId}: the filmed part is unchanged, no new capture needed`;
}
