/**
 * L1.7 data side: the two forms of an environment (display URLs, production, access, read_only), the access of a run,
 * display URL mapping, request patterns and the write classifier, the clock, and which hooks write.
 */
import { describe, expect, it } from 'vitest';
import {
  AccessError,
  ClockError,
  RunRecordSchema,
  TimelineSchema,
  applyProjectDefaults,
  classifyRequest,
  clockError,
  compileWritePolicy,
  crossEnvironmentHosts,
  describeWriteRequest,
  displayError,
  displayRows,
  displayTable,
  displayUrl,
  editDisplayTable,
  environmentAccess,
  environmentHttpCredentials,
  findLocalUrls,
  formatIssues,
  graphqlOf,
  guardsWrites,
  hookWriteReason,
  hostPatternError,
  httpWriteReason,
  isLocalHost,
  isLocalUrl,
  isWriteRefusedError,
  matchRequestPattern,
  normalizeDisplay,
  parseProjectYaml,
  parseRequestPattern,
  parseScenario,
  protectedBy,
  protectedHostMessage,
  rawEnvironmentPages,
  readmeEnvironmentsDrift,
  readmeEnvironmentLine,
  readmeSkeleton,
  requestPatternError,
  resolveClock,
  resolveEnvironment,
  resolveRunAccess,
  rollbackWriteReason,
  runAccess,
  shownText,
  shownUrl,
  sqlWriteStatement,
  WriteRefusedError,
  withoutCredentials,
  writingHooks,
  zodIssues,
} from '@retake/core';
import type { HookStep, LoadedProject, ValidationIssue } from '@retake/core';
import { errors, lineOf, tempDir, warnings, writeFiles } from './helpers.js';
import { fileFacts, nodeFileFacts } from '@retake/core/io';
import { PERSON_POLICY } from '@retake/core';

const msgs = (issues: ValidationIssue[]) => issues.map((i) => `${i.severity} ${i.line}:${i.col} ${i.path.join('.')}: ${i.message}`);

const PROJECT = `name: Northfield
environments:
  local:
    console: http://localhost:4401
    shop: {url: http://localhost:4402, display: shop.northfield.example}
  production:
    production: true
    pages:
      console: {url: https://console.example.com, display: "https://console.example.com/"}
      shop: https://shop.example.com/store
    read_only:
      hosts: [api.example.com, "*.cdn.example.net"]
      allow:
        - POST console:/api/session/refresh
        - {request: "POST shop:/graphql", operation: SearchProducts}
      mocks:
        - {request: "POST shop:/api/track", status: 204}
  live:
    production: true
    access: read-write
    pages: {shop: https://live.example.com}
`;

function project(text = PROJECT): LoadedProject {
  const { config, issues } = parseProjectYaml(text);
  expect(config, formatIssues(issues)).toBeDefined();
  return { slug: 'northfield', dir: '/nonexistent/northfield', root: '/nonexistent', file: '/nonexistent/northfield/project.yaml', readme: null, scenarios: [], config: config! };
}

describe('project.yaml environments: short form, long form, display URLs (R-ENV-01/02)', () => {
  it('normalises both forms: environments keeps the real URLs, environment_settings the rest', () => {
    const { config, issues } = parseProjectYaml(PROJECT);
    expect(issues, formatIssues(issues)).toEqual([]);
    expect(config!.environments).toEqual({
      local: { console: 'http://localhost:4401', shop: 'http://localhost:4402' },
      production: { console: 'https://console.example.com', shop: 'https://shop.example.com/store' },
      live: { shop: 'https://live.example.com' },
    });
    expect(config!.environment_settings).toEqual({
      local: { display: { shop: 'https://shop.northfield.example' } },
      production: {
        production: true,
        display: { console: 'https://console.example.com' },
        read_only: {
          hosts: ['api.example.com', '*.cdn.example.net'],
          allow: ['POST console:/api/session/refresh', { request: 'POST shop:/graphql', operation: 'SearchProducts' }],
          mocks: [{ request: 'POST shop:/api/track', status: 204 }],
        },
      },
      live: { production: true, access: 'read-write' },
    });
  });

  it('a short-form project has no environment_settings (configs as before L1.7)', () => {
    const { config } = parseProjectYaml('name: x\nenvironments:\n  local: {console: http://localhost:4401}\n');
    expect(config).toBeDefined();
    expect(Object.keys(config!)).not.toContain('environment_settings');
    expect(resolveEnvironment({ config: config! })).toEqual({ name: 'local', pages: { console: 'http://localhost:4401' } });
  });

  it('resolveEnvironment carries display, production, access and read_only; environmentAccess defaults', () => {
    const p = project();
    const prod = resolveEnvironment(p, 'production');
    expect(prod).toMatchObject({ name: 'production', production: true, display: { console: 'https://console.example.com' } });
    expect(prod.access).toBeUndefined();
    expect(environmentAccess(prod)).toBe('read-only');
    expect(environmentAccess(resolveEnvironment(p, 'local'))).toBe('read-write');
    expect(environmentAccess(resolveEnvironment(p, 'live'))).toBe('read-write');
    expect(environmentAccess({ access: 'read-only' })).toBe('read-only');
  });

  it('rawEnvironmentPages reads both forms of a raw value', () => {
    expect(rawEnvironmentPages({ a: { x: 'http://a', y: { url: 'http://b', display: 'b.example' } }, b: { production: true, pages: { z: 'http://c' } } })).toEqual({
      a: { x: 'http://a', y: 'http://b' },
      b: { z: 'http://c' },
    });
  });

  it.each([
    ['settings in the short form get a targeted message', 'name: x\nenvironments:\n  prod:\n    production: true\n    shop: https://shop.example.com\n', 'error 4:5 environments.prod.production: "production" is a setting of environment prod, not a page: settings go with the long form'],
    ['a typo in the long form is suggested', 'name: x\nenvironments:\n  prod:\n    production: true\n    acess: read-only\n    pages: {shop: https://shop.example.com}\n', 'environments.prod: unknown key "acess" (did you mean "access"?)'],
    ['a bad access value', 'name: x\nenvironments:\n  prod:\n    access: readonly\n    pages: {shop: https://shop.example.com}\n', 'environments.prod.access: expected one of "read-only", "read-write", got "readonly" (did you mean "read-only"?)'],
    ['a bad URL in the long form', 'name: x\nenvironments:\n  prod:\n    pages: {shop: shop.example.com}\n', 'environments.prod.pages.shop: expected an absolute http(s) URL'],
    ['a bad URL in the short form', 'name: x\nenvironments:\n  local:\n    console: localhost:4401\n', 'error 4:14 environments.local.console: expected an absolute http(s) URL'],
    ['an environment that is not a mapping', 'name: x\nenvironments:\n  stg: https://x.example.com\n', 'environments.stg: expected an environment mapping'],
    ['a display with a query', 'name: x\nenvironments:\n  local:\n    shop: {url: http://localhost:4402, display: "shop.example.com/?x=1"}\n', 'environments.local.shop.display: display is a base URL: no query'],
    ['a templated display', 'name: x\nenvironments:\n  local:\n    shop: {url: http://localhost:4402, display: "{{vars.host}}"}\n', 'display is shown as written: no {{…}}'],
    ['a GET allow entry', 'name: x\nenvironments:\n  prod:\n    production: true\n    pages: {shop: https://shop.example.com}\n    read_only: {allow: ["GET shop:/x"]}\n', 'environments.prod.read_only.allow.0: GET requests are never stopped'],
    ['an unknown page in a pattern', 'name: x\nenvironments:\n  prod:\n    production: true\n    pages: {shop: https://shop.example.com}\n    read_only: {mocks: [{request: "POST cart:/x"}]}\n', 'environments.prod.read_only.mocks.0.request: unknown page "cart" in the request pattern (environment prod has: shop)'],
    ['a mock with json and body, templated', 'name: x\nenvironments:\n  prod:\n    production: true\n    pages: {shop: https://shop.example.com}\n    read_only:\n      mocks: [{request: "POST /x", json: {a: "{{vars.x}}"}, body: "y"}]\n', 'a mock answers with `json` or `body`, not both'],
    ['a mock status out of range', 'name: x\nenvironments:\n  prod:\n    production: true\n    pages: {shop: https://shop.example.com}\n    read_only: {mocks: [{request: "POST /x", status: 150}]}\n', 'environments.prod.read_only.mocks.0.status: must be ≥ 200'],
  ])('%s', (_name, text, expected) => {
    const { config, issues } = parseProjectYaml(text);
    expect(config).toBeUndefined();
    expect(msgs(errors(issues)).join('\n')).toContain(expected);
    // A broken environments block does not also say "no environments yet".
    expect(msgs(warnings(issues)).join('\n')).not.toContain('no environments yet');
  });

  it('a short-form page key named access or production stays a page (C8)', () => {
    const { config, issues } = parseProjectYaml('name: x\nenvironments:\n  prod:\n    access: https://access.example.com\n    production: https://prod.example.com\n');
    expect(issues).toEqual([]);
    expect(config!.environments.prod).toEqual({ access: 'https://access.example.com', production: 'https://prod.example.com' });
  });

  it('read_only on an environment that is never read-only is a warning', () => {
    const text = 'name: x\nenvironments:\n  stg:\n    pages: {shop: https://shop.example.com}\n    read_only: {hosts: [a.example.com]}\n';
    const { config, issues } = parseProjectYaml(text);
    expect(config).toBeDefined();
    expect(msgs(issues)).toEqual([expect.stringContaining(`warning ${lineOf(text, 'read_only')}:5 environments.stg.read_only: read_only applies only to read-only runs`)]);
  });

  it('personas name pages of a long-form environment (auth checks read both forms)', () => {
    const text = `name: x
environments:
  prod:
    production: true
    pages: {shop: https://shop.example.com, console: {url: https://console.example.com, display: console.example.com}}
auth:
  personas:
    buyer: {pages: [shop], check: {url: "shop:/account", expect_text: Account}}
    supplier: {pages: [console], check: {url: "console:/", expect_text: Dashboard}}
`;
    const { config, issues } = parseProjectYaml(text);
    expect(issues, formatIssues(issues)).toEqual([]);
    expect(config!.environments.prod.console).toBe('https://console.example.com');
  });

  it('readmeEnvironmentsDrift: pages the section does not mention, skeleton lines that are gone; a hand-written section that names every URL is fine', () => {
    const pages = [
      { env: 'local', page: 'shop', url: 'http://localhost:4402', display: 'https://shop.northfield.example' },
      { env: 'stg', page: 'shop', url: 'https://shop.stg.example.com/' },
    ];
    const made = readmeSkeleton('N', { local: { shop: 'http://localhost:4402' }, old: { shop: 'https://old.example.com' } });
    expect(readmeEnvironmentsDrift(made, pages)).toEqual({ missing: ['- stg · shop: https://shop.stg.example.com/'], gone: ['- old · shop: https://old.example.com'] });
    const byHand = '# N\n\n## Environments & links\n\nLocal is http://localhost:4402, staging https://shop.stg.example.com (ask for access).\n\n## Accounts\n\n- old · shop: x\n';
    expect(readmeEnvironmentsDrift(byHand, pages)).toBeNull();
    expect(readmeEnvironmentsDrift('# N\n\nNo such section.\n', pages)).toBeNull();
  });

  it('hotfix v0.2.6 (field point 26): lines a person writes — the name in bold or code, a note in parentheses, several pages on a line, a description after the URLs — are read by environment and page', () => {
    const pages = [
      { env: 'local', page: 'shop', url: 'http://localhost:4402' },
      { env: 'local', page: 'console', url: 'http://localhost:4401' },
      { env: 'stg', page: 'shop', url: 'https://shop.stg.example.com' },
      { env: 'stg', page: 'console', url: 'https://console.stg.example.com' },
      { env: 'sandbox', page: 'shop', url: 'http://localhost:4602' },
    ];
    const readme = [
      '# N',
      '',
      '## Environments & links',
      '',
      '- **local** (default) · shop: http://localhost:4402 · console: http://localhost:4401 : the dev servers',
      '- **stg** · shop: <https://shop.stg.example.com> · console: https://console.stg.example.com : staging,',
      '  refreshed every night',
      '- `sandbox` · shop: http://localhost:4602',
      '- **old** · shop: https://old.example.com : retired',
      '- **stg** · admin: https://admin.stg.example.com',
      '',
    ].join('\n');
    expect(readmeEnvironmentsDrift(readme, pages)).toEqual({ missing: [], gone: ['- **old** · shop: https://old.example.com : retired', '- **stg** · admin: https://admin.stg.example.com'] });
    expect(readmeEnvironmentLine('- **local** (default) · shop: http://localhost:4402 · console: http://localhost:4401')).toEqual({ env: 'local', pages: ['shop', 'console'] });
    expect(readmeEnvironmentLine('  refreshed every night')).toBeNull();
  });

  it('readmeSkeleton lists the display URL a page is shown as', () => {
    const p = project();
    expect(readmeSkeleton('N', p.config.environments, p.config.environment_settings)).toContain('- local · shop: http://localhost:4402 (shown as https://shop.northfield.example)');
  });
});

