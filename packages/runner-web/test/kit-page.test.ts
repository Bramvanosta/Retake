/**
 * What the page receives from the in-page kit (a characterization): the globals it adds, the shape of `window.__retake`
 * (every member, its type, arity and prototype), the look it draws, the natives it patches, the listeners it holds on
 * the window and the document, and the kit's answers on a fixed page — in a top document, in a same-origin frame and
 * for the recorder's passive copy, installed the way a capture installs it (an init script) and the way a re-install
 * does (evaluated in a loaded page). The golden (test/golden/kit-page.json) holds what the kit gave before it was built
 * from modules (recorded from the kit of 6e25104, `kit/kit.ts`); it is written only on request (RETAKE_UPDATE_GOLDEN=1)
 * and looked at when it is.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { kitConfigFor, kitSource } from '../src/index.js';
import type { KitConfig } from '../src/index.js';
import { startServer } from './helpers.js';
import type { TestServer } from './helpers.js';

const GOLDEN = fileURLToPath(new URL('./golden/kit-page.json', import.meta.url));

/** A fixed page: every element placed and sized (its boxes do not depend on the fonts of the machine). */
const PAGE = `<!doctype html><html><head><title>Kit</title><style>
body{margin:0;font:16px/20px sans-serif} .a{position:absolute;box-sizing:border-box;margin:0;padding:0;overflow:hidden;white-space:nowrap}
</style></head><body><main>
<h1 class="a" style="left:24px;top:16px;width:300px;height:32px;font-size:24px;line-height:32px">Orders</h1>
<form onsubmit="return false">
<label class="a" for="email" style="left:24px;top:64px;width:80px;height:24px">Email</label>
<input class="a" id="email" type="email" placeholder="you@example.com" style="left:110px;top:64px;width:200px;height:24px">
<label class="a" style="left:330px;top:64px;width:260px;height:24px">Password <input class="a" id="pw" type="password" autocomplete="current-password" style="left:100px;top:0;width:150px;height:24px"></label>
<label class="a" for="size" style="left:610px;top:64px;width:40px;height:24px">Size</label>
<select class="a" id="size" style="left:660px;top:64px;width:120px;height:24px"><option>Small</option><option>Large</option></select>
<textarea class="a" id="note" aria-label="Note" style="left:24px;top:100px;width:180px;height:40px"></textarea>
<button class="a" type="submit" style="left:220px;top:100px;width:120px;height:28px">Save changes</button>
</form>
<div class="a" role="row" style="left:24px;top:160px;width:400px;height:32px"><span class="a" role="cell" style="left:0;top:0;width:200px;height:32px">Atlantis</span><span class="a" role="cell" style="left:200px;top:0;width:200px;height:32px"><button class="a" aria-label="Row actions" style="left:160px;top:2px;width:32px;height:28px">&#8943;</button></span></div>
<div class="a" role="row" style="left:24px;top:200px;width:400px;height:32px"><span class="a" role="cell" style="left:0;top:0;width:200px;height:32px">Borealis</span><span class="a" role="cell" style="left:200px;top:0;width:200px;height:32px"><button class="a" style="left:120px;top:2px;width:72px;height:28px">Edit</button></span></div>
<a class="a" href="/orders/42" style="left:24px;top:240px;width:120px;height:24px">Order 42</a>
<div class="a" role="tablist" style="left:24px;top:280px;width:300px;height:32px"><button class="a" role="tab" aria-selected="true" style="left:0;top:0;width:100px;height:32px">General</button><button class="a" role="tab" style="left:110px;top:0;width:100px;height:32px">Billing</button></div>
<dialog id="dlg" style="position:fixed;inset:auto;left:300px;top:200px;width:300px;height:120px;margin:0;padding:0;border:0;box-sizing:border-box"><p class="a" style="left:16px;top:16px;width:200px;height:24px">Sure?</p><button class="a" style="left:16px;top:72px;width:100px;height:28px">Cancel</button><button class="a" style="left:180px;top:72px;width:100px;height:28px">Delete</button></dialog>
<div popover id="pop">Pop</div>
<iframe class="a" id="fr" srcdoc="<body style='margin:0'><button style='position:absolute;left:10px;top:10px;width:80px;height:28px'>Inner</button></body>" style="left:24px;top:330px;width:200px;height:80px;border:0"></iframe>
<div class="a" id="scroller" style="left:820px;top:16px;width:160px;height:120px;overflow:auto"><div style="position:relative;width:160px;height:600px"><button class="a" style="left:10px;top:480px;width:120px;height:28px">Far away</button></div></div>
<div class="a" id="sh" style="left:820px;top:150px;width:160px;height:40px"></div>
<script>document.getElementById('sh').attachShadow({ mode: 'open' }).innerHTML = '<button style="position:absolute;left:0;top:0;width:120px;height:28px;margin:0;padding:0;font:16px/20px sans-serif;overflow:hidden;white-space:nowrap">Shadow go</button>';</script>
<div class="a" id="cal" style="left:420px;top:330px;width:260px;height:90px"><button class="a" aria-label="Previous month" style="left:0;top:0;width:28px;height:24px">&lsaquo;</button><span class="a" style="left:40px;top:0;width:180px;height:24px">November 2026</span><button class="a" aria-label="Next month" style="left:232px;top:0;width:28px;height:24px">&rsaquo;</button><div class="a" role="grid" style="left:0;top:40px;width:260px;height:32px"><button class="a" data-date="2026-11-02" style="left:0;top:0;width:36px;height:28px">2</button><button class="a" data-date="2026-11-03" style="left:40px;top:0;width:36px;height:28px">3</button><button class="a" data-date="2026-11-04" aria-disabled="true" style="left:80px;top:0;width:36px;height:28px">4</button><button class="a" data-date="2026-12-01" data-outside style="left:120px;top:0;width:36px;height:28px">1</button></div></div>
<label class="a" for="att" style="left:24px;top:430px;width:100px;height:24px">Attachment</label>
<input class="a" id="att" type="file" style="left:130px;top:430px;width:200px;height:24px">
<label class="a" for="when" style="left:360px;top:430px;width:50px;height:24px">When</label>
<input class="a" id="when" type="date" min="2026-01-01" max="2026-12-31" style="left:420px;top:430px;width:150px;height:24px">
<div class="a" id="zone" style="left:24px;top:470px;width:300px;height:60px" ondragover="event.preventDefault()" ondrop="event.preventDefault(); this.dataset.got = event.dataTransfer.files[0].name + ':' + event.dataTransfer.files[0].size">Drop files here<input type="file" id="zf" style="display:none"></div>
<div class="a" id="opens" style="left:24px;top:550px;width:400px;height:32px"><button class="a" data-testid="open-a" style="left:0;top:0;width:100px;height:28px">Open</button><button class="a" data-testid="open-b" style="left:120px;top:0;width:100px;height:28px">Open</button><button class="a" data-testid="open-c" style="left:240px;top:0;width:100px;height:28px">Open</button></div>
</main></body></html>`;

