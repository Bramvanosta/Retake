/**
 * L7.27: who wrote the hooks of a scenario (the project's record of scenario writes, by hook surface; the workspace
 * journals for writes it does not hold; asked when it cannot be known), which shell hooks a run executes, and how the
 * listing renders them. The CLI's question is held in packages/cli/test/run-agent-hooks.test.ts.
 */
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY, parseScenario } from '@retake/core';
import { fileFacts, loadProject } from '@retake/core/io';
import type { Scenario } from '@retake/core';
import {
  callerOf,
  createEngine,
  enginePorts,
  hooksTrustView,
  hooksWrittenBy,
  trustScenarioHooks,
  ManualClock,
  journalFile,
  renderForListing,
  scenarioHookFiles,
  scenarioHooksCheck,
  scenarioHookSurface,
  scenarioShellHooks,
  scenarioWritesFile,
} from '../src/index.js';
import type { Engine } from '../src/index.js';
import { scratchHome } from '@retake/test-support/home';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let ws: string;
let projectDir: string;
let studio: Engine;
let mcp: Engine;
let person: Engine;
const retakeHome = scratchHome();
const PROJECT = {
  slug: 'demo',
  get dir() {
    return projectDir;
  },
};
const SCENES = 'scenes:\n  - id: home\n    page: app\n    open: /\n    steps:\n      - hold: 1\n';
const HOOKED = (v: string, cmd = 'touch a') => `video: ${v}\nsetup:\n  - shell: "${cmd}"\n${SCENES}`;
const parsed = (text: string): Scenario => parseScenario(text, {}).scenario as Scenario;
const TPL = { pages: { app: 'http://app.example.test' }, vars: { who: 'world' }, run: { id: '20260101-120000-x', dir: '/runs/20260101-120000-x' } };

const HOOKS = enginePorts().hooks;

async function author(name: string) {
  const file = join(projectDir, 'scenarios', `${name}.yaml`);
  const text = await readFile(file, 'utf8');
  const scenario = parsed(text);
  return hooksWrittenBy(ws, PROJECT, { file, sha256: sha(text), scenario }, { files: () => scenarioHookFiles(scenario, { dir: projectDir, root: ws, config: {} as never }, HOOKS) });
}

/** A journal line as the store writes one (store/journal.ts), for writes from before the project's record. */
async function journalLine(root: string, o: { path: string; sha256: string; trust: 'author' | 'mcp'; at: string }): Promise<void> {
  const client = o.trust === 'author' ? 'cli' : 'mcp';
  await mkdir(join(root, '.retake'), { recursive: true });
  await appendFile(
    journalFile(root),
    `${JSON.stringify({ v: 1, at: o.at, by: { client, channel: client, trust: o.trust }, project: 'demo', op: 'write', what: 'scenario', path: o.path, sha256: o.sha256, outcome: 'ok' })}\n`,
  );
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-agent-written-'));
  retakeHome.use(join(ws, '.home'));
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
  projectDir = join(ws, 'projects', 'demo');
  await mkdir(join(projectDir, 'scenarios'), { recursive: true });
  await writeFile(join(projectDir, 'project.yaml'), 'name: Demo\nenvironments:\n  staging:\n    app: http://app.example.test\ncapture: {width: 1280, height: 720, scale: 1, fps: 30}\n');
  studio = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
  mcp = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
  person = await createEngine({ root: ws, client: 'cli', autoStartWorker: false });
});

afterAll(async () => {
  retakeHome.restore();
  await rm(ws, { recursive: true, force: true });
});

