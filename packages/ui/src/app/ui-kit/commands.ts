/**
 * L5.9: the page's commands that the desktop app's menu may send (`studio:command`, DESIGN §4j) — ONE list, compared
 * with the menu table of apps/desktop/src/menu.rs by a static test. The shell listens for them and accepts these ids
 * only; while a modal dialog is open it ignores them (critique M5), but the palette's own ⌘K closes the palette. In a
 * browser tab the page binds ⌘K itself on a Mac, Ctrl+K elsewhere outside a text field (⌘R, ⌘1 – 4, ⌥⌘I stay the
 * browser's); in the app (`__studioShell`) it binds
 * none of them: the menu's accelerators send the commands, so a key never acts twice. L5.11a: the Scenario menu's
 * Rehearse, Capture, Render and Stop (⌘R, ⇧⌘R, ⌘B, ⌘. in the app; never bound in a browser tab, where the palette
 * offers them) go through the shell's command bus (shell/command-bus.ts) to whoever owns them.
 */
export const MENU_COMMANDS = ['palette', 'mode-script', 'mode-shoot', 'mode-edit', 'mode-review', 'inspector', 'rehearse', 'capture', 'render', 'stop'] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number];

export const COMMAND_EVENT = 'studio:command';

export function isMenuCommand(id: unknown): id is MenuCommand {
  return typeof id === 'string' && (MENU_COMMANDS as readonly string[]).includes(id);
}

/** What the desktop shell declares about itself (a main-frame init script: menu.rs SHELL_FLAG_JS), or null in a browser tab. */
export interface StudioShellFlag {
  titleBar: 'overlay' | 'standard';
}

export function studioShell(): StudioShellFlag | null {
  const v = (window as unknown as { __studioShell?: unknown }).__studioShell;
  if (!v || typeof v !== 'object') return null;
  const t = (v as { titleBar?: unknown }).titleBar;
  return { titleBar: t === 'overlay' ? 'overlay' : 'standard' };
}

/** A modal dialog is open (a sheet, a confirmation, the palette): the shell's commands wait. */
export function modalOpen(): boolean {
  return document.querySelector('dialog:modal') !== null;
}
