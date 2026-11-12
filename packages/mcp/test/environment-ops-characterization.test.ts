/**
 * The hooks, environment-reset and sandbox operations (MCP: hooks_run, env_reset, sandbox_status, sandbox_up,
 * sandbox_reset), characterized through `retake mcp` over stdio (from the sources, the SDK's client) before they became
 * the engine's operations (L7.19). One temp workspace: a small project whose hooks are harmless shell `echo`s (a scenario's
 * setup with a rollback and its teardown, a hooks file declared `writes: false`, the project's reset hooks) and a process
 * sandbox (a node service answering /health, a shell seed step, a shell reset hook). The calls go through four clients in
 * turn: one without elicitation (needs_approval with the command a human runs), one that declines, one that never
 * answers (refused after 1.5 s), one that accepts — each question asked (its message and form) is recorded beside the
 * answer, and so are the marker files the hooks wrote. Dry runs, a production refusal before anyone is asked, the
 * argument and lookup refusals, a real run with its journal, env_reset replaying it, a sandbox up / reset with its seed
 * and reset-hook approvals are in it.
 *
 * Normalised: the workspace, home and repository paths, ISO stamps, journal stamps, job ids, the service's port, pids, durations (`ms`),
 * the host name (a whole word only), Node's and Retake's versions, the approvals' signatures (keyed by the home's secret: their shape). The approvals' fingerprints and the seed's hash are
 * kept as values (they hold no path, port or stamp). Held against fixtures/environment-ops.json, recorded on the commit
 * before the move (RETAKE_WRITE_SNAPSHOTS=1 on this file records it again: review the diff); the test also holds that
 * the fixture names nothing of this machine.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RETAKE_VERSION } from '@retake/core';
import { readWorkerLock } from '@retake/engine';
import { REPO } from '@retake/test-support/repo';
import { testChildEnv } from '@retake/test-support/child-env';

const FILE = fileURLToPath(new URL('./fixtures/environment-ops.json', import.meta.url));
const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const SOURCE_ARGS = ['--conditions=source', '--import', 'tsx', BIN];
const P = 's';
const posix = process.platform !== 'win32';

type Answer = 'none' | 'decline' | 'never' | 'accept';
interface Call {
  client: Answer;
  op: string;
  args: Record<string, unknown>;
}

/** The calls, in order (each client's calls together, the accepting client's last: it changes the workspace). */
const CALLS: Call[] = [
  // No elicitation.
  { client: 'none', op: 'hooks_run', args: { project: P, source: 'demo:setup' } },
  { client: 'none', op: 'hooks_run', args: { project: P, source: 'demo:teardown', wait_s: 25 } },
  { client: 'none', op: 'hooks_run', args: { project: P, source: 'reset', dry: true, wait_s: 25 } },
  { client: 'none', op: 'hooks_run', args: { project: P, source: 'hooks/post.yaml', env: 'production', wait_s: 25 } },
  { client: 'none', op: 'hooks_run', args: { project: P, source: 'demo:setup', dry: false } },
  { client: 'none', op: 'hooks_run', args: { project: P, source: 'hooks/post.yaml', dry: false } },
  { client: 'none', op: 'hooks_run', args: { project: P, source: 'hooks/post.yaml', env: 'production', dry: false } },
  { client: 'none', op: 'hooks_run', args: { project: P, source: '../x.yaml' } },
  { client: 'none', op: 'hooks_run', args: { project: P, source: 'hooks/none.yaml' } },
  { client: 'none', op: 'hooks_run', args: { project: P, source: 'nope:setup' } },
  { client: 'none', op: 'hooks_run', args: { project: P, source: 'broken:setup' } },
  { client: 'none', op: 'hooks_run', args: { project: P, source: 'redirect:setup', wait_s: 25 } },
  { client: 'none', op: 'hooks_run', args: { project: 'no-such-project', source: 'reset' } },
  { client: 'none', op: 'hooks_run', args: { project: P, source: 'reset', env: 'nowhere' } },
  { client: 'none', op: 'hooks_run', args: { project: P, source: 'reset', wait_s: 9999 } },
  { client: 'none', op: 'hooks_run', args: { project: P, source: 'reset', extra: 1 } },
  { client: 'none', op: 'env_reset', args: { project: P, wait_s: 25 } },
  { client: 'none', op: 'env_reset', args: { project: P, dry: false } },
  { client: 'none', op: 'env_reset', args: { project: P, env: 'production', wait_s: 25 } },
  { client: 'none', op: 'env_reset', args: { project: P, env: 'sandbox', wait_s: 25 } },
  { client: 'none', op: 'env_reset', args: { project: 'no-such-project' } },
  { client: 'none', op: 'env_reset', args: { project: P, env: 'nowhere' } },
  { client: 'none', op: 'sandbox_status', args: { project: P } },
  { client: 'none', op: 'sandbox_status', args: { project: P, env: 'local' } },
  { client: 'none', op: 'sandbox_status', args: { project: P, env: 'nowhere' } },
  { client: 'none', op: 'sandbox_status', args: { project: 'no-such-project' } },
  { client: 'none', op: 'sandbox_up', args: { project: P } },
  { client: 'none', op: 'sandbox_up', args: { project: P, env: 'local' } },
  { client: 'none', op: 'sandbox_reset', args: { project: P } },
  { client: 'none', op: 'sandbox_reset', args: { project: P, reseed: 'yes' } },
  // Declines.
  { client: 'decline', op: 'hooks_run', args: { project: P, source: 'demo:setup', dry: false } },
  { client: 'decline', op: 'env_reset', args: { project: P, dry: false } },
  { client: 'decline', op: 'sandbox_up', args: { project: P } },
  { client: 'decline', op: 'hooks_run', args: { project: P, source: 'hooks/post.yaml', env: 'production', dry: false } },
  // Never answers.
  { client: 'never', op: 'hooks_run', args: { project: P, source: 'demo:setup', dry: false } },
  { client: 'never', op: 'sandbox_reset', args: { project: P } },
  // Accepts.
  { client: 'accept', op: 'hooks_run', args: { project: P, source: 'demo:setup', wait_s: 25 } },
  { client: 'accept', op: 'hooks_run', args: { project: P, source: 'demo:setup', dry: false, wait_s: 25 } },
  { client: 'accept', op: 'env_reset', args: { project: P, wait_s: 25 } },
  { client: 'accept', op: 'hooks_run', args: { project: P, source: 'redirect:setup', dry: false } },
  { client: 'accept', op: 'hooks_run', args: { project: P, source: 'demo:teardown', dry: false, wait_s: 25 } },
  { client: 'accept', op: 'hooks_run', args: { project: P, source: 'hooks/post.yaml', dry: false, wait_s: 25 } },
  { client: 'accept', op: 'env_reset', args: { project: P, dry: false, wait_s: 25 } },
  { client: 'accept', op: 'env_reset', args: { project: P, wait_s: 25 } },
  { client: 'accept', op: 'hooks_run', args: { project: P, source: 'reset', dry: false, wait_s: 25 } },
  { client: 'accept', op: 'sandbox_up', args: { project: P, wait_s: 25 } },
  { client: 'accept', op: 'sandbox_status', args: { project: P } },
  { client: 'accept', op: 'sandbox_up', args: { project: P, wait_s: 25 } },
  { client: 'accept', op: 'sandbox_reset', args: { project: P, wait_s: 25 } },
  { client: 'accept', op: 'sandbox_reset', args: { project: P, reseed: true, wait_s: 25 } },
  { client: 'accept', op: 'sandbox_status', args: { project: P, env: 'sandbox' } },
];

