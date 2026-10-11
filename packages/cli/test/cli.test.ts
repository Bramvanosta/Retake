import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, main, memoryIo, parseEnvOptions } from '../src/index.js';

let ws: string;
/** The bundled starter templates (the temporary workspace uses them as its templates_dir). */
const TEMPLATES = fileURLToPath(new URL('../../../templates', import.meta.url));

/** Run `studio --root <ws> …args` in-process. */
async function studio(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'studio', '--root', ws, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-cli-'));
  await writeFile(join(ws, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('studio new / list / validate', () => {
  it('creates a project with environments and lists it', async () => {
    const r = await studio('new', 'demo', '--name', 'Demo product', '--env', 'staging=app:https://app.staging.example.com,api:https://api.staging.example.com');
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.err).toContain('created project demo');
    const yaml = await readFile(join(ws, 'projects', 'demo', 'project.yaml'), 'utf8');
    expect(yaml).toContain('app: https://app.staging.example.com');
    expect((await studio('new', 'demo')).code).toBe(EXIT.failure);

    const list = await studio('list', '--json');
    expect(list.code).toBe(EXIT.ok);
    const data = JSON.parse(list.out) as { projects: Array<{ slug: string; name: string; environments: string[] }> };
    expect(data.projects).toEqual([expect.objectContaining({ slug: 'demo', name: 'Demo product', environments: ['staging'] })]);
  });

  it('validates scenarios with file:line:col messages and exit codes', async () => {
    const dir = join(ws, 'projects', 'demo', 'scenarios');
    await writeFile(join(dir, 'good.yaml'), 'video: good\nscenes:\n  - id: home\n    page: app\n    open: /\n    steps:\n      - click: Sign in\n');
    await writeFile(join(dir, 'bad.yaml'), 'video: bad\nscenes:\n  - id: home\n    page: app\n    open: /\n    steps:\n      - clik: Sign in\n');

    const good = await studio('validate', 'demo', 'good');
    expect(good.code, good.err).toBe(EXIT.ok);
    expect(good.err).toMatch(/✓ scenario good/);

    const bad = await studio('validate', 'demo', 'bad');
    expect(bad.code).toBe(EXIT.failure);
    expect(bad.err).toMatch(/bad\.yaml:7:\d+ error/);
    expect(bad.err).toContain('did you mean "click"');

    const all = await studio('validate', 'demo', '--json');
    expect(all.code).toBe(EXIT.failure);
    const report = JSON.parse(all.out) as { ok: boolean; files: Array<{ kind: string; name: string }> };
    expect(report.ok).toBe(false);
    expect(report.files.filter((f) => f.kind === 'scenario').map((f) => f.name).sort()).toEqual(['bad', 'good']);

    const missing = await studio('run', 'demo', 'nope');
    expect(missing.code).toBe(EXIT.failure);
    expect(missing.err).toContain('scenario "nope" not found');
  });
});

describe('studio usage, schema and later phases', () => {
  it('exits 2 on usage errors', async () => {
    expect((await studio('run', 'demo')).code).toBe(EXIT.usage);
    expect((await studio('frobnicate')).code).toBe(EXIT.usage);
    expect((await studio('schema', 'nope')).code).toBe(EXIT.usage);
    expect((await studio('run', 'demo', 'good', '--hooks', 'maybe')).code).toBe(EXIT.usage);
    expect((await studio('new', 'x', '--env', 'not-an-env')).code).toBe(EXIT.usage);
    expect((await studio('hooks', 'run', 'demo', 'nonsense')).code).toBe(EXIT.usage);
  });

  it('prints JSON Schemas and the version', async () => {
    const r = await studio('schema', 'project');
    expect(r.code).toBe(EXIT.ok);
    expect((JSON.parse(r.out) as { $id: string }).$id).toBe('project.schema.json');
    const v = await studio('--version');
    expect(v.code).toBe(EXIT.ok);
    expect(v.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('says when later-phase commands arrive', async () => {
    const r = await studio('export', 'demo', 'good', '--whatever');
    expect(r.code).toBe(EXIT.failure);
    expect(r.err).toContain('available in phase 2');
    expect(r.err).toContain('render, still, review');
    expect((await studio('mcp')).err).toContain('available in phase 3');
    // render (L2.4) and review (L2.6) are real commands: an unknown option is a usage error.
    expect((await studio('render', 'demo', 'good', '--whatever')).code).toBe(EXIT.usage);
    expect((await studio('review', 'demo', 'latest', '--whatever')).code).toBe(EXIT.usage);
  });

  it('reports hook sources that do not exist', async () => {
    const reset = await studio('hooks', 'run', 'demo', 'reset');
    expect(reset.code).toBe(EXIT.failure);
    expect(reset.err).toContain('declares no reset hooks');
    const rb = await studio('hooks', 'rollback', 'demo');
    expect(rb.code).toBe(EXIT.ok);
    expect(rb.err).toContain('no pending rollbacks');
  });
});

describe('parseEnvOptions', () => {
  it('parses name=key:url lists and merges repeated environments', () => {
    expect(parseEnvOptions(['staging=app:https://a.example.com', 'staging=api:http://localhost:8080/v1', 'prod=app:https://b.example.com'])).toEqual({
      staging: { app: 'https://a.example.com', api: 'http://localhost:8080/v1' },
      prod: { app: 'https://b.example.com' },
    });
    expect(() => parseEnvOptions(['staging=app'])).toThrow(/not key:url/);
    expect(() => parseEnvOptions(['=app:https://a.example.com'])).toThrow(/name=key:url/);
  });
});