let browser: Browser;
let server: TestServer;

beforeAll(async () => {
  server = await startServer({ '/kit.html': PAGE });
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const NATIVES = `({
  Notification: typeof Notification === 'function' ? Notification : null,
  showNotification: typeof ServiceWorkerRegistration === 'function' ? ServiceWorkerRegistration.prototype.showNotification : null,
  showModal: HTMLDialogElement.prototype.showModal,
  showPopover: HTMLElement.prototype.showPopover,
  togglePopover: HTMLElement.prototype.togglePopover,
  hidePopover: HTMLElement.prototype.hidePopover,
})`;

/** Each native the kit may patch: still native, or replaced. */
async function natives(page: Page): Promise<Record<string, string>> {
  return page.evaluate(
    `(() => { const n = ${NATIVES}; const out = {}; for (const k of Object.keys(n)) out[k] = n[k] === null ? 'absent' : /\\{\\s*\\[native code\\]\\s*\\}\\s*$/.test(Function.prototype.toString.call(n[k])) ? 'native' : 'patched'; return out; })()`,
  );
}

/** The window's own property names (sorted). */
async function globals(page: Page, of = 'window'): Promise<string[]> {
  return page.evaluate(`Object.getOwnPropertyNames(${of}).sort()`);
}

/** Every member of the kit's API: its type, a function's arity and prototype, an object's members (one level down). */
async function shape(page: Page, of = 'window'): Promise<unknown> {
  return page.evaluate(`(() => {
    const k = (${of}).__retake;
    if (!k) return null;
    const one = (v, deep) => {
      // A function's arity, and whether it is constructible (a declaration or a function expression has a prototype;
      // an arrow or a method does not).
      if (typeof v === 'function') return 'function/' + v.length + (Object.prototype.hasOwnProperty.call(v, 'prototype') ? '/prototype' : '');
      if (v && typeof v === 'object' && deep) return Object.fromEntries(Object.keys(v).sort().map((n) => [n, one(v[n], false)]));
      return typeof v;
    };
    const d = Object.getOwnPropertyDescriptor(${of}, '__retake');
    const api = Object.fromEntries(Object.keys(k).sort().map((n) => [n, one(k[n], true)]));
    return { descriptor: { configurable: d.configurable, enumerable: d.enumerable, writable: d.writable }, api, version: k.version, config: k.config };
  })()`);
}

/**
 * The listeners on the window and the document of the page's main frame, or of its first child frame, from the
 * DevTools protocol (evaluated in that frame's own context): type and options, sorted.
 */
async function listeners(page: Page, frame: 'main' | 'child' = 'main'): Promise<Record<string, string[]>> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const contexts: Array<{ id: number; auxData?: { frameId?: string; isDefault?: boolean } }> = [];
    cdp.on('Runtime.executionContextCreated', (e: { context: (typeof contexts)[number] }) => contexts.push(e.context));
    await cdp.send('Runtime.enable');
    const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string }; childFrames?: Array<{ frame: { id: string } }> } };
    const frameId = frame === 'main' ? frameTree.frame.id : frameTree.childFrames![0].frame.id;
    const contextId = contexts.find((c) => c.auxData?.frameId === frameId && c.auxData.isDefault)!.id;
    const out: Record<string, string[]> = {};
    for (const name of ['window', 'document']) {
      const { result } = (await cdp.send('Runtime.evaluate', { expression: name, contextId })) as { result: { objectId?: string } };
      const { listeners: list } = (await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId! })) as {
        listeners: Array<{ type: string; useCapture: boolean; passive: boolean; once: boolean }>;
      };
      out[name] = list.map((l) => `${l.type}${l.useCapture ? ' capture' : ''}${l.passive ? ' passive' : ''}${l.once ? ' once' : ''}`).sort();
    }
    return out;
  } finally {
    await cdp.detach();
  }
}

