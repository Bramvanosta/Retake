/**
 * The one reader of a run folder (L7.6a, core/io run-folder.ts) and, through it, the two rules of core take.ts over the
 * whole table of states (test/fixtures/records/states.json; OLD: a good capture of `quote`; NEW: the state named):
 * the run `latest` names with what it passes over, and a run named by its folder at a terminal and through MCP.
 * These are the answers every site gives once it uses the rules.
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat, readFile, readdir as readdirAsync, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latestTake, namedRunProblem, orderRuns, relativeInside, takeNeedsTimeline, takeOf, takeWords } from '../src/index.js';
import type { LatestPick, RunFolderFacts } from '../src/index.js';
import { RUN_RECORD_MAX, TIMELINE_MAX, readNamedRun, readNamedRunFolder, readRunFolder, readRunRecord, readTimeline, readTimelineHead } from '../src/io/index.js';
import type { RunFolderFs } from '../src/io/index.js';
import { STATES, buildState, stateIds, writeRunFolder } from './fixtures/records/build.js';
import type { BuiltState } from './fixtures/records/build.js';

let root: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'retake-run-folder-')));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const problemOf = (r: { ok: true } | { ok: false; problem: string }): string => (r.ok ? 'ok' : r.problem);
const who = (b: BuiltState, id: string): string => (id === b.old ? 'OLD' : id === b.new ? 'NEW' : id);

/** `latest` of the scenario over a project's runs/, as every site resolves it: the order, then the rule on each folder read. */
async function latest(b: BuiltState, scenario: string | null = STATES.scenario): Promise<{ pick: LatestPick; looked: string[] }> {
  const looked: string[] = [];
  const pick = await latestTake(orderRuns(readdirSync(b.runs)), scenario ?? undefined, async (id) => {
    looked.push(id);
    // The record first; the timeline only when the record does not already decide (as every site reads).
    return takeOf(await readRunFolder(b.runs, id, { timeline: (record) => takeNeedsTimeline(record, scenario ?? undefined) }));
  });
  return { pick, looked };
}
function said(b: BuiltState, p: LatestPick): string {
  const parts = [p.take ? who(b, p.take.run) : 'none'];
  if (p.take?.until) parts.push(`until ${p.take.until.scene}.${p.take.until.step}`);
  if (p.passed.length) parts.push(`passed ${p.passed.map((x) => `${who(b, x.run)} ${takeWords(x.why, { run: x.run, verb: 'render' })}`).join('; ')}`);
  if (p.without_record) parts.push(`${p.without_record} without a record`);
  if (p.only_newer) parts.push('only newer');
  return parts.join(' | ');
}

