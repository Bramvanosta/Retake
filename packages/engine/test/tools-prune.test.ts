/**
 * Older Tools removed (engine tools/prune.ts; the decisions' "Prune" rule): only what nothing may still need —
 * not the running version's, not another copy's that started within 30 days (by its own bundle.json), not an update's
 * pre-downloaded ones, not those a live process of another copy uses; `force` keeps the running and pending ones only;
 * never beside an install.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeToolEntries } from '@retake/test-support/tools';
import { addPending, pruneTools, recordStarted, registerInUse, removePending } from '../src/tools/prune.js';
import { takeToolsLock } from '../src/tools/state.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-tools-prune-')));
afterAll(() => {
  spawnSync('/bin/chmod', ['-R', 'u+w', tmp]);
  rmSync(tmp, { recursive: true, force: true });
});
const DAY = 86_400_000;
let now = Date.parse('2026-11-17T12:00:00.000Z');
const clock = { now: () => now, monotonic: () => performance.now() };
let n = 0;

const current = fakeToolEntries('0.0.3');
const previous = fakeToolEntries('0.0.2');
const oldest = fakeToolEntries('0.0.1');

/** A home whose Tools folder holds the three versions' folders (read-only, as installed). */
function home(): { env: { RETAKE_HOME: string }; tools: string } {
  const h = join(tmp, `home${n++}`);
  const tools = join(h, 'tools');
  for (const e of [...current, ...previous, ...oldest]) {
    const f = join(tools, ...e.folder.split('/'));
    mkdirSync(f, { recursive: true });
    writeFileSync(join(f, 'file'), 'x'.repeat(100));
    spawnSync('/bin/chmod', ['-R', 'a-w', f]);
  }
  return { env: { RETAKE_HOME: h }, tools };
}

const folders = (entries: typeof current) => entries.map((e) => e.folder);

