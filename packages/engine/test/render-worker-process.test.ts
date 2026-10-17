/**
 * L3.2: a render job's worker killed with SIGKILL mid-render (the worker in a process of its own, from the sources).
 * Remotion starts its Chromium detached: the browser outlives the worker. The job reads `interrupted` (with the
 * `studio render` a human runs); the next worker kills the browser the job recorded (pid AND start time), removes its
 * temporary profile, the version lock and the partial video — no orphan headless shell is left. Synthetic capture, no
 * fixture product. The same for an export killed mid re-render (its browser and partial files), and a review killed
 * mid-way (the previous review, even one set aside by a swap, comes back). Needs ffmpeg and a headless shell.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProject } from '@demo-studio/core';
import { renderVideo } from '@demo-studio/editor';
import { FileJobQueue, createEngine, historyFile } from '../src/index.js';
import type { Engine, RecordedBrowser } from '../src/index.js';
import { synthTimeline } from '../../editor/test/helpers.js';
import { SHARED_CACHE, TEMPLATES, hasTool, makeColourCapture } from '../../editor/test/render-helpers.js';
import { REPO } from './helpers.js';

const canRender = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 400_000;

let root: string;
let engine: Engine;
let queue: FileJobQueue;
const children: ChildProcess[] = [];
const savedHome = process.env.DEMO_STUDIO_HOME;

function startWorker(...args: string[]): { child: ChildProcess; exited: Promise<number | null>; err(): string } {
  const child = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', join(REPO, 'packages/engine/src/worker-main.ts'), '--root', root, ...args], {
    cwd: REPO,
    env: { ...process.env, DEMO_STUDIO_HOME: join(root, '.home') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(child);
  let err = '';
  child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  return { child, exited: new Promise((r) => child.on('exit', (code, sig) => r(code ?? (sig ? -1 : null)))), err: () => err };
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 120_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** headless shells whose command line names this profile folder. */
function shellsOf(profile: string): string[] {
  const out = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout;
  return out.split('\n').filter((l) => l.includes(profile));
}