describe('`latest`, state by state: the take and what it passed over', () => {
  /** Per state: the answer of `latest` for `quote`. Marked: the decision or the fix that makes it differ from the site that differs most today. */
  const LATEST: Record<string, string> = {
    ctl: 'NEW',
    a: 'OLD | passed NEW not finished, or interrupted', // D-1
    b: 'OLD | passed NEW not finished, or interrupted', // D-1
    c: 'OLD | passed NEW failed', // D-1, D-2
    d: 'OLD | passed NEW failed', // D-1
    e: 'OLD | passed NEW cancelled', // D-1
    f: 'OLD', // a dry run is never passed over
    g: 'OLD | passed NEW its film is missing', // D-1
    gn: 'OLD | passed NEW its timeline is missing', // D-1
    gf: 'OLD | passed NEW its film is missing', // D-1 (kept frames are not a film)
    h: 'NEW', // F-2
    i: 'NEW', // D-8
    j: 'OLD | 1 without a record', // D-3
    k: 'OLD | 1 without a record', // D-3
    l: 'OLD | passed NEW its timeline does not read', // D-1
    o: 'OLD | passed NEW written by a newer Retake', // D-6
    of: 'OLD | passed NEW written by a newer Retake', // D-6
    p: 'OLD', // D-5: the record says another scenario
    p2: 'OLD', // D-5
    r: 'OLD | passed NEW its status is not one Retake writes', // D-1
    s: 'OLD | 1 without a record', // D-3 (small point 3.5: no record)
    m: 'OLD', // D-4: a dated run first (NEW is never looked at)
    m2: 'OLD', // D-4
    q: 'NEW', // D-5: the record says quote, whatever the folder is called
    t5: 'NEW', // the timeline names no film: capture.mp4
    t6: 'NEW | until catalog.1', // U-1: usable; the take says where it stopped
    t7: 'OLD | passed NEW not finished, or interrupted', // D-1 (its process is gone: the record cannot say so)
    t9: 'OLD | passed NEW its files are links', // D-7 (small point 3.1)
    hr: 'OLD | passed NEW its timeline does not read', // a head made by hand is for a run someone names (before: NEW)
    hf: 'OLD | passed NEW its timeline does not read', // the same
    v: 'NEW', // D-8: a word or a block this build does not know never loses a run
    k1: 'OLD', // D-7: a linked folder is never read
    k1f: 'OLD', // D-7
    k2: 'OLD', // F-1
    k3: 'OLD',
    z: 'NEW', // by design (small point 3.3)
  };

  it('every state of the table', async () => {
    expect(Object.keys(LATEST).sort()).toEqual(stateIds().sort());
    const got: Record<string, string> = {};
    for (const id of Object.keys(LATEST)) {
      const b = buildState(root, id);
      got[id] = said(b, (await latest(b)).pick);
    }
    expect(got).toEqual(LATEST);
  });

  it('NEW alone: the take, or nothing with what was passed over', async () => {
    const alone = async (id: string) => {
      const b = buildState(root, id, { old: 'none', slug: `alone-${id}` });
      return said(b, (await latest(b)).pick);
    };
    expect(await alone('m')).toBe('NEW');
    expect(await alone('h')).toBe('NEW');
    expect(await alone('c')).toBe('none | passed NEW failed');
    expect(await alone('k')).toBe('none | 1 without a record');
    expect(await alone('f')).toBe('none');
    expect(await alone('k1')).toBe('none');
    // D-6: the only capture is of a newer format — the caller says "update Retake".
    expect(await alone('o')).toBe('none | passed NEW written by a newer Retake | only newer');
  });

  it('lazy: nothing older than the take is read; a folder named to sort first is read last', async () => {
    const b = buildState(root, 'c', { slug: 'lazy' });
    writeRunFolder(join(b.runs, '20260901-100000-quote'), '20260901-100000-quote', 'lazy', { about: 'older' });
    writeRunFolder(join(b.runs, 'zz-quote'), 'zz-quote', 'lazy', { about: 'hand-named' });
    expect((await latest(b)).looked).toEqual([b.new, b.old]);
  });

  it('without a scenario: the newest usable take of any', async () => {
    const any = async (id: string) => {
      const b = buildState(root, id, { slug: `any-${id}` });
      return said(b, (await latest(b, null)).pick);
    };
    expect(await any('p')).toBe('NEW'); // a good capture of `other`
    expect(await any('p2')).toBe('OLD | passed NEW its timeline is of another scenario');
    expect(await any('ctl')).toBe('NEW');
  });
});