describe('the shell hooks a run executes, rendered as they will run', () => {
  const sc = {
    setup: [{ http: { url: 'http://x.example.test' } }, { name: 'seed', shell: { run: 'touch {{vars.who}}', cwd: 'data', env: { A: '{{app}}/a', B: '{{env:TOKEN}}' }, rollback: 'rm {{who}}' } }],
    teardown: [{ shell: 'touch t' }, { sql: 'delete from t' }],
    hooks: { own: { shell: 'echo {{hooks.tok.json.id}} {{run.id}}' }, web: { js: 'return 1' } },
    scenes: [
      { id: 'a', page: 'app', steps: [{ hook: 'own' }, { hook: 'shared' }, { hook: 'web' }] },
      { id: 'b', page: 'app', skip: true, steps: [{ hook: 'skipped' }] },
    ],
  } as never;
  const project = { config: { hooks: { shared: [{ shell: 'touch p1' }, { http: { url: 'http://y.example.test' } }], skipped: { shell: 'touch never' } } } } as never;
  const t = (written: string, shown = written, unknown: string[] = []) => ({ written, shown, unknown });

  it('setup, teardown and the named hooks of its steps (the scenario’s, then project.yaml’s; a skipped scene’s left out), shell and sql (L7.33), with cwd, env and rollback', () => {
    expect(scenarioShellHooks(sc, project, TPL)).toEqual([
      {
        kind: 'shell',
        phase: 'setup',
        position: 2,
        name: 'seed',
        run: t('touch {{vars.who}}', 'touch world'),
        cwd: t('data'),
        env: [
          { name: 'A', value: t('{{app}}/a', 'http://app.example.test/a') },
          { name: 'B', value: t('{{env:TOKEN}}') },
        ],
        rollback: t('rm {{who}}', 'rm world'),
      },
      { kind: 'shell', phase: 'teardown', position: 1, run: t('touch t'), env: [] },
      { kind: 'sql', phase: 'teardown', position: 2, run: t('delete from t'), env: [] },
      {
        kind: 'shell',
        phase: 'step',
        position: 1,
        name: 'own',
        named: { name: 'own', source: 'scenario' },
        run: t('echo {{hooks.tok.json.id}} {{run.id}}', 'echo <unknown until the run: {{hooks.tok.json.id}}> 20260101-120000-x', ['{{hooks.tok.json.id}}']),
        env: [],
      },
      { kind: 'shell', phase: 'step', position: 1, name: 'shared', named: { name: 'shared', source: 'project' }, run: t('touch p1'), env: [] },
    ]);
    expect(scenarioShellHooks(sc, project, TPL, ['teardown']).map((h) => h.run.written)).toEqual(['touch t', 'delete from t']);
  });

  it('an sql hook (L7.33): its statements as they will run — a file read from the project folder —, its database key, its rollback', async () => {
    await mkdir(join(projectDir, 'hooks'), { recursive: true });
    await writeFile(join(projectDir, 'hooks', 'list.sql'), 'SELECT * FROM {{vars.who}};\n');
    const withSql = { setup: [{ name: 'q', sql: { file: 'hooks/list.sql', db: 'main', rollback: { file: 'hooks/none.sql' } } }, { sql: 'hooks/list.sql' }] } as never;
    const [one, two] = scenarioShellHooks(withSql, { config: {}, dir: projectDir } as never, TPL);
    expect(one).toEqual({
      kind: 'sql',
      phase: 'setup',
      position: 1,
      name: 'q',
      run: t('SELECT * FROM {{vars.who}};\n', 'SELECT * FROM world;\n'),
      file: 'hooks/list.sql',
      db: 'main',
      env: [],
      rollback: t('<hooks/none.sql cannot be read now: ENOENT>'),
      rollbackFile: 'hooks/none.sql',
    });
    expect(two).toMatchObject({ kind: 'sql', run: { shown: 'SELECT * FROM world;\n' }, file: 'hooks/list.sql' });
    expect(two!.db).toBeUndefined();
  });

  it('a path written with spaces is read as the run reads it: a spaced response is unknown until the run, a spaced account stays a token', () => {
    expect(renderForListing('echo {{ hooks . prev . body }} {{ accounts . x . password }}', { ...TPL, vars: { accounts: { x: { password: 'agent value' } } } }).shown).toBe(
      'echo <unknown until the run: {{hooks.prev.body}}> {{accounts.x.password}}',
    );
  });

  it('a secret or a sandbox account stays a token, a response is unknown until the run, a key the run does not have is said so', () => {
    expect(renderForListing('{{ keychain:a/b }} {{accounts.x.password}} {{response.json.id}} {{nope}} {{run.dir}}', TPL)).toEqual({
      written: '{{ keychain:a/b }} {{accounts.x.password}} {{response.json.id}} {{nope}} {{run.dir}}',
      shown: '{{keychain:a/b}} {{accounts.x.password}} <unknown until the run: {{response.json.id}}> <unknown key: {{nope}}> /runs/20260101-120000-x',
      unknown: ['{{response.json.id}}'],
    });
  });
});

