/**
 * L4.6 part A1: the Studio channel of frame comments (engine comments.ts / engine.ts) on synthetic renders (the review
 * tests' helpers; empty videos — no still is made, a warning says so). Trust (T1): client `ui` creates, replies,
 * resolves and reopens as `{via: studio, name: the Studio process's $RETAKE_AUTHOR}` — never a name from the page;
 * `mcp` and `test` never create or reopen (nothing written); every client but `cli` reopens and resolves on the hash
 * it read (if_match: missing → invalid, stale → conflict naming the current hash); the Studio comments the render it
 * showed (`render_created_at`: missing → invalid, a reused id → conflict). The thread is written before its still
 * (critique B12: a still blocked on its video does not hold the thread back). `anchorAt` = the anchor `add` stores.
 * Counts from the thread files alone (critique B8: memoised per file, a broken file counted as a problem). The
 * `comments:` event sources (plan D9).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommentThread, LoadedProject } from '@retake/core';
import { CommentIndex, EngineError, addComment, anchorAt, createEngine, diffSources, scanSources, workspaceChanges, packageReviewer } from '../src/index.js';
import type { Engine } from '../src/index.js';
import { makeCase, scenesTimeline, workspace } from '@retake/test-support/review';
import type { Case, Workspace } from '@retake/test-support/review';
import { authorScope } from './helpers.js';
import { PERSON_POLICY } from '@retake/core';
import { scratchHome } from '@retake/test-support/home';

/** The product's frames (the review package's): the stills and frames these tests check are real. */
const FRAMES = packageReviewer().frames;

const LONG = 240_000;
const SCENARIO = [
  'scenes:',
  '  - id: s1',
  '    steps:',
  '      - click: Go',
  '      - hold: 2.4',
  '  - id: s2',
  '    steps:',
  '      - click: Go',
  '      - wait_for: Proposal ready',
  '        mark: proposal',
  '      - hold: 2.4',
].join('\n');
const REGION = { x: 0.6, y: 0.3, w: 0.2, h: 0.2 };

let ws: Workspace;
let project: LoadedProject;
let v1: Case;
let ui: Engine;
let mcp: Engine;
let tester: Engine;
let cli: Engine;
const retakeHome = scratchHome('RETAKE_AUTHOR');

const threadFile = (id: string) => join(project.dir, 'comments', 'quote', `${id}.json`);
const readThreadFile = async (id: string) => JSON.parse(await readFile(threadFile(id), 'utf8')) as CommentThread;
const threadsOnDisk = async () => (existsSync(join(project.dir, 'comments', 'quote')) ? (await readdir(join(project.dir, 'comments', 'quote'))).filter((f) => f.endsWith('.json')).sort() : []);

async function engineError(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  if (e instanceof EngineError) return e;
  throw new Error(`expected an EngineError, got ${e instanceof Error ? e.message : String(e)}`);
}

/** A thread from the Studio on quote-v1. */
const uiAdd = (o: Record<string, unknown> = {}) => ui.comments.add('demo', { render: 'quote-v1', render_created_at: v1.record.created_at, frame: 10, text: 'From the Studio', ...o });

beforeAll(async () => {
  ws = await workspace();
  project = ws.project;
  retakeHome.use(join(ws.root, '.home'));
  const tl = scenesTimeline([6, 6], { steps: { 1: [{ action: 'wait_for', t_start: 9.11, t_end: 9.112, mark: 'proposal' }] } });
  v1 = await makeCase(ws, 'quote', tl, { noVideo: true });
  await writeFile(join(v1.run.dir, 'scenario.yaml'), SCENARIO);
  await mkdir(join(project.dir, 'scenarios'), { recursive: true });
  await writeFile(join(project.dir, 'scenarios', 'quote.yaml'), `${SCENARIO}\n`);
  ui = await createEngine({ root: ws.root, client: 'ui', autoStartWorker: false });
  mcp = await createEngine({ root: ws.root, client: 'mcp', autoStartWorker: false });
  tester = await createEngine({ root: ws.root, client: 'test', autoStartWorker: false });
  cli = await createEngine({ root: ws.root, client: 'cli', autoStartWorker: false });
}, LONG);

afterAll(async () => {
  retakeHome.restore();
  await ws?.cleanup();
});