describe('a run named by its folder, state by state: at a terminal, then through MCP', () => {
  /** What the named rule answers for NEW read through links: `works` or the refusal's sentence. */
  async function named(b: BuiltState, trust: 'author' | 'mcp'): Promise<string> {
    const facts = await readNamedRunFolder(b.newDir);
    let inside = false;
    try {
      inside = relativeInside(realpathSync(b.newDir), realpathSync(b.dir), { self: false }) !== undefined;
    } catch {
      inside = false;
    }
    const p = namedRunProblem(facts, { scenario: STATES.scenario, trust, inside });
    return p === null ? 'works' : takeWords(p, { run: 'NEW', verb: 'render', dir: 'DIR' });
  }
  const NO_TIMELINE = 'run NEW has no timeline.json (DIR)';
  const NO_FILM = 'run NEW has no capture video (DIR/capture.mp4)';
  const NEWER = 'run NEW: this run.json is version 2: it was made for a newer Retake (this one reads version 1) — update Retake';
  /** Per state: the refusal (the same at a terminal and through MCP unless two are given). A state not listed works. */
  const REFUSED: Record<string, string | [terminal: string, mcp: string]> = {
    a: NO_TIMELINE,
    b: NO_TIMELINE,
    d: NO_FILM,
    e: NO_FILM,
    f: 'run NEW is a dry run: there is no capture to render',
    g: NO_FILM,
    gn: NO_TIMELINE,
    gf: NO_FILM,
    l: 'run NEW: its timeline does not read (timeline.json is not JSON)', // F-4
    o: NEWER,
    of: NEWER,
    p: 'run NEW is a run of scenario "other", not "quote"',
    k1: ['works', 'run NEW is a link to a folder outside the project: through MCP a render reads only the runs inside it'], // D-7
    k1f: ['works', 'run NEW is a link to a folder outside the project: through MCP a render reads only the runs inside it'], // D-7
    k2: NO_TIMELINE,
    k3: NO_TIMELINE,
    // A film that is a link: at a terminal as it always was; through MCP the files of a named run are its folder's own.
    t9: ['works', 'run NEW: its files are links: through MCP a render reads only the files of the run folder itself'],
  };

  it('every state of the table: a named run works whatever its record says', async () => {
    const got: Record<string, string | [string, string]> = {};
    for (const id of stateIds({ named: true })) {
      const b = buildState(root, id, { slug: `named-${id.toLowerCase()}` });
      const [terminal, mcp] = [await named(b, 'author'), await named(b, 'mcp')];
      if (terminal !== 'works' || mcp !== 'works') got[id] = terminal === mcp ? terminal : [terminal, mcp];
    }
    // Works, among others: a failed take with its film (c), no record or one that does not read (j, k, s), another
    // scenario in the record only (p2), any status (r, t7), any folder name (m, q, t8), a timeline made by hand
    // without its run id or its film's name (hr, hf: as before this lot), a record of a later version (v).
    expect(got).toEqual(REFUSED);
  });

  it('a linked run folder that resolves inside the project works through MCP too', async () => {
    const b = buildState(root, 'ctl', { slug: 'named-inside' });
    symlinkSync(join(b.runs, b.old), join(b.runs, 'alias'));
    expect(await named({ ...b, newDir: join(b.runs, 'alias') }, 'mcp')).toBe('works');
  });
});

