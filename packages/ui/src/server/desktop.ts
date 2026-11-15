/**
 * The window page's word to the desktop shell (DESIGN §4j): the shell asks the quit question in its window's
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
 * - `desktop_menu`: the window page's state of the menu's page commands — each id (a command id's shape: the shell
 *   applies the ids its menu holds), enabled, checked (a check item: the mode or view shown), variant (0 / 1: which of a
 *   toggle's two fixed labels) — one `{"type":"menu","items":[…]}` line (desktop_core pipe.rs reads it strictly). No
 *   text of the page reaches the menu. At most MENU_PER_MIN lines a minute (the page sends a state when it changes).
 *   Its second form, `{popup}`: the page asks for one of the shell's context menus by id (CONTEXT_MENU_IDS — the
 *   shell's table holds the items and their labels) — one `{"type":"context","menu":…}` line, at most POPUP_PER_MIN a
 *   minute (its own cap: a looping page starves neither the other). The shell shows it only right after a real
 *   secondary click in its window (its gate), so a page asking without one gets nothing on screen.
 * - `cli` lines (`DesktopPipe.cli`): the server's word on the `retake` command's link (setup-status.ts cliMenuState,
 *   read from the disk — never a value of the page's), written when it changed since the last one; the shell's Help
 *   items follow it. The page can only make the server read the disk again (setup_status, install, remove).
 * - Honest: once the supervisor has stopped (the server is closing) no line can be written — the op
 *   answers `unavailable` (503, reason `stopped`), never "answered"; the page's sheet says the answer did not arrive.
 */
import { z } from 'zod';
import { EngineError } from '@retake/engine';
import { defineTool } from '@retake/engine/contract';

/** The quit question's id (desktop_core guard_flow `id_ok`): 22 base64url characters. */
export const QUIT_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** `shown` lines a minute at most. */
export const SHOWN_PER_MIN = 20;

const id = z.string().regex(QUIT_ID_RE, 'the question id (22 base64url characters)');
export const DesktopAnswerInput = z.union([
  z.strictObject({ id, shown: z.literal(true).describe('The sheet is on screen (open, painted, the window visible).') }),
  z.strictObject({ id, answer: z.enum(['proceed', 'cancel']).describe('Quit Anyway (proceed) or Cancel.') }),
]);

/** Menu lines a minute at most (the page sends a state only when it changed). */
export const MENU_PER_MIN = 240;
/** A page command id's shape (desktop_core `menu_id_ok`). */
export const MENU_ID_RE = /^[a-z](?:[a-z-]{0,30}[a-z])?$/;
/** Items of one state at most (desktop_core MENU_ITEMS_MAX). */
export const MENU_ITEMS_MAX = 64;

/** Context-menu requests a minute at most. */
export const POPUP_PER_MIN = 30;
/** The shell's context menus (apps/desktop menu.rs CONTEXT_MENUS; a static test compares them). */
export const CONTEXT_MENU_IDS = ['scenario'] as const;
/** The `retake` command's link as the server reads it (desktop_core pipe.rs CliState). */
export const CLI_STATES = ['absent', 'ours', 'other_app', 'foreign'] as const;
export type CliState = (typeof CLI_STATES)[number];

const menuItem = z.strictObject({
  id: z.string().regex(MENU_ID_RE, "a page command's id"),
  enabled: z.boolean(),
  checked: z.boolean().optional().describe('A check item (the mode or view shown): checked.'),
  variant: z
    .union([z.literal(0), z.literal(1)])
    .optional()
    .describe('A toggle: which of its two fixed labels (Show / Hide).'),
});
export const DesktopMenuInput = z.union([
  z.strictObject({
    items: z
      .array(menuItem)
      .max(MENU_ITEMS_MAX)
      .refine((xs) => new Set(xs.map((x) => x.id)).size === xs.length, 'each id once'),
  }),
  z.strictObject({ popup: z.enum(CONTEXT_MENU_IDS).describe("One of the shell's context menus (shown only right after a right-click in the app's window).") }),
]);
export type MenuItemState = z.infer<typeof menuItem>;

