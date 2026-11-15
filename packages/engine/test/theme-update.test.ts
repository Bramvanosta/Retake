/**
 * template_update (engine src/brand/update.ts, `engine.templates.update`) and the replace guard it shares (create.ts
 * replaceProblem): a theme made through MCP re-made with only the patched inputs changed — one colour, an outro param,
 * a removal — the files it does not name taken from the theme's own copies (a removed brand file, a pruned site
 * candidate do not matter), LICENSES.md's font sections kept; refused for a theme a person made (CLI, Studio), one made
 * before made_via was recorded, one changed, one with a file added, one whose recorded inputs were edited, a starter,
 * an unknown name; nothing to change is invalid and writes nothing; the provenance keeps the merged inputs, their hash
 * and updated_at.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES_DIR, fileFacts, loadTemplate, loadWorkspaceConfig } from '@retake/core/io';
import { PERSON_POLICY } from '@retake/core';
import { packageRegistries } from '@retake/compose';
import { THEME_PROVENANCE_FILE, createThemeFromBrand, recordHash } from '../src/brand/create.js';
import { citedBaseLicences } from '../src/brand/update.js';
import { createEngine } from '../src/index.js';
import { newSiteId } from '../src/jobs/site-job.js';
import { personScope } from '../src/store/project-store.js';
import { enginePorts } from '../src/ports.js';
import { diskWorkspaceReads } from '../src/workspace-reads/disk-reads.js';
import { diskOutputs } from '../src/outputs/disk-outputs.js';
import type { Engine, EngineError } from '../src/index.js';

const T = STARTER_TEMPLATES_DIR;
let root: string;
let engine: Engine;
let studio: Engine;

const input = (o: Record<string, unknown> = {}) => ({ name: 'acme', colors: { accent: '#0e7c66' }, logo: 'brand/logo.svg', ...o });
const files = () => fileFacts(PERSON_POLICY);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x as EngineError,
  );
  if (!e) throw new Error('expected a refusal');
  return e;
}

async function provenance(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, 'templates', name, THEME_PROVENANCE_FILE), 'utf8')) as Record<string, unknown>;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-theme-update-'));
  await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
  await mkdir(join(root, 'brand'), { recursive: true });
  await mkdir(join(root, 'templates'), { recursive: true });
  await cp(join(T, 'editorial', 'logo.svg'), join(root, 'brand', 'logo.svg'));
  await cp(join(T, 'editorial', 'wordmark.svg'), join(root, 'brand', 'wordmark.svg'));
  await cp(join(T, 'default', 'fonts', 'Inter-Regular.ttf'), join(root, 'brand', 'Body-A.ttf'));
  await cp(join(T, 'default', 'fonts', 'Inter-SemiBold.ttf'), join(root, 'brand', 'Body-B.ttf'));
  engine = await createEngine({ root, client: 'mcp', autoStartWorker: false });
  studio = await createEngine({ root, client: 'ui', autoStartWorker: false });
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('template_update (engine)', () => {
  it('changes only the keys given: one colour, the rest as made; the provenance keeps the merged inputs, their hash and updated_at', async () => {
    const made = await engine.templates.create(input({ wordmark: 'brand/wordmark.svg', brand: { name: 'Northfield', url: 'example.com' }, colors: { accent: '#0e7c66', text: '#101010' } }));
    const before = await provenance('acme');
    expect(before).toMatchObject({ made_via: 'mcp', trust: 'mcp', record_sha256: recordHash(before) });
    const u = await engine.templates.update({ name: 'acme', colors: { paper: '#fbfaf7' } });
    expect(u).toMatchObject({ name: 'acme', replaced: true, changed: ['colors.paper'] });
    const t = (await loadTemplate('acme', root, { files: files() })).template;
    expect(t.colors.paper).toBe('#fbfaf7');
    expect(t.colors.accent).toBe('#0e7c66');
    expect(t.colors.text).toBe('#101010');
    expect(t.brand).toEqual({ name: 'Northfield', url: 'example.com' });
    expect(t.wordmark).toBe('wordmark.svg');
    const after = await provenance('acme');
    expect(after.inputs).toEqual({ ...(before.inputs as object), colors: { accent: '#0e7c66', text: '#101010', paper: '#fbfaf7' } });
    expect(after.record_sha256).toBe(recordHash(after));
    expect(after.created_at).toBe(before.created_at);
    expect(typeof after.updated_at).toBe('string');
    expect(made.files.sort()).toEqual(u.files.sort());
  });

  it('components.outro.params.logo_size alone re-makes the theme with it; a second update merges params per key, null removes one', async () => {
    await engine.templates.create(input());
    await engine.templates.update({ name: 'acme', components: { outro: { params: { logo_size: 72 } } } });
    expect((await loadTemplate('acme', root, { files: files() })).template.components?.outro).toEqual({ id: 'studio/outro-stack', params: { logo_size: 72 } });
    const u = await engine.templates.update({ name: 'acme', components: { outro: { params: { wordmark_width: 600 } } } });
    expect(u.changed).toEqual(['components.outro']);
    expect((await loadTemplate('acme', root, { files: files() })).template.components?.outro).toEqual({ id: 'studio/outro-stack', params: { logo_size: 72, wordmark_width: 600 } });
    await engine.templates.update({ name: 'acme', components: { outro: { params: { logo_size: null } } } });
    expect((await loadTemplate('acme', root, { files: files() })).template.components?.outro).toEqual({ id: 'studio/outro-stack', params: { wordmark_width: 600 } });
    await engine.templates.update({ name: 'acme', components: { outro: null } });
    expect((await loadTemplate('acme', root, { files: files() })).template.components?.outro).toBe('studio/outro-stack');
    // A bad param is refused by the create's checks, and nothing changes.
    const yaml = await readFile(join(root, 'templates', 'acme', 'template.yaml'), 'utf8');
    expect((await refusal(engine.templates.update({ name: 'acme', components: { outro: { params: { logo_size: 9999 } } } }))).code).toBe('invalid');
    expect(await readFile(join(root, 'templates', 'acme', 'template.yaml'), 'utf8')).toBe(yaml);
  });

  it('null removes the wordmark and brand.name (back to the derived / none)', async () => {
    await engine.templates.create(input({ wordmark: 'brand/wordmark.svg', brand: { name: 'Northfield', url: 'example.com' } }));
    const u = await engine.templates.update({ name: 'acme', wordmark: null, brand: { name: null } });
    expect(u.changed).toEqual(['brand.name', 'wordmark']);
    const t = (await loadTemplate('acme', root, { files: files() })).template;
    expect(t.wordmark).toBeUndefined();
    expect(t.brand).toEqual({ url: 'example.com' });
    expect(u.files).not.toContain('wordmark.svg');
  });

  it("files not named are the theme's own copies: a removed brand file and a pruned site candidate do not matter; LICENSES.md's font sections stay", async () => {
    await engine.templates.create(input({ fonts: { body: ['brand/Body-A.ttf', 'brand/Body-B.ttf'] } }));
    const dir = join(root, 'templates', 'acme');
    const licences = await readFile(join(dir, 'LICENSES.md'), 'utf8');
    const copies = Object.fromEntries(
      await Promise.all(['logo.svg', 'fonts/body-Regular.ttf', 'fonts/body-SemiBold.ttf', 'fonts/InstrumentSerif-Regular.ttf'].map(async (f) => [f, sha(await readFile(join(dir, f)))])),
    );
    await rm(join(root, 'brand'), { recursive: true });
    const u = await engine.templates.update({ name: 'acme', colors: { accent: '#3352b8' } });
    expect(u.changed).toEqual(['colors.accent']);
    for (const [f, h] of Object.entries(copies)) expect(sha(await readFile(join(dir, f))), f).toBe(h);
    const fontSections = (t: string) => t.slice(t.indexOf('## Fonts'));
    expect(fontSections(await readFile(join(dir, 'LICENSES.md'), 'utf8'))).toBe(fontSections(licences));
    // A file the patch names is read from its reference: gone → refused, nothing written.
    expect((await refusal(engine.templates.update({ name: 'acme', logo: 'brand/logo.svg' }))).code).toMatch(/not_found|invalid|refused/);

    // A site candidate: the logo of a theme made from site:<id>/logo-1 is its copy once the extraction is pruned.
    const siteId = newSiteId();
    const site = join(root, '.retake', 'site', siteId);
    await mkdir(site, { recursive: true });
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12, 'latin1');
    png.writeUInt32BE(400, 16);
    png.writeUInt32BE(100, 20);
    await writeFile(join(site, 'logo-1.png'), png);
    await engine.templates.create(input({ name: 'sited', logo: `site:${siteId}/logo-1` }));
    await rm(site, { recursive: true });
    expect((await engine.templates.update({ name: 'sited', colors: { paper: '#fbfaf7' } })).changed).toEqual(['colors.paper']);
    expect(sha(await readFile(join(root, 'templates', 'sited', 'logo.png')))).toBe(sha(png));
  });

  it("a base theme's fonts are the theme's own copies too, its LICENSES.md section kept as the theme cites it (the base changed since)", async () => {
    await cp(join(T, 'editorial'), join(root, 'templates', 'house'), { recursive: true });
    await engine.templates.create(input({ base: 'house' }));
    const dir = join(root, 'templates', 'acme');
    const cited = await readFile(join(dir, 'LICENSES.md'), 'utf8');
    const display = sha(await readFile(join(dir, 'fonts', 'InstrumentSerif-Regular.ttf')));
    // The base moves on: another LICENSES.md, another display font file under the same name.
    await writeFile(join(root, 'templates', 'house', 'LICENSES.md'), '# Licences\n\nRewritten since.\n');
    await cp(join(T, 'default', 'fonts', 'Inter-Bold.ttf'), join(root, 'templates', 'house', 'fonts', 'InstrumentSerif-Regular.ttf'));
    await engine.templates.update({ name: 'acme', colors: { paper: '#fbfaf7' } });
    expect(sha(await readFile(join(dir, 'fonts', 'InstrumentSerif-Regular.ttf')))).toBe(display);
    const now = await readFile(join(dir, 'LICENSES.md'), 'utf8');
    expect(now.slice(now.indexOf('## Fonts of the base theme'))).toBe(cited.slice(cited.indexOf('## Fonts of the base theme')));
    expect(now).not.toContain('Rewritten since');
  });

  it('a base theme with two body files of one static weight (Inter-Regular, Inter-Text) still makes and updates a theme', async () => {
    const house = join(root, 'templates', 'house');
    await cp(join(T, 'editorial'), house, { recursive: true });
    await cp(join(house, 'fonts', 'Inter-Regular.ttf'), join(house, 'fonts', 'Inter-Text.ttf'));
    const yaml = join(house, 'template.yaml');
    const text = await readFile(yaml, 'utf8');
    const listed = text.replace(/fonts\/Inter-Regular\.ttf/, 'fonts/Inter-Regular.ttf, fonts/Inter-Text.ttf');
    expect(listed).not.toBe(text);
    await writeFile(yaml, listed);
    const made = await engine.templates.create(input({ base: 'house' }));
    expect(made.fonts.filter((f) => f.role === 'body').map((f) => f.file)).toContain('fonts/Inter-Text.ttf');
    expect((await engine.templates.update({ name: 'acme', colors: { paper: '#fbfaf7' } })).changed).toEqual(['colors.paper']);
  });

  it('refused for a theme a person made: with the CLI, in the Studio — and replace through MCP refuses a Studio theme too (it used not to)', async () => {
    const ws = { ...(await loadWorkspaceConfig(root)), policy: PERSON_POLICY, reads: diskWorkspaceReads, outputs: diskOutputs, registries: packageRegistries() };
    await createThemeFromBrand(ws, input({ name: 'bob' }), { trust: 'author', cwd: root, scope: personScope(root, enginePorts()) });
    expect((await provenance('bob')).made_via).toBe('cli');
    expect(await refusal(engine.templates.update({ name: 'bob', colors: { paper: '#111111' } }))).toMatchObject({
      code: 'refused',
      message: expect.stringMatching(/made by a human with retake theme create: through MCP only a theme made through MCP is updated/),
    });
    await studio.templates.create(input({ name: 'carol' }));
    expect((await provenance('carol')).made_via).toBe('studio');
    expect(await refusal(engine.templates.update({ name: 'carol', colors: { paper: '#111111' } }))).toMatchObject({
      code: 'refused',
      message: expect.stringMatching(/made by a person in the Studio: through MCP only a theme made through MCP is updated/),
    });
    expect(await refusal(engine.templates.create(input({ name: 'carol', colors: { accent: '#00aa00' }, replace: true })))).toMatchObject({
      code: 'refused',
      message: expect.stringMatching(/made by a person in the Studio: through MCP only a theme made through MCP is replaced/),
    });
    expect((await loadTemplate('carol', root, { files: files() })).template.colors.accent).toBe('#0e7c66');
  });

  it('a provenance written before made_via: neither updated nor replaced through MCP, with a clear message', async () => {
    await engine.templates.create(input());
    const file = join(root, 'templates', 'acme', THEME_PROVENANCE_FILE);
    const p = await provenance('acme');
    delete p.made_via;
    delete p.record_sha256;
    delete p.sources;
    await writeFile(file, `${JSON.stringify(p, null, 2)}\n`);
    for (const call of [engine.templates.update({ name: 'acme', colors: { paper: '#111111' } }), engine.templates.create(input({ replace: true }))]) {
      expect(await refusal(call)).toMatchObject({ code: 'refused', message: expect.stringMatching(/made before Retake recorded who makes a theme .* no made_via/) });
    }
  });

  it('refused once a file changed or was added, or its recorded inputs were edited; a starter, an unknown name', async () => {
    await engine.templates.create(input());
    const dir = join(root, 'templates', 'acme');
    const yaml = join(dir, 'template.yaml');
    const text = await readFile(yaml, 'utf8');
    await writeFile(yaml, text.replace('style_bias: real', 'style_bias: motion'));
    expect(await refusal(engine.templates.update({ name: 'acme', colors: { paper: '#111111' } }))).toMatchObject({ code: 'refused', message: expect.stringMatching(/template.yaml was changed/) });
    await writeFile(yaml, text);
    await writeFile(join(dir, 'notes.md'), 'mine');
    expect(await refusal(engine.templates.update({ name: 'acme', colors: { paper: '#111111' } }))).toMatchObject({
      code: 'refused',
      message: expect.stringMatching(/files were added since it was made: notes.md/),
    });
    await rm(join(dir, 'notes.md'));
    // The inputs are data anyone can edit: an edit (here the logo pointed elsewhere) breaks their hash.
    const p = await provenance('acme');
    (p.inputs as Record<string, unknown>).logo = 'brand/elsewhere.svg';
    await writeFile(join(dir, THEME_PROVENANCE_FILE), `${JSON.stringify(p, null, 2)}\n`);
    expect(await refusal(engine.templates.update({ name: 'acme', colors: { paper: '#111111' } }))).toMatchObject({
      code: 'refused',
      message: expect.stringMatching(/the record in .* was changed since it was made/),
    });
    expect(await refusal(engine.templates.update({ name: 'editorial', colors: { paper: '#111111' } }))).toMatchObject({ code: 'not_found' });
    expect(await refusal(engine.templates.update({ name: 'nobody', colors: { paper: '#111111' } }))).toMatchObject({ code: 'not_found' });
    expect(await refusal(engine.templates.update({ name: 'Acme', colors: { paper: '#111111' } }))).toMatchObject({ code: 'invalid' });
  });

  it('a forged record never reads outside the folder nor a special file: a ../ source, an absolute or extra files key, a FIFO', async () => {
    await engine.templates.create(input());
    const dir = join(root, 'templates', 'acme');
    const file = join(dir, THEME_PROVENANCE_FILE);
    const original = await readFile(file, 'utf8');
    // A file outside the folder the record would point at: never read (its bytes would match their own hash).
    await writeFile(join(root, 'outside.txt'), 'outside');
    const forge = async (edit: (p: Record<string, unknown>) => void) => {
      const p = JSON.parse(original) as Record<string, unknown>;
      edit(p);
      p.record_sha256 = recordHash(p);
      await writeFile(file, `${JSON.stringify(p, null, 2)}\n`);
    };
    const update = () => engine.templates.update({ name: 'acme', colors: { paper: '#111111' } });
    await forge((p) => {
      (p.sources as Record<string, string>)['../../outside.txt'] = 'logo:brand/logo.svg';
      (p.files as Record<string, string>)['../../outside.txt'] = sha('outside');
    });
    expect(await refusal(update())).toMatchObject({ code: 'refused', message: expect.stringMatching(/names a file outside the theme folder or not a plain path/) });
    await forge((p) => {
      (p.files as Record<string, string>)[join(root, 'outside.txt')] = sha('outside');
    });
    expect(await refusal(update())).toMatchObject({ code: 'refused', message: expect.stringMatching(/not a plain path/) });
    await forge((p) => {
      (p.files as Record<string, string>)['notes.md'] = sha('mine');
    });
    expect(await refusal(update())).toMatchObject({ code: 'refused', message: expect.stringMatching(/notes.md was removed since it was made/) });
    await forge((p) => {
      (p.sources as Record<string, string>)['extra.svg'] = 'logo:brand/logo.svg';
    });
    expect(await refusal(update())).toMatchObject({ code: 'refused', message: expect.stringMatching(/a source for extra.svg, a file it does not list/) });
    // A FIFO in the folder (listed or not) is refused before anything is opened: the call returns.
    await writeFile(file, original);
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [join(dir, 'pipe')]);
    expect(await refusal(update())).toMatchObject({ code: 'refused', message: expect.stringMatching(/links or special files \(pipe\)/) });
    await rm(join(dir, 'pipe'));
    // A FIFO in place of the provenance file is never opened either.
    await rm(file);
    execFileSync('mkfifo', [file]);
    expect(await refusal(update())).toMatchObject({ code: 'refused', message: expect.stringMatching(/no readable/) });
    await rm(file);
    await writeFile(file, original);
    expect((await update()).changed).toEqual(['colors.paper']);
  });

  it('files an update reuses count against the brand budget; patch params have the create cap (32 keys, 4 KB)', async () => {
    await engine.templates.create(input());
    const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, i]));
    expect(await refusal(engine.templates.update({ name: 'acme', components: { outro: { params: tooMany } } }))).toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/at most 32 params/),
    });
    // Capped before the merge: 33 removals (nulls) are refused as such, not merged into "nothing to change".
    const removals = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, null]));
    expect(await refusal(engine.templates.update({ name: 'acme', components: { outro: { params: removals } } }))).toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/at most 32 params/),
    });
    expect(await refusal(engine.templates.update({ name: 'acme', components: { outro: { params: { t: 'x'.repeat(5000) } } } }))).toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/at most 4096 characters/),
    });
    // Big fonts (each under the per-font cap): the theme's own display copy (9.9 MiB) is reused by an update whose two
    // fresh body files (9.9 + 5.3 MiB) fit the 25 MiB budget alone, not with the copy counted.
    const MiB = 1024 * 1024;
    const padded = async (from: string, to: string, size: number) => {
      const b = await readFile(join(root, 'brand', from));
      await writeFile(join(root, 'brand', to), Buffer.concat([b, Buffer.alloc(Math.round(size * MiB) - b.length)]));
    };
    await cp(join(T, 'default', 'fonts', 'Inter-Bold.ttf'), join(root, 'brand', 'Body-C.ttf'));
    await padded('Body-C.ttf', 'Big-Display.ttf', 9.9);
    await padded('Body-A.ttf', 'Big-A.ttf', 9.9);
    await padded('Body-B.ttf', 'Big-B.ttf', 5.3);
    await engine.templates.create(input({ name: 'big', fonts: { display: 'brand/Big-Display.ttf', body: ['brand/Body-A.ttf'] } }));
    expect(await refusal(engine.templates.update({ name: 'big', fonts: { body: ['brand/Big-A.ttf', 'brand/Big-B.ttf'] } }))).toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/brand files are more than/),
    });
    // A smaller set fits with the copy counted.
    expect((await engine.templates.update({ name: 'big', fonts: { body: ['brand/Big-B.ttf'] } })).changed).toEqual(['fonts.body']);
  });

  it('nothing to change is invalid and writes nothing; a patch that breaks the whole input is invalid', async () => {
    await engine.templates.create(input({ colors: { accent: '#0e7c66', paper: '#fbfaf7' } }));
    const dir = join(root, 'templates', 'acme');
    const listing = async () => Promise.all((await readdir(dir, { recursive: true })).sort().map(async (f) => [f, await readFile(join(dir, f)).catch(() => null)]));
    const before = await listing();
    expect(await refusal(engine.templates.update({ name: 'acme', colors: { paper: '#fbfaf7' } }))).toMatchObject({ code: 'invalid', message: expect.stringMatching(/nothing to change/) });
    expect(await refusal(engine.templates.update({ name: 'acme' }))).toMatchObject({ code: 'invalid', message: expect.stringMatching(/nothing to change/) });
    expect(await refusal(engine.templates.update({ name: 'acme', colors: { accent: null } }))).toMatchObject({ code: 'invalid' });
    expect(await refusal(engine.templates.update({ name: 'acme', replace: true }))).toMatchObject({ code: 'invalid' });
    expect(await listing()).toEqual(before);
  });

  it("citedBaseLicences gives back the base's LICENSES.md as a theme's own cites it", async () => {
    const base = await readFile(join(T, 'editorial', 'LICENSES.md'), 'utf8');
    await engine.templates.create(input());
    const own = await readFile(join(root, 'templates', 'acme', 'LICENSES.md'), 'utf8');
    expect(citedBaseLicences(own, 'editorial')).toBe(`${base.trimEnd()}\n`);
    expect(citedBaseLicences(own, 'motion')).toBeUndefined();
  });
});
