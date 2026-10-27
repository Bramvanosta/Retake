/**
 * L4.6 part C (T11): the Studio's comment ops over HTTP with the real gate (comment-ops.ts), on a synthetic render of a
 * real encode (review helpers: a drawn capture and render) — the engine client is `ui`:
 * - ⚑ strict inputs: no author, via, marker, time, scenario or proposal field (a proposal from the page is a 400:
 *   proposals are Claude's), no path for an id, `if_match` required by the op itself on resolve / reopen / apply;
 * - ⚑ every answer is path-free (the workspace root, the home folder, `file`, a still path: none);
 * - ⚑ `thread_add` writes the channel `studio` (named by the Studio process) on the render the page showed (a reused
 *   render id: 409); ⚑ `frame_anchor` answers the anchor `thread_add` stores — for frames of several kinds and a region
 *   (the equality T4 had, moved here through the ops);
 * - resolve / reopen / apply on the hash the page showed (stale: 409 naming the current hash); ⚑ a thread's injected
 *   text comes back as data under `untrusted` only;
 * - thread_get carries the engine's proposal view and ⚑ the offer computed by the server (critique B3): Apply and
 *   re-render only for a landscape thread whose render used the files' theme and no override — a vertical thread,
 *   an override, another theme each offer Apply only, with why; Apply writes the proposal's bytes, Undo apply
 *   (scenario_edit restore of `previous`) gives the base back and the proposal reads `undone`, actionable again;
 * - ⚑ thread_apply and scenario_edit of one scenario run one at a time (one chain, critique B5): an edit sent while an
 *   apply runs finds the applied file (409), never the other way round;
 * - render_outline / render_frame through the session; ⚑ a frame request past the server's queue is 429 with
 *   Retry-After; a reused render id 409;
 * - ⚑ errors are path-free like answers (review A L1); ⚑ a proposal Apply would refuse is offered nothing (review A L4);
 * - ⚑ `timeline_view {proposal}` (see timeline-ops for the take): the proposal's plan goes through the workspace
 *   component hold (critique B9 c) — here on the take of `wc`.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffLines, textLines } from '@demo-studio/core';
import type { CommentThread } from '@demo-studio/core';
import { createEngine } from '@demo-studio/engine';
import type { Engine } from '@demo-studio/engine';
import { scaffoldDir } from '@demo-studio/components';
import { COMMENT_OPS, UI_OPS, pathFree, startStudioServer } from '../src/index.js';
import type { StudioServer, ThreadAnswer, ThreadApplyAnswer, ThreadGetAnswer, ThreadsListAnswer, TimelineViewAnswer } from '../src/index.js';
import { hasTool, makeCase, scenesTimeline, workspace } from '../../review/test/helpers.js';
import type { Case, Workspace } from '../../review/test/helpers.js';
import { synthTimeline } from '../../editor/test/helpers.js';
import { raw } from './http.js';
import { writeTake } from './timeline-take.js';

const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 240_000;
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const TEXT = `video: Quote
title: {text: Quote}
scenes:
  - id: s1
    page: app
    open: /
    caption: A very long caption that says too much
    steps:
      - click: Go
      - hold: 2.4
  - id: s2
    steps:
      - click: Go
      - hold: 2.4
`;
const SHORTER = TEXT.replace('A very long caption that says too much', 'A short caption');
const INJECTED = '<img src=x onerror=alert(1)> look here';

let ws: Workspace;
let dir: string;
let v1: Case;
let studio: StudioServer;
let mcp: Engine;
let savedRecord: string;
const saved = { home: process.env.DEMO_STUDIO_HOME, author: process.env.DEMO_STUDIO_AUTHOR };
const bodies: string[] = [];

const call = async (op: string, args: unknown = {}) => {
  const r = await raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
  bodies.push(r.body);
  return r;
};
async function ok<T>(op: string, args: unknown): Promise<T> {
  const r = await call(op, args);
  expect(r.status, `${op}: ${r.body.slice(0, 400)}`).toBe(200);
  return r.json<{ data: T }>().data;
}
const scenarioFile = () => join(dir, 'scenarios', 'quote.yaml');
const threadFile = (id: string) => join(dir, 'comments', 'quote', `${id}.json`);
const readThread = async (id: string) => JSON.parse(await readFile(threadFile(id), 'utf8')) as CommentThread;
const addArgs = (o: Record<string, unknown> = {}) => ({ project: 'demo', render_id: 'quote-v1', created_at: v1.record.created_at, frame: 40, text: 'The caption says too much.', ...o });
const add = async (o: Record<string, unknown> = {}) => (await ok<{ thread: ThreadAnswer; warnings: string[] }>('thread_add', addArgs(o))).thread;
const propose = async (id: string, yaml: string, base = TEXT) => mcp.comments.reply('demo', id, 'A shorter caption.', { proposal: { scenario_yaml: yaml, scenario_hash: sha(base) } });
const get = (id: string) => ok<ThreadGetAnswer>('thread_get', { project: 'demo', comment_id: id });
const setRecord = async (edit: (r: Record<string, unknown>) => void) => {
  const r = JSON.parse(savedRecord) as Record<string, unknown>;
  edit(r);
  await writeFile(join(dir, 'renders', 'quote-v1.json'), JSON.stringify(r));
};

/** Every string of a JSON value with its path. */
function strings(v: unknown, path: string[] = [], out: Array<{ path: string[]; s: string }> = []) {
  if (typeof v === 'string') out.push({ path, s: v });
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, [...path, String(i)], out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, [...path, k], out);
  return out;
}

