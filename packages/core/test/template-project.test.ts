/**
 * R-SHR-10, R-SHR-11: a project's own themes. A name is looked for in `<project>/templates/<name>/` first, then
 * the workspace's templates_dir, then the starters; a path reference is unchanged. Lists for a project hold the winners
 * only, each with its origin, a project theme hiding another saying which (`shadows`). A project theme's identity
 * (`template_folder`) is project-relative (`/project:templates/<name>`), so a moved or re-imported project keeps it;
 * the older workspace-relative form still reads.
 */
import { cp, mkdir, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERSON_POLICY, projectFileProblem, agentWritablePath, PROJECT_LIBRARY_PATHS, projectLibraryPath } from '@retake/core';
import { PROJECT_LIBRARY_DIRS } from '@retake/core/project';
import {
  STARTER_TEMPLATES_DIR,
  fileFacts,
  listTemplates,
  loadProject,
  loadProjectTemplate,
  loadTemplate,
  nodeFileFacts,
  projectTemplateFolderId,
  sameTemplateFolder,
  templateFolderId,
} from '@retake/core/io';
import { createProject, tempDir, writeFiles } from './helpers.js';

const ASSETS = {
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'fonts/Display.ttf': 'x',
  'fonts/Body-Regular.ttf': 'x',
  'fonts/Body-SemiBold.ttf': 'x',
  'fonts/Body-Bold.ttf': 'x',
};
const theme = (prefix: string, yaml: string): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(ASSETS).map(([k, v]) => [`${prefix}/${k}`, v])),
  [`${prefix}/template.yaml`]: yaml,
});
const files = { files: fileFacts(PERSON_POLICY) };

let ws: { dir: string; cleanup: () => Promise<void> };
beforeEach(async () => {
  ws = await tempDir();
});
afterEach(() => ws.cleanup());

