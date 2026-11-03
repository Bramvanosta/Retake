/**
 * L3.5 a new theme from brand inputs (engine src/brand/create.ts, `engine.templates.create`) in a temporary workspace:
 * the folder written (template.yaml loading as a workspace theme, logo / wordmark / fonts copied and renamed by role
 * and weight, LICENSES.md, the provenance file with the sha256 of every file), its names refused (a starter's in any
 * case, an existing folder of any type and case, an empty folder, a dangling link), templates_dir inside the Retake
 * folder refused, `replace` of an unchanged tool-made theme allowed and refused once a file was changed, added
 * or removed (or for a human's theme, or — through MCP — for a theme a human made with the CLI), font rules (same
 * weight twice, a caption weight missing, licence bits, WOFF weights from the file name's style token), font name
 * strings made printable and escaped in LICENSES.md, a crash's leftovers removed (only this tool's) and the base
 * theme's tone. Nothing is rendered here (stdio-theme.test.ts previews a new theme through MCP).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES_DIR, listTemplates, loadTemplate, loadWorkspaceConfig } from '@retake/core';
import { fontFileFace } from '@retake/components';
import { THEME_PROVENANCE_FILE, createEngine, createThemeFromBrand, fileNameFace } from '../src/index.js';
import type { Engine, EngineError, ThemeCreated } from '../src/index.js';
import { REPO } from './helpers.js';

const T = STARTER_TEMPLATES_DIR;
let root: string;
let engine: Engine;

const input = (o: Record<string, unknown> = {}) => ({ name: 'acme', colors: { accent: '#0e7c66' }, logo: 'brand/logo.svg', ...o });

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x as EngineError,
  );
  if (!e) throw new Error('expected a refusal');
  return e;
}

async function folderHash(dir: string): Promise<string> {
  const h = createHash('sha256');
  for (const e of (await readdir(dir, { withFileTypes: true, recursive: true })).filter((x) => x.isFile()).map((x) => join(x.parentPath, x.name)).sort()) {
    h.update(`${e}\0`).update(await readFile(e));
  }
  return h.digest('hex');
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A copy of a TrueType file whose `name` strings of `id` say `text` (cut or padded with spaces to each record's length). */
function patchName(font: Buffer, ids: number[], text: string): Buffer {
  const b = Buffer.from(font);
  const n = b.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    if (b.toString('latin1', 12 + i * 16, 16 + i * 16) !== 'name') continue;
    const off = b.readUInt32BE(12 + i * 16 + 8);
    const count = b.readUInt16BE(off + 2);
    const strings = off + b.readUInt16BE(off + 4);
    for (let r = 0; r < count; r++) {
      const rec = off + 6 + r * 12;
      const platform = b.readUInt16BE(rec);
      if (!ids.includes(b.readUInt16BE(rec + 6))) continue;
      const len = b.readUInt16BE(rec + 8);
      const at = strings + b.readUInt16BE(rec + 10);
      if (platform === 1) b.write(text.slice(0, len).padEnd(len, ' '), at, 'latin1');
      else {
        const chars = text.slice(0, len / 2).padEnd(len / 2, ' ');
        for (let c = 0; c < chars.length; c++) b.writeUInt16BE(chars.charCodeAt(c), at + c * 2);
      }
    }
  }
  return b;
}

