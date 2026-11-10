/**
 * L3.6 review: the size of what the comment tools return. Thread files planted in a workspace (no render, no ffmpeg),
 * ten threads of 495 replies of 2000 characters each: comments_list carries the last 10 entries of a thread
 * (`entries_total` counts them all) and at most COMMENTS_LIST_UNTRUSTED_MAX characters of thread text, leaving the next
 * threads out with a hint to narrow the listing; comment_reply returns its thread the same way. Tools run in-process
 * on a real engine (client mcp).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newCommentEntryId, newCommentId } from '@retake/core';
import { createEngine } from '@retake/engine';
import type { CommentListView, CommentView, Engine } from '@retake/engine';
import { COMMENTS_LIST_UNTRUSTED_MAX, COMMENT_ENTRIES_SHOWN, TOOLS, okResult } from '../src/index.js';
import type { ToolContext, ToolDef } from '../src/index.js';
import { workspace } from '../../review/test/helpers.js';
import type { Workspace } from '../../review/test/helpers.js';

const LONG = 120_000;
let ws: Workspace;
let engine: Engine;
const ids: string[] = [];
const lastEntry: Record<string, string> = {};
const savedHome = process.env.RETAKE_HOME;

const tool = (name: string): ToolDef => TOOLS.find((t) => t.name === name)!;
const ctx = (): ToolContext => ({ engine, signal: new AbortController().signal });
type CallResult = ReturnType<typeof okResult>;
const chars = (r: CallResult) => r.content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : 0), 0);
/** The text of a result's first block (undefined when it is not a text block: the expectation on it then fails). */
const text0 = (r: CallResult) => (r.content[0]?.type === 'text' ? r.content[0].text : undefined);

function thread(id: string, i: number) {
  const entries = Array.from({ length: 495 }, (_, k) => ({ id: newCommentEntryId(), kind: 'reply', author: { via: 'cli', name: 'Reviewer One' }, text: `${k} ${'y'.repeat(1990)}`, created_at: '2026-10-19T10:00:00.000Z' }));
  lastEntry[id] = entries[494].id;
  return {
    version: 1,
    id,
    scenario: 'quote',
    render: { id: 'quote-v1', created_at: '2026-10-19T09:00:00.000Z', run_id: '20261019-090000-quote', variant: 'landscape', fps: 30, frames: 600, width: 1920, height: 1080 },
    frame: 10 + i,
    time_s: Math.round(((10 + i) / 30) * 1000) / 1000,
    text: 'A long conversation',
    author: { via: 'cli', name: 'Reviewer One' },
    created_at: '2026-10-19T09:30:00.000Z',
    anchor: { segment: 'intro', kind: 'intro', component: 'studio/intro-stack' },
    entries,
  };
}

beforeAll(async () => {
  ws = await workspace();
  process.env.RETAKE_HOME = join(ws.root, '.home');
  const dir = join(ws.project.dir, 'comments', 'quote');
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < 10; i++) {
    const id = newCommentId();
    ids.push(id);
    await writeFile(join(dir, `${id}.json`), `${JSON.stringify(thread(id, i), null, 2)}\n`);
  }
  engine = await createEngine({ root: ws.root, client: 'mcp', autoStartWorker: false });
}, LONG);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await ws?.cleanup();
});

describe('comment tool result sizes', () => {
  it('comments_list: the last 10 entries of each thread, at most the untrusted budget, the rest left out with a hint', async () => {
    const out = await tool('comments_list').run(tool('comments_list').input.parse({ project: 'demo', limit: 20 }), ctx());
    const r = okResult(out);
    expect(chars(r)).toBeLessThan(150_000);
    const v = r.structuredContent as unknown as CommentListView & { threads: Array<CommentView & { entries_total: number }>; left_out_for_size?: number };
    expect(v.total).toBe(10);
    expect(v.threads.length).toBeGreaterThanOrEqual(1);
    expect(v.threads.length).toBeLessThan(10);
    expect(v.left_out_for_size).toBe(10 - v.threads.length);
    expect(JSON.stringify(v.threads.map((t) => t.untrusted)).length).toBeLessThanOrEqual(COMMENTS_LIST_UNTRUSTED_MAX);
    for (const t of v.threads) {
      expect(t.entries_total).toBe(495);
      expect(t.entries).toHaveLength(COMMENT_ENTRIES_SHOWN);
      expect(t.untrusted.entries).toHaveLength(COMMENT_ENTRIES_SHOWN);
      // The newest entries, ids and texts alike.
      expect(t.entries.at(-1)?.id).toBe(lastEntry[t.id]);
      expect(t.untrusted.entries.at(-1)?.id).toBe(lastEntry[t.id]);
      expect(t.untrusted.entries[0].text).toMatch(/^485 /);
    }
    expect(text0(r)).toContain(`495 entries (the last ${COMMENT_ENTRIES_SHOWN}): reply cli`);
    expect(text0(r)).toContain(`(the first ${v.threads.length} shown: the next would pass the ${COMMENTS_LIST_UNTRUSTED_MAX}-character budget of one result — narrow with scenario, render, status or a lower limit)`);
    // One thread asked for: it fits whole (its last entries).
    const one = okResult(await tool('comments_list').run(tool('comments_list').input.parse({ project: 'demo', limit: 1 }), ctx()));
    expect((one.structuredContent as { threads: unknown[]; left_out_for_size?: number }).threads).toHaveLength(1);
    expect(one.structuredContent).not.toHaveProperty('left_out_for_size');
    expect(text0(one)).toContain('(the first 1 shown: raise limit for more)');
  }, LONG);

  it('comment_reply returns its thread with the last 10 entries', async () => {
    const out = await tool('comment_reply').run(tool('comment_reply').input.parse({ project: 'demo', comment_id: ids[0], text: 'Shortened the intro.' }), ctx());
    const r = okResult(out);
    expect(chars(r)).toBeLessThan(60_000);
    const t = (r.structuredContent as { thread: CommentView & { entries_total: number } }).thread;
    expect(t.entries_total).toBe(496);
    expect(t.untrusted.entries).toHaveLength(COMMENT_ENTRIES_SHOWN);
    expect(t.untrusted.entries.at(-1)).toMatchObject({ author: 'agent', text: 'Shortened the intro.' });
  }, LONG);
});
