import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Locator, Page } from 'playwright-core';
import type { BBox, TargetObject } from '@retake/core';
import { ERROR_DOM_MAX, openSession, kitConfigFor } from '../src/index.js';
import type { BrowserSession, CursorEffectPayload, CursorState, KitClient, ResolveFound, ResolveMissing } from '../src/index.js';
import { CURSOR_DIALOG_PAGE, CURSOR_FORM_PAGE, CURSOR_PAGE, FRAME_PAGE, NO_CONTENT_PAGE, OVERLAY_A, OVERLAY_B, RESOLVER_PAGE, RIPPLE_PAGE, deepPage, latePaintPage } from './pages.js';
import { startServer } from './helpers.js';
import type { TestServer } from './helpers.js';
import { PERSON_POLICY } from '@retake/core';
// Calibrated on the Mac Retake is made for (frame rates, freezes, paint and wait timings): skipped on a shared CI
// runner, where ci.yml sets RETAKE_TEST_SHARED_RUNNER=1 (fewer cores, no GPU).
const MAC_TIMING = process.env.RETAKE_TEST_SHARED_RUNNER !== '1';

let server: TestServer;
/** Another origin (another port) serving the frame page: its content must stay out of reach. */
let cross: TestServer;
let session: BrowserSession;
let page: Page;
let kit: KitClient;

beforeAll(async () => {
  cross = await startServer({ '/frame.html': FRAME_PAGE });
  server = await startServer({
    '/deep.html': deepPage(cross.url),
    '/frame.html': FRAME_PAGE,
    '/resolver.html': RESOLVER_PAGE,
    '/overlay-a.html': OVERLAY_A,
    '/overlay-b.html': OVERLAY_B,
    '/late.html': latePaintPage(1000),
    '/plain.html': NO_CONTENT_PAGE,
    '/ripple.html': RIPPLE_PAGE,
    '/cursor.html': CURSOR_PAGE,
    '/cursor-dialog.html': CURSOR_DIALOG_PAGE,
    '/cursor-form.html': CURSOR_FORM_PAGE,
    '/big.html': `<!doctype html><html><body>${'<section><h2>Region</h2><p>Lorem ipsum dolor sit amet</p><button>Act</button></section>'.repeat(3000)}</body></html>`,
    '/widget.html': `<!doctype html><html><body><main><button id="top-save">Save changes</button><input id="nd" type="date" min="2026-10-01" max="2026-12-31">
      <iframe id="w" srcdoc="<button id='fr-save'>Save</button>"></iframe><div id="many" hidden></div></main></body></html>`,
  });
  session = await openSession({ policy: PERSON_POLICY, width: 1000, height: 700, scale: 1, kit: kitConfigFor(undefined, { style: 'debug' }) });
  page = await session.page('main');
  kit = session.kit(page);
});

afterAll(async () => {
  await session?.close();
  await server?.close();
  await cross?.close();
});

async function idOf(t: TargetObject): Promise<string | null> {
  const r = await kit.find(t);
  if (r.count === 0) return null;
  return page.evaluate((ref) => (window as unknown as { __retake: { el(r: string): Element | null } }).__retake.el(ref)?.id ?? '', (r as { ref: string }).ref);
}

describe('resolver', () => {
  beforeAll(async () => {
    await page.goto(`${server.url}/resolver.html`);
  });

  it('prefers exact text, then case-insensitive, then substring', async () => {
    // The page's open aria-modal dialog holds a Save too: behind a modal dialog, only its own (R-FLD-11) — `in: page`
    // searches the whole page.
    expect(await idOf({ text: 'Save' })).toBe('dlg-save');
    expect((await kit.find({ text: 'Save' })).count).toBe(1);
    expect(await idOf({ text: 'Save', in: 'page' })).toBe('b-save');
    expect((await kit.find({ text: 'Save', in: 'page' })).count).toBe(2);
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
    expect(await idOf({ contains: ['Finca Quenaro', '2026'] })).toBe('card');
    expect(await idOf({ contains: ['Finca Lirandel', '2025'] })).toBe('card-a');
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

  it('scopes: listbox, popover (the topmost floating layer), page and a target object (R-TGT-07)', async () => {
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.id = 'scope-box';
      box.innerHTML =
        '<div role="listbox" id="lb"><div role="option" id="lb-pause">Pause</div></div>' +
        '<div data-radix-popper-content-wrapper id="pop" style="position:fixed;left:600px;top:20px;background:#fff"><button id="pop-pause">Pause</button></div>' +
        '<aside id="side"><button id="side-save">Save</button></aside>';
      document.body.append(box);
    });
    try {
      // Unscoped, the first "Pause" of the page is the first menu's; each scope picks its own.
      expect(await idOf({ text: 'Pause' })).toBe('mi-1');
      expect(await idOf({ text: 'Pause', in: 'page' })).toBe('mi-1');
      expect((await kit.find({ text: 'Pause', in: 'page' })).count).toBe(4);
      expect(await idOf({ text: 'Pause', in: 'listbox' })).toBe('lb-pause');
      expect(await idOf({ text: 'Pause', in: 'popover' })).toBe('pop-pause');
      expect(await idOf({ text: 'Save', in: { css: 'aside' } })).toBe('side-save');
      expect(await idOf({ text: 'Save', in: { role: 'dialog' } })).toBe('dlg-save');
      const missing = await kit.find({ text: 'Save', in: { css: '#nowhere' } });
      expect(missing.count).toBe(0);
      expect((missing as ResolveMissing).scope_found).toBe(false);
    } finally {
      await page.evaluate(() => document.getElementById('scope-box')?.remove());
    }
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
    expect(trig.hover).toBe(false);
    expect(await page.evaluate((ref) => (window as unknown as { __retake: { el(r: string): Element } }).__retake.el(ref).id, trig.ref!)).toBe('iceland-menu');
    const sweden = await kit.rowFor('Sweden');
    const trig2 = await kit.menuTrigger(sweden!);
    expect(await page.evaluate((ref) => (window as unknown as { __retake: { el(r: string): Element } }).__retake.el(ref).id, trig2.ref!)).toBe('sweden-more');
  });
});

