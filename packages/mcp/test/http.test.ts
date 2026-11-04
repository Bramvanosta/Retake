/**
 * L4.1 part 3: MCP over HTTP (R-MCP-02) — `startMcpHttpServer` on a scratch copy of the fixture project, driven by the
 * SDK's own Streamable HTTP client: the same tools as stdio (names, schemas, annotations, instructions), calls,
 * an approval form answered over the session (accepted: the worker runs the hook; declined: nothing queued), sessions
 * (initialize first, unknown id 404, DELETE, the cap — a session not in use makes room, one with its event stream open
 * neither expires nor is evicted); and the gate WITH the valid token and a valid initialize body:
 * any Origin or Sec-Fetch-* header refused (browsers), a foreign Host 421, no or wrong token 401, other routes 404,
 * OPTIONS 405, a non-JSON body 415, an oversized one 413. The stable token file: created once 0600, reused, rotated,
 * refused when not private.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpHttpTokenFile, readPrivateToken, readWorkerLock, stableToken } from '@retake/engine';
import { REPO, fixtureWorkspace } from '../../engine/test/helpers.js';
import { raw } from '../../ui/test/http.js';
import { MCP_HTTP_BODY_MAX, TOOLS, claudeCodeHttpCommand, mcpHttpConfigJson, mcpHttpTokenExport, startMcpHttpServer } from '../src/index.js';
import type { McpHttpServer } from '../src/index.js';

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

let ws: string;
let home: string;
let token: string;
let server: McpHttpServer;
const opened: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = [];
/** End every session the tests opened (DELETE), then close their clients. */
async function closeAll(): Promise<void> {
  for (const o of opened.splice(0)) {
    await o.transport.terminateSession().catch(() => undefined);
    await o.client.close().catch(() => undefined);
  }
}
/** End a session opened by a raw initialize. */
const endRaw = (id: unknown) => raw(server.port, 'DELETE', '/mcp', { authorization: `Bearer ${token}`, 'mcp-session-id': String(id) });
const saved = { home: process.env.RETAKE_HOME, idle: process.env.RETAKE_WORKER_IDLE_MS };
const P = 'northfield-fixture';

const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
const MCP_ACCEPT = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };

async function connect(answer?: 'accept' | 'decline'): Promise<{ client: Client; transport: StreamableHTTPClientTransport; asked: string[] }> {
  const client = new Client({ name: 'retake-test', version: '0' }, { capabilities: answer ? { elicitation: { form: {} } } : {} });
  const asked: string[] = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push((req.params as { message: string }).message);
      return answer === 'accept' ? { action: 'accept', content: { approve: true } } : { action: 'decline' };
    });
  }
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  opened.push({ client, transport });
  return { client, transport, asked };
}

const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })) as Result;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-mcp-http-'));
  home = join(ws, '.home');
  process.env.RETAKE_HOME = home;
  process.env.RETAKE_WORKER_IDLE_MS = '1500';
  await fixtureWorkspace(ws);
  await mkdir(join(ws, 'projects', P, 'hooks'), { recursive: true });
  await writeFile(join(ws, 'projects', P, 'hooks', 'ok.yaml'), '- name: ok\n  shell: {run: "true"}\n  writes: false\n');
  token = (await stableToken(mcpHttpTokenFile())).token;
  server = await startMcpHttpServer({ root: ws, port: 0, token, maxSessions: 3 });
});

