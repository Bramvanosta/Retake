/**
 * `retake comment add | list | reply | resolve | reopen` (L3.6) on synthetic renders (the review tests' helpers): frames
 * by marker, time and number, the region, the author (`--author`, else $RETAKE_AUTHOR), `--json`, the threads
 * printed with their entries (L4.6: a reply holding a proposal with its state, an apply by its proposal), and the usage /
 * lookup errors. The first test reads the still (renders drawn with ffmpeg,
 * ffprobe); without them the renders are empty files and the others run.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine } from '@retake/engine';
import type { CommentListView, CommentView, CommentWritten } from '@retake/engine';
import { EXIT, main, memoryIo } from '../src/index.js';
import { hasTool, makeCase, scenesTimeline, workspace } from '../../review/test/helpers.js';
import type { Workspace } from '../../review/test/helpers.js';

const can = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 240_000;
let ws: Workspace;
const savedAuthor = process.env.RETAKE_AUTHOR;

async function retake(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', ws.root, '--no-color', ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

beforeAll(async () => {
  ws = await workspace();
  const v1 = await makeCase(ws, 'quote', scenesTimeline([6, 6], { steps: { 1: [{ action: 'wait_for', t_start: 9.11, t_end: 9.112, mark: 'proposal' }] } }), { noVideo: !can });
  await writeFile(
    join(v1.run.dir, 'scenario.yaml'),
    'scenes:\n  - id: s1\n    steps: [{click: Go}, {hold: 2.4}]\n  - id: s2\n    steps: [{click: Go}, {wait_for: Proposal ready, mark: proposal}, {hold: 2.4}]\n',
  );
  await makeCase(ws, 'quote', v1.timeline, { version: 2, run: v1.run, noVideo: !can });
}, LONG);
afterAll(async () => {
  if (savedAuthor === undefined) delete process.env.RETAKE_AUTHOR;
  else process.env.RETAKE_AUTHOR = savedAuthor;
  await ws?.cleanup();
});

describe('retake comment', () => {
  it.skipIf(!can)(
    'adds a comment at a marker with a region (--json) and by time with the anchor printed',
    async () => {
      const r = await retake('comment', 'add', 'demo', 'quote-v1', '--marker', 'proposal', '--region', '0.6,0.3,0.2,0.2', '--author', 'Reviewer One', '--json', 'Keep the total on screen longer');
      expect(r.code, r.err).toBe(EXIT.ok);
      const { thread, warnings } = JSON.parse(r.out) as { thread: CommentView; warnings: string[] };
      expect(warnings).toEqual([]);
      expect(thread).toMatchObject({
        render_id: 'quote-v1',
        marker: 'proposal',
        via: 'cli',
        region: { x: 0.6, y: 0.3, w: 0.2, h: 0.2 },
        untrusted: { author: 'Reviewer One', text: 'Keep the total on screen longer' },
      });
      expect(thread.anchor).toMatchObject({ scene: 's2', step: 1, step_ref: 's2.1', action: 'wait_for', marker: 'proposal' });
      expect(thread.still).toMatch(/\.retake\/comments\/c_[0-9A-Z]{26}\.jpg$/);

      process.env.RETAKE_AUTHOR = 'Reviewer Two';
      const t = await retake('comment', 'add', 'demo', 'latest', '--scenario', 'quote', '--at', '1', 'The intro is too long');
      expect(t.code, t.err).toBe(EXIT.ok);
      expect(t.err).toMatch(/✓ comment c_[0-9A-Z]{26} on quote-v2 frame 30 \(00:01\.00\): intro intro · studio\/intro-\w+/);
      expect(t.err).toMatch(/comments\/quote\/c_[0-9A-Z]{26}\.json · still .*\.jpg/);
    },
    LONG,
  );

  it(
    'refuses bad frames, regions, authors and texts as usage errors; an unknown render fails',
    async () => {
      const usage: string[][] = [
        ['--frame', '99999'],
        ['--frame', '1', '--at', '1'],
        [],
        ['--at', '1s'],
        ['--frame', '-1'],
        ['--frame', '1', '--region', '0.9,0.9,0.2,0.2'],
        ['--frame', '1', '--region', '1,2,3'],
        ['--frame', '1', '--author', '‮'],
        ['--marker', 'nope'],
      ];
      for (const args of usage) {
        const r = await retake('comment', 'add', 'demo', 'quote-v1', ...args, 'text');
        expect(r.code, args.join(' ')).toBe(EXIT.usage);
      }
      const long = await retake('comment', 'add', 'demo', 'quote-v1', '--frame', '1', 'x'.repeat(2001));
      expect(long.code).toBe(EXIT.usage);
      expect(long.err).toContain('2001 characters: at most 2000');
      const missing = await retake('comment', 'add', 'demo', 'quote-v9', '--frame', '1', 'text');
      expect(missing.code).toBe(EXIT.failure);
      expect(missing.err).toContain('render "quote-v9" not found');
      expect((await retake('comment', 'list', 'demo', '--status', 'closed')).code).toBe(EXIT.usage);
    },
    LONG,
  );

  it(
    'replies, resolves with a later render, lists, reopens',
    async () => {
      const added = JSON.parse((await retake('comment', 'add', 'demo', 'quote-v1', '--frame', '200', '--json', 'Slow the cursor down')).out) as { thread: CommentView };
      const id = added.thread.id;
      const reply = await retake('comment', 'reply', 'demo', id, 'Which part?', '--author', 'Reviewer One');
      expect(reply.code, reply.err).toBe(EXIT.ok);
      expect(reply.err).toMatch(new RegExp(`✓ replied to ${id} \\(entry r_[0-9A-Z]{26}\\): now open`));
      expect((await retake('comment', 'resolve', 'demo', id)).code).toBe(EXIT.usage);
      const older = await retake('comment', 'resolve', 'demo', id, '--note', 'Done', '--render', 'quote-v1');
      expect(older.code).toBe(EXIT.failure);
      expect(older.err).toContain('is not later than the commented render');
      const resolved = await retake('comment', 'resolve', 'demo', id, '--note', 'Slower cursor', '--render', 'quote-v2', '--json');
      expect(resolved.code, resolved.err).toBe(EXIT.ok);
      expect((JSON.parse(resolved.out) as CommentWritten).thread.resolution).toMatchObject({ via: 'cli', render_id: 'quote-v2' });
      const again = await retake('comment', 'resolve', 'demo', id, '--note', 'Again');
      expect(again.code).toBe(EXIT.failure);
      expect(again.err).toContain('already resolved');

      const open = JSON.parse((await retake('comment', 'list', 'demo', '--json')).out) as CommentListView;
      expect(open.threads.map((t) => t.id)).not.toContain(id);
      const all = await retake('comment', 'list', 'demo', '--status', 'all', '--render', 'quote-v1');
      expect(all.code, all.err).toBe(EXIT.ok);
      expect(all.err).toContain(`${id} resolved · quote-v1 frame 200`);
      expect(all.err).toMatch(/Reviewer One \(cli\) replied, .*:\n {4}Which part\?/);
      expect(all.err).toMatch(/resolved with quote-v2, .*:\n {4}Slower cursor/);
      expect(all.err).toContain('newer renders: quote-v2');
      expect(all.err).not.toContain('The intro is too long'); // made on quote-v2
      const limited = await retake('comment', 'list', 'demo', '--status', 'all', '--limit', '1');
      expect(limited.err).toMatch(/1 of \d+ threads shown \(--limit\)/);

      const reopened = await retake('comment', 'reopen', 'demo', id, '--note', 'Still too fast');
      expect(reopened.code, reopened.err).toBe(EXIT.ok);
      expect(reopened.err).toContain('now open');
      expect((await retake('comment', 'reopen', 'demo', id)).code).toBe(EXIT.failure);
      expect((await retake('comment', 'reply', 'demo', '../x', 'text')).code).toBe(EXIT.usage);
      const none = await retake('comment', 'list', 'demo', '--status', 'resolved', '--scenario', 'quote');
      expect(none.err).toContain('no resolved comment in demo · quote');
    },
    LONG,
  );

  it(
    'prints the studio channel of a thread and an entry written from the Studio (L4.6)',
    async () => {
      process.env.RETAKE_AUTHOR = 'Studio Person';
      const home = process.env.RETAKE_HOME;
      process.env.RETAKE_HOME = join(ws.root, '.home');
      const ui = await createEngine({ root: ws.root, client: 'ui', autoStartWorker: false }).finally(() => {
        if (home === undefined) delete process.env.RETAKE_HOME;
        else process.env.RETAKE_HOME = home;
      });
      const record = JSON.parse(await readFile(join(ws.project.dir, 'renders', 'quote-v1.json'), 'utf8')) as { created_at: string };
      const { thread } = await ui.comments.add('demo', { render: 'quote-v1', render_created_at: record.created_at, frame: 120, text: 'Made in the Studio' });
      await ui.comments.reply('demo', thread.id, 'And answered there.');
      const all = await retake('comment', 'list', 'demo', '--status', 'all', '--render', 'quote-v1');
      expect(all.code, all.err).toBe(EXIT.ok);
      expect(all.err).toContain(`${thread.id} open · quote-v1 frame 120`);
      expect(all.err).toMatch(/Studio Person \(studio\), .*:\n {4}Made in the Studio/);
      expect(all.err).toMatch(/Studio Person \(studio\) replied, .*:\n {4}And answered there\./);

      // An MCP proposal and its apply in the Studio are printed as such (review B L2), with the proposal's state.
      const tour =
        'video: Quote\nintro: false\noutro: false\nscenes:\n  - id: s1\n    page: app\n    open: /\n    caption: The intro caption says far too much\n    steps:\n      - click: Go\n      - hold: 2.4\n';
      await mkdir(join(ws.project.dir, 'scenarios'), { recursive: true });
      await writeFile(join(ws.project.dir, 'scenarios', 'quote.yaml'), tour);
      const mcp = await createEngine({ root: ws.root, client: 'mcp', autoStartWorker: false });
      const proposed = await mcp.comments.reply('demo', thread.id, 'Proposed a shorter caption.', {
        proposal: { scenario_yaml: tour.replace('The intro caption says far too much', 'A short intro'), scenario_hash: createHash('sha256').update(tour).digest('hex') },
      });
      const pending = await retake('comment', 'list', 'demo', '--status', 'all', '--render', 'quote-v1');
      expect(pending.err).toMatch(/agent \(mcp\) replied with a proposal \(pending, \+1 −1\), .*:\n {4}Proposed a shorter caption\./);
      await ui.comments.apply('demo', thread.id, { entry_id: proposed.entry, if_match: proposed.hash });
      const applied = await retake('comment', 'list', 'demo', '--status', 'all', '--render', 'quote-v1');
      expect(applied.err).toContain('agent (mcp) replied with a proposal (applied, +1 −1)');
      expect(applied.err).toContain(`Studio Person (studio) applied the proposal of ${proposed.entry}, `);
      expect(applied.err.match(/\(studio\) replied, /g)).toHaveLength(1);
    },
    LONG,
  );
});
