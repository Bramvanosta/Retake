/**
 * Help › Keyboard Shortcuts (DESIGN §4j), and the palette's "Keyboard shortcuts": the key of every menu-bar item that
 * has one, by its menu — the page's commands (ui-kit COMMANDS, the menu's Title Case labels), the shell's own keyed
 * items (SHELL_KEYS) and macOS's standard ones (STD_KEYS: Hide, Quit, Close Window, the Edit menu, Enter Full Screen,
 * Minimize) — then the keys the page binds itself in text and on the board (PAGE_KEYS). Not listed: the keys macOS
 * adds itself (the Help menu's search, the Edit menu's AutoFill / Dictation / Emoji, the window list). One source for
 * every row: the registry the menu is compared with. Read-only: no op. In a browser tab a line says the menu's keys
 * are the desktop app's (the palette's key works here).
 */
import { APP_NAME } from '../brand.js';
import { COMMANDS, Facts, InspectorSection, Kbd, PAGE_KEYS, SHELL_KEYS, STD_KEYS, Sheet, keyCaps } from '../ui-kit/index.js';

export interface ShortcutRow {
  id: string;
  label: string;
  keys: string[];
}

/** The groups, in the menu bar's order (the app menu, File, Edit, View, Go, Scenario, Window), then the page's own keys. */
export function shortcutGroups(): Array<{ title: string; rows: ShortcutRow[] }> {
  const menus = [APP_NAME, 'File', 'Edit', 'View', 'Go', 'Scenario', 'Window'];
  const rows = new Map<string, ShortcutRow[]>(menus.map((m) => [m, []]));
  // The page's commands first, then the shell's, then macOS's (File: New Scenario…, Open Workspace…, Close Window).
  const app = (k: { menu: string }) => (k.menu === 'App' ? APP_NAME : k.menu);
  const all: Array<{ id: string; menu: string; label: string; key?: string }> = [...COMMANDS, ...[...SHELL_KEYS, ...STD_KEYS].map((k) => ({ ...k, menu: app(k) }))];
  for (const c of all) if (c.key) rows.get(c.menu)?.push({ id: c.id, label: c.label.replace('{app}', APP_NAME), keys: keyCaps(c.key) });
  const groups = menus.map((m) => ({ title: m, rows: rows.get(m) ?? [] })).filter((g) => g.rows.length > 0);
  groups.push({ title: 'In text and on the board', rows: PAGE_KEYS.map((k) => ({ id: k.id, label: k.label, keys: keyCaps(k.key) })) });
  return groups;
}

export function ShortcutsSheet({ open, onClose, inApp }: { open: boolean; onClose: () => void; inApp: boolean }) {
  return (
    <Sheet
      open={open}
      title="Keyboard shortcuts"
      testId="shortcuts-sheet"
      focusTitle
      actions={[{ id: 'close', label: 'Done', isDefault: true, isCancel: true }]}
      onAction={onClose}
      content={shortcutGroups().map((g) => (
        <InspectorSection key={g.title} title={g.title} testId={`shortcuts-${g.title === APP_NAME ? 'app' : g.title.split(' ')[0]!.toLowerCase()}`}>
          <Facts label={g.title} rows={g.rows.map((r) => ({ key: r.id, label: r.label, value: <Kbd keys={r.keys} /> }))} />
        </InspectorSection>
      ))}
    >
      {inApp ? "The menu bar's keys and the page's own." : "The menu bar's keys are the desktop app's; in this tab the command palette's key works."}
    </Sheet>
  );
}
