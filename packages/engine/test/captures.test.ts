/**
 * L5.14 (captures first): the filming markers of this user — one file per take in a 0700 folder of the user's own,
 * written whole, naming no workspace; held while their owner beats and runs with its recorded start time; capped from
 * each reader's first sight; never holding while paused. L5.14a fixes: a test run never uses the per-user folder (review
 * B M2); markers read without following a link, blocking on a FIFO or reading a large file (A L1); a time in the future is
 * stale (A L2); the cap counts per owner (pid + start time), not per file name (A L2, B L4).
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from '@retake/core';
import { CAP_CARRY_MS, FilmingMarker, FilmingWatch, MARKER_MAX_BYTES, capturesDir, capturesLocation, selfIdentity, workspaceCaptureId } from '../src/index.js';
import type { ProcessIdentity } from '../src/index.js';
import { REPO } from '@retake/test-support/repo';

let base: string;
let dir: string;
let env: NodeJS.ProcessEnv;
let wsA: string;
let wsB: string;
let me: ProcessIdentity;
const children: ChildProcess[] = [];

const markers = () => readdirSync(dir).filter((n) => n.startsWith('k_'));
const writeMarker = (rec: Record<string, unknown>, name = `k_${ulid()}.json`) => {
  writeFileSync(join(dir, name), JSON.stringify(rec), { mode: 0o600 });
  return name;
};
const clear = () => {
  for (const n of readdirSync(dir)) rmSync(join(dir, n), { force: true });
};

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'retake-captures-test-'));
  dir = join(base, 'captures');
  env = { ...process.env, RETAKE_CAPTURES_DIR: dir };
  wsA = join(base, 'projects', 'northfield-fixture-a');
  wsB = join(base, 'other-workspace');
  await mkdir(wsA, { recursive: true });
  await mkdir(wsB, { recursive: true });
  me = await selfIdentity();
});

afterAll(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  await rm(base, { recursive: true, force: true });
});

describe('the captures folder (L5.14)', () => {
  it('RETAKE_CAPTURES_DIR names it (made 0700); a folder open to others, a link or a relative name is not used', async () => {
    expect(capturesDir(env)).toEqual({ dir });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const open = join(base, 'open');
    await mkdir(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    const refused = capturesDir({ ...env, RETAKE_CAPTURES_DIR: open });
    expect(refused.dir).toBeNull();
    expect(refused.problem).toMatch(/open to other users/);
    const link = join(base, 'link');
    symlinkSync(dir, link);
    expect(capturesDir({ ...env, RETAKE_CAPTURES_DIR: link }).dir).toBeNull();
    // Nothing is written there, and nothing holds (renders go on rather than trust such a folder).
    expect(FilmingMarker.open({ root: wsA, source: 'cli', owner: me, env: { ...env, RETAKE_CAPTURES_DIR: open } })).toBeNull();
    expect(readdirSync(open)).toEqual([]);
    const loc = capturesLocation({ ...env, RETAKE_CAPTURES_DIR: 'relative/dir' });
    expect(loc.override).toBe(false);
    expect(loc.problem).toMatch(/not an absolute path/);
  });

  it('review B M2: under a test run (VITEST, or a RETAKE_TEST_* variable) the per-user folder is never used without RETAKE_CAPTURES_DIR', () => {
    const real = capturesLocation({}).dir;
    const existed = existsSync(real);
    for (const e of [{ VITEST: 'true' }, { RETAKE_TEST_ANYTHING: '1' }]) {
      // The location says so first (nothing made): capturesDir is only asked once it does.
      expect(capturesLocation(e).refused).toBe(true);
      const got = capturesDir(e);
      expect(got.dir).toBeNull();
      expect(got.problem).toMatch(/test run never uses the per-user captures folder/);
      expect(FilmingMarker.open({ root: wsA, source: 'cli', owner: me, env: e })).toBeNull();
    }
    // This test process itself is a test run: without RETAKE_CAPTURES_DIR, nothing either.
    expect(capturesLocation({ RETAKE_HOME: join(base, 'home-x') }).refused).toBe(true);
    expect(capturesDir({ RETAKE_HOME: join(base, 'home-x') }).dir).toBeNull();
    expect(existsSync(real)).toBe(existed);
    expect(capturesDir(env).dir).toBe(dir);
  });

  it('per user, not per Retake home: two RETAKE_HOMEs see the same folder', () => {
    const a = capturesLocation({ RETAKE_HOME: join(base, 'home-a') });
    const b = capturesLocation({ RETAKE_HOME: join(base, 'home-b') });
    expect(a.dir).toBe(b.dir);
    if (process.platform === 'darwin') expect(a.dir).toMatch(/\/retake-captures$/);
  });
});

describe('filming markers (L5.14)', () => {
  it('one file per take, 0600, written whole; it names no workspace (no path, slug, scenario, run or job id)', () => {
    clear();
    const m = FilmingMarker.open({ root: wsA, source: 'job', owner: me, env })!;
    const m2 = FilmingMarker.open({ root: wsA, source: 'cli', owner: me, env })!;
    expect(m.name).not.toBe(m2.name);
    expect(markers().sort()).toEqual([m.name, m2.name].sort());
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(statSync(m.file).mode & 0o777).toBe(0o600);
    const text = readFileSync(m.file, 'utf8');
    const rec = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(rec).sort()).toEqual(['pid', 'source', 'started_at', 'v', 'ws']);
    for (const word of [wsA, base, 'northfield', 'fixture', 'projects', 'quote', 'j_', '20261']) expect(text).not.toContain(word);
    expect(rec.ws).toBe(workspaceCaptureId(wsA));
    expect(rec.ws).toMatch(/^[0-9a-f]{32}$/);
    m.closeSync();
    m2.closeSync();
    expect(markers()).toEqual([]);
  });

  it('a live marker holds: "here" for its workspace, "elsewhere" for another one', async () => {
    clear();
    const m = FilmingMarker.open({ root: wsA, source: 'job', owner: me, env })!;
    expect(await new FilmingWatch({ root: wsA, env }).scan()).toMatchObject({ holding: true, cause: 'here' });
    expect(await new FilmingWatch({ root: wsB, env }).scan()).toMatchObject({ holding: true, cause: 'elsewhere' });
    // A take's own hooks (an ancestor owns the marker) do not wait for it.
    expect((await new FilmingWatch({ root: wsB, env, ignorePids: () => new Set([process.pid]) }).scan()).holding).toBe(false);
    m.closeSync();
    expect((await new FilmingWatch({ root: wsB, env }).scan()).holding).toBe(false);
  });

  it("stale: an old time (no heartbeat), a dead pid, a pid of another start time or without one, another user's pid — never held, removed", async () => {
    clear();
    const old = FilmingMarker.open({ root: wsA, source: 'cli', owner: me, env, beatMs: 3_600_000 })!;
    const past = new Date(Date.now() - 60_000);
    utimesSync(old.file, past, past);
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const deadPid = Number(r.stdout);
    const dead = writeMarker({ v: 1, pid: deadPid, started_at: new Date().toISOString(), ws: 'x', source: 'job' });
    const reused = writeMarker({ v: 1, pid: process.pid, started_at: '2001-01-01T00:00:00.000Z', ws: 'x', source: 'job' });
    const noStart = writeMarker({ v: 1, pid: process.pid, ws: 'x', source: 'job' });
    const foreign = writeMarker({ v: 1, pid: 1, started_at: new Date().toISOString(), ws: 'x', source: 'job' });
    const st = await new FilmingWatch({ root: wsA, env }).scan();
    expect(st.holding).toBe(false);
    expect(st.takes).toEqual([]);
    for (const n of [old.name, dead, reused, noStart, foreign]) expect(existsSync(join(dir, n)), n).toBe(false);
    old.closeSync();
  });

  it('review A L1: a marker that is a FIFO, a link or larger than MARKER_MAX_BYTES is not read (never blocks, never read whole)', async () => {
    clear();
    const fifo = `k_${ulid()}.json`;
    expect(spawnSync('mkfifo', [join(dir, fifo)]).status).toBe(0);
    const big = writeMarker({ v: 1, pid: me.pid, started_at: me.started_at, ws: 'y', source: 'job', pad: 'x'.repeat(MARKER_MAX_BYTES) });
    const target = join(base, 'elsewhere.json');
    writeFileSync(target, JSON.stringify({ v: 1, pid: me.pid, started_at: me.started_at, ws: 'y', source: 'job' }));
    symlinkSync(target, join(dir, `k_${ulid()}.json`));
    const t0 = Date.now();
    const st = await new FilmingWatch({ root: wsA, env }).scan();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(st.holding).toBe(false);
    expect(st.takes).toEqual([]);
    expect(existsSync(join(dir, big))).toBe(true); // not a marker: left as is
    clear();
  });

  it('review A L2: a marker whose time is in the future is stale too (removed, holds nothing)', async () => {
    clear();
    const m = FilmingMarker.open({ root: wsA, source: 'cli', owner: me, env, beatMs: 3_600_000 })!;
    const future = new Date(Date.now() + 365 * 24 * 3600_000);
    utimesSync(m.file, future, future);
    expect((await new FilmingWatch({ root: wsA, env }).scan()).holding).toBe(false);
    expect(existsSync(m.file)).toBe(false);
    m.closeSync();
  });

  it("a newer copy's marker (v 2) with a live owner holds; a malformed one is ignored; tmp names are never read", async () => {
    clear();
    writeMarker({ v: 2, pid: me.pid, started_at: me.started_at, ws: 'y', source: 'job', more: true });
    writeFileSync(join(dir, `k_${ulid()}.json`), '{not json');
    writeFileSync(join(dir, `.k_${ulid()}.json.abcd.tmp`), JSON.stringify({ v: 1, pid: me.pid, started_at: me.started_at, ws: 'y', source: 'job' }));
    const st = await new FilmingWatch({ root: wsA, env }).scan();
    expect(st.holding).toBe(true);
    expect(st.takes).toHaveLength(1);
    clear();
  });

  it('a paused take holds nothing (L4.4 pause: not filmed); it holds again on resume', async () => {
    clear();
    const m = FilmingMarker.open({ root: wsA, source: 'job', owner: me, env })!;
    const w = new FilmingWatch({ root: wsA, env });
    m.setPaused(true);
    expect(await w.scan()).toMatchObject({ holding: false, takes: [{ paused: true }] });
    m.setPaused(false);
    expect((await w.scan()).holding).toBe(true);
    m.closeSync();
  });

  it("the cap counts holding time from each reader's first sight; a rewritten marker does not restart it; a long gap counts 5 s", async () => {
    clear();
    let t = 1_000_000;
    const capEnv = { ...env, RETAKE_CAPTURE_HOLD_MAX_MIN: '0.2' }; // 12 s
    const m = FilmingMarker.open({ root: wsA, source: 'cli', owner: me, env, beatMs: 50 })!;
    const w = new FilmingWatch({ root: wsA, env: capEnv, now: () => t, staleMs: Number.POSITIVE_INFINITY });
    expect((await w.scan()).holding).toBe(true); // first sight: 0 s held
    t += 60_000; // a suspended reader: counts 5 s
    expect((await w.scan()).takes[0]!.held_ms).toBe(5_000);
    t += 4_000;
    expect((await w.scan()).holding).toBe(true); // 9 s
    // The owner writes its file again (a forged "fresh" marker): the reader's count goes on.
    m.setPaused(true);
    m.setPaused(false);
    t += 4_000;
    const capped = await w.scan(); // 13 s ≥ 12 s
    expect(capped.holding).toBe(false);
    expect(capped.newlyCapped).toEqual([m.name]);
    t += 1_000;
    expect((await w.scan()).newlyCapped).toEqual([]);
    m.closeSync();
  });

  it("review A L2 / B L4: the cap is the owner's — a renamed file, or one removed as stale and written again, does not restart it; a new take after a pause in its markers does", async () => {
    clear();
    let t = 2_000_000;
    const capEnv = { ...env, RETAKE_CAPTURE_HOLD_MAX_MIN: '0.2' }; // 12 s
    const name = writeMarker({ v: 1, pid: me.pid, started_at: me.started_at, ws: 'x', source: 'cli' });
    const w = new FilmingWatch({ root: wsA, env: capEnv, now: () => t, staleMs: Number.POSITIVE_INFINITY });
    await w.scan();
    t += 4_000;
    await w.scan();
    t += 4_000;
    expect((await w.scan()).takes[0]!.held_ms).toBe(8_000);
    // Renamed by its owner (or anyone): the same owner, the count goes on.
    const renamed = `k_${ulid()}.json`;
    renameSync(join(dir, name), join(dir, renamed));
    t += 3_000;
    expect((await w.scan()).takes).toMatchObject([{ name: renamed, held_ms: 11_000 }]);
    // Removed (as a stale one is) and written again under a new name a beat later: still the same count.
    rmSync(join(dir, renamed));
    t += 1_000;
    expect((await w.scan()).takes).toEqual([]);
    const again = writeMarker({ v: 1, pid: me.pid, started_at: me.started_at, ws: 'x', source: 'cli' });
    t += 2_000;
    const capped = await w.scan();
    expect(capped.holding).toBe(false);
    expect(capped.newlyCapped).toEqual([again]);
    // The owner without any marker for longer than CAP_CARRY_MS: its take ended; its next marker is a new take.
    rmSync(join(dir, again));
    t += 1_000;
    await w.scan();
    t += CAP_CARRY_MS + 1_000;
    await w.scan();
    writeMarker({ v: 1, pid: me.pid, started_at: me.started_at, ws: 'x', source: 'cli' });
    t += 1_000;
    expect(await w.scan()).toMatchObject({ holding: true, takes: [{ held_ms: 0, capped: false }] });
    clear();
  });
});

describe('the owner of a marker (L5.14)', () => {
  /** A process owning a marker (from the sources, through tsx), printing its name. */
  function owner(code: string): { child: ChildProcess; name: Promise<string> } {
    const mod = join(REPO, 'packages/engine/src/jobs/captures.ts');
    const proc = join(REPO, 'packages/engine/src/jobs/proc.ts');
    const script = `const { FilmingMarker } = await import(${JSON.stringify(mod)}); const { selfIdentity } = await import(${JSON.stringify(proc)});
      const m = FilmingMarker.open({ env: process.env, root: ${JSON.stringify(wsA)}, source: 'cli', owner: await selfIdentity(), beatMs: 100 }); process.stdout.write(m.name + '\\n'); ${code}`;
    const child = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', '--input-type=module', '-e', script], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    let out = '';
    const name = new Promise<string>((r) => child.stdout!.on('data', (d: Buffer) => ((out += d.toString()), out.includes('\n') && r(out.trim()))));
    return { child, name };
  }

  it('beats: a fresh time every beat, the file written again when a reader removed it', async () => {
    clear();
    const m = FilmingMarker.open({ root: wsA, source: 'job', owner: me, env, beatMs: 50 })!;
    const past = new Date(Date.now() - 60_000);
    utimesSync(m.file, past, past);
    await new Promise((r) => setTimeout(r, 200));
    expect(Date.now() - statSync(m.file).mtimeMs).toBeLessThan(5_000);
    await rm(m.file);
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(m.file)).toBe(true);
    m.closeSync();
  });

  it('removed when its process exits without closing it', async () => {
    clear();
    const o = owner('setTimeout(() => process.exit(0), 300);');
    const name = await o.name;
    expect(markers()).toContain(name);
    await new Promise((r) => o.child.on('exit', r));
    expect(existsSync(join(dir, name))).toBe(false);
  });

  it('a suspended take (Ctrl-Z: SIGSTOP) stops beating: stale, it holds nothing', async () => {
    clear();
    const o = owner('setInterval(() => undefined, 1000);');
    const name = await o.name;
    const w = new FilmingWatch({ root: wsA, env, staleMs: 800 });
    expect((await w.scan()).holding).toBe(true);
    o.child.kill('SIGSTOP');
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await w.scan()).holding).toBe(false);
    expect(existsSync(join(dir, name))).toBe(false);
    o.child.kill('SIGCONT');
    o.child.kill('SIGKILL');
  });
});