describe('typed fields (R-CHO-14, R-CHO-15)', () => {
  it('fieldState tells search fields (type, role, landmark, floating popover, name) from form fields, never reading values', async () => {
    await page.goto(`${server.url}/resolver.html`);
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        `<div id="fs"><input id="fs-orders" name="orderSearch"><input id="fs-query" placeholder="Your query">
         <div role="search"><input id="fs-landmark"></div><div role="listbox"><input id="fs-pop"></div>
         <div role="dialog" aria-modal="true"><input id="fs-dlg" aria-label="Message" value="secret-ish"></div>
         <div role="dialog" data-side="bottom"><input id="fs-rename" aria-label="Lot name"></div>
         <div role="dialog" data-side="bottom"><input id="fs-tagq" aria-label="Tag"><div role="listbox"><div role="option">Washed</div></div></div>
         <div style="overflow:hidden;position:relative;width:3px;height:0"><textarea id="fs-proxy" style="position:absolute;bottom:-1em;width:1000px;height:1em"></textarea></div>
         <div id="fs-widget" tabindex="0">grid</div>
         <textarea id="fs-ta"></textarea><div id="fs-ce" contenteditable="true">x</div><input id="fs-ro" readonly value="1"></div>`,
      );
    });
    const state = async (css: string) => {
      const r = (await kit.find({ css })) as ResolveFound;
      return kit.fieldState(r.ref);
    };
    expect(await state('#i-ph')).toEqual({ editable: true, empty: true, kind: 'search', known: true });
    expect((await state('#fs-orders'))!.kind).toBe('search');
    expect((await state('#fs-query'))!.kind).toBe('text');
    expect((await state('#fs-landmark'))!.kind).toBe('search');
    expect((await state('#fs-pop'))!.kind).toBe('search');
    expect(await state('#fs-dlg')).toEqual({ editable: true, empty: false, kind: 'text', known: true });
    // A popover holding a small form is no search; one listing options is (review fix K10).
    expect((await state('#fs-rename'))!.kind).toBe('text');
    expect((await state('#fs-tagq'))!.kind).toBe('search');
    // An editor's hidden input (clipped to a 3 × 0 px box) and a focusable widget are not read (review fix K4).
    await page.focus('#fs-proxy');
    expect(await kit.fieldState(null)).toMatchObject({ editable: true, empty: true, known: false });
    await page.focus('#fs-widget');
    expect(await kit.fieldState(null)).toMatchObject({ editable: false, known: false });
    expect((await state('#cb-region'))!.editable).toBe(false);
    expect(await state('#fs-ta')).toEqual({ editable: true, empty: true, kind: 'multiline', known: true });
    expect(await state('#fs-ce')).toEqual({ editable: true, empty: false, kind: 'multiline', known: true });
    expect((await state('#fs-ro'))!.editable).toBe(false);
    // Nothing focused: null.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await kit.fieldState(null)).toBeNull();
    await page.evaluate(() => document.getElementById('fs')!.remove());
  });
});

