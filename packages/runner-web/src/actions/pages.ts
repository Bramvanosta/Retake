import type { Page } from 'playwright-core';
import { interpolate } from '@demo-studio/core';
import type { NewTabArgs, OpenArgs, SwitchPageArgs } from '@demo-studio/core';
import { StepError, errorMessage } from '../errors.js';
import { resolveTarget } from '../resolve.js';
import type { Runtime, StepContext } from '../runtime.js';
import { sleep } from '../util.js';
import { clickResolved } from './click.js';
import type { ActionResult } from './types.js';

/** How long a click may take to open a new page before the runner follows the href itself. */
export const NEW_TAB_WAIT_MS = 1500;

/** Navigate, wait for `waitUntil`, settle (network idle ≤ settle_ms) and re-draw the cursor. */
export async function navigate(rt: Runtime, page: Page, url: string, waitUntil: OpenArgs['wait_until'] = 'load'): Promise<void> {
  let status: number | undefined;
  try {
    const res = await page.goto(url, { waitUntil, timeout: 60_000 });
    status = res?.status();
  } catch (e) {
    throw new StepError(`open: cannot load ${url}: ${errorMessage(e).split('\n')[0]}`);
  }
  if (status !== undefined && status >= 400) rt.warn(`open: ${url} answered HTTP ${status}`);
  if (waitUntil === 'load' || waitUntil === 'domcontentloaded') {
    if (rt.pacing.settle_ms > 0) await page.waitForLoadState('networkidle', { timeout: rt.pacing.settle_ms }).catch(() => undefined);
  }
  if (page === rt.page) await rt.pointer.syncPage();
}

export async function open(ctx: StepContext, args: OpenArgs): Promise<ActionResult> {
  const { rt } = ctx;
  if (args.page !== undefined && args.page !== rt.activeId) await rt.activate(args.page);
  const url = rt.resolveUrl(interpolate(args.url, rt.template));
  await navigate(rt, rt.page, url, args.wait_until);
  return { target: { desc: url }, data: { url: rt.page.url() } };
}

function firstEnvPage(rt: Runtime): string {
  const keys = Object.keys(rt.env.pages);
  if (!keys.length) throw new StepError(`environment "${rt.env.name}" declares no pages`);
  return keys[0];
}

export async function newTab(ctx: StepContext, args: NewTabArgs): Promise<ActionResult> {
  const { rt } = ctx;
  const id = args.as ?? rt.nextTabId();
  if (rt.session.has(id)) throw new StepError(`new_tab: a page named "${id}" is already open`);
  const opener = rt.page;
  let page: Page | null = null;
  let how: 'popup' | 'href';
  const out: ActionResult = {};
  if (args.target !== undefined) {
    const r = await resolveTarget(ctx, args.target);
    const waiter = rt.session.waitForNewPage(ctx.timeoutMs + 60_000);
    try {
      const run = await clickResolved(ctx, r, { expect_popup: false });
      out.target = { desc: r.desc, bbox: r.bbox };
      out.point = run.point;
      out.t_click = run.t_click;
      out.strategy = run.strategy;
      const left = NEW_TAB_WAIT_MS - (rt.now() - run.t_click) * 1000;
      page = await Promise.race([waiter.promise, sleep(Math.max(0, left), rt.signal).then(() => null)]);
    } finally {
      waiter.cancel();
    }
    if (page) {
      how = 'popup';
    } else {
      // Synthetic clicks and prevented defaults never open tabs: follow the link ourselves.
      const href = args.href !== undefined ? interpolate(args.href, rt.template) : r.href;
      if (!href) throw new StepError(`new_tab: clicking ${r.desc} opened no page and it has no href (pass \`href\`)`);
      page = await rt.session.newPage(id);
      await rt.activate(id, page);
      await navigate(rt, page, new URL(href, opener.url()).toString());
      how = 'href';
    }
  } else if (args.href !== undefined) {
    const href = interpolate(args.href, rt.template);
    const url = /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : new URL(href, opener.url()).toString();
    page = await rt.session.newPage(id);
    await rt.activate(id, page);
    await navigate(rt, page, url);
    how = 'href';
  } else {
    throw new StepError('new_tab: give `target` (element to click) or `href`');
  }
  if (rt.activeId !== id) {
    await rt.activate(id, page);
    await rt.settle(page);
    await rt.pointer.syncPage();
  }
  out.data = { page: id, url: page.url(), how };
  return out;
}

export async function switchPage(ctx: StepContext, args: SwitchPageArgs): Promise<ActionResult> {
  const { rt } = ctx;
  const prev = rt.activeId;
  const to = args.to === 'previous' ? rt.session.previousId() : args.to === 'main' ? firstEnvPage(rt) : args.to;
  if (!to) throw new StepError('switch_page: there is no previous page');
  if (!rt.session.has(to) && !(to in rt.env.pages)) {
    throw new StepError(
      `switch_page: unknown page "${to}" (open: ${[...rt.session.pages.keys()].join(', ') || 'none'}; environment: ${Object.keys(rt.env.pages).join(', ')})`,
    );
  }
  if (!rt.session.has(to)) rt.warn(`switch_page: "${to}" was never opened; it starts blank (add an open step)`);
  await rt.activate(to);
  if (args.close_current && prev && prev !== to) await rt.session.pages.get(prev)?.close().catch(() => undefined);
  return { data: { page: to, url: rt.page.url() } };
}
