/**
 * L4.1 (critique B8): the engine's HTTP listener binds 127.0.0.1 only; the discovery file `.retake/ui.json` is
 * claimed exclusively (two claims at once: one wins, the other gets the holder), created 0600 whatever the umask,
 * read only when it is a regular file of this user without group / other bits, replaced when its holder is dead or
 * it is broken, and removed on release only when it is still ours (whatever its mode by then); an unwritable state
 * folder is a refusal with a fix.
 * The record in the workspace holds no secret (a token handed to the claim is not written); an older record (version
 * 1, with its token) is read for its holder only. The Studio's token lives in the Retake home, one file per workspace
 * (`ui/<16 hex>.token`, the same for a link to the workspace): 0600 whatever the umask, refused when it is a link, a
 * folder or readable by others, never replaced through a link, null for another workspace's record, removed on release
 * only when it is still ours.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DISCOVERY_VERSION,
  EngineError,
  LOOPBACK,
  claimDiscovery,
  discoveryFile,
  isLoopbackAddress,
  listenLoopback,
  newSecret,
  readDiscovery,
  readStudioToken,
  releaseDiscovery,
  releaseStudioToken,
  selfIdentity,
  studioTokenFile,
  writeStudioToken,
} from '../src/index.js';
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
  return { version: DISCOVERY_VERSION, kind: 'ui', pid: p, ...(s ? { started_at: s } : {}), port, url: `http://127.0.0.1:${port}/`, since: new Date().toISOString() };
}

describe('listenLoopback', () => {
  it('binds 127.0.0.1 only, on a free or a fixed port; a taken port is busy, a bad one invalid', async () => {
    const a = createServer();
    const port = await listenLoopback(a, 0);
    try {
      expect(a.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4', port });
      expect(LOOPBACK).toBe('127.0.0.1');
      const b = createServer();
      const e = await listenLoopback(b, port).then(
        () => undefined,
        (x: unknown) => x,
      );
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
  it('is created 0600 even under umask 0, inside .retake/', async () => {
    const file = discoveryFile(ws);
    expect(file).toBe(join(ws, '.retake', 'ui.json'));
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
    expect(lost.holder.port).toBe(winner.port);
    expect((await readDiscovery(file))?.port).toBe(winner.port);
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
    expect((await readDiscovery(file))?.port).toBe(mine.port);
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
    expect(JSON.parse(await readFile(file, 'utf8')).port).toBe(r.port);
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
    expect(JSON.parse(await readFile(file, 'utf8')).port).toBe(next.port);
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
      await mkdir(join(dir, '.retake'), { mode: 0o500 });
      await chmod(join(dir, '.retake'), 0o500);
      const e = await claimDiscovery(discoveryFile(dir), await record(4112)).then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(EngineError);
      expect(e).toMatchObject({ code: 'refused', message: expect.stringContaining('is not writable (EACCES)'), fix: expect.stringContaining('chmod u+w') });
    } finally {
      await chmod(join(dir, '.retake'), 0o700);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a record that does not fit is not one (a URL with a secret, a bad port, an unknown version, a token in a current record)', async () => {
    const file = discoveryFile(ws);
    const r = await record(4108);
    const secret = newSecret();
    for (const bad of [
      { ...r, url: `http://127.0.0.1:4108/#c=${secret}` },
      { ...r, port: 0, url: 'http://127.0.0.1:0/' },
      { ...r, version: 3 },
      { ...r, token: secret },
      { ...r, version: 1 },
      { ...r, version: 1, token: 'short' },
    ]) {
      await writeFile(file, JSON.stringify(bad), { mode: 0o600 });
      expect(await readDiscovery(file)).toBeNull();
      await rm(file);
    }
  });

  it('the record in the workspace holds no secret: a token handed to the claim is never written to ui.json', async () => {
    const file = discoveryFile(ws);
    const secret = newSecret();
    const r = { ...(await record(4113)), token: secret } as DiscoveryRecord;
    expect(await claimDiscovery(file, r)).toEqual({ claimed: true });
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain(secret);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['kind', 'pid', 'port', 'since', 'url', 'version', ...(r.started_at ? ['started_at'] : [])].sort());
    expect(await readDiscovery(file)).toMatchObject({ version: DISCOVERY_VERSION, port: 4113 });
    await releaseDiscovery(file, r);
    expect(await readDiscovery(file)).toBeNull();
  });

  it('a record of an older Retake (version 1, with its token) names its holder, never its token; a dead one is replaced', async () => {
    const file = discoveryFile(ws);
    const secret = newSecret();
    const old = { ...(await record(4114)), version: 1, token: secret };
    await writeFile(file, JSON.stringify(old), { mode: 0o600 });
    const read = await readDiscovery(file);
    expect(read).toMatchObject({ version: 1, port: 4114, pid: process.pid });
    expect(JSON.stringify(read)).not.toContain(secret);
    const lost = await claimDiscovery(file, await record(4115));
    expect(lost).toMatchObject({ claimed: false, holder: { version: 1, port: 4114 } });
    expect(JSON.stringify(lost)).not.toContain(secret);
    // Our own release never removes the older server's file.
    await releaseDiscovery(file, { ...old, version: 1 } as DiscoveryRecord);
    expect((await readDiscovery(file))?.version).toBe(1);
    const dead = spawnSync(process.execPath, ['-e', '']).pid as number;
    await writeFile(file, JSON.stringify({ ...old, pid: dead, started_at: new Date(Date.now() - 3600_000).toISOString() }), { mode: 0o600 });
    const mine = await record(4116);
    expect(await claimDiscovery(file, mine)).toEqual({ claimed: true });
    expect(await readDiscovery(file)).toMatchObject({ version: DISCOVERY_VERSION, port: 4116 });
    await rm(file);
  });
});

describe('the Studio token in the Retake home', () => {
  let home: string;
  const env = () => ({ ...process.env, RETAKE_HOME: home });

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'studio-token-home-'));
  });
  afterAll(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('one file per workspace in <home>/ui, the same through a link to the workspace, never inside the workspace', async () => {
    const file = await studioTokenFile(ws, env());
    expect(dirname(file)).toBe(join(home, 'ui'));
    expect(basename(file)).toMatch(/^[0-9a-f]{16}\.token$/);
    const link = join(home, 'ws-link');
    await symlink(ws, link);
    expect(await studioTokenFile(link, env())).toBe(file);
    expect(await studioTokenFile(join(home, 'another'), env())).not.toBe(file);
    expect(file.startsWith(await realpath(ws))).toBe(false);
    expect(file.startsWith(ws)).toBe(false);
    await rm(link);
  });

  it('is written 0600 under umask 0 and read back for its workspace only; release removes it only while it is ours', async () => {
    const file = await studioTokenFile(ws, env());
    const token = newSecret();
    const old = process.umask(0);
    let rec;
    try {
      rec = await writeStudioToken(file, ws, { pid: process.pid, port: 4120 }, token);
    } finally {
      process.umask(old);
    }
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, 'ui'))).mode & 0o077).toBe(0);
    expect(await readStudioToken(file, ws)).toEqual({ version: 1, root: await realpath(ws), pid: process.pid, port: 4120, token });
    // The file of another workspace's name (a hash collision, a copied file) is not this workspace's.
    expect(await readStudioToken(file, home)).toBeNull();
    // A successor's record stays; ours goes.
    const next = await writeStudioToken(file, ws, { pid: process.pid, port: 4121 }, newSecret());
    await releaseStudioToken(file, rec);
    expect((await readStudioToken(file, ws))?.port).toBe(4121);
    await releaseStudioToken(file, next);
    await expect(stat(file)).rejects.toThrow(/ENOENT/);
    expect(await readStudioToken(file, ws)).toBeNull();
    await writeFile(file, '{ not json', { mode: 0o600 });
    expect(await readStudioToken(file, ws)).toBeNull();
    await rm(file);
  });

  it('refuses a token file readable by others, a link or a folder — never read, never replaced through', async () => {
    const file = await studioTokenFile(ws, env());
    const token = newSecret();
    await writeStudioToken(file, ws, { pid: process.pid, port: 4122 }, token);
    await chmod(file, 0o644);
    await expect(readStudioToken(file, ws)).rejects.toMatchObject({ code: 'refused', fix: expect.stringContaining(`remove ${file}`) });
    await rm(file);
    const target = join(ws, 'planted.token');
    await writeFile(target, JSON.stringify({ version: 1, root: await realpath(ws), pid: process.pid, port: 4123, token }), { mode: 0o600 });
    await symlink(target, file);
    await expect(readStudioToken(file, ws)).rejects.toMatchObject({ code: 'refused' });
    await expect(writeStudioToken(file, ws, { pid: process.pid, port: 4124 }, newSecret())).rejects.toMatchObject({ code: 'refused' });
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect(await readlink(file)).toBe(target);
    expect(JSON.parse(await readFile(target, 'utf8')).port).toBe(4123);
    await rm(file);
    await rm(target);
    await mkdir(file);
    await expect(readStudioToken(file, ws)).rejects.toMatchObject({ code: 'refused' });
    await rm(file, { recursive: true });
  });
});
