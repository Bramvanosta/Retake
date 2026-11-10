/**
 * The take and the two rules (L7.6a, core take.ts), on facts — no disk: whether a capture can be edited (`takeOf`),
 * the named run's own rule (`namedRunProblem`), the order of runs (`orderRuns`) and `latest` (`latestTake`).
 * The same rules over the whole table of states, read from real folders: run-folder.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { PASSED_OVER_MAX, isFilmName, latestTake, namedRunProblem, orderRuns, parseRunId, parseRunRecord, parseTimeline, parseTimelineHead, takeNeedsTimeline, takeOf, takeWords, timelineProblem, untilStep } from '../src/index.js';
import type { NotUsable, RunFolderFacts, RunId, TakeVerdict } from '../src/index.js';
import { recordFixture } from './fixtures/records/build.js';
import { STATES, recordText } from './fixtures/records/build.js';

const NAME = '20261002-100000-quote';
const record = (o: Record<string, unknown> = {}, drop: string[] = []) => {
  const v = { ...(JSON.parse(recordText({ about: 'base' }, { id: NAME, dir: '/w/runs/x', project: 'p' })!) as Record<string, unknown>), ...o };
  for (const k of drop) delete v[k];
  return parseRunRecord(v);
};
const head = (o: Record<string, unknown> = {}, drop: string[] = []) => {
  const v: Record<string, unknown> = { version: 1, run_id: NAME, project: 'p', scenario: 'quote', mode: 'capture', capture: { file: 'capture.mp4' }, events: [], markers: [], scenes: [], ...o };
  for (const k of drop) delete v[k];
  return parseTimelineHead(v);
};
/** A good capture's facts, with what differs. */
const facts = (o: Partial<RunFolderFacts> = {}): RunFolderFacts => ({ name: NAME, folder: 'dir', record: record(), timeline: head(), film: 'file', recordLink: false, timelineLink: false, ...o });
const why = (f: RunFolderFacts): string => {
  const v = takeOf(f);
  return v.usable ? 'usable' : `${v.why}${v.capture ? ' capture' : ''}${v.scenario !== undefined ? ` of ${v.scenario}` : ''}`;
};
const FAILED = { status: 'failed', error: { message: 'no' } };

