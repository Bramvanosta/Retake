/**
 * L5.16d: the desktop app's updates in the Studio (DESIGN §4p (d)). The shell checks its feed (tauri-plugin-updater,
 * the rules in desktop_core update_flow) and tells the supervised server each state as one line on stdin — parsed here
 * strictly (`parseUpdateLine`: fixed keys per state, enums, a version, a count, the feed's notes) and kept
 * (`UpdateState`); the page reads it through `desktop_update_status` ("Update available · vX" in the status bar, the
 * sheet's notes and its progress) and clicks through `desktop_update` {action: install | later}, which writes one pipe
 * line the shell takes (pipe.rs `update`: exactly these two actions — no version, no URL ever comes from the page).
 *
 * - Studio only: own ops (OWN_OPS, the `ui` client's allow-list), never MCP tools — installing an update and
 *   restarting the app is the person's click, never an agent's.
 * - Supervised only (the desktop app's own server): another server answers status `available: false` and refuses the
 *   click (409 `not_supervised`).
 * - The feed's notes are not signed (the archive is): the shell cleans them (no control or bidi character, at most
 *   NOTES_MAX characters) and so does this parser; the status gives them under `untrusted` — the page shows them as
 *   text (Txt), never as markup.
 * - `desktop_update` {install} only while an update is known (available, or a failure the shell says may be tried
 *   again: `retry`, review d M2 — never a dead Install and Restart); `later` any time (it also acknowledges a failure).
 *   At most UPDATE_CLICKS_PER_MIN clicks a minute. Never nudges the job watch (NO_NUDGE).
 */
import { z } from 'zod';
import { EngineError } from '@retake/engine';
import type { ToolDef } from '@retake/mcp';
import type { DesktopPipe } from './desktop.js';

export const UPDATE_STATES = ['off', 'idle', 'checking', 'available', 'downloading', 'waiting', 'installing', 'failed'] as const;
export type UpdateStateName = (typeof UPDATE_STATES)[number];
/** Why the app does not update itself (update_flow Off::wire). */
export const UPDATE_OFF_REASONS = ['build', 'disabled', 'translocated', 'read_only'] as const;
/** What went wrong (update_flow Failure::wire). */
export const UPDATE_FAILURES = ['check', 'download', 'install', 'not_writable'] as const;
/** The sheet's clicks (pipe.rs UpdateAction). */
export const UPDATE_ACTIONS = ['install', 'later'] as const;
/** The longest notes the shell sends (update_flow NOTES_MAX), plus its "…". */
export const UPDATE_NOTES_MAX = 2000;
export const UPDATE_CLICKS_PER_MIN = 20;
export const UPDATE_OPS = ['desktop_update_status', 'desktop_update'] as const;

/** update_flow version_ok: major.minor.patch, an optional pre-release, at most 64 characters. */
export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const versionOk = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && VERSION_RE.test(v);
const bytesOk = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const checkedOk = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
// eslint-disable-next-line no-control-regex
const BAD_NOTE_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

export type UpdateLine =
  | { type: 'update'; state: 'off'; current: string; reason: (typeof UPDATE_OFF_REASONS)[number] }
  | { type: 'update'; state: 'idle'; current: string; checked: number | null }
  | { type: 'update'; state: 'checking'; current: string }
  | { type: 'update'; state: 'available'; current: string; version: string; notes: string; checked: number | null }
  | { type: 'update'; state: 'downloading'; current: string; version: string; received: number; total: number | null }
  | { type: 'update'; state: 'installing'; current: string; version: string }
  | { type: 'update'; state: 'waiting'; current: string; version: string; jobs: number }
  | { type: 'update'; state: 'failed'; current: string; failure: (typeof UPDATE_FAILURES)[number]; version: string | null; checked: number | null; retry: boolean };

/** The keys of each state's line, sorted (update_flow state_line writes exactly these). */
const KEYS: Record<UpdateStateName, string> = {
  off: 'current,reason,state,type',
  idle: 'checked,current,state,type',
  checking: 'current,state,type',
  available: 'checked,current,notes,state,type,version',
  downloading: 'current,received,state,total,type,version',
  installing: 'current,state,type,version',
  waiting: 'current,jobs,state,type,version',
  failed: 'checked,current,failure,retry,state,type,version',
};

