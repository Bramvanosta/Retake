/**
 * The URLs a scenario opens (core agent-policy.ts): every scenario opens only http:, https: or exactly about:blank,
 * never with sign-in details in the URL — a validation error at the field — read as WHATWG URL parses it; work an agent
 * wrote, on a known environment, opens only that environment's own origins (agent trust).
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentTrustProblems, agentTrustProblemsAt, canonicalAddress, canonicalIp, canonicalOrigin, isPageOrigin, navigationProblem, pageOrigins, parseScenario, parseYaml, scenarioNavigationRefs } from '@retake/core';
import { loadProject, nodeFileFacts } from '@retake/core/io';
import type { LoadedProject, Scenario } from '@retake/core';
import { memoryFileFacts } from '@retake/core';

/** No disk: these checks are handed a project but look at no file (L7.34: a FileFacts is required beside a project). */
const NO_DISK = memoryFileFacts({});

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Each field a scenario opens a URL from: the scenario text with `URL` in it, and the path of the field. */
const FIELDS: Array<{ name: string; yaml: (u: string) => string; path: Array<string | number> }> = [
  {
    name: 'scene open',
    yaml: (u) => `video: x\nscenes:\n  - id: a\n    page: shop\n    open: ${u}\n    steps: [{hold: 1}]\n`,
    path: ['scenes', 0, 'open'],
  },
  {
    name: 'pages[].open',
    yaml: (u) => `video: x\nscenes:\n  - id: m\n    pages:\n      - {id: one, page: shop, open: ${u}}\n      - {id: two, page: console, open: /}\n    steps: [{hold: 1, on: one}]\n`,
    path: ['scenes', 0, 'pages', 0, 'open'],
  },
  {
    name: 'open step',
    yaml: (u) => `video: x\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - open: ${u}\n`,
    path: ['scenes', 0, 'steps', 0, 'open'],
  },
  {
    name: 'open step {url}',
    yaml: (u) => `video: x\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - open: {url: ${u}, page: shop}\n`,
    path: ['scenes', 0, 'steps', 0, 'open', 'url'],
  },
  {
    name: 'new_tab href',
    yaml: (u) => `video: x\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - new_tab: {href: ${u}, as: help}\n`,
    path: ['scenes', 0, 'steps', 0, 'new_tab', 'href'],
  },
];

const REFUSED: Array<[string, RegExp]> = [
  ['file:///etc/hosts', /opens a file: URL/],
  ['FILE:///etc/hosts', /opens a file: URL/],
  [' file:///etc/hosts', /opens a file: URL/],
  ['\tfile:///etc/hosts', /opens a file: URL/],
  ['view-source:file:///etc/hosts', /opens a view-source: URL/],
  ['chrome://version', /opens a chrome: URL/],
  ['data:text/html,<b>x</b>', /opens a data: URL/],
  ['javascript:alert(1)', /opens a javascript: URL/],
  ['java\tscript:alert(1)', /opens a javascript: URL/],
  ['blob:http://localhost:4402/x', /opens a blob: URL/],
  ['about:srcdoc', /opens about:srcdoc/],
  ['https://u:p@shop.example.test/x', /holds sign-in details/],
  ['http://someone@localhost:4402/x', /holds sign-in details/],
];

const ACCEPTED = ['/x', 'quotes/1', '?tab=2', 'about:blank', 'http://localhost:4402/x', 'https://elsewhere.example.test/', 'HTTP://LOCALHOST:4402/x'];

let fixture: LoadedProject | undefined;
const project = async (): Promise<LoadedProject> => (fixture ??= await loadProject('northfield-fixture', ROOT));
const errorsAt = (text: string, p: LoadedProject | undefined, path: Array<string | number>) =>
  parseScenario(text, p ? { files: NO_DISK, project: p } : {}).issues.filter((i) => i.severity === 'error' && JSON.stringify(i.path) === JSON.stringify(path));

