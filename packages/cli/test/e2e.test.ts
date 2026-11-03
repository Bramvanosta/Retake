/**
 * End to end: the bundled fixture product on free ports, a short scenario run through the `retake` CLI entry
 * (capture mode, real setup/teardown hooks), then capture.mp4 + timeline.json checked for consistency.
 * Skipped when Chromium or ffmpeg is not available.
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunRecordSchema, TimelineSchema } from '@retake/core';
import type { RunProgress, RunRecord, Timeline, TimelineEvent } from '@retake/core';
import { EXIT, VERSION, main, memoryIo } from '../src/index.js';

const execFileP = promisify(execFile);
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(REPO, 'packages/cli/dist/bin.js');

function chromiumAvailable(): boolean {
  if (process.env.RETAKE_CHROMIUM) return existsSync(process.env.RETAKE_CHROMIUM);
  try {
    const require = createRequire(join(REPO, 'packages/runner-web/package.json'));
    const { chromium } = require('playwright-core') as { chromium: { executablePath(): string } };
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

function ffmpegAvailable(): boolean {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
}

const AVAILABLE = chromiumAvailable() && ffmpegAvailable();

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

let fixture: Fixture;
let ws: string;

async function retake(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', ws, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

/** Short, quick-paced scenario: opens a dialog, picks an option in a Radix select, closes it with a real click. */
const SCENARIO = `video: short
setup:
  - name: reset
    http: {method: POST, url: "{{console}}/api/reset"}
  - name: arm-proposal
    http:
      method: POST
      url: "{{console}}/api/quotes/auto-proposal"
      json: {after_minutes: 30}
      rollback: {method: DELETE, url: "{{console}}/api/quotes/auto-proposal"}
teardown:
  - name: reset
    http: {method: POST, url: "{{console}}/api/reset"}
pacing: {scene_start_still: 0.4, after_popup_ms: 400, after_click_ms: 200, settle_ms: 1000}
scenes:
  - id: import
    page: console
    open: /imports
    steps:
      - click: {text: New import}
      - select: {combobox: "#import-organization", option: Kettle & Crate}
      - click: {text: Cancel, in: dialog}
        id: close
      - hold: 0.5
`;

