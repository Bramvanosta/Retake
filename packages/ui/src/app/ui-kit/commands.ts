/**
 * The page's commands that the desktop app's menu may send (`studio:command`, DESIGN §4j) — ONE registry, COMMANDS:
 * each command's id, its menu, its label, its key (a Tauri accelerator) and its kind, in the menu bar's order. A static
 * test compares it item by item with the menu table of apps/desktop/src/menu.rs (the native truth: the page has no IPC,
 * so the shell keeps its own copy and the test keeps them equal); every key cap the page shows is derived from it
 * (`commandKeys`, `keyCaps`: no literal cap outside this file — a lint). The shell listens for the commands and accepts
 * these ids only; while a modal dialog is open it ignores them, but the palette's own ⌘K closes the palette. In a
 * browser tab the page binds ⌘K itself on a Mac, Ctrl+K elsewhere outside a text field (⌘R, ⌘1 – 4, ⌥⌘I stay the
 * browser's); in the app (`__studioShell`) it binds none of them: the menu's accelerators send the commands, so a key
 * never acts twice. The Scenario menu's Rehearse, Capture, Render and Stop (⌘R, ⇧⌘R, ⌘B, ⌘. in the app; never bound
 * in a browser tab, where the palette offers them) go through the shell's command bus (shell/command-bus.ts) to
 * whoever owns them. SHELL_KEYS: the shell's own keyed items (compared with menu.rs too); STD_KEYS: macOS's standard
 * items that have a key (pinned against menu.rs's Std items); PAGE_KEYS: the keys the page
 * binds itself (in text and on the board — never the menu's). CONTEXT_MENUS: the context menus the page may ask the
 * shell for (`desktop_menu` {popup}), each a list of COMMANDS ids (compared with menu.rs CONTEXT_MENUS).
 */
export type CommandMenu = 'File' | 'View' | 'Go' | 'Scenario' | 'Help';

export interface CommandSpec {
  id: string;
  menu: CommandMenu;
  /** The menu's label (Title Case, as macOS menus write it). */
  label: string;
  /** Its key, a Tauri accelerator (`Shift+CmdOrCtrl+R`), if any. */
  key?: string;
  /** A check item (the mode or view shown), or a toggle with two fixed labels (`alt`: the second). */
  kind?: 'check' | 'toggle';
  alt?: string;
}

export const COMMANDS = [
  { id: 'new-scenario', menu: 'File', label: 'New Scenario…', key: 'CmdOrCtrl+N' },
  { id: 'palette', menu: 'View', label: 'Command Palette…', key: 'CmdOrCtrl+K' },
  { id: 'mode-script', menu: 'View', label: 'Script', key: 'CmdOrCtrl+1', kind: 'check' },
  { id: 'mode-shoot', menu: 'View', label: 'Shoot', key: 'CmdOrCtrl+2', kind: 'check' },
  { id: 'mode-edit', menu: 'View', label: 'Edit', key: 'CmdOrCtrl+3', kind: 'check' },
  { id: 'mode-review', menu: 'View', label: 'Review', key: 'CmdOrCtrl+4', kind: 'check' },
  { id: 'view-board', menu: 'View', label: 'Board', key: 'Alt+CmdOrCtrl+1', kind: 'check' },
  { id: 'view-hooks', menu: 'View', label: 'Hooks', key: 'Alt+CmdOrCtrl+2', kind: 'check' },
  { id: 'view-yaml', menu: 'View', label: 'YAML', key: 'Alt+CmdOrCtrl+3', kind: 'check' },
  { id: 'inspector', menu: 'View', label: 'Show Inspector', key: 'Alt+CmdOrCtrl+I', kind: 'toggle', alt: 'Hide Inspector' },
  { id: 'go-back', menu: 'Go', label: 'Back', key: 'CmdOrCtrl+[' },
  { id: 'go-forward', menu: 'Go', label: 'Forward', key: 'CmdOrCtrl+]' },
  { id: 'go-welcome', menu: 'Go', label: 'Welcome', key: 'Shift+CmdOrCtrl+H' },
  { id: 'go-productions', menu: 'Go', label: 'Productions', key: 'Shift+CmdOrCtrl+P' },
  { id: 'go-cast', menu: 'Go', label: 'Locations and Cast' },
  { id: 'go-settings', menu: 'Go', label: 'Project Settings' },
  { id: 'go-readme', menu: 'Go', label: 'README' },
  { id: 'go-library', menu: 'Go', label: 'Components' },
  { id: 'go-themes', menu: 'Go', label: 'Themes' },
  { id: 'go-report', menu: 'Go', label: 'Review Report' },
  { id: 'go-comments', menu: 'Go', label: 'Comments' },
  { id: 'rehearse', menu: 'Scenario', label: 'Rehearse', key: 'CmdOrCtrl+R' },
  { id: 'capture', menu: 'Scenario', label: 'Capture', key: 'Shift+CmdOrCtrl+R' },
  { id: 'render', menu: 'Scenario', label: 'Render', key: 'CmdOrCtrl+B' },
  { id: 'stop', menu: 'Scenario', label: 'Stop', key: 'CmdOrCtrl+.' },
  { id: 'help-shortcuts', menu: 'Help', label: 'Keyboard Shortcuts' },
] as const satisfies readonly CommandSpec[];

