/**
 * L4.2 part 2: the scenario screen's server side over HTTP — `scenario_blocks`, `run_thumbs` and `run_status` through
 * `/v1/call` behind the gate (allow-list, zod refusals before any read, run blockers worded for the Studio, page text
 * only under `untrusted` and cut, base64 JPEGs that decode, `run_status` without its long-poll), and the `workspace`
 * event naming the scenario file saved in place and the run that started with its scenario (critique B1).
 */
import { request } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUN_THUMBS_MAX_KEYS } from '@retake/engine';
import { UI_OPS, startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { BLOCKS_YAML, GREEN, RED, capture, centre, near, writeRun } from '@retake/test-support/runs';
import { raw } from '@retake/test-support/http';
import { scratchHome } from '@retake/test-support/home';

let ws: string;
let studio: StudioServer;
const P = 'northfield-fixture';
const retakeHome = scratchHome();
const project = () => join(ws, 'projects', P);

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-scenario-'));
  retakeHome.use(join(ws, '.home'));
  await fixtureWorkspace(ws);
  await writeFile(join(project(), 'scenarios', 'blocks.yaml'), BLOCKS_YAML);
  const run = capture('20261020-100000-blocks', { video: false });
  run.events![0] = { ...run.events![0], target: `<script>window.__pwned=1</script>${'x'.repeat(5000)}` };
  await writeRun(project(), run);
  studio = await startStudioServer({ root: ws, pollMs: 100 });
}, 60_000);

