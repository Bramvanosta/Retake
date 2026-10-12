#!/usr/bin/env node
// End-to-end smoke test of the Northfield fixture with real (CDP) mouse & keyboard input.
// Starts the fixture in-process on free ports (or targets a running one with --console/--shop),
// walks through every screen and interaction the Demo Studio scenarios rely on, asserts the
// visible outcome and saves screenshots (1920×1080) + ARIA snapshots of the key dialogs.
//
//   node scripts/smoke.mjs [--out /tmp/northfield-smoke] [--console http://localhost:4401 --shop http://localhost:4402] [--headed]

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { startFixture } from '../server.mjs';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: '/tmp/northfield-smoke' },
    console: { type: 'string' },
    shop: { type: 'string' },
    headed: { type: 'boolean', default: false },
  },
});

function loadPlaywright() {
  const from = [import.meta.url, new URL('../../../packages/runner-web/package.json', import.meta.url).href];
  for (const base of from) {
    try {
      return createRequire(base)('playwright-core');
    } catch {
      /* try the next location */
    }
  }
  throw new Error('playwright-core is not installed (it is a dependency of packages/runner-web)');
}

const { chromium } = loadPlaywright();
const OUT = args.out;
const shots = [];
const checks = [];

function check(cond, message) {
  if (!cond) throw new Error(`Check failed: ${message}`);
  checks.push(message);
}

/** Lets open/close animations finish (dialogs 240 ms, popovers 160 ms). */
const settle = (page) => page.waitForTimeout(350);

async function shot(page, name) {
  const file = join(OUT, `${String(shots.length + 1).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
}

async function aria(locator, name) {
  await writeFile(join(OUT, `aria-${name}.yaml`), await locator.ariaSnapshot());
}

/** Real mouse: eased move to the element centre, short hover, press, release. */
async function click(page, locator, { hover = 120, press = 80 } = {}) {
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`No bounding box for ${locator}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await page.waitForTimeout(hover);
  await page.mouse.down();
  await page.waitForTimeout(press);
  await page.mouse.up();
}

async function hover(page, locator) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
}

async function visibleText(page, text, timeout = 10_000) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
}

