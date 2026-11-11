/**
 * L7.9 (BL-164): the project board compares a scenario's theme with its renders' by the theme's folder — the
 * `template_folder` a render record holds since L7.9 (core io templateFolderId: relative to the workspace root, or
 * `starter:<name>`) — so two folders of one name at different paths are two themes. A record of before L7.9 holds no
 * folder: it is compared by its folder's name, as before. The folder's content is no part of it (decided): a theme
 * edited after a render keeps that render current.
 *
 * A temp workspace; hand-made take and records; nothing is rendered, no browser is opened, no job runs.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedProject } from '@retake/core';
import { STARTER_TEMPLATES_DIR, loadProject, projectTemplateFolderId, templateFolderId } from '@retake/core/io';
import { exportThemeRef } from '@retake/editor';
import type { RenderRecord } from '@retake/editor';
import { EngineError, createEngine } from '../src/index.js';
import type { Engine } from '../src/index.js';
import { makeCase, scenesTimeline, workspace } from '../../review/test/helpers.js';
import type { Case, Workspace } from '../../review/test/helpers.js';

const SCENARIO_YAML = 'video: quote\nscenes:\n  - id: one\n    open: /\n    steps:\n      - click: First\n';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const OWN = './themes/brand';
const SHARED = '../../shared/brand';

let ws: Workspace;
let engine: Engine;
let project: LoadedProject;
let demo: Case;
let yaml: string;
const savedHome = process.env.RETAKE_HOME;

/** renders/<id>.json and its (empty) video: the case's record under another id, theme folder and date. */
async function record(id: string, created_at: string, folder: string | undefined): Promise<void> {
  const dir = join(project.dir, 'renders');
  const r = {
    ...demo.record,
    id,
    template: 'brand',
    ...(folder !== undefined ? { template_folder: folder } : {}),
    created_at,
    overrides: {},
    edit: { from: 'scenario', sha256: sha(SCENARIO_YAML) },
    file: join(dir, `${id}.mp4`),
    record: join(dir, `${id}.json`),
  } as unknown as RenderRecord;
  if (folder === undefined) delete (r as { template_folder?: string }).template_folder;
  await writeFile(join(dir, `${id}.mp4`), '');
  await writeFile(join(dir, `${id}.json`), JSON.stringify(r));
}

const setTheme = (ref: string) => writeFile(join(project.dir, 'project.yaml'), `name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: ${ref}\n`);
const row = async () => {
  const s = (await engine.projects.board('demo')).scenarios.find((x) => x.name === 'quote');
  return [s?.render?.render_id, s?.render_current, s?.theme];
};
async function clearRenders(): Promise<void> {
  await rm(join(project.dir, 'renders'), { recursive: true, force: true });
  await mkdir(join(project.dir, 'renders'), { recursive: true });
}

beforeAll(async () => {
  ws = await workspace();
  process.env.RETAKE_HOME = join(ws.root, '.home');
  const dir = ws.project.dir;
  // Two theme folders of one name: the project's own and one shared beside the projects.
  await cp(join(STARTER_TEMPLATES_DIR, 'editorial'), join(dir, 'themes', 'brand'), { recursive: true });
  await cp(join(STARTER_TEMPLATES_DIR, 'motion'), join(ws.root, 'shared', 'brand'), { recursive: true });
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await writeFile(join(dir, 'scenarios', 'quote.yaml'), SCENARIO_YAML);
  const timeline = scenesTimeline([5, 5]);
  if (timeline.video) delete timeline.video.template;
  demo = await makeCase(ws, 'quote', timeline, { noVideo: true });
  await writeFile(
    join(demo.run.dir, 'run.json'),
    JSON.stringify({ version: 1, id: demo.run.id, project: 'demo', scenario: 'quote', mode: 'capture', status: 'succeeded', started_at: '2026-01-01T12:00:00.000Z', finished_at: '2026-01-01T12:01:00.000Z', dir: demo.run.dir, env: 'local', options: { hooks: 'run', headed: false }, steps_total: 1, steps_done: 1, screenshots: [], hooks: { setup: 'none', teardown: 'none' }, warnings: [] }),
  );
  await writeFile(join(demo.run.dir, 'scenario.yaml'), SCENARIO_YAML);
  project = await loadProject('demo', ws.root);
  await setTheme(OWN);
  yaml = await readFile(join(dir, 'project.yaml'), 'utf8');
  engine = await createEngine({ root: ws.root, client: 'test', autoStartWorker: false });
}, 120_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await ws?.cleanup();
});