describe('readRunFolder: the facts of a folder met in a listing', () => {
  const facts = (f: RunFolderFacts) => `${f.folder} | record ${problemOf(f.record)}${f.recordLink ? ' (link)' : ''} | timeline ${problemOf(f.timeline)}${f.timelineLink ? ' (link)' : ''} | film ${f.film}`;

  it('a real folder, a linked one (nothing behind it is read), a dangling link, a plain file, a name that is not there', async () => {
    const b = buildState(root, 'k1', { slug: 'facts' });
    expect(facts(await readRunFolder(b.runs, b.old))).toBe('dir | record ok | timeline ok | film file');
    expect(facts(await readRunFolder(b.runs, b.new))).toBe('link | record missing | timeline missing | film missing');
    symlinkSync(join(root, 'nowhere'), join(b.runs, 'dangling'));
    expect(facts(await readRunFolder(b.runs, 'dangling'))).toBe('link | record missing | timeline missing | film missing');
    writeFileSync(join(b.runs, 'notes.txt'), 'x');
    expect(facts(await readRunFolder(b.runs, 'notes.txt'))).toBe('other | record missing | timeline missing | film missing');
    expect(facts(await readRunFolder(b.runs, 'gone'))).toBe('gone | record missing | timeline missing | film missing');
    // Read through the link only when the run was named.
    expect(facts(await readNamedRunFolder(b.newDir))).toBe('link | record ok | timeline ok | film file');
    expect(facts(await readNamedRunFolder(join(b.runs, 'dangling')))).toBe('gone | record missing | timeline missing | film missing');
    expect(facts(await readNamedRunFolder(join(b.runs, 'notes.txt')))).toBe('other | record missing | timeline missing | film missing');
  });

  it('files that are links, a film that is a link, a file that is a folder', async () => {
    const b = buildState(root, 't9', { slug: 'file-links' });
    expect(facts(await readRunFolder(b.runs, b.new))).toBe('dir | record ok | timeline ok | film link');
    expect(facts(await readNamedRunFolder(b.newDir))).toBe('dir | record ok | timeline ok | film link');
    // run.json and timeline.json as links to real files: not read in a listing, read (and flagged) for a named run.
    const dir = join(b.runs, '20261003-100000-quote');
    mkdirSync(dir);
    symlinkSync(join(b.runs, b.old, 'run.json'), join(dir, 'run.json'));
    symlinkSync(join(b.runs, b.old, 'timeline.json'), join(dir, 'timeline.json'));
    symlinkSync(join(root, 'nowhere.mp4'), join(dir, 'capture.mp4'));
    expect(facts(await readRunFolder(b.runs, '20261003-100000-quote'))).toBe('dir | record not-a-file (link) | timeline not-a-file (link) | film link');
    // A film that is a link to nothing: a link in a listing, missing for a named run (as it always was).
    expect(facts(await readNamedRunFolder(dir))).toBe('dir | record ok (link) | timeline ok (link) | film missing');
    // A folder where a file is expected (as a FIFO or a device would be: not a regular file).
    const odd = join(b.runs, '20261004-100000-quote');
    mkdirSync(join(odd, 'run.json'), { recursive: true });
    mkdirSync(join(odd, 'timeline.json'));
    mkdirSync(join(odd, 'capture.mp4'));
    expect(facts(await readRunFolder(b.runs, '20261004-100000-quote'))).toBe('dir | record not-a-file | timeline not-a-file | film other');
  });

  it('the film is a file of the folder: a name that leaves it is not one', async () => {
    const b = buildState(root, 'ctl', { slug: 'film-name' });
    for (const [name, want] of [['../' + b.old + '/capture.mp4', 'other'], ['sub/capture.mp4', 'other'], ['..', 'other'], ['film.mp4', 'missing'], ['capture.mp4', 'file']] as const) {
      const dir = join(b.runs, b.new);
      const tl = JSON.parse(await readFile(join(b.runs, b.old, 'timeline.json'), 'utf8')) as { capture: { file: string } };
      tl.capture.file = name;
      writeFileSync(join(dir, 'timeline.json'), JSON.stringify(tl));
      expect((await readRunFolder(b.runs, b.new)).film, name).toBe(want);
    }
  });

  it('a file over its cap is not read; a file that cannot be read says so', async () => {
    const b = buildState(root, 'ctl', { slug: 'caps' });
    const sized = (size: number): RunFolderFs => ({
      lstat: async (p) => {
        const st = await lstat(p);
        return /\.json$/.test(p) ? { isFile: () => st.isFile(), isDirectory: () => st.isDirectory(), isSymbolicLink: () => st.isSymbolicLink(), size } : st;
      },
      stat,
      readFile: (p) => readFile(p, 'utf8'),
    });
    expect(facts(await readRunFolder(b.runs, b.new, { fs: sized(RUN_RECORD_MAX + 1) }))).toBe('dir | record too-big | timeline ok | film file');
    expect(facts(await readRunFolder(b.runs, b.new, { fs: sized(TIMELINE_MAX + 1) }))).toBe('dir | record too-big | timeline too-big | film file');
    expect(facts(await readRunFolder(b.runs, b.new, { fs: sized(RUN_RECORD_MAX) }))).toBe('dir | record ok | timeline ok | film file');
    const denied: RunFolderFs = { lstat, stat, readFile: () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) };
    expect(facts(await readRunFolder(b.runs, b.new, { fs: denied }))).toBe('dir | record unreadable | timeline unreadable | film file');
  });
});

