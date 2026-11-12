import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, main, memoryIo, parseEnvOptions } from '../src/index.js';
import { LATER_COMMANDS, laterCommand } from '../src/commands/misc.js';
import { Ui } from '../src/ui.js';

let ws: string;
/** The bundled starter templates (the temporary workspace uses them as its templates_dir). */
const TEMPLATES = fileURLToPath(new URL('../../../templates', import.meta.url));

/** Run `retake --root <ws> …args` in-process. */
async function retake(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', ws, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-cli-'));
  await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('retake new / list / validate', () => {
  it('creates a project with environments and lists it', async () => {
    const r = await retake('new', 'demo', '--name', 'Demo product', '--env', 'staging=app:https://app.staging.example.com,api:https://api.staging.example.com');
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.err).toContain('created project demo');
    const yaml = await readFile(join(ws, 'projects', 'demo', 'project.yaml'), 'utf8');
    expect(yaml).toContain('app: https://app.staging.example.com');
    expect((await retake('new', 'demo')).code).toBe(EXIT.failure);

    const list = await retake('list', '--json');
    expect(list.code).toBe(EXIT.ok);
    const data = JSON.parse(list.out) as { projects: Array<{ slug: string; name: string; environments: string[] }> };
    expect(data.projects).toEqual([expect.objectContaining({ slug: 'demo', name: 'Demo product', environments: ['staging'] })]);
    // The words a person reads follow the glossary (docs/GLOSSARY.md): themes, not templates.
    const human = await retake('list');
    expect(human.code).toBe(EXIT.ok);
    expect(human.out).toMatch(/^Themes /m);
    expect(human.out).toMatch(/^ {2}default, editorial, motion$/m);
    expect(human.out).not.toMatch(/^Templates/m);
  });

  it('validates scenarios with file:line:col messages and exit codes', async () => {
    const dir = join(ws, 'projects', 'demo', 'scenarios');
    await writeFile(join(dir, 'good.yaml'), 'video: good\nscenes:\n  - id: home\n    page: app\n    open: /\n    steps:\n      - click: Sign in\n');
    await writeFile(join(dir, 'bad.yaml'), 'video: bad\nscenes:\n  - id: home\n    page: app\n    open: /\n    steps:\n      - clik: Sign in\n');

    const good = await retake('validate', 'demo', 'good');
    expect(good.code, good.err).toBe(EXIT.ok);
    expect(good.err).toMatch(/✓ scenario good/);

    const bad = await retake('validate', 'demo', 'bad');
    expect(bad.code).toBe(EXIT.failure);
    expect(bad.err).toMatch(/bad\.yaml:7:\d+ error/);
    expect(bad.err).toContain('did you mean "click"');

    const all = await retake('validate', 'demo', '--json');
    expect(all.code).toBe(EXIT.failure);
    const report = JSON.parse(all.out) as { ok: boolean; files: Array<{ kind: string; name: string }> };
    expect(report.ok).toBe(false);
    expect(
      report.files
        .filter((f) => f.kind === 'scenario')
        .map((f) => f.name)
        .sort(),
    ).toEqual(['bad', 'good']);

    const missing = await retake('run', 'demo', 'nope');
    expect(missing.code).toBe(EXIT.failure);
    expect(missing.err).toContain('scenario "nope" not found');
  });
});