describe('review fixes K9, K11, K12', () => {
  beforeAll(async () => {
    await page.goto(`${server.url}/widget.html`);
    await page.frameLocator('#w').locator('#fr-save').waitFor();
  });

  it("chooses the text tier on the page's own matches: an exact match in a widget frame does not beat a partial one", async () => {
    expect(await idOf({ text: 'Save' })).toBe('top-save');
    expect((await kit.find({ text: 'Save' })).count).toBe(1);
    expect(await idOf({ role: 'button', name: 'Save' })).toBe('top-save');
    // Inside the frame (or when the page has no match), the frame's own tiers.
    expect(await idOf({ text: 'Save', in: { css: '#w' } })).toBe('fr-save');
    expect(await idOf({ text: 'Save', exact: true })).toBe('fr-save');
  });

  it('a native date input never takes a day outside its min / max', async () => {
    const d = (await kit.find({ css: '#nd' })) as ResolveFound;
    expect(await kit.setNativeValue(d.ref, '2026-11-03')).toBe(true);
    expect(await kit.setNativeValue(d.ref, '2027-03-01')).toBe(false);
    expect(await kit.setNativeValue(d.ref, '2026-09-30')).toBe(false);
    expect(await page.locator('#nd').inputValue()).toBe('2026-11-03');
  });

  it('keeps the latest changes after a large re-render', async () => {
    await kit.watchChanges();
    await page.evaluate(() => {
      const many = document.getElementById('many')!;
      for (let i = 0; i < 600; i++) many.appendChild(document.createElement('span'));
      const toast = document.createElement('div');
      toast.id = 'toast';
      toast.textContent = 'Saved';
      toast.style.cssText = 'position:fixed;right:16px;bottom:16px;width:120px;height:40px;background:#222;color:#fff';
      document.body.appendChild(toast);
    });
    const { boxes } = await kit.changedBoxes();
    expect(boxes.some((b) => Math.abs(b.x - (1000 - 16 - 120)) <= 1 && Math.abs(b.y - (700 - 16 - 40)) <= 1)).toBe(true);
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
    expect(await page.evaluate(() => !!document.querySelector('retake-cursor'))).toBe(true);
    await page.evaluate(() => document.querySelector('retake-cursor')!.remove());
    await page.waitForTimeout(20);
    expect(await page.evaluate(() => document.querySelector('retake-cursor')?.isConnected === true)).toBe(true);
  });

  it.skipIf(!MAC_TIMING)('a cursor carried to a new document is drawn once the page painted content of its own, or when revealed (R-ISS-08)', async () => {
    await page.goto(`${server.url}/overlay-a.html`);
    await page.mouse.move(300, 260);
    await page.waitForTimeout(50);
    expect(await magentaAt(300, 260)).toBe(true);
    // A page that paints only a skeleton for 1 s: the restored cursor would be its first contentful paint — not drawn.
    await page.goto(`${server.url}/late.html`);
    await page.waitForTimeout(300);
    expect(await kit.cursorState()).toMatchObject({ x: 300, y: 260, known: true, visible: true });
    expect(await magentaAt(300, 260)).toBe(false);
    expect(await page.evaluate(() => performance.getEntriesByName('first-contentful-paint').length)).toBe(0);
    await page.waitForFunction(() => document.body.innerText.includes('Report ready'));
    await page.waitForTimeout(150);
    expect(await magentaAt(300, 260)).toBe(true);
    // A page that never paints content: drawn when the runner reveals it (after the load it waited for).
    await page.goto(`${server.url}/plain.html`);
    await page.waitForTimeout(200);
    expect(await magentaAt(300, 260)).toBe(false);
    await kit.cursorReveal();
    await page.waitForTimeout(50);
    expect(await magentaAt(300, 260)).toBe(true);
  });

  it('debug style: a 6×6 #FF00FF square centred on the hotspot, over the arrow (R-KIT-06)', async () => {
    await page.goto(`${server.url}/overlay-a.html`);
    await kit.cursorSet(700, 420, true);
    await page.waitForTimeout(50);
    const img = await decodePng(page, await page.screenshot({ clip: { x: 690, y: 410, width: 20, height: 20 } }));
    const hits: Array<[number, number]> = [];
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) {
        const i = (y * img.w + x) * 4;
        if (img.data[i] === 255 && img.data[i + 1] === 0 && img.data[i + 2] === 255) hits.push([x, y]);
      }
    }
    // Exactly the pixels [x − 3, x + 3) × [y − 3, y + 3): the hotspot (700, 420) is at (10, 10) in the clip.
    expect(hits).toHaveLength(36);
    expect(hits.every(([x, y]) => x >= 7 && x <= 12 && y >= 7 && y <= 12)).toBe(true);
    // The arrow is still drawn under it (its outline and fill reach below the square).
    const below = Array.from({ length: 6 }, (_, k) => img.data[((14 + k) * img.w + 11) * 4]);
    expect(Math.min(...below)).toBeLessThan(60);
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

/** Decode a PNG through the page itself (no image dependency): RGBA pixels. */
async function decodePng(p: Page, png: Buffer): Promise<{ w: number; h: number; data: number[] }> {
  return p.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    return { w: img.width, h: img.height, data: Array.from(g.getImageData(0, 0, img.width, img.height).data) };
  }, png.toString('base64'));
}

