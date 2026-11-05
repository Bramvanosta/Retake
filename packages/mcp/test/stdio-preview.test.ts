/**
 * L3.2 themes and components through `retake mcp` (spawned from the sources over stdio, driven by the SDK client), in a
 * temporary workspace (the repository root is itself one: component_create there would write <repo>/components/):
 * template_list (list, detail), template_preview and component_preview rendered by the worker with their stills inline
 * (JPEG ≤ 1280 px, within the caps, the rest as files) — never into a component folder; job_status returns the stills
 * of a preview that outlived its wait; component_list / get / validate; component_create scaffolds and refuses the
 * built-in namespace; no tool takes a path. Needs ffmpeg and a headless shell.
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
import { testChildEnv } from '../../core/test/child-env.js';

const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const can = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 300_000;

type Block = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { content: Block[]; structuredContent?: Record<string, unknown>; isError?: boolean };

let root: string;
let client: Client;
let stderr = '';

async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as Result;
}

const imagesOf = (r: Result) => r.content.filter((b) => b.type === 'image');

function jpegSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  for (let i = 2; i + 9 < buf.length; ) {
    if (buf[i] !== 0xff) return undefined;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return undefined;
}

async function folderHash(dir: string): Promise<string> {
  const h = createHash('sha256');
  for (const e of (await readdir(dir, { withFileTypes: true, recursive: true })).filter((x) => x.isFile()).map((x) => join(x.parentPath, x.name)).sort()) {
    h.update(`${e}\0`).update(await readFile(e));
  }
  return h.digest('hex');
}

beforeAll(async () => {
  if (!can) return;
  root = await mkdtemp(join(tmpdir(), 'studio-mcp-preview-'));
  await mkdir(join(root, 'templates'), { recursive: true });
  for (const t of ['editorial', 'motion']) await cp(join(TEMPLATES, t), join(root, 'templates', t), { recursive: true });
  await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
  await mkdir(join(root, 'projects', 'demo'), { recursive: true });
  await writeFile(join(root, 'projects', 'demo', 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
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

describe.skipIf(!can)('retake mcp: themes and components', () => {
  it('lists the tools: reads are read only, previews are jobs that never touch the product, create writes files', async () => {
    const { tools } = await client.listTools();
    const by = new Map(tools.map((t) => [t.name, t]));
    for (const n of ['template_list', 'component_list', 'component_get', 'component_validate']) expect(by.get(n)?.annotations, n).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    for (const n of ['template_preview', 'component_preview', 'component_create']) expect(by.get(n)?.annotations, n).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(by.get('component_create')?.inputSchema.required).toEqual(['id', 'kind', 'description']);
    expect(client.getInstructions()).toContain('component code, existing themes and project.yaml are never written through this server');
  });

  it('template_list: the themes by name, the project\'s marked; template gives one in detail', async () => {
    const r = await call('template_list', { project: 'demo' });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    expect(r.content[0].text).toMatch(/editorial \(workspace, the project's theme/);
    expect(r.content[0].text).toMatch(/motion \(workspace/);
    const d = await call('template_list', { template: 'motion' });
    expect(d.structuredContent).toMatchObject({ name: 'motion', source: 'workspace' });
    expect(d.content[0].text).toContain('components:');
    const bad = await call('template_list', { template: '../motion' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/template: a theme name/);
  });

  it('component_preview returns its still inline (JPEG ≤ 1280 px) from .retake/previews/; the built-in folder is unchanged', async () => {
    const lib = join(LIBRARY_DIR, 'studio', 'card-title');
    const before = await folderHash(lib);
    const r = await call('component_preview', { project: 'demo', component: 'studio/card-title', template: 'motion', slots: { title: 'Quotes in two clicks' }, params: { tone: 'dark' }, wait_s: 25 });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ theme: 'motion', targets: ['studio/card-title'], job: { state: 'succeeded' } });
    const imgs = imagesOf(r);
    expect(imgs).toHaveLength(1);
    const size = jpegSize(Buffer.from(imgs[0].data!, 'base64'));
    expect(size).toEqual({ width: 960, height: 540 });
    const dir = (r.structuredContent as { dir: string }).dir;
    expect(dir.startsWith(join(root, '.retake', 'previews', 'p_'))).toBe(true);
    expect(r.content.find((b) => b.type === 'text' && b.text?.startsWith('image 1/1'))?.text).toContain('studio/card-title (motion theme, at');
    expect(await folderHash(lib)).toBe(before);
  }, LONG);

  it('template_preview returns the theme\'s stills: 4 inline, the 5th as a file; job_status returns them too', async () => {
    const r = await call('template_preview', { project: 'demo', wait_s: 25 });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ theme: 'editorial', job: { state: 'succeeded' } });
    const stills = (r.structuredContent as { stills: Array<{ kind: string; file: string }> }).stills;
    expect(stills.map((s) => s.kind)).toEqual(['intro', 'layout', 'card', 'interstitial', 'outro']);
    expect(imagesOf(r)).toHaveLength(4);
    expect(r.content[0].text).toMatch(/1 more image as files \(read them to see them\): outro: studio\/.*outro\.png/);
    const jobId = (r.structuredContent as { job: { id: string } }).job.id;
    const js = await call('job_status', { job_id: jobId });
    expect(imagesOf(js)).toHaveLength(4);
    expect(js.content[0].text).toContain('preview images in');
  }, LONG);

  it('component_list / get / validate; component_create scaffolds a workspace component and refuses the built-in namespace', async () => {
    const list = await call('component_list', { kind: 'card' });
    expect(list.content[0].text).toContain('studio/card-title (card, builtin');
    const got = await call('component_get', { component: 'studio/card-title' });
    expect(got.content[0].text).toContain('slots: title (text, required), kicker (text), text (text)');
    const created = await call('component_create', { id: 'acme/intro-split', kind: 'intro', description: 'A split intro.' });
    expect(created.isError, JSON.stringify(created)).toBeFalsy();
    expect(created.structuredContent).toMatchObject({ id: 'acme/intro-split', dir: join(root, 'components', 'acme', 'intro-split') });
    expect((await call('component_validate', { component: 'acme/intro-split' })).structuredContent).toMatchObject({ ok: true });
    const refused = await call('component_create', { id: 'studio/intro-split', kind: 'intro', description: 'x' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/^refused: .*built-in library/);
    const path = await call('component_get', { component: '../../etc' });
    expect(path.isError).toBe(true);
    expect(existsSync(join(REPO, 'components'))).toBe(false);
  });

  it('component_preview of a still running job answers queued/running and job_status follows it', async () => {
    const r = await call('component_preview', { project: 'demo', component: 'acme/intro-split', wait_s: 0 });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    expect(imagesOf(r)).toEqual([]);
    expect(r.content[0].text).toMatch(/follow it: job_status \{job_id: "j_[0-9A-Z]{26}", wait_s: 25\}/);
    const jobId = (r.structuredContent as { job: { id: string } }).job.id;
    let js = await call('job_status', { job_id: jobId, wait_s: 25 });
    for (let i = 0; i < 4 && !imagesOf(js).length; i++) js = await call('job_status', { job_id: jobId, wait_s: 25 });
    expect(imagesOf(js)).toHaveLength(1);
    // The same stills as component_preview gives when it finishes in time (a client reads `stills` either way).
    const stills = (js.structuredContent as { stills?: Array<{ file: string }>; dir?: string }).stills;
    expect(stills).toHaveLength(1);
    expect(stills![0].file.startsWith((js.structuredContent as { dir: string }).dir)).toBe(true);
    expect(existsSync(join(root, 'components', 'acme', 'intro-split', 'preview.png'))).toBe(false);
    expect(stderr).not.toMatch(/unhandled|TypeError/i);
  }, LONG);
});
