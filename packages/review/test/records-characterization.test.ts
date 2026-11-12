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
import { findPrevious, findRender, renderRun, renderTimeline } from '../src/index.js';
import { buildState, stateIds, writeWorkspace } from '../../core/test/fixtures/records/build.js';
import { buildRenderState, renderStateIds, writeRenderFile } from '../../core/test/fixtures/records/build-renders.js';
import type { RenderFileSpec } from '../../core/test/fixtures/records/build-renders.js';

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

  it("the run folder the render names comes first, then the project's runs/<run id>; a past record keeps its blocks", async () => {
    const b = buildState(root, 'i', { slug: 'review-past' });
    const project = await loadProject(b.slug, root);
    const rec = await renderRun(project, { run_id: 'gone', run_dir: b.newDir } as RenderRecord);
    expect([rec?.status, Object.keys(rec?.engine ?? {}), (rec?.perf?.cpu as Record<string, unknown> | undefined)?.x, rec?.perf?.cpu?.retake]).toEqual([
      'succeeded',
      ['node', 'chromium', 'os', 'fonts', 'x'],
      1.5,
      undefined,
    ]);
    expect((await renderTimeline(project, { run_id: b.old, run_dir: join(b.runs, 'gone') } as RenderRecord)).file).toBe(join(b.runs, b.old, 'timeline.json'));
    expect(await renderRun(project, { run_id: 'gone' } as RenderRecord)).toBeUndefined();
  });
  it('a file that parses and is no timeline or no record is passed by for the next place (before: handed over as it stood)', async () => {
    const b = buildState(root, 'ctl', { slug: 'review-strict' });
    const project = await loadProject(b.slug, root);
    const render = { run_id: b.old, run_dir: b.newDir } as RenderRecord;
    const from = async () => [(await renderTimeline(project, render)).file, (await renderRun(project, render))?.started_at];
    const [NEW, OLD] = [
      [join(b.newDir, 'timeline.json'), '2026-10-02T08:00:00.000Z'],
      [join(b.runs, b.old, 'timeline.json'), '2026-10-01T08:00:00.000Z'],
    ];
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

// ── The render records (L7.6b): the render a review works on, state by state ─
//
// The states are those of core/test/fixtures/records/render-states.json. The cells were written before the lot (its
// P0) and flipped by its editor part on purpose: a cell that changed is marked `moved: <row>` (the lead's plan §4 and
// §1b) and says what it held before. Since the lot `latest` takes the newest succeeded complete record whatever its
// file is called and works on THAT FILE (ruling 2); the render compared with is one of the complete records of their
// own file (D-10), by core's previousRender.

describe('the render a review works on, state by state', () => {
  const NAME: Record<string, string> = {
    ctl: 'quote-v1',
    'renamed-newest': 'quote-final',
    'renamed-fixed': 'quote-final',
    'renamed-old': 'quote-final',
    'renamed-reused': 'quote-final',
    copy: 'quote-v1 copy',
    'copy-backup': 'quote-v1-backup',
    'out-name': 'quote-final',
    'empty-id': 'x',
    'keep-json': 'keep',
    'keep-json-without': 'quote-v1',
    'final-files': 'quote-v1.final',
  };
  const said = (e: unknown): string => `${(e as Error).name}: ${(e as Error).message.replaceAll(root, '<root>')}`;
  type Row = [latest: string, named: string, previous: string];
  const RTABLE: Record<string, Row> = {
    ctl: ['quote-v1', 'taken quote-v1', 'none'],
    v2: ['quote-v2', 'taken quote-v2', 'quote-v1'],
    // moved: rows 1 and 21 — latest answers quote-v1; named, the review finds no render to compare with (before: a raw TypeError in both)
    'no-created': ['quote-v1', 'taken quote-v2', 'none'],
    // moved: rows 1 and 21 — as above
    'created-5': ['quote-v1', 'taken quote-v2', 'none'],
    // ruling 2 (row 24): latest takes the renamed record BY ITS FILE (the CLI's table says the line); named, as before
    'renamed-newest': ['quote-v2', 'taken quote-v2', 'quote-v1'],
    // ruling 2, as above
    'renamed-fixed': ['quote-v2', 'taken quote-v2', 'quote-v1'],
    // named, as before (at a terminal row 8 adds one line)
    'renamed-old': ['quote-v3', 'taken quote-v0', 'none'],
    // moved: row 9 — named: refused, its stored video is now another render's (before: taken)
    'renamed-reused': [
      'quote-v4',
      'ReviewError: renders/quote-final.json says it is quote-v1, and renders/quote-v1.mp4 is now the video of another render: nothing to review — correct "file" in the record, or render again with --out',
      '-',
    ],
    // named, as before (at a terminal row 8 adds one line)
    copy: ['quote-v1', 'taken quote-v1', 'none'],
    // named, as before (at a terminal row 8 adds one line)
    'copy-backup': ['quote-v1', 'taken quote-v1', 'none'],
    'video-gone': ['quote-v2', 'taken quote-v2', 'quote-v1'],
    'scenario-other': ['quote-v1', 'taken quote-v2', 'none'],
    'scenario-7': ['quote-v1', 'taken quote-v2', 'none'],
    'no-scenario': ['quote-v1', 'taken quote-v2', 'none'],
    'no-variant': ['quote-v2', 'taken quote-v2', 'none'],
    'lock-only': ['quote-v1', 'ReviewError: render "quote-v2" not found in <root>/projects/r-lock-only/renders (renders: quote-v1); use a render id, a .json/.mp4 path or "latest"', '-'],
    'video-only': ['quote-v1', 'ReviewError: render "quote-v2" not found in <root>/projects/r-video-only/renders (renders: quote-v1); use a render id, a .json/.mp4 path or "latest"', '-'],
    paused: ['quote-v1', 'taken quote-v2', 'quote-v1'],
    failed: ['quote-v1', 'taken quote-v2', 'quote-v1'],
    'variant-cube': ['quote-v2', 'taken quote-v2', 'none'],
    // moved: row 10 — named: the newer-Retake sentence (before: `… is not a render record (renders/<id>.json)`)
    'version-2': [
      'quote-v1',
      'ReviewError: <root>/projects/r-version-2/renders/quote-v2.json: this render record is version 2: it was made for a newer Retake (this one reads version 1) — update Retake',
      '-',
    ],
    // moved: row 14 — latest is quote-v1, the link passed over (before: quote-v2); named, read through the link as before
    link: ['quote-v1', 'taken quote-v2', 'quote-v1'],
    // D-11: a terminal's latest is quote-final (must not move)
    'out-name': ['quote-final', 'taken quote-final', 'quote-v1'],
    // moved: row 13 — named: the record has no plan (before: `… is not a render record (renders/<id>.json)`)
    'no-plan': ['quote-v1', 'ReviewError: render quote-v2 has no plan (<root>/projects/r-no-plan/renders/quote-v2.json): nothing to review', '-'],
    // moved: row 15 — the file does not read as a render record (before: a JSON parser's message)
    'cut-short': ['quote-v1', 'ReviewError: <root>/projects/r-cut-short/renders/quote-v2.json does not read as a render record (it is not JSON)', '-'],
    // moved: row 15 (before: `… is not a render record (renders/<id>.json)`)
    array: ['quote-v1', 'ReviewError: <root>/projects/r-array/renders/quote-v2.json does not read as a render record', '-'],
    // moved: row 15 (before: the same)
    'null': ['quote-v1', 'ReviewError: <root>/projects/r-null/renders/quote-v2.json does not read as a render record', '-'],
    // moved: rows 15 and 28 — named: the file does not read as a render record (status) (before: taken, compared with quote-v1)
    'no-status': ['quote-v1', 'ReviewError: <root>/projects/r-no-status/renders/quote-v2.json does not read as a render record (status)', '-'],
    'no-run-id': ['quote-v2', 'taken quote-v2', 'quote-v1'],
    // ruling 25: latest still picks it BY ITS FILE (x.json); a terminal says its id in fixed words, and its review folder is review/x
    'empty-id': ['""', 'taken ""', 'quote-v1'],
    'file-outside': ['quote-v2', 'taken quote-v2', 'quote-v1'],
    // named, as before (at a terminal row 8 adds one line)
    'keep-json': ['quote-v4', 'taken quote-v1', 'none'],
    'keep-json-without': ['quote-v4', 'taken quote-v1', 'none'],
    // D-11: a terminal's latest takes a record of its own file under any name (must not move)
    'final-files': ['quote-v1.final', 'taken quote-v1.final', 'quote-v4'],
  };

  it('every state of the table: `latest`, the render named, and the render it is compared with', async () => {
    const got: Record<string, Row> = {};
    for (const id of renderStateIds()) {
      const b = buildRenderState(root, id);
      const project = await loadProject(b.slug, root);
      const latest = await findRender(project, 'latest', 'quote').then((r) => r.id || '""', said);
      let previous = '-';
      const named = await findRender(project, NAME[id] ?? 'quote-v2').then(async (r) => {
        previous = await findPrevious(project, r, undefined).then((p) => p?.id ?? 'none', said);
        return `taken ${r.id || '""'}`;
      }, said);
      got[id] = [latest, named, previous];
    }
    expect(got).toEqual(RTABLE);
  });

  it('the render compared with: the newest succeeded one of the same scenario and variant made before, whose video is there — by creation time, then by version', async () => {
    const b = buildRenderState(root, 'ctl', { slug: 'review-previous' });
    const vars = { dir: b.dir, project: b.slug, old: b.old, new: b.new };
    const add = (spec: RenderFileSpec) => writeRenderFile(b.renders, spec, vars);
    const project = await loadProject(b.slug, root);
    const previous = async (id: string) => (await findPrevious(project, await findRender(project, id), undefined))?.id ?? 'none';
    expect(await previous('quote-v1')).toBe('none');
    add({ file: 'quote-v2', run: 'NEW', at: '2026-10-02T09:02:00.000Z' });
    add({ file: 'quote-v3', run: 'NEW', at: '2026-10-02T09:03:00.000Z' });
    expect([await previous('quote-v3'), await previous('quote-v2')]).toEqual(['quote-v2', 'quote-v1']);
    // Its video gone: passed by for the one before.
    rmSync(join(b.renders, 'quote-v2.mp4'));
    expect(await previous('quote-v3')).toBe('quote-v1');
    // Another variant, another scenario, a failed one: never the previous.
    add({ file: 'quote-v4-vertical', run: 'NEW', at: '2026-10-02T09:04:00.000Z', set: { variant: 'vertical' } });
    add({ file: 'other-v1', run: 'NEW', at: '2026-10-02T09:04:30.000Z', set: { scenario: 'other' } });
    add({ file: 'quote-v5', run: 'NEW', at: '2026-10-02T09:05:00.000Z', set: { status: 'failed', error: 'x' } });
    add({ file: 'quote-v6', run: 'NEW', at: '2026-10-02T09:06:00.000Z' });
    expect([await previous('quote-v6'), await previous('quote-v4-vertical')]).toEqual(['quote-v3', 'none']);
    // The same creation time: the lower version is "before" — and among several, the LAST of the listing's order
    // (creation time, then id as text: `quote-v10` sorts before `quote-v9`), so v11's previous is v9, not v10.
    for (const n of [9, 10, 11]) add({ file: `quote-v${n}`, run: 'NEW', at: '2026-10-02T09:10:00.000Z' });
    expect([await previous('quote-v11'), await previous('quote-v10'), await previous('quote-v9')]).toEqual(['quote-v9', 'quote-v9', 'quote-v6']);
    // D-10 (L7.6b): a record renamed by hand is no render of the folder's — never the one compared with, its video there
    // or not (before the lot it was, under the id it says: here quote-v12).
    add({ file: 'kept-aside', id: 'quote-v12', run: 'NEW', at: '2026-10-02T09:11:00.000Z' });
    writeFileSync(join(b.renders, 'quote-v12.mp4'), 'x');
    add({ file: 'quote-v13', run: 'NEW', at: '2026-10-02T09:12:00.000Z' });
    expect(await previous('quote-v13')).toBe('quote-v9'); // (of 09:10, the last by id as text — see below)
    // Named by hand: taken as named; the render under review itself is refused.
    expect((await findPrevious(project, await findRender(project, 'quote-v6'), 'quote-v1'))?.id).toBe('quote-v1');
    await expect(findPrevious(project, await findRender(project, 'quote-v6'), 'quote-v6')).rejects.toThrow('--previous quote-v6 is the render under review');
    expect(await findPrevious(project, await findRender(project, 'quote-v6'), false)).toBeUndefined();
  });

  it('a render given by a path: its record, or the record beside its video', async () => {
    const b = buildRenderState(root, 'renamed-fixed', { slug: 'review-paths' });
    const project = await loadProject(b.slug, root);
    expect((await findRender(project, join(b.renders, 'quote-final.json'))).id).toBe('quote-v2');
    expect((await findRender(project, join(b.renders, 'quote-final.mp4'))).id).toBe('quote-v2');
    writeFileSync(join(b.renders, 'alone.mp4'), 'x');
    expect(await findRender(project, join(b.renders, 'alone.mp4')).catch(said)).toBe(
      `ReviewError: <root>/projects/review-paths/renders/alone.mp4 has no render record next to it (alone.json): review needs the plan the video was rendered from`,
    );
    // The renders a "not found" names are the records of their own file (D-10; before the lot: `quote-v1, quote-v2`, the
    // renamed record's inner id among them).
    expect(await findRender(project, 'quote-v9').catch(said)).toBe(
      'ReviewError: render "quote-v9" not found in <root>/projects/review-paths/renders (renders: quote-v1); use a render id, a .json/.mp4 path or "latest"',
    );
  });
});
