/**
 * Projects for what prune keeps (L7.7; test data only: see README.md): each layout is one project whose runs/ holds a
 * few run folders in the states of states.json, with the renders and comment threads named. Shared by the prune tests
 * of the engine and of the CLI, which each hold their own expected answers.
 *
 * A run is `[label, day, state, options]`: its folder is `202610<day>-100000-<scenario>` (a later day is a newer run),
 * its files those of the state (`good`: the control, a capture with its record, timeline and film).
 */
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_YAML, SCENARIO_YAML, STATES, writeRunFolder } from './build.js';
import type { StateSpec } from './build.js';

export interface LayoutRunOptions {
  /** The scenario the record and the timeline name (default `quote`). */
  scenario?: string;
  /** The folder's name, when it is not a dated one. */
  name?: string;
  /** run.json moved out of the project and linked from the run folder. */
  linkedRecord?: true;
}
export type LayoutRun = [label: string, day: number, state: string | StateSpec, options?: LayoutRunOptions];
export interface LayoutRender {
  id: string;
  /** The label of the run it was made on. */
  run: string;
  /** Minutes after 2026-10-20T09:00Z (a later one is a newer render). */
  at: number;
  /** The files' name when it is not the id (a render renamed by hand). */
  file?: string;
}
export interface LayoutThread {
  scenario: string;
  /** A thread made on this render id and this run (by label); absent: a thread file that is no JSON. */
  on?: { render: string; run: string };
}
export interface Layout {
  about: string;
  runs: LayoutRun[];
  renders?: LayoutRender[];
  threads?: LayoutThread[];
}

/** A run.json of five members: no record for the reader of the run folders (a finished run has its end), an object with an id and a status all the same. */
export const BARE = (status: string, mode = 'capture'): StateSpec => ({ about: `a record of five members saying ${mode}, ${status}`, record: { value: { version: 1, id: '$ID', scenario: 'quote', mode, status } } });

/**
 * The layouts. A1 – C4: the situations of the open decisions (§1); the others: the lot's own. The comment over each
 * says what it shows.
 */