/** The overlay host the kit adds to a document: where it is and its attributes. */
async function overlay(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const hosts = Array.from(document.querySelectorAll('retake-cursor'));
    return {
      count: hosts.length,
      parent: hosts[0]?.parentElement?.localName ?? null,
      attributes: hosts[0] ? Object.fromEntries(Array.from(hosts[0].attributes).map((a) => [a.name, a.value])) : null,
      open_shadow: hosts[0] ? hosts[0].shadowRoot !== null : null,
      popover_open: hosts[0] ? hosts[0].matches(':popover-open') : null,
    };
  });
}

/** The kit's answers on the fixed page (refs are handed out in call order: the sequence is part of the snapshot). */
async function answers(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    type Any = (...a: unknown[]) => unknown;
    const k = (window as unknown as { __retake: Record<string, Any> & { cursor: Record<string, Any>; fileDrag: Record<string, Any> } }).__retake;
    const found = k.find({ text: 'Save changes' }) as { ref: string };
    const email = k.find({ label: 'Email' }) as { ref: string };
    const size = k.find({ label: 'Size' }) as { ref: string };
    const row = k.rowFor('Atlantis') as string;
    const out: Record<string, unknown> = {
      find: found,
      find_in_row: k.find({ text: 'Edit', in: { row: 'Borealis' } }),
      find_missing: k.find({ text: 'Save chnges' }),
      find_role: k.find({ role: 'tab', name: 'Billing' }),
      find_frame: k.find({ text: 'Inner' }),
      describe: k.describe(found.ref),
      info: k.info(email.ref),
      text_of: k.textOf(found.ref),
      visible: k.visible(found.ref),
      point: k.point(found.ref, null),
      scroll_plan: k.scrollPlan(found.ref, 24, false),
      scroll_container: k.scrollContainerFor(found.ref),
      field_state: k.fieldState(email.ref),
      is_text_input: [k.isTextInput(email.ref), k.isTextInput(size.ref)],
      select: k.selectNative(size.ref, 'Large'),
      set_value: k.setNativeValue(email.ref, 'a@b.c'),
      field_value: k.fieldValue(email.ref),
      clear: k.clearField(email.ref),
      secret: k.secretField(k.find({ label: 'Password' }) && (k.find({ label: 'Password' }) as { ref: string }).ref),
      menu_trigger: k.menuTrigger(row, false),
      positional: k.positionalTrigger(row),
      confirm: k.confirmButton(null),
      file_input: k.fileInputFor(found.ref),
      calendar: k.calendar(),
      popups: k.popupState(),
      rest: k.restPoint(),
      rest_centre: k.restPoint('centre'),
      rest_near: k.restNear({ x: 24, y: 300, width: 120, height: 32 }, {}),
      outside: k.outsidePlan({ x: 500, y: 400 }, []),
      blank: k.blankPoint({ x: 500, y: 400 }),
      // The text's own box depends on the fonts: only that it lies inside the button's.
      text_box_inside: (() => {
        const t = k.textBox(found.ref) as { x: number; y: number; w: number; h: number } | null;
        const b = (found as unknown as { bbox: { x: number; y: number; w: number; h: number } }).bbox;
        return !!t && t.x >= b.x && t.y >= b.y && t.x + t.w <= b.x + b.w && t.y + t.h <= b.y + b.h;
      })(),
      has_text: [k.hasText('Orders'), k.hasText('Nowhere at all')],
      expanded: k.expanded(found.ref),
      focused_none: k.focused(),
      visible_text: k.visibleText(found.ref),
      focus_check: k.focusCheck(email.ref),
      checks: k.checkTargets([{ text: 'Save changes' }, { text: 'Nope' }, { role: 'button', name: 'Row actions' }]),
      closest: k.closest([{ text: 'Sav' }]),
      inventory: k.inventory({ limit: 50 }),
      suggest: k.suggestFor(document.querySelector('#note')!),
      snapshot: k.snapshot(row, 400),
      watching: [k.watchChanges(), k.changedBoxes()],
      effect: [k.effectWatch(), k.effectSeen(), k.effectStop(), k.effectSeen()],
      alive: [k.alive(found.ref), k.alive('r9999'), k.el('r9999')],
    };
    k.cursor.set(140, 160, true);
    k.cursor.press(true);
    k.cursor.press(false);
    out.cursor = k.cursor.state();
    out.storage = sessionStorage.getItem((k.config as unknown as KitConfig).storage_key);
    k.fileDrag.begin({ name: 'a.csv', mime: 'text/csv', size: 3 });
    out.drop = k.fileDrag.drop(140, 160);
    return out;
  });
}