describe('what a take saw beside it (L5.14b)', () => {
  it('the most other unpaused takes at once (its own marker not counted), told once with where; a heavy job of its workspace slowed', async () => {
    const { TakeBeside } = await import('../src/index.js');
    clear();
    const mine = FilmingMarker.open({ root: wsA, source: 'job', owner: me, env })!;
    const told: string[] = [];
    const beside = new TakeBeside({ root: wsA, own: () => mine.name, onFirst: (w) => told.push(w), env, everyMs: 60_000 });
    await beside.sample();
    expect(told).toEqual([]);
    const b1 = FilmingMarker.open({ root: wsB, source: 'cli', owner: me, env })!;
    const b2 = FilmingMarker.open({ root: wsB, source: 'cli', owner: me, env })!;
    b2.setPaused(true);
    await beside.sample();
    const a2 = FilmingMarker.open({ root: wsA, source: 'cli', owner: me, env })!;
    await beside.sample();
    a2.closeSync();
    b1.closeSync();
    await beside.sample();
    expect(told).toEqual(['elsewhere']);
    // Heavy work of its workspace at background priority: what its worker's held file says (review A H1: never a job
    // folder — a job's yield.json alone says nothing to it).
    const { heldFile } = await import('../src/index.js');
    const job = join(wsA, '.retake', 'jobs', `j_${ulid()}`);
    await mkdir(job, { recursive: true });
    writeFileSync(join(job, 'yield.json'), JSON.stringify({ v: 1, state: 'background', cause: 'here' }));
    await mkdir(join(wsA, '.retake', 'workers'), { recursive: true });
    writeFileSync(heldFile(wsA), JSON.stringify({ v: 1, state: 'past_cap' }));
    await beside.sample();
    expect(beside.stop()).toEqual({ takes_beside: 2, heavy_slowed: false });
    writeFileSync(heldFile(wsA), JSON.stringify({ v: 1, state: 'background', since: new Date().toISOString() }));
    const again = new TakeBeside({ root: wsA, own: () => mine.name, env, everyMs: 60_000 });
    await again.sample();
    expect(again.stop()).toEqual({ takes_beside: 0, heavy_slowed: true });
    b2.closeSync();
    mine.closeSync();
    await rm(join(wsA, '.retake'), { recursive: true, force: true });
  });
});
