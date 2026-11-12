/**
 * L3.1 review: what work submitted through MCP may not do, without a browser. A scenario that names a secret is refused
 * at save, at submit and again by the worker; a project created through MCP may not point at another project's
 * production hosts, and nothing runs read-write on them; approvals are signed with the Retake home's key; a run whose
 * job was cancelled before any worker took it is listed `cancelled`; the build stamp covers every runtime package.
 */
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from '@retake/core';
import type { HooksJobInput, RunJobInput } from '@retake/engine';
import {
  APPROVALS_USED_DIR,
  EngineError,
  buildDirs,
  consumeApprovals,
  createEngine,
  executeHooksJob,
  executeRunJob,
  openWorkspace,
  pruneUsedApprovals,
  restoreApprovals,
  setProtectedHostResolver,
  sha256Hex,
  signApprovals,
  signalInterrupts,
  verifiedApprovals,
  enginePorts,
} from '../src/index.js';
import type { Engine } from '../src/index.js';
import { scratchHome } from '@retake/test-support/home';

let ws: string;
let mcp: Engine;
let cli: Engine;
const retakeHome = scratchHome();

const project = (name: string, envs: string[]) => ['name: ' + name, 'environments:', ...envs, 'capture: {width: 1280, height: 720, scale: 1, fps: 30}', 'template: default', ''].join('\n');
const SHORT = 'video: short\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - hold: 0.2\n';
const LEAK = SHORT.replace('video: short', 'video: leak').replace('      - hold: 0.2', '      - eval: {js: "throw new Error(btoa(\'{{env:HOME}}\'))"}');
const PLAIN_HOOK = SHORT.replace('video: short', 'video: plain').replace('scenes:', 'setup:\n  - http: {method: POST, url: "{{console}}/x"}\nscenes:');
const LEAK_HOOK = SHORT.replace('video: short', 'video: leakhook').replace(
  'scenes:',
  'setup:\n  - http: {method: POST, url: "{{console}}/x", headers: {authorization: "Bearer {{env:HOME}}"}}\nscenes:',
);

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(EngineError);
  return e as EngineError;
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-agent-safety-'));
  retakeHome.use(join(ws, '.home'));
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
  const files: Record<string, string> = {
    'prod/project.yaml': project('Prod', [
      '  production:',
      '    production: true',
      '    pages:',
      '      console: http://127.0.0.1:4999',
      '  frozen:',
      '    access: read-only',
      '    pages:',
      '      console: https://frozen.example.com',
    ]),
    // A human made it: its staging points at prod's production host (as a project_create of an older build could).
    'twin/project.yaml': project('Twin', ['  staging:', '    console: http://localhost:4999', '  other:', '    console: http://127.0.0.1:4998']),
    'twin/scenarios/short.yaml': SHORT.replace('video: short', 'video: short\nenv: staging'),
    'twin/scenarios/armed.yaml': PLAIN_HOOK.replace('video: plain', 'video: armed\nenv: staging'),
    'twin/scenarios/other.yaml': SHORT.replace('video: short', 'video: other\nenv: other'),
    // Marked production by a human: the same host is fine, its runs are read-only.
    'mirror/project.yaml': project('Mirror', ['  production:', '    production: true', '    pages:', '      console: http://127.0.0.1:4999']),
    'mirror/scenarios/short.yaml': SHORT,
    'w/project.yaml': project('W', ['  local:', '    console: http://127.0.0.1:4997']),
    'w/scenarios/short.yaml': SHORT,
    'w/scenarios/leak.yaml': LEAK,
    'w/scenarios/plain.yaml': PLAIN_HOOK,
    'w/scenarios/leakhook.yaml': LEAK_HOOK,
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(ws, 'projects', rel, '..'), { recursive: true });
    await writeFile(join(ws, 'projects', rel), text);
  }
  mcp = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
  cli = await createEngine({ root: ws, client: 'cli', autoStartWorker: false });
});

