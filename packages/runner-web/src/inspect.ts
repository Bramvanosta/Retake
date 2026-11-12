/**
 * Page inspection (L3.3, `page_inspect` / `retake inspect`): at the end of a dry replay — or at the step where it failed
 * — the page the run shows is inventoried for a scenario's author. A viewport screenshot (the cursor hidden; marks are
 * drawn later, by the engine, from the boxes), the visible interactive elements with a suggested target each and
 * `inspect.json`, all in the run folder.
 *
 * Trust (L3.1 rules): everything the page controls — names, texts, labels, roles, tags, the URL, the suggested targets
 * that embed them — sits under an `untrusted` key; only marks, boxes, booleans, counts and closed enums are outside it.
 * The page is inventoried only on an origin of the environment's pages (a redirect to another host — before or during
 * the inspection — is reported by its host alone: no screenshot, no inventory), never on a sign-in page (the run's
 * sign-in guard throws first), and no field value is ever read. The URL is reported without its query and fragment.
 */
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isPoint, normalizeTarget } from '@retake/core/language';
import { flowYaml, isPageOrigin, roundTrips, targetValue } from '@retake/core/run';
import type { BBox, PointSpec, TargetObject, TargetSpec } from '@retake/core/model';
import type { Route } from 'playwright-core';
import { errorMessage, isCancelled } from './errors.js';
import { DocumentChangedError } from './session.js';
import type { FragileFlag, InventoryContext, InventoryElement, InventoryPopup, KitActionHint, KitInventory, ResolveResult } from './kit/types.js';
import type { Runtime } from './runtime.js';

/** Elements listed by default, and at most. */
export const INSPECT_LIMIT = 80;
export const INSPECT_LIMIT_MAX = 300;
/** Targets an inspection checks, at most. */
export const INSPECT_TARGETS_MAX = 20;
/** In-page time budget for the suggestions (ms). */
export const INSPECT_BUDGET_MS = 2500;
/**
 * How long an inspection waits for one answer of the page (ms): the navigation guard's install and removal, the cursor;
 * a kit call gets its in-page budget on top of `call_ms`. A protocol answer lost while the page commits a document of
 * another origin would otherwise hang the inspection forever; a deadline counts as a document change (inspectPage).
 */
export const INSPECT_DEADLINES = { guard_ms: 5_000, call_ms: 15_000 } as const;
export type InspectDeadlines = { guard_ms: number; call_ms: number };
/** The replay's pacing (core inspect-pacing.ts, L7.12): re-exported under the same name. */
export { INSPECT_PACING } from '@retake/core/run';

/** What `runScenario` inspects (`RunOptions.inspect`): the run is a dry run, its hooks skipped. */
export interface InspectRequest {
  /** Inventory only inside this element (R-MCP-23's `selector?`): a target, resolved like any step's. */
  within?: TargetSpec;
  /** Targets to check (the author's own, ≤ 20): count, chosen index, box. */
  targets?: TargetSpec[];
  /** Elements listed (default 80, at most 300). */
  limit?: number;
  /** In-page time budget for the suggestions (default 2500 ms). */
  budgetMs?: number;
  /** Receives the report (also written as inspect.json in the run folder). */
  onResult: (report: InspectReport) => void | Promise<void>;
}

/** The step a suggestion proposes, as data and as one line of YAML (both page text: under `untrusted`). */
export interface InspectStepHint {
  step: Record<string, unknown>;
  yaml: string;
}

export interface InspectElement {
  /** The number drawn on the marked screenshot (1-based, listed order). */
  mark: number;
  /** CSS px of the top viewport (× `scale` on the screenshot). */
  bbox: BBox;
  in_view: boolean;
  in: InventoryContext;
  where: 'document' | 'shadow' | 'frame';
  state: InventoryElement['state'];
  /** A suggested target was verified (resolves to this element) and survives YAML + normalizeTarget. */
  verified: boolean;
  /** Visible matches of the suggestion without its `nth` (1 = unique). */
  matches: number;
  fragile: FragileFlag[];
  action: KitActionHint['kind'];
  /** The action was checked through the runner's own helper for it (or its verified target). */
  action_verified: boolean;
  untrusted: {
    role: string | null;
    tag: string;
    input_type: string | null;
    name: string;
    text: string;
    label: string | null;
    placeholder: string | null;
    testid: string | null;
    href_path: string | null;
    /** The target as a scenario writes it (a bare string or an object), null without a verified one. */
    target: TargetSpec | null;
    target_yaml: string | null;
    hint: InspectStepHint | null;
  };
}

