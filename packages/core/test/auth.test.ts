/**
 * L1.6 contracts in core: personas in project.yaml (global, per environment, legacy), derived session paths, sign-in
 * patterns, the static plan of which persona films each page, and the validation of both files.
 */
import { mkdtempSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { authFor, isGlobalAuth, loginCommand, loginMatchers, matchLoginUrl, parseProjectYaml, parseScenario, personaPaths, planPersonas, projectPersonaNames, resolveCheckUrl, resolvePersonas } from '@retake/core';
import { retakeHome, writeTextAtomic } from '@retake/core/io';
import type { LoadedProject, Scenario, ValidationIssue } from '@retake/core';
import { errors, warnings } from './helpers.js';
import { memoryFileFacts } from '@retake/core';

/** No disk: these checks are handed a project but look at no file (L7.34: a FileFacts is required beside a project). */
const NO_DISK = memoryFileFacts({});

const errs = (issues: ValidationIssue[]) => errors(issues).map((i) => `${i.path.join('.')}: ${i.message}`);
const warns = (issues: ValidationIssue[]) => warnings(issues).map((i) => `${i.path.join('.')}: ${i.message}`);

const SIGNED_IN = [
  'name: Northfield',
  'environments:',
  '  local: {console: "http://localhost:4401", shop: "http://localhost:4402"}',
  '  signed-in: {console: "http://localhost:4403", shop: "http://localhost:4404"}',
  'auth:',
  '  signed-in:',
  '    login_url: /sign-in',
  '    personas:',
  '      supplier:',
  '        pages: [console]',
  '        check: {url: "console:/products", expect_text: Maja Lindqvist}',
  '        login:',
  '          - open: "console:/sign-in"',
  '          - type: {into: {label: Email}, text: maja@northfield.example}',
  '          - type: {into: {label: Password}, text: "{{env:NORTHFIELD_SUPPLIER_PASSWORD}}"}',
  '          - click: {role: button, name: Sign in}',
  '      buyer:',
  '        pages: [shop]',
  '        session: storage_state',
  '        check: {url: "shop:/", expect_text: Demo Café}',
  '',
];

function project(lines: string[] = SIGNED_IN, dir = mkdtempSync(join(tmpdir(), 'ds-auth-'))): LoadedProject {
  const { config, issues } = parseProjectYaml(lines.join('\n'));
  if (!config) throw new Error(errs(issues).join('\n'));
  return { slug: 'northfield', dir, root: dir, config, readme: null, scenarios: [], file: join(dir, 'project.yaml'), issues };
}

/** A scenario as written (planPersonas also runs on scenarios validation refuses: it reports their binding issues). */
const scenario = (lines: string[]): Scenario => parseYaml(['video: demo', ...lines, ''].join('\n')) as Scenario;

describe('where sessions live (R-AUTH-02, paths)', () => {
  it('RETAKE_HOME moves the Retake home (~ expanded); default ~/.retake', () => {
    expect(retakeHome({})).toBe(join(homedir(), '.retake'));
    expect(retakeHome({ RETAKE_HOME: '/tmp/x/home' })).toBe('/tmp/x/home');
    expect(retakeHome({ RETAKE_HOME: '~/studio-home', HOME: homedir() })).toBe(join(homedir(), 'studio-home'));
    expect(personaPaths('/h', 'northfield', 'signed-in', 'buyer')).toEqual({
      profileDir: '/h/profiles/northfield/signed-in/buyer',
      snapshot: '/h/sessions/northfield/signed-in/buyer.json',
      statusFile: '/h/sessions/northfield/signed-in/buyer.status.json',
    });
  });

  it('personas are derived under the home, never from project.yaml; a storage_state persona has no profile', () => {
    const p = project();
    expect(resolvePersonas(p, 'local', { home: '/h' })).toEqual([]);
    const [supplier, buyer] = resolvePersonas(p, 'signed-in', { home: '/h' });
    expect(supplier).toMatchObject({
      name: 'supplier',
      env: 'signed-in',
      legacy: false,
      pages: ['console'],
      session: 'profile',
      loginPatterns: ['/sign-in'],
      profileDir: '/h/profiles/northfield/signed-in/supplier',
      snapshot: '/h/sessions/northfield/signed-in/supplier.json',
      statusFile: '/h/sessions/northfield/signed-in/supplier.status.json',
    });
    expect(supplier.login).toHaveLength(4);
    expect(buyer).toMatchObject({ name: 'buyer', session: 'storage_state', snapshot: '/h/sessions/northfield/signed-in/buyer.json' });
    expect(buyer.profileDir).toBeUndefined();
    expect(projectPersonaNames(p.config)).toEqual(['supplier', 'buyer']);
  });

  it('the legacy auth.profile is persona "default" on every page, its paths relative to the project (still works)', () => {
    const p = project(['name: N', 'environments:', '  staging: {app: "https://app.example.com", admin: "https://admin.example.com"}', 'auth: {profile: profiles/main, storage_state: ~/state.json, login_url: /login}'], '/work/projects/northfield');
    expect(isGlobalAuth(p.config.auth)).toBe(true);
    expect(authFor(p.config, 'staging')).toEqual(p.config.auth);
    expect(resolvePersonas(p, 'staging', { home: '/h' })).toEqual([
      {
        name: 'default',
        env: 'staging',
        legacy: true,
        pages: ['app', 'admin'],
        session: 'profile',
        loginPatterns: ['/login'],
        profileDir: '/work/projects/northfield/profiles/main',
        snapshot: join(homedir(), 'state.json'),
        statusFile: '/h/sessions/northfield/staging/default.status.json',
      },
    ]);
    expect(warns(p.issues ?? [])).toEqual([
      'auth.profile: `profile` is a path that only exists on this computer: name the account in `personas` instead (its session then lives in ~/.retake, outside the project) — it still works, as persona "default"',
    ]);
    // The legacy form has no --persona (callers leave it out, keyed on `legacy`); a declared persona named "default" keeps it.
    expect(loginCommand({ project: 'northfield', env: 'staging' })).toBe('retake login northfield --env staging');
    expect(loginCommand({ project: 'northfield', env: 'signed-in', persona: 'default' })).toBe('retake login northfield --env signed-in --persona default');
    expect(loginCommand({ project: 'northfield', env: 'signed-in', persona: 'buyer' })).toBe('retake login northfield --env signed-in --persona buyer');
  });

  it('writeTextAtomic keeps a private file private from its first byte (0600 in 0700)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-atomic-'));
    const file = join(dir, 'sessions', 'p', 'e', 'x.json');
    await writeTextAtomic(file, '{}', { mode: 0o600, dirMode: 0o700 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'sessions', 'p', 'e')).mode & 0o777).toBe(0o700);
    expect(await readFile(file, 'utf8')).toBe('{}');
  });
});