describe('studio usage, schema and later phases', () => {
  it('exits 2 on usage errors', async () => {
    expect((await retake('run', 'demo')).code).toBe(EXIT.usage);
    expect((await retake('frobnicate')).code).toBe(EXIT.usage);
    expect((await retake('schema', 'nope')).code).toBe(EXIT.usage);
    expect((await retake('run', 'demo', 'good', '--hooks', 'maybe')).code).toBe(EXIT.usage);
    expect((await retake('new', 'x', '--env', 'not-an-env')).code).toBe(EXIT.usage);
    expect((await retake('hooks', 'run', 'demo', 'nonsense')).code).toBe(EXIT.usage);
  });

  it('prints JSON Schemas and the version', async () => {
    const r = await retake('schema', 'project');
    expect(r.code).toBe(EXIT.ok);
    expect((JSON.parse(r.out) as { $id: string }).$id).toBe('project.schema.json');
    const v = await retake('--version');
    expect(v.code).toBe(EXIT.ok);
    expect(v.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('says when later-phase commands arrive', async () => {
    // No command waits for a later phase since L4.1 (`ui` is real): the mechanism, with an injected entry.
    expect(LATER_COMMANDS).toEqual([]);
    const io = memoryIo();
    const code = laterCommand(new Ui(io), 'shell', 5);
    const r = { code, err: io.stderr() };
    expect(r.code).toBe(EXIT.failure);
    expect(r.err).toContain('retake shell is available in phase 5');
    expect(r.err).toContain('inspect, record, plan');
    expect(r.err).toContain('render, still, review, export');
    expect(r.err).toContain('doctor, mcp and ui');
    // ui is a real command since L4.1: an unknown option is a usage error (the server itself: packages/cli/test/ui.test.ts).
    expect((await retake('ui', '--whatever')).code).toBe(EXIT.usage);
    expect((await retake('ui', '--port', 'eighty')).code).toBe(EXIT.usage);
    // record is a real command since L3.4: an unknown option is a usage error, --url goes alone.
    expect((await retake('record', 'demo', '--whatever')).code).toBe(EXIT.usage);
    expect((await retake('record', 'demo', '--url', 'https://app.staging.example.com/', '--page', 'app')).code).toBe(EXIT.usage);
    // mcp is a real command since L3.1: an unknown option is a usage error (the server itself: packages/mcp/test).
    expect((await retake('mcp', '--whatever')).code).toBe(EXIT.usage);
    // render (L2.4), review (L2.6) and export (L2.8) are real commands: an unknown option is a usage error.
    expect((await retake('render', 'demo', 'good', '--whatever')).code).toBe(EXIT.usage);
    expect((await retake('review', 'demo', 'latest', '--whatever')).code).toBe(EXIT.usage);
    expect((await retake('export', 'demo', 'latest', '--whatever')).code).toBe(EXIT.usage);
    expect((await retake('export', 'demo', 'latest', '--formats', 'mp4_1080p,avi')).code).toBe(EXIT.usage);
  });

  it('reports hook sources that do not exist', async () => {
    const reset = await retake('hooks', 'run', 'demo', 'reset');
    expect(reset.code).toBe(EXIT.failure);
    expect(reset.err).toContain('declares no reset hooks');
    const rb = await retake('hooks', 'rollback', 'demo');
    expect(rb.code).toBe(EXIT.ok);
    expect(rb.err).toContain('no pending rollbacks');
  });
});

describe('retake journal: the workspace journal', () => {
  it('lists the authored writes and the hook runs of the workspace, who made them and their outcome', async () => {
    // `retake new demo` (above) wrote the project's files through the project store, as the person's.
    const writes = await retake('journal', '--writes', '--project', 'demo', '--json');
    expect(writes.code, writes.err).toBe(EXIT.ok);
    const lines = (JSON.parse(writes.out) as { entries: Array<{ by: { client: string }; op: string; what: string; path: string; outcome: string }> }).entries;
    expect(lines.filter((e) => e.what === 'project').map((e) => e.path)).toEqual(
      ['scenarios/.gitkeep', 'hooks/.gitkeep', 'assets/.gitkeep', 'project.yaml', 'README.md', '.gitignore'].map((f) => `projects/demo/${f}`),
    );
    expect(lines.every((e) => e.by.client === 'cli' && e.op === 'write')).toBe(true);
    // A hook run outside a capture: one line per hook, its name and outcome — never its command.
    const yaml = join(ws, 'projects', 'demo', 'project.yaml');
    const before = await readFile(yaml, 'utf8');
    await writeFile(yaml, `${before}reset:\n  - name: touch\n    shell: echo secret-value > touched.txt\n`);
    try {
      const run = await retake('hooks', 'run', 'demo', 'reset', '--env', 'staging', '--yes');
      expect(run.code, run.err).toBe(EXIT.ok);
      const hooks = await retake('journal', '--hooks');
      expect(hooks.code).toBe(EXIT.ok);
      expect(hooks.out).toMatch(/^\S+ \S+ {2}cli {2}hook reset touch \(shell\) demo · run \S+ {2}ok$/m);
      expect(hooks.out).not.toContain('secret-value');
      const all = await retake('journal', '--limit', '2');
      expect(all.out.trim().split('\n')).toHaveLength(2);
      expect((await retake('journal', '--writes', '--hooks')).code).toBe(EXIT.usage);
      expect((await retake('journal', '--limit', '0')).code).toBe(EXIT.usage);
    } finally {
      await writeFile(yaml, before);
    }
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

describe('sandboxes in validate, schema and env reset (L1.8)', () => {
  const SANDBOX = `version: 1
provider: process
services:
  app:
    command: [node, server.mjs]
    url: http://localhost:4691
    pages: {app: {url: http://localhost:4691, display: app.example.com}}
accounts:
  admin:
    pages: [app]
    username: admin@example.com
    password: demo
    check: {url: "app:/", expect_text: Admin}
`;

  it('validate reports each sandbox.yaml under its own file; a broken one fails every command, positioned in it', async () => {
    const dir = join(ws, 'projects', 'sbx');
    await mkdir(join(dir, 'sandbox'), { recursive: true });
    await mkdir(join(dir, 'scenarios'), { recursive: true });
    await writeFile(join(dir, 'project.yaml'), 'name: Sandbox demo\nsandboxes:\n  sandbox: sandbox/sandbox.yaml\n');
    await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), SANDBOX);
    await writeFile(join(dir, 'scenarios', 'home.yaml'), 'video: home\nenv: sandbox\nscenes:\n  - {id: a, page: app, persona: admin, open: /, steps: [{hold: 1}]}\n');
    const file = join(dir, 'sandbox', 'sandbox.yaml');

    const ok = await retake('validate', 'sbx');
    expect(ok.code, ok.err).toBe(EXIT.ok);
    expect(ok.err).toContain('✓ project sbx');
    expect(ok.err).toMatch(/✓ sandbox sandbox \S*sandbox\.yaml {2}1 warning/);
    expect(ok.err).toContain(`${file}:12:15 warning accounts.admin.password: a plain password shorter than 8 characters`);
    expect(ok.err).toMatch(/✓ scenario home/);
    const json = JSON.parse((await retake('validate', 'sbx', '--json')).out) as { files: Array<{ kind: string; name: string; file?: string }> };
    expect(json.files.map((f) => [f.kind, f.name])).toEqual([
      ['project', 'sbx'],
      ['sandbox', 'sandbox'],
      ['template', 'default'],
      ['scenario', 'home'],
    ]);

    await writeFile(file, SANDBOX.replace('http://localhost:4691, display', 'http://10.0.0.7:4691, display'));
    const bad = await retake('validate', 'sbx');
    expect(bad.code).toBe(EXIT.failure);
    expect(bad.err).toMatch(/✗ sandbox sandbox \S*sandbox\.yaml {2}1 error, 1 warning/);
    expect(bad.err).toContain(`${file}:7:24 error services.app.pages.app.url: page app 10.0.0.7 is not on this machine`);
    const badJson = JSON.parse((await retake('validate', 'sbx', '--json')).out) as { files: Array<{ kind: string; name: string; file?: string }> };
    expect(badJson.files.map((f) => [f.kind, f.name, f.file])).toEqual([['sandbox', 'sandbox', file]]);
    const run = await retake('run', 'sbx', 'home', '--dry');
    expect(run.code).toBe(EXIT.failure);
    expect(run.err).toContain(`sandbox sandbox ${file} has 1 error:`);
    await writeFile(file, SANDBOX);
  });

  it('prints the sandbox schema; env reset on a sandbox says how to restore its seed', async () => {
    const s = await retake('schema', 'sandbox');
    expect(s.code).toBe(EXIT.ok);
    expect((JSON.parse(s.out) as { $id: string }).$id).toBe('sandbox.schema.json');
    const reset = await retake('env', 'reset', 'sbx', '--env', 'sandbox', '--dry');
    expect(reset.code, reset.err).toBe(EXIT.ok);
    expect(reset.err).toContain('sandbox is a sandbox: `retake sandbox reset sbx --env sandbox` restores its seed');
  });
});
