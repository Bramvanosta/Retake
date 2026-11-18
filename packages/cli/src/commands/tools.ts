/**
 * `retake tools`: the app's downloaded Tools — the browser, the render browser and the compositor — under the
 * Retake home of this shell (`$RETAKE_HOME`, else ~/.retake). `status` (the default), `install` (from their
 * publishers, or `--from-archives <dir>` / `--from-playwright-cache [dir]`: no network), `check` (every folder's full
 * digest again) and `prune` (older folders nothing keeps). In a repository checkout there are no Tools: `status` says
 * what a checkout uses, the others are refused. The work is the engine's (`@retake/engine/tools`); this file prints.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { megabytes } from '@retake/core/base';
import { createEngine } from '@retake/engine';
import { CHECKOUT_TOOLS, checkToolsFor, followTools, installToolsFor, pruneToolsFor, toolsStatusOf } from '@retake/engine/tools';
import type { InstallResult, ToolStatus, ToolsRunFile, ToolsSource, ToolsStatus, ToolsWork } from '@retake/engine/tools';
import { EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import type { GlobalOptions } from '../workspace.js';

/** Decimal megabytes, as the Studio says them (core megabytes): the button's "315 MB" is the same figure here. */
const mb = megabytes;

/** What the Tools' use cases read: this shell's environment and clock (tests: a fake app and fetch through `over`). */
function workOf(global: GlobalOptions, over: Partial<ToolsWork> = {}): ToolsWork {
  return { env: global.ports.env, clock: global.ports.clock, ...over };
}

/** A Tool's state, as the table says it. */
function stateWords(t: ToolStatus): string {
  switch (t.state) {
    case 'ready':
      return 'ready';
    case 'missing':
      return `not downloaded (${mb(t.bytes)})`;
    case 'damaged':
      return `damaged: ${t.problem ?? 'its check fails'}`;
    case 'mismatch':
      return t.mismatch === 'tree'
        ? `refused: its extracted files are not the ones recorded, discarded (tree digest ${t.got ?? '?'}, recorded ${t.expected ?? '?'})`
        : `refused: its archive is not the one recorded (sha256 ${t.got ?? '?'}, recorded ${t.expected ?? '?'})`;
    case 'downloading':
      return `downloading · ${mb(t.received)} of ${mb(t.bytes)}`;
    case 'paused':
    case 'offline':
      return `${t.state} · ${mb(t.received)} of ${mb(t.bytes)} kept`;
    default:
      return t.state;
  }
}

/** The folder, said with `~` and whether $RETAKE_HOME chose it. */
function folderWords(s: Pick<ToolsStatus, 'folder' | 'home_from_env'>): string {
  const home = homedir();
  const f = s.folder.startsWith(`${home}/`) ? `~${s.folder.slice(home.length)}` : s.folder;
  return `${f}${s.home_from_env ? ' ($RETAKE_HOME)' : ''}`;
}

export interface ToolsStatusOptions {
  json?: boolean;
}

/** `retake tools [status]`: each Tool, its version, state and folder; the folder; older folders. */
export function toolsStatusCommand(ui: Ui, global: GlobalOptions, o: ToolsStatusOptions, over: Partial<ToolsWork> = {}): ExitCode {
  const s = toolsStatusOf(workOf(global, over));
  if (o.json) {
    ui.result(JSON.stringify(s, null, 2));
    return EXIT.ok;
  }
  if (!s.available) {
    ui.result(`Tools: none — ${CHECKOUT_TOOLS}`);
    return EXIT.ok;
  }
  ui.result(`Tools · ${s.state}${s.by ? ` (by ${s.by.by}, pid ${s.by.pid})` : ''} · ${folderWords(s)}`);
  const width = Math.max(...s.tools.map((t) => t.label.length), 4);
  for (const t of s.tools) ui.result(`  ${t.label.padEnd(width)}  ${t.version.padEnd(14)}  ${stateWords(t)}`);
  if (s.message) ui.result(`  ${s.message}`);
  if (s.state !== 'ready' && s.state !== 'downloading') ui.result(`  download: ${mb(s.total_bytes - s.received_bytes)} — retake tools install`);
  if (s.older.folders.length) ui.result(`  older: ${s.older.folders.length} folder(s) · ${mb(s.older.bytes)} — retake tools prune`);
  return EXIT.ok;
}

