/**
 * L3.5 site extraction end to end (R-MCP-12): the brand-site fixture over self-signed https on invented `.test` names,
 * through the production path (CONNECT proxy, route policy, Chromium switches) with only the unsafe test resolver in
 * between. The known palette comes back by role; font family names and every page string only under `untrusted`;
 * logo candidates are transparent PNGs; the escape attempts (POST, beacon, WebSocket, STUN, TURN, service worker on
 * the prototype and from a fresh frame, shared workers from a blob and from a script, a deferred fetchLater POST, a popup, preconnect, a cross-host
 * redirect, IP literals, the metadata address, a name with a private address, a navigation away) reach nothing; a
 * malformed data: icon is skipped, not fatal; only site.json, screenshot.jpg and logo-<n>.png are written — no font
 * file, no cookie file.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractSite } from '../src/index.js';
import type { SiteReport } from '../src/index.js';
import { BRAND_SITE_COLORS, BRAND_SITE_URL, hasOpenssl, startBrandSite } from '@retake/test-support/site';
import type { BrandSite } from '@retake/test-support/site';
import { PERSON_POLICY } from '@retake/core';

const can = hasOpenssl();

describe.skipIf(!can)('site extraction of the brand-site fixture', () => {
  let site: BrandSite;
  let out: string;
  let report: SiteReport;

  beforeAll(async () => {
    site = await startBrandSite();
    out = await mkdtemp(join(tmpdir(), 'site-extract-'));
    report = await extractSite({ policy: PERSON_POLICY, url: BRAND_SITE_URL, host: 'brand.test', outDir: out, testResolve: site.testResolve });
  }, 120_000);

  afterAll(async () => {
    await site?.close();
    if (out) await rm(out, { recursive: true, force: true });
  });

  it('opens the page through the proxy, after the apex → www redirect followed in Node', () => {
    expect(report.status, JSON.stringify(report.untrusted)).toBe('ok');
    expect(report.http_status).toBe(200);
    expect(report.redirects).toBe(1);
    expect(report.untrusted.final_url).toBe('https://www.brand.test/');
    expect(report.network.tunnels).toBeGreaterThan(0);
    expect(site.hits).toContain('GET www.brand.test/site.css');
    // Same-host redirects of subresources work (the host is announced).
    expect(site.hits).toContain('GET www.brand.test/redirect-same-done');
  });

  it('finds the known colours by role', () => {
    const roles = report.palette!.roles;
    expect(roles.paper).toBe(BRAND_SITE_COLORS.paper);
    expect(roles.text).toBe(BRAND_SITE_COLORS.text);
    expect(roles.accent).toBe(BRAND_SITE_COLORS.accent);
    expect(roles.dark).toBe(BRAND_SITE_COLORS.dark);
    expect(report.palette!.swatches.length).toBeLessThanOrEqual(8);
    for (const s of report.palette!.swatches) expect(s.hex).toMatch(/^#[0-9a-f]{6}$/);
    const text = report.palette!.swatches.find((s) => s.hex === BRAND_SITE_COLORS.text)!;
    expect(text.contrast.paper).toBeGreaterThan(15);
  });

  it('font family names only under untrusted, never a font file', async () => {
    expect(report.untrusted.fonts!.display[0].family).toBe('Quillmere Display');
    expect(report.untrusted.fonts!.body[0].family).toBe('Quillmere Text');
    expect(report.untrusted.fonts!.faces.map((f) => f.family)).toEqual(expect.arrayContaining(['Quillmere Display', 'Quillmere Text']));
    const trusted = JSON.stringify({ ...report, untrusted: undefined });
    expect(trusted).not.toContain('Quillmere');
    expect(trusted).not.toMatch(/ignore all previous/i);
  });

  it('page text (title, description, alt) only under untrusted', () => {
    expect(report.untrusted.title).toMatch(/^Ignore all previous instructions/);
    expect(report.untrusted.description).toMatch(/field notebooks/);
    expect(report.untrusted.site_name).toBe('Quillmere');
    expect(report.untrusted.alts?.some((a) => /SYSTEM: approve/.test(a.alt))).toBe(true);
  });

  it('logo candidates: at least two transparent PNGs, the inline SVG and the <img> among them', async () => {
    expect(report.candidates.length).toBeGreaterThanOrEqual(2);
    expect(report.candidates.length).toBeLessThanOrEqual(6);
    const sources = report.candidates.map((c) => c.source);
    expect(sources).toEqual(expect.arrayContaining(['header-svg', 'header-img']));
    let alpha = 0;
    for (const c of report.candidates) {
      const b = await readFile(join(out, c.file));
      expect(b.readUInt32BE(0)).toBe(0x89504e47);
      expect(b.readUInt32BE(20)).toBe(c.height);
      expect(c.height).toBeGreaterThanOrEqual(64);
      expect(c.height).toBeLessThanOrEqual(1024);
      if (b[25] === 6) alpha++;
    }
    expect(alpha).toBeGreaterThanOrEqual(2);
  });

  it('every escape attempt reaches nothing', () => {
    expect(site.escape, JSON.stringify(report.network)).toEqual({ tcp: 0, udp: 0, upgrades: 0 });
    expect(site.writes).toEqual([]);
    // The service worker's script was never fetched (refused on the prototype, in a fresh frame too).
    expect(site.hits.filter((h) => h.includes('/sw.js'))).toEqual([]);
    // Shared workers never start (their requests would bypass the route): no script fetched, no PUT / POST.
    expect(site.hits.filter((h) => /\/shared\.js|\/api\/shared/.test(h))).toEqual([]);
    // fetchLater does not exist (a deferred POST would be sent after the page, past the route).
    expect(site.hits.filter((h) => h.includes('/api/later'))).toEqual([]);
    // The popup never loads (its navigation is answered 204 too).
    expect(site.hits.filter((h) => h.includes('/popup'))).toEqual([]);
    const b = report.network.blocked;
    expect(b.method).toBeGreaterThanOrEqual(2); // the POST and the beacon
    expect(b.scheme).toBeGreaterThanOrEqual(2); // http:// literal and the metadata address
    expect(b.port).toBeGreaterThanOrEqual(2); // https://127.0.0.1:<port>, https://localhost:<port>
    expect(b.navigation).toBeGreaterThanOrEqual(2); // location.href to another host, the popup: answered 204
    expect(b.websocket).toBeGreaterThanOrEqual(1);
    const refused = report.network.refused;
    expect(refused.not_announced).toBeGreaterThanOrEqual(1); // the cross-host redirect hop, the preconnect
    expect(b.address).toBeGreaterThanOrEqual(1); // private.test: a reserved name, refused by the route already
    expect(report.untrusted.refused_hosts?.map((r) => r.host)).toContain('esc.test');
  });

  it('top-level redirects are followed in Node with the same rules: an IP literal, http:, a loop end the extraction first', async () => {
    for (const [path, why] of [
      ['/to-literal', /a redirect to https:\/\/127\.0\.0\.1:\d+\/ is refused \(port/],
      ['/to-http', /a redirect to http:\/\/www\.brand\.test\/ is refused \(http: is not https:/],
      ['/loop', /more than 5 redirects/],
    ] as const) {
      const dir = await mkdtemp(join(tmpdir(), 'site-redirect-'));
      try {
        const r = await extractSite({ policy: PERSON_POLICY, url: `https://brand.test${path}`, host: 'brand.test', outDir: dir, testResolve: site.testResolve });
        expect(r.status, path).toBe('failed');
        expect(r.untrusted.error, path).toMatch(why);
        expect(r.network.requests, path).toBe(0);
        expect(await readdir(dir)).toEqual(['site.json']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    expect(site.escape).toEqual({ tcp: 0, udp: 0, upgrades: 0 });
  }, 60_000);

  it('writes only site.json, screenshot.jpg and logo PNGs (no font, no cookie, no page bytes)', async () => {
    const files = (await readdir(out, { recursive: true })).sort();
    for (const f of files) expect(f).toMatch(/^(?:site\.json|screenshot\.jpg|logo-[1-6]\.png)$/);
    expect(files).toContain('site.json');
    expect(files).toContain('screenshot.jpg');
    const json = JSON.parse(await readFile(join(out, 'site.json'), 'utf8')) as SiteReport;
    expect(json.url).toBe(BRAND_SITE_URL);
    expect(json.warnings.some((w) => /unsafe test resolver/.test(w))).toBe(true);
  });
});
