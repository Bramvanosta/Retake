/**
 * Fonts by reference (R-FLD-45, R-SEC-42): the font fetch (engine brand/fontsource-fetch.ts) against a fake of the
 * font registry port serving synthetic tarballs in process — nothing reaches the network — and the font store it
 * writes (brand/fontsource-store.ts), which a theme's create and update read offline.
 *
 * Fetch: a pinned OFL package keeps the latin WOFF2 of each face and the LICENSE, with a hashed record; latest is
 * resolved and recorded; one manifest and one tarball per package per call; a stored pinned version is not fetched
 * again; refusals — another licence, a name or version that does not match, a tarball URL off the registry, an
 * integrity mismatch (nothing parsed), a tarball over its cap, an archive over the unpacked cap, a face the package
 * lacks (its latin faces listed), a stored version whose integrity changed, too many packages, a pinned and an unpinned
 * ref of one id, a broken registry (the guard) before anyone is asked. An agent's fetch asks a person first: no
 * approver → needs_approval with the command, a decline → refused, and the port is never called.
 *
 * Create / update: a `fontsource:` ref is the store's face (copied, its face from the ref, LICENSES.md citing package,
 * version, integrity and LICENSE text), an unpinned one the newest stored, a missing one not_found with the exact
 * fetch command, a changed store file or record refused; update reuses the theme's copy and keeps the citation; the
 * create never calls the registry.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES_DIR } from '@retake/core/io';
import { createEngine } from '../src/index.js';
import type { ApprovalOutcome, Engine, EngineError, FontsApprovalRequest } from '../src/index.js';
import { fetchFonts } from '../src/brand/fontsource-fetch.js';
import { fetchCommand, fontStoreDir, storeRecordHash } from '../src/brand/fontsource-store.js';
import { createThemeFromBrand } from '../src/brand/create.js';
import { readBrandFile } from '../src/brand/files.js';
import { personScope } from '../src/store/project-store.js';
import { systemClock } from '../src/clock.js';
import { enginePorts } from '../src/ports.js';
import { LICENCE_TEXT, fakePackage, fakeRegistry, tgzOf, woff2 } from '@retake/test-support/fontsource';
import type { FakePackage } from '@retake/test-support/fontsource';

let root: string;
let engine: Engine;

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x as EngineError,
  );
  if (!e) throw new Error('expected a refusal');
  return e;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-fontsource-'));
  await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
  await mkdir(join(root, 'brand'), { recursive: true });
  await cp(join(STARTER_TEMPLATES_DIR, 'editorial', 'logo.svg'), join(root, 'brand', 'logo.svg'));
  await mkdir(join(root, 'templates'), { recursive: true });
  engine = await createEngine({ root, client: 'mcp', autoStartWorker: false });
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** A person's fetch (the CLI's: no question). */
const fetchAs = (registry: ReturnType<typeof fakeRegistry>, refs: string[]) => fetchFonts(engine.workspace, { refs }, { registry, clock: systemClock, ask: false });

const approving = (answer: ApprovalOutcome = { approved: true }) => {
  const asked: FontsApprovalRequest[] = [];
  return {
    asked,
    approver: { approve: async () => answer, approveFonts: async (r: FontsApprovalRequest) => (asked.push(r), answer) },
  };
};

const store = (...p: string[]) => join(fontStoreDir({ root }), ...p);

