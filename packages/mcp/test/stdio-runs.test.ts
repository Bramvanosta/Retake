/**
 * Dry runs and captures through `studio mcp` (spawned from the sources over stdio, driven by the SDK client): the run is
 * a job the workspace's worker — a separate, detached process — runs; run_dry / run_status long-poll it with progress
 * notifications; the worker finishes a capture after the session that submitted it is gone, then exits once idle.
 * The fixture product runs on free ports. Skipped when Chromium or ffmpeg is not available.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FileJobQueue, liveWorker, readWorkerLock } from '@demo-studio/engine';
import { REPO, fixtureWorkspace } from '../../engine/test/helpers.js';

const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const SOURCE_ARGS = ['--conditions=source', '--import', 'tsx', BIN];

function chromiumAvailable(): boolean {
  if (process.env.DEMO_STUDIO_CHROMIUM) return existsSync(process.env.DEMO_STUDIO_CHROMIUM);
  try {
    const require = createRequire(join(REPO, 'packages/runner-web/package.json'));
    const { chromium } = require('playwright-core') as { chromium: { executablePath(): string } };
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const AVAILABLE = chromiumAvailable() && spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

let fixture: Fixture;
let ws: string;
let home: string;
const sessions: Client[] = [];
const protocolErrors: Error[] = [];

async function connect(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...SOURCE_ARGS, '--root', ws, 'mcp'],
    cwd: REPO,
    // The worker this server starts inherits its environment: a short idle exit for the test.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DEMO_STUDIO_HOME: home, DEMO_STUDIO_WORKER_IDLE_MS: '1500' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'demo-studio-test', version: '0' }, { capabilities: {} });
  client.onerror = (e) => protocolErrors.push(e);
  await client.connect(transport);
  sessions.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>, onprogress?: (p: { progress: number; total?: number; message?: string }) => void): Promise<Result> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000, ...(onprogress ? { onprogress } : {}) })) as Result;
}

const SHORT = `video: short
pacing: {scene_start_still: 0.2}
scenes:
  - id: imports
    page: console
    open: /imports
    steps:
      - hold: 0.6
`;

describe.skipIf(!AVAILABLE)('studio mcp: dry runs and captures as jobs', () => {
  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
      startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture>;
    };
    fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
    ws = await mkdtemp(join(tmpdir(), 'studio-mcp-runs-'));
    home = join(ws, '.home');
    await fixtureWorkspace(ws);
    const project = join(ws, 'projects', 'northfield-fixture');
    const yaml = (await readFile(join(project, 'project.yaml'), 'utf8'))
      .replaceAll('http://localhost:4401', fixture.urls.console)
      .replaceAll('http://localhost:4402', fixture.urls.shop);
    await writeFile(join(project, 'project.yaml'), yaml);
    await writeFile(join(project, 'scenarios', 'short.yaml'), SHORT);
  });

  afterAll(async () => {
    for (const c of sessions) await c.close().catch(() => undefined);
    const w = ws ? readWorkerLock(ws) : null;
    if (w) {
      try {
        process.kill(w.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    await fixture?.close();
    if (ws) await rm(ws, { recursive: true, force: true });
  });

  it('run_dry: the worker runs it to succeeded; run_status long-polls it with progress; screenshots on disk', async () => {
    const client = await connect();
    const progress: Array<{ progress: number; total?: number; message?: string }> = [];
    let r = await call(client, 'run_dry', { project: 'northfield-fixture', scenario: 'quote', until: 'discover.1', wait_s: 25 }, (p) => progress.push(p));
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    const runId = r.structuredContent?.id as string;
    expect(runId).toMatch(/^\d{8}-\d{6}-quote$/);
    expect(r.content[0].text).toContain(`dry run ${runId} submitted (job j_`);
    for (let i = 0; i < 3 && !(r.structuredContent?.finished as boolean); i++) {
      r = await call(client, 'run_status', { project: 'northfield-fixture', run_id: runId, wait_s: 25 }, (p) => progress.push(p));
    }
    const st = r.structuredContent as { status: string; finished: boolean; steps_done: number; files: { screenshots: { dir: string; count: number } }; job: { id: string; state: string } };
    expect(st.status, r.content[0].text).toBe('succeeded');
    expect(st.job.state).toBe('succeeded');
    expect(st.steps_done).toBe(2);
    // Compact (L5.8): the folder and the count; `detail: "full"` lists each screenshot.
    expect(st.files.screenshots.count).toBe(2);
    const full = (await call(client, 'run_status', { project: 'northfield-fixture', run_id: runId, detail: 'full' })).structuredContent as { screenshots: Array<{ path: string }> };
    expect(full.screenshots).toHaveLength(2);
    for (const s of full.screenshots) expect(existsSync(s.path), s.path).toBe(true);
    for (const s of full.screenshots) expect(s.path.startsWith(st.files.screenshots.dir)).toBe(true);
    expect(r.content[0].text).toContain('2 screenshots in');
    // Progress notifications: increasing, out of the run's steps.
    expect(progress.length).toBeGreaterThan(0);
    for (let i = 1; i < progress.length; i++) expect(progress[i].progress).toBeGreaterThan(progress[i - 1].progress);

    const jobs = await call(client, 'job_list', {});
    expect(jobs.content[0].text).toContain(`${st.job.id} run quote (dry) → ${runId} in northfield-fixture: succeeded · run succeeded`);
    const job = await call(client, 'job_status', { job_id: st.job.id });
    expect(job.structuredContent).toMatchObject({ state: 'succeeded', input: { kind: 'run', mode: 'dry', run_id: runId, submitted_by: 'mcp' }, result: { status: 'succeeded' } });
    expect(JSON.stringify(job.structuredContent?.input)).not.toContain(ws);
    expect(protocolErrors).toEqual([]);
  });

  it('a capture outlives the session that submitted it; the worker then exits once idle', async () => {
    const client = await connect();
    const r = await call(client, 'run_capture', { project: 'northfield-fixture', scenario: 'short' });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    const runId = r.structuredContent?.id as string;
    const jobId = (r.structuredContent?.job as { id: string }).id;
    expect(['queued', 'running']).toContain(r.structuredContent?.status);
    await client.close();

    const queue = new FileJobQueue(ws);
    const deadline = Date.now() + 90_000;
    let job = await queue.get(jobId);
    while (job && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.state) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 250));
      job = await queue.get(jobId);
    }
    expect(job?.state, JSON.stringify(job)).toBe('succeeded');
    expect(job?.result).toMatchObject({ status: 'succeeded', mode: 'capture' });
    const run = JSON.parse(await readFile(join(ws, 'projects', 'northfield-fixture', 'runs', runId, 'run.json'), 'utf8')) as { status: string; capture?: string };
    expect(run.status).toBe('succeeded');
    expect(run.capture && existsSync(run.capture)).toBe(true);
    // Idle for 1.5 s: the worker releases its lock and exits.
    const idleBy = Date.now() + 15_000;
    while ((await liveWorker(ws)) && Date.now() < idleBy) await new Promise((res) => setTimeout(res, 200));
    expect(await liveWorker(ws)).toBeNull();
    expect(protocolErrors).toEqual([]);
  });

  it('stdout carries JSON-RPC lines only while a job runs (the worker writes to its log, never to the server\'s stdout)', async () => {
    const child = spawn(process.execPath, [...SOURCE_ARGS, '--root', ws, 'mcp'], {
      cwd: REPO,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DEMO_STUDIO_HOME: home, DEMO_STUDIO_WORKER_IDLE_MS: '1500' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const answered = (id: number) => out.split('\n').some((l) => l.includes(`"id":${id}`));
    const until = async (what: string, ok: () => boolean, ms = 90_000) => {
      const deadline = Date.now() + ms;
      while (!ok()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // A dry run long-polled with progress notifications: the call stays open while the worker films.
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_dry', arguments: { project: 'northfield-fixture', scenario: 'short', wait_s: 25 }, _meta: { progressToken: 'p' } } });
    await until('the run_dry answer', () => answered(2));
    // While its job may still run: more calls; then the server's input ends.
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'job_list', arguments: {} } });
    await until('the job_list answer', () => answered(3));
    child.stdin.end();
    expect(await exited).toBe(0);
    const lines = out.trimEnd().split('\n');
    for (const l of lines) {
      const m = JSON.parse(l) as { jsonrpc?: string };
      expect(m.jsonrpc, l).toBe('2.0');
    }
    const run = lines.map((l) => JSON.parse(l) as { id?: number; result?: { structuredContent?: { status?: string; id?: string } } }).find((m) => m.id === 2);
    expect(run?.result?.structuredContent?.id).toMatch(/-short$/);
    // The call was open while the job ran: its progress notifications are among the lines.
    expect(lines.some((l) => l.includes('"method":"notifications/progress"'))).toBe(true);
    expect(existsSync(join(ws, '.demo-studio', 'workers', 'worker.log'))).toBe(true);
  });
});