describe('who wrote the hooks: the project’s record, by hook surface', () => {
  it('the surface is what the hooks run and are rendered with: a caption does not change it, a var or a hook does', () => {
    const base = parsed(HOOKED('s'));
    expect(scenarioHookSurface(parsed(HOOKED('s').replace('hold: 1', 'hold: 2')))).toBe(scenarioHookSurface(base));
    expect(scenarioHookSurface(parsed(HOOKED('s').replace('setup:', 'vars:\n  x: "1"\nsetup:')))).not.toBe(scenarioHookSurface(base));
    expect(scenarioHookSurface(parsed(HOOKED('s', 'touch b')))).not.toBe(scenarioHookSurface(base));
  });

  it('an agent’s save brings them; the same hooks saved again by anyone but the person keep them as they were; the person’s save, or changed hooks, decide', async () => {
    const a = await mcp.scenarios.save('demo', 'one', HOOKED('one'));
    expect(await author('one')).toMatchObject({ agent: true, by: { trust: 'mcp' } });
    // The Studio leaves the hooks as they were: still the agent's.
    const b = await studio.scenarios.save('demo', 'one', HOOKED('one').replace('hold: 1', 'hold: 2'), { ifMatch: a.hash });
    expect(await author('one')).toMatchObject({ agent: true, by: { client: 'mcp' } });
    // The person's save (the same hooks): the person's; the agent saving them again changes nothing.
    const c = await person.scenarios.save('demo', 'one', HOOKED('one'), { ifMatch: b.hash });
    expect(await author('one')).toEqual({ agent: false, why: 'record' });
    await mcp.scenarios.save('demo', 'one', `# again\n${HOOKED('one')}`, { ifMatch: c.hash });
    expect(await author('one')).toEqual({ agent: false, why: 'record' });
    // A Studio save that brings hooks: the Studio's (an agent channel).
    await studio.scenarios.save('demo', 'two', HOOKED('two'));
    expect(await author('two')).toMatchObject({ agent: true, by: { client: 'ui' } });
  });

  it('a Studio edit that leaves the hooks as they were (a caption) keeps them the person’s', async () => {
    const saved = await person.scenarios.save('demo', 'edited', HOOKED('edited'));
    await studio.scenarios.edit('demo', 'edited', { hash: saved.hash, edit: { kind: 'replace_text', text: HOOKED('edited').replace('hold: 1', 'hold: 3') } });
    expect(await readFile(join(projectDir, 'scenarios', 'edited.yaml'), 'utf8')).toContain('hold: 3');
    expect(await author('edited')).toEqual({ agent: false, why: 'record' });
    // The edit has its own line: the Studio's, its surface the one it found.
    const lines = (await readFile(scenarioWritesFile(projectDir), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { path: string; by: { client: string }; surface: string; prev_surface: string | null });
    const last = lines.at(-1)!;
    expect({ path: last.path, client: last.by.client, kept: last.prev_surface === last.surface }).toEqual({ path: 'scenarios/edited.yaml', client: 'ui', kept: true });
  });

  it('a hand edit: hooks as they were stay the agent’s; changed hooks are the person’s', async () => {
    await mcp.scenarios.save('demo', 'hand', HOOKED('hand'));
    const file = join(projectDir, 'scenarios', 'hand.yaml');
    await writeFile(file, `${HOOKED('hand')}# edited\n`);
    expect(await author('hand')).toMatchObject({ agent: true });
    await writeFile(file, HOOKED('hand', 'touch mine'));
    expect(await author('hand')).toEqual({ agent: false, why: 'unjournaled' });
  });

  it('the same file under another path (a link) is the same file', async () => {
    await mcp.scenarios.save('demo', 'linked', HOOKED('linked'));
    const file = join(projectDir, 'scenarios', 'linked.yaml');
    const link = join(ws, 'link-to-linked.yaml');
    await symlink(file, link);
    const text = await readFile(file, 'utf8');
    expect(await hooksWrittenBy(ws, PROJECT, { file: link, sha256: sha(text), scenario: parsed(text) })).toMatchObject({ agent: true });
  });
});

describe('who wrote the hooks: before the record, and when it cannot be known', () => {
  it('a write the record does not hold: the workspace journal’s newest write of those bytes, its own or the one found upward from the project', async () => {
    const file = join(projectDir, 'scenarios', 'old.yaml');
    const text = HOOKED('old');
    await writeFile(file, text);
    await journalLine(ws, { path: 'projects/demo/scenarios/old.yaml', sha256: sha(text), trust: 'mcp', at: '2026-01-01T00:00:00.000Z' });
    expect(await author('old')).toMatchObject({ agent: true });
    // Opened from another workspace: the one found upward from the project still holds the line.
    const other = await mkdtemp(join(tmpdir(), 'retake-agent-written-other-'));
    try {
      expect(await hooksWrittenBy(other, PROJECT, { file, sha256: sha(text), scenario: parsed(text) })).toMatchObject({ agent: true, by: { trust: 'mcp' } });
    } finally {
      await rm(other, { recursive: true, force: true });
    }
    await journalLine(ws, { path: 'projects/demo/scenarios/old.yaml', sha256: sha(text), trust: 'author', at: '2026-01-02T00:00:00.000Z' });
    expect(await author('old')).toEqual({ agent: false, why: 'journal' });
  });

  it('no record line, an agent’s write in the journal, then an edit by hand: asked (who brought the hooks is not known)', async () => {
    const file = join(projectDir, 'scenarios', 'unrecorded.yaml');
    const text = HOOKED('unrecorded');
    await writeFile(file, text);
    await journalLine(ws, { path: 'projects/demo/scenarios/unrecorded.yaml', sha256: sha(text), trust: 'mcp', at: '2026-01-01T00:00:00.000Z' });
    expect(await author('unrecorded')).toMatchObject({ agent: true, by: { trust: 'mcp' } });
    await writeFile(file, `${text}# a note\n`);
    expect(await author('unrecorded')).toEqual({ agent: true, unknown: 'an agent wrote this scenario in a write whose hook surface Retake did not record' });
  });

  it('the record read is that of the project holding the file, whichever project the command opened', async () => {
    await mkdir(join(ws, 'projects', 'other', 'scenarios'), { recursive: true });
    await writeFile(
      join(ws, 'projects', 'other', 'project.yaml'),
      'name: Other\nenvironments:\n  staging:\n    app: http://app.example.test\ncapture: {width: 1280, height: 720, scale: 1, fps: 30}\n',
    );
    await mcp.scenarios.save('other', 'theirs', HOOKED('theirs'));
    const file = join(ws, 'projects', 'other', 'scenarios', 'theirs.yaml');
    await writeFile(file, `${HOOKED('theirs')}# a note\n`);
    const text = await readFile(file, 'utf8');
    expect(await hooksWrittenBy(ws, PROJECT, { file, sha256: sha(text), scenario: parsed(text) })).toMatchObject({ agent: true, by: { trust: 'mcp' } });
  });

  it('the record is appended as the journal is: a torn last line closed first, never through a symbolic link', async () => {
    const record = scenarioWritesFile(projectDir);
    await appendFile(record, '{"v":1,"torn');
    await mcp.scenarios.save('demo', 'aftertorn', HOOKED('aftertorn'));
    expect(await author('aftertorn')).toMatchObject({ agent: true, by: { trust: 'mcp' } });
    const lines = readFileSync(record, 'utf8').split('\n');
    expect(lines.at(-2)).toContain('"path":"scenarios/aftertorn.yaml"');
    expect(lines.some((l) => l.startsWith('{"v":1,"torn{'))).toBe(false);
    // A record that is a link: never written through.
    const lonely = await mkdtemp(join(tmpdir(), 'retake-agent-written-link-'));
    try {
      const target = join(lonely, 'elsewhere.jsonl');
      await writeFile(target, '');
      const saved = readFileSync(record, 'utf8');
      await rm(record);
      await symlink(target, record);
      await mcp.scenarios.save('demo', 'vialink', HOOKED('vialink'));
      expect(readFileSync(target, 'utf8')).toBe('');
      await rm(record);
      await writeFile(record, saved);
    } finally {
      await rm(lonely, { recursive: true, force: true });
    }
  });

  it('an agent wrote the file before the record began, and no record brought its hooks: asked', async () => {
    const file = join(projectDir, 'scenarios', 'mixed.yaml');
    await writeFile(file, HOOKED('mixed'));
    await journalLine(ws, { path: 'projects/demo/scenarios/mixed.yaml', sha256: sha('older bytes'), trust: 'mcp', at: '2026-01-01T00:00:00.000Z' });
    const saved = await studio.scenarios.save('demo', 'mixed', `# caption\n${HOOKED('mixed')}`, { ifMatch: sha(HOOKED('mixed')) });
    expect(saved.hash).toBeTruthy();
    expect(await author('mixed')).toEqual({ agent: true, unknown: 'an agent wrote this scenario in a write whose hook surface Retake did not record' });
  });

  it('a record or a journal that cannot be read, no bytes, or a project of no workspace looked at: asked', async () => {
    const text = HOOKED('u');
    const file = join(projectDir, 'scenarios', 'one.yaml');
    expect(await hooksWrittenBy(ws, PROJECT, { file, scenario: parsed(text) })).toMatchObject({ agent: true, unknown: expect.stringContaining('bytes') });
    // A journal that is a folder.
    const broken = await mkdtemp(join(tmpdir(), 'retake-agent-written-broken-'));
    const loose = await mkdtemp(join(tmpdir(), 'retake-agent-written-loose-'));
    try {
      await mkdir(join(broken, '.retake', 'journal.jsonl'), { recursive: true });
      const lonely = { slug: 'lonely', dir: join(loose, 'lonely') };
      await mkdir(join(lonely.dir, 'scenarios'), { recursive: true });
      const f = join(lonely.dir, 'scenarios', 'x.yaml');
      await writeFile(f, text);
      expect(await hooksWrittenBy(broken, lonely, { file: f, sha256: sha(text), scenario: parsed(text) })).toMatchObject({
        agent: true,
        unknown: expect.stringContaining('the workspace journal cannot be read'),
      });
      // No workspace places it, and nothing decides: asked.
      expect(await hooksWrittenBy(loose, lonely, { file: f, sha256: sha(text), scenario: parsed(text) })).toMatchObject({
        agent: true,
        unknown: expect.stringContaining('projects folder of no workspace'),
      });
      // Its own record says the person: the person's.
      await mkdir(join(lonely.dir, '.retake'), { recursive: true });
      await writeFile(
        scenarioWritesFile(lonely.dir),
        `${JSON.stringify({ v: 1, at: '2026-01-01T00:00:00.000Z', path: 'scenarios/x.yaml', sha256: sha(text), surface: scenarioHookSurface(parsed(text)), prev_surface: null, by: { client: 'cli', channel: 'cli', trust: 'author' } })}\n`,
      );
      expect(await hooksWrittenBy(loose, lonely, { file: f, sha256: sha(text), scenario: parsed(text) })).toEqual({ agent: false, why: 'record' });
    } finally {
      await rm(broken, { recursive: true, force: true });
      await rm(loose, { recursive: true, force: true });
    }
  });
});

describe('a person’s trust (retake hooks trust)', () => {
  it('settles hooks whose writer could not be told (an agent’s write the record does not hold, then a hand edit); only a terminal’s caller may', async () => {
    const file = join(projectDir, 'scenarios', 'settle.yaml');
    const text = HOOKED('settle');
    await writeFile(file, text);
    await journalLine(ws, { path: 'projects/demo/scenarios/settle.yaml', sha256: sha(text), trust: 'mcp', at: '2026-01-01T00:00:00.000Z' });
    await writeFile(file, `${text}# a note\n`);
    expect(await author('settle')).toMatchObject({ agent: true, unknown: expect.any(String) });
    const project = await loadProject(projectDir, ws);
    const view = await hooksTrustView(ws, project, 'settle', { files: fileFacts(PERSON_POLICY), hooks: HOOKS });
    expect(view.hooks.map((h) => h.run.shown)).toEqual(['touch a']);
    const clock = new ManualClock(Date.parse('2026-11-12T10:00:00.000Z'));
    await expect(trustScenarioHooks(project, view, callerOf('mcp'), { clock, stores: enginePorts().stores })).rejects.toThrow('only a person in a terminal');
    await expect(trustScenarioHooks(project, view, callerOf('ui'), { clock, stores: enginePorts().stores })).rejects.toThrow('only a person in a terminal');
    expect(await author('settle')).toMatchObject({ agent: true });
    await trustScenarioHooks(project, view, callerOf('cli'), { clock, stores: enginePorts().stores });
    expect(await author('settle')).toEqual({ agent: false, why: 'record' });
  });
});

describe('a person’s trust binds the files its hooks read (L7.39)', () => {
  /** Setup runs a script (one in a folder an agent can write, too) and an sql file with its rollback's; teardown a js file and a script that does not exist yet. */
  const BOUND = (v: string) =>
    [
      `video: ${v}`,
      'setup:',
      '  - shell: "sh tools/seed.sh && sh scenarios/helper.sh tools/input.json"',
      '  - sql: {file: sql/seed.sql, rollback: {file: sql/undo.sql}}',
      'teardown:',
      '  - js: {file: tools/after.js}',
      '  - shell: "sh tools/later.sh || true"',
      SCENES,
    ].join('\n');
  const CODE = ['scenarios/helper.sh', 'sql/seed.sql', 'sql/undo.sql', 'tools/after.js', 'tools/seed.sh'];
  let project: Awaited<ReturnType<typeof loadProject>>;

  beforeAll(async () => {
    await mkdir(join(projectDir, 'tools'), { recursive: true });
    await mkdir(join(projectDir, 'sql'), { recursive: true });
    await writeFile(join(projectDir, 'tools', 'seed.sh'), 'echo seed\n');
    await writeFile(join(projectDir, 'tools', 'input.json'), '{}\n');
    await writeFile(join(projectDir, 'scenarios', 'helper.sh'), 'echo helper\n');
    await writeFile(join(projectDir, 'sql', 'seed.sql'), 'insert into t values (1);\n');
    await writeFile(join(projectDir, 'sql', 'undo.sql'), 'delete from t;\n');
    await writeFile(join(projectDir, 'tools', 'after.js'), 'return 1;\n');
    project = await loadProject(projectDir, ws);
  });

  /** What a run of `name` learns before its hooks run, as `retake run` reads it. */
  async function check(name: string, phases?: Array<'setup' | 'teardown' | 'step'>) {
    const file = join(projectDir, 'scenarios', `${name}.yaml`);
    const text = await readFile(file, 'utf8');
    return scenarioHooksCheck(ws, project, { file, sha256: sha(text), scenario: parsed(text) }, async () => TPL, HOOKS, phases);
  }
  const asked = async (name: string, phases?: Array<'setup' | 'teardown' | 'step'>) => (await check(name, phases)).ask;
  async function trust(name: string) {
    const view = await hooksTrustView(ws, project, name, { files: fileFacts(PERSON_POLICY), hooks: HOOKS });
    await trustScenarioHooks(project, view, callerOf('cli'), { clock: new ManualClock(Date.parse('2026-11-13T10:00:00.000Z')), stores: enginePorts().stores });
    return view;
  }

  it('the files are the hooks package’s trust list, code and data (an agent-writable script too), by project path, per phase', async () => {
    const files = await scenarioHookFiles(parsed(BOUND('list')), project, HOOKS);
    expect(Object.keys(files.code).sort()).toEqual(CODE);
    expect(Object.keys(files.data)).toEqual(['tools/input.json']);
    expect(files.code['sql/seed.sql']).toBe(sha('insert into t values (1);\n'));
    expect(Object.keys((await scenarioHookFiles(parsed(BOUND('list')), project, HOOKS, ['teardown'])).code)).toEqual(['tools/after.js']);
    // An sql file in a folder an agent can write, or outside the project: bound too (a run at a terminal reads it).
    await writeFile(join(projectDir, 'scenarios', 'extra.sql'), 'select 1;\n');
    const odd = { setup: [{ sql: { file: 'scenarios/extra.sql' } }, { js: { file: '../outside.js' } }] } as never;
    expect((await scenarioHookFiles(odd, project, HOOKS)).code).toEqual({ 'scenarios/extra.sql': sha('select 1;\n'), '../outside.js': 'unreadable' });
  });

  it('trusted, then unchanged: not asked, the run held to the files read; a file changed since: asked again, naming it; trusted again: not asked', async () => {
    await mcp.scenarios.save('demo', 'bound', BOUND('bound'));
    expect(await asked('bound')).toMatchObject({ by: { trust: 'mcp' } });
    const view = await trust('bound');
    expect(Object.keys(view.files.code).sort()).toEqual(CODE);
    const line = JSON.parse((await readFile(scenarioWritesFile(projectDir), 'utf8')).trim().split('\n').at(-1)!) as { files: unknown };
    expect(line.files).toEqual(JSON.parse(JSON.stringify(view.files)));
    const ok = await check('bound');
    expect(ok.ask).toBeNull();
    expect(ok.bound && Object.keys(ok.bound.code).sort()).toEqual(CODE);
    expect(await author('bound')).toMatchObject({ agent: false, why: 'record' });

    for (const f of ['tools/seed.sh', 'scenarios/helper.sh', 'sql/undo.sql', 'tools/after.js', 'tools/input.json']) {
      const before = await readFile(join(projectDir, f), 'utf8');
      await writeFile(join(projectDir, f), `${before}# more\n`);
      const found = await check('bound');
      expect(found.ask).toMatchObject({ files: [{ path: f, change: 'changed' }], at: '2026-11-13T10:00:00.000Z' });
      // The run is then held to the files as they are now (the person's yes is to these).
      expect(found.bound?.code[f] ?? found.bound?.data[f]).toBe(sha(`${before}# more\n`));
      await writeFile(join(projectDir, f), before);
      expect(await asked('bound')).toBeNull();
    }
    await writeFile(join(projectDir, 'sql', 'seed.sql'), 'insert into t values (2);\n');
    const found = await asked('bound');
    expect(found?.hooks.map((h) => h.kind)).toEqual(['shell', 'sql', 'shell']);
    expect(found).toMatchObject({ files: [{ path: 'sql/seed.sql', change: 'changed' }] });
    // Only the files of the hooks the command runs: a teardown-only command does not read the setup's.
    expect(await asked('bound', ['teardown'])).toBeNull();
    expect((await hooksTrustView(ws, project, 'bound', { files: fileFacts(PERSON_POLICY), hooks: HOOKS })).author).toMatchObject({ agent: true, files: [{ path: 'sql/seed.sql' }] });
    await trust('bound');
    expect(await asked('bound')).toBeNull();
  });

  it('a script the hooks newly run (one that did not exist when trusted): asked; a data file that appears: not', async () => {
    await mcp.scenarios.save('demo', 'later', BOUND('later'));
    await trust('later');
    expect(await asked('later')).toBeNull();
    await writeFile(join(projectDir, 'tools', 'later.sh'), 'echo later\n');
    try {
      expect(await asked('later')).toMatchObject({ files: [{ path: 'tools/later.sh', change: 'added' }] });
      expect(await asked('later', ['teardown'])).toMatchObject({ files: [{ path: 'tools/later.sh', change: 'added' }] });
    } finally {
      await rm(join(projectDir, 'tools', 'later.sh'), { force: true });
    }
    expect(await asked('later')).toBeNull();
    const input = join(projectDir, 'tools', 'input.json');
    await rm(input);
    try {
      await trust('later');
      await writeFile(input, '{"made":1}\n');
      expect(await asked('later')).toBeNull();
    } finally {
      await writeFile(input, '{}\n');
    }
  });

  it('a file that cannot be read: asked (fails closed), and still asked after trusting it', async () => {
    await mcp.scenarios.save('demo', 'locked', BOUND('locked'));
    await trust('locked');
    const file = join(projectDir, 'sql', 'undo.sql');
    await chmod(file, 0o000);
    try {
      expect(await asked('locked')).toMatchObject({ files: [{ path: 'sql/undo.sql', change: 'unreadable' }] });
      await trust('locked');
      expect(await asked('locked')).toMatchObject({ files: [{ path: 'sql/undo.sql', change: 'unreadable' }] });
    } finally {
      await chmod(file, 0o644);
    }
    expect(await asked('locked')).toMatchObject({ files: [{ path: 'sql/undo.sql', change: 'changed' }] });
  });

  it('a trust whose files are not checked (no reader given): asked; a person’s own scenario: unchanged, its files never read', async () => {
    await mcp.scenarios.save('demo', 'unchecked', BOUND('unchecked'));
    await trust('unchecked');
    const file = join(projectDir, 'scenarios', 'unchecked.yaml');
    const text = await readFile(file, 'utf8');
    expect(await hooksWrittenBy(ws, PROJECT, { file, sha256: sha(text), scenario: parsed(text) })).toMatchObject({ agent: true, unknown: expect.stringContaining('not checked') });

    await person.scenarios.save('demo', 'mine', BOUND('mine'));
    const before = await readFile(join(projectDir, 'tools', 'seed.sh'), 'utf8');
    await writeFile(join(projectDir, 'tools', 'seed.sh'), `${before}# mine\n`);
    try {
      expect(await check('mine')).toEqual({ ask: null });
      expect(await author('mine')).toEqual({ agent: false, why: 'record' });
    } finally {
      await writeFile(join(projectDir, 'tools', 'seed.sh'), before);
    }
  });

  it('a later write of the person’s that keeps the surface does not drop the binding', async () => {
    await mcp.scenarios.save('demo', 'kept', BOUND('kept'));
    await trust('kept');
    const text = await readFile(join(projectDir, 'scenarios', 'kept.yaml'), 'utf8');
    await person.scenarios.save('demo', 'kept', text.replace('hold: 1', 'hold: 2'), { ifMatch: sha(text) });
    expect(await asked('kept')).toBeNull();
    const before = await readFile(join(projectDir, 'tools', 'seed.sh'), 'utf8');
    await writeFile(join(projectDir, 'tools', 'seed.sh'), `${before}# later\n`);
    try {
      expect(await asked('kept')).toMatchObject({ files: [{ path: 'tools/seed.sh', change: 'changed' }] });
    } finally {
      await writeFile(join(projectDir, 'tools', 'seed.sh'), before);
    }
  });

  it('whatever the kinds: a phase with a js hook only is asked when its trusted file changed, with no hook listed', async () => {
    const JS = `video: jsonly\nsetup:\n  - js: {file: tools/after.js}\nteardown:\n  - shell: "touch done.txt"\n${SCENES}`;
    await mcp.scenarios.save('demo', 'jsonly', JS);
    // An agent's js-only phase is not asked about (R-SEC-38), its file read only to know there is one.
    expect(await asked('jsonly', ['setup'])).toBeNull();
    await trust('jsonly');
    expect(await check('jsonly', ['setup'])).toMatchObject({ ask: null, bound: { code: { 'tools/after.js': sha('return 1;\n') } } });
    const js = join(projectDir, 'tools', 'after.js');
    await writeFile(js, 'return 2;\n');
    try {
      expect(await asked('jsonly', ['setup'])).toEqual({ hooks: [], files: [{ path: 'tools/after.js', change: 'changed' }], at: '2026-11-13T10:00:00.000Z' });
    } finally {
      await writeFile(js, 'return 1;\n');
    }
    expect(await asked('jsonly', ['setup'])).toBeNull();
  });

  it('a file a writer of the command writes before its first reader: bound by the trust, not compared before the run, held to the trust; alone, a reader is checked', async () => {
    const GEN = `video: gen\nsetup:\n  - shell: "echo echo-gen > gen.sh"\n  - shell: "sh gen.sh"\n  - shell: "date +%N > out.txt"\n  - shell: "cat out.txt"\n  - shell: "echo dump > backup.sql"\nteardown:\n  - shell: "psql -f backup.sql"\n${SCENES}`;
    await writeFile(join(projectDir, 'gen.sh'), 'echo trusted\n');
    await writeFile(join(projectDir, 'out.txt'), 'old\n');
    await writeFile(join(projectDir, 'backup.sql'), 'old\n');
    await mcp.scenarios.save('demo', 'gen', GEN);
    const files = await scenarioHookFiles(parsed(GEN), project, HOOKS);
    expect(files).toEqual({
      code: { 'gen.sh': sha('echo trusted\n'), 'backup.sql': sha('old\n') },
      data: { 'out.txt': sha('old\n') },
      generated: ['backup.sql', 'gen.sh', 'out.txt'],
      codeOutputs: ['backup.sql', 'gen.sh'],
    });
    // The teardown alone: its dump has no writer in the command — read first, compared.
    expect((await scenarioHookFiles(parsed(GEN), project, HOOKS, ['teardown'])).generated).toBeUndefined();
    await trust('gen');
    const line = JSON.parse((await readFile(scenarioWritesFile(projectDir), 'utf8')).trim().split('\n').at(-1)!) as { files: Record<string, unknown> };
    expect(Object.keys(line.files).sort()).toEqual(['code', 'data']);
    for (const n of [1, 2]) {
      // What the run wrote last time.
      await writeFile(join(projectDir, 'gen.sh'), `echo run-${n}\n`);
      await writeFile(join(projectDir, 'out.txt'), `${n}\n`);
      await writeFile(join(projectDir, 'backup.sql'), `dump ${n}\n`);
      const c = await check('gen');
      expect(c.ask).toBeNull();
      // Held to the trust until a writer of the run changes them.
      expect(c.bound).toEqual({ code: { 'gen.sh': sha('echo trusted\n'), 'backup.sql': sha('old\n'), 'out.txt': sha('old\n') }, data: {}, codeOutputs: ['backup.sql', 'gen.sh'] });
      expect(await asked('gen', ['teardown'])).toMatchObject({ files: [{ path: 'backup.sql', change: 'changed' }] });
    }
  });

  it('a writer whose output a later hook runs as code: its inputs are bound as code — one that appears after the trust asks', async () => {
    const IN = `video: inputs\nsetup:\n  - shell: "cat n.txt > gen4.sh"\n  - shell: "sh gen4.sh"\n${SCENES}`;
    await rm(join(projectDir, 'n.txt'), { force: true });
    await mcp.scenarios.save('demo', 'inputs', IN);
    await trust('inputs');
    expect(await asked('inputs')).toBeNull();
    await writeFile(join(projectDir, 'n.txt'), 'touch pwned\n');
    try {
      expect(await asked('inputs')).toMatchObject({ files: [{ path: 'n.txt', change: 'added' }] });
      const files = await scenarioHookFiles(parsed(IN), project, HOOKS);
      expect(files.code['n.txt']).toBe(sha('touch pwned\n'));
      expect(files.codeOutputs).toEqual(['gen4.sh']);
    } finally {
      await rm(join(projectDir, 'n.txt'), { force: true });
    }
  });

  it('the inputs of every writer up a chain of plain redirects to a code reader are code (two and three writers)', async () => {
    const TWO = `video: chain2\nsetup:\n  - shell: "cat n1.txt > a1.txt"\n  - shell: "cat a1.txt > g1.sh"\n  - shell: "sh g1.sh"\n${SCENES}`;
    const THREE = `video: chain3\nsetup:\n  - shell: "cat n1.txt > a1.txt"\n  - shell: "cat a1.txt > b1.txt"\n  - shell: "cat b1.txt > g1.sh"\n  - shell: "sh g1.sh"\n${SCENES}`;
    // A cycle (each writer reads the other's output) ends.
    const CYCLE = `video: cycle\nsetup:\n  - shell: "cat c2.txt > c1.txt"\n  - shell: "cat c1.txt > c2.txt"\n  - shell: "sh c2.txt"\n${SCENES}`;
    expect((await scenarioHookFiles(parsed(TWO), project, HOOKS)).codeOutputs).toEqual(['a1.txt', 'g1.sh']);
    expect((await scenarioHookFiles(parsed(THREE), project, HOOKS)).codeOutputs).toEqual(['a1.txt', 'b1.txt', 'g1.sh']);
    expect((await scenarioHookFiles(parsed(CYCLE), project, HOOKS)).codeOutputs).toEqual(['c1.txt', 'c2.txt']);
    await rm(join(projectDir, 'n1.txt'), { force: true });
    for (const [name, text] of [
      ['chain2', TWO],
      ['chain3', THREE],
    ] as const) {
      await mcp.scenarios.save('demo', name, text);
      await trust(name);
      expect(await asked(name)).toBeNull();
    }
    await writeFile(join(projectDir, 'n1.txt'), 'touch pwned\n');
    try {
      for (const name of ['chain2', 'chain3']) expect(await asked(name)).toMatchObject({ files: [{ path: 'n1.txt', change: 'added' }] });
    } finally {
      await rm(join(projectDir, 'n1.txt'), { force: true });
    }
  });
});
