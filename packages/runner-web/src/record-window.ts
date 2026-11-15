/** The recording window as the runner follows it over CDP (record-session.ts): the recorder's world, its messages, the navigations. */
import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import { urlOriginPath } from '@retake/core/environment';
import { isPageOrigin } from '@retake/core/run';
import type { ResolvedEnvironment } from '@retake/core/environment';
import { kitConfigFor, kitSource } from './kit/source.js';
import { SECRET_MIN, recorderSource } from './kit/record-script.js';
import { isSignIn, keep, pageKeyOf } from './recording.js';
import type { Recording } from './recording.js';
import { keptQuery } from './record-secrets.js';
import { RECORD_ALT_BUDGET_MS, RECORD_BUDGET_MS } from './record-options.js';

/** The isolated world the recorder runs in. */
export const WORLD = 'retake-record';

/** A context of the recorder's world, as CDP announced it. */
export interface WorldContext {
  origin: string;
  frameId: string;
}

/** The window as the runner follows it over CDP: the recorder's world contexts and the main frame. */
export interface RecordWindow {
  cdp: CDPSession;
  env: ResolvedEnvironment;
  origins: string[];
  binding: string;
  contexts: Map<number, WorldContext>;
  /** The origin of each frame's main world (an isolated world's context reports none). */
  frameOrigin: Map<string, string>;
  mainFrame: string;
  topContext: number | null;
  starting: boolean;
  lastPath: string;
}

export async function evaluateIn(win: RecordWindow, id: number, expression: string): Promise<void> {
  await win.cdp.send('Runtime.evaluate', { contextId: id, expression, returnByValue: true }).catch(() => undefined);
}

export function verdict(win: RecordWindow, rec: Recording, id: number, url: string): void {
  const ok = isPageOrigin(url, win.env.pages) && !isSignIn(rec, url);
  void evaluateIn(win, id, `globalThis.__retakeRecVerdict && globalThis.__retakeRecVerdict(${JSON.stringify(url)}, ${ok}, ${JSON.stringify(rec.memory.list)})`);
}

/** A message of the recorder's world in the page's main frame. */
export function recorderMessage(win: RecordWindow, rec: Recording, ctx: WorldContext, contextId: number, m: Record<string, unknown>): void {
  switch (m.k) {
    case 'hello': {
      if (!rec.windowSize && typeof m.w === 'number' && typeof m.h === 'number') rec.windowSize = { width: Math.round(m.w), height: Math.round(m.h) };
      if (typeof m.url === 'string') verdict(win, rec, contextId, m.url);
      return;
    }
    case 'where':
      if (typeof m.url === 'string') verdict(win, rec, contextId, m.url);
      return;
    case 'secret':
      rec.memory.add(Number(m.n), String(m.h));
      return;
    case 'discarded': {
      const n = Math.max(1, Math.min(1000, Math.floor(Number(m.count) || 1)));
      rec.dropped.sign_in += n;
      keep(rec, { kind: 'dropped', reason: 'sign_in', count: n }, '');
      return;
    }
    case 'ev': {
      const path = typeof m.path === 'string' ? m.path : '';
      // The page's own check, made again here: never an event of a sign-in page.
      if (isSignIn(rec, `${ctx.origin}${path}`)) {
        rec.dropped.sign_in++;
        keep(rec, { kind: 'dropped', reason: 'sign_in', count: 1 }, '');
        return;
      }
      const body = m.e as Record<string, unknown> & { kind: string };
      if (!body || typeof body !== 'object' || typeof body.kind !== 'string' || ['navigation', 'write', 'dropped', 'stop', 'new_page'].includes(body.kind)) {
        rec.dropped.invalid++;
        return;
      }
      const age = Math.max(0, Math.min(60_000, Math.floor(Number(m.age) || 0)));
      keep(rec, { ...body, ...(typeof m.redacted === 'number' ? { redacted: m.redacted } : {}) }, path, age);
      return;
    }
    default:
      return;
  }
}

/** The recorder's world contexts as CDP announces them, and the messages they send through the binding. */
export function listenRecorder(win: RecordWindow, rec: Recording): void {
  const { cdp } = win;
  // An isolated world's context reports no origin ("://"): it is its document's, taken from the frame's main-world
  // context created just before it (a new document creates its main world first).
  cdp.on('Runtime.executionContextCreated', (e: { context: { id: number; origin: string; name: string; auxData?: { frameId?: string; isDefault?: boolean } } }) => {
    const frameId = e.context.auxData?.frameId ?? '';
    if (e.context.auxData?.isDefault) {
      win.frameOrigin.set(frameId, e.context.origin);
      return;
    }
    if (e.context.name !== WORLD) return;
    win.contexts.set(e.context.id, { origin: win.frameOrigin.get(frameId) ?? '', frameId });
    if (frameId === win.mainFrame) win.topContext = e.context.id;
  });
  cdp.on('Runtime.executionContextDestroyed', (e: { executionContextId: number }) => {
    win.contexts.delete(e.executionContextId);
    if (win.topContext === e.executionContextId) win.topContext = null;
  });
  cdp.on('Runtime.executionContextsCleared', () => {
    win.contexts.clear();
    win.topContext = null;
  });
  cdp.on('Runtime.bindingCalled', (e: { name: string; payload: string; executionContextId: number }) => {
    if (e.name !== win.binding || e.payload.length > 1_000_000) return;
    const ctx = win.contexts.get(e.executionContextId);
    // Only the recorder's world of an environment page: its main frame records, a frame says it was used.
    if (!ctx || !win.origins.includes(ctx.origin)) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(e.payload) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (ctx.frameId !== win.mainFrame) {
      if (m.k === 'frame') {
        rec.dropped.frame++;
        keep(rec, { kind: 'dropped', reason: 'frame', count: 1 }, '');
      }
      return;
    }
    recorderMessage(win, rec, ctx, e.executionContextId, m);
  });
}