describe('readRunFolder for a walk over many runs: the record first, the timeline only when it may be the take', () => {
  const counting = (reads: string[]): RunFolderFs => ({ lstat, stat, readFile: (p) => (reads.push(p.split('/').slice(-2).join('/')), readFile(p, 'utf8')) });

  it('a record that already rules the run out: timeline.json is not opened (said `not-read`), and the verdict is the same', async () => {
    for (const [id, opened] of [['ctl', true], ['c', false], ['e', false], ['f', false], ['a', false], ['r', false], ['o', false], ['k', false], ['s', false], ['t7', false], ['t6', true], ['g', true], ['l', true]] as const) {
      const b = buildState(root, id, { slug: `lazy-read-${id}` });
      const reads: string[] = [];
      const lazy = await readRunFolder(b.runs, b.new, { fs: counting(reads), timeline: (record) => takeNeedsTimeline(record, STATES.scenario) });
      expect(reads.includes(`${b.new}/timeline.json`), id).toBe(opened);
      // Not opened: `not-read`; state a has no timeline.json at all, which is said without opening anything.
      expect(problemOf(lazy.timeline), id).toBe(opened ? problemOf((await readRunFolder(b.runs, b.new)).timeline) : id === 'a' ? 'missing' : 'not-read');
      expect(takeOf(lazy), id).toEqual(takeOf(await readRunFolder(b.runs, b.new)));
    }
    // A capture of another scenario than the one asked is not opened either.
    const b = buildState(root, 'p', { slug: 'lazy-read-other' });
    const reads: string[] = [];
    await readRunFolder(b.runs, b.new, { fs: counting(reads), timeline: (record) => takeNeedsTimeline(record, STATES.scenario) });
    expect(reads).toEqual([`${b.new}/run.json`]);
    // Without the question every file is read, as a caller that needs the facts of one folder expects.
    reads.length = 0;
    await readRunFolder(b.runs, b.new, { fs: counting(reads) });
    expect(reads.sort()).toEqual([`${b.new}/run.json`, `${b.new}/timeline.json`]);
  });

  it('`filmFirst`: a timeline the record asks for is not opened when the folder holds no file that could be its film; the verdict is "not usable" either way', async () => {
    const opened = async (b: BuiltState, o: { filmFirst?: boolean } = { filmFirst: true }): Promise<[boolean, string, boolean]> => {
      const reads: string[] = [];
      const fs: RunFolderFs = { ...counting(reads), readdir: (p) => readdirAsync(p, { withFileTypes: true }) };
      const facts = await readRunFolder(b.runs, b.new, { fs, timeline: (record) => takeNeedsTimeline(record), ...o });
      return [reads.includes(`${b.new}/timeline.json`), problemOf(facts.timeline), takeOf(facts).usable];
    };
    // The film is gone (state g), with the files a runner leaves beside it and a hidden one: nothing to open.
    const g = buildState(root, 'g', { slug: 'film-first-g' });
    for (const f of ['frames.jsonl', 'log.jsonl', 'hooks-journal.json', 'scenario.yaml', '.DS_Store']) writeFileSync(join(g.runs, g.new, f), '');
    mkdirSync(join(g.runs, g.new, 'screenshots'));
    expect(await opened(g)).toEqual([false, 'not-read', false]);
    // Without the option the timeline is read, as `latest` reads it (its notice says the film is missing).
    expect(await opened(g, {})).toEqual([true, 'ok', false]);
    expect(takeOf(await readRunFolder(g.runs, g.new, { timeline: (record) => takeNeedsTimeline(record) }))).toMatchObject({ usable: false, why: 'no-film' });
    // A film is there, under whatever name: opened, and the take is the one the rule gives without the option.
    for (const id of ['ctl', 't6', 'h', 't5', 'hf']) {
      const b = buildState(root, id, { slug: `film-first-${id}` });
      expect([id, ...(await opened(b))]).toEqual([id, true, 'ok', takeOf(await readRunFolder(b.runs, b.new)).usable]);
    }
    const named = buildState(root, 'g', { slug: 'film-first-named' });
    writeFileSync(join(named.runs, named.new, 'capture-vertical.mp4'), 'film');
    expect((await opened(named))[0]).toBe(true);
    // A film that is a link is no file of the folder: not opened, no take (as the rule says of a linked film).
    const t9 = buildState(root, 't9', { slug: 'film-first-t9' });
    expect(await opened(t9)).toEqual([false, 'not-read', false]);
    expect(takeOf(await readRunFolder(t9.runs, t9.new)).usable).toBe(false);
    // No timeline.json at all is still said as missing; a record that rules the run out is asked nothing more.
    const gn = buildState(root, 'gn', { slug: 'film-first-gn' });
    expect(await opened(gn)).toEqual([false, 'missing', false]);
    // A file system that cannot list a folder: the timeline is opened, as without the option.
    const reads: string[] = [];
    await readRunFolder(g.runs, g.new, { fs: counting(reads), timeline: (record) => takeNeedsTimeline(record), filmFirst: true });
    expect(reads.includes(`${g.new}/timeline.json`)).toBe(true);
  });

  it('a link is still said first without the timeline: a linked timeline.json, a linked film under its usual name', async () => {
    const b = buildState(root, 'c', { slug: 'lazy-read-links' });
    const dir = join(b.runs, b.new);
    rmSync(join(dir, 'timeline.json'));
    symlinkSync(join(b.runs, b.old, 'timeline.json'), join(dir, 'timeline.json'));
    const facts = await readRunFolder(b.runs, b.new, { timeline: (record) => takeNeedsTimeline(record) });
    expect([problemOf(facts.timeline), facts.timelineLink, facts.film]).toEqual(['not-read', true, 'file']);
    expect(takeOf(facts)).toMatchObject({ usable: false, why: 'linked' });
    const t9 = buildState(root, 't9', { slug: 'lazy-read-film' });
    writeFileSync(join(t9.runs, t9.new, 'run.json'), JSON.stringify({ ...JSON.parse(await readFile(join(t9.runs, t9.new, 'run.json'), 'utf8')), status: 'failed', error: { message: 'x' } }));
    expect(takeOf(await readRunFolder(t9.runs, t9.new, { timeline: (record) => takeNeedsTimeline(record) }))).toMatchObject({ usable: false, why: 'linked' });
  });

  it('`latest` under 200 newer runs its record rules out opens one timeline: the take\'s', async () => {
    const b = buildState(root, 'ctl', { slug: 'lazy-walk' });
    for (let i = 0; i < 200; i++) {
      const id = `202611${String(1 + (i % 28)).padStart(2, '0')}-10${String(Math.floor(i / 28)).padStart(2, '0')}${String(i % 60).padStart(2, '0')}-${i % 2 ? 'other' : 'quote'}`;
      // Failed takes of the scenario, and good captures of another one.
      writeRunFolder(join(b.runs, id), id, 'lazy-walk', i % 2 ? { about: 'other', record: { set: { scenario: 'other' } }, timeline: { set: { scenario: 'other' } } } : STATES.states.c);
    }
    const reads: string[] = [];
    const fs = counting(reads);
    const pick = await latestTake(orderRuns(readdirSync(b.runs)), STATES.scenario, async (id) => takeOf(await readRunFolder(b.runs, id, { fs, timeline: (record) => takeNeedsTimeline(record, STATES.scenario) })));
    expect([pick.take?.run, pick.passed.length + pick.passed_more]).toEqual([b.new, 100]);
    expect(reads.filter((f) => f.endsWith('/timeline.json'))).toEqual([`${b.new}/timeline.json`]);
    expect(reads.filter((f) => f.endsWith('/run.json')).length).toBe(201);
  });
});

