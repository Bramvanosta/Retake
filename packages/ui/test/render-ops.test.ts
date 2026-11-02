/**
 * L4.5 part E: the Studio's render ops over HTTP (ops.ts renderOps), on a synthetic take (no render is run: the worker
 * is off, a review package is prepared by hand):
 * - ⚑ `scenario_render` takes pinned arguments only (no theme, override, variant, sandbox or path: 400) and queues the
 *   capture shown with the review inline and no theme or override of its own; ⚑ a file changed since it was shown is a
 *   409 with nothing reserved or queued; ⚑ while a render of the scenario is queued or running another is a 409 naming
 *   it (also two clicks at once: one job);
 * - `scenario_renders` answers the queue and the renders with their review's verdict — path-free;
 * - ⚑ `render_cancel` cancels a render of this project only (another project's, or a run of this project: 403);
 * - ⚑ `render_review` holds no path (no `dir`, `files`, filmed environment), its contact sheets by name;
 * - ⚑ `review_image` reads a sheet by NAME without following a link (critique B16) — a link planted in the folder, a PNG
 *   named .jpg, a review folder linked out of the project are refused; a name with a path is a 400; a real sheet comes
 *   back as a JPEG within the cap;
 * - L4.5 fixes: the review's scene sheets and key frames are listed and served (review B); ⚑ a hard link and a key
 *   frames folder linked out are refused (review A N4); a failed render's message is its first line without paths
 *   (review B M6).
 * - ⚑ L5.12a `review_export` (the Review report's Export video): a strict input (a project and a render id — no format,
 *   no folder, no path: 400), an unknown render queues nothing, one export job of the render in MP4 1080p only (the
 *   engine's own, in the fixed exports/<render id>/), a path-free answer, a second one refused while it waits (L5.12a
 *   fixes: two at once on a render with no export yet — one job), at most two exports of the workspace at once, a Studio
 *   op only (never an MCP tool).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileJobQueue } from '@demo-studio/engine';
import type { JobRecord, ScenarioRendersView } from '@demo-studio/engine';
import { RENDER_OPS, UI_OPS, startStudioServer } from '../src/index.js';
import { TOOLS } from '@demo-studio/mcp';
import type { RenderReviewAnswer, ScenarioRenderAnswer, StudioServer } from '../src/index.js';
import { synthTimeline } from '../../editor/test/helpers.js';
import { hasTool } from '../../editor/test/render-helpers.js';
import { raw } from './http.js';
import { takeWorkspace, writeTake } from './timeline-take.js';

const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
const RUN = '20260101-120000-tl';
const TEXT = `video: Timeline
title: {text: Timeline}
intro: false
outro: false
scenes:
  - id: a
    page: app
    open: /
    caption: Every frame has its own number.
    steps:
      - hold: 1
`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let ws: string;
let dir: string;
let studio: StudioServer;
let queue: FileJobQueue;
const savedHome = process.env.DEMO_STUDIO_HOME;

const call = (op: string, args: unknown = {}) => raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
const renderArgs = (o: Record<string, unknown> = {}) => ({ project: 'demo', name: 'tl', run: RUN, expect_edit_sha256: sha(TEXT), ...o });
const renderJobs = async () => (await queue.list({ project: 'demo', kinds: ['render'], limit: 50 })).filter((j) => j.state === 'queued' || j.state === 'running');
const locks = async () => (await readdir(join(dir, 'renders')).catch(() => [] as string[])).filter((f) => f.endsWith('.lock'));
const jpeg = (file: string, colour = 'red') => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=640x360`, '-frames:v', '1', file]);

/** A succeeded render record of `tl` (as a render writes it), with its video file. */
async function writeRecord(id: string, created: string): Promise<void> {
  const r = join(dir, 'renders');
  await mkdir(r, { recursive: true });
  await writeFile(join(r, `${id}.mp4`), 'video');
  await writeFile(
    join(r, `${id}.json`),
    JSON.stringify({
      version: 1, id, project: 'demo', scenario: 'tl', run_id: RUN, run_dir: join(dir, 'runs', RUN), template: 'editorial', overrides: {},
      edit: { from: 'scenario', sha256: sha(TEXT) }, variant: 'landscape', status: 'succeeded', file: join(r, `${id}.mp4`), record: join(r, `${id}.json`),
      render_version: Number(/-v(\d+)/.exec(id)![1]), created_at: created, finished_at: created, duration_s: 3, frames: 90, fps: 30, width: 1920, height: 1080, size_bytes: 1234, plan: {}, warnings: [],
    }),
  );
}