export type NavigationCause = 'start' | 'typed' | 'link' | 'form' | 'reload' | 'spa' | 'other';

/** How the main frame got to its document: the history entry's transition type. */
export async function navigationCause(win: RecordWindow, sameDocument: boolean): Promise<NavigationCause> {
  let cause: NavigationCause = sameDocument ? 'spa' : 'other';
  if (win.starting && !sameDocument) cause = 'start';
  else if (!sameDocument) {
    try {
      const h = (await win.cdp.send('Page.getNavigationHistory')) as { currentIndex: number; entries: Array<{ transitionType?: string }> };
      const tt = h.entries[h.currentIndex]?.transitionType ?? '';
      cause = tt === 'typed' || tt === 'auto_bookmark' || tt === 'generated' ? 'typed' : tt === 'link' ? 'link' : tt === 'form_submit' ? 'form' : tt === 'reload' ? 'reload' : 'other';
    } catch {
      cause = 'other';
    }
  }
  return cause;
}

/** A navigation of the main frame (the runner's view: where the page went, and how). */
export async function navigation(win: RecordWindow, rec: Recording, url: string, sameDocument: boolean): Promise<void> {
  const cause = await navigationCause(win, sameDocument);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (!/^https?:$/.test(u.protocol)) return;
  const base = { kind: 'navigation', cause, same_document: sameDocument } as const;
  if (!isPageOrigin(url, win.env.pages)) {
    keep(rec, { ...base, where: 'foreign', page_key: null, host: u.host }, '');
    return;
  }
  if (isSignIn(rec, url)) {
    keep(rec, { ...base, where: 'sign_in', page_key: null }, urlOriginPath(url).slice(u.origin.length));
    return;
  }
  const query = cause === 'typed' ? keptQuery(u, rec.memory) : undefined;
  keep(rec, { ...base, where: 'environment', page_key: pageKeyOf(url, win.env.pages), ...(query ? { query } : {}) }, u.pathname);
}

export function listenNavigations(win: RecordWindow, rec: Recording): void {
  win.cdp.on('Page.frameNavigated', (e: { frame: { id: string; parentId?: string; url: string }; type?: string }) => {
    if (e.frame.parentId) return;
    win.mainFrame = e.frame.id;
    win.lastPath = e.frame.url.split(/[?#]/)[0];
    void navigation(win, rec, e.frame.url, false);
  });
  win.cdp.on('Page.navigatedWithinDocument', (e: { frameId: string; url: string }) => {
    if (e.frameId !== win.mainFrame) return;
    const p = e.url.split(/[?#]/)[0];
    // A fragment-only change is not a route change.
    if (p === win.lastPath) return;
    win.lastPath = p;
    void navigation(win, rec, e.url, true);
  });
}

/** Stop and keep: what the person was typing (and a pending scroll or key) is committed, then the window closes. */
export function stopRecording(win: RecordWindow, rec: Recording, context: BrowserContext, reason: 'stopped' | 'max_duration'): void {
  if (!rec.open) return;
  rec.stopReason = reason;
  void (async () => {
    if (win.topContext !== null) await evaluateIn(win, win.topContext, 'globalThis.__retakeRecFlush && globalThis.__retakeRecFlush()');
    await new Promise((r) => setTimeout(r, 150));
    await context.close().catch(() => undefined);
  })();
}

/** Resolves when the context closes; the last page closed closes it (the browser may stay open on macOS). */
export function whenClosed(context: BrowserContext): Promise<void> {
  return new Promise<void>((resolve) => {
    context.on('close', () => resolve());
    const watch = (p: Page) =>
      p.on('close', () => {
        // The last page closed (the browser may stay open on macOS): the recording ends.
        if (context.pages().length === 0) void context.close().catch(() => undefined);
      });
    context.pages().forEach(watch);
    context.on('page', watch);
  });
}

/** Installs the binding, the passive kit and the recorder in the recorder's world of every new document. */
export async function installRecorder(win: RecordWindow, rec: Recording): Promise<void> {
  const { cdp, binding, origins } = win;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const tree = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
  win.mainFrame = tree.frameTree.frame.id;
  await cdp.send('Runtime.addBinding', { name: binding, executionContextName: WORLD });
  const recorder = recorderSource({
    binding,
    origins,
    salt: rec.memory.salt,
    budget_ms: RECORD_BUDGET_MS,
    alt_budget_ms: rec.options.alternativesBudgetMs ?? RECORD_ALT_BUDGET_MS,
    secret_min: SECRET_MIN,
  });
  const source = `${kitSource({ ...kitConfigFor(undefined, { hidden: true }), passive: true })}\n${recorder}`;
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source, worldName: WORLD, runImmediately: true });
}
