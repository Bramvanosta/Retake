/**
 * L3.5 `retake theme create` and `retake theme from-site` (trust `author`): a human names any local file (here: outside the workspace), the theme
 * lands in the workspace's templates_dir, `--json` prints what the MCP tool returns; refusals keep their fix and exit 1;
 * a missing required option is a usage error. from-site runs the extraction in-process on the brand-site fixture (the
 * unsafe test resolver set): no approval, the same URL rules, an environment host only warned; doctor warns.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES_DIR, loadTemplate, fileFacts } from '@retake/core/io';
import { EXIT, main, memoryIo } from '../src/index.js';
import { unsafeTestResolveCheck } from '../src/commands/doctor.js';
import type { DoctorProbes } from '../src/commands/doctor.js';
import { BRAND_SITE_COLORS, hasOpenssl, startBrandSite } from '../../runner-web/test/site-fixture.js';
import type { BrandSite } from '../../runner-web/test/site-fixture.js';
import { PERSON_POLICY } from '@retake/core';

let ws: string;
let files: string;

async function retake(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', ws, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-theme-cli-'));
  files = await mkdtemp(join(tmpdir(), 'studio-theme-files-'));
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
  await cp(join(STARTER_TEMPLATES_DIR, 'default', 'logo.svg'), join(files, 'logo.svg'));
  await cp(join(STARTER_TEMPLATES_DIR, 'motion', 'fonts', 'SpaceGrotesk-Bold.ttf'), join(files, 'Headline.ttf'));
  await cp(join(STARTER_TEMPLATES_DIR, 'default', 'fonts', 'Inter-Regular.ttf'), join(files, 'Text.ttf'));
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
  await rm(files, { recursive: true, force: true });
});

describe('retake theme create', () => {
  it('creates a theme from files anywhere on disk (a human typed it), with --json', async () => {
    const r = await retake(
      'theme',
      'create',
      'acme',
      '--accent',
      '#0E7C66',
      '--logo',
      join(files, 'logo.svg'),
      '--display-font',
      join(files, 'Headline.ttf'),
      '--body-font',
      join(files, 'Text.ttf'),
      '--brand-name',
      'Acme',
      '--brand-url',
      'acme.test',
      '--background',
      'linear:#ffffff:#eeeeee',
      '--json',
    );
    expect(r.code, r.err).toBe(EXIT.ok);
    const out = JSON.parse(r.out) as { name: string; dir: string; palette: { colors: { accent: string }; background: unknown }; fonts: Array<{ file: string }>; warnings: string[] };
    expect(out.dir).toBe(join(ws, 'templates', 'acme'));
    expect(out.palette.colors.accent).toBe('#0e7c66');
    expect(out.palette.background).toEqual({ type: 'linear', from: '#ffffff', to: '#eeeeee' });
    expect(out.fonts.map((f) => f.file)).toEqual(['fonts/display-Bold.ttf', 'fonts/body-Regular.ttf']);
    expect(out.warnings.join('\n')).toMatch(/captions.kicker of editorial uses the body font at weight 600/);
    expect((await loadTemplate('acme', ws, { files: fileFacts(PERSON_POLICY) })).template.brand).toEqual({ name: 'Acme', url: 'acme.test' });
  });

  it('prints the palette and the next step; refusals exit 1 with the reason', async () => {
    const r = await retake('theme', 'create', 'beta', '--accent', '#ffdd00', '--logo', join(files, 'logo.svg'), '--base', 'motion');
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.err).toMatch(/created theme beta over motion \(dark\)/);
    expect(r.err).toMatch(/contrast: text_on_paper/);
    expect(r.err).toMatch(/retake render <project> <scenario> --theme beta/);
    const again = await retake('theme', 'create', 'beta', '--accent', '#ffdd00', '--logo', join(files, 'logo.svg'));
    expect(again.code).toBe(EXIT.failure);
    expect(again.err).toMatch(/templates_dir already has "beta"/);
    const starter = await retake('theme', 'create', 'editorial', '--accent', '#ffdd00', '--logo', join(files, 'logo.svg'));
    expect(starter.code).toBe(EXIT.failure);
    expect(starter.err).toMatch(/starter theme editorial/);
    const font = await retake('theme', 'create', 'gamma', '--accent', '#ffdd00', '--logo', join(files, 'logo.svg'), '--display-font', join(files, 'logo.svg'));
    expect(font.code).toBe(EXIT.failure);
    expect(font.err).toMatch(/not a font file/);
    expect(existsSync(join(ws, 'templates', 'gamma'))).toBe(false);
  });

  it('a missing --accent or --logo, or a malformed --background, is a usage error', async () => {
    expect((await retake('theme', 'create', 'x', '--logo', 'a.svg')).code).toBe(EXIT.usage);
    expect((await retake('theme', 'create', 'x', '--accent', '#000')).code).toBe(EXIT.usage);
    expect((await retake('theme', 'create', 'x', '--accent', '#000', '--logo', join(files, 'logo.svg'), '--background', 'radial:red:blue')).code).toBe(EXIT.usage);
  });
});

describe.skipIf(!hasOpenssl())('retake theme from-site', () => {
  let site: BrandSite;
  const saved = process.env.RETAKE_UNSAFE_TEST_RESOLVE;
  beforeAll(async () => {
    site = await startBrandSite();
    process.env.RETAKE_UNSAFE_TEST_RESOLVE = site.resolveEnv;
    await mkdir(join(ws, 'projects', 'demo'), { recursive: true });
    await writeFile(join(ws, 'projects', 'demo', 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "https://brand.test/"}\n');
  });
  afterAll(async () => {
    await site?.close();
    if (saved === undefined) delete process.env.RETAKE_UNSAFE_TEST_RESOLVE;
    else process.env.RETAKE_UNSAFE_TEST_RESOLVE = saved;
  });

  it('extracts in-process with --json (no approval: a human typed it); an environment host is a warning here', async () => {
    const r = await retake('theme', 'from-site', 'https://brand.test/', '--json');
    expect(r.code, r.err).toBe(EXIT.ok);
    const out = JSON.parse(r.out) as {
      status: string;
      site_id: string;
      palette: { roles: Record<string, string> };
      candidates: Array<{ ref: string }>;
      warnings: string[];
      draft: { brand_input: { logo: string } };
    };
    expect(out.status).toBe('ok');
    expect(out.palette.roles).toEqual(BRAND_SITE_COLORS);
    expect(out.candidates[0].ref).toBe(`site:${out.site_id}/logo-1`);
    expect(out.draft.brand_input.logo).toBe(`site:${out.site_id}/logo-1`);
    expect(out.warnings.join('\n')).toMatch(/page app of environment local of project demo/);
    expect(out.warnings.join('\n')).toMatch(/unsafe test resolver/);
    expect(site.escape).toEqual({ tcp: 0, udp: 0, upgrades: 0 });
    expect(await readdir(join(ws, '.retake', 'site', out.site_id))).toEqual(expect.arrayContaining(['site.json', 'screenshot.jpg', 'logo-1.png']));
  }, 120_000);

  it('page strings are printed without control or bidirectional characters', async () => {
    const r = await retake('theme', 'from-site', 'https://hostile.test/bidi');
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(`${r.out}${r.err}`).toMatch(/fonts seen \(names from the page\): display Evil Display; body Evil Text/);
    expect(`${r.out}${r.err}`).not.toMatch(/[\u0080-\u009f\u202a-\u202e\u2066-\u2069]/);
  }, 120_000);

  it('the same URL rules: http, a query, an IP literal exit 1; doctor warns about the test resolver', async () => {
    for (const url of ['http://brand.test/', 'https://brand.test/?x=1', 'https://10.0.0.1/']) {
      const r = await retake('theme', 'from-site', url);
      expect(r.code, url).toBe(EXIT.failure);
      expect(r.err, url).toMatch(/url: /);
    }
    const check = unsafeTestResolveCheck({ env: { RETAKE_UNSAFE_TEST_RESOLVE: site.resolveEnv } } as unknown as DoctorProbes);
    expect(check).toMatchObject({ status: 'warn', name: 'Site extraction', detail: expect.stringMatching(/brand\.test.*loopback ports/) });
    expect(unsafeTestResolveCheck({ env: {} } as unknown as DoctorProbes)).toBeNull();
  });
});