describe('font fetch (fake registry)', () => {
  it('a pinned OFL package: the latin woff2 of each face and the LICENSE are stored with a hashed record', async () => {
    const pkg = fakePackage({ faces: ['400', '600', '400italic'] });
    const reg = fakeRegistry([pkg]);
    const f = await fetchAs(reg, ['fontsource:test-sans@5.2.1:400', 'fontsource:test-sans@5.2.1:600', 'fontsource:test-sans@5.2.1']);
    expect(f.refs).toEqual(['fontsource:test-sans@5.2.1:400', 'fontsource:test-sans@5.2.1:600']);
    expect(f.packages[0]).toMatchObject({ package: '@fontsource/test-sans', version: '5.2.1', licence: 'OFL-1.1', integrity: pkg.integrity, resolved: false, downloaded: true, dir: '.retake/fonts/fontsource/test-sans@5.2.1' });
    const record = JSON.parse(await readFile(store('test-sans@5.2.1', 'record.json'), 'utf8'));
    expect(record).toMatchObject({ package: '@fontsource/test-sans', package_version: '5.2.1', licence: 'OFL-1.1', registry: 'https://registry.npmjs.org', integrity: pkg.integrity, tarball: 'https://registry.npmjs.org/@fontsource/test-sans/-/test-sans-5.2.1.tgz' });
    // Only the faces asked and the LICENSE: never the latin-ext file, the italic nobody asked for, package.json.
    expect(Object.keys(record.files).sort()).toEqual(['LICENSE', 'latin-400-normal.woff2', 'latin-600-normal.woff2']);
    expect(await readFile(store('test-sans@5.2.1', 'LICENSE'), 'utf8')).toBe(LICENCE_TEXT);
    expect(record.files['latin-600-normal.woff2']).toBe(createHash('sha256').update(woff2('test-sans-5.2.1-600')).digest('hex'));
    // One manifest and one tarball per package per call, whatever the number of faces.
    expect(reg.calls).toEqual(['/@fontsource%2ftest-sans/5.2.1', '/@fontsource/test-sans/-/test-sans-5.2.1.tgz']);
  });

  it('latest resolves and is recorded; a pinned version stored with every face is answered from the store (no call)', async () => {
    const reg = fakeRegistry([fakePackage({ version: '5.1.0' }), fakePackage({ version: '5.10.2' })]);
    const f = await fetchAs(reg, ['fontsource:test-sans:600']);
    expect(f.packages[0]).toMatchObject({ version: '5.10.2', resolved: true });
    expect(f.refs).toEqual(['fontsource:test-sans@5.10.2:600']);
    expect(reg.calls[0]).toBe('/@fontsource%2ftest-sans/latest');
    const again = fakeRegistry([]);
    const g = await fetchAs(again, ['fontsource:test-sans@5.10.2:600']);
    expect(again.calls).toEqual([]);
    expect(g.packages[0]).toMatchObject({ downloaded: false, faces: [{ state: 'stored' }] });
    // A face more: fetched again, the stored one kept, the integrity compared with the record.
    const more = fakeRegistry([fakePackage({ version: '5.10.2' })]);
    const h = await fetchAs(more, ['fontsource:test-sans@5.10.2:600', 'fontsource:test-sans@5.10.2:400']);
    expect(h.packages[0].faces.map((x) => x.state)).toEqual(['stored', 'fetched']);
    expect(Object.keys(JSON.parse(await readFile(store('test-sans@5.10.2', 'record.json'), 'utf8')).files).sort()).toEqual(['LICENSE', 'latin-400-normal.woff2', 'latin-600-normal.woff2']);
  });

  it('refused: another licence, a licence expression, a name or version that does not match, a tarball URL off the registry, no integrity', async () => {
    const bad = async (manifest: (m: Record<string, unknown>) => Record<string, unknown>, ref = 'fontsource:test-sans@5.2.1:400') => {
      const pkg = fakePackage({});
      const reg = fakeRegistry([pkg], { override: (p) => (p.startsWith('/@fontsource%2f') ? Buffer.from(JSON.stringify(manifest(pkg.manifest('https://registry.npmjs.org')))) : undefined) });
      const e = await refusal(fetchAs(reg, [ref]));
      // The manifest only: nothing past it was asked.
      expect(reg.calls.length).toBe(1);
      return e;
    };
    expect((await bad((m) => ({ ...m, license: 'UFL-1.0' }))).message).toMatch(/declares the licence "UFL-1.0".*only OFL-1.1 or Apache-2.0/);
    expect((await bad((m) => ({ ...m, license: '(OFL-1.1 OR MIT)' }))).message).toMatch(/licence/);
    expect((await bad((m) => ({ ...m, license: undefined }))).message).toMatch(/licence null/);
    expect((await bad((m) => ({ ...m, name: '@fontsource/other' }))).message).toMatch(/another package/);
    expect((await bad((m) => ({ ...m, version: '5.2.2' }))).message).toMatch(/version 5.2.2, not 5.2.1/);
    expect((await bad((m) => ({ ...m, dist: { ...(m.dist as object), tarball: 'https://cdn.example.com/test-sans-5.2.1.tgz' } }))).message).toMatch(/never followed/);
    expect((await bad((m) => ({ ...m, dist: { ...(m.dist as object), tarball: 'https://registry.npmjs.org/@fontsource/test-sans/-/test-sans-5.2.1.tgz?x' } }))).message).toMatch(/never followed/);
    expect((await bad((m) => ({ ...m, dist: { ...(m.dist as object), integrity: 'sha1-abc' } }))).message).toMatch(/sha512 integrity/);
    for (const e of [await bad((m) => ({ ...m, license: 'MIT' }))]) expect(e.code).toBe('refused');
  });

  it('an integrity mismatch is refused before the archive is parsed (a valid archive that would fail its parse)', async () => {
    // A well-formed tarball whose package.json disagrees: parsed first, it would say so; checked first, the integrity says it.
    const listed = fakePackage({});
    const other = fakePackage({ pjLicence: 'MIT' });
    const reg = fakeRegistry([listed], { override: (p) => (p.endsWith('.tgz') ? other.tgz : undefined) });
    const e = await refusal(fetchAs(reg, ['fontsource:test-sans@5.2.1:400']));
    expect(e.message).toMatch(/sha512 is not the integrity.*nothing was read/);
    expect(e.message).not.toMatch(/package\.json/);
    await expect(readFile(store('test-sans@5.2.1', 'record.json'))).rejects.toThrow();
  });

  it('refused: a tarball over 30 MB, an archive over the unpacked cap, a package.json that disagrees, no LICENSE, a non-WOFF2 face', async () => {
    const big = Buffer.alloc(31 * 1024 * 1024);
    const reg = fakeRegistry([fakePackage({})], { override: (p) => (p.endsWith('.tgz') ? big : undefined) });
    expect((await refusal(fetchAs(reg, ['fontsource:test-sans@5.2.1']))).message).toMatch(/more than 31457280 bytes/);

    const bomb = (() => {
      const entries = [{ name: 'package/zeros', data: Buffer.alloc(201 * 1024 * 1024) }];
      const tgz = tgzOf(entries);
      return fakePackageWith(tgz);
    })();
    expect((await refusal(fetchAs(fakeRegistry([bomb]), ['fontsource:test-sans@5.2.1']))).message).toMatch(/once unpacked/);

    expect((await refusal(fetchAs(fakeRegistry([fakePackage({ pjLicence: 'MIT' })]), ['fontsource:test-sans@5.2.1']))).message).toMatch(/package\.json does not agree/);
    expect((await refusal(fetchAs(fakeRegistry([fakePackage({ licenceFile: false })]), ['fontsource:test-sans@5.2.1']))).message).toMatch(/no LICENSE/);
    const fake = fakePackage({ entries: [{ name: 'package/package.json', data: JSON.stringify({ name: '@fontsource/test-sans', version: '5.2.1', license: 'OFL-1.1' }) }, { name: 'package/LICENSE', data: 'x' }, { name: 'package/files/test-sans-latin-400-normal.woff2', data: 'not a font' }] });
    expect((await refusal(fetchAs(fakeRegistry([fake]), ['fontsource:test-sans@5.2.1']))).message).toMatch(/not a usable font/);
    await expect(readFile(store('test-sans@5.2.1', 'record.json'))).rejects.toThrow();
  });

  it('a face the package lacks is invalid, its latin faces listed; an entry with ../ or a link refuses the archive (nothing written)', async () => {
    const e = await refusal(fetchAs(fakeRegistry([fakePackage({ faces: ['300', '400', '700italic'] })]), ['fontsource:test-sans@5.2.1:600']));
    expect(e.code).toBe('invalid');
    expect(e.message).toMatch(/no latin 600: its latin faces are 300, 400, 700 italic/);
    const evil = fakePackage({ extra: [{ name: 'package/../../escape.txt', data: 'x' }] });
    expect((await refusal(fetchAs(fakeRegistry([evil]), ['fontsource:test-sans@5.2.1']))).message).toMatch(/goes out/);
    const link = fakePackage({ extra: [{ name: 'package/files/test-sans-latin-900-normal.woff2', type: '2' }] });
    expect((await refusal(fetchAs(fakeRegistry([link]), ['fontsource:test-sans@5.2.1']))).message).toMatch(/a link/);
    await expect(readFile(join(root, '.retake', 'escape.txt'))).rejects.toThrow();
    await expect(readFile(store('test-sans@5.2.1', 'record.json'))).rejects.toThrow();
  });

  it('a stored version the registry now lists with another integrity is refused, the store unchanged', async () => {
    await fetchAs(fakeRegistry([fakePackage({})]), ['fontsource:test-sans@5.2.1:400']);
    const before = await readFile(store('test-sans@5.2.1', 'record.json'), 'utf8');
    const changed = fakePackage({ extra: [{ name: 'package/README.md', data: 'new' }] });
    const e = await refusal(fetchAs(fakeRegistry([changed]), ['fontsource:test-sans@5.2.1:600']));
    expect(e.message).toMatch(/another tarball \(integrity\) than the one the store recorded/);
    expect(await readFile(store('test-sans@5.2.1', 'record.json'), 'utf8')).toBe(before);
  });

  it('at most 3 packages per call; one id pinned and unpinned at once is refused; bad refs are invalid — nothing asked', async () => {
    const reg = fakeRegistry([]);
    expect((await refusal(fetchAs(reg, ['fontsource:a-sans:400', 'fontsource:b-sans:400', 'fontsource:c-sans:400', 'fontsource:d-sans:400']))).message).toMatch(/at most 3/);
    expect((await refusal(fetchAs(reg, ['fontsource:a-sans:400', 'fontsource:a-sans@1.0.0:600']))).message).toMatch(/both pinned and unpinned/);
    expect((await refusal(fetchAs(reg, ['fontsource:A']))).code).toBe('invalid');
    expect((await refusal(fetchAs(reg, ['brand/Body.ttf']))).code).toBe('invalid');
    expect(reg.calls).toEqual([]);
  });

  it("through MCP, a fetch asks a human first: no approver → needs_approval with the command, a decline → refused, and the port is never called", async () => {
    const reg = fakeRegistry([fakePackage({})]);
    const mcp = await createEngine({ root, client: 'mcp', autoStartWorker: false, ports: { fontRegistry: reg } });
    const none = await refusal(mcp.templates.fetchFonts({ refs: ['fontsource:test-sans@5.2.1:400'] }));
    expect(none.code).toBe('needs_approval');
    expect(none.fix).toBe(`retake -C ${root} theme fetch-font fontsource:test-sans@5.2.1:400`);
    const no = approving({ approved: false, reason: 'declined' });
    const declined = await refusal(mcp.templates.fetchFonts({ refs: ['fontsource:test-sans@5.2.1:400'] }, { approver: no.approver }));
    expect(declined.code).toBe('refused');
    expect(declined.message).toMatch(/Do not retry/);
    expect(reg.calls).toEqual([]);
    expect(no.asked[0]).toEqual({ what: 'fonts', registry: 'https://registry.npmjs.org', test_registry: false, packages: [{ package: '@fontsource/test-sans', version: '5.2.1', faces: ['400'] }], fix: none.fix });
    const yes = approving();
    const f = await mcp.templates.fetchFonts({ refs: ['fontsource:test-sans:400'] }, { approver: yes.approver });
    expect(yes.asked[0].packages[0].version).toBeNull();
    expect(f.refs).toEqual(['fontsource:test-sans@5.2.1:400']);
    // Stored now: asked again, answered from the store without a question.
    const again = approving({ approved: false, reason: 'declined' });
    await mcp.templates.fetchFonts({ refs: ['fontsource:test-sans@5.2.1:400'] }, { approver: again.approver });
    expect(again.asked).toEqual([]);
  });

  it("a registry that cannot fetch (the suite's guard, a malformed hatch) refuses before anyone is asked", async () => {
    const reg = { ...fakeRegistry([]), problem: 'RETAKE_TEST_NO_FONT_FETCH is set' };
    const mcp = await createEngine({ root, client: 'mcp', autoStartWorker: false, ports: { fontRegistry: reg } });
    const a = approving();
    const e = await refusal(mcp.templates.fetchFonts({ refs: ['fontsource:test-sans@5.2.1:400'] }, { approver: a.approver }));
    expect(e.message).toMatch(/RETAKE_TEST_NO_FONT_FETCH/);
    expect(a.asked).toEqual([]);
    expect(reg.calls).toEqual([]);
  });

  it('a test registry is named in the answer and the record, and warned', async () => {
    const reg = fakeRegistry([fakePackage({})], { base: 'http://127.0.0.1:4519', test: true });
    const f = await fetchAs(reg, ['fontsource:test-sans@5.2.1']);
    expect(f).toMatchObject({ registry: 'http://127.0.0.1:4519', test_registry: true });
    expect(f.warnings[0]).toMatch(/TEST registry/);
    expect(JSON.parse(await readFile(store('test-sans@5.2.1', 'record.json'), 'utf8'))).toMatchObject({ registry: 'http://127.0.0.1:4519', test_registry: true });
  });
});

