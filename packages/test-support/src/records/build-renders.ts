/**
 * Builds the renders/ folders of render-states.json in a temp workspace (test data only: see README.md). One project
 * per state: two good captures of `quote` (OLD and NEW, build.ts's control state) and the render records the state
 * names. Shared by the records tests of every package, which each hold their own expected answers.
 */
import { mkdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILM, RECORDS_DIR, buildState } from './build.js';
import type { BuiltState } from './build.js';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

export interface RenderFileSpec {
  /** The file's base name (without .json). */
  file: string;
  /** The id the record says (default: the file's name). */
  id?: string;
  run?: 'OLD' | 'NEW';
  at?: string;
  set?: Obj;
  unset?: string[];
  raw?: string;
  link?: true;
  /** renders/<file>.json is a link to nothing. */
  dangling?: true;
  /** The record's file is made bigger than any reader's cap (a sparse file: the record's text, then zeros up to 17 MB — no JSON any more). */
  big?: true;
  video?: false;
  film?: 'alt';
  only?: 'lock' | 'video';
}
export interface RenderStateSpec {
  about: string;
  base?: RenderFileSpec[];
  files: RenderFileSpec[];
}
export interface RenderStates {
  scenario: string;
  record: Obj;
  base: RenderFileSpec[];
  states: Record<string, RenderStateSpec>;
}

/** render-states.json, read by path (a JSON file read with readFileSync is not an import). */
export const RENDER_STATES = JSON.parse(readFileSync(join(RECORDS_DIR, 'render-states.json'), 'utf8')) as RenderStates;

function setPath(o: Obj, path: string, v: Json | undefined): void {
  const keys = path.split('.');
  let at = o;
  for (const k of keys.slice(0, -1)) at = (at[k] ??= {}) as Obj;
  if (v === undefined) delete at[keys[keys.length - 1]];
  else at[keys[keys.length - 1]] = v;
}

export interface RenderVars {
  /** The project folder. */
  dir: string;
  project: string;
  old: string;
  new: string;
}

/** The text of the record of `spec` (undefined: the entry writes no record). */
export function renderRecordText(spec: RenderFileSpec, vars: RenderVars): string | undefined {
  if (spec.only) return undefined;
  if (spec.raw !== undefined) return spec.raw;
  const id = spec.id ?? spec.file;
  const o = structuredClone(RENDER_STATES.record) as Obj;
  const version = /-v(\d+)(?:-vertical|-square)?$/.exec(id);
  // Where the writer puts it: after `record`, before `created_at`.
  const ordered: Obj = {};
  for (const [k, v] of Object.entries(o)) {
    ordered[k] = v;
    if (k === 'record' && version) ordered.render_version = Number(version[1]);
  }
  for (const [k, v] of Object.entries(spec.set ?? {})) setPath(ordered, k, v);
  for (const k of spec.unset ?? []) setPath(ordered, k, undefined);
  return (
    JSON.stringify(ordered, null, 2)
      .replaceAll('$ID', id)
      .replaceAll('$FILE', spec.file)
      .replaceAll('$DIR', vars.dir)
      .replaceAll('$PROJECT', vars.project)
      .replaceAll('$RUN', spec.run === 'OLD' ? vars.old : vars.new)
      .replaceAll('$AT', spec.at ?? '2026-10-02T09:00:00.000Z') + '\n'
  );
}

export interface RenderFilms {
  /** The video written beside a record. */
  film?: Buffer;
  /** The video of an entry that says `film: alt` (other bytes). */
  alt?: Buffer;
}

/** One entry of a state written into `renders` (the folder is made). `outside`: where a linked record's target goes. */
export function writeRenderFile(renders: string, spec: RenderFileSpec, vars: RenderVars, o: RenderFilms & { outside: string } = { outside: join(renders, '..', '..', '..', 'outside') }): void {
  mkdirSync(renders, { recursive: true });
  const video = () => writeFileSync(join(renders, `${spec.file}.mp4`), spec.film === 'alt' ? (o.alt ?? Buffer.concat([o.film ?? FILM, Buffer.from('alt')])) : (o.film ?? FILM));
  if (spec.only === 'lock') return void writeFileSync(join(renders, `.${spec.file}.lock`), `${JSON.stringify({ pid: 1, at: '2026-10-02T09:02:00.000Z' })}\n`);
  if (spec.only === 'video') return void video();
  const text = renderRecordText(spec, vars);
  if (text === undefined) return;
  const file = join(renders, `${spec.file}.json`);
  if (spec.dangling) return void symlinkSync(join(o.outside, vars.project, 'gone', `${spec.file}.json`), file);
  if (spec.link) {
    const target = join(o.outside, vars.project, `${spec.file}.json`);
    mkdirSync(join(o.outside, vars.project), { recursive: true });
    writeFileSync(target, text);
    symlinkSync(target, file);
  } else writeFileSync(file, text);
  if (spec.big) truncateSync(spec.link ? join(o.outside, vars.project, `${spec.file}.json`) : file, 17 * 1024 * 1024);
  if (spec.video !== false && spec.raw === undefined) video();
}

export interface BuiltRenders extends BuiltState {
  /** The project's renders/ folder. */
  renders: string;
  state: string;
}

/** Project `r-<state>` of `root`: OLD and NEW (two good captures) and the renders of the state. */
export function buildRenderState(root: string, state: string, o: RenderFilms & { slug?: string; runFilm?: Buffer } = {}): BuiltRenders {
  const spec = RENDER_STATES.states[state];
  if (!spec) throw new Error(`no state ${state} in render-states.json`);
  const b = buildState(root, 'ctl', { slug: o.slug ?? `r-${state}`, ...(o.runFilm ? { film: o.runFilm } : {}) });
  const renders = join(b.dir, 'renders');
  const vars: RenderVars = { dir: b.dir, project: b.slug, old: b.old, new: b.new };
  mkdirSync(renders, { recursive: true });
  for (const f of [...(spec.base ?? RENDER_STATES.base), ...spec.files]) writeRenderFile(renders, f, vars, { ...o, outside: join(root, 'outside') });
  return { ...b, renders, state };
}

/** The ids of the states of render-states.json. */
export function renderStateIds(): string[] {
  return Object.keys(RENDER_STATES.states);
}
