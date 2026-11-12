/**
 * Submitting and controlling jobs (L7.15's family), characterized through their shells before they became the engine's
 * operations: MCP's run_dry, run_capture, render, review, export, page_inspect, job_cancel (and job_status on each kind
 * they queue) through `retake mcp` over stdio (from the sources, the SDK's client, which asks no approval), and the
 * Studio's scenario_run, scenario_render, review_export, run_pause, sign_in_cancel, render_cancel through its
 * `POST /v1/call/<op>` — each shell on its own copy of one workspace: the fixture project (a persona no run signs in by
 * itself, a scenario whose setup hook needs a person, plain scenarios) and `demo` with a synthetic take of `tl` and three
 * finished renders (tl-v7, tl-v8, tl-v9). The test process holds the workspace's worker lock, so a submit finds a live
 * worker and none is started (asserted: no worker.log): every job stays queued.
 *
 * In it: each submit queued, a second submit refused naming the job (409), two submits at once (one queued, one 409 —
 * sorted by status: which one wins is the arrival's), the approval refusal of a hook that needs a person (no approver),
 * a capture whose persona's session is not valid (409 with details.sessions) then confirmed, a changed file (scenario_run
 * `hash`, scenario_render `expect_edit_sha256`), the export cap (two open: 409 with details.open), the cancels and their
 * refusals, a run_pause of a queued run, an op of the other shell, the queue at the end (job_list). The Studio's status
 * and Retry-After header are recorded: none of these ops answers 429 (only render_frame does).
 *
 * Normalised: the workspace, repository and home paths, ISO stamps, job, inspection and run ids by order of appearance
 * (per shell), pids, the host name as a whole word, the Node binary, the repository's address, Node's and Retake's
 * versions. Held against fixtures/job-ops.json, recorded on the commit before the move (RETAKE_WRITE_SNAPSHOTS=1 on this
 * file records it again: review the diff).
 *
 * Not here: a job that runs (the worker is held off: stdio-runs, stdio-render, stdio-review, stdio-inspect), an approved
 * hook (stdio-approvals), a running run's pause (run-live-pause).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RETAKE_REPOSITORY, RETAKE_VERSION } from '@retake/core';
import { WorkerLock, systemClock, workersDir } from '@retake/engine';
import { REPO, fixtureWorkspace } from '../../engine/test/helpers.js';
import { testChildEnv } from '../../core/test/child-env.js';
import { synthTimeline } from '../../editor/test/helpers.js';
import { hasTool } from '../../editor/test/render-helpers.js';
import { startStudioServer } from '../../ui/src/index.js';
import type { StudioServer } from '../../ui/src/index.js';
import { raw } from '../../ui/test/http.js';
import { writeTake } from '../../ui/test/timeline-take.js';

const FILE = fileURLToPath(new URL('./fixtures/job-ops.json', import.meta.url));
const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
const P = 'northfield-fixture';
const D = 'demo';
const TAKE = '20260101-120000-tl';
/** The run ids the fixture writes (kept as they are); every other run id is today's (normalised by order). */
const FIXED_RUNS = new Set([TAKE, '20261017-120000-quote', '20261016-090000-catalogue']);
const UNSET = 'RETAKE_TEST_JOB_OPS_UNSET_PW';
const TEXT = `video: Timeline
title: {text: Timeline}
intro: false
outro: false
scenes:
  - id: a
    page: app
    open: /
    caption: Every frame has its own number.
    steps:
      - hold: 1
`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const plain = (video: string, env?: string) =>
  [`video: ${video}`, ...(env ? [`env: ${env}`] : []), 'scenes:', '  - id: a', '    page: console', '    open: /', '    steps:', '      - hold: 1', ''].join('\n');
const NONE = `j_${'0'.repeat(26)}`;