/** The markers the hooks write, read after each call: proof of what ran. */
const MARKERS = ['setup-marker.txt', 'drop-marker.txt', 'loud-marker.txt', 'teardown-marker.txt', 'post-marker.txt', 'reset-marker.txt', 'sandbox/seed-marker.txt', 'sandbox/reset-marker.txt'];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

const SERVICE = `import { createServer } from 'node:http';
createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('ok'); }).listen(Number(process.argv[2]), '127.0.0.1');
`;

/** The workspace: project `s` with shell echo hooks everywhere, and a process sandbox. */
async function workspace(ports: { env: number; sandbox: number }): Promise<{ ws: string; home: string; dir: string }> {
  const port = ports.env;
  const ws = await mkdtemp(join(tmpdir(), 'retake-environment-ops-'));
  const home = join(ws, '.home');
  await writeFile(join(ws, 'retake.yaml'), `version: 1\nprojects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
  const dir = join(ws, 'projects', P);
  await mkdir(join(dir, 'sandbox'), { recursive: true });
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await mkdir(join(dir, 'hooks'), { recursive: true });
  await writeFile(
    join(dir, 'project.yaml'),
    [
      'version: 1',
      'name: S',
      'environments:',
      `  local: {app: "http://localhost:${port}"}`,
      '  production:',
      '    production: true',
      '    pages:',
      `      app: {url: "http://localhost:${port}"}`,
      'sandboxes:',
      '  sandbox: sandbox/sandbox.yaml',
      'default_env: local',
      'template: default',
      'reset:',
      '  - name: wipe',
      '    shell: {run: "echo reset >> reset-marker.txt"}',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(dir, 'scenarios', 'demo.yaml'),
    [
      'version: 1',
      'video: demo',
      'title: {text: Demo}',
      'setup:',
      '  - name: prepare',
      '    shell: {run: "touch setup-marker.txt", rollback: "rm setup-marker.txt"}',
      '  - name: drop',
      '    shell: "touch drop-marker.txt"',
      '    destructive: true',
      '    confirm: true',
      '    optional: true',
      'teardown:',
      '  - name: tidy',
      '    shell: "touch teardown-marker.txt"',
      'scenes:',
      '  - id: one',
      '    page: app',
      '    open: /',
      '    steps:',
      '      - hold: 1',
      '',
    ].join('\n'),
  );
  // A scenario file is agent-writable: its shell hook must be plain words (no redirection).
  await writeFile(
    join(dir, 'scenarios', 'redirect.yaml'),
    'version: 1\nvideo: redirect\ntitle: {text: Redirect}\nsetup:\n  - name: loud\n    shell: "echo loud >> loud-marker.txt"\nscenes:\n  - id: one\n    page: app\n    open: /\n    steps:\n      - hold: 1\n',
  );
  // A scenario that does not load: a destructive hook without "confirm: true".
  await writeFile(
    join(dir, 'scenarios', 'broken.yaml'),
    'version: 1\nvideo: broken\ntitle: {text: Broken}\nsetup:\n  - name: drop\n    shell: "echo drop"\n    destructive: true\nscenes:\n  - id: one\n    page: app\n    open: /\n    steps:\n      - hold: 1\n',
  );
  await writeFile(join(dir, 'hooks', 'post.yaml'), '- name: post\n  shell: {run: "echo post >> post-marker.txt"}\n  writes: false\n');
  await writeFile(join(dir, 'sandbox', 'service.mjs'), SERVICE);
  await writeFile(
    join(dir, 'sandbox', 'sandbox.yaml'),
    [
      'version: 1',
      'provider: process',
      'services:',
      '  app:',
      `    command: [node, service.mjs, "${ports.sandbox}"]`,
      `    url: http://localhost:${ports.sandbox}`,
      '    health: /health',
      '    stop_timeout_s: 3',
      '    pages:',
      `      app: {url: "http://localhost:${ports.sandbox}", display: app.example}`,
      'seed:',
      '  - name: ping',
      '    http: {url: "{{app}}/health"}',
      '  - name: mark',
      '    shell: {run: "echo seeded >> seed-marker.txt"}',
      'reset:',
      '  hooks:',
      '    - name: health',
      '      http: {url: "{{app}}/health"}',
      '    - name: clean',
      '      shell: {run: "echo reset >> reset-marker.txt"}',
      '',
    ].join('\n'),
  );
  return { ws, home, dir };
}