describe('the Studio channel (T1)', () => {
  it(
    "ui creates, replies, resolves and reopens as studio, named by the Studio process's $RETAKE_AUTHOR (never by the page)",
    async () => {
      process.env.RETAKE_AUTHOR = 'Studio Person';
      // A page-chosen author is not an argument the engine reads: the stored author is the channel's.
      const { thread } = await uiAdd({ author: { via: 'cli', name: 'Someone Else' }, via: 'cli' });
      const stored = await readThreadFile(thread.id);
      expect(stored.author).toEqual({ via: 'studio', name: 'Studio Person' });
      expect(thread).toMatchObject({ via: 'studio', untrusted: { author: 'Studio Person' } });
      const reply = await ui.comments.reply('demo', thread.id, 'A reply from the Studio.');
      const resolved = await ui.comments.resolve('demo', thread.id, { note: 'Done.', if_match: reply.hash });
      const reopened = await ui.comments.reopen('demo', thread.id, 'Not quite.', { if_match: resolved.hash });
      expect(reopened.thread.status).toBe('open');
      expect((await readThreadFile(thread.id)).entries.map((e) => [e.kind, e.author.via, e.author.name])).toEqual([
        ['reply', 'studio', 'Studio Person'],
        ['resolve', 'studio', 'Studio Person'],
        ['reopen', 'studio', 'Studio Person'],
      ]);
      // Without $RETAKE_AUTHOR: the OS user (the CLI's rule), still the studio channel.
      delete process.env.RETAKE_AUTHOR;
      const r2 = await ui.comments.reply('demo', thread.id, 'Again.');
      expect((await readThreadFile(thread.id)).entries.at(-1)?.author).toEqual({ via: 'studio', name: expect.any(String) });
      expect(r2.thread.entries.at(-1)?.via).toBe('studio');
      // The MCP still writes as the agent.
      await mcp.comments.reply('demo', thread.id, 'From Claude.');
      expect((await readThreadFile(thread.id)).entries.at(-1)?.author).toEqual({ via: 'mcp', name: 'agent' });
    },
    LONG,
  );

  it(
    'mcp and test never create or reopen a thread: refused, nothing written',
    async () => {
      const before = await threadsOnDisk();
      for (const e of [mcp, tester]) {
        const add = await engineError(e.comments.add('demo', { render: 'quote-v1', render_created_at: v1.record.created_at, frame: 10, text: 'An agent' }));
        expect(add.code).toBe('refused');
        expect(add.message).toMatch(/is for a person/);
      }
      expect(await threadsOnDisk()).toEqual(before);
      const { thread } = await uiAdd();
      const resolved = await ui.comments.resolve('demo', thread.id, { note: 'Done.', if_match: thread.hash });
      const bytes = await readFile(threadFile(thread.id));
      for (const e of [mcp, tester]) {
        expect((await engineError(e.comments.reopen('demo', thread.id, 'Again', { if_match: resolved.hash }))).code).toBe('refused');
      }
      expect(await readFile(threadFile(thread.id))).toEqual(bytes);
    },
    LONG,
  );

  it(
    'ui reopens and resolves only on the hash it read: missing → invalid, stale → conflict naming the current hash; the CLI needs none',
    async () => {
      const { thread } = await uiAdd();
      const noMatch = await engineError(ui.comments.resolve('demo', thread.id, { note: 'Done.' }));
      expect(noMatch).toMatchObject({ code: 'invalid', details: { argument: 'if_match' } });
      const resolved = await ui.comments.resolve('demo', thread.id, { note: 'Done.', if_match: thread.hash });
      const bytes = await readFile(threadFile(thread.id));
      const noReopenMatch = await engineError(ui.comments.reopen('demo', thread.id, 'Again'));
      expect(noReopenMatch).toMatchObject({ code: 'invalid', details: { argument: 'if_match' } });
      // A reply landed meanwhile (Claude answering): the page's hash is stale.
      const meanwhile = await mcp.comments.reply('demo', thread.id, 'Answered.');
      const stale = await engineError(ui.comments.reopen('demo', thread.id, 'Again', { if_match: resolved.hash }));
      expect(stale).toMatchObject({ code: 'conflict', details: { current: meanwhile.hash } });
      expect((await engineError(ui.comments.reopen('demo', thread.id, 'Again', { if_match: 'nope' }))).details?.argument).toBe('if_match');
      expect((await readThreadFile(thread.id)).entries.length).toBe(JSON.parse(bytes.toString('utf8')).entries.length + 1);
      // The CLI (a person at a terminal) reopens without one.
      expect((await cli.comments.reopen('demo', thread.id, 'From the terminal')).thread.status).toBe('open');
    },
    LONG,
  );

  it(
    'the Studio comments the render it showed: render_created_at required, a reused render id is a conflict (nothing written)',
    async () => {
      const before = await threadsOnDisk();
      const missing = await engineError(ui.comments.add('demo', { render: 'quote-v1', frame: 10, text: 'No date' }));
      expect(missing).toMatchObject({ code: 'invalid', details: { argument: 'render_created_at' } });
      const replaced = await engineError(uiAdd({ render_created_at: '2020-01-01T00:00:00.000Z' }));
      expect(replaced).toMatchObject({ code: 'conflict', details: { current: v1.record.created_at } });
      expect(replaced.message).toMatch(/render quote-v1 was replaced/);
      expect((await engineError(uiAdd({ render_created_at: 'yesterday' }))).details?.argument).toBe('render_created_at');
      expect(await threadsOnDisk()).toEqual(before);
      // The CLI may name it too (same rule), or not at all.
      expect((await engineError(cli.comments.add('demo', { render: 'quote-v1', render_created_at: '2020-01-01T00:00:00.000Z', frame: 10, text: 'x' }))).code).toBe('conflict');
      expect((await cli.comments.add('demo', { render: 'quote-v1', frame: 10, text: 'From the terminal' })).thread.via).toBe('cli');
    },
    LONG,
  );

  it(
    'anchorAt is the anchor add stores (same code), with step_now; it writes nothing and needs the render it shows',
    async () => {
      const before = await threadsOnDisk();
      const mk = v1.plan.markers.find((m) => m.name === 'proposal')!;
      const frames = [0, 10, mk.done ?? mk.frame, v1.record.frames - 1];
      const chips = [];
      for (const frame of frames) chips.push(await ui.comments.anchorAt('demo', { render: 'quote-v1', render_created_at: v1.record.created_at, frame, ...(frame === 10 ? { region: REGION } : {}) }));
      expect(await threadsOnDisk()).toEqual(before);
      for (const [i, frame] of frames.entries()) {
        const { thread } = await uiAdd({ frame, ...(frame === 10 ? { region: REGION } : {}) });
        expect(chips[i].anchor, `frame ${frame}`).toEqual(thread.anchor);
        expect(chips[i]).toMatchObject({ frame, timecode: thread.timecode, time_s: thread.time_s, render_id: 'quote-v1', render_created_at: v1.record.created_at, variant: 'landscape' });
        if (thread.step_now !== undefined) expect(chips[i].step_now).toBe(thread.step_now);
        else expect(chips[i]).not.toHaveProperty('step_now');
      }
      expect(chips[2]).toMatchObject({ anchor: { marker: 'proposal', step_ref: 's2.1' }, step_now: 's2.1' });
      expect((await engineError(anchorAt(project, { render: 'quote-v1', render_created_at: undefined as never, frame: 1 }))).details?.argument).toBe('render_created_at');
      expect((await engineError(anchorAt(project, { render: 'quote-v1', render_created_at: '2020-01-01T00:00:00.000Z', frame: 1 }))).code).toBe('conflict');
      expect((await engineError(anchorAt(project, { render: 'quote-v1', render_created_at: v1.record.created_at, frame: v1.record.frames }))).details?.argument).toBe('frame');
    },
    LONG,
  );

  it(
    'the thread is written before its still: a still stuck on its video does not hold the thread back (B12)',
    async () => {
      // The render's video is a FIFO: the still's ffprobe blocks on it until a writer opens and closes it.
      const fifoCase = await makeCase(ws, 'slow', scenesTimeline([5]), { noVideo: true });
      const video = fifoCase.record.file;
      await rm(video);
      expect(spawnSync('mkfifo', [video]).status).toBe(0);
      const adding = addComment(
        project,
        { render: 'slow-v1', frame: 5, text: 'The still waits' },
        { via: 'cli', name: 'Reviewer' },
        authorScope(project, { via: 'cli', name: 'Reviewer' }),
        PERSON_POLICY,
        FRAMES,
      );
      const folder = join(project.dir, 'comments', 'slow');
      let seen: string[] = [];
      for (let i = 0; i < 200 && seen.length === 0; i++) {
        seen = existsSync(folder) ? (await readdir(folder)).filter((f) => f.endsWith('.json')) : [];
        if (!seen.length) await new Promise((r) => setTimeout(r, 25));
      }
      // Release the still (EOF on the FIFO): it fails, as a warning.
      const w = await open(video, 'w');
      await w.close();
      const { thread, warnings } = await adding;
      expect(seen).toEqual([`${thread.id}.json`]);
      expect(warnings.some((x) => x.startsWith(`no still for comment ${thread.id}`))).toBe(true);
      expect(thread.still).toBeNull();
    },
    LONG,
  );
});