/** What a call's raw answer gave the later calls (ids it named). */
type State = Record<string, string>;
/** One call: its op, its arguments, the ids to keep from its raw answer, or two calls at once (`twice`). */
interface Call {
  op: string;
  args: Record<string, unknown> | ((s: State) => Record<string, unknown>);
  keep?: Record<string, RegExp>;
  twice?: true;
}
const JOB = /\b(j_[0-9A-HJKMNP-TV-Z]{26})\b/;
const RUN = /\b(\d{8}-\d{6}-[a-z0-9-]+)\b/;

const MCP: Call[] = [
  { op: 'run_dry', args: { project: P, scenario: 'quote', wait_s: 0 }, keep: { dryJob: JOB, dryRun: RUN } },
  { op: 'run_dry', args: { project: P, scenario: 'quote', wait_s: 0 } },
  { op: 'run_capture', args: { project: P, scenario: 'quote' } },
  { op: 'run_dry', args: { project: P, scenario: 'one-a', wait_s: 0 }, twice: true },
  { op: 'run_dry', args: { project: P, scenario: 'approve', hooks: 'run', wait_s: 0 } },
  { op: 'run_capture', args: { project: P, scenario: 'approve' } },
  { op: 'run_capture', args: { project: P, scenario: 'signed' } },
  { op: 'run_capture', args: { project: P, scenario: 'signed', sessions_ack: ['supplier'] }, keep: { captureJob: JOB } },
  { op: 'run_capture', args: { project: P, scenario: 'one-b', sessions_ack: ['Not A Persona'] } },
  { op: 'run_dry', args: { project: P, scenario: 'no-such-scenario', wait_s: 0 } },
  { op: 'run_dry', args: { project: P, scenario: 'one-c', until: 'a.0', wait_s: 0 } },
  { op: 'render', args: { project: D, scenario: 'tl', template: 'nowhere' } },
  { op: 'render', args: { project: D, scenario: 'tl', template: '../editorial' } },
  { op: 'render', args: { project: D, scenario: 'tl', run_id: TAKE, overrides: { variant: 'square' } }, keep: { renderJob: JOB } },
  { op: 'render', args: { project: D, scenario: 'tl' } },
  { op: 'render', args: { project: P, scenario: 'quote' } },
  { op: 'review', args: { project: D, render_id: 'tl-v7', wait_s: 0 }, keep: { reviewJob: JOB } },
  { op: 'review', args: { project: D, render_id: 'tl-v1', wait_s: 0 } },
  { op: 'review', args: { project: D, render_id: 'latest', scenario: 'tl', fps: 2, previous: false, images: 'none', wait_s: 0 } },
  { op: 'export', args: { project: D, render_id: 'tl-v7' }, keep: { exportJob: JOB } },
  { op: 'export', args: { project: D, render_id: 'tl-v7', formats: ['webm'] } },
  { op: 'export', args: { project: D, render_id: 'tl-v9', formats: ['mp4_1080p'], gif_duration_s: 5 } },
  { op: 'export', args: { project: D, render_id: 'tl-v8' } },
  { op: 'export', args: { project: D, render_id: 'tl-v1' } },
  { op: 'export', args: { project: D, render_id: 'tl-v8', formats: ['webm', 'webm'] } },
  { op: 'page_inspect', args: { project: P, page: 'console', path: '/imports', wait_s: 0 }, keep: { inspectJob: JOB } },
  { op: 'page_inspect', args: { project: P, scenario: 'quote', until: 'a.0', images: 'none', detail: 'full', wait_s: 0 } },
  { op: 'page_inspect', args: { project: P, page: 'nowhere', wait_s: 0 } },
  { op: 'page_inspect', args: { project: P, url: 'http://elsewhere.test/', wait_s: 0 } },
  { op: 'page_inspect', args: { project: P, wait_s: 0 } },
  { op: 'job_status', args: (s) => ({ job_id: s.dryJob! }) },
  { op: 'job_status', args: (s) => ({ job_id: s.captureJob! }) },
  { op: 'job_status', args: (s) => ({ job_id: s.renderJob! }) },
  { op: 'job_status', args: (s) => ({ job_id: s.reviewJob! }) },
  { op: 'job_status', args: (s) => ({ job_id: s.exportJob! }) },
  { op: 'job_status', args: (s) => ({ job_id: s.inspectJob! }) },
  { op: 'job_status', args: (s) => ({ job_id: s.inspectJob!, detail: 'full' }) },
  { op: 'job_cancel', args: (s) => ({ job_id: s.inspectJob! }) },
  { op: 'job_cancel', args: (s) => ({ job_id: s.inspectJob! }) },
  { op: 'job_status', args: (s) => ({ job_id: s.inspectJob! }) },
  { op: 'job_cancel', args: (s) => ({ job_id: s.renderJob! }) },
  { op: 'job_cancel', args: (s) => ({ job_id: s.exportJob! }) },
  { op: 'job_cancel', args: { job_id: NONE } },
  { op: 'job_cancel', args: { job_id: 'j_nope' } },
  // Once the export of tl-v7 is cancelled, one more fits under the cap.
  { op: 'export', args: { project: D, render_id: 'tl-v8', formats: ['gif_preview'], gif_start_s: 1 } },
  // The Studio's ops are not MCP tools.
  { op: 'scenario_run', args: { project: P, name: 'quote', mode: 'dry' } },
  { op: 'render_cancel', args: (s) => ({ project: D, job: s.renderJob! }) },
  { op: 'job_list', args: {} },
];

