/**
 * The run record (L7.6a, core run-record.ts): the transitions — the only way a status changes —, and the parse boundary
 * of run.json and of a timeline's head: a value or a typed problem, never a throw.
 *
 * How the records read here were made (fixtures/records/README.md has the table): `past/run-0.1.0` and
 * `past/real/run-real-{1,2,3}` are shapes of files a build wrote (one version, one day; every value that could
 * identify anything replaced, the keys this repository no longer names left out); the other files of `past/` were
 * written BY HAND from the code of the writer each names — they hold the author's reading of that writer, not a file a
 * past version left; `future/run-next-minor` is invented. The reader does not lean on any of them being exact: a
 * member that decides nothing can never make a record unreadable, which is what the lenient rows below pin.
 */
import { describe, expect, it } from 'vitest';
import { RunRecordSchema, closeReservedRun, finishRun, isKnownRun, parseRunId, parseRunRecord, parseTimeline, parseTimelineHead, queuedRun, startedRun } from '../src/index.js';
import type { RunRead, RunRecord, RunningRun, StoredRunRecord, UnknownStatusRun } from '../src/index.js';
import { STATES, recordFixture, recordText, stateIds } from './fixtures/records/build.js';

const ID = parseRunId('20261020-090000-quote')!;
const FIELDS = {
  version: 1 as const,
  id: ID,
  project: 'p',
  scenario: 'quote',
  mode: 'capture' as const,
  started_at: '2026-10-20T07:00:00.000Z',
  dir: '/w/runs/20261020-090000-quote',
  env: 'local',
  options: { hooks: 'run' as const, headed: false },
  steps_total: 3,
  steps_done: 0,
  screenshots: [],
  hooks: { setup: 'none' as const, teardown: 'none' as const },
  warnings: [],
};
const ORDER = ['version', 'id', 'project', 'scenario', 'mode', 'status', 'started_at', 'dir', 'env', 'options', 'steps_total', 'steps_done', 'screenshots', 'hooks', 'warnings'];
const running = (): RunningRun => ({
  ...startedRun({ ...FIELDS, environment: { access: 'read-write' } }),
  steps_done: 2,
  current: { scene: 'one', step: 2, action: 'click' },
  paused: { scene: 'one', step: 2, since: '2026-10-20T07:00:05.000Z' },
  capture: '/w/c.mp4',
});
/** What the reader answered, in a few words. */
const said = (r: RunRead): string =>
  r.ok
    ? ['ok', ...r.notes].join(' ')
    : r.problem === 'invalid'
      ? `invalid at ${r.detail}`
      : r.problem === 'unknown-status'
        ? `unknown-status ${r.record.status}`
        : r.problem === 'newer-format'
          ? `newer-format of ${r.scenario ?? '?'}`
          : r.problem;

