/**
 * `retake prune` (L5.7, R-FLD-28): lists what the project's runs/, renders/ and review/ hold that nothing needs, with
 * how much it frees, and deletes it with --yes; a run a queued job names stays.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine } from '@retake/engine';
import { EXIT, main, memoryIo } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';

let ws: string;
let runs: string;

async function retake(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', ws, '--no-color', ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-prune-cli-'));
  await fixtureWorkspace(ws);
  runs = join(ws, 'projects', 'northfield-fixture', 'runs');
  // An older capture of catalogue nothing uses (the workspace's own one, 20261016-090000, is the last good take).
  const old = join(runs, '20261015-090000-catalogue');
  await mkdir(old, { recursive: true });
  await writeFile(join(old, 'capture.mp4'), Buffer.alloc(2_000_000));
  await writeFile(
    join(old, 'run.json'),
    JSON.stringify({
      id: '20261015-090000-catalogue',
      project: 'northfield-fixture',
      scenario: 'catalogue',
      mode: 'capture',
      status: 'succeeded',
      started_at: '2026-10-15T07:00:00.000Z',
      dir: old,
      env: 'local',
      options: { hooks: 'run', headed: false },
      steps_total: 1,
      steps_done: 1,
      screenshots: [],
      hooks: { setup: 'ok', teardown: 'ok' },
      warnings: [],
    }),
  );
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('retake prune', () => {
  it('lists what would go and how much it frees; --yes deletes it; a run a queued job names stays', async () => {
    const dry = await retake('prune', 'northfield-fixture');
    expect(dry.code, dry.err).toBe(EXIT.ok);
    expect(dry.err).toMatch(/would delete +run +20261015-090000-catalogue +older capture nothing uses · 2 MB/);
    expect(dry.err).toMatch(/would delete +run +20261017-120000-quote +dry run/);
    expect(dry.err).toMatch(/2 items \(2 MB\) can go; kept: 1 take, 0 renders \(the last 3 per scenario\), 0 reviews — retake prune northfield-fixture --yes deletes them/);
    expect(existsSync(join(runs, '20261015-090000-catalogue'))).toBe(true);

    // A queued dry run of quote: its run folder is reserved — never pruned while the job waits.
    const engine = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
    const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'quote', mode: 'dry' });
    await mkdir(join(runs, sub.run_id), { recursive: true });
    await writeFile(
      join(runs, sub.run_id, 'run.json'),
      JSON.stringify({
        id: sub.run_id,
        project: 'northfield-fixture',
        scenario: 'quote',
        mode: 'dry',
        status: 'failed',
        started_at: '2026-10-26T10:00:00.000Z',
        dir: join(runs, sub.run_id),
        env: 'local',
        options: { hooks: 'skip', headed: false },
        steps_total: 1,
        steps_done: 0,
        screenshots: [],
        hooks: { setup: 'none', teardown: 'none' },
        warnings: [],
      }),
    );
    const json = JSON.parse((await retake('prune', 'northfield-fixture', '--json')).out) as { items: Array<{ id: string }>; dry_run: boolean };
    expect(json.dry_run).toBe(true);
    expect(json.items.map((i) => i.id)).not.toContain(sub.run_id);

    const yes = await retake('prune', 'northfield-fixture', '--yes');
    expect(yes.code, yes.err).toBe(EXIT.ok);
    expect(yes.err).toMatch(/✓ 2 items \(2 MB\) deleted/);
    expect(existsSync(join(runs, '20261015-090000-catalogue'))).toBe(false);
    expect(existsSync(join(runs, '20261017-120000-quote'))).toBe(false);
    expect(existsSync(join(runs, '20261016-090000-catalogue'))).toBe(true);
    expect(existsSync(join(runs, sub.run_id))).toBe(true);
    expect((await retake('prune', 'northfield-fixture')).err).toMatch(/nothing to prune in northfield-fixture/);
    expect((await retake('prune', 'northfield-fixture', '--keep-renders', '0')).code).toBe(EXIT.usage);
  });

  it('comment threads that cannot be read: what they may name stays, and a warning says so, with or without something to prune (L7.5)', async () => {
    const project = join(ws, 'projects', 'northfield-fixture');
    const dry = join(runs, '20261018-090000-quote');
    await mkdir(dry, { recursive: true });
    await writeFile(
      join(dry, 'run.json'),
      JSON.stringify({
        id: '20261018-090000-quote',
        project: 'northfield-fixture',
        scenario: 'quote',
        mode: 'dry',
        status: 'succeeded',
        started_at: '2026-10-18T07:00:00.000Z',
        dir: dry,
        env: 'local',
        options: { hooks: 'skip', headed: false },
        steps_total: 1,
        steps_done: 1,
        screenshots: [],
        hooks: { setup: 'none', teardown: 'none' },
        warnings: [],
      }),
    );
    expect((await retake('prune', 'northfield-fixture')).err).toMatch(/would delete +run +20261018-090000-quote +dry run/);
    // A thread file of quote that is not JSON: the dry run of quote stays.
    await mkdir(join(project, 'comments', 'quote'), { recursive: true });
    await writeFile(join(project, 'comments', 'quote', 'c_01K8AB1CDE2FGH3JKM4NPQ5RST.json'), '{');
    const sentence = 'some comment threads of northfield-fixture cannot be read (the comment list says which): every render and take of quote is kept';
    const nothing = await retake('prune', 'northfield-fixture');
    expect(nothing.code, nothing.err).toBe(EXIT.ok);
    expect(nothing.err).toMatch(/nothing to prune in northfield-fixture/);
    expect(nothing.err).toContain(`! ${sentence}`);
    // With something else to prune (an older capture of catalogue): listed, and the warning still shown; --yes keeps quote's.
    const old = join(runs, '20261014-090000-catalogue');
    await mkdir(old, { recursive: true });
    await writeFile(
      join(old, 'run.json'),
      JSON.stringify({
        id: '20261014-090000-catalogue',
        project: 'northfield-fixture',
        scenario: 'catalogue',
        mode: 'capture',
        status: 'succeeded',
        started_at: '2026-10-14T07:00:00.000Z',
        dir: old,
        env: 'local',
        options: { hooks: 'run', headed: false },
        steps_total: 1,
        steps_done: 1,
        screenshots: [],
        hooks: { setup: 'ok', teardown: 'ok' },
        warnings: [],
      }),
    );
    const some = await retake('prune', 'northfield-fixture');
    expect(some.err).toMatch(/would delete +run +20261014-090000-catalogue/);
    expect(some.err).not.toMatch(/20261018-090000-quote/);
    expect(some.err).toContain(`! ${sentence}`);
    const json = JSON.parse((await retake('prune', 'northfield-fixture', '--json')).out) as { threads_unread?: string };
    expect(json.threads_unread).toBe(sentence);
    const yes = await retake('prune', 'northfield-fixture', '--yes');
    expect(yes.code, yes.err).toBe(EXIT.ok);
    expect(yes.err).toContain(`! ${sentence}`);
    expect([existsSync(old), existsSync(dry)]).toEqual([false, true]);
    // The file removed: no warning, and the dry run can go.
    await rm(join(project, 'comments'), { recursive: true });
    const after = await retake('prune', 'northfield-fixture');
    expect(after.err).not.toContain('cannot be read');
    expect(after.err).toMatch(/would delete +run +20261018-090000-quote/);
  });
});
