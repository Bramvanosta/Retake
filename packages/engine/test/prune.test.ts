/**
 * Pruning a project's runs/, renders/ and review/ (L5.7, R-FLD-28): what goes (failed takes, dry runs, older captures
 * nothing uses, renders beyond the last N of a scenario and variant, failed renders, reviews of renders that go) and
 * what stays (the last good take of each scenario, takes kept renders and comment threads use, renders a thread names,
 * whatever a job names) — a dry run by default, the bytes it frees. An agent's deletion (every client but the CLI and
 * tests) asks the person first and deletes the items in the approval that can still go then, each with the files it had
 * when listed; no form or a decline deletes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadedProject } from '@retake/core';
import { ulid } from '@retake/core';
import { APPROVAL_FORM_MAX_CHARS, EngineError, JOB_RECORD_VERSION, PRUNE_FORM_MAX_LINES, createEngine, formatBytes, pruneApprovalFormText, pruneApprovalRequest, pruneProject } from '../src/index.js';
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

  it('accepted: deletes only the items in the approval that can still go — a take used since, or prunable since, stays', async () => {
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

  it('accepted: an approved item goes with the files it had when listed — a file added to it since stays', async () => {
    const w = await workspace();
    try {
      await mkdir(join(w.proj, 'renders'), { recursive: true });
      await writeFile(join(w.proj, 'renders', 'quote-v9.json'), JSON.stringify({ version: 1, id: 'quote-v9', scenario: 'quote', run_id: '20261020-140000-quote', status: 'failed', created_at: '2026-10-20T15:00:00.000Z', variant: 'landscape', plan: { fps: 30 } }));
      const a = asking(async (req) => {
        expect(req.lines).toContainEqual(expect.stringMatching(/^render quote-v9 — failed render, /));
        await writeFile(join(w.proj, 'renders', 'quote-v9.log'), 'written while the person reads');
        return { approved: true };
      });
      const r = await (await engineOf(w.root, 'mcp')).projects.prune('p', { dry_run: false }, { approver: a });
      expect(r.items.find((i) => i.id === 'quote-v9')?.paths).toEqual([join(w.proj, 'renders', 'quote-v9.json')]);
      expect(await readdir(join(w.proj, 'renders'))).toEqual(['quote-v9.log']);
    } finally {
      await rm(w.root, { recursive: true, force: true });
    }
  });

  it('the whole form counts: lines that fit with the command but not with the rest of the form are refused, nothing asked', async () => {
    const w = await workspace();
    try {
      await mkdir(join(w.proj, 'renders'), { recursive: true });
      for (let i = 0; i < 20; i++) {
        const id = `r${String(i).padStart(2, '0')}-${'x'.repeat(931)}`;
        await writeFile(join(w.proj, 'renders', `r${i}.json`), JSON.stringify({ version: 1, id, scenario: 'quote', run_id: '20261020-140000-quote', status: 'failed', created_at: '2026-10-20T15:00:00.000Z', variant: 'landscape', plan: { fps: 30 } }));
      }
      // Its lines and command alone fit in 16,000 characters; with the form's other lines they do not.
      const mcp = await engineOf(w.root, 'mcp');
      const req = pruneApprovalRequest(await mcp.projects.prune('p', {}), 'retake prune p --yes');
      expect(req.lines.reduce((n, l) => n + l.length + 1, req.fix.length)).toBeLessThan(APPROVAL_FORM_MAX_CHARS);
      expect(pruneApprovalFormText(req).length).toBeGreaterThan(APPROVAL_FORM_MAX_CHARS);
      const a = asking({ approved: true });
      const e = await refusal(mcp.projects.prune('p', { dry_run: false }, { approver: a }));
      expect(e.message).toContain('too long to approve in a form: run it in a terminal');
      expect(a.asked).toEqual([]);
      expect(await w.left()).toEqual(ALL);
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

describe('comment threads that cannot be listed (L7.5)', () => {
  it('every render and every take stays, the result says why, and nothing of them is deleted', async () => {
    const d = await mkdtemp(join(tmpdir(), 'ds-prune-threads-'));
    const comments = join(d, 'comments');
    try {
      const p = { slug: 'p', dir: d, root: d, config: { name: 'P', environments: {} }, readme: null, scenarios: [], file: join(d, 'project.yaml') } as unknown as LoadedProject;
      const take = async (id: string, mode: 'capture' | 'dry', status: string) => {
        await mkdir(join(d, 'runs', id), { recursive: true });
        await writeFile(join(d, 'runs', id, 'run.json'), JSON.stringify({ version: 1, id, project: 'p', scenario: 'quote', mode, status, started_at: '2026-10-20T10:00:00.000Z' }));
      };
      const made = async (id: string, runId: string, status: string, at: string) => {
        await writeFile(join(d, 'renders', `${id}.json`), JSON.stringify({ version: 1, id, scenario: 'quote', run_id: runId, status, created_at: at, variant: 'landscape', plan: { fps: 30 } }));
      };
      await mkdir(join(d, 'renders'), { recursive: true });
      await take('20261020-100000-quote', 'capture', 'succeeded'); // only quote-v1 uses it
      await take('20261020-110000-quote', 'dry', 'succeeded');
      await take('20261020-120000-quote', 'capture', 'succeeded'); // the last good take
      await made('quote-v1', '20261020-100000-quote', 'succeeded', '2026-10-20T10:30:00.000Z');
      await made('quote-v2', '20261020-120000-quote', 'succeeded', '2026-10-20T12:30:00.000Z');
      await made('quote-v3', '20261020-120000-quote', 'failed', '2026-10-20T12:40:00.000Z');
      for (const r of ['quote-v1', 'gone-v1']) await mkdir(join(d, 'review', r), { recursive: true });
      await mkdir(join(comments, 'quote'), { recursive: true });
      const ids = (r: Awaited<ReturnType<typeof pruneProject>>) => r.items.map((i) => `${i.kind} ${i.id}`);
      const all = ['run 20261020-100000-quote', 'run 20261020-110000-quote', 'render quote-v1', 'render quote-v3', 'review gone-v1', 'review quote-v1'];

      // The threads are listed (there is none): the older render, the failed one, their takes and reviews can go.
      const listed = await pruneProject(p, { keep_renders: 1 });
      expect(ids(listed)).toEqual(all);
      expect(listed.threads_unread).toBeUndefined();

      // comments/ cannot be read: a thread may name any render and any take.
      await chmod(comments, 0o000);
      const unread = await pruneProject(p, { keep_renders: 1 });
      expect(ids(unread)).toEqual(['review gone-v1']);
      expect(unread.threads_unread).toBe('the comment threads of p cannot be listed (EACCES): every render and take is kept (make comments/ of the project readable, then prune again)');
      expect(unread.kept).toEqual({ runs: 3, renders: 3, reviews: 1 });
      const deleted = await pruneProject(p, { keep_renders: 1, dry_run: false });
      expect(ids(deleted)).toEqual(['review gone-v1']);
      expect(deleted.threads_unread).toBe(unread.threads_unread);
      expect((await readdir(join(d, 'runs'))).sort()).toEqual(['20261020-100000-quote', '20261020-110000-quote', '20261020-120000-quote']);
      expect((await readdir(join(d, 'renders'))).sort()).toEqual(['quote-v1.json', 'quote-v2.json', 'quote-v3.json']);
      expect((await readdir(join(d, 'review'))).sort()).toEqual(['quote-v1']);
      // An approved list made before does not delete them either.
      const only = new Map(listed.items.map((i) => [`${i.kind}:${i.id}`, i.paths]));
      const approved = await pruneProject(p, { keep_renders: 1, dry_run: false, only });
      expect(ids(approved)).toEqual([]);
      expect((await readdir(join(d, 'renders'))).sort()).toEqual(['quote-v1.json', 'quote-v2.json', 'quote-v3.json']);

      // Readable again: what could go goes.
      await chmod(comments, 0o755);
      const again = await pruneProject(p, { keep_renders: 1 });
      expect(ids(again)).toEqual(all.filter((x) => x !== 'review gone-v1'));
      expect(again.threads_unread).toBeUndefined();
    } finally {
      await chmod(comments, 0o755).catch(() => undefined);
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe('comment threads that do not read as threads (L7.5)', () => {
  const ID = 'c_01K8AB1CDE2FGH3JKM4NPQ5RST';
  const OTHER = 'c_01K8AB1CDE2FGH3JKM4NPQ5RSV';
  const SOME = 'some comment threads of p cannot be read (the comment list says which): every render and take ';
  /** A project of two scenarios, each with an older take and render that can go, a failed render and a newer pair that stays. */
  async function twoScenarios(): Promise<{ d: string; p: LoadedProject; all: string[] }> {
    const d = await mkdtemp(join(tmpdir(), 'ds-prune-unread-'));
    const p = { slug: 'p', dir: d, root: d, config: { name: 'P', environments: {} }, readme: null, scenarios: [], file: join(d, 'project.yaml') } as unknown as LoadedProject;
    await mkdir(join(d, 'renders'), { recursive: true });
    for (const s of ['quote', 'catalogue']) {
      for (const [stamp, mode] of [['20261020-100000', 'capture'], ['20261020-110000', 'dry'], ['20261020-120000', 'capture']] as const) {
        await mkdir(join(d, 'runs', `${stamp}-${s}`), { recursive: true });
        await writeFile(join(d, 'runs', `${stamp}-${s}`, 'run.json'), JSON.stringify({ version: 1, id: `${stamp}-${s}`, project: 'p', scenario: s, mode, status: 'succeeded', started_at: '2026-10-20T10:00:00.000Z' }));
      }
      const made = (id: string, runId: string, status: string, at: string) => writeFile(join(d, 'renders', `${id}.json`), JSON.stringify({ version: 1, id, scenario: s, run_id: runId, status, created_at: at, variant: 'landscape', plan: { fps: 30 } }));
      await made(`${s}-v1`, `20261020-100000-${s}`, 'succeeded', '2026-10-20T10:30:00.000Z');
      await made(`${s}-v2`, `20261020-120000-${s}`, 'succeeded', '2026-10-20T12:30:00.000Z');
      await made(`${s}-v3`, `20261020-120000-${s}`, 'failed', '2026-10-20T12:40:00.000Z');
    }
    const of = (s: string) => [`run 20261020-100000-${s}`, `run 20261020-110000-${s}`, `render ${s}-v1`, `render ${s}-v3`];
    return { d, p, all: [...of('catalogue'), ...of('quote')].sort() };
  }
  const ids = (r: Awaited<ReturnType<typeof pruneProject>>) => r.items.map((i) => `${i.kind} ${i.id}`).sort();
  const thread = (scenario: string, id = ID) => JSON.stringify({ version: 1, id, scenario, render: { id: `${scenario}-v9`, created_at: '2026-10-20T09:30:00.000Z', run_id: `20261020-090000-${scenario}`, variant: 'landscape', fps: 30, frames: 300, width: 1920, height: 1080 }, frame: 10, time_s: 0.33, text: 'A comment', author: { via: 'cli', name: 'Reviewer' }, created_at: '2026-10-20T10:00:00.000Z', anchor: { segment: 'intro', kind: 'intro' }, entries: [] });

  it('a thread file that is broken, a link or under another id keeps every render and take of its scenario; the other scenario is pruned as before', async () => {
    const { d, p, all } = await twoScenarios();
    try {
      const folder = join(d, 'comments', 'quote');
      await mkdir(folder, { recursive: true });
      const ofCatalogue = all.filter((x) => x.includes('catalogue'));
      const cases: Array<[string, () => Promise<void>]> = [
        ['not JSON', () => writeFile(join(folder, `${ID}.json`), '{"version": 1, ')],
        ['not a thread', () => writeFile(join(folder, `${ID}.json`), '{"version": 1}')],
        ['a symbolic link', async () => { await writeFile(join(d, 'elsewhere.json'), thread('quote')); await symlink(join(d, 'elsewhere.json'), join(folder, `${ID}.json`)); }],
        ['another id', () => writeFile(join(folder, `${ID}.json`), thread('quote', OTHER))],
      ];
      // Nothing unread yet: everything that can go is listed.
      expect([ids(await pruneProject(p, { keep_renders: 1 })), (await pruneProject(p, { keep_renders: 1 })).threads_unread]).toEqual([all, undefined]);
      for (const [what, write] of cases) {
        await write();
        const r = await pruneProject(p, { keep_renders: 1 });
        expect([what, ids(r), r.threads_unread]).toEqual([what, ofCatalogue, `${SOME}of quote is kept`]);
        expect(r.kept, what).toEqual({ runs: 4, renders: 4, reviews: 0 });
        await rm(join(folder, `${ID}.json`));
      }
      // A deletion keeps them too, and an approval made before the file broke does not delete them.
      const only = new Map((await pruneProject(p, { keep_renders: 1 })).items.map((i) => [`${i.kind}:${i.id}`, i.paths]));
      await cases[0][1]();
      const approved = await pruneProject(p, { keep_renders: 1, dry_run: false, only });
      expect([ids(approved), approved.threads_unread]).toEqual([ofCatalogue, `${SOME}of quote is kept`]);
      expect((await readdir(join(d, 'renders'))).sort()).toEqual(['catalogue-v2.json', 'quote-v1.json', 'quote-v2.json', 'quote-v3.json']);
      expect((await readdir(join(d, 'runs'))).sort()).toEqual(['20261020-100000-quote', '20261020-110000-quote', '20261020-120000-catalogue', '20261020-120000-quote']);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('a thread in another scenario\'s folder keeps both scenarios; a scenario folder that is a link keeps its scenario', async () => {
    const { d, p, all } = await twoScenarios();
    try {
      await mkdir(join(d, 'comments', 'quote'), { recursive: true });
      await writeFile(join(d, 'comments', 'quote', `${ID}.json`), thread('catalogue'));
      const misplaced = await pruneProject(p, { keep_renders: 1 });
      expect([ids(misplaced), misplaced.threads_unread]).toEqual([[], `${SOME}of catalogue, quote is kept`]);
      await rm(join(d, 'comments'), { recursive: true });
      // comments/catalogue is a link to a folder elsewhere (which may hold threads): not followed, not "no thread".
      await mkdir(join(d, 'comments'), { recursive: true });
      await mkdir(join(d, 'elsewhere'));
      await symlink(join(d, 'elsewhere'), join(d, 'comments', 'catalogue'));
      const linked = await pruneProject(p, { keep_renders: 1 });
      expect([ids(linked), linked.threads_unread]).toEqual([all.filter((x) => x.includes('quote')), `${SOME}of catalogue is kept`]);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('more thread files than a listing reads: the rest may name anything, so every render and take stays', async () => {
    const { d, p, all } = await twoScenarios();
    try {
      await mkdir(join(d, 'comments', 'quote'), { recursive: true });
      const digits = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      const id = (n: number) => `c_01K8AB1CDE2FGH3JKM4NPQ${digits[Math.floor(n / 1024) % 32]}${digits[Math.floor(n / 32) % 32]}${digits[n % 32]}0`;
      for (let n = 0; n < 2000; n++) await writeFile(join(d, 'comments', 'quote', `${id(n)}.json`), thread('quote', id(n)));
      // Exactly as many as a listing reads: all read, and they name no render or take that is there.
      const read = await pruneProject(p, { keep_renders: 1 });
      expect([ids(read), read.threads_unread]).toEqual([all, undefined]);
      await writeFile(join(d, 'comments', 'quote', `${id(2000)}.json`), thread('quote', id(2000)));
      const over = await pruneProject(p, { keep_renders: 1 });
      expect([ids(over), over.threads_unread]).toEqual([[], `${SOME}is kept`]);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  }, 60_000);

  it('comments/ itself a link: every render and take stays; what holds no thread — a stray file, a temp file, a name that is no scenario — keeps nothing', async () => {
    const { d, p, all } = await twoScenarios();
    try {
      // No thread can be in these: prune works as without them.
      await mkdir(join(d, 'comments', 'quote'), { recursive: true });
      await writeFile(join(d, 'comments', '.DS_Store'), 'x');
      await mkdir(join(d, 'comments', 'not a scenario'));
      await writeFile(join(d, 'comments', 'not a scenario', `${ID}.json`), '{');
      await writeFile(join(d, 'comments', 'quote', `.${ID}.json.tmp`), '{');
      await writeFile(join(d, 'comments', 'quote', 'notes.txt'), 'x');
      const stray = await pruneProject(p, { keep_renders: 1 });
      expect([ids(stray), stray.threads_unread]).toEqual([all, undefined]);
      // comments/ is a link: nothing of it is read, so nothing is known.
      await rm(join(d, 'comments'), { recursive: true });
      await mkdir(join(d, 'elsewhere'));
      await symlink(join(d, 'elsewhere'), join(d, 'comments'));
      const linked = await pruneProject(p, { keep_renders: 1 });
      expect([ids(linked), linked.threads_unread, linked.kept]).toEqual([[], `${SOME}is kept`, { runs: 6, renders: 6, reviews: 0 }]);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('a take or a record is of an unread scenario by the scenario its record names or by the one its id names', async () => {
    const { d, p, all } = await twoScenarios();
    try {
      const take = async (id: string, scenario: string) => {
        await mkdir(join(d, 'runs', id), { recursive: true });
        await writeFile(join(d, 'runs', id, 'run.json'), JSON.stringify({ version: 1, id, project: 'p', scenario, mode: 'capture', status: 'failed', started_at: '2026-10-20T10:00:00.000Z' }));
      };
      const failed = (id: string, scenario: string) => writeFile(join(d, 'renders', `${id}.json`), JSON.stringify({ version: 1, id, scenario, run_id: '20261020-120000-quote', status: 'failed', created_at: '2026-10-20T13:00:00.000Z', variant: 'landscape', plan: { fps: 30 } }));
      // Each names quote on one side only: by its id, or by its record.
      await take('20261020-130000-quote', 'other'); // a take: its id
      await take('20261020-131500-other', 'quote'); // a take: its record
      await failed('quote-v9', 'other'); // a record: its id
      await failed('other-v9', 'quote'); // a record: its record
      // …and these name it on neither.
      await take('20261020-133000-other', 'other');
      await failed('other-v8', 'other');
      const mixed = ['render other-v9', 'render quote-v9', 'run 20261020-130000-quote', 'run 20261020-131500-other'];
      const neither = ['render other-v8', 'run 20261020-133000-other'];
      // Every thread read: all six can go.
      expect(ids(await pruneProject(p, { keep_renders: 1 }))).toEqual([...all, ...mixed, ...neither].sort());
      // A thread of quote that does not read: the four stay, with everything of quote.
      await mkdir(join(d, 'comments', 'quote'), { recursive: true });
      await writeFile(join(d, 'comments', 'quote', `${ID}.json`), '{');
      const r = await pruneProject(p, { keep_renders: 1 });
      expect([ids(r), r.threads_unread]).toEqual([[...all.filter((x) => x.includes('catalogue')), ...neither].sort(), `${SOME}of quote is kept`]);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('a folder of comments/ that differs from its scenario by case keeps the renders and the takes alike; a folder nothing here is of is not named', async () => {
    const { d, p, all } = await twoScenarios();
    try {
      // comments/Quote/ (what a disk that ignores case may hold for quote), with a file that does not read.
      await mkdir(join(d, 'comments', 'Quote'), { recursive: true });
      await writeFile(join(d, 'comments', 'Quote', `${ID}.json`), '{');
      const r = await pruneProject(p, { keep_renders: 1 });
      expect([ids(r), r.threads_unread, r.kept]).toEqual([all.filter((x) => x.includes('catalogue')), `${SOME}of Quote is kept`, { runs: 4, renders: 4, reviews: 0 }]);
      // A scenario with unread threads and no render or take here: nothing stays for it, so it is not named.
      await mkdir(join(d, 'comments', 'ghost'), { recursive: true });
      await writeFile(join(d, 'comments', 'ghost', `${ID}.json`), '{');
      expect((await pruneProject(p, { keep_renders: 1 })).threads_unread).toBe(`${SOME}of Quote is kept`);
      await rm(join(d, 'comments', 'Quote'), { recursive: true });
      const ghost = await pruneProject(p, { keep_renders: 1 });
      expect([ids(ghost), ghost.threads_unread]).toEqual([all, undefined]);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe('the last renders of a scenario are counted among its renders only (L7.5)', () => {
  const p0 = (d: string) => ({ slug: 'p', dir: d, root: d, config: { name: 'P', environments: {} }, readme: null, scenarios: [], file: join(d, 'project.yaml') }) as unknown as LoadedProject;
  const ids = (r: Awaited<ReturnType<typeof pruneProject>>) => r.items.map((i) => `${i.kind} ${i.id} — ${i.reason}`).sort();
  const LONG = `${'q'.repeat(198)}-v1`; // 201 characters: one more than a render id holds

  it('a record that is no render of its scenario takes no render\'s place; it stays when it succeeded and goes when it failed', async () => {
    const d = await mkdtemp(join(tmpdir(), 'ds-prune-count-'));
    try {
      const p = p0(d);
      await mkdir(join(d, 'renders'), { recursive: true });
      const take = async (id: string) => {
        await mkdir(join(d, 'runs', id), { recursive: true });
        await writeFile(join(d, 'runs', id, 'run.json'), JSON.stringify({ version: 1, id, project: 'p', scenario: 'quote', mode: 'capture', status: 'succeeded', started_at: '2026-10-20T10:00:00.000Z' }));
      };
      const made = (id: string, o: { scenario?: string; status?: string; at: string; run?: string }) =>
        writeFile(join(d, 'renders', `${id.length > 200 ? 'long' : id}.json`), JSON.stringify({ version: 1, id, scenario: o.scenario ?? 'quote', run_id: o.run ?? '20261020-120000-quote', status: o.status ?? 'succeeded', created_at: o.at, variant: 'landscape', plan: { fps: 30 } }));
      await take('20261020-080000-quote'); // only `final` uses it
      await take('20261020-120000-quote'); // the last good take
      for (const n of [1, 2, 3, 4]) await made(`quote-v${n}`, { at: `2026-10-20T1${n}:00:00.000Z` });
      // Without anything else: the last three stay, the first goes.
      const before = await pruneProject(p);
      expect([ids(before), before.kept.renders]).toEqual([['render quote-v1 — older render', 'run 20261020-080000-quote — older capture nothing uses'], 3]);

      // Newer records that are renders of quote nowhere: a version past the highest, a name past 200 characters,
      // another scenario's name, a video written here under a name of its own.
      for (const n of [0, 1, 2, 3, 4]) await made(`quote-v100000${n}`, { at: `2026-10-21T1${n}:00:00.000Z` });
      await made(LONG, { at: '2026-10-21T20:00:00.000Z' });
      await made('other-v1', { at: '2026-10-21T21:00:00.000Z' });
      await made('final', { at: '2026-10-21T22:00:00.000Z', run: '20261020-080000-quote' });
      await mkdir(join(d, 'review', 'final'), { recursive: true });
      const r = await pruneProject(p);
      // The same three renders stay and the same one goes; the eight others stay beside them, with the take and
      // the review of one of them.
      expect(ids(r)).toEqual(['render quote-v1 — older render']);
      expect(r.kept).toEqual({ runs: 2, renders: 11, reviews: 1 });
      expect(r.threads_unread).toBeUndefined();
      // The same with one render kept: no other record is "the last one".
      expect(ids(await pruneProject(p, { keep_renders: 1 }))).toEqual(['render quote-v1 — older render', 'render quote-v2 — older render', 'render quote-v3 — older render']);

      // Such a record that failed or was cancelled goes, as a render that failed does.
      await made('quote-v1000009', { at: '2026-10-22T10:00:00.000Z', status: 'failed' });
      await made('draft', { at: '2026-10-22T11:00:00.000Z', status: 'cancelled' });
      expect(ids(await pruneProject(p))).toEqual(['render draft — cancelled render', 'render quote-v1 — older render', 'render quote-v1000009 — failed render']);
      const done = await pruneProject(p, { dry_run: false });
      expect(done.problems).toEqual([]);
      expect((await readdir(join(d, 'renders'))).sort()).toEqual(['final.json', 'long.json', 'other-v1.json', 'quote-v1000000.json', 'quote-v1000001.json', 'quote-v1000002.json', 'quote-v1000003.json', 'quote-v1000004.json', 'quote-v2.json', 'quote-v3.json', 'quote-v4.json']);
      expect((await readdir(join(d, 'runs'))).sort()).toEqual(['20261020-080000-quote', '20261020-120000-quote']);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
