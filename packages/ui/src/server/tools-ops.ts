/**
 * The app's downloaded Tools in the Studio (DESIGN §4p, docs/reference/studio-ui.md): the browser, the render browser
 * and the compositor that the disk image no longer carries. The Set-up sheet's first item, the status bar's control,
 * Welcome's card and the Tools page (`#/setup/tools`) read `tools_status` and act through the other four ops, over the
 * engine's `engine.tools` (tools-work.ts: the manifest, the installer, the lock other processes share).
 *
 * - **Studio only, never MCP tools** (OWN_OPS; the catalogue's TOOLS_MCP): only a person's click downloads.
 * - **Reads for every page**: `tools_status` answers on any server (a checkout says `available: false`), so the queue's
 *   waiting words and the "not downloaded yet" states of previews show in a browser tab too; it says whether this
 *   server may act (`can`: the installed app's own server, moved to Applications for a download) and never acts.
 * - **Writes are the installed app's own server's** (setup-context.ts gate: supervised AND an app bundle; a download
 *   also from Applications — a translocated copy's downloads are where quarantine sticks): 409 otherwise. Install,
 *   Check again and Remove… count in the set-up's writes a minute; Pause and Cancel do not (they only stop).
 * - **The install runs in the server, not in the request**: `tools_install` starts it (or answers that one runs:
 *   this server's, or another process's — `retake tools install` in a terminal) and returns; the page follows it by
 *   polling `tools_status` (every process writes the same `.state.json`). The server's close pauses it (what arrived
 *   is kept). An install that ends ready starts the workspace's worker (engine.tools.install): jobs that waited go on;
 *   a ready seen here after another process installed wakes it too (engine.tools.wake).
 * - The page never sends a path, a URL or a source: the server downloads the manifest's URLs from their publishers.
 * - What the system said (an offline or failed install's message, a Tool's problem) is under `untrusted`: shown as text.
 */
import { z } from 'zod';
import { EngineError } from '@retake/engine';
import type { Engine } from '@retake/engine';
import type { InstallResult, ToolCheck, ToolsPruneResult, ToolsStatus } from '@retake/engine/tools';
import { defineTool } from '@retake/engine/contract';
import type { ToolOutput } from '@retake/engine/contract';
import { READ_ANN, WRITE_ANN, appBundle, gate, locationOf } from './setup-context.js';
import type { SetupOpsOptions } from './setup-context.js';

export const TOOLS_OPS = ['tools_status', 'tools_install', 'tools_control', 'tools_check', 'tools_prune', 'tools_reveal'] as const;

/** Why this server may not act on the Tools (`ok`: it may). */
export type ToolsCan = 'ok' | 'not_supervised' | 'not_bundled' | 'location';

/** What the server keeps of the Tools between ops: the install it runs, the last outcome, the last check. */
export class ToolsServerState {
  /** The install this server runs (one at a time). */
  running: { abort: AbortController; done: Promise<void> } | undefined;
  /** How the last install this server ran ended (what the page says once it stopped). */
  last: { outcome: InstallResult['outcome']; message?: string } | undefined;
  /** The last "Check again": when, and each Tool's state. */
  checked: { at: string; tools: ToolCheck[] } | undefined;
  /** A Check again in flight. */
  checking = false;
  /** The state the last status saw (a turn to ready wakes the worker; `ready` once the wake succeeded). */
  seen: ToolsStatus['state'] | undefined;
  /** A wake of the worker in flight (one at a time). */
  waking = false;

  /** Pause the install this server runs (its close): what arrived is kept. */
  async stop(): Promise<void> {
    const r = this.running;
    if (!r) return;
    r.abort.abort();
    await r.done;
  }
}

/** What `tools_status` answers: the engine's status, what this server may do, its last outcome and check. */
export interface ToolsView extends Omit<ToolsStatus, 'message' | 'tools'> {
  can: ToolsCan;
  /** The Tools, each with its licence files once it is ready (its problem under `untrusted`). */
  tools: Array<Omit<ToolsStatus['tools'][number], 'problem'> & { licences: string[] }>;
  /** This server runs the install now. */
  running: boolean;
  last?: { outcome: InstallResult['outcome'] };
  checked?: { at: string; tools: Array<Omit<ToolCheck, 'problem'>> };
  checking: boolean;
  untrusted?: { message?: string; problems?: Record<string, string> };
}

/** The state of this server for an action: `ok`, or why not (no write counted). */
function canAct(o: SetupOpsOptions, placed: boolean): ToolsCan {
  if (!o.pipe.supervised) return 'not_supervised';
  const ctx = o.ctx();
  const b = appBundle(ctx);
  if (!b) return 'not_bundled';
  return placed && locationOf(b, ctx) !== 'ok' ? 'location' : 'ok';
}

