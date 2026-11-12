/**
 * L3.5 a site extraction against pages that attack the extraction itself (hostile.test of the brand-site fixture, over
 * self-signed https through the production path): a renderer busy loop ends at the call timeout or the deadline and a
 * cancel within seconds (the browser closed, the worker free); shared workers and fetchLater are removed by each of
 * the two layers alone; huge font names are cut; a top-level redirect to another host fails (the approval names one host); logos a
 * create would refuse (under 64 px high, over the size cap) are never made; links planted in the extraction's folder
 * are replaced, never written through.
 */
import { lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancelledError, DEFAULT_BROWSER_ARGS, UNROUTED_APIS_BLOCK, extractSite, launchTarget, sameSiteHost, siteBrowserArgs } from '../src/index.js';
import { readFacts } from '../src/site/page-script.js';
import type { PageFacts } from '../src/site/page-script.js';
import type { SiteReport } from '../src/index.js';
import { hasOpenssl, startBrandSite } from './site-fixture.js';
import type { BrandSite } from './site-fixture.js';
import { PERSON_POLICY } from '@retake/core';

const can = hasOpenssl();

describe('the approved host and its www / apex sibling', () => {
  it('same host, www ↔ apex only', () => {
    expect(sameSiteHost('brand.example', 'brand.example')).toBe(true);
    expect(sameSiteHost('brand.example', 'www.brand.example')).toBe(true);
    expect(sameSiteHost('www.brand.example', 'brand.example')).toBe(true);
    expect(sameSiteHost('brand.example', 'WWW.Brand.Example.')).toBe(true);
    expect(sameSiteHost('brand.example', 'shop.brand.example')).toBe(false);
    expect(sameSiteHost('brand.example', 'other.example')).toBe(false);
    expect(sameSiteHost('www.brand.example', 'www.www.brand.example')).toBe(true);
    expect(sameSiteHost('brand.example', 'www.www.brand.example')).toBe(false);
  });
});

describe('shared workers and fetchLater are removed by each layer alone (no network: a page fulfilled in place)', () => {
  const blob = `URL.createObjectURL(new Blob(["onconnect = () => {};"], { type: "text/javascript" }))`;
  /** An https page (a secure context: fetchLater exists only there), answered by the route — nothing resolves. */
  const securePage = async (context: BrowserContext): Promise<Page> => {
    await context.route('**/*', (r) => (r.request().url() === 'https://page.test/' ? r.fulfill({ status: 200, contentType: 'text/html', body: '<p>x</p>' }) : r.abort()));
    const page = await context.newPage();
    await page.goto('https://page.test/');
    return page;
  };
  const NO_DNS = '--host-resolver-rules=MAP * ~NOTFOUND';

  it('the init script: both throw, and cannot be put back', async () => {
    const browser = await chromium.launch({ ...launchTarget(undefined, { policy: PERSON_POLICY }), headless: true, args: [...DEFAULT_BROWSER_ARGS, NO_DNS] });
    try {
      const plain = await securePage(await browser.newContext());
      expect(await plain.evaluate('[typeof SharedWorker, typeof fetchLater]')).toEqual(['function', 'function']);
      const context = await browser.newContext();
      await context.addInitScript(UNROUTED_APIS_BLOCK);
      const page = await securePage(context);
      expect(await page.evaluate(`(() => { try { new SharedWorker(${blob}); return 'started'; } catch (e) { return e.name; } })()`)).toBe('SecurityError');
      expect(await page.evaluate(`(() => { try { fetchLater('https://page.test/later', { method: 'POST' }); return 'queued'; } catch (e) { return e.name; } })()`)).toBe('SecurityError');
      // Non-configurable, read-only: the page cannot put another one in its place.
      expect(
        await page.evaluate(
          `(() => { for (const n of ['SharedWorker', 'fetchLater']) { try { delete globalThis[n]; } catch {} try { globalThis[n] = function () {}; } catch {} } try { new SharedWorker(${blob}); return 'started'; } catch (e) { return e.name; } })()`,
        ),
      ).toBe('SecurityError');
    } finally {
      await browser.close();
    }
  });

  it('the Blink switch of siteBrowserArgs: neither exists at all', async () => {
    const browser = await chromium.launch({ ...launchTarget(undefined, { policy: PERSON_POLICY }), headless: true, args: siteBrowserArgs(9) });
    try {
      const page = await securePage(await browser.newContext());
      expect(await page.evaluate('[typeof SharedWorker, typeof fetchLater]')).toEqual(['undefined', 'undefined']);
    } finally {
      await browser.close();
    }
  });
});

