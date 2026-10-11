import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_CAPTURE,
  ScenarioError,
  createProject,
  findWorkspaceRoot,
  listProjects,
  loadProject,
  loadScenario,
  loadWorkspaceConfig,
  parseProjectYaml,
  saveScenario,
  updateReadme,
} from '@demo-studio/core';
import { SPEC_EXAMPLE, SPEC_HOOK_FILES, STAGING, errors, tempDir, writeFiles } from './helpers.js';

let ws: { dir: string; cleanup: () => Promise<void> };
const savedRoot = process.env.DEMO_STUDIO_ROOT;

beforeEach(async () => {
  delete process.env.DEMO_STUDIO_ROOT;
  ws = await tempDir();
});
afterEach(async () => {
  if (savedRoot === undefined) delete process.env.DEMO_STUDIO_ROOT;
  else process.env.DEMO_STUDIO_ROOT = savedRoot;
  await ws.cleanup();
});

describe('workspace', () => {
  it('findWorkspaceRoot: env override, studio.yaml, projects/ or templates/, else start', async () => {
    await writeFiles(ws.dir, { 'a/studio.yaml': 'projects_dir: work\n', 'a/b/c/.keep': '', 'd/templates/.keep': '', 'd/e/.keep': '' });
    expect(findWorkspaceRoot(join(ws.dir, 'a/b/c'))).toBe(join(ws.dir, 'a'));
    expect(findWorkspaceRoot(join(ws.dir, 'd/e'))).toBe(join(ws.dir, 'd'));
    process.env.DEMO_STUDIO_ROOT = join(ws.dir, 'd');
    expect(findWorkspaceRoot(join(ws.dir, 'a/b/c'))).toBe(join(ws.dir, 'd'));
  });

  it('loadWorkspaceConfig resolves dirs and validates studio.yaml', async () => {
    expect(await loadWorkspaceConfig(ws.dir)).toEqual({
      root: ws.dir,
      projectsDir: join(ws.dir, 'projects'),
      templatesDir: join(ws.dir, 'templates'),
      componentsDir: join(ws.dir, 'components'),
    });
    await writeFiles(ws.dir, { 'studio.yaml': 'projects_dir: work/projects\nffmpeg: /opt/ffmpeg\ncomponents_dir: ui/components\n' });
    expect(await loadWorkspaceConfig(ws.dir)).toMatchObject({
      projectsDir: join(ws.dir, 'work/projects'),
      componentsDir: join(ws.dir, 'ui/components'),
      ffmpeg: '/opt/ffmpeg',
    });
    await writeFiles(ws.dir, { 'studio.yaml': 'project_dir: x\n' });
    await expect(loadWorkspaceConfig(ws.dir)).rejects.toThrow(
      /studio\.yaml:1:1 error: unknown key "project_dir" \(did you mean "projects_dir"\?\)/,
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
      expect.arrayContaining(['runs/', 'renders/', 'review/', 'exports/', '.demo-studio/']),
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
    expect(loaded.config).toEqual({
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
      '2:8 expected a frame style (raw, card, browser, laptop, phone, tablet) or a layout component id "namespace/name" (lower-case letters, digits and "-", e.g. "studio/layout-card"), got "browsr" (did you mean "browser"?)',
      '3:16 must be ≥ 1, got 0',
    ]);
  });

  it('updateReadme', async () => {
    const p = await createProject(ws.dir, { name: 'Northfield', environments: STAGING });
    await updateReadme(p, '# Northfield\n\n## Product\nSpecialty coffee wholesale.');
    expect(p.readme).toBe('# Northfield\n\n## Product\nSpecialty coffee wholesale.\n');
    expect((await loadProject(p.dir)).readme).toBe(p.readme);
  });

  it('saveScenario refuses invalid scenarios, then loadScenario round-trips', async () => {
    const p = await createProject(ws.dir, { name: 'Northfield', environments: STAGING });
    const bad = SPEC_EXAMPLE.replace('click: {text: New import}', 'click: {txt: New import}');
    const err = await saveScenario(p, 'catalogue', bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScenarioError);
    expect((err as ScenarioError).message).toMatch(/catalogue\.yaml:\d+:\d+ error scenes\[0\]\.steps\[1\]\.click: unknown key "txt"/);
    expect(existsSync(join(p.dir, 'scenarios', 'catalogue.yaml'))).toBe(false);
    await expect(saveScenario(p, '../escape', SPEC_EXAMPLE)).rejects.toThrow(/invalid scenario name/);

    await writeFiles(p.dir, SPEC_HOOK_FILES);
    const saved = await saveScenario(p, 'catalogue', SPEC_EXAMPLE);
    expect(saved.file).toBe(join(p.dir, 'scenarios', 'catalogue.yaml'));
    expect(errors(saved.issues)).toEqual([]);
    expect(p.scenarios).toEqual(['catalogue']);

    const loaded = await loadScenario(p, 'catalogue');
    expect(loaded.name).toBe('catalogue');
    expect(loaded.text).toBe(SPEC_EXAMPLE);
    expect(loaded.scenario.scenes).toHaveLength(4);
    expect(loaded.issues.every((i) => i.severity === 'warning')).toBe(true);
    expect((await loadProject(p.dir)).scenarios).toEqual(['catalogue']);
    expect((await loadScenario(p, 'scenarios/catalogue.yaml')).file).toBe(saved.file);
    await expect(loadScenario(p, 'catalog')).rejects.toThrow(/scenario "catalog" not found .*\(did you mean "catalogue"\?\)/);
  });

  it('loadScenario throws ScenarioError carrying the issues', async () => {
    const p = await createProject(ws.dir, { name: 'Northfield', environments: STAGING });
    await writeFiles(p.dir, { 'scenarios/broken.yaml': 'video: broken\nscenes:\n  - id: a\n    open: /\n    steps: [{wait: soon}]\n' });
    const err = await loadScenario(p, 'broken').catch((e: unknown) => e);
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
      '  stagin: {profile: ~/.demo-studio/profiles/northfield}',
      'databases:',
      '  main: {url: "postgres://app:hunter2@db.staging.example.com/app"}',
      '  local: {url: "postgres://app:{{env:PGPASSWORD}}@db.staging.example.com/app"}',
      'reset:',
      '  - sql: "TRUNCATE offers"',
      '  - http: {url: "{{console}}/api/reset", method: POST}',
    ].join('\n');
    const { config, issues } = parseProjectYaml(text, '/nonexistent/northfield/project.yaml');
    expect(config).toBeUndefined();
    expect(errors(issues).map((i) => `${i.line} ${i.message}`)).toEqual([
      '2 unknown environment "prod" (available: staging)',
      '6 page key "vars" is reserved for templating ({{vars.…}})',
      '8 auth key "stagin" is not an environment (did you mean "staging"?) (available: staging)',
      '10 connection URL contains a clear-text password: use {{env:VAR}} or {{keychain:service/account}}',
      '13 destructive hook (SQL TRUNCATE) requires "confirm: true"',
    ]);
  });
});