describe('sign-in pages (R-AUTH-04 patterns)', () => {
  const pages = { console: 'http://localhost:4403', shop: 'http://localhost:4404/app' };
  const test = (patterns: Parameters<typeof loginMatchers>[0], url: string) => matchLoginUrl(url, loginMatchers(patterns, pages))?.pattern ?? null;

  it('a path is a prefix at a segment boundary, on the origin + path only (never the query)', () => {
    expect(test(['/sign-in'], 'http://localhost:4403/sign-in')).toBe('/sign-in');
    expect(test(['/sign-in'], 'http://localhost:4403/sign-in/sso?next=/x')).toBe('/sign-in');
    expect(test(['/sign-in/'], 'http://localhost:4403/sign-in')).toBe('/sign-in/');
    expect(test(['/sign-in'], 'http://localhost:4403/sign-in-help')).toBeNull();
    expect(test(['/sign-in'], 'http://localhost:4403/products?return=/sign-in')).toBeNull();
    expect(test(['/auth/login'], 'http://localhost:4403/auth/login')).toBe('/auth/login');
    expect(test(['/sign-in'], 'about:blank')).toBeNull();
  });

  it('"<page>:<path>" and absolute URLs are tied to their origin; {regex} sees origin + path', () => {
    expect(test(['console:/sign-in'], 'http://localhost:4403/sign-in')).toBe('console:/sign-in');
    expect(test(['console:/sign-in'], 'http://localhost:4404/sign-in')).toBeNull();
    expect(test(['shop:/sign-in'], 'http://localhost:4404/app/sign-in')).toBe('shop:/sign-in');
    expect(test(['https://sso.example.com'], 'https://sso.example.com/authorize?client=x')).toBe('https://sso.example.com');
    expect(test(['https://sso.example.com'], 'https://app.example.com/')).toBeNull();
    expect(test([{ regex: '(login|sign-?in)$', flags: 'i' }], 'http://localhost:4403/SignIn')).toBe('/(login|sign-?in)$/i');
    expect(test([{ regex: 'login' }], 'http://localhost:4403/x?login=1')).toBeNull();
    expect(test(['sign-in', { regex: '(' }], 'http://localhost:4403/sign-in')).toBeNull();
  });

  it('a page or URL pattern keeps matching after an http → https or apex → www redirect; regex flags g / y are never applied', () => {
    const site = { app: 'http://northfield.example' };
    const t = (patterns: Parameters<typeof loginMatchers>[0], url: string) => matchLoginUrl(url, loginMatchers(patterns, site))?.pattern ?? null;
    expect(t(['app:/sign-in'], 'https://www.northfield.example/sign-in')).toBe('app:/sign-in');
    expect(t(['https://www.northfield.example/sign-in'], 'http://northfield.example/sign-in/sso')).toBe('https://www.northfield.example/sign-in');
    expect(t(['app:/sign-in'], 'https://shop.northfield.example/sign-in')).toBeNull();
    expect(t(['app:/sign-in'], 'http://northfield.example:8080/sign-in')).toBeNull();
    const g = loginMatchers([{ regex: 'sign-in', flags: 'gi' }], site);
    expect([1, 2, 3].map(() => matchLoginUrl('http://northfield.example/Sign-In', g) !== null)).toEqual([true, true, true]);
    expect(t([{ regex: 'sign-in', flags: 'y' }], 'http://northfield.example/sign-in')).toBe('/sign-in/y');
  });

  it('the check opens check.url, else the first page\'s "/"', () => {
    expect(resolveCheckUrl({ pages: ['shop'] }, pages)).toBe('http://localhost:4404/app/');
    expect(resolveCheckUrl({ pages: ['shop'], check: { url: '/quotes' } }, pages)).toBe('http://localhost:4404/app/quotes');
    expect(resolveCheckUrl({ pages: [], check: { url: 'console:/products' } }, pages)).toBe('http://localhost:4403/products');
    expect(resolveCheckUrl({ pages: [], check: { url: 'https://x.example.com/me' } }, pages)).toBe('https://x.example.com/me');
  });
});