/** A package whose tarball is `tgz` (its manifest's integrity that tarball's). */
function fakePackageWith(tgz: Buffer): FakePackage {
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
  return {
    id: 'test-sans',
    version: '5.2.1',
    tgz,
    integrity,
    manifest: (base) => ({ name: '@fontsource/test-sans', version: '5.2.1', license: 'OFL-1.1', dist: { tarball: `${base}/@fontsource/test-sans/-/test-sans-5.2.1.tgz`, integrity } }),
  };
}

describe('a theme from stored fonts (offline)', () => {
  const input = (fonts: Record<string, unknown>, o: Record<string, unknown> = {}) => ({ name: 'acme', colors: { accent: '#0e7c66' }, logo: 'brand/logo.svg', fonts, ...o });

  it('the store face is copied, its face from the ref; LICENSES.md cites package, version, integrity and LICENSE; no registry call', async () => {
    const pkg = fakePackage({ faces: ['400', '700', '400italic'] });
    await fetchAs(fakeRegistry([pkg]), ['fontsource:test-sans@5.2.1:400', 'fontsource:test-sans@5.2.1:700', 'fontsource:test-sans@5.2.1:400italic']);
    const reg = fakeRegistry([]);
    const mcp = await createEngine({ root, client: 'mcp', autoStartWorker: false, ports: { fontRegistry: reg } });
    const c = await mcp.templates.create(input({ display: 'fontsource:test-sans@5.2.1:700', body: ['fontsource:test-sans@5.2.1:400', 'fontsource:test-sans@5.2.1:400italic'] }));
    expect(reg.calls).toEqual([]);
    expect(c.fonts.map((f) => [f.file, f.weight, f.italic, f.weight_from, f.package])).toEqual([
      ['fonts/display-Bold.woff2', 700, false, 'input', '@fontsource/test-sans@5.2.1'],
      ['fonts/body-Regular.woff2', 400, false, 'input', '@fontsource/test-sans@5.2.1'],
      ['fonts/body-RegularItalic.woff2', 400, true, 'input', '@fontsource/test-sans@5.2.1'],
    ]);
    expect(c.warnings.join('\n')).not.toMatch(/400 assumed|read from the file name/);
    expect(await readFile(join(c.dir, 'fonts', 'body-RegularItalic.woff2'))).toEqual(woff2('test-sans-5.2.1-400italic'));
    const lic = await readFile(join(c.dir, 'LICENSES.md'), 'utf8');
    expect(lic).toContain('## Fonts from fontsource');
    expect(lic).toContain('### `@fontsource/test-sans` 5.2.1');
    expect(lic).toContain('- Licence (as its publisher declares it): OFL-1.1');
    expect(lic).toContain(`- Integrity: ${pkg.integrity.replace(/[\\`*_[\]()!<>|#~&]/g, '\\$&')}`);
    expect(lic).toContain('> This Font Software is licensed under the SIL Open Font License, Version 1.1.');
    expect(lic).toContain('`fonts/display-Bold.woff2`, `fonts/body-Regular.woff2`, `fonts/body-RegularItalic.woff2`');
    // Cited once per package, never as a "font supplied by the user" with an empty name table.
    expect(lic.match(/### `@fontsource/g)?.length).toBe(1);
    expect(lic).not.toContain('### `fonts/body-Regular.woff2`');
    const prov = JSON.parse(await readFile(join(c.dir, '.retake-theme.json'), 'utf8'));
    expect(prov.sources['fonts/body-Regular.woff2']).toBe('font:fontsource:test-sans@5.2.1:400');
  });

  it("an unpinned family is the newest version stored with every face asked of it — one version per family (noted, recorded pinned)", async () => {
    await fetchAs(fakeRegistry([fakePackage({ version: '5.1.0', faces: ['400', '600'] })]), ['fontsource:test-sans@5.1.0:400', 'fontsource:test-sans@5.1.0:600']);
    await fetchAs(fakeRegistry([fakePackage({ version: '5.3.0', faces: ['400'] })]), ['fontsource:test-sans@5.3.0:400']);
    const c = await engine.templates.create(input({ body: ['fontsource:test-sans:400', 'fontsource:test-sans:600'] }));
    // 5.3.0 has only 400: both faces come from 5.1.0, never one face of each version.
    expect(c.fonts.filter((f) => f.role === 'body').map((f) => f.source)).toEqual(['fontsource:test-sans@5.1.0:400', 'fontsource:test-sans@5.1.0:600']);
    expect(c.notes?.join('\n')).toMatch(/fontsource:test-sans:400 is fontsource:test-sans@5\.1\.0:400 \(the newest version the font store holds with every face asked/);
    const prov = JSON.parse(await readFile(join(c.dir, '.retake-theme.json'), 'utf8'));
    expect(prov.inputs.fonts.body).toEqual(['fontsource:test-sans@5.1.0:400', 'fontsource:test-sans@5.1.0:600']);
    const one = await engine.templates.create(input({ body: ['fontsource:test-sans:400'] }, { name: 'solo' }));
    expect(one.fonts.find((f) => f.role === 'body')?.source).toBe('fontsource:test-sans@5.3.0:400');
    // No stored version holds all three: refused, naming every face to fetch.
    const e = await refusal(engine.templates.create(input({ body: ['fontsource:test-sans:400', 'fontsource:test-sans:600', 'fontsource:test-sans:700'] }, { name: 'trio' })));
    expect(e.code).toBe('not_found');
    expect(e.fix).toBe(`retake -C ${root} theme fetch-font fontsource:test-sans:400 fontsource:test-sans:600 fontsource:test-sans:700`);
  });

  it('a ref the store lacks is not_found with the exact fetch to make; a fontsource ref is never a logo', async () => {
    const e = await refusal(engine.templates.create(input({ display: 'fontsource:test-sans@5.2.1:700' })));
    expect(e.code).toBe('not_found');
    expect(e.message).toMatch(/font_fetch \{refs: \["fontsource:test-sans@5\.2\.1:700"\]\}/);
    expect(e.fix).toBe(`retake -C ${root} theme fetch-font fontsource:test-sans@5.2.1:700`);
    await fetchAs(fakeRegistry([fakePackage({})]), ['fontsource:test-sans@5.2.1:400']);
    const face = await refusal(engine.templates.create(input({ display: 'fontsource:test-sans@5.2.1:600' })));
    expect(face.message).toMatch(/holds @fontsource\/test-sans@5\.2\.1 with 400, not this one/);
    const logo = await refusal(engine.templates.create({ name: 'acme', colors: { accent: '#0e7c66' }, logo: 'fontsource:test-sans@5.2.1:400' }));
    expect(logo.code).toBe('refused');
    // The CLI (trust author): the same store, the same refusal — never a local file named so.
    await writeFile(join(root, 'fontsource:test-sans@9.9.9:400'), 'x');
    const direct = await refusal(readBrandFile(engine.workspace, 'fontsource:test-sans@9.9.9:400', 'font', { trust: 'author', cwd: root }));
    expect(direct.message).toMatch(/is a fontsource reference: it is read from the font store/);
    const author = await refusal(createThemeFromBrand(engine.workspace, input({ display: 'fontsource:test-sans@9.9.9:400' }), { trust: 'author', cwd: root, scope: personScope(root, enginePorts()) }));
    expect(author.code).toBe('not_found');
    // Worded for the person at a terminal: the command first, no MCP tool.
    expect(author.message).toMatch(new RegExp(`fetch it first: retake -C ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} theme fetch-font fontsource:test-sans@9\\.9\\.9:400$`));
    expect(author.message).not.toContain('font_fetch');
  });

  it('a store file or record changed since the fetch is refused', async () => {
    await fetchAs(fakeRegistry([fakePackage({})]), ['fontsource:test-sans@5.2.1:400']);
    await writeFile(store('test-sans@5.2.1', 'latin-400-normal.woff2'), woff2('tampered'));
    expect((await refusal(engine.templates.create(input({ display: 'fontsource:test-sans@5.2.1:400' })))).message).toMatch(/changed since it was fetched/);
    await fetchAs(fakeRegistry([fakePackage({ version: '5.2.2' })]), ['fontsource:test-sans@5.2.2:400']);
    const rec = JSON.parse(await readFile(store('test-sans@5.2.2', 'record.json'), 'utf8'));
    await writeFile(store('test-sans@5.2.2', 'record.json'), JSON.stringify({ ...rec, licence: 'Apache-2.0' }));
    expect((await refusal(engine.templates.create(input({ display: 'fontsource:test-sans@5.2.2:400' })))).message).toMatch(/record .* was changed/);
  });

  it("template_update keeps the theme's copy of a stored font and its citation; a new stored face is read from the store", async () => {
    await fetchAs(fakeRegistry([fakePackage({ faces: ['400', '700'] })]), ['fontsource:test-sans@5.2.1:400', 'fontsource:test-sans@5.2.1:700']);
    await engine.templates.create(input({ body: ['fontsource:test-sans@5.2.1:400'] }));
    const u = await engine.templates.update({ name: 'acme', colors: { paper: '#f4efe6' } });
    expect(u.changed).toEqual(['colors.paper']);
    const lic = await readFile(join(u.dir, 'LICENSES.md'), 'utf8');
    expect(lic).toContain('### `@fontsource/test-sans` 5.2.1');
    expect(lic).toContain('`fonts/body-Regular.woff2`');
    const v = await engine.templates.update({ name: 'acme', fonts: { display: 'fontsource:test-sans:700' } });
    expect(v.fonts[0]).toMatchObject({ file: 'fonts/display-Bold.woff2', source: 'fontsource:test-sans@5.2.1:700', package: '@fontsource/test-sans@5.2.1' });
  });

  it("the Studio: brand_files lists the store's faces as refs, and its New theme takes one (offline, no approver)", async () => {
    await fetchAs(fakeRegistry([fakePackage({ faces: ['400', '700italic'] })]), ['fontsource:test-sans@5.2.1:400', 'fontsource:test-sans@5.2.1:700italic']);
    const reg = fakeRegistry([]);
    const ui = await createEngine({ root, client: 'ui', autoStartWorker: false, ports: { fontRegistry: reg } });
    const listed = await ui.templates.files('font');
    expect(listed.files.map((f) => f.ref)).toEqual(['fontsource:test-sans@5.2.1:400', 'fontsource:test-sans@5.2.1:700italic']);
    expect(listed.files[0].bytes).toBe(woff2('x').length);
    const c = await ui.templates.create(input({ display: 'fontsource:test-sans@5.2.1:700italic' }));
    expect(c.fonts[0]).toMatchObject({ file: 'fonts/display-BoldItalic.woff2', italic: true });
    // The Studio never fetches: font_fetch is not served there, and the create made no call.
    expect(reg.calls).toEqual([]);
  });

  it('a gzip that is no tarball at all never becomes a store folder', async () => {
    const pkg = fakePackageWith(gzipSync(Buffer.from('plain text')));
    expect((await refusal(fetchAs(fakeRegistry([pkg]), ['fontsource:test-sans@5.2.1']))).message).toMatch(/cut short|package archive/);
  });
});

describe('the store, the fetch and the update, hardened', () => {
  const input = (fonts: Record<string, unknown>, o: Record<string, unknown> = {}) => ({ name: 'acme', colors: { accent: '#0e7c66' }, logo: 'brand/logo.svg', fonts, ...o });
  const rewriteRecord = async (dir: string, change: (r: Record<string, unknown>) => Record<string, unknown>) => {
    const r = change(JSON.parse(await readFile(join(dir, 'record.json'), 'utf8')));
    const { record_sha256: _h, ...rest } = r;
    await writeFile(join(dir, 'record.json'), JSON.stringify({ ...r, record_sha256: storeRecordHash(rest as never) }));
  };

  it("a record naming a file that is neither the LICENSE nor a face, or no LICENSE, is not one Retake wrote (even with its hash recomputed)", async () => {
    await fetchAs(fakeRegistry([fakePackage({})]), ['fontsource:test-sans@5.2.1:400']);
    const dir = store('test-sans@5.2.1');
    await writeFile(join(dir, 'notes.txt'), 'x');
    await rewriteRecord(dir, (r) => ({ ...r, files: { ...(r.files as object), 'notes.txt': createHash('sha256').update('x').digest('hex') } }));
    expect((await refusal(engine.templates.create(input({ display: 'fontsource:test-sans@5.2.1:400' })))).message).toMatch(/not one Retake wrote/);
    await rewriteRecord(dir, (r) => {
      const files = { ...(r.files as Record<string, string>) };
      delete files['notes.txt'];
      delete files.LICENSE;
      return { ...r, files };
    });
    expect((await refusal(engine.templates.create(input({ display: 'fontsource:test-sans@5.2.1:400' })))).message).toMatch(/not one Retake wrote/);
  });

  it('a stored package whose LICENSE went missing is not "stored already": the fetch and the create both say to remove it and fetch again', async () => {
    await fetchAs(fakeRegistry([fakePackage({})]), ['fontsource:test-sans@5.2.1:400']);
    await rm(store('test-sans@5.2.1', 'LICENSE'));
    const reg = fakeRegistry([fakePackage({})]);
    const f = await refusal(fetchAs(reg, ['fontsource:test-sans@5.2.1:400']));
    expect(reg.calls.length).toBeGreaterThan(0);
    expect(f.message).toMatch(/remove .*test-sans@5\.2\.1 and fetch the package again/);
    expect((await refusal(engine.templates.create(input({ display: 'fontsource:test-sans@5.2.1:400' })))).message).toMatch(/remove .*test-sans@5\.2\.1 and fetch the package again/);
  });

  it("a package stored from a test registry never stands for the real one's: fetched again (integrity compared), each answer naming its own registry", async () => {
    const pkg = fakePackage({});
    const test = fakeRegistry([pkg], { base: 'http://127.0.0.1:4518', test: true });
    await fetchAs(test, ['fontsource:test-sans@5.2.1:400']);
    // The same test registry: answered from the store, its registry and the TEST warning said.
    const again = await fetchAs(fakeRegistry([pkg], { base: 'http://127.0.0.1:4518', test: true }), ['fontsource:test-sans@5.2.1:400']);
    expect(again.packages[0]).toMatchObject({ downloaded: false, registry: 'http://127.0.0.1:4518', test_registry: true });
    expect(again.warnings.join('\n')).toMatch(/fetched from a TEST registry \(http:\/\/127\.0\.0\.1:4518\)/);
    const real = fakeRegistry([pkg]);
    const f = await fetchAs(real, ['fontsource:test-sans@5.2.1:400']);
    expect(real.calls).toEqual(['/@fontsource%2ftest-sans/5.2.1', '/@fontsource/test-sans/-/test-sans-5.2.1.tgz']);
    expect(f.packages[0]).toMatchObject({ downloaded: true, registry: 'https://registry.npmjs.org', test_registry: false });
    expect(JSON.parse(await readFile(store('test-sans@5.2.1', 'record.json'), 'utf8'))).toMatchObject({ registry: 'https://registry.npmjs.org', test_registry: false });
    // A test package of another integrity under the same version: refused, as any changed integrity is.
    await fetchAs(fakeRegistry([fakePackage({ version: '6.0.0' })], { base: 'http://127.0.0.1:4518', test: true }), ['fontsource:test-sans@6.0.0:400']);
    const other = fakePackage({ version: '6.0.0', extra: [{ name: 'package/README.md', data: 'real' }] });
    expect((await refusal(fetchAs(fakeRegistry([other]), ['fontsource:test-sans@6.0.0:400']))).message).toMatch(/another tarball \(integrity\)/);
  });

  it("the manifest's text in a refusal has every hidden character written out", async () => {
    const pkg = fakePackage({});
    const reg = fakeRegistry([pkg], { override: (p) => (p.startsWith('/@fontsource%2f') ? Buffer.from(JSON.stringify({ ...pkg.manifest('https://registry.npmjs.org'), license: 'OFL-1.1\u202e' })) : undefined) });
    const e = await refusal(fetchAs(reg, ['fontsource:test-sans@5.2.1:400']));
    expect(e.message).toContain('"OFL-1.1\\u{202e}"');
    expect(e.message).not.toContain('\u202e');
  });

  it('a link anywhere on the store path is refused, for a fetch and for a create; nothing is written through it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'retake-fontsource-outside-'));
    try {
      await mkdir(join(root, '.retake'), { recursive: true });
      await symlink(outside, join(root, '.retake', 'fonts'));
      expect((await refusal(fetchAs(fakeRegistry([fakePackage({})]), ['fontsource:test-sans@5.2.1:400']))).message).toMatch(/not a plain folder \(a link\?\)/);
      expect(await readdir(outside)).toEqual([]);
      await rm(join(root, '.retake', 'fonts'));
      await fetchAs(fakeRegistry([fakePackage({})]), ['fontsource:test-sans@5.2.1:400']);
      // The package's own folder a link: refused when read.
      await rename(store('test-sans@5.2.1'), join(outside, 'moved'));
      await symlink(join(outside, 'moved'), store('test-sans@5.2.1'));
      expect((await refusal(engine.templates.create(input({ display: 'fontsource:test-sans@5.2.1:400' })))).message).toMatch(/not a plain folder \(a link\?\)/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("an interrupted write's stage and old folders of that package are swept by its next write (another package's left alone)", async () => {
    await mkdir(store(), { recursive: true });
    for (const d of ['.stage-test-sans@5.2.1-aaaaaaaaaaaa', '.old-test-sans@5.2.1-bbbbbbbbbbbb', '.stage-other@1.0.0-cccccccccccc']) await mkdir(store(d), { recursive: true });
    await fetchAs(fakeRegistry([fakePackage({})]), ['fontsource:test-sans@5.2.1:400']);
    expect((await readdir(store())).sort()).toEqual(['.stage-other@1.0.0-cccccccccccc', 'test-sans@5.2.1']);
  });

  it('the per-call download cap holds across packages (60 MB in all)', async () => {
    const big = (id: string) => fakePackage({ id, extra: [{ name: 'package/pad.bin', data: randomBytes(25 * 1024 * 1024) }] });
    const reg = fakeRegistry([big('a-sans'), big('b-sans'), big('c-sans')]);
    const e = await refusal(fetchAs(reg, ['fontsource:a-sans@5.2.1:400', 'fontsource:b-sans@5.2.1:400', 'fontsource:c-sans@5.2.1:400']));
    expect(e.message).toMatch(/more than \d+ bytes/);
    expect(reg.calls.filter((c) => c.endsWith('.tgz'))).toHaveLength(3);
  });

  it("the fetch command quotes a workspace root with a space and a quote", () => {
    expect(fetchCommand({ root: "/tmp/my work's" }, ['fontsource:test-sans:400'])).toBe("retake -C '/tmp/my work'\\''s' theme fetch-font fontsource:test-sans:400");
    expect(fetchCommand({ root: '/tmp/plain' }, ['fontsource:a:400', 'fontsource:b@1.0.0:700italic'])).toBe('retake -C /tmp/plain theme fetch-font fontsource:a:400 fontsource:b@1.0.0:700italic');
  });

  it('template_update of one colour needs no font store: the reused fonts keep their LICENSES.md citation byte for byte', async () => {
    const pkg = fakePackage({ faces: ['400', '700'] });
    await fetchAs(fakeRegistry([pkg]), ['fontsource:test-sans@5.2.1:400', 'fontsource:test-sans@5.2.1:700']);
    const c = await engine.templates.create(input({ display: 'fontsource:test-sans@5.2.1:700', body: ['fontsource:test-sans@5.2.1:400'] }));
    const section = (md: string) => md.slice(md.indexOf('## Fonts from fontsource'), md.indexOf('## Fonts of the base theme') > 0 ? md.indexOf('## Fonts of the base theme') : undefined);
    const before = section(await readFile(join(c.dir, 'LICENSES.md'), 'utf8'));
    await rename(join(root, '.retake', 'fonts'), join(root, 'fonts-aside'));
    const u = await engine.templates.update({ name: 'acme', colors: { paper: '#f4efe6' } });
    expect(u.changed).toEqual(['colors.paper']);
    expect(section(await readFile(join(u.dir, 'LICENSES.md'), 'utf8'))).toBe(before);
    // A newly named stored face still needs the store.
    expect((await refusal(engine.templates.update({ name: 'acme', fonts: { body: ['fontsource:test-sans@5.2.1:700'] } }))).code).toBe('not_found');
  });
});

