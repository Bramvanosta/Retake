/**
 * The WorkspaceReads port's contract (workspace-reads/reads.ts): what core's loaders answer on a workspace, whichever
 * disk the adapter reads — the disk's (diskWorkspaceReads, a temp folder) and the memory's (MemoryWorkspace) run the same
 * cases with the same expected values, the workspace's root aside. Each case writes its own folder under the root.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core/policy';
import { STARTER_TEMPLATES_DIR } from '@retake/core/io';
import type { WorkspaceReads } from '../src/index.js';

/** A workspace to read, at `root`: written by the case, read by `reads`. */
export interface ReadsFixture {
  reads: WorkspaceReads;
  /** An absolute folder no file is under yet (the disk's: its real path). */
  root: string;
  write(path: string, data: string | Buffer): Promise<void>;
  link(path: string, target: string): Promise<void>;
  folder(path: string): Promise<void>;
  cleanup(): Promise<void>;
}

const PROJECT = 'version: 1\nname: Demo\nenvironments:\n  local:\n    app: http://127.0.0.1:4999\n';
const SCENARIO = 'video: one\nscenes:\n  - id: a\n    page: app\n    open: /\n    steps:\n      - click: Go\n';

async function failure(p: Promise<unknown>): Promise<Error> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  if (!(e instanceof Error)) throw new Error('did not fail');
  return e;
}

