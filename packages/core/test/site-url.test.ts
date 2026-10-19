/**
 * L3.5 the URL a site extraction opens (R-MCP-12): https, the default port, no credentials, query or fragment, a short
 * path, a DNS name with a dot that is neither an IP literal (any notation) nor a reserved or local name; the
 * canonical href approved; the unsafe test resolver (its `.test` names only, loopback only); the site job's input.
 */
import { describe, expect, it } from 'vitest';
import { JOB_INPUT_VERSION, JOB_KINDS, SITE_ID_RE, SiteJobInputSchema, parseSiteUrl, siteApprovalFingerprint, siteThemeName, siteUrlProblem, unsafeTestResolve } from '../src/index.js';

const none = new Map<string, unknown>();

describe('parseSiteUrl', () => {
  it.each([
    ['http://brand.example.net/', /only https/],
    ['ftp://brand.example.net/', /only https/],
    ['https://brand.example.net:8443/', /default https port/],
    ['https://user@brand.example.net/', /user name or password/],
    ['https://user:pw@brand.example.net/', /user name or password/],
    ['https://brand.example.net/?q=1', /query string/],
    ['https://brand.example.net/?', /query string/],
    ['https://brand.example.net/#top', /fragment/],
    ['https://brand.example.net/#', /fragment/],
    [`https://brand.example.net/${'a'.repeat(201)}`, /path longer than 200/],
    [`https://brand.example.net/${'a'.repeat(400)}`, /longer than 300/],
    ['https://127.0.0.1/', /IP address/],
    ['https://2130706433/', /IP address/],
    ['https://0x7f.1/', /IP address/],
    ['https://017700000001/', /IP address/],
    ['https://127.1/', /IP address/],
    ['https://[::1]/', /IP address/],
    ['https://[::ffff:127.0.0.1]/', /IP address/],
    ['https://169.254.169.254/', /IP address/],
    ['https://intranet/', /no dot/],
    ['https://localhost/', /no dot|reserved/],
    ['https://localhost./', /no dot|reserved/],
    ['https://app.localhost/', /reserved or local name \(\.localhost\)/],
    ['https://printer.local/', /\.local\)/],
    ['https://db.internal/', /\.internal\)/],
    ['https://nas.lan/', /\.lan\)/],
    ['https://router.home.arpa/', /\.home\.arpa\)/],
    ['https://brand.test/', /\.test\)/],
    ['https://name.alt/', /\.alt\)/],
    ['https://hidden.onion/', /\.onion\)/],
    ['https://brand.invalid/', /\.invalid\)/],
    ['https://brand.example/', /\.example\)/],
    ['https://1.2.3.4.in-addr.arpa/', /\.arpa\)/],
    ['https://brand.example.net/a\\b', /backslash/],
    ['not a url', /not an absolute URL/],
    ['', /empty/],
  ])('%s is refused (%s)', (url, why) => {
    const r = parseSiteUrl(url, none);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problem).toMatch(why);
  });

  it('the canonical href: lower-case punycode host, no trailing dot, percent-encoded path; the Unicode host aside', () => {
    expect(parseSiteUrl('https://Brand.Example.NET./Our Story', none)).toEqual({
      ok: true,
      url: { href: 'https://brand.example.net/Our%20Story', host: 'brand.example.net', unicode_host: 'brand.example.net' },
    });
    expect(parseSiteUrl('https://brand.example.net:443', none)).toMatchObject({ ok: true, url: { href: 'https://brand.example.net/' } });
    const idn = parseSiteUrl('https://bücher.example.net/', none);
    expect(idn).toMatchObject({ ok: true, url: { host: 'xn--bcher-kva.example.net', unicode_host: 'bücher.example.net', href: 'https://xn--bcher-kva.example.net/' } });
    expect(siteUrlProblem('https://www.brand.example.net/en/', none)).toBeNull();
  });

  it('the fingerprint a human approves is sha256("site\\n" + href): another URL, another fingerprint', () => {
    expect(siteApprovalFingerprint('https://a.example.net/')).toMatch(/^[0-9a-f]{64}$/);
    expect(siteApprovalFingerprint('https://a.example.net/')).not.toBe(siteApprovalFingerprint('https://b.example.net/'));
  });

  it('a theme name from the host', () => {
    expect(siteThemeName('www.quillmere.example')).toBe('quillmere');
    expect(siteThemeName('brand.test')).toBe('brand');
    expect(siteThemeName('xn--bcher-kva.example')).toBe('bcher-kva');
  });
});

describe('the unsafe test resolver', () => {
  it('maps .test names to loopback ports only; anything else is ignored', () => {
    const { map, ignored } = unsafeTestResolve({
      DEMO_STUDIO_UNSAFE_TEST_RESOLVE: 'brand.test=127.0.0.1:4430, www.brand.test=[::1]:4431,evil.example.net=127.0.0.1:443,x.test=10.0.0.1:443,y.test=127.0.0.1:99999,z.test=127.0.0.1',
    });
    expect([...map]).toEqual([
      ['brand.test', { address: '127.0.0.1', port: 4430 }],
      ['www.brand.test', { address: '::1', port: 4431 }],
    ]);
    expect(ignored).toEqual(['evil.example.net=127.0.0.1:443', 'x.test=10.0.0.1:443', 'y.test=127.0.0.1:99999', 'z.test=127.0.0.1']);
    expect(unsafeTestResolve({}).map.size).toBe(0);
  });

  it('its names pass the reserved-suffix rule, and only them', () => {
    const test = new Map([['brand.test', 1]]);
    expect(siteUrlProblem('https://brand.test/', test)).toBeNull();
    expect(siteUrlProblem('https://other.test/', test)).toMatch(/reserved/);
    expect(siteUrlProblem('http://brand.test/', test)).toMatch(/only https/);
  });
});

describe('the site job input', () => {
  const ok = { version: JOB_INPUT_VERSION, kind: 'site', site_id: 's_01HZY3J8Q4M2V6P0R9T7W5X1ZB', url: 'https://brand.example.net/', submitted_by: 'mcp' };
  it('is a job kind with a checked id and URL', () => {
    expect(JOB_KINDS).toContain('site');
    expect(SITE_ID_RE.test(ok.site_id)).toBe(true);
    expect(SiteJobInputSchema.safeParse(ok).success).toBe(true);
    expect(SiteJobInputSchema.safeParse({ ...ok, site_id: '../../etc' }).success).toBe(false);
    expect(SiteJobInputSchema.safeParse({ ...ok, url: 'https://10.0.0.1/' }).success).toBe(false);
    expect(SiteJobInputSchema.safeParse({ ...ok, url: 'https://brand.example.net/?x=1' }).success).toBe(false);
    expect(SiteJobInputSchema.safeParse({ ...ok, project: 'demo' }).success).toBe(false);
  });
});
