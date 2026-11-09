/**
 * L4.7 part A2: "Copy to edit" (engine brand/copy.ts): a listed theme copied into a new workspace theme — its regular
 * files verbatim, `name:` spliced, this tool's provenance file, validated, renamed into place — then editable from the
 * Studio. ⚑ Refused: a starter's or an existing folder's name (without case), a name that is not a slug, a source holding
 * a symbolic or (review A M1) a hard link, a templates_dir inside the Retake package; nothing left behind by a
 * refusal. A copy is the person's (trust `author`, review A N4): MCP's replace never takes it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES_DIR } from '@retake/core';
import { THEME_PROVENANCE_FILE, copyTheme, createEngine, openWorkspace, replaceProblem, personScope } from '../src/index.js';
import type { Engine, EngineError } from '../src/index.js';
import { REPO } from './helpers.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
let root: string;
let engine: Engine;
const savedHome = process.env.RETAKE_HOME;
async function failure(p: Promise<unknown>): Promise<EngineError> {
  try {
    await p;
  } catch (e) {
    return e as EngineError;
  }
  throw new Error('did not fail');
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ds-theme-copy-'));
  process.env.RETAKE_HOME = join(root, '.home');
  await writeFile(join(root, 'retake.yaml'), 'version: 1\nprojects_dir: projects\ntemplates_dir: templates\n');
  await mkdir(join(root, 'projects'), { recursive: true });
  engine = await createEngine({ root, client: 'ui', autoStartWorker: false });
}, 60_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe('copy a theme (L4.7)', () => {
  it('a starter copied: its files verbatim, the name spliced, the provenance file; editable at once', async () => {
    const r = await engine.templates.copy({ from: 'editorial', name: 'mine' });
    const dir = join(root, 'templates', 'mine');
    expect(r.name).toBe('mine');
    expect(r.files.sort()).toEqual(['.retake-theme.json', 'LICENSES.md', 'README.md', 'fonts/InstrumentSerif-Regular.ttf', 'fonts/Inter-Bold.ttf', 'fonts/Inter-Regular.ttf', 'fonts/Inter-SemiBold.ttf', 'logo.svg', 'template.yaml', 'wordmark.svg']);
    const src = readFileSync(join(STARTER_TEMPLATES_DIR, 'editorial', 'template.yaml'), 'utf8');
    const text = await readFile(join(dir, 'template.yaml'), 'utf8');
    expect(text).toBe(src.replace('name: editorial', 'name: mine'));
    for (const f of ['logo.svg', 'fonts/Inter-Bold.ttf', 'LICENSES.md']) expect(sha(await readFile(join(dir, f)))).toBe(sha(readFileSync(join(STARTER_TEMPLATES_DIR, 'editorial', f))));
    const prov = JSON.parse(await readFile(join(dir, THEME_PROVENANCE_FILE), 'utf8'));
    // The person made it in the Studio (L4.7 review A N4): theirs, never replaced through MCP; the CLI's replace may.
    expect(prov).toMatchObject({ made_by: 'retake', copy_of: 'editorial', trust: 'author', name: 'mine', files: { 'template.yaml': sha(text) } });
    expect(await replaceProblem(dir, 'mcp')).toMatch(/made by a human/);
    expect(await replaceProblem(dir, 'author')).toBeNull();
    const v = await engine.templates.view('mine');
    expect(v).toMatchObject({ source: 'workspace', editable: true, issues: [] });
    // Edited from the Studio: no longer replaceable as made (template_create_from_brand's replace is refused).
    await engine.templates.edit('mine', { if_match: v.sha256, edit: { kind: 'set_field', field: 'colors.accent', from: '#8a2332', to: '#224466' } });
    expect(await replaceProblem(dir, 'author')).toMatch(/template.yaml was changed since it was made/);
    // A copy of a workspace theme.
    const r2 = await engine.templates.copy({ from: 'mine', name: 'mine-2' });
    expect(await readFile(join(root, 'templates', 'mine-2', 'template.yaml'), 'utf8')).toBe(text.replace('name: mine', 'name: mine-2').replace('"#8a2332"', '"#224466"'));
    expect(JSON.parse(await readFile(join(root, 'templates', 'mine-2', THEME_PROVENANCE_FILE), 'utf8')).copy_of).toBe('mine');
    expect(r2.files).not.toContain('.DS_Store');
  });

  it('⚑ names: a starter\'s, an existing folder\'s (without case), not a slug; nothing left behind', async () => {
    expect((await failure(engine.templates.copy({ from: 'editorial', name: 'motion' }))).message).toMatch(/name of the starter theme motion/);
    expect((await failure(engine.templates.copy({ from: 'editorial', name: 'MINE' }))).code).toBe('invalid');
    await mkdir(join(root, 'templates', 'Taken'), { recursive: true });
    expect((await failure(engine.templates.copy({ from: 'editorial', name: 'taken' }))).code).toBe('conflict');
    for (const bad of ['../x', 'a/b', '', 'x'.repeat(65), '.hidden']) expect((await failure(engine.templates.copy({ from: 'editorial', name: bad }))).code, bad).toBe('invalid');
    expect((await failure(engine.templates.copy({ from: '../templates/mine', name: 'x2' }))).code).toBe('invalid');
    expect((await failure(engine.templates.copy({ from: 'nope', name: 'x2' }))).code).toBe('not_found');
    expect((await readdir(join(root, 'templates'))).filter((e) => e.startsWith('.tmp-'))).toEqual([]);
  });

  it('⚑ a source holding a symbolic link is refused whole; a templates_dir inside the package is refused', async () => {
    const src = join(root, 'templates', 'linky');
    await cp(join(STARTER_TEMPLATES_DIR, 'editorial'), src, { recursive: true });
    await writeFile(join(src, 'template.yaml'), readFileSync(join(STARTER_TEMPLATES_DIR, 'editorial', 'template.yaml'), 'utf8').replace('name: editorial', 'name: linky'));
    await writeFile(join(root, 'secret.txt'), 'outside');
    await symlink(join(root, 'secret.txt'), join(src, 'notes.txt'));
    const e = await failure(engine.templates.copy({ from: 'linky', name: 'linky-copy' }));
    expect(e.code).toBe('refused');
    expect(e.message).toMatch(/holds a symbolic link \(notes.txt\)/);
    expect((await readdir(join(root, 'templates'))).some((n) => n.includes('linky-copy'))).toBe(false);
    const repoWs = await openWorkspace({ root: REPO });
    expect((await failure(copyTheme(repoWs, { from: 'editorial', name: 'never-here' }, { scope: personScope(repoWs.root) }))).message).toMatch(/lies inside the Retake folder/);
  });

  it('⚑ L4.7 review A M1: a source holding a hard link is refused whole, nothing written', async () => {
    // A hard link is another name of a file kept anywhere: copied, it would become the new theme's own file (nlink 1).
    const src = join(root, 'templates', 'hardy');
    await cp(join(STARTER_TEMPLATES_DIR, 'editorial'), src, { recursive: true });
    await writeFile(join(src, 'template.yaml'), readFileSync(join(STARTER_TEMPLATES_DIR, 'editorial', 'template.yaml'), 'utf8').replace('name: editorial', 'name: hardy'));
    await mkdir(join(root, 'outside'), { recursive: true });
    await writeFile(join(root, 'outside', 'notes.txt'), 'SECRET-OUTSIDE-BYTES\n');
    await link(join(root, 'outside', 'notes.txt'), join(src, 'notes.txt'));
    const e = await failure(engine.templates.copy({ from: 'hardy', name: 'hardy-copy' }));
    expect(e.code).toBe('refused');
    expect(e.message).toBe('theme hardy holds a file with another name (a hard link: notes.txt): a copy would serve bytes from elsewhere — copy it by hand');
    expect((await readdir(join(root, 'templates'))).filter((n) => n.includes('hardy-copy'))).toEqual([]);
    // Without the link, the same theme copies.
    await rm(join(src, 'notes.txt'));
    expect((await engine.templates.copy({ from: 'hardy', name: 'hardy-copy' })).name).toBe('hardy-copy');
  });
});
