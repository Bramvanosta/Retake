/**
 * L5.11a: the status bar's read over HTTP — `scenario_actions` behind the gate: in the `ui` allow-list (a Studio read,
 * not an MCP tool), its input pinned (a strict object: project slug, scenario name, an environment name — refused before
 * any read), its answer path-free but the blockers' commands (`fix`, `fix_node`: the commands a person types), the
 * blockers with their gate's `kind` and `count`, and the same blockers scenario_blocks shows for the same location.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWN_OPS, UI_OPS, startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { raw } from './http.js';

let ws: string;
let studio: StudioServer;
const P = 'northfield-fixture';
const savedHome = process.env.DEMO_STUDIO_HOME;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-shoot-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  studio = await startStudioServer({ root: ws, pollMs: 100 });
}, 60_000);

afterAll(async () => {
  await studio?.close();
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

const call = (op: string, args: unknown = {}) => raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));

interface Blocker {
  code: string;
  kind?: string;
  count?: number;
  message: string;
  fix?: string;
  fix_node?: string;
}
interface Actions {
  hash: string;
  ok: boolean;
  environment: { name: string } | null;
  run_blockers: { dry: Blocker[]; capture: Blocker[] };
  content: { scenes: number; steps: number };
  runs: unknown[];
  running: unknown;
}

describe('scenario_actions', () => {
  it('⚑ is a Studio read in the ui allow-list; its input is pinned (strict: no run, no path, a slug and a name only)', async () => {
    expect(OWN_OPS).toContain('scenario_actions');
    expect(UI_OPS).toContain('scenario_actions');
    for (const bad of [{ project: P, name: 'quote', run: '20261020-100000-quote' }, { project: P, name: '../quote' }, { project: '/tmp', name: 'quote' }, { project: P, name: 'quote', env: 'a/b' }, { project: P }]) {
      const r = await call('scenario_actions', bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('⚑ the fixture’s quote: hash, location, counts, the capture blocked by one hook to approve (kind and count) — the blockers scenario_blocks shows; path-free but the commands', async () => {
    const r = await call('scenario_actions', { project: P, name: 'quote' });
    expect(r.status).toBe(200);
    const a = r.json<{ data: Actions }>().data;
    const b = (await call('scenario_blocks', { project: P, name: 'quote' })).json<{ data: { hash: string; run_blockers: Actions['run_blockers'] } }>().data;
    expect(a.hash).toBe(b.hash);
    expect(a.run_blockers).toEqual(b.run_blockers);
    expect(a.ok).toBe(true);
    expect(a.environment?.name).toBe('local');
    expect(a.content.scenes).toBeGreaterThan(1);
    expect(a.content.steps).toBeGreaterThan(10);
    expect(a.run_blockers.dry).toEqual([]);
    expect(a.run_blockers.capture).toHaveLength(1);
    expect(a.run_blockers.capture[0]).toMatchObject({ code: 'needs_approval', kind: 'needs_approval', count: 1, fix: expect.stringMatching(new RegExp(`run ${P} quote$`)) });
    // Path-free but the commands a person types (critique L9: fix and fix_node, explicitly).
    const without = { ...a, run_blockers: { dry: a.run_blockers.dry, capture: a.run_blockers.capture.map(({ fix: _f, fix_node: _n, ...rest }) => rest) } };
    expect(JSON.stringify(without)).not.toContain(ws);
    expect(JSON.stringify(without)).not.toMatch(/"file"|\/scenarios\//);
    expect(r.body).toContain(ws); // the commands do name the workspace (studio -C <root> …)
  });
});
