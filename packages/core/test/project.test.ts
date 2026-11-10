import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CAPTURE, ScenarioError, parseProjectYaml, parseScenario, PERSON_POLICY } from '@retake/core';
import { findWorkspaceRoot, listProjects, loadProject, loadScenario, loadWorkspaceConfig, fileFacts, nodeFileFacts } from '@retake/core/io';
import { SPEC_EXAMPLE, SPEC_HOOK_FILES, STAGING, createProject, errors, tempDir, writeFiles } from './helpers.js';

let ws: { dir: string; cleanup: () => Promise<void> };
const savedRoot = process.env.RETAKE_ROOT;

beforeEach(async () => {
  delete process.env.RETAKE_ROOT;
  ws = await tempDir();
});
afterEach(async () => {
  if (savedRoot === undefined) delete process.env.RETAKE_ROOT;
  else process.env.RETAKE_ROOT = savedRoot;
  await ws.cleanup();
});

describe('workspace', () => {
  it('findWorkspaceRoot: env override, retake.yaml, projects/ or templates/, else start', async () => {
    await writeFiles(ws.dir, { 'a/retake.yaml': 'projects_dir: work\n', 'a/b/c/.keep': '', 'd/templates/.keep': '', 'd/e/.keep': '' });
    expect(findWorkspaceRoot(join(ws.dir, 'a/b/c'))).toBe(join(ws.dir, 'a'));
    expect(findWorkspaceRoot(join(ws.dir, 'd/e'))).toBe(join(ws.dir, 'd'));
    process.env.RETAKE_ROOT = join(ws.dir, 'd');
    expect(findWorkspaceRoot(join(ws.dir, 'a/b/c'))).toBe(join(ws.dir, 'd'));
  });

  it('loadWorkspaceConfig resolves dirs and validates retake.yaml', async () => {
    expect(await loadWorkspaceConfig(ws.dir)).toEqual({
      root: ws.dir,
      projectsDir: join(ws.dir, 'projects'),
      templatesDir: join(ws.dir, 'templates'),
      componentsDir: join(ws.dir, 'components'),
    });
    await writeFiles(ws.dir, { 'retake.yaml': 'projects_dir: work/projects\nffmpeg: /opt/ffmpeg\ncomponents_dir: ui/components\n' });
    expect(await loadWorkspaceConfig(ws.dir)).toMatchObject({
      projectsDir: join(ws.dir, 'work/projects'),
      componentsDir: join(ws.dir, 'ui/components'),
      ffmpeg: '/opt/ffmpeg',
    });
    await writeFiles(ws.dir, { 'retake.yaml': 'project_dir: x\n' });
    await expect(loadWorkspaceConfig(ws.dir)).rejects.toThrow(
      /retake\.yaml:1:1 error: unknown key "project_dir" \(did you mean "projects_dir"\?\)/,
    );
  });
});