export const LAYOUTS: Record<string, Layout> = {
  // ── The situations of the decision ──
  A1: { about: 'NEW succeeded, its film gone; OLD the only take that can be edited', runs: [['OLD', 1, 'good'], ['NEW', 2, 'g']] },
  A2: { about: 'NEW succeeded, its timeline cut short', runs: [['OLD', 1, 'good'], ['NEW', 2, 'l']] },
  A3: { about: 'NEW stopped by --until; OLD the complete capture', runs: [['OLD', 1, 'good'], ['NEW', 2, 't6']] },
  B1: { about: 'NEW a symbolic link to a good take stored elsewhere', runs: [['OLD', 1, 'good'], ['NEW', 2, 'k1']] },
  B2: { about: 'NEW written by a newer Retake, succeeded', runs: [['OLD', 1, 'good'], ['NEW', 2, 'o']] },
  B2f: { about: 'NEW written by a newer Retake, failed', runs: [['OLD', 1, 'good'], ['NEW', 2, 'of']] },
  C1: { about: 'a render renamed by hand, made on OLD, among the newest renders', runs: [['OLD', 1, 'good'], ['NEW', 2, 'good']], renders: [{ id: 'quote-v1', run: 'OLD', at: 0, file: 'quote-final' }] },
  C2: {
    about: 'the same once three newer renders exist',
    runs: [['OLD', 1, 'good'], ['NEW', 2, 'good']],
    renders: [{ id: 'quote-v1', run: 'OLD', at: 0, file: 'quote-final' }, { id: 'quote-v2', run: 'NEW', at: 2 }, { id: 'quote-v3', run: 'NEW', at: 3 }, { id: 'quote-v4', run: 'NEW', at: 4 }],
  },
  C3: {
    about: 'the same, and a new render took the number',
    runs: [['OLD', 1, 'good'], ['NEW', 2, 'good']],
    renders: [{ id: 'quote-v1', run: 'OLD', at: 0, file: 'quote-final' }, { id: 'quote-v1', run: 'NEW', at: 1 }, { id: 'quote-v2', run: 'NEW', at: 2 }, { id: 'quote-v3', run: 'NEW', at: 3 }, { id: 'quote-v4', run: 'NEW', at: 4 }],
  },
  C4: {
    about: 'a render written under its own name, made on OLD',
    runs: [['OLD', 1, 'good'], ['NEW', 2, 'good']],
    renders: [{ id: 'quote-final', run: 'OLD', at: 0 }, { id: 'quote-v2', run: 'NEW', at: 2 }, { id: 'quote-v3', run: 'NEW', at: 3 }, { id: 'quote-v4', run: 'NEW', at: 4 }, { id: 'quote-v5', run: 'NEW', at: 5 }],
  },

  // ── The lot's own ──
  ctl: { about: 'the take that can be edited IS the newest succeeded one', runs: [['OLD', 1, 'good'], ['NEW', 2, 'good']] },
  two: {
    about: 'two scenarios in one project: quote as A1, other with two good captures',
    runs: [['OLD', 1, 'good'], ['NEW', 2, 'g'], ['OTHER-OLD', 3, 'good', { scenario: 'other' }], ['OTHER-NEW', 4, 'good', { scenario: 'other' }]],
  },
  none: { about: 'no take that can be edited at all: both captures lost their film', runs: [['OLD', 1, 'g'], ['NEW', 2, 'g']] },
  three: { about: 'three captures, the newest without its film: only the newest one that can be edited stays for it', runs: [['OLDER', 1, 'good'], ['OLD', 2, 'good'], ['NEW', 3, 'g']] },
  rendered: { about: 'A1, the take that can be edited already kept by a render', runs: [['OLD', 1, 'good'], ['NEW', 2, 'g']], renders: [{ id: 'quote-v1', run: 'OLD', at: 0 }] },
  commented: { about: 'A1, the take that can be edited already kept by a comment thread', runs: [['OLD', 1, 'good'], ['NEW', 2, 'g']], threads: [{ scenario: 'quote', on: { render: 'quote-v9', run: 'OLD' } }] },
  unread: {
    about: 'A1 with a thread file of quote that does not read (threads_unread), beside two good captures of other',
    runs: [['OLD', 1, 'good'], ['NEW', 2, 'g'], ['OTHER-OLD', 3, 'good', { scenario: 'other' }], ['OTHER-NEW', 4, 'good', { scenario: 'other' }]],
    threads: [{ scenario: 'quote' }],
  },
  stale: { about: 'the newest take still says running (its process died), with its film', runs: [['OLD', 1, 'good'], ['NEW', 2, 't7']] },
  stale3: { about: 'a stale running take over a capture without its film over a good one', runs: [['OLD', 1, 'good'], ['MID', 2, 'g'], ['NEW', 3, 't7']] },
  dry: { about: 'a dry run newest', runs: [['OLD', 1, 'good'], ['NEW', 2, 'f']] },
  dry3: { about: 'a dry run over a capture without its film over a good one', runs: [['OLD', 1, 'good'], ['MID', 2, 'g'], ['NEW', 3, 'f']] },
  hand: { about: 'a folder named by hand holding a good capture, beside A1', runs: [['OLD', 1, 'good'], ['NEW', 2, 'g'], ['HAND', 0, 'good', { name: 'zz-quote' }]] },
  frames: { about: 'NEW kept its frames and has no film', runs: [['OLD', 1, 'good'], ['NEW', 2, 'gf']] },
  linkfilm: { about: 'the film of NEW is a symbolic link inside a real folder', runs: [['OLD', 1, 'good'], ['NEW', 2, 't9']] },
  handmade: { about: 'the timeline of NEW was made by hand (no run id in it)', runs: [['OLD', 1, 'good'], ['NEW', 2, 'hr']] },
  until3: { about: 'a capture without its film over one stopped by --until over a complete one', runs: [['OLD', 1, 'good'], ['MID', 2, 't6'], ['NEW', 3, 'g']] },
  until4: { about: 'A3 over two complete captures: only the newest complete one stays for it', runs: [['OLDER', 1, 'good'], ['OLD', 2, 'good'], ['NEW', 3, 't6']] },
  untils: { about: 'two captures stopped by --until and no complete one', runs: [['OLD', 1, 't6'], ['NEW', 2, 't6']] },
  linkfail: { about: 'NEW a symbolic link to a failed take stored elsewhere', runs: [['OLD', 1, 'good'], ['NEW', 2, 'k1f']] },
  dangling: { about: 'NEW a symbolic link to nothing', runs: [['OLD', 1, 'good'], ['NEW', 2, 'k2']] },
  linkold: { about: 'OLD a symbolic link to a good take, NEW a good capture', runs: [['OLD', 1, 'k1'], ['NEW', 2, 'good']] },
  newerdry: { about: 'a dry run written by a newer Retake', runs: [['OLD', 1, 'good'], ['NEW', 2, { about: 'newer, dry', record: { set: { version: 2, mode: 'dry' } } }]] },
  norecord: { about: 'NEW holds a run.json that is an empty list', runs: [['OLD', 1, 'good'], ['NEW', 2, 's']] },
  nojson: { about: 'NEW holds no run.json', runs: [['OLD', 1, 'good'], ['NEW', 2, 'k']] },
  odd: { about: 'NEW has a status Retake never writes', runs: [['OLD', 1, 'good'], ['NEW', 2, 'r']] },
  interrupted: { about: 'NEW says interrupted (a status prune lists; no writer of this repository puts it in a run record)', runs: [['OLD', 1, 'good'], ['NEW', 2, { about: 'interrupted', record: { set: { status: 'interrupted' } } }]] },
  barefail: { about: 'NEW: a run.json of five members saying failed (no end, no error): no record for the reader', runs: [['OLD', 1, 'good'], ['NEW', 2, BARE('failed')]] },
  bareok: { about: 'NEW: a run.json of five members saying succeeded (no end): no record for the reader', runs: [['OLD', 1, 'good'], ['NEW', 2, BARE('succeeded')]] },
  reclink: { about: 'the run.json of NEW (failed) is a symbolic link inside a real folder', runs: [['OLD', 1, 'good'], ['NEW', 2, 'c', { linkedRecord: true }]] },
  other: { about: 'the record of NEW names another scenario', runs: [['OLD', 1, 'good'], ['NEW', 2, 'p']] },
  newerlink: { about: 'the run.json of NEW (written by a newer Retake, failed) is a symbolic link inside a real folder', runs: [['OLD', 1, 'good'], ['NEW', 2, 'of', { linkedRecord: true }]] },
  newerlinkok: { about: 'the same, the newer record saying succeeded', runs: [['OLD', 1, 'good'], ['NEW', 2, 'o', { linkedRecord: true }]] },
};