describe('sign-in details in an environment page URL: HTTP credentials for that origin, never in the URL', () => {
  const yaml = (pages: string) => `name: Northfield\nenvironments:\n  staging:\n${pages}`;
  it('resolveEnvironment gives the pages without them; environmentHttpCredentials gives them, decoded, with the origin', () => {
    const { config, issues } = parseProjectYaml(yaml('    app: "https://demo:s%40cret@app.staging.example.test/base"\n    api: "https://app.staging.example.test/api"\n    shop: "http://localhost:4402"\n'));
    expect(errors(issues)).toEqual([]);
    const p = { config: config! };
    const env = resolveEnvironment(p, 'staging');
    expect(env.pages).toEqual({ app: 'https://app.staging.example.test/base', api: 'https://app.staging.example.test/api', shop: 'http://localhost:4402' });
    expect(JSON.stringify(env)).not.toMatch(/demo|s%40cret|s@cret/);
    expect(environmentHttpCredentials(p, 'staging')).toEqual({ credentials: { origin: 'https://app.staging.example.test', username: 'demo', password: 's@cret' } });
    expect(environmentHttpCredentials(p, 'nowhere')).toEqual({});
  });

  it('withoutCredentials keeps the rest of the URL as written; other URLs as they are', () => {
    expect(withoutCredentials('http://u:p@localhost:4402')).toEqual({ url: 'http://localhost:4402', credentials: { origin: 'http://localhost:4402', username: 'u', password: 'p' } });
    expect(withoutCredentials('https://only-user@x.example.test/a?b#c').url).toBe('https://x.example.test/a?b#c');
    expect(withoutCredentials('https://a:b@c@x.example.test/').credentials).toEqual({ origin: 'https://x.example.test', username: 'a', password: 'b@c' });
    expect(withoutCredentials('https://x.example.test/a@b')).toEqual({ url: 'https://x.example.test/a@b' });
    expect(withoutCredentials('not a url')).toEqual({ url: 'not a url' });
  });

  it('one origin at most, with one set of details: anything else is an error at the environment, and refused at run', () => {
    const two = parseProjectYaml(yaml('    app: "https://a:1@app.example.test"\n    shop: "https://b:2@shop.example.test"\n'));
    expect(msgs(two.issues).filter((m) => m.startsWith('error'))).toEqual([expect.stringMatching(/environments\.staging: environment staging has sign-in details .* page URLs of 2 origins \(https:\/\/app\.example\.test, https:\/\/shop\.example\.test\)/)]);
    expect(msgs(two.issues).join('\n')).not.toMatch(/a:1|b:2/);
    const differ = parseProjectYaml(yaml('    app: "https://a:1@app.example.test/x"\n    admin: "https://a:2@app.example.test/admin"\n'));
    expect(msgs(differ.issues).filter((m) => m.startsWith('error'))).toEqual([expect.stringMatching(/gives https:\/\/app\.example\.test two different sign-in details/)]);
    const same = parseProjectYaml(yaml('    app: "https://a:1@app.example.test/x"\n    admin: "https://a:1@app.example.test/admin"\n'));
    expect(errors(same.issues)).toEqual([]);
    expect(environmentHttpCredentials({ config: same.config! }, 'staging').credentials?.origin).toBe('https://app.example.test');
  });
});

describe('access of a run (R-ENV-02/04)', () => {
  const env = (production?: boolean, access?: 'read-only' | 'read-write') => ({ name: 'e', ...(production !== undefined ? { production } : {}), ...(access ? { access } : {}) });

  it.each([
    ['not production, default', env(), false, 'read-write', false],
    ['not production, default, --allow-writes (no-op)', env(), true, 'read-write', false],
    ['not production, access: read-only', env(false, 'read-only'), false, 'read-only', false],
    ['production (read-only by default)', env(true), false, 'read-only', false],
    ['production, access: read-write, no flag', env(true, 'read-write'), false, 'read-only', false],
    ['production, access: read-write, --allow-writes', env(true, 'read-write'), true, 'read-write', true],
  ] as const)('%s', (_name, e, allowWrites, mode, allowed) => {
    const a = resolveRunAccess(e, { allowWrites });
    expect(a.mode).toBe(mode);
    expect(a.allow_writes).toBe(allowed);
  });

  it('production that allows writes: a notice without the flag, a warning with it', () => {
    expect(resolveRunAccess(env(true, 'read-write')).notice).toMatch(/this run is read-only: pass --allow-writes to write/);
    expect(resolveRunAccess(env(true, 'read-write'), { allowWrites: true }).warning).toBe('writes go to production: environment e runs read-write (--allow-writes)');
    expect(resolveRunAccess(env(true)).notice).toBeUndefined();
  });

  it('--allow-writes on a read-only environment is refused (it confirms writes, never grants them)', () => {
    expect(() => resolveRunAccess(env(true), { allowWrites: true })).toThrow(AccessError);
    expect(() => resolveRunAccess(env(true), { allowWrites: true })).toThrow(/environment e is read-only in project.yaml \(production: true\): --allow-writes only confirms/);
    expect(() => resolveRunAccess(env(false, 'read-only'), { allowWrites: true })).toThrow(/\(access: read-only\)/);
    // runAccess never throws: a journal replay judges each entry by its own environment.
    expect(runAccess(env(true), true)).toMatchObject({ mode: 'read-only', allow_writes: false });
  });
});

