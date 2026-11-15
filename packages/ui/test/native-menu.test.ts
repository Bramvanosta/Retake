/**
 * The desktop app's menu follows the page (shell/native-menu.ts `menuItems`): every page command of the menu, in
 * MENU_COMMANDS order, with what can run now — the scenario's pages and views only with a scenario in context, the
 * project's pages only with a project open, the mode and view shown checked, the inspector's toggle label, the Scenario
 * menu's runs as the status bar's buttons say (command-bus.ts), Help's Keyboard Shortcuts always. The shortcuts sheet
 * (shell/ShortcutsSheet.tsx) lists every key of the registry by menu, the shell's own and the page's own.
 */
import { describe, expect, it } from 'vitest';
import { menuItems } from '../src/app/shell/native-menu.js';
import type { MenuInput } from '../src/app/shell/native-menu.js';
import { shortcutGroups } from '../src/app/shell/ShortcutsSheet.js';
import { COMMANDS, MENU_COMMANDS, PAGE_KEYS, SHELL_KEYS, STD_KEYS, keyCaps } from '../src/app/ui-kit/commands.js';

const state = (i: Partial<MenuInput>) =>
  Object.fromEntries(menuItems({ route: { name: 'projects' }, slug: null, ctx: null, mode: null, hasInspector: false, inspectorShown: false, runnable: () => false, ...i }).map((x) => [x.id, x]));

describe('the native menu state', () => {
  it('every page command once, in MENU_COMMANDS order', () => {
    const items = menuItems({ route: { name: 'projects' }, slug: null, ctx: null, mode: null, hasInspector: false, inspectorShown: false, runnable: () => true });
    expect(items.map((i) => i.id)).toEqual([...MENU_COMMANDS]);
  });

  it('Welcome: nothing of a project or a scenario; the palette and the history always; Welcome greyed (it is here)', () => {
    const s = state({});
    for (const id of [
      'new-scenario',
      'go-productions',
      'go-cast',
      'go-settings',
      'go-readme',
      'go-library',
      'go-themes',
      'go-report',
      'go-comments',
      'mode-script',
      'view-board',
      'rehearse',
      'stop',
      'inspector',
    ] as const)
      expect(s[id]?.enabled, id).toBe(false);
    for (const id of ['palette', 'go-back', 'go-forward', 'help-shortcuts'] as const) expect(s[id]?.enabled, id).toBe(true);
    expect(s['go-welcome']?.enabled).toBe(false);
    expect(s['mode-script']?.checked).toBe(false);
  });

  it("a scenario's Hooks view: its mode and view checked, the project's and scenario's pages on, the runs as the status bar says, the inspector's label", () => {
    const ctx = { slug: 'p', scenario: 'quote' };
    const s = state({
      route: { name: 'scenario', slug: 'p', scenario: 'quote', tab: 'hooks' },
      slug: 'p',
      ctx,
      mode: 'script',
      hasInspector: true,
      inspectorShown: true,
      runnable: (id) => id === 'rehearse' || id === 'render',
    });
    expect([s['mode-script']?.checked, s['mode-shoot']?.checked, s['view-hooks']?.checked, s['view-board']?.checked]).toEqual([true, false, true, false]);
    for (const id of ['mode-edit', 'view-yaml', 'go-report', 'go-comments', 'go-settings', 'new-scenario', 'go-welcome'] as const) expect(s[id]?.enabled, id).toBe(true);
    expect([s.rehearse?.enabled, s.capture?.enabled, s.render?.enabled, s.stop?.enabled]).toEqual([true, false, true, false]);
    expect(s.inspector).toEqual({ id: 'inspector', enabled: true, variant: 1 });
    expect(state({ hasInspector: true, inspectorShown: false }).inspector).toEqual({ id: 'inspector', enabled: true, variant: 0 });
    // Another screen than the scenario's: no view checked, the mode still.
    const edit = state({ route: { name: 'timeline', slug: 'p', scenario: 'quote' }, slug: 'p', ctx, mode: 'edit' });
    expect([edit['mode-edit']?.checked, edit['view-board']?.checked, edit['view-board']?.enabled]).toEqual([true, false, true]);
  });

  it('Help › Keyboard Shortcuts is always on (a scenario, a project, Welcome)', () => {
    const ctx = { slug: 'p', scenario: 'quote' };
    for (const i of [{}, { slug: 'p' }, { route: { name: 'scenario', slug: 'p', scenario: 'quote', tab: 'blocks' } as const, slug: 'p', ctx, mode: 'script' as const }])
      expect(state(i)['help-shortcuts']).toEqual({ id: 'help-shortcuts', enabled: true });
  });

  it("the shortcuts sheet lists every COMMANDS key by menu, the shell's keys and the page's own", () => {
    const groups = shortcutGroups();
    expect(groups.map((g) => g.title)).toEqual(['Retake', 'File', 'Edit', 'View', 'Go', 'Scenario', 'Window', 'In text and on the board']);
    const rows = groups.flatMap((g) => g.rows.map((r) => ({ ...r, menu: g.title })));
    // Every key of the registry once, with its menu label (Title Case) and its caps; nothing without a key.
    const keyed = [...COMMANDS.filter((c) => 'key' in c), ...SHELL_KEYS, ...STD_KEYS];
    expect(
      rows
        .filter((r) => r.menu !== 'In text and on the board')
        .map((r) => r.id)
        .sort(),
    ).toEqual(keyed.map((c) => c.id).sort());
    for (const c of keyed) {
      const r = rows.find((x) => x.id === c.id)!;
      expect(r.label, c.id).toBe(c.label.replace('{app}', 'Retake'));
      expect(r.menu, c.id).toBe(c.menu.replace('App', 'Retake'));
      expect(r.keys, c.id).toEqual(keyCaps(c.key!));
    }
    expect(rows.find((r) => r.id === 'render')).toMatchObject({ menu: 'Scenario', label: 'Render', keys: ['⌘', 'B'] });
    expect(groups.find((g) => g.title === 'File')!.rows.map((r) => r.id)).toEqual(['new-scenario', 'open-workspace', 'close-window']);
    expect(groups.find((g) => g.title === 'Retake')!.rows.map((r) => r.label)).toEqual(['Set Up Retake…', 'Hide Retake', 'Hide Others', 'Quit Retake']);
    expect(groups.find((g) => g.title === 'Edit')!.rows.map((r) => r.keys.join(''))).toEqual(['⌘Z', '⇧⌘Z', '⌘X', '⌘C', '⌘V', '⌘A']);
    expect(groups.at(-1)!.rows.map((r) => r.id)).toEqual(PAGE_KEYS.map((k) => k.id));
  });
});