export interface InspectTargetCheck {
  /** Index in the request's `targets`. */
  index: number;
  count: number;
  /** The match a step would use (its `nth`, else 0). */
  chosen: number | null;
  in_view: boolean | null;
  bbox: BBox | null;
  hidden: number;
  scope_found: boolean;
  untrusted: { desc: string; near: string[] };
}

export interface InspectReport {
  version: 1;
  /** `landed_elsewhere`: the page is on another origin than the environment's pages (nothing of it was taken). */
  status: 'ok' | 'landed_elsewhere' | 'failed';
  /** After the whole scenario, at `until`, or at the step that failed. */
  at: 'end' | 'until' | 'failed_step';
  /** The page id the run shows (an environment page key for single-page scenes). */
  page: string | null;
  persona: string | null;
  viewport: { width: number; height: number };
  /** Device pixels per CSS px of the screenshot (capture.scale). */
  scale: number;
  screenshot: string | null;
  file: string;
  replay: {
    steps_done: number;
    steps_total: number;
    until: string | null;
    /** Irreversible steps a dry run shows without executing them: the page may differ from a real run past them. */
    skipped_irreversible: number;
    /** Setup / teardown hooks are never run by an inspection: a page state they would prepare is missing. */
    hooks: 'skipped' | 'none';
    failed: { scene: string; step: number; action: string } | null;
  };
  counts: KitInventory['counts'] & { partial: boolean; within_found: boolean; dropped: number; targets_checked: number };
  popups: Array<{ kind: InventoryPopup['kind']; bbox: BBox; untrusted: { name: string } }>;
  scrollers: KitInventory['scrollers'];
  elements: InspectElement[];
  targets_checked: InspectTargetCheck[];
  timings: { inspect_ms: number; kit_ms: number };
  untrusted: {
    /** Origin and path of the page (no query, no fragment); empty when it was not on the environment. */
    url: string;
    title: string;
    headings: KitInventory['headings'];
    /** The foreign host the page landed on (`landed_elsewhere`). */
    landed_host?: string;
    /** The replay's error (`at: failed_step`) or the inspection's own (`status: failed`). */
    error?: string;
    warnings: string[];
  };
}

/** What the run knows of the replay (filled by runScenario). */
export interface InspectContext {
  at: InspectReport['at'];
  persona: string | null;
  replay: InspectReport['replay'];
  error?: string;
}

const PLACEHOLDER = '…';

/** The step a hint proposes, built from the verified target value. */
function stepHint(kind: KitActionHint['kind'], hint: KitActionHint, value: TargetSpec): Record<string, unknown> {
  switch (kind) {
    case 'type':
      return { type: { into: value, text: PLACEHOLDER } };
    case 'select':
      return { select: hint.field !== undefined ? { field: hint.field, option: PLACEHOLDER } : { combobox: value, option: PLACEHOLDER } };
    case 'menu':
      return { menu: { row: hint.row, item: PLACEHOLDER } };
    case 'drop_file':
      return { drop_file: { zone: value, fake: true, name: 'document.pdf' } };
    default:
      return { click: value };
  }
}

