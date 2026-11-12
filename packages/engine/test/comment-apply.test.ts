/**
 * L4.6 part A2 (T5): applying Claude's proposal (engine comments.apply → comments.ts applyProposal), a person channel
 * (`ui`, `cli`). Apply writes exactly the proposal's result bytes through the Studio's own write path (editScenario,
 * every L4.3 rule at the moment of the write) and appends an `apply` entry; Undo apply (scenarios.edit `restore` of the
 * answer's `previous`) gives the base bytes back and the proposal reads `undone` — applicable again (critique B4).
 * ⚑ A planted thread (a proposal changing `setup:` that never went through the write-time checks) is refused at Apply;
 * ⚑ a tampered result hash, ⚑ non-canonical hunks (critique B1), ⚑ a stale base, a superseded or applied proposal, a
 * resolved thread are refused, nothing written; ⚑ only person channels apply, on the thread version they read
 * (`if_match`, checked before the scenario is written); ⚑ the thread lock is held across the scenario write and the
 * apply entry (critique B5): a reply arriving meanwhile waits and lands after, the apply never fails after its write.
 * Fixes after the reviews: ⚑ the view says when Apply would refuse (`blocked`, review A L4); ⚑ a full thread (entries,
 * size) refuses before the scenario is written (review A L5 / B M3).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffLines, textLines } from '@retake/core';
import type { CommentThread } from '@retake/core';
import { EngineError, commentLockFile, createEngine } from '../src/index.js';
import type { Engine } from '../src/index.js';
import { scratchHome } from '@retake/test-support/home';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const RUN = '20261027-090000-quote';
const PROJECT = 'name: W\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: default\n';
const TEXT = `video: Quote
title: {text: Quote}
intro: false
outro: false
scenes:
  - id: a
    page: app
    open: /
    caption: A very long caption that says too much
    steps:
      - hold: 1
      - click: Go
`;
const SHORTER = TEXT.replace('A very long caption that says too much', 'A short caption');
const HOOKED = TEXT.replace('scenes:', 'setup:\n  - http: {method: POST, url: "{{app}}/reset"}\nscenes:');

let ws: string;
let dir: string;
let mcp: Engine;
let ui: Engine;
let cli: Engine;
let tester: Engine;
const retakeHome = scratchHome();
let n = 0;

const scenarioFile = (name: string) => join(dir, 'scenarios', `${name}.yaml`);
const threadPath = (scenario: string, id: string) => join(dir, 'comments', scenario, `${id}.json`);
const readThread = async (scenario: string, id: string) => JSON.parse(await readFile(threadPath(scenario, id), 'utf8')) as CommentThread;

async function failure(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(EngineError);
  return e as EngineError;
}

/** A scenario file with a hand-made open thread (via studio); extra entries as given. */
async function setup(scenario: string, text: string, entries: unknown[] = []): Promise<string> {
  await writeFile(scenarioFile(scenario), text);
  const id = `c_01JQ1000000000000000000${String(++n).padStart(3, '0')}`;
  await mkdir(join(dir, 'comments', scenario), { recursive: true });
  await writeFile(
    threadPath(scenario, id),
    JSON.stringify({
      version: 1,
      id,
      scenario,
      render: { id: `${scenario}-v1`, created_at: '2026-10-27T09:01:00.000Z', run_id: RUN, variant: 'landscape', fps: 30, frames: 90, width: 1920, height: 1080 },
      frame: 30,
      time_s: 1,
      text: 'The caption says too much.',
      author: { via: 'studio', name: 'Reviewer' },
      created_at: '2026-10-27T09:05:00.000Z',
      anchor: { segment: 'a', kind: 'clip' },
      entries,
    }),
  );
  return id;
}

/** A reply entry holding a proposal from `base` to `result` (made by hand: no write-time check), with overrides. */
function planted(base: string, result: string, o: { id?: string; proposal?: Record<string, unknown> } = {}) {
  return {
    id: o.id ?? 'r_01JQ1000000000000000000PR1',
    kind: 'reply',
    author: { via: 'mcp', name: 'agent' },
    text: 'Proposed.',
    created_at: '2026-10-27T09:06:00.000Z',
    proposal: { base_sha256: sha(base), result_sha256: sha(result), eol: 'lf', delta: 'edit', hunks: diffLines(textLines(base), textLines(result)), ...o.proposal },
  };
}

/** A proposal written through the MCP (all write-time checks); its entry id and the thread's hash. */
async function proposed(scenario: string, id: string, result: string, base = TEXT): Promise<{ entry: string; hash: string }> {
  const w = await mcp.comments.reply('w', id, 'Proposed a shorter caption.', { proposal: { scenario_yaml: result, scenario_hash: sha(base) } });
  return { entry: w.entry, hash: w.hash };
}