async function api(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function scrollTo(page, y) {
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
  await page.waitForTimeout(150);
}

async function consoleFlow(page, C) {
  // 1. Imports → New import dialog → Radix Select → drop zone → Start import → result.
  await page.goto(`${C}/imports`);
  await visibleText(page, 'Northfield - Price list Q4 2026.xlsx');
  await shot(page, 'imports');
  await click(page, page.getByRole('button', { name: 'New import', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'New import' });
  await dialog.waitFor();
  await settle(page);
  await shot(page, 'import-dialog');
  await aria(dialog, 'import-dialog');
  await click(page, page.locator('#import-organization'));
  const listbox = page.getByRole('listbox');
  await listbox.waitFor();
  await settle(page);
  await shot(page, 'import-org-select-open');
  await click(page, listbox.getByRole('option', { name: 'Northfield Roasters' }));
  await listbox.waitFor({ state: 'hidden' });
  check((await page.locator('#import-organization').innerText()).includes('Northfield Roasters'), 'organisation selected in the Radix Select');

  const zone = page.getByText('Click to choose a file', { exact: true });
  check((await zone.evaluate((el) => el.closest('label')?.querySelector('input[type=file]') !== null)), 'drop zone contains a hidden <input type=file>');
  await zone.evaluate((el) => {
    const target = el.closest('label');
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(48 * 1024)], 'Northfield - Price list 2027.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    window.__smokeDt = dt;
    const r = target.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    target.dispatchEvent(new DragEvent('dragenter', init));
    target.dispatchEvent(new DragEvent('dragover', init));
  });
  await page.waitForTimeout(250);
  check(await page.locator('.dropzone[data-dragging]').isVisible(), 'dragenter highlights the drop zone');
  await shot(page, 'import-dragging');
  await page.locator('.dropzone').evaluate((target) => {
    const r = target.getBoundingClientRect();
    target.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__smokeDt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }),
    );
  });
  await visibleText(page, 'Northfield - Price list 2027.xlsx');
  check(await dialog.getByText('48 KB', { exact: false }).isVisible(), 'dropped file shows its size');
  await settle(page);
  await shot(page, 'import-file-dropped');
  await click(page, dialog.getByRole('button', { name: 'Start import' }));
  await dialog.getByRole('progressbar').waitFor();
  await page.waitForTimeout(700);
  await shot(page, 'import-progress');
  await visibleText(page, '921 offers created', 6000);
  await page.waitForTimeout(900);
  await shot(page, 'import-result');
  await click(page, page.getByRole('button', { name: 'Done' }));
  await dialog.waitFor({ state: 'hidden' });
  check(await page.locator('[data-import="imp-0109"]').getByText('Completed').isVisible(), 'new import listed as completed');
  await shot(page, 'imports-after');

  // 2. Availability: scroll, Base UI row menu → Pause → Radix AlertDialog → Paused badge.
  await page.goto(`${C}/availability/products/finca-lirandel-geisha`);
  await visibleText(page, 'Iceland');
  await shot(page, 'availability');
  await page.evaluate(() => window.scrollTo({ top: 560, behavior: 'smooth' }));
  await page.waitForTimeout(900);
  await shot(page, 'availability-scrolled');
  const iceland = page.getByRole('row').filter({ hasText: 'Iceland' });
  const inView = async (loc) => {
    const b = await loc.boundingBox();
    return b !== null && b.y > 40 && b.y + b.height < 1080;
  };
  check((await inView(iceland)) && (await inView(page.getByRole('row').filter({ hasText: 'Sweden' }))), 'after scrolling to 560 the Iceland and Sweden rows are in view');
  const trigger = iceland.getByRole('button', { name: 'Row actions' });
  check((await trigger.getAttribute('aria-haspopup')) === 'menu', 'row trigger has aria-haspopup=menu');
  await click(page, trigger);
  const menu = page.getByRole('menu');
  await menu.waitFor();
  await settle(page);
  await shot(page, 'row-menu');
  await aria(menu, 'row-menu');
  await click(page, menu.getByRole('menuitem', { name: 'Pause' }));
  const confirm = page.getByRole('alertdialog');
  await confirm.waitFor();
  await page.waitForTimeout(300);
  await shot(page, 'pause-confirm');
  await aria(confirm, 'pause-confirm');
  await click(page, confirm.getByRole('button', { name: 'Pause', exact: true }));
  await confirm.waitFor({ state: 'hidden' });
  await iceland.getByText('Paused', { exact: true }).waitFor();
  check(!(await page.getByRole('menu').isVisible().catch(() => false)), 'menu closed after confirming');
  await page.waitForTimeout(400);
  await shot(page, 'paused');

  // 3. Edit dialog: three multi-select pickers (Base UI, Radix, Base UI + search), Save.
  const sweden = page.getByRole('row').filter({ hasText: 'Sweden' });
  await click(page, sweden.getByRole('button', { name: 'Row actions' }));
  await click(page, page.getByRole('menu').getByRole('menuitem', { name: 'Edit' }));
  const edit = page.getByRole('dialog', { name: 'Edit availability' });
  await edit.waitFor();
  await settle(page);
  await shot(page, 'edit-dialog');
  const title = edit.getByRole('heading', { name: 'Edit availability' });
  const pick = async (field, option, { search, shotName } = {}) => {
    await click(page, edit.getByRole('button', { name: field }));
    const list = page.getByRole('listbox', { name: field });
    await list.waitFor();
    await settle(page);
    if (search) {
      // Base UI moves focus into the popover a frame after opening: click the search box first.
      await click(page, page.getByRole('textbox', { name: `Search ${field.toLowerCase()}` }));
      await page.keyboard.type(search, { delay: 90 });
      await page.waitForTimeout(200);
      check((await list.getByRole('option').count()) === 1, `${field}: search "${search}" leaves one option`);
    }
    await click(page, list.getByRole('option', { name: option }));
    check((await list.getByRole('option', { name: option }).getAttribute('aria-selected')) === 'true', `${field}: "${option}" selected`);
    check(await list.isVisible(), `${field}: popover stays open after a pick`);
    if (shotName) await shot(page, shotName);
    await click(page, title);
    await list.waitFor({ state: 'hidden' });
  };
  await pick('Bag sizes', '1 kg', { shotName: 'picker-bag-sizes' });
  await pick('Grind options', 'Espresso', { shotName: 'picker-grind-options' });
  await pick('Label languages', 'Swedish', { search: 'Swe', shotName: 'picker-label-languages-search' });
  const mounted = await page.locator('[role="listbox"][aria-multiselectable="true"]').count();
  check(mounted >= 2, `several picker popovers stay mounted inside the dialog (${mounted} listboxes in the DOM)`);
  await shot(page, 'edit-picked');
  await aria(edit, 'edit-dialog');
  await click(page, edit.getByRole('button', { name: 'Save' }));
  await edit.waitFor({ state: 'hidden' });
  await sweden.getByText('Swedish', { exact: true }).waitFor();
  check(await sweden.getByText('Espresso', { exact: true }).isVisible(), 'Sweden row shows Espresso after save');
  await page.waitForTimeout(300);
  await shot(page, 'edit-saved');

  // Escape inside a Base UI popover closes the whole Radix dialog.
  await click(page, sweden.getByRole('button', { name: 'Row actions' }));
  await click(page, page.getByRole('menu').getByRole('menuitem', { name: 'Edit' }));
  await edit.waitFor();
  await click(page, edit.getByRole('button', { name: 'Label languages' }));
  await page.getByRole('listbox', { name: 'Label languages' }).waitFor();
  await page.keyboard.press('Escape');
  await edit.waitFor({ state: 'hidden', timeout: 3000 });
  check(true, 'Escape inside a picker closes the whole dialog');

  // 4. Catalogue → Add a coffee → registry search → duplicate → (refs removed) → enrichment.
  await page.goto(`${C}/products`);
  await visibleText(page, 'Mountfern AA');
  await shot(page, 'catalogue');
  await click(page, page.getByRole('button', { name: 'Product actions' }).first());
  await page.getByRole('menu').waitFor();
  await settle(page);
  await shot(page, 'catalogue-row-menu');
  await page.keyboard.press('Escape');
  await click(page, page.getByRole('button', { name: 'Add a coffee' }));
  const add = page.getByRole('dialog', { name: 'Add a coffee' });
  await add.waitFor();
  await settle(page);
  await shot(page, 'add-coffee-dialog');
  await click(page, add.getByRole('textbox'));
  await page.keyboard.type('Finca Quenaro', { delay: 100 });
  const result2026 = add.getByRole('option').filter({ hasText: 'Finca Quenaro' }).filter({ hasText: '2026' });
  await result2026.waitFor();
  await page.waitForTimeout(400);
  await shot(page, 'registry-results');
  await aria(add, 'add-coffee-dialog');
  await click(page, result2026);
  await visibleText(page, 'This coffee is already in your catalogue');
  await shot(page, 'registry-duplicate');
  const removed = await api(C, 'DELETE', '/api/products/finca-quenaro/refs');
  check(removed.removed.includes('GCR-26-0412'), 'DELETE /refs frees the registry ref');
  await click(page, result2026);
  await page.waitForURL('**/products/finca-quenaro-2');
  await visibleText(page, 'Enrichment in progress');
  await page.waitForTimeout(1500);
  await shot(page, 'enrichment-in-progress');
  await page.waitForFunction(() => !document.body.innerText.includes('Enrichment in progress'), null, { timeout: 15_000 });
  await page.waitForTimeout(1600);
  await shot(page, 'enrichment-revealed');
  await page.getByRole('heading', { name: 'Awards', exact: true }).evaluate((el) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 140, behavior: 'instant' }));
  await page.waitForTimeout(300);
  await shot(page, 'awards');

  // 5. Supplier quote requests.
  await page.goto(`${C}/quotes`);
  await visibleText(page, 'Café Tallmora');
  await shot(page, 'console-quote-requests');
}

