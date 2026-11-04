/**
 * L5.16c — doctor's App group (DESIGN §4p (c)): where the installed app runs from (critique H1: a translocated copy,
 * its disk image, /Volumes → "Move Retake to Applications"), the `retake` command's link (dangling, another copy, a file
 * that is not Retake's, another retake first on this shell's PATH) — a fake app and a scratch HOME only — and the
 * workspace's worker running another copy of Retake (critique M6). L5.16c fixes: another copy is told by its app's
 * identifier (review c B-M3), the rm hint quotes the path (A-L7), a same copy of another version is said (B-L1), the
 * lock's text has no hidden characters in this terminal (A-L4). L5.16d: the app's update checks (critique L7) — the
 * date of the last successful check (desktop-updates.json, written by the shell), an install that failed, a stale feed,
 * RETAKE_DISABLE_UPDATE_CHECK.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { APP_BUNDLE_ID, RETAKE_VERSION, UPDATES_FILE, readUpdateChecks, writeAppSettings } from '@retake/core';
import type { BundleInfo } from '@retake/core';
import { appChecks, doctorChecks, launchUpdates, updateCheck } from '../src/commands/doctor.js';
import type { DoctorProbes } from '../src/commands/doctor.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-app-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;

function fakeApp(dir: string, name = 'Retake'): { bundle: BundleInfo; launcher: string } {
  const root = join(dir, `${name}.app`, 'Contents', 'Resources');
  mkdirSync(join(root, 'bin'), { recursive: true });
  const launcher = join(root, 'bin', 'retake');
  writeFileSync(launcher, '#!/bin/sh\n');
  chmodSync(launcher, 0o755);
  writeFileSync(join(dir, `${name}.app`, 'Contents', 'Info.plist'), `<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${APP_BUNDLE_ID}</string></dict></plist>\n`);
  const bundle = { root, sealed: join(dir, `${name}.app`), manifest: {} as BundleInfo['manifest'], paths: {} as BundleInfo['paths'] } as BundleInfo;
  return { bundle, launcher };
}

function setup(): { home: string; bin: string; app: ReturnType<typeof fakeApp> } {
  const d = join(base, `case-${++n}`);
  const home = join(d, 'home');
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  return { home, bin, app: fakeApp(join(d, 'Applications')) };
}

const probes = (o: Partial<DoctorProbes>): DoctorProbes => ({ platform: 'darwin', nodeVersion: '22.16.0', env: {}, which: () => null, exec: async () => null, exists: () => false, chromium: async () => ({}) as never, head: async () => ({ ms: 0 }), readOnly: () => false, ...o });

describe('doctor: App location and the retake command', () => {
  it('an installed app: its location OK, the command not installed, installed, or behind another retake on PATH', () => {
    const { home, bin, app } = setup();
    const env = { HOME: home, RETAKE_HOME: join(home, '.retake-scratch'), PATH: '/usr/bin:/bin' };
    expect(appChecks(probes({ bundle: app.bundle, env }))).toEqual([
      { status: 'ok', name: 'App location', detail: app.bundle.sealed },
      { status: 'ok', name: 'retake command', detail: "not installed · the app's Help › Install the retake Command… links it" },
      { status: 'ok', name: 'App updates', detail: 'not checked yet — the app checks at launch, at most once a day (Help › Check for Updates…)' },
    ]);
    symlinkSync(app.launcher, join(bin, 'retake'));
    expect(appChecks(probes({ bundle: app.bundle, env }))[1]).toEqual({ status: 'ok', name: 'retake command', detail: `${join(bin, 'retake')} → this app` });
    // Another retake earlier on this shell's PATH.
    const other = join(home, 'early');
    mkdirSync(other);
    writeFileSync(join(other, 'retake'), '#!/bin/sh\n');
    chmodSync(join(other, 'retake'), 0o755);
    const c = appChecks(probes({ bundle: app.bundle, env: { ...env, PATH: `${other}:${bin}:/usr/bin` } }))[1]!;
    expect(c.status).toBe('warn');
    expect(c.detail).toContain(`${join(other, 'retake')} comes first on this PATH`);
  });

  it('the link the app recorded (app.json), a link to another copy, a file that is not Retake\'s', () => {
    const { home, bin, app } = setup();
    const env = { HOME: home, RETAKE_HOME: join(home, '.retake-scratch'), PATH: '/usr/bin' };
    const chosen = join(home, 'tools');
    mkdirSync(chosen);
    symlinkSync(app.launcher, join(chosen, 'retake'));
    writeAppSettings(env.RETAKE_HOME, { cli: { path: join(chosen, 'retake'), at: '2026-11-03T00:00:00Z' } });
    expect(appChecks(probes({ bundle: app.bundle, env }))[1]).toMatchObject({ status: 'ok', detail: `${join(chosen, 'retake')} → this app` });
    writeAppSettings(env.RETAKE_HOME, { cli: null });
    const old = fakeApp(join(base, `old-${n}`), 'Retake Old');
    symlinkSync(old.launcher, join(bin, 'retake'));
    expect(appChecks(probes({ bundle: app.bundle, env }))[1]).toMatchObject({ status: 'warn', detail: `${join(bin, 'retake')} runs another copy of Retake (${old.launcher})`, hint: expect.stringContaining('Replace') });
    rmSync(join(bin, 'retake'));
    writeFileSync(join(bin, 'retake'), '#!/bin/sh\nexec pnpm retake "$@"\n');
    expect(appChecks(probes({ bundle: app.bundle, env }))[1]).toMatchObject({ status: 'warn', detail: expect.stringContaining("is not Retake's command (file)") });
  });

  it('a dangling link is said from the app and from a checkout; a checkout says nothing else', () => {
    const { home, bin } = setup();
    const gone = fakeApp(join(base, `gone-${n}`));
    symlinkSync(gone.launcher, join(bin, 'retake'));
    rmSync(gone.bundle.sealed, { recursive: true });
    const env = { HOME: home, PATH: '/usr/bin' };
    expect(appChecks(probes({ bundle: null, env }))).toEqual([
      { status: 'warn', name: 'retake command', detail: `${join(bin, 'retake')} points to a Retake app that is gone (${gone.launcher}): the command fails`, hint: `install it again from the app (Help › Install the retake Command…), or remove it: rm ${join(bin, 'retake')}` },
    ]);
    rmSync(join(bin, 'retake'));
    writeFileSync(join(bin, 'retake'), '#!/bin/sh\n');
    expect(appChecks(probes({ bundle: null, env }))).toEqual([]);
    // Review c A-L7: a folder with a space — the rm hint quotes it (safe to paste).
    rmSync(join(bin, 'retake'));
    const spaced = join(home, 'my tools');
    mkdirSync(spaced);
    const gone2 = fakeApp(join(base, `gone2-${n}`));
    symlinkSync(gone2.launcher, join(spaced, 'retake'));
    rmSync(gone2.bundle.sealed, { recursive: true });
    const app2 = fakeApp(join(base, `app2-${n}`));
    writeAppSettings(join(home, '.retake-scratch'), { cli: { path: join(spaced, 'retake'), at: '2026-11-03T00:00:00Z' } });
    const c = appChecks(probes({ bundle: app2.bundle, env: { ...env, RETAKE_HOME: join(home, '.retake-scratch') } })).find((x) => x.name === 'retake command')!;
    expect(c.hint).toBe(`install it again from the app (Help › Install the retake Command…), or remove it: rm '${join(spaced, 'retake')}'`);
    // No HOME in the environment: nothing looked at.
    expect(appChecks(probes({ bundle: null, env: {} }))).toEqual([]);
  });

  it('critique H1: a translocated copy, its disk image or /Volumes — warn with "Move Retake to Applications"', () => {
    const { home } = setup();
    for (const [sealed, ro, words] of [
      ['/private/var/folders/xy/T/AppTranslocation/0A1B/d/Retake.app', false, 'temporary copy'],
      ['/Volumes/Retake/Retake.app', true, 'read-only disk'],
      ['/Volumes/External/Retake.app', false, 'under /Volumes'],
    ] as const) {
      const bundle = { root: `${sealed}/Contents/Resources`, sealed, manifest: {}, paths: {} } as BundleInfo;
      const c = appChecks(probes({ bundle, env: { HOME: home }, readOnly: () => ro }))[0]!;
      expect(c).toMatchObject({ status: 'warn', name: 'App location', hint: 'Move Retake to Applications, then open it again' });
      expect(c.detail).toContain(words);
    }
    // A staged tree (no .app around it) is no installed app: no App lines.
    expect(appChecks(probes({ bundle: { root: '/tmp/stage', sealed: '/tmp/stage', manifest: {}, paths: {} } as unknown as BundleInfo, env: {} }))).toEqual([]);
  });
});

describe('doctor: the workspace\'s worker of another copy of Retake (critique M6)', () => {
  const ws = { root: join(base, 'ws'), projectsDir: join(base, 'ws', 'projects'), templatesDir: join(base, 'ws', 'templates'), componentsDir: join(base, 'ws', 'components') };
  mkdirSync(ws.projectsDir, { recursive: true });
  const mcpLine = async (worker: Awaited<ReturnType<NonNullable<DoctorProbes['worker']>>>) => {
    const checks = await doctorChecks(
      probes({ env: { PATH: '/usr/bin' }, engine: '/Applications/Retake.app', execPath: '/Applications/Retake.app/Contents/Resources/node/bin/node', worker: async () => worker, chromium: async () => ({ path: null, source: 'playwright', exists: false, launched: false, ms: 0 }) as never, exec: async () => null }),
      ws,
    );
    return checks.find((c) => c.name === 'MCP')!;
  };
  it('names the other copy (version, path); the same copy says nothing', async () => {
    const other = await mcpLine({ pid: 42, since: '2026-11-03T00:00:00Z', version: '0.1.0', engine: '/Users/me/src/retake' });
    expect(other.status).toBe('warn');
    expect(other.detail).toContain("this workspace's worker runs another copy of Retake (0.1.0, /Users/me/src/retake)");
    const same = await mcpLine({ pid: 42, since: '2026-11-03T00:00:00Z', version: RETAKE_VERSION, engine: '/Applications/Retake.app' });
    expect(same.detail).not.toContain('another copy');
    // An older lock without `engine`: its version alone.
    const older = await mcpLine({ pid: 42, since: '2026-11-03T00:00:00Z', version: RETAKE_VERSION });
    expect(older.detail).not.toContain('another copy');
    // Review c B-L1: the same copy (same folder) of another version is said too.
    const version = await mcpLine({ pid: 42, since: '2026-11-03T00:00:00Z', version: '0.1.0', engine: '/Applications/Retake.app' });
    expect(version.detail).toContain("this workspace's worker runs another copy of Retake (0.1.0, /Applications/Retake.app)");
  });

  it('review c A-L4: the lock\'s text reaches this terminal without control or hidden characters', async () => {
    const odd = await mcpLine({ pid: 42, since: '2026-11-03T00:00:00Z', version: '0.1.0\u001b[2J', engine: '/Apps/\u202eppa.ekateR', started_by: 'mcp\u0007' });
    expect(odd.detail).not.toMatch(/[\u0000-\u001f\u202e]/);
    expect(odd.detail).toContain('0.1.0?[2J');
    expect(odd.detail).toContain('started by mcp?');
  });
});

describe('doctor: App updates (L5.16d, critique L7)', () => {
  const now = Date.UTC(2026, 10, 10, 12, 0) ;
  const write = (dir: string, text: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, UPDATES_FILE), text);
  };
  it('never checked, the last successful check, a stale one, a failed install, the checks off; a foreign file reads as nothing', () => {
    const { home } = setup();
    const rh = join(home, '.retake-scratch');
    const env = { HOME: home, RETAKE_HOME: rh };
    expect(updateCheck(env, home, now)).toEqual({ status: 'ok', name: 'App updates', detail: 'not checked yet — the app checks at launch, at most once a day (Help › Check for Updates…)' });
    write(rh, JSON.stringify({ version: 1, checked: Math.floor(now / 1000) - 3600, failed: null }));
    expect(updateCheck(env, home, now)).toEqual({ status: 'ok', name: 'App updates', detail: 'last successful check 2026-11-10 11:00 UTC' });
    write(rh, JSON.stringify({ version: 1, checked: Math.floor(now / 1000) - 40 * 86_400, failed: null }));
    const stale = updateCheck(env, home, now);
    expect(stale.status).toBe('warn');
    expect(stale.detail).toBe('last successful check 2026-10-01 12:00 UTC, 40 days ago');
    write(rh, JSON.stringify({ version: 1, checked: 1, failed: { failure: 'install', version: '0.2.1' } }));
    expect(updateCheck(env, home, now)).toMatchObject({ status: 'warn', detail: 'the update to 0.2.1 could not be installed: the app kept this version' });
    expect(updateCheck({ ...env, RETAKE_DISABLE_UPDATE_CHECK: '1' }, home, now).detail).toMatch(/ · RETAKE_DISABLE_UPDATE_CHECK is set here/);
    for (const bad of ['{"version":2,"checked":5}', 'not json', '{"version":1,"checked":"5","failed":{"failure":"install","version":"v1"}}']) {
      write(rh, bad);
      expect(readUpdateChecks(rh), bad).toEqual({ checked: null, failed: null });
    }
    // Only an installed app has the line (a checkout or a staged tree has no updater).
    expect(appChecks(probes({ env: { ...env, PATH: '/usr/bin' } })).map((c) => c.name)).not.toContain('App updates');
  });

  it('review d A-L9: a build made without an update feed says so (its launch.json), whatever the remembered checks say', () => {
    const { home, app } = setup();
    const rh = join(home, '.retake-scratch');
    const env = { HOME: home, RETAKE_HOME: rh, PATH: '/usr/bin' };
    const off = { status: 'ok', name: 'App updates', detail: 'updates are off in this build (made without an update feed): a newer version comes from its disk image' };
    expect(updateCheck(env, home, now, 'off')).toEqual(off);
    const line = () => appChecks(probes({ bundle: app.bundle, env })).find((c) => c.name === 'App updates');
    // No launch.json (or one from before L5.16d): the remembered checks.
    expect(line()?.detail).toMatch(/^not checked yet/);
    writeFileSync(join(app.bundle.root, 'launch.json'), JSON.stringify({ version: 2, bundled: true, updates: 'off' }));
    write(rh, JSON.stringify({ version: 1, checked: Math.floor(now / 1000) - 3600, failed: null }));
    expect(line()).toEqual(off);
    writeFileSync(join(app.bundle.root, 'launch.json'), JSON.stringify({ version: 2, bundled: true, updates: 'on' }));
    expect(line()?.detail).toMatch(/^last successful check /);
    expect([launchUpdates('{"updates":"on"}'), launchUpdates('{"updates":"off"}'), launchUpdates('{"updates":true}'), launchUpdates('not json'), launchUpdates(null), launchUpdates('null')]).toEqual(['on', 'off', null, null, null, null]);
  });
});
