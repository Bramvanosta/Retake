/**
 * L3.4 scenario_record through `retake mcp` (spawned from the sources over stdio, driven by the SDK client) on a copy
 * of projects/northfield-fixture pointed at the fixture product on free ports. No real window opens here: the worker
 * lock is held by this process (so the server spawns no worker), first by a bare lock (a job that stays queued), then
 * by an in-process worker whose injected driver plays the person (Playwright in a headless "headed" window).
 * - the tool (a job against the product, not destructive; no credential, no allow_writes) and the INSTRUCTIONS (the
 *   USER performs the flow, Claude never drives it; follow with job_status; no other job meanwhile);
 * - refusals: an argument the tool does not take, another origin, a template, an unknown page — nothing queued;
 * - submit returns at once with the job id and what to ask the user; job_status while queued; job_cancel → cancelled,
 *   no draft;
 * - a recording of the lab run by the in-process worker: job_status returns counts, the saved file and the check as
 *   trusted fields and the draft read from the recording's folder under `untrusted` (the note the person typed, a
 *   {{vars.password_1}} placeholder); the typed note is in no summary nor trusted field; the sentinel typed in the
 *   password field is in no tool output, job file, worker log, history line or recording file.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WorkerLock, buildStamp, historyFile, jobsDir, readWorkerLock, runWorker, workersDir, systemClock } from '@retake/engine';
import { REPO } from '../../engine/test/helpers.js';
import { testChildEnv } from '../../core/test/child-env.js';

const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const FIXTURE_PROJECT = join(REPO, 'projects', 'northfield-fixture');
const GENERATED = new Set(['runs', 'renders', 'review', 'exports', '.retake', 'frames']);
const PROJECT = 'northfield-fixture';

type Block = { type: string; text?: string };
type Result = { content: Block[]; structuredContent?: Record<string, unknown>; isError?: boolean };

interface Fixture {
  urls: { console: string; shop: string; signedIn?: { console: string; shop: string } };
  close(): Promise<void>;
}

let fixture: Fixture;
let root: string;
let client: Client;
let stderr = '';
const outputs: string[] = [];
const savedHome = process.env.RETAKE_HOME;

async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })) as Result;
  outputs.push(JSON.stringify(r));
  return r;
}
const data = <T>(r: Result) => r.structuredContent as T;
const summary = (r: Result) => r.content[0]?.text ?? '';

/** Everything but the `untrusted` subtrees. */
function trustedPart(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(trustedPart);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'untrusted').map(([k, x]) => [k, trustedPart(x)]));
  return v;
}

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else out.push(join(d, e.name));
    }
  };
  if (existsSync(dir)) await walk(dir);
  return out;
}

