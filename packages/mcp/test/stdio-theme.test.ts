/**
 * A theme from brand files through `retake mcp` (spawned from the sources over stdio, driven by the SDK client),
 * in a temporary workspace: template_create_from_brand with the user's files in brand/ → template_list shows the new
 * theme (`workspace`) → template_preview renders its stills through the existing preview job (images inline) → a
 * second call with replace: true changes it while nobody edited it. Refusals over stdio: a starter name, an
 * agent-writable source, a script SVG, a path outside the workspace. font_fetch against a loopback registry (the test
 * hatch; the suite's guard refuses any other), the user approving in the form, then a theme from the stored fonts;
 * template_from_tokens returning the proposal and writing nothing. The starter themes and the built-in component
 * folders are byte for byte the same afterwards. Only the preview needs ffmpeg (and a headless shell): everything else
 * runs without it.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LIBRARY_DIR } from '@retake/components';
import { readWorkerLock } from '@retake/engine/testing';
import { REPO } from '@retake/test-support/repo';
import { TEMPLATES, hasTool } from '@retake/test-support/repo';
import { linkSharedCache } from '@retake/test-support/render';
import { testChildEnv } from '@retake/test-support/child-env';
import { fakePackage, loopbackRegistry } from '@retake/test-support/fontsource';

const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const can = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 300_000;

type Block = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { content: Block[]; structuredContent?: Record<string, unknown>; isError?: boolean };

let root: string;
let client: Client;
let stderr = '';
let startersBefore = '';
let libraryBefore = '';

async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as Result;
}

const imagesOf = (r: Result) => r.content.filter((b) => b.type === 'image');

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

beforeAll(async () => {
  startersBefore = await folderHash(TEMPLATES);
  libraryBefore = await folderHash(LIBRARY_DIR);
  root = await mkdtemp(join(tmpdir(), 'studio-mcp-theme-'));
  await mkdir(join(root, 'templates'), { recursive: true });
  await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
  await mkdir(join(root, 'projects', 'demo', 'scenarios'), { recursive: true });
  await writeFile(join(root, 'projects', 'demo', 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  // The user's brand files (here: the starters' placeholder artwork and OFL fonts under other names).
  await mkdir(join(root, 'brand'), { recursive: true });
  await cp(join(TEMPLATES, 'default', 'logo.svg'), join(root, 'brand', 'mark.svg'));
  await cp(join(TEMPLATES, 'default', 'wordmark.svg'), join(root, 'brand', 'name.svg'));
  await cp(join(TEMPLATES, 'motion', 'fonts', 'SpaceGrotesk-Bold.ttf'), join(root, 'brand', 'Headline.ttf'));
  for (const w of ['Regular', 'SemiBold', 'Bold']) await cp(join(TEMPLATES, 'default', 'fonts', `Inter-${w}.ttf`), join(root, 'brand', `Text-${w}.ttf`));
  await writeFile(join(root, 'brand', 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><image href="https://tracker.test/p.png"/></svg>');
  // A logo the agent could have written (scenarios/ is agent-writable).
  await cp(join(TEMPLATES, 'default', 'logo.svg'), join(root, 'projects', 'demo', 'scenarios', 'logo.svg'));
  await linkSharedCache(root);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--conditions=source', '--import', 'tsx', BIN, '--root', root, 'mcp'],
    cwd: REPO,
    env: testChildEnv({ RETAKE_HOME: join(root, '.home'), RETAKE_WORKER_IDLE_MS: '1500' }),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  client = new Client({ name: 'retake-test', version: '0' }, { capabilities: {} });
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
  if (root) await rm(root, { recursive: true, force: true });
});

const brand = {
  name: 'harbor',
  colors: { accent: '#3352b8' },
  logo: 'brand/mark.svg',
  wordmark: 'brand/name.svg',
  fonts: { display: 'brand/Headline.ttf', body: ['brand/Text-Regular.ttf', 'brand/Text-SemiBold.ttf', 'brand/Text-Bold.ttf'] },
  brand: { name: 'Harbor', url: 'harbor.test' },
};

/** The theme harbor made from the brand files, for a case about what follows its creation. */
async function makeHarbor(): Promise<void> {
  const r = await call('template_create_from_brand', brand);
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
}

