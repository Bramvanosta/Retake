/**
 * Run records as the core reads them today (L7.6a): the schema of what this version writes over the records older
 * builds left, the performance line of a take, and the folder a new run reserves. The fixtures are those of
 * test/fixtures/records (README.md says where each comes from).
 *
 * A row marked `D-<n>` is an outcome a decision of the lot changes; `F-<n>` one a fix made on the way changes.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RUN_ID_MAX, RunRecordSchema, TimelineSchema, isRunId, newRunId, perfSummary } from '../src/index.js';
import type { RunPerf } from '../src/index.js';
import { reserveRunId } from '../src/io/index.js';
import { STATES, recordFixture, recordText, stateIds } from './fixtures/records/build.js';

const tmp = mkdtempSync(join(tmpdir(), 'retake-records-core-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** `ok`, or the paths of the schema's issues (never a value). */
function strict(value: unknown): string {
  const r = RunRecordSchema.safeParse(value);
  return r.success ? 'ok' : r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`).join('; ');
}

describe('the schema of what this version writes, over records of the past', () => {
  it('each past record: accepted, or refused at these paths', () => {
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
    ])
      rows[f] = strict(recordFixture(`past/${f}`));
    expect(rows).toEqual({
      // D-8: the strict schema stays what this version writes; the reader of the lot reads this record (both blocks kept).
      'run-0.1.0/run.json': 'engine.retake: invalid_type; perf.cpu.retake: invalid_type',
      'run-phase1.json': 'ok',
      'run-queued.json': 'ok',
      'run-closed-from-queued.json': 'ok',
      'run-running.json': 'ok',
      'run-closed-from-running.json': 'ok',
      'run-closed-from-paused.json': 'ok',
      'run-dry.json': 'engine.retake: invalid_type',
    });
  });

  it('a key the schema does not know, in `engine` and in `perf.cpu`: refused there, whatever its name', () => {
    for (const key of ['x', 'tool', 'k_9', 'a'.repeat(40), 'made.by']) {
      const value = recordFixture('past/run-0.1.0/run.json') as { engine: Record<string, unknown>; perf: { cpu: Record<string, unknown> } };
      value.engine[key] = '0.1.0';
      value.perf.cpu[key] = 1.5;
      expect(strict(value), key).toBe('engine.retake: invalid_type; engine: unrecognized_keys; perf.cpu.retake: invalid_type; perf.cpu: unrecognized_keys');
    }
  });

  it('each state of the table: the record as written to disk', () => {
    const rows: Record<string, string> = {};
    for (const id of stateIds({ named: true })) {
      const text = recordText(STATES.states[id], { id: STATES.states[id].name ?? STATES.new, dir: '/w/runs/x', project: 'p' });
      let value: unknown;
      try {
        value = text === undefined ? undefined : JSON.parse(text);
      } catch {
        rows[id] = 'not JSON';
        continue;
      }
      const r = text === undefined ? 'no file' : strict(value);
      if (r !== 'ok') rows[id] = r;
    }
    // Every other state's record passes the schema of written records: each is a state a writer makes.
    expect(rows).toEqual({
      i: 'engine.retake: invalid_type; engine: unrecognized_keys; perf.cpu.retake: invalid_type; perf.cpu: unrecognized_keys',
      j: 'not JSON',
      k: 'no file',
      o: 'version: invalid_value',
      of: 'version: invalid_value',
      r: 'status: invalid_union',
      s: '(root): invalid_type',
      // A record of a later version: every word and block this version would not write is refused by the schema of
      // WRITTEN records — and none of them by the reader (run-record.test.ts): the two are not the same question.
      v: 'options.hooks: invalid_value; options.cursor: invalid_value; options: unrecognized_keys; environment.access: invalid_value; environment.sandbox.provider: invalid_value; environment.sandbox.strategy: invalid_value; environment: unrecognized_keys; hooks.teardown: invalid_value; hooks.steps: invalid_value; stopped_at.reason: invalid_value; engine: unrecognized_keys; perf.machine: invalid_type; perf.frame_rate_limit: invalid_type; perf.frames: invalid_type; perf.stalls: invalid_type; perf: unrecognized_keys; pauses.0: unrecognized_keys; (root): unrecognized_keys',
    });
  });

  it('the schema of written records refuses the states no writer makes (L7.6a: one state per status)', () => {
    // Before the lot the flat schema accepted each of these: it had no rule between `status` and the other members.
    const base = JSON.parse(recordText({ about: 'base' }, { id: STATES.new, dir: '/w/runs/x', project: 'p' })!) as Record<string, unknown>;
    expect(strict({ ...base, error: { message: 'x' } })).toBe('error: invalid_type');
    expect(strict({ ...base, status: 'queued' })).toBe('finished_at: invalid_type; capture: invalid_type; timeline: invalid_type');
    const { finished_at: _f, ...unfinished } = base;
    expect(strict(unfinished)).toBe('finished_at: invalid_type');
    expect(strict({ ...base, status: 'failed' })).toBe('error: invalid_type');
  });

  it('the past timeline passes the timeline schema', () => {
    expect(TimelineSchema.safeParse(recordFixture('past/run-0.1.0/timeline.json')).success).toBe(true);
  });
});

describe('the performance line of a take', () => {
  it('a take whose `perf.cpu` has no `retake`: the line says retake 0.00', () => {
    const perf = (recordFixture('past/run-0.1.0/run.json') as unknown as { perf: RunPerf }).perf;
    expect(perfSummary(perf)).toBe('0.93 cores (Chromium 0.59, encoder 0.18, retake 0.00, product 0.01) · 32.3 fps (moves ≥ 38) · no freeze · no slow transition · 21 MB');
    // D-8: the same line whatever other key the block holds.
    for (const key of ['x', 'tool', 'k_9', 'a'.repeat(40), 'made.by']) expect(perfSummary({ ...perf, cpu: { ...perf.cpu!, [key]: 1.5 } }), key).toBe(perfSummary(perf));
  });
});

describe('the folder a new run reserves', () => {
  it('a scenario name the stamp leaves room for: a run id', async () => {
    const at = new Date(2026, 9, 17, 14, 22, 33);
    const name = 'a'.repeat(RUN_ID_MAX - 16);
    const r = await reserveRunId(join(tmp, 'fits'), name, at);
    expect([r.id.length, isRunId(r.id)]).toEqual([RUN_ID_MAX, true]);
  });

  it('a longer scenario name: refused before any folder is made (a folder that is no run id is a run no list shows)', async () => {
    // F-8 (small point 3.6). Before the lot: the folder was made, 206 characters long, and no list showed the run.
    const at = new Date(2026, 9, 17, 14, 22, 33);
    const name = 'a'.repeat(190);
    expect([newRunId(name, at).length, isRunId(newRunId(name, at))]).toEqual([206, false]);
    await expect(reserveRunId(join(tmp, 'long'), name, at)).rejects.toThrow(
      `scenario "${'a'.repeat(40)}…": its name is too long for a run folder, which is named after it (a run id holds at most 200 characters: 184 for the scenario's name) — give the scenario file a shorter name`,
    );
    expect(existsSync(join(tmp, 'long'))).toBe(false);
    // One character less than the limit's overflow: the last name that fits.
    expect((await reserveRunId(join(tmp, 'long'), 'a'.repeat(184), at)).id.length).toBe(200);
    await expect(reserveRunId(join(tmp, 'long'), 'a'.repeat(185), at)).rejects.toThrow('too long for a run folder');
  });
});
