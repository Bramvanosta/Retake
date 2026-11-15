/**
 * Synthetic fontsource packages for the font fetch's tests (engine brand/fontsource-fetch.ts) — nothing here reaches
 * the network: a ustar writer (prefix, pax and GNU long names, links, a base-256 size, a wrong checksum on purpose) with
 * gzip, a package as the fetch expects it (package.json, LICENSE, latin WOFF2 files that pass the engine's font sniff),
 * its manifest, and two registries serving them — a fake of the engine's FontRegistry port in process, and a loopback
 * HTTP server for a child process (the test hatch, RETAKE_UNSAFE_TEST_NPM_REGISTRY). Families are invented (test-sans).
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

export interface TarEntry {
  name: string;
  data?: Buffer | string;
  /** Typeflag: '0' file (default), '5' folder, '1' / '2' link, 'x' pax, 'L' GNU long name. */
  type?: string;
  /** The ustar prefix field (the name is then `<prefix>/<name>`). */
  prefix?: string;
  /** A base-256 size field (refused by the reader). */
  base256?: boolean;
  /** A checksum one off (refused by the reader). */
  badChecksum?: boolean;
  /** A size field that is not octal. */
  sizeText?: string;
}

function header(e: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(e.name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  if (e.base256) {
    h[124] = 0x80;
    h.writeUInt32BE(size, 132);
  } else h.write(e.sizeText ?? `${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write('00000000000\0', 136, 'latin1');
  h.write(e.type ?? '0', 156, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  if (e.prefix) h.write(e.prefix, 345, 155, 'utf8');
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${(sum + (e.badChecksum ? 1 : 0)).toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

/** A pax extended header whose `path` names the next entry. */
export function paxPath(path: string): TarEntry {
  const body = (len: number) => `${len} path=${path}\n`;
  let len = body(0).length;
  while (body(len).length !== len) len = body(len).length;
  return { name: 'PaxHeader', type: 'x', data: body(len) };
}

/** A ustar archive of `entries` (end blocks unless `end: false`), gzipped. */
export function tgzOf(entries: TarEntry[], o: { end?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    parts.push(header(e, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  if (o.end !== false) parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/** A WOFF2 the engine's sniff accepts (signature, its own length, 3 tables), distinct per `seed`. */
export function woff2(seed: string, length = 64): Buffer {
  const w = Buffer.alloc(length);
  w.write('wOF2', 0, 'latin1');
  w.writeUInt32BE(0x00010000, 4);
  w.writeUInt32BE(length, 8);
  w.writeUInt16BE(3, 12);
  w.write(seed.slice(0, length - 48), 48, 'latin1');
  return w;
}

export const LICENCE_TEXT = 'Copyright 2026 The Test Sans Project Authors\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\n';

export interface FakePackage {
  id: string;
  version: string;
  tgz: Buffer;
  integrity: string;
  /** The manifest the registry answers for this version (its tarball URL on `base`). */
  manifest(base: string): Record<string, unknown>;
}

/**
 * A fontsource package: package.json, LICENSE and `package/files/<id>-latin-<w>-<style>.woff2` for each face (`400`,
 * `600italic`…), plus a latin-ext file the fetch never keeps. `entries` replaces the archive's entries; `licence`
 * the manifest's and package.json's licence (`pjLicence` package.json's alone).
 */
export function fakePackage(o: { id?: string; version?: string; licence?: unknown; pjLicence?: unknown; faces?: string[]; licenceFile?: boolean; entries?: TarEntry[]; extra?: TarEntry[] }): FakePackage {
  const id = o.id ?? 'test-sans';
  const version = o.version ?? '5.2.1';
  const licence = 'licence' in o ? o.licence : 'OFL-1.1';
  const faces = o.faces ?? ['400', '600'];
  const entries: TarEntry[] = o.entries ?? [
    { name: 'package/package.json', data: JSON.stringify({ name: `@fontsource/${id}`, version, license: 'pjLicence' in o ? o.pjLicence : licence }) },
    ...(o.licenceFile === false ? [] : [{ name: 'package/LICENSE', data: LICENCE_TEXT }]),
    ...faces.map((f) => {
      const m = /^(\d00)(italic)?$/.exec(f)!;
      return { name: `package/files/${id}-latin-${m[1]}-${m[2] ? 'italic' : 'normal'}.woff2`, data: woff2(`${id}-${version}-${f}`) };
    }),
    { name: `package/files/${id}-latin-ext-400-normal.woff2`, data: woff2('ext') },
    ...(o.extra ?? []),
  ];
  const tgz = tgzOf(entries);
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
  return {
    id,
    version,
    tgz,
    integrity,
    manifest: (base) => ({ name: `@fontsource/${id}`, version, license: licence, dist: { tarball: `${base}/@fontsource/${id}/-/${id}-${version}.tgz`, integrity } }),
  };
}

/** What a registry serves: `GET /@fontsource%2f<id>/<version|latest>` and `GET /@fontsource/<id>/-/<id>-<version>.tgz`. */
function answer(pkgs: FakePackage[], base: string, path: string, latest: Record<string, string>): Buffer | null {
  let m = /^\/@fontsource%2f([a-z0-9-]+)\/([0-9.]+|latest)$/.exec(path);
  if (m) {
    const version = m[2] === 'latest' ? latest[m[1]] : m[2];
    const p = pkgs.find((x) => x.id === m![1] && x.version === version);
    return p ? Buffer.from(JSON.stringify(p.manifest(base))) : null;
  }
  m = /^\/@fontsource\/([a-z0-9-]+)\/-\/[a-z0-9-]+-([0-9.]+)\.tgz$/.exec(path);
  if (m) return pkgs.find((x) => x.id === m![1] && x.version === m![2])?.tgz ?? null;
  return null;
}

/** The newest version of each id (the registry's `latest`). */
function latestOf(pkgs: FakePackage[]): Record<string, string> {
  const out: Record<string, string> = {};
  const newer = (a: string, b: string) => {
    const [x, y] = [a, b].map((v) => v.split('.').map(Number));
    const i = x.findIndex((v, k) => v !== y[k]);
    return i >= 0 && x[i] > y[i];
  };
  for (const p of pkgs) if (!out[p.id] || newer(p.version, out[p.id])) out[p.id] = p.version;
  return out;
}

/**
 * The engine's FontRegistry port, in process: it serves `pkgs` (or `override(path)` first), records every path asked
 * (`calls`) and holds the caps the adapter holds (over `max` → refused).
 */
export function fakeRegistry(pkgs: FakePackage[], o: { base?: string; test?: boolean; override?: (path: string) => Buffer | null | undefined } = {}) {
  const base = o.base ?? 'https://registry.npmjs.org';
  const calls: string[] = [];
  const latest = latestOf(pkgs);
  return {
    base,
    test: o.test ?? false,
    calls,
    async get(path: string, g: { max: number; signal: AbortSignal }): Promise<Buffer> {
      calls.push(path);
      const body = o.override?.(path) ?? answer(pkgs, base, path, latest);
      if (!body) throw Object.assign(new Error(`no ${path} (404)`), { code: 'not_found' });
      if (body.length > g.max) throw Object.assign(new Error(`${path} is more than ${g.max} bytes`), { code: 'refused' });
      return body;
    },
  };
}

/** A loopback registry over HTTP (127.0.0.1, an ephemeral port) serving `pkgs`; every request's path recorded. */
export async function loopbackRegistry(pkgs: FakePackage[], o: { status?: (path: string) => { status: number; headers?: Record<string, string> } | undefined } = {}) {
  const requests: string[] = [];
  let base = '';
  const latest = latestOf(pkgs);
  const server = createServer((req, res) => {
    const path = req.url ?? '';
    requests.push(path);
    const forced = o.status?.(path);
    if (forced) {
      res.writeHead(forced.status, forced.headers ?? {});
      res.end();
      return;
    }
    const body = answer(pkgs, base, path, latest);
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}