describe('one file of a run', () => {
  it('readRunRecord, readTimelineHead and readTimeline: the value or the problem, never a throw', async () => {
    const b = buildState(root, 'l', { slug: 'one-file' });
    const old = join(b.runs, b.old);
    expect((await readRunRecord(join(old, 'run.json'))).ok).toBe(true);
    expect(problemOf(await readRunRecord(join(old, 'nope.json')))).toBe('missing');
    expect(problemOf(await readRunRecord(join(old, 'capture.mp4')))).toBe('not-json');
    expect(problemOf(await readRunRecord(join(old, 'timeline.json')))).toBe('invalid');
    expect(await readTimelineHead(join(old, 'timeline.json'))).toEqual({ ok: true, value: { mode: 'capture', scenario: 'quote', run_id: b.old, film: 'capture.mp4' }, notes: [] });
    expect(problemOf(await readTimelineHead(join(b.newDir, 'timeline.json')))).toBe('not-json');
    const whole = await readTimeline(join(old, 'timeline.json'));
    expect(whole.ok && [whole.value.run_id, Array.isArray(whole.value.events), whole.value.scenes.length > 0]).toEqual([b.old, true, true]);
    expect(problemOf(await readTimeline(join(b.newDir, 'timeline.json')))).toBe('not-json');
    // A head alone is no timeline: its lists must be lists.
    writeFileSync(join(b.newDir, 'timeline.json'), JSON.stringify({ version: 1, run_id: 'r', scenario: 'quote', mode: 'capture', capture: { file: '' }, events: [], markers: {} }));
    expect(await readTimeline(join(b.newDir, 'timeline.json'))).toEqual({ ok: false, problem: 'invalid', detail: 'markers' });
    expect((await readTimelineHead(join(b.newDir, 'timeline.json'))).ok).toBe(true);
    // A link is not read unless asked.
    symlinkSync(join(old, 'run.json'), join(b.newDir, 'linked.json'));
    expect(problemOf(await readRunRecord(join(b.newDir, 'linked.json')))).toBe('not-a-file');
    expect(problemOf(await readRunRecord(join(b.newDir, 'linked.json'), { follow: true }))).toBe('ok');
  });
});

