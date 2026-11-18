/**
 * The Tools' use cases: what `retake tools`, the Studio's set-up and Tools page (engine.tools, facade/tools-api.ts)
 * and engine_info call — status, install, pause / resume / cancel, check again, prune, the start record — over the app's
 * manifest (bundle.json `tools`) and the Retake home of the caller's environment. In a repository checkout there are no
 * Tools: the status says `checkout` (Playwright's cache and node_modules) and an install is refused — a test makes
 * an app with `bundle` (a fake bundle, test-support tools.ts fakeToolsBundle) or core's overrideBundleInfo.
 *
 * Only a person's action installs: no job, no MCP tool and no Studio start calls `installToolsFor`.
 */
import { bundleInfoOrNull, bundleTools, readStamp, toolFolder, toolProblem, toolState, toolsDir, treeDigest, VERIFIED_FILE } from '@retake/core/io';
import type { BundleInfo, ToolEntry, ToolId, ToolNeed, ToolReadiness } from '@retake/core/io';
import { missingNeeds } from './tools/gate.js';
import { chmodSync, lstatSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from './clock.js';
import { stampOf } from './clock.js';
import type { EngineEnv } from './env.js';
import { EngineError } from './errors.js';
import { controlTools, installTools } from './tools/install.js';
import type { InstallResult, ToolsSource } from './tools/install.js';
import type { RetryPolicy, ToolsFetch } from './tools/download.js';
import { addPending, pruneTools, recordStarted, removePending } from './tools/prune.js';
import type { ToolsPruneResult } from './tools/prune.js';
import { takeToolsLock, toolsStatus } from './tools/state.js';
import type { ToolsInstaller, ToolsLockRecord, ToolsRunFile, ToolsStatus } from './tools/state.js';

export type { InstallResult, ToolsSource } from './tools/install.js';
export type { ToolsPruneResult } from './tools/prune.js';
export type { ToolsFetch } from './tools/download.js';
export type { ToolStatus, ToolsInstaller, ToolsOverall, ToolsRunFile, ToolsStatus } from './tools/state.js';

/** What the Tools' use cases read: the caller's environment (its home), the clock, the app (default this engine's). */
export interface ToolsWork {
  env: EngineEnv;
  clock: Clock;
  /** The app this engine runs from (default core bundleInfoOrNull); null: a checkout. */
  bundle?: BundleInfo | null;
  /** The download (default the system's fetch); tests hand theirs. */
  fetch?: ToolsFetch;
  hosts?: readonly string[];
  retry?: RetryPolicy;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  freeBytes?: (dir: string) => number;
}

/** What a checkout says instead of installing. */
export const CHECKOUT_TOOLS =
  'this Retake runs from a repository checkout: it uses Playwright’s cache and node_modules (pnpm --filter @retake/runner-web exec playwright-core install chromium chromium-headless-shell) — `retake tools install` is the installed app’s';

function bundleOf(w: ToolsWork): BundleInfo | null {
  return w.bundle === undefined ? bundleInfoOrNull() : w.bundle;
}

/** The app's Tools (bundle.json `tools`), null in a checkout; a damaged list is an `internal` EngineError. */
export function appTools(w: ToolsWork): ToolEntry[] | null {
  const b = bundleOf(w);
  if (!b) return null;
  try {
    return bundleTools(b);
  } catch (e) {
    throw new EngineError('internal', `${e instanceof Error ? e.message : String(e)}: reinstall Retake`);
  }
}

/**
 * The Tools' status (state.ts ToolsStatus): `checkout` in a checkout; `damaged` with the reason when the app's
 * bundle.json lists no valid Tools (never a throw: engine_info and the Studio's start read it).
 */
export function toolsStatusOf(w: ToolsWork): ToolsStatus {
  let entries: ToolEntry[] | null;
  try {
    entries = appTools(w);
  } catch (e) {
    const s = toolsStatus(w.env, null);
    return { ...s, available: true, state: 'damaged', message: e instanceof Error ? e.message : String(e) };
  }
  return toolsStatus(w.env, entries);
}

/**
 * Why a command typed in a terminal that needs `need` may not start now (one sentence saying what to do), or undefined:
 * the Tools it needs are ready (or named by $RETAKE_CHROMIUM / $RETAKE_CHROMIUM_HEADLESS_SHELL), or this is a checkout.
 * The CLI runs its captures and renders in process, with no queue to wait in: it refuses before anything starts.
 */
export function toolsRefusal(w: ToolsWork, need: ToolNeed, what: string): string | undefined {
  const b = bundleOf(w);
  if (!b || !missingNeeds(w.env, b).has(need)) return undefined;
  const ids: ToolId[] = need === 'browser' ? ['browser'] : ['render-browser', 'compositor'];
  const why = ids.map((id) => toolProblem(id, w.env as NodeJS.ProcessEnv, b)).find((p) => p !== undefined);
  return `${what} needs ${need === 'browser' ? 'the browser' : 'the render tools'}: ${why ?? 'not downloaded yet: run `retake tools install`'}`;
}

/** The needs of the Tools missing now, read afresh (tools/gate.ts missingNeeds: never a gate's cached answer). */
export function missingToolsNow(w: ToolsWork): ReadonlySet<ToolNeed> {
  return missingNeeds(w.env, bundleOf(w));
}

/** The default download: the system's fetch, with the installer's request (download.ts calls it with no other option). */
const systemFetch: ToolsFetch = (url, init) => fetch(url, init);

export interface InstallRequest {
  by: ToolsInstaller;
  source?: ToolsSource;
  only?: readonly ToolId[];
  signal?: AbortSignal;
  onProgress?: (run: ToolsRunFile) => void;
  log?: (line: string) => void;
}

/** Install the app's Tools (install.ts installTools); refused (`refused`) in a checkout. */
export async function installToolsFor(w: ToolsWork, r: InstallRequest): Promise<InstallResult> {
  const entries = appTools(w);
  if (!entries) throw new EngineError('refused', CHECKOUT_TOOLS);
  const b = bundleOf(w)!;
  return installTools({
    env: w.env,
    entries,
    version: b.manifest.app,
    by: r.by,
    clock: w.clock,
    ...(r.source ? { source: r.source } : {}),
    ...(r.only ? { only: r.only } : {}),
    ...(w.hosts ? { hosts: w.hosts } : {}),
    fetch: w.fetch ?? systemFetch,
    ...(w.retry ? { retry: w.retry } : {}),
    ...(w.sleep ? { sleep: w.sleep } : {}),
    ...(w.freeBytes ? { freeBytes: w.freeBytes } : {}),
    ...(r.signal ? { signal: r.signal } : {}),
    ...(r.onProgress ? { onProgress: r.onProgress } : {}),
    ...(r.log ? { log: r.log } : {}),
  });
}

/**
 * The updater's install (the updater's server side): the Tools of the version an update brings (`entries`, from its own bundle.json:
 * core parseToolEntries), downloaded before its restart while this version runs on its own; kept by `.pending.json`
 * until the new version starts (toolsStarted) or the update is abandoned (`abandonUpdateTools`).
 */
export async function installUpdateTools(w: ToolsWork, u: { app: string; entries: readonly ToolEntry[] } & Omit<InstallRequest, 'by' | 'only'>): Promise<InstallResult> {
  if (!bundleOf(w)) throw new EngineError('refused', CHECKOUT_TOOLS);
  addPending(w.env, { app: u.app, folders: u.entries.map((e) => e.folder), clock: w.clock });
  return installTools({
    env: w.env,
    entries: u.entries,
    version: u.app,
    by: 'update',
    clock: w.clock,
    ...(u.source ? { source: u.source } : {}),
    ...(w.hosts ? { hosts: w.hosts } : {}),
    fetch: w.fetch ?? systemFetch,
    ...(w.retry ? { retry: w.retry } : {}),
    ...(w.sleep ? { sleep: w.sleep } : {}),
    ...(w.freeBytes ? { freeBytes: w.freeBytes } : {}),
    ...(u.signal ? { signal: u.signal } : {}),
    ...(u.onProgress ? { onProgress: u.onProgress } : {}),
    ...(u.log ? { log: u.log } : {}),
  });
}

/** One Tool's licence files as its folder holds them (two levels down): ABOUT, LICENSE…, NOTICE…, COPYING…. */
export function licenceFiles(folder: string): string[] {
  const out: string[] = [];
  const LICENCE = /^(?:about|licen[cs]e|notice|copying)(?:[._-].*)?$/i;
  const walk = (dir: string, rel: string, depth: number) => {
    let list: Dirent[];
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile() && LICENCE.test(e.name)) out.push(r);
      else if (e.isDirectory() && depth < 1 && !e.name.endsWith('.app')) walk(join(dir, e.name), r, depth + 1);
    }
  };
  walk(folder, '', 0);
  return out.sort().slice(0, 8);
}