afterAll(async () => {
  await studio?.close();
  retakeHome.restore();
  if (ws) await rm(ws, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${studio.token}` });
const json = { 'content-type': 'application/json' };
const call = (op: string, args: unknown = {}, headers: Record<string, string> = {}) => raw(studio.port, 'POST', `/v1/call/${op}`, { ...auth(), ...json, ...headers }, JSON.stringify(args));

interface Answer<T> {
  ok: boolean;
  summary: string;
  data: T;
  error?: { code: string; message: string };
}

describe('scenario_blocks', () => {
  it('is allowed; reads the fixture’s quote: blocks, no issue, the capture blocked with Studio wording and the command', async () => {
    expect(UI_OPS).toEqual(expect.arrayContaining(['scenario_blocks', 'run_thumbs', 'run_status']));
    const r = await call('scenario_blocks', { project: P, name: 'quote' });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const a = r.json<Answer<{ ok: boolean; blocks: { step_count: number }; run_blockers: { dry: unknown[]; capture: Array<{ code: string; message: string; fix: string }> } }>>();
    expect(a.data.ok).toBe(true);
    expect(a.data.blocks.step_count).toBeGreaterThan(10);
    expect(a.data.run_blockers.dry).toEqual([]);
    expect(a.data.run_blockers.capture[0]).toMatchObject({ code: 'needs_approval', fix: expect.stringMatching(new RegExp(`run ${P} quote$`)) });
    expect(a.data.run_blockers.capture[0].message).toContain('The Studio cannot approve hooks yet');
    expect(r.body).not.toMatch(/MCP client|elicitation/);
  });

  it('carries the edit hints: the scenario language’s description of each action the file uses, and no other', async () => {
    const r = await call('scenario_blocks', { project: P, name: 'blocks' });
    const a = r.json<Answer<{ hints: Record<string, string> }>>();
    expect(Object.keys(a.data.hints).sort()).toEqual(['click', 'hold']);
    expect(a.data.hints.click).toMatch(/^Click an element/);
  });

  it('binds the synthetic capture; page text only under untrusted, cut to 2,000 characters', async () => {
    const r = await call('scenario_blocks', { project: P, name: 'blocks' });
    expect(r.status).toBe(200);
    const a = r.json<Answer<{ source: { run: string }; steps: Record<string, { run_key: string; picture: string }>; untrusted: { steps: Record<string, { target: string }> } }>>();
    expect(a.summary).toBe('blocks: 5 steps, 0 issues, pictures from 20261020-100000-blocks');
    expect(a.data.steps['one.0']).toMatchObject({ run_key: 'one.0', picture: 'frame' });
    const target = a.data.untrusted.steps['one.0'].target;
    expect(target.startsWith('<script>window.__pwned=1</script>')).toBe(true);
    expect(target.length).toBeLessThan(2100);
    expect(target).toMatch(/… \(\d+ more characters\)$/);
    expect(r.body.indexOf('__pwned')).toBe(r.body.lastIndexOf('__pwned'));
  });

  it('zod refusals before any read: a path as a name, a bad run id, an unknown argument', async () => {
    for (const args of [
      { project: P, name: '../quote' },
      { project: P, name: 'quote', run: '../../x' },
      { project: P, name: 'quote', extra: 1 },
      { project: '../x', name: 'quote' },
    ]) {
      const r = await call('scenario_blocks', args);
      expect(r.status, JSON.stringify(args)).toBe(400);
    }
    expect((await call('scenario_blocks', { project: P, name: 'nope' })).status).toBe(404);
  });
});

describe('run_thumbs', () => {
  it('base64 JPEGs of the run’s steps, their colours; missing ones say why', async () => {
    const r = await call('run_thumbs', { project: P, run: '20261020-100000-blocks', keys: ['one.0', 'one.1', 'two.9'] });
    expect(r.status).toBe(200);
    const a = r.json<Answer<{ thumbs: Array<{ key: string; mime: string; base64: string; width: number; height: number; from: string }>; missing: Array<{ key: string; reason: string }> }>>();
    expect(a.data.thumbs.map((t) => [t.key, t.mime, t.from])).toEqual([
      ['one.0', 'image/jpeg', 'frame'],
      ['one.1', 'image/jpeg', 'frame'],
    ]);
    expect(near(centre(a.data.thumbs[0].base64, a.data.thumbs[0].width, a.data.thumbs[0].height), RED)).toBe(true);
    expect(near(centre(a.data.thumbs[1].base64, a.data.thumbs[1].width, a.data.thumbs[1].height), GREEN)).toBe(true);
    expect(a.data.missing).toEqual([{ key: 'two.9', reason: 'not_reached' }]);
  });

  it('refuses 0 or 25 keys, a key that is a path, a run id that is a path — 400, nothing read', async () => {
    for (const args of [
      { project: P, run: '20261020-100000-blocks', keys: [] },
      { project: P, run: '20261020-100000-blocks', keys: Array.from({ length: RUN_THUMBS_MAX_KEYS + 1 }, (_x, i) => `one.${i}`) },
      { project: P, run: '20261020-100000-blocks', keys: ['../../etc/passwd.0'] },
      { project: P, run: '20261020-100000-blocks', keys: ['one.0'], max_px: 4000 },
      { project: P, run: '../runs', keys: ['one.0'] },
    ]) {
      const r = await call('run_thumbs', args);
      expect(r.status, JSON.stringify(args).slice(0, 80)).toBe(400);
    }
  });
});

describe('run_status from the Studio: no long-poll', () => {
  it('answers the run’s status; wait_s other than 0 is refused (400)', async () => {
    const ok = await call('run_status', { project: P, run_id: '20261020-100000-blocks' });
    expect(ok.status).toBe(200);
    expect(ok.json<Answer<{ status: string; steps_done: number }>>().data).toMatchObject({ status: 'succeeded', steps_done: 5 });
    expect((await call('run_status', { project: P, run_id: '20261020-100000-blocks', wait_s: 0 })).status).toBe(200);
    const t0 = Date.now();
    const r = await call('run_status', { project: P, run_id: '20261020-100000-blocks', wait_s: 5 });
    expect(r.status).toBe(400);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((await call('run_status', { project: P, run_id: '20261020-100000-blocks', extra: true })).status).toBe(400);
  });
});

/** The events of a stream, and a wait until one matches. */
function watch(port: number, token: string) {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const req = request({ host: '127.0.0.1', port, path: '/v1/events', method: 'GET', headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` }, setHost: false, agent: false }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c: string) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev && data) events.push({ event: ev, data: JSON.parse(data) as Record<string, unknown> });
      }
    });
    res.on('error', () => undefined);
  });
  req.on('error', () => undefined);
  req.end();
  const until = async (pred: (e: { event: string; data: Record<string, unknown> }) => boolean, what: string) => {
    const t0 = Date.now();
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > 4000) throw new Error(`no ${what} within 4 s: ${JSON.stringify(events)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { events, until, close: () => req.destroy() };
}

const runsOf = (id: string) => (e: { event: string; data: Record<string, unknown> }) =>
  e.event === 'workspace' && Array.isArray(e.data.runs) && (e.data.runs as Array<{ run: string }>).some((x) => x.run === id);

describe('the workspace event names scenario files and runs (B1)', () => {
  it('an in-place save → scenarios ["<slug>/<name>"]; a run that starts → runs [{run, scenario, change: new}]', async () => {
    const w = watch(studio.port, studio.token);
    try {
      await w.until((e) => e.event === 'hello', 'hello');
      await new Promise((r) => setTimeout(r, 300));
      const file = join(project(), 'scenarios', 'quote.yaml');
      await writeFile(file, `${await readFile(file, 'utf8')}# saved in place\n`);
      await w.until((e) => e.event === 'workspace' && JSON.stringify(e.data.scenarios) === JSON.stringify([`${P}/quote`]), 'scenarios event');
      const id = '20261022-100000-blocks';
      await writeRun(project(), { id, scenario: 'blocks', mode: 'dry', status: 'running', noTimeline: true });
      const ev = await w.until(runsOf(id), 'runs event');
      expect(ev.data.runs).toEqual([{ project: P, run: id, scenario: 'blocks', status: 'running', finished: false, change: 'new' }]);
    } finally {
      w.close();
    }
  });

  it('the same without node:sqlite (the scan held in memory): the run is named with its scenario, then its finish', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-ui-scenario-nosqlite-'));
    await fixtureWorkspace(dir);
    const s2 = await startStudioServer({ root: dir, sqlite: async () => null, pollMs: 100 });
    const w = watch(s2.port, s2.token);
    try {
      await w.until((e) => e.event === 'hello', 'hello');
      await new Promise((r) => setTimeout(r, 300));
      const id = '20261022-110000-quote';
      const runDir = await writeRun(join(dir, 'projects', P), { id, scenario: 'quote', mode: 'dry', status: 'running', noTimeline: true });
      expect((await w.until(runsOf(id), 'runs event')).data.runs).toEqual([{ project: P, run: id, scenario: 'quote', status: 'running', finished: false, change: 'new' }]);
      const rec = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as Record<string, unknown>;
      await writeFile(join(runDir, 'run.json'), JSON.stringify({ ...rec, status: 'succeeded', finished_at: '2026-10-22T11:00:00.000Z' }));
      const done = await w.until((e) => runsOf(id)(e) && (e.data.runs as Array<{ finished: boolean }>).some((x) => x.finished), 'finished run event');
      expect(done.data.runs).toEqual([{ project: P, run: id, scenario: 'quote', status: 'succeeded', finished: true, change: 'status' }]);
    } finally {
      w.close();
      await s2.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('without node:sqlite, a runs/ folder that cannot be read is never "every run deleted": its runs are kept and it is read again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-ui-scenario-unreadable-'));
    await fixtureWorkspace(dir);
    const runs = join(dir, 'projects', P, 'runs');
    const s2 = await startStudioServer({ root: dir, sqlite: async () => null, pollMs: 100 });
    const w = watch(s2.port, s2.token);
    try {
      await w.until((e) => e.event === 'hello', 'hello');
      await new Promise((r) => setTimeout(r, 300));
      await mkdir(join(runs, '20261022-120000-empty'));
      await chmod(runs, 0o000);
      await new Promise((r) => setTimeout(r, 600));
      await chmod(runs, 0o755);
      const id = '20261022-130000-quote';
      await writeRun(join(dir, 'projects', P), { id, scenario: 'quote', mode: 'dry', status: 'running', noTimeline: true });
      // Only the new run is new: the runs known before were never dropped (else they would come back as new too).
      expect((await w.until(runsOf(id), 'runs event')).data.runs).toEqual([{ project: P, run: id, scenario: 'quote', status: 'running', finished: false, change: 'new' }]);
      const changes = w.events.filter((e) => e.event === 'workspace' && Array.isArray(e.data.runs)).flatMap((e) => e.data.runs as Array<{ change: string }>);
      expect(changes.map((c) => c.change)).toEqual(['new']);
    } finally {
      w.close();
      await chmod(runs, 0o755).catch(() => undefined);
      await s2.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