describe('a project theme is found first (R-SHR-10)', () => {
  it('project → workspace → starter, for loadProjectTemplate and loadTemplate with the project', async () => {
    const p = await createProject(ws.dir, { name: 'Demo' });
    await writeFiles(ws.dir, { ...theme('templates/brand', 'name: Workspace\n'), ...theme('templates/other', 'name: Other\n') });
    await writeFiles(p.dir, { ...theme('templates/brand', 'name: Mine\n'), ...theme('templates/editorial', 'name: My editorial\n') });
    const mine = await loadProjectTemplate(p, 'brand', files);
    expect([mine.dir, mine.template.name]).toEqual([join(p.dir, 'templates/brand'), 'Mine']);
    expect((await loadProjectTemplate(p, 'editorial', files)).dir).toBe(join(p.dir, 'templates/editorial'));
    expect((await loadProjectTemplate(p, 'other', files)).dir).toBe(join(ws.dir, 'templates/other'));
    expect((await loadProjectTemplate(p, 'motion', files)).dir).toBe(join(STARTER_TEMPLATES_DIR, 'motion'));
    expect((await loadTemplate('brand', ws.dir, { ...files, projectDir: p.dir })).dir).toBe(join(p.dir, 'templates/brand'));
    // No project named: today's answer (the workspace's).
    expect((await loadTemplate('brand', ws.dir, files)).dir).toBe(join(ws.dir, 'templates/brand'));
  });

  it('a project folder without template.yaml takes precedence, and its error says so; an unknown name lists the three places', async () => {
    const p = await createProject(ws.dir, { name: 'Demo' });
    await writeFiles(ws.dir, theme('templates/brand', ''));
    await writeFiles(p.dir, { 'templates/brand/README.md': 'work in progress' });
    await expect(loadProjectTemplate(p, 'brand', files)).rejects.toThrow(/template "brand": no template\.yaml in .*demo\/templates\/brand \(a folder of the project's templates\/ takes precedence/);
    await expect(loadProjectTemplate(p, 'nope', files)).rejects.toThrow(/template "nope" not found in .*demo\/templates, .*\/templates or the starter templates/);
  });

  it('a path reference is unchanged (against the project folder), and a name never leaves the three folders', async () => {
    const p = await createProject(ws.dir, { name: 'Demo' });
    await writeFiles(p.dir, { ...theme('themes/brand', 'name: Path\n'), ...theme('templates/brand', 'name: Named\n') });
    expect((await loadProjectTemplate(p, './themes/brand', files)).template.name).toBe('Path');
    expect((await loadProjectTemplate(p, 'templates/brand', files)).template.name).toBe('Named');
    await expect(loadProjectTemplate(p, 'themes', files)).rejects.toThrow(/not found/);
  });

  it("a project whose templates/ is the workspace's templates_dir has no theme of its own (nothing shadows itself)", async () => {
    await writeFiles(ws.dir, { 'retake.yaml': 'templates_dir: projects/main/templates\n' });
    const p = await createProject(ws.dir, { name: 'Main' });
    await writeFiles(p.dir, theme('templates/brand', ''));
    const listed = await listTemplates(ws.dir, { projectDir: p.dir });
    expect(listed.find((t) => t.name === 'brand')).toEqual({ name: 'brand', dir: join(p.dir, 'templates/brand'), source: 'workspace' });
  });
});

describe('lists say each theme origin (R-SHR-11)', () => {
  it('winners only, sorted, a project theme saying what it hides; no project: today', async () => {
    const p = await createProject(ws.dir, { name: 'Demo' });
    await writeFiles(ws.dir, { ...theme('templates/brand', ''), ...theme('templates/house', '') });
    await writeFiles(p.dir, { ...theme('templates/brand', ''), ...theme('templates/motion', ''), ...theme('templates/solo', ''), 'templates/default/README.md': 'wip' });
    expect((await listTemplates(ws.dir, { projectDir: p.dir })).map((t) => `${t.name}:${t.source}${t.shadows ? `>${t.shadows}` : ''}`)).toEqual([
      'brand:project>workspace',
      'editorial:starter',
      'house:workspace',
      'motion:project>starter',
      'solo:project',
    ]);
    expect((await listTemplates(ws.dir)).map((t) => `${t.name}:${t.source}`)).toEqual(['brand:workspace', 'default:starter', 'editorial:starter', 'house:workspace', 'motion:starter']);
  });
});

describe("a project theme's identity is project-relative", () => {
  it('/project:<path> for a folder inside the project, the older workspace-relative form read as the same', async () => {
    const p = await createProject(ws.dir, { name: 'Demo' });
    await writeFiles(ws.dir, theme('templates/brand', ''));
    await writeFiles(p.dir, { ...theme('templates/brand', ''), ...theme('themes/own', '') });
    const id = await projectTemplateFolderId(p, 'brand');
    expect(id).toBe('/project:templates/brand');
    expect(await projectTemplateFolderId(p, './themes/own')).toBe('/project:themes/own');
    expect(templateFolderId(join(p.dir, 'templates/brand'), p.root, p.dir)).toBe(id);
    // Without the project: today's workspace-relative id.
    expect(templateFolderId(join(p.dir, 'templates/brand'), p.root)).toBe('projects/demo/templates/brand');
    expect(sameTemplateFolder('projects/demo/templates/brand', id!, p)).toBe(true);
    expect(sameTemplateFolder('templates/brand', id!, p)).toBe(false);
    expect(sameTemplateFolder('/starter:default', '/starter:default', p)).toBe(true);
  });

  it('the same id once the project is moved to another workspace (a copy of the folder alone)', async () => {
    const p = await createProject(ws.dir, { name: 'Demo' });
    await writeFiles(p.dir, theme('templates/brand', ''));
    const before = await projectTemplateFolderId(p, 'brand');
    const other = join(ws.dir, 'b');
    await mkdir(join(other, 'projects'), { recursive: true });
    await writeFiles(other, { 'retake.yaml': '' });
    await cp(p.dir, join(other, 'projects', 'renamed'), { recursive: true });
    const moved = await loadProject(join(other, 'projects', 'renamed'), other);
    expect(await projectTemplateFolderId(moved, 'brand')).toBe(before);
  });

  it("a folder reached through a link into the project is the project's (real paths)", async () => {
    const p = await createProject(ws.dir, { name: 'Demo' });
    await writeFiles(p.dir, theme('templates/brand', ''));
    await rename(join(p.dir, 'templates'), join(p.dir, 'real-templates'));
    await symlink(join(p.dir, 'real-templates'), join(p.dir, 'templates'));
    expect(await projectTemplateFolderId(p, 'brand')).toBe('/project:real-templates/brand');
  });
});

describe("the project's library folders are never code (R-SHR-15)", () => {
  it('PROJECT_LIBRARY_PATHS are the layout names', () => {
    expect(PROJECT_LIBRARY_PATHS).toEqual(Object.values(PROJECT_LIBRARY_DIRS).map((d) => `${d}/`));
    expect(projectLibraryPath('Templates/brand/x.js')).toBe(true);
    expect(projectLibraryPath('./components/acme/x/index.tsx')).toBe(true);
    expect(projectLibraryPath('hooks/setup.js')).toBe(false);
  });

  it('a hook js, sql or eval file under templates/, components/ or brand/ is refused as code; a plain file is read', async () => {
    const p = await createProject(ws.dir, { name: 'Demo' });
    await writeFiles(p.dir, { 'templates/brand/seed.sql': 'select 1', 'components/acme/x/run.js': '', 'brand/logo.svg': '<svg/>', 'hooks/ok.js': '' });
    for (const ref of ['templates/brand/seed.sql', 'components/acme/x/run.js', 'brand/logo.svg']) {
      expect(projectFileProblem(p.dir, ref, { code: true, files: nodeFileFacts })).toMatch(
        /is a file of the project's themes, components or brand files .*code is only run from files a human put elsewhere/,
      );
    }
    expect(projectFileProblem(p.dir, 'hooks/ok.js', { code: true, files: nodeFileFacts })).toBeNull();
    expect(projectFileProblem(p.dir, 'templates/brand/seed.sql', { code: false, files: nodeFileFacts })).toBeNull();
  });

  it('an agent-written shell command never names them', async () => {
    const p = await createProject(ws.dir, { name: 'Demo' });
    expect(agentWritablePath('templates/brand/run.sh', { projectDir: p.dir, files: nodeFileFacts })).toBe('templates/brand/run.sh');
    expect(agentWritablePath('../demo/brand/x.sh', { projectDir: p.dir, files: nodeFileFacts })).toBe('brand/x.sh');
    expect(agentWritablePath('hooks/run.sh', { projectDir: p.dir, files: nodeFileFacts })).toBeNull();
  });
});