afterAll(async () => {
  retakeHome.restore();
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('secrets: a scenario written or run through MCP never names one', () => {
  it('save and validate through MCP refuse it; the engine of another client saves it', async () => {
    const e = await mcp.scenarios.save('w', 'leak2', LEAK).then(
      () => undefined,
      (x: unknown) => x as Error,
    );
    expect(e?.message).toContain('the scenario uses {{env:HOME}}: through MCP a scenario never resolves a secret');
    expect((await mcp.scenarios.validate('w', LEAK)).ok).toBe(false);
    expect((await cli.scenarios.validate('w', LEAK)).ok).toBe(true);
    expect((await cli.scenarios.save('w', 'leak3', LEAK)).created).toBe(true);
  });

  it('a run or hooks of such a scenario (written by hand) are refused at submit with the terminal command', async () => {
    const run = await refusal(mcp.runs.submit({ project: 'w', scenario: 'leak', mode: 'dry' }));
    expect(run.code).toBe('refused');
    expect(run.message).toContain('{{env:HOME}}');
    expect(run.fix).toBe(`retake -C ${ws} run w leak --dry --hooks skip`);
    const hooks = await refusal(mcp.hooks.submit({ project: 'w', source: 'leakhook:setup', dry: true }));
    expect(hooks.code).toBe('refused');
    expect(hooks.fix).toBe(`retake -C ${ws} hooks run w leakhook:setup --dry`);
    expect((await mcp.jobs.list({ project: 'w' })).length).toBe(0);
  });

  it('the worker checks again: hooks of a scenario changed after the submit are refused', async () => {
    const sub = await mcp.hooks.submit({ project: 'w', source: 'plain:setup', dry: true });
    const leak = LEAK_HOOK.replace('video: leakhook', 'video: plain');
    await writeFile(join(ws, 'projects', 'w', 'scenarios', 'plain.yaml'), leak);
    try {
      const input = sub.job.input as HooksJobInput;
      const wsc = await openWorkspace({ root: ws, agent: false });
      const exec = (i: HooksJobInput) => refusal(executeHooksJob({ ...enginePorts(), ws: wsc, cli: 'retake', input: i, signal: new AbortController().signal, event: () => undefined }));
      // Other bytes than submitted: a conflict before they are parsed.
      expect((await exec(input)).code).toBe('conflict');
      // A job pinned to the changed bytes (queued without a submit): their agent trust is checked again here.
      const e = await exec({ ...input, scenario_sha256: sha256Hex(leak) });
      expect(e.message).toContain('{{env:HOME}}');
    } finally {
      await writeFile(join(ws, 'projects', 'w', 'scenarios', 'plain.yaml'), PLAIN_HOOK);
      await mcp.jobs.cancel(sub.job.id);
    }
  });
});

describe("navigation: what a scenario opens (its scheme everywhere; agent work: the environment's origins)", () => {
  const FOREIGN = PLAIN_HOOK.replace('video: plain', 'video: foreign').replace('      - hold: 0.2', '      - open: "http://127.0.0.1:4998/admin"');
  const FILE = SHORT.replace('video: short', 'video: file').replace('    open: /', '    open: " file:///etc/hosts"');

  it('save and validate: a file: URL is an error for every client; another origin is saved (save checks the scheme only)', async () => {
    for (const engine of [mcp, cli]) {
      const e = await engine.scenarios.save('w', 'file', FILE).then(
        () => undefined,
        (x: unknown) => x as Error,
      );
      expect(e?.message).toContain('opens a file: URL: a scenario opens only http: and https: pages (or about:blank)');
      const v = await engine.scenarios.validate('w', FILE);
      expect(v.ok).toBe(false);
      expect(v.issues.filter((i) => i.severity === 'error')).toEqual([expect.objectContaining({ path: ['scenes', 0, 'open'], line: 5 })]);
    }
    expect((await mcp.scenarios.save('w', 'foreign', FOREIGN)).created).toBe(true);
    expect((await mcp.scenarios.validate('w', FOREIGN)).ok).toBe(true);
  });

  it("validate on a known environment (its `env`, or the scenario's own) says what the run would refuse, at the line", async () => {
    for (const v of [await mcp.scenarios.validate('w', FOREIGN, { env: 'local' }), await mcp.scenarios.validate('w', FOREIGN.replace('video: foreign', 'video: foreign\nenv: local'))]) {
      expect(v.ok).toBe(false);
      expect(v.issues.filter((i) => i.severity === 'error')).toEqual([
        expect.objectContaining({ path: ['scenes', 0, 'steps', 0, 'open'], message: expect.stringContaining('not an origin of environment local') }),
      ]);
    }
    expect((await mcp.scenarios.validate('w', FOREIGN, { env: 'nowhere' })).issues.some((i) => /not an origin/.test(i.message))).toBe(false);
    expect((await cli.scenarios.validate('w', FOREIGN, { env: 'local' })).ok).toBe(true);
  });

  it('a run, an inspection or hooks of a scenario opening another origin are refused at submit, saying what to change', async () => {
    const before = (await mcp.jobs.list({ project: 'w' })).length;
    const run = await refusal(mcp.runs.submit({ project: 'w', scenario: 'foreign', mode: 'dry' }));
    expect(run.code).toBe('refused');
    expect(run.message).toContain('scenes[0].steps[0].open: http://127.0.0.1:4998/admin is on http://127.0.0.1:4998, not an origin of environment local');
    expect(run.message).toContain('add its origin as a page of environment local in project.yaml');
    expect(run.details?.problems).toHaveLength(1);
    expect(run.fix).toBe(`retake -C ${ws} run w foreign --dry --hooks skip`);
    const inspect = await refusal(mcp.inspect.submit({ project: 'w', scenario: 'foreign' }));
    expect(inspect.message).toContain('not an origin of environment local');
    const hooks = await refusal(mcp.hooks.submit({ project: 'w', source: 'foreign:setup', dry: true }));
    expect(hooks.message).toContain('not an origin of environment local');
    expect((await mcp.jobs.list({ project: 'w' })).length).toBe(before);
  });

  it('the Studio runs under the same trust: its run blockers say the same, from the Studio', async () => {
    const ui = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
    const check = await ui.scenarios.check('w', 'foreign');
    expect(check.ok).toBe(true);
    expect(check.run_blockers.dry).toEqual([expect.objectContaining({ kind: 'opens_other_site', message: expect.stringContaining('from the Studio a scenario opens only its environment') })]);
    expect(check.run_blockers.dry[0].message).toContain('add its origin as a page of environment local in project.yaml');
    // Another reason beside it: the gate's general words, never "opens another site" alone.
    await writeFile(
      join(ws, 'projects', 'w', 'scenarios', 'foreign-secret.yaml'),
      FOREIGN.replace('video: foreign', 'video: foreign-secret').replace('url: "{{console}}/x"}', 'url: "{{console}}/x", headers: {authorization: "Bearer {{env:HOME}}"}}'),
    );
    const mixed = await ui.scenarios.check('w', 'foreign-secret');
    expect(mixed.run_blockers.dry).toEqual([expect.objectContaining({ kind: 'agent_trust' })]);
  });

  it('the worker checks again: a run job pinned to bytes opening another origin is refused before anything opens', async () => {
    await writeFile(join(ws, 'projects', 'w', 'scenarios', 'nav.yaml'), SHORT.replace('video: short', 'video: nav'));
    const sub = await mcp.runs.submit({ project: 'w', scenario: 'nav', mode: 'dry' });
    const swapped = FOREIGN.replace('video: foreign', 'video: nav');
    await writeFile(join(ws, 'projects', 'w', 'scenarios', 'nav.yaml'), swapped);
    try {
      const input = { ...(sub.job.input as RunJobInput), scenario_sha256: sha256Hex(swapped) };
      const out = await executeRunJob({
        ...enginePorts(),
        ws: await openWorkspace({ root: ws, agent: false }),
        cli: 'retake',
        input,
        signal: new AbortController().signal,
        interrupts: signalInterrupts(),
        event: () => undefined,
        progress: () => undefined,
      }).then(
        (r) => JSON.stringify(r),
        (x: unknown) => String((x as Error).message),
      );
      expect(out).toContain('not an origin of environment local');
    } finally {
      await mcp.jobs.cancel(sub.job.id);
    }
  });
});

describe("production across projects: another project's production / read-only hosts", () => {
  it('project_create refuses a page on them (loopback names alike, ports compared); other hosts are fine', async () => {
    for (const url of ['http://127.0.0.1:4999/app', 'http://localhost:4999', 'https://frozen.example.com/x']) {
      const e = await refusal(mcp.projects.create({ name: 'Clone', slug: 'clone', environments: { staging: { console: url } } }));
      expect(e.code, url).toBe('refused');
      expect(e.message).toMatch(/points at a host of (production environment production|read-only environment frozen) of project (prod|mirror)/);
    }
    await expect(stat(join(ws, 'projects', 'clone'))).rejects.toThrow();
    const ok = await mcp.projects.create({ name: 'Fine', slug: 'fine', environments: { staging: { console: 'http://127.0.0.1:4996' } } });
    expect(ok.slug).toBe('fine');
  });

  /** Resolve names with `table` only (no real DNS); the names asked for are recorded in `asked`. */
  function resolveWith(table: Record<string, readonly string[] | 'never'>, timeoutMs = 2000): { asked: string[]; restore: () => void } {
    const asked: string[] = [];
    const before = setProtectedHostResolver({
      lookup: (name) => {
        asked.push(name);
        const r = table[name];
        if (r === 'never') return new Promise<never>(() => undefined);
        return r ? Promise.resolve(r) : Promise.reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND' }));
      },
      timeoutMs,
    });
    return { asked, restore: () => void setProtectedHostResolver(before) };
  }

  it('addresses compare canonically: an IPv4-mapped IPv6 address is its IPv4 form, the unspecified address is loopback', async () => {
    const dns = resolveWith({});
    try {
      for (const url of [
        'http://[::ffff:127.0.0.1]:4999/app',
        'http://[::ffff:7f00:1]:4999',
        'http://[0:0:0:0:0:ffff:7f00:1]:4999',
        'http://[::]:4999',
        'http://[::ffff:0.0.0.0]:4999',
        'http://0x7f.1:4999',
      ]) {
        const e = await refusal(mcp.projects.create({ name: 'Mapped', slug: 'mapped', environments: { staging: { console: url } } }));
        expect(e.code, url).toBe('refused');
        expect(e.message, url).toContain('points at a host of production environment production of project');
      }
      // A human's project with such a page: its runs through MCP are refused too.
      await mkdir(join(ws, 'projects', 'mapped'), { recursive: true });
      await writeFile(join(ws, 'projects', 'mapped', 'project.yaml'), project('Mapped', ['  staging:', '    console: http://[::ffff:7f00:1]:4999']));
      await mkdir(join(ws, 'projects', 'mapped', 'scenarios'), { recursive: true });
      await writeFile(join(ws, 'projects', 'mapped', 'scenarios', 'short.yaml'), SHORT.replace('video: short', 'video: short\nenv: staging'));
      const run = await refusal(mcp.runs.submit({ project: 'mapped', scenario: 'short', mode: 'dry' }));
      expect(run.message).toContain('its page console (http://[::ffff:7f00:1]:4999) points at a host of production environment production of project');
      // Both sides IP literals: compared without resolving anything; another port is still another server.
      const ok = await mcp.projects.create({ name: 'Six', slug: 'six', environments: { staging: { console: 'http://[::ffff:7f00:1]:4995' } } });
      expect(ok.slug).toBe('six');
      expect(dns.asked).toEqual([]);
    } finally {
      dns.restore();
      await rm(join(ws, 'projects', 'mapped'), { recursive: true, force: true });
    }
  });

  it('an IP literal is compared with the addresses a protected name resolves to (and a page name with a protected address)', async () => {
    const dns = resolveWith({ 'frozen.example.com': ['2001:db8::7', '::ffff:203.0.113.7'], 'alias.example.com': ['127.0.0.2'], 'elsewhere.example.com': ['192.0.2.1'] });
    try {
      for (const url of ['https://203.0.113.7/x', 'https://[::ffff:cb00:7107]/', 'https://[2001:db8:0::7]/']) {
        const e = await refusal(mcp.projects.create({ name: 'Lit', slug: 'lit', environments: { staging: { console: url } } }));
        expect(e.code, url).toBe('refused');
        expect(e.message, url).toMatch(/points at a host of read-only environment frozen of project prod \(frozen\.example\.com resolves to (203\.0\.113\.7|2001:db8::7)\)/);
      }
      const alias = await refusal(mcp.projects.create({ name: 'Alias', slug: 'alias', environments: { staging: { console: 'http://alias.example.com:4999' } } }));
      expect(alias.message).toContain('(alias.example.com resolves to a loopback address)');
      expect(dns.asked).toContain('frozen.example.com');
      // Another address, another port: fine.
      expect((await mcp.projects.create({ name: 'Lit', slug: 'lit', environments: { staging: { console: 'https://203.0.113.8/' } } })).slug).toBe('lit');
      expect((await mcp.projects.create({ name: 'Else', slug: 'else', environments: { staging: { console: 'http://elsewhere.example.com:4999' } } })).slug).toBe('else');
      dns.asked.length = 0;
      expect((await mcp.projects.create({ name: 'Port', slug: 'port', environments: { staging: { console: 'https://203.0.113.7:8443/' } } })).slug).toBe('port');
      expect(dns.asked).toEqual([]);
    } finally {
      dns.restore();
    }
  });

  it('a name that does not resolve in time next to an IP literal counts as a match (failing closed)', async () => {
    const dns = resolveWith({ 'frozen.example.com': 'never' }, 50);
    try {
      const started = Date.now();
      const e = await refusal(mcp.projects.create({ name: 'Slow', slug: 'slow', environments: { staging: { console: 'https://198.51.100.4/' } } }));
      expect(e.message).toContain('read-only environment frozen of project prod (frozen.example.com did not resolve within 0.05 s, so it may be 198.51.100.4)');
      expect(Date.now() - started).toBeLessThan(1500);
      // Not found at all: the same.
      const gone = await refusal(mcp.projects.create({ name: 'Gone', slug: 'gone', environments: { staging: { console: 'http://unknown.example.com:4999' } } }));
      expect(gone.message).toContain('(unknown.example.com did not resolve within 0.05 s, so it may be a loopback address)');
      await expect(stat(join(ws, 'projects', 'slow'))).rejects.toThrow();
    } finally {
      dns.restore();
    }
  });

  it('a protected page written with a loopback name is an address too: compared with what a name resolves to, and a loopback page with a protected name', async () => {
    await mkdir(join(ws, 'projects', 'local-prod'), { recursive: true });
    await writeFile(join(ws, 'projects', 'local-prod', 'project.yaml'), project('Local prod', ['  live:', '    production: true', '    pages:', '      console: http://localhost:4997']));
    const dns = resolveWith({ 'dev.example.test': ['127.0.0.1'], 'frozen.example.com': ['::1'], 'away.example.test': ['192.0.2.3'] });
    try {
      const e = await refusal(mcp.projects.create({ name: 'Named', slug: 'named', environments: { staging: { console: 'http://dev.example.test:4997/' } } }));
      expect(e.code).toBe('refused');
      expect(e.message).toContain('points at a host of production environment live of project local-prod (dev.example.test resolves to a loopback address)');
      // A loopback page beside a protected name (frozen.example.com, https) that resolves to loopback.
      const back = await refusal(mcp.projects.create({ name: 'Back', slug: 'back', environments: { staging: { console: 'https://localhost/x' } } }));
      expect(back.message).toContain('points at a host of read-only environment frozen of project prod (frozen.example.com resolves to a loopback address)');
      expect((await mcp.projects.create({ name: 'Away', slug: 'away', environments: { staging: { console: 'http://away.example.test:4997/' } } })).slug).toBe('away');
    } finally {
      dns.restore();
      await rm(join(ws, 'projects', 'local-prod'), { recursive: true, force: true });
    }
  });

  it('the names of one check are resolved together, under one deadline', async () => {
    const asked: string[] = [];
    const before = setProtectedHostResolver({
      lookup: (name) => (asked.push(name), new Promise((r) => setTimeout(() => r(['192.0.2.50']), 400))),
      timeoutMs: 2000,
    });
    try {
      const started = Date.now();
      const pages = Object.fromEntries(['a', 'b', 'c', 'd'].map((k) => [k, `http://${k}.slow.example.test:4999/`]));
      expect((await mcp.projects.create({ name: 'Many', slug: 'many', environments: { staging: pages, preview: { e: 'http://e.slow.example.test:4999/' } } })).slug).toBe('many');
      expect([...asked].sort()).toEqual(['a', 'b', 'c', 'd', 'e'].map((k) => `${k}.slow.example.test`));
      // One after the other would take 5 × 400 ms.
      expect(Date.now() - started).toBeLessThan(1600);
    } finally {
      setProtectedHostResolver(before);
    }
  });

  it('runs, hooks and resets on a read-write environment pointing at them are refused; a protected environment, another port, are not', async () => {
    const run = await refusal(mcp.runs.submit({ project: 'twin', scenario: 'short', mode: 'dry' }));
    expect(run.code).toBe('refused');
    expect(run.message).toContain('environment staging of project twin is read-write and its page console (http://localhost:4999) points at a host of production environment production of project');
    expect(run.fix).toBe(`retake -C ${ws} run twin short --dry --hooks skip`);
    expect((await refusal(mcp.hooks.submit({ project: 'twin', source: 'armed:setup', env: 'staging' }))).code).toBe('refused');
    expect((await refusal(mcp.env.reset({ project: 'twin', env: 'staging' }))).code).toBe('refused');
    const other = await mcp.runs.submit({ project: 'twin', scenario: 'other', mode: 'dry' });
    const mirror = await mcp.runs.submit({ project: 'mirror', scenario: 'short', mode: 'dry' });
    await mcp.jobs.cancel(other.job.id);
    await mcp.jobs.cancel(mirror.job.id);
  });
});

describe('a run whose job was cancelled before any worker took it', () => {
  it('run_list shows it cancelled, as run_status does (run.json still says queued)', async () => {
    const sub = await mcp.runs.submit({ project: 'w', scenario: 'short', mode: 'dry' });
    expect((await mcp.runs.list('w')).find((r) => r.id === sub.run_id)?.status).toBe('queued');
    await mcp.runs.cancel('w', sub.run_id);
    expect(JSON.parse(await readFile(join(ws, 'projects', 'w', 'runs', sub.run_id, 'run.json'), 'utf8')).status).toBe('queued');
    expect((await mcp.runs.list('w')).find((r) => r.id === sub.run_id)?.status).toBe('cancelled');
    expect((await mcp.runs.status('w', sub.run_id)).status).toBe('cancelled');
  });
});

describe('approvals are signed with the Retake home key, for their job', () => {
  const jobId = 'j_01K9AZ0000000000000000000A';
  const input: RunJobInput = {
    version: 1,
    kind: 'run',
    project: 'w',
    scenario: 'short',
    scenario_sha256: 'a'.repeat(64),
    mode: 'dry',
    run_id: '20261017-120000-short',
    submitted_by: 'mcp',
    approvals: [{ fingerprint: 'b'.repeat(64), by: 'human-elicitation', at: '2026-10-17T12:00:00.000Z' }],
  };

  it('the key is created 0600 in a 0700 folder; only the signed input verifies', async () => {
    const home = join(ws, 'sign-home');
    const keyFile = join(home, 'approvals.key');
    expect(await signApprovals({ ...input, approvals: [] }, { jobId, root: ws, keyFile })).toEqual({ ...input, approvals: [] });
    await expect(stat(keyFile)).rejects.toThrow(); // no approval, no key
    const signed = await signApprovals(input, { jobId, root: ws, keyFile });
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect(await verifiedApprovals(signed, { jobId, root: ws, keyFile })).toEqual({ approvals: signed.approvals, rejected: 0 });
    // L5.14: bound to their job — the same input under another job id verifies nothing.
    expect((await verifiedApprovals(signed, { jobId: 'j_01K9AZ0000000000000000000B', root: ws, keyFile })).rejected).toBe(1);
    // …and to their workspace: the same job in another workspace (another root) verifies nothing.
    expect((await verifiedApprovals(signed, { jobId, root: join(ws, 'projects'), keyFile })).rejected).toBe(1);
    // Anything else of the job changed, the approval copied to another job, no signature, another key: rejected.
    for (const forged of [
      { ...signed, mode: 'capture' as const },
      { ...signed, run_id: '20261017-120001-short' },
      { ...signed, approvals: [{ ...signed.approvals![0], fingerprint: 'c'.repeat(64) }] },
      { ...input },
    ]) {
      expect((await verifiedApprovals(forged, { jobId, root: ws, keyFile })).rejected).toBe(1);
    }
    expect((await verifiedApprovals(signed, { jobId, root: ws, keyFile: join(ws, 'other-home', 'approvals.key') })).rejected).toBe(1);
  });

  it('a hooks job: the sha256 of its scenario bytes is signed with its approvals', async () => {
    const keyFile = join(ws, 'sign-home', 'approvals.key');
    const hooks: HooksJobInput = {
      version: 1,
      kind: 'hooks',
      project: 'w',
      source: 'short:setup',
      scenario_sha256: 'a'.repeat(64),
      dry: false,
      journal_id: '20261017-120000-hooks-short-setup',
      submitted_by: 'mcp',
      approvals: [{ fingerprint: 'b'.repeat(64), by: 'human-elicitation', at: '2026-10-17T12:00:00.000Z' }],
    };
    const signed = await signApprovals(hooks, { jobId, root: ws, keyFile });
    expect((await verifiedApprovals(signed, { jobId, root: ws, keyFile })).rejected).toBe(0);
    const { scenario_sha256: _, ...unpinned } = signed;
    for (const forged of [{ ...signed, scenario_sha256: 'c'.repeat(64) }, unpinned]) {
      expect((await verifiedApprovals(forged, { jobId, root: ws, keyFile })).rejected).toBe(1);
    }
  });
});

describe("a claim takes its job's approvals once (L5.14, review B M1)", () => {
  const approvals = [{ fingerprint: 'b'.repeat(64), by: 'human-elicitation' as const, at: '2026-10-17T12:00:00.000Z' }];
  const rec = (id: string, withApprovals = true) => ({
    id,
    input: { version: 1, kind: 'hooks', project: 'w', source: 'hooks/x.yaml', dry: false, submitted_by: 'mcp', ...(withApprovals ? { approvals } : {}) } as never,
  });

  it('once per id; none without approvals; an id older than the record kept is refused; restore gives them back; a record that cannot be written throws', async () => {
    const env = { ...process.env, RETAKE_HOME: join(ws, 'consume-home') };
    const id = `j_${ulid()}`;
    expect(await consumeApprovals(rec(`j_${ulid()}`, false), env, Date.now())).toBe(true);
    await expect(stat(join(ws, 'consume-home', APPROVALS_USED_DIR))).rejects.toThrow(); // nothing taken, nothing written
    // The record is stamped with the time the worker hands (its clock), not read here.
    const now = Date.now() + 1234;
    expect(await consumeApprovals(rec(id), env, now)).toBe(true);
    expect(JSON.parse(await readFile(join(ws, 'consume-home', APPROVALS_USED_DIR, id), 'utf8')).at).toBe(new Date(now).toISOString());
    expect(await consumeApprovals(rec(id), env, Date.now())).toBe(false);
    await restoreApprovals(id, env);
    expect(await consumeApprovals(rec(id), env, Date.now())).toBe(true);
    // A job id older than a year: its record may be pruned — refused.
    expect(await consumeApprovals(rec(`j_${ulid()}`), env, Date.now() + 366 * 24 * 3600_000)).toBe(false);
    expect(await consumeApprovals(rec('not-a-job-id'), env, Date.now())).toBe(false);
    // The record's folder not writable: an error, never "taken before".
    await chmod(join(ws, 'consume-home', APPROVALS_USED_DIR), 0o500);
    try {
      await expect(consumeApprovals(rec(`j_${ulid()}`), env, Date.now())).rejects.toThrow(/EACCES|permission/i);
    } finally {
      await chmod(join(ws, 'consume-home', APPROVALS_USED_DIR), 0o700);
    }
  });

  it('pruneUsedApprovals removes the records older than a year only (and nothing that is not one)', async () => {
    const env = { ...process.env, RETAKE_HOME: join(ws, 'prune-home') };
    const fresh = `j_${ulid()}`;
    const old = `j_${ulid()}`;
    await consumeApprovals(rec(fresh), env, Date.now());
    await consumeApprovals(rec(old), env, Date.now());
    const dir = join(ws, 'prune-home', APPROVALS_USED_DIR);
    await writeFile(join(dir, 'notes.txt'), '');
    const then = new Date(Date.now() - 366 * 24 * 3600_000);
    await utimes(join(dir, old), then, then);
    await utimes(join(dir, 'notes.txt'), then, then);
    await pruneUsedApprovals(env, Date.now());
    expect((await readdir(dir)).sort()).toEqual([fresh, 'notes.txt'].sort());
  });
});

describe('build stamp', () => {
  it('covers the engine and every @retake package it runs, transitively (hooks included)', async () => {
    const pkg = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { dependencies: Record<string, string> };
    const dirs = buildDirs().map((d) => d.split('/packages/')[1]?.split('/')[0]);
    expect(dirs[0]).toBe('engine');
    for (const name of Object.keys(pkg.dependencies).filter((n) => n.startsWith('@retake/'))) expect(dirs).toContain(name.replace('@retake/', ''));
    expect(dirs).toContain('hooks');
  });
});
