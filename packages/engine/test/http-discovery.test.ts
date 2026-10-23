/**
 * L4.1 (critique B8): the engine's HTTP listener binds 127.0.0.1 only; the discovery file `.demo-studio/ui.json` is
 * claimed exclusively (two claims at once: one wins, the other gets the holder), created 0600 whatever the umask,
 * read only when it is a regular file of this user without group / other bits, replaced when its holder is dead or
 * it is broken, and removed on release only when it is still ours (whatever its mode by then); an unwritable state
 * folder is a refusal with a fix.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineError, LOOPBACK, claimDiscovery, discoveryFile, isLoopbackAddress, listenLoopback, newSecret, readDiscovery, releaseDiscovery, selfIdentity } from '../src/index.js';
import type { DiscoveryRecord } from '../src/index.js';

let ws: string;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-discovery-'));
});

afterAll(async () => {
  if (ws) await rm(ws, { recursive: true, force: true });
});

async function record(port: number, pid?: number, started_at?: string): Promise<DiscoveryRecord> {
  const me = await selfIdentity();
  const p = pid ?? me.pid;
  const s = pid === undefined ? me.started_at : started_at;
  return { version: 1, kind: 'ui', pid: p, ...(s ? { started_at: s } : {}), port, url: `http://127.0.0.1:${port}/`, token: newSecret(), since: new Date().toISOString() };
}

describe('listenLoopback', () => {
  it('binds 127.0.0.1 only, on a free or a fixed port; a taken port is busy, a bad one invalid', async () => {
    const a = createServer();
    const port = await listenLoopback(a, 0);
    try {
      expect(a.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4', port });
      expect(LOOPBACK).toBe('127.0.0.1');
      const b = createServer();
      const e = await listenLoopback(b, port).then(() => undefined, (x: unknown) => x);
      expect(e).toBeInstanceOf(EngineError);
      expect((e as EngineError).code).toBe('busy');
      for (const bad of [-1, 65536, 1.5, Number.NaN]) await expect(listenLoopback(createServer(), bad)).rejects.toMatchObject({ code: 'invalid' });
    } finally {
      await new Promise<void>((r) => a.close(() => r()));
    }
    expect(isLoopbackAddress({ address: '0.0.0.0', family: 'IPv4', port: 1 })).toBe(false);
    expect(isLoopbackAddress({ address: '::', family: 'IPv6', port: 1 })).toBe(false);
    expect(isLoopbackAddress({ address: '::1', family: 'IPv6', port: 1 })).toBe(false);
    expect(isLoopbackAddress('/tmp/sock')).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });
});

describe('discovery file', () => {
  it('is created 0600 even under umask 0, inside .demo-studio/', async () => {
    const file = discoveryFile(ws);
    expect(file).toBe(join(ws, '.demo-studio', 'ui.json'));
    const old = process.umask(0);
    try {
      const r = await record(4100);
      expect(await claimDiscovery(file, r)).toEqual({ claimed: true });
    } finally {
      process.umask(old);
    }
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readDiscovery(file)).toMatchObject({ port: 4100, kind: 'ui' });
    await rm(file);
  });

  it('two claims at once: exactly one wins, the other gets the live holder', async () => {
    const file = discoveryFile(ws);
    const [r1, r2] = [await record(4101), await record(4102)];
    const out = await Promise.all([claimDiscovery(file, r1), claimDiscovery(file, r2)]);
    const won = out.filter((o) => o.claimed);
    expect(won).toHaveLength(1);
    const lost = out.find((o) => !o.claimed) as { claimed: false; holder: DiscoveryRecord };
    const winner = out[0].claimed ? r1 : r2;
    expect(lost.holder.token).toBe(winner.token);
    expect((await readDiscovery(file))?.token).toBe(winner.token);
    // Release by the loser removes nothing; by the winner, the file.
    await releaseDiscovery(file, winner === r1 ? r2 : r1);
    expect(await readDiscovery(file)).not.toBeNull();
    await releaseDiscovery(file, winner);
    expect(await readDiscovery(file)).toBeNull();
  });

  it('replaces a dead holder and a broken file', async () => {
    const file = discoveryFile(ws);
    const dead = spawnSync(process.execPath, ['-e', '']).pid as number;
    await claimDiscovery(file, await record(4103, dead, new Date(Date.now() - 3600_000).toISOString()));
    const mine = await record(4104);
    expect(await claimDiscovery(file, mine)).toEqual({ claimed: true });
    expect((await readDiscovery(file))?.token).toBe(mine.token);
    await rm(file);
    await writeFile(file, '{ not json', { mode: 0o600 });
    expect(await readDiscovery(file)).toBeNull();
    const next = await record(4105);
    expect(await claimDiscovery(file, next)).toEqual({ claimed: true });
    await rm(file);
  });

  it('refuses a file readable by others, a link, or a folder — never trusted, never replaced', async () => {
    const file = discoveryFile(ws);
    const r = await record(4106);
    await writeFile(file, JSON.stringify(r), { mode: 0o600 });
    await chmod(file, 0o644);
    await expect(readDiscovery(file)).rejects.toMatchObject({ code: 'refused' });
    await expect(claimDiscovery(file, await record(4107))).rejects.toMatchObject({ code: 'refused' });
    expect(JSON.parse(await readFile(file, 'utf8')).token).toBe(r.token);
    await rm(file);
    const target = join(ws, 'elsewhere.json');
    await writeFile(target, JSON.stringify(r), { mode: 0o600 });
    await symlink(target, file);
    await expect(readDiscovery(file)).rejects.toMatchObject({ code: 'refused' });
    await rm(file);
    await mkdir(file);
    await expect(readDiscovery(file)).rejects.toMatchObject({ code: 'refused' });
    await rm(file, { recursive: true });
  });

  it('release removes our own file whatever its mode now (0644 while serving), never the file of a successor or a link (review B L8)', async () => {
    const file = discoveryFile(ws);
    const r = await record(4110);
    expect(await claimDiscovery(file, r)).toEqual({ claimed: true });
    await chmod(file, 0o644);
    await releaseDiscovery(file, r);
    await expect(stat(file)).rejects.toThrow(/ENOENT/);
    // A successor's file stays, 0644 or not; so does a link, even to our own record.
    const next = await record(4111);
    expect(await claimDiscovery(file, next)).toEqual({ claimed: true });
    await chmod(file, 0o644);
    await releaseDiscovery(file, r);
    expect(JSON.parse(await readFile(file, 'utf8')).token).toBe(next.token);
    await rm(file);
    const target = join(ws, 'ours.json');
    await writeFile(target, JSON.stringify(r), { mode: 0o600 });
    await symlink(target, file);
    await releaseDiscovery(file, r);
    expect((await stat(file)).isFile()).toBe(true);
    await rm(file);
    await rm(target);
  });

  it('a state folder this user cannot write: refused with a fix, never a stack (review B L3)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-discovery-ro-'));
    try {
      await mkdir(join(dir, '.demo-studio'), { mode: 0o500 });
      await chmod(join(dir, '.demo-studio'), 0o500);
      const e = await claimDiscovery(discoveryFile(dir), await record(4112)).then(() => undefined, (x: unknown) => x);
      expect(e).toBeInstanceOf(EngineError);
      expect(e).toMatchObject({ code: 'refused', message: expect.stringContaining('is not writable (EACCES)'), fix: expect.stringContaining('chmod u+w') });
    } finally {
      await chmod(join(dir, '.demo-studio'), 0o700);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a record that does not fit is not one (a URL with a secret, a bad port)', async () => {
    const file = discoveryFile(ws);
    const r = await record(4108);
    for (const bad of [{ ...r, url: `http://127.0.0.1:4108/#c=${r.token}` }, { ...r, port: 0, url: 'http://127.0.0.1:0/' }, { ...r, version: 2 }, { ...r, token: 'short' }]) {
      await writeFile(file, JSON.stringify(bad), { mode: 0o600 });
      expect(await readDiscovery(file)).toBeNull();
      await rm(file);
    }
  });
});