beforeAll(async () => {
  if (!canRun) return;
  ws = await workspace();
  dir = ws.project.dir;
  process.env.DEMO_STUDIO_HOME = join(ws.root, '.home');
  process.env.DEMO_STUDIO_AUTHOR = 'Studio Person';
  const tl = scenesTimeline([6, 6], { steps: { 1: [{ action: 'wait_for', t_start: 9.11, t_end: 9.112, mark: 'proposal' }] } });
  v1 = await makeCase(ws, 'quote', tl);
  await writeFile(join(v1.run.dir, 'scenario.yaml'), TEXT);
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await writeFile(scenarioFile(), TEXT);
  savedRecord = await readFile(join(dir, 'renders', 'quote-v1.json'), 'utf8');
  studio = await startStudioServer({ root: ws.root, startWorker: false });
  mcp = await createEngine({ root: ws.root, client: 'mcp', autoStartWorker: false });
}, LONG);

afterAll(async () => {
  await studio?.close();
  for (const [k, v] of [['DEMO_STUDIO_HOME', saved.home], ['DEMO_STUDIO_AUTHOR', saved.author]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await ws?.cleanup();
});

describe.skipIf(!canRun)('the comment ops (T11)', () => {
  it('are the Studio\'s own ops on the allow-list; the MCP comment tools stay out', () => {
    expect(UI_OPS).toEqual(expect.arrayContaining([...COMMENT_OPS]));
    for (const op of ['comments_list', 'comment_reply', 'comment_resolve']) expect(UI_OPS).not.toContain(op);
  });

  it('⚑ strict inputs: no author, via, marker, time, scenario or proposal; ids never paths; if_match required by the op', async () => {
    const before = await readFile(scenarioFile());
    for (const extra of [{ author: { via: 'cli', name: 'X' } }, { via: 'cli' }, { marker: 'proposal' }, { at_s: 1 }, { time_s: 1 }, { scenario: 'quote' }, { render_id: 'latest' }, { render_id: '../x' }, { created_at: 'yesterday' }, { frame: -1 }, { frame: 1.5 }, { region: { x: 0, y: 0, w: 2, h: 1 } }, { region: { x: 0, y: 0, w: 0.5 } }, { text: '' }]) {
      expect((await call('thread_add', addArgs(extra))).status, JSON.stringify(extra)).toBe(400);
    }
    const t = await add();
    // ⚑ A proposal from the page is a 400 (proposals are Claude's: the MCP only).
    const prop = await call('thread_reply', { project: 'demo', comment_id: t.id, text: 'Mine.', proposal: { scenario_yaml: SHORTER, scenario_hash: sha(TEXT) } });
    expect(prop.status).toBe(400);
    expect(prop.json<{ error: { message: string } }>().error.message).toMatch(/invalid arguments for thread_reply/);
    for (const [op, args] of [
      ['thread_reply', { project: 'demo', comment_id: t.id, text: 'x', author: 'Someone' }],
      ['thread_reply', { project: 'demo', comment_id: '../c_x', text: 'x' }],
      ['thread_resolve', { project: 'demo', comment_id: t.id, note: 'Done.' }],
      ['thread_reopen', { project: 'demo', comment_id: t.id }],
      ['thread_apply', { project: 'demo', comment_id: t.id, entry_id: 'r_01JQ1000000000000000000PR1' }],
      ['thread_apply', { project: 'demo', comment_id: t.id, entry_id: 'r_01JQ1000000000000000000PR1', if_match: t.hash, proposal: {} }],
      ['render_frame', { project: 'demo', render_id: 'quote-v1', created_at: v1.record.created_at, frame: 0 }],
      ['thread_get', { project: 'demo', comment_id: t.id, file: threadFile(t.id) }],
    ] as const) {
      const r = await call(op, args);
      expect(r.status, `${op} ${JSON.stringify(args)}`).toBe(400);
      // The op's own schema refuses it (not only the engine behind it).
      expect(r.json<{ error: { message: string } }>().error.message, op).toMatch(new RegExp(`invalid arguments for ${op}`));
    }
    expect((await readThread(t.id)).entries).toEqual([]);
    expect(await readFile(scenarioFile())).toEqual(before);
  }, LONG);

  it('⚑ thread_add writes the channel studio, named by the Studio process, on the render the page showed; a reused render id is a 409', async () => {
    const t = await add({ text: INJECTED, region: { x: 0.6, y: 0.3, w: 0.2, h: 0.2 } });
    expect(t).toMatchObject({ via: 'studio', render_id: 'quote-v1', frame: 40, status: 'open', still: true, region: { x: 0.6, y: 0.3, w: 0.2, h: 0.2 } });
    expect((await readThread(t.id)).author).toEqual({ via: 'studio', name: 'Studio Person' });
    const stale = await call('thread_add', addArgs({ created_at: '2020-01-01T00:00:00.000Z' }));
    expect(stale.status).toBe(409);
    expect(stale.json<{ error: { details: { current: string } } }>().error.details.current).toBe(v1.record.created_at);
    // A reply, a resolve on the hash shown, a reopen: all studio.
    const r = await ok<{ hash: string }>('thread_reply', { project: 'demo', comment_id: t.id, text: 'And the button.' });
    const old = await call('thread_resolve', { project: 'demo', comment_id: t.id, note: 'Done.', if_match: t.hash });
    expect(old.status).toBe(409);
    expect(old.json<{ error: { details: { current: string } } }>().error.details.current).toBe(r.hash);
    const res = await ok<{ hash: string; thread: ThreadAnswer }>('thread_resolve', { project: 'demo', comment_id: t.id, note: 'Done.', if_match: r.hash });
    expect(res.thread.status).toBe('resolved');
    expect((await call('thread_reopen', { project: 'demo', comment_id: t.id, if_match: r.hash })).status).toBe(409);
    const re = await ok<{ thread: ThreadAnswer }>('thread_reopen', { project: 'demo', comment_id: t.id, note: 'Not quite.', if_match: res.hash });
    expect(re.thread.status).toBe('open');
    expect((await readThread(t.id)).entries.map((e) => [e.kind, e.author.via, e.author.name])).toEqual([
      ['reply', 'studio', 'Studio Person'],
      ['resolve', 'studio', 'Studio Person'],
      ['reopen', 'studio', 'Studio Person'],
    ]);
    // ⚑ The injected text is data under `untrusted` only, in the list and the thread.
    await mcp.comments.reply('demo', t.id, `Claude: ${INJECTED}`);
    const list = await ok<ThreadsListAnswer>('threads_list', { project: 'demo', name: 'quote', status: 'all' });
    const got = await get(t.id);
    for (const v of [list, got]) {
      const hits = strings(v).filter((x) => x.s.includes('<img'));
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) expect(h.path, h.path.join('.')).toContain('untrusted');
    }
    expect(list.threads.find((x) => x.id === t.id)).toMatchObject({ via: 'studio', last: { kind: 'reply', via: 'mcp' }, entries_total: 4, untrusted: { text: INJECTED, author: 'Studio Person' } });
    expect(list.counts.open).toBeGreaterThan(0);
    const counts = await ok<{ scenarios: Record<string, { open: number; resolved: number }> }>('threads_counts', { project: 'demo', name: 'quote' });
    expect(counts.scenarios.quote).toEqual(list.counts);
  }, LONG);

  it('⚑ frame_anchor answers the anchor thread_add stores (frames of several kinds, a caption region)', async () => {
    const fps = v1.record.fps;
    const last = v1.record.frames - 1;
    const cases: Array<{ frame: number; region?: { x: number; y: number; w: number; h: number } }> = [
      { frame: 5 },
      { frame: Math.round(3 * fps) },
      { frame: Math.round(3 * fps), region: { x: 0.1, y: 0.82, w: 0.8, h: 0.12 } },
      { frame: Math.round(9.1 * fps) },
      { frame: Math.round(6 * fps) },
      { frame: last },
    ];
    const kinds = new Set<string>();
    const areas = new Set<string>();
    for (const c of cases) {
      const args = { project: 'demo', render_id: 'quote-v1', created_at: v1.record.created_at, frame: c.frame, ...(c.region ? { region: c.region } : {}) };
      const a = await ok<{ anchor: CommentThread['anchor']; frame: number; timecode: string }>('frame_anchor', args);
      const t = await add({ frame: c.frame, ...(c.region ? { region: c.region } : {}) });
      expect(t.anchor, JSON.stringify(c)).toEqual(a.anchor);
      expect((await readThread(t.id)).anchor, JSON.stringify(c)).toEqual(a.anchor);
      expect([t.frame, t.timecode]).toEqual([a.frame, a.timecode]);
      kinds.add(a.anchor.kind);
      if (a.anchor.area) areas.add(a.anchor.area);
    }
    // Meaningful: more than one kind of place, and the region picked an area.
    expect(kinds.size).toBeGreaterThan(1);
    expect(areas.size).toBeGreaterThan(0);
  }, LONG);

  it('⚑ the offer (critique B3): Apply and re-render only for a landscape thread rendered with the files\' theme and no override', async () => {
    const t = await add();
    await propose(t.id, SHORTER);
    // The synthetic render used an override (scale): Apply and Preview, not Apply and re-render.
    let g = await get(t.id);
    expect(g.proposal).toMatchObject({ state: 'pending', actionable: true, verified: true, same_take: true, added: 1, removed: 1 });
    expect(g.proposal!.untrusted.rows).toContain('    caption: A short caption');
    expect(g.proposal!.offer).toEqual({ apply: true, preview: true, apply_render: false, why: "The commented render used options beyond the files' (scale): apply it, then render it from your terminal or ask Claude" });
    try {
      await setRecord((r) => (r.overrides = {}));
      g = await get(t.id);
      expect(g.proposal!.offer).toEqual({ apply: true, preview: true, apply_render: true });
      // A vertical thread (the same render, as a vertical cut would be): the Studio renders landscape only.
      const stored = await readThread(t.id);
      const vid = t.id.replace(/.{3}$/, 'VVV');
      await writeFile(threadFile(vid), JSON.stringify({ ...stored, id: vid, render: { ...stored.render, variant: 'vertical' }, entries: [] }));
      await propose(vid, SHORTER);
      const gv = await get(vid);
      expect(gv.thread.variant).toBe('vertical');
      expect(gv.proposal!.offer).toEqual({ apply: true, preview: true, apply_render: false, why: 'The comment is on a vertical render and the Studio renders landscape only: apply it, then render it from your terminal or ask Claude' });
      // A thread on a take that is gone: the proposal cannot be previewed or re-rendered on it — Apply only.
      const gone = t.id.replace(/.{3}$/, 'RRR');
      await writeFile(threadFile(gone), JSON.stringify({ ...stored, id: gone, render: { ...stored.render, run_id: '20200101-000000-quote' }, entries: [] }));
      await propose(gone, SHORTER);
      const gg = await get(gone);
      expect(gg.proposal).toMatchObject({ state: 'pending', actionable: true, same_take: false });
      expect(gg.proposal!.offer).toEqual({ apply: true, preview: false, apply_render: false, why: "It does not render on the commented take (the take is gone, or the scenario's filmed part changed since): apply it, then capture again" });
      // Another theme than the files': the scenario now names one (the render used the project's).
      const themed = TEXT.replace('video: Quote\n', 'video: Quote\ntemplate: default\n');
      await writeFile(scenarioFile(), themed);
      const t3 = await add();
      await propose(t3.id, themed.replace('A very long caption that says too much', 'Shorter'), themed);
      expect((await get(t3.id)).proposal!.offer).toEqual({ apply: true, preview: true, apply_render: false, why: "The commented render used the theme editorial, not the files' default: apply it, then render it from your terminal or ask Claude" });
      // T1's proposal is stale meanwhile (its base is not today's file): nothing offered, with why.
      expect((await get(t.id)).proposal!.offer).toEqual({ apply: false, preview: false, apply_render: false, why: 'The scenario changed since it was proposed: ask Claude to propose again' });
    } finally {
      await writeFile(scenarioFile(), TEXT);
      await writeFile(join(dir, 'renders', 'quote-v1.json'), savedRecord);
    }
  }, LONG);

  it('apply on the hash shown writes the proposal\'s bytes; Undo apply (scenario_edit restore of previous) gives the base back, the proposal undone', async () => {
    await writeFile(scenarioFile(), TEXT);
    const t = await add();
    const w = await propose(t.id, SHORTER);
    const entry = w.entry;
    const stale = await call('thread_apply', { project: 'demo', comment_id: t.id, entry_id: entry, if_match: t.hash });
    expect(stale.status).toBe(409);
    expect(stale.json<{ error: { details: { current: string } } }>().error.details.current).toBe(w.hash);
    expect(await readFile(scenarioFile(), 'utf8')).toBe(TEXT);
    const a = await ok<ThreadApplyAnswer>('thread_apply', { project: 'demo', comment_id: t.id, entry_id: entry, if_match: w.hash });
    expect(await readFile(scenarioFile(), 'utf8')).toBe(SHORTER);
    expect(a.scenario).toEqual({ name: 'quote', file: expect.stringMatching(/^scenarios\/quote\.yaml$/), hash: sha(SHORTER), previous: { text: TEXT, hash: sha(TEXT) } });
    expect(a).toMatchObject({ change: 'edit', problems: [], entry: expect.stringMatching(/^r_/) });
    expect(a.thread.entries.at(-1)).toMatchObject({ kind: 'apply', via: 'studio', applies: entry });
    expect((await get(t.id)).proposal).toMatchObject({ state: 'applied', offer: { apply: false, why: 'Applied: the scenario holds it' } });
    // Undo apply: the Studio's restore of the exact base (a version the engine read).
    const undo = await call('scenario_edit', { project: 'demo', name: 'quote', hash: a.scenario.hash, edit: { kind: 'restore', text: a.scenario.previous.text, text_hash: a.scenario.previous.hash } });
    expect(undo.status, undo.body.slice(0, 300)).toBe(200);
    expect(await readFile(scenarioFile(), 'utf8')).toBe(TEXT);
    const after = await get(t.id);
    expect(after.proposal).toMatchObject({ state: 'undone', actionable: true, offer: { apply: true, preview: true } });
  }, LONG);

  it('⚑ thread_apply and scenario_edit of one scenario run one at a time (one chain): an edit sent during an apply finds the applied file', async () => {
    await writeFile(scenarioFile(), TEXT);
    const t = await add();
    const w = await propose(t.id, SHORTER);
    const original = studio.engine.comments.apply;
    let entered = false;
    studio.engine.comments.apply = async (...args) => {
      entered = true;
      await new Promise((r) => setTimeout(r, 400));
      return original(...args);
    };
    try {
      const applying = call('thread_apply', { project: 'demo', comment_id: t.id, entry_id: w.entry, if_match: w.hash });
      const end = Date.now() + 10_000;
      while (!entered && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      expect(entered).toBe(true);
      const edit = call('scenario_edit', { project: 'demo', name: 'quote', hash: sha(TEXT), edit: { kind: 'replace_text', text: TEXT.replace('title: {text: Quote}', 'title: {text: Quote two}') } });
      const [ra, re] = await Promise.all([applying, edit]);
      expect(ra.status, ra.body.slice(0, 300)).toBe(200);
      expect(re.status, re.body.slice(0, 300)).toBe(409);
      expect(await readFile(scenarioFile(), 'utf8')).toBe(SHORTER);
    } finally {
      studio.engine.comments.apply = original;
      await writeFile(scenarioFile(), TEXT);
    }
  }, LONG);

  it('render_outline and render_frame through the page\'s session; ⚑ past the queue a frame request is 429 with Retry-After; a reused id 409', async () => {
    const o = await ok<{ frames: number; fps: number; pins: unknown[] }>('render_outline', { project: 'demo', render_id: 'quote-v1', created_at: v1.record.created_at });
    expect(o.fps).toBe(v1.record.fps);
    expect(o.pins.length).toBeGreaterThan(0);
    const f = await ok<{ frame: number; base64: string; mime: string }>('render_frame', { project: 'demo', render_id: 'quote-v1', created_at: v1.record.created_at, frame: 12, session: 'tabA' });
    expect(f).toMatchObject({ frame: 12, mime: 'image/jpeg' });
    expect(Buffer.from(f.base64, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect((await call('render_frame', { project: 'demo', render_id: 'quote-v1', created_at: '2020-01-01T00:00:00.000Z', frame: 12, session: 'tabA' })).status).toBe(409);
    expect((await call('render_frame', { project: 'demo', render_id: 'quote-v1', created_at: v1.record.created_at, frame: o.frames, session: 'tabA' })).status).toBe(400);
    // A flood of frames from many sessions (no cache hit): some are refused busy — 429, Retry-After.
    const flood = await Promise.all(Array.from({ length: 16 }, (_x, i) => call('render_frame', { project: 'demo', render_id: 'quote-v1', created_at: v1.record.created_at, frame: 100 + i * 7, session: `flood${i}` })));
    const busy = flood.filter((r) => r.status !== 200);
    expect(busy.length).toBeGreaterThan(0);
    for (const r of busy) {
      expect(r.status).toBe(429);
      expect(r.headers['retry-after']).toBe('1');
      expect(r.json<{ error: { code: string } }>().error.code).toBe('busy');
    }
  }, LONG);

  it('⚑ errors are path-free too (review A L1): a missing video, an apply the Studio rules refuse; ⚑ thread_get offers nothing Apply would refuse (review A L4)', async () => {
    const roots = [ws.root, realpathSync(ws.root), dir, homedir()];
    const clean = (body: string) => {
      for (const needle of roots) expect(body.includes(needle), `${needle} in ${body.slice(0, 400)}`).toBe(false);
    };
    // The video gone: renderForWork's words named its absolute path.
    const video = join(dir, 'renders', 'quote-v1.mp4');
    await rename(video, `${video}.away`);
    try {
      for (const [op, args] of [
        ['render_outline', { project: 'demo', render_id: 'quote-v1', created_at: v1.record.created_at }],
        ['render_frame', { project: 'demo', render_id: 'quote-v1', created_at: v1.record.created_at, frame: 3, session: 'tabZ' }],
      ] as const) {
        const r = await call(op, args);
        expect(r.status, r.body).toBe(404);
        clean(r.body);
        expect(r.json<{ error: { message: string } }>().error.message).toMatch(/^the video of render quote-v1 is missing/);
      }
    } finally {
      await rename(`${video}.away`, video);
    }
    // A planted proposal (thread files are agent-writable) whose text the Studio refuses: a secret reference.
    const t = await add({ frame: 41 });
    const result = TEXT.replace('A very long caption that says too much', 'Token {{secret:api_token}}');
    const thread = await readThread(t.id);
    thread.entries.push({
      id: 'r_01JQ9000000000000000000PR1',
      kind: 'reply',
      author: { via: 'mcp', name: 'agent' },
      text: 'Proposed.',
      created_at: '2026-10-27T09:06:00.000Z',
      proposal: { base_sha256: sha(TEXT), result_sha256: sha(result), eol: 'lf', delta: 'edit', hunks: diffLines(textLines(TEXT), textLines(result))! },
    });
    await writeFile(threadFile(t.id), JSON.stringify(thread));
    const g = await get(t.id);
    expect(g.proposal).toMatchObject({ state: 'pending', actionable: true, offer: { apply: false, preview: false, apply_render: false } });
    expect(g.proposal!.offer.why).toMatch(/^Apply would refuse it now \(.+\): ask Claude to propose again$/);
    clean(JSON.stringify(g));
    const before = await readFile(scenarioFile());
    const r = await call('thread_apply', { project: 'demo', comment_id: t.id, entry_id: 'r_01JQ9000000000000000000PR1', if_match: g.thread.hash });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.json<{ error: { message: string } }>().error.message).toMatch(/^not applied: /);
    clean(r.body);
    expect(await readFile(scenarioFile())).toEqual(before);
  }, LONG);

  it('⚑ every answer is path-free (workspace, home, file, still path)', () => {
    expect(bodies.length).toBeGreaterThan(20);
    const roots = [ws.root, realpathSync(ws.root), dir, homedir()];
    for (const b of bodies) {
      for (const needle of [...roots, '"file":"/', '"still":"', '.jpg"']) expect(b.includes(needle), `${needle} in ${b.slice(0, 300)}`).toBe(false);
      // An answer never names the thread file (an error's words may: a project-relative name).
      if (b.startsWith('{"ok":true')) expect(b.includes('comments/quote/c_'), b.slice(0, 200)).toBe(false);
    }
    // The text of a warning or a problem loses its paths too.
    expect(pathFree(`no still for comment c_1: ${ws.root}/projects/demo/renders/quote-v1.mp4: Invalid data`, ws.root)).toBe('no still for comment c_1: projects/demo/renders/quote-v1.mp4: Invalid data');
    expect(pathFree('ffmpeg failed: /elsewhere/deep/file.mp4 bad', ws.root)).toBe('ffmpeg failed: …/file.mp4 bad');
    expect(pathFree('runs/20260101-120000-quote/scenario.yaml is missing', ws.root)).toBe('runs/20260101-120000-quote/scenario.yaml is missing');
  });
});

describe.skipIf(!canRun)('timeline_view {proposal} (T11, critique B9 c)', () => {
  it('⚑ the proposal\'s plan goes through the workspace component hold: a proposal adding an unallowed component is preview_held', async () => {
    // A take in this workspace (the editorial theme of the repository), a workspace component, a thread on its run.
    const RUN = '20260101-120000-tl';
    const T = `video: Timeline
title: {text: Timeline}
intro: false
outro: false
scenes:
  - id: a
    page: app
    open: /
    caption: Every frame has its own number.
    steps:
      - hold: 1
  - card: {slots: {title: Chapter two}}
    id: c1
`;
    const tl = synthTimeline({
      duration: 3,
      entries: [{ id: 'a', t_start: 0.5, t_end: 2.5, caption: { text: 'Every frame has its own number.' }, steps: [{ action: 'hold', t_start: 0.5, t_end: 2.5 }] }, { card: { id: 'c1', slots: { title: 'Chapter two' } } }],
      video: { title: { text: 'Timeline' }, intro: false, outro: false, template: 'editorial' },
    });
    await writeTake(dir, 'tl', { run: RUN, text: T, timeline: tl, codec: 'h264-x264', seconds: 3 });
    const comp = join(ws.root, 'components', 'acme', 'marked');
    await mkdir(comp, { recursive: true });
    await cp(scaffoldDir('card'), comp, { recursive: true });
    await writeFile(join(comp, 'component.yaml'), (await readFile(join(comp, 'component.yaml'), 'utf8')).replace(/^id: .*$/m, 'id: acme/marked'));
    const id = 'c_01JQ3000000000000000000001';
    await mkdir(join(dir, 'comments', 'tl'), { recursive: true });
    await writeFile(
      join(dir, 'comments', 'tl', `${id}.json`),
      JSON.stringify({
        version: 1, id, scenario: 'tl',
        render: { id: 'tl-v1', created_at: '2026-01-01T13:00:00.000Z', run_id: RUN, variant: 'landscape', fps: 30, frames: 90, width: 1920, height: 1080 },
        frame: 10, time_s: 0.333, text: 'A custom card, please.', author: { via: 'studio', name: 'Reviewer' }, created_at: '2026-01-01T13:05:00.000Z',
        anchor: { segment: 'c1', kind: 'card' }, entries: [],
      }),
    );
    const w = await mcp.comments.reply('demo', id, 'With the custom card.', { proposal: { scenario_yaml: T.replace('{slots: {title: Chapter two}}', '{component: acme/marked, slots: {title: Chapter two}}'), scenario_hash: sha(T) } });
    const view = async (args: Record<string, unknown>) => {
      const d = await ok<TimelineViewAnswer>('timeline_view', args);
      if ('blocked' in d) throw new Error(`blocked: ${JSON.stringify(d.blocked)}`);
      return d;
    };
    const file = await view({ project: 'demo', name: 'tl' });
    expect(file.preview_held).toBeUndefined();
    expect(file.proposal).toBeUndefined();
    const p = await view({ project: 'demo', name: 'tl', proposal: { comment_id: id, entry_id: w.entry } });
    expect(p.proposal).toMatchObject({ comment_id: id, entry_id: w.entry, shown: true });
    expect(p.editable).toEqual({ why: 'Previewing a proposal: apply it to edit' });
    expect('text' in p).toBe(false);
    expect(p.preview_held).toEqual([{ id: 'acme/marked', kind: 'card', hash: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
    // Pinned: another key in proposal, a path for an id → 400.
    for (const bad of [{ comment_id: id, entry_id: w.entry, text: T }, { comment_id: '../x', entry_id: w.entry }]) {
      expect((await call('timeline_view', { project: 'demo', name: 'tl', proposal: bad })).status, JSON.stringify(bad)).toBe(400);
    }
  }, LONG);
});