/** The engine's status as the page reads it (system text under `untrusted`). */
export function toolsView(s: ToolsStatus, st: ToolsServerState, can: ToolsCan, licences: Partial<Record<string, string[]>> = {}): ToolsView {
  const { message, tools, ...rest } = s;
  const problems: Record<string, string> = {};
  for (const t of tools) if (t.problem) problems[t.id] = t.problem;
  const checkProblems = st.checked?.tools.filter((t) => t.problem) ?? [];
  for (const t of checkProblems) problems[`check:${t.id}`] = t.problem!;
  const message2 = message ?? st.last?.message;
  const untrusted = { ...(message2 ? { message: message2 } : {}), ...(Object.keys(problems).length ? { problems } : {}) };
  return {
    ...rest,
    can,
    tools: tools.map(({ problem: _p, ...t }) => ({ ...t, licences: t.state === 'ready' ? (licences[t.id] ?? []) : [] })),
    running: st.running !== undefined,
    ...(st.last ? { last: { outcome: st.last.outcome } } : {}),
    ...(st.checked ? { checked: { at: st.checked.at, tools: st.checked.tools.map(({ problem: _p, ...t }) => t) } } : {}),
    checking: st.checking,
    ...(Object.keys(untrusted).length ? { untrusted } : {}),
  };
}

/** What the Tools ops close over: the set-up's options (pipe, state, machine) and this server's engine. */
export interface ToolsOpsOptions extends SetupOpsOptions {
  engine: () => Engine;
  tools: ToolsServerState;
}

function statusOp(o: ToolsOpsOptions) {
  return defineTool({
    name: 'tools_status',
    title: "The app's Tools",
    description:
      "The browser, the render browser and the compositor the app downloads: their state, the download's progress, the folder. Any Studio page reads it; only the desktop app's own server acts.",
    input: z.strictObject({}),
    annotations: READ_ANN,
    async run(): Promise<ToolOutput<ToolsView>> {
      const e = o.engine();
      const s = e.tools.status();
      wakeOnReady(o.tools, e, s.state);
      return { summary: `tools: ${s.state}`, data: toolsView(s, o.tools, canAct(o, true), s.available ? e.tools.licences() : {}) };
    },
  });
}

/**
 * Ready now, after another process's install (a terminal's): the jobs that waited go on. The turn to `ready` is only
 * remembered once the wake resolved (engine.tools.wake decides from a fresh read of the Tools, never the queue's
 * cached gate): a wake that failed is tried again on the next status.
 */
export function wakeOnReady(st: ToolsServerState, e: Engine, state: ToolsStatus['state']): void {
  if (state !== 'ready' || st.seen === undefined || st.seen === 'ready' || st.running) {
    st.seen = state;
    return;
  }
  if (st.waking) return;
  st.waking = true;
  void e.tools
    .wake()
    .then(
      () => {
        st.seen = 'ready';
      },
      () => undefined,
    )
    .finally(() => {
      st.waking = false;
    });
}

/** Start the install in the server: it ends on its own (the page polls tools_status), the server's close pauses it. */
function startInstall(o: ToolsOpsOptions): void {
  const abort = new AbortController();
  const e = o.engine();
  o.tools.last = undefined;
  const done = e.tools
    .install({ by: 'studio', signal: abort.signal })
    .then(
      (r) => {
        o.tools.last = { outcome: r.outcome, ...(r.message ? { message: r.message } : {}) };
      },
      (err: unknown) => {
        o.tools.last = { outcome: 'failed', message: err instanceof Error ? err.message : String(err) };
      },
    )
    .finally(() => {
      o.tools.running = undefined;
    });
  o.tools.running = { abort, done };
}

function installOp(o: ToolsOpsOptions) {
  return defineTool({
    name: 'tools_install',
    title: 'Download the Tools',
    description:
      "Download the Tools this version names from their publishers, check each against its digest, then keep them in the Retake home (or resume a paused download). Starts it and returns: tools_status follows it. The desktop app's own server only; the person's click.",
    input: z.strictObject({}),
    annotations: { ...WRITE_ANN, openWorldHint: true },
    async run() {
      gate(o.pipe, o.ctx(), o.state, true);
      const s = o.engine().tools.status();
      if (!s.available) throw new EngineError('refused', 'this Retake runs from a repository checkout: it has no Tools to download', { details: { reason: 'checkout' } });
      if (o.tools.running) return { summary: 'the download runs already', data: { started: false, state: s.state } };
      if (s.state === 'ready') return { summary: 'the Tools are ready', data: { started: false, state: s.state } };
      if (s.by) return { summary: `another process downloads the Tools (${s.by.by})`, data: { started: false, state: s.state } };
      startInstall(o);
      return { summary: 'the download started', data: { started: true, state: 'downloading' as const } };
    },
  });
}

