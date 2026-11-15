/**
 * A new theme from brand inputs (engine src/brand/create.ts, `engine.templates.create`) in a temporary workspace:
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES_DIR, listTemplates, loadTemplate, loadWorkspaceConfig, fileFacts } from '@retake/core/io';
import { fontFileFace } from '@retake/components';
import { THEME_PROVENANCE_FILE, createThemeFromBrand, fileNameFace } from '../src/brand/create.js';
import { createEngine } from '../src/index.js';
import { personScope } from '../src/store/project-store.js';
import { enginePorts } from '../src/ports.js';
import { diskWorkspaceReads } from '../src/workspace-reads/disk-reads.js';
import { diskOutputs } from '../src/outputs/disk-outputs.js';
import type { Engine, EngineError, ThemeCreated } from '../src/index.js';
import { REPO } from '@retake/test-support/repo';
import { PERSON_POLICY } from '@retake/core';
import { packageRegistries } from '@retake/compose';

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
  for (const e of (await readdir(dir, { withFileTypes: true, recursive: true }))
    .filter((x) => x.isFile())
    .map((x) => join(x.parentPath, x.name))
    .sort()) {
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

/**
 * A copy of a TrueType file with an `fvar` table whose axes are `axes` ([tag, min, max], 16.16 fixed): a synthetic
 * variable font (the outlines stay the static font's; only the sniff reads it). The table directory grows by one
 * record, every table moves 16 bytes; checksums are not checked by the sniff.
 */
function withFvar(font: Buffer, axes: Array<[string, number, number]>): Buffer {
  const n = font.readUInt16BE(4);
  const head = Buffer.from(font.subarray(0, 12));
  head.writeUInt16BE(n + 1, 4);
  const dir = Buffer.alloc((n + 1) * 16);
  for (let i = 0; i < n; i++) {
    font.copy(dir, i * 16, 12 + i * 16, 28 + i * 16);
    dir.writeUInt32BE(font.readUInt32BE(12 + i * 16 + 8) + 16, i * 16 + 8);
  }
  const fvar = Buffer.alloc(16 + axes.length * 20);
  fvar.writeUInt16BE(1, 0);
  fvar.writeUInt16BE(16, 4);
  fvar.writeUInt16BE(2, 6);
  fvar.writeUInt16BE(axes.length, 8);
  fvar.writeUInt16BE(20, 10);
  axes.forEach(([tag, min, max], i) => {
    const r = 16 + i * 20;
    fvar.write(tag, r, 'latin1');
    fvar.writeInt32BE(min * 65536, r + 4);
    fvar.writeInt32BE(min * 65536, r + 8);
    fvar.writeInt32BE(max * 65536, r + 12);
  });
  const body = Buffer.from(font.subarray(12 + n * 16));
  const fvarAt = 12 + (n + 1) * 16 + body.length;
  dir.write('fvar', n * 16, 'latin1');
  dir.writeUInt32BE(fvarAt, n * 16 + 8);
  dir.writeUInt32BE(fvar.length, n * 16 + 12);
  return Buffer.concat([head, dir, body, fvar]);
}

const WOFF2 = (() => {
  const w = Buffer.alloc(60);
  w.write('wOF2', 0, 'latin1');
  w.writeUInt32BE(0x00010000, 4);
  w.writeUInt32BE(60, 8);
  w.writeUInt16BE(3, 12);
  return w;
})();

