/**
 * Hotfix v0.2.3 (field feedback, hooks of a sandbox): in a sandbox environment a hook reads `{{compose_env:NAME}}` (the
 * sandbox's compose env file) and `{{accounts.<persona>.username|password}}` (its sandbox.yaml accounts), both masked
 * like any secret and kept in template form in a rollback's journal entry; `auth: {persona}` on an http hook sends the
 * persona's session (HookContext.personaAuth) as `Authorization` / `Cookie`, masked too. Elsewhere both are refused
 * with what to write instead.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PERSON_POLICY, resolveEnvironment } from '@retake/core';
import { loadProject } from '@retake/core/io';
import type { HookStep, LoadedProject } from '@retake/core';
import { Journal, runHooks } from '@retake/hooks';
import type { HookContext } from '@retake/hooks';
import { startApi, tempProject } from './helpers.js';

let api: Awaited<ReturnType<typeof startApi>>;
let tmp: Awaited<ReturnType<typeof tempProject>>;

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  tmp = await tempProject('retake-sandbox-refs-');
  api.requests.length = 0;
  api.replies.clear();
});
afterEach(async () => {
  await tmp.cleanup();
});

const PASSWORD = 'pw-buyer-7f3k';
const API_KEY = 'key-console-91xq';

/** A project whose docker-compose sandbox `stage` serves the test API as its `console` page, with two accounts. */
async function sandboxProject(): Promise<LoadedProject> {
  const dir = tmp.dir;
  await mkdir(join(dir, 'sandbox'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), ['name: Sandbox refs test', 'environments:', '  local: {console: "http://localhost:9"}', 'sandboxes:', '  stage: sandbox/sandbox.yaml', ''].join('\n'));
  await writeFile(join(dir, 'sandbox', 'compose.yaml'), 'services:\n  console:\n    image: busybox\n');
  await writeFile(join(dir, 'sandbox', '.env'), `DEMO_BUYER_PASSWORD=${PASSWORD}\nCONSOLE_API_KEY=${API_KEY}\nEMPTY=\n`);
  await writeFile(
    join(dir, 'sandbox', 'sandbox.yaml'),
    [
      'version: 1',
      'provider: docker-compose',
      'login_url: /sign-in',
      'accounts:',
      '  buyer:',
      '    pages: [console]',
      '    username: orders@example.com',
      '    password: "{{compose_env:DEMO_BUYER_PASSWORD}}"',
      '    login: [{open: "console:/sign-in"}, {type: {into: {label: Password}, text: "{{account.password}}"}}]',
      '  admin:',
      '    pages: [console]',
      '    username: admin@example.com',
      '    password: plain-admin-pw',
      '    login: [{open: "console:/sign-in"}]',
      'services:',
      `  console: {url: "${api.base}", health: false, pages: {console: "${api.base}"}}`,
      '',
    ].join('\n'),
  );
  return loadProject(dir);
}

function contextOf(project: LoadedProject, env: string, over: Partial<HookContext> = {}): { ctx: HookContext; text: () => string } {
  const logs: string[] = [];
  const ctx: HookContext = { project, policy: PERSON_POLICY, env: resolveEnvironment(project, env), vars: {}, saved: {}, log: (level, msg) => logs.push(`${level} ${msg}`), ...over };
  return { ctx, text: () => logs.join('\n') };
}