describe('the transitions', () => {
  it('a reserved run and a run that starts: a state the schema of written records accepts, its status after its mode', () => {
    const q = queuedRun(FIELDS);
    expect(Object.keys(q)).toEqual(ORDER);
    expect([q.status, RunRecordSchema.safeParse(q).success]).toEqual(['queued', true]);
    const s = startedRun({ ...FIELDS, environment: { access: 'read-write' } });
    expect(Object.keys(s)).toEqual([...ORDER, 'environment']);
    expect([s.status, RunRecordSchema.safeParse(s).success]).toEqual(['running', true]);
    // A record without `version` keeps none.
    const { version: _v, ...old } = FIELDS;
    expect(Object.keys(queuedRun(old))).toEqual(ORDER.slice(1));
  });

  it('a run that ends well: its end and its warnings, no step it was at, no pause, no error', () => {
    const done = finishRun(running(), { status: 'succeeded', at: '2026-10-20T07:01:00.000Z', warnings: ['w'] });
    expect(Object.keys(done)).toEqual([...ORDER, 'environment', 'capture', 'finished_at']);
    expect(done).toMatchObject({ status: 'succeeded', finished_at: '2026-10-20T07:01:00.000Z', warnings: ['w'], capture: '/w/c.mp4', steps_done: 2 });
    expect(RunRecordSchema.safeParse(done).success).toBe(true);
  });

  it('a run that fails or is cancelled: its end, then its error; the step it was at and its pause are dropped', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      const done = finishRun(running(), { status, at: '2026-10-20T07:01:00.000Z', warnings: [], error: { message: 'no', scene: 'one', step: 2 } });
      expect(Object.keys(done), status).toEqual([...ORDER, 'environment', 'capture', 'finished_at', 'error']);
      expect(done).toMatchObject({ status, error: { message: 'no', scene: 'one', step: 2 } });
      expect(RunRecordSchema.safeParse(done).success).toBe(true);
    }
  });

  it('finishing does not change the record it was given', () => {
    const r = running();
    const before = JSON.stringify(r);
    finishRun(r, { status: 'succeeded', at: 'x', warnings: ['w'] });
    expect(JSON.stringify(r)).toBe(before);
  });

  it('a reserved run closed from outside: the bytes run.json has always got', () => {
    const text = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
    const close = (rel: string, status: 'failed' | 'cancelled', at: string, message: string) => text(closeReservedRun(recordFixture(rel) as { status: 'queued' | 'running' }, { status, at, message }));
    expect(close('past/run-queued.json', 'failed', '2026-10-20T07:00:02.000Z', 'the worker stopped before the run started')).toBe(text(recordFixture('past/run-closed-from-queued.json')));
    expect(close('past/run-running.json', 'failed', '2026-10-21T07:00:09.000Z', "the run's process ended without finishing it")).toBe(text(recordFixture('past/run-closed-from-running.json')));
    const { finished_at: _f, error: _e, ...paused } = recordFixture('past/run-closed-from-paused.json') as Record<string, unknown>;
    expect(text(closeReservedRun({ ...paused, status: 'running' }, { status: 'cancelled', at: '2026-10-22T07:00:09.000Z', message: 'cancelled' }))).toBe(
      text(recordFixture('past/run-closed-from-paused.json')),
    );
    // It keeps what it finds: the step the run was at, an error's other members, a member it does not know.
    expect(closeReservedRun({ status: 'running', current: { scene: 'a' }, error: { message: 'old', scene: 'one' }, extra: 1 }, { status: 'cancelled', at: 't', message: 'new' })).toEqual({
      status: 'cancelled',
      current: { scene: 'a' },
      error: { message: 'new', scene: 'one' },
      extra: 1,
      finished_at: 't',
    });
  });

  it('a run closed from outside is a state of the written record, with the step it was at and its pause', () => {
    for (const f of ['run-closed-from-queued.json', 'run-closed-from-running.json', 'run-closed-from-paused.json']) expect(RunRecordSchema.safeParse(recordFixture(`past/${f}`)).success, f).toBe(true);
  });
});

describe('the schema of written records: one state per status', () => {
  const base = () => JSON.parse(recordText({ about: 'base' }, { id: STATES.new, dir: '/w/runs/x', project: 'p' })!) as Record<string, unknown>;
  const refused = (v: unknown): string => {
    const r = RunRecordSchema.safeParse(v);
    return r.success ? 'ok' : r.error.issues.map((i) => i.path.join('.') || '(root)').join(' ');
  };

  it('refuses a state no writer makes, at the member that makes it one', () => {
    const { finished_at: _f, ...unfinished } = base();
    expect(refused(base())).toBe('ok');
    expect(refused({ ...base(), error: { message: 'x' } })).toBe('error');
    expect(refused({ ...base(), current: { scene: 'a', step: 0, action: 'click' } })).toBe('current');
    expect(refused({ ...base(), paused: { scene: 'a', step: 0, since: 't' } })).toBe('paused');
    expect(refused(unfinished)).toBe('finished_at');
    expect(refused({ ...base(), status: 'failed' })).toBe('error');
    expect(refused({ ...base(), status: 'cancelled' })).toBe('error');
    expect(refused({ ...base(), status: 'queued' })).toBe('finished_at capture timeline');
    expect(refused({ ...unfinished, status: 'running', error: { message: 'x' } })).toBe('error');
    expect(refused({ ...base(), status: 'running' })).toBe('finished_at');
    expect(refused({ ...base(), status: 'done' })).toBe('status');
    expect(refused({ ...base(), extra: 1 })).toBe('(root)');
  });
});

