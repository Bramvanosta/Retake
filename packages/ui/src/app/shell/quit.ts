/**
 * L5.12d: the desktop app's quit question in the window's page (DESIGN §4j). The shell asks with one `studio:quit`
 * event (apps/desktop/core guard_flow `page_quit_js`: its words from the shell's word tables, as data, and a fresh id);
 * the page's kit Sheet acks it through `desktop_answer {id, shown: true}` once it is on screen and sends the person's
 * answer; `studio:quit-close {id}` closes it (the shell went to its native alert, the server went away, a signal…).
 * The detail is checked here, whole: exactly QUIT_DETAIL_KEYS (a static test compares them with the Rust list), the
 * id's shape, two buttons, indexes in range — anything else is ignored (no sheet, no ack: the shell's native alert
 * comes after 1.5 s).
 */
import type { SheetAction } from '../ui-kit/index.js';

export const QUIT_EVENT = 'studio:quit';
export const QUIT_CLOSE_EVENT = 'studio:quit-close';
/** The detail's keys, in the shell's order (guard_flow.rs QUIT_DETAIL_KEYS). */
export const QUIT_DETAIL_KEYS = ['id', 'action', 'title', 'text', 'buttons', 'proceed', 'cancel', 'destructive'] as const;
/** The question's id (guard_flow.rs `id_ok`; the server's QUIT_ID_RE). */
export const QUIT_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/**
 * The longest title or text taken (UTF-16 units: `.length`) — the shell's own bound (guard_flow.rs QUIT_TEXT_MAX,
 * compared by a static test), which the longest question of words.rs fits (review A-L1 / B-L1).
 */
export const QUIT_TEXT_MAX = 4000;
/** The longest button label taken (guard_flow.rs QUIT_LABEL_MAX). */
export const QUIT_LABEL_MAX = 100;

export interface QuitQuestion {
  id: string;
  title: string;
  text: string;
  buttons: [string, string];
  /** The index of the button that quits. */
  proceed: 0 | 1;
  /** The index of the button that keeps everything as it is. */
  cancel: 0 | 1;
  /** Quitting loses unsaved text: the proceed button is destructive, never the default. */
  destructive: boolean;
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** The question of a `studio:quit` detail, or null for anything but the exact shape the shell sends. */
export function parseQuitDetail(d: unknown): QuitQuestion | null {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const o = d as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== QUIT_DETAIL_KEYS.length || !QUIT_DETAIL_KEYS.every((k) => keys.includes(k))) return null;
  const { id, action, title, text, buttons, proceed, cancel, destructive } = o;
  if (typeof id !== 'string' || !QUIT_ID_RE.test(id) || action !== 'quit') return null;
  if (!str(title, QUIT_TEXT_MAX) || !str(text, QUIT_TEXT_MAX)) return null;
  if (!Array.isArray(buttons) || buttons.length !== 2 || !buttons.every((b) => str(b, QUIT_LABEL_MAX))) return null;
  if ((proceed !== 0 && proceed !== 1) || (cancel !== 0 && cancel !== 1) || proceed === cancel || typeof destructive !== 'boolean') return null;
  return { id, title, text, buttons: [buttons[0] as string, buttons[1] as string], proceed, cancel, destructive };
}

/**
 * The sheet's actions, left to right as the native alert shows them (review B-M1): the alert's first button — its
 * default, Return — is the rightmost, as the kit's other sheets place their primary action. So unsaved text reads
 * [Quit Anyway (destructive, no key)] [Cancel ●] and jobs only [Cancel] [Quit Anyway ●]; the cancel button takes
 * Escape, and a destructive proceed is never the default (the kit's rule; Return on it chooses the default: Sheet).
 */
export function quitActions(q: QuitQuestion): SheetAction[] {
  return q.buttons
    .map((label, i): SheetAction => {
      const proceed = i === q.proceed;
      return {
        id: proceed ? 'proceed' : 'cancel',
        label,
        variant: proceed && q.destructive ? 'destructive' : i === 0 ? 'primary' : 'secondary',
        ...(i === 0 ? { isDefault: true } : {}),
        ...(i === q.cancel ? { isCancel: true } : {}),
        testId: proceed ? 'quit-proceed' : 'quit-cancel',
      };
    })
    .reverse();
}