describe('counts from the thread files alone (B8)', () => {
  it(
    'open / resolved per scenario, one file re-read after a reply, a broken file counted as a problem, never a render record',
    async () => {
      const index = new CommentIndex();
      const counted = await index.counts(project);
      const listed = await ui.comments.list('demo', { status: 'all' });
      const want: Record<string, { open: number; resolved: number }> = {};
      for (const t of listed.threads) {
        want[t.scenario] ??= { open: 0, resolved: 0 };
        want[t.scenario][t.status]++;
      }
      expect(counted.scenarios).toEqual(want);
      expect(counted.problems).toBe(0);
      const files = (await readdir(join(project.dir, 'comments', 'quote'))).length;
      expect(index.stats.reads).toBe(files + (await readdir(join(project.dir, 'comments', 'slow'))).length);
      // A resolution: that thread only is read again, and the counts follow.
      const open = listed.threads.find((t) => t.scenario === 'quote' && t.status === 'open')!;
      const reads = index.stats.reads;
      await ui.comments.resolve('demo', open.id, { note: 'Done.', if_match: open.hash });
      const after = await index.counts(project, { scenario: 'quote' });
      expect(index.stats.reads).toBe(reads + 1);
      expect(after.scenarios.quote).toEqual({ open: want.quote.open - 1, resolved: want.quote.resolved + 1 });
      // An in-place edit (by hand: no rename, the folder unchanged) is seen by the file's own signature.
      const f = threadFile(open.id);
      const t = await readThreadFile(open.id);
      t.entries = t.entries.slice(0, -1);
      await writeFile(f, `${JSON.stringify(t, null, 2)}\n`);
      expect((await index.counts(project, { scenario: 'quote' })).scenarios.quote).toEqual(want.quote);
      // Broken and linked files are problems, never counted; the render records are never read (garbage: same counts).
      await writeFile(join(project.dir, 'comments', 'quote', 'c_01JZZZZZZZZZZZZZZZZZZZZZZZ.json'), '{ not json');
      await symlink(f, join(project.dir, 'comments', 'quote', 'c_01JYYYYYYYYYYYYYYYYYYYYYYY.json'));
      const records = await readdir(join(project.dir, 'renders'));
      const savedRecord = await readFile(join(project.dir, 'renders', 'quote-v1.json'));
      try {
        await writeFile(join(project.dir, 'renders', 'quote-v1.json'), 'garbage');
        const broken = await ui.comments.counts('demo', { scenario: 'quote' });
        expect(broken).toEqual({ project: 'demo', scenarios: { quote: want.quote }, problems: 2 });
      } finally {
        await writeFile(join(project.dir, 'renders', 'quote-v1.json'), savedRecord);
        await rm(join(project.dir, 'comments', 'quote', 'c_01JZZZZZZZZZZZZZZZZZZZZZZZ.json'));
        await rm(join(project.dir, 'comments', 'quote', 'c_01JYYYYYYYYYYYYYYYYYYYYYYY.json'));
      }
      expect(await readdir(join(project.dir, 'renders'))).toEqual(records);
      expect((await ui.comments.counts('demo', { scenario: 'nothing-here' })).scenarios).toEqual({});
      expect((await engineError(ui.comments.counts('demo', { scenario: '../x' }))).code).toBe('invalid');
    },
    LONG,
  );
});