beforeAll(async () => {
  if (!canRender) return;
  root = await mkdtemp(join(tmpdir(), 'studio-render-kill-'));
  process.env.DEMO_STUDIO_HOME = join(root, '.home');
  await writeFile(join(root, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
  const runDir = join(root, 'projects', 'demo', 'runs', '20260101-120000-synthetic');
  await mkdir(runDir, { recursive: true });
  await writeFile(join(root, 'projects', 'demo', 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  // A longer capture: the render must still be running when the worker is killed.
  const t = synthTimeline({
    duration: 12,
    entries: [
      { id: 'a', t_start: 0.5, t_end: 6.0, caption: { text: 'A long first scene.' } },
      { id: 'b', t_start: 6.0, t_end: 12.0, open_end: 6.1 },
    ],
    video: { title: { text: 'Synthetic' }, intro: false, outro: false, frame: 'card', template: 'editorial' },
  });
  t.run_id = '20260101-120000-synthetic';
  t.project = 'demo';
  t.scenario = 'synthetic';
  await writeFile(join(runDir, 'timeline.json'), JSON.stringify(t));
  makeColourCapture(join(runDir, 'capture.mp4'), 12);
  await mkdir(join(root, '.demo-studio'), { recursive: true });
  await symlink(SHARED_CACHE, join(root, '.demo-studio', 'cache'));
  engine = await createEngine({ root, client: 'test', autoStartWorker: false });
  queue = new FileJobQueue(root);
}, LONG);

afterAll(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!canRender)('a render job whose worker is killed', () => {
  it('SIGKILL mid-render: interrupted; the next worker kills the orphan browser and removes its profile, the lock and the partial video', async () => {
    const sub = await engine.renders.submit({ project: 'demo', scenario: 'synthetic' });
    const renders = join(root, 'projects', 'demo', 'renders');
    const w = startWorker('--idle-exit', '5000');
    const browserFile = queue.browserFile(sub.job.id);
    await waitFor('the render running with its browser recorded', async () => {
      const j = await queue.get(sub.job.id);
      return j?.state === 'running' && (j.progress?.steps_done ?? 0) > 0 && existsSync(browserFile);
    });
    const browser = JSON.parse(await readFile(browserFile, 'utf8')) as RecordedBrowser;
    expect(browser.pid).toBeGreaterThan(1);
    expect(browser.started_at).toBeTruthy();
    expect(browser.user_data_dir).toMatch(/puppeteer_dev_chrome_profile-/);
    w.child.kill('SIGKILL');
    await w.exited;

    // The browser outlived its worker (Remotion starts it detached): what the next worker must clean up.
    expect(alive(browser.pid)).toBe(true);
    const job = await waitFor('interrupted', async () => {
      const j = await queue.get(sub.job.id);
      return j?.state === 'interrupted' ? j : undefined;
    }, 10_000);
    expect(job.error?.message).toContain(`nothing was written under ${sub.render_id}`);
    expect((await engine.jobs.get(sub.job.id)).error?.fix).toBe(`studio -C ${root} render demo synthetic --run 20260101-120000-synthetic`);
    expect(await engine.renders.status('demo', sub.render_id)).toMatchObject({ status: 'interrupted', finished: true });
    expect((await readdir(renders)).some((f) => f === `.synthetic-v1.lock`)).toBe(true);

    const next = startWorker('--idle-exit', '300');
    expect(await next.exited).toBe(0);
    expect(next.err()).toContain(`killed the render browser it left (pid ${browser.pid})`);
    await waitFor('the browser gone', async () => !alive(browser.pid), 10_000);
    expect(shellsOf(browser.user_data_dir!)).toEqual([]);
    expect(existsSync(browser.user_data_dir!)).toBe(false);
    expect(await readdir(renders)).toEqual([]);
    expect((await queue.stored(sub.job.id))?.state).toBe('interrupted');
    const last = JSON.parse((await readFile(historyFile(root), 'utf8')).trim().split('\n').at(-1)!) as Record<string, unknown>;
    expect(last).toMatchObject({ kind: 'render', state: 'interrupted', render: { id: sub.render_id }, counted: { renders: 0 } });
  }, LONG);
});

describe.skipIf(!canRender)('review and export jobs whose worker is killed', () => {
  let renderId: string;
  beforeAll(async () => {
    const project = await loadProject('demo', root);
    const r = await renderVideo({ project, root, run: '20260101-120000-synthetic', overrides: { scale: 0.5 }, concurrency: 2 });
    renderId = r.id;
  }, LONG);

  it('SIGKILL mid re-render of an export: interrupted; the next worker kills the browser, removes the partial files; nothing counted', async () => {
    const sub = await engine.exports.submit({ project: 'demo', render_id: renderId, formats: ['vertical_9x16'] });
    const w = startWorker('--idle-exit', '5000');
    const browserFile = queue.browserFile(sub.job.id);
    const dir = join(root, 'projects', 'demo', 'exports', renderId);
    await waitFor('the re-render rendering, its browser recorded', async () => {
      const j = await queue.get(sub.job.id);
      return j?.state === 'running' && (j.progress?.fraction ?? 0) > 0.1 && existsSync(browserFile);
    });
    const browser = JSON.parse(await readFile(browserFile, 'utf8')) as RecordedBrowser;
    w.child.kill('SIGKILL');
    await w.exited;
    expect(alive(browser.pid)).toBe(true);
    const job = await waitFor('interrupted', async () => {
      const j = await queue.get(sub.job.id);
      return j?.state === 'interrupted' ? j : undefined;
    }, 10_000);
    expect(job.error?.message).toContain(`The export stopped: formats written before stay in exports/${renderId}/`);
    expect((await engine.jobs.get(sub.job.id)).error?.fix).toBe(`studio -C ${root} export demo ${renderId} --formats vertical_9x16`);
    // Remotion writes the re-render's file at its end: a partial file as an earlier kill (or ffmpeg) leaves it.
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `.${renderId}-vertical.partial-0badc0de.mp4`), 'partial');

    const next = startWorker('--idle-exit', '300');
    expect(await next.exited).toBe(0);
    expect(next.err()).toContain(`killed the render browser it left (pid ${browser.pid})`);
    await waitFor('the browser gone', async () => !alive(browser.pid), 10_000);
    expect(shellsOf(browser.user_data_dir!)).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
    const last = JSON.parse((await readFile(historyFile(root), 'utf8')).trim().split('\n').at(-1)!) as Record<string, unknown>;
    expect(last).toMatchObject({ kind: 'export', state: 'interrupted', export: { render: renderId, formats: [] }, counted: { renders: 0 } });
  }, LONG);

  it('SIGKILL mid-review (even between the two renames of its swap): the next worker puts the previous review back', async () => {
    const first = await engine.reviews.submit({ project: 'demo', render_id: renderId, previous: false });
    const w0 = startWorker('--idle-exit', '300');
    expect(await w0.exited).toBe(0);
    expect((await engine.jobs.get(first.job.id)).state).toBe('succeeded');
    const reviews = join(root, 'projects', 'demo', 'review');
    const final = join(reviews, renderId);
    const before = await readFile(join(final, 'report.json'), 'utf8');

    const sub = await engine.reviews.submit({ project: 'demo', render_id: renderId, fps: 2, previous: false });
    const w = startWorker('--idle-exit', '5000');
    await waitFor('the review running', async () => (await queue.get(sub.job.id))?.state === 'running', 60_000);
    w.child.kill('SIGKILL');
    await w.exited;
    const job = await waitFor('interrupted', async () => {
      const j = await queue.get(sub.job.id);
      return j?.state === 'interrupted' ? j : undefined;
    }, 10_000);
    expect(job.error?.message).toContain(`the previous review of ${renderId} is kept`);
    // As if it died between the two renames of the swap: the previous review set aside, the new one unfinished.
    const dead = w.child.pid!;
    if (existsSync(final)) await rename(final, `${final}.old-${dead}-abcdef`);
    await mkdir(`${final}.tmp-${dead}-123456`, { recursive: true });

    const next = startWorker('--idle-exit', '300');
    expect(await next.exited).toBe(0);
    expect(await readFile(join(final, 'report.json'), 'utf8')).toBe(before);
    expect((await readdir(reviews)).sort()).toEqual([renderId]);
    expect(await engine.reviews.get('demo', renderId)).toMatchObject({ status: 'interrupted', clean: expect.any(Boolean) });
  }, LONG);
});