/** The answer with what changes between runs replaced (see the header). */
function normalise(v: unknown, o: { paths: Array<[string, string]>; ports: { env: number; sandbox: number }; ids: Map<string, string> }): unknown {
  const { ids } = o;
  const byOrder = (kind: string) => (id: string) => {
    const k = `${kind}:${id}`;
    if (!ids.has(k)) ids.set(k, `<${kind}-${[...ids.keys()].filter((x) => x.startsWith(`${kind}:`)).length + 1}>`);
    return ids.get(k)!;
  };
  const text = (s: string): string => {
    let t = s;
    for (const [from, to] of o.paths) t = t.split(from).join(to);
    t = t.replace(new RegExp(`(?<![\\w.-])${hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'), '<host>');
    t = t.split(RETAKE_VERSION).join('<version>');
    for (const [k, p] of Object.entries(o.ports)) t = t.replace(new RegExp(`(?<!\\d)${p}(?!\\d)`, 'g'), `<${k}-port>`);
    t = t.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<at>');
    t = t.replace(/\bj_[0-9A-HJKMNP-TV-Z]{26}\b/g, byOrder('job'));
    // A journal's id starts with its stamp (20261112-031536-hooks-demo-setup).
    t = t.replace(/\b\d{8}-\d{6}(?=-)/g, '<stamp>');
    t = t.replace(/\bpid \d+\b/g, 'pid <pid>');
    return t.replace(/\b\d+(?:\.\d+)? ?ms\b/g, '<ms>');
  };
  const walk = (x: unknown, key?: string): unknown => {
    if (typeof x === 'string' && key === 'node' && x === process.versions.node) return '<node>';
    if (typeof x === 'string' && key === 'host' && x === hostname()) return '<host>';
    // An approval's signature: keyed by this Retake home's secret and its stamp, so its shape only.
    if (typeof x === 'string' && key === 'sig') return /^[0-9a-f]{64}$/.test(x) ? '<sig: 64 hex>' : `<sig: ${x.length} characters>`;
    if (typeof x === 'string') return text(x);
    if (typeof x === 'number' && (key === 'pid' || key === 'ppid' || key === 'port')) return `<${key}>`;
    if (typeof x === 'number' && (key === 'ms' || (key ?? '').endsWith('_ms'))) return '<ms>';
    if (Array.isArray(x)) return x.map((y) => walk(y));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [text(k), walk(y, k)]));
    return x;
  };
  return walk(v);
}

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

type Answers = Array<{ client: Answer; op: string; args: unknown; answer: unknown; asked: unknown; markers: unknown }>;

let answers: Answers = [];
let ws = '';
const sessions: Client[] = [];
const protocolErrors: Error[] = [];

async function record(): Promise<Answers> {
  const ports = { env: await freePort(), sandbox: await freePort() };
  while (ports.sandbox === ports.env) ports.sandbox = await freePort();
  const w = await workspace(ports);
  ws = w.ws;
  const n = { paths: await pathsOf(w.ws, w.home), ports, ids: new Map<string, string>() };
  const clients = new Map<Answer, { client: Client; asked: Array<{ message: string; requestedSchema: unknown }> }>();
  const connect = async (answer: Answer) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...SOURCE_ARGS, '--root', w.ws, 'mcp'],
      cwd: REPO,
      env: testChildEnv({ RETAKE_HOME: w.home, RETAKE_WORKER_IDLE_MS: '1500', RETAKE_MCP_APPROVAL_TIMEOUT_MS: '1500', RETAKE_DISK_WARN: 'off' }),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'retake-test', version: '0' }, { capabilities: answer === 'none' ? {} : { elicitation: { form: {} } } });
    const asked: Array<{ message: string; requestedSchema: unknown }> = [];
    if (answer !== 'none') {
      client.setRequestHandler(ElicitRequestSchema, async (req) => {
        const p = req.params as { message: string; requestedSchema: unknown };
        asked.push({ message: p.message, requestedSchema: p.requestedSchema });
        if (answer === 'never') return new Promise(() => undefined);
        return answer === 'accept' ? { action: 'accept', content: { approve: true } } : { action: 'decline' };
      });
    }
    client.onerror = (e) => protocolErrors.push(e);
    await client.connect(transport);
    sessions.push(client);
    return { client, asked };
  };
  const markers = async () => {
    const out: Record<string, string> = {};
    for (const m of MARKERS) {
      const f = join(w.dir, m);
      if (existsSync(f)) out[m] = await readFile(f, 'utf8');
    }
    return out;
  };
  const out: Answers = [];
  for (const c of CALLS) {
    if (!clients.has(c.client)) clients.set(c.client, await connect(c.client));
    const { client, asked } = clients.get(c.client)!;
    const before = asked.length;
    const r = (await client.callTool({ name: c.op, arguments: c.args }, undefined, { timeout: 120_000 })) as {
      content: Array<{ type: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    out.push({
      client: c.client,
      op: c.op,
      args: normalise(c.args, n),
      answer: normalise({ isError: r.isError ?? false, text: r.content[0]?.text, blocks: r.content.map((b) => b.type), data: r.structuredContent }, n),
      asked: normalise(asked.slice(before), n),
      markers: await markers(),
    });
  }
  return out;
}

beforeAll(async () => {
  if (!posix) return;
  answers = await record();
}, 600_000);

afterAll(async () => {
  for (const c of sessions) await c.close().catch(() => undefined);
  if (!ws) return;
  // The sandbox's service, stopped as a person would (it outlives the MCP servers that started it).
  spawnSync(process.execPath, [...SOURCE_ARGS, '--root', ws, 'sandbox', 'down', P], { cwd: REPO, env: testChildEnv({ RETAKE_HOME: join(ws, '.home'), RETAKE_DISK_WARN: 'off' }), timeout: 60_000 });
  const w = readWorkerLock(ws);
  if (w) {
    try {
      process.kill(w.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  await rm(ws, { recursive: true, force: true });
});

describe.skipIf(!posix)('the hooks, environment-reset and sandbox operations through MCP stdio (characterization)', () => {
  it('answer as fixtures/environment-ops.json says: approvals answered, declined, never answered or not askable; dry runs; refusals', () => {
    const text = `${JSON.stringify({ mcp: answers }, null, 1)}\n`;
    if (process.env.RETAKE_WRITE_SNAPSHOTS === '1') writeFileSync(FILE, text);
    expect(text).toBe(readFileSync(FILE, 'utf8'));
    expect([...new Set(answers.map((a) => a.op))].sort()).toEqual(['env_reset', 'hooks_run', 'sandbox_reset', 'sandbox_status', 'sandbox_up']);
    expect(protocolErrors).toEqual([]);
  });

  it('the fixture names nothing of this machine: no host name, account, home, temp folder or repository path', () => {
    const text = readFileSync(FILE, 'utf8');
    const words = [hostname(), userInfo().username, homedir(), tmpdir(), REPO.replace(/\/$/, ''), process.versions.node].filter((w) => w.length >= 3);
    for (const w of words) expect(text.includes(w), `the fixture holds ${JSON.stringify(w)}`).toBe(false);
    expect(text).not.toMatch(/\/(?:Users|home|private|var\/folders)\//);
  });
});
