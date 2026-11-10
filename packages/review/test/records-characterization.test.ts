/**
 * The run of a render as the review reads it (L7.6a): `renderRun` (the take's record: what it cost) and
 * `renderTimeline`, state by state (core/test/fixtures/records/states.json; NEW: the state named). A review reads the
 * run its render names, whatever the record says: these rows do not move in this lot but where marked (the reads go
 * through the core's one reader: a file that is no record, or one a newer Retake wrote, is not handed over).
 */
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProject } from '@retake/core/io';
import type { RenderRecord } from '@retake/editor/plan';
import { renderRun, renderTimeline } from '../src/index.js';
import { buildState, stateIds, writeWorkspace } from '../../core/test/fixtures/records/build.js';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'retake-records-review-'));
  writeWorkspace(root);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Per state: what the record read says (`status/scenario`, or what was parsed), then whether the timeline read. */
const ROWS: Record<string, [record: string, timeline: string]> = {
  a: ['running/quote', 'none'],
  b: ['queued/quote', 'none'],
  c: ['failed/quote', 'capture'],
  d: ['failed/quote', 'capture'],
  e: ['cancelled/quote', 'capture'],
  f: ['succeeded/quote', 'dry'],
  gn: ['succeeded/quote', 'none'],
  j: ['none', 'capture'],
  k: ['none', 'capture'],
  l: ['succeeded/quote', 'none'],
  o: ['none', 'capture'], // D-6: a record a newer Retake wrote is not read (before: `succeeded/quote`, taken as it stood)
  of: ['none', 'capture'], // D-6: the same (before: `failed/quote`)
  p: ['succeeded/other', 'capture'],
  p2: ['succeeded/other', 'capture'],
  r: ['done/quote', 'capture'],
  s: ['none', 'capture'], // F-6: a run.json that is no record is not handed over (before: the empty list itself)
  t7: ['running/quote', 'capture'],
  k1f: ['failed/quote', 'capture'],
  k2: ['none', 'none'],
  k3: ['none', 'none'],
};

describe('the run of a render, state by state', () => {
  it('every state of the table: the record and the timeline the review reads', async () => {
    const got: Record<string, [string, string]> = {};
    for (const id of stateIds({ named: true })) {
      const b = buildState(root, id);
      const project = await loadProject(b.slug, root);
      const render = { run_id: b.new } as RenderRecord;
      const rec: unknown = await renderRun(project, render);
      const r = rec as { status?: string; scenario?: string } | undefined;
      const tl = (await renderTimeline(project, render)).timeline;
      const row: [string, string] = [rec === undefined ? 'none' : Array.isArray(rec) ? 'an array' : `${r?.status}/${r?.scenario}`, tl ? tl.mode : 'none'];
      if (row.join() !== 'succeeded/quote,capture') got[id] = row;
    }
    // Every state not listed: its record reads `succeeded/quote` and its timeline is a capture's.
    expect(got).toEqual(ROWS);
  });

  it('the run folder the render names comes first, then the project\'s runs/<run id>; a past record keeps its blocks', async () => {
    const b = buildState(root, 'i', { slug: 'review-past' });
    const project = await loadProject(b.slug, root);
    const rec = await renderRun(project, { run_id: 'gone', run_dir: b.newDir } as RenderRecord);
    expect([rec?.status, Object.keys(rec?.engine ?? {}), (rec?.perf?.cpu as Record<string, unknown> | undefined)?.x, rec?.perf?.cpu?.retake]).toEqual(['succeeded', ['node', 'chromium', 'os', 'fonts', 'x'], 1.5, undefined]);
    expect((await renderTimeline(project, { run_id: b.old, run_dir: join(b.runs, 'gone') } as RenderRecord)).file).toBe(join(b.runs, b.old, 'timeline.json'));
    expect(await renderRun(project, { run_id: 'gone' } as RenderRecord)).toBeUndefined();
  });
  it('a file that parses and is no timeline or no record is passed by for the next place (before: handed over as it stood)', async () => {
    const b = buildState(root, 'ctl', { slug: 'review-strict' });
    const project = await loadProject(b.slug, root);
    const render = { run_id: b.old, run_dir: b.newDir } as RenderRecord;
    const from = async () => [(await renderTimeline(project, render)).file, (await renderRun(project, render))?.started_at];
    const [NEW, OLD] = [[join(b.newDir, 'timeline.json'), '2026-10-02T08:00:00.000Z'], [join(b.runs, b.old, 'timeline.json'), '2026-10-01T08:00:00.000Z']];
    expect(await from()).toEqual(NEW);
    // Files that are links are read, as they always were (the render names its run).
    for (const name of ['run.json', 'timeline.json']) {
      renameSync(join(b.newDir, name), join(root, `review-strict-${name}`));
      symlinkSync(join(root, `review-strict-${name}`), join(b.newDir, name));
    }
    expect(await from()).toEqual(NEW);
    // A timeline without its lists; a succeeded record that holds an error.
    const tl = JSON.parse(readFileSync(NEW[0], 'utf8')) as Record<string, unknown>;
    writeFileSync(NEW[0], JSON.stringify({ ...tl, events: undefined }));
    const rec = JSON.parse(readFileSync(join(b.newDir, 'run.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(b.newDir, 'run.json'), JSON.stringify({ ...rec, error: { message: 'x' } }));
    expect(await from()).toEqual(OLD);
    writeFileSync(NEW[0], JSON.stringify({ mode: 'capture' }));
    expect((await renderTimeline(project, render)).file).toBe(OLD[0]);
  });
});
