/**
 * The queue's waiting state for the Tools : what each job kind needs (JOB_TOOLS,
 * every kind), the gate (tools/gate.ts: the stamp and markers, the env overrides, a damaged app), pick skipping a
 * blocked job without holding the slot, derive's `yield: {cause: 'tools'}` and position's `held_by: 'tools'`, the
 * words, and the worker: it never claims a blocked job and exits idle while only blocked jobs wait, then a worker
 * started once the Tools are ready runs the job.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { overrideBundleInfo } from '@retake/core/io';
import type { ToolNeed } from '@retake/core/io';
import { fakeToolsBundle, placeTool, toolFixtures } from '@retake/test-support/tools';
import type { FixtureTools } from '@retake/test-support/tools';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { JOB_KINDS, JOB_TOOLS, jobNeeds } from '../src/jobs/job-input.js';
import type { JobInput } from '../src/jobs/job-input.js';
import { pick } from '../src/jobs/pick.js';
import type { PickRecord } from '../src/jobs/pick.js';
import { MemoryJobQueue } from '../src/jobs/memory-queue.js';
import { FileJobQueue } from '../src/jobs/queue.js';
import { heldWork, heldWorkWords, yieldWords } from '../src/jobs/held.js';
import { runWorker } from '../src/jobs/worker.js';
import { missingNeeds, toolsGate } from '../src/tools/gate.js';
import { cachedProjectBrowsers } from '../src/tools/tool-need.js';
import { createEngine } from '../src/engine.js';
import type { JobRecord } from '../src/jobs/types.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-tools-queue-')));
afterAll(() => {
  spawnSync('/bin/chmod', ['-R', 'u+w', tmp]);
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => overrideBundleInfo(undefined));
// A browser named by the environment needs no Tool (tools/gate.ts): the CI tier names a missing program in both
// (scripts/test-ci.mjs), so these tests run without them and give them back after.
const NAMED_BROWSERS = ['RETAKE_CHROMIUM', 'RETAKE_CHROMIUM_HEADLESS_SHELL'] as const;
const namedBrowsers = Object.fromEntries(NAMED_BROWSERS.map((k) => [k, process.env[k]]));
beforeAll(() => {
  for (const k of NAMED_BROWSERS) delete process.env[k];
});
afterAll(() => {
  for (const k of NAMED_BROWSERS)
    if (namedBrowsers[k] === undefined) delete process.env[k];
    else process.env[k] = namedBrowsers[k];
});
let fx: FixtureTools;
let n = 0;
beforeAll(async () => {
  fx = await toolFixtures(join(tmp, 'fx'));
});

const none: ReadonlySet<ToolNeed> = new Set();
const browser: ReadonlySet<ToolNeed> = new Set(['browser']);
const render: ReadonlySet<ToolNeed> = new Set(['render']);
const SHA = 'a'.repeat(64);
const runInput = (run: string, mode: 'capture' | 'dry' = 'capture'): JobInput =>
  ({ version: 1, kind: 'run', project: 'p', scenario: 's', scenario_sha256: SHA, mode, run_id: run, submitted_by: 'test', approvals: [] }) as unknown as JobInput;
const rec = (id: string, kind: string, input: unknown = { kind }): PickRecord => ({ id, state: 'queued', kind, input, claimed: false });

describe('what each job kind needs', () => {
  it('every kind is in the table; the browser for takes, sign-ins, recordings, inspections and sites; the render tools for renders, exports and previews', () => {
    expect(Object.keys(JOB_TOOLS).sort()).toEqual([...JOB_KINDS].sort());
    expect(JOB_KINDS.filter((k) => JOB_TOOLS[k] === 'browser').sort()).toEqual(['auth_login', 'inspect', 'record', 'run', 'site']);
    expect(JOB_KINDS.filter((k) => JOB_TOOLS[k] === 'render').sort()).toEqual(['export', 'preview', 'render']);
    expect(JOB_KINDS.filter((k) => JOB_TOOLS[k] === null).sort()).toEqual(['env_reset', 'hooks', 'review', 'sandbox_reset', 'sandbox_up']);
    expect(jobNeeds('from-a-newer-client')).toBeNull();
  });
});

describe('pick: a blocked job is skipped, never the whole slot', () => {
  it('a take waiting for the browser holds neither the capture slot nor the renders', () => {
    const take = rec('j_01', 'run', runInput('20261117-120000-s'));
    const hooks = rec('j_02', 'hooks');
    const rnd = rec('j_03', 'render');
    expect(pick([take, hooks, rnd], { slot: 'capture', filmingLive: false, blocked: browser })).toBe('j_02');
    expect(pick([take, hooks, rnd], { slot: 'heavy', filmingLive: false, blocked: browser })).toBe('j_03');
    // Without the gate a queued take holds every heavy job (captures first), as before.
    expect(pick([take, hooks, rnd], { slot: 'heavy', filmingLive: false, blocked: none })).toBeUndefined();
    expect(pick([take, hooks, rnd], { slot: 'capture', filmingLive: false })).toBe('j_01');
  });

  it('renders wait for the render tools; a review (no Tool) goes on', () => {
    const recs = [rec('j_01', 'render'), rec('j_02', 'preview'), rec('j_03', 'review'), rec('j_04', 'export')];
    expect(pick(recs, { slot: 'heavy', filmingLive: false, blocked: render })).toBe('j_03');
    expect(pick(recs, { slot: 'heavy', filmingLive: false, blocked: browser })).toBe('j_01');
  });
});

describe('the gate', () => {
  it('in a checkout: nothing missing; in the app: what is not ready, unless the variables name another browser; a damaged app: both', () => {
    const env = { RETAKE_HOME: join(tmp, `home${n++}`) };
    const app = fakeToolsBundle(join(tmp, 'app'), fx.entries);
    expect([...missingNeeds(env, null)]).toEqual([]);
    expect([...missingNeeds(env, app)].sort()).toEqual(['browser', 'render']);
    placeTool(join(env.RETAKE_HOME, 'tools'), fx.byId('compositor'));
    expect([...missingNeeds({ ...env, RETAKE_CHROMIUM: '/opt/chrome', RETAKE_CHROMIUM_HEADLESS_SHELL: '/opt/shell' }, app)]).toEqual([]);
    expect([...missingNeeds({ ...env, RETAKE_CHROMIUM_HEADLESS_SHELL: '/opt/shell' }, app)]).toEqual(['browser']);
    placeTool(join(env.RETAKE_HOME, 'tools'), fx.byId('render-browser'));
    expect([...missingNeeds(env, app)]).toEqual(['browser']);
    placeTool(join(env.RETAKE_HOME, 'tools'), fx.byId('browser'));
    expect([...missingNeeds(env, app)]).toEqual([]);
    expect([...missingNeeds(env, { ...app, manifest: { ...app.manifest, tools: [] } })].sort()).toEqual(['browser', 'render']);
    // Read again at most once per ttl.
    let reads = 0;
    const gate = toolsGate(env, () => (reads++, app), 60_000);
    gate();
    gate();
    expect(reads).toBe(1);
  });
});

describe('derive, position and the words', () => {
  it("a queued job whose Tool is missing waits for it ('tools'), whatever its class; its position says so", async () => {
    let missing: ReadonlySet<ToolNeed> = browser;
    const q = new MemoryJobQueue(join(tmp, 'ws-mem'), { tools: () => missing });
    const take = await q.enqueue(runInput('20261117-120000-s'));
    const t = await q.get(take.id);
    expect(t?.yield).toEqual({ state: 'waiting', cause: 'tools', needs: 'browser' });
    expect(await q.position(take.id)).toEqual({ ahead: 0, held_by: 'tools', needs: 'browser' });
    expect(yieldWords(t!.yield!)).toBe('waiting for the browser to be downloaded (it starts by itself once checked)');
    expect(heldWorkWords(heldWork([t!])!)).toBe('a run waits for the browser to be downloaded');
    missing = none;
    expect((await q.get(take.id))?.yield).toBeUndefined();
    const two = [
      { ...t!, yield: { state: 'waiting', cause: 'tools', needs: 'render' } },
      { ...t!, id: 'x', yield: { state: 'waiting', cause: 'tools', needs: 'render' } },
    ] as JobRecord[];
    expect(heldWorkWords(heldWork(two)!)).toBe('2 jobs wait for the render tools to be downloaded');
  });
});

describe('position', () => {
  it('a job held by the Tools is not ahead of the jobs of its lane (it is skipped: they go first)', async () => {
    const q = new MemoryJobQueue(join(tmp, 'ws-pos'), { tools: () => browser });
    await q.enqueue(runInput('20261117-150000-s'));
    const hooks = await q.enqueue({
      version: 1,
      kind: 'hooks',
      project: 'p',
      source: 'reset',
      dry: true,
      journal_id: '20261117-150001-hooks-reset',
      submitted_by: 'test',
      approvals: [],
    } as unknown as JobInput);
    expect(await q.position(hooks.id)).toEqual({ ahead: 0 });
  });
});

describe("a project's own browser", () => {
  it('a job whose project launches a browser of its own (browser.executable, channel chrome) needs no Tool; the headless shell needs the render tools; a project that cannot be read keeps its kind’s need', async () => {
    const projects: Record<string, unknown> = { own: { executable: '/opt/chrome' }, chrome: { channel: 'chrome' }, shell: { channel: 'headless-shell' }, plain: {} };
    const q = new MemoryJobQueue(join(tmp, 'ws-own'), { tools: () => browser, browsers: async (p) => (Object.hasOwn(projects, p) ? (projects[p] as object) : null) });
    const take = (project: string) => ({ kind: 'run', input: { ...(runInput('20261117-120000-s') as object), project } });
    expect(await q.toolNeed(take('own'), browser)).toBeNull();
    expect(await q.toolNeed(take('chrome'), browser)).toBeNull();
    expect(await q.toolNeed(take('shell'), browser)).toBe('render');
    expect(await q.toolNeed(take('plain'), browser)).toBe('browser');
    expect(await q.toolNeed(take('gone'), browser)).toBe('browser');
    // A recording opens a window: the headless shell is not what it starts (the browser is).
    expect(await q.toolNeed({ kind: 'record', input: { kind: 'record', project: 'shell' } }, browser)).toBe('browser');
    expect(await q.toolNeed({ kind: 'auth_login', input: { kind: 'auth_login', project: 'shell', mode: 'auto' } }, browser)).toBe('render');
    // Derive: the take on its own Chrome does not wait; pick takes it.
    const own = await q.enqueue({ ...(runInput('20261117-120001-s') as object), project: 'chrome' } as JobInput);
    expect((await q.get(own.id))?.yield).toBeUndefined();
    const plain = await q.enqueue({ ...(runInput('20261117-120002-s') as object), project: 'plain' } as JobInput);
    expect((await q.get(plain.id))?.yield).toEqual({ state: 'waiting', cause: 'tools', needs: 'browser' });
    expect(
      pick(
        [
          { ...rec(plain.id, 'run', plain.input), needs: 'browser' },
          { ...rec(own.id, 'run', own.input), needs: null },
        ],
        { slot: 'capture', filmingLive: false, blocked: browser },
      ),
    ).toBe(own.id);
  });

  it("through its engine, the queue reads each project's browser: (project.yaml, the workspace's folded in), at most once per ttl", async () => {
    const root = join(tmp, `ws${n++}`);
    mkdirSync(root);
    await fixtureWorkspace(root);
    const yaml = join(root, 'projects', 'northfield-fixture', 'project.yaml');
    writeFileSync(yaml, `${readFileSync(yaml, 'utf8')}\nbrowser:\n  channel: chrome\n`);
    const env = { ...process.env, RETAKE_HOME: join(tmp, `home${n++}`) };
    const bundle = fakeToolsBundle(join(tmp, 'app'), fx.entries);
    const engine = await createEngine({ root, client: 'test', ports: { env }, autoStartWorker: false, tools: { bundle } });
    const q = new FileJobQueue(root, 'retake', { now: () => Date.now(), monotonic: () => performance.now() }, env);
    const own = await q.enqueue({ ...(runInput('20261117-160000-s') as object), project: 'northfield-fixture' } as JobInput);
    const other = await q.enqueue(runInput('20261117-160001-s'));
    const jobs = await engine.jobs.list({ states: ['queued'] });
    // Its project films on the installed Chrome: no Tool to wait for. The other project cannot be read: its kind's need.
    expect(jobs.find((j) => j.id === own.id)?.yield).toBeUndefined();
    expect(jobs.find((j) => j.id === other.id)?.yield).toMatchObject({ cause: 'tools', needs: 'browser' });
    // The reader: one read per project per ttl, a throw reads as null.
    let reads = 0;
    const read = cachedProjectBrowsers(async (p) => {
      reads++;
      if (p === 'gone') throw new Error('no such project');
      return { channel: 'chrome' };
    }, 60_000);
    expect([await read('a'), await read('a'), await read('gone')]).toEqual([{ channel: 'chrome' }, { channel: 'chrome' }, null]);
    expect(reads).toBe(2);
  });
});

describe('the worker', () => {
  it('never claims a job waiting for the Tools and exits idle; a worker started once they are ready claims it', async () => {
    const root = join(tmp, `ws${n++}`);
    mkdirSync(root);
    await fixtureWorkspace(root);
    const env = { ...process.env, RETAKE_HOME: join(tmp, `home${n++}`) };
    overrideBundleInfo(fakeToolsBundle(join(tmp, 'app'), fx.entries));
    const clock = { now: () => Date.now(), monotonic: () => performance.now() };
    const q = new FileJobQueue(root, 'retake', clock, env);
    const job = await q.enqueue(runInput('20261117-120000-s', 'dry'));
    const t0 = performance.now();
    expect(await runWorker({ root, idleExitMs: 300, pollMs: 50, log: () => undefined, heavyInProcess: true, ports: { env } })).toBe(0);
    expect(performance.now() - t0).toBeLessThan(10_000);
    const waiting = await q.get(job.id);
    expect(waiting).toMatchObject({ state: 'queued', yield: { cause: 'tools', needs: 'browser' } });
    expect(await q.claimOf(job.id)).toBeUndefined();
    // The Tools are ready: the next worker takes the job (it fails here — no such project — but it ran).
    for (const t of fx.tools) placeTool(join(env.RETAKE_HOME, 'tools'), t);
    expect(await runWorker({ root, once: true, idleExitMs: 0, pollMs: 50, log: () => undefined, heavyInProcess: true, ports: { env } })).toBe(0);
    expect((await q.get(job.id))?.state).not.toBe('queued');
  });

  it('wake decides from the Tools as they are now: ready behind a gate cached before the install, the held job still starts', async () => {
    const root = join(tmp, `ws${n++}`);
    mkdirSync(root);
    await fixtureWorkspace(root);
    const env = { ...process.env, RETAKE_HOME: join(tmp, `home${n++}`) };
    const bundle = fakeToolsBundle(join(tmp, 'app'), fx.entries);
    overrideBundleInfo(bundle);
    const spawned: string[] = [];
    const workerSpawn = (() => (spawned.push('worker'), { pid: 999_999, on: () => undefined, unref: () => undefined })) as unknown as NonNullable<Parameters<typeof createEngine>[0]['workerSpawn']>;
    const engine = await createEngine({ root, client: 'test', ports: { env }, workerSpawn, tools: { bundle } });
    const q = new FileJobQueue(root, 'retake', { now: () => Date.now(), monotonic: () => performance.now() }, env);
    const job = await q.enqueue(runInput('20261117-130000-s', 'dry'));
    // The engine's queue reads (and caches for a second) its gate while the Tools are missing: the job waits.
    expect((await engine.jobs.list({ states: ['queued'] }))[0]).toMatchObject({ id: job.id, yield: { cause: 'tools' } });
    expect(await engine.tools.wake()).toBe(false);
    expect(spawned).toEqual([]);
    // The Tools arrive (another process installed them) within that second: the cache still says missing.
    for (const t of fx.tools) placeTool(join(env.RETAKE_HOME, 'tools'), t);
    expect(await engine.tools.wake()).toBe(true);
    expect(spawned).toEqual(['worker']);
  });

  it('opening an app engine starts no worker, even for a claimable job (retake list, doctor, MCP: only the Studio server, an install and a submit do)', async () => {
    const root = join(tmp, `ws${n++}`);
    mkdirSync(root);
    await fixtureWorkspace(root);
    const env = { ...process.env, RETAKE_HOME: join(tmp, `home${n++}`) };
    const bundle = fakeToolsBundle(join(tmp, 'app'), fx.entries);
    overrideBundleInfo(bundle);
    for (const t of fx.tools) placeTool(join(env.RETAKE_HOME, 'tools'), t);
    const q = new FileJobQueue(root, 'retake', { now: () => Date.now(), monotonic: () => performance.now() }, env);
    await q.enqueue(runInput('20261117-140000-s', 'dry'));
    const spawned: string[] = [];
    const workerSpawn = (() => (spawned.push('worker'), { pid: 999_999, on: () => undefined, unref: () => undefined })) as unknown as NonNullable<Parameters<typeof createEngine>[0]['workerSpawn']>;
    await createEngine({ root, client: 'cli', ports: { env }, workerSpawn, tools: { bundle } });
    await new Promise((r) => setTimeout(r, 200));
    expect(spawned).toEqual([]);
  });
});
