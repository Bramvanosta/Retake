/**
 * The window page's word to the desktop shell (L5.12d, DESIGN §4j): the shell asks the quit question in its window's
 * page (`studio:quit`, a fresh id), the page's sheet answers through the own op `desktop_answer`, and the server writes
 * one pipe line the shell reads (supervise.ts frames it): `{"type":"shown","id","shown":true}` once the sheet is on
 * screen, `{"type":"answer","id","answer":"proceed"|"cancel"}` when the person answers. The shell takes them only for
 * the question it asked (desktop_core guard_flow: the id, once); everything else is ignored there.
 *
 * - Studio only: an own op (OWN_OPS, the `ui` client's allow-list), never an MCP tool (a page is never Claude, and
 *   Claude never answers the person's quit question).
 * - Strict input: the id's shape and one of the two forms, nothing else (an extra field is a 400) — no text of the page
 *   reaches the pipe; nothing is echoed back.
 * - Supervised only (`retake ui --supervised`, owned by the shell): any other server answers 409 (reason
 *   `not_supervised`) — there is no pipe to write on.
 * - `shown` lines: at most SHOWN_PER_MIN a minute (a page looping on acks cannot flood the pipe); an `answer` is never
 *   capped nor dropped (it is the person's).
 * - Not read-only (a line is written) but never nudges the job watch (studio.ts NO_NUDGE, like unsaved_report).
 * - Honest (review B-L6): once the supervisor has stopped (the server is closing) no line can be written — the op
 *   answers `unavailable` (503, reason `stopped`), never "answered"; the page's sheet says the answer did not arrive.
 */
import { z } from 'zod';
import { EngineError } from '@retake/engine';
import type { ToolDef } from '@retake/engine/contract';
import { parseUpdateLine } from './update-ops.js';
import type { UpdateLine } from './update-ops.js';

/** The quit question's id (desktop_core guard_flow `id_ok`): 22 base64url characters. */
export const QUIT_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** `shown` lines a minute at most. */
export const SHOWN_PER_MIN = 20;

const id = z.string().regex(QUIT_ID_RE, 'the question id (22 base64url characters)');
export const DesktopAnswerInput = z.union([
  z.strictObject({ id, shown: z.literal(true).describe('The sheet is on screen (open, painted, the window visible).') }),
  z.strictObject({ id, answer: z.enum(['proceed', 'cancel']).describe('Quit Anyway (proceed) or Cancel.') }),
]);

/** L5.16c: what the server may ask the shell to do for the Set-up sheet (desktop_core pipe.rs SetupAction). */
export const SETUP_ACTIONS = ['notifications', 'cli_folder'] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];

/** The longest line the shell writes on the server's stdin (bytes). */
export const SHELL_LINE_MAX = 8192;

/** A line the desktop shell wrote on the supervised server's stdin (L5.16c; L5.16d: the update's state). */
export type ShellLine = { type: 'cli_folder'; path: string } | { type: 'cli_folder_open' } | { type: 'cli_folder_cancelled' } | { type: 'notifications'; state: 'on' | 'off' | 'unknown' } | UpdateLine;

/**
 * One line of the shell on stdin, or null for anything but its exact shapes: `{"type":"cli_folder_open"}` (its native
 * folder panel is up: review c A-L7 — the sheet says "choose in the panel" only then), `{"type":"cli_folder","path":
 * <absolute>}` (the folder the person picked there), `{"type":"cli_folder_cancelled"}` (none: cancelled, or the panel
 * could not open while another question was up), `{"type":"notifications","state":"on"|"off"|"unknown"}`. Strict: no
 * other field, a path absolute, one line, no NUL, at most 4096 characters; the line at most SHELL_LINE_MAX bytes (UTF-8).
 * L5.16d: `{"type":"update","state":…}` — the update's state (update-ops.ts parseUpdateLine: fixed keys per state).
 */