export interface ToolsInstallOptions {
  fromArchives?: string;
  /** `true`: Playwright's default cache; a string: that folder. */
  fromPlaywrightCache?: string | boolean;
  wait?: boolean;
  json?: boolean;
}

/** Playwright's cache folder: $PLAYWRIGHT_BROWSERS_PATH (unless 0), else its macOS default. */
function playwrightCache(env: GlobalOptions['ports']['env'], given: string | boolean): string {
  if (typeof given === 'string') return resolve(given);
  const v = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  return v && v !== '0' ? resolve(v) : join(homedir(), 'Library', 'Caches', 'ms-playwright');
}

/** One line of a running install: each Tool's step, the aggregate, the time left. */
function progressLine(run: ToolsRunFile): string {
  const tools = Object.entries(run.tools);
  const open = tools.filter(([, t]) => t.state !== 'ready');
  const received = open.reduce((n, [, t]) => n + t.received, 0);
  const total = open.reduce((n, [, t]) => n + t.bytes, 0);
  const now = tools.find(([, t]) => t.state === 'downloading' || t.state === 'checking' || t.state === 'extracting');
  const rate = run.rate ? ` · ${mb(run.rate)}/s` : '';
  const eta = run.eta_s !== undefined ? ` · about ${run.eta_s < 60 ? `${Math.max(1, run.eta_s)} s` : `${Math.round(run.eta_s / 60)} min`} left` : '';
  return `${now ? `${now[0]} ${now[1].state}` : 'Tools'} · ${mb(received)} of ${mb(total)}${rate}${eta}`;
}

/** What an install's end says, and its exit code. */
function reportInstall(ui: Ui, r: InstallResult, s: ToolsStatus): ExitCode {
  if (r.outcome === 'ready') {
    for (const t of s.tools) ui.ok(`${t.label} ${t.version} · checked · ${t.folder}`);
    return EXIT.ok;
  }
  if (r.outcome === 'paused') {
    ui.warn('paused: what arrived is kept — run retake tools install again to resume');
    return EXIT.interrupted;
  }
  if (r.outcome === 'cancelled') {
    ui.warn('cancelled: what arrived was removed');
    return EXIT.failure;
  }
  ui.error(r.message ?? `the Tools were not installed (${r.outcome})`);
  return EXIT.failure;
}

/**
 * `retake tools install`: download (or copy) and check the Tools not ready. Ctrl-C pauses (what arrived is kept). While
 * another process downloads them, it follows that one (`--no-wait`: says who, and exits 0).
 */
export async function toolsInstallCommand(ui: Ui, global: GlobalOptions, o: ToolsInstallOptions, over: Partial<ToolsWork> = {}): Promise<ExitCode> {
  const w = workOf(global, over);
  const before = toolsStatusOf(w);
  if (!before.available) {
    ui.error(CHECKOUT_TOOLS);
    return EXIT.failure;
  }
  if (o.fromArchives && o.fromPlaywrightCache) throw new UsageError('--from-archives and --from-playwright-cache are two sources of the same Tools: give one');
  const source: ToolsSource | undefined = o.fromArchives
    ? { from: 'archives', dir: resolve(o.fromArchives) }
    : o.fromPlaywrightCache
      ? { from: 'playwright-cache', dir: playwrightCache(w.env, o.fromPlaywrightCache) }
      : undefined;
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once('SIGINT', onSignal);
  let last = '';
  try {
    const r = await installToolsFor(w, {
      by: 'cli',
      ...(source ? { source } : {}),
      signal: stop.signal,
      onProgress: (run) => {
        if (o.json) {
          ui.result(JSON.stringify({ type: 'progress', ...run }));
          return;
        }
        const line = progressLine(run);
        if (line !== last) ui.setStatus(line);
        last = line;
      },
      log: (line) => ui.info(line),
    });
    ui.clearStatus();
    if (r.outcome === 'busy') return await followOther(ui, w, r, o, stop.signal);
    const s = toolsStatusOf(w);
    if (o.json) ui.result(JSON.stringify({ type: 'result', outcome: r.outcome, installed: r.installed, ...(r.message ? { message: r.message } : {}), status: s }));
    const code = reportInstall(ui, r, s);
    if (r.outcome === 'ready') await wakeWorker(ui, global);
    return code;
  } finally {
    process.off('SIGINT', onSignal);
  }
}