const WOFF2 = (() => {
  const w = Buffer.alloc(60);
  w.write('wOF2', 0, 'latin1');
  w.writeUInt32BE(0x00010000, 4);
  w.writeUInt32BE(60, 8);
  w.writeUInt16BE(3, 12);
  return w;
})();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-theme-create-'));
  await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
  await mkdir(join(root, 'brand'), { recursive: true });
  await cp(join(T, 'editorial', 'logo.svg'), join(root, 'brand', 'logo.svg'));
  await cp(join(T, 'editorial', 'wordmark.svg'), join(root, 'brand', 'wordmark.svg'));
  await cp(join(T, 'motion', 'fonts', 'SpaceGrotesk-Bold.ttf'), join(root, 'brand', 'Grotesk.ttf'));
  await cp(join(T, 'default', 'fonts', 'Inter-Regular.ttf'), join(root, 'brand', 'Body-A.ttf'));
  await cp(join(T, 'default', 'fonts', 'Inter-SemiBold.ttf'), join(root, 'brand', 'Body-B.ttf'));
  await cp(join(T, 'default', 'fonts', 'Inter-Bold.ttf'), join(root, 'brand', 'Body-C.ttf'));
  await writeFile(join(root, 'brand', 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>');
  await mkdir(join(root, 'templates'), { recursive: true });
  engine = await createEngine({ root, client: 'mcp', autoStartWorker: false });
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('template_create_from_brand (engine)', () => {
  let made: ThemeCreated;
  let startersBefore: string;

  it('writes a new workspace theme: template.yaml, logo, wordmark, renamed fonts, LICENSES.md, provenance', async () => {
    startersBefore = await folderHash(T);
    made = await engine.templates.create(
      input({
        wordmark: 'brand/wordmark.svg',
        fonts: { display: 'brand/Grotesk.ttf', body: ['brand/Body-A.ttf', 'brand/Body-B.ttf', { file: 'brand/Body-C.ttf' }] },
        brand: { name: 'Acme', url: 'acme.test' },
      }),
    );
    const dir = join(root, 'templates', 'acme');
    expect(made).toMatchObject({ name: 'acme', dir, base: 'editorial', replaced: false });
    expect(made.files).toEqual(['template.yaml', 'logo.svg', 'wordmark.svg', 'fonts/display-Bold.ttf', 'fonts/body-Regular.ttf', 'fonts/body-SemiBold.ttf', 'fonts/body-Bold.ttf', 'LICENSES.md', THEME_PROVENANCE_FILE]);
    expect(made.fonts.map((f) => [f.file, f.weight, f.weight_from])).toEqual([
      ['fonts/display-Bold.ttf', 700, 'font'],
      ['fonts/body-Regular.ttf', 400, 'font'],
      ['fonts/body-SemiBold.ttf', 600, 'font'],
      ['fonts/body-Bold.ttf', 700, 'font'],
    ]);
    // The renderer reads each copy's weight back from its name.
    for (const f of made.fonts) expect(fontFileFace(f.file).weight, f.file).toBe(f.weight);
    // Loaded as a workspace theme, by name, with every asset in its folder.
    const t = await loadTemplate('acme', root);
    expect(t.dir).toBe(dir);
    expect(t.template.colors).toEqual(made.palette.colors);
    expect(t.template.brand).toEqual({ name: 'Acme', url: 'acme.test' });
    expect(t.template.components?.intro).toBe('studio/intro-stack');
    expect((await listTemplates(root)).find((e) => e.name === 'acme')).toMatchObject({ source: 'workspace' });
    expect(await readFile(join(dir, 'logo.svg'))).toEqual(await readFile(join(root, 'brand', 'logo.svg')));
    expect(await readFile(join(dir, 'fonts', 'display-Bold.ttf'))).toEqual(await readFile(join(root, 'brand', 'Grotesk.ttf')));
    // Provenance: the sha256 of every file written.
    const prov = JSON.parse(await readFile(join(dir, THEME_PROVENANCE_FILE), 'utf8')) as { files: Record<string, string>; made_by: string; inputs: { logo: string } };
    expect(prov.made_by).toBe('retake');
    expect(prov.inputs.logo).toBe('brand/logo.svg');
    expect(Object.keys(prov.files).sort()).toEqual(made.files.filter((f) => f !== THEME_PROVENANCE_FILE).sort());
    for (const [f, h] of Object.entries(prov.files)) expect(sha(await readFile(join(dir, f))), f).toBe(h);
    // Font strings are third-party text: under untrusted, and in LICENSES.md for the human.
    expect(made.untrusted.fonts.map((f) => f.family)).toEqual(['Space Grotesk', 'Inter', 'Inter', 'Inter']);
    const licences = await readFile(join(dir, 'LICENSES.md'), 'utf8');
    expect(licences).toMatch(/fonts\/display-Bold.ttf.*brand\/Grotesk.ttf/);
    expect(licences).toMatch(/Family: Space Grotesk/);
    expect(licences).not.toMatch(/Fonts of the base theme/);
    // No hidden build folder left behind; the starters untouched.
    expect((await readdir(join(root, 'templates'))).filter((e) => e.startsWith('.'))).toEqual([]);
    expect(await folderHash(T)).toBe(startersBefore);
  });

  it('no fonts given: the base theme\'s files are copied as they are, with its LICENSES.md', async () => {
    const c = await engine.templates.create(input({ name: 'plain', base: 'motion', colors: { accent: '#ff5c38' } }));
    expect(c.fonts.map((f) => [f.file, f.weight_from])).toEqual([
      ['fonts/SpaceGrotesk-Bold.ttf', 'base'],
      ['fonts/Inter-Regular.ttf', 'base'],
      ['fonts/Inter-SemiBold.ttf', 'base'],
      ['fonts/Inter-Bold.ttf', 'base'],
    ]);
    expect(c.palette.tone).toBe('dark');
    expect(await readFile(join(c.dir, 'LICENSES.md'), 'utf8')).toMatch(/Fonts of the base theme `motion`[\s\S]*SIL Open Font License/);
    expect(c.warnings).toContain('no wordmark and no brand.name: the outro shows the logo alone');
    expect(c.untrusted.fonts).toEqual([]);
  });

  it.each([
    ['default', /starter theme default/],
    ['editorial', /starter theme editorial/],
    ['motion', /starter theme motion/],
  ])('refuses the starter name %s', async (name, why) => {
    const e = await refusal(engine.templates.create(input({ name })));
    expect(e).toMatchObject({ code: 'refused', message: expect.stringMatching(why) });
  });

  it('refuses upper-case names (Default would shadow the starter default on macOS) and paths', async () => {
    for (const name of ['Default', 'Acme', '../x', 'a/b', '.x']) expect(await refusal(engine.templates.create(input({ name }))), name).toMatchObject({ code: 'invalid' });
  });

  it('refuses an existing folder of any kind: a theme, an empty folder, a file, a dangling link, another case', async () => {
    const tdir = join(root, 'templates');
    await mkdir(join(tdir, 'empty'));
    await writeFile(join(tdir, 'afile'), 'x');
    await symlink(join(root, 'nowhere'), join(tdir, 'dangle'));
    await mkdir(join(tdir, 'Mixed'));
    for (const name of ['acme', 'empty', 'afile', 'dangle', 'mixed']) {
      const e = await refusal(engine.templates.create(input({ name })));
      expect(e, name).toMatchObject({ code: 'conflict', message: expect.stringMatching(/already has/) });
    }
    // Still there, untouched.
    expect(await readdir(join(tdir, 'empty'))).toEqual([]);
    expect(await readFile(join(tdir, 'afile'), 'utf8')).toBe('x');
  });

  it('refuses a templates_dir inside the Retake folder: the repository as workspace, or a folder inside it', async () => {
    for (const td of [join(REPO, 'templates'), join(REPO, 'projects', 'northfield-fixture', 'themes')]) {
      const ws = await mkdtemp(join(tmpdir(), 'studio-theme-repo-'));
      await mkdir(join(ws, 'brand'));
      await cp(join(T, 'editorial', 'logo.svg'), join(ws, 'brand', 'logo.svg'));
      await writeFile(join(ws, 'retake.yaml'), `templates_dir: ${JSON.stringify(td)}\n`);
      const e = await refusal(createThemeFromBrand(await loadWorkspaceConfig(ws), input(), { trust: 'mcp' }));
      expect(e).toMatchObject({ code: 'refused', message: expect.stringMatching(/lies inside the Retake folder/), fix: expect.stringMatching(/RETAKE_ROOT/) });
      await rm(ws, { recursive: true, force: true });
    }
    expect(existsSync(join(REPO, 'projects', 'northfield-fixture', 'themes'))).toBe(false);
    expect(existsSync(join(REPO, 'templates', 'acme'))).toBe(false);
  });

  it('refuses a script SVG and an agent-writable source before writing anything', async () => {
    await mkdir(join(root, 'projects', 'demo', 'scenarios'), { recursive: true });
    await cp(join(T, 'editorial', 'logo.svg'), join(root, 'projects', 'demo', 'scenarios', 'logo.svg'));
    expect(await refusal(engine.templates.create(input({ name: 'bad1', logo: 'brand/evil.svg' })))).toMatchObject({ code: 'invalid', message: expect.stringMatching(/<script>/) });
    expect(await refusal(engine.templates.create(input({ name: 'bad2', logo: 'projects/demo/scenarios/logo.svg' })))).toMatchObject({ code: 'refused' });
    expect(await refusal(engine.templates.create(input({ name: 'bad3', fonts: { display: 'brand/logo.svg' } })))).toMatchObject({ code: 'invalid' });
    for (const n of ['bad1', 'bad2', 'bad3']) expect(existsSync(join(root, 'templates', n))).toBe(false);
    expect((await readdir(join(root, 'templates'))).filter((e) => e.startsWith('.'))).toEqual([]);
  });

  it('replace: an unchanged tool-made theme is replaced; once changed, added to or emptied of a file, never', async () => {
    const before = made;
    const r = await engine.templates.create(input({ colors: { accent: '#3352b8' }, replace: true }));
    expect(r).toMatchObject({ replaced: true, name: 'acme' });
    expect((await loadTemplate('acme', root)).template.colors.accent).toBe('#3352b8');
    expect(existsSync(join(before.dir, 'wordmark.svg'))).toBe(false);
    expect((await readdir(join(root, 'templates'))).filter((e) => e.startsWith('.'))).toEqual([]);

    const dir = join(root, 'templates', 'acme');
    const yaml = join(dir, 'template.yaml');
    const text = await readFile(yaml, 'utf8');
    await writeFile(yaml, text.replace('style_bias: real', 'style_bias: motion'));
    expect(await refusal(engine.templates.create(input({ replace: true })))).toMatchObject({ code: 'refused', message: expect.stringMatching(/template.yaml was changed since it was made.*never overwritten/) });
    await writeFile(yaml, text);
    await writeFile(join(dir, 'notes.md'), 'mine');
    expect(await refusal(engine.templates.create(input({ replace: true })))).toMatchObject({ code: 'refused', message: expect.stringMatching(/files were added since it was made: notes.md/) });
    await rm(join(dir, 'notes.md'));
    const logo = await readFile(join(dir, 'logo.svg'));
    await rm(join(dir, 'logo.svg'));
    expect(await refusal(engine.templates.create(input({ replace: true })))).toMatchObject({ code: 'refused', message: expect.stringMatching(/logo.svg was removed/) });
    await writeFile(join(dir, 'logo.svg'), logo);
    // Restored byte for byte: replaceable again.
    expect((await engine.templates.create(input({ replace: true }))).replaced).toBe(true);
    // A human's theme (no provenance) and an existing folder of another case are never replaced.
    await cp(join(T, 'editorial'), join(root, 'templates', 'human'), { recursive: true });
    expect(await refusal(engine.templates.create(input({ name: 'human', replace: true })))).toMatchObject({ code: 'refused', message: expect.stringMatching(/not made by this tool/) });
    expect(await refusal(engine.templates.create(input({ name: 'mixed', replace: true })))).toMatchObject({ code: 'refused', message: expect.stringMatching(/another case|not made by this tool/) });
    // replace with nothing there creates it.
    expect((await engine.templates.create(input({ name: 'fresh', replace: true }))).replaced).toBe(false);
  });

  it('font rules: one face per weight and style, a caption weight with no body file, WOFF2 weight from the input', async () => {
    const twice = await refusal(engine.templates.create(input({ name: 'twice', fonts: { body: ['brand/Body-A.ttf', 'brand/Body-A.ttf'] } })));
    expect(twice).toMatchObject({ code: 'invalid', message: expect.stringMatching(/same weight and style \(400\)/) });
    const c = await engine.templates.create(input({ name: 'thin', fonts: { body: ['brand/Body-A.ttf'] } }));
    expect(c.warnings.join('\n')).toMatch(/captions.kicker of editorial uses the body font at weight 600, which no body file has/);
    // A WOFF2 (header only): the weight comes from the input, else the file name.
    const woff2 = Buffer.alloc(60);
    woff2.write('wOF2', 0, 'latin1');
    woff2.writeUInt32BE(0x00010000, 4);
    woff2.writeUInt32BE(60, 8);
    woff2.writeUInt16BE(3, 12);
    await writeFile(join(root, 'brand', 'Brand-Heavy.woff2'), woff2);
    await writeFile(join(root, 'brand', 'Brand.woff2'), woff2);
    // Validation only: the bytes are no real font, so the theme is not previewed here.
    const w = await engine.templates.create(input({ name: 'woff', fonts: { display: 'brand/Brand-Heavy.woff2', body: [{ file: 'brand/Brand.woff2', weight: 500 }, 'brand/Body-B.ttf'] } }));
    expect(w.fonts.map((f) => [f.file, f.weight, f.weight_from])).toEqual([
      ['fonts/display-Black.woff2', 900, 'file name'],
      ['fonts/body-Medium.woff2', 500, 'input'],
      ['fonts/body-SemiBold.ttf', 600, 'font'],
    ]);
  });

  it('a font whose embedding bits are restricted is copied with a warning and a LICENSES.md note', async () => {
    const b = Buffer.from(await readFile(join(root, 'brand', 'Body-A.ttf')));
    const n = b.readUInt16BE(4);
    for (let i = 0; i < n; i++) if (b.toString('latin1', 12 + i * 16, 16 + i * 16) === 'OS/2') b.writeUInt16BE(0x0002, b.readUInt32BE(12 + i * 16 + 8) + 8);
    await writeFile(join(root, 'brand', 'Restricted.ttf'), b);
    const c = await engine.templates.create(input({ name: 'restricted', fonts: { display: 'brand/Restricted.ttf' } }));
    expect(c.warnings.join('\n')).toMatch(/display font brand\/Restricted.ttf: restricted licence embedding/);
    expect(await readFile(join(c.dir, 'LICENSES.md'), 'utf8')).toMatch(/Embedding: restricted licence embedding/);
  });

  it('a dark paper over a light base is a warning; the accent that fails is suggested, never changed', async () => {
    const c = await engine.templates.create(input({ name: 'night', colors: { accent: '#ffdd00', paper: '#11131c' } }));
    expect(c.palette.tone).toBe('dark');
    expect(c.warnings.join('\n')).toMatch(/makes a dark theme over editorial, a light one.*consider base motion/);
    const y = await engine.templates.create(input({ name: 'yellow', colors: { accent: '#ffdd00' } }));
    expect(y.palette.colors.accent).toBe('#ffdd00');
    expect(y.palette.suggestions.accent).toMatch(/^#/);
    expect((await loadTemplate('yellow', root)).template.colors.accent).toBe('#ffdd00');
  });

  it('WOFF / WOFF2 weights come from the style token after the last "-" or "_": a family word never reads as a weight', async () => {
    for (const f of ['LighthouseSans-Regular', 'LighthouseSans-Bold', 'Boldwick', 'Heavyweight_SemiBoldItalic']) await writeFile(join(root, 'brand', `${f}.woff2`), WOFF2);
    const c = await engine.templates.create(input({ name: 'lighthouse', fonts: { display: 'brand/Heavyweight_SemiBoldItalic.woff2', body: ['brand/LighthouseSans-Regular.woff2', 'brand/LighthouseSans-Bold.woff2'] } }));
    expect(c.fonts.map((f) => [f.file, f.weight, f.italic, f.weight_from])).toEqual([
      ['fonts/display-SemiBoldItalic.woff2', 600, true, 'file name'],
      ['fonts/body-Regular.woff2', 400, false, 'file name'],
      ['fonts/body-Bold.woff2', 700, false, 'file name'],
    ]);
    expect(c.warnings.join('\n')).toMatch(/body font brand\/LighthouseSans-Regular\.woff2: weight 400 read from the file name \(WOFF2 files keep it compressed\) — give \{file, weight\} if it is wrong/);
    // No style token: regular, said.
    const plain = await engine.templates.create(input({ name: 'boldonse', fonts: { display: 'brand/Boldwick.woff2' } }));
    expect(plain.fonts[0]).toMatchObject({ file: 'fonts/display-Regular.woff2', weight: 400, weight_from: 'file name' });
    expect(plain.warnings.join('\n')).toMatch(/display font brand\/Boldwick\.woff2: no weight in the file \(WOFF2\) nor in its name: 400 assumed/);
    for (const [name, face] of [
      ['Brand-Light.woff2', { weight: 300, italic: false }],
      ['Brand-ExtraLight.woff2', { weight: 200, italic: false }],
      ['Brand_700.woff', { weight: 700, italic: false }],
      ['Brand-Italic.woff2', { weight: 400, italic: true }],
      ['Brand-BlackOblique.woff2', { weight: 900, italic: true }],
      ['Lighthouse.woff2', null],
      ['Brand-Wide.woff2', null],
    ] as const) {
      expect(fileNameFace(`brand/${name}`), name).toEqual(face);
    }
  });

  it('font name strings: printable on one line (no control or bidirectional character) and escaped in LICENSES.md', async () => {
    const inter = await readFile(join(T, 'default', 'fonts', 'Inter-Regular.ttf'));
    const markdown = '![x](https://tracker.test/p.png) [a](https://tracker.test/) <img src=x> *b* _c_ `d` | e';
    // The family records hold 5 characters: "I", a right-to-left override, "N", a C1 control, "T".
    let b = patchName(inter, [1, 16], 'I\u202eN\u0085T');
    b = patchName(b, [0, 13], markdown);
    await writeFile(join(root, 'brand', 'Named.ttf'), b);
    const c = await engine.templates.create(input({ name: 'named', fonts: { display: 'brand/Named.ttf' } }));
    const names = c.untrusted.fonts[0];
    expect(names.family).toBe('I N T');
    expect(names.copyright).toContain('![x](https://tracker.test/p.png)');
    const md = await readFile(join(c.dir, 'LICENSES.md'), 'utf8');
    const copyright = md.split('\n').find((l) => l.startsWith('- Copyright: '))!;
    // Every Markdown / HTML breaker escaped: no link, image, tag, emphasis or table cell is made of the font's text.
    expect(copyright).toContain('\\!\\[x\\]\\(https://tracker.test/p.png\\)');
    expect(copyright).not.toContain('](');
    expect(copyright).not.toMatch(/(?<!\\)[<`*_|]/);
    expect(md).not.toMatch(/[\u202e\u2066\u0085]/);
  });

  it('replace through MCP never takes a theme a human made with the CLI; the CLI may replace a tool-made one', async () => {
    const ws = await loadWorkspaceConfig(root);
    await createThemeFromBrand(ws, input({ name: 'bob' }), { trust: 'author', cwd: root });
    expect(await refusal(engine.templates.create(input({ name: 'bob', colors: { accent: '#00aa00' }, replace: true })))).toMatchObject({
      code: 'refused',
      message: expect.stringMatching(/was made by a human with retake theme create: through MCP only a theme made through MCP is replaced/),
    });
    expect((await loadTemplate('bob', root)).template.colors.accent).toBe('#0e7c66');
    await engine.templates.create(input({ name: 'carol' }));
    expect((await createThemeFromBrand(ws, input({ name: 'carol', colors: { accent: '#00aa00' }, replace: true }), { trust: 'author', cwd: root })).replaced).toBe(true);
  });

  it("a crash's leftovers: only this tool's .tmp- / .old-<name>-<12 hex> folders older than an hour go", async () => {
    const tpl = join(root, 'templates');
    const old = new Date(Date.now() - 2 * 3600_000);
    const prov = JSON.stringify({ version: 1, made_by: 'retake', files: {} });
    const make = async (name: string, files: Record<string, string>, aged = true) => {
      await mkdir(join(tpl, name));
      for (const [f, t] of Object.entries(files)) await writeFile(join(tpl, name, f), t);
      if (aged) await utimes(join(tpl, name), old, old);
    };
    await make('.tmp-acme-0123456789ab', { [THEME_PROVENANCE_FILE]: prov, 'template.yaml': 'x' });
    await make('.old-acme-ba9876543210', { [THEME_PROVENANCE_FILE]: prov });
    await make('.tmp-zed-aaaaaaaaaaaa', {});
    await make('.tmp-mywork', { 'notes.txt': 'mine' });
    await make('.old-acme', { [THEME_PROVENANCE_FILE]: prov });
    await make('.tmp-acme-0123456789ac', { 'notes.txt': 'mine' });
    await make('.tmp-acme-0123456789ad', { [THEME_PROVENANCE_FILE]: JSON.stringify({ made_by: 'someone else' }) });
    await make('.tmp-acme-0123456789ae', { [THEME_PROVENANCE_FILE]: prov }, false);
    await make('.tmp-Acme-0123456789af', { [THEME_PROVENANCE_FILE]: prov });
    await engine.templates.create(input({ name: 'sweep' }));
    expect((await readdir(tpl)).filter((e) => e.startsWith('.')).sort()).toEqual(['.old-acme', '.tmp-Acme-0123456789af', '.tmp-acme-0123456789ac', '.tmp-acme-0123456789ad', '.tmp-acme-0123456789ae', '.tmp-mywork']);
    expect(await readFile(join(tpl, '.tmp-mywork', 'notes.txt'), 'utf8')).toBe('mine');
  });

  it('an unknown base is not found; a base cannot be the theme itself', async () => {
    expect(await refusal(engine.templates.create(input({ name: 'nob', base: 'nope' })))).toMatchObject({ code: 'not_found' });
    expect(await refusal(engine.templates.create(input({ name: 'self', base: 'self' })))).toMatchObject({ code: 'invalid' });
  });

  it('⚑ L4.7 review A M1: a base theme font held by a hard link is refused (never copied into the new theme)', async () => {
    const base = join(root, 'templates', 'hard-base');
    await cp(join(T, 'motion'), base, { recursive: true });
    await writeFile(join(base, 'template.yaml'), (await readFile(join(T, 'motion', 'template.yaml'), 'utf8')).replace('name: motion', 'name: hard-base'));
    await mkdir(join(root, 'outside'), { recursive: true });
    await cp(join(T, 'default', 'fonts', 'Inter-Regular.ttf'), join(root, 'outside', 'font.ttf'));
    await rm(join(base, 'fonts', 'Inter-Regular.ttf'));
    await link(join(root, 'outside', 'font.ttf'), join(base, 'fonts', 'Inter-Regular.ttf'));
    const e = await refusal(engine.templates.create(input({ name: 'from-hard', base: 'hard-base' })));
    expect(e).toMatchObject({ code: 'refused', message: "base theme hard-base: Inter-Regular.ttf has another name (a hard link): a new theme copies only the base's own files" });
    expect(existsSync(join(root, 'templates', 'from-hard'))).toBe(false);
    await rm(base, { recursive: true, force: true });
  });
});