beforeAll(async () => {
  const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
    startFixture(o: { consolePort: number; shopPort: number; host: string; auth: { consolePort: number; shopPort: number } }): Promise<Fixture>;
  };
  fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1', auth: { consolePort: 0, shopPort: 0 } });
  root = await mkdtemp(join(tmpdir(), 'studio-mcp-record-'));
  process.env.RETAKE_HOME = join(root, '.home');
  await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
  const project = join(root, 'projects', PROJECT);
  await cp(FIXTURE_PROJECT, project, { recursive: true, filter: (src) => !GENERATED.has(src.slice(FIXTURE_PROJECT.length + 1).split('/')[0]) });
  const strip = (u: string) => u.replace(/\/$/, '');
  const yaml = (await readFile(join(project, 'project.yaml'), 'utf8'))
    .replaceAll('http://localhost:4401', strip(fixture.urls.console))
    .replaceAll('http://localhost:4402', strip(fixture.urls.shop))
    .replaceAll('http://localhost:4403', strip(fixture.urls.signedIn!.console))
    .replaceAll('http://localhost:4404', strip(fixture.urls.signedIn!.shop));
  await writeFile(join(project, 'project.yaml'), yaml);
  await symlink(join(REPO, 'fixtures'), join(root, 'fixtures'));
  await mkdir(join(root, '.retake'), { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--conditions=source', '--import', 'tsx', BIN, '--root', root, 'mcp'],
    cwd: REPO,
    env: testChildEnv({ RETAKE_HOME: join(root, '.home'), RETAKE_WORKER_IDLE_MS: '5000' }),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  client = new Client({ name: 'retake-test', version: '0' }, { capabilities: {} });
  await client.connect(transport);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  const w = root ? readWorkerLock(root) : null;
  // A worker the server spawned (never this process's own in-process worker).
  if (w && w.pid !== process.pid) {
    try {
      process.kill(w.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  await fixture?.close();
  if (root) await rm(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
});

describe('retake mcp: scenario_record', () => {
  it('lists scenario_record (a job against the product, not destructive) and says the USER performs the flow, never Claude', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'scenario_record');
    expect(t?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(t?.inputSchema.required).toEqual(['project']);
    expect(Object.keys((t?.inputSchema.properties ?? {}) as object).sort()).toEqual(['check', 'env', 'page', 'path', 'persona', 'project', 'scenario', 'url']);
    expect(t?.description).toMatch(/the USER performs the flow there and closes the window/);
    expect(t?.description).toMatch(/you never drive it/);
    const line = (client.getInstructions() ?? '').split('\n').find((l) => l.includes('scenario_record'))!;
    expect(line).toMatch(/the USER performs the flow/);
    expect(line).toMatch(/you never drive it/);
    expect(line).toMatch(/job_status \{job_id, wait_s: 25\}/);
    expect(line).toMatch(/submit no other job meanwhile/);
  });

  it('refuses what it cannot record, queueing nothing: an unknown argument, another origin, a template, an unknown page', async () => {
    const extra = await call('scenario_record', { project: PROJECT, page: 'shop', allow_writes: true });
    expect(extra.isError).toBe(true);
    expect(summary(extra)).toMatch(/invalid arguments/);
    const foreign = await call('scenario_record', { project: PROJECT, url: 'http://elsewhere.example/' });
    expect(foreign.isError).toBe(true);
    expect(summary(foreign)).toMatch(/^refused:/);
    const template = await call('scenario_record', { project: PROJECT, page: 'shop', path: '/{{env:HOME}}' });
    expect(summary(template)).toMatch(/^refused:/);
    const unknown = await call('scenario_record', { project: PROJECT, page: 'nowhere' });
    expect(summary(unknown)).toMatch(/^not_found:/);
    expect(data<{ jobs: unknown[] }>(await call('job_list', {})).jobs).toEqual([]);
  });

  it('returns at once with the job id and what to ask the user; job_cancel before the window opens cancels it, no draft', async () => {
    // This process holds the worker lock: the server spawns no worker and the job stays queued.
    const lock = await WorkerLock.acquire(root, buildStamp(), systemClock, () => undefined);
    expect(lock).not.toBeNull();
    try {
      const r = await call('scenario_record', { project: PROJECT, page: 'shop', scenario: 'never-recorded' });
      expect(r.isError, summary(r)).toBeFalsy();
      const d = data<{ rec_id: string; job: { id: string; state: string } }>(r);
      expect(d.rec_id).toMatch(/^rec_[0-9A-Z]{26}$/);
      expect(d.job.state).toBe('queued');
      expect(summary(r)).toMatch(/Ask the user to perform the flow there and close the window when done — you do not drive it/);
      expect(summary(r)).toMatch(new RegExp(`job_status \\{job_id: "${d.job.id}", wait_s: 25\\}`));
      expect(summary(r)).toMatch(/submit no other job meanwhile/);
      const queued = await call('job_status', { job_id: d.job.id });
      expect(summary(queued)).toMatch(/Queued: the window opens on the user's machine once the jobs ahead are done/);
      const cancelled = await call('job_cancel', { job_id: d.job.id });
      expect(data<{ state: string }>(cancelled).state).toBe('cancelled');
      const after = await call('job_status', { job_id: d.job.id });
      expect(data<{ job: { state: string }; untrusted?: unknown }>(after).job.state).toBe('cancelled');
      expect(existsSync(join(root, 'projects', PROJECT, 'scenarios', 'never-recorded.yaml'))).toBe(false);
    } finally {
      lock!.release();
    }
  });

  it('a recording run by the worker: counts and the check trusted, the draft from the folder under untrusted, the typed secret nowhere', async () => {
    const sentinel = `Sentinel-${randomBytes(6).toString('hex')}`;
    // The worker of this process plays the person (the server sees it alive and spawns none). Not `once`: it first
    // closes the job cancelled above, then runs the recording, then exits once idle.
    const worker = runWorker({
      root,
      idleExitMs: 8_000,
      pollMs: 100,
      log: () => undefined,
      ports: {
        recordWindow: {
          headless: true,
          windowSize: { width: 1400, height: 1000 },
          drive: async (page) => {
            await page.waitForLoadState('domcontentloaded');
            await page.waitForTimeout(800);
            await page.getByRole('heading', { name: 'Recording lab' }).waitFor();
            await page.locator('#lab-password').click();
            await page.keyboard.type(sentinel);
            await page.getByLabel('Note').click();
            await page.keyboard.type('Two bags of the washed lot');
            await page.waitForTimeout(400);
            await page.close();
          },
        },
      },
    });
    await new Promise((r) => setTimeout(r, 300));
    const r = await call('scenario_record', { project: PROJECT, page: 'shop', path: '/record-lab', scenario: 'lab-through-mcp' });
    expect(r.isError, summary(r)).toBeFalsy();
    const id = data<{ job: { id: string } }>(r).job.id;
    expect(await worker).toBe(0);

    const done = await call('job_status', { job_id: id, wait_s: 25 });
    const d = data<{
      job: { state: string };
      saved: { file: string; hash: string };
      check: { status: string; steps_passed: number; steps_total: number };
      counts: { actions: number };
      stats: { secrets: number; steps: number };
      issues: { codes: string[] };
      files: { draft: string };
      untrusted: { draft_lines: string[]; issues: Array<{ code: string }>; scenes: Array<{ id: string }> };
    }>(done);
    expect(d.job.state).toBe('succeeded');
    expect(d.saved.file).toBe('scenarios/lab-through-mcp.yaml');
    expect(d.check.status).toBe('passed');
    expect(d.stats.secrets).toBe(1);
    expect(d.issues.codes).toContain('secret_field');
    const draft = d.untrusted.draft_lines.join('\n');
    expect(draft).toBe((await readFile(d.files.draft, 'utf8')).replace(/\n$/, ''));
    expect(draft).toContain('{{vars.password_1}}');
    expect(draft).toContain('Two bags of the washed lot');
    expect(summary(done)).toMatch(/saved as scenarios\/lab-through-mcp\.yaml/);
    expect(summary(done)).toMatch(/check replay \(headless dry run\): \d+\/\d+ steps passed/);
    expect(summary(done)).toMatch(/ask the user for a showable demo value, never the real one/);
    // Typed text and the scene ids made from page paths only under `untrusted`.
    expect(summary(done)).not.toContain('Two bags');
    expect(JSON.stringify(trustedPart(done.structuredContent))).not.toContain('Two bags');
    expect(d.untrusted.scenes.length).toBeGreaterThan(0);

    // The scenario Claude would check next.
    const v = await call('scenario_validate', { project: PROJECT, yaml: `${draft}\n` });
    expect(data<{ ok: boolean }>(v).ok, summary(v)).toBe(true);

    // The sentinel: in no tool output, job file, worker log, history line or recording file.
    const all = [...(await files(jobsDir(root))), ...(await files(workersDir(root))), historyFile(root), ...(await files(join(root, 'projects', PROJECT, '.retake', 'records')))];
    for (const f of all.filter((x) => existsSync(x))) expect((await readFile(f)).includes(sentinel), f).toBe(false);
    expect(outputs.join('\n')).not.toContain(sentinel);
    expect(stderr).not.toContain(sentinel);
  }, 180_000);
});