describe('display URLs (R-ENV-01)', () => {
  it('validates and normalises display values', () => {
    expect(displayError('shop.example.com')).toBeNull();
    expect(displayError('https://shop.example.com/app/')).toBeNull();
    expect(displayError('shop.example.com:8443/x')).toBeNull();
    expect(displayError('ftp://x.example.com')).toMatch(/http\(s\) URL or a host/);
    expect(displayError('user@shop.example.com')).toMatch(/credentials/);
    expect(displayError('/just/a/path')).toMatch(/does not start with a host/);
    // A local display would put the local host in the video; a port out of range is no URL (V6).
    for (const local of ['localhost:4402', 'http://127.0.0.1', 'shop.localhost', 'devbox', 'app.test', 'nas.lan', '[::1]:3000', '100.64.1.2']) {
      expect(displayError(local), local).toMatch(/is a local host/);
    }
    expect(displayError('shop.example.com:99999')).toMatch(/is not a valid URL/);
    expect(normalizeDisplay('Shop.Example.com')).toBe('https://shop.example.com');
    expect(normalizeDisplay('https://shop.example.com/app/')).toBe('https://shop.example.com/app');
    expect(normalizeDisplay('http://shop.example.com:8080')).toBe('http://shop.example.com:8080');
  });

  const table = displayTable({
    pages: { shop: 'http://localhost:4402', admin: 'http://localhost:4402/admin/', console: 'http://localhost:4401', api: 'http://localhost:4403' },
    display: { shop: 'shop.northfield.example', admin: 'admin.northfield.example/panel', console: 'console.northfield.example' },
  });

  it('builds the table of the pages that declare one', () => {
    expect(table).toEqual([
      { page: 'shop', url: 'http://localhost:4402', display: 'https://shop.northfield.example' },
      { page: 'admin', url: 'http://localhost:4402/admin', display: 'https://admin.northfield.example/panel' },
      { page: 'console', url: 'http://localhost:4401', display: 'https://console.northfield.example' },
    ]);
  });

  it.each([
    ['http://localhost:4402/', 'https://shop.northfield.example/'],
    ['http://localhost:4402/products/selowa?x=1#top', 'https://shop.northfield.example/products/selowa?x=1#top'],
    ['http://localhost:4402/admin', 'https://admin.northfield.example/panel'],
    ['http://localhost:4402/admin/users', 'https://admin.northfield.example/panel/users'],
    ['http://localhost:4402/administrator', 'https://shop.northfield.example/administrator'],
    ['http://localhost:4401/imports', 'https://console.northfield.example/imports'],
    ['http://localhost:4403/x', 'http://localhost:4403/x'],
    ['https://www.example.org/', 'https://www.example.org/'],
    ['not a url', 'not a url'],
  ])('%s → %s', (url, shown) => {
    expect(displayUrl(url, table)).toBe(shown);
  });

  it('blob: and filesystem: URLs map the URL they wrap; file: URLs are local; other schemes are never mapped (V1)', () => {
    expect(displayUrl('blob:http://localhost:4402/7f1c-uuid', table)).toBe('blob:https://shop.northfield.example/7f1c-uuid');
    expect(displayUrl('filesystem:http://localhost:4401/temporary/a.png', table)).toBe('filesystem:https://console.northfield.example/temporary/a.png');
    expect(displayUrl('file:///home/someone/report.pdf', table)).toBe('file:///home/someone/report.pdf');
    expect(displayUrl('mailto:sales@localhost', table)).toBe('mailto:sales@localhost');
    expect(isLocalUrl('blob:http://localhost:4403/x')).toBe(true);
    expect(isLocalUrl('blob:https://shop.example.com/x')).toBe(false);
    expect(isLocalUrl('filesystem:http://127.0.0.1:3000/temporary/x')).toBe(true);
    expect(isLocalUrl('file:///home/someone/report.pdf')).toBe(true);
    expect(isLocalUrl('about:blank')).toBe(false);
    expect(isLocalUrl('data:text/plain,hello')).toBe(false);
  });

  it('a page without a display URL claims its URLs: they stay as they are (hidden when local); the origin fallback only takes URLs no page claims (V7)', () => {
    const rows = displayRows({ pages: { shop: 'http://localhost:4402', admin: 'http://localhost:4402/admin' }, display: { shop: 'shop.northfield.example' } });
    expect(rows).toEqual([{ page: 'shop', url: 'http://localhost:4402', display: 'https://shop.northfield.example' }, { page: 'admin', url: 'http://localhost:4402/admin' }]);
    expect(displayUrl('http://localhost:4402/admin/users', rows)).toBe('http://localhost:4402/admin/users');
    expect(displayUrl('http://localhost:4402/basket', rows)).toBe('https://shop.northfield.example/basket');
    // Two pages on one origin, the one at "/" without a display URL: a URL under neither base stays unchanged.
    const split = displayRows({ pages: { root: 'http://localhost:3000', app: 'http://localhost:3000/app' }, display: { app: 'app.example.com/app' } });
    expect(displayUrl('http://localhost:3000/other', split)).toBe('http://localhost:3000/other');
    expect(displayUrl('http://localhost:3000/app/x', split)).toBe('https://app.example.com/app/x');
    // displayTable keeps the rows that declare one (what a run records).
    expect(displayTable({ pages: { shop: 'http://localhost:4402', admin: 'http://localhost:4402/admin' }, display: { shop: 'shop.northfield.example' } })).toEqual([rows[0]]);
  });

  it('editDisplayTable: the project\'s current pages first (a display URL added after the capture applies), recorded rows it no longer declares kept (V2)', () => {
    const recorded = [
      { page: 'shop', url: 'http://localhost:4402', display: 'https://old.northfield.example' },
      { page: 'legacy', url: 'http://localhost:4499', display: 'https://legacy.northfield.example' },
    ];
    const current = displayRows({ pages: { shop: 'http://localhost:4402', console: 'http://localhost:4401' }, display: { shop: 'shop.northfield.example' } });
    const t = editDisplayTable(recorded, current);
    expect(displayUrl('http://localhost:4402/x', t)).toBe('https://shop.northfield.example/x');
    expect(displayUrl('http://localhost:4499/y', t)).toBe('https://legacy.northfield.example/y');
    expect(displayUrl('http://localhost:4401/z', t)).toBe('http://localhost:4401/z');
    expect(editDisplayTable(undefined, undefined)).toEqual([]);
    expect(editDisplayTable(recorded, undefined)).toEqual(recorded);
  });

  it('shownUrl / shownText: the display URL, else the path — never a local host, never a file path', () => {
    expect(shownUrl('http://localhost:4402/quotes?x=1', table)).toBe('https://shop.northfield.example/quotes?x=1');
    expect(shownUrl('http://localhost:4403/api/x?y=2', table)).toBe('/api/x?y=2');
    expect(shownUrl('file:///home/someone/report%20q3.pdf', table)).toBe('report q3.pdf');
    expect(shownUrl('https://www.example.org/a', table)).toBe('https://www.example.org/a');
    expect(shownText('open http://localhost:4402/quotes', table)).toBe('open https://shop.northfield.example/quotes');
    expect(shownText('open http://localhost:4403/admin, then localhost:4403/x and 192.168.1.5:3000.', table)).toBe('open /admin, then /x and /.');
    expect(shownText('click button "Save"', table)).toBe('click button "Save"');
  });

  it('a same-origin URL outside every base path takes the display origin of the "/" page', () => {
    const t = displayTable({ pages: { app: 'http://127.0.0.1:3000/app', root: 'http://127.0.0.1:3000' }, display: { app: 'app.example.com/app', root: 'www.example.com' } });
    expect(displayUrl('http://127.0.0.1:3000/other', t)).toBe('https://www.example.com/other');
    const only = displayTable({ pages: { app: 'http://[::1]:3000/app' }, display: { app: 'app.example.com/app' } });
    expect(displayUrl('http://[::1]:3000/elsewhere', only)).toBe('https://app.example.com/elsewhere');
  });

  it.each([
    ['localhost', true], ['shop.localhost', true], ['127.0.0.1', true], ['127.8.0.2', true], ['[::1]', true], ['0.0.0.0', true],
    ['printer.local', true], ['app.test', true], ['svc.internal', true], ['10.1.2.3', true], ['172.16.0.1', true], ['172.31.255.1', true],
    ['172.32.0.1', false], ['192.168.1.20', true], ['169.254.1.1', true], ['fd12:3456::1', true], ['fe80::1', true],
    ['shop.northfield.example', false], ['8.8.8.8', false], ['example.com', false], ['2001:db8::1', false],
    // V6: names without a dot, home / office network suffixes, shared addresses, IPv4-mapped IPv6, written forms.
    ['devbox', true], ['web', true], ['nas.lan', true], ['router.home.arpa', true], ['box.localdomain', true],
    ['100.64.0.1', true], ['100.127.255.254', true], ['100.128.0.1', false], ['[::ffff:7f00:1]', true], ['::ffff:127.0.0.1', true],
    ['[::ffff:808:808]', false], ['127.1', true], ['2130706433', true], ['0:0:0:0:0:0:0:1', true], ['localhost:3000', true],
    ['shop.example', false], ['www.example.net', false],
  ])('isLocalHost(%s) → %s', (host, local) => {
    expect(isLocalHost(host)).toBe(local);
  });

  it('isLocalUrl and findLocalUrls', () => {
    expect(isLocalUrl('http://localhost:4402/x')).toBe(true);
    expect(isLocalUrl('https://shop.example.com')).toBe(false);
    expect(isLocalUrl('mailto:a@b')).toBe(false);
    expect(findLocalUrls('Open http://localhost:4402/quotes, then 127.0.0.1:8080/x and localhost:3000. Not https://shop.example.com.')).toEqual([
      'http://localhost:4402/quotes',
      '127.0.0.1:8080/x',
      'localhost:3000',
    ]);
    // V6: bare local hosts with a port or a path; a full URL to a name without a dot; never a ratio or a time.
    expect(findLocalUrls('See shop.localhost:4402, app.test:3000/x, 192.168.1.5:3000, [::1]:4402, localhost/admin and http://devbox:3000/y.')).toEqual([
      'http://devbox:3000/y',
      'shop.localhost:4402',
      'app.test:3000/x',
      '192.168.1.5:3000',
      '[::1]:4402',
      'localhost/admin',
    ]);
    expect(findLocalUrls('Ratio 16:9 at 10:30, rated 10.5/20, v1.2.3/docs, shop.example.com:443/x, item:5')).toEqual([]);
  });
});

