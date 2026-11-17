/**
 * The iOS runner's acceptance with a real simulator (gated: RETAKE_TEST_IOS=1, a Mac with Xcode; about 5 minutes): the fixture app
 * (fixtures/ios-wholesale) built, its project's quote scenario filmed by `retake run` (the CLI), its capture checked —
 * constant rate, round(duration · fps) frames at the device's 1206×2622, the timeline valid with touches, bboxes and
 * ripples —; the touch-down timing calibrated on northfield://calibrate (each tap's touch-down from the video against
 * the app's own touch-down: within one frame, the recording's start lateness applied as in a take); the driver's
 * guards on the device (a wrong token, the token's proof, a bad Content-Length, a command past its deadline, its own
 * quit when idle); the take rendered with its review; an agent's run naming a scheme the environment does not list
 * refused. The simulators it creates are deleted at the end (RETAKE_IOS_KEEP_DEVICE=1 keeps them).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERSON_POLICY } from '@retake/core/policy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_CONFINEMENT } from '@retake/core/model';
import { resolveEnvironment } from '@retake/core/environment';
import { homeIosDriverCache, loadProject, nodeFileFacts } from '@retake/core/io';
import { TimelineSchema } from '@retake/core/run';
import { agentTrustProblems } from '@retake/core/scenario';
import type { Scenario } from '@retake/core/scenario';
import { REPO } from '@retake/test-support/repo';
import { testChildEnv } from '@retake/test-support/child-env';
import { bootDevice, findOrCreateDevice } from '../src/device.js';
import { ensureDriver } from '../src/driver-build.js';
import { DriverSession } from '../src/driver-session.js';
import { procExec } from '../src/proc.js';
import { ScreenRecording } from '../src/record-video.js';
import { Simctl } from '../src/simctl.js';
import { DriverClient } from '../src/driver-client.js';
import { capturedProbe, settleTouches } from '../src/take.js';
import type { TouchRecord } from '../src/touch-track.js';

const hasXcode = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'simctl']).status === 0;
const ENABLED = process.env.RETAKE_TEST_IOS === '1' && hasXcode;
const CLI = join(REPO, 'packages', 'cli', 'dist', 'bin.js');

let root: string;
let ws: string;
let home: string;
let app: string;
let devicesBefore: Set<string>;
const simctl = new Simctl(procExec, 'xcrun');

function cli(args: string[], timeoutMs: number): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [CLI, '-C', ws, ...args], { env: testChildEnv({ RETAKE_HOME: home }), encoding: 'utf8', timeout: timeoutMs });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe.skipIf(!ENABLED)('the iOS runner on a real simulator (RETAKE_TEST_IOS=1)', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'retake-ios-acceptance-'));
    home = join(root, 'home');
    ws = join(root, 'ws');
    mkdirSync(join(ws, 'projects'), { recursive: true });
    devicesBefore = new Set((await simctl.devices()).map((d) => d.udid));
    const t0 = Date.now();
    app = execFileSync(process.execPath, [join(REPO, 'fixtures', 'ios-wholesale', 'build.mjs'), '--out', join(root, 'app')], { encoding: 'utf8' }).trim();
    console.log(`fixture app built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    writeFileSync(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    const project = join(ws, 'projects', 'ios-fixture');
    cpSync(join(REPO, 'fixtures', 'ios-wholesale', 'project'), project, { recursive: true });
    const yaml = readFileSync(join(project, 'project.yaml'), 'utf8').replace('app: build/NorthfieldBuyer.app', `app: ${JSON.stringify(app)}`);
    writeFileSync(join(project, 'project.yaml'), yaml);
  }, 300_000);

  afterAll(async () => {
    if (process.env.RETAKE_IOS_KEEP_DEVICE !== '1') {
      for (const d of await simctl.devices()) {
        if (devicesBefore.has(d.udid) || !d.name.startsWith('Retake - ')) continue;
        await simctl.shutdown(d.udid).catch(() => undefined);
        await simctl.raw(['delete', d.udid]);
      }
    }
    rmSync(root, { recursive: true, force: true });
  }, 120_000);

  it('retake run films the quote scenario: run.json succeeded, a valid timeline, a constant-rate capture at the device size', () => {
    const t0 = Date.now();
    const r = cli(['-v', 'run', 'ios-fixture', 'quote'], 600_000);
    console.log(
      `retake run: ${((Date.now() - t0) / 1000).toFixed(1)} s\n${r.out
        .split('\n')
        .filter((l) => /creating|building|built|ready|booting|converted|take:|first frame|could not be timed|succeeded|failed/.test(l))
        .join('\n')}`,
    );
    expect(r.code, r.out).toBe(0);
    const runs = join(ws, 'projects', 'ios-fixture', 'runs');
    const dir = join(runs, readdirSync(runs).sort().at(-1)!);
    const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    expect(run.status).toBe('succeeded');
    const timeline = TimelineSchema.parse(JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')));
    expect(timeline.capture).toMatchObject({ width: 402, height: 874, scale: 3, device: { kind: 'ios', name: 'iPhone 17 Pro' } });
    expect(timeline.capture.duration).toBeGreaterThan(20);
    expect(timeline.capture.duration).toBeLessThan(60);
    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height,r_frame_rate,color_transfer', '-of', 'json', join(dir, 'capture.mp4')],
        { encoding: 'utf8' },
      ),
    ).streams[0];
    expect(probe).toMatchObject({ width: 1206, height: 2622, r_frame_rate: '30/1', color_transfer: 'bt709' });
    expect(Number(probe.nb_read_frames)).toBe(Math.round(timeline.capture.duration * timeline.capture.fps));
    const taps = timeline.events.filter((e) => e.action === 'click' || (e.action === 'type' && e.target));
    expect(taps.length).toBeGreaterThanOrEqual(6);
    for (const e of taps) {
      expect(e.target?.bbox, `${e.scene}.${e.step}`).toBeDefined();
      expect(e.t_click).toBeGreaterThan(e.t_start);
    }
    const ripples = (timeline.cursor_effects ?? []).filter((c) => c.type === 'ripple');
    expect(ripples.length).toBe((timeline.cursor_effects ?? []).filter((c) => c.type === 'press').length);
    expect(ripples.length).toBeGreaterThanOrEqual(taps.length);
    expect(timeline.pages).toEqual([expect.objectContaining({ id: 'simulator', t_start: 0 })]);
    expect(timeline.markers.map((m) => m.name)).toEqual(['quantity', 'sent']);
    expect(existsSync(join(dir, '.ios', 'capture.mov'))).toBe(false);
    expect(readdirSync(join(dir, '.ios'))).toEqual(['xcodebuild.log']);
  }, 660_000);

  it("calibration: each tap's touch-down read from the video is within one frame of the app's own touch-down", async () => {
    const dev = await findOrCreateDevice(simctl, 'iPhone 17 Pro', () => undefined);
    const booted = await bootDevice(simctl, dev, () => undefined);
    const built = await ensureDriver({ exec: procExec, xcrun: 'xcrun', log: () => undefined, cacheOf: (k) => homeIosDriverCache(k, { RETAKE_HOME: home }) });
    const dir = join(root, 'calibrate');
    mkdirSync(dir, { recursive: true });
    await simctl.install(dev.udid, app);
    const session = await DriverSession.start({
      exec: procExec,
      simctl,
      xcrun: 'xcrun',
      xctestrun: built.xctestrun,
      derivedData: built.derivedData,
      udid: dev.udid,
      dir,
      redact: (l) => l,
      log: () => undefined,
    });
    const touches: TouchRecord[] = [];
    const appDowns: number[] = [];
    let t0 = 0;
    try {
      const c = session.client;
      await c.cmd('launch', { bundleId: 'com.example.northfield.buyer' }, 120_000);
      await c.cmd('open', { url: 'northfield://calibrate' });
      await new Promise((r) => setTimeout(r, 1500));
      const mov = join(dir, 'calibrate.mov');
      const rec = await ScreenRecording.start({ exec: procExec, xcrun: 'xcrun', udid: dev.udid, mov, onStarted: () => (t0 = Date.now()) });
      await new Promise((r) => setTimeout(r, 800));
      const points = [
        [120, 300],
        [280, 300],
        [200, 450],
        [120, 600],
        [280, 600],
        [200, 250],
        [150, 520],
        [250, 380],
      ];
      for (const [x, y] of points) {
        const r = await c.cmd<{ t_act: number }>('tap', { x, y });
        touches.push({ kind: 'tap', t_act: (r.t_act - t0) / 1000, t_end: (r.t_end - t0) / 1000, x, y });
        const v = await c.cmd<{ value?: string }>('find', { query: { id: 'calibration-surface' }, timeout_ms: 2000 });
        appDowns.push(Number(/down=(\d+)/.exec(v.value ?? '')?.[1] ?? Number.NaN));
        await new Promise((res) => setTimeout(res, 700));
      }
      await rec.stop();
      // As in a take: the frames on the capture clock, shifted by the start stamp's lateness d.
      let late = '';
      const { probe, lateness } = await capturedProbe({ policy: PERSON_POLICY, mov, recording: { startedNs: rec.startedNs, stopNs: rec.stopNs }, log: (_l, m) => (late = m) });
      console.log(`calibration take: lateness d = ${(lateness * 1000).toFixed(1)} ms (${late})`);
      // An idle screen makes no frames (the recording is variable-rate): none in the still 0.8 s before the first tap,
      // nor in the still part of each wait between taps (from 0.4 s after a tap's reply to the next tap).
      const between = (a: number, b: number) => probe.frameTimes.filter((t) => t > a && t < b).length;
      const idle = [between(0.15, touches[0].t_act - 0.05), ...touches.slice(1).map((t, i) => between(touches[i].t_end + 0.4, t.t_act - 0.05))];
      console.log(`idle spans' frames (before the first tap, then between taps): ${idle.join(', ')} — ${probe.frameTimes.length} frames in all`);
      expect(idle[0]).toBeLessThanOrEqual(1);
      const settled = await settleTouches({ policy: PERSON_POLICY, mov, screen: { width: 402, height: 874, scale: 3 }, touches, log: () => undefined }, probe);
      const frame = 1 / 30;
      const rows = settled.map((t, i) => ({
        tap: i + 1,
        how: t.how,
        t_down: t.t_down,
        app_down: Math.round(appDowns[i] - t0) / 1000,
        delta_ms: Math.round((t.t_down - (appDowns[i] - t0) / 1000) * 1000),
      }));
      console.log(`calibration (per tap, t_down − the app's touch-down):\n${rows.map((r) => `  tap ${r.tap}: ${r.how} Δ ${r.delta_ms} ms`).join('\n')}`);
      for (const r of rows) {
        expect(r.how, `tap ${r.tap}`).toBe('video');
        expect(Math.abs(r.delta_ms / 1000), `tap ${r.tap}: Δ ${r.delta_ms} ms`).toBeLessThanOrEqual(frame);
      }
    } finally {
      await session.stop('com.example.northfield.buyer');
      if (booted && process.env.RETAKE_IOS_KEEP_BOOTED !== '1') await simctl.shutdown(dev.udid).catch(() => undefined);
    }
  }, 300_000);

  it('the driver on the device: a wrong token refused, the token proved, a bad length refused, a late command dropped; idle, it quits', async () => {
    const dev = await findOrCreateDevice(simctl, 'iPhone 17 Pro', () => undefined);
    const booted = await bootDevice(simctl, dev, () => undefined);
    const built = await ensureDriver({ exec: procExec, xcrun: 'xcrun', log: () => undefined, cacheOf: (k) => homeIosDriverCache(k, { RETAKE_HOME: home }) });
    const dir = join(root, 'guards');
    mkdirSync(dir, { recursive: true });
    const IDLE_S = 5;
    const session = await DriverSession.start({
      exec: procExec,
      simctl,
      xcrun: 'xcrun',
      xctestrun: built.xctestrun,
      derivedData: built.derivedData,
      udid: dev.udid,
      dir,
      redact: (l) => l,
      log: () => undefined,
      idleS: IDLE_S,
      keepaliveMs: 600_000,
    });
    try {
      const { port, token } = (session.client as unknown as { o: { port: number; token: string } }).o;
      const base = `http://127.0.0.1:${port}`;
      // The token's proof (HMAC-SHA256 of the nonce): the host's check, against the driver on the device.
      const proven = new DriverClient({ port, token });
      expect(await proven.status(2000)).toBe(true);
      expect(await new DriverClient({ port, token: 'f'.repeat(64) }).status(2000)).toBe(false);
      const post = (headers: Record<string, string>, body: unknown) =>
        fetch(`${base}/cmd`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      expect((await post({ 'x-retake-token': 'f'.repeat(64) }, { op: 'ping' })).status).toBe(403);
      expect((await post({}, { op: 'ping' })).status).toBe(403);
      // A command reaching the driver past its deadline is dropped, not played.
      const late = await (await post({ 'x-retake-token': token }, { op: 'ping', deadline_ms: Date.now() - 5000 })).json();
      expect(late).toMatchObject({ ok: false, code: 'expired' });
      // A Content-Length that is no length up to 1 MiB: refused (400), the driver still answers after.
      const raw = (length: string) =>
        new Promise<string>((resolve, reject) => {
          const sock = connect(port, '127.0.0.1', () => sock.write(`POST /cmd HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Retake-Token: ${token}\r\nContent-Length: ${length}\r\n\r\n{}`));
          let got = '';
          sock.on('data', (d) => (got += d.toString('utf8')));
          sock.on('end', () => resolve(got.split('\r\n')[0]));
          sock.on('error', reject);
          sock.setTimeout(10_000, () => sock.destroy(new Error('no answer')));
        });
      expect(await raw('-1')).toMatch(/^HTTP\/1\.1 400/);
      expect(await raw(String(2 * 1024 * 1024))).toMatch(/^HTTP\/1\.1 400/);
      expect(await session.client.cmd('ping', {}, 10_000)).toMatchObject({ ok: true });
      // Sent nothing for its idle limit (no host ping here), the driver quits by itself.
      const t0 = Date.now();
      while ((await proven.status(1000)) && Date.now() - t0 < (IDLE_S + 25) * 1000) await new Promise((r) => setTimeout(r, 500));
      const quitS = (Date.now() - t0) / 1000;
      console.log(`driver idle quit after ${quitS.toFixed(1)} s without a command (limit ${IDLE_S} s)`);
      expect(await proven.status(1000)).toBe(false);
      expect(quitS).toBeGreaterThanOrEqual(IDLE_S - 1);
      expect(readFileSync(join(dir, 'xcodebuild.log'), 'utf8')).toContain(`retake-driver: no command for ${IDLE_S} s: quitting`);
    } finally {
      await session.stop();
      if (booted && process.env.RETAKE_IOS_KEEP_BOOTED !== '1') await simctl.shutdown(dev.udid).catch(() => undefined);
    }
  }, 300_000);

  it('retake render --review: the take in its phone frame, the contact sheet written', () => {
    const t0 = Date.now();
    const r = cli(['render', 'ios-fixture', 'quote', '--review'], 900_000);
    expect(r.code, r.out).toBe(0);
    const review = join(ws, 'projects', 'ios-fixture', 'review');
    const name = readdirSync(review).sort().at(-1)!;
    const sheet = join(review, name, 'sheet_1fps.jpg');
    expect(existsSync(sheet)).toBe(true);
    expect(r.out).not.toMatch(/does not validate/);
    console.log(
      `retake render --review: ${((Date.now() - t0) / 1000).toFixed(1)} s\ncontact sheet: ${sheet}\nscene sheets: ${readdirSync(join(review, name))
        .filter((f) => f.startsWith('scene'))
        .join(', ')}`,
    );
  }, 900_000);

  it('an agent run (MCP, the Studio) opening a scheme the environment does not list is refused before anything runs', async () => {
    const project = await loadProject(join(ws, 'projects', 'ios-fixture'));
    const env = resolveEnvironment(project, 'simulator');
    const sc = { version: 1, video: 'x', scenes: [{ id: 'a', open: 'otherapp://pay', steps: [{ wait: 0.2 }] }] } as unknown as Scenario;
    const problems = agentTrustProblems(project, sc, { via: AGENT_CONFINEMENT, env, files: nodeFileFacts });
    expect(problems.join('\n')).toMatch(/otherapp/);
    const listed = { ...sc, scenes: [{ id: 'a', open: 'northfield://quote', steps: [{ wait: 0.2 }] }] } as unknown as Scenario;
    expect(agentTrustProblems(project, listed, { via: AGENT_CONFINEMENT, env, files: nodeFileFacts })).toEqual([]);
  });
});
