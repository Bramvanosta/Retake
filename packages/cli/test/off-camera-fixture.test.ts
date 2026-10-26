/**
 * L5.8 acceptance cases on the fixture product (R-FLD-30, R-FLD-31, R-FLD-33): the committed `off-camera` scenario and
 * variants of it, run through the `studio` CLI against the fixture on free ports (environment `local`) —
 *
 * - a capture: the `hook:` step mid-take makes a café's quote request arrive (an http entry, then a shell one) during
 *   the take, its span is cut from the edit, the `offscreen` scene is played (the console reached its list) but left
 *   out, and `offscreen` toggles on the same take (edit only);
 * - a project.yaml hook with a rollback, undone after the teardown; a failing entry failing its step; a dry run without
 *   hooks skipping the step;
 * - the page pre-flight: a page that does not answer stops the take before anything runs, naming the page and its URL;
 * - `studio doctor --project` pointing to a sandbox.
 *
 * Skipped when Chromium is not available.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunRecordSchema, TimelineSchema } from '@demo-studio/core';
import type { RunProgress, RunRecord, Timeline } from '@demo-studio/core';
import { main, memoryIo } from '../src/index.js';

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

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

let fixture: Fixture;
let ws: string;
let committed: string;
const QUICK = 'pacing: {scene_start_still: 0.2, after_click_ms: 120, after_popup_ms: 350, after_navigation_ms: 500, settle_ms: 800, move_max_ms: 450}\n';

async function studio(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'studio', '--root', ws, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

/** Run a variant of the committed scenario; its run record and timeline. */
async function variant(name: string, edit: (yaml: string) => string, ...flags: string[]): Promise<{ run: RunRecord; tl: Timeline | null }> {
  await writeFile(join(ws, 'projects', 'fx', 'scenarios', `${name}.yaml`), `${edit(committed)}\n${QUICK}`);
  const r = await studio('run', 'fx', name, '--json', ...flags);
  const end = JSON.parse(r.out.trim().split('\n').pop()!) as RunProgress;
  expect(end.type, r.err).toBe('run_end');
  const run = (end as { run: RunRecord }).run;
  const tl = run.timeline ? (JSON.parse(await readFile(run.timeline, 'utf8')) as Timeline) : null;
  return { run, tl };
}

/** The scenario without its last scene (the "New" highlight it clicks lasts a few seconds: dry runs take longer). */
const noAnswer = (y: string) => y.slice(0, y.indexOf('  - id: answer'));

/** A port nothing listens on (bound, then released). */
async function deadPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((res) => srv.close(() => res()));
  return port;
}

