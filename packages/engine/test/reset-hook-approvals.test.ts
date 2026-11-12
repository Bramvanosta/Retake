/**
 * L7.8: a sandbox's shell `reset.hooks` steps are approval items, as its shell seed steps are (trust `mcp`: MCP and the
 * Studio's agent path). The sandbox checks a reset hook when it runs (sandbox seed.ts runSeed: phase `reset` in the
 * fingerprint, its position among the reset hooks, the sandbox's environment); the item is bound to exactly that, so
 * an approval of a reset hook is never a seed step's. An unapproved reset hook, or one changed since its approval, is
 * refused; an approved one runs; a person's own reset (no trust) runs it as before.
 *
 * A small process sandbox in a temp workspace (a node service answering /health); no worker, no browser.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import type { JobApproval } from '@retake/engine';
import { loadProject } from '@retake/core/io';
import { hookFingerprint } from '@retake/hooks';
import { openSandbox } from '@retake/sandbox';
import type { Sandbox } from '@retake/sandbox';
import { approvalChecker } from '../src/approvals.js';
import { createEngine, packageHookRunner, seedApprovalItems } from '../src/index.js';
import type { ApprovalItem, ApprovalRequest, Engine } from '../src/index.js';
import { REPO } from './helpers.js';

const posix = process.platform !== 'win32';

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

/** A tiny service: /health → 200 (any method); GET /deletes → how many DELETE requests it was sent. */
const SERVICE = `import { createServer } from 'node:http';
let deletes = 0;
createServer((req, res) => {
  if (req.method === 'DELETE') deletes++;
  if (req.url === '/deletes') { res.writeHead(200); res.end(String(deletes)); return; }
  res.writeHead(req.url === '/health' ? 200 : 404); res.end('ok');
}).listen(Number(process.argv[2]), '127.0.0.1');
`;

let ws: string;
let dir: string;
let port: number;
let engine: Engine;
let sb: Sandbox | undefined;
const savedHome = process.env.RETAKE_HOME;

const manifest = (resetRun: string) =>
  [
    'version: 1',
    'provider: process',
    'services:',
    '  app:',
    `    command: [node, service.mjs, "${port}"]`,
    `    url: http://localhost:${port}`,
    '    health: /health',
    '    stop_timeout_s: 3',
    '    pages:',
    `      app: {url: "http://localhost:${port}", display: app.example}`,
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
    `      shell: {run: "${resetRun}"}`,
    '',
  ].join('\n');
const RESET = 'echo reset >> reset-marker.txt';

const marker = async (name: string) => {
  const f = join(dir, 'sandbox', name);
  return existsSync(f) ? (await readFile(f, 'utf8')).trim().split('\n').length : 0;
};
const project = (): Promise<LoadedProject> => loadProject('s', ws);
const approvalsOf = (items: readonly ApprovalItem[]): JobApproval[] => items.map((i) => ({ fingerprint: i.fingerprint, by: 'human-elicitation', at: '2026-11-11T10:00:00.000Z' }) as JobApproval);
/** A reset under trust `mcp` with `approvals`, as a sandbox job runs it (sandbox-job.ts executeSandboxJob). */
async function agentReset(approvals: readonly JobApproval[]): Promise<string> {
  sb = openSandbox(await project(), 'sandbox', PERSON_POLICY);
  try {
    await sb.reset({ reseed: true, seedTrust: { trust: 'mcp', confirm: approvalChecker(approvals) } });
    return 'ran';
  } catch (e) {
    return `refused: ${(e as Error).message}`;
  }
}