/** The licence files of each ready Tool (the Tools page's terms list them beside our own notices); none in a checkout. */
export function toolLicences(w: ToolsWork): Partial<Record<ToolId, string[]>> {
  const entries = appTools(w);
  if (!entries) return {};
  const dir = toolsDir(w.env as NodeJS.ProcessEnv);
  const out: Partial<Record<ToolId, string[]>> = {};
  for (const e of entries) if (toolState(e, dir, { walk: false }).state === 'ready') out[e.id] = licenceFiles(toolFolder(e, dir));
  return out;
}

/** An update given up: its pre-downloaded Tools are no longer kept (a later prune may remove them). */
export function abandonUpdateTools(w: ToolsWork, app: string): void {
  removePending(w.env, app);
}

/** Pause or cancel the running install (any process's); a cancel with none running clears what one left (under the lock). */
export async function controlToolsFor(w: ToolsWork, action: 'pause' | 'cancel'): Promise<void> {
  if (!appTools(w)) throw new EngineError('refused', CHECKOUT_TOOLS);
  await controlTools(w.env, action, w.clock, bundleOf(w)!.manifest.app);
}

/** One Tool after "Check again". */
export interface ToolCheck {
  id: ToolId;
  state: ToolReadiness;
  problem?: string;
}

/** A folder's inode (lstat), or undefined when it is not there. */
function inode(p: string): number | undefined {
  try {
    const st = lstatSync(p);
    return st.isDirectory() ? st.ino : undefined;
  } catch {
    return undefined;
  }
}

