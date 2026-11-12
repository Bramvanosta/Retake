/**
 * L1.7 in the runner: the access of a run (a read-only run with writing hooks is refused before any browser opens,
 * `--allow-writes` on a read-only environment is refused before anything is recorded) and the environment blocks of
 * run.json and timeline.json (access, display table, clock).
 */
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessError, RunRecordSchema, TimelineSchema, applyProjectDefaults, zodIssues, PERSON_POLICY } from '@retake/core';
import type { LoadedProject, RunProgress, RunRecord, Scenario } from '@retake/core';
import { runScenario } from '../src/index.js';
import { FAST, makeProject, makeScenario, readTimeline, startServer, tempDir, testHookRunner } from './helpers.js';
import type { TestServer } from './helpers.js';

let server: TestServer;
let dir: string;

beforeAll(async () => {
  server = await startServer({ '/home.html': '<!doctype html><html><body><h1>Northfield</h1><button>Request a quote</button></body></html>' });
  dir = await tempDir('rw-access-');
});

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A project whose environments use the L1.7 forms (normalised as loadProject does). */
function project(): LoadedProject {
  const base = makeProject(dir, {});
  return {
    ...base,
    config: applyProjectDefaults({
      name: 'Northfield',
      environments: {
        local: { app: { url: server.url, display: 'app.northfield.example' } },
        production: { production: true, pages: { app: server.url } },
        live: { production: true, access: 'read-write', pages: { app: server.url } },
      },
      capture: base.config.capture,
      frame: 'raw',
      template: 'editorial',
      clock: '2026-11-02T10:24:00Z',
    }),
  };
}

const WRITING: Omit<Scenario, 'video'> = {
  pacing: FAST,
  setup: [{ name: 'reset', http: { method: 'POST', url: '{{app}}/api/reset' } }, { name: 'health', http: { url: '{{app}}/home.html' } }],
  teardown: [{ optional: true, shell: 'echo done' }],
  // A secret no environment holds: the refusal comes before the secrets are read.
  scenes: [{ id: 'home', page: 'app', open: '/home.html', steps: [{ type: { text: '{{env:RETAKE_L17_NOT_SET}}', into: { css: 'h1' } } }] }],
};