describe.skipIf(!posix)('shell reset hooks of a sandbox need a human under trust mcp (L7.8)', () => {
  beforeAll(async () => {
    ws = await mkdtemp(join(tmpdir(), 'retake-reset-hook-approvals-'));
    process.env.RETAKE_HOME = join(ws, '.home');
    port = await freePort();
    await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    dir = join(ws, 'projects', 's');
    await mkdir(join(dir, 'sandbox'), { recursive: true });
    await writeFile(join(dir, 'sandbox', 'service.mjs'), SERVICE);
    await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), manifest(RESET));
    await writeFile(join(dir, 'project.yaml'), ['name: S', 'environments:', `  local: {app: "http://localhost:${port}"}`, 'sandboxes:', '  sandbox: sandbox/sandbox.yaml', 'default_env: local', 'template: default', ''].join('\n'));
    engine = await createEngine({ root: ws, client: 'test', autoStartWorker: false });
  }, 60_000);

  afterAll(async () => {
    try {
      await openSandbox(await project(), 'sandbox', PERSON_POLICY).down();
    } catch {
      /* never started */
    }
    if (savedHome === undefined) delete process.env.RETAKE_HOME;
    else process.env.RETAKE_HOME = savedHome;
    if (ws) await rm(ws, { recursive: true, force: true });
  });

  it('the items: the seed\'s shell step, then the shell reset hook — phase reset, its position among the reset hooks, the fingerprint the sandbox checks', async () => {
    const p = await project();
    const items = await seedApprovalItems(p, 'sandbox', packageHookRunner());
    expect(items.map((i) => [i.phase, i.index, i.name, i.kind, i.reason])).toEqual([
      ['seed', 1, 'mark', 'shell', 'a shell command (runs local code)'],
      ['reset', 1, 'clean', 'shell', 'a shell command (runs local code)'],
    ]);
    const hook = p.sandboxes!.sandbox.manifest.reset!.hooks![1] as never;
    expect(items[1].fingerprint).toBe(hookFingerprint(hook, { phase: 'reset', index: 1, env: 'sandbox' }));
    expect(items[1].lines.join('\n')).toContain(RESET);
  });

  it('an `exec` step is asked about nowhere, yet keeps its position: the seed\'s and the reset hooks\' indexes, each within its list, are those runSeed checks', async () => {
    const c = join(ws, 'projects', 'c');
    await mkdir(join(c, 'sandbox'), { recursive: true });
    await writeFile(join(c, 'project.yaml'), ['name: C', 'environments:', '  local: {app: "http://localhost:9"}', 'sandboxes:', '  sandbox: sandbox/sandbox.yaml', 'template: default', ''].join('\n'));
    await writeFile(join(c, 'sandbox', 'compose.yaml'), ['services:', '  app: {image: busybox:1.38.0}', ''].join('\n'));
    await writeFile(
      join(c, 'sandbox', 'sandbox.yaml'),
      ['version: 1', 'provider: docker-compose', 'services:', '  app: {url: "http://localhost:4790", health: false, pages: {app: "http://localhost:4790"}}', 'seed:', '  - exec: {service: app, command: "true"}', '  - shell: {run: "echo seeded"}', 'reset:', '  hooks:', '    - exec: {service: app, command: "true"}', '    - name: after-exec', '      shell: {run: "echo reset"}', ''].join('\n'),
    );
    const p = await loadProject('c', ws);
    const items = await seedApprovalItems(p, 'sandbox', packageHookRunner());
    expect(items.map((i) => [i.phase, i.index, i.name ?? '-'])).toEqual([
      ['seed', 1, '-'],
      ['reset', 1, 'after-exec'],
    ]);
    expect(items[1].fingerprint).toBe(hookFingerprint(p.sandboxes!.sandbox.manifest.reset!.hooks![1] as never, { phase: 'reset', index: 1, env: 'sandbox' }));
  });

  it('a person\'s own up and reset (no trust): the reset hook runs, as before', async () => {
    sb = openSandbox(await project(), 'sandbox', PERSON_POLICY);
    const up = await sb.up();
    expect(up.reset).toMatchObject({ hooks: { steps: 2 } });
    expect([await marker('seed-marker.txt'), await marker('reset-marker.txt')]).toEqual([1, 1]);
    await sb.reset({ reseed: true });
    expect([await marker('seed-marker.txt'), await marker('reset-marker.txt')]).toEqual([2, 2]);
  }, 60_000);

  it('approved (both items): the seed and the reset hook run under trust mcp', async () => {
    const items = await seedApprovalItems(await project(), 'sandbox', packageHookRunner());
    expect(await agentReset(approvalsOf(items))).toBe('ran');
    expect([await marker('seed-marker.txt'), await marker('reset-marker.txt')]).toEqual([3, 3]);
  }, 60_000);

  it('the reset hook not approved (only the seed\'s step): refused, it does not run', async () => {
    const items = await seedApprovalItems(await project(), 'sandbox', packageHookRunner());
    const r = await agentReset(approvalsOf(items.filter((i) => i.phase === 'seed')));
    expect(r).toMatch(/^refused: sandbox sandbox: reset hook step 2\/2/);
    expect(r).toContain('without a human approval');
    expect([await marker('seed-marker.txt'), await marker('reset-marker.txt')]).toEqual([4, 3]);
  }, 60_000);

  it('the reset hook changed since its approval: refused, the new command does not run', async () => {
    const approved = approvalsOf(await seedApprovalItems(await project(), 'sandbox', packageHookRunner()));
    await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), manifest('echo changed >> changed-marker.txt'));
    try {
      const r = await agentReset(approved);
      expect(r).toMatch(/^refused: sandbox sandbox: reset hook step 2\/2/);
      expect(await marker('changed-marker.txt')).toBe(0);
    } finally {
      await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), manifest(RESET));
    }
  }, 60_000);

  it('a seed step that is the same command as an approved reset hook, at the position its approval was once bound to, does not share it', async () => {
    // Approved: the seed's shell step and the reset hook `clean` (reset hook 2 of 2; under a seed-phase binding after the
    // seed's two steps it would have been index 3).
    const approved = approvalsOf(await seedApprovalItems(await project(), 'sandbox', packageHookRunner()));
    const grown = manifest(RESET)
      .replace("    shell: {run: \"echo seeded >> seed-marker.txt\"}\n", `    shell: {run: "echo seeded >> seed-marker.txt"}\n  - name: pad\n    http: {url: "{{app}}/health"}\n  - name: clean\n    shell: {run: "${RESET}"}\n`)
      .replace(/reset:\n  hooks:\n(?:    .*\n|      .*\n)*/, '');
    await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), grown);
    try {
      const p = await project();
      expect(p.sandboxes!.sandbox.manifest.seed![3]).toEqual({ name: 'clean', shell: { run: RESET } });
      const items = await seedApprovalItems(p, 'sandbox', packageHookRunner());
      expect(items.map((i) => `${i.phase} ${i.index} ${i.name}`)).toEqual(['seed 1 mark', 'seed 3 clean']);
      expect(approved.map((a) => a.fingerprint)).not.toContain(items[1].fingerprint);
      const before = await marker('reset-marker.txt');
      const r = await agentReset(approved);
      expect(r).toMatch(/^refused: sandbox sandbox: seed step 4\/4/);
      expect(await marker('reset-marker.txt')).toBe(before);
    } finally {
      await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), manifest(RESET));
    }
  }, 60_000);

  // L7.9: a reset hook of another kind than shell gets exactly what a seed step of its kind gets: an http or sql step
  // rebuilds the sandbox's own data (its database checked at run time) and an exec step runs inside a sandbox container
  // — none is an approval item, none is asked about, under trust mcp too. A destructive http step pins it.
  it('an http reset hook, destructive (DELETE), is treated as an http seed step: no item, and under trust mcp it runs unasked', async () => {
    const destructive = (m: string) => m.replaceAll('http: {url: "{{app}}/health"}', 'http: {method: DELETE, url: "{{app}}/health"}');
    await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), destructive(manifest(RESET)));
    try {
      const p = await project();
      expect([p.sandboxes!.sandbox.manifest.seed![0], p.sandboxes!.sandbox.manifest.reset!.hooks![0]]).toEqual([
        { name: 'ping', http: { method: 'DELETE', url: '{{app}}/health' } },
        { name: 'health', http: { method: 'DELETE', url: '{{app}}/health' } },
      ]);
      const items = await seedApprovalItems(p, 'sandbox', packageHookRunner());
      expect(items.map((i) => `${i.phase} ${i.index} ${i.kind}`)).toEqual(['seed 1 shell', 'reset 1 shell']);
      const deletes = async () => Number(await (await fetch(`http://127.0.0.1:${port}/deletes`)).text());
      const before = await deletes();
      const resets = await marker('reset-marker.txt');
      expect(await agentReset(approvalsOf(items))).toBe('ran');
      // The seed's DELETE and the reset hook's, both unasked; then the approved shell reset hook.
      expect([(await deletes()) - before, (await marker('reset-marker.txt')) - resets]).toEqual([2, 1]);
      // Only the shell steps approved is all it takes: the http steps were never asked about.
      const none = await agentReset([]);
      expect(none).toMatch(/^refused: sandbox sandbox: seed step 2\/2 \(mark: /);
      expect((await deletes()) - before).toBe(3); // the seed's DELETE ran, then its shell step was refused
    } finally {
      await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), manifest(RESET));
    }
  }, 60_000);

  it('a sandbox reset submitted through the engine asks about the reset hook: no approver, needs_approval naming it; an accept binds its fingerprint', async () => {
    const none = await engine.sandbox.reset({ project: 's' }).catch((e: unknown) => e);
    expect(none).toMatchObject({ code: 'needs_approval', message: expect.stringContaining('reset hook 2 "clean" (a shell command (runs local code))') });
    const asked: ApprovalRequest[] = [];
    const sub = await engine.sandbox.reset({ project: 's' }, { approver: { approve: async (req) => (asked.push(req), { approved: true }) } });
    const items = await seedApprovalItems(await project(), 'sandbox', packageHookRunner());
    expect(asked[0]?.items.map((i) => `${i.phase} ${i.index}`)).toEqual(['seed 1', 'reset 1']);
    expect(sub.job.input).toMatchObject({ kind: 'sandbox_reset', approvals: items.map((i) => expect.objectContaining({ fingerprint: i.fingerprint })) });
    await engine.jobs.cancel(sub.job.id).catch(() => undefined);
  });
});
