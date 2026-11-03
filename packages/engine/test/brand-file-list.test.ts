/**
 * L4.7 part A2: the workspace files a new theme may take (engine brand/file-list.ts, the Studio's `brand_files`):
 * ⚑ the source rules of brand/files.ts — never a hidden folder, the components folder, a folder an agent writes in a
 * project, node_modules; links never followed nor listed — names and sizes only, bounded.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import type { Engine } from '../src/index.js';

let root: string;
let engine: Engine;
const savedHome = process.env.RETAKE_HOME;

async function put(rel: string, body = 'x'): Promise<void> {
  const p = join(root, ...rel.split('/'));
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, body);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ds-brand-list-'));
  process.env.RETAKE_HOME = join(root, '.home');
  await writeFile(join(root, 'retake.yaml'), 'version: 1\nprojects_dir: projects\ntemplates_dir: templates\n');
  await put('projects/demo/project.yaml', 'version: 1\nname: Demo\nenvironments:\n  local: {app: "http://app.test"}\n');
  await put('brand/logo.svg', '<svg/>');
  await put('brand/Logo Dark.PNG', 'png');
  await put('brand/fonts/Brand-Regular.ttf', 'ttf');
  await put('brand/notes.txt');
  await put('projects/demo/assets/mark.webp');
  await put('projects/demo/runs/r1/shot.png');
  await put('projects/demo/renders/v1/poster.jpg');
  await put('projects/demo/scenarios/pic.png');
  await put('projects/demo/review/r/sheet.jpg');
  await put('projects/demo/exports/e/cover.png');
  await put('components/acme/badge/logo.png');
  await put('.retake/site/s_x/logo-1.png');
  await put('.git/logo.png');
  await put('brand/.hidden.png');
  await put('node_modules/pkg/logo.png');
  await put('a/b/c/d/e/f/g/deep.png');
  await writeFile(join(root, 'outside.png'), 'png');
  await symlink(join(root, 'outside.png'), join(root, 'brand', 'linked.png'));
  await symlink(join(root, 'components'), join(root, 'brand', 'comps'));
  engine = await createEngine({ root, client: 'ui', autoStartWorker: false });
}, 60_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe('brand files (L4.7)', () => {
  it('⚑ images: workspace files outside hidden, components, agent-writable and node_modules folders; links not followed', async () => {
    const r = await engine.templates.files('image');
    expect(r.files.map((f) => f.ref).sort()).toEqual(['brand/Logo Dark.PNG', 'brand/logo.svg', 'outside.png', 'projects/demo/assets/mark.webp']);
    expect(r.files.find((f) => f.ref === 'brand/logo.svg')?.bytes).toBe(6);
    expect(r.links).toBe(2);
    expect(r.truncated).toBe(false);
    expect(JSON.stringify(r)).not.toContain(root);
  });

  it('fonts', async () => {
    const r = await engine.templates.files('font');
    expect(r.files.map((f) => f.ref)).toEqual(['brand/fonts/Brand-Regular.ttf']);
    await expect(engine.templates.files('video' as never)).rejects.toMatchObject({ code: 'invalid' });
  });
});
