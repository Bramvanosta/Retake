/**
 * Run records as the runner writes them and as the raw export's gate reads them (L7.6a). The gate: state by state
 * (core/test/fixtures/records/states.json; OLD: a good capture of `quote`; NEW: the state named), the refusal of
 * `exportCapture` or "passes the gate" (the export stops at its first progress event: nothing is encoded). The
 * writer: the members of the record a real dry run ends with, per outcome.
 *
 * A row marked `D-<n>` is an outcome a decision of the lot changes; `F-<n>` one a fix made on the way changes. The
 * gate's rows do not move in this lot (a named run keeps working whatever its record says) but where marked: the gate
 * reads through the core's one reader and decides by the named run's rule (core take.ts namedRunProblem).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY, RunRecordSchema } from '@retake/core';
import type { RunRecord, Scenario } from '@retake/core';
import { loadProject } from '@retake/core/io';
import { exportCapture, rawExportRun, runScenario } from '../src/index.js';
import type { RunOptions } from '../src/index.js';
import { STATES, buildState, stateIds, writeWorkspace } from '../../core/test/fixtures/records/build.js';
import type { BuiltState } from '../../core/test/fixtures/records/build.js';
import { DRY_PAGE } from './pages.js';
import { FAST, makeScenario, startServer } from '@retake/test-support/capture';
import { makeProject } from './helpers.js';
import type { TestServer } from '@retake/test-support/capture';

let root: string;
let server: TestServer;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'retake-records-runner-'));
  writeWorkspace(root);
  server = await startServer({ '/dry.html': DRY_PAGE });
});
afterAll(async () => {
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

class PastTheGate extends Error {}

/** What the raw export answers for a run folder: its refusal, or `passes` once it starts planning. */
async function gate(b: BuiltState, dir: string): Promise<string> {
  const project = await loadProject(b.slug, root);
  try {
    await exportCapture({
      project,
      runDir: dir,
      policy: PERSON_POLICY,
      out: join(root, 'out', b.slug),
      onProgress: () => {
        throw new PastTheGate();
      },
    });
    return 'exported';
  } catch (e) {
    if (e instanceof PastTheGate) return 'passes';
    return `${(e as Error).name}: ${(e as Error).message.replaceAll(root, '<root>').replaceAll(b.new, 'NEW').replaceAll(b.old, 'OLD')}`;
  }
}

const NO_TIMELINE = (slug: string) => `RawExportError: <root>/projects/${slug}/runs/NEW has no timeline.json (not a run, or the run did not finish)`;
const NEWER = 'RawExportError: run NEW: this run.json is version 2: it was made for a newer Retake (this one reads version 1) — update Retake';

/** Per state: the gate's answer for NEW named by its folder. A state not listed passes. */
const REFUSED: Record<string, string> = {
  a: NO_TIMELINE('s-a'),
  b: NO_TIMELINE('s-b'),
  f: 'RawExportError: run NEW is a dry run: it has no capture to export',
  gn: NO_TIMELINE('s-gn'),
  l: 'RawExportError: run NEW: its timeline does not read (timeline.json is not JSON)', // F-4: was a raw `SyntaxError: Unterminated string in JSON…`
  o: NEWER,
  of: NEWER,
  k2: NO_TIMELINE('s-k2'),
  k3: NO_TIMELINE('s-k3'),
};

describe("the raw export's gate, state by state", () => {
  it('every state of the table: refused with these words, or past the gate', async () => {
    const got: Record<string, string> = {};
    for (const id of stateIds({ named: true })) {
      const b = buildState(root, id);
      const r = await gate(b, b.newDir);
      if (r !== 'passes') got[id] = r;
    }
    // Past the gate: a failed take with its film (c), one without (d, e, g: the export fails later, on its frames), a
    // record that does not read (j, k, s), another scenario (p, p2), any status (r, t7), any name (m, t8), links (t9, k1).
    expect(got).toEqual(REFUSED);
  });

  it('the gate reads the folder it is given: OLD passes, OLD without its timeline does not', async () => {
    const b = buildState(root, 'ctl', { slug: 'gate-old' });
    expect(await gate(b, join(b.runs, b.old))).toBe('passes');
    rmSync(join(b.runs, b.old, 'timeline.json'));
    expect(await gate(b, join(b.runs, b.old))).toBe('RawExportError: <root>/projects/gate-old/runs/OLD has no timeline.json (not a run, or the run did not finish)');
  });
});