beforeAll(async () => {
  if (!canRun) return;
  ws = await mkdtemp(join(tmpdir(), 'ds-render-ops-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  dir = await takeWorkspace(ws);
  const t = synthTimeline({
    duration: 3,
    entries: [{ id: 'a', t_start: 0.5, t_end: 2.5, caption: { text: 'Every frame has its own number.' }, steps: [{ action: 'hold', t_start: 0.5, t_end: 2.5 }] }],
    video: { title: { text: 'Timeline' }, intro: false, outro: false, template: 'editorial' },
  });
  await writeTake(dir, 'tl', { run: RUN, text: TEXT, timeline: t, codec: 'h264-x264', seconds: 3 });
  // A rendered and reviewed v7 (by hand): a report whose files name paths elsewhere, its filmed environment a path.
  await writeRecord('tl-v7', '2026-01-02T10:00:00.000Z');
  const rv = join(dir, 'review', 'tl-v7');
  await mkdir(rv, { recursive: true });
  jpeg(join(rv, 'sheet_1fps.jpg'));
  await symlink(join(rv, 'sheet_1fps.jpg'), join(rv, 'sheet_1fps_p2.jpg'));
  jpeg(join(rv, 'shot.png'), 'blue');
  await rename(join(rv, 'shot.png'), join(rv, 'sheet_1fps_p3.jpg'));
  await mkdir(join(ws, 'outside'), { recursive: true });
  jpeg(join(ws, 'outside', 'secret.jpg'), 'green');
  await symlink(join(ws, 'outside', 'secret.jpg'), join(rv, 'sheet_out.jpg'));
  // Review B: a scene sheet and a marker's key frame (PNG, in keyframes/) are shown too; a hard link to an outside
  // file is refused (review A N4).
  jpeg(join(rv, 'sheet_scene_a.jpg'), 'yellow');
  await mkdir(join(rv, 'keyframes'), { recursive: true });
  jpeg(join(rv, 'keyframes', 'first.png'), 'white');
  await link(join(ws, 'outside', 'secret.jpg'), join(rv, 'sheet_hard.jpg'));
  await writeFile(
    join(rv, 'report.json'),
    JSON.stringify({
      version: 1, clean: false, counts: { error: 0, warning: 1, info: 1 }, review: { created_at: '2026-01-02T10:01:00.000Z', fps: 1 },
      findings: [
        { severity: 'warning', code: 'caption-too-long', message: 'The caption "Every frame has its own number." is long', at: { frame: 12, segment: 'a' } },
        { severity: 'info', code: 'plan-warning', message: 'a note' },
      ],
      files: { sheets: ['/elsewhere/sheet_1fps.jpg', join(rv, 'sheet_1fps_p2.jpg')], scene_sheets: { a: [join(rv, 'sheet_scene_a.jpg')] }, keyframes: { first: '/elsewhere/keyframes/first.png' } },
      durations: { total_s: 3, segments: [{ id: 'a', kind: 'clip', from_s: 0, to_s: 3, duration_s: 3, component: 'studio/layout-raw' }] },
      environment: { base_url: `file://${ws}/outside` },
    }),
  );
  // v9: a review folder that is a link out of the project.
  await writeRecord('tl-v9', '2026-01-02T09:00:00.000Z');
  await mkdir(join(ws, 'outside', 'rev'), { recursive: true });
  jpeg(join(ws, 'outside', 'rev', 'sheet_1fps.jpg'));
  await symlink(join(ws, 'outside', 'rev'), join(dir, 'review', 'tl-v9'));
  // v6: a review folder whose keyframes/ is a link out of it.
  await mkdir(join(dir, 'review', 'tl-v6'), { recursive: true });
  await mkdir(join(ws, 'outside', 'kf'), { recursive: true });
  jpeg(join(ws, 'outside', 'kf', 'first.png'), 'green');
  await symlink(join(ws, 'outside', 'kf'), join(dir, 'review', 'tl-v6', 'keyframes'));
  studio = await startStudioServer({ root: ws, startWorker: false });
  queue = new FileJobQueue(ws);
}, 120_000);

afterAll(async () => {
  await studio?.close();
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe.skipIf(!canRun)('the Studio render ops (L4.5 part E)', () => {
  it('⚑ scenario_render: pinned arguments only; ⚑ a file changed since it was shown is a 409, nothing reserved or queued', async () => {
    expect(UI_OPS).toEqual(expect.arrayContaining([...RENDER_OPS]));
    expect(UI_OPS).not.toContain('render');
    expect(UI_OPS).not.toContain('job_cancel');
    for (const extra of [{ template: 'editorial' }, { theme: 'editorial' }, { overrides: { scale: 0.5 } }, { variant: 'vertical' }, { review: { fps: 2 } }, { run: '../x' }, { name: '../tl' }, { project: '/tmp' }, { expect_edit_sha256: 'abc' }]) {
      const r = await call('scenario_render', renderArgs(extra));
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    const { expect_edit_sha256: _h, ...noHash } = renderArgs();
    expect((await call('scenario_render', noHash)).status).toBe(400);
    expect(await renderJobs()).toEqual([]);

    // ⚑ The file changed since the screen showed it: 409, no lock, no job.
    const stale = await call('scenario_render', renderArgs({ expect_edit_sha256: sha(`${TEXT}# another version\n`) }));
    expect(stale.status, stale.body).toBe(409);
    expect(stale.json<{ error: { message: string; details?: Record<string, unknown> } }>().error).toMatchObject({ message: 'scenarios/tl changed since it was shown: look at the timeline again, then render', details: { current: sha(TEXT) } });
    expect(await renderJobs()).toEqual([]);
    expect(await locks()).toEqual([]);
  });

  it('⚑ queues the capture shown, reviewed inline, theme and options from the files; ⚑ another render of the scenario meanwhile is a 409', async () => {
    // Two clicks at once: one render, the other refused naming it.
    const [a, b] = await Promise.all([call('scenario_render', renderArgs()), call('scenario_render', renderArgs())]);
    const ok = [a, b].filter((r) => r.status === 200);
    const refused = [a, b].filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const d = ok[0].json<{ data: ScenarioRenderAnswer }>().data;
    expect(d).toMatchObject({ render_id: 'tl-v10', run_id: RUN, variant: 'landscape', edit: 'scenario', state: 'queued' });
    expect(refused[0].json<{ error: { message: string; details: Record<string, unknown> } }>().error).toMatchObject({ message: 'render tl-v10 of tl is queued: wait for it to end, or cancel it', details: { render_id: 'tl-v10', job: d.job } });
    const jobs = await renderJobs();
    expect(jobs.map((j) => j.id)).toEqual([d.job]);
    const input = jobs[0].input;
    expect(input).toMatchObject({ kind: 'render', project: 'demo', scenario: 'tl', run_id: RUN, edit_sha256: sha(TEXT), review: { fps: 1 }, overrides: {}, submitted_by: 'ui' });
    expect(input).not.toHaveProperty('template');
    // The text it was planned from goes with the job (B5).
    expect(await readFile(join(queue.jobDir(d.job), 'edit.yaml'), 'utf8')).toBe(TEXT);
    // Still refused while it waits (a third click later).
    const again = await call('scenario_render', renderArgs());
    expect(again.status).toBe(409);
    expect(await renderJobs()).toHaveLength(1);
  });

  it('scenario_renders: the queue and the renders with their review verdict, path-free', async () => {
    const r = await call('scenario_renders', { project: 'demo', name: 'tl' });
    expect(r.status).toBe(200);
    const v = r.json<{ data: ScenarioRendersView }>().data;
    expect(v.jobs).toMatchObject([{ render_id: 'tl-v10', state: 'queued', run_id: RUN, edit_sha256: sha(TEXT), reviewing: false, queue: { ahead: 0 }, cancel_requested: false, submitted_by: 'ui' }]);
    expect(v.renders.map((x) => x.render_id)).toEqual(['tl-v7', 'tl-v9']);
    expect(v.renders[0]).toMatchObject({ status: 'succeeded', theme: 'editorial', edit: { from: 'scenario', sha256: sha(TEXT) }, review: { state: 'warnings', counts: { error: 0, warning: 1, info: 1 } } });
    expect(v.renders[1].review).toEqual({ state: 'none' });
    for (const needle of [ws, homedir(), '.mp4', '"file"', 'run_dir']) expect(r.body.includes(needle), needle).toBe(false);
    expect((await call('scenario_renders', { project: 'demo', name: 'tl', run: RUN })).status).toBe(400);
  });

  it('⚑ render_cancel: a render of this project only', async () => {
    // Another project's render job, and a run of this project: refused, untouched.
    const other = await queue.enqueue({ version: 1, kind: 'render', project: 'other', scenario: 'tl', run_id: RUN, timeline_sha256: sha('t'), render_id: 'tl-v1', overrides: {}, submitted_by: 'test' });
    const runJob = await queue.enqueue({ version: 1, kind: 'run', project: 'demo', scenario: 'tl', scenario_sha256: sha(TEXT), mode: 'dry', run_id: '20260101-130000-tl', submitted_by: 'test' });
    for (const job of [other, runJob]) {
      const r = await call('render_cancel', { project: 'demo', job: job.id });
      expect(r.status, job.kind).toBe(403);
      expect((await queue.get(job.id))?.cancel_requested_at).toBeUndefined();
    }
    expect((await call('render_cancel', { project: 'demo', job: '../j' })).status).toBe(400);
    // This project's render: cancelled (a queued job is cancelled before it starts).
    const mine = (await renderJobs()).find((j) => j.input.kind === 'render' && j.input.project === 'demo') as JobRecord;
    const r = await call('render_cancel', { project: 'demo', job: mine.id });
    expect(r.status, r.body).toBe(200);
    expect(r.json<{ data: { kind: string; render_id: string } }>().data).toMatchObject({ kind: 'render', render_id: 'tl-v10' });
    expect((await queue.get(mine.id))?.cancel_requested_at).toBeDefined();
    for (const job of [other, runJob]) await queue.cancel(job.id, 'test');
  });

  it('⚑ render_review: no path, no filmed environment; the contact sheets by name, messages as untrusted text', async () => {
    const r = await call('render_review', { project: 'demo', render_id: 'tl-v7' });
    expect(r.status, r.body).toBe(200);
    const v = r.json<{ data: RenderReviewAnswer }>().data;
    expect(v).toMatchObject({ render_id: 'tl-v7', status: 'succeeded', fps: 1, counts: { error: 0, warning: 1, info: 1 } });
    expect(v.findings).toEqual([
      { severity: 'warning', code: 'caption-too-long', at: { frame: 12, segment: 'a' } },
      { severity: 'info', code: 'plan-warning' },
    ]);
    expect(v.untrusted.messages).toEqual(['The caption "Every frame has its own number." is long', 'a note']);
    // The images the folder really holds (report.json's paths are rebuilt), by name only: the sheets, the key frames
    // and the scene sheets (review B: not the 1 fps sheets only).
    expect(v.images).toEqual([
      { image: 'sheet_1fps.jpg', label: 'contact sheet (1 fps)' },
      { image: 'sheet_1fps_p2.jpg', label: 'contact sheet (1 fps), page 2' },
      { image: 'keyframes/first.png', label: 'key frame first' },
      { image: 'sheet_scene_a.jpg', label: 'scene sheet a' },
    ]);
    for (const k of ['dir', 'files']) expect(Object.prototype.hasOwnProperty.call(v, k), k).toBe(false);
    expect(v.untrusted).not.toHaveProperty('environment');
    for (const needle of [ws, homedir(), 'outside', 'report.json', '/elsewhere']) expect(r.body.includes(needle), needle).toBe(false);
    for (const bad of [{ project: 'demo', render_id: '../tl-v7' }, { project: 'demo', render_id: 'tl-v7', images: 'all' }]) expect((await call('render_review', bad)).status).toBe(400);
  });

  it('⚑ review_image: a sheet by name as a capped JPEG; a planted link, a PNG named .jpg, a folder linked out are refused', async () => {
    const r = await call('review_image', { project: 'demo', render_id: 'tl-v7', image: 'sheet_1fps.jpg' });
    expect(r.status, r.body).toBe(200);
    const d = r.json<{ data: { base64: string; width: number; height: number; mime: string } }>().data;
    expect(d).toMatchObject({ mime: 'image/jpeg', width: 640, height: 360 });
    expect(Buffer.from(d.base64, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(d.base64.length).toBeLessThanOrEqual(2_000_000);
    expect(r.body.includes(ws)).toBe(false);
    // ⚑ A link in the folder (to a sheet of the same folder, or out of it), a hard link to an outside file: never followed.
    for (const image of ['sheet_1fps_p2.jpg', 'sheet_out.jpg', 'sheet_hard.jpg']) {
      const l = await call('review_image', { project: 'demo', render_id: 'tl-v7', image });
      expect(l.status, image).toBe(403);
      expect(l.json<{ error: { message: string } }>().error.message).toBe(`${image} of the review of tl-v7 is a link (symbolic or hard): not followed`);
    }
    // A scene sheet and a key frame (a PNG, answered as a JPEG); a key frames folder linked out of the review folder: refused.
    expect((await call('review_image', { project: 'demo', render_id: 'tl-v7', image: 'sheet_scene_a.jpg' })).status).toBe(200);
    const kf = await call('review_image', { project: 'demo', render_id: 'tl-v7', image: 'keyframes/first.png' });
    expect(kf.status, kf.body).toBe(200);
    expect(Buffer.from(kf.json<{ data: { base64: string } }>().data.base64, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const kfOut = await call('review_image', { project: 'demo', render_id: 'tl-v6', image: 'keyframes/first.png' });
    expect(kfOut.status).toBe(403);
    expect(kfOut.body).toContain('lies outside its folder');
    // ⚑ A PNG under a .jpg name: not a JPEG.
    const png = await call('review_image', { project: 'demo', render_id: 'tl-v7', image: 'sheet_1fps_p3.jpg' });
    expect(png.status).toBe(403);
    expect(png.body).toContain('is not a JPEG');
    // ⚑ The review folder is a link out of the project.
    const out = await call('review_image', { project: 'demo', render_id: 'tl-v9', image: 'sheet_1fps.jpg' });
    expect(out.status).toBe(403);
    expect(out.body).toContain('lies outside the project');
    // A name with a path, another kind of file, an id with a path: 400 before any read; a missing sheet: 404.
    for (const image of ['../tl-v7.json', 'sheet_1fps.png', '/etc/hosts', 'keyframes/x.jpg', 'keyframes/../x.png', 'keyframes/a/b.png', '.sheet.jpg', 'report.json']) {
      expect((await call('review_image', { project: 'demo', render_id: 'tl-v7', image })).status, image).toBe(400);
    }
    expect((await call('review_image', { project: 'demo', render_id: '../x', image: 'sheet_1fps.jpg' })).status).toBe(400);
    expect((await call('review_image', { project: 'demo', render_id: 'tl-v7', image: 'sheet_9fps.jpg' })).status).toBe(404);
    expect(existsSync(join(dir, 'review', 'tl-v7', 'sheet_1fps.jpg'))).toBe(true);
  });

  it('⚑ L5.12a review_export: MP4 into the fixed folder, path-free; a strict input; an unknown render queues nothing; one at a time per render; not an MCP tool', async () => {
    expect(UI_OPS).toContain('review_export');
    expect(TOOLS.map((t) => t.name)).not.toContain('review_export');
    const exportJobs = async () => queue.list({ project: 'demo', kinds: ['export'], limit: 50 });
    // A strict input: no format, no folder, no path; a render id of a render id's shape only.
    for (const bad of [
      { project: 'demo', render_id: 'tl-v7', formats: ['webm'] },
      { project: 'demo', render_id: 'tl-v7', dir: '/tmp' },
      { project: 'demo', render_id: 'tl-v7', out: 'x' },
      { project: 'demo', render_id: '../tl-v7' },
      { project: 'demo', render_id: 'tl-v7; touch x' },
      { project: 'demo', render_id: 'tl v7' },
      { project: 'demo', render_id: RUN },
      { project: 'demo', render_id: 'latest' },
      { project: '../demo', render_id: 'tl-v7' },
      { project: 'demo' },
    ]) {
      const r = await call('review_export', bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    // A render the project does not have: refused, nothing queued.
    const unknown = await call('review_export', { project: 'demo', render_id: 'tl-v99' });
    expect(unknown.status, unknown.body).toBe(404);
    expect(await exportJobs()).toEqual([]);
    // L5.12a fixes (review B-M3): the race itself — two clicks at once on a render with no export yet: one 200, one 409,
    // exactly one job (the chain holds the check and the submit together).
    await writeRecord('tl-v12', '2026-01-02T11:00:00.000Z');
    const race = await Promise.all([call('review_export', { project: 'demo', render_id: 'tl-v12' }), call('review_export', { project: 'demo', render_id: 'tl-v12' })]);
    expect(race.map((x) => x.status).sort()).toEqual([200, 409]);
    const raced = await exportJobs();
    expect(raced.map((j) => (j.input as { render_id: string }).render_id)).toEqual(['tl-v12']);
    // One export of the render: the engine's job, MP4 1080p only, submitted by the Studio; the answer names no path.
    const r = await call('review_export', { project: 'demo', render_id: 'tl-v7' });
    expect(r.status, r.body).toBe(200);
    const d = r.json<{ data: { render_id: string; job: string; state: string; formats: string[]; where: string } }>().data;
    expect(d).toMatchObject({ render_id: 'tl-v7', state: 'queued', formats: ['mp4_1080p'], where: "the project's exports folder, under tl-v7" });
    for (const needle of [ws, homedir(), 'exports/', '.mp4']) expect(r.body.includes(needle), needle).toBe(false);
    const jobs = (await exportJobs()).filter((j) => (j.input as { render_id: string }).render_id === 'tl-v7');
    expect(jobs.map((j) => j.id)).toEqual([d.job]);
    expect(jobs[0].input).toEqual({ version: 1, kind: 'export', project: 'demo', render_id: 'tl-v7', formats: ['mp4_1080p'], submitted_by: 'ui' });
    // One at a time per render: a second (also two at once) is refused naming the job, nothing more queued.
    const [a, b] = await Promise.all([call('review_export', { project: 'demo', render_id: 'tl-v7' }), call('review_export', { project: 'demo', render_id: 'tl-v7' })]);
    for (const x of [a, b]) {
      expect(x.status).toBe(409);
      expect(x.json<{ error: { details: Record<string, unknown> } }>().error.details).toEqual({ job: d.job });
    }
    expect(await exportJobs()).toHaveLength(2);
    // ⚑ The workspace's cap (review A-L8): two exports queued, a third render's is refused — it queues once one ended.
    await writeRecord('tl-v13', '2026-01-02T11:30:00.000Z');
    const third = await call('review_export', { project: 'demo', render_id: 'tl-v13' });
    expect(third.status, third.body).toBe(409);
    expect(third.json<{ error: { message: string; details: Record<string, unknown> } }>().error).toMatchObject({ message: '2 exports are already queued or running: wait for one to end', details: { open: 2 } });
    expect(await exportJobs()).toHaveLength(2);
    await studio.engine.jobs.cancel(raced[0].id);
    const after = await call('review_export', { project: 'demo', render_id: 'tl-v13' });
    expect(after.status, after.body).toBe(200);
  });

  it('review B M6: a failed render shows its first line, every path cut to its file name — never a stack', async () => {
    const job = await queue.enqueue({ version: 1, kind: 'render', project: 'demo', scenario: 'tl', run_id: RUN, timeline_sha256: sha('t'), render_id: 'tl-v11', overrides: {}, submitted_by: 'test' });
    const rec = (await queue.get(job.id))!;
    const message = `Error: ffmpeg could not read ${join(dir, 'runs', RUN, 'capture.mp4')} (file://${ws}/x/y.json)\n    at encode (${join(ws, 'node_modules', 'editor', 'dist', 'render.js')}:12:3)\n    at C:\\Users\\someone\\x.js`;
    await queue.write({ ...rec, state: 'failed', finished_at: new Date(Date.now() + 1000).toISOString(), error: { code: 'internal', message } } as JobRecord);
    const r = await call('scenario_renders', { project: 'demo', name: 'tl' });
    const v = r.json<{ data: ScenarioRendersView }>().data;
    expect(v.last_failed).toMatchObject({ job: job.id, render_id: 'tl-v11', state: 'failed' });
    expect(v.untrusted.error).toBe('Error: ffmpeg could not read …/capture.mp4 (…/y.json)');
    for (const needle of [ws, homedir(), 'node_modules', '    at ', 'render.js']) expect(r.body.includes(needle), needle).toBe(false);
  });
});