/**
 * More answers, after `answers` (its refs come first): an off-screen target in a scrolled container (an awaited
 * scrollAnimate), an open shadow root, resolver options, a file input and a dropzone that accepts, a native date input,
 * the popups with a modal dialog open, and the web notifications the kit queues (no runner binding here).
 */
async function more(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    type Any = (...a: unknown[]) => unknown;
    const k = (window as unknown as { __retake: Record<string, Any> & { cursor: Record<string, Any>; fileDrag: Record<string, Any> } }).__retake;
    const out: Record<string, unknown> = {};
    // An off-screen target in a tall overflow:auto container, scrolled into view.
    const far = k.find({ text: 'Far away' }) as { ref: string };
    const container = k.scrollContainerFor(far.ref) as string;
    const plan = k.scrollPlan(far.ref, 24, false) as { container: string; top: number; left: number } | null;
    out.scroll_before = { far, container, info: k.scrollInfo(container, far.ref), plan, point: k.point(far.ref, null), visible: k.visible(far.ref) };
    const animated = plan ? await (k.scrollAnimate(plan.container, plan.top, plan.left, 120) as Promise<unknown>) : null;
    out.scroll_after = { animated, info: k.scrollInfo(container, far.ref), again: k.find({ text: 'Far away' }), point: k.point(far.ref, null), plan: k.scrollPlan(far.ref, 24, false) };
    // An open shadow root.
    const shadow = k.find({ text: 'Shadow go' }) as { ref: string };
    out.shadow = { find: shadow, info: k.info(shadow.ref), point: k.point(shadow.ref, null), visible: k.visible(shadow.ref), role: k.find({ role: 'button', name: 'Shadow go' }) };
    // Resolver options: an ambiguous match, nth, last_visible, testid, placeholder, a near miss, exact.
    out.resolver = {
      ambiguous: k.find({ text: 'Open' }),
      nth: k.find({ text: 'Open', nth: 1 }),
      nth_last: k.find({ text: 'Open', nth: -1 }),
      nth_out: k.find({ text: 'Open', nth: 5 }),
      last_visible: k.find({ text: 'Open', last_visible: true }),
      testid: k.find({ testid: 'open-b' }),
      placeholder: k.find({ placeholder: 'you@example.com' }),
      placeholder_part: k.find({ placeholder: 'you@' }),
      near: k.find({ text: 'Opne' }),
      exact_miss: k.find({ text: 'Ope', exact: true }),
      in_row: k.find({ role: 'button', in: { row: 'Atlantis' } }),
      hidden_file: k.find({ css: '#zf' }, { include_hidden: true }),
      hidden_default: k.find({ css: '#zf' }),
      checks: k.checkTargets([{ text: 'Open' }, { testid: 'open-c' }, { text: 'Shadow go' }, { text: 'Far away' }]),
      closest: k.closest([{ text: 'Opn' }, { placeholder: 'you@' }]),
    };
    // A file input and a dropzone that accepts (holding a hidden file input).
    const zone = k.find({ text: 'Drop files here' }) as { ref: string; bbox: { x: number; y: number; w: number; h: number } };
    const att = k.find({ label: 'Attachment' }) as { ref: string };
    k.fileDrag.begin({ name: 'b.csv', mime: 'text/csv', size: 5 });
    const drop = k.fileDrag.drop(zone.bbox.x + zone.bbox.w / 2, zone.bbox.y + zone.bbox.h / 2);
    out.files = {
      zone,
      zone_input: k.fileInputFor(zone.ref),
      att,
      att_info: k.info(att.ref),
      att_input: k.fileInputFor(att.ref),
      drop,
      got: (document.getElementById('zone') as HTMLElement).dataset.got ?? null,
    };
    // A native date input with a range.
    const when = k.find({ label: 'When' }) as { ref: string };
    out.date = {
      out_of_range: k.setNativeValue(when.ref, '2027-01-01'),
      bad: k.setNativeValue(when.ref, 'soon'),
      ok: k.setNativeValue(when.ref, '2026-05-05'),
      value: k.fieldValue(when.ref),
      state: k.fieldState(when.ref),
    };
    // A modal dialog opened with showModal(): the popups, its confirm button, the overlay kept in the top layer.
    const dlg = document.getElementById('dlg') as HTMLDialogElement;
    dlg.showModal();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const host = document.querySelector('retake-cursor');
    out.modal = {
      popups: k.popupState(),
      confirm: k.confirmButton(null),
      confirm_named: k.confirmButton('Delete'),
      in_dialog: k.find({ text: 'Delete', in: 'dialog' }),
      behind: k.find({ text: 'Save changes' }),
      blank: k.blankPoint({ x: 500, y: 400 }),
      outside: k.outsidePlan({ x: 500, y: 400 }, []),
      rest_near: k.restNear({ x: 480, y: 272, width: 100, height: 28 }, {}),
      calendar: k.calendar(),
      overlay_open: host ? host.matches(':popover-open') : null,
      overlay_last: host ? host.parentElement?.lastElementChild === host : null,
    };
    dlg.close();
    out.after_modal = { popups: k.popupState(), confirm: k.confirmButton(null) };
    // Web notifications: queued for the runner (no binding here), the page's call unchanged.
    const N = (window as unknown as { Notification?: (new (title: string, options?: unknown) => Notification) & { permission?: string } }).Notification;
    if (N) {
      const n1 = new N('x');
      const n2 = new N('Build done', { body: 'All green', tag: 'b1', icon: '/icon.png' });
      const queued = (window as unknown as { __retakeNotifications?: Array<Record<string, unknown>> }).__retakeNotifications ?? [];
      out.notifications = {
        name: N.name,
        length: N.length,
        permission: N.permission,
        instance: n1 instanceof N && n2 instanceof N,
        titles: [n1.title, n2.title, n2.body, n2.tag],
        queued: queued.map((p) => ({ ...p, time: typeof p.time })),
      };
    } else out.notifications = 'absent';
    return out;
  });
}

