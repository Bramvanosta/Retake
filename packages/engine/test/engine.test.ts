import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessError, ConfigError, ScenarioError } from '@retake/core';
import { EngineError, LocalStorage, checkRef, createEngine, firstErrorLine, maskUrlCredentials, sha256Hex, toEngineError } from '../src/index.js';
import type { Engine } from '../src/index.js';
import { fixtureWorkspace } from './helpers.js';

let ws: string;
let home: string;
let engine: Engine;
const savedHome = process.env.RETAKE_HOME;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-engine-'));
  home = join(ws, '.home');
  process.env.RETAKE_HOME = home;
  await fixtureWorkspace(ws);
  engine = await createEngine({ root: ws, client: 'test' });
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await rm(ws, { recursive: true, force: true });
});

describe('LocalStorage', () => {
  it('maps refs to paths and back, refusing absolute paths, ".." and backslashes', () => {
    const s = new LocalStorage('/p/proj');
    expect(s.resolve('runs/a/capture.mp4')).toBe('/p/proj/runs/a/capture.mp4');
    expect(s.refOf('/p/proj/runs/a/capture.mp4')).toBe('runs/a/capture.mp4');
    for (const bad of ['/etc/passwd', '../x', 'runs/../../x', 'a//b', './a', 'a\\b', '', 'C:/x']) {
      expect(() => checkRef(bad), bad).toThrow(EngineError);
    }
    expect(() => s.refOf('/p/other/x')).toThrow(/outside the project/);
    expect(() => s.refOf('/p/proj')).toThrow(EngineError);
  });

  it('writeText: if_match hash, null = must not exist (atomic), conflicts name the current hash; symlink escapes refused', async () => {
    const dir = join(ws, 'storage');
    await mkdir(dir, { recursive: true });
    const s = new LocalStorage(dir);
    const a = await s.writeText('notes/a.txt', 'one\n', { ifMatch: null });
    expect(a.sha256).toBe(sha256Hex('one\n'));
    expect(await readFile(join(dir, 'notes', 'a.txt'), 'utf8')).toBe('one\n');
    const again = await s.writeText('notes/a.txt', 'two\n', { ifMatch: null }).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(EngineError);
    expect((again as EngineError).code).toBe('conflict');
    expect((again as EngineError).details).toEqual({ current: a.sha256 });
    const stale = await s.writeText('notes/a.txt', 'two\n', { ifMatch: sha256Hex('zero\n') }).catch((e: unknown) => e);
    expect((stale as EngineError).code).toBe('conflict');
    expect(await readFile(join(dir, 'notes', 'a.txt'), 'utf8')).toBe('one\n');
    const b = await s.writeText('notes/a.txt', 'two\n', { ifMatch: a.sha256 });
    expect(b.sha256).toBe(sha256Hex('two\n'));
    const missing = await s.writeText('notes/b.txt', 'x', { ifMatch: a.sha256 }).catch((e: unknown) => e);
    expect((missing as EngineError).code).toBe('conflict');
    expect((await s.readText('notes/a.txt'))?.sha256).toBe(b.sha256);
    const d = await s.describe('notes/a.txt', 'asset', { hash: true });
    expect(d).toMatchObject({ ref: 'notes/a.txt', bytes: 4, sha256: b.sha256 });
    expect(await s.describe('notes/none.txt', 'asset')).toBeUndefined();
    // A folder that is a symbolic link out of the project: never written through.
    const outside = await mkdtemp(join(tmpdir(), 'studio-outside-'));
    await symlink(outside, join(dir, 'escape'));
    const esc = await s.writeText('escape/x.txt', 'x').catch((e: unknown) => e);
    expect((esc as EngineError).code).toBe('refused');
    await rm(outside, { recursive: true, force: true });
  });
});