/** The report's element: page text under `untrusted`; a suggestion kept only when its YAML reads back as the target. */
export function inspectElement(e: InventoryElement, mark: number): InspectElement {
  let target: TargetSpec | null = null;
  let targetYaml: string | null = null;
  let hint: InspectStepHint | null = null;
  if (e.suggested) {
    const value = targetValue(e.suggested.target);
    const line = flowYaml(value);
    if (roundTrips(line, e.suggested.target)) {
      target = value;
      targetYaml = line;
      const step = stepHint(e.action.kind, e.action, value);
      hint = { step, yaml: flowYaml(step) };
    }
  }
  return {
    mark,
    bbox: e.bbox,
    in_view: e.in_view,
    in: e.in,
    where: e.where,
    state: e.state,
    verified: target !== null,
    matches: target !== null ? (e.suggested?.matches ?? 0) : 0,
    fragile: target !== null ? (e.suggested?.fragile ?? []) : [],
    action: e.action.kind,
    action_verified: e.action.verified && (target !== null || e.action.kind === 'menu' || (e.action.kind === 'select' && e.action.field !== undefined)),
    untrusted: {
      role: e.role,
      tag: e.tag,
      input_type: e.input_type,
      name: e.name,
      text: e.text,
      label: e.label,
      placeholder: e.placeholder,
      testid: e.testid,
      href_path: e.href_path,
      target,
      target_yaml: targetYaml,
      hint,
    },
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** The URL an inspection reports: origin and path, never a query or a fragment (tokens live there). */
export function reportedUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? `${u.origin}${u.pathname}` : '';
  } catch {
    return '';
  }
}

/** The page left the environment's origins during the inspection (seen by a document's origin or the page's URL). */
class LandedElsewhere extends Error {
  constructor(readonly url: string) {
    super('the page left the environment during the inspection');
  }
}

/** The page did not answer one step of the inspection in time (`bounded`). */
export class InspectDeadlineError extends Error {
  constructor(readonly stage: string, ms: number) {
    super(`the page did not answer (${stage}) within ${Math.round(ms / 100) / 10} s`);
  }
}

