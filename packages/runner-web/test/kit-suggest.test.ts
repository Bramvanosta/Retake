/**
 * Kit 1.5.0 for the recorder (L3.4): `suggestFor` is the inventory's own entry for one element (same target, context
 * and action as `inventory` lists it), found from what a person acts on (a span inside a button, a label, a hidden
 * file input); `secretField` classifies fields without reading a value; the passive kit draws, patches and listens to
 * nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { kitConfigFor, kitSource, openSession } from '../src/index.js';
import type { BrowserSession, InventoryElement, KitInventory } from '../src/index.js';
import { startServer } from './helpers.js';
import type { TestServer } from './helpers.js';

const LAB = `<!doctype html><html><body>
<h1>Suggest lab</h1>
<button id="b1"><span id="inner">Save</span></button><button>Save</button><button>Save draft</button>
<button aria-label="Close panel" id="x">×</button>
<label for="email">Email</label><input id="email" type="email">
<label>Notes <textarea id="notes"></textarea></label>
<input id="q" placeholder="Search lots">
<select id="roast" aria-label="Roast"><option>Light</option><option>Dark</option></select>
<label id="zone" class="zone">Drop a file<input id="file" type="file" style="display:none"></label>
<table><tbody>
<tr><td>Selowa Ridge</td><td><button aria-haspopup="menu" aria-label="Row actions">⋯</button></td></tr>
<tr><td>Cerro Alto</td><td><button aria-haspopup="menu" aria-label="Row actions">⋯</button></td></tr>
</tbody></table>
<a href="/next?x=1">Next page</a>
<p id="plain">Plain text, not interactive.</p>
<div role="dialog" aria-label="Edit"><button>Apply</button></div>
<h2>Secrets</h2>
<input id="s-pw" type="password">
<input id="s-ac" autocomplete="one-time-code">
<input id="s-cc" autocomplete="cc-number">
<input id="s-csc" name="cardCvc">
<input id="s-key" name="apiKey">
<input id="s-token" placeholder="Access token">
<input id="s-pin" aria-label="PIN">
<label for="s-iban">IBAN</label><input id="s-iban">
<input id="s-newpw" name="new_password">
<div id="otp"><input maxlength="1"><input maxlength="1"><input maxlength="1"><input maxlength="1" id="otp4"></div>
<input id="n-name" name="fullName"><input id="n-pass" placeholder="Passenger name"><input id="n-cb" type="checkbox" name="password">
<div contenteditable="true" id="n-ce" aria-label="Comment"></div>
</body></html>`;

let server: TestServer;
let session: BrowserSession;
let page: Page;
let browser: Browser;

type Kit = {
  inventory(o: object): KitInventory;
  suggestFor(t: Element | string, o?: object): InventoryElement | null;
  secretField(t: Element | string): string | null;
  el(ref: string): Element | null;
};

beforeAll(async () => {
  server = await startServer({ '/lab.html': LAB });
  session = await openSession({ width: 1200, height: 900, scale: 1, kit: kitConfigFor(undefined, { hidden: true }) });
  page = await session.page('main');
  await page.goto(`${server.url}/lab.html`);
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await session?.close();
  await browser?.close();
  await server?.close();
});

describe('suggestFor (kit 1.5.0)', () => {
  it("is the inventory's entry for each element: same target, context and action", async () => {
    const r = await page.evaluate(() => {
      const kit = (window as unknown as { __demoStudio: Kit }).__demoStudio;
      const inv = kit.inventory({ limit: 300 });
      return inv.elements.map((e) => {
        const s = kit.suggestFor(kit.el(e.ref)!);
        return { a: [e.suggested, e.in, e.action, e.name, e.tag], b: s ? [s.suggested, s.in, s.action, s.name, s.tag] : null };
      });
    });
    expect(r.length).toBeGreaterThan(15);
    for (const x of r) expect(x.b).toEqual(x.a);
  });

  it('from what a person acts on: a span in a button, a label, a hidden file input; null for plain text', async () => {
    const r = await page.evaluate(() => {
      const kit = (window as unknown as { __demoStudio: Kit }).__demoStudio;
      const at = (sel: string) => kit.suggestFor(document.querySelector(sel)!);
      return {
        inner: at('#inner'),
        label: at('label[for=email]'),
        file: at('#file'),
        plain: at('#plain'),
        row: at('tr:nth-child(2) button'),
        apply: at('[role=dialog] button'),
      };
    });
    expect(r.inner?.tag).toBe('button');
    expect(r.inner?.suggested?.target).toEqual({ css: '#b1' });
    expect(r.label?.suggested?.target).toEqual({ label: 'Email' });
    expect(r.file?.action.kind).toBe('drop_file');
    expect(r.plain).toBeNull();
    expect(r.row?.action).toEqual({ kind: 'menu', row: 'Cerro Alto', verified: true });
    expect(r.apply?.in).toBe('dialog');
  });

  it('secretField: by type, autocomplete, names, labels and one-time-code boxes; never a plain field', async () => {
    const r = await page.evaluate(() => {
      const kit = (window as unknown as { __demoStudio: Kit }).__demoStudio;
      const ids = ['s-pw', 's-ac', 's-cc', 's-csc', 's-key', 's-token', 's-pin', 's-iban', 's-newpw', 'otp4', 'n-name', 'n-pass', 'n-cb', 'n-ce', 'email', 'q'];
      return Object.fromEntries(ids.map((id) => [id, kit.secretField(document.getElementById(id)!)]));
    });
    expect(r).toEqual({
      's-pw': 'password',
      's-ac': 'one_time_code',
      's-cc': 'card_number',
      's-csc': 'card_code',
      's-key': 'api_key',
      's-token': 'api_key',
      's-pin': 'pin',
      's-iban': 'iban',
      's-newpw': 'password',
      otp4: 'one_time_code',
      'n-name': null,
      'n-pass': null,
      'n-cb': null,
      'n-ce': null,
      email: null,
      q: null,
    });
  });
});

describe('the passive kit (the recorder\'s copy)', () => {
  it('draws no cursor, patches no API, still resolves and inventories', async () => {
    const p = await browser.newPage();
    try {
      await p.goto(`${server.url}/lab.html`);
      await p.evaluate(kitSource({ ...kitConfigFor(undefined, { hidden: true }), passive: true }));
      const r = await p.evaluate(() => {
        const w = window as unknown as Record<string, unknown> & { __demoStudio: Kit & { healthy(): boolean; version: string } };
        return {
          version: w.__demoStudio.version,
          healthy: w.__demoStudio.healthy(),
          cursor: document.querySelectorAll('demo-studio-cursor').length,
          patched: w.__demoStudioNotifyPatched === true,
          save: w.__demoStudio.suggestFor(document.querySelector('#inner')!)?.tag,
        };
      });
      expect(r).toEqual({ version: '1.5.0', healthy: true, cursor: 0, patched: false, save: 'button' });
    } finally {
      await p.close();
    }
  });
});