describe('request patterns and the write classifier (R-ENV-03)', () => {
  it('parses patterns and explains the bad ones', () => {
    expect(parseRequestPattern('POST shop:/api/quotes/')).toMatchObject({ method: 'POST', page: 'shop', path: '/api/quotes' });
    expect(parseRequestPattern('/api/**')).toMatchObject({ path: '/api/**' });
    expect(parseRequestPattern('/api/**').method).toBeUndefined();
    expect(requestPatternError('GET shop:/x')).toMatch(/GET requests are never stopped/);
    expect(requestPatternError('https://shop.example.com/x')).toMatch(/absolute URLs are not supported/);
    expect(requestPatternError('shop/x')).toMatch(/is not a request pattern/);
    expect(requestPatternError('POST /x?y=1')).toMatch(/no query/);
  });

  const pages = { shop: 'https://shop.example.com/store', console: 'https://console.example.com' };
  it.each([
    ['POST shop:/api/quotes', 'POST', 'https://shop.example.com/store/api/quotes', true],
    ['POST shop:/api/quotes', 'POST', 'https://shop.example.com/store/api/quotes/', true],
    ['POST shop:/api/quotes', 'POST', 'https://shop.example.com/store/api/quotes?draft=1', true],
    ['POST shop:/api/quotes', 'PUT', 'https://shop.example.com/store/api/quotes', false],
    ['POST shop:/api/quotes', 'POST', 'https://shop.example.com/api/quotes', false],
    ['POST shop:/api/quotes', 'POST', 'https://console.example.com/store/api/quotes', false],
    ['shop:/api/*/lines', 'PATCH', 'https://shop.example.com/store/api/q1/lines', true],
    ['shop:/api/*/lines', 'PATCH', 'https://shop.example.com/store/api/q1/x/lines', false],
    ['/api/**', 'DELETE', 'https://console.example.com/api/a/b/c', true],
    ['cart:/x', 'POST', 'https://shop.example.com/x', false],
  ])('%s matches %s %s → %s', (pattern, method, url, match) => {
    expect(matchRequestPattern(parseRequestPattern(pattern), method, url, pages)).toBe(match);
  });

  it('reads GraphQL bodies: queries read, mutations and persisted queries write', () => {
    expect(graphqlOf('{"query":"query Products($q: String) { products(q: $q) { id } }"}')).toEqual([{ operations: [{ kind: 'query', name: 'Products' }], persisted: false }]);
    expect(graphqlOf({ query: '{ me { id } }' })).toEqual([{ operations: [{ kind: 'query' }], persisted: false }]);
    expect(graphqlOf({ query: 'query A { a } mutation B { b }', operationName: 'B' })![0].operations).toEqual([{ kind: 'mutation', name: 'B' }]);
    expect(graphqlOf({ query: '# mutation X\n"""mutation in a string""" query Q { a(s: "mutation") }' })![0].operations).toEqual([{ kind: 'query', name: 'Q' }]);
    expect(graphqlOf({ operationName: 'Save', extensions: { persistedQuery: { sha256Hash: 'abc' } } })).toEqual([{ operations: [], operationName: 'Save', persisted: true }]);
    expect(graphqlOf('not json')).toBeNull();
    expect(graphqlOf({ a: 1 })).toBeNull();
    // A JSON body that merely has a `query` field is not GraphQL (it writes like any other): another key, or a `query`
    // that is not a document.
    expect(graphqlOf({ name: 'Open', query: '{"status":"open"}' })).toBeNull();
    expect(graphqlOf({ query: '{ x }', text: 'hello' })).toBeNull();
    expect(graphqlOf({ query: '{"status":"open"}' })).toBeNull();
    expect(graphqlOf({ query: '{}' })).toBeNull();
    expect(graphqlOf({ query: 'status:open' })).toBeNull();
    expect(graphqlOf({ query: '{ ...Fields } fragment Fields on Query { a }', variables: {}, extensions: {} })![0].operations).toEqual([{ kind: 'query' }]);
    expect(httpWriteReason({ method: 'POST', json: { name: 'Open', query: '{"status":"open"}' } })).toBe('HTTP POST');
  });

  const project = {
    config: applyProjectDefaults({
      name: 'x',
      environments: {
        prod: {
          production: true,
          pages: { shop: 'https://shop.example.com', console: 'https://console.example.com' },
          read_only: {
            hosts: ['api.example.com', '*.cdn.example.net'],
            allow: ['POST console:/api/session/refresh', { request: 'POST shop:/graphql', operation: 'SearchProducts' }, 'POST /api/quotes'],
            mocks: [{ request: 'POST shop:/api/track', status: 204 }, { request: 'POST shop:/graphql', operation: 'SaveCart', json: { data: { ok: true } } }],
          },
        },
      },
    }),
  };
  const policy = compileWritePolicy(resolveEnvironment(project, 'prod'), {
    scenarioMocks: [{ request: 'POST shop:/api/quotes', status: 201, json: { id: 9001 }, delay_ms: 300 }],
  });

  it('compiles the guarded hosts (production: every host — fail closed), allow entries and mocks (scenario first)', () => {
    expect(policy.hosts).toEqual(['*']);
    expect([policy.readOnly, guardsWrites(policy)]).toEqual([true, true]);
    // A read-only environment that is not production: its pages' hosts, then read_only.hosts.
    const staging = compileWritePolicy({ ...resolveEnvironment(project, 'prod'), name: 'staging', production: false, access: 'read-only' });
    expect(staging.hosts).toEqual(['shop.example.com', 'console.example.com', 'api.example.com', '*.cdn.example.net']);
    expect(policy.allow.map((r) => r.source)).toEqual(['POST console:/api/session/refresh', 'POST shop:/graphql', 'POST /api/quotes']);
    expect(policy.mocks.map((m) => [m.source, m.from, m.status, m.contentType, m.body, m.delayMs])).toEqual([
      ['POST shop:/api/quotes', 'scenario', 201, 'application/json', '{"id":9001}', 300],
      ['POST shop:/api/track', 'environment', 204, 'text/plain', '', 0],
      ['POST shop:/graphql', 'environment', 200, 'application/json', '{"data":{"ok":true}}', 0],
    ]);
  });

  it.each([
    ['GET is a read', { method: 'GET', url: 'https://shop.example.com/x' }, { write: false }],
    ['OPTIONS is a read', { method: 'OPTIONS', url: 'https://shop.example.com/x' }, { write: false }],
    ['a GraphQL query sent as POST is a read', { method: 'POST', url: 'https://shop.example.com/graphql', body: '{"query":"{ cart { id } }"}' }, { write: false }],
    ['a stopped write', { method: 'DELETE', url: 'https://shop.example.com/api/cart/1' }, { write: true, outcome: 'blocked' }],
    ['a write to an extra guarded host', { method: 'PUT', url: 'https://api.example.com/v1/x' }, { write: true, outcome: 'blocked' }],
    ['a write to a guarded subdomain', { method: 'POST', url: 'https://img.cdn.example.net/upload' }, { write: true, outcome: 'blocked' }],
    ['production: a write to any other host is stopped too', { method: 'POST', url: 'https://analytics.example.org/collect' }, { write: true, outcome: 'blocked' }],
    ['a scenario mock wins over an allow entry', { method: 'POST', url: 'https://shop.example.com/api/quotes' }, { write: true, outcome: 'mocked', rule: 'POST shop:/api/quotes' }],
    ['an environment mock', { method: 'POST', url: 'https://shop.example.com/api/track?v=2' }, { write: true, outcome: 'mocked', rule: 'POST shop:/api/track' }],
    ['an allow entry', { method: 'POST', url: 'https://console.example.com/api/session/refresh' }, { write: true, outcome: 'allowed', rule: 'POST console:/api/session/refresh' }],
    ['a path allow entry on any guarded host', { method: 'POST', url: 'https://console.example.com/api/quotes' }, { write: true, outcome: 'allowed', rule: 'POST /api/quotes' }],
    ['a GraphQL mutation allowed by operation', { method: 'POST', url: 'https://shop.example.com/graphql', body: '{"query":"mutation SearchProducts { x }"}' }, { write: true, outcome: 'allowed', operation: 'SearchProducts' }],
    ['a GraphQL mutation mocked by operation', { method: 'POST', url: 'https://shop.example.com/graphql', body: '{"query":"mutation SaveCart($c: In) { save(c: $c) { id } }"}' }, { write: true, outcome: 'mocked', operation: 'SaveCart' }],
    ['another GraphQL mutation is stopped', { method: 'POST', url: 'https://shop.example.com/graphql', body: '{"query":"mutation Pay { pay }"}' }, { write: true, outcome: 'blocked', operation: 'Pay' }],
    ['a persisted query is a write unless allowed by name', { method: 'POST', url: 'https://shop.example.com/graphql', body: '{"operationName":"SearchProducts","extensions":{"persistedQuery":{"sha256Hash":"1"}}}' }, { write: true, outcome: 'allowed', operation: 'SearchProducts' }],
    ['an unknown persisted query is stopped', { method: 'POST', url: 'https://shop.example.com/graphql', body: '{"operationName":"Other","extensions":{"persistedQuery":{"sha256Hash":"1"}}}' }, { write: true, outcome: 'blocked', operation: 'Other' }],
    // An entry narrowed to an operation covers a batch only when every operation of it that writes is that one.
    ['a batch of allowed operations', { method: 'POST', url: 'https://shop.example.com/graphql', body: '[{"query":"mutation SearchProducts { a }"},{"query":"query Me { me }"},{"query":"mutation SearchProducts { b }"}]' }, { write: true, outcome: 'allowed' }],
    ['a batch with another mutation is stopped', { method: 'POST', url: 'https://shop.example.com/graphql', body: '[{"operationName":"SearchProducts","query":"mutation SearchProducts { a }"},{"operationName":"CreateOrder","query":"mutation CreateOrder { b }"}]' }, { write: true, outcome: 'blocked' }],
    ['a batch with an anonymous mutation is stopped', { method: 'POST', url: 'https://shop.example.com/graphql', body: '[{"query":"mutation { deleteAll }"},{"query":"mutation SearchProducts { a }"}]' }, { write: true, outcome: 'blocked' }],
    ['a mock by operation never answers a batch with another write', { method: 'POST', url: 'https://shop.example.com/graphql', body: '[{"query":"mutation SaveCart { a }"},{"operationName":"Pay","extensions":{"persistedQuery":{"sha256Hash":"2"}}}]' }, { write: true, outcome: 'blocked' }],
    ['a JSON body with a `query` field is no GraphQL read', { method: 'POST', url: 'https://shop.example.com/api/saved-views', body: '{"name":"Open","query":"{\\"status\\":\\"open\\"}"}' }, { write: true, outcome: 'blocked' }],
  ])('%s', (_name, req, expected) => {
    expect(classifyRequest(req, policy)).toMatchObject(expected);
  });

  it('a read-only environment that is not production guards its pages and read_only.hosts; other writes pass (recorded)', () => {
    const staging = compileWritePolicy({ ...resolveEnvironment(project, 'prod'), name: 'staging', production: false, access: 'read-only' });
    expect(classifyRequest({ method: 'PUT', url: 'https://api.example.com/v1/x' }, staging)).toMatchObject({ write: true, outcome: 'blocked' });
    expect(classifyRequest({ method: 'POST', url: 'https://img.cdn.example.net/upload' }, staging)).toMatchObject({ write: true, outcome: 'blocked' });
    expect(classifyRequest({ method: 'POST', url: 'https://cdn.example.net/upload' }, staging)).toMatchObject({ write: true, outcome: 'passed' });
    expect(classifyRequest({ method: 'POST', url: 'https://analytics.example.org/collect' }, staging)).toMatchObject({ write: true, outcome: 'passed' });
  });

  it('read_only.hosts entries are host patterns: a path, a leading dot or a stray wildcard is refused; IDN in punycode', () => {
    for (const ok of ['api.example.com', 'API.example.com', 'api.example.com:8443', '*.example.com', '*', 'https://api.example.com/v1', '[::1]:5432', 'bücher.example', 'api.example.com.']) {
      expect(hostPatternError(ok), ok).toBeNull();
    }
    for (const bad of ['api.example.com/', 'api.example.com/v1', '.example.com', 'api.*.com', 'a b.example', 'user@api.example.com', '-api.example.com', 'https://']) {
      expect(hostPatternError(bad), bad).toMatch(/is not a (host|URL with a host)/);
    }
    const { issues } = parseProjectYaml('name: X\nenvironments:\n  staging:\n    access: read-only\n    pages: {shop: https://shop.example.com}\n    read_only:\n      hosts: [api.example.com/, "api.example.com/v1", .example.com]\n');
    expect(errors(issues).map((i) => `${i.path.join('.')}: ${i.message.split(':')[0]}`)).toEqual([
      'environments.staging.read_only.hosts.0: "api.example.com/" is not a host',
      'environments.staging.read_only.hosts.1: "api.example.com/v1" is not a host',
      'environments.staging.read_only.hosts.2: ".example.com" is not a host',
    ]);
    const idn = compileWritePolicy({ name: 'staging', pages: { shop: 'https://shop.example.com' }, access: 'read-only', read_only: { hosts: ['bücher.example', '*.straße.example'] } });
    expect(idn.hosts).toEqual(['shop.example.com', 'xn--bcher-kva.example', '*.xn--strae-oqa.example']);
    expect(classifyRequest({ method: 'POST', url: 'https://bücher.example/api' }, idn)).toMatchObject({ outcome: 'blocked' });
    expect(classifyRequest({ method: 'POST', url: 'https://www.straße.example/api' }, idn)).toMatchObject({ outcome: 'blocked' });
  });

  it('"*" guards every host', () => {
    const all = compileWritePolicy({ name: 'p', pages: { shop: 'https://shop.example.com' }, read_only: { hosts: ['*'] } });
    expect(classifyRequest({ method: 'POST', url: 'https://anything.example.org/x' }, all)).toMatchObject({ write: true, outcome: 'blocked' });
  });

  it('describeWriteRequest names a write by its page (longest base) or host, never its query; WriteRefusedError', () => {
    const pages = { shop: 'https://shop.example.com', admin: 'https://shop.example.com/admin', api: 'http://localhost:4402/v1/' };
    expect(describeWriteRequest('post', 'https://shop.example.com/api/quotes?token=s3cret#x', pages)).toBe('POST shop:/api/quotes');
    expect(describeWriteRequest('DELETE', 'https://shop.example.com/admin/users/7', pages)).toBe('DELETE admin:/users/7');
    expect(describeWriteRequest('PUT', 'http://localhost:4402/v1', pages)).toBe('PUT api:/');
    expect(describeWriteRequest('POST', 'https://api.example.org/track?id=1', pages)).toBe('POST api.example.org/track');
    expect(describeWriteRequest('POST', 'not a url?q=1', pages)).toBe('POST not a url');
    const e = new WriteRefusedError(['POST shop:/api/reset'], 'production', { detail: 'the hook threw: Error: no' });
    expect([e.name, e.message, e.writes, e.env, e.detail, isWriteRefusedError(e)]).toEqual([
      'WriteRefusedError',
      'a js hook wrote on read-only environment production (POST shop:/api/reset): stopped in its tab; the hook threw: Error: no',
      ['POST shop:/api/reset'],
      'production',
      'the hook threw: Error: no',
      true,
    ]);
    expect(isWriteRefusedError(Object.assign(new Error('x'), { name: 'WriteRefusedError' }))).toBe(true);
    expect(isWriteRefusedError(new Error('x'))).toBe(false);
    const foreign = new WriteRefusedError(['POST api.example.com/reset'], 'local', { protectedBy: 'production' });
    expect([foreign.message, foreign.protectedBy]).toEqual(['a js hook wrote to a host of read-only environment production (POST api.example.com/reset): stopped in its tab', 'production']);
  });
});