describe('retake mcp: a theme from brand files', () => {
  // Each case starts without the theme harbor.
  beforeEach(async () => {
    await rm(join(root, 'templates', 'harbor'), { recursive: true, force: true });
  });

  it('lists template_create_from_brand: writes files (a replace removes a folder: destructive), no open world, its input schema strict', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'template_create_from_brand');
    expect(t?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(t?.inputSchema.required).toEqual(['name', 'colors', 'logo']);
    expect(client.getInstructions()).toContain('template_create_from_brand');
  });

  it('creates the theme: its folder, palette, fonts; font strings only under untrusted; next is template_preview', async () => {
    const r = await call('template_create_from_brand', brand);
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const dir = join(root, 'templates', 'harbor');
    expect(r.structuredContent).toMatchObject({ name: 'harbor', dir, base: 'editorial', replaced: false });
    expect(r.content[0].text).toMatch(/^created theme harbor \(over editorial, light\) in /);
    expect(r.content[0].text).toContain('next: template_preview {project, template: "harbor"}');
    const data = r.structuredContent as { fonts: Array<{ file: string }>; untrusted: { fonts: Array<{ family: string }> } };
    expect(data.fonts.map((f) => f.file)).toEqual(['fonts/display-Bold.ttf', 'fonts/body-Regular.ttf', 'fonts/body-SemiBold.ttf', 'fonts/body-Bold.ttf']);
    expect(data.untrusted.fonts.map((f) => f.family)).toEqual(['Space Grotesk', 'Inter', 'Inter', 'Inter']);
    // Family names never outside `untrusted` (in the data) nor in the summary.
    const { untrusted: _u, ...rest } = r.structuredContent as Record<string, unknown>;
    expect(JSON.stringify(rest)).not.toMatch(/Space Grotesk/);
    expect(r.content[0].text).not.toMatch(/Space Grotesk/);
    expect(existsSync(join(dir, 'template.yaml'))).toBe(true);
  });

  it('template_list shows it as a workspace theme; its detail says themes are never edited here and who wrote its brand text', async () => {
    await makeHarbor();
    const l = await call('template_list', {});
    expect(l.content[0].text).toMatch(/- harbor \(workspace, real\): intro studio\/intro-stack/);
    const d = await call('template_list', { template: 'harbor' });
    expect(d.content[0].text).toMatch(
      /Themes a person made or changed are never written through this server \(a human edits them\): template_create_from_brand makes new ones, and template_update \/ replace: true re-make only one it made through MCP that nobody changed — its brand name and URL are text an agent gave/,
    );
  });

  it.skipIf(!can)(
    'template_preview renders its stills through the preview job',
    async () => {
      await makeHarbor();
      const r = await call('template_preview', { project: 'demo', template: 'harbor', wait_s: 25 });
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
      expect(r.structuredContent).toMatchObject({ theme: 'harbor', job: { state: 'succeeded' } });
      const stills = (r.structuredContent as { stills: Array<{ kind: string; file: string; bytes: number }> }).stills;
      expect(stills.map((s) => s.kind)).toEqual(['intro', 'layout', 'card', 'interstitial', 'outro']);
      for (const s of stills) expect(s.bytes).toBeGreaterThan(5_000);
      expect(imagesOf(r).length).toBeGreaterThanOrEqual(4);
      expect(stderr).not.toMatch(/font.*fail|cancelRender/i);
    },
    LONG,
  );

  it('replace: true changes it while nobody edited it; after a human edit it is refused', async () => {
    await makeHarbor();
    const r = await call('template_create_from_brand', { ...brand, colors: { accent: '#0e7c66' }, replace: true });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(r.content[0].text).toMatch(/^replaced theme harbor/);
    const yaml = join(root, 'templates', 'harbor', 'template.yaml');
    await writeFile(yaml, `${await readFile(yaml, 'utf8')}# a human note\n`);
    const again = await call('template_create_from_brand', { ...brand, replace: true });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toMatch(/template.yaml was changed since it was made/);
  });

  it("template_update over stdio: a theme made through MCP changes one key (destructive, no open world); a person's is refused", async () => {
    const { tools } = await client.listTools();
    expect(tools.find((x) => x.name === 'template_update')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    await makeHarbor();
    const r = await call('template_update', { name: 'harbor', components: { outro: { params: { logo_size: 72 } } } });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(r.content[0].text).toMatch(/^updated theme harbor: components\.outro changed \(the rest as made\)/);
    expect(r.structuredContent).toMatchObject({ name: 'harbor', replaced: true, changed: ['components.outro'] });
    expect(await readFile(join(root, 'templates', 'harbor', 'template.yaml'), 'utf8')).toMatch(/outro: \{id: studio\/outro-stack, params: \{logo_size: 72\}\}/);
    // A person's theme (the starter's copy in templates/, no provenance) is never changed.
    await cp(join(TEMPLATES, 'editorial'), join(root, 'templates', 'person'), { recursive: true });
    const refused = await call('template_update', { name: 'person', colors: { paper: '#101010' } });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/not made by this tool/);
    await rm(join(root, 'templates', 'person'), { recursive: true, force: true });
  });

  it.each([
    [{ name: 'motion' }, /starter theme motion/],
    [{ name: 'other1', logo: 'projects/demo/scenarios/logo.svg' }, /scenarios\/ of project demo, a folder an agent can write/],
    [{ name: 'other2', logo: 'brand/evil.svg' }, /an SVG this tool does not copy — a href to something other than a fragment/],
    [{ name: 'other3', logo: '../outside.svg' }, /goes out with/],
    [{ name: 'other4', logo: '.retake/cache/x.svg' }, /hidden folder/],
  ])('refused over stdio: %j', async (over, why) => {
    const r = await call('template_create_from_brand', { ...brand, ...over });
    expect(r.isError).toBe(true);
    expect(r.content.map((b) => b.text ?? '').join('\n')).toMatch(why);
    expect(existsSync(join(root, 'templates', (over as { name: string }).name, 'template.yaml'))).toBe(false);
  });

  it('template_from_tokens over stdio returns the proposal and writes nothing (read-only, names under untrusted)', async () => {
    await writeFile(join(root, 'brand', 'tokens.json'), JSON.stringify({ color: { $type: 'color', background: { $value: '#fafaf7' }, brand: { primary: { $value: '#3352b8' } } } }));
    const { tools } = await client.listTools();
    expect(tools.find((x) => x.name === 'template_from_tokens')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    const before = await readdir(join(root, 'templates'));
    const r = await call('template_from_tokens', { tokens: 'brand/tokens.json', name: 'harbor-tokens' });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(r.content[0].text).toMatch(/proposed roles: accent #3352b8 \(token #1, by name/);
    const data = JSON.parse(r.content[1].text!) as { draft: { brand_input: Record<string, unknown> }; untrusted: { colours: Array<{ name: string }> } };
    expect(data.draft.brand_input).toMatchObject({ name: 'harbor-tokens', colors: { accent: '#3352b8', paper: '#fafaf7' } });
    expect(data.untrusted.colours.map((c) => c.name)).toEqual(['color.background', 'color.brand.primary']);
    expect(await readdir(join(root, 'templates'))).toEqual(before);
  });

  it("font_fetch is listed open world; without the test hatch the suite's guard refuses it before any question", async () => {
    const { tools } = await client.listTools();
    expect(tools.find((x) => x.name === 'font_fetch')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    const r = await call('font_fetch', { refs: ['fontsource:test-sans@5.2.1:400'] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/RETAKE_TEST_NO_FONT_FETCH/);
  });

  it('the starter themes and the built-in components are unchanged', async () => {
    expect(await folderHash(TEMPLATES)).toBe(startersBefore);
    expect(await folderHash(LIBRARY_DIR)).toBe(libraryBefore);
  });
});

describe('retake mcp: open-licence fonts by reference (a loopback registry)', () => {
  it('font_fetch over stdio: the user approves the form (the test registry named), the store holds the faces, a theme takes them offline', async () => {
    const registry = await loopbackRegistry([fakePackage({ faces: ['400', '700'] })]);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--conditions=source', '--import', 'tsx', BIN, '--root', root, 'mcp'],
      cwd: REPO,
      env: testChildEnv({ RETAKE_HOME: join(root, '.home'), RETAKE_WORKER_IDLE_MS: '1500', RETAKE_UNSAFE_TEST_NPM_REGISTRY: registry.base }),
      stderr: 'pipe',
    });
    const asking = new Client({ name: 'retake-test', version: '0' }, { capabilities: { elicitation: { form: {} } } });
    const asked: string[] = [];
    asking.setRequestHandler(ElicitRequestSchema, async (req) => {
      // Asked before any request reached the registry.
      asked.push(`${(req.params as { message: string }).message}\n[requests so far: ${registry.requests.length}]`);
      return { action: 'accept', content: { approve: true } };
    });
    await asking.connect(transport);
    try {
      const at = (name: string, args: Record<string, unknown>) => asking.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }) as Promise<Result>;
      const f = await at('font_fetch', { refs: ['fontsource:test-sans:400', 'fontsource:test-sans:700'] });
      expect(f.isError, JSON.stringify(f.content)).toBeFalsy();
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain(`From: ${registry.base} — a TEST registry`);
      expect(asked[0]).toContain('- @fontsource/test-sans latest (resolved now, and recorded): 400, 700');
      expect(asked[0]).toContain('[requests so far: 0]');
      expect(registry.requests).toEqual(['/@fontsource%2ftest-sans/latest', '/@fontsource/test-sans/-/test-sans-5.2.1.tgz']);
      expect(f.content[0].text).toMatch(/@fontsource\/test-sans 5\.2\.1 \(latest, resolved now: pin it next time\), OFL-1\.1/);
      const c = await at('template_create_from_brand', { name: 'harbor-fonts', colors: { accent: '#3352b8' }, logo: 'brand/mark.svg', fonts: { display: 'fontsource:test-sans@5.2.1:700', body: ['fontsource:test-sans@5.2.1:400'] } });
      expect(c.isError, JSON.stringify(c.content)).toBeFalsy();
      // The create read the store only: no new request reached the registry.
      expect(registry.requests).toHaveLength(2);
      expect(c.content[0].text).toMatch(/warning: display font fontsource:test-sans@5\.2\.1:700 was fetched from a TEST registry/);
      expect(await readFile(join(root, 'templates', 'harbor-fonts', 'LICENSES.md'), 'utf8')).toContain('### `@fontsource/test-sans` 5.2.1');
    } finally {
      await asking.close().catch(() => undefined);
      await registry.close();
      await rm(join(root, 'templates', 'harbor-fonts'), { recursive: true, force: true });
    }
  });
});