describe('sandbox references in hooks (hotfix v0.2.3)', () => {
  it('resolves {{compose_env:NAME}} and {{accounts.<persona>.…}} in a sandbox environment, masked everywhere', async () => {
    const project = await sandboxProject();
    const { ctx, text } = contextOf(project, 'stage');
    const journal = await Journal.open(join(tmp.dir, 'runs/r1/hooks-journal.json'));
    const hook: HookStep = {
      name: 'sign in',
      http: {
        method: 'POST',
        url: '{{console}}/api/replies?key={{compose_env:CONSOLE_API_KEY}}',
        headers: { 'x-api-key': '{{ compose_env:CONSOLE_API_KEY }}' },
        json: { text: '{{accounts.buyer.username}} {{accounts.buyer.password}} {{accounts.admin.password}}' },
        save_as: 'session',
        rollback: { method: 'DELETE', url: '{{console}}/api/replies/{{response.json.id}}', headers: { 'x-pw': '{{accounts.buyer.password}}' } },
      },
    };
    const res = await runHooks([hook], ctx, { phase: 'setup', journal });
    expect(res.ok, JSON.stringify(res.results)).toBe(true);
    const sent = api.requests[0];
    expect(sent.headers['x-api-key']).toBe(API_KEY);
    expect(JSON.parse(sent.body)).toEqual({ text: `orders@example.com ${PASSWORD} plain-admin-pw` });
    // Never in what a person reads: the result, the logs, the saved response, the journal.
    const shown = JSON.stringify(res.results) + text();
    for (const v of [PASSWORD, API_KEY, 'plain-admin-pw']) expect(shown).not.toContain(v);
    expect(res.results[0].description).toContain('key=***');
    const file = await readFile(join(tmp.dir, 'runs/r1/hooks-journal.json'), 'utf8');
    expect(file).not.toContain(PASSWORD);
    expect(file).toContain('{{accounts.buyer.password}}');
    // The rollback reads the account again when it replays.
    const replay = contextOf(project, 'stage');
    const rolled = await (await Journal.open(join(tmp.dir, 'runs/r1/hooks-journal.json'))).rollbackAll(replay.ctx);
    expect(rolled[0]).toMatchObject({ ok: true });
    expect(api.requests[1].headers['x-pw']).toBe(PASSWORD);
    expect(api.replies.size).toBe(0);
  });

  it('a dry run checks the names and prints no value', async () => {
    const project = await sandboxProject();
    const { ctx, text } = contextOf(project, 'stage', { dryRun: true });
    const journal = await Journal.open(join(tmp.dir, 'runs/r2/hooks-journal.json'));
    const ok = await runHooks([{ http: { method: 'POST', url: '{{console}}/api/replies', json: { a: '{{compose_env:CONSOLE_API_KEY}}', b: '{{accounts.buyer.password}}' } } }], ctx, {
      phase: 'setup',
      journal,
    });
    expect(ok.ok).toBe(true);
    expect(JSON.stringify(ok.results) + text()).not.toContain(API_KEY);
    expect(JSON.stringify(ok.results) + text()).not.toContain(PASSWORD);
    expect(api.requests).toHaveLength(0);
    const missing = await runHooks([{ http: { url: '{{console}}/text?k={{compose_env:NOPE}}' } }], ctx, { phase: 'teardown', journal });
    expect(missing.results[0].error).toContain('{{compose_env:NOPE}}: NOPE is not set (or empty) in the compose env file');
    const empty = await runHooks([{ http: { url: '{{console}}/text?k={{compose_env:EMPTY}}' } }], ctx, { phase: 'teardown', journal });
    expect(empty.results[0].error).toContain('EMPTY is not set (or empty)');
  });

  it('says what is wrong: not a sandbox, an unknown account, an unknown field', async () => {
    const project = await sandboxProject();
    const journal = await Journal.open(join(tmp.dir, 'runs/r3/hooks-journal.json'));
    const run = async (env: string, url: string) => (await runHooks([{ http: { url } }], contextOf(project, env).ctx, { phase: 'teardown', journal })).results[0].error;
    expect(await run('local', '{{console}}/text?k={{compose_env:CONSOLE_API_KEY}}')).toContain('environment "local" is not a sandbox (there, a secret is {{env:VAR}} or {{keychain:service/account}})');
    expect(await run('local', '{{console}}/text?k={{accounts.buyer.password}}')).toContain('reads an account of a sandbox: environment "local" is not a sandbox');
    expect(await run('stage', '{{console}}/text?k={{accounts.seller.password}}')).toContain('sandbox stage has no account "seller" (accounts: buyer, admin)');
    expect(await run('stage', '{{console}}/text?k={{accounts.buyer.token}}')).toContain('{{accounts.<persona>.username}} or {{accounts.<persona>.password}}');
    expect(api.requests).toHaveLength(0);
  });
});