/** Pointer input a sub-frame posts to the top document (the frame pointer relay): the cursor after each message. */
async function framePointer(page: Page): Promise<unknown> {
  const frame = page.mainFrame().childFrames()[0];
  const out: unknown[] = [];
  for (const m of [
    { hello: 1 },
    { __retakePtr: 1, type: 'move', x: 5, y: 6 },
    { __retakePtr: 1, type: 'down', x: 7, y: 8 },
    { __retakePtr: 1, type: 'up', x: 7, y: 8 },
    { __retakePtr: 1, type: 'move', x: 'a', y: 1 },
  ]) {
    // The kit's listener was added when it installed: it runs before this one.
    const got = page.evaluate(
      () =>
        new Promise((resolve) => {
          addEventListener('message', () => resolve((window as unknown as { __retake: { cursor: { state(): unknown } } }).__retake.cursor.state()), { once: true });
        }),
    );
    await frame.evaluate((msg) => parent.postMessage(msg, '*'), m);
    out.push({ message: m, cursor: await got });
  }
  return out;
}

async function snapshotOf(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const config = kitConfigFor(undefined, { style: 'arrow-light', size: 30, ripple_color: 'rgba(1,2,3,.4)' });
  const plain = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await plain.goto(`${server.url}/kit.html`);
  const base = await globals(plain);
  const baseFrame = await globals(plain, `document.getElementById('fr').contentWindow`);
  const baseListeners = await listeners(plain);
  const baseFrameListeners = await listeners(plain, 'child');
  const added = (now: string[], before: string[]) => now.filter((n) => !before.includes(n));
  out.natives_without_kit = await natives(plain);
  await plain.close();

  // As a capture installs it: an init script in every document (the frame included).
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.addInitScript({ content: kitSource(config) });
  await page.goto(`${server.url}/kit.html`);
  await page.evaluate(() => (window as unknown as { __retake: { cursor: { reveal(): void } } }).__retake.cursor.reveal());
  out.top = {
    globals_added: added(await globals(page), base),
    shape: await shape(page),
    natives: await natives(page),
    listeners: await listeners(page),
    listeners_before: baseListeners,
    overlay: await overlay(page),
    look: await page.evaluate(() => (window as unknown as { __retake: { cursorLook: unknown } }).__retake.cursorLook),
  };
  const frameWin = `document.getElementById('fr').contentWindow`;
  out.frame = {
    globals_added: added(await globals(page, frameWin), baseFrame),
    shape: await shape(page, frameWin),
    listeners: await listeners(page, 'child'),
    listeners_before: baseFrameListeners,
  };
  out.answers = await answers(page);
  out.more = await more(page);
  out.frame_pointer = await framePointer(page);
  // Evaluated again in the same document: the healthy kit of the same version stays (same object).
  out.reinstall_same = await page.evaluate(`(() => { const a = window.__retake; ${kitSource(config)}; return { same: window.__retake === a, healthy: a.healthy() }; })()`);
  // Disposed, then evaluated again: a new kit carries the cursor over.
  out.after_dispose = await page.evaluate(
    `(() => { const a = window.__retake; a.dispose(); const healthy = a.healthy(); ${kitSource(config)}; const b = window.__retake; return { healthy, replaced: b !== a, cursor: b.cursor.state(), hosts: document.querySelectorAll('retake-cursor').length }; })()`,
  );
  out.after_dispose_listeners = await listeners(page);
  await page.close();

  // The recorder's copy, evaluated in a loaded page.
  const passive = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await passive.goto(`${server.url}/kit.html`);
  await passive.evaluate(kitSource({ ...kitConfigFor(undefined, { hidden: true }), passive: true }));
  out.passive = {
    globals_added: added(await globals(passive), base),
    shape: await shape(passive),
    natives: await natives(passive),
    listeners: await listeners(passive),
    overlay: await overlay(passive),
    healthy: await passive.evaluate(() => (window as unknown as { __retake: { healthy(): boolean } }).__retake.healthy()),
  };
  await passive.close();

  // The look for the other styles (the debug dot, the default ripple).
  const look = await browser.newPage();
  await look.evaluate(kitSource(kitConfigFor(undefined, { style: 'debug' })));
  out.look_debug = await look.evaluate(() => (window as unknown as { __retake: { cursorLook: unknown } }).__retake.cursorLook);
  await look.close();
  return out;
}

/** The snapshot without what changes from run to run: the test server's port, the inspection's own duration. */
function stable(snap: Record<string, unknown>): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(snap).replaceAll(server.url, 'http://test.server')) as Record<string, unknown> & { answers: { inventory: { ms?: number }; checks: { ms?: number } } };
  delete out.answers.inventory.ms;
  delete out.answers.checks.ms;
  return out;
}

describe('what the page receives from the kit', () => {
  it('the same globals, API, look, patches, listeners and answers as the kit before modules', async () => {
    const now = stable(await snapshotOf());
    if (process.env.RETAKE_UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) {
      expect(process.env.RETAKE_UPDATE_GOLDEN, `${GOLDEN} is missing: written now; run again with RETAKE_UPDATE_GOLDEN=1 to accept it`).toBe('1');
      writeFileSync(GOLDEN, JSON.stringify(now, null, 1) + '\n');
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
    for (const key of Object.keys(golden)) expect(now[key], key).toEqual(golden[key]);
    expect(Object.keys(now).sort()).toEqual(Object.keys(golden).sort());
  });
});
