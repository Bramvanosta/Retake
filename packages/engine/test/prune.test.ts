/**
 * Pruning a project's runs/, renders/ and review/ (L5.7, R-FLD-28): what goes (failed takes, dry runs, older captures
 * nothing uses, renders beyond the last N of a scenario and variant, failed renders, reviews of renders that go) and
 * what stays (the last good take of each scenario, takes kept renders and comment threads use, renders a thread names,
 * whatever a job names) — a dry run by default, the bytes it frees. An agent's deletion (every client but the CLI and
 * tests) asks the person first and deletes only what they saw that can still go then; no form or a decline deletes
 * nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadedProject } from '@retake/core';
import { ulid } from '@retake/core';
import { EngineError, JOB_RECORD_VERSION, PRUNE_FORM_MAX_LINES, createEngine, formatBytes, pruneProject } from '../src/index.js';
import type { ApprovalOutcome, Approver, EngineClient, PruneApprovalRequest } from '../src/index.js';

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

describe('an agent\'s prune asks the person first (projects.prune under agent trust)', () => {
  /** A workspace with project p: four takes that can go, the last good one, and an orphan review. */
  async function workspace(): Promise<{ root: string; proj: string; take: (id: string, status: string, mode?: 'capture' | 'dry') => Promise<void>; left: () => Promise<string[]> }> {
    const root = await mkdtemp(join(tmpdir(), 'retake-prune-ask-'));
    const proj = join(root, 'projects', 'p');
    await mkdir(proj, { recursive: true });
    await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\n');
    await writeFile(join(proj, 'project.yaml'), 'name: P\nenvironments:\n  local:\n    app: http://127.0.0.1:9\n');
    const take = async (id: string, status: string, mode: 'capture' | 'dry' = 'capture') => {
      const d = join(proj, 'runs', id);
      await mkdir(d, { recursive: true });
      await writeFile(join(d, 'run.json'), JSON.stringify({ version: 1, id, project: 'p', scenario: 'quote', mode, status, started_at: '2026-10-20T10:00:00.000Z', dir: d, env: 'local', options: { hooks: 'run', headed: false }, steps_total: 1, steps_done: 1, screenshots: [], hooks: { setup: 'none', teardown: 'none' }, warnings: [] }));
      await writeFile(join(d, 'capture.mp4'), Buffer.alloc(2000));
    };
    await take('20261020-100000-quote', 'failed');
    await take('20261020-110000-quote', 'succeeded', 'dry');
    await take('20261020-120000-quote', 'failed');
    await take('20261020-130000-quote', 'cancelled');
    await take('20261020-140000-quote', 'succeeded');
    await mkdir(join(proj, 'review', 'orphan-v1'), { recursive: true });
    await writeFile(join(proj, 'review', 'orphan-v1', 'report.json'), '{}');
    const left = async () => [...(await readdir(join(proj, 'runs'))).sort(), ...(await readdir(join(proj, 'review'))).map((r) => `review/${r}`)];
    return { root, proj, take, left };
  }
  const ALL = ['20261020-100000-quote', '20261020-110000-quote', '20261020-120000-quote', '20261020-130000-quote', '20261020-140000-quote', 'review/orphan-v1'];

  function asking(answer: ApprovalOutcome | ((req: PruneApprovalRequest) => Promise<ApprovalOutcome>)): Approver & { asked: PruneApprovalRequest[] } {
    const asked: PruneApprovalRequest[] = [];
    return {
      asked,
      approve: async () => ({ approved: true }),
      approvePrune: async (req) => {
        asked.push(req);
        return typeof answer === 'function' ? answer(req) : answer;
      },
    };
  }

  async function refusal(p: Promise<unknown>): Promise<EngineError> {
    const e = await p.then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(EngineError);
    return e as EngineError;
  }

  const engineOf = (root: string, client: EngineClient) => createEngine({ root, client, autoStartWorker: false });

  it('no form to ask with: needs_approval with the terminal command, and nothing is deleted (MCP and Studio wording)', async () => {
    const w = await workspace();
    try {
      const mcp = await engineOf(w.root, 'mcp');
      const e = await refusal(mcp.projects.prune('p', { dry_run: false }));
      expect(e.code).toBe('needs_approval');
      expect(e.message).toContain('deleting 5 items of p');
      expect(e.message).toContain('this MCP client cannot ask its user');
      expect(e.fix).toMatch(/^retake -C .+ prune p --yes$/);
      // An approver that cannot ask about a prune is no approver.
      expect((await refusal(mcp.projects.prune('p', { dry_run: false }, { approver: { approve: async () => ({ approved: true }) } }))).code).toBe('needs_approval');
      const ui = await engineOf(w.root, 'ui');
      const s = await refusal(ui.projects.prune('p', { dry_run: false, keep_renders: 2 }));
      expect(s.code).toBe('needs_approval');
      expect(s.message).toContain('the Studio cannot approve it yet: run it in a terminal');
      expect(s.fix).toMatch(/ prune p --keep-renders 2 --yes$/);
      expect(await w.left()).toEqual(ALL);
      // A dry run asks nobody.
      expect((await mcp.projects.prune('p', {})).items).toHaveLength(5);
    } finally {
      await rm(w.root, { recursive: true, force: true });
    }
  });

  it('a declined, dismissed, unanswered or failed question is refused and deletes nothing; the form has the count, the size, the kinds and each item', async () => {
    const w = await workspace();
    try {
      const mcp = await engineOf(w.root, 'mcp');
      for (const outcome of [{ approved: false, reason: 'declined' }, { approved: false, reason: 'cancelled' }, { approved: false, reason: 'timeout' }, { approved: false, reason: 'error', message: 'closed' }] as const) {
        const a = asking(outcome);
        const e = await refusal(mcp.projects.prune('p', { dry_run: false }, { approver: a }));
        expect(e.code, outcome.reason).toBe('refused');
        expect(e.message).toMatch(/^nothing was deleted: /);
        expect(e.message).toContain('Do not retry on your own');
        expect(a.asked).toHaveLength(1);
      }
      const thrown = asking(async () => {
        throw new Error('form broke');
      });
      expect((await refusal(mcp.projects.prune('p', { dry_run: false }, { approver: thrown }))).code).toBe('refused');
      expect(await w.left()).toEqual(ALL);
      const req = asking({ approved: false, reason: 'declined' });
      await refusal(mcp.projects.prune('p', { dry_run: false }, { approver: req }));
      const q = req.asked[0]!;
      expect(q.project).toBe('p');
      expect(q.count).toBe(5);
      expect(q.bytes).toBeGreaterThanOrEqual(4 * 2000);
      expect(q.by_kind.map((k) => [k.kind, k.count])).toEqual([
        ['run', 4],
        ['review', 1],
      ]);
      expect(q.lines).toEqual([
        expect.stringMatching(/^take 20261020-100000-quote — failed take, \d+ kB$/),
        expect.stringMatching(/^take 20261020-110000-quote — dry run, /),
        expect.stringMatching(/^take 20261020-120000-quote — failed take, /),
        expect.stringMatching(/^take 20261020-130000-quote — cancelled take, /),
        expect.stringMatching(/^review orphan-v1 — review of a deleted render, /),
      ]);
      expect(q.more).toBe(0);
      expect(q.fix).toMatch(/ prune p --yes$/);
    } finally {
      await rm(w.root, { recursive: true, force: true });
    }
  });

  it('accepted: deletes only what the person saw that can still go — a take used since, or prunable since, stays', async () => {
    const w = await workspace();
    try {
      const mcp = await engineOf(w.root, 'mcp');
      const a = asking(async () => {
        // While the person reads: a take starts again, a job is queued that names another, a new failed take appears.
        await w.take('20261020-120000-quote', 'running');
        const id = `j_${ulid()}`;
        await mkdir(join(w.root, '.retake', 'jobs', id), { recursive: true });
        const input = { version: 1, kind: 'render', project: 'p', scenario: 'quote', run_id: '20261020-130000-quote', render_id: 'quote-v1', submitted_by: 'test' };
        await writeFile(join(w.root, '.retake', 'jobs', id, 'job.json'), JSON.stringify({ version: JOB_RECORD_VERSION, id, kind: 'render', input, state: 'queued', created_at: new Date().toISOString() }));
        await w.take('20261020-150000-quote', 'failed');
        return { approved: true };
      });
      const r = await mcp.projects.prune('p', { dry_run: false }, { approver: a });
      expect(a.asked).toHaveLength(1);
      expect(r.dry_run).toBe(false);
      expect(r.items.map((i) => i.id)).toEqual(['20261020-100000-quote', '20261020-110000-quote', 'orphan-v1']);
      expect(r.skipped).toEqual([
        { kind: 'run', id: '20261020-120000-quote' },
        { kind: 'run', id: '20261020-130000-quote' },
      ]);
      expect(r.not_asked).toBe(1);
      expect(await w.left()).toEqual(['20261020-120000-quote', '20261020-130000-quote', '20261020-140000-quote', '20261020-150000-quote']);
      // Nothing to delete: nobody is asked.
      const none = asking({ approved: true });
      await rm(join(w.proj, 'runs', '20261020-150000-quote'), { recursive: true });
      await rm(join(w.root, '.retake', 'jobs'), { recursive: true });
      await w.take('20261020-120000-quote', 'running');
      await w.take('20261020-130000-quote', 'running');
      expect((await mcp.projects.prune('p', { dry_run: false }, { approver: none })).items).toEqual([]);
      expect(none.asked).toEqual([]);
    } finally {
      await rm(w.root, { recursive: true, force: true });
    }
  });

  it('a long list: the form shows the first 20 items and counts the rest in its totals', async () => {
    const w = await workspace();
    try {
      for (let i = 0; i < 25; i++) await w.take(`20261021-${String(100000 + i)}-quote`, 'failed');
      const a = asking({ approved: false, reason: 'declined' });
      await refusal((await engineOf(w.root, 'mcp')).projects.prune('p', { dry_run: false }, { approver: a }));
      expect(a.asked[0]!.count).toBe(30);
      expect(a.asked[0]!.lines).toHaveLength(PRUNE_FORM_MAX_LINES);
      expect(a.asked[0]!.more).toBe(10);
      expect(a.asked[0]!.by_kind.find((k) => k.kind === 'run')!.count).toBe(29);
    } finally {
      await rm(w.root, { recursive: true, force: true });
    }
  });

  it('a form too long to read (long names) is refused before anyone is asked, and nothing is deleted', async () => {
    const w = await workspace();
    try {
      await mkdir(join(w.proj, 'renders'), { recursive: true });
      for (let i = 0; i < 20; i++) {
        const id = `r${i}-${'x'.repeat(1200)}`;
        await writeFile(join(w.proj, 'renders', `r${i}.json`), JSON.stringify({ version: 1, id, scenario: 'quote', run_id: '20261020-140000-quote', status: 'failed', created_at: '2026-10-20T15:00:00.000Z', variant: 'landscape', plan: { fps: 30 } }));
      }
      const a = asking({ approved: true });
      const e = await refusal((await engineOf(w.root, 'mcp')).projects.prune('p', { dry_run: false }, { approver: a }));
      expect(e.code).toBe('refused');
      expect(e.message).toContain('too long to approve in a form: run it in a terminal');
      expect(a.asked).toEqual([]);
      expect(await w.left()).toEqual(ALL);
      expect((await readdir(join(w.proj, 'renders'))).length).toBe(20);
    } finally {
      await rm(w.root, { recursive: true, force: true });
    }
  });

  it('the CLI (a person at a terminal, --yes) deletes without a form, as before', async () => {
    const w = await workspace();
    try {
      const r = await (await engineOf(w.root, 'cli')).projects.prune('p', { dry_run: false });
      expect(r.items).toHaveLength(5);
      expect(r.skipped).toBeUndefined();
      expect(await w.left()).toEqual(['20261020-140000-quote']);
    } finally {
      await rm(w.root, { recursive: true, force: true });
    }
  });
});
