/**
 * Kit 1.5.0 for the recorder (L3.4): `suggestFor` is the inventory's own entry for one element (same target, context
 * and action as `inventory` lists it), found from what a person acts on (a span inside a button, a label, a hidden
 * file input); `secretField` classifies fields without reading a value; the passive kit draws, patches and listens to
 * nothing. Kit 1.6.0 (L4.8): up to three alternative targets per element, for the recorder only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { kitConfigFor, kitSource, openSession } from '../src/index.js';
import type { BrowserSession, InventoryElement, KitInventory } from '../src/index.js';
import { startServer } from './helpers.js';
import { PERSON_POLICY } from '@retake/core';
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
  find(t: object, o?: object): { count: number; ref?: string };
};

beforeAll(async () => {
  server = await startServer({ '/lab.html': LAB });
  session = await openSession({ policy: PERSON_POLICY, width: 1200, height: 900, scale: 1, kit: kitConfigFor(undefined, { hidden: true }) });
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
      const kit = (window as unknown as { __retake: Kit }).__retake;
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
      const kit = (window as unknown as { __retake: Kit }).__retake;
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
      const kit = (window as unknown as { __retake: Kit }).__retake;
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

describe('alternative targets (kit 1.6.0, the recorder only)', () => {
  it('up to three other targets, each resolving once to the very element; never positional; without the option nothing changes', async () => {
    const r = await page.evaluate(() => {
      const kit = (window as unknown as { __retake: Kit }).__retake;
      const sels = ['#email', '#q', '#roast', '#notes', '#x', '#inner', 'tr:nth-child(2) button', '[role=dialog] button', 'a[href]', '#zone'];
      return sels.map((sel) => {
        const e = kit.suggestFor(document.querySelector(sel)!, { alternatives: 3, alternatives_budget_ms: 50 });
        const el = e ? kit.el(e.ref) : null;
        const plain = kit.suggestFor(document.querySelector(sel)!);
        return {
          sel,
          suggested: e?.suggested?.target ?? null,
          alternatives: e?.alternatives ?? null,
          partial: e?.alternatives_partial ?? null,
          // Re-checked here: each alternative resolves once, to the element the suggestion names.
          resolve: (e?.alternatives ?? []).map((a) => {
            const f = kit.find(a.target, {});
            return f.count === 1 && f.ref !== undefined && kit.el(f.ref) === el;
          }),
          plainKeys: plain ? Object.keys(plain).includes('alternatives') : null,
        };
      });
    });
    const by = Object.fromEntries(r.map((x) => [x.sel, x]));
    for (const x of r) {
      expect(x.alternatives, x.sel).not.toBeNull();
      expect(x.alternatives!.length, x.sel).toBeLessThanOrEqual(3);
      expect(x.resolve.every(Boolean), x.sel).toBe(true);
      for (const a of x.alternatives!) {
        expect(a.target.nth, x.sel).toBeUndefined();
        expect(a.fragile, x.sel).not.toContain('nth');
        expect(a.target, x.sel).not.toEqual(x.suggested);
      }
      expect(x.plainKeys, x.sel).toBe(false);
    }
    expect(by['#email'].suggested).toEqual({ label: 'Email' });
    expect(by['#email'].alternatives!.map((a) => a.target)).toEqual([{ role: 'textbox', name: 'Email' }, { css: '#email' }]);
    expect(by['#email'].alternatives![1].fragile).toEqual(['css']);
    expect(by['#q'].alternatives!.map((a) => a.target)).toEqual([{ role: 'textbox', name: 'Search lots' }, { css: '#q' }]);
    // "Save" twice on the page: only the stable id resolves once; no positional alternative is ever offered.
    expect(by['#inner'].suggested).toEqual({ css: '#b1' });
    expect(by['#inner'].alternatives).toEqual([]);
    expect(r.reduce((n, x) => n + x.alternatives!.length, 0)).toBeGreaterThanOrEqual(6);
  });

  it('each one is verified in the page: a key the page shares with an element outside the interactive ones is not offered', async () => {
    const r = await page.evaluate(() => {
      const kit = (window as unknown as { __retake: Kit }).__retake;
      const alts = () => kit.suggestFor(document.querySelector('#x')!, { alternatives: 3, alternatives_budget_ms: 50 })?.alternatives?.map((a) => a.target);
      const before = alts();
      const twin = document.createElement('div');
      twin.setAttribute('aria-label', 'Close panel');
      twin.textContent = 'Panel';
      document.body.append(twin);
      try {
        return { before, after: alts() };
      } finally {
        twin.remove();
      }
    });
    expect(r.before).toContainEqual({ aria: 'Close panel' });
    expect(r.after).not.toContainEqual({ aria: 'Close panel' });
    expect(r.after).toContainEqual({ css: '#x' });
  });

  it('a noisy text is never offered — mostly digits (a price) or pieces run together — and the good ones still are (review B-L7)', async () => {
    const r = await page.evaluate(() => {
      const kit = (window as unknown as { __retake: Kit }).__retake;
      const box = document.createElement('div');
      box.innerHTML =
        '<div role="listbox" aria-label="Sizes"><div role="option" id="o5" data-testid="opt-5kg"><span>5 kg</span><span>€36.40 / kg</span></div></div>' +
        '<button id="card" data-testid="card-cv"><span>Cerro Verde</span><span>Peru · Natural</span></button>';
      document.body.append(box);
      try {
        const alts = (sel: string) => kit.suggestFor(document.querySelector(sel)!, { alternatives: 3, alternatives_budget_ms: 50 });
        const o = alts('#o5');
        const c = alts('#card');
        return { option: { target: o?.target, alts: o?.alternatives?.map((a) => a.target) }, card: { target: c?.target, alts: c?.alternatives?.map((a) => a.target) } };
      } finally {
        box.remove();
      }
    });
    const texts = (ts: unknown[] | undefined) => (ts ?? []).flatMap((t) => (t && typeof t === 'object' && 'text' in t ? [(t as { text: string }).text] : []));
    expect(texts(r.option.alts)).not.toContain('€36.40 / kg');
    expect(texts(r.option.alts)).not.toContain('5 kg€36.40 / kg');
    expect(JSON.stringify(r.option.alts)).not.toContain('36.40');
    expect(r.option.alts).toContainEqual({ testid: 'opt-5kg' });
    expect(texts(r.card.alts)).not.toContain('Cerro VerdePeru · Natural');
    expect(r.card.alts).toContainEqual({ testid: 'card-cv' });
    expect(r.card.alts!.length).toBe(3);
  });

  it('a spent budget gives none, said partial; the inventory of page_inspect never carries them', async () => {
    const r = await page.evaluate(() => {
      const kit = (window as unknown as { __retake: Kit }).__retake;
      const e = kit.suggestFor(document.querySelector('#email')!, { alternatives: 3, alternatives_budget_ms: 0 });
      const inv = kit.inventory({ limit: 300 });
      return { alternatives: e?.alternatives, partial: e?.alternatives_partial, inventory: inv.elements.some((x) => 'alternatives' in x || 'alternatives_partial' in x) };
    });
    expect(r).toEqual({ alternatives: [], partial: true, inventory: false });
  });
});

describe('the passive kit (the recorder\'s copy)', () => {
  it('draws no cursor, patches no API, still resolves and inventories', async () => {
    const p = await browser.newPage();
    try {
      await p.goto(`${server.url}/lab.html`);
      await p.evaluate(kitSource({ ...kitConfigFor(undefined, { hidden: true }), passive: true }));
      const r = await p.evaluate(() => {
        const w = window as unknown as Record<string, unknown> & { __retake: Kit & { healthy(): boolean; version: string } };
        return {
          version: w.__retake.version,
          healthy: w.__retake.healthy(),
          cursor: document.querySelectorAll('retake-cursor').length,
          patched: w.__retakeNotifyPatched === true,
          save: w.__retake.suggestFor(document.querySelector('#inner')!)?.tag,
        };
      });
      expect(r).toEqual({ version: '1.6.0', healthy: true, cursor: 0, patched: false, save: 'button' });
    } finally {
      await p.close();
    }
  });
});