describe('takeOf: a usable capture', () => {
  it('a succeeded capture with its timeline and its film: the take', () => {
    expect(takeOf(facts())).toEqual({ usable: true, take: { run: NAME, scenario: 'quote', film: 'capture.mp4', finished_at: '2026-10-02T08:01:00.000Z' } });
    // The film a timeline names; `capture.mp4` when it names none.
    expect(takeOf(facts({ timeline: head({ capture: { file: '' } }) }))).toMatchObject({ usable: true, take: { film: 'capture.mp4' } });
    expect(takeOf(facts({ timeline: head({ capture: { file: 'film.mp4' } }) }))).toMatchObject({ usable: true, take: { film: 'film.mp4' } });
  });

  it('a capture stopped by --until is usable, and the take says where it stopped', () => {
    const v = takeOf(facts({ record: record({ stopped_at: { scene: 'one', step: 1, reason: 'until' }, options: { hooks: 'run', headed: false, until: 'one.1' } }) }));
    expect(v).toMatchObject({ usable: true, take: { until: { scene: 'one', step: 1 } } });
    // Stopped for another reason: not `until`.
    expect(takeOf(facts({ record: record({ stopped_at: { scene: 'one', step: 1, reason: 'irreversible' } }) }))).toEqual(takeOf(facts()));
  });

  it('each reason, with what the record says of itself', () => {
    const rows: Array<[string, RunFolderFacts, string]> = [
      ['a name that is no run id', facts({ name: 'my take' }), 'not-a-run-id'],
      ['a name of 201 characters', facts({ name: 'a'.repeat(201) }), 'not-a-run-id'],
      ['a linked folder (nothing read)', facts({ folder: 'link', record: { ok: false, problem: 'missing' }, timeline: { ok: false, problem: 'missing' }, film: 'missing' }), 'linked'],
      ['a linked run.json', facts({ recordLink: true, record: { ok: false, problem: 'not-a-file' } }), 'linked'],
      ['a linked timeline.json', facts({ timelineLink: true, timeline: { ok: false, problem: 'not-a-file' } }), 'linked capture of quote'],
      ['a linked film', facts({ film: 'link' }), 'linked capture of quote'],
      ['a plain file, or an entry gone', facts({ folder: 'other', record: { ok: false, problem: 'missing' } }), 'not-a-run-id'],
      ['no run.json', facts({ record: { ok: false, problem: 'missing' } }), 'no-record'],
      ['no run.json, its timeline not opened', facts({ record: { ok: false, problem: 'missing' }, timeline: { ok: false, problem: 'not-read' } }), 'no-record'],
      // Neither file: an empty folder, one being made — no run folder at all, never counted by `latest`.
      ['neither run.json nor timeline.json', facts({ record: { ok: false, problem: 'missing' }, timeline: { ok: false, problem: 'missing' }, film: 'missing' }), 'not-a-run-id'],
      ['run.json is not JSON', facts({ record: { ok: false, problem: 'not-json' } }), 'record-unreadable'],
      ['run.json is no record', facts({ record: parseRunRecord([]) }), 'record-unreadable'],
      ['run.json too big', facts({ record: { ok: false, problem: 'too-big' } }), 'record-unreadable'],
      ['a newer format', facts({ record: parseRunRecord({ version: 2, scenario: 'quote' }) }), 'newer-format capture of quote'],
      ['a newer format that names no scenario', facts({ record: parseRunRecord({ version: 2 }) }), 'newer-format capture'],
      // A dry run of a newer format is no capture: `latest` never says it passed one over.
      ['a dry run of a newer format', facts({ record: parseRunRecord({ version: 2, scenario: 'quote', mode: 'dry' }) }), 'newer-format of quote'],
      ['a status Retake never writes', facts({ record: record({ status: 'done' }) }), 'unknown-status capture of quote'],
      ['a dry run', facts({ record: record({ mode: 'dry' }), timeline: head({ mode: 'dry', capture: { file: '' } }), film: 'missing' }), 'dry-run of quote'],
      ['a record of a capture over a dry timeline', facts({ timeline: head({ mode: 'dry' }) }), 'dry-run capture of quote'],
      ['queued', facts({ record: record({ status: 'queued' }, ['finished_at', 'capture', 'timeline']), timeline: { ok: false, problem: 'missing' }, film: 'missing' }), 'not-finished capture of quote'],
      ['running, with its timeline and its film', facts({ record: record({ status: 'running' }, ['finished_at']) }), 'not-finished capture of quote'],
      ['failed, with its film', facts({ record: record(FAILED) }), 'failed capture of quote'],
      ['cancelled', facts({ record: record({ status: 'cancelled', error: { message: 'cancelled' } }), film: 'missing' }), 'cancelled capture of quote'],
      ['no timeline', facts({ timeline: { ok: false, problem: 'missing' } }), 'no-timeline capture of quote'],
      ['timeline.json is not JSON', facts({ timeline: { ok: false, problem: 'not-json' } }), 'timeline-unreadable capture of quote'],
      ['timeline.json is no timeline', facts({ timeline: parseTimelineHead({ mode: 'capture' }) }), 'timeline-unreadable capture of quote'],
      ['the timeline is of another scenario', facts({ timeline: head({ scenario: 'other' }) }), 'scenario-mismatch capture of quote'],
      ['the record is of another scenario', facts({ record: record({ scenario: 'other' }) }), 'scenario-mismatch capture of other'],
      // A head made by hand — no run id, no film named — is for a run someone names, never a take.
      ['a timeline without its run id', facts({ timeline: head({}, ['run_id']) }), 'timeline-unreadable capture of quote'],
      ['a timeline that names no film', facts({ timeline: head({ capture: {} }) }), 'timeline-unreadable capture of quote'],
      ['a timeline the adapter did not read', facts({ timeline: { ok: false, problem: 'not-read' } }), 'timeline-unreadable capture of quote'],
      ['a film named by a path', facts({ timeline: head({ capture: { file: 'sub/film.mp4' } }), film: 'other' }), 'film-outside capture of quote'],
      ['a film named `..`', facts({ timeline: head({ capture: { file: '..' } }), film: 'other' }), 'film-outside capture of quote'],
      ['the film is gone', facts({ film: 'missing' }), 'no-film capture of quote'],
      ['the film is a folder', facts({ film: 'other' }), 'no-film capture of quote'],
    ];
    for (const [what, f, want] of rows) expect(why(f), what).toBe(want);
  });

  it('a folder outside the project, for work through MCP: no take, said after a link and before anything it holds', () => {
    const v = (f: RunFolderFacts, outside: boolean) => {
      const t = takeOf(f, { outside });
      return t.usable ? 'usable' : `${t.why}${t.capture ? ' capture' : ''}${t.scenario !== undefined ? ` of ${t.scenario}` : ''}`;
    };
    expect(v(facts(), false)).toBe('usable');
    expect(v(facts(), true)).toBe('outside capture of quote');
    expect(takeOf(facts())).toEqual(takeOf(facts(), {})); // a terminal says nothing of it
    expect(v(facts({ record: record(FAILED) }), true)).toBe('outside capture of quote');
    expect(v(facts({ film: 'link' }), true)).toBe('linked capture of quote');
    expect(v(facts({ name: 'my take' }), true)).toBe('not-a-run-id');
    // A folder outside whose record does not read is not named: counted with the others of no record (latestTake).
    expect(v(facts({ record: { ok: false, problem: 'missing' } }), true)).toBe('outside');
  });

  it('the first reason that applies, in the order of the list', () => {
    // A failed run without timeline nor film says failed; a linked one says linked first; a bad name before all.
    const worst = { record: record(FAILED), timeline: { ok: false as const, problem: 'missing' as const }, film: 'missing' as const };
    expect(why(facts(worst))).toBe('failed capture of quote');
    expect(why(facts({ ...worst, timelineLink: true }))).toBe('linked capture of quote');
    expect(why(facts({ ...worst, timelineLink: true, name: '-x' }))).toBe('not-a-run-id');
    expect(why(facts({ record: record({ status: 'done' }), timeline: head({ scenario: 'other' }), film: 'missing' }))).toBe('unknown-status capture of quote');
    expect(why(facts({ timeline: head({ scenario: 'other' }), film: 'missing' }))).toBe('scenario-mismatch capture of quote');
  });

  it('a newer record carries its sentence', () => {
    const v = takeOf(facts({ record: parseRunRecord({ version: 2, scenario: 'quote' }) }));
    expect(!v.usable && v.message).toBe('this run.json is version 2: it was made for a newer Retake (this one reads version 1) — update Retake');
  });
});