/** One update line of the shell (a parsed JSON object with `type: 'update'`), or null for anything but its exact shapes. */
export function parseUpdateLine(o: Record<string, unknown>): UpdateLine | null {
  const state = o.state as UpdateStateName;
  if (o.type !== 'update' || !(UPDATE_STATES as readonly string[]).includes(state as string)) return null;
  if (Object.keys(o).sort().join(',') !== KEYS[state] || !versionOk(o.current)) return null;
  const current = o.current;
  switch (state) {
    case 'off':
      return (UPDATE_OFF_REASONS as readonly unknown[]).includes(o.reason) ? { type: 'update', state, current, reason: o.reason as (typeof UPDATE_OFF_REASONS)[number] } : null;
    case 'idle':
      return checkedOk(o.checked) ? { type: 'update', state, current, checked: o.checked } : null;
    case 'checking':
      return { type: 'update', state, current };
    case 'available':
      if (!versionOk(o.version) || !checkedOk(o.checked) || typeof o.notes !== 'string' || [...o.notes].length > UPDATE_NOTES_MAX + 1 || BAD_NOTE_CHARS.test(o.notes)) return null;
      return { type: 'update', state, current, version: o.version, notes: o.notes, checked: o.checked };
    case 'downloading':
      // BL-167: the bytes received so far, of the size the server announced (null: none).
      return versionOk(o.version) && bytesOk(o.received) && (o.total === null || (bytesOk(o.total) && o.total > 0)) ? { type: 'update', state, current, version: o.version, received: o.received, total: o.total as number | null } : null;
    case 'installing':
      return versionOk(o.version) ? { type: 'update', state, current, version: o.version } : null;
    case 'waiting':
      return versionOk(o.version) && typeof o.jobs === 'number' && Number.isInteger(o.jobs) && o.jobs >= 1 && o.jobs <= 1_000_000 ? { type: 'update', state, current, version: o.version, jobs: o.jobs } : null;
    case 'failed':
      if (!(UPDATE_FAILURES as readonly unknown[]).includes(o.failure) || !(o.version === null || versionOk(o.version)) || !checkedOk(o.checked) || typeof o.retry !== 'boolean' || (o.retry && o.version === null)) return null;
      return { type: 'update', state, current, failure: o.failure as (typeof UPDATE_FAILURES)[number], version: o.version as string | null, checked: o.checked, retry: o.retry };
  }
}

/** What the server keeps: the shell's last update line, and the clicks' cap. */
export class UpdateState {
  last: UpdateLine | undefined;
  private window = { start: 0, count: 0 };

  constructor(readonly now: () => number = Date.now) {}

  apply(l: UpdateLine): void {
    this.last = l;
  }

  /** One click more this minute: false past the cap. */
  take(): boolean {
    const t = this.now();
    if (t - this.window.start >= 60_000) this.window = { start: t, count: 0 };
    if (this.window.count >= UPDATE_CLICKS_PER_MIN) return false;
    this.window.count++;
    return true;
  }
}

/** An update is known: Install and Restart may be clicked (available, or a failure the shell may try again). */
export function installable(l: UpdateLine | undefined): boolean {
  return !!l && (l.state === 'available' || (l.state === 'failed' && l.version !== null && l.retry && (l.failure === 'download' || l.failure === 'install')));
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** The Studio's update ops on `pipe` (the shell's pipe) and `state` (its last line). */
export function updateOps(o: { pipe: DesktopPipe; state: UpdateState }): ToolDef[] {
  const { pipe, state } = o;
  const status: ToolDef = {
    name: 'desktop_update_status',
    title: 'Updates of the desktop app',
    description: "The desktop app's update: off, up to date, available (its version and notes), downloading, waiting for jobs, installing, failed. The desktop app's own server only.",
    input: z.strictObject({}),
    annotations: READ,
    async run() {
      if (!pipe.supervised) return { summary: 'updates: not the desktop app\'s server', data: { available: false, reason: 'not_supervised' } };
      const l = state.last;
      if (!l) return { summary: 'updates: nothing said yet', data: { available: true, state: 'unknown' } };
      const { type: _t, ...fields } = l;
      void _t;
      if (l.state === 'available') {
        const { notes, ...rest } = fields as typeof fields & { notes: string };
        return { summary: `updates: ${l.version} available`, data: { available: true, ...rest, installable: true, untrusted: { notes } } };
      }
      return { summary: `updates: ${l.state}`, data: { available: true, ...fields, installable: installable(l) } };
    },
  };
  const ClickInput = z.strictObject({ action: z.enum(UPDATE_ACTIONS).describe('install: Install and Restart; later: not now (stops waiting for jobs).') });
  const click: ToolDef<typeof ClickInput> = {
    name: 'desktop_update',
    title: 'Install the update, or later',
    description: "Install and Restart (the desktop app downloads and checks the update, waits for this workspace's jobs, asks about unsaved text, then restarts) or Later. The desktop app's own server only; the person's click.",
    input: ClickInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(a) {
      if (!pipe.supervised) throw new EngineError('conflict', 'this Studio server is not the desktop app\'s (not supervised): there is no update to install here', { details: { reason: 'not_supervised' } });
      if (a.action === 'install' && !installable(state.last)) throw new EngineError('conflict', 'no update to install (the app has not found one): Help › Check for Updates…', { details: { reason: 'no_update' } });
      if (!state.take()) throw new EngineError('busy', `too many update clicks this minute (at most ${UPDATE_CLICKS_PER_MIN}): wait a moment`, { details: { reason: 'rate' } });
      pipe.update(a.action);
      return { summary: a.action === 'install' ? 'install asked' : 'later', data: { ok: true } };
    },
  };
  return [status, click as unknown as ToolDef];
}