describe('navigationProblem: the scheme rule', () => {
  it.each(REFUSED)('%j is refused, with what to write instead', (url, why) => {
    const p = navigationProblem(url);
    expect(p).toMatch(why);
    expect(p).toMatch(/write the http\(s\) URL of the page, or a path of an environment page|remove them \(a persona signs in/);
  });

  it.each(ACCEPTED)('%j is accepted (a path is resolved when it runs)', (url) => {
    expect(navigationProblem(url)).toBeNull();
  });

  it('a message never shows the sign-in details, and writes hidden characters out', () => {
    expect(navigationProblem('https://admin:s3cret@shop.example.test/x')).not.toMatch(/admin|s3cret/);
    expect(navigationProblem('//admin:s3cret@shop.example.test/x')).not.toMatch(/admin|s3cret/);
    expect(navigationProblem('file:///etc/\u202Ehosts')).toContain('\\u{202e}');
  });

  it('a scheme whose rest does not parse is refused, never left to the run; other text that is not a URL is not judged', () => {
    for (const u of ['http://exa mple.test/', 'https://[::1', 'file://%zz/x', ' FILE://a b/']) {
      expect(navigationProblem(u), u).toMatch(/is not a URL a browser can read .*write the http\(s\) URL of the page/);
    }
    expect(navigationProblem('https://u:p@exa mple.test/')).not.toMatch(/u:p/);
  });

  it('the article fits the scheme ("an app: URL", "a shp: URL")', () => {
    expect(navigationProblem('app:/x')).toMatch(/opens an app: URL/);
    expect(navigationProblem('shp:/x')).toMatch(/opens a shp: URL/);
  });

  it('only exactly about:blank: another about: page, or about:blank with more, is refused', () => {
    for (const u of ['about:blank#x', 'about:blank?x', 'about:BLANK', 'about:version']) expect(navigationProblem(u), u).not.toBeNull();
  });
});

describe('navigationProblem: the environment origins (agent work)', () => {
  const origins = ['http://localhost:4401', 'http://localhost:4402'];
  it('an absolute URL has the exact origin of an environment page: another port of localhost or another host is refused', () => {
    expect(navigationProblem('http://localhost:4402/x', { origins })).toBeNull();
    expect(navigationProblem('HTTP://LocalHost:4402/x', { origins })).toBeNull();
    expect(navigationProblem('about:blank', { origins })).toBeNull();
    expect(navigationProblem('/x', { origins })).toBeNull();
    for (const u of ['http://localhost:4403/x', 'https://localhost:4402/x', 'http://127.0.0.1:4402/x', 'https://elsewhere.example.test/']) {
      const p = navigationProblem(u, { origins, envName: 'local', via: 'studio' });
      expect(p, u).toContain("not an origin of environment local's pages (http://localhost:4401, http://localhost:4402)");
      expect(p, u).toContain('from the Studio a scenario opens only its environment');
      expect(p, u).toContain('add its origin as a page of environment local in project.yaml');
    }
  });

  it('a host without a scheme (`//host`, `\\\\host`) is refused; without origins it is not judged', () => {
    for (const u of ['//elsewhere.example.test/x', '\\\\elsewhere.example.test/x', '/\\elsewhere.example.test/x']) {
      expect(navigationProblem(u, { origins }), u).toContain('names a host without a scheme');
      expect(navigationProblem(u), u).toBeNull();
    }
  });

  it('canonicalOrigin is the one comparison: case, default port, other schemes', () => {
    expect(canonicalOrigin('HTTP://LocalHost:80/x')).toBe('http://localhost');
    expect(canonicalOrigin(' https://shop.example.test:443/a')).toBe('https://shop.example.test');
    expect(canonicalOrigin('file:///etc/hosts')).toBeNull();
    expect(canonicalOrigin('not a url')).toBeNull();
    expect(pageOrigins({ a: 'http://localhost:4401/app', b: 'HTTP://localhost:4401', c: 'file:///x' })).toEqual(['http://localhost:4401']);
    expect(isPageOrigin(' http://LOCALHOST:4401/x', { a: 'http://localhost:4401' })).toBe(true);
    expect(isPageOrigin('http://localhost:4402/x', { a: 'http://localhost:4401' })).toBe(false);
  });

  it('canonicalIp / canonicalAddress: the server a URL reaches — an IPv4-mapped IPv6 address is its IPv4 form; origins unchanged', () => {
    for (const h of ['[::ffff:127.0.0.1]', '::ffff:7f00:1', '[0:0:0:0:0:ffff:7f00:1]', '127.1', '0x7f000001', '127.0.0.1']) expect(canonicalIp(h), h).toBe('127.0.0.1');
    expect(canonicalIp('[::ffff:203.0.113.7]')).toBe('203.0.113.7');
    expect(canonicalIp('[0:0:0:0:0:0:0:0]')).toBe('::');
    expect(canonicalIp('2001:DB8:0::7')).toBe('2001:db8::7');
    for (const h of ['shop.example.test', 'localhost', '1.2.3.4.example', '', 'a b', 'x/y']) expect(canonicalIp(h), h).toBeNull();
    expect(canonicalAddress('http://[::ffff:7f00:1]:4999/app')).toEqual({ host: '127.0.0.1', port: '4999', ip: true });
    expect(canonicalAddress('HTTPS://Shop.Example.Test./x')).toEqual({ host: 'shop.example.test', port: '443', ip: false });
    expect(canonicalAddress('http://[::]/')).toEqual({ host: '::', port: '80', ip: true });
    expect(canonicalAddress('file:///etc/hosts')).toBeNull();
    // A browser still counts the mapped form as another origin.
    expect(canonicalOrigin('http://[::ffff:127.0.0.1]:4999')).toBe('http://[::ffff:7f00:1]:4999');
  });
});

describe('scenarioNavigationRefs', () => {
  it('lists every URL a scenario opens, with its path; skipped scenes included, cards and other steps not', () => {
    const scenario = parseYaml(
      [
        'video: x',
        'scenes:',
        '  - {card: {slots: {url: "https://cta.example.test"}}}',
        '  - id: a',
        '    page: shop',
        '    open: /a',
        '    skip: true',
        '    steps:',
        '      - open: /b',
        '      - open: {url: /c}',
        '      - new_tab: {href: /d}',
        '      - new_tab: /e',
        '      - new_tab: Help',
        '      - wait_for: {url: /f}',
        '  - id: m',
        '    pages: {one: {page: shop, open: "shop:/g"}, two: {page: console}}',
        '    steps: [{hold: 1, on: one}]',
        '',
      ].join('\n'),
    ).value;
    expect(scenarioNavigationRefs(scenario).map((r) => [r.path.join('.'), r.url, r.pagePrefix])).toEqual([
      ['scenes.1.open', '/a', false],
      ['scenes.1.steps.0.open', '/b', false],
      ['scenes.1.steps.1.open.url', '/c', false],
      ['scenes.1.steps.2.new_tab.href', '/d', false],
      ['scenes.1.steps.3.new_tab', '/e', false],
      ['scenes.2.pages.one.open', 'shop:/g', true],
    ]);
  });
});

describe('validation: every scenario', () => {
  for (const f of FIELDS) {
    it.each(REFUSED)(`${f.name}: %j is an error at the field`, async (url, why) => {
      const errors = errorsAt(f.yaml(JSON.stringify(url)), await project(), f.path);
      expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(why)]);
    });

    it(`${f.name}: paths, about:blank and http(s) URLs on any host are valid (the origin rule is agent trust's)`, async () => {
      for (const url of ACCEPTED) expect(errorsAt(f.yaml(JSON.stringify(url)), await project(), f.path), url).toEqual([]);
    });
  }

  it('without a project too: the scheme rule needs no environment', () => {
    expect(errorsAt(FIELDS[0].yaml('"file:///etc/hosts"'), undefined, FIELDS[0].path)).toHaveLength(1);
    expect(errorsAt(FIELDS[4].yaml('" javascript:alert(1)"'), undefined, FIELDS[4].path)).toHaveLength(1);
  });

  it('a multi-page `<page>:/path` names a page; another prefix is refused, with the pages to choose from', async () => {
    const f = FIELDS[1];
    expect(errorsAt(f.yaml('"shop:/quotes"'), await project(), f.path)).toEqual([]);
    expect(errorsAt(f.yaml('"shp:/quotes"'), await project(), f.path).map((e) => e.message)).toEqual([
      expect.stringMatching(/opens a shp: URL.*"shp:" is not a page of environment "local" either \(did you mean "shop"\?\) \(available: console, shop\)/),
    ]);
  });

  it('a `<page>:` prefix that names no page is refused even when it would open nothing a browser reads (`admin_consol:/x`)', async () => {
    const f = FIELDS[1];
    for (const u of ['"shop_x:/quotes"', '"_shop:/quotes"']) {
      expect(errorsAt(f.yaml(u), await project(), f.path).map((e) => e.message), u).toEqual([
        expect.stringMatching(/: "_?shop_?x?:" is not a page of environment "local".*\(available: console, shop\) — write `<page>:\/path` with a page of the environment/),
      ]);
    }
  });

  it('without an environment, a `<page>:` prefix may name a page — but never file:, data:, javascript:, blob:, view-source: or chrome:', () => {
    const f = FIELDS[1];
    for (const u of ['file:///etc/hosts', 'data:text/html,x', 'javascript:alert(1)', 'blob:http://localhost:4402/x', 'view-source:http://localhost:4402/', 'chrome://version']) {
      expect(errorsAt(f.yaml(JSON.stringify(u)), undefined, f.path), u).toHaveLength(1);
    }
    for (const u of ['shop:/quotes', 'admin:/x']) expect(errorsAt(f.yaml(JSON.stringify(u)), undefined, f.path), u).toEqual([]);
  });

  it('templated text is judged when it runs', async () => {
    for (const f of FIELDS) expect(errorsAt(f.yaml('"{{vars.u}}"').replace('video: x', 'video: x\nvars: {u: "file:///etc/hosts"}'), await project(), f.path), f.name).toEqual([]);
  });
});