describe('auth: {persona} on an http hook (hotfix v0.2.3)', () => {
  const TOKEN = 'eyJhbGciOi.idtoken-of-buyer.sig';

  it("sends the persona's session as Authorization and Cookie, masked, and says who it acts as", async () => {
    const project = await sandboxProject();
    const asked: Array<{ persona: string; url: string }> = [];
    const { ctx, text } = contextOf(project, 'stage', {
      personaAuth: async (persona, url) => {
        asked.push({ persona, url });
        return { authorization: `Bearer ${TOKEN}`, cookie: 'sid=cookie-value-123; theme=dark' };
      },
    });
    const journal = await Journal.open(join(tmp.dir, 'runs/r4/hooks-journal.json'));
    const res = await runHooks(
      [
        {
          http: {
            method: 'POST',
            url: '{{console}}/api/replies',
            auth: { persona: 'buyer' },
            json: { text: 'hello' },
            rollback: { method: 'DELETE', url: '{{console}}/api/replies/{{response.json.id}}', auth: { persona: 'admin' } },
          },
        },
      ],
      ctx,
      { phase: 'setup', journal },
    );
    expect(res.ok, JSON.stringify(res.results)).toBe(true);
    expect(asked).toEqual([{ persona: 'buyer', url: `${api.base}/api/replies` }]);
    expect(api.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(api.requests[0].headers.cookie).toBe('sid=cookie-value-123; theme=dark');
    expect(res.results[0].description).toBe(`http POST ${api.base}/api/replies as buyer`);
    const shown = JSON.stringify(res.results) + text() + (await readFile(join(tmp.dir, 'runs/r4/hooks-journal.json'), 'utf8'));
    expect(shown).not.toContain('idtoken-of-buyer');
    expect(shown).not.toContain('cookie-value-123');
    // The rollback acts as its own persona, asked for when it replays.
    const rolled = await journal.rollbackAll(ctx);
    expect(rolled[0]).toMatchObject({ ok: true });
    expect(asked[1]).toMatchObject({ persona: 'admin' });
  });

  it('refuses: an unknown persona, an Authorization header beside it, no session here, a seed, a session with nothing to send', async () => {
    const project = await sandboxProject();
    const journal = await Journal.open(join(tmp.dir, 'runs/r5/hooks-journal.json'));
    const withSession = contextOf(project, 'stage', { personaAuth: async () => ({ authorization: `Bearer ${TOKEN}` }) }).ctx;
    const err = async (ctx: HookContext, http: Record<string, unknown>, phase: 'teardown' | 'seed' = 'teardown') =>
      (await runHooks([{ http: { url: '{{console}}/text', ...http } } as HookStep], ctx, { phase, journal })).results[0].error;
    expect(await err(withSession, { auth: { persona: 'seller' } })).toContain('persona "seller" is not declared for environment "stage" (personas: buyer, admin)');
    expect(await err(withSession, { auth: { persona: 'buyer' }, headers: { Authorization: 'Bearer x' } })).toContain('sets the Authorization header from the persona');
    expect(await err(contextOf(project, 'stage').ctx, { auth: { persona: 'buyer' } })).toContain('needs the saved session of the persona, and none exists here');
    expect(await err(withSession, { auth: { persona: 'buyer' } }, 'seed')).toContain('not available in a sandbox seed');
    const empty = contextOf(project, 'stage', { personaAuth: async () => ({}) }).ctx;
    expect(await err(empty, { auth: { persona: 'buyer' } })).toContain('holds nothing to send');
    expect(api.requests).toHaveLength(0);
  });

  it("through MCP a persona's session goes only to that persona's own pages: same origin sent, another origin refused before anything is read or sent; a person's run unchanged", async () => {
    const project = await sandboxProject();
    const journal = await Journal.open(join(tmp.dir, 'runs/r6/hooks-journal.json'));
    const asked: string[] = [];
    const session = { personaAuth: async (_p: string, url: string) => (asked.push(url), { authorization: `Bearer ${TOKEN}` }) };
    const elsewhere = api.base.replace('127.0.0.1', 'localhost');
    const run = async (ctx: HookContext, url: string) => (await runHooks([{ http: { url, auth: { persona: 'buyer' } } } as HookStep], ctx, { phase: 'teardown', journal })).results[0];
    const agent = contextOf(project, 'stage', { trust: 'mcp', ...session }).ctx;
    // Same origin as the persona's page (console): sent with its token.
    expect((await run(agent, '{{console}}/text')).ok).toBe(true);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    // Another origin: refused, naming the persona and the rule; no session read, no request made.
    const refused = await run(agent, `${elsewhere}/text`);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/http hook acting as persona buyer .* sends its session only to that persona's own pages \(http:\/\/127\.0\.0\.1:\d+\): http:\/\/localhost:\d+ is not one of them/);
    expect(asked).toEqual([`${api.base}/text`]);
    expect(api.requests).toHaveLength(1);
    // A person's own run (no trust `mcp`): the request goes as written.
    const person = contextOf(project, 'stage', session).ctx;
    expect((await run(person, `${elsewhere}/text`)).ok).toBe(true);
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
});
