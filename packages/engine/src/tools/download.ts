/**
 * One Tool's archive, downloaded (the decisions' "Sources"): from the URL its manifest records, over https, to
 * the hosts of the allow-list only (core TOOL_HOSTS, every redirect hop checked, at most MAX_REDIRECTS), with
 * `Accept-Encoding: identity` (the bytes hashed are the bytes sent), never more than the recorded size (a larger body
 * or a total that is not the recorded one is refused at once), into `<tools>/.partial/<name>.part` with its
 * `.part.json` (url, sha256, bytes, received). A cut connection keeps what arrived and resumes with `Range` (a `206`
 * that starts where the file ends; anything else starts again from zero), after a backoff that doubles from 2 s to 60 s,
 * at most `retry.attempts` times or `retry.maxMs` in all — then `offline`. A later install reuses a `.part` whose record
 * names the same archive. No proxy, cookie or credential: the injected `fetch` is called with the URL and these
 * headers only.
 *
 * The archive is never opened here: its sha256 is checked by the installer (install.ts) on the whole file on disk.
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_HOSTS, urlProblem } from '@retake/core/io';
import type { ToolEntry } from '@retake/core/io';
import type { Clock } from '../clock.js';

/** Redirect hops followed at most per request. */
export const MAX_REDIRECTS = 3;

/** How a download tries again after a cut: the first backoff, its cap, the tries and the time in all. */
export interface RetryPolicy {
  firstMs: number;
  capMs: number;
  attempts: number;
  maxMs: number;
}
export const RETRY: RetryPolicy = { firstMs: 2_000, capMs: 60_000, attempts: 8, maxMs: 10 * 60_000 };

/** A download refused for good (a host off the list, too many redirects, a body larger than recorded): never retried. */
export class DownloadRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadRefused';
  }
}

/** The connection kept failing past the retry policy: what arrived is kept. */
export class DownloadOffline extends Error {
  constructor(
    message: string,
    readonly received: number,
  ) {
    super(message);
    this.name = 'DownloadOffline';
  }
}

/** The download was stopped (a pause or a cancel): what arrived is kept. */
export class DownloadStopped extends Error {
  constructor(readonly received: number) {
    super('stopped');
    this.name = 'DownloadStopped';
  }
}

/** The part of `fetch` the downloader calls (tests hand their own: no network). */
export type ToolsFetch = (url: string, init: { redirect: 'manual'; headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export interface DownloadOptions {
  entry: ToolEntry;
  /** `<tools>/.partial`. */
  partial: string;
  fetch: ToolsFetch;
  hosts?: readonly string[];
  signal?: AbortSignal;
  retry?: RetryPolicy;
  /** Waits between tries (tests: none). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  clock: Pick<Clock, 'monotonic'>;
  /** Bytes on disk so far (called as they arrive). */
  onBytes?: (received: number) => void;
  log?: (line: string) => void;
}

/** The `.part` file of an entry and its record. */
export function partFiles(entry: ToolEntry, partial: string): { part: string; meta: string } {
  const leaf = entry.folder.split('/').pop()!;
  const part = join(partial, `${leaf}.${entry.archive}.part`);
  return { part, meta: `${part}.json` };
}

interface PartMeta {
  url: string;
  sha256: string;
  bytes: number;
  received: number;
}

/** Bytes of a `.part` that may be resumed: its record names this archive and the file is not longer than the archive. */
function resumable(entry: ToolEntry, part: string, meta: string): number {
  try {
    const m = JSON.parse(readFileSync(meta, 'utf8')) as PartMeta;
    const size = statSync(part).size;
    if (m.url === entry.url && m.sha256 === entry.sha256 && m.bytes === entry.bytes && size <= entry.bytes) return size;
  } catch {
    /* no record, or no file */
  }
  rmSync(part, { force: true });
  rmSync(meta, { force: true });
  return 0;
}

function writeMeta(entry: ToolEntry, meta: string, received: number): void {
  const tmp = `${meta}.tmp`;
  writeFileSync(tmp, JSON.stringify({ url: entry.url, sha256: entry.sha256, bytes: entry.bytes, received } satisfies PartMeta));
  renameSync(tmp, meta);
}

const sleepFor = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
  });

/**
 * GET `url` from byte `from`: each hop checked against the allow-list (https, its hosts), at most MAX_REDIRECTS
 * followed, by hand (`redirect: 'manual'`), the body of a redirect dropped.
 */