afterAll(async () => {
  await closeAll();
  await server?.close();
  const w = ws ? readWorkerLock(ws) : null;
  if (w) {
    try {
      process.kill(w.pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  if (saved.home === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = saved.home;
  if (saved.idle === undefined) delete process.env.RETAKE_WORKER_IDLE_MS;
  else process.env.RETAKE_WORKER_IDLE_MS = saved.idle;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('MCP over HTTP: the same server as stdio', () => {
  it('lists exactly the tools stdio lists (names, schemas, annotations) with the same instructions', async () => {
    const { client } = await connect();
    const http = (await client.listTools()).tools;
    expect(http).toHaveLength(TOOLS.length);
    const stdio = new Client({ name: 'retake-test', version: '0' }, { capabilities: {} });
    await stdio.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--conditions=source', '--import', 'tsx', join(REPO, 'packages', 'cli', 'src', 'bin.ts'), '--root', ws, 'mcp'],
        cwd: REPO,
        env: { PATH: process.env.PATH ?? '', CFFIXED_USER_HOME: process.env.CFFIXED_USER_HOME ?? '', HOME: process.env.HOME ?? '', RETAKE_HOME: home },
        stderr: 'pipe',
      }),
    );
    try {
      expect(http).toEqual((await stdio.listTools()).tools);
      expect(client.getInstructions()).toBe(stdio.getInstructions());
    } finally {
      await stdio.close();
    }
    const info = await call(client, 'engine_info');
    expect(info.structuredContent).toMatchObject({ client: 'mcp', root: ws });
    const list = await call(client, 'project_list');
    expect((list.structuredContent as { projects: Array<{ slug: string }> }).projects.map((p) => p.slug)).toEqual([P]);
  });

  it('an approval form goes out on the session and its answer comes back: accepted → the worker runs the hook; declined → nothing queued', async () => {
    await closeAll();
    const yes = await connect('accept');
    const r = await call(yes.client, 'hooks_run', { project: P, source: 'hooks/ok.yaml', dry: false, wait_s: 25 });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    expect(yes.asked).toHaveLength(1);
    expect(yes.asked[0]).toContain('setup hook 1 "ok"');
    const job = r.structuredContent as { state: string; input: { approvals: Array<{ by: string }>; submitted_by: string }; result: { results: Array<{ name: string; status: string }> } };
    expect(job.input.approvals).toEqual([expect.objectContaining({ by: 'human-elicitation' })]);
    expect(job.input.submitted_by).toBe('mcp');
    expect(job.state).toBe('succeeded');
    expect(job.result.results.map((x) => [x.name, x.status])).toEqual([['ok', 'ok']]);
    const no = await connect('decline');
    const before = ((await call(no.client, 'job_list')).structuredContent as { jobs: unknown[] }).jobs.length;
    const d = await call(no.client, 'hooks_run', { project: P, source: 'hooks/ok.yaml', dry: false });
    expect(d.isError).toBe(true);
    expect((d.structuredContent as { error: { code: string; message: string } }).error).toMatchObject({ code: 'refused', message: expect.stringContaining('the user declined') });
    expect(no.asked).toHaveLength(1);
    expect(((await call(no.client, 'job_list')).structuredContent as { jobs: unknown[] }).jobs.length).toBe(before);
    // A client that declared no elicitation: needs_approval, as over stdio.
    const plain = await connect();
    const n = await call(plain.client, 'hooks_run', { project: P, source: 'hooks/ok.yaml', dry: false });
    expect((n.structuredContent as { error: { code: string } }).error.code).toBe('needs_approval');
  });

  it('sessions: initialize first, an unknown id 404, DELETE ends one, at most 3 here — all in use (event streams open): the 4th 503', async () => {
    await closeAll();
    const auth = { authorization: `Bearer ${token}`, ...MCP_ACCEPT };
    const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const first = await raw(server.port, 'POST', '/mcp', auth, list);
    expect(first.status).toBe(400);
    expect(first.body).toContain('send initialize first');
    expect((await raw(server.port, 'POST', '/mcp', { ...auth, 'mcp-session-id': '00000000-0000-4000-8000-000000000000' }, list)).status).toBe(404);
    const a = await connect();
    await connect();
    await connect();
    expect(server.sessions).toBe(3);
    const over = await raw(server.port, 'POST', '/mcp', auth, INIT);
    expect(over.status).toBe(503);
    await a.transport.terminateSession();
    expect(server.sessions).toBe(2);
    const more = await raw(server.port, 'POST', '/mcp', auth, INIT);
    expect(more.status).toBe(200);
    expect((await endRaw(more.headers['mcp-session-id'])).status).toBe(200);
    await closeAll();
    expect(server.sessions).toBe(0);
  });
});

describe('MCP over HTTP: abandoned sessions make room (review A L1 / B M2)', () => {
  it('at the cap, a new initialize closes the least recently seen session with no call running and no event stream', async () => {
    await closeAll();
    const auth = { authorization: `Bearer ${token}`, ...MCP_ACCEPT };
    const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const evicted = server.evicted;
    // Clients that went away without DELETE (Claude Code restarting): raw initializes, never closed.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await raw(server.port, 'POST', '/mcp', auth, INIT);
      expect(r.status).toBe(200);
      ids.push(String(r.headers['mcp-session-id']));
      await new Promise((x) => setTimeout(x, 5));
    }
    // The second one is used again: the first is now the least recently seen.
    expect((await raw(server.port, 'POST', '/mcp', { ...auth, 'mcp-session-id': ids[1], 'mcp-protocol-version': '2025-06-18' }, list)).status).toBe(200);
    const fourth = await raw(server.port, 'POST', '/mcp', auth, INIT);
    expect(fourth.status).toBe(200);
    expect(server.sessions).toBe(3);
    expect(server.evicted).toBe(evicted + 1);
    expect((await raw(server.port, 'POST', '/mcp', { ...auth, 'mcp-session-id': ids[0], 'mcp-protocol-version': '2025-06-18' }, list)).status).toBe(404);
    expect((await raw(server.port, 'POST', '/mcp', { ...auth, 'mcp-session-id': ids[1], 'mcp-protocol-version': '2025-06-18' }, list)).status).toBe(200);
    for (const id of [...ids.slice(1), String(fourth.headers['mcp-session-id'])]) await endRaw(id);
    expect(server.sessions).toBe(0);
  });

  it('nine SDK clients in a row that close without DELETE (cap 3): every one connects and lists the tools', async () => {
    const own = await startMcpHttpServer({ root: ws, port: 0, token, maxSessions: 3 });
    try {
      for (let i = 0; i < 9; i++) {
        const client = new Client({ name: 'restarting-client', version: '0' }, { capabilities: {} });
        const transport = new StreamableHTTPClientTransport(new URL(own.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
        await client.connect(transport);
        expect((await client.listTools()).tools).toHaveLength(TOOLS.length);
        await client.close(); // no terminateSession(): the process "exits"
      }
      expect(own.sessions).toBeLessThanOrEqual(3);
      expect(own.evicted).toBeGreaterThanOrEqual(6);
    } finally {
      await own.close();
    }
  });
});

/** A GET event stream of a session, held open until closed. */
function holdStream(port: number, sid: string): Promise<{ status: number; close(): void }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'GET', agent: false, setHost: false, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, accept: 'text/event-stream', 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' } },
      (res) => {
        res.on('data', () => undefined);
        res.on('error', () => undefined);
        resolve({ status: res.statusCode ?? 0, close: () => req.destroy() });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('MCP over HTTP: idle sessions', () => {
  it('a session whose event stream is open never expires; once the stream closes it does (review A L2)', async () => {
    const quick = await startMcpHttpServer({ root: ws, port: 0, token, idleMs: 300 });
    try {
      const auth = { authorization: `Bearer ${token}`, ...MCP_ACCEPT };
      const r = await raw(quick.port, 'POST', '/mcp', auth, INIT);
      const sid = String(r.headers['mcp-session-id']);
      const v = { ...auth, 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' };
      expect((await raw(quick.port, 'POST', '/mcp', v, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status).toBe(202);
      const s = await holdStream(quick.port, sid);
      expect(s.status).toBe(200);
      // Several sweeps (every second here) with no request: the open stream keeps the session.
      await new Promise((x) => setTimeout(x, 2500));
      expect(quick.sessions).toBe(1);
      expect((await raw(quick.port, 'POST', '/mcp', v, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))).status).toBe(200);
      s.close();
      const end = Date.now() + 5000;
      while (quick.sessions > 0 && Date.now() < end) await new Promise((x) => setTimeout(x, 100));
      expect(quick.sessions).toBe(0);
    } finally {
      await quick.close();
    }
  });

  it('a session with no request for idleMs (and no call running) is closed', async () => {
    const quick = await startMcpHttpServer({ root: ws, port: 0, token, idleMs: 300 });
    try {
      const r = await raw(quick.port, 'POST', '/mcp', { authorization: `Bearer ${token}`, ...MCP_ACCEPT }, INIT);
      expect(r.status).toBe(200);
      expect(quick.sessions).toBe(1);
      const end = Date.now() + 5000;
      while (quick.sessions > 0 && Date.now() < end) await new Promise((x) => setTimeout(x, 100));
      expect(quick.sessions).toBe(0);
      const gone = await raw(quick.port, 'POST', '/mcp', { authorization: `Bearer ${token}`, ...MCP_ACCEPT, 'mcp-session-id': String(r.headers['mcp-session-id']) }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
      expect(gone.status).toBe(404);
    } finally {
      await quick.close();
    }
  });
});

describe('MCP over HTTP: the gate, each check with the valid token and a valid initialize', () => {
  it('refuses every request a browser could send — any Origin (even its own), any Sec-Fetch-* header but the lone Sec-Fetch-Mode: cors of Node fetch', async () => {
    await closeAll();
    const auth = { authorization: `Bearer ${token}`, ...MCP_ACCEPT };
    const sessions = server.sessions;
    const browsers: Array<Record<string, string>> = [
      { origin: `http://127.0.0.1:${server.port}` },
      { origin: `http://localhost:${server.port}` },
      { origin: 'null' },
      { origin: 'https://example.com' },
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'none' },
      { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' },
      { 'sec-fetch-mode': 'no-cors' },
      { 'sec-fetch-mode': 'navigate' },
      { 'sec-fetch-dest': 'empty' },
      { 'sec-fetch-user': '?1' },
      { 'sec-fetch-storage-access': 'none' },
    ];
    for (const h of browsers) {
      const r = await raw(server.port, 'POST', '/mcp', { ...auth, ...h }, INIT);
      expect(r.status, JSON.stringify(h)).toBe(403);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('browser');
    }
    expect((await raw(server.port, 'GET', '/mcp', { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'sec-fetch-mode': 'navigate' })).status).toBe(403);
    expect(server.sessions).toBe(sessions);
    // What Node's fetch sends on every request (the SDK client, Claude Code): `Sec-Fetch-Mode: cors` alone — served.
    const node = await raw(server.port, 'POST', '/mcp', { ...auth, 'sec-fetch-mode': 'cors' }, INIT);
    expect(node.status).toBe(200);
    expect(server.sessions).toBe(sessions + 1);
    await endRaw(node.headers['mcp-session-id']);
  });

  it('Host 421, token 401, route 404, OPTIONS 405, content type 415, size 413 — and the same request passes once corrected', async () => {
    const auth = { authorization: `Bearer ${token}`, ...MCP_ACCEPT };
    const sessions = server.sessions;
    const cases: Array<[Record<string, string>, string, number]> = [
      [{ host: `rebind.test:${server.port}` }, '/mcp', 421],
      [{ host: `127.0.0.1:${server.port + 1}` }, '/mcp', 421],
      [{ authorization: '' }, '/mcp', 401],
      [{ authorization: `Bearer ${token.slice(0, -1)}x` }, '/mcp', 401],
      [{ authorization: `Basic ${token}` }, '/mcp', 401],
      [{}, '/', 404],
      [{}, '/v1/info', 404],
      [{}, '/mcp/../mcp', 404],
      [{ 'content-type': 'text/plain' }, '/mcp', 415],
      [{ 'content-type': 'application/x-www-form-urlencoded' }, '/mcp', 415],
    ];
    for (const [h, path, status] of cases) {
      const r = await raw(server.port, 'POST', path, { ...auth, ...h }, INIT);
      expect(r.status, `${JSON.stringify(h)} ${path}`).toBe(status);
      expect(Object.keys(r.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
    }
    expect((await raw(server.port, 'OPTIONS', '/mcp', { authorization: `Bearer ${token}`, 'access-control-request-method': 'POST' })).status).toBe(405);
    expect((await raw(server.port, 'PUT', '/mcp', auth, INIT)).status).toBe(405);
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { pad: 'x'.repeat(MCP_HTTP_BODY_MAX) } });
    expect((await raw(server.port, 'POST', '/mcp', auth, big)).status).toBe(413);
    expect((await raw(server.port, 'POST', '/mcp', auth, '{not json')).status).toBe(400);
    expect(server.sessions).toBe(sessions);
    // The control: the same initialize, corrected, opens a session.
    const ok = await raw(server.port, 'POST', '/mcp', auth, INIT);
    expect(ok.status).toBe(200);
    expect(ok.headers['mcp-session-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(server.sessions).toBe(sessions + 1);
    await endRaw(ok.headers['mcp-session-id']);
    expect(server.sessions).toBe(sessions);
  });
});

describe('the stable token (Retake home, 0600)', () => {
  it('created once (0600, atomic), the same at every start; --rotate-token replaces it; a non-private file is refused', async () => {
    const file = mcpHttpTokenFile();
    expect(file).toBe(join(home, 'mcp-http.token'));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stableToken(file)).token).toBe(token);
    expect(await readPrivateToken(file)).toBe(token);
    const r = await stableToken(file, { rotate: true });
    expect(r).toMatchObject({ rotated: true, created: false });
    expect(r.token).not.toBe(token);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file, 'utf8')).trim()).toBe(r.token);
    // Two starts at once: one token.
    const other = join(home, 'race', 'mcp-http.token');
    const [x, y] = await Promise.all([stableToken(other), stableToken(other)]);
    expect(x.token).toBe(y.token);
    expect([x.created, y.created].filter(Boolean)).toHaveLength(1);
    // Not private: refused, never repaired silently.
    await chmod(other, 0o644);
    await expect(stableToken(other)).rejects.toThrow(/permissions 644/);
    await expect(stableToken(other, { rotate: true })).rejects.toThrow(/permissions 644/);
    const link = join(home, 'link.token');
    await symlink(file, link);
    await expect(readPrivateToken(link)).rejects.toThrow(/not a regular file/);
    await chmod(other, 0o600);
    await writeFile(other, 'short\n');
    await expect(stableToken(other)).rejects.toThrow(/no valid token/);
    expect((await stableToken(other, { rotate: true })).rotated).toBe(true);
    // The registration printers: the URL and the bearer header by reference only (review A M1) — an environment
    // variable in the .mcp.json block, the token file read by the shell in the command.
    const url = 'http://127.0.0.1:47820/mcp';
    expect(mcpHttpConfigJson({ url })).toEqual({ mcpServers: { 'retake': { type: 'http', url, headers: { Authorization: 'Bearer ${RETAKE_MCP_TOKEN}' } } } });
    expect(claudeCodeHttpCommand({ url, tokenFile: '/home/x/.retake/mcp-http.token' })).toBe(
      'claude mcp add --transport http retake http://127.0.0.1:47820/mcp --scope user --header "Authorization: Bearer $(cat /home/x/.retake/mcp-http.token)"',
    );
    expect(claudeCodeHttpCommand({ url, tokenFile: "/a b/it's.token" })).toContain(`$(cat '/a b/it'\\''s.token')`);
    expect(mcpHttpTokenExport('/home/x/t')).toBe('export RETAKE_MCP_TOKEN="$(cat /home/x/t)"');
  });
});