const STUDIO: Call[] = [
  { op: 'scenario_run', args: { project: P, name: 'quote', mode: 'dry' }, keep: { dryJob: JOB, dryRun: RUN } },
  { op: 'scenario_run', args: { project: P, name: 'quote', mode: 'capture' } },
  { op: 'scenario_run', args: { project: P, name: 'one-a', mode: 'dry' }, twice: true },
  { op: 'scenario_run', args: { project: P, name: 'one-b', mode: 'capture', hash: sha('another text\n') } },
  { op: 'scenario_run', args: { project: P, name: 'one-b', mode: 'capture', hash: sha(plain('one-b')) } },
  { op: 'scenario_run', args: { project: P, name: 'approve', mode: 'capture' } },
  { op: 'scenario_run', args: { project: P, name: 'approve', mode: 'dry', env: 'local' } },
  { op: 'scenario_run', args: { project: P, name: 'signed', mode: 'capture' } },
  { op: 'scenario_run', args: { project: P, name: 'signed', mode: 'capture', sessions_ack: ['supplier'] } },
  { op: 'scenario_run', args: { project: P, name: 'one-c', mode: 'dry', sessions_ack: ['supplier'] } },
  { op: 'scenario_run', args: { project: P, name: 'quote', mode: 'later' } },
  { op: 'scenario_run', args: { project: P, name: 'no-such-scenario', mode: 'dry' } },
  { op: 'scenario_run', args: { project: P, name: 'quote', mode: 'dry', until: 'a.0' } },
  { op: 'run_pause', args: (s) => ({ project: P, run_id: s.dryRun!, paused: true }) },
  { op: 'run_pause', args: (s) => ({ project: P, run_id: s.dryRun!, paused: false }) },
  { op: 'run_pause', args: { project: P, run_id: '20990101-000000-quote', paused: true } },
  { op: 'run_pause', args: { project: P, run_id: '../x', paused: true } },
  { op: 'auth_login', args: { project: P, env: 'signed-in', persona: 'supplier' }, keep: { signInJob: JOB } },
  { op: 'sign_in_cancel', args: (s) => ({ job: s.dryJob! }) },
  { op: 'sign_in_cancel', args: (s) => ({ job: s.signInJob! }) },
  { op: 'sign_in_cancel', args: { job: NONE } },
  { op: 'sign_in_cancel', args: { job: 'j_nope' } },
  { op: 'scenario_render', args: { project: D, name: 'tl', run: TAKE, expect_edit_sha256: sha(TEXT) }, keep: { renderJob: JOB } },
  { op: 'scenario_render', args: { project: D, name: 'tl', run: TAKE, expect_edit_sha256: sha(TEXT) } },
  { op: 'scenario_render', args: { project: D, name: 'tl', run: TAKE, expect_edit_sha256: 'b'.repeat(64) } },
  { op: 'render_cancel', args: (s) => ({ project: P, job: s.renderJob! }) },
  { op: 'render_cancel', args: (s) => ({ project: P, job: s.dryJob! }) },
  { op: 'render_cancel', args: (s) => ({ project: D, job: s.renderJob! }) },
  { op: 'render_cancel', args: (s) => ({ project: D, job: s.renderJob! }) },
  { op: 'render_cancel', args: { project: D, job: NONE } },
  { op: 'scenario_render', args: { project: D, name: 'tl', run: TAKE, expect_edit_sha256: 'b'.repeat(64) } },
  { op: 'scenario_render', args: { project: D, name: 'tl', run: '20990101-000000-tl', expect_edit_sha256: sha(TEXT) } },
  { op: 'scenario_render', args: { project: D, name: 'tl', run: TAKE, expect_edit_sha256: sha(TEXT), review: false } },
  { op: 'review_export', args: { project: D, render_id: 'tl-v7' } },
  { op: 'review_export', args: { project: D, render_id: 'tl-v7' } },
  { op: 'review_export', args: { project: D, render_id: 'tl-v9' } },
  { op: 'review_export', args: { project: D, render_id: 'tl-v8' } },
  { op: 'review_export', args: { project: D, render_id: 'tl-v1' } },
  { op: 'review_export', args: { project: D, render_id: 'latest' } },
  // MCP's tools are not Studio ops.
  { op: 'run_dry', args: { project: P, scenario: 'quote' } },
  { op: 'job_cancel', args: (s) => ({ job_id: s.dryJob! }) },
  { op: 'export', args: { project: D, render_id: 'tl-v7' } },
  { op: 'job_list', args: {} },
];