describe("the raw export's gate: the reader's stricter answers and the rule's order (L7.6a)", () => {
  /** NEW of a control state with its files rewritten, through the gate. */
  async function gateOf(slug: string, files: { record?: (r: Record<string, unknown>) => unknown; timeline?: (t: Record<string, unknown>) => unknown }): Promise<string> {
    const b = buildState(root, 'ctl', { slug });
    for (const [name, change] of [
      ['run.json', files.record],
      ['timeline.json', files.timeline],
    ] as const) {
      if (!change) continue;
      const file = join(b.newDir, name);
      writeFileSync(file, JSON.stringify(change(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)));
    }
    return gate(b, b.newDir);
  }

  it('a timeline that parses and is no timeline is refused with one sentence (before: taken as it was, and a crash further on)', async () => {
    const NOT_A_TIMELINE = 'RawExportError: run NEW: its timeline does not read (timeline.json is not a timeline)';
    // No scenario, no run id, no `capture`: the head does not read (the run is named by its folder).
    expect(await gateOf('gate-head', { timeline: () => ({ mode: 'capture' }) })).toBe(NOT_A_TIMELINE);
    expect(await gateOf('gate-list', { timeline: () => [] })).toBe(NOT_A_TIMELINE);
    // The head reads; a list of the timeline is no list.
    expect(await gateOf('gate-events', { timeline: (t) => ({ ...t, events: 'none' }) })).toBe(NOT_A_TIMELINE);
    expect(await gateOf('gate-scenes', { timeline: ({ scenes: _scenes, ...t }) => t })).toBe(NOT_A_TIMELINE);
    // Control: the same folder untouched passes.
    expect(await gateOf('gate-control', {})).toBe('passes');
  });

  it('a run of a newer format says so first, whatever else is wrong with it (before: the timeline was judged first)', async () => {
    const b = buildState(root, 'o', { slug: 'gate-newer-bare' });
    rmSync(join(b.newDir, 'timeline.json'));
    // Before: "<dir> has no timeline.json (not a run, or the run did not finish)".
    expect(await gate(b, b.newDir)).toBe(NEWER);
    // Before: "run NEW is a dry run: it has no capture to export".
    expect(await gateOf('gate-newer-dry', { record: (r) => ({ ...r, version: 2 }), timeline: (t) => ({ ...t, mode: 'dry' }) })).toBe(NEWER);
  });

  it('the sentences name the run as its timeline does, the folder when the timeline does not read', async () => {
    expect(await gateOf('gate-name-dry', { timeline: (t) => ({ ...t, mode: 'dry', run_id: 'as-the-timeline-says' }) })).toBe(
      'RawExportError: run as-the-timeline-says is a dry run: it has no capture to export',
    );
    expect(await gateOf('gate-name-newer', { record: (r) => ({ ...r, version: 2 }), timeline: (t) => ({ ...t, run_id: 'as-the-timeline-says' }) })).toBe(
      NEWER.replace('run NEW', 'run as-the-timeline-says'),
    );
  });

  it('what the package says of the run comes from its record, whatever its status: a failed take exports as `failed`', async () => {
    const read = async (state: string) => (await rawExportRun(buildState(root, state, { slug: `gate-record-${state}` }).newDir)).record;
    const said = async (state: string) => {
      const r = await read(state);
      return r === undefined ? 'none' : `${r.status}/${r.env}`;
    };
    // The manifest's `run.status` and `run.env` (and the display table's environment for a run of before L1.7).
    expect([await said('ctl'), await said('c'), await said('e'), await said('t7'), await said('i')]).toEqual([
      'succeeded/local',
      'failed/local',
      'cancelled/local',
      'running/local',
      'succeeded/local',
    ]);
    // A status Retake never writes is still what the record says.
    expect(await said('r')).toBe('done/local');
    // No record, a record cut short, a file that is no record: the package names no status and no environment.
    expect([await said('k'), await said('j'), await said('s')]).toEqual(['none', 'none', 'none']);
    // The film is not the gate's (the clips come from the frames a run kept): a run without it is read.
    expect([await said('g'), await said('gf'), await said('d')]).toEqual(['succeeded/local', 'succeeded/local', 'failed/local']);
    // A record that parses and is no record — here a succeeded run that holds an error — is not read (before: its
    // status and environment were taken as they stood).
    const b = buildState(root, 'ctl', { slug: 'gate-record-impossible' });
    const file = join(b.newDir, 'run.json');
    writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>), error: { message: 'x' } }));
    expect((await rawExportRun(b.newDir)).record).toBeUndefined();
    expect(await gate(b, b.newDir)).toBe('passes');
  });
});

