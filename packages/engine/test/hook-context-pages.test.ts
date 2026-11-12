/**
 * The js hooks' pages and an http hook's persona auth outside a capture (engine hooks.ts createHookContext), on the
 * in-memory capture runner's pages: which persona a page's tab is signed in as (one browser per persona, opened on first
 * use, shared with its http auth, closed by closeSessions), the words of a saved session that cannot be used and of a
 * tab that lands on the sign-in page, and the persona-origin rule (hotfix v0.2.3 / v0.2.4): under trust `mcp` an http
 * hook's `auth: {persona}` reaches that persona's own pages only; a person's own command (trust `author`) any URL. The
 * real browser's side is the capture sessions contract (capture-sessions.test.ts) and the CLI's auth.test.ts.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_CAPTURE, PERSON_POLICY } from '@retake/core';
import type { HookTrust, LoadedProject } from '@retake/core';
import { createHookContext } from '../src/index.js';
import { MemoryHookPages } from '../src/capture/memory-sessions.js';

const root = await mkdtemp(join(tmpdir(), 'retake-hook-pages-'));
afterAll(() => rm(root, { recursive: true, force: true }));

const APP = 'http://127.0.0.1:4901';
const SHOP = 'http://127.0.0.1:4902';
const DOCS = 'http://127.0.0.1:4903';

async function project(): Promise<LoadedProject> {
  const dir = join(root, 'northfield');
  await mkdir(dir, { recursive: true });
  return {
    slug: 'northfield',
    dir,
    root,
    file: join(dir, 'project.yaml'),
    readme: null,
    scenarios: [],
    config: {
      name: 'Northfield',
      environments: { test: { app: APP, shop: SHOP, docs: DOCS } },
      capture: { ...DEFAULT_CAPTURE },
      frame: 'card',
      template: 'default',
      auth: { login_url: '/sign-in', personas: { ada: { pages: ['app'] }, ben: { pages: ['shop'] } } },
    },
  } as LoadedProject;
}

async function context(pages: MemoryHookPages, trust?: HookTrust) {
  return createHookContext(await project(), {
    policy: PERSON_POLICY,
    env: 'test',
    log: () => undefined,
    loginCommand: (p) => `retake login ${p.project} --env ${p.env}${p.persona ? ` --persona ${p.persona}` : ''}`,
    ...(trust ? { trust } : {}),
    pages,
  });
}

describe('js hooks outside a capture: their pages', () => {
  it("a page's tab is signed in as the persona whose pages list it (nobody for another page); one browser per persona, closed by closeSessions", async () => {
    const pages = new MemoryHookPages({ evaluate: (_code, at) => `${at.page}:${at.persona ?? 'nobody'}` });
    const { ctx, closeSessions } = await context(pages);
    expect(await ctx.evalInPage!('app', 'return 1')).toBe('app:ada');
    expect(await ctx.evalInPage!('shop', 'return 1')).toBe('shop:ben');
    expect(await ctx.evalInPage!('docs', 'return 1')).toBe('docs:nobody');
    // The environment's first page when none is named: ada's, in the browser already open.
    expect(await ctx.evalInPage!(undefined, 'return 1')).toBe('app:ada');
    expect(pages.opened.map((b) => b.persona)).toEqual(['ada', 'ben', undefined]);
    expect(pages.opened[0].ran.map((r) => r.page)).toEqual(['app', 'app']);
    // A persona's browser is opened on a copy of its session, with the words of a session that cannot be used.
    expect(pages.opened[0].options).toMatchObject({ persona: { name: 'ada' }, failure: 'js hooks cannot use the saved session of persona ada:', policy: PERSON_POLICY });
    expect(pages.opened[2].options.persona).toBeUndefined();
    expect(pages.opened[2].options.failure).toBeUndefined();
    expect(pages.opened.every((b) => !b.closed)).toBe(true);
    await closeSessions();
    expect(pages.opened.every((b) => b.closed)).toBe(true);
  });

  it("a tab that lands on its persona's sign-in page fails with the command that signs it in again", async () => {
    const pages = new MemoryHookPages({ landing: (page, _p, url) => (page === 'app' ? `${url}/sign-in?next=%2F` : url) });
    const { ctx, closeSessions } = await context(pages);
    await expect(ctx.evalInPage!('app', 'return 1')).rejects.toThrow(
      `js hook page "app" (persona ada) landed on the sign-in page (${APP}/sign-in): its session expired — sign in again: retake login northfield --env test --persona ada`,
    );
    await closeSessions();
  });
});

describe("an http hook's `auth: {persona}` outside a capture", () => {
  it("trust mcp: the persona's session reaches its own pages only — refused elsewhere before its browser opens", async () => {
    const pages = new MemoryHookPages({ cookies: { ada: 'sid=ada-session' } });
    const { ctx, closeSessions } = await context(pages, 'mcp');
    await expect(ctx.personaAuth!('ada', `${SHOP}/api/orders`)).rejects.toThrow(
      /an http hook acting as persona ada \(`auth: \{persona\}`\) sends its session only to that persona's own pages \(http:\/\/127\.0\.0\.1:4901\)/,
    );
    expect(pages.opened).toEqual([]);
    expect(await ctx.personaAuth!('ada', `${APP}/api/orders`)).toEqual({ cookie: 'sid=ada-session' });
    // The browser its js hooks would use: one, opened on first read.
    expect(pages.opened.map((b) => b.persona)).toEqual(['ada']);
    expect(await ctx.evalInPage!('app', 'return 1')).toBeUndefined();
    expect(pages.opened).toHaveLength(1);
    await closeSessions();
  });

  it("a person's own command (trust author): any URL; an undeclared persona is refused", async () => {
    const pages = new MemoryHookPages({ cookies: { ada: 'sid=ada-session' } });
    const { ctx, closeSessions } = await context(pages);
    expect(await ctx.personaAuth!('ada', `${SHOP}/api/orders`)).toEqual({ cookie: 'sid=ada-session' });
    await expect(ctx.personaAuth!('carl', `${APP}/`)).rejects.toMatchObject({ code: 'invalid', message: 'persona "carl" is not declared for environment "test" (personas: ada, ben)' });
    await closeSessions();
  });
});
