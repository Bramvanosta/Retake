/**
 * Builds the run folders of states.json in a temp workspace (test data only: see README.md). One project per state:
 * `projects/<slug>/runs/` holds OLD (a good capture) and NEW in the state named. Shared by the records tests of every
 * package, which each hold their own expected answers.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECORDS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = join(RECORDS_DIR, '..', '..', '..', '..', '..');

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };
type Part = { raw: string } | { value: Json } | { fixture?: string; set?: Obj; unset?: string[] };
export interface StateSpec {
  about: string;
  name?: string;
  folder?: 'dir' | 'link-out' | 'dangling' | 'files';
  record?: Part | null;
  timeline?: Part | null;
  film?: 'file' | 'link' | 'none';
  frames?: true;
  named_only?: true;
}
export interface States {
  scenario: string;
  old: string;
  new: string;
  timeline_fixture: string;
  record: Obj;
  states: Record<string, StateSpec>;
}

/** states.json, read by path (a JSON file read with readFileSync is not an import). */
export const STATES = JSON.parse(readFileSync(join(RECORDS_DIR, 'states.json'), 'utf8')) as States;
/** A file of this folder, parsed. */
export const recordFixture = (rel: string): Json => JSON.parse(readFileSync(join(RECORDS_DIR, rel), 'utf8')) as Json;
const TIMELINE = (): Obj => JSON.parse(readFileSync(join(REPO, STATES.timeline_fixture), 'utf8')) as Obj;

export const SCENARIO_YAML = 'video: quote\nscenes:\n  - id: one\n    open: /\n    steps:\n      - click: First\n';
export const PROJECT_YAML = 'name: P\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n';
/** Bytes for a film nothing decodes. */
export const FILM = Buffer.from('not really a video');

function setPath(o: Obj, path: string, v: Json | undefined): void {
  const keys = path.split('.');
  let at = o;
  for (const k of keys.slice(0, -1)) at = (at[k] ??= {}) as Obj;
  if (v === undefined) delete at[keys[keys.length - 1]];
  else at[keys[keys.length - 1]] = v;
}

/** The text of one file of a state (undefined: no file). `vars`: what `$ID`, `$DIR` and `$PROJECT` become. */
export function partText(base: Obj, part: Part | null | undefined, vars: { id: string; dir: string; project: string }): string | undefined {
  if (part === null) return undefined;
  if (part && 'raw' in part) return part.raw;
  let value: Json;
  if (part && 'value' in part) value = part.value;
  else {
    const o = part?.fixture ? (recordFixture(part.fixture) as Obj) : (structuredClone(base) as Obj);
    for (const [k, v] of Object.entries(part?.set ?? {})) setPath(o, k, v);
    for (const k of part?.unset ?? []) setPath(o, k, undefined);
    value = o;
  }
  return JSON.stringify(value, null, 2).replaceAll('$ID', vars.id).replaceAll('$DIR', vars.dir).replaceAll('$PROJECT', vars.project) + '\n';
}

/** The run.json text of a state for a folder (undefined: none). */
export function recordText(spec: StateSpec, vars: { id: string; dir: string; project: string }): string | undefined {
  return partText(STATES.record, spec.record, vars);
}

/** The timeline.json text of a state for a folder (undefined: none). */
export function timelineText(spec: StateSpec, vars: { id: string; dir: string; project: string }): string | undefined {
  return partText({ ...TIMELINE(), run_id: vars.id, project: vars.project }, spec.timeline, vars);
}

/** One run folder at `dir`, named `id`, in the state `spec`. */
export function writeRunFolder(dir: string, id: string, project: string, spec: StateSpec, film: Buffer = FILM): void {
  mkdirSync(dir, { recursive: true });
  const vars = { id, dir, project };
  const record = recordText(spec, vars);
  if (record !== undefined) writeFileSync(join(dir, 'run.json'), record);
  const timeline = timelineText(spec, vars);
  if (timeline !== undefined) writeFileSync(join(dir, 'timeline.json'), timeline);
  if ((spec.film ?? 'file') === 'file') writeFileSync(join(dir, 'capture.mp4'), film);
  if (spec.film === 'link') {
    const target = join(dirname(dirname(dirname(dirname(dir)))), 'outside', `${project}-film.mp4`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, film);
    symlinkSync(target, join(dir, 'capture.mp4'));
  }
  if (spec.frames) {
    mkdirSync(join(dir, 'frames'), { recursive: true });
    writeFileSync(join(dir, 'frames', '000001.png'), 'png');
    writeFileSync(join(dir, 'frames.jsonl'), '{"file":"frames/000001.png","t":0}\n');
  }
}

export interface BuiltState {
  slug: string;
  /** The project folder. */
  dir: string;
  runs: string;
  old: string;
  /** NEW's folder name. */
  new: string;
  /** NEW's path under runs/ (a link for the linked states; absent files for `files`). */
  newDir: string;
}

/** The workspace file of a temp root (the repository's templates). */
export function writeWorkspace(root: string): void {
  writeFileSync(join(root, 'retake.yaml'), `version: 1\nprojects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
}

/**
 * Project `s-<state>` of `root` with OLD and NEW. `old`: 'good' (default), 'no-film' (OLD's film removed: the
 * sensitivity rows) or 'none' (NEW alone).
 */
export function buildState(root: string, state: string, o: { old?: 'good' | 'no-film' | 'none'; film?: Buffer; slug?: string } = {}): BuiltState {
  const spec = STATES.states[state];
  if (!spec) throw new Error(`no state ${state} in states.json`);
  const slug = o.slug ?? `s-${state}`;
  const dir = join(root, 'projects', slug);
  const runs = join(dir, 'runs');
  mkdirSync(join(dir, 'scenarios'), { recursive: true });
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(dir, 'project.yaml'), PROJECT_YAML);
  writeFileSync(join(dir, 'scenarios', 'quote.yaml'), SCENARIO_YAML);
  writeFileSync(join(dir, 'scenarios', 'other.yaml'), SCENARIO_YAML.replace('video: quote', 'video: other'));
  if (o.old !== 'none') {
    const oldDir = join(runs, STATES.old);
    writeRunFolder(oldDir, STATES.old, slug, { about: 'OLD', film: o.old === 'no-film' ? 'none' : 'file', record: { set: { started_at: '2026-10-01T08:00:00.000Z', finished_at: '2026-10-01T08:01:00.000Z' } } }, o.film);
  }
  const name = spec.name ?? STATES.new;
  const newDir = join(runs, name);
  const folder = spec.folder ?? 'dir';
  if (folder === 'dir') writeRunFolder(newDir, name, slug, spec, o.film);
  else if (folder === 'link-out') {
    const target = join(root, 'outside', slug, name);
    writeRunFolder(target, name, slug, spec, o.film);
    symlinkSync(target, newDir);
  } else if (folder === 'dangling') symlinkSync(join(root, 'outside', slug, 'gone'), newDir);
  else {
    writeFileSync(join(runs, '.DS_Store'), 'x');
    writeFileSync(join(runs, 'notes.txt'), 'x');
  }
  return { slug, dir, runs, old: STATES.old, new: name, newDir };
}

/** The ids of the states of states.json; `named`: with those that only a named run reaches. */
export function stateIds(o: { named?: boolean } = {}): string[] {
  return Object.keys(STATES.states).filter((s) => o.named || !STATES.states[s].named_only);
}
