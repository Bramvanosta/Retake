/**
 * Hotfix v0.2.5 (field point 21) — a reset puts back what a database snapshot does not cover: a Firebase Auth emulator's
 * accounts (`reset.firebase_auth`: emptied before the seed, saved after it, emptied and imported at every reset — after
 * `restart`, which empties a restarted emulator), then `reset.hooks` run. The service here is a stand-in of the Auth
 * emulator with the three routes the sandbox uses, as firebase-tools serves them (DELETE
 * /emulator/v1/projects/<p>/accounts, GET …/accounts:batchGet?maxResults=-1, POST …/accounts:batchCreate), all with
 * `Bearer owner`, and two test routes: add an account (the seed, a take) and count the reset hook's calls.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProject, parseSandboxYaml } from '@retake/core';
import { openSandbox, probePort } from '@retake/sandbox';

const EMULATOR = `
const http = require('node:http');
const port = Number(process.argv[2]);
let users = [];
let hooks = 0;
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/health') return json({ ok: true });
    if (u.pathname === '/test/add') { users.push({ localId: 'u' + users.length + '-' + Math.random().toString(36).slice(2, 6), email: u.searchParams.get('email'), passwordHash: 'fakeHash:salt=s:password=p', salt: 's' }); return json({ n: users.length }); }
    if (u.pathname === '/test/state') return json({ emails: users.map((x) => x.email).sort(), hooks });
    if (u.pathname === '/test/hook') { hooks++; return json({ hooks }); }
    if (req.headers.authorization !== 'Bearer owner') return json({ error: { message: 'not owner' } }, 401);
    if (req.method === 'DELETE' && u.pathname === '/emulator/v1/projects/demo-shop/accounts') { users = []; return json({}); }
    if (req.method === 'GET' && u.pathname === '/identitytoolkit.googleapis.com/v1/projects/demo-shop/accounts:batchGet' && u.searchParams.get('maxResults') === '-1') return json({ kind: 'identitytoolkit#DownloadAccountResponse', users });
    if (req.method === 'POST' && u.pathname === '/identitytoolkit.googleapis.com/v1/projects/demo-shop/accounts:batchCreate') {
      const b = JSON.parse(body);
      if (!b.users || !b.users.length) return json({ error: { message: 'MISSING_USER_ACCOUNT' } }, 400);
      for (const x of b.users) if (users.some((y) => y.localId === x.localId)) return json({ error: { message: 'DUPLICATE_LOCAL_ID' } }, 400);
      users.push(...b.users);
      return json({});
    }
    json({ error: { message: 'no route ' + req.method + ' ' + u.pathname } }, 404);
  });
}).listen(port, '127.0.0.1');
`;

let root: string;
let port: number;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-reset-extras-'));
  do {
    port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
  } while (await probePort(port));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const manifest = (p: number) =>
  [
    'version: 1',
    'provider: process',
    'services:',
    '  auth:',
    `    command: [node, emulator.cjs, "${p}"]`,
    `    url: http://127.0.0.1:${p}`,
    '    health: /health',
    `    pages: {app: "http://127.0.0.1:${p}"}`,
    'seed:',
    '  - http: {method: POST, url: "{{app}}/test/add?email=owner@example.com"}',
    'reset:',
    '  restart: [auth]',
    `  firebase_auth: {url: "http://127.0.0.1:${p}", project: demo-shop}`,
    '  hooks:',
    '    - name: count',
    '      http: {method: POST, url: "{{app}}/test/hook"}',
    '',
  ].join('\n');

async function state(): Promise<{ emails: string[]; hooks: number }> {
  return (await fetch(`http://127.0.0.1:${port}/test/state`)).json() as Promise<{ emails: string[]; hooks: number }>;
}

describe('a reset puts back a Firebase Auth emulator and runs reset.hooks (hotfix v0.2.5)', () => {
  it('validates: reset.hooks are checked as seed steps; the emulator is on this machine', () => {
    const bad = parseSandboxYaml(manifest(port).replace('http: {method: POST, url: "{{app}}/test/hook"}', 'exec: {service: auth, command: "true"}').replace(`firebase_auth: {url: "http://127.0.0.1:${port}"`, 'firebase_auth: {url: "https://auth.example.test"'), undefined, { env: "sandbox" });
    const msgs = bad.issues.filter((i) => i.severity === 'error').map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(msgs).toEqual(expect.arrayContaining([expect.stringMatching(/^reset\.hooks\.0\.exec: `exec` runs a command inside a compose service/), expect.stringMatching(/^reset\.firebase_auth\.url: the Firebase Auth emulator auth\.example\.test is not on this machine/)]));
  });

  it('the seed starts on an empty emulator; a take\'s account is gone after the reset, the seeded one is back after the restart; the hooks ran', async () => {
    const dir = join(root, 'p');
    await mkdir(join(dir, 'sandbox'), { recursive: true });
    await writeFile(join(dir, 'project.yaml'), ['name: Reset extras', 'environments:', '  local: {app: "http://localhost:9"}', 'sandboxes:', '  sandbox: sandbox/sandbox.yaml', ''].join('\n'));
    await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), manifest(port));
    await writeFile(join(dir, 'sandbox', 'emulator.cjs'), EMULATOR);
    const sb = openSandbox(await loadProject(dir), 'sandbox');
    try {
      const up = await sb.up();
      expect(up.reset).toMatchObject({ seed: { steps: 1 }, firebase_auth: { accounts: 1 }, hooks: { steps: 1 } });
      expect(await state()).toEqual({ emails: ['owner@example.com'], hooks: 1 });
      // A take creates an account.
      await fetch(`http://127.0.0.1:${port}/test/add?email=take@example.com`, { method: 'POST' });
      expect((await state()).emails).toEqual(['owner@example.com', 'take@example.com']);
      // The reset (strategy reseed): emptied before the seed, the seed's account saved, the restart, put back, the hook.
      const r = await sb.reset();
      expect(r).toMatchObject({ restarted: ['auth'], firebase_auth: { accounts: 1 }, hooks: { steps: 1 } });
      expect((await state()).emails).toEqual(['owner@example.com']);
      expect((await state()).hooks).toBe(1); // the restarted service counts from 0: the hook ran after the restart
    } finally {
      await sb.down();
    }
  }, 120_000);
});