describe('namedRunProblem: a run named by its id or its folder', () => {
  const at = (f: RunFolderFacts, o: { scenario?: string; trust?: 'author' | 'mcp'; inside?: boolean } = {}) => {
    const p = namedRunProblem(f, { trust: 'author', inside: true, ...o });
    return p === null ? 'works' : takeWords(p, { run: f.name, verb: 'render', dir: `/w/runs/${f.name}` });
  };

  it('works whatever the record says: failed, running, of an unknown status, absent, unreadable, of another scenario', () => {
    for (const r of [record(FAILED), record({ status: 'running' }, ['finished_at']), record({ status: 'queued' }, ['finished_at', 'capture', 'timeline']), record({ status: 'done' }), record({ scenario: 'other' }), parseRunRecord([]), { ok: false as const, problem: 'missing' as const }, { ok: false as const, problem: 'not-json' as const }]) {
      expect(at(facts({ record: r }), { scenario: 'quote' })).toBe('works');
    }
  });

  it('works whatever the folder is called and whatever kind the film is', () => {
    expect(at(facts({ name: 'my take' }))).toBe('works');
    expect(at(facts({ film: 'link' }))).toBe('works');
    expect(at(facts({ film: 'other' }))).toBe('works');
    expect(at(facts({ recordLink: true, timelineLink: true }))).toBe('works');
    expect(at(facts({ timeline: head({ capture: { file: '' } }) }))).toBe('works');
  });

  it('the refusals, in the words they have always had', () => {
    expect(at(facts({ timeline: { ok: false, problem: 'missing' } }))).toBe(`run ${NAME} has no timeline.json (/w/runs/${NAME})`);
    expect(at(facts({ timeline: head({ scenario: 'other' }) }), { scenario: 'quote' })).toBe(`run ${NAME} is a run of scenario "other", not "quote"`);
    expect(at(facts({ timeline: head({ scenario: 'other' }) }))).toBe('works'); // no scenario asked
    expect(at(facts({ timeline: head({ mode: 'dry' }) }))).toBe(`run ${NAME} is a dry run: there is no capture to render`);
    expect(at(facts({ film: 'missing' }))).toBe(`run ${NAME} has no capture video (/w/runs/${NAME}/capture.mp4)`);
    expect(at(facts({ record: parseRunRecord({ version: 2 }) }))).toBe(`run ${NAME}: this run.json is version 2: it was made for a newer Retake (this one reads version 1) — update Retake`);
    // A timeline that does not read: a sentence, not a parser's message.
    expect(at(facts({ timeline: { ok: false, problem: 'not-json' } }))).toBe(`run ${NAME}: its timeline does not read (timeline.json is not JSON)`);
    expect(at(facts({ timeline: parseTimelineHead({}) }))).toBe(`run ${NAME}: its timeline does not read (timeline.json is not a timeline)`);
    expect(at(facts({ timeline: { ok: false, problem: 'too-big' } }))).toBe(`run ${NAME}: its timeline does not read (timeline.json is too big)`);
  });

  it('the order of the refusals: a newer record first, then the timeline, the scenario, the dry run, the film', () => {
    const newer = parseRunRecord({ version: 2 });
    expect(at(facts({ record: newer, timeline: { ok: false, problem: 'missing' } }))).toContain('update Retake');
    expect(at(facts({ timeline: head({ scenario: 'other', mode: 'dry' }), film: 'missing' }), { scenario: 'quote' })).toContain('is a run of scenario "other"');
    expect(at(facts({ timeline: head({ mode: 'dry' }), film: 'missing' }))).toContain('is a dry run');
  });

  it('a linked run folder: used at a terminal; through MCP only when it resolves inside the project', () => {
    const link = facts({ folder: 'link' });
    expect(at(link, { trust: 'author', inside: false })).toBe('works');
    expect(at(link, { trust: 'mcp', inside: true })).toBe('works');
    expect(at(link, { trust: 'mcp', inside: false })).toBe(`run ${NAME} is a link to a folder outside the project: through MCP a render reads only the runs inside it`);
    // A real folder that does not lie in the project (runs/, or a folder above it, is a link): refused through MCP in
    // its own words — it is not a link itself —, whether it was named or picked as `latest` a moment before.
    expect(at(facts(), { trust: 'mcp', inside: false })).toBe(`run ${NAME} lies outside the project (its folder, or a folder above it, is a link): through MCP a render reads only the runs inside it`);
    expect(at(facts(), { trust: 'author', inside: false })).toBe('works');
    // A folder that is gone, or no folder: said as what it lacks.
    expect(at(facts({ folder: 'gone', timeline: { ok: false, problem: 'missing' } }), { trust: 'mcp', inside: false })).toBe(`run ${NAME} has no timeline.json (/w/runs/${NAME})`);
    // The refusal comes before anything the folder holds is judged.
    expect(at(facts({ folder: 'link', record: parseRunRecord({ version: 2 }) }), { trust: 'mcp', inside: false })).toContain('outside the project');
  });

  it('the film a timeline names: through MCP one path segment of the run folder; at a terminal as the timeline gives it', () => {
    const NOT_IN_FOLDER = `run ${NAME}: the film its timeline names is not a file of the run folder: through MCP a render reads only the film inside it`;
    const film = (file: string) => facts({ timeline: head({ capture: { file } }) });
    for (const file of ['../20261001-100000-quote/capture.mp4', '..', '.', 'sub/film.mp4', 'sub\\film.mp4', '/abs/film.mp4', 'a/../capture.mp4']) {
      expect(at(film(file), { trust: 'author' }), file).toBe('works');
      expect(at(film(file), { trust: 'mcp' }), file).toBe(NOT_IN_FOLDER);
    }
    for (const file of ['capture.mp4', 'the film.mp4', '..mp4', 'a..b', '']) expect(at(film(file), { trust: 'mcp' }), file).toBe('works');
    // Said before the scenario, the dry run and the film itself (nothing is told of a file outside the folder); after
    // the link, the record's format and a timeline that does not read. The words name no file: the name is a file's text.
    const out = facts({ timeline: head({ scenario: 'other', mode: 'dry', capture: { file: '../x/capture.mp4' } }), film: 'missing' });
    expect(at(out, { trust: 'mcp', scenario: 'quote' })).toBe(NOT_IN_FOLDER);
    expect(at(out, { trust: 'author', scenario: 'quote' })).toContain('is a run of scenario "other"');
    expect(at({ ...out, folder: 'link' }, { trust: 'mcp', inside: false })).toContain('is a link to a folder outside the project');
    expect(at({ ...out, record: parseRunRecord({ version: 2 }) }, { trust: 'mcp' })).toContain('update Retake');
    expect(isFilmName('capture.mp4') && !isFilmName('') && !isFilmName('..') && !isFilmName('a/b') && !isFilmName('a\\b')).toBe(true);
  });

  it('the files of a named run through MCP: a run.json, a timeline.json or a film that is a link is refused; at a terminal it works', () => {
    const LINKS = `run ${NAME}: its files are links: through MCP a render reads only the files of the run folder itself`;
    for (const f of [facts({ recordLink: true }), facts({ timelineLink: true }), facts({ film: 'link' })]) {
      expect(at(f, { trust: 'mcp' })).toBe(LINKS);
      expect(at(f, { trust: 'author' })).toBe('works');
    }
    // Said after the folder's own refusal; a linked film after a film named out of the folder; before the scenario.
    expect(at(facts({ recordLink: true }), { trust: 'mcp', inside: false })).toContain('lies outside the project');
    expect(at(facts({ film: 'link', timeline: head({ capture: { file: '../x/capture.mp4' } }) }), { trust: 'mcp' })).toContain('is not a file of the run folder');
    expect(at(facts({ film: 'link', timeline: head({ scenario: 'other' }) }), { trust: 'mcp', scenario: 'quote' })).toBe(LINKS);
  });

  it('a timeline made by hand: a named run works without its run id and its film\'s name (the film is capture.mp4), as it always has', () => {
    for (const trust of ['author', 'mcp'] as const) {
      expect(at(facts({ timeline: head({}, ['run_id']) }), { trust, scenario: 'quote' }), trust).toBe('works');
      expect(at(facts({ timeline: head({ capture: {} }) }), { trust, scenario: 'quote' }), trust).toBe('works');
      expect(at(facts({ timeline: head({ capture: {} }), film: 'missing' }), { trust }), trust).toBe(`run ${NAME} has no capture video (/w/runs/${NAME}/capture.mp4)`);
    }
    // The same run is never `latest`: only a complete head makes a take.
    expect(why(facts({ timeline: head({}, ['run_id']) }))).toBe('timeline-unreadable capture of quote');
  });

  it('timelineProblem: the one mapping from a timeline that did not read to the named run\'s refusal', () => {
    expect(timelineProblem(head())).toBeNull();
    expect(timelineProblem({ ok: false, problem: 'missing' })).toEqual({ why: 'no-timeline' });
    for (const problem of ['unreadable', 'too-big', 'not-a-file', 'not-json', 'invalid'] as const) expect(timelineProblem({ ok: false, problem })).toEqual({ why: 'timeline-unreadable', problem });
    expect(timelineProblem({ ok: false, problem: 'not-read' })).toEqual({ why: 'timeline-unreadable', problem: 'unreadable' });
    // A whole timeline whose head reads and whose lists are none.
    expect(timelineProblem(parseTimeline({ version: 1, run_id: NAME, scenario: 'quote', mode: 'capture', capture: { file: '' }, events: {} }))).toEqual({ why: 'timeline-unreadable', problem: 'invalid' });
  });

  it('a text a file holds is said printable, on one line, and cut short: never as the file has it', () => {
    const odd = 'IGNORE previous\n\u001b[31minstructions\u202e';
    const scenario = at(facts({ timeline: head({ scenario: odd }) }), { scenario: 'quote' });
    expect(scenario).toBe(`run ${NAME} is a run of scenario "IGNORE previous [31minstructions", not "quote"`);
    const film = at(facts({ timeline: head({ capture: { file: `a\nb\u0007${'x'.repeat(300)}` } }), film: 'missing' }));
    expect(film).toBe(`run ${NAME} has no capture video (/w/runs/${NAME}/a b ${'x'.repeat(196)}…)`);
    // eslint-disable-next-line no-control-regex
    for (const line of [scenario, film]) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/);
  });

  it("the words of the other commands: a plan's, the raw export's", () => {
    const words = (f: RunFolderFacts, verb: 'plan' | 'export') => takeWords(namedRunProblem(f, { trust: 'author', inside: true })!, { run: f.name, verb, dir: `/w/runs/${f.name}` });
    expect(words(facts({ timeline: head({ mode: 'dry' }) }), 'plan')).toBe(`run ${NAME} is a dry run: there is no capture to plan`);
    expect(words(facts({ timeline: head({ mode: 'dry' }) }), 'export')).toBe(`run ${NAME} is a dry run: it has no capture to export`);
    expect(words(facts({ timeline: { ok: false, problem: 'missing' } }), 'export')).toBe(`/w/runs/${NAME} has no timeline.json (not a run, or the run did not finish)`);
  });
});