/** Another process installs: say who, then follow it (unless --no-wait). */
async function followOther(ui: Ui, w: ToolsWork, r: InstallResult, o: ToolsInstallOptions, signal: AbortSignal): Promise<ExitCode> {
  const h = r.holder!;
  const who = `${h.by === 'studio' ? 'the Studio' : h.by === 'update' ? 'an update' : 'another retake tools install'} (pid ${h.pid}, Retake ${h.version})`;
  if (o.wait === false) {
    ui.result(`the Tools are being downloaded by ${who}: it goes on there`);
    return EXIT.ok;
  }
  ui.info(`the Tools are being downloaded by ${who}: following it (Ctrl-C stops following, not the download)`);
  const s = await followTools(w, { signal, onStatus: (x) => x.state === 'downloading' && ui.setStatus(`Tools · ${mb(x.received_bytes)} of ${mb(x.total_bytes)}`) });
  ui.clearStatus();
  if (o.json) ui.result(JSON.stringify({ type: 'result', outcome: s.state, status: s }));
  if (s.state === 'ready') {
    ui.ok('the Tools are ready');
    return EXIT.ok;
  }
  ui.warn(`the Tools are ${s.state}${s.message ? `: ${s.message}` : ''}`);
  return signal.aborted ? EXIT.interrupted : EXIT.failure;
}

/** Jobs that waited for the Tools in this shell's workspace: its worker started again. Nothing outside a workspace. */
async function wakeWorker(ui: Ui, global: GlobalOptions): Promise<void> {
  try {
    const engine = await createEngine({ ...(global.root ? { root: resolve(global.root) } : {}), client: 'cli', ports: global.ports });
    if (await engine.tools.wake()) ui.info("the workspace's jobs that waited for the Tools start now");
  } catch {
    /* no workspace here: its worker starts when its Studio or an MCP client opens it */
  }
}

export interface ToolsCheckOptions {
  json?: boolean;
}

/** `retake tools check`: every folder's full digest again; a damaged one stays damaged until installed again (exit 1). */
export async function toolsCheckCommand(ui: Ui, global: GlobalOptions, o: ToolsCheckOptions, over: Partial<ToolsWork> = {}): Promise<ExitCode> {
  const w = workOf(global, over);
  if (!toolsStatusOf(w).available) {
    ui.error(CHECKOUT_TOOLS);
    return EXIT.failure;
  }
  const checks = await checkToolsFor(w);
  if (o.json) ui.result(JSON.stringify({ checks }, null, 2));
  else for (const c of checks) (c.state === 'ready' ? ui.ok.bind(ui) : ui.warn.bind(ui))(`${c.id}: ${c.state}${c.problem ? ` — ${c.problem}` : ''}`);
  if (checks.some((c) => c.state === 'damaged')) {
    if (!o.json) ui.error('damaged Tools: run retake tools install (they are downloaded and checked again)');
    return EXIT.failure;
  }
  return EXIT.ok;
}

export interface ToolsPruneOptions {
  force?: boolean;
  json?: boolean;
}

/** `retake tools prune [--force]`: older Tools folders nothing keeps (`--force`: only this version's stay). */
export async function toolsPruneCommand(ui: Ui, global: GlobalOptions, o: ToolsPruneOptions, over: Partial<ToolsWork> = {}): Promise<ExitCode> {
  const w = workOf(global, over);
  if (!toolsStatusOf(w).available) {
    ui.error(CHECKOUT_TOOLS);
    return EXIT.failure;
  }
  const r = await pruneToolsFor(w, { ...(o.force ? { force: true } : {}) });
  if (o.json) {
    ui.result(JSON.stringify(r, null, 2));
    return r.busy ? EXIT.failure : EXIT.ok;
  }
  if (r.busy) {
    ui.error(`the Tools are being downloaded (pid ${r.busy.pid}): try again once that ends`);
    return EXIT.failure;
  }
  for (const x of r.removed) ui.ok(`removed ${x.folder} (${mb(x.bytes)})`);
  for (const x of r.kept) ui.info(`kept ${x.folder}: ${x.why}`);
  if (!r.removed.length) ui.result('nothing to remove');
  return EXIT.ok;
}
