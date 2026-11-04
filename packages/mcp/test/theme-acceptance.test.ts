/**
 * L3.5 acceptance through MCP: a new theme made from a site and brand files, then filmed with (slow: gated by
 * RETAKE_TEST_SLOW=1 — `pnpm test:slow`). An SDK client drives `retake mcp` (spawned from the sources over stdio)
 * on a scratch workspace holding a copy of projects/northfield-fixture (its local environment pointed at the fixture
 * product started on free ports) and the user's font files in brand/ (the OFL fonts of templates/ under other names):
 * template_from_site on the brand-site fixture (self-signed https on invented `.test` names, reached through the unsafe
 * test resolver in the server's environment; the approval answered through elicitation) → template_create_from_brand
 * from its draft with the `site:` logo candidate, the brand/ fonts and the site's colours → template_list shows it
 * (`workspace`) → template_preview stills → a capture of `quote` rendered with the new theme (guarded: nothing blocked)
 * → review: clean. With RETAKE_ACCEPTANCE_KEEP=<folder>, the stills, the sheets and the video are copied there to
 * look at.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parseYaml } from '@retake/core';
import { readWorkerLock } from '@retake/engine';
import { REPO } from '../../engine/test/helpers.js';
import { TEMPLATES, linkSharedCache } from '../../editor/test/render-helpers.js';
import { BRAND_SITE_COLORS, hasOpenssl, startBrandSite } from '../../runner-web/test/site-fixture.js';
import type { BrandSite } from '../../runner-web/test/site-fixture.js';

const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const FIXTURE_PROJECT = join(REPO, 'projects', 'northfield-fixture');
const GENERATED = new Set(['runs', 'renders', 'review', 'exports', '.retake', 'frames']);
const tool = (n: string) => spawnSync(n, ['-version'], { stdio: 'ignore' }).status === 0;
const ENABLED = process.env.RETAKE_TEST_SLOW === '1' && tool('ffmpeg') && tool('ffprobe') && hasOpenssl();
const KEEP = process.env.RETAKE_ACCEPTANCE_KEEP;
const STEP = 900_000;
const THEME = 'quillmere';

type Block = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { content: Block[]; structuredContent?: Record<string, unknown>; isError?: boolean };

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

let fixture: Fixture;
let site: BrandSite;
let root: string;
let client: Client;
let stderr = '';
const asked: string[] = [];
const ids: { site?: string; logo?: string; run?: string; render?: string } = {};
let draft: { base: string; brand_input: { colors: Record<string, string>; logo?: string; base?: string } } | undefined;

async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as Result;
  expect(r.isError, `${name}: ${r.content[0]?.text} ${JSON.stringify(r.structuredContent ?? {})}`).toBeFalsy();
  return r;
}

/** Call a long-polling status tool until `done` says it finished (25 s per call). */
async function follow(name: string, args: Record<string, unknown>, done: (r: Result) => boolean, rounds = 40): Promise<Result> {
  let r = await call(name, { ...args, wait_s: 25 });
  for (let i = 0; i < rounds && !done(r); i++) r = await call(name, { ...args, wait_s: 25 });
  expect(done(r), r.content[0].text).toBe(true);
  return r;
}

const images = (r: Result) => r.content.filter((b) => b.type === 'image');
const data = <T>(r: Result) => r.structuredContent as T;
const finished = (x: Result) => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(data<{ job?: { state: string }; state?: string }>(x).job?.state ?? data<{ state?: string }>(x).state ?? '');

/** The colour of a still at (40, height / 2), read with ffmpeg. */
function pixel(file: string): number[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'crop=w=2:h=2:x=40:y=ih/2,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1024 });
  return [...out.stdout];
}

async function keep(sub: string, files: string[]): Promise<void> {
  if (!KEEP) return;
  const dir = join(KEEP, sub);
  await mkdir(dir, { recursive: true });
  for (const f of files) await cp(f, join(dir, f.split('/').pop()!));
}