/** What the server may ask the shell to do for the Set-up sheet (desktop_core pipe.rs SetupAction). */
export const SETUP_ACTIONS = ['notifications', 'cli_folder'] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];

/** The pipe of a supervised server (set by startSupervisor); none otherwise. */
export class DesktopPipe {
  private write: ((line: string) => boolean) | undefined;
  private window = { start: 0, count: 0 };
  private menuWindow = { start: 0, count: 0 };
  private popupWindow = { start: 0, count: 0 };
  /** The last cli state written (only a change is written again). */
  private cliSent: CliState | undefined;
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
   * A set-up request for the shell (setup-ops.ts) — `notifications` (ask macOS for the permission) or
   * `cli_folder` (show the native folder panel; the answer comes back on stdin: shell-line.ts parseShellLine). Fixed
   * shapes only.
   */
  setup(action: SetupAction): void {
    this.send(this.need(), JSON.stringify({ type: 'setup', action }));
  }

  /** The page's state of the menu's page commands; false when the minute's cap is reached (nothing written). */
  menu(items: readonly MenuItemState[]): boolean {
    const w = this.need();
    const t = this.now();
    if (t - this.menuWindow.start >= 60_000) this.menuWindow = { start: t, count: 0 };
    if (this.menuWindow.count >= MENU_PER_MIN) return false;
    const line = items.map((i) => ({ id: i.id, enabled: i.enabled, ...(i.checked !== undefined ? { checked: i.checked } : {}), ...(i.variant !== undefined ? { variant: i.variant } : {}) }));
    this.send(w, JSON.stringify({ type: 'menu', items: line }));
    this.menuWindow.count++;
    return true;
  }

  /** The page asks for context menu `menu`; false when the minute's cap is reached (nothing written). */
  context(menu: (typeof CONTEXT_MENU_IDS)[number]): boolean {
    const w = this.need();
    const t = this.now();
    if (t - this.popupWindow.start >= 60_000) this.popupWindow = { start: t, count: 0 };
    if (this.popupWindow.count >= POPUP_PER_MIN) return false;
    this.send(w, JSON.stringify({ type: 'context', menu }));
    this.popupWindow.count++;
    return true;
  }

  /** The command's link as read now (setup-status.ts cliMenuState): written when it changed; true when written. */
  cli(state: CliState): boolean {
    const w = this.need();
    if (state === this.cliSent) return false;
    this.send(w, JSON.stringify({ type: 'cli', state }));
    this.cliSent = state;
    return true;
  }

  /** The update sheet's click for the shell (update-ops.ts `desktop_update`): Install and Restart, or Later. */
  update(action: 'install' | 'later'): void {
    this.send(this.need(), JSON.stringify({ type: 'update', action }));
  }

  private send(w: (line: string) => boolean, line: string): void {
    if (!w(line)) throw new EngineError('unavailable', "the desktop app's pipe is closed (this Studio server is stopping): the answer was not sent", { details: { reason: 'stopped' } });
    this.written++;
  }

  private need(): (line: string) => boolean {
    if (!this.write) throw new EngineError('conflict', "this Studio server is not the desktop app's (not supervised): there is no question to answer", { details: { reason: 'not_supervised' } });
    return this.write;
  }
}

/** The own ops `desktop_answer` and `desktop_menu` on `pipe`. */
export function desktopOps(pipe: DesktopPipe) {
  const op = defineTool({
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
  });
  const menu = defineTool({
    name: 'desktop_menu',
    title: "The desktop app's menu",
    description:
      "The window page's state of the menu's page commands (enabled, checked, a toggle's label), or a request for one of the app's context menus (`popup`). The desktop app's own server only.",
    input: DesktopMenuInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(a) {
      if ('popup' in a) {
        const sent = pipe.context(a.popup);
        return { summary: sent ? 'context menu asked' : 'context menu not asked: too many this minute', data: { ok: true, sent } };
      }
      const sent = pipe.menu(a.items);
      return { summary: sent ? 'menu state sent' : 'menu state not sent: too many this minute', data: { ok: true, sent } };
    },
  });
  return [op, menu];
}

export const DESKTOP_OPS = ['desktop_answer', 'desktop_menu'] as const;
