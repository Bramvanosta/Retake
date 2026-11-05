/**
 * L4.2 part 2: thumbnails of a run's steps (engine runs.thumbs, run-thumbs.ts) on synthetic runs — exact colours.
 *
 * - Which picture (critique B3): a dry run's step screenshot, a failed step's error screenshot, a capture step's frame
 *   on screen at its end after its hold on the CFR grid — kept frames and the video give the same colour, the last
 *   step included (its hold ends at the end of the capture), a step end on a frame boundary and one mid-interval (a
 *   frame stamped between the grid tick and the step end is NOT shown: the video does not show it either).
 * - Multi-page scenes: the track of the page the step acted on; frames deleted → each track's video.
 * - Reads (critique B6): symlinked capture.mp4 / frames folder / screenshot / run folder refused (ffmpeg never started
 *   on a link), frame names and track files validated, a FIFO frame index does not hold the call, a decompression-bomb
 *   PNG refused.
 * - Cost (critique B7): one ffmpeg per batch, ≤ 1 per run, ≤ 2 at once, abort kills it; the memory cache serves a
 *   repeat and stays within its byte bound; the thumbnail path never imports the review package's root (Remotion).
 */
import { execFileSync } from 'node:child_process';
import { closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO, fixtureWorkspace } from './helpers.js';
import { EngineError, RUN_THUMBS_MAX_KEYS, RUN_THUMBS_RESPONSE_MAX, RunFolder, RunThumbs, SCREENSHOT_MAX, THUMB_BASE64_MAX, createEngine, frameAt, gridFrame, parseFrameIndex, seekTime } from '../src/index.js';
import type { Engine, RunThumbsView } from '../src/index.js';
import { BLOCKS_YAML, BLUE, CYAN, GREEN, MAGENTA, ORANGE, RED, YELLOW, capture, centre, colourName, near, noisePng, png, pngBits, writeRun } from './synthetic-runs.js';
import type { Rgb, SynthRun } from './synthetic-runs.js';

let ws: string;
let tools: string;
let projectDir: string;
let engine: Engine;
const P = 'northfield-fixture';
const savedHome = process.env.RETAKE_HOME;

const EXPECTED: Record<string, Rgb> = { 'one.0': RED, 'one.1': GREEN, 'one.2': GREEN, 'two.0': YELLOW, 'two.1': MAGENTA };
const KEYS = Object.keys(EXPECTED);

function colours(v: RunThumbsView): Record<string, string> {
  return Object.fromEntries(v.thumbs.map((t) => [t.key, colourName(centre(t.base64, t.width, t.height))]));
}

function expectColours(v: RunThumbsView, want: Record<string, Rgb>, from?: string): void {
  for (const t of v.thumbs) {
    const c = centre(t.base64, t.width, t.height);
    expect(near(c, want[t.key]), `${t.key}: got ${colourName(c)} ${c.join(',')}, want ${colourName(want[t.key])}`).toBe(true);
    if (from) expect(t.from, t.key).toBe(from);
  }
  expect(v.thumbs.map((t) => t.key).sort()).toEqual(Object.keys(want).sort());
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-run-thumbs-'));
  // The ffmpeg stand-ins live outside the workspace: the Studio's engine runs no program from inside it.
  tools = await mkdtemp(join(tmpdir(), 'studio-run-thumbs-tools-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  projectDir = join(ws, 'projects', P);
  await writeFile(join(projectDir, 'scenarios', 'blocks.yaml'), BLOCKS_YAML);
  engine = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
}, 60_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
  if (tools) await rm(tools, { recursive: true, force: true });
});