describe('parseRunRecord', () => {
  it('every record older builds wrote reads, whole', () => {
    const rows: Record<string, string> = {};
    for (const f of [
      'run-0.1.0/run.json',
      'run-phase1.json',
      'run-queued.json',
      'run-closed-from-queued.json',
      'run-running.json',
      'run-closed-from-running.json',
      'run-closed-from-paused.json',
      'run-dry.json',
    ]) {
      const value = recordFixture(`past/${f}`);
      const r = parseRunRecord(value);
      rows[f] = said(r);
      // What is read is what was written: nothing dropped, nothing added, the members in their order.
      if (r.ok) expect(JSON.stringify(r.value), f).toBe(JSON.stringify(value));
    }
    expect(Object.values(rows)).toEqual(Array.from({ length: 8 }, () => 'ok'));
  });

  it('a key this build does not know in `engine` and `perf.cpu`, and no `retake` there: the record reads and keeps the key', () => {
    for (const key of ['x', 'tool', 'k_9', 'a'.repeat(40), 'made.by']) {
      const value = recordFixture('past/run-0.1.0/run.json') as { engine: Record<string, unknown>; perf: { cpu: Record<string, unknown> } };
      value.engine[key] = '0.1.0';
      value.perf.cpu[key] = 1.5;
      const r = parseRunRecord(value);
      expect(said(r), key).toBe('ok');
      if (!r.ok) continue;
      expect([(r.value.engine as Record<string, unknown>)[key], (r.value.perf?.cpu as Record<string, unknown>)[key], r.value.engine?.retake, r.value.perf?.cpu?.retake], key).toEqual([
        '0.1.0',
        1.5,
        undefined,
        undefined,
      ]);
    }
  });

  it('a diagnostic block that does not read is dropped and noted: the run is never lost for it', () => {
    const value = () => recordFixture('past/run-0.1.0/run.json') as Record<string, unknown> & { perf: Record<string, unknown>; engine: Record<string, unknown> };
    const dropped = (v: unknown) => {
      const r = parseRunRecord(v);
      return r.ok ? `${said(r)} | engine ${r.value.engine ? 'kept' : 'gone'}, perf ${r.value.perf ? 'kept' : 'gone'}` : said(r);
    };
    expect(dropped({ ...value(), perf: { ...value().perf, seconds: 'long' } })).toBe('ok perf-dropped | engine kept, perf gone');
    expect(dropped({ ...value(), perf: 'none' })).toBe('ok perf-dropped | engine kept, perf gone');
    expect(dropped({ ...value(), perf: { ...value().perf, cpu: { browser: 'much' } } })).toBe('ok perf-dropped | engine kept, perf gone');
    expect(dropped({ ...value(), engine: { ...value().engine, node: 22 } })).toBe('ok engine-dropped | engine gone, perf kept');
    expect(dropped({ ...value(), engine: [], perf: null })).toBe('ok engine-dropped perf-dropped | engine gone, perf gone');
    expect(dropped(value())).toBe('ok | engine kept, perf kept');
  });

  it('every state of the table', () => {
    const rows: Record<string, string> = {};
    for (const id of stateIds({ named: true })) {
      const text = recordText(STATES.states[id], { id: STATES.states[id].name ?? STATES.new, dir: '/w/runs/x', project: 'p' });
      if (text === undefined) continue;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        continue;
      }
      const r = said(parseRunRecord(value));
      if (r !== 'ok') rows[id] = r;
    }
    // Every other state's record reads (a failed, cancelled, running or queued one, a dry run, the record of an older build).
    // `v`, a record of a later version of the same format, reads too: only its `perf`, which this build cannot read, is left out.
    expect(rows).toEqual({ o: 'newer-format of quote', of: 'newer-format of quote', r: 'unknown-status done', s: 'invalid at (root)', v: 'ok perf-dropped' });
  });

  it('what is not a record: the path of the first member that does not read, never a value', () => {
    const base = () => JSON.parse(recordText({ about: 'base' }, { id: STATES.new, dir: '/w/runs/x', project: 'p' })!) as Record<string, unknown>;
    const { scenario: _s, ...noScenario } = base();
    const { finished_at: _f, ...unfinished } = base();
    const rows: Array<[unknown, string]> = [
      [null, 'invalid at (root)'],
      ['text', 'invalid at (root)'],
      [[], 'invalid at (root)'],
      [{}, 'invalid at status'],
      [noScenario, 'invalid at scenario'],
      [{ ...base(), mode: 'film' }, 'invalid at mode'],
      [{ ...base(), status: 7 }, 'invalid at status'],
      [{ ...base(), id: '' }, 'invalid at id'],
      [{ ...base(), finished_at: 7 }, 'invalid at finished_at'],
      // A state no writer makes is not a record either.
      [{ ...base(), error: { message: 'secret words' } }, 'invalid at error'],
      [unfinished, 'invalid at finished_at'],
      [{ ...base(), status: 'failed' }, 'invalid at error'],
      [{ ...base(), status: 'failed', error: 'it broke' }, 'invalid at error'],
      // The refusal names what decides, also beside a member that decides nothing and does not read either.
      [{ ...base(), status: 'failed', error: 'it broke', environment: null, steps_done: 'three' }, 'invalid at error'],
      [{ ...noScenario, options: 'fast' }, 'invalid at scenario'],
      [{ ...base(), status: 'done', finished_at: 7 }, 'invalid at finished_at'],
      [{ ...base(), status: 'queued' }, 'invalid at finished_at'],
      [{ ...base(), current: { scene: 'a', step: 1, action: 'click' } }, 'invalid at current'],
      // A status Retake never writes: its record, when the rest reads; else invalid.
      [{ ...base(), status: 'done' }, 'unknown-status done'],
      [{ ...noScenario, status: 'done' }, 'invalid at scenario'],
      [{ ...unfinished, status: 'paused', current: { scene: 'a', step: 1, action: 'click' } }, 'unknown-status paused'],
      // A newer format: said before anything else is read; the scenario only when it is a text.
      [{ version: 2 }, 'newer-format of ?'],
      [{ version: 3, scenario: 'quote', status: [] }, 'newer-format of quote'],
      [{ version: 2, scenario: 7 }, 'newer-format of ?'],
      // A member this build does not know passes, at every level.
      [{ ...base(), extra: { a: 1 }, options: { hooks: 'run', headed: false, later: true }, hooks: { setup: 'none', teardown: 'none', more: 'x' } }, 'ok'],
    ];
    for (const [value, want] of rows) expect(said(parseRunRecord(value)), JSON.stringify(value)?.slice(0, 80)).toBe(want);
    const newer = parseRunRecord({ version: 2 });
    expect(!newer.ok && newer.problem === 'newer-format' && newer.message).toBe('this run.json is version 2: it was made for a newer Retake (this one reads version 1) — update Retake');
    // The detail is a path: the words of the file never reach it.
    expect(JSON.stringify(parseRunRecord({ ...base(), error: { message: 'secret words' } }))).not.toContain('secret');
  });
});

