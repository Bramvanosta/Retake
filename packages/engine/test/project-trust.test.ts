/**
 * R-SHR-35, R-SHR-36: an imported project not trusted is inert, and its mark fails closed.
 * - importTrust: none / untrusted / trusted, from the two halves of the mark (the workspace's, the project's marker):
 *   a marker alone (a folder moved here), a mark alone, two ids, bad JSON, an unsigned, tampered or other-home trust;
 * - the catalogue's allow-list: reads and UNTRUSTED_WRITES only, a new operation refused by default;
 * - the gate through every channel: invoke (MCP and the Studio), the worker's handleJob (a job written by hand), the CLI's
 *   commands (untrustedCommandRefusal), and the product's ports (hooks, sandboxes, capture, renderer, previews);
 * - nothing copied out of an untrusted import (untrustedSourceRefusal).
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOGUE, UNTRUSTED_WRITES, allowedOnUntrusted } from '../src/catalogue.js';
import type { Engine, EngineError } from '../src/index.js';
import { handleJob } from '../src/jobs/job-handlers.js';
import type { JobRun } from '../src/jobs/job-handlers.js';
import { invoke } from '../src/operations/invoke.js';
import { OPERATIONS_BY_NAME } from '../src/operations/index.js';
import type { ToolDef } from '../src/operations/define.js';
import { guardUntrusted } from '../src/project-archive/guard.js';
import {
  importMarkFile,
  importMarkerFile,
  importMarkerText,
  importTrust,
  readImportMark,
  untrustedCommandRefusal,
  untrustedOperationRefusal,
  untrustedSourceRefusal,
  writeImportMark,
  writeTrust,
} from '../src/project-archive/trust.js';
import type { ProductAdapters } from '../src/ports.js';

let root: string;
const env = process.env;
const ID = 'a'.repeat(32);
const dir = (slug = 'imp') => join(root, 'projects', slug);
const at = (slug = 'imp') => ({ root, dir: dir(slug), slug });
const ws = () => ({ root, projectsDir: join(root, 'projects') });

async function imported(slug = 'imp', id = ID): Promise<void> {
  await mkdir(join(dir(slug), '.retake'), { recursive: true });
  await writeFile(join(dir(slug), 'project.yaml'), 'name: imp\n');
  await writeFile(importMarkerFile(dir(slug)), importMarkerText(id));
  await writeImportMark(root, { slug, import_id: id, imported_at: 'now', archive: { name: 'a.zip', sha256: 'b'.repeat(64) }, from_retake: '0.0.0', code_files: {} });
}

async function trust(slug = 'imp'): Promise<void> {
  const m = await readImportMark(root, slug);
  if (typeof m !== 'object') throw new Error('no mark');
  await writeTrust(at(slug), m, {}, '2026-11-18T00:00:00.000Z', env);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-trust-'));
  await mkdir(join(root, 'projects', 'plain'), { recursive: true });
  await writeFile(join(root, 'projects', 'plain', 'project.yaml'), 'name: plain\n');
});
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('the mark fails closed (importTrust)', () => {
  it('none without either half; untrusted for one half, two ids, bad JSON; trusted only signed by this home', async () => {
    expect((await importTrust(at('plain'), env)).state).toBe('none');
    await imported();
    expect(await importTrust(at(), env)).toMatchObject({ state: 'untrusted', why: 'nobody trusted it yet' });
    await trust();
    expect((await importTrust(at(), env)).state).toBe('trusted');
    // The marker removed (an agent can): untrusted, never "none".
    await rm(importMarkerFile(dir()));
    expect(await importTrust(at(), env)).toMatchObject({ state: 'untrusted', why: expect.stringMatching(/marker .* missing/) });
    // Another import's marker: untrusted.
    await writeFile(importMarkerFile(dir()), importMarkerText('c'.repeat(32)));
    expect(await importTrust(at(), env)).toMatchObject({ state: 'untrusted', why: expect.stringMatching(/another import/) });
    await writeFile(importMarkerFile(dir()), importMarkerText(ID));
    expect((await importTrust(at(), env)).state).toBe('trusted');
    // The trusted stanza edited (its files widened), or signed under another home: untrusted.
    const file = importMarkFile(root, 'imp');
    const m = JSON.parse(await import('node:fs/promises').then((f) => f.readFile(file, 'utf8')));
    await writeFile(file, JSON.stringify({ ...m, trusted: { ...m.trusted, files: { 'hooks/x.sh': 'f'.repeat(64) } } }));
    expect(await importTrust(at(), env)).toMatchObject({ state: 'untrusted', why: expect.stringMatching(/not signed by this Retake home/) });
    await writeFile(file, JSON.stringify(m));
    const elsewhere = await mkdtemp(join(tmpdir(), 'retake-other-home-'));
    expect((await importTrust(at(), { ...env, RETAKE_HOME: elsewhere })).state).toBe('untrusted');
    await rm(elsewhere, { recursive: true, force: true });
    await writeFile(file, '{not json');
    expect(await importTrust(at(), env)).toMatchObject({ state: 'untrusted', why: expect.stringMatching(/does not read/) });
    // The workspace's mark gone (a folder moved or copied into another workspace): untrusted.
    await rm(file);
    expect(await importTrust(at(), env)).toMatchObject({ state: 'untrusted', why: expect.stringMatching(/holds no mark/) });
  });
});

describe('the allow-list of an untrusted project (catalogue allowedOnUntrusted)', () => {
  it('reads and these writes only; an operation the catalogue adds later is refused by default', () => {
    expect([...UNTRUSTED_WRITES].sort()).toEqual(
      [
        'job_cancel',
        'project_env_remove',
        'project_env_set',
        'project_export',
        'project_prune',
        'project_trust',
        'project_trust_discard',
        'project_update_readme',
        'render_cancel',
        'run_cancel',
        'sandbox_down',
        'scenario_edit',
        'scenario_save',
        'sign_in_cancel',
        'timeline_leave',
      ].sort(),
    );
    for (const o of CATALOGUE) expect(allowedOnUntrusted(o), o.name).toBe(o.effect === 'read' || UNTRUSTED_WRITES.has(o.name));
    for (const o of CATALOGUE) if (o.code !== 'none' || o.job) expect(allowedOnUntrusted(o), o.name).toBe(o.name === 'sandbox_down');
    expect(allowedOnUntrusted({ name: 'later_tool', effect: 'write' })).toBe(false);
  });
});

describe('the gate through every channel', () => {
  it('invoke: a code-running operation naming an untrusted project is refused before it runs; reads and the allow-list run', async () => {
    await imported();
    const ran: string[] = [];
    const fake = {
      caller: { client: 'mcp', channel: 'mcp', trust: 'mcp' },
      workspace: ws(),
      envVars: env,
      runs: { submit: async () => (ran.push('submit'), { job: { id: 'j' } }) },
      projects: { prune: async () => (ran.push('prune'), { dry_run: true, items: [], keep_renders: 3, bytes: 0, skipped: [], not_asked: 0 }) },
    } as unknown as Engine;
    const call = (name: keyof typeof OPERATIONS_BY_NAME, args: object) => invoke(OPERATIONS_BY_NAME[name] as ToolDef, fake, args, { shell: 'mcp', startedIn: root, signal: new AbortController().signal });
    const r = await call('run_dry', { project: 'imp', scenario: 'demo', wait_s: 0 });
    expect(r.ok).toBe(false);
    expect(!r.ok && [r.error.code, r.error.message]).toEqual(['refused', expect.stringMatching(/^imp was imported from a project archive and is not trusted/)]);
    expect(ran).toEqual([]);
    // An ordinary project goes through (the fake answers), and so does an allowed write on the import.
    expect((await untrustedOperationRefusal('run_dry', { project: 'plain' }, ws(), env)) === undefined).toBe(true);
    expect(await untrustedOperationRefusal('project_prune', { project: 'imp' }, ws(), env)).toBeUndefined();
    expect(await untrustedOperationRefusal('scenario_get', { project: 'imp' }, ws(), env)).toBeUndefined();
    expect((await untrustedOperationRefusal('scenario_render', { project: 'imp' }, ws(), env))?.code).toBe('refused');
    expect((await untrustedOperationRefusal('an_unknown_op', { project: 'imp' }, ws(), env))?.code).toBe('refused');
    await trust();
    expect(await untrustedOperationRefusal('run_dry', { project: 'imp' }, ws(), env)).toBeUndefined();
  });

  it("the worker's handleJob: a job of an untrusted project (a file written by hand) never reaches its handler", async () => {
    await imported();
    const run = { id: 'j_x', base: { ws: ws(), env } } as unknown as JobRun;
    const job = { version: 1, kind: 'hooks', project: 'imp', source: 'reset', dry: false, journal_id: 'x', submitted_by: 'mcp' } as never;
    const e = await handleJob(job, run).then(
      () => null,
      (x: EngineError) => x,
    );
    expect(e?.message).toMatch(/^imp was imported from a project archive and is not trusted/);
  });

  it("the CLI's commands: refused unless every operation the command serves is allowed; a command the catalogue does not name refused", async () => {
    await imported();
    for (const path of ['run', 'render', 'hooks run', 'sandbox up', 'login', 'inspect', 'record', 'export-capture', 'review', 'still', 'project adopt', 'comment add', 'zzz'])
      expect((await untrustedCommandRefusal(ws(), path, 'imp', env))?.code, path).toBe('refused');
    for (const path of ['validate', 'plan', 'prune', 'sandbox down', 'project export', 'project trust', 'env set', 'list'])
      expect(await untrustedCommandRefusal(ws(), path, 'imp', env), path).toBeUndefined();
    // A command serving an allowed operation and another one: refused (every one must be allowed).
    const mixed = [
      { ...CATALOGUE.find((o) => o.name === 'project_prune')!, cli: ['tidy'] },
      { ...CATALOGUE.find((o) => o.name === 'hooks_run')!, cli: ['tidy'] },
    ];
    expect((await untrustedCommandRefusal(ws(), 'tidy', 'imp', env, mixed))?.code).toBe('refused');
    expect(await untrustedCommandRefusal(ws(), 'tidy', 'imp', env, mixed.slice(0, 1))).toBeUndefined();
    // No workspace opens: a folder holding an import marker is refused all the same (its mark cannot be read).
    expect((await untrustedCommandRefusal(undefined, 'run', dir(), env))?.message).toMatch(/no workspace opens here, so its mark cannot be read/);
    expect(await untrustedCommandRefusal(undefined, 'run', dir('plain'), env)).toBeUndefined();
    expect(await untrustedCommandRefusal(undefined, 'validate', dir(), env)).toBeUndefined();
    // A link to the import is the import.
    await symlink(dir(), join(root, 'projects', 'alias'));
    expect((await untrustedCommandRefusal(ws(), 'run', 'alias', env))?.message).toMatch(/^imp was imported/);
    // Named by its folder too; an ordinary project passes.
    expect((await untrustedCommandRefusal(ws(), 'run', dir(), env))?.code).toBe('refused');
    expect(await untrustedCommandRefusal(ws(), 'run', 'plain', env)).toBeUndefined();
  });

  it("the product's ports refuse its hooks, sandboxes, browsers and renders; a sandbox still stops", async () => {
    await imported();
    const calls: string[] = [];
    const rec =
      (what: string) =>
      async (..._a: unknown[]) => (calls.push(what), {}) as never;
    const handle = { env: 'sandbox', up: rec('up'), down: rec('down'), status: rec('status'), killStartedSync: () => calls.push('kill') };
    const base = {
      hooks: { run: rec('hooks.run'), journals: { rollback: rec('rollback'), rollbackPending: rec('rollbackPending'), open: rec('open') }, approval: {} },
      reviewer: {},
      capture: { run: rec('capture.run'), record: rec('record'), sessions: { check: rec('check'), signIn: rec('signIn') }, hookPages: { open: rec('hookPages.open') } },
      sandboxes: { open: async () => handle, init: rec('init') },
      renderer: { video: rec('video'), stills: rec('stills'), previews: { bundle: rec('bundle'), open: rec('previews.open') } },
      registries: {},
    } as unknown as ProductAdapters;
    const g = guardUntrusted(base, env);
    const project = { root, dir: dir(), slug: 'imp' };
    const plain = { root, dir: dir('plain'), slug: 'plain' };
    const refused = async (p: Promise<unknown>) => expect((await p.then(() => null, (e: EngineError) => e))?.code).toBe('refused');
    await refused(g.hooks.run([], { project } as never, {} as never));
    await refused(g.hooks.journals.rollback([], { project } as never));
    await refused(g.capture.run({ project } as never));
    await refused(g.capture.sessions.signIn({ project } as never));
    await refused(g.capture.hookPages.open({ project } as never));
    const h = await g.sandboxes.open(project as never, undefined, {} as never);
    await refused(h.up());
    await refused(h.status());
    await h.down();
    h.killStartedSync();
    const registry = { projectComponentsDir: join(dir(), 'components') };
    await refused(g.renderer.video({ root, registry, plan: {} } as never));
    await refused(g.renderer.stills({ root, registry: {}, plan: { assets: { logo: join(dir(), 'templates', 't', 'a.json') } } } as never));
    await refused(g.renderer.previews.bundle({ root, components: [{ dir: join(dir(), 'components', 'acme', 'x') }] } as never));
    expect(calls).toEqual(['down', 'kill']);
    // An ordinary project runs as before.
    await g.hooks.run([], { project: plain } as never, {} as never);
    await (await g.sandboxes.open(plain as never, undefined, {} as never)).up();
    await g.renderer.video({ root, registry: { projectComponentsDir: join(dir('plain'), 'components') }, plan: {} } as never);
    expect(calls).toEqual(['down', 'kill', 'hooks.run', 'up', 'video']);
  });

  it('nothing is copied out of an untrusted import (a theme or component folder inside it); trusted: copied', async () => {
    await imported();
    const theme = join(dir(), 'templates', 'brand');
    await mkdir(theme, { recursive: true });
    expect((await untrustedSourceRefusal(ws(), theme, env))?.message).toMatch(/^nothing is copied out of imp: imp was imported/);
    expect(await untrustedSourceRefusal(ws(), join(dir('plain'), 'templates', 'x'), env)).toBeUndefined();
    await trust();
    expect(await untrustedSourceRefusal(ws(), theme, env)).toBeUndefined();
  });
});
