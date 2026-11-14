/**
 * L4.2 part 4: the scenario screen's run actions over HTTP — `scenario_run` (an own op with pinned arguments, critique
 * B11) and `run_cancel`, behind the gate, under the `ui` client's agent trust with no approver:
 *
 * - pinned: a sandbox reset, `until`, `hooks`, `wait_s`, another mode → 400 before anything is read or queued;
 *   `run_dry` / `run_capture` stay outside the allow-list;
 * - blocker-first (B2): quote's capture is refused (403 needs_approval) exactly as scenario_blocks showed it before any
 *   click, worded for the Studio, with the `retake run …` command; nothing queued, no run id reserved;
 * - a dry run queues a job `submitted_by: ui`; `run_cancel` cancels it;
 * - wording raised deeper (hooks package, core shellAlwaysWrites): a shell hook refused on a read-only environment says
 *   "from the Studio", never MCP;
 * - the worker (B5): the Studio starts it on submit with a clean environment (spawn injected: PATH sanitised, no
 *   package-manager / LLM / MCP-token variables, RETAKE_HOME kept absolute, sign-in secrets kept) and
 *   `--started-by ui`; a real one records `started_by: ui` in its lock and exits once idle (no orphan; killed by pid in
 *   any case).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readWorkerLock, workerLockFile } from '@retake/engine';
import type { WorkerSpawnFn } from '@retake/engine';
import { UI_OPS, startStudioServer, studioWorkerEnv } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { raw } from '@retake/test-support/http';
import { scratchHome } from '@retake/test-support/home';

const P = 'northfield-fixture';
const retakeHome = scratchHome();
let ws: string;
let studio: StudioServer;
const project = () => join(ws, 'projects', P);

const READ_ONLY_SHELL = [
  'video: ro-shell',
  'env: production',
  'setup:',
  '  - name: count-orders',
  '    shell: echo 1',
  '    writes: false',
  'scenes:',
  '  - id: a',
  '    page: console',
  '    open: /',
  '    steps:',
  '      - hold: 1',
  '',
].join('\n');

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-run-'));
  retakeHome.use(join(ws, '.home'));
  await fixtureWorkspace(ws);
  await writeFile(join(project(), 'scenarios', 'ro-shell.yaml'), READ_ONLY_SHELL);
  studio = await startStudioServer({ root: ws, startWorker: false });
}, 60_000);

afterAll(async () => {
  await studio?.close();
  retakeHome.restore();
  if (ws) await rm(ws, { recursive: true, force: true });
});

const callOn = (s: StudioServer, op: string, args: unknown = {}) =>
  raw(s.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
const call = (op: string, args: unknown = {}) => callOn(studio, op, args);

interface Fail {
  ok: false;
  error: { code: string; message: string; fix?: string };
}
interface Queued {
  ok: true;
  data: { run_id: string; job: string; state: string; mode: string; worker?: { pid?: number; spawned: boolean } };
}

const jobFiles = async () => (await readdir(join(ws, '.retake', 'jobs')).catch(() => [] as string[])).sort();
const runDirs = async () => (await readdir(join(project(), 'runs'))).sort();

describe('scenario_run: the scenario screen’s Dry run and Capture', () => {
  it('is in the allow-list with run_cancel; run_dry / run_capture are not', async () => {
    expect(UI_OPS).toEqual(expect.arrayContaining(['scenario_run', 'run_cancel', 'run_status']));
    expect(UI_OPS).not.toContain('run_dry');
    expect(UI_OPS).not.toContain('run_capture');
    for (const op of ['run_dry', 'run_capture', 'job_cancel']) expect((await call(op, { project: P, scenario: 'quote' })).status, op).toBe(404);
  });

  it('pinned arguments: a sandbox reset, until, hooks, wait_s, another mode, a path → 400; nothing read, queued or reserved', async () => {
    const jobs = await jobFiles();
    const runs = await runDirs();
    const before = studio.calls;
    for (const extra of [{ sandbox: true }, { until: 'discover.0' }, { hooks: 'run' }, { wait_s: 0 }, { mode: 'record' }, { name: '../quote' }, { scenario: 'quote' }]) {
      const r = await call('scenario_run', { project: P, name: 'quote', mode: 'dry', ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await jobFiles()).toEqual(jobs);
    expect(await runDirs()).toEqual(runs);
    expect(studio.calls - before).toBe(7);
  });

  it('a blocked capture (quote: hooks needing a person) → 403 as the screen showed before the click, Studio wording, the command; nothing queued', async () => {
    const view = (await call('scenario_blocks', { project: P, name: 'quote' })).json<{
      data: { run_blockers: { capture: Array<{ code: string; message: string; fix?: string; fix_node?: string }> } };
    }>().data;
    expect(view.run_blockers.capture).toHaveLength(1);
    const jobs = await jobFiles();
    const runs = await runDirs();
    const r = await call('scenario_run', { project: P, name: 'quote', mode: 'capture' });
    expect(r.status).toBe(403);
    const e = r.json<Fail>().error;
    expect(e.code).toBe('needs_approval');
    // L5.11a: the blocker also says which gate refused (`kind`, `count`: the status bar's words) — the refusal does not.
    const { fix_node, kind, count, ...shown } = view.run_blockers.capture[0] as (typeof view.run_blockers.capture)[0] & { kind?: string; count?: number };
    expect([kind, count]).toEqual(['needs_approval', 1]);
    expect({ code: e.code, message: e.message, fix: e.fix }).toEqual(shown);
    // The same command for a person without `retake` on their PATH (review B L6).
    expect(fix_node).toBe(`${process.execPath} ${join(fileURLToPath(new URL('../../..', import.meta.url)), 'packages/cli/dist/bin.js')} -C ${ws} run ${P} quote`);
    expect(e.message).toContain('The Studio cannot approve hooks yet: run it in a terminal');
    expect(e.fix).toBe(`retake -C ${ws} run ${P} quote`);
    expect(r.body).not.toMatch(/MCP|elicitation/);
    expect(await jobFiles()).toEqual(jobs);
    expect(await runDirs()).toEqual(runs);
  });

  it('a dry run queues a job submitted_by ui with the default hooks (none), no until, no sandbox; run_cancel cancels it', async () => {
    const r = await call('scenario_run', { project: P, name: 'quote', mode: 'dry' });
    expect(r.status).toBe(200);
    const q = r.json<Queued>().data;
    expect(q).toMatchObject({ mode: 'dry', state: 'queued' });
    expect(q.worker).toBeUndefined();
    const rec = JSON.parse(await readFile(join(project(), 'runs', q.run_id, 'run.json'), 'utf8')) as { status: string; mode: string; options: Record<string, unknown> };
    expect(rec).toMatchObject({ status: 'queued', mode: 'dry', options: { hooks: 'skip', headed: false } });
    expect(rec.options.until).toBeUndefined();
    const job = JSON.parse(await readFile(join(ws, '.retake', 'jobs', q.job, 'job.json'), 'utf8')) as { input: Record<string, unknown> };
    expect(job.input).toMatchObject({ kind: 'run', scenario: 'quote', mode: 'dry', submitted_by: 'ui' });
    for (const k of ['sandbox', 'until', 'hooks', 'env', 'approvals']) expect(job.input[k], k).toBeUndefined();
    const c = await call('run_cancel', { project: P, run_id: q.run_id });
    expect(c.status).toBe(200);
    const st = (await call('run_status', { project: P, run_id: q.run_id })).json<{ data: { status: string; job: { state: string } } }>().data;
    expect(st.job.state).toBe('cancelled');
    expect(st.status).toBe('cancelled');
  });

  it('the file as the screen showed it (`hash`): another file → 409, nothing queued (review A #6)', async () => {
    const view = (await call('scenario_blocks', { project: P, name: 'highlights' })).json<{ data: { hash: string } }>().data;
    const jobs = await jobFiles();
    const runs = await runDirs();
    const stale = 'f'.repeat(64);
    const r = await call('scenario_run', { project: P, name: 'highlights', mode: 'dry', hash: stale });
    expect(r.status).toBe(409);
    expect(r.json<Fail>().error).toMatchObject({ code: 'conflict', message: expect.stringMatching(/^scenarios\/highlights changed since it was shown/) });
    expect([await jobFiles(), await runDirs()]).toEqual([jobs, runs]);
    expect((await call('scenario_run', { project: P, name: 'highlights', mode: 'dry', hash: 'x' })).status).toBe(400);
    const ok = await call('scenario_run', { project: P, name: 'highlights', mode: 'dry', hash: view.hash });
    expect(ok.status).toBe(200);
    expect((await call('run_cancel', { project: P, run_id: ok.json<Queued>().data.run_id })).status).toBe(200);
  });

  it('one run of a scenario at a time: a second click (another tab, at once or later) → 409 naming the run (review B L2)', async () => {
    const both = await Promise.all([call('scenario_run', { project: P, name: 'highlights', mode: 'dry' }), call('scenario_run', { project: P, name: 'highlights', mode: 'capture' })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const first = both.find((r) => r.status === 200)!.json<Queued>().data;
    const refused = both.find((r) => r.status === 409)!.json<Fail>().error;
    expect(refused.message).toContain(`is queued (${first.run_id}): wait for it to end, or stop it`);
    const later = await call('scenario_run', { project: P, name: 'highlights', mode: 'dry' });
    expect(later.status).toBe(409);
    // Another scenario is not held; once cancelled, the scenario runs again.
    const other = await call('scenario_run', { project: P, name: 'catalogue', mode: 'dry' });
    expect(other.status).toBe(200);
    await call('run_cancel', { project: P, run_id: other.json<Queued>().data.run_id });
    await call('run_cancel', { project: P, run_id: first.run_id });
    const again = await call('scenario_run', { project: P, name: 'highlights', mode: 'dry' });
    expect(again.status).toBe(200);
    await call('run_cancel', { project: P, run_id: again.json<Queued>().data.run_id });
  });

  it('wording raised deeper: a shell hook refused on a read-only environment says "from the Studio", never MCP', async () => {
    const r = await call('scenario_blocks', { project: P, name: 'ro-shell' });
    const b = r.json<{ data: { run_blockers: { dry: unknown[]; capture: Array<{ code: string; message: string }> } } }>().data.run_blockers;
    expect(b.dry).toEqual([]);
    const text = b.capture.map((x) => x.message).join('\n');
    expect(text).toContain('from the Studio a shell hook always counts as writing');
    expect(text).not.toMatch(/MCP|elicitation/);
    const s = await call('scenario_run', { project: P, name: 'ro-shell', mode: 'capture' });
    expect(s.status).toBe(403);
    expect(s.json<Fail>().error.message).toBe(b.capture[0].message);
  });
});

describe('the worker the Studio starts (critique B5)', () => {
  it('studioWorkerEnv: PATH like retake mcp’s, no package-manager / LLM / MCP-token variables, RETAKE_HOME absolute, the rest kept', () => {
    const root = '/work/space';
    const env = studioWorkerEnv(
      {
        PATH: ['/repo/node_modules/.bin', 'relative/bin', `${root}/bin`, '/usr/local/bin', '/opt/tools/bin'].join(delimiter),
        npm_config__authToken: 'npm-secret',
        npm_lifecycle_event: 'studio',
        PNPM_SCRIPT_SRC_DIR: '/repo',
        INIT_CWD: '/repo',
        ANTHROPIC_API_KEY: 'sk-x',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-x',
        RETAKE_MCP_TOKEN: 'mcp-x',
        RETAKE_HOME: 'rel/home',
        NORTHFIELD_SUPPLIER_PASSWORD: 'kept',
        HOME: '/Users/someone',
      },
      root,
      '/node/bin/node',
      () => false,
    );
    expect(env.PATH).toBe(['/node/bin', '/usr/local/bin', '/opt/tools/bin'].join(delimiter));
    for (const k of ['npm_config__authToken', 'npm_lifecycle_event', 'PNPM_SCRIPT_SRC_DIR', 'INIT_CWD', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'RETAKE_MCP_TOKEN'])
      expect(env[k], k).toBeUndefined();
    expect(env.RETAKE_HOME).toBe(join(process.cwd(), 'rel/home'));
    expect(env.NORTHFIELD_SUPPLIER_PASSWORD).toBe('kept');
    expect(env.HOME).toBe('/Users/someone');
  });

  it('a submit from the Studio spawns the worker with that environment and --started-by ui (spawn injected)', async () => {
    const seen: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd: unknown; detached: unknown }> = [];
    const spawn: WorkerSpawnFn = (command, args, options) => {
      seen.push({ command, args, env: options.env ?? {}, cwd: options.cwd, detached: options.detached });
      return { pid: 4242, on: () => undefined, unref: () => undefined } as unknown as ReturnType<WorkerSpawnFn>;
    };
    const saved = {
      PATH: process.env.PATH,
      npm_config__authToken: process.env.npm_config__authToken,
      RETAKE_MCP_TOKEN: process.env.RETAKE_MCP_TOKEN,
      NORTHFIELD_SUPPLIER_PASSWORD: process.env.NORTHFIELD_SUPPLIER_PASSWORD,
    };
    process.env.PATH = [join(ws, 'node_modules', '.bin'), join(ws, 'bin'), process.env.PATH ?? ''].join(delimiter);
    process.env.npm_config__authToken = 'npm-secret';
    process.env.RETAKE_MCP_TOKEN = 'mcp-secret';
    process.env.NORTHFIELD_SUPPLIER_PASSWORD = 'for-the-sign-in';
    let s2: StudioServer | undefined;
    try {
      s2 = await startStudioServer({ root: ws, workerSpawn: spawn });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    try {
      const r = await callOn(s2, 'scenario_run', { project: P, name: 'catalogue', mode: 'dry' });
      expect(r.status).toBe(200);
      const q = r.json<Queued>().data;
      expect(q.worker).toEqual({ pid: 4242, spawned: true });
      expect(seen).toHaveLength(1);
      const w = seen[0];
      expect(w.command).toBe(process.execPath);
      expect(w.args.slice(-4)).toEqual(['--root', ws, '--started-by', 'ui']);
      expect(w.cwd).toBe(ws);
      expect(w.detached).toBe(true);
      const path = (w.env.PATH ?? '').split(delimiter);
      expect(path[0]).toBe(join(process.execPath, '..'));
      expect(path.some((p) => p.includes('node_modules') || p.startsWith(ws))).toBe(false);
      expect(w.env.npm_config__authToken).toBeUndefined();
      expect(w.env.RETAKE_MCP_TOKEN).toBeUndefined();
      expect(w.env.RETAKE_HOME).toBe(join(ws, '.home'));
      expect(w.env.NORTHFIELD_SUPPLIER_PASSWORD).toBe('for-the-sign-in');
      await callOn(s2, 'run_cancel', { project: P, run_id: q.run_id });
    } finally {
      await s2.close();
    }
  });

  it('a real worker started by the Studio: started_by ui in its lock, the Studio’s home, and it exits once idle — no orphan', async () => {
    const s3 = await startStudioServer({ root: ws, workerIdleExitMs: 1500 });
    const pids = new Set<number>();
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      const r = await callOn(s3, 'scenario_run', { project: P, name: 'catalogue', mode: 'dry' });
      expect(r.status).toBe(200);
      const q = r.json<Queued>().data;
      expect(q.worker?.spawned).toBe(true);
      expect(q.worker?.pid).toBeGreaterThan(0);
      pids.add(q.worker!.pid!);
      // Cancelled at once: whether the worker takes it first or not, it starts nothing heavy, then idles out. (The
      // cancel may start a second worker while the first boots: the one that takes the lock serves, the other exits.)
      await callOn(s3, 'run_cancel', { project: P, run_id: q.run_id });
      let lock = readWorkerLock(ws);
      for (let t = 0; t < 200 && !lock; t++) {
        await new Promise((res) => setTimeout(res, 50));
        lock = readWorkerLock(ws);
      }
      const log = await readFile(join(ws, '.retake', 'workers', 'worker.log'), 'utf8').catch(() => '');
      expect(lock, log).toMatchObject({ started_by: 'ui' });
      pids.add(lock!.pid);
      if (process.platform === 'darwin' && alive(lock!.pid)) {
        // The live process's own environment (ps -E: same user): the Studio's home, no package-manager variable.
        const out = execFileSync('ps', ['-wwE', '-p', String(lock!.pid), '-o', 'command='], { encoding: 'utf8' });
        expect(out).toContain(`RETAKE_HOME=${join(ws, '.home')}`);
        expect(out).not.toMatch(/\bnpm_config_/);
      }
      for (let t = 0; t < 300 && [...pids].some(alive); t++) await new Promise((res) => setTimeout(res, 50));
      expect([...pids].filter(alive), 'every worker the Studio started exits once idle').toEqual([]);
      expect(existsSync(workerLockFile(ws))).toBe(false);
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
      await s3.close();
    }
  }, 60_000);
});