describe('parseRunRecord: only what the rules and the union need decides', () => {
  const base = () => JSON.parse(recordText({ about: 'base' }, { id: STATES.new, dir: '/w/runs/x', project: 'p' })!) as Record<string, unknown>;
  /** What the reader answered, and the member looked at as it reads now. */
  const read = (value: Record<string, unknown>, member: string): string => {
    const r = parseRunRecord(value);
    if (!r.ok) return said(r);
    let at: unknown = r.value;
    for (const key of member.split('.')) at = (at as Record<string, unknown> | undefined)?.[key];
    return `${said(r)} | ${JSON.stringify(at)}`;
  };

  it('a member that decides nothing never loses the run: a word is kept, a member that does not read is left out or read as its empty value, each noted', () => {
    const rows: Array<[Record<string, unknown>, string, string]> = [
      // A closed word this build does not know: kept as the file holds it, nothing noted.
      [{ options: { hooks: 'none', headed: false } }, 'options.hooks', 'ok | "none"'],
      [{ options: { hooks: 'run', headed: false, cursor: 'shown' } }, 'options.cursor', 'ok | "shown"'],
      [{ hooks: { setup: 'ok', teardown: 'later', steps: 'partial' } }, 'hooks', 'ok | {"setup":"ok","teardown":"later","steps":"partial"}'],
      [{ environment: { access: 'read' } }, 'environment.access', 'ok | "read"'],
      [{ environment: { access: 'read-write', sandbox: { name: 's', provider: 'vm', strategy: 'clone' } } }, 'environment.sandbox.provider', 'ok | "vm"'],
      [{ stopped_at: { scene: 'a', step: 2, reason: 'limit' } }, 'stopped_at.reason', 'ok | "limit"'],
      [{ steps_done: 2.5 }, 'steps_done', 'ok | 2.5'],
      [{ pauses: [{ scene: 'a', step: 1, at: 'x', ms: 12.5 }] }, 'pauses', 'ok | [{"scene":"a","step":1,"at":"x","ms":12.5}]'],
      // A member a record may lack that does not read: left out, and noted.
      [{ environment: null }, 'environment', 'ok environment-dropped | undefined'],
      [{ environment: 'local' }, 'environment', 'ok environment-dropped | undefined'],
      [{ stopped_at: { scene: 'a' } }, 'stopped_at', 'ok stopped_at-dropped | undefined'],
      [{ optional_failures: 'two' }, 'optional_failures', 'ok optional_failures-dropped | undefined'],
      [{ pauses: null }, 'pauses', 'ok pauses-dropped | undefined'],
      [{ capture: 7 }, 'capture', 'ok capture-dropped | undefined'],
      [{ version: '1' }, 'version', 'ok version-dropped | undefined'],
      [{ version: 0 }, 'version', 'ok version-dropped | undefined'],
      // Inside a block that otherwise reads, only the member that does not read goes.
      [{ environment: { access: 'read-write', production: 'yes', clock: 7 } }, 'environment', 'ok environment.production-dropped environment.clock-dropped | {"access":"read-write"}'],
      [{ options: { hooks: 'run', headed: false, until: 7 } }, 'options', 'ok options.until-dropped | {"hooks":"run","headed":false}'],
      // A member every record holds that does not read: its empty value, and noted (absent: the empty value, silently).
      [{ steps_done: 'three' }, 'steps_done', 'ok steps_done-dropped | 0'],
      [{ warnings: 'none' }, 'warnings', 'ok warnings-dropped | []'],
      [{ screenshots: [1, 2] }, 'screenshots', 'ok screenshots-dropped | []'],
      [{ options: 'fast' }, 'options', 'ok options-dropped | {"hooks":"","headed":false}'],
      [{ options: { hooks: 3, headed: 'no' } }, 'options', 'ok options.hooks-dropped options.headed-dropped | {"hooks":"","headed":false}'],
      [{ hooks: null }, 'hooks', 'ok hooks-dropped | {"setup":"","teardown":""}'],
      [{ env: 5, dir: [] }, 'env', 'ok dir-dropped env-dropped | ""'],
      [{ started_at: undefined, project: undefined }, 'started_at', 'ok | ""'],
    ];
    for (const [change, member, want] of rows) expect(read({ ...base(), ...change }, member), JSON.stringify(change)).toBe(want);
    // A failed run's error: its message is the one member it must hold; the rest goes member by member.
    const failed = { ...base(), status: 'failed', error: { message: 7, step: 'two', scene: 'a', later: true } };
    expect(read(failed, 'error')).toBe('ok error.message-dropped error.step-dropped | {"message":"","scene":"a","later":true}');
    // Nothing is noted, and the value is the file's own, when everything reads.
    const whole = base();
    const r = parseRunRecord(whole);
    expect(r.ok && r.value).toBe(whole);
    // The reader never changes what it was given.
    const odd = { ...base(), environment: null, steps_done: 'three' };
    const before = JSON.stringify(odd);
    parseRunRecord(odd);
    expect(JSON.stringify(odd)).toBe(before);
  });

  it('a record a later version of the same format wrote — words and blocks this build does not know — reads, with every member it can read', () => {
    const value = recordFixture('future/run-next-minor.json') as Record<string, unknown>;
    const r = parseRunRecord(value);
    // Only the diagnostic block that does not read is left out; every unknown word and block is kept as the file holds it.
    expect(said(r)).toBe('ok perf-dropped');
    if (!r.ok) return;
    const { perf: _perf, ...rest } = value;
    expect(JSON.stringify(r.value)).toBe(JSON.stringify(rest));
    expect([r.value.status, r.value.mode, r.value.scenario, r.value.finished_at]).toEqual(['succeeded', 'capture', 'quote', '2026-10-02T08:00:09.000Z']);
    expect([r.value.options.hooks, r.value.hooks.steps, r.value.environment?.access, r.value.stopped_at?.reason]).toEqual(['partial', 'retried', 'read-audit', 'budget']);
  });

  it('the three run records found on a real machine (values neutral, shapes real) read whole', () => {
    for (const n of [1, 2, 3]) {
      const value = recordFixture(`past/real/run-real-${n}.json`);
      const r = parseRunRecord(value);
      expect(said(r), String(n)).toBe('ok');
      if (r.ok) expect(JSON.stringify(r.value), String(n)).toBe(JSON.stringify(value));
      if (r.ok) expect([r.value.engine?.retake, r.value.perf?.cpu?.retake], String(n)).toEqual([undefined, undefined]);
    }
  });

  it('a newer format says its scenario and whether it is a dry run, read leniently', () => {
    const kind = (v: unknown) => {
      const r = parseRunRecord(v);
      return !r.ok && r.problem === 'newer-format' ? [r.scenario, r.dry] : 'not newer';
    };
    expect(kind({ version: 2, scenario: 'quote', mode: 'dry' })).toEqual(['quote', true]);
    expect(kind({ version: 2, scenario: 'quote', mode: 'capture' })).toEqual(['quote', undefined]);
    expect(kind({ version: 2, scenario: 'quote', mode: 7 })).toEqual(['quote', undefined]);
  });
});