describe("a theme's identity is its folder (BL-164, L7.9)", () => {
  it('the folder as an id: relative to the workspace root, `/`-separated; a starter outside the workspace by its name', async () => {
    expect(templateFolderId(join(project.dir, 'themes', 'brand'), ws.root)).toBe('projects/demo/themes/brand');
    expect(templateFolderId(join(ws.root, 'shared', 'brand'), ws.root)).toBe('shared/brand');
    expect(templateFolderId(join(ws.root, '..', 'elsewhere', 'brand'), ws.root)).toBe('../elsewhere/brand');
    expect(templateFolderId(join(STARTER_TEMPLATES_DIR, 'editorial'), ws.root)).toBe('/starter:editorial');
    // L7.9 fix pass: a starter is a starter inside a workspace too (the checkout as a workspace, an install under it).
    expect(templateFolderId(join(STARTER_TEMPLATES_DIR, 'editorial'), join(STARTER_TEMPLATES_DIR, '..'))).toBe('/starter:editorial');
    // No folder's path is a starter's id: a folder named so is a path like any other.
    expect(templateFolderId(join(ws.root, 'starter:editorial'), ws.root)).toBe('starter:editorial');
  });

  it('the root and the folder as the disk spells them: a root named through a link gives the same ids', async () => {
    const link = join(ws.root, '..', `${basename(ws.root)}-link`);
    await symlink(ws.root, link);
    try {
      for (const [dir, root] of [
        [join(link, 'shared', 'brand'), ws.root],
        [join(ws.root, 'shared', 'brand'), link],
        [join(link, 'shared', 'brand'), link],
      ]) expect(templateFolderId(dir, root)).toBe('shared/brand');
      expect(templateFolderId(join(link, '..', 'elsewhere', 'brand'), ws.root)).toBe(templateFolderId(join(ws.root, '..', 'elsewhere', 'brand'), ws.root));
      expect(await projectTemplateFolderId({ root: link, dir: join(link, 'projects', 'demo') }, SHARED)).toBe('shared/brand');
    } finally {
      await rm(link);
    }
  });

  it("today's folder of a reference, by the editor's rule: a path against the project, a name in the workspace's themes, else the starter's", async () => {
    const p = await loadProject('demo', ws.root);
    expect(await projectTemplateFolderId(p, OWN)).toBe('projects/demo/themes/brand');
    expect(await projectTemplateFolderId(p, SHARED)).toBe('shared/brand');
    // The workspace's templates_dir is the starters' folder here (the test workspace): a name is a starter.
    expect(await projectTemplateFolderId(p, 'editorial')).toBe('/starter:editorial');
    expect(await projectTemplateFolderId(p, undefined)).toBeUndefined();
    // A folder that does not exist has an identity all the same.
    expect(await projectTemplateFolderId(p, './themes/gone')).toBe('projects/demo/themes/gone');
  });

  it('two folders of one name are two themes: the row holds the render of the folder the project names today', async () => {
    await clearRenders();
    // quote-v1: the project's own brand; quote-v2, newer: the shared brand — same file, same take, same theme name.
    await record('quote-v1', '2026-10-20T11:00:00.000Z', 'projects/demo/themes/brand');
    await record('quote-v2', '2026-10-20T12:00:00.000Z', 'shared/brand');
    try {
      expect(await row()).toEqual(['quote-v1', true, 'brand']);
      await setTheme(SHARED);
      expect(await row()).toEqual(['quote-v2', true, 'brand']);
    } finally {
      await writeFile(join(project.dir, 'project.yaml'), yaml);
    }
  });

  it("with only the other folder's render, the row holds it and says it does not show today's file", async () => {
    await clearRenders();
    await record('quote-v2', '2026-10-20T12:00:00.000Z', 'shared/brand');
    expect(await row()).toEqual(['quote-v2', false, 'brand']);
  });

  it('a record of before L7.9 holds no folder: compared by its folder\'s name, as before', async () => {
    await clearRenders();
    await record('quote-v1', '2026-10-20T11:00:00.000Z', undefined);
    expect(await row()).toEqual(['quote-v1', true, 'brand']);
    await setTheme(SHARED);
    try {
      expect(await row()).toEqual(['quote-v1', true, 'brand']);
    } finally {
      await writeFile(join(project.dir, 'project.yaml'), yaml);
    }
  });

  it("the folder's content is no part of it: a theme edited after its render keeps that render current", async () => {
    await clearRenders();
    await record('quote-v1', '2026-10-20T11:00:00.000Z', 'projects/demo/themes/brand');
    const file = join(project.dir, 'themes', 'brand', 'template.yaml');
    const before = await readFile(file, 'utf8');
    await writeFile(file, `${before}\n# edited after the render\n`);
    try {
      expect(await row()).toEqual(['quote-v1', true, 'brand']);
    } finally {
      await writeFile(file, before);
    }
  });
});

