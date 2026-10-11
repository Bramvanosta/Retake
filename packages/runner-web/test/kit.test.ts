import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import type { TargetObject } from '@demo-studio/core';
import { openSession, kitConfigFor } from '../src/index.js';
import type { BrowserSession, KitClient, ResolveMissing } from '../src/index.js';
import { OVERLAY_A, OVERLAY_B, RESOLVER_PAGE } from './pages.js';
import { startServer } from './helpers.js';
import type { TestServer } from './helpers.js';

let server: TestServer;
let session: BrowserSession;
let page: Page;
let kit: KitClient;

beforeAll(async () => {
  server = await startServer({ '/resolver.html': RESOLVER_PAGE, '/overlay-a.html': OVERLAY_A, '/overlay-b.html': OVERLAY_B });
  session = await openSession({ width: 1000, height: 700, scale: 1, kit: kitConfigFor(undefined, { style: 'debug' }) });
  page = await session.page('main');
  kit = session.kit(page);
});

afterAll(async () => {
  await session?.close();
  await server?.close();
});

async function idOf(t: TargetObject): Promise<string | null> {
  const r = await kit.find(t);
  if (r.count === 0) return null;
  return page.evaluate((ref) => (window as unknown as { __demoStudio: { el(r: string): Element | null } }).__demoStudio.el(ref)?.id ?? '', (r as { ref: string }).ref);
}

describe('resolver', () => {
  beforeAll(async () => {
    await page.goto(`${server.url}/resolver.html`);
  });

  it('prefers exact text, then case-insensitive, then substring', async () => {
    expect(await idOf({ text: 'Save' })).toBe('b-save');
    expect((await kit.find({ text: 'Save' })).count).toBe(2); // + the dialog's Save
    expect(await idOf({ text: 'save changes' })).toBe('b-save-changes');
    expect(await idOf({ text: 'changes' })).toBe('b-save-changes');
    expect((await kit.find({ text: 'chang', exact: true })).count).toBe(0);
    expect(await idOf({ text: 'Submit order' })).toBe('i-submit');
  });

  it('ignores hidden elements and reports them', async () => {
    for (const text of ['Hidden action', 'Invisible action', 'Transparent action', 'Offscreen action', 'Screen reader only', 'Clipped away']) {
      const r = await kit.find({ text });
      expect(r.count, text).toBe(0);
      expect((r as ResolveMissing).hidden, text).toBeGreaterThan(0);
    }
  });

  it('promotes to the nearest interactive ancestor', async () => {
    expect(await idOf({ text: 'Wrapped link' })).toBe('l-span');
    expect(await idOf({ text: 'link' })).toBe('l-span');
  });

  it('contains → innermost element holding every string', async () => {
    expect(await idOf({ contains: ['Finca La Esperanza', '2026'] })).toBe('card');
    expect(await idOf({ contains: ['Finca El Paraiso', '2025'] })).toBe('card-a');
  });

  it('role + name, label, aria, placeholder, testid, css', async () => {
    expect(await idOf({ role: 'button', name: 'Close panel' })).toBe('b-icon');
    expect(await idOf({ role: 'button', name: 'Custom button' })).toBe('rb-1');
    expect(await idOf({ role: 'combobox', name: 'Region' })).toBe('cb-region');
    expect(await idOf({ label: 'Email address' })).toBe('i-email');
    expect(await idOf({ label: 'Company' })).toBe('i-company');
    expect(await idOf({ label: 'Region' })).toBe('cb-region');
    expect(await idOf({ aria: 'Close panel' })).toBe('b-icon');
    expect(await idOf({ aria: 'close' })).toBe('b-icon');
    expect(await idOf({ placeholder: 'Search coffees' })).toBe('i-ph');
    expect(await idOf({ testid: 'export-btn' })).toBe('b-tid');
    expect(await idOf({ css: 'button', text: 'Save changes' })).toBe('b-save-changes');
    expect(await idOf({ role: 'link', name: 'Wrapped link' })).toBe('l-span');
  });

  it('scopes: dialog, menu, row', async () => {
    expect(await idOf({ text: 'Save', in: 'dialog' })).toBe('dlg-save');
    expect(await idOf({ role: 'menuitem', name: 'Pause', in: 'menu' })).toBe('mi-2');
    expect(await idOf({ role: 'button', in: { row: 'Iceland' } })).toBe('iceland-menu');
    expect(await idOf({ aria: 'More options', in: { row: 'Sweden' } })).toBe('sweden-more');
    expect(await idOf({ text: 'Norway', in: { row: 'Norway' } })).toBe('li-2');
    const missing = await kit.find({ text: 'Save', in: { row: 'Atlantis' } });
    expect(missing.count).toBe(0);
    expect((missing as ResolveMissing).scope_found).toBe(false);
  });

  it('nth, negative nth and last_visible (several mounted popovers)', async () => {
    expect((await kit.find({ text: 'Pause' })).count).toBe(2);
    expect(await idOf({ text: 'Pause', nth: 0 })).toBe('mi-1');
    expect(await idOf({ text: 'Pause', nth: -1 })).toBe('mi-2');
    expect(await idOf({ text: 'Pause', last_visible: true })).toBe('mi-2');
    expect(await idOf({ aria: 'Next month', last_visible: true })).toBe('next2');
    const out = await kit.find({ text: 'Pause', nth: 5 });
    expect(out.count).toBe(0);
    expect(out.desc).toContain('out of range');
  });

  it('reports nearby texts when nothing matches', async () => {
    const r = (await kit.find({ text: 'Save chnges' })) as ResolveMissing;
    expect(r.count).toBe(0);
    expect(r.near).toContain('Save changes');
  });

  it('elements below the fold are found (scrollable into view) but not in view', async () => {
    const r = await kit.find({ text: 'Far below' });
    expect(r.count).toBe(1);
    expect('in_view' in r && r.in_view).toBe(false);
  });

  it('hasText only counts text a viewer can see (laid out but transparent text is not visible yet)', async () => {
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.id = 'reveal-box';
      box.style.opacity = '0';
      box.innerHTML = '<p><b>921</b> offers created</p>';
      document.body.append(box);
    });
    try {
      expect(await kit.hasText('921 offers created')).toBe(false);
      await page.evaluate(() => void (document.getElementById('reveal-box')!.style.opacity = '0.3'));
      expect(await kit.hasText('921 offers created')).toBe(false);
      await page.evaluate(() => void (document.getElementById('reveal-box')!.style.opacity = '1'));
      expect(await kit.hasText('921  OFFERS created')).toBe(true);
      expect(await kit.hasText('Hidden action')).toBe(false);
    } finally {
      await page.evaluate(() => document.getElementById('reveal-box')?.remove());
    }
  });

  it('reports the menu trigger of a row and the field trigger of a label', async () => {
    const iceland = await kit.rowFor('Iceland');
    expect(iceland).not.toBeNull();
    const trig = await kit.menuTrigger(iceland!);
    expect(await page.evaluate((ref) => (window as unknown as { __demoStudio: { el(r: string): Element } }).__demoStudio.el(ref).id, trig!)).toBe('iceland-menu');
    const sweden = await kit.rowFor('Sweden');
    const trig2 = await kit.menuTrigger(sweden!);
    expect(await page.evaluate((ref) => (window as unknown as { __demoStudio: { el(r: string): Element } }).__demoStudio.el(ref).id, trig2!)).toBe('sweden-more');
  });
});

