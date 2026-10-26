/**
 * L5.6 acceptance cases on the fixture product (R-FLD-10 – R-FLD-16): the committed `proforma` scenario and variants
 * of it, dry-run through the `studio` CLI against the fixture on free ports (environment `local`, the personas' mail
 * addresses declared there). The page is the fixture's "Pro forma invoices": a modal dialog whose body scrolls over a
 * page that has a "Quantity (kg)" field too, a calendar that covers the fields under it, a "Preview" button wired to
 * nothing, a PDF whose second transfer breaks, a pro forma mailed to the café's accounts address and the supplier.
 * Skipped when Chromium is not available.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmailArtefact, RunProgress, RunRecord, Timeline } from '@demo-studio/core';
import { main, memoryIo } from '../src/index.js';

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
let committed: string;

async function studio(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'studio', '--root', ws, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

/** Dry-run a variant of the committed scenario (quick pacing, environment local); its run record and timeline. */
async function variant(name: string, edit: (yaml: string) => string): Promise<{ run: RunRecord; tl: Timeline | null; out: string }> {
  const text = edit(committed.replace(/^env: signed-in\n/m, '').replace(/^\s+- hold: [\d.]+\n/gm, ''));
  await writeFile(join(ws, 'projects', 'fx', 'scenarios', `${name}.yaml`), `${text}\npacing: {scene_start_still: 0.2, after_click_ms: 120, after_popup_ms: 350, after_navigation_ms: 500, settle_ms: 800, move_max_ms: 450}\n`);
  const r = await studio('run', 'fx', name, '--dry', '--hooks', 'run', '--json');
  const end = JSON.parse(r.out.trim().split('\n').pop()!) as RunProgress;
  expect(end.type, r.err).toBe('run_end');
  const run = (end as { run: RunRecord }).run;
  const tl = run.timeline ? (JSON.parse(await readFile(run.timeline, 'utf8')) as Timeline) : null;
  return { run, tl, out: r.out };
}

describe.skipIf(!chromiumAvailable())('capture reliability on the fixture (L5.6)', () => {
  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
      startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture>;
    };
    fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
    ws = await mkdtemp(join(tmpdir(), 'studio-reliability-'));
    await writeFile(join(ws, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    const project = join(ws, 'projects', 'fx');
    await mkdir(join(project, 'scenarios'), { recursive: true });
    await writeFile(
      join(project, 'project.yaml'),
      [
        'name: FX',
        'environments:',
        `  local: {console: ${fixture.urls.console}, shop: ${fixture.urls.shop}}`,
        'capture: {width: 1440, height: 900, scale: 1, fps: 30}',
        'template: default',
        `mailbox: {provider: mailpit, url: "${fixture.urls.console}/mailbox", poll_ms: 200}`,
        // The personas' mail addresses (no pages: nothing is signed in on this environment).
        'auth:',
        '  local:',
        '    personas:',
        '      supplier: {email: maja@northfield.example, check: {url: "console:/"}}',
        '      buyer: {email: orders@demo-cafe.example, check: {url: "shop:/"}}',
        '',
      ].join('\n'),
    );
    committed = await readFile(join(REPO, 'projects/northfield-fixture/scenarios/proforma.yaml'), 'utf8');
  });

  afterAll(async () => {
    await fixture?.close();
    if (ws) await rm(ws, { recursive: true, force: true });
  });

  it('the committed scenario: types into the dialog\'s fields below its fold, the broken PDF transfer is fetched again, the supplier\'s copy is taken by address', async () => {
    const { run, tl } = await variant('proforma', (y) => y);
    expect(run.error?.message ?? '').toBe('');
    expect(run.status).toBe('succeeded');
    const ev = tl!.events.filter((e) => e.step >= 0);
    const qty = ev.find((e) => e.scene === 'write' && e.step === 3)!;
    expect(qty.target?.desc).toBe('textbox "Quantity (kg)"');
    // The dialog's field, scrolled into view inside the dialog's body (the page's filter field is at y ≈ 200).
    expect(qty.point!.y).toBeGreaterThan(300);
    const dl = ev.find((e) => e.action === 'download')!;
    expect(dl.data).toMatchObject({ name: 'proforma', mime: 'application/pdf', via: 'tab', attempts: 2 });
    const copy = (tl!.artefacts ?? []).find((a): a is EmailArtefact => a.kind === 'email')!;
    expect(copy).toMatchObject({ name: 'copy', to: ['maja@northfield.example'], persona: 'supplier' });
    expect(tl!.warnings).toEqual([expect.stringMatching(/^send\.0: download "proforma": aborted — trying again in 1 s \(attempt 2 of 3\)$/)]);
  }, 180_000);

  it('two renamed labels in one scene: one failed take names both, with the fields they became', async () => {
    const { run } = await variant('renamed', (y) =>
      y.replace('defaults: {timeout_s: 30}', 'defaults: {timeout_s: 1}').replace('label: Quantity (kg)', 'label: Quantity in kg').replace('label: Unit price (EUR/kg)', 'label: Price per kg'),
    );
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ scene: 'write', step: 3, action: 'type' });
    expect(run.error!.message).toMatch(/no visible element matches label="Quantity in kg" after 1\.0 s/);
    expect(run.error!.missing_targets).toEqual([
      { scene: 'write', step: 4, action: 'type', target: 'label="Price per kg"', near: expect.arrayContaining([expect.objectContaining({ role: 'textbox', name: 'Unit price (EUR/kg)' })]) },
    ]);
    expect(run.error!.message).toMatch(/1 later target of scene write not on this page either/);
  }, 120_000);

  it('a dead button is reported at once with a screenshot; the take goes on', async () => {
    const { run, tl } = await variant('dead', (y) => y.replace('      - type: {into: {label: Unit price (EUR/kg)}, text: "21.80", cps: 9}\n', '      - type: {into: {label: Unit price (EUR/kg)}, text: "21.80", cps: 9}\n      - click: Preview\n'));
    expect(run.status, run.error?.message).toBe('succeeded');
    const dead = tl!.warnings.filter((w) => w.includes('produced nothing'));
    expect(dead).toEqual([expect.stringMatching(/^write\.5: clicking button "Preview" produced nothing within 1 s .* screenshot: \S+dead-click-write-5\.png/)]);
    expect(existsSync(/screenshot: (\S+\.png)/.exec(dead[0])![1])).toBe(true);
  }, 120_000);

  it('a mail sent to another address than the persona\'s: the error lists what came, sender and recipients', async () => {
    const { run } = await variant('other-address', (y) => y.replace('{to: "persona:supplier", subject: Pro forma, as: copy}', '{to: "persona:buyer", subject: Pro forma, as: copy, timeout: 3}'));
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ scene: 'send', step: 3, action: 'wait_for_email' });
    expect(run.error!.message).toMatch(/no new message \(to persona:buyer, subject Pro forma = orders@demo-cafe\.example\) within 3 s/);
    expect(run.error!.message).toMatch(/to accounts@demo-cafe\.example/);
    expect(run.error!.message).toMatch(/to maja@northfield\.example/);
  }, 120_000);

  it('a field the open calendar covers: the step fails before typing, naming the field that kept the focus', async () => {
    const { run } = await variant('covered', (y) =>
      y.replace('      - click: {outside: true}\n', '      - type: {into: {label: Customer}, text: Café Lumen, clear: true}\n'),
    );
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ scene: 'write', step: 2, action: 'type' });
    expect(run.error!.message).toMatch(/put the focus on textbox "Delivery date" instead: nothing was typed/);
    expect(existsSync(run.error!.screenshot!)).toBe(true);
  }, 120_000);
});