describe('hosts of the other, read-only environments: never written to from another run (R-ENV-04)', () => {
  const SHARED = `name: X
environments:
  local:
    app: http://localhost:4402
  demo:
    app: https://shop.example.com
  production:
    production: true
    pages:
      app: https://shop.example.com
      api: https://api.example.com
    read_only:
      hosts: ["*.example.com", "*"]
  live:
    production: true
    access: read-write
    pages: {app: https://live.example.org}
`;

  it('a run protects the hosts of the environments it would be read-only on, unless it may write to them too', () => {
    const p = project(SHARED);
    const local = crossEnvironmentHosts(p, 'local');
    expect(local.writable.sort()).toEqual(['localhost', 'shop.example.com']);
    expect(local.protected.map((h) => `${h.host} ${h.env}`)).toEqual(['api.example.com production', '*.example.com production', 'live.example.org live']);
    // A host shared with a read-write environment is not protected (shop.example.com: demo), "*" never is.
    expect(protectedBy('shop.example.com', local)).toBeNull();
    expect(protectedBy('localhost', local)).toBeNull();
    expect(protectedBy('API.example.com', local)).toMatchObject({ env: 'production', production: true, configured: 'read-only' });
    expect(protectedBy('img.example.com', local)).toMatchObject({ env: 'production' });
    expect(protectedBy('analytics.example.net', local)).toBeNull();
    // --allow-writes: live's own access applies (production, access: read-write) — production's never does.
    expect(crossEnvironmentHosts(p, 'local', true).protected.map((h) => h.env)).toEqual(['production', 'production']);
    // The run's own read-only environment is its policy's, not a protected one.
    expect(crossEnvironmentHosts(p, 'production').protected.map((h) => h.host)).toEqual(['live.example.org']);
    // resolveRunAccess carries them when given the project.
    expect(resolveRunAccess(resolveEnvironment(p, 'local'), { project: p }).protected).toEqual(local.protected);
    expect(resolveRunAccess(resolveEnvironment(p, 'local')).protected).toBeUndefined();
  });

  it('a project without read-only environments, or whose read-only one shares its hosts, protects nothing', () => {
    expect(crossEnvironmentHosts(project('name: X\nenvironments:\n  local: {app: "http://localhost:4402"}\n  staging: {app: "https://staging.example.com"}\n'), 'local').protected).toEqual([]);
    // The fixture's case: production is the same local server.
    const same = project('name: X\nenvironments:\n  local: {app: "http://localhost:4402"}\n  production:\n    production: true\n    pages: {app: "http://localhost:4402"}\n');
    expect(crossEnvironmentHosts(same, 'local').protected).toEqual([]);
    const access = runAccess(resolveEnvironment(same, 'local'), false, same);
    expect(guardsWrites(compileWritePolicy(resolveEnvironment(same, 'local'), { access }))).toBe(false);
  });

  it('a read-write run guards only the protected hosts: no mocks, no allow entries, its other writes are not the guard\'s', () => {
    const p = project(SHARED);
    const env = resolveEnvironment(p, 'local');
    const access = resolveRunAccess(env, { project: p });
    const policy = compileWritePolicy(env, { access, scenarioMocks: [{ request: 'POST /api/x', status: 200 }] });
    expect([policy.readOnly, policy.hosts, policy.mocks, policy.allow, guardsWrites(policy)]).toEqual([false, [], [], [], true]);
    expect(classifyRequest({ method: 'POST', url: 'http://localhost:4402/api/x' }, policy)).toEqual({ write: false });
    expect(classifyRequest({ method: 'POST', url: 'https://shop.example.com/api/x' }, policy)).toEqual({ write: false });
    expect(classifyRequest({ method: 'POST', url: 'https://api.example.com/api/reset' }, policy)).toEqual({ write: true, outcome: 'blocked', protectedBy: 'production' });
    expect(classifyRequest({ method: 'GET', url: 'https://api.example.com/api/x' }, policy)).toEqual({ write: false });
    // A read-only run guards them too (here a non-production one: its own hosts, then the protected ones).
    const ro = project(`${SHARED}  staging:\n    access: read-only\n    pages: {app: https://staging.example.net}\n`);
    const st = resolveEnvironment(ro, 'staging');
    const stPolicy = compileWritePolicy(st, { access: resolveRunAccess(st, { project: ro }) });
    expect(classifyRequest({ method: 'POST', url: 'https://staging.example.net/x' }, stPolicy)).toEqual({ write: true, outcome: 'blocked' });
    expect(classifyRequest({ method: 'POST', url: 'https://live.example.org/x' }, stPolicy)).toEqual({ write: true, outcome: 'blocked', protectedBy: 'live' });
    expect(classifyRequest({ method: 'POST', url: 'https://elsewhere.example.net/x' }, stPolicy)).toEqual({ write: true, outcome: 'passed' });
  });

  it('the refusal names the host, its environment and the way out', () => {
    const p = project(SHARED);
    const access = resolveRunAccess(resolveEnvironment(p, 'local'), { project: p });
    expect(protectedHostMessage('HTTP POST', protectedBy('api.example.com', access)!, access, 'api.example.com')).toBe(
      'refusing a hook that writes (HTTP POST) to api.example.com, a host of environment production — this run is on environment local: environment production is production, read-only in project.yaml; `optional: true` does not skip a refusal',
    );
    expect(protectedHostMessage('HTTP PUT', protectedBy('live.example.org', access)!, access)).toMatch(/to a host of environment live — this run is on environment local: pass --allow-writes to let it write to production;/);
  });
});