describe('which persona films each page (R-AUTH-01, static plan)', () => {
  const p = project();
  const personas = resolvePersonas(p, 'signed-in', { home: '/h' });
  const envPages = p.config.environments['signed-in'];
  const plan = (s: Scenario, extra: Partial<Parameters<typeof planPersonas>[1]> = {}) => planPersonas(s, { env: 'signed-in', envPages, personas, hooks: true, ...extra });

  it('pages take the persona whose `pages` list their environment page; tabs inherit; hook tabs too', () => {
    const s = scenario([
      'setup:',
      '  - js: {page: console, code: "return 1"}',
      'scenes:',
      '  - id: a',
      '    page: shop',
      '    open: /',
      '    steps:',
      '      - new_tab: {href: /quotes, as: quotes}',
      '      - switch_page: main',
      '      - open: {url: /products, page: shop}',
      '  - id: b',
      '    steps: [{wait: 1}]',
    ]);
    const r = plan(s);
    expect([...r.pages]).toEqual([
      ['shop', 'buyer'],
      ['quotes', 'buyer'],
      ['console', 'supplier'],
    ]);
    expect([...r.hookPages]).toEqual([['console', 'supplier']]);
    expect(r.used).toEqual(['supplier', 'buyer']);
    expect(r.needsDefault).toBe(false);
    expect(r.issues).toEqual([]);
    // Hooks skipped (a dry run): the hook tab needs no persona; --until: later steps are not walked.
    expect([...plan(s, { hooks: false, until: { sceneIndex: 0, stepIndex: 0 } }).pages.keys()]).toEqual(['shop', 'quotes']);
    expect(plan(s, { hooks: false, until: { sceneIndex: 0, stepIndex: 0 } }).used).toEqual(['buyer']);
  });

  it('multi-page scenes bind each page (`pages.<id>.persona`, env key from `open`, absolute URLs by origin); none = no persona', () => {
    const s = scenario([
      'scenes:',
      '  - id: both',
      '    pages:',
      '      buyer: {open: "shop:/products"}',
      '      supplier: {open: "http://localhost:4403/quotes"}',
      '    steps: [{wait: 1}]',
      '  - id: guest',
      '    pages:',
      '      visitor: {open: "shop:/", persona: none}',
      '      second-buyer: {open: "shop:/quotes", persona: buyer}',
      '    steps: [{wait: 1}]',
      '  - id: skipped',
      '    skip: true',
      '    page: console',
      '    persona: buyer',
      '    steps: [{wait: 1}]',
    ]);
    const r = plan(s);
    expect([...r.pages]).toEqual([
      ['buyer', 'buyer'],
      ['supplier', 'supplier'],
      ['visitor', null],
      ['second-buyer', 'buyer'],
    ]);
    expect([...r.none]).toEqual(['visitor']);
    expect(r.needsDefault).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('`persona: none` holds for a later scene on a page filmed without one, and for the tabs a none page opens (never guarded)', () => {
    const s = scenario([
      'scenes:',
      '  - id: a',
      '    page: shop',
      '    persona: none',
      '    open: /',
      '    steps:',
      '      - new_tab: {href: /sign-in, as: help}',
      '      - new_tab: {href: /quotes}',
      '  - id: b',
      '    page: console',
      '    open: /',
      '    steps: [{new_tab: {href: /quotes, as: mine}}]',
      '  - id: c',
      '    page: mine',
      '    persona: none',
      '    steps: [{wait: 1}]',
    ]);
    const r = plan(s);
    expect([...r.pages]).toEqual([
      ['shop', null],
      ['help', null],
      ['tab2', null],
      ['console', 'supplier'],
      ['mine', 'supplier'],
    ]);
    expect([...r.none]).toEqual(['shop', 'help', 'tab2']);
    // A tab of a persona page written `persona: none` later is a conflict (it keeps its persona).
    expect(r.issues.map((i) => i.kind)).toEqual(['conflict']);
    const later = plan(scenario(['scenes:', '  - id: a', '    page: shop', '    persona: none', '    steps: [{new_tab: {href: /x, as: t}}]', '  - id: b', '    page: t', '    persona: none', '    steps: [{wait: 1}]']));
    expect(later.issues).toEqual([]);
    expect([...later.none]).toEqual(['shop', 't']);
    const unbound = plan(scenario(['scenes:', '  - id: a', '    page: other', '    steps: [{wait: 1}]', '  - id: b', '    page: other', '    persona: none', '    steps: [{wait: 1}]']));
    expect([...unbound.none]).toEqual(['other']);
  });

  it('switch_page: previous follows the page history (closed pages aside): a tab opened there takes that page\'s persona', () => {
    const s = scenario([
      'scenes:',
      '  - id: a',
      '    page: console',
      '    open: /products',
      '    steps:',
      '      - switch_page: shop',
      '      - switch_page: previous',
      '      - new_tab: {href: /quotes, as: t}',
      '      - switch_page: {to: shop, close_current: true}',
      '      - switch_page: previous',
      '      - new_tab: {href: /x, as: u}',
    ]);
    const r = plan(s);
    expect(r.pages.get('t')).toBe('supplier');
    // t was closed when leaving it: "previous" is console again.
    expect(r.pages.get('u')).toBe('supplier');
    const m = plan(scenario(['scenes:', '  - id: a', '    pages: [console, shop]', '    steps: [{on: shop, wait: 1}]', '  - id: b', '    page: console', '    steps: [{switch_page: previous}, {new_tab: {href: /q, as: q}}]']));
    expect(m.pages.get('q')).toBe('buyer');
  });

  it('a js hook tab takes the persona its page is filmed with (none included), else its default', () => {
    const s = scenario([
      'setup:',
      '  - js: {page: shop, code: "return 1"}',
      '  - js: {page: console, code: "return 1"}',
      'scenes:',
      '  - id: a',
      '    page: shop',
      '    persona: none',
      '    open: /',
      '    steps: [{wait: 1}]',
    ]);
    const r = plan(s);
    expect([...r.hookPages]).toEqual([
      ['shop', null],
      ['console', 'supplier'],
    ]);
    // The buyer films nothing: it is not checked by the preflight.
    expect(r.used).toEqual(['supplier']);
    const as = plan(scenario(['setup:', '  - js: {page: shop, code: "return 1"}', 'scenes:', '  - id: a', '    page: shop', '    persona: supplier', '    steps: [{wait: 1}]']));
    expect([...as.hookPages]).toEqual([['shop', 'supplier']]);
    expect(as.used).toEqual(['supplier']);
  });

  it('a page keeps one persona for the run; unknown personas and `persona` on a multi-page scene are reported', () => {
    const s = scenario([
      'scenes:',
      '  - id: a',
      '    page: console',
      '    open: /',
      '    steps: [{wait: 1}]',
      '  - id: b',
      '    page: console',
      '    persona: buyer',
      '    steps: [{wait: 1}]',
      '  - id: c',
      '    page: shop',
      '    persona: buyr',
      '    steps: [{wait: 1}]',
      '  - id: d',
      '    persona: buyer',
      '    pages: [shop, console]',
      '    steps: [{wait: 1}]',
    ]);
    expect(plan(s).issues).toEqual([
      {
        path: ['scenes', 1, 'persona'],
        kind: 'conflict',
        message:
          'page "console" is filmed as supplier since scenes[0].page and as buyer here: a page keeps one persona for the whole run — film the other account on a page id of its own (a multi-page scene\'s `pages`)',
      },
      { path: ['scenes', 2, 'persona'], kind: 'unknown', message: 'persona "buyr" is not declared for environment "signed-in" (personas: supplier, buyer; or none)' },
      { path: ['scenes', 3, 'persona'], kind: 'placement', message: 'a multi-page scene binds each page: write `persona` on the page (`pages.<id>.persona`)' },
    ]);
  });

  it('one page, several personas (hotfix v0.2.2): the project validates; the first one declared is the page’s default, `persona:` names another, two page ids film both', () => {
    const text = ['name: N', 'environments:', '  local: {admin: "http://localhost:4810"}', 'auth:', '  login_url: /login', '  personas:', '    owner: {pages: [admin]}', '    staff: {pages: [admin]}'].join('\n');
    expect(parseProjectYaml(text).issues.filter((i) => i.severity === 'error')).toEqual([]);
    const shared = project(text.split('\n'));
    const opts = { env: 'local', envPages: shared.config.environments.local, personas: resolvePersonas(shared, 'local', { home: '/h' }), hooks: true };
    const byDefault = planPersonas(scenario(['scenes:', '  - id: a', '    page: admin', '    open: /', '    steps: [{wait: 1}]']), opts);
    expect([...byDefault.pages]).toEqual([['admin', 'owner']]);
    const named = planPersonas(scenario(['scenes:', '  - id: a', '    page: admin', '    persona: staff', '    open: /', '    steps: [{wait: 1}]']), opts);
    expect([...named.pages]).toEqual([['admin', 'staff']]);
    expect(named).toMatchObject({ used: ['staff'], issues: [] });
    const both = planPersonas(scenario(['scenes:', '  - id: a', '    pages:', '      theirs: {page: admin, open: /}', '      ours: {page: admin, persona: staff, open: /}', '    steps: [{wait: 1}]']), opts);
    expect([...both.pages]).toEqual([
      ['theirs', 'owner'],
      ['ours', 'staff'],
    ]);
    expect(both.issues).toEqual([]);
  });

  it('an environment without personas binds nothing (persona keys are ignored); the legacy form binds every page to default', () => {
    const s = scenario(['scenes:', '  - id: a', '    page: shop', '    persona: buyer', '    open: /', '    steps: [{new_tab: {href: /x}}]']);
    const none = planPersonas(s, { env: 'local', envPages: p.config.environments.local, personas: [], hooks: true });
    expect(none).toMatchObject({ used: [], needsDefault: true, issues: [] });
    expect(none.pages.size).toBe(0);
    const legacy = project(['name: N', 'environments:', '  local: {shop: "http://localhost:4402"}', 'auth: {profile: /p}']);
    const r = planPersonas(scenario(['scenes:', '  - id: a', '    page: shop', '    open: /', '    steps: [{new_tab: {href: /x}}]']), {
      env: 'local',
      envPages: legacy.config.environments.local,
      personas: resolvePersonas(legacy, 'local', { home: '/h' }),
      hooks: true,
    });
    expect([...r.pages]).toEqual([
      ['shop', 'default'],
      ['tab2', 'default'],
    ]);
    expect(r.used).toEqual(['default']);
  });
});

describe('validation (R-AUTH-01, R-AUTH-02)', () => {
  it('the fixture-like project is clean', () => {
    expect(errs(project().issues ?? [])).toEqual([]);
    expect(warns(project().issues ?? [])).toEqual([]);
  });

  it('reports persona paths, mixed forms, names, pages, patterns, checks and login steps', () => {
    const text = [
      'name: N',
      'environments:',
      '  local: {console: "http://localhost:4401", shop: "http://localhost:4402"}',
      '  staging: {console: "https://console.example.com"}',
      'vars: {who: Maja}',
      'auth:',
      '  local:',
      '    profile: ~/profiles/x',
      '    personas: {a: {pages: [console]}}',
      '  staging:',
      '    login_url: ["/sign-in?next=x", "auth:/login", {regex: "("}, "/log(in)+"]',
      '    personas:',
      '      none: {pages: [console]}',
      '      Admin: {check: {url: "consol:/"}}',
      '      admin:',
      '        pages: [console, shop]',
      '        login:',
      '          - type: {into: {label: Password}, text: hunter22}',
      '          - type: {into: {label: Email}, text: "{{vars.who}}@example.com"}',
      '          - open: "{{hooks.token.json}}"',
      '          - wait_for: "{{vars.nobody}}"',
      '      other: {pages: [console]}',
    ].join('\n');
    const { issues } = parseProjectYaml(text);
    expect(errs(issues)).toEqual([
      'auth.local.personas: `profile` (one account) and `personas` cannot be mixed: name the account as a persona and remove `profile`',
      'auth.staging.login_url.1: "auth:" is not an environment page (pages: console)',
      'auth.staging.login_url.2.regex: invalid regular expression: Invalid regular expression: /(/: Unterminated group',
      'auth.staging.personas.none: "none" is reserved (`persona: none` films a page without any persona): pick another name',
      'auth.staging.personas.Admin.check.url: "consol:" is not an environment page (did you mean "console"?) (pages: console)',
      'auth.staging.personas.admin: persona "admin" differs from "Admin" only by case (their session folders would be the same on macOS)',
      'auth.staging.personas.admin.pages.1: unknown page "shop" (environment staging: console)',
      'auth.staging.personas.admin.login.2.open: {{hooks.token.json}} is not available in login steps: they run before the setup hooks',
      'auth.staging.personas.admin.login.3.wait_for: unknown variable {{vars.nobody}}; declared: who',
    ]);
    expect(warns(issues)).toEqual([
      'auth.local.personas.a: persona "a" has no `check` and no `login_url`: an expired session is only noticed when a step fails (add check: {url, expect_text})',
      'auth.staging.login_url.0: "/sign-in?next=x": the query string and fragment of a URL are never matched (sign-in patterns look at its origin + path)',
      'auth.staging.login_url.3: "/log(in)+" is matched as a path prefix, not as a regular expression: write {regex: "…"} for one',
      'auth.staging.personas.admin.login.0.type.text: a password written in project.yaml: use {{env:VAR}} or {{keychain:service/account}}',
    ]);
  });

  it('sign-in patterns that match every page, or can never match, are reported', () => {
    const text = [
      'name: N',
      'environments:',
      '  local: {console: "http://localhost:4401", shop: "http://localhost:4402/app"}',
      'auth:',
      '  login_url:',
      '    - /',
      '    - "console:"',
      '    - "shop:/"',
      '    - http://localhost:4402',
      '    - {regex: ".*"}',
      '    - {regex: "sign-in", flags: g}',
      '    - {regex: "sign-in", flags: iy}',
      '    - {regex: "^/login"}',
      '    - /sign-in/i',
      '    - "shop:/sign-in"',
      '    - https://sso.example.com',
      '    - /sign-in/',
      '    - {regex: "^https?://[^/]+/login"}',
      '  personas: {admin: {pages: [console], check: {url: "console:/"}}}',
    ].join('\n');
    const { issues } = parseProjectYaml(text);
    const every = 'every run would stop on its first page as "landed on the sign-in page"';
    expect(errs(issues)).toEqual([
      `auth.login_url.0: "/" matches every page: ${every} — write the sign-in page's own path ("/sign-in")`,
      `auth.login_url.1: "console:" matches every page of "console": ${every} — write the sign-in page's own path ("/sign-in")`,
      `auth.login_url.2: "shop:/" matches every page of "shop": ${every} — write the sign-in page's own path ("/sign-in")`,
      `auth.login_url.3: "http://localhost:4402" matches every page of "shop" (http://localhost:4402/app): ${every} — write the sign-in page's own path ("/sign-in")`,
      `auth.login_url.4.regex: /.*/ matches any URL: ${every}`,
      'auth.login_url.5.flags: flags "g" and "y" make a regular expression remember where it stopped (it would match one URL in two, or only at the start): leave them out',
      'auth.login_url.6.flags: flags "g" and "y" make a regular expression remember where it stopped (it would match one URL in two, or only at the start): leave them out',
    ]);
    expect(warns(issues)).toEqual([
      'auth.login_url.7.regex: /^/login/ never matches: a sign-in regex is tested against the origin + path ("http://host/sign-in") — write "^https?://[^/]+/…", or leave out the "^"',
      'auth.login_url.8: "/sign-in/i" is matched as a path prefix, not as a regular expression /…/flags: write {regex: "…", flags: "…"} for one',
    ]);
  });

  it('a persona never takes a path: profile / storage_state inside one are explained', () => {
    const { issues } = parseProjectYaml(['name: N', 'environments: {local: {app: "http://localhost:1"}}', 'auth: {personas: {admin: {profile: ~/p, check: {url: /}}}}'].join('\n'));
    expect(errs(issues)).toEqual([
      'auth.personas.admin: unknown key "profile"',
      "auth.personas.admin.profile: a persona's session is never a path in project.yaml (it would only exist on this computer): `retake login` keeps it in ~/.retake/profiles/<project>/<env>/admin (RETAKE_HOME moves it) — remove `profile`",
    ]);
  });

  it('a persona with no check and no sign-in pattern is warned about; an environment named like an auth key is refused', () => {
    const { issues } = parseProjectYaml(['name: N', 'environments: {personas: {app: "http://localhost:1"}}', 'auth: {personas: {admin: {pages: [app]}}}'].join('\n'));
    expect(errs(issues)).toEqual(['environments.personas: environment name "personas" is also an `auth` key (profile, storage_state, login_url, personas): rename the environment']);
    expect(warns(issues)).toEqual([
      'auth.personas.admin: persona "admin" has no `check` and no `login_url`: an expired session is only noticed when a step fails (add check: {url, expect_text})',
    ]);
  });

  it('scenarios: persona names (any environment) and one persona per page (each environment with personas)', () => {
    const p = project();
    const { issues } = parseScenario(
      [
        'video: demo',
        'scenes:',
        '  - id: a',
        '    page: console',
        '    persona: suplier',
        '    open: /',
        '    steps: [{wait: 1}]',
        '  - id: b',
        '    pages:',
        '      console: {open: "console:/", persona: buyer}',
        '      guest: {open: "shop:/", persona: none}',
        '    persona: supplier',
        '    steps: [{wait: 1}]',
        '  - id: c',
        '    page: shop',
        '    open: /',
        '    steps: [{wait: 1}]',
        '  - id: d',
        '    page: shop',
        '    persona: supplier',
        '    steps: [{wait: 1}]',
        '',
      ].join('\n'),
      { files: NO_DISK, project: p },
    );
    expect(errs(issues)).toEqual([
      'scenes.0.persona: unknown persona "suplier" (did you mean "supplier"?) (personas: supplier, buyer; or none)',
      'scenes.1.persona: a multi-page scene binds each page: write `persona` on the page (`pages.<id>.persona`)',
      'scenes.3.persona: page "shop" is filmed as buyer since scenes[2].page and as supplier here: a page keeps one persona for the whole run — film the other account on a page id of its own (a multi-page scene\'s `pages`) (environment signed-in)',
    ]);
    const bare = parseScenario(['video: demo', 'scenes:', '  - id: a', '    page: console', '    persona: x', '    open: /', '    steps: [{wait: 1}]', ''].join('\n'), {
      files: NO_DISK, project: project(['name: N', 'environments: {local: {console: "http://localhost:1"}}']),
    });
    expect(errs(bare.issues)).toEqual(['scenes.0.persona: unknown persona "x": project "northfield" declares no personas (auth.personas in project.yaml)']);
  });
});