/** `p`, or InspectDeadlineError after `ms` (`p` keeps running; a late rejection of it is handled here). */
async function bounded<T>(stage: string, ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new InspectDeadlineError(stage, ms)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * While the page is inspected, a navigation of its main frame to an origin that is not one of the environment's pages
 * (a late redirect by script, a meta refresh, a form posted elsewhere) is answered 204 No Content: the page stays where
 * it was.
 * Returns the guard's removal and the count of navigations it stopped.
 */
async function guardNavigation(rt: Runtime): Promise<{ blocked: () => number; remove: () => Promise<boolean> }> {
  const page = rt.page;
  let blocked = 0;
  const handler = async (route: Route): Promise<void> => {
    const r = route.request();
    let main = false;
    try {
      main = r.isNavigationRequest() && r.frame() === page.mainFrame();
    } catch {
      main = false;
    }
    if (main && !isPageOrigin(r.url(), rt.env.pages)) {
      blocked++;
      // 204 No Content: the browser keeps the current document (an aborted navigation would show an error page).
      await route.fulfill({ status: 204, body: '' }).catch(() => undefined);
      return;
    }
    await route.fallback().catch(() => undefined);
  };
  await page.route('**/*', handler);
  return { blocked: () => blocked, remove: () => page.unroute('**/*', handler).then(() => true, () => true) };
}

/**
 * Inspect the page the run shows now. Throws only a sign-in landing (the run reports it) or a cancel; any other
 * failure is a `failed` report. Writes screenshot.png (when inventoried) and inspect.json in the run folder.
 *
 * The origin is checked where the data comes from, not once: each kit call runs in one document only (a document
 * replaced during it is an error, never retried in the new one) and returns that document's origin; the page's URL is
 * checked again after the screenshot. Main-frame navigations to other origins are stopped while it runs.
 *
 * Every wait on the page is bounded (`deadlines`, INSPECT_DEADLINES): a step the page does not answer in time counts
 * as a document change — where the page is then decides between `landed_elsewhere` and `failed` (naming the step) —,
 * and a guard that cannot be removed in time is left to the page's close, with a warning.
 */
export async function inspectPage(
  rt: Runtime,
  req: Omit<InspectRequest, 'onResult'>,
  ctx: InspectContext,
  deadlines: InspectDeadlines = INSPECT_DEADLINES,
): Promise<InspectReport> {
  const started = performance.now();
  const file = join(rt.runDir, 'inspect.json');
  const shot = join(rt.runDir, 'screenshot.png');
  const limit = Math.max(1, Math.min(INSPECT_LIMIT_MAX, Math.floor(req.limit ?? INSPECT_LIMIT)));
  const report: InspectReport = {
    version: 1,
    status: 'ok',
    at: ctx.at,
    page: rt.activeId,
    persona: ctx.persona,
    viewport: { width: rt.capture.width, height: rt.capture.height },
    scale: rt.capture.scale,
    screenshot: null,
    file,
    replay: ctx.replay,
    counts: {
      interactive: 0,
      listed: 0,
      in_view: 0,
      suggested: 0,
      ambiguous: 0,
      unsuggested: 0,
      verifications: 0,
      shadow_roots: 0,
      same_origin_frames: 0,
      cross_origin_frames: 0,
      partial: false,
      within_found: true,
      dropped: 0,
      targets_checked: 0,
    },
    popups: [],
    scrollers: [],
    elements: [],
    targets_checked: [],
    timings: { inspect_ms: 0, kit_ms: 0 },
    untrusted: { url: '', title: '', headings: [], warnings: [], ...(ctx.error !== undefined ? { error: ctx.error } : {}) },
  };
  const warnings: string[] = [];
  let guard: Awaited<ReturnType<typeof guardNavigation>> | null = null;
  let shotTaken = false;
  /** The URL the inspection started on. */
  let read: string | null = null;
  const onEnv = (url: string): void => {
    if (!isPageOrigin(url, rt.env.pages)) throw new LandedElsewhere(url);
  };
  const callMs = deadlines.call_ms + (req.budgetMs ?? INSPECT_BUDGET_MS);
  /** Remove the guard (bounded): false when the page did not answer in time. */
  const removeGuard = async (): Promise<boolean> => (guard ? bounded('removing the navigation guard', deadlines.guard_ms, guard.remove()).catch(() => false) : true);
  try {
    // Assigned once installed: a guard whose install timed out is never removed (its handler may never be added).
    guard = await bounded('installing the navigation guard', deadlines.guard_ms, guardNavigation(rt));
    await bounded('the page load', callMs, rt.awaitLoaded().catch(() => undefined));
    rt.assertSignedIn();
    const url = (read = rt.page.url());
    // Only a page of the environment is taken (its origin, not merely its host: another local port is another app).
    onEnv(url);
    let within: string | null = null;
    let withinFound = true;
    if (req.within !== undefined) {
      const r = await bounded('finding `within`', callMs, rt.kit.callOnce<ResolveResult>('find', normalizeTarget(req.within), {}));
      if (r.count > 0 && 'ref' in r) within = r.ref;
      else {
        withinFound = false;
        warnings.push('the `within` target matches no visible element: nothing listed');
      }
    }
    const t0 = performance.now();
    const inv: KitInventory | null = withinFound
      ? await bounded('the inventory', callMs, rt.kit.inventory({ within, limit, budget_ms: req.budgetMs ?? INSPECT_BUDGET_MS }))
      : null;
    // The document the inventory read (a script may have replaced the page since the URL was read).
    if (inv) onEnv(`${inv.origin}/`);
    const targets = (req.targets ?? []).slice(0, INSPECT_TARGETS_MAX);
    if ((req.targets?.length ?? 0) > INSPECT_TARGETS_MAX) warnings.push(`only the first ${INSPECT_TARGETS_MAX} targets were checked`);
    const normal: Array<TargetObject | null> = targets.map((t) => (isPoint(t as TargetSpec | PointSpec) ? null : normalizeTarget(t)));
    const checked = await bounded('checking the targets', callMs, rt.kit.checkTargets(normal.filter((t): t is TargetObject => t !== null)));
    onEnv(`${checked.origin}/`);
    const kitMs = Math.round(performance.now() - t0);
    // The screenshot last (the inventory reads only): the cursor hidden; marks are drawn from the boxes later.
    await bounded('hiding the cursor', deadlines.guard_ms, rt.kit.cursorShow(false).catch(() => undefined));
    await rt.page.screenshot({ path: shot, timeout: 10_000 });
    shotTaken = true;
    // A sign-in page that showed while the picture was taken (L1.6), or a page that left meanwhile: never kept.
    rt.assertSignedIn();
    const after = rt.page.url();
    onEnv(after);

    report.untrusted.url = reportedUrl(after);
    report.screenshot = shot;
    report.timings.kit_ms = kitMs;
    report.counts.within_found = withinFound;
    let k = 0;
    report.targets_checked = normal.map((t, index): InspectTargetCheck => {
      if (!t) return { index, count: 0, chosen: null, in_view: null, bbox: null, hidden: 0, scope_found: true, untrusted: { desc: 'a point is not a target', near: [] } };
      const c = checked.checks[k++];
      return { index, count: c.count, chosen: c.index, in_view: c.in_view, bbox: c.bbox, hidden: c.hidden, scope_found: c.scope_found, untrusted: { desc: c.desc, near: c.near } };
    });
    report.counts.targets_checked = report.targets_checked.length;
    if (inv) {
      report.untrusted.title = inv.title;
      report.untrusted.headings = inv.headings;
      report.popups = inv.popups.map((p) => ({ kind: p.kind, bbox: p.bbox, untrusted: { name: p.name } }));
      report.scrollers = inv.scrollers;
      report.elements = inv.elements.map((e, i) => inspectElement(e, i + 1));
      report.counts = { ...report.counts, ...inv.counts, partial: inv.partial, within_found: inv.within_found };
      // A suggestion whose YAML would not read back as the verified target is dropped (never shown unverified).
      report.counts.dropped = report.elements.filter((e, i) => !e.verified && inv.elements[i].suggested !== null).length;
      if (inv.partial) warnings.push(`the in-page time budget ran out: ${inv.counts.unsuggested} listed elements have no suggestion`);
    }
  } catch (e) {
    if (shotTaken) await rm(shot, { force: true }).catch(() => undefined);
    if (isCancelled(e) || rt.loginGuardError()) {
      await removeGuard();
      throw rt.loginGuardError() ?? e;
    }
    // Nothing read from a document that was not the environment's is kept: the report holds its host alone.
    // A document replaced during a kit call (or a step the page did not answer in time): where the page went, once the
    // new one committed.
    const changed = e instanceof DocumentChangedError || e instanceof InspectDeadlineError;
    if (changed && read !== null) {
      const from = read;
      await bounded('the new document', 4_000, rt.page.waitForURL((u) => u.href !== from, { waitUntil: 'commit', timeout: 3_000 })).catch(() => undefined);
    }
    const landed = e instanceof LandedElsewhere ? e.url : changed && !isPageOrigin(rt.page.url(), rt.env.pages) ? rt.page.url() : null;
    if (landed !== null) {
      report.status = 'landed_elsewhere';
      report.untrusted.landed_host = hostOf(landed);
    } else {
      report.status = 'failed';
      report.untrusted.error = errorMessage(e);
    }
  }
  if (guard) {
    if (guard.blocked() > 0) warnings.push(`the page tried to leave for another origin during the inspection (${guard.blocked()} navigation(s) stopped)`);
    if (!(await removeGuard())) warnings.push('the navigation guard could not be removed in time (the page closes with the run)');
  }
  report.untrusted.warnings.push(...warnings);
  return finish(rt, report, file, started);
}

async function finish(rt: Runtime, report: InspectReport, file: string, started: number): Promise<InspectReport> {
  report.timings.inspect_ms = Math.round(performance.now() - started);
  // Secret values the run resolved (a persona's password typed at sign-in…) never reach the report.
  const safe = rt.secrets.redactDeep(report);
  await writeFile(file, `${JSON.stringify(safe, null, 1)}\n`);
  return safe;
}
