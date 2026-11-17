/**
 * RunFiles (runner-web runfiles.ts) writes run.json and the record log.jsonl's run_start / run_end carry by the rule of
 * core record-paths.ts (R-SHR-01): relative to the run folder inside the project — `dir` "." — and absolute when the
 * run folder lies outside the project folder. The record it holds stays absolute (what the runner hands back).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { finishRun, parseRunId, startedRun } from '@retake/core';
import type { RunningRun } from '@retake/core';
import { RunFiles } from '../src/runfiles.js';

const scratch = mkdtempSync(join(tmpdir(), 'retake-runfiles-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function running(dir: string): RunningRun {
  return startedRun({
    version: 1,
    id: parseRunId('20261101-090000-quote')!,
    project: 'demo',
    scenario: 'quote',
    mode: 'capture',
    started_at: '2026-11-01T09:00:00.000Z',
    dir,
    env: 'local',
    options: { hooks: 'run', headed: false },
    steps_total: 1,
    steps_done: 0,
    screenshots: [join(dir, 'screenshots', '1.png')],
    hooks: { setup: 'none', teardown: 'none' },
    warnings: [],
  });
}

async function write(project: string, dir: string): Promise<{ disk: Record<string, unknown>; log: Array<{ type: string; run?: Record<string, unknown> }>; held: RunningRun }> {
  mkdirSync(dir, { recursive: true });
  const record = running(dir);
  const files = new RunFiles(dir, record, project);
  files.progress({ type: 'run_start', run: { ...record } });
  record.capture = join(dir, 'capture.mp4');
  record.timeline = join(dir, 'timeline.json');
  const done = finishRun(record, { status: 'failed', at: '2026-11-01T09:01:00.000Z', warnings: [], error: { message: 'x', screenshot: join(dir, 'screenshots', 'error-a-1.png'), dom: join(dir, 'screenshots', 'error-a-1.html') } });
  files.finish(done);
  files.progress({ type: 'run_end', run: { ...done } });
  await files.close();
  const disk = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as Record<string, unknown>;
  const log = readFileSync(join(dir, 'log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string; run?: Record<string, unknown> });
  return { disk, log, held: record };
}

describe('RunFiles: the paths of run.json and log.jsonl', () => {
  it('inside the project: `dir` ".", every path relative to the run folder; the record held stays absolute', async () => {
    const project = join(scratch, 'ws/projects/demo');
    const dir = join(project, 'runs/20261101-090000-quote');
    const { disk, log, held } = await write(project, dir);
    expect(disk).toMatchObject({ dir: '.', screenshots: ['screenshots/1.png'], capture: 'capture.mp4', timeline: 'timeline.json', error: { screenshot: 'screenshots/error-a-1.png', dom: 'screenshots/error-a-1.html' } });
    expect(JSON.stringify(disk)).not.toContain(scratch);
    // log.jsonl: the record of run_start and run_end, the same rule.
    expect(log.map((l) => [l.type, l.run?.dir, l.run?.screenshots])).toEqual([
      ['run_start', '.', ['screenshots/1.png']],
      ['run_end', '.', ['screenshots/1.png']],
    ]);
    expect(log[1]!.run).toMatchObject({ capture: 'capture.mp4', error: { dom: 'screenshots/error-a-1.html' } });
    expect(held.dir).toBe(dir);
    expect(held.capture).toBe(join(dir, 'capture.mp4'));
  });

  it('a run folder outside the project folder: every path absolute, as before', async () => {
    const dir = join(scratch, 'elsewhere/runs/20261101-090000-quote');
    const { disk, log } = await write(join(scratch, 'ws/projects/other'), dir);
    expect(disk).toMatchObject({ dir, capture: join(dir, 'capture.mp4'), screenshots: [join(dir, 'screenshots', '1.png')] });
    expect(log[0]!.run?.dir).toBe(dir);
  });
});
