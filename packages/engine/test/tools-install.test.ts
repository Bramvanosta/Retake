/**
 * The Tools' installer (engine tools/): every rule of the decisions' "Sources", "Extraction" and "Integrity" —
 * the allow-list on every hop, the size cap, resume (`206` from where the file ends, else from zero), the sha256 before
 * anything is extracted, the listing and tree rules, the tree digest, the atomic rename, the lock, pause and cancel,
 * free space, `--from-archives` and the Playwright-cache import. Small fixture archives (test-support tools.ts) and an
 * injected fetch: never the network.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolState } from '@retake/core/io';
import type { ToolEntry } from '@retake/core/io';
import { FIXTURE_MARKERS, fakeToolsBundle, toolFixtures, tgzOf, zipOf } from '@retake/test-support/tools';
import type { FixtureTools } from '@retake/test-support/tools';
import { checkListing, tgzListing, treeProblem, zipListing } from '../src/tools/archive.js';
import { DownloadRefused, getTool, partFiles } from '../src/tools/download.js';
import type { ToolsFetch } from '../src/tools/download.js';
import { extractArchive, sweepLeftovers } from '../src/tools/extract.js';
import { controlTools, installTools } from '../src/tools/install.js';
import type { InstallToolsOptions } from '../src/tools/install.js';
import { askHolder, liveHolder, toolsStatus } from '../src/tools/state.js';
import { checkToolsFor } from '../src/tools-work.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-tools-install-')));
afterAll(() => {
  spawnSync('/bin/chmod', ['-R', 'u+w', tmp]);
  rmSync(tmp, { recursive: true, force: true });
});
const clock = { now: () => Date.now(), monotonic: () => performance.now() };
const NO_WAIT = { firstMs: 1, capMs: 1, attempts: 3, maxMs: 60_000 };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let fx: FixtureTools;
let n = 0;
beforeAll(async () => {
  fx = await toolFixtures(join(tmp, 'fx'));
});

/** A fresh home and its Tools folder. */
function home(): { env: { RETAKE_HOME: string }; tools: string } {
  const h = join(tmp, `home${n++}`);
  return { env: { RETAKE_HOME: h }, tools: join(h, 'tools') };
}

interface Served {
  /** Bytes served per URL (default the fixtures'). */
  bytes?: Map<string, Buffer>;
  /** Cut the body of the n-th request (1-based) after this many bytes. */
  cut?: { request: number; after: number };
  /** Answer a Range request with the whole body (200). */
  ignoreRange?: boolean;
  /** Answer a Range request with a 206 of the whole body (its Content-Range starting at 0, not where the file ends). */
  wrongRange?: boolean;
  /** Redirects: from URL to Location. */
  redirects?: Map<string, string>;
  /** Hold every body until this resolves. */
  hold?: Promise<void>;
}

/** An injected fetch over the fixture archives; `calls` records each request (URL and headers). */
function serve(s: Served = {}): { fetch: ToolsFetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const bytes = s.bytes ?? new Map(fx.tools.map((t) => [t.entry.url, t.bytes]));
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch: ToolsFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const to = s.redirects?.get(url);
    if (to) return new Response(null, { status: 302, headers: { location: to } });
    const body = bytes.get(url);
    if (!body) return new Response('not found', { status: 404 });
    const m = /^bytes=(\d+)-$/.exec(init.headers.range ?? '');
    const from = m && !s.ignoreRange && !s.wrongRange ? Number(m[1]) : 0;
    const part = body.subarray(from);
    const cutHere = s.cut && s.cut.request === calls.length ? s.cut.after : undefined;
    const hold = s.hold;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      // One chunk per pull: an error after a chunk (a cut) reaches the reader after the chunk did.
      async pull(c) {
        if (pulls++ === 0 && hold) await hold;
        if (init.signal?.aborted) return c.error(new Error('aborted'));
        if (pulls === 1) c.enqueue(new Uint8Array(cutHere !== undefined ? part.subarray(0, cutHere) : part));
        else if (cutHere !== undefined) c.error(new Error('socket hang up'));
        else c.close();
      },
    });
    const headers: Record<string, string> = { 'content-length': String(part.length) };
    if (from > 0 || (m && s.wrongRange)) headers['content-range'] = `bytes ${from}-${body.length - 1}/${body.length}`;
    return new Response(stream, { status: from > 0 || (m && s.wrongRange) ? 206 : 200, headers });
  };
  return { fetch, calls };
}