describe('click ripple (R-ISS-03, R-CHO-05)', () => {
  const EDITORIAL_RIPPLE = 'rgba(138, 35, 50, 0.45)';
  const BUTTON = [138, 35, 50];
  const C = { x: 380, y: 260 }; // centre of the burgundy button (no text near it)
  let rs: BrowserSession;
  let rp: Page;

  beforeAll(async () => {
    rs = await openSession({ policy: PERSON_POLICY, width: 1000, height: 600, scale: 1, kit: kitConfigFor(undefined, { style: 'arrow-dark', ripple_color: EDITORIAL_RIPPLE }) });
    rp = await rs.page('main');
  });
  afterAll(async () => {
    await rs?.close();
  });

  /** Fire a ripple at C, pause its animations at `ms` through CDP, and count the pixels around C that differ from the button. */
  async function rippleAt(ms: number): Promise<{ distinct: number; maxDiff: number; anims: Array<{ name: string; duration: number; easing: string; keyframes: string }> }> {
    await rp.goto(`${server.url}/ripple.html`);
    await rp.mouse.move(900, 560); // the drawn cursor stays away from the measured area
    const cdp = await rp.context().newCDPSession(rp);
    await cdp.send('Animation.enable');
    const started: Array<{ id: string; name: string; source: { duration: number; keyframesRule?: { keyframes: Array<{ easing: string }> } } }> = [];
    cdp.on('Animation.animationStarted', (e) => started.push(e.animation as unknown as (typeof started)[number]));
    await rs.kit(rp).ripple(C.x, C.y);
    for (let i = 0; i < 50 && started.length < 2; i++) await rp.waitForTimeout(10);
    const ids = started.map((a) => a.id);
    await cdp.send('Animation.setPaused', { animations: ids, paused: true });
    await cdp.send('Animation.seekAnimations', { animations: ids, currentTime: ms });
    const anims = [];
    for (const a of started) {
      const { remoteObject } = (await cdp.send('Animation.resolveAnimation', { animationId: a.id })) as { remoteObject: { objectId: string } };
      const { result } = (await cdp.send('Runtime.callFunctionOn', {
        objectId: remoteObject.objectId,
        functionDeclaration: 'function () { return JSON.stringify(this.effect.getKeyframes().map((k) => k.transform || k.opacity)); }',
        returnByValue: true,
      })) as { result: { value: string } };
      anims.push({ name: a.name, duration: a.source.duration, easing: a.source.keyframesRule?.keyframes[0]?.easing ?? '', keyframes: result.value });
    }
    await rp.waitForTimeout(50);
    const png = await rp.screenshot({ clip: { x: C.x - 50, y: C.y - 50, width: 100, height: 100 } });
    await cdp.detach();
    const img = await decodePng(rp, png);
    let distinct = 0;
    let maxDiff = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const d = Math.max(Math.abs(img.data[i] - BUTTON[0]), Math.abs(img.data[i + 1] - BUTTON[1]), Math.abs(img.data[i + 2] - BUTTON[2]));
      maxDiff = Math.max(maxDiff, d);
      if (d > 60) distinct++;
    }
    return { distinct, maxDiff, anims };
  }

  it('follows the field notes: 12 px disc, scale .4 → 5.5, opacity 1 → 0, .5 s / .55 s curves', async () => {
    const { anims } = await rippleAt(100);
    const byName = Object.fromEntries(anims.map((a) => [a.name, a]));
    expect(byName['dsr-t']).toMatchObject({ duration: 500, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    expect(byName['dsr-t'].keyframes).toMatch(/scale\(0\.4\).*scale\(5\.5\)/);
    expect(byName['dsr-o']).toMatchObject({ duration: 550, easing: 'ease-out' });
    expect(JSON.parse(byName['dsr-o'].keyframes)).toEqual(['1', '0']);
  });

  it('is clearly distinguishable on a button of the same colour as the ripple (contrasting ring)', async () => {
    // Strong while it expands, still distinguishable while it fades out (opacity 1 → 0 over .55 s ease-out bounds
    // the contrast: at 200 ms the ring is ~50 % opaque, i.e. at most ~105 levels away from the button on one channel).
    for (const [ms, minDiff] of [[60, 100], [150, 100], [200, 70], [300, 40]] as const) {
      const { distinct, maxDiff } = await rippleAt(ms);
      expect(maxDiff, `${ms} ms`).toBeGreaterThan(minDiff);
      if (ms <= 200) expect(distinct, `${ms} ms`).toBeGreaterThan(150);
    }
    // Control: the same disc without the ring (the previous ripple) is invisible on that button.
    await rp.goto(`${server.url}/ripple.html`);
    await rp.evaluate(([x, y, color]) => {
      const d = document.createElement('div');
      d.style.cssText = `position:fixed;left:${x - 21}px;top:${y - 21}px;width:42px;height:42px;border-radius:50%;background:${color}`;
      document.body.appendChild(d);
    }, [C.x, C.y, EDITORIAL_RIPPLE] as const);
    const img = await decodePng(rp, await rp.screenshot({ clip: { x: C.x - 50, y: C.y - 50, width: 100, height: 100 } }));
    let distinct = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const d = Math.max(Math.abs(img.data[i] - BUTTON[0]), Math.abs(img.data[i + 1] - BUTTON[1]), Math.abs(img.data[i + 2] - BUTTON[2]));
      if (d > 60) distinct++;
    }
    expect(distinct).toBe(0);
  });
});

