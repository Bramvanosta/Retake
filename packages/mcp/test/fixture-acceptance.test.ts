/**
 * L3.2 fixture acceptance through MCP (slow: gated by RETAKE_TEST_SLOW=1 — `pnpm test:slow`, several minutes).
 * An SDK client drives `retake mcp` (spawned from the sources over stdio) on a copy of projects/northfield-fixture
 * (its local environment pointed at the fixture product started on free ports) the way an agent would: capture the
 * `quote` scenario → render it with the editorial theme → review it (clean, the contact sheet received as images) →
 * render it again with the motion theme and the laptop layout (no scenario change) → review it (all images) → export
 * mp4_1080p, gif_preview and vertical_9x16 → job_status. Every render runs guarded: none may report a blocked request.
 * L3.6: between the two renders a person comments the proposal of the editorial render, asking for a laptop frame
 * (`retake comment add --marker proposal --region …`, the CLI in its own process); comments_list returns the anchor (the
 * marked wait_for step, the marker, the callout overlay) and the still; comment_reply; the motion + laptop render answers
 * it and comment_resolve names it with if_match; listings by status and render. L3.8: the request is one a render
 * answers — a scenario change would need a new capture first (plan_preview says scenario_changed: false here).
 * With RETAKE_ACCEPTANCE_KEEP=<folder>, the reviews' sheets, the comment's still and the exports are copied there.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readWorkerLock } from '@retake/engine';
import { REPO } from '../../engine/test/helpers.js';
import { linkSharedCache } from '../../editor/test/render-helpers.js';

const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const FIXTURE_PROJECT = join(REPO, 'projects', 'northfield-fixture');
const GENERATED = new Set(['runs', 'renders', 'review', 'exports', '.retake', 'frames']);
const tool = (n: string) => spawnSync(n, ['-version'], { stdio: 'ignore' }).status === 0;
const ENABLED = process.env.RETAKE_TEST_SLOW === '1' && tool('ffmpeg') && tool('ffprobe');
const KEEP = process.env.RETAKE_ACCEPTANCE_KEEP;
const STEP = 900_000;

type Block = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { content: Block[]; structuredContent?: Record<string, unknown>; isError?: boolean };

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

let fixture: Fixture;
let root: string;
let client: Client;
let stderr = '';
const asked: string[] = [];
const ids: { run?: string; editorial?: string; motion?: string; comment?: string; hash?: string } = {};

async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as Result;
  expect(r.isError, `${name}: ${r.content[0]?.text}`).toBeFalsy();
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

async function keep(sub: string, files: string[]): Promise<void> {
  if (!KEEP) return;
  const dir = join(KEEP, sub);
  await mkdir(dir, { recursive: true });
  for (const f of files) await cp(f, join(dir, f.split('/').pop()!));
}

describe.skipIf(!ENABLED)('fixture acceptance through MCP: capture → render → review → comment → theme switch → review → resolve → export (RETAKE_TEST_SLOW=1)', () => {
  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture> };
    fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
    root = await mkdtemp(join(tmpdir(), 'studio-mcp-acceptance-'));
    await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    const project = join(root, 'projects', 'northfield-fixture');
    await cp(FIXTURE_PROJECT, project, { recursive: true, filter: (src) => !GENERATED.has(src.slice(FIXTURE_PROJECT.length + 1).split('/')[0]) });
    // The copy's local environment on the fixture's free ports (display URLs unchanged).
    const yaml = await readFile(join(project, 'project.yaml'), 'utf8');
    await writeFile(
      join(project, 'project.yaml'),
      yaml.replaceAll('http://localhost:4401', fixture.urls.console.replace(/\/$/, '')).replaceAll('http://localhost:4402', fixture.urls.shop.replace(/\/$/, '')),
    );
    await symlink(join(REPO, 'fixtures'), join(root, 'fixtures'));
    await linkSharedCache(root);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--conditions=source', '--import', 'tsx', BIN, '--root', root, 'mcp'],
      cwd: REPO,
      env: { PATH: process.env.PATH ?? '', CFFIXED_USER_HOME: process.env.CFFIXED_USER_HOME ?? '', HOME: process.env.HOME ?? '', RETAKE_HOME: join(root, '.home'), RETAKE_WORKER_IDLE_MS: '5000' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    // A client whose user approves what the server asks (the quote's setup hooks write to the fixture).
    client = new Client({ name: 'retake-acceptance', version: '0' }, { capabilities: { elicitation: { form: {} } } });
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
    await fixture?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('captures quote on the fixture through run_capture', async () => {
    const r = await call('run_capture', { project: 'northfield-fixture', scenario: 'quote' });
    ids.run = data<{ id: string }>(r).id;
    const st = await follow('run_status', { project: 'northfield-fixture', run_id: ids.run }, (x) => data<{ finished: boolean }>(x).finished === true);
    expect(data<{ status: string }>(st).status, st.content[0].text).toBe('succeeded');
  }, STEP);

  it('renders it with the editorial theme (guarded: nothing blocked); the review is clean and returns the contact sheet as images', async () => {
    const r = await call('render', { project: 'northfield-fixture', scenario: 'quote', run_id: ids.run, template: 'editorial' });
    ids.editorial = data<{ render_id: string }>(r).render_id;
    const st = await follow('render_status', { project: 'northfield-fixture', render_id: ids.editorial }, (x) => data<{ finished: boolean }>(x).finished === true);
    const view = data<{ status: string; record: { template: string; width: number }; untrusted: { warnings: string[] } }>(st);
    expect(view.status, st.content[0].text).toBe('succeeded');
    expect(view.record).toMatchObject({ template: 'editorial', width: 1920 });
    expect(view.untrusted.warnings.filter((w) => w.startsWith('the render blocked'))).toEqual([]);
    const rv = await call('review', { project: 'northfield-fixture', render_id: ids.editorial, wait_s: 25 });
    const done = data<{ finished: boolean }>(rv).finished ? rv : await follow('review_get', { project: 'northfield-fixture', render_id: ids.editorial }, (x) => data<{ finished: boolean }>(x).finished === true);
    const v = data<{ clean: boolean; counts: Record<string, number>; files: { sheets: string[] } }>(done);
    expect(v.counts.error, done.content[0].text).toBe(0);
    expect(v.clean, done.content[0].text).toBe(true);
    expect(images(done).length).toBeGreaterThanOrEqual(1);
    await keep('editorial', v.files.sheets);
  }, STEP);

  it('a person asks for a laptop frame on the proposal (retake comment add --marker); comments_list returns the anchor and the still; comment_reply', async () => {
    const out = execFileSync(
      process.execPath,
      ['--conditions=source', '--import', 'tsx', BIN, '--root', root, 'comment', 'add', 'northfield-fixture', ids.editorial!, '--marker', 'proposal', '--region', '0.67,0.42,0.12,0.08', '--json', 'Try a laptop frame for the proposal'],
      { cwd: REPO, env: { PATH: process.env.PATH ?? '', CFFIXED_USER_HOME: process.env.CFFIXED_USER_HOME ?? '', HOME: process.env.HOME ?? '', RETAKE_HOME: join(root, '.home'), RETAKE_AUTHOR: 'Reviewer' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const added = JSON.parse(out) as { thread: { id: string }; warnings: string[] };
    expect(added.warnings).toEqual([]);
    ids.comment = added.thread.id;
    const r = await call('comments_list', { project: 'northfield-fixture', scenario: 'quote' });
    const t = data<{ threads: Array<Record<string, unknown> & { id: string; hash: string; still: string; frame: number; anchor: Record<string, unknown>; untrusted: { text: string; author: string } }> }>(r).threads[0];
    expect(t).toMatchObject({ id: ids.comment, render_id: ids.editorial, render_present: true, status: 'open', via: 'cli', marker: 'proposal', region: { x: 0.67, y: 0.42, w: 0.12, h: 0.08 } });
    expect(t.anchor).toMatchObject({ kind: 'clip', segment: 'proposal', scene: 'proposal', step: 3, step_ref: 'proposal.3', action: 'wait_for', marker: 'proposal', area: 'screen', overlays: ['studio/overlay-callout'] });
    expect(t.anchor.step_fp).toMatch(/^[0-9a-f]{12}$/);
    expect(t.untrusted).toMatchObject({ text: 'Try a laptop frame for the proposal', author: 'Reviewer' });
    expect(r.content[0].text).not.toContain('laptop frame');
    const img = images(r);
    expect(img).toHaveLength(1);
    expect(img[0].mimeType).toBe('image/jpeg');
    expect(r.content.find((b) => b.text?.startsWith('image 1/1: '))?.text).toContain(`comment ${ids.comment} at `);
    await keep('comment', [t.still]);
    const reply = await call('comment_reply', { project: 'northfield-fixture', comment_id: ids.comment, text: 'Re-rendering with the laptop layout and the motion theme; the scenario is unchanged.' });
    ids.hash = data<{ hash: string }>(reply).hash;
    expect(data<{ thread: { entries: Array<{ via: string }> } }>(reply).thread.entries.map((e) => e.via)).toEqual(['mcp']);
  }, STEP);

  it('switches the theme to motion and the layout to studio/layout-laptop without touching the scenario; reviews it with every image', async () => {
    const before = await readFile(join(root, 'projects', 'northfield-fixture', 'scenarios', 'quote.yaml'), 'utf8');
    const plan = await call('plan_preview', { project: 'northfield-fixture', scenario: 'quote', run_id: ids.run, template: 'motion', overrides: { components: { layout: 'studio/layout-laptop' } } });
    expect(plan.content[0].text).toContain('theme motion');
    // L3.8: the run's snapshot is the scenario file as it is — a layout or theme switch needs only a render.
    expect(plan.structuredContent).toMatchObject({ scenario_changed: false });
    expect(plan.content[0].text).not.toContain('changed since');
    const r = await call('render', { project: 'northfield-fixture', scenario: 'quote', run_id: ids.run, template: 'motion', overrides: { components: { layout: 'studio/layout-laptop' } } });
    ids.motion = data<{ render_id: string }>(r).render_id;
    expect(ids.motion).not.toBe(ids.editorial);
    const st = await follow('render_status', { project: 'northfield-fixture', render_id: ids.motion }, (x) => data<{ finished: boolean }>(x).finished === true);
    const view = data<{ status: string; record: { template: string }; untrusted: { warnings: string[] } }>(st);
    expect(view.status, st.content[0].text).toBe('succeeded');
    expect(view.record.template).toBe('motion');
    expect(view.untrusted.warnings.filter((w) => w.startsWith('the render blocked'))).toEqual([]);
    await call('review', { project: 'northfield-fixture', render_id: ids.motion, wait_s: 0 });
    const done = await follow('review_get', { project: 'northfield-fixture', render_id: ids.motion, images: 'all', detail: 'full' }, (x) => data<{ finished: boolean }>(x).finished === true);
    const v = data<{ counts: Record<string, number>; diff?: { previous: string }; files: { sheets: string[]; keyframes: Record<string, string> } }>(done);
    expect(v.counts.error, done.content[0].text).toBe(0);
    expect(v.diff?.previous).toBe(ids.editorial);
    expect(images(done)).toHaveLength(4);
    await keep('motion', [...v.files.sheets, ...Object.values(v.files.keyframes)]);
    expect(await readFile(join(root, 'projects', 'northfield-fixture', 'scenarios', 'quote.yaml'), 'utf8')).toBe(before);
  }, STEP);

  it('resolves the comment with the motion render (if_match); listed as resolved on the editorial render, nothing on the motion one', async () => {
    const r = await call('comment_resolve', { project: 'northfield-fixture', comment_id: ids.comment, note: 'Re-rendered with studio/layout-laptop and the motion theme.', render_id: ids.motion, if_match: ids.hash });
    expect(data<{ thread: { status: string; resolution: Record<string, unknown> } }>(r).thread).toMatchObject({ status: 'resolved', resolution: { via: 'mcp', render_id: ids.motion } });
    expect(data<{ threads: unknown[] }>(await call('comments_list', { project: 'northfield-fixture' })).threads).toEqual([]);
    const resolved = data<{ threads: Array<{ id: string; resolution: { render_id: string } }> }>(await call('comments_list', { project: 'northfield-fixture', render: ids.editorial, status: 'resolved' })).threads;
    expect(resolved.map((t) => [t.id, t.resolution.render_id])).toEqual([[ids.comment, ids.motion]]);
    expect(data<{ threads: unknown[] }>(await call('comments_list', { project: 'northfield-fixture', render: ids.motion, status: 'all' })).threads).toEqual([]);
  }, STEP);

  it('exports mp4_1080p, gif_preview and vertical_9x16 (re-rendered); job_status lists the files', async () => {
    const r = await call('export', { project: 'northfield-fixture', render_id: ids.motion, formats: ['mp4_1080p', 'gif_preview', 'vertical_9x16'] });
    expect(data<{ rerendered: string[] }>(r).rerendered).toEqual(['vertical_9x16']);
    const jobId = data<{ job: { id: string } }>(r).job.id;
    const js = await follow('job_status', { job_id: jobId }, (x) => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(data<{ state: string }>(x).state));
    const job = data<{ state: string; result: { outputs: Array<{ format: string; file: string; width: number; height: number; method: string }>; failed: string[]; untrusted: { warnings: string[] } } }>(js);
    expect(job.state, js.content[0].text).toBe('succeeded');
    expect(job.result.failed).toEqual([]);
    const by = Object.fromEntries(job.result.outputs.map((o) => [o.format, o]));
    expect(by.mp4_1080p).toMatchObject({ width: 1920, height: 1080 });
    expect(by.vertical_9x16).toMatchObject({ width: 1080, height: 1920, method: 'render' });
    expect(by.gif_preview.file).toMatch(/\.gif$/);
    for (const o of job.result.outputs) expect(existsSync(o.file), o.file).toBe(true);
    expect(job.result.untrusted.warnings.filter((w) => w.startsWith('the render blocked'))).toEqual([]);
    for (const o of job.result.outputs) expect(js.content[0].text).toContain(o.file);
    await keep('exports', job.result.outputs.map((o) => o.file));
    expect(stderr).not.toMatch(/unhandled/i);
  }, STEP);
});