/** A succeeded render record of `tl` (as a render writes it), with its video file. */
async function writeRecord(dir: string, id: string, created: string): Promise<void> {
  const r = join(dir, 'renders');
  await mkdir(r, { recursive: true });
  await writeFile(join(r, `${id}.mp4`), 'video');
  await writeFile(
    join(r, `${id}.json`),
    JSON.stringify({
      version: 1,
      id,
      project: D,
      scenario: 'tl',
      run_id: TAKE,
      run_dir: join(dir, 'runs', TAKE),
      template: 'editorial',
      overrides: {},
      edit: { from: 'scenario', sha256: sha(TEXT) },
      variant: 'landscape',
      status: 'succeeded',
      file: join(r, `${id}.mp4`),
      record: join(r, `${id}.json`),
      render_version: Number(/-v(\d+)/.exec(id)![1]),
      created_at: created,
      finished_at: created,
      duration_s: 3,
      frames: 90,
      fps: 30,
      width: 1920,
      height: 1080,
      size_bytes: 1234,
      plan: {},
      warnings: [],
    }),
  );
}

/** The workspace: the fixture project with its extra scenarios, and `demo` with its take and three renders; the worker lock held. */
async function workspace(name: string): Promise<{ ws: string; home: string; lock: WorkerLock }> {
  const ws = await mkdtemp(join(tmpdir(), `retake-job-ops-${name}-`));
  const home = join(ws, '.home');
  await fixtureWorkspace(ws);
  const project = join(ws, 'projects', P);
  // The supplier's login steps use a variable no process has: no run signs it in by itself (never signed in either).
  const yaml = await readFile(join(project, 'project.yaml'), 'utf8');
  expect(yaml).toContain('{{env:NORTHFIELD_SUPPLIER_PASSWORD}}');
  await writeFile(join(project, 'project.yaml'), yaml.replace('{{env:NORTHFIELD_SUPPLIER_PASSWORD}}', `{{env:${UNSET}}}`));
  for (const n of ['one-a', 'one-b', 'one-c']) await writeFile(join(project, 'scenarios', `${n}.yaml`), plain(n));
  await writeFile(join(project, 'scenarios', 'signed.yaml'), plain('signed', 'signed-in'));
  // A setup hook that runs a shell command: through these shells it needs a person.
  await writeFile(join(project, 'scenarios', 'approve.yaml'), `setup:\n  - name: say\n    shell: {run: "echo hello"}\n${plain('approve')}`);
  const dir = join(ws, 'projects', D);
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'version: 1\nname: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  await writeFile(join(dir, 'README.md'), '# Demo\n\nA synthetic take.\n');
  const t = synthTimeline({
    duration: 3,
    entries: [{ id: 'a', t_start: 0.5, t_end: 2.5, caption: { text: 'Every frame has its own number.' }, steps: [{ action: 'hold', t_start: 0.5, t_end: 2.5 }] }],
    video: { title: { text: 'Timeline' }, intro: false, outro: false, template: 'editorial' },
  });
  await writeTake(dir, 'tl', { run: TAKE, text: TEXT, timeline: t, codec: 'h264-x264', seconds: 3 });
  await writeRecord(dir, 'tl-v7', '2026-01-02T10:00:00.000Z');
  await writeRecord(dir, 'tl-v8', '2026-01-02T09:30:00.000Z');
  await writeRecord(dir, 'tl-v9', '2026-01-02T09:00:00.000Z');
  // This process holds the worker lock: a submit finds a live worker, so none is started and every job stays queued.
  const lock = await WorkerLock.acquire(ws, 'b1', systemClock);
  expect(lock).not.toBeNull();
  return { ws, home, lock: lock! };
}

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The answer with what changes between runs replaced: paths, stamps, ids by order (per shell), pids, versions. */
function normalise(v: unknown, o: { paths: Array<[string, string]>; ids: Map<string, string> }): unknown {
  const { ids } = o;
  const byOrder = (kind: string) => (id: string) => {
    if (!ids.has(id)) ids.set(id, `<${kind}-${[...ids.values()].filter((x) => x.startsWith(`<${kind}-`)).length + 1}>`);
    return ids.get(id)!;
  };
  const text = (s: string): string => {
    let t = s;
    for (const [from, to] of o.paths) t = t.split(from).join(to);
    t = t.split(process.execPath).join('<node-bin>').split(RETAKE_REPOSITORY).join('<repository>');
    t = t.replace(new RegExp(`(?<![\\w.-])${escaped(hostname())}(?![\\w-])`, 'g'), '<host>');
    t = t.split(`/blob/v${RETAKE_VERSION}/`).join('/blob/v<version>/').split(RETAKE_VERSION).join('<version>');
    t = t.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<at>');
    t = t.replace(/\bj_[0-9A-HJKMNP-TV-Z]{26}\b/g, byOrder('job'));
    t = t.replace(/\bi_[0-9A-HJKMNP-TV-Z]{26}\b/g, byOrder('inspection'));
    t = t.replace(/\b\d{8}-\d{6}-[a-z0-9][a-z0-9-]*\b/g, (id) => (FIXED_RUNS.has(id) ? id : byOrder('run')(id)));
    return t.replace(/\bpid \d+\b/g, 'pid <pid>');
  };
  const walk = (x: unknown, key?: string): unknown => {
    if (typeof x === 'string' && ((key === 'host' && x === hostname()) || (key === 'node' && x === process.versions.node))) return `<${key}>`;
    if (typeof x === 'string') return text(x);
    if (typeof x === 'number' && (key === 'pid' || key === 'ppid')) return '<pid>';
    if (Array.isArray(x)) return x.map((y) => walk(y));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [text(k), walk(y, k)]));
    return x;
  };
  return walk(v);
}

