/**
 * The recorder's alternative targets (L4.8, kit 1.6.0, R-UI-21): at a press, a keyboard activation, typing, a native
 * select or a file, the element's event carries up to three other targets verified at that moment — each resolving once
 * to the element the suggestion names (re-checked in the window), never positional, never for a secret field — within
 * their own in-page budget (none, said partial, when it is spent or the page is large). The window is played by
 * Playwright input (trusted), headless, on the fixture's recording lab; the in-page cost of a press with and without
 * them is measured (p50 / p95 of each press's `ms`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright-core';
import { RecordedEventSchema, resolveEnvironment } from '@demo-studio/core';
import type { RecordedEvent } from '@demo-studio/core';
import { kitConfigFor, kitSource, recordSession } from '../src/index.js';
import type { RecordSessionOptions, RecordSessionResult } from '../src/index.js';
import { makeProject, tempDir } from './helpers.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

let fixture: Fixture;
let dir: string;
let home: string;

beforeAll(async () => {
  home = await tempDir('ds-record-alt-home-');
  process.env.DEMO_STUDIO_HOME = home;
  const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
    startFixture(o: { consolePort: number; shopPort: number; host: string; auth: { consolePort: number; shopPort: number } }): Promise<Fixture>;
  };
  fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1', auth: { consolePort: 0, shopPort: 0 } });
  dir = await tempDir('rw-record-alt-');
}, 60_000);

afterAll(async () => {
  await fixture?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  if (home) await rm(home, { recursive: true, force: true });
});

type WithEl = Extract<RecordedEvent, { el: unknown }>;
type Pointer = Extract<RecordedEvent, { kind: 'pointer' }>;

/** Record with `drive` playing the person (the events seen live are passed to it); the window closes after it. */
async function record(drive: (page: Page, seen: RecordedEvent[]) => Promise<void>, over: Partial<RecordSessionOptions> = {}): Promise<{ r: RecordSessionResult; bytes: string }> {
  const file = join(dir, `events-${randomBytes(4).toString('hex')}.jsonl`);
  const project = makeProject(dir, { console: fixture.urls.console, shop: fixture.urls.shop }, { width: 1280, height: 800 });
  const seen: RecordedEvent[] = [];
  const r = await recordSession({
    project,
    env: resolveEnvironment(project, 'test'),
    url: `${fixture.urls.shop}/record-lab`,
    eventsFile: file,
    headless: true,
    windowSize: { width: 1400, height: 1000 },
    onEvent: (e) => seen.push(e),
    drive: async (page) => {
      await page.waitForLoadState('domcontentloaded');
      if (!over.url) await page.getByRole('heading', { name: 'Recording lab' }).waitFor();
      await page.waitForTimeout(400);
      await drive(page, seen);
      await page.waitForTimeout(300).catch(() => undefined);
      await page.close().catch(() => undefined);
    },
    ...over,
  });
  const bytes = await readFile(file, 'utf8');
  await rm(file, { force: true });
  return { r, bytes };
}