describe('agent trust: the environment origins', () => {
  const env = { name: 'local', pages: { console: 'http://localhost:4401', shop: 'http://localhost:4402' } };
  const sc = (text: string): Scenario => parseScenario(text).scenario as Scenario;

  for (const f of FIELDS) {
    it(`${f.name}: another origin is refused when the environment is known, never at a save (no environment)`, async () => {
      const p = await project();
      for (const url of ['http://localhost:4403/x', 'https://elsewhere.example.test/']) {
        const s = sc(f.yaml(JSON.stringify(url)));
        expect(agentTrustProblems(p, s, { files: nodeFileFacts, env }), url).toEqual([expect.stringMatching(new RegExp(`^${f.path.map((k) => (typeof k === 'number' ? `\\[${k}\\]` : `\\.?${k}`)).join('')}: .* is on .*add its origin as a page of environment local in project\\.yaml`))]);
        expect(agentTrustProblems(p, s, { files: nodeFileFacts }), url).toEqual([]);
      }
      for (const url of ['http://localhost:4402/x', 'http://LOCALHOST:4401/', '/x', 'about:blank', '{{vars.u}}']) {
        expect(agentTrustProblems(p, sc(f.yaml(JSON.stringify(url))), { files: nodeFileFacts, env }), url).toEqual([]);
      }
    });
  }

  it('a multi-page `<page>:/path` is a page of the environment; `//host` is refused', async () => {
    const p = await project();
    expect(agentTrustProblems(p, sc(FIELDS[1].yaml('"shop:/x"')), { files: nodeFileFacts, env })).toEqual([]);
    expect(agentTrustProblems(p, sc(FIELDS[4].yaml('"//elsewhere.example.test/x"')), { files: nodeFileFacts, env })).toEqual([expect.stringContaining('names a host without a scheme')]);
  });

  it('agentTrustProblemsAt places each refused URL at its line, worded for the channel', async () => {
    const text = ['video: x', 'scenes:', '  - id: a', '    page: shop', '    open: /', '    steps:', '      - click: Go', '      - open: "http://localhost:4499/admin"', ''].join('\n');
    const at = agentTrustProblemsAt(await project(), sc(text), text, { files: nodeFileFacts, via: 'studio', env });
    expect(at.map((p) => [p.line, p.path.join('.')])).toEqual([[8, 'scenes.0.steps.1.open']]);
    expect(at[0].message).toContain('from the Studio a scenario opens only');
    expect(agentTrustProblemsAt(await project(), sc(text), text, { files: nodeFileFacts, via: 'studio' })).toEqual([]);
  });
});