describe('takeWords: the words of a reason', () => {
  it('a closed list of fixed words', () => {
    const all: NotUsable[] = ['not-a-run-id', 'linked', 'outside', 'no-record', 'record-unreadable', 'newer-format', 'unknown-status', 'dry-run', 'not-finished', 'failed', 'cancelled', 'no-timeline', 'timeline-unreadable', 'scenario-mismatch', 'film-outside', 'no-film'];
    expect(all.map((w) => takeWords(w, { run: 'r', verb: 'render' }))).toEqual([
      'it is not a run folder',
      'its files are links',
      'it lies outside the project',
      'it has no run.json',
      'its run.json does not read as a record',
      'written by a newer Retake',
      'its status is not one Retake writes',
      'a dry run',
      'not finished, or interrupted',
      'failed',
      'cancelled',
      'its timeline is missing',
      'its timeline does not read',
      'its timeline is of another scenario',
      'its film is not a file of its folder',
      'its film is missing',
    ]);
  });
});

describe('orderRuns: one order of runs', () => {
  it('dated runs first, newest first, then the other names descending; names that are no run id left out', () => {
    expect(orderRuns(['20261017-142233-quote', 'zz-quote', '20261020-090000-mobile-quote', 'my-take-quote', '20261016-090000-quote', '20261019-090000-quote'])).toEqual([
      '20261020-090000-mobile-quote',
      '20261019-090000-quote',
      '20261017-142233-quote',
      '20261016-090000-quote',
      'zz-quote',
      'my-take-quote',
    ]);
    // Seven digits are not a stamp: such a name sorts with the others.
    expect(orderRuns(['my-take-quote', 'zz-quote', '2026101-142233-quote'])).toEqual(['zz-quote', 'my-take-quote', '2026101-142233-quote']);
    expect(orderRuns(['Take.1-quote', '20261001-100000-quote', 'zz-quote', '20991231-235959-quote'])).toEqual(['20991231-235959-quote', '20261001-100000-quote', 'zz-quote', 'Take.1-quote']);
    // A stamped name is dated whatever follows the stamp.
    expect(orderRuns(['20261017-142233-', '20261017-142235-quote-', '20261017-142233-Quote', '20261017-142234-quote.bak', 'zz'])).toEqual(['20261017-142235-quote-', '20261017-142234-quote.bak', '20261017-142233-Quote', '20261017-142233-', 'zz']);
  });

  it('only run ids of at most 200 characters', () => {
    const a = (n: number, ch = 'a') => ch.repeat(n);
    expect(orderRuns(['.tmp-quote', '-quote', `20261017-142233-${a(185)}`, `${a(195, 'z')}-quote`, '20261017-142242-quote\n', 'a/b', '', '..'])).toEqual([]);
    expect(orderRuns([`${a(194, 'z')}-quote`, `20261017-142233-${a(184)}`]).map((n) => n.length)).toEqual([200, 200]);
    expect(orderRuns([])).toEqual([]);
  });

  it('does not change the list it is given', () => {
    const names = ['b', 'a', '20261017-142233-quote'];
    orderRuns(names);
    expect(names).toEqual(['b', 'a', '20261017-142233-quote']);
  });
});

