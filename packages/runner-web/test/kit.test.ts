import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import type { TargetObject } from '@demo-studio/core';
import { ERROR_DOM_MAX, openSession, kitConfigFor } from '../src/index.js';
import type { BrowserSession, KitClient, ResolveMissing } from '../src/index.js';
import { CURSOR_PAGE, OVERLAY_A, OVERLAY_B, RESOLVER_PAGE, RIPPLE_PAGE } from './pages.js';
import { startServer } from './helpers.js';
import type { TestServer } from './helpers.js';

let server: TestServer;
let session: BrowserSession;
let page: Page;
let kit: KitClient;

beforeAll(async () => {
  server = await startServer({
    '/resolver.html': RESOLVER_PAGE,
    '/overlay-a.html': OVERLAY_A,
    '/overlay-b.html': OVERLAY_B,
    '/ripple.html': RIPPLE_PAGE,
    '/cursor.html': CURSOR_PAGE,
    '/big.html': `<!doctype html><html><body>${'<section><h2>Region</h2><p>Lorem ipsum dolor sit amet</p><button>Act</button></section>'.repeat(3000)}</body></html>`,
  });
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
    rs = await openSession({ width: 1000, height: 600, scale: 1, kit: kitConfigFor(undefined, { style: 'arrow-dark', ripple_color: EDITORIAL_RIPPLE }) });
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
    cdp.on('Animation.animationStarted', (e: { animation: (typeof started)[number] }) => started.push(e.animation));
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

  it(`error DOM snippets are capped at ${ERROR_DOM_MAX / 1024} KB, cut at a tag boundary (R-KIT-10)`, async () => {
    expect(ERROR_DOM_MAX).toBe(64 * 1024);
    await page.goto(`${server.url}/big.html`);
    const html = await kit.snapshot(null, ERROR_DOM_MAX);
    const [body, note] = html.split('\n<!-- … trimmed to ');
    expect(body.length).toBeLessThanOrEqual(ERROR_DOM_MAX);
    expect(body.length).toBeGreaterThan(ERROR_DOM_MAX * 0.75);
    expect(body.endsWith('>')).toBe(true);
    expect(note).toMatch(/^\d+ of \d+ chars -->$/);
    expect(html).not.toContain('demo-studio-cursor');
    await page.goto(`${server.url}/cursor.html`);
    const small = await kit.snapshot(null, ERROR_DOM_MAX);
    expect(small).toContain('Far away');
    expect(small).not.toContain('trimmed');
  });
});
