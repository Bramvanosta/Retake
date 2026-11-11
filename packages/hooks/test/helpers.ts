import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_CAPTURE, PERSON_POLICY } from '@retake/core';
import type { LoadedProject, ProjectConfig } from '@retake/core';
import type { HookContext, HookLogLevel } from '@retake/hooks';

export async function tempProject(prefix = 'retake-hooks-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
}

/** The fictional Northfield project (a staging environment plus a local one). */
export function makeProject(dir: string, local: Record<string, string> = {}, extra: Partial<ProjectConfig> = {}): LoadedProject {
  return {
    slug: 'northfield',
    dir,
    root: dirname(dir),
    file: join(dir, 'project.yaml'),
    readme: null,
    scenarios: [],
    config: {
      name: 'Northfield',
      environments: {
        local,
        staging: { console: 'https://console.staging.example.com', shop: 'https://shop.staging.example.com' },
      },
      capture: { ...DEFAULT_CAPTURE },
      frame: 'card',
      template: 'default',
      ...extra,
    },
  };
}

export interface LogLine {
  level: HookLogLevel;
  msg: string;
}

export function makeContext(
  project: LoadedProject,
  over: Partial<HookContext> = {},
): { ctx: HookContext; logs: LogLine[]; logText: () => string } {
  const logs: LogLine[] = [];
  const ctx: HookContext = {
    project,
    policy: PERSON_POLICY,
    env: { name: 'local', pages: { ...project.config.environments.local } },
    vars: {},
    log: (level, msg) => logs.push({ level, msg }),
    saved: {},
    ...over,
  };
  return { ctx, logs, logText: () => logs.map((l) => `${l.level} ${l.msg}`).join('\n') };
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/**
 * A tiny local "Northfield console" API: replies (create / delete / list), arbitrary statuses,
 * redirects. Records every request.
 */
export async function startApi(): Promise<{
  base: string;
  requests: RecordedRequest[];
  replies: Map<number, { id: number; text: string }>;
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const replies = new Map<number, { id: number; text: string }>();
  let nextId = 41;
  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, body === undefined ? headers : { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const url = new URL(req.url ?? '/', 'http://localhost');
      const replyId = /^\/api\/replies\/(\d+)$/.exec(url.pathname);
      if (req.method === 'POST' && url.pathname === '/api/replies') {
        const input = JSON.parse(body || '{}') as { text?: string };
        const reply = { id: ++nextId, text: input.text ?? '' };
        replies.set(reply.id, reply);
        return send(res, 201, reply);
      }
      if (req.method === 'GET' && url.pathname === '/api/replies') return send(res, 200, [...replies.values()]);
      if (req.method === 'DELETE' && replyId) {
        return replies.delete(Number(replyId[1])) ? send(res, 204) : send(res, 404, { error: 'no such reply' });
      }
      const status = /^\/status\/(\d{3})$/.exec(url.pathname);
      if (status) return send(res, Number(status[1]), { status: Number(status[1]) });
      if (url.pathname === '/redirect') return send(res, 302, undefined, { location: url.searchParams.get('to') ?? '/' });
      if (url.pathname === '/text') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('plain text');
      }
      return send(res, 404, { error: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    replies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A local port nothing listens on. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