describe('the page reader cuts what the page controls (no network: a page set in place)', () => {
  it('family names to 200 characters, candidate URLs (data: and https) to their caps', async () => {
    const browser = await chromium.launch({ ...launchTarget(undefined, { policy: PERSON_POLICY }), headless: true, args: DEFAULT_BROWSER_ARGS });
    try {
      const page = await browser.newPage();
      await page.route('**/*', (r) => r.abort());
      const big = 'A'.repeat(60_000);
      await page.setContent(
        `<html><head><link rel="icon" href="data:image/png;base64,${big}"><link rel="apple-touch-icon" href="data:image/png;base64,AAAA"><link rel="mask-icon" href="https://cdn.example.net/${'p'.repeat(6000)}.svg"></head><body><h1 style="font-family: '${'F'.repeat(5000)}'">x</h1><p>y</p></body></html>`,
      );
      await page.evaluate(`document.fonts.add(new FontFace("${'G'.repeat(5000)}", "local(Arial)"))`);
      const facts = (await page.evaluate(
        `(() => { var __name = (f) => f; return (${readFacts.toString()})(${JSON.stringify({ maxCandidates: 6, svgMax: 400_000, urlMax: 4096, dataUrlMax: 50_000 })}); })()`,
      )) as PageFacts;
      expect(Object.keys(facts.fonts.display).every((f) => f.length <= 200)).toBe(true);
      expect(facts.faces.every((f) => f.family.length <= 200)).toBe(true);
      const urls = facts.candidates.map((c) => ('url' in c ? c.url : ''));
      expect(urls).toEqual(['data:image/png;base64,AAAA']);
    } finally {
      await browser.close();
    }
  });
});

