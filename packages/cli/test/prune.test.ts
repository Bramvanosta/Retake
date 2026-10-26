/**
 * `studio prune` (L5.7, R-FLD-28): lists what the project's runs/, renders/ and review/ hold that nothing needs, with
 * how much it frees, and deletes it with --yes; a run a queued job names stays.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine } from '@demo-studio/engine';
import { EXIT, main, memoryIo } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';

let ws: string;
let runs: string;

async function studio(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'studio', '--root', ws, '--no-color', ...args], io);
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
    JSON.stringify({ id: '20261015-090000-catalogue', project: 'northfield-fixture', scenario: 'catalogue', mode: 'capture', status: 'succeeded', started_at: '2026-10-15T07:00:00.000Z', dir: old, env: 'local', options: { hooks: 'run', headed: false }, steps_total: 1, steps_done: 1, screenshots: [], hooks: { setup: 'ok', teardown: 'ok' }, warnings: [] }),
  );
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('studio prune', () => {
  it('lists what would go and how much it frees; --yes deletes it; a run a queued job names stays', async () => {
    const dry = await studio('prune', 'northfield-fixture');
    expect(dry.code, dry.err).toBe(EXIT.ok);
    expect(dry.err).toMatch(/would delete +run +20261015-090000-catalogue +older capture nothing uses · 2 MB/);
    expect(dry.err).toMatch(/would delete +run +20261017-120000-quote +dry run/);
    expect(dry.err).toMatch(/2 items \(2 MB\) can go; kept: 1 take, 0 renders \(the last 3 per scenario\), 0 reviews — studio prune northfield-fixture --yes deletes them/);
    expect(existsSync(join(runs, '20261015-090000-catalogue'))).toBe(true);

    // A queued dry run of quote: its run folder is reserved — never pruned while the job waits.
    const engine = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
    const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'quote', mode: 'dry' });
    await mkdir(join(runs, sub.run_id), { recursive: true });
    await writeFile(join(runs, sub.run_id, 'run.json'), JSON.stringify({ id: sub.run_id, project: 'northfield-fixture', scenario: 'quote', mode: 'dry', status: 'failed', started_at: '2026-10-26T10:00:00.000Z', dir: join(runs, sub.run_id), env: 'local', options: { hooks: 'skip', headed: false }, steps_total: 1, steps_done: 0, screenshots: [], hooks: { setup: 'none', teardown: 'none' }, warnings: [] }));
    const json = JSON.parse((await studio('prune', 'northfield-fixture', '--json')).out) as { items: Array<{ id: string }>; dry_run: boolean };
    expect(json.dry_run).toBe(true);
    expect(json.items.map((i) => i.id)).not.toContain(sub.run_id);

    const yes = await studio('prune', 'northfield-fixture', '--yes');
    expect(yes.code, yes.err).toBe(EXIT.ok);
    expect(yes.err).toMatch(/✓ 2 items \(2 MB\) deleted/);
    expect(existsSync(join(runs, '20261015-090000-catalogue'))).toBe(false);
    expect(existsSync(join(runs, '20261017-120000-quote'))).toBe(false);
    expect(existsSync(join(runs, '20261016-090000-catalogue'))).toBe(true);
    expect(existsSync(join(runs, sub.run_id))).toBe(true);
    expect((await studio('prune', 'northfield-fixture')).err).toMatch(/nothing to prune in northfield-fixture/);
    expect((await studio('prune', 'northfield-fixture', '--keep-renders', '0')).code).toBe(EXIT.usage);
  });
});
