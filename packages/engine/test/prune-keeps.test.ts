/**
 * What prune keeps of a scenario's captures (L7.7, R-FLD-28), layout by layout (core/test/fixtures/records
 * prune-layouts.ts): what a dry prune lists through the engine, how many takes it keeps and what it says it kept.
 * A row marked `P-1` or `U-1` is one the decisions of the lot change (the newest take that can be edited stays; a
 * linked folder and a take of a newer Retake are left alone; the newest complete capture stays beside one stopped by
 * `--until`); `C` a row of the renders renamed by hand, which this lot must leave exactly as it is. A row without a
 * mark holds what prune answered before the lot.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LoadedProject } from '@retake/core';
import { RUN_RECORD_MAX } from '@retake/core/io';
import { createEngine, pruneApprovalFormText, pruneKey, pruneProject } from '../src/index.js';
import type { Engine } from '../src/index.js';
import { writeWorkspace } from '../../core/test/fixtures/records/build.js';
import { LAYOUTS, buildLayout } from '../../core/test/fixtures/records/prune-layouts.js';
import type { BuiltLayout, Layout } from '../../core/test/fixtures/records/prune-layouts.js';

// Every file read whole (node:fs/promises readFile) is noted, and read as ever: what a prune opens can be counted.
const { opened } = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  const readFile = ((...a: unknown[]) => {
    opened.push(String(a[0]));
    return (fs.readFile as (...a: unknown[]) => unknown)(...a);
  }) as typeof fs.readFile;
  return { ...fs, default: { ...fs, readFile }, readFile };
});

let root: string;
let engine: Engine;
const savedHome = process.env.RETAKE_HOME;
const built = new Map<string, BuiltLayout>();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'retake-prune-keeps-'));
  process.env.RETAKE_HOME = join(root, '.home');
  writeWorkspace(root);
  for (const id of Object.keys(LAYOUTS)) built.set(id, buildLayout(root, id));
  engine = await createEngine({ root, client: 'test', autoStartWorker: false });
}, 120_000);
/** The pipes a test made: a reader left waiting on one (a regression) is let go at the end. */
const pipes: string[] = [];
afterAll(() => {
  for (const p of pipes) {
    try {
      closeSync(openSync(p, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {
      // Nobody reads it: nothing to let go.
    }
  }
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

/** A run folder's name as its label in the layout. */
const label = (b: BuiltLayout, id: string): string => Object.entries(b.ids).find(([, name]) => name === id)?.[0] ?? id;

/** `run OLD (older capture nothing uses); … | kept <takes> | <what it says it kept>`. */
async function row(id: string): Promise<string> {
  const b = built.get(id)!;
  const r = await engine.projects.prune(b.slug, { dry_run: true });
  const items = r.items.map((i) => `${i.kind} ${label(b, i.id)} (${i.reason})${i.paths.length ? '' : ' no file'}`).join('; ') || 'nothing';
  const said = (r as { kept_takes?: Array<{ id: string; why: string }> }).kept_takes?.map((k) => `${label(b, k.id)} ${k.why}`).join(', ');
  return `${items} | kept ${r.kept.runs}${said ? ` | ${said}` : ''}${r.threads_unread ? ' | threads unread' : ''}`;
}

const TABLE: Record<string, string> = {
  // P-1
  A1: 'nothing | kept 2 | OLD editable',
  // P-1
  A2: 'nothing | kept 2 | OLD editable',
  // U-1
  A3: 'nothing | kept 2 | OLD complete',
  // P-1
  B1: 'nothing | kept 2 | NEW linked',
  // P-1
  B2: 'nothing | kept 2 | NEW newer-format',
  // P-1
  B2f: 'nothing | kept 2 | NEW newer-format',
  // C — L7.6b R-1: the take a renamed record names stays whatever the count of newer renders, and it is said
  C1: 'nothing | kept 2 | OLD render-file',
  // C — L7.6b R-1 (was: OLD offered, and a line `render quote-v1` without a file)
  C2: 'nothing | kept 2 | OLD render-file',
  // C — L7.6b R-1 (was: OLD offered, and `render quote-v1` twice): the renamed file says quote-v1, the real one stays
  C3: 'nothing | kept 2 | OLD render-file',
  // C
  C4: 'render quote-v2 (older render) | kept 2',
  ctl: 'run OLD (older capture nothing uses) | kept 1',
  // P-1
  two: 'run OTHER-OLD (older capture nothing uses) | kept 3 | OLD editable',
  none: 'run OLD (older capture nothing uses) | kept 1',
  // P-1
  three: 'run OLDER (older capture nothing uses) | kept 2 | OLD editable',
  rendered: 'nothing | kept 2',
  commented: 'nothing | kept 2',
  unread: 'run OTHER-OLD (older capture nothing uses) | kept 3 | threads unread',
  stale: 'nothing | kept 2',
  // P-1
  stale3: 'nothing | kept 3 | OLD editable',
  dry: 'run NEW (dry run) | kept 1',
  // P-1
  dry3: 'run NEW (dry run) | kept 2 | OLD editable',
  // P-1
  hand: 'nothing | kept 2 | OLD editable',
  // P-1
  frames: 'nothing | kept 2 | OLD editable',
  // P-1
  linkfilm: 'nothing | kept 2 | OLD editable',
  // P-1
  handmade: 'nothing | kept 2 | OLD editable',
  // P-1, U-1
  until3: 'nothing | kept 3 | MID editable, OLD complete',
  // U-1
  until4: 'run OLDER (older capture nothing uses) | kept 2 | OLD complete',
  untils: 'run OLD (older capture nothing uses) | kept 1',
  // P-1
  linkfail: 'nothing | kept 2 | NEW linked',
  // P-1
  dangling: 'nothing | kept 2 | NEW linked',
  // P-1
  linkold: 'nothing | kept 2 | OLD linked',
  // P-1
  newerdry: 'nothing | kept 2 | NEW newer-format',
  norecord: 'nothing | kept 2',
  nojson: 'nothing | kept 2',
  odd: 'nothing | kept 2',
  interrupted: 'run NEW (interrupted take) | kept 1',
  barefail: 'run NEW (failed take) | kept 1',
  // P-1
  bareok: 'nothing | kept 2 | OLD editable',
  reclink: 'run NEW (failed take) | kept 1',
  other: 'nothing | kept 2',
  // P-1 (a newer record behind a linked run.json: read by prune's own read, left alone all the same)
  newerlink: 'nothing | kept 2 | NEW newer-format',
  // P-1
  newerlinkok: 'nothing | kept 2 | NEW newer-format',
};

describe('what prune keeps of a scenario\'s captures, layout by layout', () => {
  it('every layout: what a dry prune lists, how many takes it keeps, what it says', async () => {
    const got: Record<string, string> = {};
    for (const id of Object.keys(LAYOUTS)) got[id] = await row(id);
    expect(got).toEqual(TABLE);
  }, 120_000);
});

describe('what the result says, and what a deletion leaves', () => {
  /** Which run folders of the layout are still there, by label. */
  const left = (b: BuiltLayout): string[] => Object.entries(b.ids).filter(([, name]) => existsSync(join(b.runs, name))).map(([l]) => l);
  const fresh = (id: string, n: string): BuiltLayout => buildLayout(root, id, { slug: `d-${id.toLowerCase()}-${n}` });

  it('`kept_takes`: the take, why, and the fixed words — newest first; absent when the rule alone keeps nothing', async () => {
    const b = built.get('until3')!;
    const r = await engine.projects.prune(b.slug, { dry_run: true });
    expect(r.kept_takes).toEqual([
      { id: b.ids.MID, why: 'editable', reason: 'the last capture that can be edited' },
      { id: b.ids.OLD, why: 'complete', reason: 'the last complete capture (a newer one was stopped by --until)' },
    ]);
    expect((await engine.projects.prune(built.get('B1')!.slug)).kept_takes).toEqual([{ id: built.get('B1')!.ids.NEW, why: 'linked', reason: 'its folder is a link (left alone)' }]);
    expect((await engine.projects.prune(built.get('B2')!.slug)).kept_takes).toEqual([{ id: built.get('B2')!.ids.NEW, why: 'newer-format', reason: 'written by a newer Retake (left alone)' }]);
    // Newest first, the folders left alone among the takes kept: an older linked folder comes after the take kept above it.
    const mixed = fresh('A1', 'mixed');
    symlinkSync(join(root, 'outside'), join(mixed.runs, '20260930-100000-quote'));
    expect((await engine.projects.prune(mixed.slug)).kept_takes?.map((k) => `${label(mixed, k.id)} ${k.why}`)).toEqual(['OLD editable', '20260930-100000-quote linked']);
    // The take that can be edited is the newest succeeded one, or a render or a thread already keeps it: nothing to say.
    for (const id of ['ctl', 'rendered', 'commented', 'unread', 'none']) expect(await engine.projects.prune(built.get(id)!.slug), id).not.toHaveProperty('kept_takes');
  });

  it('a deletion keeps the take that can be edited (A1, A2), the complete one (A3) and what it leaves alone; what it lists still goes', async () => {
    for (const id of ['A1', 'A2', 'A3', 'B1', 'B2', 'B2f']) {
      const b = fresh(id, 'yes');
      const r = await engine.projects.prune(b.slug, { dry_run: false });
      expect([id, r.items.length, r.problems, left(b)]).toEqual([id, 0, [], ['OLD', 'NEW']]);
    }
    const two = fresh('two', 'yes');
    const r = await engine.projects.prune(two.slug, { dry_run: false });
    expect([r.items.map((i) => label(two, i.id)), left(two), r.kept_takes?.map((k) => `${label(two, k.id)} ${k.why}`)]).toEqual([['OTHER-OLD'], ['OLD', 'NEW', 'OTHER-NEW'], ['OLD editable']]);
    const until4 = fresh('until4', 'yes');
    await engine.projects.prune(until4.slug, { dry_run: false });
    expect(left(until4)).toEqual(['OLD', 'NEW']);
  });

  it('a linked run folder is never deleted: the link and what it points at stay, also when its record says failed', async () => {
    const b = fresh('linkfail', 'yes');
    const r = await engine.projects.prune(b.slug, { dry_run: false });
    const target = join(root, 'outside', b.slug, b.ids.NEW);
    expect([r.items, lstatSync(join(b.runs, b.ids.NEW)).isSymbolicLink(), existsSync(join(target, 'run.json')), left(b)]).toEqual([[], true, true, ['OLD', 'NEW']]);
  });

  it('an approved take that became the last one that can be edited since the list stays (skipped), and the result says why', async () => {
    const b = fresh('ctl', 'only');
    const project = { slug: b.slug, dir: b.dir, root, config: { name: 'P', environments: {} }, readme: null, scenarios: [], file: join(b.dir, 'project.yaml') } as unknown as LoadedProject;
    const listed = await pruneProject(project, { dry_run: true });
    expect(listed.items.map((i) => label(b, i.id))).toEqual(['OLD']);
    // The newer capture loses its film between the list and the approval.
    rmSync(join(b.runs, b.ids.NEW, 'capture.mp4'));
    const r = await pruneProject(project, { dry_run: false, only: new Map(listed.items.map((i) => [pruneKey(i), i.paths])) });
    expect([r.items, r.skipped, r.kept_takes?.map((k) => `${label(b, k.id)} ${k.why}`), left(b)]).toEqual([[], [{ kind: 'run', id: b.ids.OLD }], ['OLD editable'], ['OLD', 'NEW']]);
  });

  it('only the newest take of each reason stays for it: older captures that can be edited still go', async () => {
    const b = built.get('three')!;
    const r = await engine.projects.prune(b.slug, { dry_run: true });
    expect([r.items.map((i) => `${label(b, i.id)} ${i.reason}`), r.kept.runs]).toEqual([['OLDER older capture nothing uses'], 2]);
  });

  it('a thread file that does not read still names the scenario of a folder left alone (by its id; a newer record by its scenario)', async () => {
    const sentence = (slug: string) => `some comment threads of ${slug} cannot be read (the comment list says which): every render and take of quote is kept`;
    // (`dangling`: a link to nothing was a folder prune could not read and said nothing of; it is a folder left alone now.)
    for (const id of ['linkfail', 'B2f', 'dangling']) {
      const b = fresh(id, 'thread');
      rmSync(join(b.runs, b.ids.OLD), { recursive: true });
      mkdirSync(join(b.dir, 'comments', 'quote'), { recursive: true });
      writeFileSync(join(b.dir, 'comments', 'quote', 'c_01K8AB1CDE2FGH3JKM4NPQ5RST.json'), '{');
      const r = await engine.projects.prune(b.slug, { dry_run: true });
      expect([id, r.items, r.kept.runs, r.threads_unread]).toEqual([id, [], 1, sentence(b.slug)]);
    }
  });

  it('a record of a newer Retake behind a linked run.json is left alone: a deletion keeps it, whatever it says; a linked record this Retake reads still goes', async () => {
    for (const id of ['newerlink', 'newerlinkok']) {
      const b = fresh(id, 'yes');
      const r = await engine.projects.prune(b.slug, { dry_run: false });
      expect([id, r.items, r.kept.runs, r.kept_takes, left(b)]).toEqual([id, [], 2, [{ id: b.ids.NEW, why: 'newer-format', reason: 'written by a newer Retake (left alone)' }], ['OLD', 'NEW']]);
      expect(existsSync(join(root, 'outside', b.slug, `${b.ids.NEW}.run.json`))).toBe(true);
    }
    const b = fresh('reclink', 'yes');
    const r = await engine.projects.prune(b.slug, { dry_run: false });
    expect([r.items.map((i) => `${label(b, i.id)} ${i.reason}`), left(b)]).toEqual([['NEW failed take'], ['OLD']]);
  });

  it('a run.json prune\'s own read does not open — over the reader\'s cap, a pipe, a link to one or to a folder — says nothing: the take is kept and counted, never listed', async () => {
    const said = async (b: BuiltLayout): Promise<unknown[]> => {
      const r = await engine.projects.prune(b.slug, { dry_run: true });
      return [r.items.map((i) => `${label(b, i.id)} ${i.reason}`), r.kept.runs, r.kept_takes];
    };
    // Over the cap: a failed take's record, padded past what the reader reads (read whole before, and listed).
    const big = fresh('barefail', 'big');
    const record = JSON.parse(readFileSync(join(big.runs, big.ids.NEW, 'run.json'), 'utf8')) as Record<string, unknown>;
    expect(await said(big)).toEqual([['NEW failed take'], 1, undefined]);
    writeFileSync(join(big.runs, big.ids.NEW, 'run.json'), JSON.stringify({ ...record, pad: 'x'.repeat(RUN_RECORD_MAX) }));
    opened.length = 0;
    expect(await said(big)).toEqual([[], 2, undefined]);
    expect(opened.filter((f) => f.startsWith(join(big.runs, big.ids.NEW)))).toEqual([]);
    // A link to a folder.
    const folder = fresh('barefail', 'folder');
    rmSync(join(folder.runs, folder.ids.NEW, 'run.json'));
    symlinkSync(join(folder.runs, folder.ids.OLD), join(folder.runs, folder.ids.NEW, 'run.json'));
    expect(await said(folder)).toEqual([[], 2, undefined]);
    // A pipe, and a link to one: never opened (a read of it would wait for ever).
    if (process.platform !== 'win32') {
      for (const how of ['pipe', 'link']) {
        const b = fresh('barefail', how);
        const file = join(b.runs, b.ids.NEW, 'run.json');
        rmSync(file);
        const pipe = how === 'pipe' ? file : join(root, `${b.slug}.pipe`);
        execFileSync('mkfifo', [pipe]);
        pipes.push(pipe);
        if (how === 'link') symlinkSync(pipe, file);
        expect([how, ...(await said(b))]).toEqual([how, [], 2, undefined]);
      }
    }
  }, 20_000);

  it('a timeline is opened only for a capture that may be one to keep: one stopped by --until once the take that can be edited is found, or one whose folder holds no film, costs its run.json alone', async () => {
    /** The timelines a dry prune of `runs` (newest last) reads whole, by label, and what it lists. */
    const reads = async (n: string, states: string[]): Promise<[string[], string[]]> => {
      const layout: Layout = { about: 'cost', runs: states.map((state, i) => [`R${i + 1}`, i + 1, state]) };
      const b = buildLayout(root, 'cost', { slug: `cost-${n}`, layout });
      opened.length = 0;
      const r = await engine.projects.prune(b.slug, { dry_run: true });
      return [opened.filter((f) => f.startsWith(b.runs) && f.endsWith('timeline.json')).map((f) => label(b, f.slice(b.runs.length + 1).split('/')[0])).sort(), r.items.map((i) => label(b, i.id))];
    };
    // Six captures stopped by --until and no complete one: the newest is the one that can be edited; no other is opened.
    expect(await reads('until', ['t6', 't6', 't6', 't6', 't6', 't6'])).toEqual([['R6'], ['R1', 'R2', 'R3', 'R4', 'R5']]);
    // Six captures whose film was removed: none can be a take, none is opened.
    expect(await reads('nofilm', ['g', 'g', 'g', 'g', 'g', 'g'])).toEqual([[], ['R1', 'R2', 'R3', 'R4', 'R5']]);
    // The usual project: the newest capture is all three; nothing older is opened.
    expect(await reads('good', ['good', 'good', 'good', 'good'])).toEqual([['R4'], ['R1', 'R2', 'R3']]);
    // Films removed above a stopped capture above a complete one: the two that matter are opened, and kept.
    expect(await reads('mixed', ['good', 'good', 't6', 't6', 'g', 'g'])).toEqual([['R2', 'R4'], ['R1', 'R3', 'R5']]);
    // Still opened, one by one: captures with a film whose timeline does not read (no complete take is ever found).
    expect(await reads('cut', ['l', 'l', 'l'])).toEqual([['R1', 'R2', 'R3'], ['R1', 'R2']]);
  });

  it('the form a person approves says what stays: the take that can be edited, the complete one, and what is left alone', () => {
    const text = pruneApprovalFormText({ what: 'prune', project: 'p', keep_renders: 3, count: 1, bytes: 1000, by_kind: [{ kind: 'run', count: 1, bytes: 1000 }], lines: ['take 20261001-100000-quote — failed take, 1 kB'], more: 0, fix: 'retake prune p --yes' });
    expect(text.split('\n')[1]).toBe(
      'Kept: the last good take of each scenario, the last one that can still be edited and the last complete one, the last 3 renders of each scenario and variant, whatever a kept render, a comment thread or a queued or running job uses; a run folder that is a link and a take written by a newer Retake are left alone, and so is a file of renders/ that is no render of its own name, or a record that lacks a member, with the render and the take it names; exports/ is not touched.',
    );
    // L7.6b: the files of renders/ left alone are said with a count, never a name.
    const alone = (n: number) => pruneApprovalFormText({ what: 'prune', project: 'p', keep_renders: 3, count: 1, bytes: 1000, by_kind: [{ kind: 'run', count: 1, bytes: 1000 }], lines: ['take 20261001-100000-quote — failed take, 1 kB'], more: 0, fix: 'retake prune p --yes', renders_alone: n }).split('\n')[2];
    expect([alone(1), alone(2)]).toEqual(['1 file of renders/ is no render of its own name, or lacks a member: left alone, with the renders and the takes it names.', '2 files of renders/ are no render of their own name, or lack a member: left alone, with the renders and the takes they name.']);
  });
});