describe('clock (R-ENV-05)', () => {
  it('validates ISO date-times; a date alone is refused', () => {
    expect(clockError('2026-11-02T10:24:00')).toBeNull();
    expect(clockError('2026-11-02 10:24')).toBeNull();
    expect(clockError('2026-11-02T10:24:00.250+01:00')).toBeNull();
    expect(clockError('2026-11-02T10:24:00Z')).toBeNull();
    expect(clockError('2026-11-02')).toBe('a date alone is not enough: add a time, e.g. 2026-11-02T10:24:00');
    expect(clockError('2026-02-30T10:00:00')).toMatch(/is not a real date and time/);
    expect(clockError('2026-11-02T24:00:00')).toMatch(/is not a real date and time/);
    expect(clockError('next monday')).toMatch(/expected an ISO 8601 date and time/);
  });

  it('an explicit offset names one instant; scenario wins, false turns the project clock off', () => {
    expect(resolveClock(undefined, '2026-11-02T10:24:00Z')).toEqual({ at: '2026-11-02T10:24:00Z', epoch_ms: Date.UTC(2026, 10, 2, 10, 24) });
    expect(resolveClock('2026-11-02T10:24:00+01:00', '2020-01-01T00:00:00Z')!.epoch_ms).toBe(Date.UTC(2026, 10, 2, 9, 24));
    expect(resolveClock({ at: '2026-11-02T10:24:00-05:30', freeze: true }, undefined)).toEqual({ at: '2026-11-02T10:24:00-05:30', epoch_ms: Date.UTC(2026, 10, 2, 15, 54), freeze: true });
    expect(resolveClock(false, '2026-11-02T10:24:00Z')).toBeUndefined();
    expect(resolveClock(undefined, undefined)).toBeUndefined();
  });

  it('a time without an offset is wall time in browser.timezone (DST-aware), else the machine zone', () => {
    // Paris: UTC+1 in November (after the DST change), UTC+2 in July.
    expect(resolveClock('2026-11-02T10:24:00', undefined, { timezone: 'Europe/Paris' })).toEqual({ at: '2026-11-02T10:24:00', epoch_ms: Date.UTC(2026, 10, 2, 9, 24), timezone: 'Europe/Paris' });
    expect(resolveClock('2026-07-01T10:24:00', undefined, { timezone: 'Europe/Paris' })!.epoch_ms).toBe(Date.UTC(2026, 6, 1, 8, 24));
    expect(resolveClock('2026-03-08T12:00:00', undefined, { timezone: 'America/New_York' })!.epoch_ms).toBe(Date.UTC(2026, 2, 8, 16, 0));
    expect(resolveClock('2026-11-02T10:24:00', undefined)!.epoch_ms).toBe(new Date(2026, 10, 2, 10, 24).getTime());
    // An offset wins over the zone.
    expect(resolveClock('2026-11-02T10:24:00Z', undefined, { timezone: 'Europe/Paris' })).toEqual({ at: '2026-11-02T10:24:00Z', epoch_ms: Date.UTC(2026, 10, 2, 10, 24) });
  });

  it('refuses an unusable clock or time zone', () => {
    expect(() => resolveClock('2026-11-02', undefined)).toThrow(ClockError);
    expect(() => resolveClock('2026-11-02T10:24:00', undefined, { timezone: 'Mars/Olympus' })).toThrow(/browser.timezone "Mars\/Olympus" is not a time zone/);
    // T3: minutes of an offset past 59, a year before 1970.
    expect(clockError('2026-11-02T10:24:00+05:99')).toMatch(/the offset is out of range/);
    expect(clockError('2026-11-02T10:24:00+0560')).toMatch(/the offset is out of range/);
    expect(clockError('2026-11-02T10:24:00+05:45')).toBeNull();
    expect(clockError('0099-11-02T10:24:00Z')).toMatch(/1970 or later/);
  });

  it('a wall time a DST change skips or shows twice names no instant: refused, with the offset to write (T3)', () => {
    expect(() => resolveClock('2026-03-29T02:30:00', undefined, { timezone: 'Europe/Paris' })).toThrow(
      'clock: 2026-03-29T02:30:00 does not exist in Europe/Paris (the clocks go forward then): give an offset, e.g. 2026-03-29T02:30:00+01:00',
    );
    expect(() => resolveClock('2026-10-25T02:30:00', undefined, { timezone: 'Europe/Paris' })).toThrow(
      'clock: 2026-10-25T02:30:00 happens twice in Europe/Paris (the clocks go back then): give an offset — 2026-10-25T02:30:00+02:00 (the first) or 2026-10-25T02:30:00+01:00 (the second)',
    );
    expect(() => resolveClock('2026-03-08T02:30:00', undefined, { timezone: 'America/New_York' })).toThrow(/does not exist in America\/New_York.*-05:00/);
    expect(() => resolveClock('2026-11-01T01:30:00', undefined, { timezone: 'America/New_York' })).toThrow(/happens twice in America\/New_York.*-04:00 \(the first\) or .*-05:00 \(the second\)/);
    // Half-hour DST (Lord Howe) and zones without DST.
    expect(() => resolveClock('2026-10-04T02:15:00', undefined, { timezone: 'Australia/Lord_Howe' })).toThrow(/does not exist/);
    expect(resolveClock('2026-11-02T10:24:00', undefined, { timezone: 'Asia/Kolkata' })!.epoch_ms).toBe(Date.UTC(2026, 10, 2, 4, 54));
    // Right before and after a change: one instant each; an offset settles an ambiguous time.
    expect(resolveClock('2026-10-25T01:59:59', undefined, { timezone: 'Europe/Paris' })!.epoch_ms).toBe(Date.UTC(2026, 9, 24, 23, 59, 59));
    expect(resolveClock('2026-10-25T03:00:00', undefined, { timezone: 'Europe/Paris' })!.epoch_ms).toBe(Date.UTC(2026, 9, 25, 2, 0));
    expect(resolveClock('2026-10-25T02:30:00+01:00', undefined, { timezone: 'Europe/Paris' })!.epoch_ms).toBe(Date.UTC(2026, 9, 25, 1, 30));
  });

  it('records the zone a time without an offset was read in: browser.timezone, else the machine\'s (T4)', () => {
    const machine = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveClock('2026-11-02T10:24:00', undefined)).toEqual({ at: '2026-11-02T10:24:00', epoch_ms: new Date(2026, 10, 2, 10, 24).getTime(), timezone: machine });
    expect(resolveClock({ at: '2026-11-02T10:24:00', freeze: true }, undefined, { timezone: 'UTC' })).toEqual({ at: '2026-11-02T10:24:00', epoch_ms: Date.UTC(2026, 10, 2, 10, 24), timezone: 'UTC', freeze: true });
  });

  it('project and scenario clocks are validated where they are written', () => {
    const p = parseProjectYaml('name: x\nclock: {at: "2026-11-02"}\nenvironments:\n  local: {a: "http://localhost:1"}\n');
    expect(msgs(p.issues)).toEqual(['error 2:13 clock.at: a date alone is not enough: add a time, e.g. 2026-11-02T10:24:00']);
    expect(parseProjectYaml('name: x\nclock: 2026-11-02T10:24:00\nenvironments:\n  local: {a: "http://localhost:1"}\n').config!.clock).toBe('2026-11-02T10:24:00');
    const s = parseScenario('video: v\nclock: false\nscenes:\n  - id: a\n    steps: [{wait: 1}]\n');
    expect(s.scenario?.clock).toBe(false);
    const bad = parseScenario('video: v\nclock: true\nscenes:\n  - id: a\n    steps: [{wait: 1}]\n');
    expect(msgs(errors(bad.issues))).toEqual(['error 2:8 clock: expected false, a string or a mapping, got true']);
  });
});

