/**
 * L7.5 D-3, at the Studio's ops over HTTP, on a workspace made in a temp folder whose templates/ already holds themes
 * with long names (made before the cap of 60 for a NEW name: an 80-character lower-case one, a 100-character one with
 * capitals and "_", a 101-character one):
 * - ⚑ a theme that exists under a name of 61 to 100 characters keeps working: listed, opened, edited, shown by the
 *   library, previewed, the default of a project, the base of a new theme, and copied FROM;
 * - ⚑ a NEW theme's name takes at most 60 characters: theme_copy and theme_create refuse 61, 64 and 100 at the door
 *   (400, nothing written) and take 60;
 * - a name of 101 characters is no theme name for any op, as before.
 * There is no operation that renames a theme: giving a long theme a short name is a copy.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES_DIR } from '@retake/core/io';
import { LIBRARY_DIR } from '@retake/components';
import type { ThemeEditView } from '@retake/engine';
import { startStudioServer } from '../src/index.js';
import type { StudioServer, ThemePreviewAnswer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { raw } from './http.js';
import { stubTools } from './studio-tools.js';

const P = 'northfield-fixture';
const LEASE = 'themeCapsAAAAAAAAAAAA';
const a = (n: number, ch = 'a') => ch.repeat(n);
/** 80 characters, lower-case: a name a copy could take before the cap (the engine took up to 64, the Studio's door up to 100). */
const LONG = `long-${a(75)}`;
/** 100 characters with capitals and "_": the longest name a listed theme has. */
const LONGEST = `Long_${a(95, 'B')}`;
/** 101 characters: never a theme name. */
const TOO_LONG = `long-${a(96)}`;

let ws: string;
let studio: StudioServer;
const savedHome = process.env.RETAKE_HOME;
const call = (op: string, args: unknown = {}) => raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
async function ok<T>(op: string, args: unknown): Promise<T> {
  const r = await call(op, args);
  expect(r.status, `${op}: ${r.body.slice(0, 400)}`).toBe(200);
  return r.json<{ data: T }>().data;
}
const themeFolders = async () => (await readdir(join(ws, 'templates'))).filter((n) => !n.startsWith('.')).sort();

/** A theme folder made by hand, as one made before the lot: a starter's files under the long name. */
async function oldTheme(name: string): Promise<void> {
  const dir = join(ws, 'templates', name);
  await cp(join(STARTER_TEMPLATES_DIR, 'editorial'), dir, { recursive: true });
  const file = join(dir, 'template.yaml');
  await writeFile(file, (await readFile(file, 'utf8')).replace(/^name: .*$/m, `name: ${name}`));
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ds-theme-caps-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  await writeFile(join(ws, 'retake.yaml'), 'version: 1\nprojects_dir: projects\ntemplates_dir: templates\n');
  await mkdir(join(ws, 'templates'));
  await mkdir(join(ws, 'brand'));
  await cp(join(LIBRARY_DIR, 'studio', 'card-title', 'preview.png'), join(ws, 'brand', 'logo.png'));
  for (const name of [LONG, LONGEST, TOO_LONG]) await oldTheme(name);
  // A project whose theme is the 80-character one: what its renders use.
  const own = join(ws, 'projects', 'own');
  await mkdir(join(own, 'scenarios'), { recursive: true });
  await writeFile(join(own, 'project.yaml'), `version: 1\nname: Own\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: ${LONG}\n`);
  studio = await startStudioServer({ root: ws, startWorker: false });
}, 60_000);