describe('readNamedRun: a named run and its whole timeline in one read', () => {
  it('the facts readNamedRunFolder gives and the timeline readTimeline gives, with timeline.json and run.json read once each', async () => {
    const reads: string[] = [];
    const counted: RunFolderFs = { lstat, stat, readFile: (p) => (reads.push(p.split('/').pop() ?? p), readFile(p, 'utf8')) };
    for (const id of ['ctl', 'c', 'l', 'f', 'gn', 'o', 'k1', 's', 't5']) {
      const b = buildState(root, id, { slug: `named-run-${id}` });
      const dir = join(b.runs, b.new);
      reads.length = 0;
      const one = await readNamedRun(dir, { fs: counted });
      expect(reads.filter((f) => f === 'timeline.json').length, id).toBeLessThanOrEqual(1);
      expect(reads.filter((f) => f === 'run.json').length, id).toBeLessThanOrEqual(1);
      expect(one.facts, id).toEqual(await readNamedRunFolder(dir));
      expect(one.timeline, id).toEqual(await readTimeline(join(dir, 'timeline.json'), { follow: true }));
    }
    // The control: both files are there and each was read exactly once; the timeline is whole.
    const b = buildState(root, 'ctl', { slug: 'named-run-once' });
    reads.length = 0;
    const one = await readNamedRun(join(b.runs, b.new), { fs: counted });
    expect(reads.sort()).toEqual(['run.json', 'timeline.json']);
    expect(one.timeline.ok && Array.isArray(one.timeline.value.events)).toBe(true);
    // A folder that is not there: no timeline, never a throw.
    expect(await readNamedRun(join(b.runs, 'nope'))).toMatchObject({ facts: { folder: 'gone' }, timeline: { ok: false, problem: 'missing' } });
    // A head that reads and lists that are not lists: the facts say a timeline, the whole says why not.
    writeFileSync(join(b.runs, b.new, 'timeline.json'), JSON.stringify({ version: 1, run_id: b.new, scenario: 'quote', mode: 'capture', capture: { file: '' }, events: 'none', markers: [], scenes: [] }));
    const half = await readNamedRun(join(b.runs, b.new));
    expect([half.facts.timeline.ok, half.timeline]).toEqual([true, { ok: false, problem: 'invalid', detail: 'events' }]);
  });
});