describe('prune', () => {
  it("removes what nothing names; keeps this version's", async () => {
    const { env, tools } = home();
    const r = await pruneTools(env, { entries: current, version: '0.0.3', clock });
    expect(r.removed.map((x) => x.folder).sort()).toEqual([...folders(previous), ...folders(oldest)].sort());
    expect(r.removed.every((x) => x.bytes === 100)).toBe(true);
    for (const f of folders(current)) expect(existsSync(join(tools, f))).toBe(true);
    expect(existsSync(join(tools, 'browsers'))).toBe(true);
  });

  it('another copy that started within 30 days keeps the Tools its own bundle.json names (two apps on one home never prune each other)', async () => {
    const { env, tools } = home();
    const other = join(tmp, `Other${n++}.app`);
    mkdirSync(join(other, 'Contents', 'Resources'), { recursive: true });
    writeFileSync(join(other, 'Contents', 'Resources', 'bundle.json'), JSON.stringify({ v: 2, tools: previous }));
    recordStarted(env, { app: '0.0.2', location: other, entries: oldest, clock });
    const r = await pruneTools(env, { entries: current, version: '0.0.3', clock });
    // Its bundle.json wins over its record (it was updated in place since).
    expect(r.removed.map((x) => x.folder).sort()).toEqual(folders(oldest).sort());
    expect(r.kept.map((x) => x.folder).sort()).toEqual(folders(previous).sort());
    expect(r.kept[0]!.why).toMatch(/Retake 0\.0\.2 started with them within 30 days/);
    // Its bundle.json gone: its record says what it used. Older than 30 days: nothing kept for it.
    rmSync(other, { recursive: true });
    now += 31 * DAY;
    expect((await pruneTools(env, { entries: current, version: '0.0.3', clock })).removed.map((x) => x.folder).sort()).toEqual(folders(previous).sort());
    now -= 31 * DAY;
    expect(JSON.parse(readFileSync(join(tools, '.started.json'), 'utf8'))).toHaveLength(1);
  });

  it("an update's pre-downloaded Tools are kept, even with force while that update is under way, until the update starts or is abandoned", async () => {
    const { env } = home();
    addPending(env, { app: '0.0.4', folders: folders(oldest), clock });
    const forced = await pruneTools(env, { entries: current, version: '0.0.3', clock, force: true, keepPending: '0.0.4' });
    expect(forced.removed.map((x) => x.folder).sort()).toEqual(folders(previous).sort());
    expect(forced.kept.map((x) => x.why)).toEqual(expect.arrayContaining([expect.stringMatching(/an update to 0\.0\.4 downloaded them/)]));
    removePending(env, '0.0.4');
    expect((await pruneTools(env, { entries: current, version: '0.0.3', clock })).removed.map((x) => x.folder).sort()).toEqual(folders(oldest).sort());
  });

  it('a pending update keeps its Tools 30 days at most; force drops every pending update but the one under way (the records go too)', async () => {
    const { env, tools } = home();
    const pending = () => (JSON.parse(readFileSync(join(tools, '.pending.json'), 'utf8')) as Array<{ app: string }>).map((p) => p.app);
    // An update that never started, 31 days ago: its Tools go, its record too.
    addPending(env, { app: '0.0.9', folders: folders(oldest), clock: { now: () => now - 31 * DAY } });
    addPending(env, { app: '0.0.4', folders: folders(previous), clock });
    const r = await pruneTools(env, { entries: current, version: '0.0.3', clock });
    expect(r.removed.map((x) => x.folder).sort()).toEqual(folders(oldest).sort());
    expect(pending()).toEqual(['0.0.4']);
    // Force with no update under way: the recent pending one goes as well.
    const forced = await pruneTools(env, { entries: current, version: '0.0.3', clock, force: true });
    expect(forced.removed.map((x) => x.folder).sort()).toEqual(folders(previous).sort());
    expect(pending()).toEqual([]);
  });

  it('a live process of another copy keeps the Tools it uses; a dead one’s record is dropped; force ignores the starts and the users', async () => {
    const { env, tools } = home();
    const release = await registerInUse(env, { location: '/Applications/Other.app', folders: folders(previous), clock });
    writeFileSync(join(tools, '.in-use', '999999.json'), JSON.stringify({ pid: 999_999, command: 'worker', since: 'x', folders: folders(oldest) }));
    const r = await pruneTools(env, { entries: current, version: '0.0.3', clock });
    expect(r.removed.map((x) => x.folder).sort()).toEqual(folders(oldest).sort());
    expect(r.kept.map((x) => x.why)).toEqual(expect.arrayContaining([`a running process (pid ${process.pid}) uses them`]));
    expect(existsSync(join(tools, '.in-use', '999999.json'))).toBe(false);
    expect((await pruneTools(env, { entries: current, version: '0.0.3', clock, force: true })).removed.map((x) => x.folder).sort()).toEqual(folders(previous).sort());
    release();
    expect(existsSync(join(tools, '.in-use', `${process.pid}.json`))).toBe(false);
  });

  it("never beside an install (busy, nothing removed); other versions' partial downloads go, this version's stay", async () => {
    const { env, tools } = home();
    const lock = await takeToolsLock(tools, 'studio', '0.0.3', clock);
    expect('release' in lock).toBe(true);
    const busy = await pruneTools(env, { entries: current, version: '0.0.3', clock });
    expect(busy).toMatchObject({ busy: { pid: process.pid, by: 'studio' }, removed: [] });
    if ('release' in lock) lock.release();
    mkdirSync(join(tools, '.partial'), { recursive: true });
    writeFileSync(join(tools, '.partial', 'chromium-003.zip.part'), 'mine');
    writeFileSync(join(tools, '.partial', 'chromium-002.zip.part'), 'old');
    await pruneTools(env, { entries: current, version: '0.0.3', clock });
    expect(existsSync(join(tools, '.partial', 'chromium-003.zip.part'))).toBe(true);
    expect(existsSync(join(tools, '.partial', 'chromium-002.zip.part'))).toBe(false);
  });
});
