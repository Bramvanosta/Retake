/**
 * Native context menus in the desktop app (DESIGN §4j). In the app's window (`__studioShell`) the page:
 * - suppresses WebKit's own menu outside text (one `window` listener, capture phase: a component's stopPropagation
 *   cannot skip it) — no Reload (WKWebView never asks before leaving unsaved text), no Open Link in New Window. Text keeps
 *   WebKit's menu (Copy, Look Up, Spelling): a text field (`textarea`, a text-like `input`, a contenteditable surface such
 *   as the YAML editor's) or a right-click over the text selection itself. A debug build lets ⌥-right-click through
 *   (Inspect Element; the flag's `inspect`);
 * - asks the shell for one of its context menus by id (`desktop_menu` {popup}) — only from a right-click this listener
 *   prevented (never inside WebKit's own menu), and only an id of ui-kit CONTEXT_MENUS: the shell holds the items and
 *   their labels, and shows the menu only right after a real secondary click in its window (its gate). The page keeps
 *   what was right-clicked (a scenario) for one command, at most TARGET_MS; a pick comes back as a `studio:command` with
 *   the menu's id (menu-commands.ts runs it on that target, never on the scenario in context).
 * In a browser tab the browser keeps its own menu and nothing is asked; a right-click there still selects the poster (as
 * Finder does), and the palette's Keyboard shortcuts is there too. VoiceOver's "show menu" (a `contextmenu` with no
 * mouse click) gets no native menu (the shell's gate refuses it): every item is reachable from the poster's own keys and
 * the menu bar. Where the Studio's script is not running (an error page, a blank window) WebKit's menu stays.
 */
import { desktopMenu } from '../data/desktop.js';
import { bestEffort } from '../best-effort.js';
import { studioShell } from '../ui-kit/index.js';
import type { ContextMenu } from '../ui-kit/index.js';
import type { ScenarioContext } from './modes.js';

/** How long a right-clicked target waits for the menu's pick. */
export const TARGET_MS = 60_000;

/** `input` types that take typed text (their menu is WebKit's: Copy, Paste, Spelling). */
const TEXT_INPUTS = new Set(['', 'text', 'search', 'url', 'email', 'tel', 'password', 'number']);

/** A text field: a textarea, a text-like input, or a contenteditable surface (CodeMirror's). */
export function textTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if (t instanceof HTMLTextAreaElement) return true;
  if (t instanceof HTMLInputElement) return TEXT_INPUTS.has(t.getAttribute('type')?.toLowerCase() ?? '');
  return t instanceof HTMLElement && t.isContentEditable;
}

/**
 * The right-click is on the selected text itself: the point inside one of the selection's rectangles — not merely
 * inside an element that holds a selection (an ancestor's empty area), nor while some text elsewhere is selected.
 */
export function overSelection(x: number, y: number): boolean {
  const sel = typeof getSelection === 'function' ? getSelection() : null;
  if (!sel || sel.isCollapsed) return false;
  for (let i = 0; i < sel.rangeCount; i++) for (const r of sel.getRangeAt(i).getClientRects()) if (r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  return false;
}

/** WebKit's menu stays for this right-click. */
export function keepsWebKitMenu(e: Pick<MouseEvent, 'target' | 'altKey' | 'clientX' | 'clientY'>, inspect: boolean): boolean {
  return (inspect && e.altKey) || textTarget(e.target) || overSelection(e.clientX, e.clientY);
}

let held: { menu: ContextMenu; target: ScenarioContext; at: number } | null = null;

/** In the app's window: suppress WebKit's menu outside text (returns the removal; nothing in a browser tab). */
export function installContextMenus(): () => void {
  const flag = studioShell();
  if (!flag) return () => undefined;
  const onMenu = (e: MouseEvent) => {
    // Every right-click forgets the last target: only the one this very event sets (a poster's handler, after this
    // capture phase) may receive a pick — never an earlier poster's under a later menu.
    held = null;
    if (!keepsWebKitMenu(e, flag.inspect)) e.preventDefault();
  };
  window.addEventListener('contextmenu', onMenu, true);
  return () => window.removeEventListener('contextmenu', onMenu, true);
}

/**
 * A right-click on `target` asks the shell for context menu `menu` — only when the shell's listener prevented
 * WebKit's menu for this very event (in the app, outside text). Only the menu's id goes out.
 */
export function requestContextMenu(menu: ContextMenu, target: ScenarioContext, e: { defaultPrevented: boolean }): void {
  if (!e.defaultPrevented || !studioShell()) return;
  held = { menu, target: { slug: target.slug, scenario: target.scenario }, at: Date.now() };
  void bestEffort(desktopMenu({ popup: menu }), 'a context menu not asked: nothing shows');
}

/** The target a pick of `menu` acts on — once, while fresh (`now`: the clock, tests); null otherwise (the pick then does nothing). */
export function takeContextTarget(menu: ContextMenu, now: number = Date.now()): ScenarioContext | null {
  const h = held;
  held = null;
  if (!h || h.menu !== menu || now - h.at > TARGET_MS) return null;
  return h.target;
}