/** Write a folder's stamp (read-only folder: writable for the write only). */
function restamp(folder: string, entry: ToolEntry, clock: Pick<Clock, 'now'>, damaged?: string): void {
  const old = readStamp(folder);
  const file = join(folder, VERIFIED_FILE);
  chmodSync(folder, 0o755);
  try {
    // The stamp is read-only too: replaced, not written over.
    rmSync(file, { force: true });
    writeFileSync(file, `${JSON.stringify({ v: 1, tree: entry.tree, entries: old?.entries ?? 0, bytes: old?.bytes ?? 0, at: stampOf(clock), ...(damaged ? { damaged } : {}) })}\n`, { mode: 0o444 });
  } finally {
    chmodSync(folder, 0o555);
  }
}

/** What a check answers while another process holds the Tools folder (an install: it would see a folder half placed). */
export function checkBusy(h: ToolsLockRecord): EngineError {
  const who = h.by === 'studio' ? 'the Studio' : h.by === 'update' ? 'an update' : 'retake tools';
  return new EngineError('busy', `the Tools are being ${h.command === 'tools install' ? 'downloaded' : 'changed'} by ${who} (pid ${h.pid}): check them again once that ends`, {
    details: { reason: 'busy', pid: h.pid, by: h.by },
  });
}

/**
 * "Check again": every installed Tool's full tree digest against the manifest's, under the Tools folder's lock (an
 * install never moves a folder while it is read; `busy` while another process holds it). A folder whose digest is not
 * the one recorded is marked damaged in its stamp (every cheap check then says so, its jobs wait) until it is installed
 * again — only the folder that was digested (the same inode before and after).
 */