describe('which hooks write (R-ENV-04)', () => {
  it.each([
    ['SELECT id FROM products WHERE slug = $1', null],
    ["SELECT 'delete from x; update y' AS note -- insert\n", null],
    ['WITH s AS (SELECT 1) SELECT * FROM s', null],
    ['SHOW search_path; TABLE products; VALUES (1)', null],
    ['SET search_path TO app; SET LOCAL statement_timeout = 5000; SELECT 1', null],
    ['EXPLAIN DELETE FROM products', null],
    ['EXPLAIN ANALYZE SELECT * FROM products', null],
    ['SELECT * FROM orders FOR UPDATE', 'SQL SELECT … FOR UPDATE / SHARE locks rows'],
    ['SELECT * FROM orders FOR NO KEY UPDATE', 'SQL SELECT … FOR UPDATE / SHARE locks rows'],
    ['SELECT * INTO backup FROM orders', 'SQL SELECT … INTO creates a table'],
    ["SELECT nextval('quote_ids')", 'SQL nextval() changes a sequence'],
    ['WITH gone AS (DELETE FROM carts RETURNING id) SELECT count(*) FROM gone', 'SQL DELETE'],
    ['EXPLAIN (ANALYZE, BUFFERS) DELETE FROM carts', 'EXPLAIN ANALYZE runs SQL DELETE'],
    ['SELECT 1; INSERT INTO t VALUES (1)', 'SQL INSERT'],
    ['UPDATE products SET price = 1', 'SQL UPDATE'],
    ['CREATE TABLE t (id int)', 'SQL CREATE'],
    ['CALL reset_demo()', 'SQL CALL'],
    ["DO $$ BEGIN PERFORM 1; END $$", 'SQL DO'],
    ['COPY products TO STDOUT', 'SQL COPY'],
    ['SET TRANSACTION READ WRITE', 'SQL SET of the transaction mode or role'],
    ['SET default_transaction_read_only = off', 'SQL SET of the transaction mode or role'],
    ['SET ROLE admin', 'SQL SET of the transaction mode or role'],
    ['RESET ALL', 'SQL RESET ALL'],
    // A quoted identifier counts by its name (the masking would otherwise hide it).
    ['SET "transaction_read_only" = off; SELECT 1', 'SQL SET of the transaction mode or role'],
    ['RESET "transaction_read_only"', 'SQL RESET of the transaction mode or role'],
    ['SET "role" = admin', 'SQL SET of the transaction mode or role'],
    ['select "nextval"(\'s\')', 'SQL nextval() changes a sequence'],
    ['SELECT "delete me", "Update Count" FROM t', null],
    // dblink runs its SQL over a connection of its own (outside the read-only transaction).
    ["SELECT * FROM dblink('dbname=x', 'DELETE FROM t') AS t(a int)", 'SQL dblink() runs SQL over its own connection'],
    ["SELECT dblink_exec('dbname=x', 'DELETE FROM t')", 'SQL dblink_exec() runs SQL over its own connection'],
    ['/* nothing */ -- at all', null],
  ])('%s → %s', (sql, reason) => {
    expect(sqlWriteStatement(sql)).toBe(reason);
  });

  it('http: by method, a GraphQL query sent as POST reads', () => {
    expect(httpWriteReason({})).toBeNull();
    expect(httpWriteReason({ method: 'HEAD' })).toBeNull();
    expect(httpWriteReason({ method: 'POST' })).toBe('HTTP POST');
    expect(httpWriteReason({ method: 'DELETE' })).toBe('HTTP DELETE');
    expect(httpWriteReason({ method: 'POST', json: { query: 'query Health { ok }' } })).toBeNull();
    expect(httpWriteReason({ method: 'POST', json: { query: 'mutation Reset { reset }' } })).toBe('GraphQL mutation Reset');
    expect(httpWriteReason({ method: 'POST', body: '{"query":"{ ok }"}' })).toBeNull();
  });

  it('hooks of every kind, their rollbacks included', async () => {
    const tmp = await tempDir();
    try {
      await writeFiles(tmp.dir, { 'hooks/read.sql': 'SELECT count(*) FROM quotes;\n', 'hooks/undo.sql': 'DELETE FROM quotes WHERE id = 1;\n' });
      const opts = { projectDir: tmp.dir, files: nodeFileFacts };
      const cases: Array<[HookStep, string | null]> = [
        [{ http: { url: '{{shop}}/api/health' } }, null],
        [{ http: { method: 'POST', url: '{{shop}}/api/reset' } }, 'HTTP POST'],
        [{ http: { url: '{{shop}}/api/health', rollback: { method: 'DELETE', url: '{{shop}}/api/x' } } }, 'its rollback: HTTP DELETE'],
        [{ sql: 'hooks/read.sql' }, null],
        [{ sql: { file: 'hooks/read.sql', rollback: 'hooks/undo.sql' } }, 'its rollback: hooks/undo.sql: SQL DELETE'],
        [{ sql: 'UPDATE quotes SET seen = true' }, 'SQL UPDATE'],
        [{ sql: 'hooks/missing.sql' }, null],
        [{ shell: 'curl -s http://localhost:4402/api/health' }, 'a shell command — add `writes: false` to a shell hook that only reads'],
        [{ shell: 'curl -s http://localhost:4402/api/health', writes: false }, null],
        [{ shell: 'rm -rf tmp/cache', writes: false }, 'shell rm, although it declares writes: false'],
        [{ shell: { run: 'cat data.json', rollback: 'rm data.json' }, writes: false }, 'its rollback: a shell command'],
        [{ js: 'return document.title' }, null],
        [{ js: { code: 'return 1', rollback: 'localStorage.clear()' } }, 'its rollback: JavaScript run in the page'],
      ];
      for (const [hook, reason] of cases) expect(hookWriteReason(hook, opts), JSON.stringify(hook)).toBe(reason);
      // Teardown hooks are never rolled back: their declared rollback does not count.
      expect(
        writingHooks(
          {
            setup: [{ name: 'read', http: { url: '{{shop}}/api/health', rollback: { method: 'DELETE', url: '{{shop}}/x' } } }],
            teardown: [{ js: { code: 'return 1', rollback: 'x()' } }, { http: { method: 'PATCH', url: '{{shop}}/y' } }],
          },
          opts,
        ),
      ).toEqual([
        { phase: 'setup', index: 0, name: 'read', reason: 'its rollback: HTTP DELETE' },
        { phase: 'teardown', index: 1, reason: 'HTTP PATCH' },
      ]);
    } finally {
      await tmp.cleanup();
    }
  });

  it('journaled rollback actions', () => {
    expect(rollbackWriteReason({ kind: 'http', request: { method: 'DELETE' } })).toBe('HTTP DELETE');
    expect(rollbackWriteReason({ kind: 'http', request: {} })).toBeNull();
    expect(rollbackWriteReason({ kind: 'sql', query: 'SELECT 1' })).toBeNull();
    expect(rollbackWriteReason({ kind: 'sql', query: 'DELETE FROM x' })).toBe('SQL DELETE');
    expect(rollbackWriteReason({ kind: 'shell' })).toBe('a shell command');
    expect(rollbackWriteReason({ kind: 'js' })).toBe('JavaScript run in the page');
  });
});