describe.skipIf(!chromiumAvailable())('off camera on the fixture (L5.8)', () => {
  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
      startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture>;
    };
    fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
    ws = await mkdtemp(join(tmpdir(), 'studio-off-camera-'));
    await writeFile(join(ws, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    const project = join(ws, 'projects', 'fx');
    await mkdir(join(project, 'scenarios'), { recursive: true });
    await writeFile(
      join(project, 'project.yaml'),
      [
        'name: FX',
        'environments:',
        `  local: {console: ${fixture.urls.console}, shop: ${fixture.urls.shop}}`,
        `  moved: {console: "http://127.0.0.1:${await deadPort()}", shop: ${fixture.urls.shop}}`,
        'capture: {width: 1280, height: 800, scale: 1, fps: 30}',
        'template: default',
        `mailbox: {provider: mailpit, url: "${fixture.urls.console}/mailbox"}`,
        // A shared named hook, with a rollback (journaled like a setup hook's, undone after the teardown).
        'hooks:',
        '  arm-proposal:',
        '    http:',
        '      method: POST',
        '      url: "{{console}}/api/quotes/auto-proposal"',
        '      json: {after_minutes: 30}',
        '      rollback: {method: DELETE, url: "{{console}}/api/quotes/auto-proposal"}',
        '',
      ].join('\n'),
    );
    committed = await readFile(join(REPO, 'projects/northfield-fixture/scenarios/off-camera.yaml'), 'utf8');
  });

  afterAll(async () => {
    await fixture?.close();
    if (ws) await rm(ws, { recursive: true, force: true });
  });

  it('a capture: the hook step makes the request arrive during the take, its span and the offscreen scene are left out of the edit', async () => {
    const { run, tl } = await variant('off-camera', (y) => y);
    expect(run.error?.message ?? '').toBe('');
    expect(run.status).toBe('succeeded');
    expect(run.hooks).toEqual({ setup: 'ok', teardown: 'ok', steps: 'ok' });
    const hook = tl!.events.find((e) => e.action === 'hook')!;
    expect(hook).toMatchObject({ scene: 'requests', step: 2, status: 'ok', data: { hook: 'cafe-requests-a-quote', results: ['request: 201 Created', 'queue: exit 0'] } });
    // The shell entry sleeps 1.5 s: the step's span is the hook's.
    expect(hook.t_end - hook.t_start).toBeGreaterThan(1.4);
    // The request arrived while the take went on: the next step saw the row "New".
    expect(tl!.events.find((e) => e.scene === 'requests' && e.step === 3)).toMatchObject({ action: 'wait_for', status: 'ok' });
    expect(tl!.scenes.find((s) => s.id === 'to-the-list')).toMatchObject({ offscreen: true, status: 'ok' });
    // Both files keep to their published schemas (the new fields included).
    expect(TimelineSchema.safeParse(tl).error?.issues ?? []).toEqual([]);
    expect(RunRecordSchema.safeParse(JSON.parse(await readFile(join(run.dir, 'run.json'), 'utf8'))).error?.issues ?? []).toEqual([]);

    const planned = await studio('plan', 'fx', run.id, '--scenario', 'off-camera', '--json');
    expect(planned.code, planned.err).toBe(0);
    const plan = JSON.parse(planned.out) as { segments: Array<{ id: string; kind: string; trims?: Array<{ src_from_s: number; src_to_s: number }> }>; notes: string[] };
    expect(plan.segments.map((s) => s.id)).not.toContain('to-the-list');
    const requests = plan.segments.find((s) => s.id === 'requests')!;
    expect(requests.trims).toEqual(expect.arrayContaining([{ at: expect.any(Number), src_from_s: expect.closeTo(hook.t_start, 1), src_to_s: expect.closeTo(hook.t_end, 1) }]));
    expect(plan.notes).toContain('scene "to-the-list" was played off camera (offscreen: true): not in the edit');

    // `offscreen` is edit: removed from today's file, the same take plans the scene as a clip (no scenario_changed).
    await writeFile(join(ws, 'projects', 'fx', 'scenarios', 'off-camera.yaml'), `${committed.replace('    offscreen: true\n', '')}\n${QUICK}`);
    const again = await studio('plan', 'fx', run.id, '--scenario', 'off-camera', '--json');
    expect(again.code, again.err).toBe(0);
    expect(again.err).not.toMatch(/filmed part/);
    expect((JSON.parse(again.out) as { segments: Array<{ id: string }> }).segments.map((s) => s.id)).toContain('to-the-list');
  }, 180_000);

  it('a project.yaml hook with a rollback is undone after the teardown; a failing entry fails its step; a dry run without hooks skips it', async () => {
    // Armed after the request arrived (an armed proposal would answer the request at once: no row "New").
    const shared = await variant('shared', (y) => noAnswer(y).replace('      - hold: 1.4\n', '      - hold: 1.4\n      - hook: arm-proposal\n'), '--dry', '--hooks', 'run');
    expect(shared.run.status, shared.run.error?.message).toBe('succeeded');
    const journal = JSON.parse(await readFile(join(shared.run.dir, 'hooks-journal.json'), 'utf8')) as { entries: Array<{ name: string; phase: string; status: string }> };
    expect(journal.entries.filter((e) => e.phase === 'step').map((e) => [e.name, e.status])).toEqual([
      ['request', 'ok'],
      ['queue', 'ok'],
      ['arm-proposal', 'rolled_back'],
    ]);

    const failing = await variant('failing', (y) => y.replace('      shell: "sleep 1.5"', '      shell: "echo no queue >&2; exit 4"'), '--dry', '--hooks', 'run');
    expect(failing.run.status).toBe('failed');
    expect(failing.run.error).toMatchObject({ scene: 'requests', step: 2, action: 'hook' });
    expect(failing.run.error!.message).toMatch(/hook "cafe-requests-a-quote" failed \(queue: .*exit 4/);
    expect(failing.run.hooks).toMatchObject({ steps: 'failed', teardown: 'ok' });

    const skipped = await variant('skipped', (y) => noAnswer(y).replace('      - wait_for: {text: New}\n        mark: arrived\n', ''), '--dry');
    expect(skipped.run.status, skipped.run.error?.message).toBe('succeeded');
    expect(skipped.run.hooks.steps).toBe('skipped');
    expect(skipped.tl!.events.find((e) => e.action === 'hook')!.data).toEqual({ hook: 'cafe-requests-a-quote', skipped: true });
  }, 180_000);

  it('the page pre-flight: a page that does not answer stops the take before anything runs, naming the page and its URL', async () => {
    const { run, tl } = await variant('moved', (y) => y.replace('version: 1\n', 'version: 1\nenv: moved\n'));
    expect(run.status).toBe('failed');
    expect(run.steps_done).toBe(0);
    expect(run.error!.message).toMatch(/^environment moved: a page does not answer — page console \(http:\/\/127\.0\.0\.1:\d+\): connection refused \(nothing listens on that port\)\. Nothing was filmed/);
    // No hook ran (the setup's reset would show in the fixture), no capture.
    expect(run.hooks.setup).toBe('none');
    expect(tl?.capture?.frames ?? 0).toBe(0);
  }, 60_000);

  it('studio doctor --project points to a sandbox for a local environment with a mailbox and no sandbox', async () => {
    const r = await studio('doctor', '--project', 'fx', '--json');
    const checks = (JSON.parse(r.out) as { checks: Array<{ status: string; name: string; detail: string; hint?: string }> }).checks;
    expect(checks.find((c) => c.name === 'Sandbox')).toEqual({
      status: 'warn',
      name: 'Sandbox',
      detail: 'none — environment local films this machine with the mailbox: each take starts from whatever the last one (or a hand-made reset) left',
      hint: expect.stringMatching(/studio( -C \S+)? sandbox init fx writes a sandbox\.yaml to fill in/),
    });
  }, 60_000);
});