describe('scene-start rest point and DOM snippets', () => {
  it('restNear keeps the drawn cursor off the target, inside the viewport, preferably over a neutral spot', async () => {
    await page.goto(`${server.url}/cursor.html`);
    const W = 1000;
    const H = 700;
    const boxOf = async (text: string) => {
      const r = await kit.find({ text });
      return (r as { bbox: { x: number; y: number; w: number; h: number } }).bbox;
    };
    for (const box of [await boxOf('Start'), await boxOf('Far away'), { x: W - 60, y: 10, w: 50, h: 30 }, { x: 10, y: H - 40, w: 60, h: 30 }]) {
      const p = await kit.restNear(box);
      const coversX = p.x + 28 > box.x - 4 && p.x - 6 < box.x + box.w + 4;
      const coversY = p.y + 32 > box.y - 4 && p.y - 6 < box.y + box.h + 4;
      expect(coversX && coversY, JSON.stringify({ box, p })).toBe(false);
      expect(p.x).toBeGreaterThan(0);
      expect(p.y).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(W - 30);
      expect(p.y).toBeLessThan(H - 30);
      expect(Math.hypot(p.x - (box.x + box.w / 2), p.y - (box.y + box.h / 2))).toBeLessThan(220);
      expect(p.side).not.toBe('fallback');
    }
    // A target filling the viewport leaves no room: the neutral right-centre point is used.
    expect((await kit.restNear({ x: 0, y: 0, w: W, h: H })).side).toBe('fallback');
  });

  it('restNear rests next to the click point of a wide target and inside the dialog that holds it (R-MAC-06)', async () => {
    await page.goto(`${server.url}/cursor-dialog.html`);
    const r = (await kit.find({ text: 'Pick dates' })) as { ref: string; bbox: { x: number; y: number; w: number; h: number } };
    const pt = (await kit.point(r.ref))!;
    const dialog = await page.locator('[role=dialog]').boundingBox();
    const inDialog = (q: { x: number; y: number }) =>
      q.x > dialog!.x && q.y > dialog!.y && q.x + 26 < dialog!.x + dialog!.width && q.y + 32 < dialog!.y + dialog!.height;
    // A button at the dialog's right edge: its natural rest point (below-right) is on the backdrop unless the dialog
    // is known.
    const close = (await kit.find({ aria: 'Close' })) as { ref: string; bbox: { x: number; y: number; w: number; h: number } };
    expect(inDialog(await kit.restNear(close.bbox))).toBe(false);
    expect(inDialog(await kit.restNear(close.bbox, { ref: close.ref }))).toBe(true);
    // The 480 px field: next to where it is clicked, inside the dialog.
    const p = await kit.restNear(r.bbox, { point: { x: pt.x, y: pt.y }, ref: r.ref });
    expect(p.side).not.toBe('fallback');
    expect(inDialog(p)).toBe(true);
    expect(Math.hypot(p.x - pt.x, p.y - pt.y)).toBeLessThan(160);
    const coversX = p.x + 28 > r.bbox.x - 4 && p.x - 6 < r.bbox.x + r.bbox.w + 4;
    const coversY = p.y + 32 > r.bbox.y - 4 && p.y - 6 < r.bbox.y + r.bbox.h + 4;
    expect(coversX && coversY).toBe(false);
  });

  it('restNear finds a neutral gap close to the click point when every usual spot is a field (R-MAC-06)', async () => {
    await page.goto(`${server.url}/cursor-form.html`);
    const r = (await kit.find({ text: 'Pick dates' })) as { ref: string; bbox: { x: number; y: number; w: number; h: number } };
    const pt = (await kit.point(r.ref))!;
    const p = await kit.restNear(r.bbox, { point: { x: pt.x, y: pt.y }, ref: r.ref });
    expect(p.side).toMatch(/^near-/);
    expect(Math.hypot(p.x - pt.x, p.y - pt.y)).toBeLessThan(100);
    const under = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y)!;
      return { tag: el.tagName, cursor: getComputedStyle(el).cursor, dialog: !!el.closest('[role=dialog]') };
    }, [p.x, p.y] as const);
    expect(under.dialog).toBe(true);
    expect(['SELECT', 'BUTTON', 'TEXTAREA', 'INPUT']).not.toContain(under.tag);
    expect(['pointer', 'text']).not.toContain(under.cursor);
  });

  it(`error DOM snippets are capped at ${ERROR_DOM_MAX / 1024} KB, cut at a tag boundary (R-KIT-10)`, async () => {
    expect(ERROR_DOM_MAX).toBe(64 * 1024);
    await page.goto(`${server.url}/big.html`);
    const html = await kit.snapshot(null, ERROR_DOM_MAX);
    const [body, note] = html.split('\n<!-- … trimmed to ');
    expect(body.length).toBeLessThanOrEqual(ERROR_DOM_MAX);
    expect(body.length).toBeGreaterThan(ERROR_DOM_MAX * 0.75);
    expect(body.endsWith('>')).toBe(true);
    expect(note).toMatch(/^\d+ of \d+ chars -->$/);
    expect(html).not.toContain('retake-cursor');
    await page.goto(`${server.url}/cursor.html`);
    const small = await kit.snapshot(null, ERROR_DOM_MAX);
    expect(small).toContain('Far away');
    expect(small).not.toContain('trimmed');
  });
});