describe('the record a run ends with (a real dry run per outcome)', () => {
  const START = ['version', 'id', 'project', 'scenario', 'mode', 'status', 'started_at', 'dir', 'env', 'options', 'steps_total', 'steps_done', 'screenshots', 'hooks', 'warnings', 'environment'];
  function run(name: string, scenario: Omit<Scenario, 'video'>, opts: Partial<RunOptions> = {}): Promise<RunRecord> {
    const dir = join(root, 'runner');
    return runScenario({
      policy: PERSON_POLICY,
      project: makeProject(dir, { app: server.url }),
      scenario: makeScenario(name, { pacing: FAST, ...scenario }),
      mode: 'dry',
      runId: `${name}-1`,
      ...opts,
    });
  }
  /** run.json as written: a state of the written record (the schema refuses any other). */
  const onDisk = (rec: RunRecord) => {
    const value = JSON.parse(readFileSync(join(rec.dir, 'run.json'), 'utf8')) as Record<string, unknown>;
    expect(RunRecordSchema.safeParse(value).error?.issues ?? []).toEqual([]);
    return value;
  };
  const ends = (rec: RunRecord) => {
    const lines = readFileSync(join(rec.dir, 'log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; run?: Record<string, unknown> });
    return [lines[0].type, lines[0].run?.status, lines[lines.length - 1].type, lines[lines.length - 1].run?.status];
  };

  it('a pre-assigned run id that is no run id is refused before any folder is made (L7.6a)', async () => {
    // Before the lot any text was taken as the folder's name, a path included.
    for (const id of ['../elsewhere', 'a/b', '.hidden', '', 'a'.repeat(201)]) {
      await expect(run('never', { scenes: [{ id: 'one', open: '/dry.html', steps: [{ click: 'Other' }] }] }, { runId: id }), id).rejects.toThrow(
        /is not a run id \(a folder name of runs\/: letters, digits, "\.", "_" and "-", never a path\)/,
      );
    }
    expect(existsSync(join(root, 'runner', 'runs'))).toBe(false);
    expect(existsSync(join(root, 'elsewhere'))).toBe(false);
  });

  it('succeeded (stopped by --until): no `current`, no `error`; its end, its timeline, where it stopped', async () => {
    const rec = await run('ok', { scenes: [{ id: 'one', open: '/dry.html', steps: [{ click: 'Save draft' }, { click: 'Other' }] }] }, { until: 'one.0' });
    expect(Object.keys(rec)).toEqual([...START, 'engine', 'stopped_at', 'timeline', 'finished_at']);
    expect(Object.keys(onDisk(rec))).toEqual(Object.keys(rec));
    expect([rec.status, rec.stopped_at, rec.options]).toEqual(['succeeded', { scene: 'one', step: 0, reason: 'until' }, { hooks: 'skip', headed: false, until: 'one.0' }]);
    expect(ends(rec)).toEqual(['run_start', 'running', 'run_end', 'succeeded']);
  }, 60_000);

  it('failed: an `error` and its end, no `current`', async () => {
    const rec = await run('bad', { scenes: [{ id: 'one', open: '/dry.html', steps: [{ click: 'Save draft' }, { click: 'Publish catalogue', timeout: 0.4 }] }] });
    expect(Object.keys(rec)).toEqual([...START, 'engine', 'timeline', 'finished_at', 'error']);
    expect(Object.keys(onDisk(rec))).toEqual(Object.keys(rec));
    expect([rec.status, Object.keys(rec.error ?? {})]).toEqual(['failed', ['message', 'scene', 'step', 'action', 'screenshot', 'dom']]);
    expect(ends(rec)).toEqual(['run_start', 'running', 'run_end', 'failed']);
  }, 60_000);

  it('cancelled: an `error` with its message and its end, no `current`', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 900);
    const rec = await run('stop', { scenes: [{ id: 'one', open: '/dry.html', steps: [{ wait: 20 }] }] }, { signal: ac.signal });
    expect(Object.keys(rec)).toEqual([...START, 'engine', 'timeline', 'finished_at', 'error']);
    expect(Object.keys(onDisk(rec))).toEqual(Object.keys(rec));
    expect([rec.status, Object.keys(rec.error ?? {})]).toEqual(['cancelled', ['message']]);
    expect(ends(rec)).toEqual(['run_start', 'running', 'run_end', 'cancelled']);
  }, 60_000);
});
