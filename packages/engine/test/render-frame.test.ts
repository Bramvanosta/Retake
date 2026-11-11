/**
 * L4.6 part A1, T6 / T7 (engine render-frames.ts; critique B7): a render's own frames for the Studio's comment viewer,
 * on a render encoded as a real one is (libx264 with B-frames, a 60-frame GOP without scene cuts, an AAC track) whose
 * every frame shows its own index in white blocks (the L4.5 bits take): the frame shown is the frame asked on both
 * sides of keyframes and at the last frame, and the still of a thread on it holds the same index (viewer = still =
 * thread). Refused: a record whose fps is not its video's, a video that is a link, a hard link, another file than
 * renders/<id>.mp4 or outside the project; a reused id (created_at) is a conflict, a frame past the video's own end an
 * argument error. The LRU serves a repeat without ffmpeg; the same session's newer request supersedes the older one,
 * decided at arrival (review A L2); past the queue bound requests — outlines too — are `busy` before any file is opened
 * (review A N4); a request ends within its timeout (`unavailable`, review B L3); a video that does not start at 0 or
 * has a variable frame rate is refused (review B L4). Needs ffmpeg and ffprobe.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedProject } from '@retake/core';
import type { RenderRecord } from '@retake/editor';
import { EngineError, RenderFrames, Semaphore, addComment, createEngine } from '../src/index.js';
import { hasTool, makeCase, scenesTimeline, workspace } from '../../review/test/helpers.js';
import type { Case, Workspace } from '../../review/test/helpers.js';
import { authorScope } from './helpers.js';
import { bitsVideo, readBits } from '../../ui/test/timeline-take.js';
import { PERSON_POLICY } from '@retake/core';

const can = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 240_000;
const GOP = 60;

let ws: Workspace;
let project: LoadedProject;
let v1: Case;
let savedRecord: Buffer;
const savedHome = process.env.RETAKE_HOME;

async function engineError(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  if (e instanceof EngineError) return e;
  throw new Error(`expected an EngineError, got ${e instanceof Error ? e.message : String(e)}`);
}

/** The render's video: the bits take re-encoded as Remotion encodes (B-frames, fixed GOP, an AAC track), `frames` long. */
function bitsRender(file: string, frames: number, width: number, height: number, fps: number): void {
  const src = `${file}.src.mp4`;
  bitsVideo(src, Math.ceil(frames / fps) + 1, 'h264-x264', `${width}x${height}`);
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-i', src,
    '-f', 'lavfi', '-t', (frames / fps).toFixed(4), '-i', 'anullsrc=r=48000:cl=stereo',
    '-map', '0:v:0', '-map', '1:a:0', '-frames:v', String(frames),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-bf', '2', '-g', String(GOP), '-keyint_min', String(GOP), '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', file,
  ]);
  spawnSync('rm', ['-f', src]);
}

const frameIndex = (base64: string) => readBits(Buffer.from(base64, 'base64'));
const recordFile = () => join(project.dir, 'renders', 'quote-v1.json');
async function withRecord<T>(edit: (r: RenderRecord) => RenderRecord, fn: () => Promise<T>): Promise<T> {
  const rec = JSON.parse(savedRecord.toString('utf8')) as RenderRecord;
  await writeFile(recordFile(), JSON.stringify(edit(rec)));
  try {
    return await fn();
  } finally {
    await writeFile(recordFile(), savedRecord);
  }
}
const frames = (o: Partial<ConstructorParameters<typeof RenderFrames>[0]> = {}) => new RenderFrames({ policy: PERSON_POLICY, slots: new Semaphore(2), ...o });
const ask = (rf: RenderFrames, frame: number, o: { session?: string; created_at?: string } = {}) =>
  rf.frame(project, { render_id: 'quote-v1', created_at: o.created_at ?? v1.record.created_at, frame }, o.session ? { session: o.session } : {});

