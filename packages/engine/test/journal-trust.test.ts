/**
 * L5.14 — what the worker replays and runs is what Retake wrote (worker in-process, trust `mcp`):
 * - rollback journal entries are signed when written: an environment reset job replays the signed ones and never a
 *   journal placed by hand (in runs/<id>/ or .retake/journals/), which it refuses and says;
 * - a journal placed in a run's reserved folder between its submit and its start is not replayed by the run;
 * - approvals are bound to their job: a job.json copied under another id runs no approved hook, and a job folder made
 *   again under the id of a job that already ran is refused at its claim (L7.37: on the in-memory hook runner).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from '@retake/core';
import type { EnvResetJobResult, HooksJobResult } from '../src/index.js';
import { FileJobQueue, createEngine, runWorker } from '../src/index.js';
import type { Engine } from '../src/index.js';
import { MemoryHookRunner } from '../src/hook-run/memory-hooks.js';
import { REPO } from '@retake/test-support/repo';
import { scratchHome } from '@retake/test-support/home';

let root: string;
let project: string;
let engine: Engine;
let queue: FileJobQueue;
let server: Server;
const retakeHome = scratchHome();
const accept = { approver: { approve: async () => ({ approved: true as const }) } };
const logs: string[] = [];
const work = () => runWorker({ root, idleExitMs: 300, pollMs: 50, log: (m) => logs.push(m) });
const read = (name: string) => (existsSync(join(project, name)) ? readFileSync(join(project, name), 'utf8') : '');

/** A journal Retake did not write: one pending shell rollback. */
function placed(rollback: string): string {
  return JSON.stringify({
    version: 1,
    created_at: '2026-11-04T09:00:00.000Z',
    updated_at: '2026-11-04T09:00:00.000Z',
    entries: [
      {
        seq: 1,
        name: 'placed',
        kind: 'shell',
        phase: 'setup',
        description: 'shell "true"',
        env: 'local',
        started_at: '2026-11-04T09:00:00.000Z',
        finished_at: '2026-11-04T09:00:01.000Z',
        status: 'ok',
        rollback: { kind: 'shell', run: rollback, description: `shell "${rollback}"`, data: {} },
      },
    ],
  });
}

async function place(rel: string, text: string): Promise<void> {
  await mkdir(join(project, rel, '..'), { recursive: true });
  await writeFile(join(project, rel), text);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-journal-trust-'));
  retakeHome.use(join(root, '.home'));
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Placed</title><body><h1>A page</h1></body>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  project = join(root, 'projects', 'w');
  await mkdir(join(project, 'scenarios'), { recursive: true });
  await mkdir(join(project, 'hooks'), { recursive: true });
  await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\n');
  await writeFile(join(project, 'project.yaml'), ['name: W', 'environments:', '  local:', `    app: http://127.0.0.1:${port}`, 'capture: {width: 640, height: 360, scale: 1, fps: 30}', ''].join('\n'));
  await writeFile(join(project, 'hooks', 'mark.yaml'), '- name: mark\n  shell: {run: "printf x >> marks.log", rollback: "printf u >> undo.log"}\n');
  await writeFile(
    join(project, 'scenarios', 'short.yaml'),
    ['video: short', 'setup:', '  - name: ping', '    http: {method: GET, url: "{{app}}/ping"}', 'scenes:', '  - id: one', '    page: app', '    open: /', '    steps:', '      - hold: 0.2', ''].join(
      '\n',
    ),
  );
  engine = await createEngine({ root, client: 'mcp', autoStartWorker: false });
  queue = new FileJobQueue(root);
});

afterAll(async () => {
  retakeHome.restore();
  await new Promise<void>((r) => server.close(() => r()));
  if (root) await rm(root, { recursive: true, force: true });
});