const base = (env: { RETAKE_HOME: string }, over: Partial<InstallToolsOptions> = {}): InstallToolsOptions => ({
  env,
  entries: fx.entries,
  version: '0.0.1',
  by: 'cli',
  clock,
  retry: NO_WAIT,
  freeBytes: () => 1e12,
  ...over,
});

describe('the whole install', () => {
  it('downloads, checks and places the three Tools: Playwright’s layout, markers, the stamp, read-only, nothing left behind', async () => {
    const { env, tools } = home();
    const { fetch, calls } = serve();
    const r = await installTools(base(env, { fetch }));
    expect(r).toMatchObject({ outcome: 'ready', installed: ['render-browser', 'compositor', 'browser'] });
    // Smallest first, each request on the allow-list, the bytes as sent.
    expect(calls.map((c) => c.url)).toEqual(fx.entries.map((e) => e.url));
    for (const c of calls) expect(c.headers).toEqual({ 'accept-encoding': 'identity' });
    for (const e of fx.entries) expect(toolState(e, tools).state, e.id).toBe('ready');
    const shell = join(tools, 'browsers', 'chromium_headless_shell-001');
    for (const m of FIXTURE_MARKERS) expect(readFileSync(join(shell, m), 'utf8')).toBe('');
    expect(statSync(shell).mode & 0o777).toBe(0o555);
    expect(statSync(join(shell, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')).mode & 0o777).toBe(0o555);
    expect(statSync(join(shell, 'chrome-headless-shell-mac-arm64', 'LICENSE.headless_shell')).mode & 0o777).toBe(0o444);
    // The manifest's prune path is gone; the framework's links are kept.
    const fw = join(tools, 'browsers', 'chromium-001', 'chrome-mac-arm64', 'Fixture Browser.app', 'Contents', 'Frameworks', 'Fixture.framework');
    expect(existsSync(join(fw, 'Versions', '0.0.1', 'Resources', 'install.sh'))).toBe(false);
    expect(lstatSync(join(fw, 'Versions', 'Current')).isSymbolicLink()).toBe(true);
    expect(readdirSync(tools).sort()).toEqual(['.state.json', 'browsers', 'compositor-0.0.1']);
    expect(toolsStatus(env, fx.entries)).toMatchObject({ available: true, state: 'ready', total_bytes: 0 });
    // Again: nothing to do, nothing fetched (each folder digested again before it is kept).
    const again = serve();
    expect(await installTools(base(env, { fetch: again.fetch }))).toMatchObject({ outcome: 'ready', installed: [] });
    expect(again.calls).toEqual([]);
  });
});

describe('sources: the allow-list on every hop, the size, the encoding', () => {
  it('a redirect to another host or to http, or more than three hops: refused, the next hop never fetched; a hop on the list is followed', async () => {
    const url = fx.entries[0]!.url;
    const via = (to: string) => serve({ redirects: new Map([[url, to]]) });
    for (const to of ['https://downloads.example/x.zip', 'http://storage.googleapis.com/x.zip']) {
      const { fetch, calls } = via(to);
      await expect(getTool({ fetch }, url, 0)).rejects.toThrow(DownloadRefused);
      expect(calls.map((c) => c.url)).toEqual([url]);
    }
    // A relative Location on the same host is followed (and checked like the first hop).
    const same = via('/elsewhere.zip');
    await expect(getTool({ fetch: same.fetch }, url, 0)).resolves.toMatchObject({ status: 404 });
    expect(same.calls.map((c) => c.url)).toEqual([url, 'https://storage.googleapis.com/elsewhere.zip']);
    const loop: ToolsFetch = async (u) => new Response(null, { status: 302, headers: { location: `${u}/next` } });
    await expect(getTool({ fetch: loop }, url, 0)).rejects.toThrow(/more than 3 redirects/);
    await expect(getTool({ fetch: loop }, 'http://storage.googleapis.com/a.zip', 0)).rejects.toThrow(/https only/);
    // An install whose first archive is redirected away: failed, nothing written, the reason said.
    const { env, tools } = home();
    const away = via('https://downloads.example/x.zip');
    const r = await installTools(base(env, { fetch: away.fetch }));
    expect(r).toMatchObject({ outcome: 'failed', message: expect.stringMatching(/refused a redirect: url https:\/\/downloads\.example\/x\.zip: downloads\.example is not one of the hosts/) });
    expect(toolState(fx.entries[0]!, tools).state).toBe('missing');
  });

  it('a body larger than recorded, a length that is not the recorded one, or a compressed body: refused', async () => {
    for (const over of [{ bytes: new Map(fx.tools.map((t) => [t.entry.url, Buffer.concat([t.bytes, Buffer.from('x')])])) }]) {
      const { env } = home();
      const r = await installTools(base(env, { fetch: serve(over).fetch }));
      expect(r).toMatchObject({ outcome: 'failed', message: expect.stringMatching(/is \d+ bytes, not the \d+ this version records/) });
    }
    const gz: ToolsFetch = async () => new Response('x', { status: 200, headers: { 'content-encoding': 'gzip' } });
    expect(await installTools(base(home().env, { fetch: gz }))).toMatchObject({ outcome: 'failed', message: expect.stringMatching(/Content-Encoding gzip/) });
    // No content-length: the bytes are counted as they come, and refused past the recorded size.
    const long: ToolsFetch = async () => new Response(new Uint8Array(fx.entries[0]!.bytes + 10), { status: 200 });
    const stripped: ToolsFetch = async (u, i) => {
      const r = await long(u, i);
      return new Response(r.body, { status: 200 });
    };
    expect(await installTools(base(home().env, { fetch: stripped }))).toMatchObject({ outcome: 'failed', message: expect.stringMatching(/sent more than the \d+ bytes/) });
  });
});

describe('resume', () => {
  it('a cut connection keeps what arrived and resumes from there (Range, 206)', async () => {
    const { env } = home();
    const { fetch, calls } = serve({ cut: { request: 1, after: 100 } });
    const r = await installTools(base(env, { fetch }));
    expect(r.outcome).toBe('ready');
    expect(calls[1]).toEqual({ url: fx.entries[0]!.url, headers: { 'accept-encoding': 'identity', range: 'bytes=100-' } });
  });

  it('a server that answers 200 to a Range request: the archive starts again from zero (and is right)', async () => {
    const { env } = home();
    const lines: string[] = [];
    const { fetch, calls } = serve({ cut: { request: 1, after: 100 }, ignoreRange: true });
    const r = await installTools(base(env, { fetch, log: (l) => lines.push(l) }));
    expect(r.outcome).toBe('ready');
    expect(calls[1]!.headers.range).toBe('bytes=100-');
    expect(lines.some((l) => /starting from zero/.test(l))).toBe(true);
  });

  it('a 206 that does not start where the file ends: the archive starts again from zero (never appended out of place)', async () => {
    const { env } = home();
    const { fetch, calls } = serve({ cut: { request: 1, after: 100 }, wrongRange: true });
    const r = await installTools(base(env, { fetch }));
    expect(r.outcome).toBe('ready');
    expect(calls.slice(0, 3).map((c) => c.headers.range)).toEqual([undefined, 'bytes=100-', undefined]);
  });

  it('past the retry policy: offline, what arrived kept; a later install resumes from it', async () => {
    const { env, tools } = home();
    const down: ToolsFetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    const first = serve({ cut: { request: 1, after: 64 } });
    let i = 0;
    const flaky: ToolsFetch = (u, init) => (i++ === 0 ? first.fetch(u, init) : down(u, init));
    const r = await installTools(base(env, { fetch: flaky }));
    expect(r).toMatchObject({ outcome: 'offline', message: expect.stringMatching(/^the connection was lost — what arrived is kept/) });
    const { part } = partFiles(fx.entries[0]!, join(tools, '.partial'));
    expect(statSync(part).size).toBe(64);
    expect(toolsStatus(env, fx.entries)).toMatchObject({ state: 'offline', received_bytes: 64 });
    const later = serve();
    expect((await installTools(base(env, { fetch: later.fetch }))).outcome).toBe('ready');
    expect(later.calls[0]!.headers.range).toBe('bytes=64-');
  });
});

describe('the sha256 before anything is extracted', () => {
  it('a wrong archive (same size): deleted, nothing extracted, mismatch with both digests and the URL', async () => {
    const { env, tools } = home();
    const t = fx.tools[0]!;
    const forged = Buffer.from(t.bytes);
    forged[forged.length - 30] = forged[forged.length - 30]! ^ 0xff;
    const { fetch } = serve({ bytes: new Map([[t.entry.url, forged]]) });
    // The extractor is watched: it never runs for an archive whose sha256 is not the recorded one.
    const extracted: string[] = [];
    const extract: InstallToolsOptions['extract'] = async (e, archive, into) => {
      extracted.push(e.id);
      await extractArchive(e, archive, into);
    };
    const r = await installTools(base(env, { fetch, extract }));
    expect(extracted).toEqual([]);
    expect(r).toMatchObject({ outcome: 'mismatch', message: expect.stringContaining(`recorded ${t.entry.sha256}, from ${t.entry.url}`) });
    expect(r.run?.tools['render-browser']).toMatchObject({ state: 'mismatch', mismatch: 'archive', expected: t.entry.sha256, got: sha(forged), url: t.entry.url });
    expect(readdirSync(tools).filter((f) => !f.startsWith('.state') && f !== '.partial')).toEqual(['browsers']);
    expect(readdirSync(join(tools, 'browsers'))).toEqual([]);
    expect(existsSync(partFiles(t.entry, join(tools, '.partial')).part)).toBe(false);
    expect(toolsStatus(env, fx.entries).tools[0]).toMatchObject({ state: 'mismatch', expected: t.entry.sha256, got: sha(forged) });
    // The right archives: each one extracted once, after its check.
    const right = await installTools(base(env, { fetch: serve().fetch, extract }));
    expect(right.outcome).toBe('ready');
    expect(extracted).toEqual(['render-browser', 'compositor', 'browser']);
  });
});

/** An entry for hand-written archive bytes (its sha256 and size theirs; any tree). */
function entryFor(bytes: Buffer, over: Partial<ToolEntry> = {}): ToolEntry {
  return { ...fx.entries[0]!, bytes: bytes.length, sha256: sha(bytes), ...over };
}

describe('the listing, before the extractor runs', () => {
  const cases: Array<[string, Buffer, RegExp]> = [
    ['a .. segment', zipOf([{ name: 'a/../../escape', data: 'x' }]), /a \.\. segment/],
    ['an absolute name', zipOf([{ name: '/tmp/escape', data: 'x' }]), /an absolute path/],
    [
      'a file below a link',
      zipOf([
        { name: 'a', kind: 'link', data: '/tmp' },
        { name: 'a/planted', data: 'x' },
      ]),
      /lies below a link of the archive \(a\)/,
    ],
    // The disk folds case and Unicode normalisation: `A` and `a`, `café` in NFC and in NFD are one path.
    [
      'a file below a link named in another case',
      zipOf([
        { name: 'A', kind: 'link', data: '/tmp' },
        { name: 'a/planted', data: 'x' },
      ]),
      /lies below a link of the archive \(a\)/,
    ],
    [
      'a file below a link named in another Unicode form',
      zipOf([
        { name: 'caf\u00e9', kind: 'link', data: '/tmp' },
        { name: 'cafe\u0301/planted', data: 'x' },
      ]),
      /lies below a link of the archive/,
    ],
    ['a setuid file', zipOf([{ name: 'a/tool', data: 'x', mode: 0o4755 }]), /setuid or setgid/],
    ['a fifo', zipOf([{ name: 'a/pipe', kind: 'fifo' }]), /not a file, a folder or a link/],
  ];
  for (const [what, bytes, msg] of cases) {
    it(`a zip with ${what}: refused, nothing extracted`, async () => {
      const file = join(tmp, `crafted${n++}.zip`);
      writeFileSync(file, bytes);
      expect(() => checkListing(zipListing(file))).toThrow(msg);
      const { env, tools } = home();
      const e = entryFor(bytes);
      const r = await installTools(base(env, { entries: [e, ...fx.entries.slice(1)], only: ['render-browser'], fetch: serve({ bytes: new Map([[e.url, bytes]]) }).fetch }));
      expect(r).toMatchObject({ outcome: 'failed', message: expect.stringMatching(msg) });
      expect(readdirSync(tools).filter((f) => f.startsWith('.tmp') || f.startsWith('.trash'))).toEqual([]);
      expect(existsSync('/tmp/escape')).toBe(false);
    });
  }

  it('a tgz: a .. name, a device, an entry outside its package/ folder — refused', async () => {
    const file = (b: Buffer) => {
      const f = join(tmp, `crafted${n++}.tgz`);
      writeFileSync(f, b);
      return f;
    };
    await expect(tgzListing(file(tgzOf([{ name: 'package/ok', data: 'x' }])))).resolves.toEqual([{ name: 'package/ok', kind: 'file', mode: 0o644 }]);
    await expect((async () => checkListing(await tgzListing(file(tgzOf([{ name: 'package/../../x', data: 'x' }]))), { root: 'package' }))()).rejects.toThrow(/a \.\. segment/);
    await expect((async () => checkListing(await tgzListing(file(tgzOf([{ name: 'package/dev', type: '3' }]))), { root: 'package' }))()).rejects.toThrow(/not a file, a folder or a link/);
    await expect((async () => checkListing(await tgzListing(file(tgzOf([{ name: 'other/x', data: 'x' }]))), { root: 'package' }))()).rejects.toThrow(/outside the archive's package\/ folder/);
    await expect(
      (async () =>
        checkListing(
          await tgzListing(
            file(
              tgzOf([
                { name: 'package/l', type: '2', link: '/etc' },
                { name: 'package/l/x', data: 'x' },
              ]),
            ),
          ),
          { root: 'package' },
        ))(),
    ).rejects.toThrow(/below a link/);
  });
});

describe('the tree, after extraction', () => {
  it('a link that leaves the tree (absolute, by .., through another link): refused, the folder never placed', async () => {
    const t = (entries: Parameters<typeof zipOf>[0]) => {
      const d = join(tmp, `tree${n++}`);
      mkdirSync(d);
      const z = join(d, 'a.zip');
      writeFileSync(z, zipOf(entries));
      spawnSync('/usr/bin/ditto', ['-x', '-k', z, join(d, 'x')]);
      return treeProblem(join(d, 'x'));
    };
    expect(t([{ name: 'a/up', kind: 'link', data: '../../outside' }])).toMatch(/a\/up is a link that leads out of the tree/);
    expect(t([{ name: 'a/abs', kind: 'link', data: '/etc' }])).toMatch(/a\/abs is a link to an absolute path/);
    expect(
      t([
        { name: 'a/f', data: 'x' },
        { name: 'a/in', kind: 'link', data: 'f' },
      ]),
    ).toBeUndefined();
    // The installer: a zip whose listing passes, holding a link out — refused after extraction, nothing placed.
    const bytes = zipOf([{ name: 'chrome-headless-shell-mac-arm64/up', kind: 'link', data: '../../../../../etc' }]);
    const { env, tools } = home();
    const e = entryFor(bytes);
    const r = await installTools(base(env, { entries: [e, ...fx.entries.slice(1)], only: ['render-browser'], fetch: serve({ bytes: new Map([[e.url, bytes]]) }).fetch }));
    expect(r).toMatchObject({ outcome: 'failed', message: expect.stringMatching(/is refused: chrome-headless-shell-mac-arm64\/up is a link to an absolute path|leads out of the tree/) });
    expect(toolState(e, tools).state).toBe('missing');
  });

  it('a setuid or setgid file, a fifo: refused (whatever the listing said)', () => {
    const d = join(tmp, `special${n++}`);
    mkdirSync(join(d, 'a'), { recursive: true });
    writeFileSync(join(d, 'a', 'tool'), 'x');
    expect(treeProblem(d)).toBeUndefined();
    spawnSync('/bin/chmod', ['4755', join(d, 'a', 'tool')]);
    expect(treeProblem(d)).toBe('a/tool carries a setuid or setgid bit');
    spawnSync('/bin/chmod', ['2755', join(d, 'a', 'tool')]);
    expect(treeProblem(d)).toBe('a/tool carries a setuid or setgid bit');
    spawnSync('/bin/chmod', ['0755', join(d, 'a', 'tool')]);
    spawnSync('/usr/bin/mkfifo', [join(d, 'a', 'pipe')]);
    expect(treeProblem(d)).toBe('a/pipe is not a file, a folder or a link');
  });

  it('a tree that is not the one recorded (its digest): mismatch, discarded', async () => {
    const { env, tools } = home();
    const e = { ...fx.entries[0]!, tree: 'f'.repeat(64) };
    const r = await installTools(base(env, { entries: [e, ...fx.entries.slice(1)], only: ['render-browser'], fetch: serve().fetch }));
    expect(r).toMatchObject({ outcome: 'mismatch', message: expect.stringMatching(/is not the one this version records \(tree digest [0-9a-f]{64}, recorded f{64}\)/) });
    expect(toolState(e, tools).state).toBe('missing');
    // Said as the tree's mismatch (the archive was right and opened), not the archive's.
    expect(toolsStatus(env, [e, ...fx.entries.slice(1)]).tools[0]).toMatchObject({ state: 'mismatch', mismatch: 'tree', expected: 'f'.repeat(64) });
  });
});

describe('the atomic rename and what a crash leaves', () => {
  it('a crash between the check and the rename leaves the old state; the next install sweeps the leftovers and finishes', async () => {
    const { env, tools } = home();
    const r = await installTools(
      base(env, {
        fetch: serve().fetch,
        beforePlace: () => {
          throw new Error('killed');
        },
      }),
    );
    expect(r).toMatchObject({ outcome: 'failed', message: 'killed' });
    for (const e of fx.entries) expect(toolState(e, tools).state).toBe('missing');
    mkdirSync(join(tools, '.tmp-0123abcd', 'chromium-001'), { recursive: true });
    mkdirSync(join(tools, '.trash-45ef'), { recursive: true });
    expect(sweepLeftovers(tools).sort()).toEqual(['.tmp-0123abcd', '.trash-45ef']);
    expect((await installTools(base(env, { fetch: serve().fetch }))).outcome).toBe('ready');
  });

  // A damaged folder is replaced by the checked tree whatever made it damaged — also when its tree digest is still
  // right (a marker, the stamp, a stamp that says damaged, the modes: none of them is in the digest).
  const causes: Array<[string, (shell: string, tools: string) => void, RegExp, string[]?]> = [
    ['a file planted (its digest differs)', (shell) => writeFileSync(join(shell, 'chrome-headless-shell-mac-arm64', 'planted'), 'x'), /its files changed/],
    ['a marker gone', (shell) => rmSync(join(shell, 'INSTALLATION_COMPLETE')), /its marker INSTALLATION_COMPLETE is missing/],
    ['its .verified stamp gone', (shell) => rmSync(join(shell, '.verified')), /never checked/],
    [
      'a stamp that says damaged (an earlier Check again)',
      (shell) => {
        const stamp = JSON.parse(readFileSync(join(shell, '.verified'), 'utf8')) as Record<string, unknown>;
        rmSync(join(shell, '.verified'));
        writeFileSync(join(shell, '.verified'), JSON.stringify({ ...stamp, damaged: 'its tree digest is 000…' }));
      },
      /its last check found its files changed/,
    ],
    ['a folder others may write', (shell) => spawnSync('/bin/chmod', ['g+w', shell]), /may be written by other users/],
    // The folders above are repaired in place (their write for others taken): nothing to download again.
    ['the browsers folder others may write', (_shell, tools) => spawnSync('/bin/chmod', ['o+w', join(tools, 'browsers')]), /may be written by other users/, []],
  ];
  for (const [what, damage, problem, installed = ['render-browser']] of causes) {
    it(`a damaged folder (${what}): repaired by one install (the checked tree replaces it), not downloaded again after`, async () => {
      const { env, tools } = home();
      await installTools(base(env, { fetch: serve().fetch }));
      const shell = join(tools, 'browsers', 'chromium_headless_shell-001');
      spawnSync('/bin/chmod', ['-R', 'u+w', shell]);
      damage(shell, tools);
      spawnSync('/bin/chmod', ['u-w', shell]);
      expect(toolState(fx.entries[0]!, tools)).toMatchObject({ state: 'damaged', problem: expect.stringMatching(problem) });
      const r = await installTools(base(env, { fetch: serve().fetch }));
      expect(r).toMatchObject({ outcome: 'ready', installed });
      expect(existsSync(join(shell, 'chrome-headless-shell-mac-arm64', 'planted'))).toBe(false);
      expect(toolState(fx.entries[0]!, tools).state).toBe('ready');
      expect(statSync(shell).mode & 0o777).toBe(0o555);
      const again = serve();
      expect(await installTools(base(env, { fetch: again.fetch }))).toMatchObject({ outcome: 'ready', installed: [] });
      expect(again.calls).toEqual([]);
    });
  }
});

describe('one install at a time', () => {
  it('two installers: one holds the lock, the other is told who; its status shows the download', async () => {
    const { env, tools } = home();
    let open!: () => void;
    const hold = new Promise<void>((r) => (open = r));
    const first = installTools(base(env, { fetch: serve({ hold }).fetch, by: 'studio' }));
    for (let i = 0; i < 200 && !liveHolder(tools); i++) await new Promise((r) => setTimeout(r, 10));
    const second = await installTools(base(env, { fetch: serve().fetch }));
    expect(second).toMatchObject({ outcome: 'busy', holder: { pid: process.pid, by: 'studio', version: '0.0.1' } });
    expect(toolsStatus(env, fx.entries)).toMatchObject({ state: 'downloading', by: { by: 'studio', pid: process.pid } });
    open();
    expect((await first).outcome).toBe('ready');
    expect(liveHolder(tools)).toBeNull();
  });
});

describe('pause, cancel, free space', () => {
  it('pause (this process) keeps what arrived; cancel (another process, .control.json) removes it', async () => {
    const { env, tools } = home();
    const stop = new AbortController();
    const half = serve({ cut: { request: 1, after: 128 } });
    const paused = installTools(
      base(env, {
        fetch: half.fetch,
        signal: stop.signal,
        sleep: async () => stop.abort(),
      }),
    );
    expect((await paused).outcome).toBe('paused');
    const { part } = partFiles(fx.entries[0]!, join(tools, '.partial'));
    expect(statSync(part).size).toBe(128);
    expect(toolsStatus(env, fx.entries)).toMatchObject({ state: 'paused' });
    let open!: () => void;
    const hold = new Promise<void>((r) => (open = r));
    const running = installTools(base(env, { fetch: serve({ hold }).fetch }));
    for (let i = 0; i < 200 && !liveHolder(tools); i++) await new Promise((r) => setTimeout(r, 10));
    askHolder(tools, 'cancel', clock);
    await new Promise((r) => setTimeout(r, 400));
    open();
    expect((await running).outcome).toBe('cancelled');
    expect(existsSync(join(tools, '.partial'))).toBe(false);
    // A cancel with no live holder clears what a dead one left.
    mkdirSync(join(tools, '.partial'), { recursive: true });
    await controlTools(env, 'cancel', clock, '0.0.1');
    expect(existsSync(join(tools, '.partial'))).toBe(false);
  });

  it('a cancel while an install holds the lock asks it (its files are never removed under it); a pause with none running does nothing', async () => {
    const { env, tools } = home();
    let open!: () => void;
    const hold = new Promise<void>((r) => (open = r));
    const running = installTools(base(env, { fetch: serve({ hold }).fetch }));
    for (let i = 0; i < 200 && !liveHolder(tools); i++) await new Promise((r) => setTimeout(r, 10));
    await controlTools(env, 'cancel', clock, '0.0.1');
    // Asked, not cleared: its state and its partial folder are still there while it runs.
    expect(existsSync(join(tools, '.state.json'))).toBe(true);
    expect(existsSync(join(tools, '.partial'))).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    open();
    expect((await running).outcome).toBe('cancelled');
    await controlTools(env, 'pause', clock, '0.0.1');
    expect(existsSync(join(tools, '.control.json'))).toBe(false);
  });

  it("an install that ends (ready or cancelled) removes only its own partial downloads: another version's paused one stays", async () => {
    const { env, tools } = home();
    const other = join(tools, '.partial', 'chromium-999.zip.part');
    mkdirSync(join(tools, '.partial'), { recursive: true });
    writeFileSync(other, 'paused bytes of another version');
    expect((await installTools(base(env, { fetch: serve().fetch, by: 'update' }))).outcome).toBe('ready');
    expect(readFileSync(other, 'utf8')).toBe('paused bytes of another version');
    for (const e of fx.entries) expect(existsSync(partFiles(e, join(tools, '.partial')).part)).toBe(false);
  });

  it('not enough free space: refused before anything is downloaded, with the figures', async () => {
    const { env } = home();
    const { fetch, calls } = serve();
    const r = await installTools(base(env, { fetch, freeBytes: () => 1000 }));
    expect(r).toMatchObject({
      outcome: 'failed',
      message: expect.stringMatching(/^not enough free space for the Tools in .*: they need [\d.]+ MB \(download and extracted, \+10 %\), 0\.0 MB are free$/),
    });
    expect(calls).toEqual([]);
  });
});

describe('local sources (no network)', () => {
  it('--from-archives: the same checks minus the download; a file of another size is refused', async () => {
    const { env } = home();
    expect(await installTools(base(env, { source: { from: 'archives', dir: fx.archives } }))).toMatchObject({ outcome: 'ready', installed: ['render-browser', 'compositor', 'browser'] });
    const odd = join(tmp, `odd${n++}`);
    mkdirSync(join(odd, 'google'), { recursive: true });
    for (const t of fx.tools) writeFileSync(join(odd, 'google', t.archive.split('/').pop()!), Buffer.concat([t.bytes, Buffer.from('!')]));
    expect(await installTools(base(home().env, { source: { from: 'archives', dir: odd } }))).toMatchObject({
      outcome: 'failed',
      message: expect.stringMatching(/bytes, not the \d+ this version records/),
    });
  });

  it('--from-playwright-cache: the browsers copied and their copy digested; a cache copy that differs is refused; no compositor there', async () => {
    const cache = join(tmp, `cache${n++}`);
    for (const t of fx.tools.filter((x) => x.entry.id !== 'compositor')) {
      const leaf = join(cache, t.entry.folder.split('/').pop()!);
      spawnSync('/usr/bin/ditto', [t.source, leaf]);
      for (const m of FIXTURE_MARKERS) writeFileSync(join(leaf, m), '');
    }
    const { env, tools } = home();
    const r = await installTools(base(env, { source: { from: 'playwright-cache', dir: cache }, only: ['render-browser', 'browser'] }));
    expect(r).toMatchObject({ outcome: 'ready', installed: ['render-browser', 'browser'] });
    expect(toolState(fx.entries[2]!, tools).state).toBe('ready');
    const all = await installTools(base(home().env, { source: { from: 'playwright-cache', dir: cache } }));
    expect(all).toMatchObject({ outcome: 'failed', message: expect.stringMatching(/Playwright's cache holds no compositor/) });
    writeFileSync(join(cache, 'chromium_headless_shell-001', 'chrome-headless-shell-mac-arm64', 'planted'), 'x');
    expect(await installTools(base(home().env, { source: { from: 'playwright-cache', dir: cache }, only: ['render-browser'] }))).toMatchObject({ outcome: 'mismatch' });
  });
});

describe('Check again', () => {
  it('takes the Tools folder’s lock: busy while an install holds it (nothing stamped), each Tool checked once it ends', async () => {
    const { env, tools } = home();
    const w = { env, clock, bundle: fakeToolsBundle(join(tmp, `app${n++}`), fx.entries) };
    expect(await installTools(base(env, { fetch: serve().fetch }))).toMatchObject({ outcome: 'ready' });
    // A folder whose digest is wrong, then an install of it under way: the check never reads (nor stamps) it meanwhile.
    const shell = join(tools, 'browsers', 'chromium_headless_shell-001');
    spawnSync('/bin/chmod', ['-R', 'u+w', shell]);
    writeFileSync(join(shell, 'chrome-headless-shell-mac-arm64', 'planted'), 'x');
    let open!: () => void;
    const hold = new Promise<void>((r) => (open = r));
    const running = installTools(base(env, { fetch: serve({ hold }).fetch, by: 'studio' }));
    for (let i = 0; i < 200 && !liveHolder(tools); i++) await new Promise((r) => setTimeout(r, 10));
    const stamp = readFileSync(join(shell, '.verified'), 'utf8');
    await expect(checkToolsFor(w)).rejects.toMatchObject({
      code: 'busy',
      message: expect.stringMatching(/^the Tools are being downloaded by the Studio \(pid \d+\): check them again once that ends$/),
    });
    expect(readFileSync(join(shell, '.verified'), 'utf8')).toBe(stamp);
    open();
    expect((await running).outcome).toBe('ready');
    expect((await checkToolsFor(w)).map((c) => c.state)).toEqual(['ready', 'ready', 'ready']);
    expect(liveHolder(tools)).toBeNull();
  });
});

describe('the status, each poll', () => {
  it('older folders are measured once while they stay as they are (no walk per poll); a folder replaced is measured again', () => {
    const { env, tools } = home();
    const old = join(tools, 'browsers', 'chromium-000', 'deep');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'f'), 'x'.repeat(100));
    expect(toolsStatus(env, fx.entries).older).toEqual({ folders: ['browsers/chromium-000'], bytes: 100 });
    // A file deep inside changes, the folder itself does not: the figure is the one measured (no walk).
    writeFileSync(join(old, 'f'), 'x'.repeat(300));
    expect(toolsStatus(env, fx.entries).older.bytes).toBe(100);
    // The folder replaced (a new inode): measured again.
    rmSync(join(tools, 'browsers', 'chromium-000'), { recursive: true });
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'f'), 'x'.repeat(200));
    expect(toolsStatus(env, fx.entries).older.bytes).toBe(200);
  });
});