export interface BuiltLayout {
  slug: string;
  dir: string;
  runs: string;
  /** label → the folder's name. */
  ids: Record<string, string>;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The state of a run with its record and timeline naming `scenario`. */
function ofScenario(spec: StateSpec, scenario: string | undefined): StateSpec {
  if (scenario === undefined) return spec;
  const part = (p: StateSpec['record']): StateSpec['record'] => {
    if (p === null || (p && ('raw' in p || 'value' in p))) return p;
    return { ...p, set: { ...p?.set, scenario } };
  };
  return { ...spec, record: part(spec.record), timeline: part(spec.timeline) };
}

/** The project `slug` of `root` in the layout `id` — or in `o.layout`, a layout of the caller's own (a generated one). */
export function buildLayout(root: string, id: string, o: { slug?: string; film?: Buffer; layout?: Layout } = {}): BuiltLayout {
  const layout = o.layout ?? LAYOUTS[id];
  if (!layout) throw new Error(`no layout ${id}`);
  const slug = o.slug ?? `p-${id.toLowerCase()}`;
  const dir = join(root, 'projects', slug);
  const runs = join(dir, 'runs');
  mkdirSync(join(dir, 'scenarios'), { recursive: true });
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(dir, 'project.yaml'), PROJECT_YAML);
  writeFileSync(join(dir, 'scenarios', 'quote.yaml'), SCENARIO_YAML);
  writeFileSync(join(dir, 'scenarios', 'other.yaml'), SCENARIO_YAML.replace('video: quote', 'video: other'));
  const ids: Record<string, string> = {};
  for (const [label, day, state, options] of layout.runs) {
    const scenario = options?.scenario ?? 'quote';
    const name = options?.name ?? `202610${pad(day)}-100000-${scenario}`;
    ids[label] = name;
    const base = typeof state === 'string' ? (state === 'good' ? ({ about: 'good' } as StateSpec) : STATES.states[state]) : state;
    if (!base) throw new Error(`no state ${String(state)}`);
    const spec = ofScenario({ ...base, record: base.record === undefined ? { set: { started_at: `2026-10-${pad(day)}T08:00:00.000Z`, finished_at: `2026-10-${pad(day)}T08:01:00.000Z` } } : base.record }, options?.scenario);
    const at = join(runs, name);
    const folder = spec.folder ?? 'dir';
    if (folder === 'dir') writeRunFolder(at, name, slug, spec, o.film);
    else if (folder === 'link-out') {
      const target = join(root, 'outside', slug, name);
      writeRunFolder(target, name, slug, spec, o.film);
      symlinkSync(target, at);
    } else if (folder === 'dangling') symlinkSync(join(root, 'outside', slug, 'gone'), at);
    else throw new Error(`layout ${id}: folder ${folder}`);
    if (options?.linkedRecord) {
      // The record moved out of the project and linked from the run folder.
      const target = join(root, 'outside', slug, `${name}.run.json`);
      mkdirSync(join(root, 'outside', slug), { recursive: true });
      renameSync(join(at, 'run.json'), target);
      symlinkSync(target, join(at, 'run.json'));
    }
  }
  for (const r of layout.renders ?? []) {
    mkdirSync(join(dir, 'renders'), { recursive: true });
    const file = r.file ?? r.id;
    const at = `2026-10-20T09:${pad(r.at)}:00.000Z`;
    writeFileSync(join(dir, 'renders', `${file}.json`), JSON.stringify({ version: 1, id: r.id, scenario: 'quote', run_id: ids[r.run], status: 'succeeded', created_at: at, variant: 'landscape', template: 'editorial', plan: {} }));
    writeFileSync(join(dir, 'renders', `${file}.mp4`), 'mp4');
  }
  for (const [n, t] of (layout.threads ?? []).entries()) {
    const thread = `c_01K8AB1CDE2FGH3JKM4NPQ5RS${'TVWXYZ'[n]}`;
    mkdirSync(join(dir, 'comments', t.scenario), { recursive: true });
    const text = t.on
      ? JSON.stringify({
          version: 1,
          id: thread,
          scenario: t.scenario,
          render: { id: t.on.render, created_at: '2026-10-20T09:30:00.000Z', run_id: ids[t.on.run], variant: 'landscape', fps: 30, frames: 300, width: 1920, height: 1080 },
          frame: 10,
          time_s: 0.33,
          text: 'The caption is too long here',
          author: { via: 'cli', name: 'Reviewer' },
          created_at: '2026-10-20T10:00:00.000Z',
          anchor: { segment: 'intro', kind: 'intro' },
          entries: [],
        })
      : '{';
    writeFileSync(join(dir, 'comments', t.scenario, `${thread}.json`), text);
  }
  return { slug, dir, runs, ids };
}
