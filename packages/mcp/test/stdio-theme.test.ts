/**
 * L3.5 a theme from brand files through `retake mcp` (spawned from the sources over stdio, driven by the SDK client),
 * in a temporary workspace: template_create_from_brand with the user's files in brand/ → template_list shows the new
 * theme (`workspace`) → template_preview renders its stills through the existing preview job (images inline) → a
 * second call with replace: true changes it while nobody edited it. Refusals over stdio: a starter name, an
 * agent-writable source, a script SVG, a path outside the workspace. The starter themes and the built-in component
 * folders are byte for byte the same afterwards. Only the preview needs ffmpeg (and a headless shell): everything else
 * runs without it.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LIBRARY_DIR } from '@retake/components';
import { readWorkerLock } from '@retake/engine';
import { REPO } from '../../engine/test/helpers.js';
import { TEMPLATES, hasTool, linkSharedCache } from '../../editor/test/render-helpers.js';

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
  for (const e of (await readdir(dir, { withFileTypes: true, recursive: true })).filter((x) => x.isFile()).map((x) => join(x.parentPath, x.name)).sort()) {
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
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', RETAKE_HOME: join(root, '.home'), RETAKE_WORKER_IDLE_MS: '1500' },
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

describe('retake mcp: a theme from brand files', () => {
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
    const l = await call('template_list', {});
    expect(l.content[0].text).toMatch(/- harbor \(workspace, real\): intro studio\/intro-stack/);
    const d = await call('template_list', { template: 'harbor' });
    expect(d.content[0].text).toMatch(/Themes are never edited through this server \(a human edits them\): template_create_from_brand makes new ones, and replaces only one it made through MCP that nobody changed — its brand name and URL are text an agent gave/);
  });

  it.skipIf(!can)('template_preview renders its stills through the preview job', async () => {
    const r = await call('template_preview', { project: 'demo', template: 'harbor', wait_s: 25 });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ theme: 'harbor', job: { state: 'succeeded' } });
    const stills = (r.structuredContent as { stills: Array<{ kind: string; file: string; bytes: number }> }).stills;
    expect(stills.map((s) => s.kind)).toEqual(['intro', 'layout', 'card', 'interstitial', 'outro']);
    for (const s of stills) expect(s.bytes).toBeGreaterThan(5_000);
    expect(imagesOf(r).length).toBeGreaterThanOrEqual(4);
    expect(stderr).not.toMatch(/font.*fail|cancelRender/i);
  }, LONG);

  it('replace: true changes it while nobody edited it; after a human edit it is refused', async () => {
    const r = await call('template_create_from_brand', { ...brand, colors: { accent: '#0e7c66' }, replace: true });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(r.content[0].text).toMatch(/^replaced theme harbor/);
    const yaml = join(root, 'templates', 'harbor', 'template.yaml');
    await writeFile(yaml, `${await readFile(yaml, 'utf8')}# a human note\n`);
    const again = await call('template_create_from_brand', { ...brand, replace: true });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toMatch(/template.yaml was changed since it was made/);
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

  it('the starter themes and the built-in components are unchanged', async () => {
    expect(await folderHash(TEMPLATES)).toBe(startersBefore);
    expect(await folderHash(LIBRARY_DIR)).toBe(libraryBefore);
  });
});