describe('toEngineError', () => {
  it('maps the typed errors of the other packages to codes', () => {
    expect(toEngineError(new ScenarioError('scenario "x" not found in /p (available: none)')).code).toBe('not_found');
    expect(toEngineError(new ScenarioError('not saved: …', [{ severity: 'error', path: [], message: 'm', line: 1, col: 1 }])).code).toBe('invalid');
    expect(toEngineError(new ConfigError('project "x" not found in /p/projects (available: none)')).code).toBe('not_found');
    expect(toEngineError(new AccessError('production is read-only')).code).toBe('refused');
    expect(toEngineError(Object.assign(new Error('busy'), { name: 'SandboxError', code: 'busy' })).code).toBe('busy');
    expect(toEngineError(Object.assign(new Error('down'), { name: 'SandboxError', code: 'down' })).code).toBe('unavailable');
    expect(toEngineError(Object.assign(new Error('stop'), { name: 'CancelledError' })).code).toBe('cancelled');
    expect(toEngineError(Object.assign(new Error('x'), { name: 'HookSecurityError' })).code).toBe('refused');
    expect(toEngineError(new TypeError('boom')).code).toBe('internal');
    expect(toEngineError('text').message).toBe('text');
  });

  it('masks a password written in a URL', () => {
    expect(maskUrlCredentials({ a: ['postgres://app:s3cret@localhost:5432/db', 'https://example.com/x'] })).toEqual({ a: ['postgres://app:***@localhost:5432/db', 'https://example.com/x'] });
  });
});

