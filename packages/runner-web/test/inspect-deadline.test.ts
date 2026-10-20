/**
 * L3.8 review (the full-suite hang of inspect.test.ts): every wait of an inspection on the page is bounded. A stub page
 * whose navigation guard, kit call or guard removal never answers still gets a report within the deadline — `failed`
 * naming the step while the page stays on the environment, `landed_elsewhere` once it shows another origin — and a
 * guard that cannot be removed leaves the report as it was, with a warning. No browser.
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectPage } from '../src/inspect.js';
import type { InspectContext, InspectDeadlines } from '../src/inspect.js';
import type { KitInventory, KitTargetChecks } from '../src/kit/types.js';
import type { Runtime } from '../src/runtime.js';

const APP = 'http://127.0.0.1:4999';
const DEADLINES: InspectDeadlines = { guard_ms: 150, call_ms: 150 };
const BUDGET = 50;
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const ctx: InspectContext = { at: 'end', persona: null, replay: { steps_done: 1, steps_total: 1, until: null, skipped_irreversible: 0, hooks: 'none', failed: null } };

const inventory = (origin = APP): KitInventory =>
  ({
    origin,
    title: 'Stub',
    headings: [],
    popups: [],
    scrollers: [],
    elements: [],
    within_found: true,
    partial: false,
    counts: { interactive: 0, listed: 0, in_view: 0, suggested: 0, ambiguous: 0, unsuggested: 0, verifications: 0, shadow_roots: 0, same_origin_frames: 0, cross_origin_frames: 0 },
  }) as unknown as KitInventory;

interface Stub {
  route?: () => Promise<void>;
  unroute?: () => Promise<void>;
  /** The inventory (one page.evaluate) never answers. */
  hangInventory?: boolean;
  /** The URL the page shows once the inventory hung (a cross-origin commit). */
  urlAfterHang?: string;
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ds-inspect-deadline-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let seq = 0;
function stubRuntime(s: Stub): Runtime {
  let url = `${APP}/late`;
  const page = {
    url: () => url,
    route: s.route ?? (async () => undefined),
    unroute: s.unroute ?? (async () => undefined),
    mainFrame: () => ({}),
    screenshot: async () => Buffer.from(''),
    waitForURL: async () => undefined,
  };
  const kit = {
    callOnce: async () => ({ count: 0 }),
    inventory: async (): Promise<KitInventory> => {
      if (!s.hangInventory) return inventory();
      if (s.urlAfterHang) url = s.urlAfterHang;
      return never<KitInventory>();
    },
    checkTargets: async (): Promise<KitTargetChecks> => ({ origin: APP, checks: [] }),
    cursorShow: async () => undefined,
  };
  return {
    runDir: join(dir, `run${++seq}`),
    capture: { width: 1280, height: 720, scale: 1 },
    activeId: 'app',
    page,
    kit,
    env: { pages: { app: APP } },
    awaitLoaded: async () => undefined,
    assertSignedIn: () => undefined,
    loginGuardError: () => null,
    secrets: { redactDeep: <T>(x: T) => x },
  } as unknown as Runtime;
}

async function timed(rt: Runtime) {
  await mkdir(rt.runDir, { recursive: true });
  const t0 = Date.now();
  const r = await inspectPage(rt, { budgetMs: BUDGET }, ctx, DEADLINES);
  return { r, ms: Date.now() - t0 };
}

describe('an inspection never waits on the page forever', () => {
  it('the stub answers: ok (the stub itself is sound)', async () => {
    const { r } = await timed(stubRuntime({}));
    expect(r.status).toBe('ok');
    expect(r.untrusted.warnings).toEqual([]);
  });

  it('a navigation guard whose install never answers: failed, naming the step, within the deadline', async () => {
    const { r, ms } = await timed(stubRuntime({ route: never }));
    expect(r.status).toBe('failed');
    expect(r.untrusted.error).toBe('the page did not answer (installing the navigation guard) within 0.2 s');
    expect(ms).toBeLessThan(2_000);
  });

  it('a kit call (page.evaluate) that never answers while the page stays: failed, naming the step, nothing inventoried', async () => {
    const { r, ms } = await timed(stubRuntime({ hangInventory: true }));
    expect(r.status).toBe('failed');
    expect(r.untrusted.error).toBe('the page did not answer (the inventory) within 0.2 s');
    expect(r.elements).toEqual([]);
    expect(r.screenshot).toBeNull();
    expect(ms).toBeLessThan(2_000);
    expect(JSON.parse(await readFile(r.file, 'utf8')).status).toBe('failed');
  });

  it('a kit call that never answers because the page committed another origin: landed_elsewhere, by its host alone', async () => {
    const { r, ms } = await timed(stubRuntime({ hangInventory: true, urlAfterHang: 'http://127.0.0.1:4998/landed?token=abc' }));
    expect(r.status).toBe('landed_elsewhere');
    expect(r.untrusted.landed_host).toBe('127.0.0.1:4998');
    expect(JSON.stringify(r)).not.toContain('token=abc');
    expect(ms).toBeLessThan(2_000);
  });

  it('a guard removal (page.unroute) that never answers: the report as read, with a warning, within the deadline', async () => {
    const { r, ms } = await timed(stubRuntime({ unroute: never }));
    expect(r.status).toBe('ok');
    expect(r.untrusted.warnings).toEqual(['the navigation guard could not be removed in time (the page closes with the run)']);
    expect(ms).toBeLessThan(2_000);
  });
});