// L7.9 fix pass: an export's re-render (vertical, square) plans with the master's theme folder, named as the project can
// name it (editor exportThemeRef) — before, with the record's theme name, so a project on `./themes/brand` re-rendered
// with the workspace's `brand` or failed "not found". Through MCP never a path the record holds.
describe("an export's re-render plans with the master's theme folder (L7.9 fix pass)", () => {
  const p = () => loadProject('demo', ws.root);
  const outcome = async (x: Promise<unknown>) => x.then(() => 'ok', (e: unknown) => (e instanceof EngineError ? `${e.code}: ${e.message}` : `${(e as Error).name}: ${(e as Error).message}`));

  it('the folder named as the project names it: its own template:, a theme name, a starter; a record of before L7.9 by its name', async () => {
    const project = await p();
    for (const trust of ['author', 'mcp'] as const) {
      expect(await exportThemeRef(project, { template: 'brand', template_folder: 'projects/demo/themes/brand' }, { trust })).toBe(OWN);
      expect(await exportThemeRef(project, { template: 'editorial', template_folder: '/starter:editorial' }, { trust })).toBe('editorial');
      expect(await exportThemeRef(project, { template: 'brand' }, { trust })).toBe('brand');
    }
  });

  it('a folder the project does not name: at a terminal the folder itself, through MCP refused in words that quote nothing of the record', async () => {
    const project = await p();
    const shared = { template: 'brand', template_folder: 'shared/brand' };
    expect(await exportThemeRef(project, shared, { trust: 'author' })).toBe(resolve(realpathSync(ws.root), 'shared', 'brand'));
    const refused = await outcome(exportThemeRef(project, shared, { trust: 'mcp' }));
    expect(refused).toBe(
      "PlanTrustError: refused through MCP:\n- the theme folder this render was made with is not one the project names today (its project.yaml template:, a theme of the workspace or a starter): through MCP a re-render uses only those — re-render it from a terminal, or render the scenario again",
    );
    // A record's text that is no folder of the rule: refused both ways, never another folder.
    const crafted = { template: 'brand', template_folder: '/starter:../../shared/brand' };
    expect(await outcome(exportThemeRef(project, crafted, { trust: 'author' }))).toMatch(/^RenderError: the theme folder this render was made with cannot be found from the workspace/);
    expect(await outcome(exportThemeRef(project, crafted, { trust: 'mcp' }))).toMatch(/^PlanTrustError: refused through MCP/);
  });

  it('an export submitted through the engine: a vertical of a render of the project\'s own folder is planned; one of another folder of that name is refused', async () => {
    await clearRenders();
    await record('quote-v1', '2026-10-20T11:00:00.000Z', 'projects/demo/themes/brand');
    await record('quote-v2', '2026-10-20T12:00:00.000Z', 'shared/brand');
    const ok = await engine.exports.submit({ project: 'demo', render_id: 'quote-v1', formats: ['vertical_9x16'] });
    expect(ok.rerendered).toEqual(['vertical_9x16']);
    await engine.jobs.cancel(ok.job.id).catch(() => undefined);
    const no = await outcome(engine.exports.submit({ project: 'demo', render_id: 'quote-v2', formats: ['vertical_9x16'] }));
    expect(no).toMatch(/^refused: refused through MCP:\n- the theme folder this render was made with is not one the project names today/);
    expect(no).not.toContain('shared');
  });
});