export function workspaceReadsContract(name: string, make: () => Promise<ReadsFixture>): void {
  describe(`WorkspaceReads contract: ${name}`, () => {
    let f: ReadsFixture;
    let n = 0;
    /** A fresh workspace folder of the case. */
    const ws = () => join(f.root, `w${++n}`);
    /** A message with this workspace's folder named `<ws>`. */
    const shown = (m: string, dir: string) => m.split(dir).join('<ws>');

    beforeAll(async () => {
      f = await make();
    });
    afterAll(async () => {
      await f.cleanup();
    });

    it('the workspace: retake.yaml optional, its folders resolved; a broken one and a folder in its place refused in the loader’s words', async () => {
      const a = ws();
      await f.folder(a);
      expect(await f.reads.loadWorkspaceConfig(a)).toEqual({ root: a, projectsDir: join(a, 'projects'), templatesDir: join(a, 'templates'), componentsDir: join(a, 'components') });
      await f.write(join(a, 'retake.yaml'), 'version: 1\nprojects_dir: work\ntemplates_dir: themes\n');
      expect(await f.reads.loadWorkspaceConfig(a)).toMatchObject({ projectsDir: join(a, 'work'), templatesDir: join(a, 'themes') });
      expect(f.reads.findWorkspaceUpward(join(a, 'work', 'x', 'y'))).toBe(a);
      const b = ws();
      await f.write(join(b, 'retake.yaml'), 'version: 9\n');
      const bad = await failure(f.reads.loadWorkspaceConfig(b));
      expect([bad.name, shown(bad.message, b).split('\n')[0]]).toEqual(['ConfigError', 'workspace config <ws>/retake.yaml has 1 error:']);
      const c = ws();
      await f.folder(join(c, 'retake.yaml'));
      const dir = await failure(f.reads.loadWorkspaceConfig(c));
      expect(shown(dir.message, c)).toBe('cannot read <ws>/retake.yaml: EISDIR: illegal operation on a directory, read');
    });

    it('a path through a file is ENOTDIR, a link loop ELOOP — never "nothing there": the loaders that branch on ENOENT refuse them in node’s words', async () => {
      const a = ws();
      await f.write(join(a, 'file.txt'), 'a file');
      // A workspace under a file: its retake.yaml cannot be read (not "no retake.yaml, the defaults").
      const under = await failure(f.reads.loadWorkspaceConfig(join(a, 'file.txt', 'ws')));
      expect(shown(under.message, a)).toBe("cannot read <ws>/file.txt/ws/retake.yaml: ENOTDIR: not a directory, open '<ws>/file.txt/ws/retake.yaml'");
      // projects_dir a file: the list fails (not "no project").
      const b = ws();
      await f.write(join(b, 'retake.yaml'), 'version: 1\nprojects_dir: work.txt\n');
      await f.write(join(b, 'work.txt'), 'a file');
      const list = await failure(f.reads.listProjects(b));
      expect([(list as NodeJS.ErrnoException).code, shown(list.message, b)]).toEqual(['ENOTDIR', "ENOTDIR: not a directory, scandir '<ws>/work.txt'"]);
      // A sandbox manifest under a file: project.yaml's own check says it is not found in the project.
      await f.write(join(b, 'p', 'project.yaml'), `${PROJECT}sandboxes:\n  box: notes.txt/sandbox.yaml\n`);
      await f.write(join(b, 'p', 'notes.txt'), 'x');
      const manifest = await failure(f.reads.loadProject(join(b, 'p'), b));
      expect(shown(manifest.message, b)).toContain('error sandboxes.box: sandbox manifest "notes.txt/sandbox.yaml" not found in the project');
      // A link loop: retake.yaml cannot be read; a README in a loop is not shown, the project loads.
      const c = ws();
      await f.link(join(c, 'retake.yaml'), 'loop.yaml');
      await f.link(join(c, 'loop.yaml'), 'retake.yaml');
      const loop = await failure(f.reads.loadWorkspaceConfig(c));
      expect(shown(loop.message, c)).toBe("cannot read <ws>/retake.yaml: ELOOP: too many symbolic links encountered, open '<ws>/retake.yaml'");
      const d = ws();
      await f.write(join(d, 'projects', 'demo', 'project.yaml'), PROJECT);
      await f.link(join(d, 'projects', 'demo', 'docs'), 'docs2');
      await f.link(join(d, 'projects', 'demo', 'docs2'), 'docs');
      await f.link(join(d, 'projects', 'demo', 'README.md'), 'docs/README.md');
      expect((await f.reads.loadProject('demo', d)).readme).toBeNull();
      expect(f.reads.disk.readPlain(join(d, 'projects', 'demo', 'docs', 'README.md'), 100)).toMatchObject({ ok: false, reason: 'link' });
      expect(f.reads.disk.readPlain(join(a, 'file.txt', 'README.md'), 100)).toMatchObject({ ok: false, reason: 'missing' });
      const dirLoop = await failure(f.reads.disk.list(join(d, 'projects', 'demo', 'docs')));
      expect((dirLoop as NodeJS.ErrnoException).code).toBe('ELOOP');
    });

    it('the projects: folders holding a project.yaml, sorted, named by it (else the slug); hidden ones, files and a link to a folder left out', async () => {
      const a = ws();
      await f.write(join(a, 'projects', 'b', 'project.yaml'), PROJECT.replace('Demo', 'Bee'));
      await f.write(join(a, 'projects', 'a', 'project.yaml'), 'version: 1\nenvironments: {}\n');
      await f.write(join(a, 'projects', '.hidden', 'project.yaml'), PROJECT);
      await f.write(join(a, 'projects', 'c', 'notes.txt'), 'no project here');
      await f.write(join(a, 'projects', 'x.txt'), 'a file');
      await f.write(join(a, 'elsewhere', 'project.yaml'), PROJECT);
      await f.link(join(a, 'projects', 'linked'), '../elsewhere');
      expect(await f.reads.listProjects(a)).toEqual([
        { slug: 'a', name: 'a', dir: join(a, 'projects', 'a') },
        { slug: 'b', name: 'Bee', dir: join(a, 'projects', 'b') },
      ]);
    });

    it('a project loaded: its config, scenario names (sorted, .yaml and .yml once, hidden left out), README; not found with the available ones', async () => {
      const a = ws();
      const dir = join(a, 'projects', 'demo');
      await f.write(join(dir, 'project.yaml'), PROJECT);
      await f.write(join(dir, 'scenarios', 'two.yml'), SCENARIO);
      await f.write(join(dir, 'scenarios', 'one.yaml'), SCENARIO);
      await f.write(join(dir, 'scenarios', 'one.yml'), SCENARIO);
      await f.write(join(dir, 'scenarios', '.draft.yaml'), SCENARIO);
      await f.write(join(dir, 'scenarios', 'notes.txt'), 'x');
      await f.write(join(dir, 'README.md'), '# Demo\n');
      const p = await f.reads.loadProject('demo', a);
      expect([p.slug, p.dir, p.root, p.file, p.config.name, p.scenarios, p.readme]).toEqual(['demo', dir, a, join(dir, 'project.yaml'), 'Demo', ['one', 'two'], '# Demo\n']);
      expect((await f.reads.loadProject(dir)).slug).toBe('demo');
      const none = await failure(f.reads.loadProject('dmeo', a));
      expect([none.name, shown(none.message, a)]).toEqual(['ConfigError', 'project "dmeo" not found in <ws>/projects (did you mean "demo"?) (available: demo)']);
      const path = await failure(f.reads.loadProject(join(a, 'projects', 'nope')));
      expect(shown(path.message, a)).toBe('no project.yaml in <ws>/projects/nope');
    });

    it('a project.yaml with errors is refused with its issues; a sandbox manifest it names missing or broken, in the words of each check', async () => {
      const a = ws();
      await f.write(join(a, 'projects', 'bad', 'project.yaml'), 'version: 1\nname: Bad\nenvironments:\n  local: "not a page map"\n');
      const bad = await failure(f.reads.loadProject('bad', a));
      expect(bad.name).toBe('ConfigError');
      expect(shown(bad.message, a).split('\n')).toEqual([
        'project <ws>/projects/bad/project.yaml has 1 error:',
        expect.stringMatching(/^<ws>\/projects\/bad\/project\.yaml:4:10 error environments\.local: expected an environment mapping .*, got "not a page map"$/),
      ]);
      await f.write(join(a, 'projects', 'sb', 'project.yaml'), `${PROJECT}sandboxes:\n  box: sandbox/sandbox.yaml\n`);
      const sb = await failure(f.reads.loadProject('sb', a));
      // project.yaml's own check looks for the manifest through the disk's FileFacts.
      expect([sb.name, shown(sb.message, a)]).toEqual([
        'ConfigError',
        'project <ws>/projects/sb/project.yaml has 1 error:\n<ws>/projects/sb/project.yaml:7:8 error sandboxes.box: sandbox manifest "sandbox/sandbox.yaml" not found in the project',
      ]);
      await f.write(join(a, 'projects', 'sb', 'sandbox', 'sandbox.yaml'), 'version: 1\nprovider: nowhere\n');
      const broken = await failure(f.reads.loadProject('sb', a));
      expect([broken.name, shown(broken.message, a).split('\n')[0]]).toEqual(['ConfigError', 'sandbox box <ws>/projects/sb/sandbox/sandbox.yaml has 2 errors:']);
    });

    it('the README is read only as a small plain file: a link, a folder or one over the cap is not shown (the project still loads)', async () => {
      const a = ws();
      const mk = async (slug: string) => {
        await f.write(join(a, 'projects', slug, 'project.yaml'), PROJECT);
        return join(a, 'projects', slug);
      };
      await f.write(join(a, 'outside.md'), '# secret\n');
      await f.link(join(await mk('link'), 'README.md'), '../../outside.md');
      await f.folder(join(await mk('dir'), 'README.md'));
      await f.write(join(await mk('big'), 'README.md'), Buffer.alloc(2 * 1024 * 1024 + 1, 'a'));
      await f.write(join(await mk('cap'), 'README.md'), Buffer.alloc(2 * 1024 * 1024, 'a'));
      const readme = async (slug: string) => (await f.reads.loadProject(slug, a)).readme;
      expect(await readme('link')).toBeNull();
      expect(await readme('dir')).toBeNull();
      expect(await readme('big')).toBeNull();
      expect((await readme('cap'))?.length).toBe(2 * 1024 * 1024);
    });

    it('a scenario read once by name (.yaml, then .yml) or path, its bytes hashed; another hash refused unparsed; not found with the available ones', async () => {
      const a = ws();
      const dir = join(a, 'projects', 'demo');
      await f.write(join(dir, 'project.yaml'), PROJECT);
      await f.write(join(dir, 'scenarios', 'one.yaml'), SCENARIO);
      await f.write(join(dir, 'scenarios', 'old.yml'), SCENARIO.replace('one', 'old'));
      await f.write(join(dir, 'drafts', 'x.yaml'), SCENARIO);
      const p = await f.reads.loadProject('demo', a);
      const one = await f.reads.readScenarioSource(p, 'one');
      expect([one.name, one.file, one.text, one.sha256]).toEqual(['one', join(dir, 'scenarios', 'one.yaml'), SCENARIO, createHash('sha256').update(SCENARIO).digest('hex')]);
      expect((await f.reads.readScenarioSource(p, 'old')).file).toBe(join(dir, 'scenarios', 'old.yml'));
      expect((await f.reads.readScenarioSource(p, 'drafts/x.yaml')).file).toBe(join(dir, 'drafts', 'x.yaml'));
      const changed = await failure(f.reads.readScenarioSource(p, 'one', { expectSha256: '0'.repeat(64) }));
      expect([changed.name, changed.message]).toEqual(['ScenarioChangedError', expect.stringContaining('scenarios/one.yaml')]);
      const none = await failure(f.reads.readScenarioSource(p, 'onee'));
      expect([none.name, shown(none.message, a)]).toEqual(['ScenarioError', 'scenario "onee" not found in <ws>/projects/demo/scenarios (did you mean "one"?) (available: old, one)']);
      const loaded = await f.reads.loadScenario(p, 'one', { files: f.reads.fileFacts(PERSON_POLICY) });
      expect([loaded.name, loaded.scenario.scenes.map((s) => s.id)]).toEqual(['one', ['a']]);
    });

    it('the themes: the workspace’s before the starters, a folder of a starter’s name shadows it; missing assets and an unknown name in the loader’s words', async () => {
      const a = ws();
      const brand = join(a, 'templates', 'brand');
      await f.write(join(brand, 'template.yaml'), 'version: 1\nname: brand\nlogo: logo.svg\n');
      await f.folder(join(a, 'templates', 'motion'));
      await f.write(join(a, 'projects', 'demo', 'project.yaml'), `${PROJECT}template: brand\n`);
      const listed = (await f.reads.listTemplates(a)).map((t) => `${t.name}:${t.source}`);
      expect(listed).toEqual(['brand:workspace', 'default:starter', 'editorial:starter']);
      const files = f.reads.fileFacts(PERSON_POLICY);
      const missing = await failure(f.reads.loadTemplate('brand', a, { files }));
      expect([missing.name, shown(missing.message, a)]).toEqual([
        'ConfigError',
        'template "brand" (<ws>/templates/brand) is missing 5 asset files: logo.svg, fonts/Display.ttf, fonts/Body-Regular.ttf, fonts/Body-SemiBold.ttf, fonts/Body-Bold.ttf',
      ]);
      for (const asset of ['logo.svg', 'fonts/Display.ttf', 'fonts/Body-Regular.ttf', 'fonts/Body-SemiBold.ttf']) await f.write(join(brand, asset), 'x');
      const one = await failure(f.reads.loadTemplate('brand', a, { files }));
      expect(shown(one.message, a)).toBe('template "brand" (<ws>/templates/brand) is missing an asset file: fonts/Body-Bold.ttf');
      await f.write(join(brand, 'fonts/Body-Bold.ttf'), 'x');
      const p = await f.reads.loadProject('demo', a);
      const t = await f.reads.loadProjectTemplate(p, undefined, { files });
      expect([t.name, t.dir, t.assets.logo]).toEqual(['brand', brand, join(brand, 'logo.svg')]);
      expect((await f.reads.loadTemplate('editorial', a, { files })).dir).toBe(join(STARTER_TEMPLATES_DIR, 'editorial'));
      const shadow = await failure(f.reads.loadTemplate('motion', a, { files }));
      expect(shown(shadow.message, a)).toBe('template "motion": no template.yaml in <ws>/templates/motion (a workspace folder of that name takes precedence over the starter template)');
      const none = await failure(f.reads.loadTemplate('brnad', a, { files }));
      expect(shown(none.message, a)).toBe('template "brnad" not found in <ws>/templates or the starter templates (did you mean "brand"?) (available: brand, default, editorial)');
      expect(await f.reads.projectTemplateFolderId(p, 'brand')).toBe(`templates/brand`);
      expect(await f.reads.projectTemplateFolderId(p, 'default')).toBe('/starter:default');
      expect(await f.reads.projectTemplateFolderId(p, './themes/own')).toBe('projects/demo/themes/own');
    });

    it('a new project planned: its files named, not written; a taken slug and a folder that is not empty refused', async () => {
      const a = ws();
      await f.folder(a);
      const plan = await f.reads.planNewProject(a, { name: 'Acme Demo', environments: { local: { app: 'http://127.0.0.1:4999' } } });
      expect([plan.slug, plan.dir, plan.files.map((x) => x.ref)]).toEqual([
        'acme-demo',
        join(a, 'projects', 'acme-demo'),
        ['scenarios/.gitkeep', 'hooks/.gitkeep', 'assets/.gitkeep', 'project.yaml', 'README.md', '.gitignore'],
      ]);
      expect(await f.reads.listProjects(a)).toEqual([]);
      await f.write(join(a, 'projects', 'taken', 'project.yaml'), PROJECT);
      await f.write(join(a, 'projects', 'full', 'notes.txt'), 'x');
      const taken = await failure(f.reads.planNewProject(a, { name: 'Taken' }));
      expect(shown(taken.message, a)).toBe('project "taken" already exists (<ws>/projects/taken)');
      const full = await failure(f.reads.planNewProject(a, { name: 'Full' }));
      expect(shown(full.message, a)).toBe('cannot create project "full": <ws>/projects/full exists and is not empty');
    });
  });
}
