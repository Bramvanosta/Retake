/**
 * L7.27: who wrote the hooks of a scenario (the project's record of scenario writes, by hook surface; the workspace
 * journals for writes it does not hold; asked when it cannot be known), which shell hooks a run executes, and how the
 * listing renders them. The CLI's question is held in packages/cli/test/run-agent-hooks.test.ts.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  hooksTrustView,
  hooksWrittenBy,
  trustScenarioHooks,
  ManualClock,
  journalFile,
  renderForListing,
  scenarioHookSurface,
  scenarioShellHooks,
  scenarioWritesFile,
} from '../src/index.js';
import type { Engine } from '../src/index.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let ws: string;
let projectDir: string;
let studio: Engine;
let mcp: Engine;
let person: Engine;
const savedHome = process.env.RETAKE_HOME;
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

async function author(name: string) {
  const file = join(projectDir, 'scenarios', `${name}.yaml`);
  const text = await readFile(file, 'utf8');
  return hooksWrittenBy(ws, PROJECT, { file, sha256: sha(text), scenario: parsed(text) });
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
  process.env.RETAKE_HOME = join(ws, '.home');
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
  projectDir = join(ws, 'projects', 'demo');
  await mkdir(join(projectDir, 'scenarios'), { recursive: true });
  await writeFile(join(projectDir, 'project.yaml'), 'name: Demo\nenvironments:\n  staging:\n    app: http://app.example.test\ncapture: {width: 1280, height: 720, scale: 1, fps: 30}\n');
  studio = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
  mcp = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
  person = await createEngine({ root: ws, client: 'cli', autoStartWorker: false });
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
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
    const view = await hooksTrustView(ws, project, 'settle', { files: fileFacts(PERSON_POLICY) });
    expect(view.hooks.map((h) => h.run.shown)).toEqual(['touch a']);
    const clock = new ManualClock(Date.parse('2026-11-12T10:00:00.000Z'));
    await expect(trustScenarioHooks(project, view, callerOf('mcp'), clock)).rejects.toThrow('only a person in a terminal');
    await expect(trustScenarioHooks(project, view, callerOf('ui'), clock)).rejects.toThrow('only a person in a terminal');
    expect(await author('settle')).toMatchObject({ agent: true });
    await trustScenarioHooks(project, view, callerOf('cli'), clock);
    expect(await author('settle')).toEqual({ agent: false, why: 'record' });
  });
});