describe('the frame of a step (B3: floor on the CFR grid, clamped)', () => {
  it('gridFrame / frameAt / seekTime: floor, the last frame for an end past it, the earlier frame mid-interval', () => {
    expect(gridFrame(0.95, 10, 50)).toBe(9);
    expect(gridFrame(1.0, 10, 50)).toBe(10);
    expect(gridFrame(2.0 / 3, 30, 100)).toBe(20);
    expect(gridFrame(5.0, 10, 50)).toBe(49);
    expect(gridFrame(63.554, 30, Math.round(63.555 * 30))).toBe(1906);
    expect(gridFrame(-1, 10, 50)).toBe(0);
    const index = parseFrameIndex(['{"file":"000002.jpg","t":1.93}', '{"file":"000001.jpg","t":1.0}', '{"file":"../x.jpg","t":1.5}', 'not json', '{"file":"000003.jpg","t":"2"}'].join('\n'));
    expect(index).toEqual({ files: ['000001.jpg', '000002.jpg'], times: [1.0, 1.93] });
    expect(frameAt(index, 19, 10, 5)).toBe(0);
    expect(frameAt(index, 20, 10, 5)).toBe(1);
    expect(frameAt(index, 0, 10, 5)).toBe(0);
    expect(seekTime(10, 10)).toBeCloseTo(0.975);
    expect(seekTime(0, 10)).toBe(0);
  });
});