/** The paths of a workspace, longest first (its real path too: macOS /var → /private/var), with their placeholders. */
async function pathsOf(ws: string, home: string): Promise<Array<[string, string]>> {
  const pairs: Array<[string, string]> = [
    [home, '<home>'],
    [await realpath(home).catch(() => home), '<home>'],
    [ws, '<ws>'],
    [await realpath(ws), '<ws>'],
    [REPO.replace(/\/$/, ''), '<repo>'],
    [process.cwd(), '<cwd>'],
  ];
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

type Answers = Array<{ op: string; args: unknown; answer: unknown }>;

let mcpAnswers: Answers = [];
let studioAnswers: Answers = [];
/** Whether either shell started a worker (it would write workers/worker.log). */
const workerLogs: boolean[] = [];
const cleanup: Array<() => Promise<void>> = [];

/** Keep the ids a call's raw answer names (its text and data as JSON), the first match of each pattern. */
function kept(c: Call, rawText: string, state: State): void {
  for (const [k, re] of Object.entries(c.keep ?? {})) {
    const m = re.exec(rawText);
    if (m) state[k] = m[1]!;
  }
}

/** Two answers of one call made twice at once, in a stable order: by status (the arrival decides which one wins). */
const byOutcome = <T>(pair: T[], failed: (a: T) => boolean): T[] => [...pair].sort((a, b) => Number(failed(a)) - Number(failed(b)));

async function viaMcp(): Promise<Answers> {
  const { ws, home, lock } = await workspace('mcp');
  cleanup.push(async () => {
    lock.release();
    await rm(ws, { recursive: true, force: true });
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--conditions=source', '--import', 'tsx', BIN, '--root', ws, 'mcp'],
    cwd: REPO,
    env: testChildEnv({ RETAKE_HOME: home, RETAKE_DISK_WARN: 'off' }),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'retake-test', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  cleanup.unshift(() => client.close());
  const out: Answers = [];
  const state: State = {};
  const n = { paths: await pathsOf(ws, home), ids: new Map<string, string>() };
  type One = { isError: boolean; text?: string; data?: unknown } | { protocolError: string };
  const one = async (op: string, args: Record<string, unknown>): Promise<One> => {
    const called = await client.callTool({ name: op, arguments: args }, undefined, { timeout: 60_000 }).catch((e: unknown) => ({ protocolError: e instanceof Error ? e.message : String(e) }));
    if ('protocolError' in called) return { protocolError: String(called.protocolError) };
    const r = called as { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
    return { isError: r.isError ?? false, text: r.content[0]?.text, data: r.structuredContent };
  };
  for (const c of MCP) {
    const args = typeof c.args === 'function' ? c.args(state) : c.args;
    if (c.twice) {
      const pair = byOutcome(await Promise.all([one(c.op, args), one(c.op, args)]), (a) => 'protocolError' in a || a.isError);
      for (const a of pair) kept(c, JSON.stringify(a), state);
      out.push({ op: c.op, args: normalise(args, n), answer: normalise({ twice: pair }, n) });
      continue;
    }
    const a = await one(c.op, args);
    kept(c, JSON.stringify(a), state);
    out.push({ op: c.op, args: normalise(args, n), answer: normalise(a, n) });
  }
  workerLogs.push(existsSync(join(workersDir(ws), 'worker.log')));
  return out;
}

async function viaStudio(): Promise<Answers> {
  const { ws, home, lock } = await workspace('studio');
  cleanup.push(async () => {
    lock.release();
    await rm(ws, { recursive: true, force: true });
  });
  const saved = process.env.RETAKE_HOME;
  process.env.RETAKE_HOME = home;
  cleanup.push(async () => {
    if (saved === undefined) delete process.env.RETAKE_HOME;
    else process.env.RETAKE_HOME = saved;
  });
  // The worker starts on a submit, as in the app: the lock this process holds makes it find a live one.
  const studio: StudioServer = await startStudioServer({ root: ws });
  cleanup.unshift(() => studio.close());
  const out: Answers = [];
  const state: State = {};
  const n = { paths: await pathsOf(ws, home), ids: new Map<string, string>() };
  const one = async (op: string, args: Record<string, unknown>) => {
    const r = await raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
    return { status: r.status, ...(r.headers['retry-after'] !== undefined ? { retry_after: r.headers['retry-after'] } : {}), body: r.json() };
  };
  for (const c of STUDIO) {
    const args = typeof c.args === 'function' ? c.args(state) : c.args;
    if (c.twice) {
      const pair = byOutcome(await Promise.all([one(c.op, args), one(c.op, args)]), (a) => a.status !== 200);
      for (const a of pair) kept(c, JSON.stringify(a), state);
      out.push({ op: c.op, args: normalise(args, n), answer: normalise({ twice: pair }, n) });
      continue;
    }
    const a = await one(c.op, args);
    kept(c, JSON.stringify(a), state);
    out.push({ op: c.op, args: normalise(args, n), answer: normalise(a, n) });
  }
  workerLogs.push(existsSync(join(workersDir(ws), 'worker.log')));
  return out;
}

beforeAll(async () => {
  if (!canRun) return;
  delete process.env[UNSET];
  mcpAnswers = await viaMcp();
  studioAnswers = await viaStudio();
}, 240_000);

afterAll(async () => {
  for (const f of cleanup) await f().catch(() => undefined);
});

describe.skipIf(!canRun)('submitting and controlling jobs through their shells (characterization)', () => {
  it('answer as fixtures/job-ops.json says, through MCP stdio and the Studio', () => {
    const text = `${JSON.stringify({ mcp: mcpAnswers, studio: studioAnswers }, null, 1)}\n`;
    if (process.env.RETAKE_WRITE_SNAPSHOTS === '1') writeFileSync(FILE, text);
    expect(text).toBe(readFileSync(FILE, 'utf8'));
    expect(mcpAnswers.map((a) => a.op)).toEqual(MCP.map((c) => c.op));
    expect(studioAnswers.map((a) => a.op)).toEqual(STUDIO.map((c) => c.op));
    // No worker was started: every job stayed queued for the next call to find.
    expect(workerLogs).toEqual([false, false]);
    // Every op of the family answered at least once through the shell that serves it.
    const ok = (a: { answer: unknown }) => {
      const x = a.answer as { isError?: boolean; status?: number; twice?: Array<{ isError?: boolean; status?: number }> };
      return x.twice ? x.twice.some((y) => y.isError === false || y.status === 200) : x.isError === false || x.status === 200;
    };
    for (const op of ['run_dry', 'run_capture', 'render', 'review', 'export', 'page_inspect', 'job_cancel', 'job_status'])
      expect(
        mcpAnswers.some((a) => a.op === op && ok(a)),
        op,
      ).toBe(true);
    for (const op of ['scenario_run', 'scenario_render', 'review_export', 'sign_in_cancel', 'render_cancel'])
      expect(
        studioAnswers.some((a) => a.op === op && ok(a)),
        op,
      ).toBe(true);
    // The refusals the family is held to are in it: two submits at once (one 409 naming the job), sessions_ack missing
    // (details.sessions), a changed file, the export cap (details.open).
    expect(text).toContain('"sessions": [');
    expect(text).toContain('"open": 2');
    expect(studioAnswers.some((a) => (a.answer as { status: number }).status === 429 || 'retry_after' in (a.answer as object))).toBe(false);
    // Nothing machine-specific is left: no path of this machine, no host name, no Node binary or version.
    for (const leak of [REPO.replace(/\/$/, ''), tmpdir(), homedir(), process.execPath, RETAKE_REPOSITORY, `"${process.versions.node}"`]) expect(text.includes(leak), leak).toBe(false);
    expect(new RegExp(`(?<![\\w.-])${escaped(hostname())}(?![\\w-])`).test(text)).toBe(false);
  });
});