async function state(scenario: string, id: string): Promise<[Buffer, Buffer, number]> {
  return [await readFile(threadPath(scenario, id)), await readFile(scenarioFile(scenario)), (await stat(scenarioFile(scenario))).mtimeMs];
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ds-comment-apply-'));
  retakeHome.use(join(ws, '.home'));
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
  dir = join(ws, 'projects', 'w');
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), PROJECT);
  mcp = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
  ui = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
  cli = await createEngine({ root: ws, client: 'cli', autoStartWorker: false });
  tester = await createEngine({ root: ws, client: 'test', autoStartWorker: false });
});

afterAll(async () => {
  retakeHome.restore();
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('Apply (T5)', () => {
  it('⚑ writes exactly the result bytes through the Studio write path and appends the apply entry; Undo gives the base back, the proposal reads undone and applies again (critique B4)', async () => {
    const id = await setup('quote', TEXT);
    const p = await proposed('quote', id, SHORTER);
    const a = await ui.comments.apply('w', id, { entry_id: p.entry, if_match: p.hash });
    expect(await readFile(scenarioFile('quote'), 'utf8')).toBe(SHORTER);
    expect(a).toMatchObject({
      scenario: { name: 'quote', file: 'scenarios/quote.yaml', hash: sha(SHORTER), previous: { text: TEXT, hash: sha(TEXT) } },
      label: `Applied the proposal of comment ${id}`,
      change: 'edit',
      problems: [],
    });
    expect(a.hash).toBe(sha(await readFile(threadPath('quote', id))));
    const t = await readThread('quote', id);
    expect(t.entries.at(-1)).toMatchObject({ id: a.entry, kind: 'apply', author: { via: 'studio' }, text: '', applies: p.entry, scenario_sha256: sha(SHORTER) });
    expect(a.thread.entries.find((e) => e.id === p.entry)?.proposal).toMatchObject({ state: 'applied', actionable: false });
    expect(a.thread.entries.at(-1)).toMatchObject({ kind: 'apply', applies: p.entry, scenario_sha256: sha(SHORTER) });
    expect(await ui.comments.proposal('w', id)).toMatchObject({ state: 'applied', verified: true, actionable: false });
    // Applied twice: refused, nothing written.
    const before = await state('quote', id);
    expect(await failure(ui.comments.apply('w', id, { entry_id: p.entry, if_match: a.hash }))).toMatchObject({ code: 'conflict', message: expect.stringMatching(/already applied/) });
    expect(await state('quote', id)).toEqual(before);
    // Undo apply: the Studio's restore of `previous` (a version the engine read: accepted).
    const undo = await ui.scenarios.edit('w', 'quote', { hash: a.scenario.hash, edit: { kind: 'restore', text: a.scenario.previous.text, text_hash: a.scenario.previous.hash } });
    expect(undo.hash).toBe(sha(TEXT));
    expect(await readFile(scenarioFile('quote'), 'utf8')).toBe(TEXT);
    const g = await ui.comments.get('w', id);
    expect(g.entries.find((e) => e.id === p.entry)?.proposal).toMatchObject({ state: 'undone', actionable: true });
    expect(await ui.comments.proposal('w', id)).toMatchObject({ state: 'undone', actionable: true, verified: true });
    const again = await ui.comments.apply('w', id, { entry_id: p.entry, if_match: g.hash });
    expect(await readFile(scenarioFile('quote'), 'utf8')).toBe(SHORTER);
    expect((await readThread('quote', id)).entries.filter((e) => e.kind === 'apply').map((e) => e.applies)).toEqual([p.entry, p.entry]);
    expect(again.problems).toEqual([]);
  });

  it('⚑ a planted thread whose proposal changes setup: (never checked when written) is refused at Apply by the Studio rules; nothing written', async () => {
    const result = HOOKED.replace('/reset', '/wipe');
    const id = await setup('planted', HOOKED, [planted(HOOKED, result)]);
    const thread = await ui.comments.get('w', id);
    const before = await state('planted', id);
    // The view says so before anyone clicks (review A L4): Apply's own checks, project-relative words.
    const view = await ui.comments.proposal('w', id);
    expect(view).toMatchObject({ state: 'pending', actionable: true });
    expect(view.blocked).toMatch(/^not applied: setup changed: hooks and mocks run on this Mac/);
    expect(view.blocked).not.toContain(ws);
    const e = await failure(ui.comments.apply('w', id, { entry_id: 'r_01JQ1000000000000000000PR1', if_match: thread.hash }));
    expect(e).toMatchObject({ code: 'refused', details: { sections: ['setup'] } });
    expect(e.message).toMatch(/^not applied: setup changed: hooks and mocks run on this Mac/);
    expect(await state('planted', id)).toEqual(before);
    // A proposal Apply would take has no `blocked`.
    const okId = await setup('plain', TEXT);
    await proposed('plain', okId, SHORTER);
    expect((await ui.comments.proposal('w', okId)).blocked).toBeUndefined();
  });

  it('⚑ a full thread refuses before the scenario is written (review A L5 / B M3): the entry cap and the file-size cap, nothing written', async () => {
    const filler = (i: number) => ({ id: `r_01JQ2${String(i).padStart(21, '0')}`, kind: 'reply', author: { via: 'cli', name: 'Reviewer' }, text: 'More.', created_at: '2026-10-27T09:07:00.000Z' });
    // 499 entries + the proposal = 500: the apply entry would be the 501st.
    const full = await setup('full', TEXT, [...Array.from({ length: 499 }, (_, i) => filler(i)), planted(TEXT, SHORTER)]);
    const thread = await ui.comments.get('w', full);
    const before = await state('full', full);
    expect((await ui.comments.proposal('w', full)).blocked).toBe(`not applied: comment ${full} has 500 entries: start a new thread`);
    const e = await failure(ui.comments.apply('w', full, { entry_id: 'r_01JQ1000000000000000000PR1', if_match: thread.hash }));
    expect(e).toMatchObject({ code: 'refused', message: `not applied: comment ${full} has 500 entries: start a new thread — nothing was written` });
    expect(await state('full', full)).toEqual(before);
    // Close to 2 MB (3-byte characters): the apply entry would pass the file cap.
    const MAX = 2 * 1024 * 1024;
    const heavy = await setup('heavy', TEXT, [planted(TEXT, SHORTER)]);
    const t = await readThread('heavy', heavy);
    const sizeOf = () => Buffer.byteLength(`${JSON.stringify(t, null, 2)}\n`);
    let i = 0;
    for (; sizeOf() + 6200 < MAX; i++) t.entries.push({ ...filler(i), text: '東'.repeat(2000) } as CommentThread['entries'][number]);
    // One more filler sized so that 20–80 bytes are left: less than any apply entry.
    t.entries.push({ ...filler(i), text: '東' } as CommentThread['entries'][number]);
    const last = t.entries.at(-1)!;
    last.text = '東'.repeat(Math.floor((MAX - 50 - sizeOf() + 3) / 3) + 1);
    expect(MAX - sizeOf()).toBeGreaterThan(0);
    expect(MAX - sizeOf()).toBeLessThan(120);
    await writeFile(threadPath('heavy', heavy), `${JSON.stringify(t, null, 2)}\n`);
    const th = await ui.comments.get('w', heavy);
    const b2 = await state('heavy', heavy);
    const e2 = await failure(ui.comments.apply('w', heavy, { entry_id: 'r_01JQ1000000000000000000PR1', if_match: th.hash }));
    expect(e2).toMatchObject({ code: 'refused', message: expect.stringMatching(/^not applied: comment .* would grow past 2 MB with this entry: start a new thread — nothing was written$/) });
    expect(await state('heavy', heavy)).toEqual(b2);
  });

  it('⚑ a tampered result hash and ⚑ non-canonical hunks (critique B1) are refused: the bytes Apply writes are the bytes the diff shows', async () => {
    const tamperedId = await setup('tampered', TEXT, [planted(TEXT, SHORTER, { proposal: { result_sha256: sha('another text') } })]);
    let before = await state('tampered', tamperedId);
    let e = await failure(ui.comments.apply('w', tamperedId, { entry_id: 'r_01JQ1000000000000000000PR1', if_match: sha(before[0]) }));
    expect(e).toMatchObject({ code: 'refused', message: expect.stringMatching(/does not give the text it names \(its result hash\)/) });
    expect(await state('tampered', tamperedId)).toEqual(before);
    // The same bytes, but a hunk that also "changes" the unchanged line before the caption: not the canonical diff.
    const lines = textLines(TEXT);
    const loose = [{ at: 8, del: [lines[7], lines[8]], add: [lines[7], '    caption: A short caption'] }];
    const looseId = await setup('loose', TEXT, [planted(TEXT, SHORTER, { proposal: { hunks: loose } })]);
    before = await state('loose', looseId);
    e = await failure(ui.comments.apply('w', looseId, { entry_id: 'r_01JQ1000000000000000000PR1', if_match: sha(before[0]) }));
    expect(e).toMatchObject({ code: 'refused', message: expect.stringMatching(/is not the canonical line diff of its text/) });
    expect(await state('loose', looseId)).toEqual(before);
    // The view says the same: not verified, not actionable as exact.
    expect(await ui.comments.proposal('w', looseId)).toMatchObject({ verified: false });
  });

  it('⚑ a stale base is a conflict (ask Claude again); a superseded proposal and a resolved thread are refused; nothing written', async () => {
    const id = await setup('stale', TEXT);
    const p = await proposed('stale', id, SHORTER);
    const moved = TEXT.replace('title: {text: Quote}', 'title: {text: Quote, kicker: New}');
    await writeFile(scenarioFile('stale'), moved);
    let before = await state('stale', id);
    let e = await failure(ui.comments.apply('w', id, { entry_id: p.entry, if_match: p.hash }));
    expect(e).toMatchObject({ code: 'conflict', details: { state: 'stale', current: sha(moved) } });
    expect(e.message).toMatch(/changed since this was proposed — ask Claude to propose again/);
    expect(await state('stale', id)).toEqual(before);

    const id2 = await setup('superseded', TEXT);
    const first = await proposed('superseded', id2, SHORTER);
    const second = await proposed('superseded', id2, TEXT.replace('A very long caption that says too much', 'Shorter still'));
    before = await state('superseded', id2);
    e = await failure(ui.comments.apply('w', id2, { entry_id: first.entry, if_match: second.hash }));
    expect(e).toMatchObject({ code: 'conflict', details: { state: 'superseded', newest: second.entry } });
    expect(await state('superseded', id2)).toEqual(before);

    const id3 = await setup('resolvedapply', TEXT);
    const p3 = await proposed('resolvedapply', id3, SHORTER);
    const r = await ui.comments.resolve('w', id3, { note: 'Fine as it is.', if_match: p3.hash });
    before = await state('resolvedapply', id3);
    e = await failure(ui.comments.apply('w', id3, { entry_id: p3.entry, if_match: r.hash }));
    expect(e).toMatchObject({ code: 'conflict', message: expect.stringMatching(/is resolved — reopen it first/) });
    expect(await state('resolvedapply', id3)).toEqual(before);
  });

  it('⚑ only person channels apply, on the thread version they read: mcp / test refused, if_match missing (invalid) or stale (conflict) — checked before the scenario write', async () => {
    const id = await setup('channel', TEXT);
    const p = await proposed('channel', id, SHORTER);
    const before = await state('channel', id);
    for (const e of [mcp, tester]) {
      const x = await failure(e.comments.apply('w', id, { entry_id: p.entry, if_match: p.hash }));
      expect(x).toMatchObject({ code: 'refused', message: expect.stringMatching(/apply \(applying a proposal\) is for a person \(in the Studio: an agent proposes, a person applies\)/) });
    }
    expect(await failure(ui.comments.apply('w', id, { entry_id: p.entry }))).toMatchObject({ code: 'invalid', details: { argument: 'if_match' } });
    expect(await state('channel', id)).toEqual(before);
    // Claude replied meanwhile: the page's version is stale — the scenario is not written.
    const meanwhile = await mcp.comments.reply('w', id, 'One more thing.');
    const scenarioBefore = await readFile(scenarioFile('channel'));
    const stale = await failure(ui.comments.apply('w', id, { entry_id: p.entry, if_match: p.hash }));
    expect(stale).toMatchObject({ code: 'conflict', details: { current: meanwhile.hash } });
    expect(await readFile(scenarioFile('channel'))).toEqual(scenarioBefore);
    // The terminal (a person) applies without one.
    const done = await cli.comments.apply('w', id, { entry_id: p.entry });
    expect(done.scenario.hash).toBe(sha(SHORTER));
    expect((await readThread('channel', id)).entries.at(-1)?.author.via).toBe('cli');
  });

  it('⚑ critique B5: the thread lock is held across the scenario write and the apply entry — a reply arriving meanwhile waits and lands after', async () => {
    for (let round = 0; round < 3; round++) {
      const scenario = `locked${round}`;
      const id = await setup(scenario, TEXT);
      const p = await proposed(scenario, id, SHORTER);
      const lockFile = commentLockFile(dir, id);
      const applying = ui.comments.apply('w', id, { entry_id: p.entry, if_match: p.hash });
      // Once the apply holds the thread's lock, Claude replies.
      const t0 = Date.now();
      while (!existsSync(lockFile) && Date.now() - t0 < 5000) await new Promise((r) => setImmediate(r));
      const replying = mcp.comments.reply('w', id, 'A reply while applying.');
      const [a, r] = await Promise.all([applying, replying]);
      expect(a.problems, `round ${round}`).toEqual([]);
      expect(a.entry).toBeDefined();
      expect(await readFile(scenarioFile(scenario), 'utf8')).toBe(SHORTER);
      const kinds = (await readThread(scenario, id)).entries.map((e) => [e.kind, e.id]);
      expect(kinds).toEqual([
        ['reply', p.entry],
        ['apply', a.entry],
        ['reply', r.entry],
      ]);
    }
  });
});
