/**
 * A client's mistake is told as one: the engine's refusals of a wrong input (a job of another kind, a keep count below
 * one, a run id that is none, a headed run without a display) are EngineErrors of their kind, never `internal` — so the
 * MCP client reads the right code, the Studio's HTTP answer the right status, and the CLI prints the one line without
 * the "unexpected error" stack.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorKindOf } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import { scratchHome } from '@retake/test-support/home';
import { ERROR_STATUS, EngineError, checkHeadedDisplay, openLiveChannel, pruneProject, toEngineError } from '../src/index.js';
import type { Engine, JobRecord } from '../src/index.js';
import { recordOutput } from '../src/operations/authoring.js';
import { inspectOutput } from '../src/operations/inspect.js';
import { siteOutput } from '../src/operations/themes.js';

const root = await mkdtemp(join(tmpdir(), 'retake-client-mistakes-'));
const home = scratchHome();
beforeAll(() => home.use(join(root, '.home')));
afterAll(async () => {
  home.restore();
  await rm(root, { recursive: true, force: true });
});

/** The refusal `work` throws: its code, its HTTP status, and whether it states its kind (the CLI's known error: one line, no stack). */
async function refusal(work: () => Promise<unknown>): Promise<{ code: string; status: number; known: boolean; message: string }> {
  try {
    await work();
  } catch (e) {
    const ee = toEngineError(e);
    return { code: ee.code, status: ERROR_STATUS[ee.code], known: errorKindOf(e) !== undefined && e instanceof EngineError, message: ee.message };
  }
  throw new Error('no refusal');
}

const job = (kind: string) => ({ id: 'j_test', state: 'succeeded', input: { kind } }) as unknown as JobRecord;
const engine = {} as Engine;

describe('client mistakes are refusals of their kind, not internal', () => {
  it('a job of another kind shown as a recording, an inspection or a site extraction: invalid (400)', async () => {
    expect(await refusal(() => recordOutput(engine, job('run')))).toEqual({ code: 'invalid', status: 400, known: true, message: 'job j_test is not a recording' });
    expect(await refusal(() => inspectOutput(engine, job('run')))).toEqual({ code: 'invalid', status: 400, known: true, message: 'job j_test is not an inspection' });
    expect(await refusal(() => siteOutput(engine, job('run')))).toEqual({ code: 'invalid', status: 400, known: true, message: 'job j_test is not a site extraction' });
  });

  it('keep_renders below one: invalid (400), before anything is read', async () => {
    const project = { slug: 'p', dir: join(root, 'nowhere'), config: { name: 'P', environments: {} } } as unknown as LoadedProject;
    for (const keep of [0, 1.5, -1])
      expect(await refusal(() => pruneProject(project, { keep_renders: keep }))).toEqual({ code: 'invalid', status: 400, known: true, message: `keep_renders ${keep}: a whole number from 1` });
  });

  it('a live channel for what is not a run id: invalid (400)', async () => {
    const r = await refusal(() => openLiveChannel({ files: { live: () => join(root, 'never.json') }, jobId: 'j_test', runId: 'a/b', worker: { pid: process.pid, started: '' } as never }));
    expect(r).toEqual({ code: 'invalid', status: 400, known: true, message: 'invalid run id "a/b"' });
  });

  it('a headed run where no display is available: unavailable (503), the display variables named', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    try {
      expect(await refusal(async () => checkHeadedDisplay({ headed: true }, {}))).toEqual({
        code: 'unavailable',
        status: 503,
        known: true,
        message: '--headed needs a display, and none is available (DISPLAY / WAYLAND_DISPLAY are not set)',
      });
      expect(() => checkHeadedDisplay({ headed: true }, { DISPLAY: ':0' })).not.toThrow();
      expect(() => checkHeadedDisplay({ headed: false }, {})).not.toThrow();
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
