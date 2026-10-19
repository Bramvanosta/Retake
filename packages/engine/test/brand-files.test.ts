/**
 * L3.5 brand files (engine src/brand/files.ts): where a logo, wordmark or font may come from under trust `mcp`, and
 * what its bytes must be — every refused source (absolute, `..`, links out of the workspace or into agent-writable
 * folders, scenarios / runs / renders / review / exports of any project in any case, `.demo-studio/`, the components
 * folder, hidden folders, malformed `site:` references — the others in site-job.test.ts), raster headers (PNG, JPEG, WebP; sizes), the
 * SVG scan (the starters' logos and font-embedding wordmarks accepted; scripts, handlers, namespaced elements,
 * external references, SMIL, character references, CSS escapes, entities, UTF-16, NUL refused) and the font sniff
 * (the starters' TrueType files read: family, weight, fsType, licence strings; WOFF / WOFF2 headers; fakes refused).
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES_DIR, loadWorkspaceConfig } from '@demo-studio/core';
import type { WorkspaceConfig } from '@demo-studio/core';
import { FONT_MAX_BYTES, checkImage, fontCopyName, rasterInfo, readBrandFile, scanSvg, sniffFont } from '../src/index.js';
import { fontFileFace } from '@demo-studio/components';

let root: string;
let outside: string;
let ws: WorkspaceConfig;
const T = STARTER_TEMPLATES_DIR;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#0e7c66"/></svg>';

async function put(rel: string, data: string | Buffer): Promise<void> {
  const p = join(root, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, data);
}

const mcp = (ref: string, kind: 'logo' | 'font' = 'logo') => readBrandFile(ws, ref, kind, { trust: 'mcp' });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-brand-files-'));
  outside = await mkdtemp(join(tmpdir(), 'studio-brand-outside-'));
  await writeFile(join(root, 'studio.yaml'), 'projects_dir: projects\ntemplates_dir: templates\ncomponents_dir: components\n');
  await put('brand/logo.svg', SVG);
  await put('brand/Inter-Regular.ttf', await readFile(join(T, 'default', 'fonts', 'Inter-Regular.ttf')));
  await put('projects/demo/project.yaml', 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\n');
  await put('projects/demo/assets/logo.svg', SVG);
  for (const f of ['scenarios', 'runs/20261019-1-quote', 'renders', 'review/x', 'exports/x']) await put(`projects/demo/${f}/logo.svg`, SVG);
  await put('projects/demo/.demo-studio/inspect/i/logo.svg', SVG);
  await put('.demo-studio/site/s1/logo-1.png', SVG);
  await put('components/acme/intro/logo.svg', SVG);
  await put('.hidden/logo.svg', SVG);
  await put('templates/own/logo.svg', SVG);
  await writeFile(join(outside, 'logo.svg'), SVG);
  await symlink(join(outside, 'logo.svg'), join(root, 'brand', 'out.svg'));
  await symlink(join(outside), join(root, 'brand', 'outdir'));
  await symlink(join(root, 'projects', 'demo', 'runs', '20261019-1-quote', 'logo.svg'), join(root, 'brand', 'run-link.svg'));
  await symlink(join(root, '.demo-studio', 'site', 's1', 'logo-1.png'), join(root, 'brand', 'site-link.png'));
  await mkdir(join(root, 'brand', 'folder.svg'));
  ws = await loadWorkspaceConfig(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('brand file sources (trust mcp)', () => {
  it('a file of the workspace is read: brand/, a project\'s assets/, a theme folder', async () => {
    for (const ref of ['brand/logo.svg', 'projects/demo/assets/logo.svg', 'templates/own/logo.svg']) {
      const f = await mcp(ref);
      expect(f.bytes.toString()).toBe(SVG);
      expect(f.ext).toBe('.svg');
    }
  });

  it.each([
    ['/etc/hosts', /absolute path/],
    [`${'x'}/../../logo.svg`, /goes out with/],
    ['brand/out.svg', /leaves the workspace/],
    ['brand/outdir/logo.svg', /leaves the workspace/],
    ['brand/run-link.svg', /runs\/ of project demo, a folder an agent can write/],
    ['brand/site-link.png', /hidden folder or file \(\.demo-studio/],
    ['projects/demo/scenarios/logo.svg', /scenarios\/ of project demo/],
    ['projects/demo/runs/20261019-1-quote/logo.svg', /runs\/ of project demo/],
    ['projects/demo/RUNS/20261019-1-quote/logo.svg', /(runs|RUNS)\/ of project demo|not found/],
    ['projects/demo/renders/logo.svg', /renders\/ of project demo/],
    ['projects/demo/review/x/logo.svg', /review\/ of project demo/],
    ['projects/demo/exports/x/logo.svg', /exports\/ of project demo/],
    ['projects/demo/.demo-studio/inspect/i/logo.svg', /hidden folder/],
    ['.demo-studio/site/s1/logo-1.png', /hidden folder/],
    ['.hidden/logo.svg', /hidden folder/],
    ['components/acme/intro/logo.svg', /components folder/],
    ['COMPONENTS/acme/intro/logo.svg', /components folder|not found/],
    ['site:s1/logo-1', /a site reference is site:<site id>\/logo-<n>/],
    ['site:s_01HZY3J8Q4M2V6P0R9T7W5X1ZB/../../brand/logo', /a site reference is site:<site id>\/logo-<n>/],
  ])('%s is refused', async (ref, why) => {
    const e = await mcp(ref).catch((x: unknown) => x as { code: string; message: string });
    expect(e).toMatchObject({ message: expect.stringMatching(why) });
    if (!/not found/.test((e as { message: string }).message)) expect((e as { code: string }).code).toBe('refused');
  });

  it('upper-case agent-writable folders are refused where the file system ignores case (macOS)', async () => {
    const e = await mcp('projects/demo/RUNS/20261019-1-quote/logo.svg').catch((x: { code: string; message: string }) => x);
    // On a case-insensitive file system RUNS/ is runs/; on a case-sensitive one the file does not exist.
    expect(['refused', 'not_found']).toContain((e as { code: string }).code);
  });

  it('missing files, folders and other extensions', async () => {
    await expect(mcp('brand/nope.svg')).rejects.toMatchObject({ code: 'not_found' });
    await expect(mcp('brand/folder.svg')).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/not a file/) });
    await expect(mcp('brand/logo.svg', 'font')).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/not a font file/) });
    await expect(mcp('brand/Inter-Regular.ttf')).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/not an image file/) });
  });

  it('a human (trust author) names any local file, links included', async () => {
    const f = await readBrandFile(ws, join(outside, 'logo.svg'), 'logo', { trust: 'author' });
    expect(f.bytes.toString()).toBe(SVG);
    expect((await readBrandFile(ws, 'brand/out.svg', 'logo', { trust: 'author', cwd: root })).path).toBe(join(outside, 'logo.svg').replace(/^\/var\//, '/private/var/'));
  });

  it('size caps and the total budget', async () => {
    await put('brand/huge.ttf', Buffer.alloc(FONT_MAX_BYTES + 1));
    await expect(mcp('brand/huge.ttf', 'font')).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/more than the 10485760/) });
    const budget = { left: 100 };
    await expect(readBrandFile(ws, 'brand/Inter-Regular.ttf', 'font', { trust: 'mcp', budget })).rejects.toMatchObject({ message: expect.stringMatching(/together/) });
  });
});

// ── Raster headers ─────────────────────────────────────────────────────────────────────────────────────────────────

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function jpeg(w: number, h: number): Buffer {
  // SOI, an APP0 segment, then SOF0 with the size.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X', w: number, h: number): Buffer {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'latin1');
  b.write(kind, 12, 'latin1');
  if (kind === 'VP8 ') {
    b[23] = 0x9d;
    b[24] = 0x01;
    b[25] = 0x2a;
    b.writeUInt16LE(w, 26);
    b.writeUInt16LE(h, 28);
  } else if (kind === 'VP8L') {
    b[20] = 0x2f;
    b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  } else {
    b.writeUIntLE(w - 1, 24, 3);
    b.writeUIntLE(h - 1, 27, 3);
  }
  return b;
}

describe('raster logos: magic and size from the header', () => {
  it('reads PNG, JPEG and the three WebP chunk kinds', () => {
    expect(rasterInfo(png(640, 200))).toEqual({ format: 'png', width: 640, height: 200 });
    expect(rasterInfo(jpeg(800, 300))).toEqual({ format: 'jpeg', width: 800, height: 300 });
    expect(rasterInfo(webp('VP8 ', 500, 120))).toEqual({ format: 'webp', width: 500, height: 120 });
    expect(rasterInfo(webp('VP8L', 501, 121))).toEqual({ format: 'webp', width: 501, height: 121 });
    expect(rasterInfo(webp('VP8X', 502, 122))).toEqual({ format: 'webp', width: 502, height: 122 });
    expect(rasterInfo(Buffer.from('GIF89a……'))).toBeUndefined();
  });

  it('refuses a format that does not match its extension, too small, too large, and not an image', () => {
    const ok = (bytes: Buffer, ext: string) => checkImage({ ref: `brand/logo${ext}`, ext, bytes }, 'logo');
    expect(ok(png(640, 200), '.png')).toMatchObject({ format: 'png' });
    expect(ok(jpeg(800, 300), '.jpeg')).toMatchObject({ format: 'jpeg' });
    expect(() => ok(png(640, 200), '.jpg')).toThrow(/a PNG named \.jpg/);
    expect(() => ok(png(640, 32), '.png')).toThrow(/64 px of height/);
    expect(() => ok(png(9000, 300), '.png')).toThrow(/at most 8192/);
    expect(() => ok(Buffer.from(SVG), '.png')).toThrow(/not a PNG, JPEG or WebP/);
  });
});

// ── SVG scan ───────────────────────────────────────────────────────────────────────────────────────────────────────

const wrap = (inner: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"${attrs}>${inner}</svg>`;

describe('SVG scan', () => {
  it('accepts the starters\' logos and wordmarks (live text with an embedded data:font/woff2) and plain shapes', async () => {
    for (const t of ['default', 'editorial', 'motion']) {
      for (const f of ['logo.svg', 'wordmark.svg']) expect(scanSvg(await readFile(join(T, t, f))).problems, `${t}/${f}`).toEqual([]);
    }
    expect(scanSvg(Buffer.from(wrap('<defs><linearGradient id="g"/></defs><rect fill="url(#g)" mask="url( \'#m\' )"/><use href="#g"/><use xlink:href="#g"/>')))).toEqual({ problems: [], width: 10, height: 10 });
    expect(scanSvg(Buffer.from(wrap('<image href="data:image/png;base64,iVBORw0KGgo=" width="10" height="10"/>'))).problems).toEqual([]);
    expect(scanSvg(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by hand -->\n${wrap('<title>Acme &amp; Co</title><path d="M0 0h10v10z"/>')}`)).problems).toEqual([]);
    expect(scanSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300px" height="80"><path d="M0 0"/></svg>'))).toEqual({ problems: [], width: 300, height: 80 });
  });

  it.each([
    ['a script element', wrap('<script>alert(1)</script>'), /<script>/],
    ['a script element with a namespace prefix', wrap('<x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script>'), /<script>/],
    ['a script split by comments', wrap('<scr<!-- -->ipt>alert(1)</scr<!-- -->ipt>'), /<script>/],
    ['an onload handler after a slash', '<svg/onload=alert(1) xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>', /event handler/],
    ['an onclick handler', wrap('<rect onclick="alert(1)"/>'), /event handler/],
    ['a handler hidden by an encoded quote', wrap('<a href="#x&quot; onmouseover=&quot;alert(1)">x</a>'), /event handler|fragment/],
    ['an encoded quote inside an href (read as written too)', wrap('<use href="#a&quot;https://tracker.test/x"/>'), /href to something other than a fragment/],
    ['foreignObject', wrap('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'), /<foreignobject>/],
    ['an iframe, an embed, an object', wrap('<iframe/><embed/><object/>'), /<iframe>/],
    ['an external href', wrap('<a href="https://tracker.test/x"><rect/></a>'), /href to something other than a fragment/],
    ['an external href under another prefix', wrap('<use foo:href="https://tracker.test/x#a" xmlns:foo="http://www.w3.org/1999/xlink"/>'), /href to something other/],
    ['an external xlink:href image', wrap('<image xlink:href="https://tracker.test/x.png"/>'), /href to something other/],
    ['an embedded SVG document', wrap('<image href="data:image/svg+xml;base64,PHN2Zz4="/>'), /href to something other|embedded HTML or SVG/],
    ['an unquoted href', wrap('<a href=javascript:alert(1)>x</a>'), /unquoted href/],
    ['a javascript: href with character references', wrap('<a href="&#106;avascript:alert(1)">x</a>'), /javascript: URL|href to something/],
    ['a javascript: href with hex references and a tab', wrap('<a xlink:href="&#x6A;ava&#x9;script:alert(1)">x</a>'), /javascript: URL/],
    ['SMIL setting an href', wrap('<a><set attributeName="href" to="javascript:alert(1)"/>x</a>'), /animation of an href/],
    ['SMIL animating xlink:href', wrap('<a><animate attributeName="xlink:href" values="javascript:alert(1)"/>x</a>'), /animation of an href/],
    ['an external url() in CSS', wrap('<style>rect{fill:url(https://tracker.test/x)}</style><rect/>'), /url\(…\) to something other/],
    ['a quoted url() hiding a parenthesis', wrap('<style>rect{fill:url("https://tracker.test/a)b")}</style><rect/>'), /url\(…\) to something other/],
    ['an unterminated url(', wrap('<rect style="fill:url(https://tracker.test/x"/>'), /unterminated url\(|url\(…\) to something other/],
    ['a CSS escape of url', wrap('<style>rect{fill:u\\72l(https://tracker.test/x)}</style><rect/>'), /backslash/],
    ['an escaped @import', wrap('<style>\\40import "https://tracker.test/x.css";</style>'), /backslash/],
    ['an @import', wrap('<style>@import "https://tracker.test/x.css";</style>'), /@import/],
    ['image-set()', wrap('<style>svg{background:image-set("https://tracker.test/x.png" 1x)}</style>'), /image-set/],
    ['a DOCTYPE with entities', `<!DOCTYPE svg [<!ENTITY x "&#60;script&#62;">]>${wrap('&x;')}`, /DOCTYPE or entities/],
    ['an xml-stylesheet processing instruction', `<?xml version="1.0"?><?xml-stylesheet href="https://tracker.test/x.css"?>${wrap('')}`, /processing instruction/],
    ['XInclude', wrap('<xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="https://tracker.test/x"/>'), /<include>/],
    // Names as a parser reads them: a prefix of any letters, judged by the local part.
    ['a script element under a non-ASCII prefix', wrap('<é:script xmlns:é="http://www.w3.org/2000/svg">alert(1)</é:script>'), /<script>/],
    ['a script element under a mixed prefix', wrap('<aé:script xmlns:aé="http://www.w3.org/2000/svg">alert(1)</aé:script>'), /<script>/],
    ['foreignObject under a non-ASCII prefix', wrap('<é:foreignObject xmlns:é="http://www.w3.org/2000/svg"><p>x</p></é:foreignObject>'), /<foreignobject>/],
    ['an external href under a non-ASCII prefix', wrap('<image é:href="https://tracker.test/x.png" xmlns:é="http://www.w3.org/1999/xlink" width="10" height="10"/>'), /href to something other/],
    ['an event handler under a non-ASCII prefix', wrap('<rect é:onclick="alert(1)" xmlns:é="http://www.w3.org/2000/svg"/>'), /event handler/],
    ['SMIL animating a non-ASCII-prefixed href', wrap('<a><set attributeName="é:href" to="javascript:alert(1)"/>x</a>'), /animation of an href/],
    // What the bytes mean to a browser must be what the scan read.
    ['an XML declaration of another encoding', `<?xml version="1.0" encoding="ISO-2022-JP"?>\n${wrap('<scr\u001b(Bipt>alert(1)</scr\u001b(Bipt>')}`, /another encoding than UTF-8/],
    ['an XML declaration of UTF-16 in UTF-8 bytes', `<?xml version="1.0" encoding="UTF-16"?>${wrap('<rect/>')}`, /another encoding than UTF-8/],
    ['a control character splitting a name', wrap('<scr\u001bipt>alert(1)</scr\u001bipt>'), /control character/],
    ['no viewBox and no size', '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', /no viewBox/],
    ['no svg element', '<html><body>x</body></html>', /no <svg> element/],
  ])('refuses %s', (_what, text, why) => {
    const r = scanSvg(Buffer.from(text));
    expect(r.problems.join('; ')).toMatch(why);
  });

  it('accepts an XML declaration of UTF-8 in any spelling, and tabs and newlines', () => {
    for (const enc of ['UTF-8', 'utf-8', 'utf8']) expect(scanSvg(Buffer.from(`<?xml version="1.0" encoding="${enc}"?>\n${wrap('<rect\twidth="1"\r\nheight="1"/>')}`)).problems, enc).toEqual([]);
  });

  it("never quotes the file's own text in a problem (an error message reaches an agent)", () => {
    const marker = 'IGNORE-PREVIOUS-INSTRUCTIONS';
    const r = scanSvg(
      Buffer.from(
        `<?xml version="1.0"?><?${marker} x?>${wrap(`<a href="https://tracker.test/${marker}">x</a><style>rect{fill:url(https://tracker.test/${marker})}</style><${marker}:script/>`)}`,
      ),
    );
    expect(r.problems.length).toBeGreaterThanOrEqual(4);
    expect(r.problems.join('; ')).not.toContain(marker);
  });

  it('refuses UTF-16, invalid UTF-8 and NUL bytes', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(wrap(''), 'utf16le')]);
    expect(scanSvg(utf16).problems).toEqual(['it is not UTF-8 text']);
    expect(scanSvg(Buffer.concat([Buffer.from(wrap('')), Buffer.from([0xc3, 0x28])])).problems).toEqual(['it is not UTF-8 text']);
    expect(scanSvg(Buffer.from(wrap('<rect/>\u0000<script/>'))).problems).toEqual(['it holds a NUL character']);
    expect(scanSvg(Buffer.from(wrap('<a href="#&#0;x"/>'))).problems.join('; ')).toMatch(/invalid character/);
  });

  it('checkImage refuses an SVG with problems, with the fix', () => {
    expect(() => checkImage({ ref: 'brand/logo.svg', ext: '.svg', bytes: Buffer.from(wrap('<script/>')) }, 'logo')).toThrow(/an SVG this tool does not copy — it has a <script> element/);
  });
});

// ── Fonts ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('font sniff', () => {
  const font = async (theme: string, file: string) => ({ ref: file, ext: '.ttf', bytes: await readFile(join(T, theme, 'fonts', file)) });

  it('reads the starters\' TrueType files: family, weight, italic, fsType, licence strings', async () => {
    const inter = sniffFont(await font('default', 'Inter-SemiBold.ttf'));
    expect(inter).toMatchObject({ format: 'ttf', weight: 600, italic: false, fs_type: 0, licence_notes: [] });
    expect(inter.names).toMatchObject({ family: 'Inter', subfamily: 'SemiBold', copyright: expect.stringMatching(/Inter Project Authors/), licence_url: 'https://openfontlicense.org' });
    expect(sniffFont(await font('editorial', 'InstrumentSerif-Regular.ttf'))).toMatchObject({ weight: 400, names: { family: 'Instrument Serif' } });
    expect(sniffFont(await font('motion', 'SpaceGrotesk-Bold.ttf'))).toMatchObject({ weight: 700, names: { family: 'Space Grotesk' } });
  });

  it('fsType embedding bits are notes, never refusals', async () => {
    const f = await font('default', 'Inter-Regular.ttf');
    const b = Buffer.from(f.bytes);
    const n = b.readUInt16BE(4);
    for (let i = 0; i < n; i++) {
      if (b.toString('latin1', 12 + i * 16, 16 + i * 16) === 'OS/2') b.writeUInt16BE(0x0002 | 0x0200, b.readUInt32BE(12 + i * 16 + 8) + 8);
    }
    const info = sniffFont({ ...f, bytes: b });
    expect(info.fs_type).toBe(0x0202);
    expect(info.licence_notes.join('; ')).toMatch(/restricted licence embedding.*bitmap embedding only/);
  });

  it('WOFF and WOFF2: magic and header checked, weight left to the input or the file name', () => {
    const woff = Buffer.alloc(80);
    woff.write('wOFF', 0, 'latin1');
    woff.writeUInt32BE(0x00010000, 4);
    woff.writeUInt32BE(80, 8);
    woff.writeUInt16BE(1, 12);
    woff.write('head', 44, 'latin1');
    woff.writeUInt32BE(64, 48);
    woff.writeUInt32BE(16, 52);
    expect(sniffFont({ ref: 'brand/A.woff', ext: '.woff', bytes: woff })).toEqual({ format: 'woff', names: {}, licence_notes: [] });
    const woff2 = Buffer.alloc(60);
    woff2.write('wOF2', 0, 'latin1');
    woff2.writeUInt32BE(0x00010000, 4);
    woff2.writeUInt32BE(60, 8);
    woff2.writeUInt16BE(3, 12);
    expect(sniffFont({ ref: 'brand/A.woff2', ext: '.woff2', bytes: woff2 })).toMatchObject({ format: 'woff2' });
    // A header that disagrees with the file, a table beyond its end, the wrong extension.
    const short = Buffer.from(woff2);
    short.writeUInt32BE(999, 8);
    expect(() => sniffFont({ ref: 'brand/A.woff2', ext: '.woff2', bytes: short })).toThrow(/another length/);
    const far = Buffer.from(woff);
    far.writeUInt32BE(4000, 48);
    expect(() => sniffFont({ ref: 'brand/A.woff', ext: '.woff', bytes: far })).toThrow(/beyond the end/);
    expect(() => sniffFont({ ref: 'brand/A.ttf', ext: '.ttf', bytes: woff2 })).toThrow(/a WOFF2 file named \.ttf/);
  });

  it('refuses a PNG renamed .ttf, a truncated table directory, a table beyond the end, a collection, a font without outlines', async () => {
    expect(() => sniffFont({ ref: 'brand/x.ttf', ext: '.ttf', bytes: png(100, 100) })).toThrow(/no TrueType, OpenType, WOFF or WOFF2 signature/);
    const inter = (await font('default', 'Inter-Regular.ttf')).bytes;
    expect(() => sniffFont({ ref: 'brand/x.ttf', ext: '.ttf', bytes: inter.subarray(0, 40) })).toThrow(/truncated table directory/);
    expect(() => sniffFont({ ref: 'brand/x.ttf', ext: '.ttf', bytes: inter.subarray(0, 50_000) })).toThrow(/table lies beyond the end/);
    // The table's tag (bytes of the file) is never quoted.
    const tagged = Buffer.from(inter.subarray(0, 50_000));
    for (let i = 0; i < tagged.readUInt16BE(4); i++) tagged.write('PWN!', 12 + i * 16, 'latin1');
    expect(() => sniffFont({ ref: 'brand/x.ttf', ext: '.ttf', bytes: tagged })).toThrow(/^(?!.*PWN!).*a table lies beyond the end/);
    const ttc = Buffer.from(inter);
    ttc.write('ttcf', 0, 'latin1');
    expect(() => sniffFont({ ref: 'brand/x.ttf', ext: '.ttf', bytes: ttc })).toThrow(/font collection/);
    const fake = Buffer.alloc(64);
    fake.write('OTTO', 0, 'latin1');
    fake.writeUInt16BE(1, 4);
    fake.write('name', 12, 'latin1');
    fake.writeUInt32BE(28, 20);
    fake.writeUInt32BE(8, 24);
    expect(() => sniffFont({ ref: 'brand/x.otf', ext: '.otf', bytes: fake })).toThrow(/no cmap table/);
  });

  it('copies are named by role and weight so the renderer reads the right face back (never the family)', () => {
    for (const w of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
      for (const italic of [false, true]) {
        const name = fontCopyName('body', w, italic, '.woff2');
        expect(name).toMatch(/^fonts\/body-[A-Za-z]+\.woff2$/);
        expect(fontFileFace(name), name).toEqual({ weight: w, style: italic ? 'italic' : 'normal' });
      }
    }
    expect(fontCopyName('display', 450, false, '.ttf')).toBe('fonts/display-Medium.ttf');
    // What the copy names avoid: a family name read as a weight (the source names are read by their style token).
    expect(fontFileFace('fonts/LighthouseSans-Regular.ttf').weight).toBe(300);
  });
});
