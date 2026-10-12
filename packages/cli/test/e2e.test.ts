/**
 * End to end: the bundled fixture product on free ports, a short scenario run through the `studio` CLI entry
 * (capture mode, real setup/teardown hooks), then capture.mp4 + timeline.json checked for consistency.
 * Skipped when Chromium or ffmpeg is not available.
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunRecordSchema, TimelineSchema } from '@demo-studio/core';
import type { RunProgress, RunRecord, Timeline, TimelineEvent } from '@demo-studio/core';
import { EXIT, main, memoryIo } from '../src/index.js';

const execFileP = promisify(execFile);
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

function chromiumAvailable(): boolean {
  if (process.env.DEMO_STUDIO_CHROMIUM) return existsSync(process.env.DEMO_STUDIO_CHROMIUM);
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

async function studio(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'studio', '--root', ws, ...args], io);
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

describe.skipIf(!AVAILABLE)('studio run (fixture product, headless capture)', () => {
  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
      startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture>;
    };
    fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
    ws = await mkdtemp(join(tmpdir(), 'studio-e2e-'));
    await writeFile(join(ws, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
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
    const r = await studio('validate', 'e2e', 'short');
    expect(r.code, r.err).toBe(EXIT.ok);
  });

  it('captures capture.mp4 + timeline.json that agree with each other', async () => {
    const r = await studio('run', 'e2e', 'short', '--json');
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
    const tl = TimelineSchema.parse(JSON.parse(await readFile(join(run.dir, 'timeline.json'), 'utf8'))) as Timeline;

    // Video and timeline agree: duration, size, frame rate.
    const probe = JSON.parse(
      (await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,avg_frame_rate', '-of', 'json', run.capture!])).stdout,
    ) as { format: { duration: string }; streams: Array<{ width: number; height: number; avg_frame_rate: string }> };
    expect(probe.streams[0]).toMatchObject({ width: 1280, height: 720, avg_frame_rate: '30/1' });
    expect(Math.abs(Number(probe.format.duration) - tl.capture.duration)).toBeLessThanOrEqual(1 / 30 + 0.001);
    expect(tl.capture.frames).toBeGreaterThan(10);
    expect(tl.cursor.length).toBeGreaterThan(10);
    expect(tl.warnings.filter((w) => !w.includes('captured below'))).toEqual([]);

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

    // The setup rollback ran after the teardown: nothing is left pending for `studio env reset`.
    const journal = JSON.parse(await readFile(join(run.dir, 'hooks-journal.json'), 'utf8')) as { entries: Array<{ status: string; rollback?: unknown }> };
    expect(journal.entries.filter((x) => x.status === 'ok' && x.rollback)).toEqual([]);
    expect((await studio('hooks', 'rollback', 'e2e')).err).toContain('no pending rollbacks');
  });

  it('runs js hooks in a headless page of the environment', async () => {
    const file = join(ws, 'projects', 'e2e', 'hooks', 'title.yaml');
    await mkdir(join(ws, 'projects', 'e2e', 'hooks'), { recursive: true });
    await writeFile(file, '- name: title\n  js: {code: "if (!document.title.includes(\'Northfield\')) throw new Error(document.title)", page: console}\n');
    const r = await studio('hooks', 'run', 'e2e', 'hooks/title.yaml');
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.err).toContain('title: done');
  });

  it('dry-runs up to a step with a screenshot per step', async () => {
    const r = await studio('run', 'e2e', 'short', '--dry', '--until', 'import.1');
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.err).toContain('dry run succeeded');
    const runs = (await readdir(join(ws, 'projects', 'e2e', 'runs'))).sort();
    const record = JSON.parse(await readFile(join(ws, 'projects', 'e2e', 'runs', runs[runs.length - 1], 'run.json'), 'utf8')) as RunRecord;
    expect(record.mode).toBe('dry');
    expect(record.stopped_at).toEqual({ scene: 'import', step: 1, reason: 'until' });
    expect(record.screenshots).toHaveLength(2);
    expect(record.capture).toBeUndefined();
  });

  it('run --raw --json: JSON lines only — the RunProgress events, then one raw_export line with the manifest', async () => {
    const out = join(ws, 'raw-pkg');
    const r = await studio('run', 'e2e', 'short', '--raw', '--cursor', 'none', '--json', '--out', out);
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
    expect(last.manifest).toMatchObject({ kind: 'demo-studio/raw-capture', run: { cursor: 'hidden' } });
    expect(last.manifest.clips.map((c) => c.file)).toEqual(['clips/01-import.mp4']);
    expect(existsSync(join(out, 'manifest.json'))).toBe(true);
  });
});

describe('studio hooks run / hooks rollback / env reset (fixture API)', () => {
  let api: Fixture;
  let root: string;

  async function cli(...args: string[]) {
    const io = memoryIo();
    const code = await main(['node', 'studio', '--root', root, ...args], io);
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
      `name: API\nenvironments:\n  local:\n    console: ${api.urls.console}\nreset:\n  - name: reset\n    http: {method: POST, url: "{{console}}/api/reset"}\n`,
    );
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
    const runId = /studio hooks rollback api (\S+)\)/.exec(run.err)?.[1];
    expect(runId, run.err).toBeTruthy();

    // R-ISS-06: the journal lives in .demo-studio/journals/, never in a run-looking folder of runs/.
    const journals = join(root, 'projects', 'api', '.demo-studio', 'journals');
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
    // R-ISS-06: hooks run + env reset journals are all under .demo-studio/journals/; runs/ stays empty.
    const journals = await readdir(join(root, 'projects', 'api', '.demo-studio', 'journals'));
    expect(journals.some((f) => /-env-reset\.json$/.test(f))).toBe(true);
    expect(journals.every((f) => f.endsWith('.json'))).toBe(true);
    expect(existsSync(join(root, 'projects', 'api', 'runs'))).toBe(false);
  });
});