export function parseShellLine(line: string): ShellLine | null {
  if (Buffer.byteLength(line, 'utf8') > SHELL_LINE_MAX) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (o.type === 'cli_folder' && keys === 'path,type' && typeof o.path === 'string' && o.path.startsWith('/') && o.path.length <= 4096 && !/[\0\n\r]/.test(o.path)) return { type: 'cli_folder', path: o.path };
  if (o.type === 'cli_folder_open' && keys === 'type') return { type: 'cli_folder_open' };
  if (o.type === 'cli_folder_cancelled' && keys === 'type') return { type: 'cli_folder_cancelled' };
  if (o.type === 'notifications' && keys === 'state,type' && (o.state === 'on' || o.state === 'off' || o.state === 'unknown')) return { type: 'notifications', state: o.state };
  if (o.type === 'update') return parseUpdateLine(o);
  return null;
}

/** The pipe of a supervised server (set by startSupervisor); none otherwise. */
export class DesktopPipe {
  private write: ((line: string) => boolean) | undefined;
  private window = { start: 0, count: 0 };
  /** Lines written: tests. */
  written = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** The supervisor's framed line writer (`retake ui --supervised`): false once it has stopped (nothing written). */
  attach(write: (line: string) => boolean): void {
    this.write = write;
  }

  get supervised(): boolean {
    return this.write !== undefined;
  }

  /** The page shows question `id`; false when the minute's cap is reached (nothing written). */
  shown(qid: string): boolean {
    const w = this.need();
    const t = this.now();
    if (t - this.window.start >= 60_000) this.window = { start: t, count: 0 };
    if (this.window.count >= SHOWN_PER_MIN) return false;
    this.send(w, JSON.stringify({ type: 'shown', id: qid, shown: true }));
    this.window.count++;
    return true;
  }

  /** The person's answer to question `id` (never capped). */
  answer(qid: string, answer: 'proceed' | 'cancel'): void {
    this.send(this.need(), JSON.stringify({ type: 'answer', id: qid, answer }));
  }

  /**
   * L5.16c: a set-up request for the shell (setup-ops.ts) — `notifications` (ask macOS for the permission) or
   * `cli_folder` (show the native folder panel; the answer comes back on stdin: parseShellLine). Fixed shapes only.
   */
  setup(action: SetupAction): void {
    this.send(this.need(), JSON.stringify({ type: 'setup', action }));
  }

  /** L5.16d: the update sheet's click for the shell (update-ops.ts `desktop_update`): Install and Restart, or Later. */
  update(action: 'install' | 'later'): void {
    this.send(this.need(), JSON.stringify({ type: 'update', action }));
  }

  private send(w: (line: string) => boolean, line: string): void {
    if (!w(line)) throw new EngineError('unavailable', 'the desktop app\'s pipe is closed (this Studio server is stopping): the answer was not sent', { details: { reason: 'stopped' } });
    this.written++;
  }

  private need(): (line: string) => boolean {
    if (!this.write) throw new EngineError('conflict', 'this Studio server is not the desktop app\'s (not supervised): there is no question to answer', { details: { reason: 'not_supervised' } });
    return this.write;
  }
}

/** The own op `desktop_answer` on `pipe`. */
export function desktopOps(pipe: DesktopPipe): ToolDef[] {
  const op: ToolDef<typeof DesktopAnswerInput> = {
    name: 'desktop_answer',
    title: 'Answer the desktop app',
    description: "The window's quit question: shown (the sheet is on screen) or the person's answer. The desktop app's own server only.",
    input: DesktopAnswerInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(a) {
      if ('answer' in a) {
        pipe.answer(a.id, a.answer);
        return { summary: 'answered', data: { ok: true } };
      }
      const sent = pipe.shown(a.id);
      return { summary: sent ? 'shown' : 'shown (not sent: too many this minute)', data: { ok: true } };
    },
  };
  return [op as unknown as ToolDef];
}

export const DESKTOP_OPS = ['desktop_answer'] as const;
