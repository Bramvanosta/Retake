/**
 * `retake theme fetch-font` and `retake theme from-tokens` (trust `author`: the person's own act, no form). fetch-font
 * downloads from a loopback registry (the test hatch, set for the call; the suite's guard refuses any other registry)
 * into the workspace's font store and prints the pinned refs; `retake theme create --display-font fontsource:…` then
 * reads the store offline. from-tokens prints the proposed roles (token names printable only) and the draft command,
 * writes nothing; a malformed --map is a usage error.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES_DIR } from '@retake/core/io';
import { EXIT, main, memoryIo } from '../src/index.js';
import { fakePackage, loopbackRegistry } from '@retake/test-support/fontsource';

let ws: string;

async function retake(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', ws, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-theme-fonts-cli-'));
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
  await mkdir(join(ws, 'brand'), { recursive: true });
  await cp(join(STARTER_TEMPLATES_DIR, 'default', 'logo.svg'), join(ws, 'brand', 'logo.svg'));
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('retake theme fetch-font', () => {
  it('without the test hatch the suite guard refuses (exit 1, the reason); with it, the store holds the faces and create reads them', async () => {
    const refused = await retake('theme', 'fetch-font', 'fontsource:test-sans@5.2.1:400');
    expect(refused.code).toBe(EXIT.failure);
    expect(refused.err).toMatch(/RETAKE_TEST_NO_FONT_FETCH/);
    const registry = await loopbackRegistry([fakePackage({ faces: ['400', '700'] })]);
    process.env.RETAKE_UNSAFE_TEST_NPM_REGISTRY = registry.base;
    try {
      const r = await retake('theme', 'fetch-font', 'fontsource:test-sans:400', 'fontsource:test-sans:700');
      expect(r.code, r.err).toBe(EXIT.ok);
      expect(r.err).toMatch(/fetched @fontsource\/test-sans 5\.2\.1 \(OFL-1\.1, as its publisher declares it\) from http:\/\/127\.0\.0\.1:\d+ \(a TEST registry\) into \.retake\/fonts\/fontsource\/test-sans@5\.2\.1/);
      expect(r.err).toMatch(/fontsource:test-sans@5\.2\.1:700 \(fetched\)/);
      expect(r.err).toMatch(/TEST registry/);
      const j = await retake('theme', 'fetch-font', 'fontsource:test-sans@5.2.1:700', '--json');
      expect(JSON.parse(j.out)).toMatchObject({ refs: ['fontsource:test-sans@5.2.1:700'], bytes_downloaded: 0, packages: [{ downloaded: false }] });
      expect(registry.requests).toHaveLength(2);
    } finally {
      delete process.env.RETAKE_UNSAFE_TEST_NPM_REGISTRY;
      await registry.close();
    }
    const c = await retake('theme', 'create', 'acme', '--accent', '#0e7c66', '--logo', join(ws, 'brand', 'logo.svg'), '--display-font', 'fontsource:test-sans@5.2.1:700', '--body-font', 'fontsource:test-sans:400');
    expect(c.code, c.err).toBe(EXIT.ok);
    expect(c.err).toMatch(/fonts: fonts\/display-Bold\.woff2 \(display 700\), fonts\/body-Regular\.woff2 \(body 400\)/);
    expect(c.err).toMatch(/note: fontsource:test-sans:400 is fontsource:test-sans@5\.2\.1:400/);
    const missing = await retake('theme', 'create', 'beta', '--accent', '#0e7c66', '--logo', join(ws, 'brand', 'logo.svg'), '--display-font', 'fontsource:test-sans@5.2.1:900');
    expect(missing.code).toBe(EXIT.failure);
    expect(missing.err).toMatch(/fix: retake -C \S+ theme fetch-font fontsource:test-sans@5\.2\.1:900/);
    // Worded for the terminal: the command first, no MCP tool named.
    expect(missing.err).toMatch(/fetch it first: retake -C \S+ theme fetch-font fontsource:test-sans@5\.2\.1:900/);
    expect(missing.err).not.toContain('font_fetch');
    expect((await retake('theme', 'fetch-font', 'fontsource:Test')).code).toBe(EXIT.failure);
  });
});

describe('retake theme from-tokens', () => {
  it('prints the roles (names printable only) and the draft command; writes nothing; --map picks a token', async () => {
    await writeFile(join(ws, 'brand', 'tokens.json'), JSON.stringify({ tokens: [{ name: 'background', value: '#fafaf7' }, { name: 'primary', value: '#0e7c66' }, { name: 'ink\u202e', value: '#111111' }, { name: 'gold', value: '#c9a227' }] }));
    const before = await readdir(ws, { recursive: true });
    const r = await retake('theme', 'from-tokens', join(ws, 'brand', 'tokens.json'));
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.err).toMatch(/accent: #0e7c66 — primary \(by name/);
    expect(r.err).toContain("next: retake theme create brand --base editorial --accent '#0e7c66' --text '#111111' --paper '#fafaf7' --logo <file>");
    expect(r.err).not.toContain('\u202e');
    expect(await readdir(ws, { recursive: true })).toEqual(before);
    const m = await retake('theme', 'from-tokens', join(ws, 'brand', 'tokens.json'), '--map', 'accent=gold', '--json');
    expect(JSON.parse(m.out).roles.accent).toMatchObject({ hex: '#c9a227', why: 'map' });
    // A name the file lacks: its nearest names printed (printable only), and in --json.
    const near = await retake('theme', 'from-tokens', join(ws, 'brand', 'tokens.json'), '--map', 'accent=goldd');
    expect(near.code).toBe(EXIT.failure);
    expect(near.err).toMatch(/nearest token names \(from the file\): gold, /);
    const nearJson = await retake('theme', 'from-tokens', join(ws, 'brand', 'tokens.json'), '--map', 'accent=goldd', '--json');
    expect(nearJson.code).toBe(EXIT.failure);
    expect(JSON.parse(nearJson.out).error).toMatchObject({ code: 'invalid', untrusted: { near: expect.arrayContaining(['gold']) } });
    expect(nearJson.out).not.toContain('\u202e');
    const bad = await retake('theme', 'from-tokens', join(ws, 'brand', 'tokens.json'), '--map', 'colour=gold');
    expect(bad.code).toBe(EXIT.usage);
  });
});