export type MenuCommand = (typeof COMMANDS)[number]['id'];
/** Every command id, in the menu bar's order. */
export const MENU_COMMANDS: readonly MenuCommand[] = COMMANDS.map((c) => c.id);

/** The shell's own keyed items (menu.rs `Item::Cmd` with a key; `{app}`: the app's name) — for the shortcuts list. */
export const SHELL_KEYS = [
  { id: 'set-up', menu: 'App', label: 'Set Up {app}…', key: 'CmdOrCtrl+,' },
  { id: 'open-workspace', menu: 'File', label: 'Open Workspace…', key: 'CmdOrCtrl+O' },
  { id: 'show-window', menu: 'Window', label: 'Show Studio Window', key: 'CmdOrCtrl+0' },
] as const;

/**
 * macOS's standard items of the menu bar that have a key (menu.rs `Item::Std`, the platform's own; `{app}`: the app's
 * name) — for the shortcuts list. A static test pins them against the table's Std items, menu by menu.
 */
export const STD_KEYS = [
  { id: 'hide', std: 'Hide', menu: 'App', label: 'Hide {app}', key: 'CmdOrCtrl+H' },
  { id: 'hide-others', std: 'HideOthers', menu: 'App', label: 'Hide Others', key: 'Alt+CmdOrCtrl+H' },
  { id: 'quit', std: 'Quit', menu: 'App', label: 'Quit {app}', key: 'CmdOrCtrl+Q' },
  { id: 'close-window', std: 'CloseWindow', menu: 'File', label: 'Close Window', key: 'CmdOrCtrl+W' },
  { id: 'undo', std: 'Undo', menu: 'Edit', label: 'Undo', key: 'CmdOrCtrl+Z' },
  { id: 'redo', std: 'Redo', menu: 'Edit', label: 'Redo', key: 'Shift+CmdOrCtrl+Z' },
  { id: 'cut', std: 'Cut', menu: 'Edit', label: 'Cut', key: 'CmdOrCtrl+X' },
  { id: 'copy', std: 'Copy', menu: 'Edit', label: 'Copy', key: 'CmdOrCtrl+C' },
  { id: 'paste', std: 'Paste', menu: 'Edit', label: 'Paste', key: 'CmdOrCtrl+V' },
  { id: 'select-all', std: 'SelectAll', menu: 'Edit', label: 'Select All', key: 'CmdOrCtrl+A' },
  { id: 'full-screen', std: 'FullScreen', menu: 'View', label: 'Enter Full Screen', key: 'Ctrl+CmdOrCtrl+F' },
  { id: 'minimize', std: 'Minimize', menu: 'Window', label: 'Minimize', key: 'CmdOrCtrl+M' },
] as const;