describe('the states by type: what decides a state cannot be assigned', () => {
  it('status, the end and the error are read-only on a state and on the union; a status Retake never writes is none of the five', () => {
    // (`as`: a value declared as the union and given a queued run would be narrowed to that state by the assignment,
    // and the three lines below would fail for that reason alone.)
    const run = queuedRun(FIELDS) as RunRecord;
    const stored = run as StoredRunRecord;
    const assign = (): void => {
      // @ts-expect-error a status changes through the transitions only: it cannot be assigned on the union
      run.status = 'failed';
      // @ts-expect-error an error cannot be put on a record in place: finishRun and closeReservedRun make the failed one
      run.error = { message: 'x' };
      // @ts-expect-error the end of a run cannot be taken away (or set) in place
      run.finished_at = undefined;
    };
    expect(typeof assign).toBe('function');
    expect(run.status).toBe('queued');
    // What is read is one of the five states or a record of an unknown status: once told apart (isKnownRun), the states
    // narrow on their status — a succeeded record has its end, as a text.
    const end = (r: StoredRunRecord | UnknownStatusRun): string | undefined => (isKnownRun(r) && r.status === 'succeeded' ? r.finished_at.slice(0, 4) : undefined);
    expect(end(stored)).toBeUndefined();
    expect(end(finishRun(startedRun(FIELDS), { status: 'succeeded', at: '2026-10-20T07:01:00.000Z', warnings: [] }))).toBe('2026');
    const odd = parseRunRecord({ ...JSON.parse(recordText({ about: 'base' }, { id: STATES.new, dir: '/w/runs/x', project: 'p' })!), status: 'done' });
    expect(!odd.ok && odd.problem === 'unknown-status' && end(odd.record)).toBeUndefined();
    expect([isKnownRun(stored), !odd.ok && odd.problem === 'unknown-status' && isKnownRun(odd.record)]).toEqual([true, false]);
  });
});