describe.skipIf(!ENABLED)('theme acceptance through MCP: a theme from a site and brand files → preview → capture → render → review (RETAKE_TEST_SLOW=1)', () => {
  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture> };
    fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
    site = await startBrandSite();
    root = await mkdtemp(join(tmpdir(), 'studio-mcp-theme-acceptance-'));
    await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
    await mkdir(join(root, 'templates'), { recursive: true });
    const project = join(root, 'projects', 'northfield-fixture');
    await cp(FIXTURE_PROJECT, project, { recursive: true, filter: (src) => !GENERATED.has(src.slice(FIXTURE_PROJECT.length + 1).split('/')[0]) });
    // The copy's local environment on the fixture's free ports (display URLs unchanged).
    const yaml = await readFile(join(project, 'project.yaml'), 'utf8');
    await writeFile(
      join(project, 'project.yaml'),
      yaml.replaceAll('http://localhost:4401', fixture.urls.console.replace(/\/$/, '')).replaceAll('http://localhost:4402', fixture.urls.shop.replace(/\/$/, '')),
    );
    await symlink(join(REPO, 'fixtures'), join(root, 'fixtures'));
    // The user's font files (the starters' OFL fonts under other names): a geometric display, a text family.
    await mkdir(join(root, 'brand'), { recursive: true });
    await cp(join(TEMPLATES, 'motion', 'fonts', 'SpaceGrotesk-Bold.ttf'), join(root, 'brand', 'Quill-Display-Bold.ttf'));
    for (const w of ['Regular', 'SemiBold', 'Bold']) await cp(join(TEMPLATES, 'default', 'fonts', `Inter-${w}.ttf`), join(root, 'brand', `Quill-Text-${w}.ttf`));
    await linkSharedCache(root);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--conditions=source', '--import', 'tsx', BIN, '--root', root, 'mcp'],
      cwd: REPO,
      env: {
        PATH: process.env.PATH ?? '',
        CFFIXED_USER_HOME: process.env.CFFIXED_USER_HOME ?? '',
        HOME: process.env.HOME ?? '',
        RETAKE_HOME: join(root, '.home'),
        RETAKE_WORKER_IDLE_MS: '5000',
        RETAKE_UNSAFE_TEST_RESOLVE: site.resolveEnv,
      },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    // A client whose user approves what the server asks (the site's URL; the quote's setup hooks).
    client = new Client({ name: 'retake-theme-acceptance', version: '0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push((req.params as { message: string }).message);
      return { action: 'accept', content: { approve: true } };
    });
    await client.connect(transport);
  }, 120_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    const w = root ? readWorkerLock(root) : null;
    if (w) {
      try {
        process.kill(w.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    await site?.close();
    await fixture?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('reads the brand site through template_from_site (approved by the user): colours by role, a site: logo, a draft', async () => {
    let r = await call('template_from_site', { url: 'https://brand.test/', wait_s: 25 });
    if (!finished(r)) r = await follow('job_status', { job_id: data<{ job: { id: string } }>(r).job.id }, finished);
    const v = data<{ site_id: string; status: string; palette: { roles: Record<string, string> }; candidates: Array<{ ref: string; file: string }>; draft: typeof draft }>(r);
    expect(v.status, r.content[0].text).toBe('ok');
    expect(asked.filter((a) => /^URL: https:\/\/brand\.test\/$/m.test(a))).toHaveLength(1);
    expect(v.palette.roles).toEqual(BRAND_SITE_COLORS);
    expect(v.candidates.length).toBeGreaterThanOrEqual(2);
    for (const c of v.candidates) expect(existsSync(c.file), c.file).toBe(true);
    expect(v.draft?.brand_input.logo).toBe(`site:${v.site_id}/logo-1`);
    ids.site = v.site_id;
    ids.logo = v.draft!.brand_input.logo;
    draft = v.draft!;
    expect(images(r).length).toBeGreaterThanOrEqual(2);
    expect(site.escape).toEqual({ tcp: 0, udp: 0, upgrades: 0 });
    expect(site.writes).toEqual([]);
    await keep('site', v.candidates.map((c) => c.file));
  }, STEP);

  it('creates the theme from the draft with the site logo, the brand/ fonts and the chosen colours; template_list shows it', async () => {
    const input = {
      ...draft!.brand_input,
      name: THEME,
      logo: ids.logo,
      colors: { ...draft!.brand_input.colors },
      fonts: { display: 'brand/Quill-Display-Bold.ttf', body: ['brand/Quill-Text-Regular.ttf', 'brand/Quill-Text-SemiBold.ttf', 'brand/Quill-Text-Bold.ttf'] },
      brand: { name: 'Quillmere', url: 'quillmere.test' },
    };
    const r = await call('template_create_from_brand', input);
    const dir = join(root, 'templates', THEME);
    expect(r.structuredContent).toMatchObject({ name: THEME, dir, base: 'editorial', replaced: false });
    const made = data<{ files: string[]; fonts: Array<{ file: string }> }>(r);
    expect(made.files).toEqual(expect.arrayContaining(['template.yaml', 'logo.png', 'LICENSES.md']));
    expect(made.fonts.map((f) => f.file)).toEqual(['fonts/display-Bold.ttf', 'fonts/body-Regular.ttf', 'fonts/body-SemiBold.ttf', 'fonts/body-Bold.ttf']);
    const file = parseYaml(await readFile(join(dir, 'template.yaml'), 'utf8')).value as { colors: Record<string, string>; logo: string; brand: { name: string; url: string }; outro: { url?: string } };
    expect(file.colors).toMatchObject({ accent: BRAND_SITE_COLORS.accent, text: BRAND_SITE_COLORS.text, paper: BRAND_SITE_COLORS.paper });
    expect(file.logo).toBe('logo.png');
    expect(file.brand).toEqual({ name: 'Quillmere', url: 'quillmere.test' });
    expect(file.outro.url).toBe('quillmere.test');
    expect((JSON.parse(await readFile(join(dir, '.retake-theme.json'), 'utf8')) as { site_id: string }).site_id).toBe(ids.site);
    const l = await call('template_list', {});
    expect(l.content[0].text).toMatch(new RegExp(`- ${THEME} \\(workspace, real\\)`));
  }, STEP);

  it('template_preview renders its stills', async () => {
    let r = await call('template_preview', { project: 'northfield-fixture', template: THEME, wait_s: 25 });
    if (!finished(r)) r = await follow('job_status', { job_id: data<{ job: { id: string } }>(r).job.id }, finished);
    const stills = data<{ stills: Array<{ kind: string; file: string; bytes: number }> }>(r).stills;
    expect(stills.map((s) => s.kind)).toEqual(['intro', 'layout', 'card', 'interstitial', 'outro']);
    for (const s of stills) expect(s.bytes).toBeGreaterThan(5_000);
    expect(images(r).length).toBeGreaterThanOrEqual(1);
    // The palette drawn: the interstitial on the site's dark colour, the outro on (a tint of) its paper.
    const near = (a: number[], hex: string, tol: number) => [1, 3, 5].every((o, i) => Math.abs(a[i] - parseInt(hex.slice(o, o + 2), 16)) <= tol);
    expect(near(pixel(stills.find((s) => s.kind === 'interstitial')!.file), BRAND_SITE_COLORS.dark, 6)).toBe(true);
    expect(near(pixel(stills.find((s) => s.kind === 'outro')!.file), BRAND_SITE_COLORS.paper, 14)).toBe(true);
    await keep('preview', stills.map((s) => s.file));
  }, STEP);

  it('captures quote on the fixture and renders it with the new theme (guarded: nothing blocked); the review is clean', async () => {
    const run = await call('run_capture', { project: 'northfield-fixture', scenario: 'quote' });
    ids.run = data<{ id: string }>(run).id;
    const rs = await follow('run_status', { project: 'northfield-fixture', run_id: ids.run }, (x) => data<{ finished: boolean }>(x).finished === true);
    expect(data<{ status: string }>(rs).status, rs.content[0].text).toBe('succeeded');

    const r = await call('render', { project: 'northfield-fixture', scenario: 'quote', run_id: ids.run, template: THEME });
    ids.render = data<{ render_id: string }>(r).render_id;
    const st = await follow('render_status', { project: 'northfield-fixture', render_id: ids.render }, (x) => data<{ finished: boolean }>(x).finished === true);
    const view = data<{ status: string; file: string; record: { template: string; width: number }; untrusted: { warnings: string[] } }>(st);
    expect(view.status, st.content[0].text).toBe('succeeded');
    expect(view.record).toMatchObject({ template: THEME, width: 1920 });
    expect(view.untrusted.warnings.filter((w) => w.startsWith('the render blocked'))).toEqual([]);

    const rv = await call('review', { project: 'northfield-fixture', render_id: ids.render, wait_s: 25 });
    const done = data<{ finished: boolean }>(rv).finished ? rv : await follow('review_get', { project: 'northfield-fixture', render_id: ids.render }, (x) => data<{ finished: boolean }>(x).finished === true);
    const v = data<{ clean: boolean; counts: Record<string, number>; files: { sheets: string[] } }>(done);
    expect(v.counts.error, done.content[0].text).toBe(0);
    expect(v.clean, done.content[0].text).toBe(true);
    expect(images(done).length).toBeGreaterThanOrEqual(1);
    await keep('render', [...v.files.sheets, view.file]);
    expect(stderr).not.toMatch(/unhandled|cancelRender/i);
  }, STEP);
});
