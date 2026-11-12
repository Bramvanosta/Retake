/**
 * The eleven operations both MCP and the Studio serve (engine_info, project_list, project_get, project_update_readme,
 * scenario_validate, run_list, run_status, run_cancel, job_list, auth_status, auth_login), characterized through both
 * shells before they became the engine's operations (L7.13): each call's answer through `retake mcp` over stdio (from
 * the sources, the SDK's client) and through the Studio's `POST /v1/call/<op>`, each shell on its own copy of the
 * fixture workspace with a dry run queued by a test engine (no worker), normalised — the workspace, repository and home
 * paths, ISO stamps, job ids by order of appearance, the queued run's id, pids, the host name, Node's and Retake's versions — and
 * held against fixtures/shared-ops.json, which was recorded on the commit before the move (RETAKE_WRITE_SNAPSHOTS=1 on
 * this file records it again: review the diff).
 *
 * Not here: a sign-in through MCP that succeeds (it starts the worker, which opens a window), a stale engine (MCP's
 * stale-engine.test.ts), a long poll (stdio-runs.test.ts), a worker of another copy (engine-info-other-copy.test.ts).
 */
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RETAKE_VERSION } from '@retake/core';
import { createEngine } from '@retake/engine';
import { REPO } from '@retake/test-support/repo';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { testChildEnv } from '@retake/test-support/child-env';
import { startStudioServer } from '../../ui/src/index.js';
import type { StudioServer } from '../../ui/src/index.js';
import { raw } from '@retake/test-support/http';
import { scratchHome } from '@retake/test-support/home';

const FILE = fileURLToPath(new URL('./fixtures/shared-ops.json', import.meta.url));
const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const P = 'northfield-fixture';
const GOOD = 'video: good\nscenes:\n  - id: home\n    page: console\n    open: /\n    steps:\n      - click: Products\n';
const BAD = 'video: bad\nscenes:\n  - id: home\n    page: console\n    open: /\n    steps:\n      - clik: Products\n';
const FAILED_DRY = '20261017-120000-quote';
const CAPTURE = '20261016-090000-catalogue';

/** One call: its op, its arguments, and (`readme`) the README hash the shell's project_get answered. */
interface Call {
  op: string;
  args: Record<string, unknown> | ((s: State) => Record<string, unknown>);
  only?: 'mcp' | 'studio';
}
interface State {
  readmeHash?: string;
  queued: string;
}