describe('latestTake: the run `latest` names', () => {
  const id = (s: string): RunId => parseRunId(s)!;
  const usable = (run: string, scenario = 'quote'): TakeVerdict => ({ usable: true, take: { run: id(run), scenario, film: 'capture.mp4', finished_at: 't' } });
  const not = (w: NotUsable, o: { scenario?: string; capture?: boolean; message?: string } = {}): TakeVerdict => ({ usable: false, why: w, capture: o.capture ?? true, ...(o.scenario !== undefined ? { scenario: o.scenario } : { scenario: 'quote' }), ...(o.message ? { message: o.message } : {}) });
  const noRecord: TakeVerdict = { usable: false, why: 'no-record', capture: false };
  /** `latest` over runs r9 (newest) … r1, each with its verdict; the ids looked at. */
  async function pick(verdicts: Record<string, TakeVerdict>, scenario: string | null = 'quote') {
    const looked: string[] = [];
    const r = await latestTake(Object.keys(verdicts).map(id), scenario ?? undefined, (run) => {
      looked.push(run);
      return verdicts[run];
    });
    return { r, looked };
  }

  it('the first usable take of the scenario; nothing older is looked at', async () => {
    const { r, looked } = await pick({ r5: not('failed'), r4: usable('r4', 'other'), r3: usable('r3'), r2: usable('r2'), r1: not('failed') });
    expect(r).toEqual({ take: { run: 'r3', scenario: 'quote', film: 'capture.mp4', finished_at: 't' }, passed: [{ run: 'r5', why: 'failed' }], passed_more: 0, reasons: [{ why: 'failed', count: 1 }], without_record: 0 });
    expect(looked).toEqual(['r5', 'r4', 'r3']);
  });

  it('without a scenario: the first usable take of any', async () => {
    const { r, looked } = await pick({ r3: not('cancelled', { scenario: 'other' }), r2: usable('r2', 'other'), r1: usable('r1') }, null);
    expect([r.take?.run, r.passed, looked]).toEqual(['r2', [{ run: 'r3', why: 'cancelled' }], ['r3', 'r2']]);
  });

  it('what it passes over: the captures whose record names the scenario — never a dry run, another scenario, or a folder without a record', async () => {
    const { r } = await pick({
      r9: not('failed'),
      r8: not('dry-run', { capture: false }),
      r7: not('cancelled', { scenario: 'other' }),
      r6: noRecord,
      r5: { usable: false, why: 'record-unreadable', capture: false },
      r4: { usable: false, why: 'linked', capture: false },
      r3: not('no-film'),
      r2: { usable: false, why: 'not-a-run-id', capture: false },
      r1: usable('r1'),
    });
    expect(r).toEqual({ take: expect.objectContaining({ run: 'r1' }), passed: [{ run: 'r9', why: 'failed' }, { run: 'r3', why: 'no-film' }], passed_more: 0, reasons: [{ why: 'failed', count: 1 }, { why: 'no-film', count: 1 }], without_record: 2 });
  });

  it(`names at most ${PASSED_OVER_MAX} passed-over runs, counts the others, and goes on to the take`, async () => {
    const { r, looked } = await pick({ r9: not('failed'), r8: not('cancelled'), r7: not('not-finished'), r6: not('no-film'), r5: not('timeline-unreadable'), r4: not('unknown-status'), r3: not('failed'), r2: usable('r2'), r1: usable('r1') });
    expect([r.take?.run, r.passed.map((p) => p.run), r.passed_more, looked.length]).toEqual(['r2', ['r9', 'r8', 'r7', 'r6', 'r5'], 2, 8]);
    // Every capture passed over is counted by its reason — the named ones and the others —, in the order the reasons were met.
    expect(r.reasons).toEqual([
      { why: 'failed', count: 2 },
      { why: 'cancelled', count: 1 },
      { why: 'not-finished', count: 1 },
      { why: 'no-film', count: 1 },
      { why: 'timeline-unreadable', count: 1 },
      { why: 'unknown-status', count: 1 },
    ]);
    expect(r.reasons.reduce((n, x) => n + x.count, 0)).toBe(r.passed.length + r.passed_more);
  });

  it('nothing usable: no take, what was passed over, the folders without a record counted', async () => {
    expect((await pick({ r3: not('failed'), r2: noRecord, r1: noRecord })).r).toEqual({ passed: [{ run: 'r3', why: 'failed' }], passed_more: 0, reasons: [{ why: 'failed', count: 1 }], without_record: 2 });
    expect((await pick({})).r).toEqual({ passed: [], passed_more: 0, reasons: [], without_record: 0 });
  });

  it('nothing usable and every capture passed over written by a newer Retake: the newest one and its sentence', async () => {
    const newer = (m: string) => not('newer-format', { message: m });
    expect((await pick({ r3: newer('m3'), r2: noRecord, r1: newer('m1') })).r).toEqual({ passed: [{ run: 'r3', why: 'newer-format' }, { run: 'r1', why: 'newer-format' }], passed_more: 0, reasons: [{ why: 'newer-format', count: 2 }], without_record: 1, only_newer: { run: 'r3', message: 'm3' } });
    // One other reason among them, or a take found: not set.
    expect((await pick({ r3: newer('m3'), r2: not('failed') })).r.only_newer).toBeUndefined();
    expect((await pick({ r3: newer('m3'), r2: usable('r2') })).r.only_newer).toBeUndefined();
    // A newer record of another scenario is not this scenario's.
    expect((await pick({ r3: not('newer-format', { scenario: 'other', message: 'm' }) })).r).toEqual({ passed: [], passed_more: 0, reasons: [], without_record: 0 });
    // A dry run of a newer format is no capture: alone it leaves "no capture run", and above a take it is not passed over.
    const dry = takeOf(facts({ record: parseRunRecord({ version: 2, scenario: 'quote', mode: 'dry' }) }));
    expect((await pick({ r3: dry })).r).toEqual({ passed: [], passed_more: 0, reasons: [], without_record: 0 });
    expect((await pick({ r3: dry, r2: usable('r2') })).r).toMatchObject({ take: { run: 'r2' }, passed: [] });
  });

  it('a record that does not read as one is counted also when a take is found: `latest` never passes it over in silence', async () => {
    const unread = takeOf(facts({ record: parseRunRecord({ status: 'succeeded' }) }));
    expect(unread).toEqual({ usable: false, why: 'record-unreadable', capture: false });
    const { r } = await pick({ r4: unread, r3: noRecord, r2: usable('r2'), r1: unread });
    expect([r.take?.run, r.passed, r.without_record]).toEqual(['r2', [], 2]);
  });

  it('a record a later version of the same format wrote is a take, and `latest` takes it', async () => {
    const later = facts({ record: parseRunRecord(recordFixture('future/run-next-minor.json')) });
    const v = takeOf(later);
    // Its `stopped_at` names a reason this build does not know: carried by the record, not read as `--until`.
    expect(v).toEqual({ usable: true, take: { run: NAME, scenario: 'quote', film: 'capture.mp4', finished_at: '2026-10-02T08:00:09.000Z' } });
    expect((await pick({ r2: v, r1: usable('r1') })).r).toMatchObject({ take: { run: NAME }, passed: [], without_record: 0 });
  });

  it('a take stopped by --until is taken, and says where it stopped', async () => {
    const until: TakeVerdict = { usable: true, take: { run: id('r2'), scenario: 'quote', film: 'capture.mp4', finished_at: 't', until: { scene: 'one', step: 1 } } };
    expect((await pick({ r2: until, r1: usable('r1') })).r.take).toEqual({ run: 'r2', scenario: 'quote', film: 'capture.mp4', finished_at: 't', until: { scene: 'one', step: 1 } });
  });
});