/** The keys the page binds itself, in text and on the board (never in the menu: a key never acts twice). */
export const PAGE_KEYS = [
  { id: 'save', label: 'Save the YAML or the README', key: 'CmdOrCtrl+S' },
  { id: 'send', label: 'Send a comment', key: 'CmdOrCtrl+Enter' },
  { id: 'undo', label: 'Undo on the board and in Edit (outside a text field)', key: 'CmdOrCtrl+Z' },
  { id: 'redo', label: 'Redo on the board and in Edit (outside a text field)', key: 'Shift+CmdOrCtrl+Z' },
  { id: 'redo-y', label: 'Redo (the other key)', key: 'CmdOrCtrl+Y' },
] as const;

/** The context menus the page may ask the shell for (`desktop_menu` {popup}), each a list of COMMANDS ids. */
export const CONTEXT_MENUS = {
  scenario: ['mode-script', 'mode-shoot', 'mode-edit', 'mode-review', 'go-report', 'go-comments'],
} as const satisfies Record<string, readonly MenuCommand[]>;
export type ContextMenu = keyof typeof CONTEXT_MENUS;

const MODIFIERS: ReadonlyArray<[string, string]> = [
  ['Ctrl', '⌃'],
  ['Alt', '⌥'],
  ['Shift', '⇧'],
  ['CmdOrCtrl', '⌘'],
];
const KEY_NAMES: Readonly<Record<string, string>> = { Enter: '↩', Period: '.', Comma: ',' };

/** A Tauri accelerator as macOS key caps, modifiers in macOS's order ⌃⌥⇧⌘: `Shift+CmdOrCtrl+R` → ⇧ ⌘ R. */
export function keyCaps(accelerator: string): string[] {
  const parts = accelerator.split('+');
  // A `+` key itself would be the empty last part.
  const key = parts.pop() ?? '';
  const caps = MODIFIERS.filter(([m]) => parts.includes(m)).map(([, cap]) => cap);
  return [...caps, KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key)];
}

/** A command's menu label. */
export function commandLabel(id: MenuCommand): string {
  return COMMANDS.find((x) => x.id === id)!.label;
}

/** A command's key caps (none: no key). */
export function commandKeys(id: MenuCommand): string[] | undefined {
  const c: CommandSpec = COMMANDS.find((x) => x.id === id)!;
  return c.key ? keyCaps(c.key) : undefined;
}

/** A page key's caps (PAGE_KEYS). */
export function pageKeys(id: (typeof PAGE_KEYS)[number]['id']): string[] {
  return keyCaps(PAGE_KEYS.find((k) => k.id === id)!.key);
}

export const COMMAND_EVENT = 'studio:command';

export function isMenuCommand(id: unknown): id is MenuCommand {
  return typeof id === 'string' && (MENU_COMMANDS as readonly string[]).includes(id);
}

export function isContextMenu(id: unknown): id is ContextMenu {
  return typeof id === 'string' && Object.hasOwn(CONTEXT_MENUS, id);
}

/** What the desktop shell declares about itself (a main-frame init script: menu.rs SHELL_FLAG_JS), or null in a browser tab. */
export interface StudioShellFlag {
  titleBar: 'overlay' | 'standard';
  /** A debug build of the app (Inspect Element on ⌥-right-click). */
  inspect: boolean;
}

declare global {
  interface Window {
    /** The desktop shell's flag (menu.rs SHELL_FLAG_JS); unknown until checked: a page script could set anything. */
    __studioShell?: unknown;
  }
}

export function studioShell(): StudioShellFlag | null {
  const v = window.__studioShell;
  if (!v || typeof v !== 'object') return null;
  const t = 'titleBar' in v ? v.titleBar : undefined;
  return { titleBar: t === 'overlay' ? 'overlay' : 'standard', inspect: 'inspect' in v && v.inspect === true };
}

/** A modal dialog is open (a sheet, a confirmation, the palette): the shell's commands wait. */
export function modalOpen(): boolean {
  return document.querySelector('dialog:modal') !== null;
}