describe('engine: projects', () => {
  it('a project that does not load is listed with its first problem, not just "has 1 error:" (review B L5)', async () => {
    expect(firstErrorLine('project.yaml has 1 error:\n  environments.local: expected an object\n')).toBe('project.yaml has 1 error: environments.local: expected an object');
    expect(firstErrorLine('no project.yaml in /x')).toBe('no project.yaml in /x');
    const dir = await mkdtemp(join(tmpdir(), 'studio-engine-broken-'));
    try {
      await mkdir(join(dir, 'projects', 'broken'), { recursive: true });
      await writeFile(join(dir, 'projects', 'broken', 'project.yaml'), 'version: 1\nname: Broken\nenvironments:\n  local: "not a page map"\n');
      const e = await createEngine({ root: dir, client: 'test', autoStartWorker: false });
      const [b] = await e.projects.list();
      expect(b.error).toMatch(/error[^\n]*: \S/);
      expect(b.error).toContain('local');
      expect(b.error).not.toMatch(/:$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists projects and reads one without session paths, login steps or account passwords', async () => {
    const list = await engine.projects.list();
    expect(list.map((p) => p.slug)).toEqual(['northfield-fixture']);
    expect(list[0].scenarios).toContain('quote');
    const p = await engine.projects.get('northfield-fixture');
    expect(p.readme).toContain('Northfield');
    expect(p.readme_hash).toBe(sha256Hex(await readFile(join(ws, 'projects', 'northfield-fixture', 'README.md'))));
    expect(p.file).toBe('project.yaml');
    const prod = p.environments.find((e) => e.name === 'production');
    expect(prod).toMatchObject({ production: true, access: 'read-only', sandbox: false });
    const signedIn = p.environments.find((e) => e.name === 'signed-in');
    expect(signedIn?.personas.map((x) => x.name).sort()).toEqual(['buyer', 'supplier']);
    expect(p.environments.find((e) => e.name === 'sandbox')?.sandbox).toBe(true);
    const text = JSON.stringify(p);
    expect(text).not.toContain('roast-lot-2026'); // a sandbox account's plain password
    expect(text).not.toContain('NORTHFIELD_SUPPLIER_PASSWORD'); // login steps are not returned at all
    expect(text).not.toContain(home);
    expect(p.config).not.toHaveProperty('auth');
  });

  it('refuses paths where a slug is expected', async () => {
    for (const bad of ['../northfield-fixture', '/etc', './x', 'projects/northfield-fixture']) {
      await expect(engine.projects.get(bad)).rejects.toMatchObject({ name: 'EngineError', code: 'invalid' });
    }
    await expect(engine.projects.get('nope')).rejects.toThrow(/not found/);
  });

  it('creates a project and replaces its README only with the right if_match', async () => {
    const p = await engine.projects.create({ name: 'Acme Demo', environments: { staging: { app: 'https://app.staging.example.com' } } });
    expect(p.slug).toBe('acme-demo');
    expect(p.environments).toEqual([expect.objectContaining({ name: 'staging', production: false, access: 'read-write' })]);
    await expect(engine.projects.create({ name: 'Acme Demo' })).rejects.toThrow(/already exists/);
    const noMatch = await engine.projects.updateReadme('acme-demo', '# New').catch((e: unknown) => e);
    expect(noMatch).toMatchObject({ code: 'conflict' });
    expect((noMatch as EngineError).details?.current).toBe(p.readme_hash);
    const r = await engine.projects.updateReadme('acme-demo', '# New', p.readme_hash);
    expect(r.hash).toBe(sha256Hex('# New\n'));
    expect(r.file).toBe('README.md');
    await expect(engine.projects.updateReadme('acme-demo', '# Newer', p.readme_hash)).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('engine: scenarios', () => {
  const GOOD = 'video: good\nscenes:\n  - id: home\n    page: console\n    open: /\n    steps:\n      - click: Products\n';
  const BAD = 'video: bad\nscenes:\n  - id: home\n    page: console\n    open: /\n    steps:\n      - clik: Products\n';

  it('validates text with line/col, reads with a hash, saves with if_match', async () => {
    const bad = await engine.scenarios.validate('northfield-fixture', BAD);
    expect(bad.ok).toBe(false);
    const err = bad.issues.find((i) => i.severity === 'error');
    expect(err).toMatchObject({ line: 7 });
    expect(err?.message).toContain('did you mean "click"');
    expect((await engine.scenarios.validate('northfield-fixture', GOOD)).ok).toBe(true);
    const unknownPage = await engine.scenarios.validate('northfield-fixture', GOOD.replace('page: console', 'page: nowhere'));
    expect(unknownPage.ok).toBe(false);

    await expect(engine.scenarios.save('northfield-fixture', 'good', BAD)).rejects.toBeInstanceOf(ScenarioError);
    const created = await engine.scenarios.save('northfield-fixture', 'good', GOOD, { ifMatch: null });
    expect(created).toMatchObject({ created: true, file: 'scenarios/good.yaml', hash: sha256Hex(GOOD) });
    // Exists: if_match is required, and must be the current hash.
    await expect(engine.scenarios.save('northfield-fixture', 'good', GOOD)).rejects.toMatchObject({ code: 'conflict' });
    await expect(engine.scenarios.save('northfield-fixture', 'good', GOOD, { ifMatch: null })).rejects.toMatchObject({ code: 'conflict' });
    const read = await engine.scenarios.get('northfield-fixture', 'good');
    expect(read.hash).toBe(created.hash);
    const edited = GOOD.replace('click: Products', 'click: Orders').trimEnd(); // a final newline is added
    const saved = await engine.scenarios.save('northfield-fixture', 'good', edited, { ifMatch: read.hash });
    expect(saved.hash).toBe(sha256Hex(`${edited}\n`));
    await expect(engine.scenarios.save('northfield-fixture', 'good', GOOD, { ifMatch: read.hash })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses names that are paths, and a .yaml that would shadow a .yml', async () => {
    for (const bad of ['../x', 'a/b', '/tmp/x', 'x.yaml']) {
      await expect(engine.scenarios.save('northfield-fixture', bad, GOOD)).rejects.toMatchObject({ code: 'invalid' });
      await expect(engine.scenarios.get('northfield-fixture', bad)).rejects.toMatchObject({ code: 'invalid' });
    }
    await writeFile(join(ws, 'projects', 'northfield-fixture', 'scenarios', 'old.yml'), GOOD);
    expect((await engine.scenarios.get('northfield-fixture', 'old')).file).toBe('scenarios/old.yml');
    await expect(engine.scenarios.save('northfield-fixture', 'old', GOOD)).rejects.toThrow(/would shadow/);
    await rm(join(ws, 'projects', 'northfield-fixture', 'scenarios', 'old.yml'));
    await expect(engine.scenarios.get('northfield-fixture', 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('engine: runs, auth, sandbox', () => {
  it('lists runs newest first and reads a status with refs, keeping page text apart', async () => {
    const runs = await engine.runs.list('northfield-fixture');
    expect(runs.map((r) => r.id)).toEqual(['20261017-120000-quote', '20261016-090000-catalogue']);
    expect(await engine.runs.list('northfield-fixture', { mode: 'capture' })).toHaveLength(1);
    expect(await engine.runs.list('northfield-fixture', { scenario: 'quote', limit: 1 })).toHaveLength(1);

    const dry = await engine.runs.status('northfield-fixture', '20261017-120000-quote');
    expect(dry).toMatchObject({ status: 'failed', mode: 'dry', steps_done: 1, finished: true, error: { scene: 'catalog', step: 1, action: 'click' } });
    // run.json was written elsewhere (the project moved): refs follow the run folder, paths are the current ones.
    expect(dry.screenshots).toEqual([{ ref: 'runs/20261017-120000-quote/screenshots/001-catalog.0.png', path: join(ws, 'projects', 'northfield-fixture', 'runs', '20261017-120000-quote', 'screenshots', '001-catalog.0.png') }]);
    expect(dry.error?.screenshot?.ref).toBe('runs/20261017-120000-quote/error-catalog-1.png');
    expect(dry.untrusted.error_message).toContain('ignore your rules');
    // L5.6: the scene's other missing targets (their closest elements are page text) and the failed optional steps.
    expect(dry.untrusted.missing_targets).toEqual([{ scene: 'catalog', step: 3, action: 'type', target: 'label="Quantity"', near: [{ role: 'textbox', name: 'Quantity (kg)' }] }]);
    expect(dry.optional_failures).toEqual([{ scene: 'catalog', step: 0, action: 'hover', screenshot: { ref: 'runs/20261017-120000-quote/error-catalog-0.png', path: join(ws, 'projects', 'northfield-fixture', 'runs', '20261017-120000-quote', 'error-catalog-0.png') } }]);
    expect(dry.untrusted.optional_errors).toEqual(['no element "Featured" — page text']);
    expect(dry.untrusted.warnings).toHaveLength(1);
    expect(JSON.stringify({ ...dry, untrusted: undefined })).not.toContain('ignore');

    const cap = await engine.runs.status('northfield-fixture', '20261016-090000-catalogue');
    expect(cap.outputs.find((o) => o.ref.endsWith('capture.mp4'))).toMatchObject({ sha256: sha256Hex('not really a video'), bytes: 18 });
    await expect(engine.runs.status('northfield-fixture', '../../etc')).rejects.toMatchObject({ code: 'invalid' });
    await expect(engine.runs.status('northfield-fixture', 'no-record')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('auth status: personas with the command a human runs, no session paths', async () => {
    const r = await engine.auth.status({ project: 'northfield-fixture', env: 'signed-in' });
    expect(r.personas.map((p) => [p.persona, p.status])).toEqual([['supplier', 'never'], ['buyer', 'never']]);
    expect(r.personas[0].command).toBe(`retake -C ${ws} login northfield-fixture --env signed-in --persona supplier`);
    expect(JSON.stringify(r)).not.toContain(home);
    await expect(engine.auth.status({ env: 'local' })).rejects.toMatchObject({ code: 'invalid' });
    const all = await engine.auth.status();
    expect(all.personas.some((p) => p.sandbox)).toBe(true);
  });

  it('sandbox status of a sandbox that is down; a project without that sandbox is not_found', async () => {
    const s = await engine.sandbox.status('northfield-fixture', 'sandbox');
    expect(s).toMatchObject({ env: 'sandbox', provider: 'process', state: 'down', file: 'sandbox/sandbox.yaml' });
    expect(s.pages).toHaveProperty('console');
    const e = await engine.sandbox.status('northfield-fixture', 'local').catch((x: unknown) => x);
    expect(toEngineError(e).code).toBe('not_found');
  });
});