// Each case gets its own workspace and engine: none relies on what another left.
beforeEach(async () => {
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

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** The theme `acme` with a wordmark, fonts and a brand, as the first case writes it. */
const makeAcme = () =>
  engine.templates.create(
    input({
      wordmark: 'brand/wordmark.svg',
      fonts: { display: 'brand/Grotesk.ttf', body: ['brand/Body-A.ttf', 'brand/Body-B.ttf', { file: 'brand/Body-C.ttf' }] },
      brand: { name: 'Acme', url: 'acme.test' },
    }),
  );

describe('template_create_from_brand (engine)', () => {
  it('writes a new workspace theme: template.yaml, logo, wordmark, renamed fonts, LICENSES.md, provenance', async () => {
    const startersBefore = await folderHash(T);
    const made: ThemeCreated = await makeAcme();
    const dir = join(root, 'templates', 'acme');
    expect(made).toMatchObject({ name: 'acme', dir, base: 'editorial', replaced: false });
    expect(made.files).toEqual([
      'template.yaml',
      'logo.svg',
      'wordmark.svg',
      'fonts/display-Bold.ttf',
      'fonts/body-Regular.ttf',
      'fonts/body-SemiBold.ttf',
      'fonts/body-Bold.ttf',
      'LICENSES.md',
      THEME_PROVENANCE_FILE,
    ]);
    expect(made.fonts.map((f) => [f.file, f.weight, f.weight_from])).toEqual([
      ['fonts/display-Bold.ttf', 700, 'font'],
      ['fonts/body-Regular.ttf', 400, 'font'],
      ['fonts/body-SemiBold.ttf', 600, 'font'],
      ['fonts/body-Bold.ttf', 700, 'font'],
    ]);
    // The renderer reads each copy's weight back from its name.
    for (const f of made.fonts) expect(fontFileFace(f.file).weight, f.file).toBe(f.weight);
    // Loaded as a workspace theme, by name, with every asset in its folder.
    const t = await loadTemplate('acme', root, { files: fileFacts(PERSON_POLICY) });
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

  it("no fonts given: the base theme's files are copied as they are, with its LICENSES.md", async () => {
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
    await makeAcme();
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
      const e = await refusal(
        createThemeFromBrand({ ...(await loadWorkspaceConfig(ws)), policy: PERSON_POLICY, reads: diskWorkspaceReads, outputs: diskOutputs, registries: packageRegistries() }, input(), {
          trust: 'mcp',
          scope: personScope(ws, enginePorts()),
        }),
      );
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
    const before = await makeAcme();
    const r = await engine.templates.create(input({ colors: { accent: '#3352b8' }, replace: true }));
    expect(r).toMatchObject({ replaced: true, name: 'acme' });
    expect((await loadTemplate('acme', root, { files: fileFacts(PERSON_POLICY) })).template.colors.accent).toBe('#3352b8');
    expect(existsSync(join(before.dir, 'wordmark.svg'))).toBe(false);
    expect((await readdir(join(root, 'templates'))).filter((e) => e.startsWith('.'))).toEqual([]);

    const dir = join(root, 'templates', 'acme');
    const yaml = join(dir, 'template.yaml');
    const text = await readFile(yaml, 'utf8');
    await writeFile(yaml, text.replace('style_bias: real', 'style_bias: motion'));
    expect(await refusal(engine.templates.create(input({ replace: true })))).toMatchObject({
      code: 'refused',
      message: expect.stringMatching(/template.yaml was changed since it was made.*never overwritten/),
    });
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
    await mkdir(join(root, 'templates', 'Mixed'));
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

  it('a dark paper over a light base gets the light cursor and a note (no warning); the accent that fails is suggested, never changed', async () => {
    const c = await engine.templates.create(input({ name: 'night', colors: { accent: '#ffdd00', paper: '#11131c' } }));
    expect(c.palette.tone).toBe('dark');
    expect(c.warnings.join('\n')).not.toMatch(/consider base|makes a dark theme/);
    expect(c.notes?.join('\n')).toMatch(/dark paper over editorial \(a light theme\): cursor arrow-light chosen.*set cursor.style if your app's UI is light/);
    expect((await loadTemplate('night', root, { files: fileFacts(PERSON_POLICY) })).template.cursor).toMatchObject({ style: 'arrow-light' });
    const y = await engine.templates.create(input({ name: 'yellow', colors: { accent: '#ffdd00' } }));
    expect(y.palette.colors.accent).toBe('#ffdd00');
    expect(y.palette.suggestions.accent).toMatch(/^#/);
    expect((await loadTemplate('yellow', root, { files: fileFacts(PERSON_POLICY) })).template.colors.accent).toBe('#ffdd00');
  });

  it("the cursor: a given cursor.style wins over the tone; the same tone keeps the base's; a light paper over motion gets arrow-dark", async () => {
    const given = await engine.templates.create(input({ name: 'given', colors: { accent: '#ffdd00', paper: '#11131c' }, cursor: { style: 'arrow-dark', size: 30 } }));
    expect(given.notes ?? []).toEqual([]);
    expect((await loadTemplate('given', root, { files: fileFacts(PERSON_POLICY) })).template.cursor).toMatchObject({ style: 'arrow-dark', size: 30 });
    const same = await engine.templates.create(input({ name: 'same', colors: { accent: '#0e7c66', paper: '#fbfaf7' } }));
    expect(same.notes).toBeUndefined();
    expect((await loadTemplate('same', root, { files: fileFacts(PERSON_POLICY) })).template.cursor.style).toBe('arrow-dark');
    const motionDark = await engine.templates.create(input({ name: 'night2', base: 'motion', colors: { accent: '#ff5c38', paper: '#101218' } }));
    expect(motionDark.notes).toBeUndefined();
    expect((await loadTemplate('night2', root, { files: fileFacts(PERSON_POLICY) })).template.cursor).toMatchObject({ style: 'arrow-dark', size: 28 });
    const light = await engine.templates.create(input({ name: 'day', base: 'motion', colors: { accent: '#0e7c66', paper: '#fbfaf7' } }));
    expect(light.notes?.join('\n')).toMatch(/light paper over motion \(a dark theme\): cursor arrow-dark chosen/);
    expect((await loadTemplate('day', root, { files: fileFacts(PERSON_POLICY) })).template.cursor.style).toBe('arrow-dark');
    expect(await refusal(engine.templates.create(input({ name: 'big', cursor: { style: 'debug' } })))).toMatchObject({ code: 'invalid' });
    expect(await refusal(engine.templates.create(input({ name: 'big', cursor: { size: 200 } })))).toMatchObject({ code: 'invalid' });
  });

  it('a wide logo (3:1 and wider) is written as logo_kind: wordmark and said in a note; logo_kind: mark keeps it a mark', async () => {
    const png = (w: number, h: number) => {
      const b = Buffer.alloc(33);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
      b.writeUInt32BE(13, 8);
      b.write('IHDR', 12, 'latin1');
      b.writeUInt32BE(w, 16);
      b.writeUInt32BE(h, 20);
      return b;
    };
    await writeFile(join(root, 'brand', 'wide.png'), png(2048, 181));
    await writeFile(join(root, 'brand', 'almost.png'), png(299, 100));
    await writeFile(join(root, 'brand', 'three.png'), png(300, 100));
    const wide = await engine.templates.create(input({ name: 'wide', logo: 'brand/wide.png', brand: { name: 'Northfield' } }));
    expect(wide.logo_kind).toBe('wordmark');
    expect(wide.notes?.join('\n')).toMatch(/the logo is wide \(11\.3:1\): drawn as a wordmark/);
    expect(wide.template_yaml).toMatch(/^logo: logo\.png\nlogo_kind: wordmark$/m);
    const loaded = await loadTemplate('wide', root, { files: fileFacts(PERSON_POLICY) });
    expect(loaded.template.logo_kind).toBe('wordmark');
    expect(loaded.assets.logo_aspect).toBe(11.3149);
    // 3:1 exactly is a wordmark, 2.99:1 a mark (nothing written).
    expect((await engine.templates.create(input({ name: 'three', logo: 'brand/three.png' }))).logo_kind).toBe('wordmark');
    const almost = await engine.templates.create(input({ name: 'almost', logo: 'brand/almost.png' }));
    expect(almost.logo_kind).toBe('mark');
    expect(almost.template_yaml).not.toContain('logo_kind');
    // Explicit wins: a mark stays a mark (written), no note; a wordmark image next to a wordmark logo is warned.
    const mark = await engine.templates.create(input({ name: 'markwide', logo: 'brand/wide.png', logo_kind: 'mark' }));
    expect(mark.logo_kind).toBe('mark');
    expect(mark.notes ?? []).toEqual([]);
    expect(mark.template_yaml).toMatch(/^logo_kind: mark$/m);
    const both = await engine.templates.create(input({ name: 'both', logo: 'brand/wide.png', wordmark: 'brand/wordmark.svg' }));
    expect(both.warnings.join('\n')).toMatch(/wordmark image is kept in the theme folder but not drawn .* while logo_kind is wordmark/);
    // No brand name and no wordmark: the outro "logo alone" warning is a mark's only.
    expect(wide.warnings.join('\n')).not.toMatch(/logo alone/);
    expect(almost.warnings.join('\n')).toMatch(/no wordmark and no brand.name: the outro shows the logo alone/);
  });

  it("an SVG with one side and a viewBox: the viewBox's proportions (a square mark stays a mark), as the loader reads it; a degenerate size is a mark", async () => {
    await writeFile(join(root, 'brand', 'square.svg'), '<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 100 100"><rect width="100" height="100"/></svg>');
    await writeFile(join(root, 'brand', 'dash.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1100" viewBox="0 0 110 10"><rect width="110" height="10"/></svg>');
    await writeFile(join(root, 'brand', 'huge.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="0.00001"><rect width="1" height="1"/></svg>');
    const square = await engine.templates.create(input({ name: 'square', logo: 'brand/square.svg', brand: { name: 'Northfield' } }));
    expect(square.logo).toMatchObject({ width: 24, height: 24 });
    expect(square.logo_kind).toBe('mark');
    expect(square.notes ?? []).toEqual([]);
    expect((await loadTemplate('square', root, { files: fileFacts(PERSON_POLICY) })).assets.logo_aspect).toBe(1);
    const dash = await engine.templates.create(input({ name: 'dash', logo: 'brand/dash.svg' }));
    expect(dash.logo_kind).toBe('wordmark');
    expect(dash.notes?.join('\n')).toMatch(/the logo is wide \(11\.0:1\)/);
    expect((await loadTemplate('dash', root, { files: fileFacts(PERSON_POLICY) })).assets.logo_aspect).toBe(11);
    const huge = await engine.templates.create(input({ name: 'huge', logo: 'brand/huge.svg' }));
    expect(huge.logo_kind).toBe('mark');
    expect(JSON.stringify(huge)).not.toMatch(/Infinity/);
  });

  it('create and the loader read one kind: a fake wide root in a comment longer than the head the loader reads is never read', async () => {
    // The fake root lies in the head, the comment's end beyond it.
    const note = `<!-- <svg width="1100" height="100"> ${'n'.repeat(300 * 1024)} -->`;
    await writeFile(join(root, 'brand', 'noted.svg'), `<?xml version="1.0"?>${note}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100"/></svg>`);
    const c = await engine.templates.create(input({ name: 'noted', logo: 'brand/noted.svg' }));
    expect(c.logo_kind).toBe('mark');
    const loaded = await loadTemplate('noted', root, { files: fileFacts(PERSON_POLICY) });
    expect(loaded.assets.logo_aspect).toBeUndefined();
    const { resolveLogoKind } = await import('@retake/components');
    expect(resolveLogoKind(loaded.template.logo_kind, loaded.assets.logo_aspect)).toBe(c.logo_kind);
  });

  it("components: params merge over the base's entry, another id takes only its own params, a bad id or param is invalid and nothing is written", async () => {
    const c = await engine.templates.create(input({ name: 'small', components: { outro: { params: { logo_size: 72 } }, layout: { params: { radius: 8 } } } }));
    const t = (await loadTemplate('small', root, { files: fileFacts(PERSON_POLICY) })).template;
    expect(t.components?.outro).toEqual({ id: 'studio/outro-stack', params: { logo_size: 72 } });
    expect(t.components?.layout).toEqual({ id: 'studio/layout-card', params: { width: 1560, radius: 8, shadow: 'soft' } });
    expect(t.components?.intro).toBe('studio/intro-stack');
    expect(c.template_yaml).toMatch(/^ {2}outro: \{id: studio\/outro-stack, params: \{logo_size: 72\}\}$/m);
    const other = await engine.templates.create(
      input({ name: 'other', components: { transition: { id: 'studio/transition-fade-black' }, intro: { id: 'studio/intro-minimal', params: { logo_only: true } } } }),
    );
    const o = (await loadTemplate('other', root, { files: fileFacts(PERSON_POLICY) })).template;
    expect(o.components?.transition).toBe('studio/transition-fade-black');
    expect(o.components?.intro).toEqual({ id: 'studio/intro-minimal', params: { logo_only: true } });
    expect(other.files).toContain('template.yaml');
    const before = await readdir(join(root, 'templates'));
    for (const bad of [{ outro: { id: 'studio/no-such' } }, { outro: { params: { logo_size: 9999 } } }, { outro: { params: { colour: 'red' } } }]) {
      const e = await refusal(engine.templates.create(input({ name: 'bad', components: bad })));
      expect(e.code, JSON.stringify(bad)).toBe('invalid');
    }
    expect(await refusal(engine.templates.create(input({ name: 'bad', components: { outro: { id: 'Not An Id' } } })))).toMatchObject({ code: 'invalid' });
    expect(await refusal(engine.templates.create(input({ name: 'bad', components: { sidebar: { id: 'studio/outro-stack' } } })))).toMatchObject({ code: 'invalid' });
    expect(await readdir(join(root, 'templates'))).toEqual(before);
  });

  it('a component entry removes the legacy field it contradicts (intro.layout with another intro), a string base entry is expanded', async () => {
    const c = await engine.templates.create(input({ name: 'quiet', components: { intro: { id: 'studio/intro-minimal' } } }));
    const loaded = await loadTemplate('quiet', root, { files: fileFacts(PERSON_POLICY) });
    expect(loaded.template.components?.intro).toBe('studio/intro-minimal');
    expect(c.template_yaml).not.toMatch(/layout: logo-kicker-title/);
    expect(c.template_yaml).toMatch(/^intro: \{duration: 3\.2\}$/m);
    expect(c.notes?.join('\n')).toMatch(/legacy fields of editorial the components given replace, removed: intro\.layout/);
    const { parseTemplateYaml } = await import('@retake/core');
    expect(parseTemplateYaml(c.template_yaml).issues).toEqual([]);
  });

  it('up to 8 body files; a 9th is invalid', async () => {
    const body = Array.from({ length: 8 }, (_, i) => ({ file: 'brand/Body-A.ttf', weight: (i + 1) * 100 }));
    await writeFile(join(root, 'brand', 'Body-9.woff2'), WOFF2);
    const c = await engine.templates.create(input({ name: 'eight', fonts: { body } }));
    expect(c.fonts.filter((f) => f.role === 'body')).toHaveLength(8);
    expect(await refusal(engine.templates.create(input({ name: 'nine', fonts: { body: [...body, 'brand/Body-9.woff2'] } })))).toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/fonts\.body/),
    });
  });

  it('a variable body font: {file, weight: "200 800"} is one face for the range, copied as fonts/body-wght200-800', async () => {
    await writeFile(join(root, 'brand', 'Sans-Variable.woff2'), WOFF2);
    const c = await engine.templates.create(input({ name: 'vary', fonts: { body: [{ file: 'brand/Sans-Variable.woff2', weight: '200 800' }] } }));
    const body = c.fonts.filter((f) => f.role === 'body');
    expect(body.map((f) => [f.file, f.weight, f.weight_from])).toEqual([['fonts/body-wght200-800.woff2', [200, 800], 'input']]);
    // The caption kicker of editorial (body 600) lies inside the range: no warning.
    expect(c.warnings.join('\n')).not.toMatch(/captions\.kicker/);
    const t = await loadTemplate('vary', root, { files: fileFacts(PERSON_POLICY) });
    expect(t.template.fonts.body).toEqual(['fonts/body-wght200-800.woff2']);
    expect(fontFileFace(t.assets.body[0])).toEqual({ weight: [200, 800], style: 'normal' });
    expect(await readFile(join(c.dir, 'LICENSES.md'), 'utf8')).toMatch(/body, 200–800 \(woff2\)/);
    expect(await refusal(engine.templates.create(input({ name: 'flat', fonts: { body: [{ file: 'brand/Sans-Variable.woff2', weight: '420 440' }] } })))).toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/one weight once rounded/),
    });
    for (const w of ['800 200', '200-800', '50 900', '200 1000'])
      expect((await refusal(engine.templates.create(input({ name: 'bad', fonts: { body: [{ file: 'brand/Sans-Variable.woff2', weight: w }] } })))).code, w).toBe('invalid');
  });

  it("a TTF's fvar gives the range when the input gives none; another axis alone leaves it static", async () => {
    const ttf = await readFile(join(root, 'brand', 'Body-A.ttf'));
    await writeFile(
      join(root, 'brand', 'Var.ttf'),
      withFvar(ttf, [
        ['wdth', 75, 100],
        ['wght', 300, 700],
      ]),
    );
    await writeFile(join(root, 'brand', 'Wide.ttf'), withFvar(ttf, [['wdth', 75, 100]]));
    const c = await engine.templates.create(input({ name: 'fvar', fonts: { display: 'brand/Var.ttf', body: ['brand/Wide.ttf'] } }));
    expect(c.fonts.map((f) => [f.file, f.weight, f.weight_from])).toEqual([
      ['fonts/display-wght300-700.ttf', [300, 700], 'font'],
      ['fonts/body-Regular.ttf', 400, 'font'],
    ]);
  });

  it('two body faces that serve one weight are invalid: a static weight inside a range of its style, two ranges that meet', async () => {
    await writeFile(join(root, 'brand', 'V.woff2'), WOFF2);
    await writeFile(join(root, 'brand', 'W.woff2'), WOFF2);
    const inside = await refusal(engine.templates.create(input({ name: 'inside', fonts: { body: [{ file: 'brand/V.woff2', weight: '200 800' }, 'brand/Body-B.ttf'] } })));
    expect(inside).toMatchObject({ code: 'invalid', message: expect.stringMatching(/two body fonts serve the same weight \(200–800 and 600\)/) });
    const meet = await refusal(
      engine.templates.create(
        input({
          name: 'meet',
          fonts: {
            body: [
              { file: 'brand/V.woff2', weight: '200 500' },
              { file: 'brand/W.woff2', weight: '500 800' },
            ],
          },
        }),
      ),
    );
    expect(meet).toMatchObject({ code: 'invalid', message: expect.stringMatching(/200–500 and 500–800/) });
    // Ranges side by side, and an italic beside the upright range, are fine.
    const ok = await engine.templates.create(
      input({
        name: 'apart',
        fonts: {
          body: [
            { file: 'brand/V.woff2', weight: '200 400' },
            { file: 'brand/W.woff2', weight: '500 800' },
            { file: 'brand/Body-B.ttf', italic: true },
          ],
        },
      }),
    );
    expect(ok.fonts.filter((f) => f.role === 'body').map((f) => f.file)).toEqual(['fonts/body-wght200-400.woff2', 'fonts/body-wght500-800.woff2', 'fonts/body-SemiBoldItalic.ttf']);
  });

  it("fileNameFace reads a copy's wght<min>-<max> as its range, never as its max", () => {
    expect(fileNameFace('fonts/body-wght200-800.woff2')).toEqual({ weight: [200, 800], italic: false });
    expect(fileNameFace('fonts/body-wght200-800Italic.woff2')).toEqual({ weight: [200, 800], italic: true });
    expect(fileNameFace('Brand-SemiBold.woff2')).toEqual({ weight: 600, italic: false });
  });

  it('WOFF / WOFF2 weights come from the style token after the last "-" or "_": a family word never reads as a weight', async () => {
    for (const f of ['LighthouseSans-Regular', 'LighthouseSans-Bold', 'Boldwick', 'Heavyweight_SemiBoldItalic']) await writeFile(join(root, 'brand', `${f}.woff2`), WOFF2);
    const c = await engine.templates.create(
      input({ name: 'lighthouse', fonts: { display: 'brand/Heavyweight_SemiBoldItalic.woff2', body: ['brand/LighthouseSans-Regular.woff2', 'brand/LighthouseSans-Bold.woff2'] } }),
    );
    expect(c.fonts.map((f) => [f.file, f.weight, f.italic, f.weight_from])).toEqual([
      ['fonts/display-SemiBoldItalic.woff2', 600, true, 'file name'],
      ['fonts/body-Regular.woff2', 400, false, 'file name'],
      ['fonts/body-Bold.woff2', 700, false, 'file name'],
    ]);
    expect(c.warnings.join('\n')).toMatch(
      /body font brand\/LighthouseSans-Regular\.woff2: weight 400 read from the file name \(WOFF2 files keep it compressed\) — give \{file, weight\} if it is wrong/,
    );
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
    const ws = { ...(await loadWorkspaceConfig(root)), policy: PERSON_POLICY, reads: diskWorkspaceReads, outputs: diskOutputs, registries: packageRegistries() };
    await createThemeFromBrand(ws, input({ name: 'bob' }), { trust: 'author', cwd: root, scope: personScope(root, enginePorts()) });
    expect(await refusal(engine.templates.create(input({ name: 'bob', colors: { accent: '#00aa00' }, replace: true })))).toMatchObject({
      code: 'refused',
      message: expect.stringMatching(/was made by a human with retake theme create: through MCP only a theme made through MCP is replaced/),
    });
    expect((await loadTemplate('bob', root, { files: fileFacts(PERSON_POLICY) })).template.colors.accent).toBe('#0e7c66');
    await engine.templates.create(input({ name: 'carol' }));
    expect(
      (await createThemeFromBrand(ws, input({ name: 'carol', colors: { accent: '#00aa00' }, replace: true }), { trust: 'author', cwd: root, scope: personScope(root, enginePorts()) })).replaced,
    ).toBe(true);
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
    expect((await readdir(tpl)).filter((e) => e.startsWith('.')).sort()).toEqual([
      '.old-acme',
      '.tmp-Acme-0123456789af',
      '.tmp-acme-0123456789ac',
      '.tmp-acme-0123456789ad',
      '.tmp-acme-0123456789ae',
      '.tmp-mywork',
    ]);
    expect(await readFile(join(tpl, '.tmp-mywork', 'notes.txt'), 'utf8')).toBe('mine');
  });

  it('an unknown base is not found; a base cannot be the theme itself', async () => {
    expect(await refusal(engine.templates.create(input({ name: 'nob', base: 'nope' })))).toMatchObject({ code: 'not_found' });
    expect(await refusal(engine.templates.create(input({ name: 'self', base: 'self' })))).toMatchObject({ code: 'invalid' });
  });

  it('⚑ a base theme font held by a hard link is refused (never copied into the new theme)', async () => {
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