describe.skipIf(!AVAILABLE)('retake run (fixture product, headless capture)', () => {
  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
      startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture>;
    };
    fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
    ws = await mkdtemp(join(tmpdir(), 'studio-e2e-'));
    await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    const project = join(ws, 'projects', 'e2e');
    await mkdir(join(project, 'scenarios'), { recursive: true });
    await writeFile(
      join(project, 'project.yaml'),
      [
        'name: E2E',
        'environments:',
        '  local:',
        `    console: ${fixture.urls.console}`,
        `    shop: ${fixture.urls.shop}`,
        'capture: {width: 1280, height: 720, scale: 1, fps: 30}',
        'template: default',
        '',
      ].join('\n'),
    );
    await writeFile(join(project, 'scenarios', 'short.yaml'), SCENARIO);
  });

  afterAll(async () => {
    await fixture?.close();
    if (ws) await rm(ws, { recursive: true, force: true });
  });

  it('validates the scenario', async () => {
    const r = await retake('validate', 'e2e', 'short');
    expect(r.code, r.err).toBe(EXIT.ok);
  });

  it('captures capture.mp4 + timeline.json that agree with each other', async () => {
    const r = await retake('run', 'e2e', 'short', '--json');
    const events = r.out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as RunProgress);
    const end = events[events.length - 1];
    expect(events[0].type).toBe('run_start');
    expect(end.type).toBe('run_end');
    const run = (end as { run: RunRecord }).run;
    expect(run.error?.message ?? '', r.err).toBe('');
    expect(r.code).toBe(EXIT.ok);
    expect(run.status).toBe('succeeded');
    expect(run.hooks).toEqual({ setup: 'ok', teardown: 'ok' });
    expect(events.filter((e) => e.type === 'step_end')).toHaveLength(4);
    expect(events.some((e) => e.type === 'hook' && e.phase === 'rollback' && e.status === 'ok')).toBe(true);

    // Files of the run, valid against the shared schemas.
    expect(run.capture && existsSync(run.capture)).toBe(true);
    const record = RunRecordSchema.parse(JSON.parse(await readFile(join(run.dir, 'run.json'), 'utf8')));
    expect(record.status).toBe('succeeded');
    // The format version and what ran the capture (R-PRIN-13): Retake, Node.js, Chromium, the OS, the fonts.
    expect(record.version).toBe(1);
    expect(record.engine).toMatchObject({ retake: VERSION, node: process.versions.node });
    expect(record.engine?.chromium).toMatch(/^\d+\.\d+\./);
    expect(record.engine?.os.startsWith(`${process.platform} `)).toBe(true);
    expect(record.engine?.fonts?.digest).toMatch(/^[0-9a-f]{12}$/);
    if (process.platform === 'darwin') expect(record.engine?.fonts?.files).toBeGreaterThan(50);
    const tl = TimelineSchema.parse(JSON.parse(await readFile(join(run.dir, 'timeline.json'), 'utf8'))) as Timeline;

    // Video and timeline agree: duration, size, frame rate.
    const probe = JSON.parse(
      (await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,avg_frame_rate', '-of', 'json', run.capture!])).stdout,
    ) as { format: { duration: string }; streams: Array<{ width: number; height: number; avg_frame_rate: string }> };
    expect(probe.streams[0]).toMatchObject({ width: 1280, height: 720, avg_frame_rate: '30/1' });
    expect(Math.abs(Number(probe.format.duration) - tl.capture.duration)).toBeLessThanOrEqual(1 / 30 + 0.001);
    expect(tl.capture.frames).toBeGreaterThan(10);
    expect(tl.cursor.length).toBeGreaterThan(10);
    // A freeze during a click ripple only is the known dialog-close stall with the frame rate limiter on (R-ISS-12).
    const rippleOnly = (w: string): boolean => w.startsWith('the capture froze') && !w.includes('cursor moving');
    expect(tl.warnings.filter((w) => !w.includes('captured below') && !rippleOnly(w))).toEqual([]);

    // Events: in order, inside the capture, no hesitation between steps, clicks inside their targets.
    const steps = tl.events.filter((e) => e.step >= 0);
    expect(steps.map((e) => e.action)).toEqual(['click', 'select', 'click', 'hold']);
    for (const e of tl.events) {
      expect(e.status).toBe('ok');
      expect(e.t_start).toBeGreaterThanOrEqual(0);
      expect(e.t_end).toBeGreaterThanOrEqual(e.t_start);
      expect(e.t_end).toBeLessThanOrEqual(tl.capture.duration + 0.001);
    }
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1];
      expect(steps[i].t_start - (prev.hold?.t_end ?? prev.t_end)).toBeLessThan(0.08);
    }
    const clicks = steps.filter((e): e is TimelineEvent & { t_click: number } => e.t_click !== undefined);
    expect(clicks).toHaveLength(3);
    for (const e of clicks) {
      expect(e.t_click).toBeGreaterThanOrEqual(e.t_start);
      expect(e.t_click).toBeLessThanOrEqual(e.t_end);
      const { bbox } = e.target!;
      expect(e.point!.x).toBeGreaterThanOrEqual(bbox!.x);
      expect(e.point!.x).toBeLessThanOrEqual(bbox!.x + bbox!.w);
      expect(e.point!.y).toBeGreaterThanOrEqual(bbox!.y);
      expect(e.point!.y).toBeLessThanOrEqual(bbox!.y + bbox!.h);
    }
    expect(steps[0].popup_opened).toBe(true); // New import opens a dialog
    expect(steps[1].popup_opened).toBe(true); // the Radix select opens on pointerdown
    expect(tl.pages.map((p) => p.url)).toEqual([`${fixture.urls.console}/imports`]);
    expect(tl.scenes).toEqual([expect.objectContaining({ id: 'import', status: 'ok', url: `${fixture.urls.console}/imports` })]);

    // The setup rollback ran after the teardown: nothing is left pending for `retake env reset`.
    const journal = JSON.parse(await readFile(join(run.dir, 'hooks-journal.json'), 'utf8')) as { entries: Array<{ status: string; rollback?: unknown }> };
    expect(journal.entries.filter((x) => x.status === 'ok' && x.rollback)).toEqual([]);
    expect((await retake('hooks', 'rollback', 'e2e')).err).toContain('no pending rollbacks');
  });

  it('runs js hooks in a headless page of the environment', async () => {
    const file = join(ws, 'projects', 'e2e', 'hooks', 'title.yaml');
    await mkdir(join(ws, 'projects', 'e2e', 'hooks'), { recursive: true });
    await writeFile(file, '- name: title\n  js: {code: "if (!document.title.includes(\'Northfield\')) throw new Error(document.title)", page: console}\n');
    const r = await retake('hooks', 'run', 'e2e', 'hooks/title.yaml');
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.err).toContain('title: done');
  });

  it('refuses js and shell hooks that would reach a host outside the allow-list (R-SEC-06)', async () => {
    const hooksDir = join(ws, 'projects', 'e2e', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    await writeFile(join(hooksDir, 'leak.yaml'), '- name: leak\n  js: {code: "await fetch(\'http://elsewhere.invalid/x\')", page: console}\n');
    const js = await retake('hooks', 'run', 'e2e', 'hooks/leak.yaml');
    expect(js.code, js.err).toBe(EXIT.failure);
    expect(js.err).toContain('refusing to contact elsewhere.invalid (blocked while the js hook ran)');
    expect(js.err).toContain('the hook threw: TypeError: Failed to fetch');

    await writeFile(join(hooksDir, 'curl.yaml'), '- name: reset-prod\n  shell: "touch ran.txt && curl -fsS https://elsewhere.invalid/reset"\n');
    const shell = await retake('hooks', 'run', 'e2e', 'hooks/curl.yaml');
    expect(shell.code, shell.err).toBe(EXIT.failure);
    expect(shell.err).toMatch(/curl\.yaml:2:\d+ error \[0\]\.shell: shell hook names host elsewhere\.invalid \(URL\): it is not allowed/);
    expect(existsSync(join(ws, 'projects', 'e2e', 'ran.txt'))).toBe(false);
  });

  it('clears the React search field of the shop when select-all is blocked (native value setter, R-CHO-15)', async () => {
    await writeFile(
      join(ws, 'projects', 'e2e', 'scenarios', 'clear.yaml'),
      [
        'video: clear',
        'pacing: {scene_start_still: 0.2, after_click_ms: 150, after_navigation_ms: 300, settle_ms: 1000}',
        'scenes:',
        '  - id: shop',
        '    page: shop',
        '    open: /',
        '    steps:',
        '      - type: {into: {aria: Search coffees}, text: zzz, cps: 40}',
        `      - eval: {js: "document.querySelector('[aria-label=\\"Search coffees\\"]').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') e.preventDefault(); }, true)"}`,
        '      - type: {into: {aria: Search coffees}, text: Selowa, clear: true, enter: true}',
        '      - assert: {url: q=Selowa}',
        '',
      ].join('\n'),
    );
    const r = await retake('run', 'e2e', 'clear', '--dry', '--json');
    const end = JSON.parse(r.out.trim().split('\n').pop()!) as { run: RunRecord };
    expect(end.run.error?.message ?? '', r.err).toBe('');
    expect(end.run.status).toBe('succeeded');
    const tl = JSON.parse(await readFile(join(end.run.dir, 'timeline.json'), 'utf8')) as Timeline;
    const typed = tl.events.filter((e) => e.action === 'type');
    // React's state followed the clear: the search navigated to q=Selowa (not "zzSelowa"); typed at search speed.
    expect(typed[1].data).toMatchObject({ clear: 'setter', rate: 'search', cps: 10 });
  });

  it('dry-runs up to a step with a screenshot per step', async () => {
    const r = await retake('run', 'e2e', 'short', '--dry', '--until', 'import.1');
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.err).toContain('dry run succeeded');
    const runs = (await readdir(join(ws, 'projects', 'e2e', 'runs'))).sort();
    const record = JSON.parse(await readFile(join(ws, 'projects', 'e2e', 'runs', runs[runs.length - 1], 'run.json'), 'utf8')) as RunRecord;
    expect(record.mode).toBe('dry');
    expect(record.stopped_at).toEqual({ scene: 'import', step: 1, reason: 'until' });
    expect(record.screenshots).toHaveLength(2);
    expect(record.capture).toBeUndefined();
  });

  it('inspect --json: the report of a page (elements with verified targets, a marked screenshot), out of runs/', async () => {
    const runs = async () => (existsSync(join(ws, 'projects', 'e2e', 'runs')) ? readdir(join(ws, 'projects', 'e2e', 'runs')) : []);
    const runsBefore = await runs();
    const r = await retake('inspect', 'e2e', 'shop', '--path', '/inspect-lab', '--json', '--target', '{role: button, name: Publish}');
    expect(r.code, r.err).toBe(EXIT.ok);
    const report = JSON.parse(r.out) as { status: string; file: string; marked: string; elements: Array<{ verified: boolean; untrusted: { target_yaml: string | null } }>; targets_checked: Array<{ count: number }> };
    expect(report.status).toBe('ok');
    expect(report.file.startsWith(join(ws, 'projects', 'e2e', '.retake', 'inspect'))).toBe(true);
    expect(existsSync(report.marked)).toBe(true);
    expect(report.elements.filter((e) => e.verified && e.untrusted.target_yaml).length).toBeGreaterThan(15);
    expect(report.targets_checked.map((t) => t.count)).toEqual([1]);
    expect(await runs()).toEqual(runsBefore);
  });

  it('inspect a scenario up to a step: the open dialog first, as a table; an unknown page or scenario is a usage error', async () => {
    const r = await retake('inspect', 'e2e', 'short', '--until', 'import.1', '--images', 'none');
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.err).toMatch(/dialog open/);
    expect(r.err.split('\n').find((l) => /^\s+1\s/.test(l))).toMatch(/in dialog/);
    const bad = await retake('inspect', 'e2e', 'nowhere');
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.err).toMatch(/neither a page of environment local \(console, shop\) nor a scenario of e2e \([^)]*\bshort\b/);
    const until = await retake('inspect', 'e2e', 'shop', '--until', 'import.1');
    expect(until.code).toBe(EXIT.usage);
    expect(until.err).toMatch(/"shop" is a page of environment local: --until goes with a scenario/);
    const persona = await retake('inspect', 'e2e', 'shop', '--persona', 'nobody');
    expect(persona.code).not.toBe(EXIT.ok);
    expect(persona.err).toMatch(/cannot inspect page shop: persona: unknown persona "nobody"/);
    // No position inside the scenario the command builds (it is never shown).
    expect(persona.err).not.toMatch(/\d+:\d+/);
  });

  it('inspect a page under an open dialog: what the dialog covers is said so (and left unmarked)', async () => {
    const r = await retake('inspect', 'e2e', 'shop', '--path', '/inspect-lab?dialog=1');
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.err).toMatch(/covered \(not marked\)/);
  });

  it('run --raw --json: JSON lines only — the RunProgress events, then one raw_export line with the manifest', async () => {
    const out = join(ws, 'raw-pkg');
    const r = await retake('run', 'e2e', 'short', '--raw', '--cursor', 'none', '--json', '--out', out);
    expect(r.code, r.err).toBe(EXIT.ok);
    const lines = r.out.trim().split('\n');
    const events = lines.map((l, i) => {
      try {
        return JSON.parse(l) as { type: string };
      } catch {
        throw new Error(`stdout line ${i + 1} is not JSON: ${l.slice(0, 80)}`);
      }
    });
    expect(events[0].type).toBe('run_start');
    expect(events[events.length - 2].type).toBe('run_end');
    const last = events[events.length - 1] as { type: string; dir: string; manifest: { kind: string; run: { cursor: string }; clips: Array<{ file: string }> } };
    expect(last.type).toBe('raw_export');
    expect(last.dir).toBe(out);
    expect(last.manifest).toMatchObject({ kind: 'retake/raw-capture', run: { cursor: 'hidden' } });
    expect(last.manifest.clips.map((c) => c.file)).toEqual(['clips/01-import.mp4']);
    expect(existsSync(join(out, 'manifest.json'))).toBe(true);
  });

  /**
   * R-RUN-08: `retake run` as a process (the built CLI, its own TMPDIR) gets SIGINT or SIGTERM. The run is cancelled
   * (exit 1, like any run that did not succeed), the teardown hooks and the setup rollbacks run, the browser and its
   * profile are gone. A second signal quits at once.
   */
  describe.skipIf(process.platform === 'win32' || !existsSync(BIN))('Ctrl-C and SIGTERM during retake run (built CLI)', () => {
    const LONG_SETUP = SCENARIO.slice(SCENARIO.indexOf('setup:'), SCENARIO.indexOf('pacing:'));
    const scene = ['scenes:', '  - id: wait', '    page: console', '    open: /imports', '    steps:', '      - wait: 30', ''].join('\n');
    const tmps: string[] = [];
    // Long shell hooks with a duration of their own (pid + random): their processes can be found, and only them — not
    // those of another copy of the suite running at the same time.
    const tag = `${process.pid}${Math.floor(Math.random() * 1e6)}`;
    const SETUP_SLEEP = `sleep 30.${tag}`;
    const TEARDOWN_SLEEP = `sleep 20.${tag}`;

    beforeAll(async () => {
      const dir = join(ws, 'projects', 'e2e', 'scenarios');
      await writeFile(join(dir, 'long.yaml'), `video: long\n${LONG_SETUP}pacing: {scene_start_still: 0.2}\n${scene}`);
      // A setup shell hook that takes long.
      const slow = LONG_SETUP.replace('teardown:', `  - name: seed\n    shell: {run: "${SETUP_SLEEP}"}\n    writes: false\nteardown:`);
      await writeFile(join(dir, 'slow-setup.yaml'), `video: slow-setup\n${slow}pacing: {scene_start_still: 0.2}\n${scene}`);
      // A teardown that starts with a long shell hook: a second signal arrives while it runs.
      const slowTeardown = LONG_SETUP.replace('teardown:\n', `teardown:\n  - name: slow-cleanup\n    shell: {run: "${TEARDOWN_SLEEP}"}\n    writes: false\n`);
      await writeFile(join(dir, 'slow-teardown.yaml'), `video: slow-teardown\n${slowTeardown}pacing: {scene_start_still: 0.2}\n${scene}`);
    });

    afterAll(async () => {
      // A browser a killed process left (second signal) would show its TMPDIR on its command line.
      for (const tmp of tmps) {
        for (const pid of await processesWith(tmp)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* gone */
          }
        }
        await rm(tmp, { recursive: true, force: true });
      }
    });

    /** Processes whose command line contains `text` (a TMPDIR: the browser's profile is in it). */
    async function processesWith(text: string): Promise<number[]> {
      const { stdout } = await execFileP('ps', ['-axww', '-o', 'pid=,command=']);
      return stdout
        .split('\n')
        .filter((l) => l.includes(text))
        .map((l) => Number(l.trim().split(/\s+/)[0]))
        .filter((pid) => pid !== process.pid);
    }

    const sleeping = async (cmd = SETUP_SLEEP) => (await execFileP('ps', ['-axww', '-o', 'command='])).stdout.split('\n').some((l) => l.trim() === cmd);

    async function armedNow(): Promise<boolean> {
      const res = (await (await fetch(`${fixture.urls.console}/api/quotes/auto-proposal`, { method: 'DELETE' })).json()) as { was_armed: boolean };
      return res.was_armed; // DELETE disarms: call once per check
    }

    type Ready = (events: RunProgress[]) => boolean | Promise<boolean>;
    /** Spawn `retake run e2e <scenario> --json`; at each `ready`, send its signal; wait for the exit. */
    async function signalled(scenario: string, steps: Array<[Ready, NodeJS.Signals]>) {
      const tmp = await mkdtemp(join(tmpdir(), 'studio-sig-'));
      tmps.push(tmp);
      const child = spawn(process.execPath, [BIN, '--root', ws, 'run', 'e2e', scenario, '--json'], {
        env: { ...process.env, TMPDIR: tmp, RETAKE_HOME: join(tmp, 'home') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
      const events = () =>
        out
          .split('\n')
          .filter((l) => l.startsWith('{'))
          .map((l) => JSON.parse(l) as RunProgress);
      let t0 = 0;
      for (const [ready, sig] of steps) {
        const deadline = Date.now() + 60_000;
        while (child.exitCode === null && Date.now() < deadline && !(await ready(events()))) await new Promise((r) => setTimeout(r, 25));
        expect(child.exitCode, err).toBeNull();
        t0 ||= Date.now();
        child.kill(sig);
      }
      const end = await exited;
      const start = events().find((e): e is Extract<RunProgress, { type: 'run_start' }> => e.type === 'run_start');
      return { ...end, ms: Date.now() - t0, events: events(), err, tmp, dir: start!.run.dir };
    }

    const waiting: Ready = (ev) => ev.some((e) => e.type === 'step_start' && e.action === 'wait');

    async function noBrowserLeft(tmp: string): Promise<void> {
      const deadline = Date.now() + 10_000;
      while ((await processesWith(tmp)).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(await processesWith(tmp)).toEqual([]);
      expect((await readdir(tmp)).filter((n) => /^(playwright|retake-)/.test(n))).toEqual([]);
    }

    async function cancelledRecord(dir: string): Promise<RunRecord> {
      const record = RunRecordSchema.parse(JSON.parse(await readFile(join(dir, 'run.json'), 'utf8'))) as RunRecord;
      expect(record.status).toBe('cancelled');
      const log = (await readFile(join(dir, 'log.jsonl'), 'utf8')).trim().split('\n');
      expect((JSON.parse(log[log.length - 1]) as { type: string }).type).toBe('run_end');
      return record;
    }

    it('SIGINT during a step: cancelled, exit 1, teardown and rollback ran, no browser or profile left', async () => {
      const r = await signalled('long', [[waiting, 'SIGINT']]);
      expect(r.code, r.err).toBe(EXIT.failure);
      expect(r.ms).toBeLessThan(15_000);
      const record = await cancelledRecord(r.dir);
      expect(record.hooks).toEqual({ setup: 'ok', teardown: 'ok' });
      expect(record.error?.message).toBe('run cancelled (SIGINT)');
      expect(r.events.some((e) => e.type === 'hook' && e.phase === 'rollback' && e.status === 'ok')).toBe(true);
      expect(await armedNow()).toBe(false);
      expect((await retake('hooks', 'rollback', 'e2e')).err).toContain('no pending rollbacks');
      await noBrowserLeft(r.tmp);
    });

    it('SIGTERM during a setup shell hook: the command is stopped, the setup rolled back, teardown runs', async () => {
      const r = await signalled('slow-setup', [[() => sleeping(), 'SIGTERM']]);
      expect(r.code, r.err).toBe(EXIT.failure);
      expect(r.ms).toBeLessThan(15_000);
      expect(await sleeping()).toBe(false);
      const record = await cancelledRecord(r.dir);
      expect(record.hooks).toEqual({ setup: 'failed', teardown: 'ok' });
      expect(record.steps_done).toBe(0);
      expect(record.error?.message).toBe('run cancelled (SIGTERM)');
      const seed = r.events.find((e) => e.type === 'hook' && e.phase === 'setup' && e.name === 'seed');
      expect(seed).toMatchObject({ status: 'failed', message: expect.stringContaining('was interrupted (its process group stopped)') });
      expect(r.events.some((e) => e.type === 'hook' && e.phase === 'teardown' && e.name === 'reset' && e.status === 'ok')).toBe(true);
      expect(await armedNow()).toBe(false);
      expect((await retake('hooks', 'rollback', 'e2e')).err).toContain('no pending rollbacks');
      await noBrowserLeft(r.tmp);
    });

    it('a second SIGINT (during a teardown shell hook) quits at once and kills that hook; retake hooks rollback replays the rest', async () => {
      const r = await signalled('slow-teardown', [
        [waiting, 'SIGINT'],
        [() => sleeping(TEARDOWN_SLEEP), 'SIGINT'],
      ]);
      expect(r.signal, r.err).toBe('SIGINT');
      expect(r.code).toBeNull();
      expect(r.ms).toBeLessThan(5_000);
      // The teardown's shell command (its own process group) went with the process.
      for (let i = 0; i < 20 && (await sleeping(TEARDOWN_SLEEP)); i++) await new Promise((res) => setTimeout(res, 50));
      expect(await sleeping(TEARDOWN_SLEEP)).toBe(false);
      // Neither the rest of the teardown (the reset) nor the setup rollback ran: the journal kept the rollback.
      expect(await armedNow()).toBe(true);
      await fetch(`${fixture.urls.console}/api/quotes/auto-proposal`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      const rb = await retake('hooks', 'rollback', 'e2e');
      expect(rb.code, rb.err).toBe(EXIT.ok);
      expect(await armedNow()).toBe(false);
      // The browser went with its pipe; its temporary profile stays for the next run's sweep (README: 10 minutes).
      for (let i = 0; i < 50 && (await processesWith(r.tmp)).length; i++) await new Promise((res) => setTimeout(res, 100));
      expect(await processesWith(r.tmp)).toEqual([]);
    });
  });
});

describe('retake hooks run / hooks rollback / env reset (fixture API)', () => {
  let api: Fixture;
  let root: string;

  async function cli(...args: string[]) {
    const io = memoryIo();
    const code = await main(['node', 'retake', '--root', root, ...args], io);
    return { code, out: io.stdout(), err: io.stderr() };
  }

  async function armed(): Promise<boolean> {
    // Arming twice is allowed; DELETE answers whether a proposal was armed (and disarms it): re-arm afterwards.
    const res = (await (await fetch(`${api.urls.console}/api/quotes/auto-proposal`, { method: 'DELETE' })).json()) as { was_armed: boolean };
    if (res.was_armed) await fetch(`${api.urls.console}/api/quotes/auto-proposal`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    return res.was_armed;
  }

  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
      startFixture(o: { consolePort: number; shopPort: number; host?: string; build?: boolean }): Promise<Fixture>;
    };
    api = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1', build: false });
    root = await mkdtemp(join(tmpdir(), 'studio-hooks-'));
    const project = join(root, 'projects', 'api');
    await mkdir(join(project, 'hooks'), { recursive: true });
    await writeFile(
      join(project, 'project.yaml'),
      // vars.cleanup: a command the static check of a hooks file cannot see (it is only known once templated).
      `name: API\nenvironments:\n  local:\n    console: ${api.urls.console}\n  staging:\n    console: ${api.urls.console}\nvars: {cleanup: "rm -f scratch.txt"}\nreset:\n  - name: reset\n    http: {method: POST, url: "{{console}}/api/reset"}\n`,
    );
    await mkdir(join(project, 'scenarios'), { recursive: true });
    await writeFile(
      join(project, 'scenarios', 'quote.yaml'),
      [
        'video: quote',
        'setup:',
        '  - name: arm',
        '    http:',
        '      method: POST',
        '      url: "{{console}}/api/quotes/auto-proposal"',
        '      json: {after_minutes: 10}',
        '      rollback: {method: DELETE, url: "{{console}}/api/quotes/auto-proposal"}',
        'teardown:',
        '  - name: reset',
        '    http: {method: POST, url: "{{console}}/api/reset"}',
        'scenes:',
        '  - {id: quotes, page: console, open: /quotes, steps: [{hold: 0.2}]}',
        '',
      ].join('\n'),
    );
    await writeFile(join(project, 'hooks', 'cleanup.yaml'), '- name: cleanup\n  shell: "{{vars.cleanup}}"\n');
    await writeFile(
      join(project, 'hooks', 'arm.yaml'),
      '- name: arm\n  http:\n    method: POST\n    url: "{{console}}/api/quotes/auto-proposal"\n    json: {after_minutes: 10}\n    rollback: {method: DELETE, url: "{{console}}/api/quotes/auto-proposal"}\n',
    );
    await writeFile(join(project, 'hooks', 'bad.yaml'), '- name: wipe\n  http: {method: DELETE, url: "{{console}}/api/products/x/refs"}\n');
  });

  afterAll(async () => {
    await api?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('runs a hooks file with a journal, rolls it back by run id, and refuses unconfirmed destructive hooks', async () => {
    const run = await cli('hooks', 'run', 'api', 'hooks/arm.yaml');
    expect(run.code, run.err).toBe(EXIT.ok);
    expect(await armed()).toBe(true);
    const runId = /retake hooks rollback api (\S+)\)/.exec(run.err)?.[1];
    expect(runId, run.err).toBeTruthy();

    // R-ISS-06: the journal lives in .retake/journals/, never in a run-looking folder of runs/.
    const journals = join(root, 'projects', 'api', '.retake', 'journals');
    expect(await readdir(journals)).toEqual([`${runId}.json`]);
    expect(existsSync(join(root, 'projects', 'api', 'runs'))).toBe(false);

    const rb = await cli('hooks', 'rollback', 'api', runId!);
    expect(rb.code, rb.err).toBe(EXIT.ok);
    expect(await armed()).toBe(false);
    expect((await cli('hooks', 'rollback', 'api', runId!)).err).toContain('nothing to roll back');

    const bad = await cli('hooks', 'run', 'api', 'hooks/bad.yaml');
    expect(bad.code).toBe(EXIT.failure);
    expect(bad.err).toMatch(/bad\.yaml:2:\d+ error .*requires "confirm: true"/);
  });

  it('env reset replays pending journals, then runs the reset hooks', async () => {
    expect((await cli('hooks', 'run', 'api', 'hooks/arm.yaml')).code).toBe(EXIT.ok);
    const reset = await cli('env', 'reset', 'api');
    expect(reset.code, reset.err).toBe(EXIT.ok);
    expect(reset.err).toContain('rollback');
    expect(reset.err).toContain('environment reset');
    expect(await armed()).toBe(false);
    expect((await cli('hooks', 'rollback', 'api')).err).toContain('no pending rollbacks');
    // R-ISS-06: hooks run + env reset journals are all under .retake/journals/; runs/ stays empty.
    const journals = await readdir(join(root, 'projects', 'api', '.retake', 'journals'));
    expect(journals.some((f) => /-env-reset\.json$/.test(f))).toBe(true);
    expect(journals.every((f) => f.endsWith('.json'))).toBe(true);
    expect(existsSync(join(root, 'projects', 'api', 'runs'))).toBe(false);
  });

  it('hooks run sources: <scenario>:setup, :teardown, reset, a file; --dry checks without running, --yes approves (R-CLI-05)', async () => {
    const journals = join(root, 'projects', 'api', '.retake', 'journals');
    const listJournals = async () => (existsSync(journals) ? await readdir(journals) : []);
    const before = await listJournals();
    expect(await armed()).toBe(false);

    // --dry: templated and security-checked, nothing executed, nothing journaled.
    const dry = await cli('hooks', 'run', 'api', 'quote:setup', '--dry');
    expect(dry.code, dry.err).toBe(EXIT.ok);
    expect(dry.err).toContain('setup hooks quote-setup');
    expect(dry.err).toMatch(/◦ arm: http POST \S+\/api\/quotes\/auto-proposal +not executed \(dry run\)/);
    expect(dry.err).toContain('quote-setup: checked (nothing executed)');
    expect(dry.err).not.toContain('pending rollback');
    expect(await armed()).toBe(false);
    expect(await listJournals()).toEqual(before);

    // <scenario>:setup runs the scenario's setup with its journal; <scenario>:teardown its teardown (the reset disarms).
    const setup = await cli('hooks', 'run', 'api', 'quote:setup');
    expect(setup.code, setup.err).toBe(EXIT.ok);
    expect(setup.err).toMatch(/✓ arm: http POST \S+\/api\/quotes\/auto-proposal +200 OK/);
    expect(setup.err).toMatch(/1 pending rollback: retake hooks rollback api \d{8}-\d{6}-hooks-quote-setup\)/);
    expect(await armed()).toBe(true);
    const teardown = await cli('hooks', 'run', 'api', 'quote:teardown');
    expect(teardown.code, teardown.err).toBe(EXIT.ok);
    expect(teardown.err).toContain('teardown hooks quote-teardown');
    expect(teardown.err).toContain('quote-teardown: done');
    expect(await armed()).toBe(false);
    expect((await cli('hooks', 'rollback', 'api')).code).toBe(EXIT.ok); // the setup's pending DELETE (nothing armed now)

    // reset: the project's reset hooks, here on another environment (--env).
    expect((await cli('hooks', 'run', 'api', 'hooks/arm.yaml')).code).toBe(EXIT.ok);
    const reset = await cli('hooks', 'run', 'api', 'reset', '--env', 'staging');
    expect(reset.code, reset.err).toBe(EXIT.ok);
    expect(reset.err).toContain('api reset hooks reset · env staging · 1 hook');
    expect(reset.err).toContain('reset: done');
    expect(await armed()).toBe(false);
    expect((await cli('hooks', 'rollback', 'api')).code).toBe(EXIT.ok);

    // A command that turns destructive once templated (rm): refused without --yes (no prompt here), --dry included;
    // --yes approves it, with a warning.
    const scratch = join(root, 'projects', 'api', 'scratch.txt');
    await writeFile(scratch, 'x');
    for (const extra of [[], ['--dry']]) {
      const refused = await cli('hooks', 'run', 'api', 'hooks/cleanup.yaml', ...extra);
      expect(refused.code, refused.err).toBe(EXIT.failure);
      expect(refused.err).toContain('destructive hook (shell rm) needs approval: add "confirm: true" to it, or pass --yes');
      expect(refused.err).toContain('refusing destructive hook (shell rm) without "confirm: true"');
      expect(existsSync(scratch)).toBe(true);
    }
    const dryYes = await cli('hooks', 'run', 'api', 'hooks/cleanup.yaml', '--dry', '--yes');
    expect(dryYes.code, dryYes.err).toBe(EXIT.ok);
    expect(existsSync(scratch)).toBe(true);
    const yes = await cli('hooks', 'run', 'api', 'hooks/cleanup.yaml', '--yes');
    expect(yes.code, yes.err).toBe(EXIT.ok);
    expect(yes.err).toContain('destructive hook (shell rm) approved without "confirm: true": cleanup: shell "rm -f scratch.txt"');
    expect(yes.err).toContain('cleanup: done');
    expect(existsSync(scratch)).toBe(false);
  });
});
