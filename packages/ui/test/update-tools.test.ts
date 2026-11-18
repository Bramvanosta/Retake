/**
 * The update's Tools before its restart (update-tools.ts, engine tools/update-archive.ts; DESIGN §4p (d)): the
 * shell's `update_archive` line (strict), the `preparing` state and the `tools` failure (strict, Install and Restart
 * live again), and the server's flow on a real update archive made here with /usr/bin/tar (a fake app's bundle.json
 * naming fixture Tools of the new version, served by a fake download — never the network):
 * - ready: the new version's Tools are installed beside the current ones (kept by `.pending.json`), the shell is told
 *   `update_tools` ready, desktop_update_status shows them;
 * - refused: an archive changed since it was verified (another SHA-256), a bundle.json of another version — failed,
 *   nothing installed, the reason as untrusted text;
 * - skipped: a bundle.json this version cannot read whole (another manifest version, a Tool id it does not know, one it
 *   lacks, a host off its allow-list, none in the archive) — `skip`, nothing downloaded: the update goes on and the new
 *   version downloads its Tools at its first start (this version never decides which later releases install);
 * - busy: while another install holds the Tools (the person's own download), the update's waits for it, then goes on;
 * - given up: the shell's next state (Later: available) stops the download and forgets the pending record.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ToolEntry } from '@retake/core/io';
import { toolFixtures } from '@retake/test-support/tools';
import type { FixtureTools } from '@retake/test-support/tools';
import { scratchHome } from '@retake/test-support/home';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { raw } from '@retake/test-support/http';
import { parseShellLine } from '../src/server/shell-line.js';
import { installable, parseUpdateLine } from '../src/server/update-ops.js';
import type { UpdateLine } from '../src/server/update-ops.js';
import { applyShellLine, startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fakeNet, fakeTools } from './tools-fake.js';
import type { FakeNet } from './tools-fake.js';

// biome-ignore lint/suspicious/noExplicitAny: the answers' JSON is read as data
type Untyped = any;

const POLL = { timeout: 20_000, interval: 50 };
const base = realpathSync(mkdtempSync(join(tmpdir(), 'update-tools-')));
const ws = join(base, 'ws');
const rhome = join(base, 'retake-home');
const testHome = scratchHome();
let studio: StudioServer;
let next: FixtureTools;
let net2: FakeNet;
const lines: string[] = [];
let n = 0;

/** An update archive as the shell keeps it: `<dir>/updates/update-<pid>.tar.gz`, its bundle.json `manifest`. */
function archiveOf(manifest: unknown): { path: string; sha256: string } {
  const top = join(base, `stage${n++}`);
  const res = join(top, 'Retake.app', 'Contents', 'Resources');
  mkdirSync(res, { recursive: true });
  writeFileSync(join(res, 'bundle.json'), JSON.stringify(manifest));
  const dir = join(base, `cache${n}`, 'updates');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `update-${4000 + n}.tar.gz`);
  const r = spawnSync('/usr/bin/tar', ['-czf', path, '-C', top, 'Retake.app'], { env: { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1' } });
  expect(r.status).toBe(0);
  return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}
const manifestOf = (app: string, tools: readonly ToolEntry[]) => ({ v: 2, app, tools });
const line = (version: string, a: { path: string; sha256: string }) => JSON.stringify({ type: 'update_archive', version, path: a.path, sha256: a.sha256 });
const shell = (text: string) => applyShellLine(studio.setup, ws, text, studio.update);
const state = (s: Record<string, unknown>) => shell(JSON.stringify({ type: 'update', current: '0.0.1', ...s }));
const updateStatus = async () => {
  const r = await raw(studio.port, 'POST', '/v1/call/desktop_update_status', { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, '{}');
  return r.json<{ data: Untyped }>().data;
};
const answers = () => lines.filter((l) => l.startsWith('{"type":"update_tools"'));
function wipe(dir: string): void {
  spawnSync('/bin/chmod', ['-R', 'u+w', dir]);
  rmSync(dir, { recursive: true, force: true });
}

beforeAll(async () => {
  mkdirSync(ws);
  testHome.use(rhome);
  await fixtureWorkspace(ws);
  const t = await fakeTools(base);
  next = await toolFixtures(join(base, 'next-fixtures'), '0.0.2');
  net2 = fakeNet(next);
  const both = { ...t.engineTools, fetch: (u: string, i: Parameters<FakeNet['fetch']>[1]) => (next.entries.some((e) => e.url === u) ? net2 : t.net).fetch(u, i) };
  studio = await startStudioServer({ root: ws, startWorker: false, tools: both });
  studio.desktop.attach((l) => (lines.push(l), true));
}, 60_000);
afterAll(async () => {
  await studio?.close();
  testHome.restore();
  wipe(base);
});
beforeEach(() => {
  lines.length = 0;
});

describe("the shell's lines for the update's Tools", () => {
  it('update_archive is strict: a version, an absolute archive path of the shell, a lowercase SHA-256, nothing else', () => {
    const sha = 'a'.repeat(64);
    const ok = { type: 'update_archive', version: '0.4.0', path: '/Users/x/Library/Caches/app/updates/update-77.tar.gz', sha256: sha };
    expect(parseShellLine(JSON.stringify(ok))).toEqual(ok);
    for (const bad of [
      { ...ok, version: 'latest' },
      { ...ok, sha256: 'A'.repeat(64) },
      { ...ok, sha256: 'a'.repeat(63) },
      { ...ok, path: 'updates/update-77.tar.gz' },
      { ...ok, path: '/tmp/other.tar.gz' },
      { ...ok, path: '/tmp/../tmp/updates/update-1.tar.gz' },
      { ...ok, path: '/tmp/a\nb/updates/update-1.tar.gz' },
      { ...ok, extra: 1 },
      { type: 'update_archive', version: '0.4.0', path: ok.path },
    ])
      expect(parseShellLine(JSON.stringify(bad)), JSON.stringify(bad)).toBeNull();
  });

  it('the preparing state and the tools failure: exact keys; a tools failure keeps Install and Restart live', () => {
    expect(parseUpdateLine({ type: 'update', state: 'preparing', current: '0.0.1', version: '0.0.2' })).toEqual({ type: 'update', state: 'preparing', current: '0.0.1', version: '0.0.2' });
    expect(parseUpdateLine({ type: 'update', state: 'preparing', current: '0.0.1', version: '0.0.2', received: 1 })).toBeNull();
    expect(parseUpdateLine({ type: 'update', state: 'preparing', current: '0.0.1' })).toBeNull();
    const failed = parseUpdateLine({ type: 'update', state: 'failed', current: '0.0.1', failure: 'tools', version: '0.0.2', checked: null, retry: true }) as UpdateLine;
    expect(failed).toMatchObject({ failure: 'tools' });
    expect(installable(failed)).toBe(true);
  });
});

describe("the server's side of the update's Tools", () => {
  it("ready: the new version's Tools beside the current ones, kept as pending; the shell told; the sheet's figures", async () => {
    state({ state: 'preparing', version: '0.0.2' });
    const a = archiveOf(manifestOf('0.0.2', next.entries));
    expect(shell(line('0.0.2', a))).toBe(true);
    await expect.poll(answers, POLL).toEqual(['{"type":"update_tools","version":"0.0.2","state":"ready"}']);
    for (const e of next.entries) expect(existsSync(join(rhome, 'tools', ...e.folder.split('/'))), e.folder).toBe(true);
    const pending = JSON.parse(readFileSync(join(rhome, 'tools', '.pending.json'), 'utf8'));
    expect(pending.map((p: Untyped) => p.app)).toEqual(['0.0.2']);
    const s = await updateStatus();
    expect(s.state).toBe('preparing');
    expect(s.tools).toMatchObject({ version: '0.0.2', state: 'ready' });
    expect(s.tools.total).toBe(next.entries.reduce((x, e) => x + e.bytes, 0));
    expect(s.tools.tools.map((t: Untyped) => [t.id, t.here])).toEqual([
      ['render-browser', false],
      ['compositor', false],
      ['browser', false],
    ]);
    // Install and Restart goes on: the waiting state keeps the record.
    state({ state: 'waiting', version: '0.0.2', jobs: 1 });
    expect(existsSync(join(rhome, 'tools', '.pending.json'))).toBe(true);
  });

  it('a second time: every Tool already here (the figure says so, nothing downloaded)', async () => {
    state({ state: 'preparing', version: '0.0.2' });
    const calls = net2.calls.length;
    shell(line('0.0.2', archiveOf(manifestOf('0.0.2', next.entries))));
    await expect.poll(answers, POLL).toEqual(['{"type":"update_tools","version":"0.0.2","state":"ready"}']);
    expect(net2.calls.length).toBe(calls);
    const s = await updateStatus();
    expect(s.tools.total).toBe(0);
    expect(s.tools.tools.every((t: Untyped) => t.here)).toBe(true);
  });

  it('refused: an archive changed since it was verified, a bundle.json of another version', async () => {
    const good = archiveOf(manifestOf('0.0.3', next.entries));
    const cases: Array<[string, string, RegExp]> = [
      ['0.0.3', line('0.0.3', { path: good.path, sha256: 'b'.repeat(64) }), /changed since it was verified/],
      ['0.0.3', line('0.0.3', archiveOf(manifestOf('0.0.9', next.entries))), /version 0\.0\.9, not 0\.0\.3/],
    ];
    for (const [v, l, why] of cases) {
      lines.length = 0;
      state({ state: 'preparing', version: v });
      shell(l);
      await expect.poll(answers, POLL).toEqual([`{"type":"update_tools","version":"${v}","state":"failed"}`]);
      const s = await updateStatus();
      expect(s.tools.state).toBe('failed');
      expect(s.untrusted.tools).toMatch(why);
    }
  });

  it('skipped: a manifest this version cannot read whole (another manifest version, an id it does not know, one it lacks, a host off its list, no bundle.json): the update goes on, nothing downloaded', async () => {
    const [shellEntry, compositor, browser] = next.entries as [ToolEntry, ToolEntry, ToolEntry];
    const offList = next.entries.map((e) => ({ ...e, url: e.url.replace('storage.googleapis.com', 'downloads.example.com') }));
    const noManifest = (() => {
      const top = join(base, `stage${n++}`);
      mkdirSync(join(top, 'Retake.app', 'Contents'), { recursive: true });
      writeFileSync(join(top, 'Retake.app', 'Contents', 'Info.plist'), '<plist/>');
      const dir = join(base, `cache${n}`, 'updates');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `update-${4000 + n}.tar.gz`);
      spawnSync('/usr/bin/tar', ['-czf', path, '-C', top, 'Retake.app'], { env: { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1' } });
      return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
    })();
    const cases: Array<{ path: string; sha256: string }> = [
      archiveOf({ v: 3, app: '0.0.4', tools: next.entries }),
      archiveOf(manifestOf('0.0.4', [...next.entries, { ...browser, id: 'ios-runner', folder: 'browsers/ios-runner-1' } as unknown as ToolEntry])),
      archiveOf(manifestOf('0.0.4', [shellEntry, browser])),
      archiveOf(manifestOf('0.0.4', offList)),
      noManifest,
    ];
    const calls = net2.calls.length;
    for (const a of cases) {
      lines.length = 0;
      state({ state: 'preparing', version: '0.0.4' });
      shell(line('0.0.4', a));
      await expect.poll(answers, POLL).toEqual(['{"type":"update_tools","version":"0.0.4","state":"skip"}']);
      expect((await updateStatus()).tools).toMatchObject({ version: '0.0.4', state: 'ready', tools: [] });
    }
    expect(net2.calls.length).toBe(calls);
    expect(compositor.id).toBe('compositor');
    const pending = existsSync(join(rhome, 'tools', '.pending.json')) ? readFileSync(join(rhome, 'tools', '.pending.json'), 'utf8') : '';
    expect(pending).not.toContain('0.0.4');
  });

  it("busy: the person's own download holds the Tools — the update's waits for it to end, then goes on (ready)", async () => {
    wipe(join(rhome, 'tools'));
    // A live install holds the lock (this process, as the Studio's own download would).
    mkdirSync(join(rhome, 'tools'), { recursive: true });
    writeFileSync(join(rhome, 'tools', '.lock'), JSON.stringify({ pid: process.pid, command: 'tools install', by: 'studio', version: '0.0.1', since: new Date().toISOString() }));
    state({ state: 'preparing', version: '0.0.2' });
    shell(line('0.0.2', archiveOf(manifestOf('0.0.2', next.entries))));
    await new Promise((r) => setTimeout(r, 1_500));
    expect(answers()).toEqual([]);
    rmSync(join(rhome, 'tools', '.lock'));
    await expect.poll(answers, POLL).toEqual(['{"type":"update_tools","version":"0.0.2","state":"ready"}']);
    for (const e of next.entries) expect(existsSync(join(rhome, 'tools', ...e.folder.split('/'))), e.folder).toBe(true);
  });

  it("given up: Later (the shell's next state) stops the download and forgets the pending record; no answer", async () => {
    wipe(join(rhome, 'tools'));
    net2.hold = true;
    state({ state: 'preparing', version: '0.0.2' });
    shell(line('0.0.2', archiveOf(manifestOf('0.0.2', next.entries))));
    await expect.poll(() => existsSync(join(rhome, 'tools', '.pending.json')) && readFileSync(join(rhome, 'tools', '.pending.json'), 'utf8').includes('0.0.2'), POLL).toBe(true);
    state({ state: 'available', version: '0.0.2', notes: '', checked: null });
    await expect.poll(() => readFileSync(join(rhome, 'tools', '.pending.json'), 'utf8').includes('0.0.2'), POLL).toBe(false);
    net2.hold = false;
    await new Promise((r) => setTimeout(r, 300));
    expect(answers()).toEqual([]);
    expect((await updateStatus()).tools).toBeUndefined();
  });
});
