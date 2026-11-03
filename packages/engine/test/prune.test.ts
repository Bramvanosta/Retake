/**
 * Pruning a project's runs/, renders/ and review/ (L5.7, R-FLD-28): what goes (failed takes, dry runs, older captures
 * nothing uses, renders beyond the last N of a scenario and variant, failed renders, reviews of renders that go) and
 * what stays (the last good take of each scenario, takes kept renders and comment threads use, renders a thread names,
 * whatever a job names) — a dry run by default, the bytes it frees.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadedProject } from '@retake/core';
import { formatBytes, pruneProject } from '../src/index.js';

let dir: string;
let project: LoadedProject;

async function run(id: string, mode: 'capture' | 'dry', status: string, bytes = 1000): Promise<void> {
  const d = join(dir, 'runs', id);
  await mkdir(d, { recursive: true });
  const scenario = id.replace(/^\d{8}-\d{6}-/, '');
  await writeFile(join(d, 'run.json'), JSON.stringify({ version: 1, id, project: 'p', scenario, mode, status, started_at: '2026-10-20T10:00:00.000Z', dir: d, env: 'local', options: { hooks: 'run', headed: false }, steps_total: 1, steps_done: 1, screenshots: [], hooks: { setup: 'none', teardown: 'none' }, warnings: [] }));
  await writeFile(join(d, 'capture.mp4'), Buffer.alloc(bytes));
}

async function render(id: string, runId: string, status: 'succeeded' | 'failed', createdAt: string, variant = 'landscape'): Promise<void> {
  const scenario = id.replace(/-v\d+(-vertical|-square)?$/, '');
  await writeFile(join(dir, 'renders', `${id}.json`), JSON.stringify({ version: 1, id, scenario, run_id: runId, status, created_at: createdAt, variant, plan: { fps: 30 } }));
  if (status === 'succeeded') await writeFile(join(dir, 'renders', `${id}.mp4`), Buffer.alloc(5000));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ds-prune-'));
  project = { slug: 'p', dir, root: dir, config: { name: 'P', environments: {} }, readme: null, scenarios: [], file: join(dir, 'project.yaml') } as unknown as LoadedProject;
  await mkdir(join(dir, 'renders'), { recursive: true });
  await run('20261020-100000-quote', 'capture', 'succeeded', 4000); // only quote-v1 (dropped) uses it → goes
  await run('20261020-110000-quote', 'capture', 'failed'); // → goes
  await run('20261020-120000-quote', 'dry', 'succeeded'); // → goes
  await run('20261020-130000-quote', 'capture', 'succeeded'); // quote-v2 and its vertical variant (kept)
  await run('20261020-140000-quote', 'capture', 'succeeded'); // the last good take of quote
  await run('20261020-150000-catalogue', 'capture', 'cancelled'); // a job names it → stays
  await run('20261020-090000-catalogue', 'capture', 'succeeded'); // a comment thread's take → stays
  await run('20261020-160000-catalogue', 'capture', 'succeeded'); // the last good take of catalogue
  await run('20261020-170000-signup', 'capture', 'running'); // still running → stays
  await mkdir(join(dir, 'runs', 'not-a-run'), { recursive: true });
  await render('quote-v1', '20261020-100000-quote', 'succeeded', '2026-10-20T11:00:00.000Z');
  await render('quote-v2', '20261020-130000-quote', 'succeeded', '2026-10-20T13:30:00.000Z');
  await render('quote-v3', '20261020-140000-quote', 'succeeded', '2026-10-20T14:30:00.000Z');
  await render('quote-v4', '20261020-140000-quote', 'failed', '2026-10-20T14:40:00.000Z');
  await render('quote-v2-vertical', '20261020-130000-quote', 'succeeded', '2026-10-20T13:40:00.000Z', 'vertical');
  await render('catalogue-v1', '20261020-090000-catalogue', 'succeeded', '2026-10-20T09:30:00.000Z');
  await render('catalogue-v2', '20261020-160000-catalogue', 'succeeded', '2026-10-20T16:30:00.000Z');
  await render('catalogue-v3', '20261020-160000-catalogue', 'succeeded', '2026-10-20T16:40:00.000Z');
  for (const r of ['quote-v1', 'quote-v3', 'catalogue-v1', 'orphan-v9']) {
    await mkdir(join(dir, 'review', r), { recursive: true });
    await writeFile(join(dir, 'review', r, 'report.json'), '{}');
  }
  // A thread made on catalogue-v1 (beyond the last two renders of catalogue): it keeps that render and its take.
  const thread = {
    version: 1,
    id: 'c_01K8AB1CDE2FGH3JKM4NPQ5RST',
    scenario: 'catalogue',
    render: { id: 'catalogue-v1', created_at: '2026-10-20T09:30:00.000Z', run_id: '20261020-090000-catalogue', variant: 'landscape', fps: 30, frames: 300, width: 1920, height: 1080 },
    frame: 10,
    time_s: 0.33,
    text: 'The caption is too long here',
    author: { via: 'cli', name: 'Reviewer' },
    created_at: '2026-10-20T10:00:00.000Z',
    anchor: { segment: 'intro', kind: 'intro' },
    entries: [],
  };
  await mkdir(join(dir, 'comments', 'catalogue'), { recursive: true });
  await writeFile(join(dir, 'comments', 'catalogue', `${thread.id}.json`), JSON.stringify(thread));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('retake prune / project_prune (engine pruneProject)', () => {
  it('a dry run lists what goes and why, how much it frees, and deletes nothing', async () => {
    const busy = (id: string) => id === '20261020-150000-catalogue';
    const r = await pruneProject(project, { keep_renders: 2, busy });
    expect(r.dry_run).toBe(true);
    expect(r.items.map((i) => [i.kind, i.id, i.reason])).toEqual([
      ['run', '20261020-100000-quote', 'older capture nothing uses'],
      ['run', '20261020-110000-quote', 'failed take'],
      ['run', '20261020-120000-quote', 'dry run'],
      ['render', 'quote-v1', 'older render'],
      ['render', 'quote-v4', 'failed render'],
      ['review', 'orphan-v9', 'review of a deleted render'],
      ['review', 'quote-v1', 'review of an older render'],
    ]);
    expect(r.items.find((i) => i.id === 'quote-v1')!.paths.map((p) => p.split('/').pop()).sort()).toEqual(['quote-v1.json', 'quote-v1.mp4']);
    expect(r.items.find((i) => i.id === '20261020-100000-quote')!.bytes).toBeGreaterThanOrEqual(4000);
    expect(r.bytes).toBe(r.items.reduce((n, i) => n + i.bytes, 0));
    expect(r.kept).toEqual({ runs: 6, renders: 6, reviews: 2 });
    expect(existsSync(join(dir, 'runs', '20261020-110000-quote'))).toBe(true);
    expect(existsSync(join(dir, 'renders', 'quote-v1.mp4'))).toBe(true);
    // The default keeps 3 renders per scenario and variant: quote-v1 stays then.
    expect((await pruneProject(project, { busy })).items.map((i) => i.id)).not.toContain('quote-v1');
    await expect(pruneProject(project, { keep_renders: 0 })).rejects.toThrow(/keep_renders 0/);
    expect(formatBytes(1_234_000_000)).toBe('1.2 GB');
    expect(formatBytes(20_300_000)).toBe('20 MB');
  });

  it('dry_run: false deletes exactly those, and a second pass finds nothing', async () => {
    const busy = (id: string) => id === '20261020-150000-catalogue';
    const r = await pruneProject(project, { keep_renders: 2, dry_run: false, busy });
    expect(r.problems).toEqual([]);
    expect((await readdir(join(dir, 'runs'))).sort()).toEqual([
      '20261020-090000-catalogue',
      '20261020-130000-quote',
      '20261020-140000-quote',
      '20261020-150000-catalogue',
      '20261020-160000-catalogue',
      '20261020-170000-signup',
      'not-a-run',
    ]);
    expect((await readdir(join(dir, 'renders'))).filter((f) => f.endsWith('.json')).sort()).toEqual([
      'catalogue-v1.json',
      'catalogue-v2.json',
      'catalogue-v3.json',
      'quote-v2-vertical.json',
      'quote-v2.json',
      'quote-v3.json',
    ]);
    expect((await readdir(join(dir, 'review'))).sort()).toEqual(['catalogue-v1', 'quote-v3']);
    expect((await pruneProject(project, { keep_renders: 2, busy })).items).toEqual([]);
  });
});