/** The calls, in order, the same for both shells (`only`: the one shell that makes it). */
const CALLS: Call[] = [
  { op: 'engine_info', args: {} },
  { op: 'engine_info', args: { verbose: true } },
  { op: 'project_list', args: {} },
  { op: 'project_get', args: { project: P } },
  { op: 'project_get', args: { project: 'no-such-project' } },
  { op: 'project_get', args: { project: '../outside' } },
  { op: 'project_update_readme', args: { project: P, markdown: '# Northfield\n\nRewritten.\n' } },
  { op: 'project_update_readme', args: { project: P, markdown: '# Northfield\n\nRewritten.\n', if_match: 'f'.repeat(64) } },
  { op: 'project_update_readme', args: (s) => ({ project: P, markdown: '# Northfield\n\nRewritten.\n', if_match: s.readmeHash }) },
  { op: 'project_get', args: { project: P } },
  { op: 'scenario_validate', args: { project: P, yaml: GOOD, name: 'good' } },
  { op: 'scenario_validate', args: { project: P, yaml: BAD } },
  { op: 'scenario_validate', args: { project: P, yaml: GOOD, env: 'nowhere' } },
  { op: 'scenario_validate', args: { project: P, yaml: GOOD, until: 'home.9' } },
  { op: 'scenario_validate', args: { project: P } },
  { op: 'run_list', args: { project: P } },
  { op: 'run_list', args: { project: P, scenario: 'quote', mode: 'dry', limit: 1 } },
  { op: 'run_list', args: { project: P, limit: 0 } },
  { op: 'run_status', args: (s) => ({ project: P, run_id: s.queued }) },
  { op: 'run_status', args: { project: P, run_id: FAILED_DRY } },
  { op: 'run_status', args: { project: P, run_id: FAILED_DRY, detail: 'full' } },
  { op: 'run_status', args: { project: P, run_id: CAPTURE } },
  { op: 'run_status', args: { project: P, run_id: '20990101-000000-none' } },
  { op: 'run_status', args: { project: P, run_id: '../../etc' } },
  { op: 'run_status', args: (s) => ({ project: P, run_id: s.queued, wait_s: 5 }), only: 'studio' },
  { op: 'job_list', args: {} },
  { op: 'job_list', args: { project: P, state: ['queued'], limit: 5 } },
  { op: 'job_list', args: { state: ['stuck'] } },
  { op: 'auth_status', args: {} },
  { op: 'auth_status', args: { project: P, env: 'signed-in' } },
  { op: 'auth_status', args: { env: 'signed-in' } },
  { op: 'auth_status', args: { project: 'no-such-project' } },
  { op: 'auth_login', args: { project: P } },
  { op: 'auth_login', args: { project: P, env: 'signed-in', persona: 'nobody' } },
  { op: 'auth_login', args: { project: P, env: 'nowhere', persona: 'buyer' } },
  { op: 'auth_login', args: { project: P, env: 'signed-in', persona: 'buyer', mode: 'auto' }, only: 'studio' },
  { op: 'auth_login', args: { project: P, env: 'signed-in', persona: 'buyer', wait_s: 5 }, only: 'studio' },
  { op: 'auth_login', args: { project: P, env: 'signed-in', persona: 'buyer', mode: 'fast' } },
  { op: 'auth_login', args: { project: P, env: 'signed-in', persona: 'buyer' }, only: 'studio' },
  { op: 'job_list', args: { project: P }, only: 'studio' },
  { op: 'run_cancel', args: { project: P, run_id: FAILED_DRY } },
  { op: 'run_cancel', args: { project: P, run_id: '20990101-000000-none' } },
  { op: 'run_cancel', args: (s) => ({ project: P, run_id: s.queued }) },
  { op: 'run_cancel', args: (s) => ({ project: P, run_id: s.queued }) },
  { op: 'run_status', args: (s) => ({ project: P, run_id: s.queued }) },
];

/** A workspace of the fixture project with a dry run of `quote` queued by a test engine (no worker started). */
async function workspace(name: string): Promise<{ ws: string; home: string; queued: string }> {
  const ws = await mkdtemp(join(tmpdir(), `retake-shared-ops-${name}-`));
  const home = join(ws, '.home');
  await fixtureWorkspace(ws);
  const engine = await createEngine({ root: ws, client: 'test', autoStartWorker: false });
  const sub = await engine.runs.submit({ project: P, scenario: 'quote', mode: 'dry' });
  return { ws, home, queued: sub.run_id };
}