describe('open shadow roots and same-origin frames (R-ISS-07, R-KIT-11)', () => {
  const ship = () => page.frameLocator('#ship');
  /** The deep page with every frame loaded (the cross-origin one included: it then counts as not searchable). */
  async function openDeep(): Promise<void> {
    await page.goto(`${server.url}/deep.html`);
    await ship().locator('#estimate').waitFor();
    await ship().frameLocator('#nested').locator('#nested-btn').waitFor();
    await page.frameLocator('#cross').locator('#estimate').waitFor();
    await page.locator('nf-embed').locator('#emb-frame').contentFrame().locator('#emb').waitFor();
  }
  async function found(t: TargetObject): Promise<ResolveFound> {
    const r = await kit.find(t);
    expect(r.count, JSON.stringify(t)).toBeGreaterThan(0);
    return r as ResolveFound;
  }
  /** The kit's box (top-level px) equals Playwright's box of the same element (main-frame px) within 0.5 px. */
  async function sameBox(box: BBox, loc: Locator, what: string): Promise<void> {
    const pw = (await loc.boundingBox())!;
    expect(pw, what).not.toBeNull();
    for (const [a, b] of [[box.x, pw.x], [box.y, pw.y], [box.w, pw.width], [box.h, pw.height]]) expect(Math.abs(a - b), `${what} ${JSON.stringify({ box, pw })}`).toBeLessThanOrEqual(0.5);
  }
  async function cursorAt(x: number, y: number, kind?: CursorState['kind']): Promise<CursorState> {
    let st = await kit.cursorState();
    for (let i = 0; i < 100 && !(st.x === x && st.y === y && (!kind || st.kind === kind)); i++) {
      await page.waitForTimeout(20);
      st = await kit.cursorState();
    }
    return st;
  }

  beforeAll(openDeep);

  it('finds targets inside open shadow roots (nested, slotted), never inside a closed one', async () => {
    expect(await idOf({ text: 'Add bag' })).toBe('sh-addbag');
    expect((await kit.find({ text: 'Add bag' })).count).toBe(2); // + the component inside the frame
    expect(await idOf({ role: 'button', name: 'Remove bag' })).toBe('sh-remove');
    expect(await idOf({ aria: 'Remove bag' })).toBe('sh-remove');
    expect(await idOf({ label: 'Note' })).toBe('sh-note');
    expect(await idOf({ placeholder: 'Tasting note' })).toBe('sh-note');
    expect(await idOf({ testid: 'sh-tid' })).toBe('sh-tidspan');
    expect(await idOf({ css: '#sh-add' })).toBe('sh-add');
    expect(await idOf({ text: 'Deep badge' })).toBe('deep-badge');
    expect(await idOf({ text: 'Slotted title' })).toBe('slotted');
    expect((await kit.find({ text: 'Closed action' })).count).toBe(0);
    const hidden = (await kit.find({ text: 'Shadow hidden' })) as ResolveMissing;
    expect(hidden.count).toBe(0);
    expect(hidden.hidden).toBeGreaterThan(0);
  });

  it('finds targets inside same-origin frames, nested frames and a frame inside a shadow root; not across origins', async () => {
    expect(await idOf({ text: 'Estimate' })).toBe('estimate');
    expect((await kit.find({ text: 'Estimate' })).count).toBe(1); // the cross-origin copy is out of reach
    expect((await found({ label: 'Destination' })).tag).toBe('select');
    expect(await idOf({ label: 'Bags' })).toBe('fbags');
    expect(await idOf({ role: 'button', name: 'Nested frame button' })).toBe('nested-btn');
    expect(await idOf({ text: 'Embedded' })).toBe('emb');
    expect(await idOf({ text: 'Add bag', nth: 1 })).toBe('fsh-addbag'); // a shadow root inside the frame
    const missing = (await kit.find({ text: 'Nowhere to be found' })) as ResolveMissing;
    expect(missing.count).toBe(0);
    expect(missing.desc).toBe('1 cross-origin frame not searched');
  });

  it('counts matches in composed order and scopes into a frame or a component', async () => {
    const order: Array<string | null> = [];
    for (let i = 0; i < 4; i++) order.push(await idOf({ text: 'Add', exact: true, nth: i }));
    expect(order).toEqual(['light-add', 'sh-add', 'fr-add', 'fsh-add']);
    expect((await kit.find({ text: 'Add', exact: true })).count).toBe(4);
    expect(await idOf({ text: 'Add', exact: true, last_visible: true })).toBe('fsh-add');
    expect((await kit.find({ text: 'Add', exact: true, in: { css: '#ship' } })).count).toBe(2);
    expect(await idOf({ text: 'Add', exact: true, in: { css: '#ship' } })).toBe('fr-add');
    expect((await kit.find({ text: 'Add', exact: true, in: { css: 'nf-stepper' } })).count).toBe(1);
    expect(await idOf({ text: 'Add', exact: true, in: { css: 'nf-stepper' } })).toBe('sh-add');
    expect(await idOf({ text: 'Confirm', in: 'dialog' })).toBe('sh-confirm');
    const dlg = (await page.locator('#sh-dlg').boundingBox())!;
    const popups = await kit.popupState();
    expect(popups.some((p) => Math.abs(p.bbox.x - dlg.x) <= 0.5 && Math.abs(p.bbox.y - dlg.y) <= 0.5 && p.kind === 'dialog')).toBe(true);
  });

  it('boxes and points are in top-level px (frame borders, padding, page and frame scroll); hit tests pierce', async () => {
    const est = await found({ text: 'Estimate' });
    const nested = await found({ text: 'Nested frame button' });
    const shAdd = await found({ css: '#sh-add' });
    await sameBox(est.bbox, ship().locator('#estimate'), 'estimate');
    await sameBox(nested.bbox, ship().frameLocator('#nested').locator('#nested-btn'), 'nested');
    await sameBox(shAdd.bbox, page.locator('#sh-add'), 'sh-add');
    expect((await kit.point(est.ref))!.hit).toBe(true);
    expect((await kit.point(shAdd.ref))!.hit).toBe(true);
    expect((await kit.point((await found({ text: 'Embedded' })).ref))!.hit).toBe(true);
    // A slotted label inside a shadow button: the button is hit through its slot.
    const pill = await found({ css: 'button', in: { css: 'nf-pill' } });
    expect(await idOf({ css: 'button', in: { css: 'nf-pill' } })).toBe('pill-btn');
    expect((await kit.point(pill.ref))!.hit).toBe(true);
    // Covered by a page element over the frame: not hit.
    await page.evaluate(() => void (document.getElementById('cover')!.style.display = 'block'));
    expect((await kit.point(est.ref))!.hit).toBe(false);
    await page.evaluate(() => void (document.getElementById('cover')!.style.display = 'none'));
    // Page and frame scrolled.
    await page.evaluate(() => window.scrollTo(0, 40));
    await ship().locator('body').evaluate(() => window.scrollTo(0, 30));
    for (const [t, loc, what] of [
      [{ text: 'Estimate' }, ship().locator('#estimate'), 'estimate scrolled'],
      [{ text: 'Nested frame button' }, ship().frameLocator('#nested').locator('#nested-btn'), 'nested scrolled'],
      [{ css: '#sh-add' }, page.locator('#sh-add'), 'sh-add scrolled'],
    ] as Array<[TargetObject, Locator, string]>) {
      await sameBox((await found(t)).bbox, loc, what);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await ship().locator('body').evaluate(() => window.scrollTo(0, 0));
  });

  it('hasText reads shadow roots and frames; a native <select> in a frame is set in its own realm', async () => {
    expect(await kit.hasText('3 bags')).toBe(true);
    expect(await kit.hasText('Shadow hidden')).toBe(false);
    expect(await kit.hasText('Closed action')).toBe(false);
    const dest = await found({ label: 'Destination' });
    expect(await kit.selectNative(dest.ref, 'Norway')).toMatchObject({ ok: true, label: 'Norway' });
    expect(await ship().locator('#dest').inputValue()).toBe('Norway');
    expect(await kit.hasText('dest=Norway')).toBe(true);
  });

  it('the focused field is found inside a frame and inside a shadow root', async () => {
    await ship().locator('#fbags').focus();
    expect(await kit.isTextInput(null)).toBe(true);
    await sameBox((await kit.focused())!.bbox, ship().locator('#fbags'), 'focused frame field');
    await page.locator('#sh-note').focus();
    expect(await kit.isTextInput(null)).toBe(true);
    const f = (await kit.focused())!;
    expect(f.desc).toContain('Note');
    await sameBox(f.bbox, page.locator('#sh-note'), 'focused shadow field');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  });

  it('synthetic click strategies dispatch at frame-local coordinates in the frame realm', async () => {
    await ship().locator('#fbags').fill('7');
    const est = await found({ text: 'Estimate' });
    const pt = (await kit.point(est.ref))!;
    await kit.pointerSequence(est.ref, pt.x, pt.y);
    const box = (await page.locator('#ship').boundingBox())!;
    const last = await ship().locator('body').evaluate(() => (window as unknown as { lastClick: { x: number; y: number; view: boolean; trusted: boolean } }).lastClick);
    expect(last).toMatchObject({ view: true, trusted: false });
    // #ship: 6 px border + 10 px padding.
    expect(Math.abs(last.x - (pt.x - (box.x + 16)))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(last.y - (pt.y - (box.y + 16)))).toBeLessThanOrEqual(0.5);
    expect(await ship().locator('#out').textContent()).toMatch(/^7 bags to /);
    await ship().locator('#out').evaluate((el) => void (el.textContent = '-'));
    await kit.domClick(est.ref, pt.x, pt.y);
    expect(await ship().locator('#out').textContent()).toMatch(/^7 bags to /);
  });

  it('scrolls inside a frame, then the page around it (innermost first); scroll containers and positions', async () => {
    await openDeep();
    const far = await found({ text: 'Far in frame' });
    expect(far.in_view).toBe(false);
    const ops = [];
    for (let i = 0; i < 6; i++) {
      const op = await kit.scrollPlan(far.ref, 80);
      if (!op) break;
      ops.push(op);
      await kit.scrollAnimate(op.container, op.top, op.left, 0);
    }
    expect(ops.length).toBeGreaterThan(0);
    expect(ops[0].container).not.toBe(''); // the frame's own scroller first
    expect((await found({ text: 'Far in frame' })).in_view).toBe(true);
    expect((await kit.point(far.ref))!.hit).toBe(true);
    const sc = await kit.scrollContainerFor(far.ref, true);
    expect(sc).not.toBe('');
    expect(await kit.scrollContainerFor((await found({ css: '#ship' })).ref)).toBe(sc); // an iframe designates its document's scroller
    const info = await kit.scrollInfo(sc, far.ref);
    const inDoc = await ship().locator('#far').evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    expect(Math.abs(info.target_top! - inDoc)).toBeLessThanOrEqual(1);
    // A frame below the page fold: the page scrolls.
    const low = await found({ text: 'Low button' });
    expect(low.in_view).toBe(false);
    expect((await kit.scrollPlan(low.ref, 80))!.container).toBe('');
  });

  it('the drawn cursor follows real input into frames (nested, inside a shadow root) with the right icon; presses ripple', async () => {
    await openDeep();
    const at = async (t: TargetObject) => (await kit.point((await found(t)).ref))!;
    const est = await at({ text: 'Estimate' });
    await page.mouse.move(est.x, est.y);
    expect(await cursorAt(est.x, est.y, 'hand')).toMatchObject({ x: est.x, y: est.y, kind: 'hand' });
    const bags = await at({ label: 'Bags' });
    await page.mouse.move(bags.x, bags.y);
    expect(await cursorAt(bags.x, bags.y, 'ibeam')).toMatchObject({ x: bags.x, y: bags.y, kind: 'ibeam' });
    const shAdd = await at({ css: '#sh-add' }); // cursor:pointer comes from the shadow stylesheet
    await page.mouse.move(shAdd.x, shAdd.y);
    expect(await cursorAt(shAdd.x, shAdd.y, 'hand')).toMatchObject({ x: shAdd.x, y: shAdd.y, kind: 'hand' });
    const emb = await at({ text: 'Embedded' }); // a frame inside a web component's shadow root
    await page.mouse.move(emb.x, emb.y);
    expect(await cursorAt(emb.x, emb.y, 'hand')).toMatchObject({ x: emb.x, y: emb.y, kind: 'hand' });
    await ship().locator('body').evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const nested = await at({ text: 'Nested frame button' });
    expect(nested.hit).toBe(true);
    await page.mouse.move(nested.x, nested.y);
    expect(await cursorAt(nested.x, nested.y)).toMatchObject({ x: nested.x, y: nested.y });
    // A real press inside the frame: press and ripple reported at the press point.
    const effects: CursorEffectPayload[] = [];
    session.onCursorEffect = (_p, e) => effects.push(e);
    try {
      await page.mouse.move(emb.x, emb.y);
      await cursorAt(emb.x, emb.y);
      await page.mouse.down();
      await page.mouse.up();
      for (let i = 0; i < 50 && !effects.some((e) => e.type === 'ripple'); i++) await page.waitForTimeout(20);
    } finally {
      session.onCursorEffect = null;
    }
    expect(effects.some((e) => e.type === 'press')).toBe(true);
    const rp = effects.find((e) => e.type === 'ripple')!;
    expect(Math.abs(rp.x! - emb.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(rp.y! - emb.y)).toBeLessThanOrEqual(0.5);
  });

  it('never picks a click-outside point inside a frame', async () => {
    await openDeep();
    await page.locator('#sh-dlg').evaluate((el) => void ((el as HTMLElement).style.display = 'none'));
    const shipBox = (await page.locator('#ship').boundingBox())!;
    const near = { x: Math.round(shipBox.x + shipBox.width / 2), y: Math.round(shipBox.y + shipBox.height / 2) };
    const plan = (await kit.outsidePlan(near, []))!;
    expect(plan).not.toBeNull();
    const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.localName, [plan.x, plan.y] as const);
    expect(['iframe', 'nf-embed']).not.toContain(under);
  });

  it('a ref into a frame that navigated reads as gone', async () => {
    await openDeep();
    const est = await found({ text: 'Estimate' });
    expect(await kit.call<boolean>('alive', est.ref)).toBe(true);
    await page.locator('#ship').evaluate((f) => void ((f as HTMLIFrameElement).src = '/frame.html?n=2'));
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      await page.waitForTimeout(20);
      alive = await kit.call<boolean>('alive', est.ref);
    }
    expect(alive).toBe(false);
  });
});