describe('comments: event sources (D9)', () => {
  it(
    'one source per real scenario folder; a reply changes only its own; a linked folder is not one',
    async () => {
      const a = await scanSources(ui.workspace);
      expect([...a.keys()].filter((k) => k.startsWith('comments:'))).toEqual(['comments:demo/quote', 'comments:demo/slow']);
      const { thread } = await uiAdd();
      const b = await scanSources(ui.workspace);
      expect(diffSources(a, b)).toEqual(['comments:demo/quote']);
      await mcp.comments.reply('demo', thread.id, 'An entry.');
      const c = await scanSources(ui.workspace);
      const keys = diffSources(b, c);
      expect(keys).toEqual(['comments:demo/quote']);
      expect(workspaceChanges(keys)).toEqual({ projects: ['demo'], readme: [], scenarios: [], comments: ['demo/quote'], history: false });
      // No comment key changed: no comments field (older readers compare the whole object).
      expect(workspaceChanges(['readme:demo'])).toEqual({ projects: ['demo'], readme: ['demo'], scenarios: [], history: false });
      const elsewhere = join(ws.root, 'elsewhere');
      await mkdir(elsewhere, { recursive: true });
      await symlink(elsewhere, join(project.dir, 'comments', 'linked'));
      try {
        expect([...(await scanSources(ui.workspace)).keys()].filter((k) => k.startsWith('comments:'))).toEqual(['comments:demo/quote', 'comments:demo/slow']);
      } finally {
        await rm(join(project.dir, 'comments', 'linked'));
      }
      // A file renamed in the folder (how the store writes a thread or an entry) moves the folder's signature (probe E4).
      const tmp = join(project.dir, 'comments', 'quote', 'x.tmp');
      await writeFile(tmp, '{}');
      const d = await scanSources(ui.workspace);
      await rename(tmp, join(project.dir, 'comments', 'quote', 'y.tmp'));
      expect(diffSources(d, await scanSources(ui.workspace))).toEqual(['comments:demo/quote']);
      await rm(join(project.dir, 'comments', 'quote', 'y.tmp'));
    },
    LONG,
  );
});