/** The answer with what changes between runs replaced: paths, stamps, job ids by order (per shell), the queued run's id, pids. */
function normalise(v: unknown, o: { paths: Array<[string, string]>; queued: string; jobs: Map<string, string> }): unknown {
  const { jobs } = o;
  const text = (s: string): string => {
    let t = s;
    for (const [from, to] of o.paths) t = t.split(from).join(to);
    t = t.split(o.queued).join('<queued-run>');
    t = t.split(hostname()).join('<host>');
    // The version (engine_info, the docs links of errors): a release changes it, not this lot's answers.
    t = t.split(`/blob/v${RETAKE_VERSION}/`).join('/blob/v<version>/').split(RETAKE_VERSION).join('<version>');
    t = t.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<at>');
    t = t.replace(/\bj_[0-9A-HJKMNP-TV-Z]{26}\b/g, (id) => {
      if (!jobs.has(id)) jobs.set(id, `<job-${jobs.size + 1}>`);
      return jobs.get(id)!;
    });
    return t.replace(/\bpid \d+\b/g, 'pid <pid>');
  };
  const walk = (x: unknown, key?: string): unknown => {
    // The machine's name and Node's version (engine_info): this machine's, never the fixture's (tested before any
    // other string: their values are only this machine's).
    if (typeof x === 'string' && (key === 'host' || key === 'node')) return `<${key}>`;
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
const cleanup: Array<() => Promise<void>> = [];

async function viaMcp(): Promise<Answers> {
  const { ws, home, queued } = await workspace('mcp');
  cleanup.push(() => rm(ws, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--conditions=source', '--import', 'tsx', BIN, '--root', ws, 'mcp'],
    cwd: REPO,
    // run_cancel starts the worker (nothing left to run: it exits when idle).
    env: testChildEnv({ RETAKE_HOME: home, RETAKE_WORKER_IDLE_MS: '1500', RETAKE_DISK_WARN: 'off' }),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'retake-test', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  cleanup.unshift(() => client.close());
  const state: State = { queued };
  const out: Answers = [];
  const n = { paths: await pathsOf(ws, home), queued, jobs: new Map<string, string>() };
  for (const c of CALLS) {
    if (c.only === 'studio') continue;
    const args = typeof c.args === 'function' ? c.args(state) : c.args;
    const r = (await client.callTool({ name: c.op, arguments: args }, undefined, { timeout: 60_000 })) as {
      content: Array<{ type: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    if (c.op === 'project_get' && !r.isError && state.readmeHash === undefined) state.readmeHash = r.structuredContent?.readme_hash as string;
    // content[1] is the data's JSON (= structuredContent): kept once.
    out.push({ op: c.op, args: normalise(args, n), answer: normalise({ isError: r.isError ?? false, text: r.content[0]?.text, blocks: r.content.length, data: r.structuredContent }, n) });
  }
  // No job but the queued run's was ever queued (no sign-in through MCP: it would open a window).
  expect((await readdir(join(ws, '.retake', 'jobs'))).filter((f) => f.startsWith('j_'))).toHaveLength(1);
  // The worker run_cancel started finds nothing to run: its folder goes once it has exited (idle, 1.5 s).
  const engine = await createEngine({ root: ws, client: 'test', autoStartWorker: false });
  for (let i = 0; i < 100 && (await engine.jobs.worker()); i++) await new Promise((r) => setTimeout(r, 100));
  return out;
}

async function viaStudio(): Promise<Answers> {
  const { ws, home, queued } = await workspace('studio');
  cleanup.push(() => rm(ws, { recursive: true, force: true }));
  const retakeHome = scratchHome();
  retakeHome.use(home);
  cleanup.push(async () => {
    retakeHome.restore();
  });
  const studio: StudioServer = await startStudioServer({ root: ws, startWorker: false });
  cleanup.unshift(() => studio.close());
  const state: State = { queued };
  const out: Answers = [];
  const n = { paths: await pathsOf(ws, home), queued, jobs: new Map<string, string>() };
  for (const c of CALLS) {
    if (c.only === 'mcp') continue;
    const args = typeof c.args === 'function' ? c.args(state) : c.args;
    const r = await raw(studio.port, 'POST', `/v1/call/${c.op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
    const body = r.json<{ ok: boolean; data?: Record<string, unknown> }>();
    if (c.op === 'project_get' && body.ok && state.readmeHash === undefined) state.readmeHash = body.data?.readme_hash as string;
    out.push({ op: c.op, args: normalise(args, n), answer: normalise({ status: r.status, body }, n) });
  }
  return out;
}

beforeAll(async () => {
  mcpAnswers = await viaMcp();
  studioAnswers = await viaStudio();
}, 240_000);

afterAll(async () => {
  for (const f of cleanup) await f().catch(() => undefined);
});

describe('the eleven shared operations through both shells (characterization)', () => {
  it('answer as fixtures/shared-ops.json says, through MCP stdio and the Studio', () => {
    const text = `${JSON.stringify({ mcp: mcpAnswers, studio: studioAnswers }, null, 1)}\n`;
    if (process.env.RETAKE_WRITE_SNAPSHOTS === '1') writeFileSync(FILE, text);
    expect(text).toBe(readFileSync(FILE, 'utf8'));
    expect(mcpAnswers.map((a) => a.op)).toEqual(CALLS.filter((c) => c.only !== 'studio').map((c) => c.op));
    expect(studioAnswers.map((a) => a.op)).toEqual(CALLS.filter((c) => c.only !== 'mcp').map((c) => c.op));
    // Every op of the eleven is called through both shells.
    const eleven = ['engine_info', 'project_list', 'project_get', 'project_update_readme', 'scenario_validate', 'run_list', 'run_status', 'run_cancel', 'job_list', 'auth_status', 'auth_login'];
    expect([...new Set(mcpAnswers.map((a) => a.op))].sort()).toEqual([...eleven].sort());
    expect([...new Set(studioAnswers.map((a) => a.op))].sort()).toEqual([...eleven].sort());
  });
});