/** The lab's flow for these tests: presses, typing, a keyboard activation, a secret field. */
async function flow(page: Page): Promise<void> {
  await page.getByLabel('Email').click();
  await page.keyboard.type('maja@example.test');
  await page.getByRole('button', { name: 'Forgery target' }).click();
  await page.getByLabel('Roast level').focus();
  await page.keyboard.press('d');
  await page.getByLabel('Integration').click();
  await page.keyboard.type('plain-value');
  await page.getByLabel('Note').click();
  await page.keyboard.type('Two bags');
  await page.getByRole('button', { name: 'Re-mount the field' }).click();
  await page.getByRole('button', { name: 'Edit address' }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Street').waitFor();
  await page.keyboard.press('Escape');
  await page.getByLabel('Street').waitFor({ state: 'detached' });
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const pressMs = (r: RecordSessionResult) => r.events.filter((e): e is Pointer => e.kind === 'pointer' && e.via === 'pointer').map((e) => e.ms);

describe('recordSession: alternative targets (L4.8)', () => {
  it('up to three per action, each resolving once to the pressed element in the window; never positional; none for a secret field', async () => {
    let checks: Array<{ seq: number; ok: boolean[] }> = [];
    const { r, bytes } = await record(async (page, seen) => {
      await flow(page);
      await page.waitForTimeout(300);
      // Re-check in the window, as it is now (every control of the flow is still there): a kit in the page's own world.
      await page.evaluate(kitSource({ ...kitConfigFor(undefined, { hidden: true }), passive: true }));
      const pairs = seen.flatMap((e) => ('el' in e && e.el?.target && e.el.alternatives?.length ? [{ seq: e.seq, main: e.el.target, alts: e.el.alternatives.map((a) => a.target) }] : []));
      checks = await page.evaluate((list) => {
        const kit = (window as unknown as { __demoStudio: { find(t: object, o: object): { count: number; ref?: string }; el(ref: string): Element | null } }).__demoStudio;
        const one = (t: object) => {
          const f = kit.find(t, {});
          return f.count === 1 && f.ref !== undefined ? kit.el(f.ref) : null;
        };
        return list.map((p) => {
          const el = one(p.main);
          return { seq: p.seq, ok: p.alts.map((a) => el !== null && one(a) === el) };
        });
      }, pairs);
    });
    // Every event passes the schema (none dropped for its alternatives), and the file holds exactly them.
    expect(r.counts.dropped.invalid).toBe(0);
    for (const e of r.events) expect(RecordedEventSchema.safeParse(e).success).toBe(true);
    expect(bytes.trim().split('\n').map((l) => JSON.parse(l) as RecordedEvent)).toEqual(r.events);

    const withAlts = r.events.filter((e): e is WithEl => 'el' in e && (e.el?.alternatives?.length ?? 0) > 0);
    expect(withAlts.length).toBeGreaterThanOrEqual(4);
    expect(checks.length).toBe(withAlts.length);
    for (const c of checks) expect(c.ok.every(Boolean), `seq ${c.seq}`).toBe(true);
    for (const e of withAlts) {
      expect(e.el!.alternatives!.length).toBeLessThanOrEqual(3);
      for (const a of e.el!.alternatives!) {
        expect(a.target.nth).toBeUndefined();
        expect(a.target.last_visible).toBeUndefined();
        expect(a.target).not.toEqual(e.el!.target);
      }
    }
    const find = (pred: (e: WithEl) => boolean) => r.events.filter((e): e is WithEl => 'el' in e && pred(e));
    // The Email press and its typing, the button press, the native select each carry some.
    expect(find((e) => e.kind === 'pointer' && e.el?.label === 'Email')[0]?.el?.alternatives?.length).toBeGreaterThanOrEqual(1);
    expect(find((e) => e.kind === 'type' && e.el?.label === 'Email')[0]?.el?.alternatives?.length).toBeGreaterThanOrEqual(1);
    expect(find((e) => e.kind === 'pointer' && e.el?.name === 'Forgery target')[0]?.el?.alternatives).toContainEqual({ target: { css: '#lab-forge-target' }, fragile: ['css'] });
    expect(find((e) => e.kind === 'select_native')[0]?.el?.alternatives?.length).toBeGreaterThanOrEqual(1);
    // A secret field (the integration key): none, neither on its press nor on its typing.
    const secret = find((e) => e.el?.secret === true);
    expect(secret.length).toBeGreaterThanOrEqual(2);
    for (const e of secret) {
      expect(e.el!.alternatives).toBeUndefined();
      expect(e.el!.alternatives_partial).toBeUndefined();
    }
    // Scrolls and plain keys never ask for any.
    for (const e of r.events) if (e.kind === 'scroll' || e.kind === 'key') expect(e.el?.alternatives).toBeUndefined();
  }, 90_000);

  it('their budget spent (0 ms): none, said partial — the action itself is recorded as before', async () => {
    const { r } = await record(async (page) => {
      await page.getByLabel('Email').click();
      await page.getByRole('button', { name: 'Forgery target' }).click();
    }, { alternativesBudgetMs: 0 });
    const presses = r.events.filter((e): e is Pointer => e.kind === 'pointer');
    expect(presses).toHaveLength(2);
    for (const p of presses) {
      expect(p.el?.target).toBeTruthy();
      expect(p.el?.alternatives).toBeUndefined();
      expect(p.el?.alternatives_partial).toBe(true);
    }
  }, 60_000);

  it('the in-page cost of a press: with and without them on the lab; skipped on a page of 10,000 controls', async () => {
    const withAlts = await record((page) => flow(page));
    const without = await record((page) => flow(page), { alternativesBudgetMs: 0 });
    const a = pressMs(withAlts.r);
    const b = pressMs(without.r);
    expect(a.length).toBeGreaterThanOrEqual(5);
    console.log(`record: a press on the lab, in-page ms — with alternatives p50 ${quantile(a, 0.5)} / p95 ${quantile(a, 0.95)} (n=${a.length}); without p50 ${quantile(b, 0.5)} / p95 ${quantile(b, 0.95)} (n=${b.length})`);
    // Inside the 150 ms press budget: the alternatives' own budget is 10 ms — the bound that matters is what they add
    // (review B-N2), on the median press (n is small: the p95 is the slowest press).
    expect(quantile(a, 0.95)).toBeLessThan(150);
    expect(quantile(a, 0.5) - quantile(b, 0.5)).toBeLessThanOrEqual(15);

    const big = await record(
      async (page) => {
        await page.getByRole('heading', { name: 'Inventory' }).waitFor();
        const row = page.getByRole('row', { name: /^Item 2500 / });
        await row.scrollIntoViewIfNeeded();
        await row.getByRole('button', { name: 'Save' }).click();
      },
      { url: `${fixture.urls.shop}/inspect-lab?rows=5000` },
    );
    const press = big.r.events.find((e): e is Pointer => e.kind === 'pointer');
    expect(press).toBeTruthy();
    console.log(`record: a press on a 5,000-row page took ${press!.ms} ms in the page (alternatives ${press!.el?.alternatives?.length ?? 0}, partial ${press!.el?.alternatives_partial === true})`);
    if (press!.el?.target) {
      // A slow suggestion: the press does not wait for alternatives.
      expect(press!.el.alternatives).toBeUndefined();
      expect(press!.el.alternatives_partial).toBe(true);
    }
  }, 120_000);
});