afterAll(async () => {
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

type List = { project_theme?: string; themes: Array<{ name: string; source: string; default?: true; editable: true | { why: string }; issues: string[]; used_by: { projects: string[] } }> };

describe('a theme that exists under a long name keeps working', () => {
  it('the names are 80, 100 and 101 characters', () => {
    expect([LONG.length, LONGEST.length, TOO_LONG.length]).toEqual([80, 100, 101]);
  });

  it('⚑ listed (editable, no issue), and the default of the project that names it', async () => {
    const list = await ok<List>('theme_list', { project: P });
    const by = new Map(list.themes.map((t) => [t.name, t]));
    for (const name of [LONG, LONGEST]) expect(by.get(name), name).toMatchObject({ source: 'workspace', editable: true, issues: [] });
    expect(by.get(LONG)!.used_by.projects).toContain('own');
    const own = await ok<List>('theme_list', { project: 'own' });
    expect(own.project_theme).toBe(LONG);
    expect(own.themes.find((t) => t.name === LONG)).toMatchObject({ default: true, editable: true });
  });

  it('⚑ opened and edited', async () => {
    for (const name of [LONG, LONGEST]) {
      const v = await ok<ThemeEditView>('theme_view', { theme: name });
      expect(v, name).toMatchObject({ name, editable: true });
      const accent = v.fields['colors.accent'] as string;
      const w = await ok<{ sha256: string }>('theme_edit', { theme: name, if_match: v.sha256, edit: { kind: 'set_field', field: 'colors.accent', from: accent, to: '#224466' } });
      expect(w.sha256).not.toBe(v.sha256);
      expect(await readFile(join(ws, 'templates', name, 'template.yaml'), 'utf8')).toContain('#224466');
    }
  });

  it('⚑ shown by the library and previewed', async () => {
    for (const name of [LONG, LONGEST]) {
      const lib = await ok<{ theme: { name: string }; themes: Array<{ name: string }> }>('library_view', { project: P, theme: name });
      expect(lib.theme.name).toBe(name);
      expect(lib.themes.map((t) => t.name)).toEqual(expect.arrayContaining([LONG, LONGEST]));
      const d = await ok<ThemePreviewAnswer>('theme_preview', { project: P, theme: name, target: 'intro', lease: LEASE });
      expect('preview_error' in d ? d.preview_error : '').toBe('');
      expect(d).toMatchObject({ theme: name, frame_url: expect.stringContaining(`${studio.player.origin}/s/`) });
    }
    // The project whose own theme it is: the library opens on it.
    expect((await ok<{ theme: { name: string } }>('library_view', { project: 'own' })).theme.name).toBe(LONG);
  });

  it('⚑ copied from (a copy is how a long theme gets a shorter name), and the base of a new theme', async () => {
    expect(await ok<{ name: string; from: string }>('theme_copy', { from: LONG, name: 'short-one' })).toMatchObject({ name: 'short-one', from: LONG });
    expect(await ok<{ name: string; from: string }>('theme_copy', { from: LONGEST, name: 'short-two' })).toMatchObject({ name: 'short-two', from: LONGEST });
    expect((await ok<ThemeEditView>('theme_view', { theme: 'short-one' })).name).toBe('short-one');
    expect(await readFile(join(ws, 'templates', 'short-two', 'template.yaml'), 'utf8')).toMatch(/^name: short-two$/m);
    expect(await ok<Record<string, unknown>>('theme_create', { name: 'branded', base: LONG, colors: { accent: '#3355aa' }, logo: 'brand/logo.png' })).toMatchObject({
      name: 'branded',
      base: LONG,
      replaced: false,
    });
    // The long themes themselves are as they were.
    expect(await themeFolders()).toEqual(expect.arrayContaining([LONG, LONGEST, 'short-one', 'short-two', 'branded']));
  });

  it('a name of 101 characters is no theme name, for any op that takes one', async () => {
    const asked: Array<[string, unknown]> = [
      ['theme_view', { theme: TOO_LONG }],
      ['theme_copy', { from: TOO_LONG, name: 'never' }],
      ['library_view', { project: P, theme: TOO_LONG }],
      ['theme_preview', { project: P, theme: TOO_LONG, target: 'intro', lease: LEASE }],
      ['theme_create', { name: 'never', base: TOO_LONG, colors: { accent: '#3355aa' }, logo: 'brand/logo.png' }],
    ];
    for (const [op, args] of asked) expect((await call(op, args)).status, op).toBe(400);
    expect(await themeFolders()).not.toContain('never');
  });
});

describe("a new theme's name takes at most 60 characters", () => {
  it('⚑ theme_copy: 61, 64 and 100 characters refused at the door, nothing written; 60 taken', async () => {
    const before = await themeFolders();
    for (const n of [61, 64, 65, 100, 101]) {
      const r = await call('theme_copy', { from: 'editorial', name: a(n, 'c') });
      expect(r.status, `${n}: ${r.body.slice(0, 200)}`).toBe(400);
      expect(r.body, String(n)).toContain('name');
    }
    expect((await call('theme_copy', { from: 'editorial', name: 'Mine' })).status).toBe(400);
    expect(await themeFolders()).toEqual(before);
    expect(await ok<{ name: string }>('theme_copy', { from: LONG, name: a(60, 'c') })).toMatchObject({ name: a(60, 'c') });
    expect(await themeFolders()).toEqual([...before, a(60, 'c')].sort());
  });

  it('⚑ theme_create: 61 characters refused, 60 taken', async () => {
    const input = { colors: { accent: '#3355aa' }, logo: 'brand/logo.png' };
    const before = await themeFolders();
    for (const n of [61, 64, 100]) expect((await call('theme_create', { ...input, name: a(n, 'd') })).status, String(n)).toBe(400);
    expect(await themeFolders()).toEqual(before);
    expect(await ok<Record<string, unknown>>('theme_create', { ...input, name: a(60, 'd') })).toMatchObject({ name: a(60, 'd') });
  });

  it("the op's schema: the new name at 60 with its sentence; the theme copied from, viewed or edited at 100", () => {
    const tools = stubTools();
    const issues = (op: string, args: unknown) => {
      const r = tools.get(op)!.input.safeParse(args);
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    };
    expect(issues('theme_copy', { from: LONGEST, name: a(60) })).toEqual([]);
    expect(issues('theme_copy', { from: LONGEST, name: a(61) })).toEqual([expect.stringMatching(/^name: /)]);
    expect(issues('theme_copy', { from: 'editorial', name: 'Mine' })).toEqual(['name: a new theme name: lower-case letters, digits and "-", never a path']);
    expect(issues('theme_copy', { from: TOO_LONG, name: 'mine' })).toEqual([expect.stringMatching(/^from: /)]);
    expect(issues('theme_copy', { from: '../x', name: 'mine' })).toEqual(['from: a theme name (the themes list names them), never a path']);
    expect(issues('theme_view', { theme: LONGEST })).toEqual([]);
    expect(issues('theme_view', { theme: TOO_LONG })).toEqual([expect.stringMatching(/^theme: /)]);
    expect(issues('library_view', { project: P, theme: LONGEST })).toEqual([]);
    expect(issues('library_view', { project: P, theme: '../x' })).toEqual(['theme: a theme name (library_view lists them), never a path']);
  });
});