function controlOp(o: ToolsOpsOptions) {
  return defineTool({
    name: 'tools_control',
    title: 'Pause or cancel the download',
    description:
      "Pause the Tools' download (what arrived is kept: tools_install resumes) or cancel it (what arrived is removed) — this server's or another process's. The desktop app's own server only.",
    input: z.strictObject({ action: z.enum(['pause', 'cancel']).describe('pause: keep what arrived; cancel: remove it.') }),
    annotations: WRITE_ANN,
    async run(a: { action: 'pause' | 'cancel' }) {
      // Stopping is never capped (it only stops what runs).
      gate(o.pipe, o.ctx(), o.state, false, false);
      await o.engine().tools.control(a.action);
      return { summary: a.action === 'pause' ? 'the download pauses' : 'the download is cancelled', data: { ok: true, action: a.action } };
    },
  });
}

function checkOp(o: ToolsOpsOptions) {
  return defineTool({
    name: 'tools_check',
    title: 'Check the Tools again',
    description: "Every installed Tool's whole tree against the digest this version records; a Tool that differs is marked damaged until it is downloaded again. The desktop app's own server only.",
    input: z.strictObject({}),
    annotations: WRITE_ANN,
    async run() {
      gate(o.pipe, o.ctx(), o.state, false);
      // This server's install or check, or another process's install (a terminal's, an update's): a folder half placed
      // would read as damaged. The engine's check takes the Tools folder's lock too (busy while anyone holds it).
      if (o.tools.running || o.tools.checking || o.engine().tools.status().by)
        throw new EngineError('busy', 'the Tools are being downloaded or checked: wait for it to end', { details: { reason: 'busy' } });
      o.tools.checking = true;
      try {
        const tools = await o.engine().tools.check();
        o.tools.checked = { at: new Date().toISOString(), tools };
        const bad = tools.filter((t) => t.state !== 'ready');
        return { summary: bad.length ? `${bad.length} Tool(s) not ready` : 'every Tool matches its digest', data: { ok: bad.length === 0, tools: tools.map(({ problem: _p, ...t }) => t) } };
      } finally {
        o.tools.checking = false;
      }
    },
  });
}

/** A prune's answer for the page: what went, what stayed and why (our words). */
function pruneData(r: ToolsPruneResult) {
  return { busy: r.busy !== undefined, removed: r.removed, kept: r.kept };
}

function pruneOp(o: ToolsOpsOptions) {
  return defineTool({
    name: 'tools_prune',
    title: 'Remove older Tools',
    description:
      "Remove the Tools folders this version does not name and no copy of Retake used in the last 30 days (another app's current Tools, an update's, a running worker's are kept). The desktop app's own server only; the person's click.",
    input: z.strictObject({}),
    annotations: { ...WRITE_ANN, destructiveHint: true },
    async run() {
      gate(o.pipe, o.ctx(), o.state, false);
      if (o.tools.running) throw new EngineError('busy', 'the Tools are being downloaded: remove older ones once it ends', { details: { reason: 'busy' } });
      const r = await o.engine().tools.prune();
      const bytes = r.removed.reduce((n, x) => n + x.bytes, 0);
      return { summary: r.busy ? 'another process installs the Tools now: nothing removed' : `${r.removed.length} folder(s) removed (${bytes} bytes)`, data: pruneData(r) };
    },
  });
}

function revealOp(o: ToolsOpsOptions) {
  return defineTool({
    name: 'tools_reveal',
    title: 'Show the Tools in Finder',
    description: "Ask the desktop app to show its Tools folder in Finder (the shell's own home's: no path comes from the page). The desktop app's own server only.",
    input: z.strictObject({}),
    annotations: WRITE_ANN,
    async run() {
      gate(o.pipe, o.ctx(), o.state, false);
      o.pipe.setup('tools_folder');
      return { summary: 'the Tools folder shows in Finder', data: { ok: true } };
    },
  });
}

/** The Studio's Tools ops. */
export function toolsOps(o: ToolsOpsOptions) {
  return [statusOp(o), installOp(o), controlOp(o), checkOp(o), pruneOp(o), revealOp(o)];
}