describe('thumbnails of a capture: kept frames and the video agree', () => {
  beforeAll(async () => {
    await writeRun(projectDir, capture('20261020-100000-blocks'));
    const nf = capture('20261020-100100-blocks');
    await writeRun(projectDir, nf);
    await rm(join(projectDir, 'runs', nf.id, 'frames'), { recursive: true });
    await rm(join(projectDir, 'runs', nf.id, 'frames.jsonl'));
  }, 60_000);

  it('from kept frames: each step its colour (mid-interval, boundary, after the hold, the last step)', async () => {
    const v = await engine.runs.thumbs(P, '20261020-100000-blocks', KEYS);
    expect(v.missing).toEqual([]);
    expectColours(v, EXPECTED, 'frame');
    for (const t of v.thumbs) {
      expect([t.mime, t.width, t.height]).toEqual(['image/jpeg', 64, 36]);
      expect(Buffer.from(t.base64, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    }
  });

  it('frames deleted: the same colours from the video, the last step included (one ffmpeg process)', async () => {
    const svc = new RunThumbs();
    const v = await svc.thumbs(projectDir, P, '20261020-100100-blocks', KEYS);
    expect(v.missing).toEqual([]);
    expectColours(v, EXPECTED, 'video');
    expect(svc.stats.ffmpeg).toBe(1);
    expect(colours(v)).toEqual(colours(await engine.runs.thumbs(P, '20261020-100000-blocks', KEYS)));
  });

  it('a repeat comes from memory; unknown keys and steps the run never reached say so', async () => {
    const svc = new RunThumbs();
    await svc.thumbs(projectDir, P, '20261020-100000-blocks', KEYS);
    const made = svc.stats.made;
    const again = await svc.thumbs(projectDir, P, '20261020-100000-blocks', [...KEYS, 'three.0', 'one.7']);
    expect(svc.stats.made).toBe(made);
    expect(again.thumbs.length).toBe(5);
    expect(again.missing).toEqual([
      { key: 'three.0', reason: 'not_reached' },
      { key: 'one.7', reason: 'not_reached' },
    ]);
  });

  it('the cache keeps within its byte bound', async () => {
    const svc = new RunThumbs({ cacheBytes: 1500 });
    await svc.thumbs(projectDir, P, '20261020-100000-blocks', KEYS);
    expect(svc.cacheSize.bytes).toBeLessThanOrEqual(1500);
    expect(svc.cacheSize.entries).toBeLessThan(5);
  });

  it('refuses a bad batch before reading anything', async () => {
    for (const keys of [[], Array.from({ length: RUN_THUMBS_MAX_KEYS + 1 }, (_x, i) => `one.${i}`), ['../one.0'], ['one'], ['one.0/x']]) {
      const e = await engine.runs.thumbs(P, '20261020-100000-blocks', keys).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(EngineError);
      expect((e as EngineError).code).toBe('invalid');
    }
    const e = await engine.runs.thumbs(P, '20261099-000000-nope', ['one.0']).catch((x: unknown) => x);
    expect((e as EngineError).code).toBe('not_found');
  });
});

describe('dry runs, failed steps, multi-page tracks', () => {
  it('dry run: step screenshots, the failed step its error screenshot, later steps not reached', async () => {
    await writeRun(projectDir, {
      id: '20261020-110000-blocks',
      scenario: 'blocks',
      mode: 'dry',
      status: 'failed',
      snapshot: BLOCKS_YAML,
      scenes: [{ id: 'one' }, { id: 'two', status: 'failed' }],
      events: [
        { scene: 'one', step: 0, action: 'click', t_start: 0, t_end: 0.5 },
        { scene: 'one', step: 1, action: 'click', t_start: 0.5, t_end: 1 },
        { scene: 'one', step: 2, action: 'hold', t_start: 1, t_end: 2 },
        { scene: 'two', step: 0, action: 'click', t_start: 2, t_end: 3, status: 'failed', error: 'no element' },
        // A step recorded as skipped (as after an irreversible step) has no picture of its own, whatever lies in the folder.
        { scene: 'two', step: 1, action: 'click', t_start: 3, t_end: 3, status: 'skipped' },
      ],
      screenshots: { 'one-00-click.png': RED, 'one-01-click.png': GREEN, 'one-02-hold.png': BLUE, 'error-two-0.png': YELLOW, 'two-00-click.png': ORANGE, 'two-01-click.png': ORANGE },
      error: { scene: 'two', step: 0, message: 'no element "Third"' },
    });
    const v = await engine.runs.thumbs(P, '20261020-110000-blocks', KEYS);
    expectColours(v, { 'one.0': RED, 'one.1': GREEN, 'one.2': BLUE, 'two.0': YELLOW });
    expect(v.thumbs.map((t) => t.from)).toEqual(['screenshot', 'screenshot', 'screenshot', 'error_screenshot']);
    expect(v.missing).toEqual([{ key: 'two.1', reason: 'not_reached' }]);
  });

  it('a capture that failed: the error screenshot first, else the frame at the failure', async () => {
    const run = capture('20261020-120000-blocks', { status: 'failed', screenshots: { 'error-two-0.png': ORANGE } });
    run.events![3] = { ...run.events![3], status: 'failed', error: 'timeout' };
    await writeRun(projectDir, run);
    const v = await engine.runs.thumbs(P, run.id, ['two.0', 'one.1']);
    expectColours(v, { 'two.0': ORANGE, 'one.1': GREEN });
    expect(v.thumbs.map((t) => t.from)).toEqual(['error_screenshot', 'frame']);
    await unlink(join(projectDir, 'runs', run.id, 'screenshots', 'error-two-0.png'));
    const w = await new RunThumbs().thumbs(projectDir, P, run.id, ['two.0']);
    expectColours(w, { 'two.0': YELLOW }, 'frame');
  });

  it('a multi-page scene: the track of the page each step acted on — kept frames, then each track’s video', async () => {
    const run: SynthRun = {
      id: '20261020-130000-multi',
      scenario: 'multi',
      mode: 'capture',
      scenes: [{ id: 'both', t_start: 0, t_end: 3, pages: [{ id: 'desk', track: 'desk' }, { id: 'phone', track: 'phone' }] }],
      events: [
        { scene: 'both', step: 0, action: 'click', t_start: 0.2, t_end: 1.2, page: 'phone' },
        { scene: 'both', step: 1, action: 'click', t_start: 1.2, t_end: 2.2, page: 'desk' },
        { scene: 'both', step: 2, action: 'click', t_start: 2.2, t_end: 2.6, hold: [2.6, 3.0], page: 'phone' },
        { scene: 'both', step: 3, action: 'click', t_start: 2.6, t_end: 2.7 }, // no page recorded: the scene's first page
      ],
      duration: 3,
      tracks: [
        { id: 'desk', frames: [[0, ORANGE]] },
        { id: 'phone', frames: [[0, CYAN], [2.5, MAGENTA]] },
      ],
      video: true,
    };
    await writeRun(projectDir, run);
    const want = { 'both.0': CYAN, 'both.1': ORANGE, 'both.2': MAGENTA, 'both.3': ORANGE };
    expectColours(await engine.runs.thumbs(P, run.id, Object.keys(want)), want, 'frame');
    for (const t of ['desk', 'phone']) {
      await rm(join(projectDir, 'runs', run.id, `frames-${t}`), { recursive: true });
      await rm(join(projectDir, 'runs', run.id, `frames-${t}.jsonl`));
    }
    const svc = new RunThumbs();
    expectColours(await svc.thumbs(projectDir, P, run.id, Object.keys(want)), want, 'video');
    expect(svc.stats.ffmpeg).toBe(2);
  });

  it('a track file that changes is read again (review A #8: the tracks are part of the run’s signature)', async () => {
    const run: SynthRun = {
      id: '20261020-130100-multi',
      scenario: 'multi',
      mode: 'capture',
      scenes: [{ id: 'both', t_start: 0, t_end: 3, pages: [{ id: 'desk', track: 'desk' }, { id: 'phone', track: 'phone' }] }],
      events: [{ scene: 'both', step: 0, action: 'click', t_start: 0.2, t_end: 1.2, page: 'phone' }],
      duration: 3,
      tracks: [
        { id: 'desk', frames: [[0, ORANGE]] },
        { id: 'phone', frames: [[0, CYAN]] },
      ],
    };
    const dir = await writeRun(projectDir, run);
    const svc = new RunThumbs();
    expectColours(await svc.thumbs(projectDir, P, run.id, ['both.0']), { 'both.0': CYAN }, 'frame');
    // The phone's frames re-written (another picture, a new index): the next call shows it.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(dir, 'frames-phone', '000002.png'), png(64, 36, GREEN));
    await writeFile(join(dir, 'frames-phone.jsonl'), `${JSON.stringify({ file: '000002.png', t: 0 })}\n`);
    expectColours(await svc.thumbs(projectDir, P, run.id, ['both.0']), { 'both.0': GREEN }, 'frame');
  });
});

describe('reads (B6): links, names, FIFOs, bombs', () => {
  const outside = () => join(ws, 'outside');

  beforeAll(async () => {
    await mkdir(outside(), { recursive: true });
    // A video and frames outside the project, of a colour no step has.
    await writeRun(join(outside(), 'p'), capture('20261020-140000-blocks', { frames: [[0, ORANGE]] }));
  }, 60_000);

  it('a capture.mp4 that is a link (frames gone): no picture, ffmpeg never started on it', async () => {
    const run = capture('20261020-150000-blocks', { video: false });
    const dir = await writeRun(projectDir, run);
    await rm(join(dir, 'frames'), { recursive: true });
    await rm(join(dir, 'frames.jsonl'));
    await symlink(join(outside(), 'p', 'runs', '20261020-140000-blocks', 'capture.mp4'), join(dir, 'capture.mp4'));
    const svc = new RunThumbs();
    const v = await svc.thumbs(projectDir, P, run.id, KEYS);
    expect(v.thumbs).toEqual([]);
    expect(v.missing.map((m) => m.reason)).toEqual(KEYS.map(() => 'unreadable'));
    expect(svc.stats.ffmpeg).toBe(0);
  });

  it('a frames folder that is a link, frame names that are paths, a screenshot that is a link: refused', async () => {
    const run = capture('20261020-160000-blocks', { video: false });
    const dir = await writeRun(projectDir, run);
    await rm(join(dir, 'frames'), { recursive: true });
    await symlink(join(outside(), 'p', 'runs', '20261020-140000-blocks', 'frames'), join(dir, 'frames'));
    let v = await new RunThumbs().thumbs(projectDir, P, run.id, ['one.0']);
    expect([v.thumbs, v.missing]).toEqual([[], [{ key: 'one.0', reason: 'unreadable' }]]);
    // Frame names that are paths are left out of the index: nothing to read.
    await unlink(join(dir, 'frames'));
    await mkdir(join(dir, 'frames'));
    await writeFile(join(dir, 'frames.jsonl'), `${JSON.stringify({ file: '../../../../outside/p/runs/20261020-140000-blocks/frames/000001.png', t: 0 })}\n`);
    v = await new RunThumbs().thumbs(projectDir, P, run.id, ['one.0']);
    expect(v.thumbs).toEqual([]);
    // A dry screenshot that is a link.
    const dry = await writeRun(projectDir, { id: '20261020-170000-blocks', scenario: 'blocks', mode: 'dry', snapshot: BLOCKS_YAML, scenes: [{ id: 'one' }], events: [{ scene: 'one', step: 0, action: 'click', t_start: 0, t_end: 1 }] });
    await writeFile(join(outside(), 'secret.png'), png(8, 8, ORANGE));
    await symlink(join(outside(), 'secret.png'), join(dry, 'screenshots', 'one-00-click.png'));
    v = await new RunThumbs().thumbs(projectDir, P, '20261020-170000-blocks', ['one.0']);
    expect([v.thumbs, v.missing]).toEqual([[], [{ key: 'one.0', reason: 'unreadable' }]]);
  });

  it('track files that are not track names: no picture, nothing read', async () => {
    const run: SynthRun = {
      id: '20261020-180000-multi',
      scenario: 'multi',
      mode: 'capture',
      scenes: [{ id: 'both', t_start: 0, t_end: 3, pages: [{ id: 'desk', track: 'desk' }] }],
      events: [{ scene: 'both', step: 0, action: 'click', t_start: 0, t_end: 1, page: 'desk' }],
      duration: 3,
      tracks: [{ id: 'desk', frames: [[0, ORANGE]] }],
    };
    const dir = await writeRun(projectDir, run);
    const tl = JSON.parse(await readFile(join(dir, 'timeline.json'), 'utf8'));
    tl.tracks[0].frames_file = '../../../../outside/p/runs/20261020-140000-blocks/frames.jsonl';
    await writeFile(join(dir, 'timeline.json'), JSON.stringify(tl));
    const v = await new RunThumbs().thumbs(projectDir, P, run.id, ['both.0']);
    expect([v.thumbs, v.missing]).toEqual([[], [{ key: 'both.0', reason: 'no_picture' }]]);
  });

  it('a run folder that is a link: not found', async () => {
    await symlink(join(outside(), 'p', 'runs', '20261020-140000-blocks'), join(projectDir, 'runs', '20261020-190000-blocks'));
    const e = await engine.runs.thumbs(P, '20261020-190000-blocks', ['one.0']).catch((x: unknown) => x);
    expect((e as EngineError).code).toBe('not_found');
  });

  it('a FIFO as frames.jsonl does not hold the call (the video answers)', async () => {
    const run = capture('20261020-200000-blocks');
    const dir = await writeRun(projectDir, run);
    await unlink(join(dir, 'frames.jsonl'));
    execFileSync('mkfifo', [join(dir, 'frames.jsonl')]);
    const t0 = Date.now();
    const v = await new RunThumbs().thumbs(projectDir, P, run.id, ['two.1']);
    expect(Date.now() - t0).toBeLessThan(5000);
    expectColours(v, { 'two.1': MAGENTA }, 'video');
  }, 15_000);

  it('links that stay inside the run are refused too: capture.mp4 → another video of the run, frames/ → another folder of the run, the run folder → another run', async () => {
    const run = capture('20261020-230000-blocks');
    const dir = await writeRun(projectDir, run);
    await rm(join(dir, 'frames.jsonl'));
    await rename(join(dir, 'capture.mp4'), join(dir, 'kept.mp4'));
    await symlink('kept.mp4', join(dir, 'capture.mp4'));
    const svc = new RunThumbs();
    let v = await svc.thumbs(projectDir, P, run.id, ['one.0']);
    expect([v.thumbs, v.missing, svc.stats.ffmpeg]).toEqual([[], [{ key: 'one.0', reason: 'unreadable' }], 0]);
    // frames/ → screenshots/ (holding a "frame" of another colour).
    const other = capture('20261020-230100-blocks', { video: false, screenshots: { '000001.png': ORANGE } });
    const odir = await writeRun(projectDir, other);
    await rm(join(odir, 'frames'), { recursive: true });
    await symlink('screenshots', join(odir, 'frames'));
    v = await new RunThumbs().thumbs(projectDir, P, other.id, ['one.0']);
    expect([v.thumbs, v.missing]).toEqual([[], [{ key: 'one.0', reason: 'unreadable' }]]);
    // runs/<id> → runs/<another id> of the same project.
    await symlink(run.id, join(projectDir, 'runs', '20261020-230200-blocks'));
    const e = await engine.runs.thumbs(P, '20261020-230200-blocks', ['one.0']).catch((x: unknown) => x);
    expect((e as EngineError).code).toBe('not_found');
  });

  it('a run folder swapped for a link once opened: every read and the video refused (review A #7: checked once open)', async () => {
    const run = capture('20261020-230500-blocks');
    const dir = await writeRun(projectDir, run);
    const folder = await RunFolder.open(projectDir, run.id);
    expect(folder).not.toBeNull();
    expect((await folder!.read('run.json', 1 << 20)).ok).toBe(true);
    const ok = folder!.openVideo('capture.mp4', 2);
    expect(ok.ok).toBe(true);
    if (ok.ok) for (const fd of ok.fds) closeSync(fd);
    // The folder the reader resolved becomes a link to a run outside the project.
    await rename(dir, `${dir}-moved`);
    await symlink(join(outside(), 'p', 'runs', '20261020-140000-blocks'), dir);
    expect(await folder!.read('run.json', 1 << 20)).toMatchObject({ ok: false, reason: 'link' });
    expect(await folder!.read('frames/000001.png', 1 << 20)).toMatchObject({ ok: false });
    expect(folder!.openVideo('capture.mp4', 2)).toMatchObject({ ok: false, reason: 'link' });
    await unlink(dir);
    await rename(`${dir}-moved`, dir);
  });

  it('the video goes to ffmpeg as descriptors (fd protocol only): its arguments name no path', async () => {
    const run = capture('20261020-230600-blocks');
    const dir = await writeRun(projectDir, run);
    await rm(join(dir, 'frames'), { recursive: true });
    await rm(join(dir, 'frames.jsonl'));
    const real = execFileSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).trim();
    const wrapper = join(tools, 'ffmpeg-args.sh');
    await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$@" > "${ws}/ffmpeg-args"\nexec "${real}" "$@"\n`);
    await chmod(wrapper, 0o755);
    const v = await new RunThumbs({ ffmpeg: wrapper }).thumbs(projectDir, P, run.id, KEYS);
    expectColours(v, EXPECTED, 'video');
    const args = (await readFile(join(ws, 'ffmpeg-args'), 'utf8')).split('\n');
    expect(args.filter((a) => a === 'fd:')).toHaveLength(KEYS.length);
    // Each input: the fd protocol only, its own descriptor.
    const lists = args.flatMap((a, i) => (a === '-protocol_whitelist' ? [args[i + 1]] : []));
    expect(lists).toEqual(KEYS.map(() => 'fd'));
    expect(args.flatMap((a, i) => (a === '-fd' ? [args[i + 1]] : []))).toEqual(KEYS.map((_k, i) => String(3 + i)));
    expect(args.some((a) => a.includes('capture.mp4') || a.includes(ws))).toBe(false);
    expect(args.some((a) => a === 'file')).toBe(false);
  });

  it('sources are read inside the sharp slots: at most 2 held at once (review A #2), a screenshot over 16 MiB never read', async () => {
    const events: SynthRun['events'] = [];
    for (let i = 0; i < RUN_THUMBS_MAX_KEYS; i++) events.push({ scene: 'one', step: i, action: 'click', t_start: i, t_end: i + 1 });
    const dir = await writeRun(projectDir, { id: '20261020-240100-big', scenario: 'big', mode: 'dry', scenes: [{ id: 'one' }], events });
    // One 12 MiB "PNG" (its signature, then noise: sharp refuses it once read) hard-linked under 24 step names.
    const size = 12 * 1024 * 1024;
    const big = join(dir, 'big.bin');
    await writeFile(big, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(size - 8)]));
    for (let i = 0; i < RUN_THUMBS_MAX_KEYS; i++) await link(big, join(dir, 'screenshots', `one-${String(i).padStart(2, '0')}-click.png`));
    const svc = new RunThumbs();
    const v = await svc.thumbs(projectDir, P, '20261020-240100-big', events.map((e) => `one.${e.step}`));
    expect(v.missing.map((m) => m.reason)).toEqual(events.map(() => 'unreadable'));
    expect(svc.stats.sourceBytesPeak).toBeGreaterThanOrEqual(size);
    expect(svc.stats.sourceBytesPeak).toBeLessThanOrEqual(2 * size);
    expect(svc.stats.sourceBytes).toBe(0);
    // Over SCREENSHOT_MAX (16 MiB): refused from its size, nothing read.
    expect(SCREENSHOT_MAX).toBe(16 * 1024 * 1024);
    const huge = join(dir, 'screenshots', 'one-00-click.png');
    await unlink(huge);
    await writeFile(huge, '');
    await truncate(huge, SCREENSHOT_MAX + 1);
    const svc2 = new RunThumbs();
    const v2 = await svc2.thumbs(projectDir, P, '20261020-240100-big', ['one.0']);
    expect(v2.missing).toEqual([{ key: 'one.0', reason: 'too_large' }]);
    expect(svc2.stats.sourceBytesPeak).toBe(0);
    await rm(dir, { recursive: true });
  }, 30_000);

  it('names that are files of the run but not frames or tracks: never read', async () => {
    // A frame index naming a file of frames/ that is not a frame (NNNNNN.jpg / .png).
    const run = capture('20261020-230300-blocks', { video: false });
    const dir = await writeRun(projectDir, run);
    await writeFile(join(dir, 'frames', 'secret.png'), png(64, 36, ORANGE));
    await writeFile(join(dir, 'frames.jsonl'), `${JSON.stringify({ file: 'secret.png', t: 0 })}\n`);
    let v = await new RunThumbs().thumbs(projectDir, P, run.id, ['one.0']);
    expect([v.thumbs, v.missing]).toEqual([[], [{ key: 'one.0', reason: 'no_picture' }]]);
    // A track whose files are the main capture's (valid file names, not track names).
    const multi: SynthRun = {
      id: '20261020-230400-multi',
      scenario: 'multi',
      mode: 'capture',
      scenes: [{ id: 'both', t_start: 0, t_end: 3, pages: [{ id: 'desk', track: 'desk' }] }],
      events: [{ scene: 'both', step: 0, action: 'click', t_start: 0, t_end: 1, page: 'desk' }],
      duration: 3,
      frames: [[0, ORANGE]],
      tracks: [{ id: 'desk', frames: [[0, CYAN]] }],
    };
    const mdir = await writeRun(projectDir, multi);
    const tl = JSON.parse(await readFile(join(mdir, 'timeline.json'), 'utf8'));
    tl.tracks[0].frames_file = 'frames.jsonl';
    tl.tracks[0].file = 'capture.mp4';
    await writeFile(join(mdir, 'timeline.json'), JSON.stringify(tl));
    v = await new RunThumbs().thumbs(projectDir, P, multi.id, ['both.0']);
    expect([v.thumbs, v.missing]).toEqual([[], [{ key: 'both.0', reason: 'no_picture' }]]);
  });

  it('a decompression bomb (a valid PNG of 108 million pixels) is refused before it is decoded', async () => {
    const dry = await writeRun(projectDir, { id: '20261020-210000-blocks', scenario: 'blocks', mode: 'dry', snapshot: BLOCKS_YAML, scenes: [{ id: 'one' }], events: [{ scene: 'one', step: 0, action: 'click', t_start: 0, t_end: 1 }] });
    await writeFile(join(dry, 'screenshots', 'one-00-click.png'), pngBits(12_000, 9_000));
    const t0 = Date.now();
    const v = await engine.runs.thumbs(P, '20261020-210000-blocks', ['one.0']);
    expect([v.thumbs, v.missing]).toEqual([[], [{ key: 'one.0', reason: 'unreadable' }]]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('an answer stays within its size caps: each thumbnail ≤ THUMB_BASE64_MAX, all ≤ RUN_THUMBS_RESPONSE_MAX, the rest "budget"', async () => {
    const shots: Record<string, Buffer> = {};
    const events: SynthRun['events'] = [];
    for (let i = 0; i < RUN_THUMBS_MAX_KEYS; i++) {
      shots[`one-${String(i).padStart(2, '0')}-click.png`] = noisePng(960, 960, i + 1);
      events.push({ scene: 'one', step: i, action: 'click', t_start: i, t_end: i + 1 });
    }
    const dir = await writeRun(projectDir, { id: '20261020-240000-noise', scenario: 'noise', mode: 'dry', scenes: [{ id: 'one' }], events });
    for (const [name, bytes] of Object.entries(shots)) await writeFile(join(dir, 'screenshots', name), bytes);
    const keys = events.map((e) => `one.${e.step}`);
    const v = await new RunThumbs().thumbs(projectDir, P, '20261020-240000-noise', keys);
    const total = v.thumbs.reduce((n, t) => n + t.base64.length, 0);
    console.log(`noise batch: ${v.thumbs.length} thumbnails, ${Math.round(total / 1024)} KB of base64, ${v.missing.length} left for another call`);
    expect(total).toBeLessThanOrEqual(RUN_THUMBS_RESPONSE_MAX);
    for (const t of v.thumbs) expect(t.base64.length).toBeLessThanOrEqual(THUMB_BASE64_MAX);
    expect(v.missing.length).toBeGreaterThan(0);
    expect(new Set(v.missing.map((m) => m.reason))).toEqual(new Set(['budget']));
    expect(v.thumbs.length + v.missing.length).toBe(RUN_THUMBS_MAX_KEYS);
  });
});

describe('cost (B7): ffmpeg processes, abort, no Remotion', () => {
  /** An ffmpeg wrapper that waits `s` seconds first and records its pid. */
  async function slowFfmpeg(s: number): Promise<string> {
    const real = execFileSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).trim();
    const file = join(tools, `ffmpeg-slow-${s}.sh`);
    await writeFile(file, `#!/bin/sh\necho $$ >> "${ws}/ffmpeg-pids"\nsleep ${s}\nexec "${real}" "$@"\n`);
    await chmod(file, 0o755);
    return file;
  }

  /** An "ffmpeg" that never answers (it becomes `sleep`: killing it leaves nothing behind) and records its pid. */
  async function hangingFfmpeg(): Promise<string> {
    const file = join(tools, 'ffmpeg-hang.sh');
    await writeFile(file, `#!/bin/sh\necho $$ >> "${ws}/ffmpeg-pids"\nexec sleep 30\n`);
    await chmod(file, 0o755);
    return file;
  }

  beforeAll(async () => {
    for (const id of ['20261020-220000-blocks', '20261020-220100-blocks', '20261020-220200-blocks']) {
      const dir = await writeRun(projectDir, capture(id));
      await rm(join(dir, 'frames'), { recursive: true });
      await rm(join(dir, 'frames.jsonl'));
    }
  }, 60_000);

  it('three runs at once: at most 2 ffmpeg processes; two batches of one run never overlap', async () => {
    const svc = new RunThumbs({ ffmpeg: await slowFfmpeg(0.4) });
    const ids = ['20261020-220000-blocks', '20261020-220100-blocks', '20261020-220200-blocks'];
    const views = await Promise.all(ids.map((id) => svc.thumbs(projectDir, P, id, KEYS)));
    for (const v of views) expectColours(v, EXPECTED, 'video');
    expect(svc.stats.ffmpeg).toBe(3);
    expect(svc.stats.ffmpegPeak).toBe(2);
    const one = new RunThumbs({ ffmpeg: await slowFfmpeg(0.4) });
    const t0 = Date.now();
    await Promise.all([one.thumbs(projectDir, P, ids[0], ['one.0']), one.thumbs(projectDir, P, ids[0], ['one.1'])]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(800);
    expect(one.stats.ffmpegPeak).toBe(1);
  }, 30_000);

  it('an aborted call kills its ffmpeg and answers cancelled', async () => {
    await rm(join(ws, 'ffmpeg-pids'), { force: true });
    const svc = new RunThumbs({ ffmpeg: await hangingFfmpeg() });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    const v = await svc.thumbs(projectDir, P, '20261020-220000-blocks', ['one.0'], { signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(v.missing).toEqual([{ key: 'one.0', reason: 'cancelled' }]);
    const pid = Number((await readFile(join(ws, 'ffmpeg-pids'), 'utf8')).trim());
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it('the thumbnail path imports the review package’s ./thumbs entry only (never its root: editor, Remotion)', async () => {
    const thumbs = await readFile(join(REPO, 'packages/review/src/thumbs.ts'), 'utf8');
    const imports = [...thumbs.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    // @retake/core only for ffmpegBin (the bundled ffmpeg, L5.16): core never imports the editor or Remotion
    expect(imports.sort()).toEqual(['@retake/core', 'node:child_process', 'node:stream', 'sharp']);
    for (const f of ['run-thumbs.ts', 'run-data.ts', 'run-files.ts', 'scenario-view.ts']) {
      const src = await readFile(join(REPO, 'packages/engine/src', f), 'utf8');
      expect(src, f).not.toMatch(/['"]@retake\/(review|editor)['"]/);
    }
    expect(await readFile(join(REPO, 'packages/engine/src/run-thumbs.ts'), 'utf8')).toContain("import('@retake/review/thumbs')");
  });
});