describe('rollback journal entries are signed (L5.14)', () => {
  it('an environment reset replays what Retake recorded and never a hand-placed journal (runs/<id>/, .retake/journals/): refused, and said', async () => {
    const hooks = await engine.hooks.submit({ project: 'w', source: 'hooks/mark.yaml', dry: false }, accept);
    expect(await work()).toBe(0);
    expect((await queue.stored(hooks.job.id))?.state).toBe('succeeded');
    expect(read('marks.log')).toBe('x');
    // A copy of the signed journal while its rollback is pending (review A M2).
    const pendingCopy = await readFile(join(project, '.retake', 'journals', `${hooks.journal_id}.json`), 'utf8');
    await place('runs/20261104-091000-placed/hooks-journal.json', placed('printf run >> placed.log'));
    await place('.retake/journals/20261104-092000-hooks-placed.json', placed('printf standalone >> placed.log'));
    const reset = await engine.env.reset({ project: 'w', dry: false }, accept);
    expect(await work()).toBe(0);
    const result = (await queue.stored(reset.job.id))?.result as EnvResetJobResult;
    expect(result.ok).toBe(false);
    const by = Object.fromEntries(result.rollbacks.map((r) => [r.journal, r.results.map((x) => [x.status, x.untrusted.error ?? ''])]));
    expect(by[hooks.journal_id]).toEqual([['ok', '']]);
    for (const id of ['20261104-091000-placed', '20261104-092000-hooks-placed']) {
      expect(by[id]).toEqual([['refused', expect.stringMatching(/not replayed: its journal entry \(.+ #1\) is not signed by this Retake home/)]]);
      // Said for a person, without a flag for the agent to pass.
      const error = result.rollbacks.find((r) => r.journal === id)!.results[0]!.untrusted.error ?? '';
      expect(error).toContain('a person can review it and replay it from a terminal');
      expect(error).not.toContain('--replay-unsigned');
    }
    expect(read('undo.log')).toBe('u');
    expect(read('placed.log')).toBe('');

    // The signed copy taken while it was pending, written back after its rollback, moved into runs/ (same id), and
    // copied into another project of the workspace: none is replayed again.
    await rm(join(project, 'runs', '20261104-091000-placed'), { recursive: true });
    await rm(join(project, '.retake', 'journals', '20261104-092000-hooks-placed.json'));
    await place(`.retake/journals/${hooks.journal_id}.json`, pendingCopy);
    await place(`runs/${hooks.journal_id}/hooks-journal.json`, pendingCopy);
    const other = join(root, 'projects', 'w2');
    await mkdir(join(other, '.retake', 'journals'), { recursive: true });
    await writeFile(join(other, 'project.yaml'), await readFile(join(project, 'project.yaml'), 'utf8'));
    await writeFile(join(other, '.retake', 'journals', `${hooks.journal_id}.json`), pendingCopy);
    const again = await engine.env.reset({ project: 'w', dry: false }, accept);
    const there = await engine.env.reset({ project: 'w2', dry: false }, accept);
    expect(await work()).toBe(0);
    const statuses = async (id: string) => ((await queue.stored(id))?.result as EnvResetJobResult).rollbacks.flatMap((r) => r.results.map((x) => [x.status, x.untrusted.error ?? '']));
    // runs/ first (same id), then .retake/journals/.
    expect(await statuses(again.job.id)).toEqual([
      ['refused', expect.stringMatching(/is not signed by this Retake home for this journal/)],
      ['refused', expect.stringMatching(/Retake replayed this rollback before .* not replayed twice/)],
    ]);
    expect(await statuses(there.job.id)).toEqual([['refused', expect.stringMatching(/is not signed by this Retake home for this journal/)]]);
    expect(read('undo.log')).toBe('u');
    expect(existsSync(join(other, 'undo.log'))).toBe(false);
  }, 60_000);
});

function chromiumAvailable(): boolean {
  if (process.env.RETAKE_CHROMIUM) return existsSync(process.env.RETAKE_CHROMIUM);
  try {
    const require = createRequire(join(REPO, 'packages/runner-web/package.json'));
    const { chromium } = require('playwright-core') as { chromium: { executablePath(): string } };
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!chromiumAvailable() || !hasFfmpeg)('a run replays only its own rollbacks (L5.14, real dry run)', () => {
  it('a journal placed in its reserved run folder between submit and start is not replayed (refused, and said)', async () => {
    const sub = await engine.runs.submit({ project: 'w', scenario: 'short', mode: 'dry', hooks: 'run' }, accept);
    await place(`runs/${sub.run_id}/hooks-journal.json`, placed('printf reserved >> placed.log'));
    expect(await work()).toBe(0);
    expect(read('placed.log')).toBe('');
    const events = await queue.events(sub.job.id);
    expect(JSON.stringify(events)).toMatch(/not signed by this Retake home/);
  }, 120_000);
});

/**
 * L7.37: the approvals are the engine's (signed for their job at submit, taken once at the claim): the hooks job runs on
 * the in-memory hook runner, whose executions stand for marks.log. An approved shell hook that really runs is the
 * environment reset case above.
 */
describe('approvals are bound to their job (L5.14), on the in-memory hook runner', () => {
  const hooks = new MemoryHookRunner();
  let mengine: Engine;
  /** How many times the mark hook ran (marks.log's length on the hooks package). */
  const marks = () => hooks.executed.filter((e) => e.name === 'mark' && e.phase !== 'rollback').length;
  const mwork = (at = root) => runWorker({ root: at, idleExitMs: 300, pollMs: 50, log: (m) => logs.push(m), heavyInProcess: true, ports: { hooks } });

  beforeAll(async () => {
    mengine = await createEngine({ root, client: 'mcp', autoStartWorker: false, ports: { hooks } });
  });

  it('a job.json copied under another id runs no approved hook; a job folder made again under a used id is refused at its claim', async () => {
    const before = marks();
    const sub = await mengine.hooks.submit({ project: 'w', source: 'hooks/mark.yaml', dry: false }, accept);
    const original = (await queue.stored(sub.job.id))!;
    const copyId = `j_${ulid()}`;
    await mkdir(queue.files.job(copyId), { recursive: true });
    await writeFile(join(queue.files.job(copyId), 'job.json'), JSON.stringify({ ...original, id: copyId }));
    expect(await mwork()).toBe(0);
    expect((await queue.stored(sub.job.id))?.state).toBe('succeeded');
    const copy = (await queue.stored(copyId))!;
    expect((copy.result as HooksJobResult | undefined)?.results.map((r) => r.status)).toEqual(['refused']);
    expect(JSON.stringify(await queue.events(copyId))).toMatch(/approval\(s\) of this job are not signed for it/);
    expect(marks()).toBe(before + 1);
    // The original's folder made again (queued, no claim): refused at its claim, its hook never runs again.
    await rm(join(queue.files.job(sub.job.id), 'claim'), { force: true });
    await rm(join(queue.files.job(sub.job.id), 'events.jsonl'), { force: true });
    await writeFile(join(queue.files.job(sub.job.id), 'job.json'), JSON.stringify(original));
    expect(await mwork()).toBe(0);
    const again = (await queue.stored(sub.job.id))!;
    expect(again.state).toBe('failed');
    expect(again.error?.message).toMatch(/refused without running: the approvals of job .* were taken by an earlier claim of that id/);
    expect(marks()).toBe(before + 1);
    expect(JSON.parse(await readFile(join(root, '.home', 'approvals-used', sub.job.id), 'utf8'))).toMatchObject({ digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
  }, 60_000);

  it('review B L4: a record of taken approvals that cannot be written fails the job with that reason, not as approvals taken before', async () => {
    const before = marks();
    const sub = await mengine.hooks.submit({ project: 'w', source: 'hooks/mark.yaml', dry: false }, accept);
    const used = join(root, '.home', 'approvals-used');
    await mkdir(used, { recursive: true });
    await chmod(used, 0o500);
    try {
      expect(await mwork()).toBe(0);
    } finally {
      await chmod(used, 0o700);
    }
    const end = (await queue.stored(sub.job.id))!;
    expect(end.state).toBe('failed');
    expect(end.error?.message).toMatch(/not run: the record of the approvals workers took \(.*approvals-used\) cannot be written \(.*(EACCES|permission).*\)/i);
    expect(end.error?.message).not.toMatch(/taken by an earlier claim/);
    expect(marks()).toBe(before);
  }, 60_000);

  it('review A L1: a queued job folder copied into another workspace of the same home runs no approved hook there', async () => {
    const before = marks();
    const sub = await mengine.hooks.submit({ project: 'w', source: 'hooks/mark.yaml', dry: false }, accept);
    // Another workspace with a project of the same name and the same hook (the same fingerprint).
    const root2 = await mkdtemp(join(tmpdir(), 'retake-journal-trust-ws2-'));
    try {
      const project2 = join(root2, 'projects', 'w');
      await mkdir(join(project2, 'hooks'), { recursive: true });
      await writeFile(join(root2, 'retake.yaml'), 'projects_dir: projects\n');
      await writeFile(join(project2, 'project.yaml'), await readFile(join(project, 'project.yaml'), 'utf8'));
      await writeFile(join(project2, 'hooks', 'mark.yaml'), await readFile(join(project, 'hooks', 'mark.yaml'), 'utf8'));
      const q2 = new FileJobQueue(root2);
      await mkdir(q2.files.job(sub.job.id), { recursive: true });
      await writeFile(join(q2.files.job(sub.job.id), 'job.json'), await readFile(join(queue.files.job(sub.job.id), 'job.json'), 'utf8'));
      expect(await mwork(root2)).toBe(0);
      expect(((await q2.stored(sub.job.id))?.result as HooksJobResult | undefined)?.results.map((r) => r.status)).toEqual(['refused']);
      expect(JSON.stringify(await q2.events(sub.job.id))).toMatch(/approval\(s\) of this job are not signed for it/);
      expect(marks()).toBe(before);
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
    // In its own workspace it is not run either: its claim there took its approvals (the copy was claimed first).
    expect(await mwork()).toBe(0);
    expect((await queue.stored(sub.job.id))?.error?.message).toMatch(/taken by an earlier claim of that id/);
    expect(marks()).toBe(before);
  }, 60_000);
});