async function shopFlow(context, page, S) {
  await api(S, 'POST', '/api/quotes/auto-proposal', {});
  await page.goto(`${S}/`);
  await visibleText(page, 'Award winners');
  await page.waitForTimeout(400);
  await shot(page, 'shop-home');
  await page.getByRole('heading', { name: 'Fresh arrivals' }).evaluate((el) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 100, behavior: 'instant' }));
  await page.waitForTimeout(300);
  await shot(page, 'shop-home-arrivals');
  await click(page, page.getByText('Selowa Ridge', { exact: true }).first());
  await page.waitForURL('**/products/selowa-ridge');
  await page.getByRole('button', { name: 'Request a quote' }).waitFor();
  await page.waitForTimeout(300);
  await shot(page, 'shop-product');

  await click(page, page.getByRole('button', { name: 'Request a quote' }));
  const dialog = page.getByRole('dialog', { name: 'Request a quote' });
  await dialog.waitFor();
  await settle(page);
  await shot(page, 'quote-dialog');
  await click(page, dialog.getByRole('button', { name: 'Increase' }));
  await click(page, dialog.getByRole('button', { name: 'Increase' }));
  check((await dialog.getByLabel('Number of bags').inputValue()) === '3', 'stepper reaches 3 bags');
  await click(page, dialog.getByRole('combobox', { name: 'Bag size' }));
  await page.getByRole('listbox').waitFor();
  await settle(page);
  await shot(page, 'quote-bag-size-open');
  await click(page, page.getByRole('listbox').getByRole('option', { name: '5 kg' }));
  await click(page, dialog.getByRole('combobox', { name: 'Grind' }));
  await click(page, page.getByRole('listbox').getByRole('option', { name: 'Whole bean' }));
  check((await dialog.getByRole('combobox', { name: 'Label language' }).innerText()).includes('Swedish'), 'label language defaults to Swedish');

  await click(page, dialog.getByRole('button', { name: 'Delivery window' }));
  const calendar = page.getByRole('dialog', { name: 'Choose a delivery window' });
  await calendar.waitFor();
  await settle(page);
  await shot(page, 'calendar-open');
  await click(page, calendar.getByRole('button', { name: 'Next month' }));
  await click(page, calendar.getByRole('button', { name: 'Sunday, 10 January 2027' }));
  await hover(page, calendar.getByRole('button', { name: 'Sunday, 24 January 2027' }));
  await page.waitForTimeout(250);
  await shot(page, 'calendar-range-preview');
  await click(page, calendar.getByRole('button', { name: 'Sunday, 24 January 2027' }));
  await calendar.waitFor({ state: 'hidden' });
  check((await dialog.getByRole('button', { name: 'Delivery window' }).innerText()).includes('10 – 24 Jan 2027'), 'delivery window shows 10 – 24 Jan 2027');
  await click(page, dialog.getByLabel('Message'));
  await page.keyboard.type('Light roast for filter, please. Deliveries before 9 am.', { delay: 25 });
  await shot(page, 'quote-filled');
  await aria(dialog, 'quote-dialog');
  await click(page, dialog.getByRole('button', { name: 'Send request' }));
  await dialog.waitFor({ state: 'hidden' });
  await visibleText(page, 'Quote request sent');
  await page.waitForTimeout(500);
  await shot(page, 'quote-sent-toast');
  check(!(await page.locator('.bell .unread').isVisible()), 'no unread badge before the next page load');

  // "A few hours later": a fresh load shows the proposal notification.
  await page.goto(`${S}/`);
  await page.locator('.bell .unread').waitFor();
  await page.waitForTimeout(1500);
  await shot(page, 'bell-unread');
  await click(page, page.getByRole('button', { name: /^Notifications/ }));
  const notif = page.getByText('New proposal from Northfield Roasters', { exact: true });
  await notif.waitFor();
  await settle(page);
  await shot(page, 'notifications-open');
  await click(page, notif);
  await page.waitForURL('**/quotes/1043');
  await page.getByText('€720.00', { exact: false }).first().waitFor();
  check(await page.getByTestId('proposal-total').getByText('€720.00').isVisible(), 'proposal total is €720.00 incl. VAT');
  await page.waitForTimeout(500);
  await shot(page, 'quote-proposal');

  const link = page.getByRole('link', { name: /Download quote PDF/ });
  check((await link.getAttribute('target')) === '_blank', 'PDF link has target=_blank');
  // A real PDF (printed by Chromium from the quote document), fetched with the page's session.
  const res = await context.request.get(new URL(await link.getAttribute('href'), S).toString());
  check(res.headers()['content-type'] === 'application/pdf', 'the quote PDF is application/pdf');
  check((await res.body()).subarray(0, 5).toString('latin1') === '%PDF-', 'the quote PDF is a real PDF');
  check(/filename="Northfield_Quote_Q-1043\.pdf"/.test(res.headers()['content-disposition'] ?? ''), 'the PDF is named after the quote');

  // Sign-up: the confirmation email lands in the Mailpit-compatible mailbox.
  await page.goto(`${S}/signup`);
  await page.getByLabel('Café name').fill('Café Lumen');
  await page.getByLabel('Your name').fill('Noa Brandt');
  await page.getByLabel('Work email').fill('noa@cafe-lumen.example');
  await click(page, page.getByRole('button', { name: 'Create account' }));
  await visibleText(page, 'Check your inbox');
  await shot(page, 'signup-sent');
  let mail = null;
  for (let i = 0; i < 30 && !mail; i++) {
    const list = await (await fetch(`${S}/mailbox/api/v1/messages`)).json();
    mail = list.messages.find((m) => m.To.some((t) => t.Address === 'noa@cafe-lumen.example')) ?? null;
    if (!mail) await page.waitForTimeout(100);
  }
  check(!!mail && /Confirm your email/.test(mail.Subject), 'the confirmation email is in the mailbox');

  await page.goto(`${S}/quotes`);
  await visibleText(page, 'Q-1043');
  await shot(page, 'shop-quotes');
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  let fixture = null;
  let C = args.console;
  let S = args.shop;
  if (!C || !S) {
    fixture = await startFixture({ consolePort: 0, shopPort: 0, log: (m) => console.log(m) });
    C = fixture.urls.console;
    S = fixture.urls.shop;
  }
  console.log(`console ${C} · shop ${S} · screenshots → ${OUT}`);
  await api(C, 'POST', '/api/reset');
  const browser = await chromium.launch({ headless: !args.headed, channel: 'chromium' });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: 'en-GB' });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      // The duplicate check answers 409 on purpose; Chromium logs every non-2xx fetch.
      if (m.type() === 'error' && !/status of 409/.test(m.text())) errors.push(`console.error: ${m.text()}`);
    });
    await consoleFlow(page, C);
    await shopFlow(context, page, S);
    check(errors.length === 0, `no page errors (${errors.join(' | ') || 'none'})`);
  } catch (err) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) await page.screenshot({ path: join(OUT, 'FAILED.png') }).catch(() => {});
    if (errors.length) console.error(errors.join('\n'));
    throw err;
  } finally {
    await browser.close();
    if (fixture) await fixture.close();
  }
  console.log(`${checks.length} checks passed:`);
  for (const c of checks) console.log(`  ✓ ${c}`);
  console.log(`${shots.length} screenshots in ${OUT}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