beforeAll(async () => {
  if (!can) return;
  ws = await workspace();
  project = ws.project;
  process.env.RETAKE_HOME = join(ws.root, '.home');
  v1 = await makeCase(ws, 'quote', scenesTimeline([3, 3]), { noVideo: true });
  await writeFile(join(v1.run.dir, 'scenario.yaml'), 'scenes:\n  - id: s1\n    steps: [{click: Go}, {hold: 1}]\n  - id: s2\n    steps: [{click: Go}, {hold: 1}]\n');
  bitsRender(v1.record.file, v1.record.frames, v1.record.width, v1.record.height, v1.record.fps);
  savedRecord = await readFile(recordFile());
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,has_b_frames,nb_frames', '-of', 'json', v1.record.file]).toString();
  const streams = (JSON.parse(probe) as { streams: Array<{ codec_type: string; has_b_frames?: number; nb_frames?: string }> }).streams;
  // The render under test is shaped as a real one: B-frames, an audio track, the record's frame count.
  expect(streams.find((s) => s.codec_type === 'video')).toMatchObject({ has_b_frames: 2, nb_frames: String(v1.record.frames) });
  expect(streams.some((s) => s.codec_type === 'audio')).toBe(true);
}, LONG);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await ws?.cleanup();
});

describe.skipIf(!can)('render frames for the comment viewer (T6)', () => {
  it.skipIf(process.platform !== 'darwin')('L5.15: a VideoToolbox render (no B-frames, a key frame every 2 s) — the frame shown is the frame asked, both sides of keyframes', async () => {
    const file = v1.record.file;
    const saved = await readFile(file);
    const vt = `${file}.vt.mp4`;
    try {
      // As the GPU path encodes a render: h264_videotoolbox at its bitrate, gopSize = 2 × fps (editor policy.ts).
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'h264_videotoolbox', '-b:v', '8M', '-g', String(2 * v1.record.fps), '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', vt]);
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,has_b_frames,nb_frames', '-of', 'json', vt]).toString()) as { streams: Array<{ codec_type: string; has_b_frames?: number; nb_frames?: string }> };
      expect(probe.streams.find((x) => x.codec_type === 'video')).toMatchObject({ has_b_frames: 0, nb_frames: String(v1.record.frames) });
      await copyFile(vt, file);
      const rf = frames();
      const last = v1.record.frames - 1;
      for (const f of [0, 1, GOP - 1, GOP, GOP + 1, 2 * GOP - 1, 2 * GOP, last - 1, last]) expect(frameIndex((await ask(rf, f)).base64), `frame ${f}`).toBe(f);
    } finally {
      await writeFile(file, saved);
      await rm(vt, { force: true });
    }
  }, LONG);

  it('the frame shown is the frame asked — both sides of keyframes, the last — and a thread still on it shows the same (T7)', async () => {
    const rf = frames();
    const last = v1.record.frames - 1;
    expect(last).toBeGreaterThan(2 * GOP + 1);
    for (const f of [0, 1, 31, GOP - 1, GOP, GOP + 1, 2 * GOP - 1, 2 * GOP, last - 1, last]) {
      const v = await ask(rf, f);
      expect(frameIndex(v.base64), `frame ${f}`).toBe(f);
      expect(v).toMatchObject({ render_id: 'quote-v1', created_at: v1.record.created_at, frame: f, mime: 'image/jpeg', width: v1.record.width, height: v1.record.height });
    }
    // The thread's still (the store's exact frame-number select) shows the frame the viewer showed.
    for (const f of [GOP - 1, GOP + 1]) {
      const { thread, warnings } = await addComment(project, { render: 'quote-v1', render_created_at: v1.record.created_at, frame: f, text: 'This frame' }, { via: 'cli', name: 'Reviewer' }, authorScope(project, { via: 'cli', name: 'Reviewer' }), PERSON_POLICY);
      expect(warnings).toEqual([]);
      expect(thread.frame).toBe(f);
      expect(readBits(await readFile(thread.still!))).toBe(f);
    }
    const outline = await rf.outline(project, { render_id: 'quote-v1', created_at: v1.record.created_at });
    expect(outline).toMatchObject({ frames: v1.record.frames, fps: v1.record.fps, width: v1.record.width, height: v1.record.height, variant: 'landscape', scenario: 'quote' });
    expect(outline.pins.map((p) => p.frame)).toEqual([GOP - 1, GOP + 1]);
    expect(outline.pins.every((p) => p.status === 'open' && /^c_/.test(p.id))).toBe(true);
    expect(outline.markers.length).toBe(outline.untrusted.markers.length);
    // The same id made at another time is another render (core sameRender, L7.6c): the threads made on the render as it
    // was are none of its pins, and the page that read it then is told it was replaced.
    const later = '2026-12-01T10:00:00.000Z';
    await withRecord((r) => ({ ...r, created_at: later }), async () => {
      expect((await rf.outline(project, { render_id: 'quote-v1' })).pins).toEqual([]);
      await expect(rf.outline(project, { render_id: 'quote-v1', created_at: v1.record.created_at })).rejects.toMatchObject({ code: 'conflict', details: { current: later } });
    });
  }, LONG);

  it('a record whose fps is not its video\'s is refused (the frames would be other frames)', async () => {
    const e = await withRecord((r) => ({ ...r, fps: 25, plan: { ...r.plan, fps: 25 } }), () => engineError(ask(frames(), 31)));
    expect(e.code).toBe('refused');
    expect(e.message).toMatch(/says 25 fps but its video holds 30 fps/);
    expect((await withRecord((r) => ({ ...r, fps: 25, plan: { ...r.plan, fps: 25 } }), () => engineError(frames().outline(project, { render_id: 'quote-v1' })))).code).toBe('refused');
  }, LONG);

  it("frames are bounded by the video's own frame count, whatever the record says; a reused id is a conflict", async () => {
    const n = v1.record.frames;
    const e = await withRecord((r) => ({ ...r, frames: n + 50, plan: { ...r.plan, durationInFrames: n + 50 } }), () => engineError(ask(frames(), n + 10)));
    expect(e).toMatchObject({ code: 'invalid', details: { argument: 'frame' } });
    expect(e.message).toBe(`frame ${n + 10} is past the end of render quote-v1 (frames 0..${n - 1})`);
    expect((await withRecord((r) => ({ ...r, frames: n + 50, plan: { ...r.plan, durationInFrames: n + 50 } }), () => frames().outline(project, { render_id: 'quote-v1' }))).frames).toBe(n);
    expect((await engineError(ask(frames(), n))).details?.argument).toBe('frame');
    expect((await engineError(ask(frames(), -1))).details?.argument).toBe('frame');
    expect((await engineError(ask(frames(), 1.5))).details?.argument).toBe('frame');
    const replaced = await engineError(ask(frames(), 1, { created_at: '2020-01-01T00:00:00.000Z' }));
    expect(replaced).toMatchObject({ code: 'conflict', details: { current: v1.record.created_at } });
    expect((await engineError(frames().frame(project, { render_id: '../quote-v1', created_at: v1.record.created_at, frame: 1 }))).code).toBe('invalid');
  }, LONG);

  it('a video that is a link, a hard link, another file of the project or outside it is refused', async () => {
    const video = v1.record.file;
    const real = join(project.dir, 'renders', 'quote-v1.real.mp4');
    await copyFile(video, real);
    try {
      // A link at renders/<id>.mp4 (to a real video of the project).
      await rm(video);
      await symlink(real, video);
      expect((await engineError(ask(frames(), 1))).message).toBe('renders/quote-v1.mp4 is a symbolic link: not shown');
      // A hard link (the file has another name).
      await rm(video);
      await link(real, video);
      expect((await engineError(ask(frames(), 1))).message).toBe('renders/quote-v1.mp4 has another name (a hard link): not shown');
      await rm(real);
      // The record names another video of the project (the run's capture): never shown under this id.
      const other = join(v1.run.dir, 'capture.mp4');
      await copyFile(video, other);
      const e = await withRecord((r) => ({ ...r, file: other }), () => engineError(ask(frames(), 1)));
      expect(e).toMatchObject({ code: 'refused', message: 'renders/quote-v1.json names another file than renders/quote-v1.mp4: not shown' });
      // A video outside the project (renderForWork's containment).
      const outside = join(ws.root, 'outside.mp4');
      await copyFile(video, outside);
      expect((await withRecord((r) => ({ ...r, file: outside }), () => engineError(ask(frames(), 1)))).code).toBe('refused');
      // The renders/ folder is a link: refused.
      const renders = join(project.dir, 'renders');
      const moved = join(ws.root, 'renders-real');
      await mkdir(moved, { recursive: true });
      execFileSync('mv', [renders, join(moved, 'renders')]);
      await symlink(join(moved, 'renders'), renders);
      try {
        expect((await engineError(ask(frames(), 1))).code).toBe('refused');
      } finally {
        await rm(renders);
        execFileSync('mv', [join(moved, 'renders'), renders]);
      }
    } finally {
      await rm(real, { force: true });
    }
    expect(frameIndex((await ask(frames(), 7)).base64)).toBe(7);
  }, LONG);

  it('a repeat comes from memory; the same session\'s newer request drops the older one; past the queue bound: busy; a timeout ends a request', async () => {
    const rf = frames();
    await ask(rf, 40);
    const made = rf.stats.made;
    expect(frameIndex((await ask(rf, 40)).base64)).toBe(40);
    expect(rf.stats.made).toBe(made);

    // Newest wins: the slots are held so both requests wait; the second of one session supersedes the first.
    const slots = new Semaphore(1);
    const held = await slots.acquire();
    const nw = frames({ slots });
    const first = ask(nw, 50, { session: 'tab-1' }).then((v) => v, (x: unknown) => x);
    const other = ask(nw, 51, { session: 'tab-2' });
    await new Promise((r) => setTimeout(r, 300));
    const second = ask(nw, 52, { session: 'tab-1' });
    await new Promise((r) => setTimeout(r, 300));
    held();
    const e = await first;
    expect(e).toBeInstanceOf(EngineError);
    expect(e).toMatchObject({ code: 'cancelled', details: { reason: 'superseded' } });
    expect(frameIndex((await second).base64)).toBe(52);
    expect(frameIndex((await other).base64)).toBe(51);
    expect(nw.stats.superseded).toBe(1);

    // The queue bound: with the slots held, the fifth waiting request is refused at once.
    const slots2 = new Semaphore(1);
    const held2 = await slots2.acquire();
    const q = frames({ slots: slots2, queueMax: 4 });
    const asks = [60, 61, 62, 63, 64, 65].map((f) => ask(q, f).then((v) => v, (x: unknown) => x));
    await new Promise((r) => setTimeout(r, 500));
    held2();
    const results = await Promise.all(asks);
    const busy = results.filter((r) => r instanceof EngineError && r.code === 'busy');
    expect(busy.length).toBe(2);
    expect((busy[0] as EngineError).details?.reason).toBe('queue_full');
    expect(results.filter((r) => !(r instanceof EngineError)).length).toBe(4);

    // A request that cannot get a slot in time ends with its own code (review B L3: a timeout is not a full queue).
    const slots3 = new Semaphore(1);
    const held3 = await slots3.acquire();
    const t = frames({ slots: slots3, timeoutMs: 400 });
    const late = await engineError(ask(t, 70));
    held3();
    expect(late).toMatchObject({ code: 'unavailable', details: { reason: 'timeout' } });
  }, LONG);

  it('⚑ newest wins at arrival: an older request whose file opens later never drops the newer one (review A L2)', async () => {
    const rf = frames();
    // The first request's open() is slowed: before the fix, it superseded the newer request once its file was open.
    const self = rf as unknown as { open: (...a: unknown[]) => Promise<unknown> };
    const open = self.open.bind(rf);
    let calls = 0;
    self.open = async (...a: unknown[]) => {
      if (calls++ === 0) await new Promise((r) => setTimeout(r, 400));
      return open(...a);
    };
    const first = ask(rf, 33, { session: 'tab-9' }).then((v) => v, (x: unknown) => x);
    await new Promise((r) => setTimeout(r, 20));
    const second = ask(rf, 34, { session: 'tab-9' }).then((v) => v, (x: unknown) => x);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ code: 'cancelled', details: { reason: 'superseded' } });
    expect(b).not.toBeInstanceOf(Error);
    expect(frameIndex((b as { base64: string }).base64)).toBe(34);
    expect(rf.stats.superseded).toBe(1);
  }, LONG);

  it('⚑ the bound is checked before the file is opened, outlines included; a busy refusal drops nothing (review A L2 / N4)', async () => {
    const slots = new Semaphore(1);
    const held = await slots.acquire();
    const q = frames({ slots, queueMax: 2 });
    const self = q as unknown as { open: (...a: unknown[]) => Promise<unknown> };
    const open = self.open.bind(q);
    let opens = 0;
    self.open = (...a: unknown[]) => {
      opens++;
      return open(...a);
    };
    const a1 = ask(q, 80, { session: 'tab-1' }).then((v) => v, (x: unknown) => x);
    const b = ask(q, 81, { session: 'tab-2' }).then((v) => v, (x: unknown) => x);
    // Full: a third session and an outline are refused at once, before any file is opened.
    const before = opens;
    expect(await engineError(ask(q, 82, { session: 'tab-3' }))).toMatchObject({ code: 'busy', details: { reason: 'queue_full' } });
    expect(await engineError(q.outline(project, { render_id: 'quote-v1' }))).toMatchObject({ code: 'busy', details: { reason: 'queue_full' } });
    expect(opens).toBe(before);
    expect(q.stats.superseded).toBe(0);
    // The same session's newer request takes its predecessor's place (never refused for it).
    const a2 = ask(q, 83, { session: 'tab-1' }).then((v) => v, (x: unknown) => x);
    held();
    const [r1, rb, r2] = await Promise.all([a1, b, a2]);
    expect(r1).toMatchObject({ code: 'cancelled', details: { reason: 'superseded' } });
    expect(frameIndex((rb as { base64: string }).base64)).toBe(81);
    expect(frameIndex((r2 as { base64: string }).base64)).toBe(83);
    // Nothing left behind: the next outline goes through.
    expect((await q.outline(project, { render_id: 'quote-v1' })).frames).toBe(v1.record.frames);
  }, LONG);

  it('⚑ a video that does not start at 0, or whose frame rate varies, is refused (review B L4)', async () => {
    const video = v1.record.file;
    const saved = join(project.dir, 'renders', 'quote-v1.saved.mp4');
    await copyFile(video, saved);
    try {
      // The same frames, timestamps shifted by 0.4 s: the seek would give frame F − 1 where the still gives F.
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', saved, '-c', 'copy', '-output_ts_offset', '0.4', '-f', 'mp4', video]);
      const off = await engineError(ask(frames(), 31));
      expect(off.code).toBe('refused');
      expect(off.message).toBe('the video of render quote-v1 starts at 0.4 s, not 0: its frames cannot be told apart, not shown');
      expect((await engineError(frames().outline(project, { render_id: 'quote-v1' }))).code).toBe('refused');
      // Every 7th frame dropped (a variable frame rate at a nominal 30 fps).
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', saved, '-vf', "select='not(eq(mod(n\\,7)\\,6))'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '2', '-c:a', 'copy', '-f', 'mp4', video]);
      const vfr = await engineError(ask(frames(), 31));
      expect(vfr.code).toBe('refused');
      expect(vfr.message).toMatch(/^the video of render quote-v1 has a variable frame rate \([\d.]+ fps on average, 30 nominal\): its frames cannot be told apart, not shown$/);
    } finally {
      await copyFile(saved, video);
      await rm(saved, { force: true });
    }
    expect(frameIndex((await ask(frames(), 31)).base64)).toBe(31);
  }, LONG);

  it('through the engine (client ui): renders.frame and renders.outline', async () => {
    const ui = await createEngine({ root: ws.root, client: 'ui', autoStartWorker: false });
    const v = await ui.renders.frame('demo', { render_id: 'quote-v1', created_at: v1.record.created_at, frame: 12 }, { session: 'abc' });
    expect(frameIndex(v.base64)).toBe(12);
    expect(v.timecode).toBe('00:00.40');
    expect((await ui.renders.outline('demo', { render_id: 'quote-v1' })).frames).toBe(v1.record.frames);
    expect((await engineError(ui.renders.frame('demo', { render_id: 'quote-v1', created_at: v1.record.created_at, frame: 1 }, { session: 'not a session!' }))).code).toBe('invalid');
    expect(ui.info().features).toEqual(expect.arrayContaining(['renders.frame', 'renders.outline', 'comments.counts', 'comments.anchor', 'comments.studio']));
  }, LONG);
});