export async function getTool(o: Pick<DownloadOptions, 'fetch' | 'hosts' | 'signal'>, url: string, from: number): Promise<Response> {
  let at = url;
  for (let hop = 0; ; hop++) {
    const bad = urlProblem(at, o.hosts ?? TOOL_HOSTS);
    if (bad) throw new DownloadRefused(hop ? `refused a redirect: ${bad}` : bad);
    const headers: Record<string, string> = { 'accept-encoding': 'identity', ...(from > 0 ? { range: `bytes=${from}-` } : {}) };
    const res = await o.fetch(at, { redirect: 'manual', headers, ...(o.signal ? { signal: o.signal } : {}) });
    if (res.status < 300 || res.status >= 400) return res;
    await res.body?.cancel().catch(() => undefined);
    const loc = res.headers.get('location');
    if (!loc) throw new DownloadRefused(`${at} answered ${res.status} without a location`);
    if (hop >= MAX_REDIRECTS) throw new DownloadRefused(`${url}: more than ${MAX_REDIRECTS} redirects`);
    at = new URL(loc, at).href;
  }
}

/** Where a response's body starts in the archive (0 or `from`), or why it cannot be used. */
function bodyStart(entry: ToolEntry, res: Response, from: number): number {
  const enc = res.headers.get('content-encoding');
  if (enc && enc.toLowerCase() !== 'identity') throw new DownloadRefused(`${entry.url} came with Content-Encoding ${enc}: the bytes hashed must be the bytes sent`);
  if (res.status === 206 && from > 0) {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
    if (m && Number(m[1]) === from && Number(m[3]) === entry.bytes) return from;
    return -1; // not where the file ends: start again
  }
  if (res.status === 200) {
    const len = res.headers.get('content-length');
    if (len !== null && Number(len) !== entry.bytes) throw new DownloadRefused(`${entry.url} is ${len} bytes, not the ${entry.bytes} this version records`);
    return 0;
  }
  throw new Error(`${entry.url} answered ${res.status}`);
}

/** Append the body to `part` from `start`; returns the bytes on disk. Refuses at once past the recorded size. */
async function writeBody(o: DownloadOptions, res: Response, part: string, meta: string, start: number): Promise<number> {
  const fd = openSync(part, start === 0 ? 'w' : 'a');
  let received = start;
  let lastMeta = o.clock.monotonic();
  try {
    if (!res.body) throw new Error(`${o.entry.url} answered without a body`);
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (received + chunk.length > o.entry.bytes) throw new DownloadRefused(`${o.entry.url} sent more than the ${o.entry.bytes} bytes this version records`);
      writeSync(fd, chunk);
      received += chunk.length;
      o.onBytes?.(received);
      if (o.clock.monotonic() - lastMeta >= 1_000) {
        writeMeta(o.entry, meta, received);
        lastMeta = o.clock.monotonic();
      }
    }
  } finally {
    closeSync(fd);
    writeMeta(o.entry, meta, received);
  }
  return received;
}

/**
 * Download `entry`'s archive into `.partial` (resuming a `.part` of the same archive), and answer its path once all
 * its bytes are there. DownloadStopped on `signal`, DownloadRefused for good, DownloadOffline past the retry policy.
 */
export async function downloadArchive(o: DownloadOptions): Promise<string> {
  const { entry } = o;
  const { part, meta } = partFiles(entry, o.partial);
  const retry = o.retry ?? RETRY;
  const sleep = o.sleep ?? sleepFor;
  let received = resumable(entry, part, meta);
  if (received === entry.bytes) return part;
  const began = o.clock.monotonic();
  let wait = retry.firstMs;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await getTool(o, entry.url, received);
      let start = bodyStart(entry, res, received);
      if (start < 0) {
        await res.body?.cancel().catch(() => undefined);
        rmSync(part, { force: true });
        received = 0;
        continue;
      }
      if (start === 0 && received > 0) o.log?.(`${entry.label}: the server sent the whole archive again: starting from zero`);
      received = start = await writeBody(o, res, part, meta, start);
      if (received === entry.bytes) return part;
      throw new Error(`the connection ended after ${received} of ${entry.bytes} bytes`);
    } catch (e) {
      received = existsSync(part) ? statSync(part).size : 0;
      if (o.signal?.aborted) throw new DownloadStopped(received);
      if (e instanceof DownloadRefused) throw e;
      const why = e instanceof Error ? e.message : String(e);
      if (attempt >= retry.attempts || o.clock.monotonic() - began >= retry.maxMs) throw new DownloadOffline(`${entry.url}: ${why}`, received);
      o.log?.(`${entry.label}: ${why} — trying again in ${Math.round(wait / 1000)} s (what arrived is kept)`);
      await sleep(wait, o.signal);
      if (o.signal?.aborted) throw new DownloadStopped(received);
      wait = Math.min(wait * 2, retry.capMs);
    }
  }
}