describe('a read-only run refuses its writing hooks before anything runs (R-ENV-04)', () => {
  it('fails at once, listing the hooks; no browser (an unusable executable is never launched), no secret, no hook', async () => {
    const events: RunProgress[] = [];
    const rec = await runScenario({ policy: PERSON_POLICY,
      project: project(),
      scenario: makeScenario('refused', WRITING),
      mode: 'capture',
      env: 'production',
      runId: `refused-${Date.now()}`,
      hookRunner: testHookRunner(),
      browser: { executable: '/nonexistent/chromium' },
      onProgress: (e) => events.push(e),
    });
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toBe(
      'environment production is production, read-only and 2 hooks write: setup hook 1 "reset" (HTTP POST), teardown hook 1 (a shell command — add `writes: false` to a shell hook that only reads) — nothing ran. ' +
        'Run with --hooks skip (no hooks), or run it on a read-write environment; `optional: true` does not skip a refusal',
    );
    expect(rec.environment).toEqual({ production: true, access: 'read-only', clock: { at: '2026-11-02T10:24:00Z' } });
    expect(rec.hooks).toEqual({ setup: 'none', teardown: 'none' });
    expect(existsSync(join(rec.dir, 'hooks-journal.json'))).toBe(false);
    expect(events.some((e) => e.type === 'hook')).toBe(false);
    const saved = JSON.parse(await readFile(join(rec.dir, 'run.json'), 'utf8')) as RunRecord;
    expect(zodIssues(RunRecordSchema, saved)).toEqual([]);
    expect(saved.environment).toEqual(rec.environment);
  });

  it('production that allows writes: a notice, then the same refusal without --allow-writes', async () => {
    const events: RunProgress[] = [];
    const rec = await runScenario({ policy: PERSON_POLICY,
      project: project(),
      scenario: makeScenario('live-refused', WRITING),
      mode: 'capture',
      env: 'live',
      runId: `live-refused-${Date.now()}`,
      hookRunner: testHookRunner(),
      browser: { executable: '/nonexistent/chromium' },
      onProgress: (e) => events.push(e),
    });
    expect(rec.error?.message).toMatch(/^environment live is production, read-only without --allow-writes and 2 hooks write: .* or pass --allow-writes to write to production;/);
    expect(events).toContainEqual(expect.objectContaining({ type: 'log', level: 'warn', message: expect.stringContaining('environment live is production and project.yaml allows writes (access: read-write), but this run is read-only') }));
  });

  it('--hooks skip runs no hook, so nothing is refused (here the browser launch fails instead)', async () => {
    const rec = await runScenario({ policy: PERSON_POLICY,
      project: project(),
      scenario: makeScenario('skipped', { ...WRITING, scenes: [{ id: 'home', page: 'app', open: '/home.html', steps: [{ wait: 0.1 }] }] }),
      mode: 'dry',
      env: 'production',
      hooks: 'skip',
      runId: `skipped-${Date.now()}`,
      browser: { executable: '/nonexistent/chromium' },
    });
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).not.toMatch(/nothing ran/);
    expect(rec.hooks).toEqual({ setup: 'none', teardown: 'none' });
  });

  it('--allow-writes on a read-only environment throws before a run folder exists; on live it makes the run read-write', async () => {
    const runId = `flag-${Date.now()}`;
    await expect(
      runScenario({ policy: PERSON_POLICY, project: project(), scenario: makeScenario('flag', WRITING), mode: 'capture', env: 'production', runId, allowWrites: true, hookRunner: testHookRunner() }),
    ).rejects.toThrow(AccessError);
    expect(existsSync(join(dir, 'runs', runId))).toBe(false);

    const events: RunProgress[] = [];
    const rec = await runScenario({ policy: PERSON_POLICY,
      project: project(),
      scenario: makeScenario('flag-live', { ...WRITING, setup: [], teardown: [] }),
      mode: 'dry',
      env: 'live',
      allowWrites: true,
      runId: `flag-live-${Date.now()}`,
      browser: { executable: '/nonexistent/chromium' },
      onProgress: (e) => events.push(e),
    });
    expect(rec.options.allow_writes).toBe(true);
    expect(rec.environment).toMatchObject({ production: true, access: 'read-write' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'log', level: 'warn', message: 'writes go to production: environment live runs read-write (--allow-writes)' }));
  });
});

describe('environment blocks of the run files (R-ENV-01/02/05 data)', () => {
  it('timeline.environment holds the access, the display table and the clock; URLs elsewhere stay real', async () => {
    const rec = await runScenario({ policy: PERSON_POLICY,
      project: project(),
      scenario: makeScenario('blocks', { pacing: FAST, scenes: [{ id: 'home', page: 'app', open: '/home.html', steps: [{ hover: { text: 'Request a quote' } }] }] }),
      mode: 'dry',
      env: 'local',
      runId: `blocks-${Date.now()}`,
    });
    expect(rec.status, rec.error?.message).toBe('succeeded');
    expect(rec.environment).toEqual({ access: 'read-write', clock: { at: '2026-11-02T10:24:00Z' } });
    expect(rec.options.allow_writes).toBeUndefined();
    const tl = await readTimeline(rec.timeline!);
    expect(zodIssues(TimelineSchema, tl)).toEqual([]);
    expect(tl.environment).toEqual({
      name: 'local',
      access: 'read-write',
      display: [{ page: 'app', url: server.url.replace(/\/$/, ''), display: 'https://app.northfield.example' }],
      clock: { at: '2026-11-02T10:24:00Z', epoch_ms: Date.UTC(2026, 10, 2, 10, 24) },
    });
    expect(tl.scenes[0].url ?? tl.pages[0]?.url).toContain(new URL(server.url).host);
  });
});
