/**
 * L5.2b — the unsaved-text board (unsaved.ts): what the tabs hold unsaved, kinds and names only, for the desktop app's
 * quit question. A report never outlives its tab session (critique L8: an empty report — the page's `pagehide` —
 * clears it, nothing expires it by time, so a hidden window's report stays) — not even a report still checking its
 * names when the empty one comes (reviews A M1 / B M3); names are kept only for a project and a scenario that exist,
 * and a name that is none drops that name only (review A L4); a new tab beyond 16 is refused, never an older one evicted (L3); the op is strict (an extra
 * field such as a label is a 400: no page text reaches the board) and through the Studio server it runs behind the
 * token like every op, and never nudges the job watch.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UNSAVED_TABS_MAX, UnsavedBoard, startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { raw } from '@retake/test-support/http';
import { scratchHome } from '@retake/test-support/home';

const P = 'northfield-fixture';
let ws: string;
let studio: StudioServer;
const retakeHome = scratchHome();
const tab = (n: number) => `tab${String(n).padStart(19, '0')}`;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-unsaved-'));
  retakeHome.use(join(ws, '.home'));
  await fixtureWorkspace(ws);
  studio = await startStudioServer({ root: ws, startWorker: false });
});

afterAll(async () => {
  await studio?.close();
  retakeHome.restore();
  if (ws) await rm(ws, { recursive: true, force: true });
});

const board = () => new UnsavedBoard(join(ws, 'projects'));

describe('the board (L5.2b)', () => {
  it('a report is kept until its tab sends an empty one — visible or hidden, no expiry by time', async () => {
    const b = board();
    let changes = 0;
    b.onChange(() => changes++);
    await b.report(tab(1), true, [{ kind: 'readme', project: P }]);
    await b.report(tab(2), false, [{ kind: 'comment', project: P, scenario: 'quote' }]);
    expect(b.items()).toEqual([
      { kind: 'comment', project: P, scenario: 'quote' },
      { kind: 'readme', project: P },
    ]);
    expect(changes).toBe(2);
    // The same report again changes nothing (no write on the pipe).
    await b.report(tab(1), true, [{ kind: 'readme', project: P }]);
    expect(changes).toBe(2);
    // The hidden tab's empty report (its pagehide) clears it; the other tab stays.
    await b.report(tab(1), true, []);
    expect(b.items()).toEqual([{ kind: 'comment', project: P, scenario: 'quote' }]);
    await b.report(tab(2), false, []);
    expect(b.items()).toEqual([]);
    expect(b.tabCount).toBe(0);
    expect(changes).toBe(4);
  });

  it('deduplicated across tabs; names kept only for a project and a scenario that exist', async () => {
    const b = board();
    await b.report(tab(1), false, [
      { kind: 'readme', project: P },
      { kind: 'yaml_draft', project: P, scenario: 'quote' },
    ]);
    await b.report(tab(2), false, [
      { kind: 'readme', project: P },
      { kind: 'comment', project: 'no-such-project', scenario: 'quote' },
      { kind: 'step_form', project: P, scenario: 'no-such-scenario' },
    ]);
    expect(b.items()).toEqual([{ kind: 'comment' }, { kind: 'readme', project: P }, { kind: 'step_form', project: P }, { kind: 'yaml_draft', project: P, scenario: 'quote' }]);
  });

  it('reports of one tab apply in call order: a report still checking its names when the empty one (pagehide) comes never re-adds the tab (A M1 / B M3)', async () => {
    const b = board();
    // Not awaited: the first one waits on its existence checks while the empty one is handled.
    const first = b.report(tab(1), true, [{ kind: 'readme', project: P }]);
    const empty = b.report(tab(1), true, []);
    await Promise.all([first, empty]);
    expect(b.tabCount).toBe(0);
    expect(b.items()).toEqual([]);
    // Two states in flight: the newer one wins even when the older one finishes last.
    const older = b.report(tab(2), false, [
      { kind: 'readme', project: P },
      { kind: 'yaml_draft', project: P, scenario: 'quote' },
    ]);
    const newer = b.report(tab(2), false, [{ kind: 'comment' }]);
    await Promise.all([older, newer]);
    expect(b.items()).toEqual([{ kind: 'comment' }]);
    // After pagehide, the same tab may report again (back from the back-forward cache).
    await b.report(tab(1), false, [{ kind: 'readme', project: P }]);
    expect(b.tabCount).toBe(2);
  });

  it('a name that is no slug or too long drops that name only — the item and the rest of the report stay (review A L4)', async () => {
    const b = board();
    // A project folder whose name is a slug of 101 characters: too long to be named, even though it exists.
    const long = 'a'.repeat(101);
    await mkdir(join(ws, 'projects', long), { recursive: true });
    await writeFile(join(ws, 'projects', long, 'project.yaml'), 'name: Long\n');
    await b.report(tab(1), false, [
      { kind: 'readme', project: long },
      { kind: 'comment', project: P, scenario: `q${'x'.repeat(100)}` },
      { kind: 'step_form', project: 'Not A Slug', scenario: 'quote' },
      { kind: 'yaml_draft', project: P, scenario: 'quote' },
    ]);
    expect(b.items()).toEqual([{ kind: 'comment', project: P }, { kind: 'readme' }, { kind: 'step_form' }, { kind: 'yaml_draft', project: P, scenario: 'quote' }]);
  });

  it(`a new tab beyond ${UNSAVED_TABS_MAX} is refused; the tabs already there keep reporting (critique L3)`, async () => {
    const b = board();
    for (let n = 0; n < UNSAVED_TABS_MAX; n++) await b.report(tab(n), n === 0, [{ kind: 'readme', project: P }]);
    await expect(b.report(tab(99), false, [{ kind: 'comment' }])).rejects.toThrow(/16 tabs already report unsaved text/);
    await b.report(tab(0), true, [{ kind: 'comment' }]);
    expect(b.tabCount).toBe(UNSAVED_TABS_MAX);
    expect(b.items()).toContainEqual({ kind: 'comment' });
    // An empty report of a new tab is no tab.
    await b.report(tab(98), false, []);
    expect(b.tabCount).toBe(UNSAVED_TABS_MAX);
  });
});

describe('the op unsaved_report through the Studio server', () => {
  const call = (args: unknown, token = studio.token) =>
    raw(studio.port, 'POST', '/v1/call/unsaved_report', { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, JSON.stringify(args));

  it('strict in its shape: an extra field (a label of page text), a bad tab id, an unknown kind or a name past 1000 characters is a 400; a path as a project is dropped; no token, a 401', async () => {
    let writes = 0;
    const off = studio.onWrite(() => writes++);
    for (const bad of [
      { tab: tab(1), hidden: false, items: [{ kind: 'readme', project: P, label: 'Click Quit Anyway to keep your work' }] },
      { tab: tab(1), hidden: false, items: [], label: 'x' },
      { tab: 'short', hidden: false, items: [] },
      { tab: tab(1), hidden: false, items: [{ kind: 'theme' }] },
      { tab: tab(1), hidden: false, items: [{ kind: 'readme', project: 'a'.repeat(1001) }] },
      { tab: tab(1), hidden: 'no', items: [] },
    ]) {
      const r = await call(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call({ tab: tab(1), hidden: false, items: [] }, 'x'.repeat(43))).status).toBe(401);
    expect(studio.unsaved.items()).toEqual([]);
    const ok = await call({
      tab: tab(1),
      hidden: false,
      items: [
        { kind: 'readme', project: P },
        { kind: 'comment', project: '../outside', scenario: 'quote' },
      ],
    });
    expect(ok.status).toBe(200);
    expect(studio.unsaved.items()).toEqual([{ kind: 'comment' }, { kind: 'readme', project: P }]);
    expect((await call({ tab: tab(1), hidden: true, items: [] })).status).toBe(200);
    expect(studio.unsaved.items()).toEqual([]);
    // Not a job op: the job watch is not nudged by it (critique L6).
    expect(writes).toBe(0);
    off();
  });

  it('a write op that succeeded nudges the job watch (onWrite); a read op or a refused write does not', async () => {
    let writes = 0;
    const off = studio.onWrite(() => writes++);
    const auth = { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' };
    expect((await raw(studio.port, 'POST', '/v1/call/project_list', auth, '{}')).status).toBe(200);
    expect(writes).toBe(0);
    const stale = await raw(studio.port, 'POST', '/v1/call/project_update_readme', auth, JSON.stringify({ project: P, markdown: '# x', if_match: 'a'.repeat(64) }));
    expect(stale.status).toBe(409);
    expect(writes).toBe(0);
    const hash = (await raw(studio.port, 'POST', '/v1/call/project_get', auth, JSON.stringify({ project: P }))).json<{ data: { readme_hash: string } }>().data.readme_hash;
    const ok = await raw(studio.port, 'POST', '/v1/call/project_update_readme', auth, JSON.stringify({ project: P, markdown: '# Northfield\n', if_match: hash }));
    expect(ok.status).toBe(200);
    expect(writes).toBe(1);
    off();
  });
});