describe('cursor overlay', () => {
  const magentaAt = async (x: number, y: number): Promise<boolean> => {
    const png = await page.screenshot({ clip: { x: x - 2, y: y - 2, width: 4, height: 4 } });
    // Decode via the browser itself to avoid an image dependency.
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data;
      let hits = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i + 1] < 30 && d[i + 2] > 230) hits++;
      return hits >= 4;
    }, png.toString('base64'));
  };

  it('follows real input, survives a full navigation and is re-attached when removed', async () => {
    await page.goto(`${server.url}/overlay-a.html`);
    await page.mouse.move(300, 260);
    let st = await kit.cursorState();
    expect(st).toMatchObject({ x: 300, y: 260, known: true, visible: true });
    // Full navigation, no input since: the position is restored from sessionStorage.
    await page.goto(`${server.url}/overlay-b.html`);
    st = await kit.cursorState();
    expect(st).toMatchObject({ x: 300, y: 260, known: true, visible: true });
    expect(await page.evaluate(() => !!document.querySelector('demo-studio-cursor'))).toBe(true);
    await page.evaluate(() => document.querySelector('demo-studio-cursor')!.remove());
    await page.waitForTimeout(20);
    expect(await page.evaluate(() => document.querySelector('demo-studio-cursor')?.isConnected === true)).toBe(true);
  });

  it('is drawn above a modal dialog and above a [popover]', async () => {
    await page.goto(`${server.url}/overlay-a.html`);
    await page.mouse.move(400, 300);
    await page.waitForTimeout(50);
    expect(await magentaAt(400, 300)).toBe(true);
    await page.evaluate(() => (document.getElementById('dlg') as HTMLDialogElement).showModal());
    await page.waitForTimeout(50);
    // The dialog (opaque, centred) covers the point; the cursor must still be visible on top of it.
    expect(await page.evaluate(() => document.elementFromPoint(400, 300)?.closest('dialog')?.id)).toBe('dlg');
    expect(await magentaAt(400, 300)).toBe(true);
    await page.evaluate(() => (document.getElementById('dlg') as HTMLDialogElement).close());
    await page.evaluate(() => document.getElementById('pop')!.showPopover());
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => document.elementFromPoint(400, 300)?.id)).toBe('pop');
    expect(await magentaAt(400, 300)).toBe(true);
  });
});