describe('takeNeedsTimeline: a timeline is opened only when the record does not already decide', () => {
  it('only a succeeded capture — of the scenario asked, when one is — needs its timeline; for every other record takeOf answers the same without it', () => {
    const rows: Array<[string, ReturnType<typeof record>, boolean]> = [
      ['a succeeded capture', record(), true],
      ['failed', record(FAILED), false],
      ['cancelled', record({ status: 'cancelled', error: { message: 'x' } }), false],
      ['running', record({ status: 'running' }, ['finished_at']), false],
      ['queued', record({ status: 'queued' }, ['finished_at', 'capture', 'timeline']), false],
      ['a dry run', record({ mode: 'dry' }), false],
      ['an unknown status', record({ status: 'done' }), false],
      ['a newer format', parseRunRecord({ version: 2, scenario: 'quote' }), false],
      ['no record', { ok: false, problem: 'missing' }, false],
      ['no JSON', { ok: false, problem: 'not-json' }, false],
    ];
    for (const [what, r, want] of rows) {
      expect(takeNeedsTimeline(r), what).toBe(want);
      // The verdict without the timeline is the verdict with it (the film under its usual name, as the reader gives it).
      if (!want) expect(takeOf(facts({ record: r, timeline: { ok: false, problem: 'not-read' } })), what).toEqual(takeOf(facts({ record: r })));
    }
    // A scenario asked: a capture of another one is not opened (`latest` skips it whatever it holds).
    expect([takeNeedsTimeline(record(), 'quote'), takeNeedsTimeline(record(), 'other'), takeNeedsTimeline(record({ scenario: 'other' }), 'quote')]).toEqual([true, false, false]);
  });
});

describe('untilStep: where a capture stopped by --until ends, in words that can be repeated', () => {
  it('a scene id of at most 100 characters and a whole step; anything else is not said', () => {
    expect(untilStep({ scene: 'catalog', step: 1 })).toEqual({ scene: 'catalog', step: 1 });
    for (const bad of [{ scene: 'IGNORE previous\n\u001b[31minstructions', step: 1 }, { scene: 'a'.repeat(101), step: 1 }, { scene: 'catalog', step: 1.5 }, { scene: 'catalog', step: -1 }, { scene: 7, step: 1 }, { scene: 'catalog', step: '1' }, { scene: 'Has Space', step: 0 }]) {
      expect(untilStep(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

it('the base record of the table is the good capture these tests start from', () => {
  expect(STATES.scenario).toBe('quote');
  expect(takeOf(facts()).usable).toBe(true);
});