describe('scenario checks on read-only environments', () => {
  const p = project();
  const scenario = (env: string, extra = '') =>
    `video: demo\nenv: ${env}\n${extra}scenes:\n  - id: main\n    page: shop\n    open: /\n    steps:\n      - wait: 1\n`;

  it('a writing hook on a read-only environment is a warning (the run refuses it)', () => {
    const text = scenario('production', 'setup:\n  - name: reset\n    http: {method: POST, url: "{{shop}}/api/reset"}\n  - http: {url: "{{shop}}/api/health"}\n');
    const { scenario: s, issues } = parseScenario(text, { files: fileFacts(PERSON_POLICY), project: p });
    expect(s).toBeDefined();
    expect(msgs(issues)).toEqual([
      `warning ${lineOf(text, '- name: reset')}:5 setup.0: this hook writes (HTTP POST) and environment production is production, read-only: such a run refuses it before anything runs — run with --hooks skip, or on a read-write environment`,
    ]);
    const live = parseScenario(scenario('live', 'teardown:\n  - http: {method: DELETE, url: "{{shop}}/x"}\n    confirm: true\n'), { files: fileFacts(PERSON_POLICY), project: p });
    expect(msgs(live.issues).join('\n')).toContain('environment live is production, read-only without --allow-writes: such a run refuses it before anything runs — run with --hooks skip, or with --allow-writes');
    // The same scenario on a read-write environment: no warning.
    expect(parseScenario(text, { files: fileFacts(PERSON_POLICY), project: p, env: 'local' }).issues).toEqual([]);
  });

  it('mocks: page keys of the environment, literal values, ignored on read-write environments', () => {
    const mocks = 'mocks:\n  - {request: "POST shop:/api/quotes", status: 201, json: {id: 9001}}\n';
    expect(parseScenario(scenario('production', mocks), { files: fileFacts(PERSON_POLICY), project: p }).issues).toEqual([]);
    const local = parseScenario(scenario('local', mocks), { files: fileFacts(PERSON_POLICY), project: p });
    expect(msgs(local.issues)).toEqual([expect.stringContaining('warning 3:1 mocks: mocks apply to read-only runs only: environment local is read-write')]);
    const bad = parseScenario(scenario('production', 'mocks:\n  - {request: "POST cart:/x", body: "{{run.id}}"}\n  - {request: "GET shop:/x"}\n'), { files: fileFacts(PERSON_POLICY), project: p });
    expect(msgs(errors(bad.issues))).toEqual([
      expect.stringContaining('mocks.0.request: unknown page "cart" in the request pattern (environment production has: console, shop)'),
      expect.stringContaining('mocks.0.body: mocks are served as written'),
      expect.stringContaining('mocks.1.request: GET requests are never stopped'),
    ]);
  });

  it('`writes` belongs to shell hooks', () => {
    const text = scenario('local', 'setup:\n  - http: {method: POST, url: "{{shop}}/api/reset"}\n    writes: false\n  - shell: cat data.json\n    writes: false\n');
    const { issues } = parseScenario(text, { files: fileFacts(PERSON_POLICY), project: p });
    expect(msgs(errors(issues))).toEqual([expect.stringContaining('setup.0.writes: `writes` is for shell hooks: the writes of an http hook are seen in its method and body')]);
  });
});

describe('run files: environment blocks', () => {
  it('timeline.environment and run.json environment validate', () => {
    const tl = {
      version: 1, run_id: 'r', project: 'p', scenario: 's', created_at: 'now', mode: 'capture',
      capture: { file: 'capture.mp4', width: 1920, height: 1080, scale: 1, fps: 30, duration: 1, t0_wall: 0, frames: 1 },
      scenes: [], events: [], markers: [], pages: [], cursor: [], idle: [], warnings: [],
      environment: {
        name: 'production', production: true, access: 'read-only',
        display: [{ page: 'shop', url: 'http://localhost:4402', display: 'https://shop.northfield.example' }],
        clock: { at: '2026-11-02T10:24:00', epoch_ms: 1, timezone: 'Europe/Paris' },
        writes: [{ t: 3.2, method: 'POST', url: 'http://localhost:4402/api/quotes', outcome: 'mocked', rule: 'POST shop:/api/quotes', status: 201, via: 'page' }],
      },
    };
    expect(zodIssues(TimelineSchema, tl)).toEqual([]);
    expect(zodIssues(TimelineSchema, { ...tl, environment: { ...tl.environment, access: 'read-mostly' } })).not.toEqual([]);
    const record = {
      id: 'r', project: 'p', scenario: 's', mode: 'capture', status: 'succeeded', started_at: 'now', dir: '/x', env: 'production',
      options: { hooks: 'run', headed: false, allow_writes: true }, steps_total: 0, steps_done: 0, screenshots: [],
      hooks: { setup: 'none', teardown: 'none' }, warnings: [], environment: { production: true, access: 'read-write', clock: { at: '2026-11-02T10:24:00', timezone: 'Europe/Paris', freeze: true } },
    };
    expect(zodIssues(RunRecordSchema, record)).toEqual([]);
    expect(zodIssues(RunRecordSchema, { ...record, environment: { access: 'read-only', clock: '2026-11-02T10:24:00' } })).not.toEqual([]);
  });
});