describe('projects', () => {
  it('createProject → loadProject round trip', async () => {
    const created = await createProject(ws.dir, {
      name: 'Northfield Wholesale',
      environments: STAGING,
      capture: { scale: 2 },
      frame: 'browser',
    });
    expect(created.slug).toBe('northfield-wholesale');
    const dir = join(ws.dir, 'projects', 'northfield-wholesale');
    expect(created.dir).toBe(dir);
    for (const f of ['README.md', 'project.yaml', '.gitignore', 'scenarios', 'hooks', 'assets']) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    expect((await readFile(join(dir, '.gitignore'), 'utf8')).split('\n')).toEqual(
      expect.arrayContaining(['runs/', 'renders/', 'review/', 'exports/', '.retake/']),
    );
    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    for (const h of ['# Northfield Wholesale', '## Product', '## Audience', '## Goals', '## Tone', '## Environments & links', '## Accounts (by reference — never passwords)', "## Do / Don't"]) {
      expect(readme).toContain(h);
    }
    expect(readme).toContain('- staging · console: https://console.staging.example.com');

    const loaded = await loadProject('northfield-wholesale', ws.dir);
    expect(loaded).toEqual(created);
    expect(loaded.root).toBe(ws.dir);
    expect(loaded.readme).toBe(readme);
    expect(loaded.scenarios).toEqual([]);
    expect(loaded.issues).toEqual([]);
    // `retake new` writes the format version first (R-PRIN-13).
    expect((await readFile(join(dir, 'project.yaml'), 'utf8')).split('\n').slice(0, 2)).toEqual(['# Retake project "northfield-wholesale"', 'version: 1']);
    expect(loaded.config).toEqual({
      version: 1,
      name: 'Northfield Wholesale',
      environments: STAGING,
      capture: { ...DEFAULT_CAPTURE, scale: 2 },
      frame: 'browser',
      template: 'default',
    });
    // by directory path too
    expect((await loadProject(dir)).config.name).toBe('Northfield Wholesale');
    expect(await listProjects(ws.dir)).toEqual([{ slug: 'northfield-wholesale', name: 'Northfield Wholesale', dir }]);
  });

  it('createProject refuses duplicates and invalid input; custom readme is kept', async () => {
    const p = await createProject(ws.dir, { name: 'Northfield', readme: '# Northfield\n\nCoffee wholesale.' });
    expect(p.readme).toBe('# Northfield\n\nCoffee wholesale.\n');
    expect(p.issues?.map((i) => i.message)).toEqual([
      'no environments yet: add environments.<env>.<page>: <url> before running scenarios',
    ]);
    await expect(createProject(ws.dir, { name: 'Northfield' })).rejects.toThrow(/project "northfield" already exists/);
    await expect(createProject(ws.dir, { name: 'X', slug: 'Bad Slug' })).rejects.toThrow(/invalid project slug "Bad Slug"/);
    await expect(
      createProject(ws.dir, { name: 'Y', environments: { staging: { console: 'not a url' } } }),
    ).rejects.toThrow(/environments\.staging\.console: expected an absolute http\(s\) URL/);
  });

  it('loadProject: helpful not-found error and defaults', async () => {
    await writeFiles(ws.dir, { 'projects/northfield/project.yaml': 'name: Northfield\n' });
    await expect(loadProject('northfeld', ws.dir)).rejects.toThrow(
      /project "northfeld" not found in .*projects \(did you mean "northfield"\?\) \(available: northfield\)/,
    );
    const p = await loadProject('northfield', ws.dir);
    expect(p.config).toEqual({
      name: 'Northfield',
      environments: {},
      capture: DEFAULT_CAPTURE,
      frame: 'card',
      template: 'default',
    });
    expect(p.readme).toBeNull();
  });

  it('loadProject throws ConfigError with positioned issues', async () => {
    await writeFiles(ws.dir, { 'projects/p/project.yaml': 'name: P\nframe: browsr\ncapture: {fps: 0}\n' });
    const err = await loadProject('p', ws.dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(errors((err as ConfigError).issues).map((i) => `${i.line}:${i.col} ${i.message}`)).toEqual([
      '2:8 expected a frame style (raw, card, browser, laptop, phone, tablet, split, pip) or a layout component id "namespace/name" (lower-case letters, digits and "-", e.g. "studio/layout-card"), got "browsr" (did you mean "browser"?)',
      '3:16 must be ≥ 1, got 0',
    ]);
  });

  it('an invalid scenario text has error issues (the engine refuses to save it); a valid one written loadScenario round-trips', async () => {
    const p = await createProject(ws.dir, { name: 'Northfield', environments: STAGING });
    const file = join(p.dir, 'scenarios', 'catalogue.yaml');
    await writeFiles(p.dir, SPEC_HOOK_FILES);
    const bad = SPEC_EXAMPLE.replace('click: {text: New import}', 'click: {txt: New import}');
    expect(errors(parseScenario(bad, { files: fileFacts(PERSON_POLICY), file, project: p }).issues).map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual(['scenes.0.steps.1.click: unknown key "txt" (did you mean "text"?)']);
    expect(existsSync(file)).toBe(false);
    expect(errors(parseScenario(SPEC_EXAMPLE.trimEnd(), { files: fileFacts(PERSON_POLICY), file, project: p }).issues)).toEqual([]);
    expect(existsSync(file)).toBe(false);
    await writeFiles(p.dir, { 'scenarios/catalogue.yaml': SPEC_EXAMPLE });
    p.scenarios = ['catalogue'];

    const loaded = await loadScenario(p, 'catalogue', { files: fileFacts(PERSON_POLICY) });
    expect(loaded.name).toBe('catalogue');
    expect(loaded.text).toBe(SPEC_EXAMPLE);
    expect(loaded.scenario.scenes).toHaveLength(4);
    expect(loaded.issues.every((i) => i.severity === 'warning')).toBe(true);
    expect((await loadProject(p.dir)).scenarios).toEqual(['catalogue']);
    expect((await loadScenario(p, 'scenarios/catalogue.yaml', { files: fileFacts(PERSON_POLICY) })).file).toBe(file);
    await expect(loadScenario(p, 'catalog', { files: fileFacts(PERSON_POLICY) })).rejects.toThrow(/scenario "catalog" not found .*\(did you mean "catalogue"\?\)/);
  });

  it('loadScenario throws ScenarioError carrying the issues', async () => {
    const p = await createProject(ws.dir, { name: 'Northfield', environments: STAGING });
    await writeFiles(p.dir, { 'scenarios/broken.yaml': 'video: broken\nscenes:\n  - id: a\n    open: /\n    steps: [{wait: soon}]\n' });
    const err = await loadScenario(p, 'broken', { files: fileFacts(PERSON_POLICY) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScenarioError);
    expect((err as ScenarioError).issues).toEqual([
      { severity: 'error', path: ['scenes', 0, 'steps', 0, 'wait'], message: 'expected a number, got "soon"', line: 5, col: 20 },
    ]);
  });
});

describe('parseProjectYaml semantic checks', () => {
  it('environments, default_env, auth, databases and reset hooks', () => {
    const text = [
      'name: Northfield',
      'default_env: prod',
      'environments:',
      '  staging:',
      '    console: https://console.staging.example.com',
      '    vars: https://x.example.com',
      'auth:',
      '  stagin: {profile: ~/.retake/profiles/northfield}',
      'databases:',
      '  main: {url: "postgres://app:hunter2@db.staging.example.com/app"}',
      '  local: {url: "postgres://app:{{env:PGPASSWORD}}@db.staging.example.com/app"}',
      'reset:',
      '  - sql: "TRUNCATE offers"',
      '  - http: {url: "{{console}}/api/reset", method: POST}',
      'vars: {agent: "{{env:AGENT_EMAIL}}", plain: Harbour Coffee Co.}',
    ].join('\n');
    const { config, issues } = parseProjectYaml(text, '/nonexistent/northfield/project.yaml', nodeFileFacts);
    expect(config).toBeUndefined();
    expect(errors(issues).map((i) => `${i.line} ${i.message}`)).toEqual([
      '2 unknown environment "prod" (available: staging)',
      '6 page key "vars" is reserved for templating ({{vars.…}})',
      '8 auth key "stagin" is not an environment (did you mean "staging"?) (available: staging)',
      '10 connection URL contains a clear-text password: use {{env:VAR}} or {{keychain:service/account}}',
      '13 destructive hook (SQL TRUNCATE) requires "confirm: true"',
      // vars values are inserted as written (L1.2 review: D5).
      '15 {{env:AGENT_EMAIL}}: a vars value is not templated (it would be inserted as written): write the value, or put the token where the variable is used',
    ]);
  });

  it('reset shell hooks are checked against the project\'s own environments and allow_hosts (R-SEC-06)', () => {
    const text = [
      'name: Northfield',
      'environments:',
      '  staging: {console: https://console.staging.example.com}',
      'allow_hosts: [db.staging.example.com]',
      'reset:',
      '  - shell: "psql -h db.staging.example.com -c \'select 1\' && curl -fsS https://console.staging.example.com/api/reset"',
      '  - shell: "pg_restore --host db.prod.example.com demo.dump"',
    ].join('\n');
    const { issues } = parseProjectYaml(text, '/nonexistent/northfield/project.yaml', nodeFileFacts);
    expect(errors(issues).map((i) => `${i.line} ${i.message}`)).toEqual([
      '7 shell hook names host db.prod.example.com (pg_restore -h): it is not allowed: use localhost, an environment host, or add it to allow_hosts (allowed: localhost, 127.0.0.1, ::1, console.staging.example.com, db.staging.example.com)',
    ]);
  });
});