export async function checkToolsFor(w: ToolsWork, by: ToolsInstaller = 'cli'): Promise<ToolCheck[]> {
  const entries = appTools(w);
  if (!entries) throw new EngineError('refused', CHECKOUT_TOOLS);
  const dir = toolsDir(w.env as NodeJS.ProcessEnv);
  const lock = await takeToolsLock(dir, by, bundleOf(w)!.manifest.app, w.clock, 'tools check');
  if ('holder' in lock) throw checkBusy(lock.holder);
  try {
    return await checkEach(w, entries, dir);
  } finally {
    lock.release();
  }
}

/** The check of each Tool (the lock held). */
async function checkEach(w: ToolsWork, entries: readonly ToolEntry[], dir: string): Promise<ToolCheck[]> {
  const out: ToolCheck[] = [];
  for (const e of entries) {
    const s = toolState(e, dir);
    if (s.state === 'missing') {
      out.push({ id: e.id, state: 'missing' });
      continue;
    }
    if (s.state === 'damaged' && !readStamp(s.path)) {
      out.push({ id: e.id, state: 'damaged', ...(s.problem ? { problem: s.problem } : {}) });
      continue;
    }
    const ino = inode(s.path);
    const got = ino !== undefined ? await treeDigest(s.path, e.markers ?? []) : '';
    if (got !== e.tree) {
      const problem = `its tree digest is ${got.slice(0, 12)}…, not the ${e.tree.slice(0, 12)}… this version records`;
      // Only the folder that was digested is marked (never one put there meanwhile).
      if (ino !== undefined && inode(s.path) === ino) restamp(s.path, e, w.clock, problem);
      out.push({ id: e.id, state: 'damaged', problem });
      continue;
    }
    const after = toolState(e, dir);
    out.push({ id: e.id, state: after.state, ...(after.problem ? { problem: after.problem } : {}) });
  }
  return out;
}

/**
 * Remove older Tools folders (prune.ts); refused in a checkout. `force`: only this version's stay, and the update's
 * under way (`keepPending`) — every other pending update's record is dropped.
 */
export async function pruneToolsFor(w: ToolsWork, o: { force?: boolean; keepPending?: string } = {}): Promise<ToolsPruneResult> {
  const entries = appTools(w);
  if (!entries) throw new EngineError('refused', CHECKOUT_TOOLS);
  return pruneTools(w.env, {
    entries,
    version: bundleOf(w)!.manifest.app,
    clock: w.clock,
    ...(o.force ? { force: true } : {}),
    ...(o.keepPending !== undefined ? { keepPending: o.keepPending } : {}),
  });
}

/**
 * At a start of the app (the Studio's server): once every Tool of this version is ready, record the start
 * (`.started.json`), forget this version's pending update record, and prune older folders. Null when not every Tool
 * is ready (nothing recorded, nothing pruned) or in a checkout.
 */
export async function toolsStarted(w: ToolsWork): Promise<ToolsPruneResult | null> {
  const entries = appTools(w);
  if (!entries) return null;
  const dir = toolsDir(w.env as NodeJS.ProcessEnv);
  if (!entries.every((e) => toolState(e, dir).state === 'ready')) return null;
  const b = bundleOf(w)!;
  recordStarted(w.env, { app: b.manifest.app, location: b.sealed, entries, clock: w.clock });
  removePending(w.env, b.manifest.app);
  return pruneTools(w.env, { entries, version: b.manifest.app, clock: w.clock });
}

/**
 * Follow another process's install until it ends (`retake tools install` while the Studio downloads): the status every
 * `pollMs`, until no live holder is left or `signal` is aborted. Returns the last status.
 */
export async function followTools(w: ToolsWork, o: { pollMs?: number; signal?: AbortSignal; onStatus?: (s: ToolsStatus) => void } = {}): Promise<ToolsStatus> {
  for (;;) {
    const s = toolsStatusOf(w);
    o.onStatus?.(s);
    if (s.state !== 'downloading' || o.signal?.aborted) return s;
    await new Promise((r) => setTimeout(r, o.pollMs ?? 500));
  }
}
