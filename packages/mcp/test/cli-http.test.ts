/**
 * `retake mcp --http` from the built entry point (`pnpm build` first; skipped without dist): `--print-config --http`
 * prints the HTTP registration (the URL; the stable token of the Retake home, 0600, only by reference — its file in
 * the `claude mcp add` line, $RETAKE_MCP_TOKEN in the .mcp.json block — never the token itself); `--http --port 0
 * --json` prints one JSON line, nothing on stderr, serves the 45 tools to the SDK's Streamable HTTP client holding that
 * token, and stops on SIGTERM (exit 0); the HTTP flags without --http are a usage error. SEC-18: --print-config --http
 * says stdio is the safe default; a fixed port held by a listener that is not a Retake MCP server is refused with the
 * rotate-token advice, one held by this account's own `retake mcp --http` keeps the port-busy answer.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { REPO, fixtureWorkspace } from '../../engine/test/helpers.js';

const BIN = join(REPO, 'packages', 'cli', 'dist', 'bin.js');
const built = existsSync(BIN) && existsSync(join(REPO, 'packages', 'mcp', 'dist', 'http.js'));

let base: string;
let ws: string;
let home: string;
const children: ChildProcess[] = [];

function retake(args: string[]): { child: ChildProcess; line: Promise<string>; exit: Promise<{ code: number | null; out: string; err: string }> } {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: base, env: { ...process.env, RETAKE_HOME: home, RETAKE_ROOT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  let err = '';
  let gotLine: (l: string) => void = () => undefined;
  const line = new Promise<string>((r) => (gotLine = r));
  child.stdout!.on('data', (c: Buffer) => {
    out += c.toString('utf8');
    if (out.includes('\n')) gotLine(out.split('\n')[0]);
  });
  child.stderr!.on('data', (c: Buffer) => (err += c.toString('utf8')));
  const exit = new Promise<{ code: number | null; out: string; err: string }>((r) => child.on('exit', (code) => r({ code, out, err })));
  return { child, line, exit };
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'studio-mcp-http-cli-'));
  ws = join(base, 'ws');
  home = join(base, 'home');
  await mkdir(ws, { recursive: true });
  await fixtureWorkspace(ws);
});

afterAll(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  if (base) await rm(base, { recursive: true, force: true });
});

describe.skipIf(!built)('retake mcp --http (built CLI)', () => {
  it('--print-config --http: the URL and the token by reference only (its 0600 file, $RETAKE_MCP_TOKEN) — never the token, before or after --rotate-token', async () => {
    const first = await retake(['--root', ws, 'mcp', '--print-config', '--http', '--port', '47999']).exit;
    expect(first.code, first.err).toBe(0);
    const file = join(home, 'mcp-http.token');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const token = (await readFile(file, 'utf8')).trim();
    // Review A M1: neither the .mcp.json block (often committed) nor the command line (shell history) carries it.
    expect(first.out).not.toContain(token);
    expect(first.err).not.toContain(token);
    const json = JSON.parse(first.out.slice(0, first.out.indexOf('\n}\n') + 2)) as { mcpServers: Record<string, unknown> };
    expect(json).toEqual({ mcpServers: { 'retake': { type: 'http', url: 'http://127.0.0.1:47999/mcp', headers: { Authorization: 'Bearer ${RETAKE_MCP_TOKEN}' } } } });
    // The JSON on stdout (to pipe), the lines for a person on stderr — as the stdio registration.
    expect(first.err).toContain(`claude mcp add --transport http retake http://127.0.0.1:47999/mcp --scope user --header "Authorization: Bearer $(cat ${file})"`);
    expect(first.err).toContain(`export RETAKE_MCP_TOKEN="$(cat ${file})"`);
    expect(first.err).toContain(`retake --root ${ws} mcp --http --port 47999`);
    // SEC-18: stdio is the safe default, and what HTTP leaves open on a shared Mac.
    expect(first.err).toContain('stdio (retake mcp --print-config, without --http) is the safe default');
    expect(first.err).toContain("another account's program can listen on port 47999 and receive the token your client sends");
    expect(first.err).toContain('the client does not check the server it reaches');
    const again = await retake(['--root', ws, 'mcp', '--print-config', '--http', '--port', '47999']).exit;
    expect(`${again.out}${again.err}`).not.toContain(token);
    expect(again.err).not.toContain('register the server again');
    const rotated = await retake(['--root', ws, 'mcp', '--print-config', '--http', '--rotate-token']).exit;
    expect(rotated.code).toBe(0);
    const fresh = (await readFile(file, 'utf8')).trim();
    expect(fresh).not.toBe(token);
    expect(rotated.out).toContain('http://127.0.0.1:47820/mcp');
    expect(`${rotated.out}${rotated.err}`).not.toContain(fresh);
    expect(rotated.err).toContain('register the server again');
  });

  it('--http --port 0 --json: one JSON line, nothing on stderr; the 45 tools over HTTP with the token; SIGTERM → exit 0', async () => {
    const s = retake(['--root', ws, 'mcp', '--http', '--port', '0', '--json']);
    const line = JSON.parse(await s.line) as { type: string; url: string; port: number; pid: number };
    expect(line).toMatchObject({ type: 'mcp-http', url: `http://127.0.0.1:${line.port}/mcp`, pid: s.child.pid });
    const token = (await readFile(join(home, 'mcp-http.token'), 'utf8')).trim();
    const client = new Client({ name: 'retake-test', version: '0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(line.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(45);
    const r = (await client.callTool({ name: 'project_list', arguments: {} })) as { structuredContent: { projects: Array<{ slug: string }> } };
    expect(r.structuredContent.projects.map((p) => p.slug)).toEqual(['northfield-fixture']);
    await transport.terminateSession();
    await client.close();
    const wrong = await fetch(line.url, { method: 'POST', headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' }, body: '{}' });
    expect(wrong.status).toBe(401);
    s.child.kill('SIGTERM');
    const end = await s.exit;
    expect(end.code).toBe(0);
    expect(end.err).toBe('');
    expect(end.out.trim().split('\n')).toHaveLength(1);
  });

  it('SEC-18: the port held by a program that is not a Retake MCP server → refused (exit 1), stop it and rotate the token', async () => {
    const holder = spawn(process.execPath, ['-e', "require('net').createServer().listen({port: 4975, host: '127.0.0.1', exclusive: true}, () => console.log('up'))"], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(holder);
    await new Promise<void>((r) => holder.stdout!.once('data', () => r()));
    try {
      const r = await retake(['--root', ws, 'mcp', '--http', '--port', '4975']).exit;
      expect(r.code, r.err).toBe(1);
      expect(r.out).toBe('');
      expect(r.err).toContain('127.0.0.1:4975 is taken and not by a Retake MCP server of this account');
      expect(r.err).toContain(process.platform === 'darwin' ? `not a Retake MCP server (pid ${holder.pid})` : 'not by a Retake MCP server');
      expect(r.err).toContain('fix: stop that program');
      expect(r.err).toContain('retake mcp --http --rotate-token: an MCP client may already have sent the token to it');
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it.skipIf(process.platform !== 'darwin')("SEC-18: the port held by this account's own retake mcp --http → the port-busy answer, no token advice", async () => {
    const first = retake(['--root', ws, 'mcp', '--http', '--port', '4976', '--json']);
    expect(JSON.parse(await first.line)).toMatchObject({ port: 4976, pid: first.child.pid });
    try {
      const r = await retake(['--root', ws, 'mcp', '--http', '--port', '4976']).exit;
      expect(r.code, r.err).toBe(1);
      expect(r.err).toContain('cannot listen on 127.0.0.1:4976: EADDRINUSE');
      expect(r.err).toContain('fix: pass another --port, or leave it out for a free one');
      expect(r.err).not.toContain('rotate-token');
    } finally {
      first.child.kill('SIGTERM');
      expect((await first.exit).code).toBe(0);
    }
  });

  it('the HTTP flags without --http: usage error (exit 2)', async () => {
    const r = await retake(['--root', ws, 'mcp', '--port', '1']).exit;
    expect(r.code).toBe(2);
    expect(r.err).toContain('go with --http');
  });
});