describe.skipIf(!can)('a site extraction against hostile pages', () => {
  let site: BrandSite;
  const dirs: string[] = [];
  const outDir = async () => {
    const d = await mkdtemp(join(tmpdir(), 'site-hostile-'));
    dirs.push(d);
    return d;
  };

  beforeAll(async () => {
    site = await startBrandSite();
  }, 60_000);

  afterAll(async () => {
    await site?.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('a renderer busy loop ends at the call timeout: failed, the browser closed, nothing hangs', async () => {
    const t0 = Date.now();
    const r = await extractSite({ policy: PERSON_POLICY, url: 'https://hostile.test/hang', host: 'hostile.test', outDir: await outDir(), testResolve: site.testResolve, callTimeoutMs: 3000 });
    expect(r.status).toBe('failed');
    expect(r.untrusted.error).toMatch(/the page did not answer in 3 s/);
    expect(Date.now() - t0).toBeLessThan(25_000);
  }, 60_000);

  it('and at the deadline when calls may take longer', async () => {
    const t0 = Date.now();
    const r = await extractSite({
      policy: PERSON_POLICY,
      url: 'https://hostile.test/hang',
      host: 'hostile.test',
      outDir: await outDir(),
      testResolve: site.testResolve,
      callTimeoutMs: 120_000,
      deadlineMs: 9000,
    });
    expect(r.status).toBe('failed');
    expect(r.untrusted.error).toMatch(/took more than 9 s/);
    expect(Date.now() - t0).toBeLessThan(20_000);
  }, 60_000);

  it('a cancel ends it within seconds, whatever the page does', async () => {
    const ac = new AbortController();
    let abortedAt = 0;
    const p = extractSite({
      policy: PERSON_POLICY,
      url: 'https://hostile.test/hang',
      host: 'hostile.test',
      outDir: await outDir(),
      testResolve: site.testResolve,
      signal: ac.signal,
      onPhase: (phase) => {
        if (phase === 'reading')
          setTimeout(() => {
            abortedAt = Date.now();
            ac.abort();
          }, 2500);
      },
    });
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(abortedAt).toBeGreaterThan(0);
    expect(Date.now() - abortedAt).toBeLessThan(5000);
  }, 60_000);

  it('font face names are cut: site.json stays small', async () => {
    const dir = await outDir();
    const r = await extractSite({ policy: PERSON_POLICY, url: 'https://hostile.test/fonts', host: 'hostile.test', outDir: dir, testResolve: site.testResolve });
    expect(r.status, JSON.stringify(r.untrusted.error)).toBe('ok');
    expect(r.untrusted.fonts!.faces.length).toBeGreaterThan(0);
    expect(r.untrusted.fonts!.faces.length).toBeLessThanOrEqual(40);
    for (const f of r.untrusted.fonts!.faces) expect(f.family.length).toBeLessThanOrEqual(200);
    expect((await stat(join(dir, 'site.json'))).size).toBeLessThan(200_000);
  }, 60_000);

  it('a top-level redirect to another host fails: the approval names one host (its www / apex sibling aside)', async () => {
    const dir = await outDir();
    const r = await extractSite({ policy: PERSON_POLICY, url: 'https://brand.test/to-other', host: 'brand.test', outDir: dir, testResolve: site.testResolve });
    expect(r.status).toBe('failed');
    expect(r.warnings.join(' ')).toMatch(/the page redirects to another host \(its URL is the last of untrusted\.redirect_chain\): only brand\.test and its www \/ apex sibling are read/);
    // The other host is named only under untrusted.
    expect(JSON.stringify({ ...r, untrusted: undefined, warnings: r.warnings.filter((w) => !/unsafe test resolver/.test(w)) })).not.toContain('elsewhere');
    expect(r.untrusted.redirect_chain).toEqual(['https://brand.test/to-other', 'https://elsewhere.test/']);
    expect(r.network.requests).toBe(0);
    expect(site.hits.filter((h) => h.startsWith('GET elsewhere.test'))).toEqual([]);
    expect(await readdir(dir)).toEqual(['site.json']);
  }, 30_000);

  let wide: SiteReport;
  let wideDir: string;

  it('logos a create would refuse are never made: under 64 px high dropped, too heavy drawn smaller', async () => {
    wideDir = await outDir();
    wide = await extractSite({ policy: PERSON_POLICY, url: 'https://hostile.test/wide', host: 'hostile.test', outDir: wideDir, testResolve: site.testResolve, candidateMaxBytes: 200_000 });
    expect(wide.status, JSON.stringify(wide.untrusted.error)).toBe('ok');
    // The noise image only (the 2000 × 30 one would be 31 px high at 2048 px wide).
    expect(wide.candidates).toHaveLength(1);
    const c = wide.candidates[0];
    expect(c.height).toBeGreaterThanOrEqual(64);
    expect(c.height).toBeLessThan(400);
    const b = await readFile(join(wideDir, c.file));
    expect(b.length).toBeLessThanOrEqual(200_000);
    expect(b.readUInt32BE(20)).toBe(c.height);
  }, 60_000);

  it('links planted in the folder are replaced, never written through; the folder itself is never a link', async () => {
    const dir = await outDir();
    const victims = await outDir();
    for (const f of ['site.json', 'screenshot.jpg', 'logo-1.png']) {
      await writeFile(join(victims, f), 'ORIGINAL\n');
      await symlink(join(victims, f), join(dir, f));
    }
    const r = await extractSite({ policy: PERSON_POLICY, url: 'https://hostile.test/wide', host: 'hostile.test', outDir: dir, testResolve: site.testResolve });
    expect(r.status, JSON.stringify(r.untrusted.error)).toBe('ok');
    for (const f of ['site.json', 'screenshot.jpg', 'logo-1.png']) {
      expect(await readFile(join(victims, f), 'utf8'), f).toBe('ORIGINAL\n');
      expect((await lstat(join(dir, f))).isFile(), f).toBe(true);
    }
    // No temporary file left behind.
    expect((await readdir(dir)).filter((f) => f.startsWith('.'))).toEqual([]);
    const linked = join(await outDir(), 'linked');
    await symlink(victims, linked);
    await expect(extractSite({ policy: PERSON_POLICY, url: 'https://hostile.test/wide', host: 'hostile.test', outDir: linked, testResolve: site.testResolve })).rejects.toThrow(/is not a folder/);
  }, 60_000);
});