describe('parseTimelineHead', () => {
  const head = { version: 1, run_id: 'r', project: 'p', scenario: 'quote', mode: 'capture', capture: { file: 'capture.mp4' }, events: [], markers: [], scenes: [] };
  const said = (v: unknown) => {
    const r = parseTimelineHead(v);
    return r.ok
      ? `${r.value.mode} ${r.value.scenario} ${r.value.run_id} ${r.value.film}${r.value.lacks ? ` (lacks ${r.value.lacks})` : ''}`
      : r.problem === 'invalid'
        ? `invalid at ${r.detail}`
        : r.problem;
  };

  it('the mode, the scenario, the run and the film; `capture.mp4` when the timeline names no film', () => {
    expect(said(head)).toBe('capture quote r capture.mp4');
    expect(said({ ...head, capture: { file: '' } })).toBe('capture quote r capture.mp4');
    expect(said({ ...head, capture: { file: 'film.mp4' } })).toBe('capture quote r film.mp4');
    expect(said({ ...head, mode: 'dry', capture: { file: '' }, events: [{ not: 'looked at' }] })).toBe('dry quote r capture.mp4');
    expect(said(recordFixture('past/run-0.1.0/timeline.json'))).toBe('capture quote 20261028-083636-quote capture.mp4');
  });

  it('anything else is invalid, at the member that does not read', () => {
    const { scenario: _s, ...noScenario } = head;
    const { capture: _c, ...noCapture } = head;
    const rows: Array<[unknown, string]> = [
      [null, 'invalid at (root)'],
      [[], 'invalid at (root)'],
      ['{}', 'invalid at (root)'],
      [{ mode: 'capture' }, 'invalid at scenario'],
      [{ ...head, mode: 'film' }, 'invalid at mode'],
      [noScenario, 'invalid at scenario'],
      [noCapture, 'invalid at capture'],
      [{ ...head, capture: 'capture.mp4' }, 'invalid at capture'],
      [{ ...head, capture: [] }, 'invalid at capture'],
      [{ ...head, capture: { file: 7 } }, 'invalid at capture.file'],
    ];
    for (const [value, want] of rows) expect(said(value), JSON.stringify(value)).toBe(want);
  });

  it("a head made by hand reads and says what a complete one has and it lacks: its run id, its film's name (the film is then capture.mp4); its lists are the whole timeline's to judge", () => {
    const { run_id: _r, ...noRun } = head;
    const { events: _e, ...noEvents } = head;
    const rows: Array<[unknown, string]> = [
      [noRun, 'capture quote undefined capture.mp4 (lacks run_id)'],
      [{ ...head, run_id: 7 }, 'capture quote undefined capture.mp4 (lacks run_id)'],
      [{ ...head, capture: {} }, 'capture quote r capture.mp4 (lacks capture.file)'],
      [{ ...head, capture: { file: null } }, 'capture quote r capture.mp4 (lacks capture.file)'],
      [{ ...noRun, capture: {} }, 'capture quote undefined capture.mp4 (lacks run_id)'],
      [noEvents, 'capture quote r capture.mp4'],
      [{ ...head, markers: {}, scenes: 'none' }, 'capture quote r capture.mp4'],
      // An empty name is a name: the film a capture has always had (a timeline the runner wrote without a film).
      [{ ...head, capture: { file: '' } }, 'capture quote r capture.mp4'],
    ];
    for (const [value, want] of rows) expect(said(value), JSON.stringify(value)).toBe(want);
    // The whole timeline: a run someone names works without its run id and its film's name, never without its lists.
    const whole = (v: unknown) => {
      const r = parseTimeline(v);
      return r.ok ? 'ok' : `${r.problem} at ${'detail' in r ? r.detail : ''}`;
    };
    expect([whole(noRun), whole({ ...head, capture: {} }), whole(noEvents), whole({ ...head, scenes: 'none' }), whole(head)]).toEqual(['ok', 'ok', 'invalid at events', 'invalid at scenes', 'ok']);
  });
});
