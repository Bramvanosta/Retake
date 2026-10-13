/**
 * L1.7 end to end on the fixture product (R-ENV-01/03/05): the committed `read-only` scenario (holds removed, quick
 * pacing) dry-run through the `studio` CLI on a production environment pointing at the fixture on free ports. The
 * request's POST is answered by the scenario's mock and never reaches the server (`/api/health` → `mutations`
 * unchanged), the caption's `{{shop}}` reads the display URL, and two takes read the same "Prices as of" line from
 * the product's clock. Skipped when Chromium is not available.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunProgress, RunRecord, Timeline } from '@demo-studio/core';
import { EXIT, main, memoryIo } from '../src/index.js';
import { writesSummary } from '../src/commands/run.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

function chromiumAvailable(): boolean {
  if (process.env.DEMO_STUDIO_CHROMIUM) return existsSync(process.env.DEMO_STUDIO_CHROMIUM);
  try {
    const require = createRequire(join(REPO, 'packages/runner-web/package.json'));
    const { chromium } = require('playwright-core') as { chromium: { executablePath(): string } };
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

let fixture: Fixture;
let ws: string;

async function studio(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'studio', '--root', ws, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

/** A run's last JSON event: the run record. */
function runOf(out: string): RunRecord {
  const end = JSON.parse(out.trim().split('\n').pop()!) as RunProgress;
  expect(end.type).toBe('run_end');
  return (end as { run: RunRecord }).run;
}

async function mutations(): Promise<number> {
  const health = (await (await fetch(`${fixture.urls.shop}/api/health`)).json()) as { mutations: number };
  expect(typeof health.mutations).toBe('number');
  return health.mutations;
}

describe('writesSummary (run summary line)', () => {
  it('counts the writes of a read-only run, the sign-in\'s exempt ones excepted; on a read-write run, only writes stopped on another environment\'s hosts', () => {
    expect(writesSummary(undefined)).toBeUndefined();
    expect(writesSummary({ environment: { name: 'local', access: 'read-write' } })).toBeUndefined();
    expect(
      writesSummary({
        environment: { name: 'local', access: 'read-write', writes: [{ t: 1, method: 'POST', url: 'https://api.example.com/reset', outcome: 'blocked', via: 'page', protected_by: 'production' }] },
      }),
    ).toEqual({ text: '1 stopped (hosts of read-only environments)', stopped: 1 });
    expect(writesSummary({ environment: { name: 'production', access: 'read-only' } })).toEqual({ text: '0 mocked, 0 stopped (read-only)', stopped: 0 });
    expect(
      writesSummary({
        environment: {
          name: 'production',
          access: 'read-only',
          writes: [
            { t: 1, method: 'POST', url: 'http://localhost:4402/api/quotes', outcome: 'mocked', via: 'page' },
            { t: 2, method: 'POST', url: 'http://localhost:4402/api/track', outcome: 'blocked', via: 'page' },
            { method: 'POST', url: 'http://localhost:4402/sign-in', outcome: 'exempt', via: 'sign-in' },
            { method: 'PUT', url: 'http://localhost:4402/api/last-seen', outcome: 'blocked', via: 'sign-in' },
            { t: 3, method: 'POST', url: 'https://metrics.example.com/c', outcome: 'passed', via: 'page' },
          ],
        },
      }),
    ).toEqual({ text: '1 mocked, 2 stopped, 1 to unguarded hosts (read-only)', stopped: 2 });
  });
});

describe.skipIf(!chromiumAvailable())('the fixture read-only scenario (production, mocked write, product clock)', () => {
  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
      startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture>;
    };
    fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
    ws = await mkdtemp(join(tmpdir(), 'studio-read-only-'));
    await writeFile(join(ws, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    const project = join(ws, 'projects', 'fx');
    await mkdir(join(project, 'scenarios'), { recursive: true });
    await writeFile(
      join(project, 'project.yaml'),
      [
        'name: FX',
        'environments:',
        '  production:',
        '    production: true',
        '    pages:',
        `      console: {url: ${fixture.urls.console}, display: console.northfield.example}`,
        `      shop: {url: ${fixture.urls.shop}, display: shop.northfield.example}`,
        'capture: {width: 1280, height: 720, scale: 1, fps: 30}',
        'template: default',
        '',
      ].join('\n'),
    );
    // The committed scenario, quicker: no holds, short stills and pauses.
    const committed = await readFile(join(REPO, 'projects/northfield-fixture/scenarios/read-only.yaml'), 'utf8');
    const quick = `${committed.replace(/^\s+- hold: [\d.]+\n/gm, '')}\npacing: {scene_start_still: 0.2, after_click_ms: 120, after_popup_ms: 350, after_navigation_ms: 500, settle_ms: 800, move_max_ms: 450}\n`;
    await writeFile(join(project, 'scenarios', 'read-only.yaml'), quick);
  });

  afterAll(async () => {
    await fixture?.close();
    if (ws) await rm(ws, { recursive: true, force: true });
  });

  it('runs read-only: the quote request is mocked, nothing reaches the server, captions show the display URL', async () => {
    const before = await mutations();
    const r = await studio('run', 'fx', 'read-only', '--dry', '--hooks', 'run', '--json');
    const run = runOf(r.out);
    expect(run.error?.message ?? '', r.err).toBe('');
    expect(r.code).toBe(EXIT.ok);
    expect(run.environment).toEqual({ production: true, access: 'read-only', clock: { at: '2026-11-02T10:24:00', timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone } });
    expect(run.hooks.setup).toBe('ok'); // a GET: allowed on a read-only environment
    const tl = JSON.parse(await readFile(join(run.dir, 'timeline.json'), 'utf8')) as Timeline;
    expect(tl.environment).toMatchObject({ name: 'production', production: true, access: 'read-only', clock: { at: '2026-11-02T10:24:00' } });
    expect(tl.environment!.display!.map((d) => d.display)).toEqual(['https://console.northfield.example', 'https://shop.northfield.example']);
    expect(tl.environment!.writes).toEqual([
      expect.objectContaining({ method: 'POST', url: `${fixture.urls.shop}/api/quotes`, outcome: 'mocked', rule: 'POST shop:/api/quotes', status: 201, via: 'page' }),
    ]);
    // The toast read the mock's answer; the server saw no write at all.
    expect(tl.events.find((e) => e.scene === 'send' && e.action === 'wait_for')?.status).toBe('ok');
    expect(await mutations()).toBe(before);
    expect(tl.scenes.find((s) => s.id === 'prices')?.caption).toEqual({ kicker: 'Production', text: 'Live prices at https://shop.northfield.example, filmed without changing a thing.' });
    expect(tl.warnings).toEqual([]);
  }, 180_000);

  it('two takes read the same date and time from the product clock', async () => {
    const takes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await studio('run', 'fx', 'read-only', '--dry', '--until', 'prices.0', '--json');
      const run = runOf(r.out);
      expect(run.status, r.err).toBe('succeeded');
      const tl = JSON.parse(await readFile(join(run.dir, 'timeline.json'), 'utf8')) as Timeline;
      const text = tl.artefacts?.find((a) => a.kind === 'text' && a.name === 'prices-as-of');
      expect(text, JSON.stringify(tl.artefacts)).toBeDefined();
      takes.push((text as { value: string }).value);
    }
    expect(takes).toEqual(['Monday 2 November 2026, 10:24', 'Monday 2 November 2026, 10:24']);
  }, 120_000);
});
