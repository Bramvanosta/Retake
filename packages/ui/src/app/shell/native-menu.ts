/**
 * The desktop app's menu follows the page (on Ranch's model — the menu shows what can run now): the state of every
 * page command of the menu (ui-kit MENU_COMMANDS), computed from the shell's context — the open project, the scenario
 * in context, the mode and view shown, the inspector, what the status bar can run (command-bus.ts) — and sent to the
 * shell through the own op `desktop_menu` when it changes (the app's window only; a browser tab has no menu). The shell
 * greys out, checks or relabels the items it holds (apps/desktop menu.rs `apply`); a command still says in the status bar
 * why it cannot act when it is run anyway (a key).
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { desktopMenu } from '../data/desktop.js';
import { bestEffort } from '../best-effort.js';
import type { Route } from '../route.js';
import { MENU_COMMANDS } from '../ui-kit/index.js';
import type { MenuCommand } from '../ui-kit/index.js';
import { commandEnabled, commandsWatch, isShellCommand } from './command-bus.js';
import { VIEW_COMMAND, isProjectPage, isScenarioPage } from './menu-table.js';
import type { Mode, ScenarioContext } from './modes.js';

export interface MenuItemState {
  id: MenuCommand;
  enabled: boolean;
  checked?: boolean;
  variant?: 0 | 1;
}

export interface MenuInput {
  route: Route;
  slug: string | null;
  ctx: ScenarioContext | null;
  mode: Mode | null;
  hasInspector: boolean;
  inspectorShown: boolean;
  /** A shell command's state (command-bus.ts commandEnabled). */
  runnable: (id: 'rehearse' | 'capture' | 'render' | 'stop') => boolean;
}

const MODE_OF: Partial<Record<MenuCommand, Mode>> = { 'mode-script': 'script', 'mode-shoot': 'shoot', 'mode-edit': 'edit', 'mode-review': 'review' };

/** Every page command's state, in MENU_COMMANDS order (pure: the tests read it). */
export function menuItems(i: MenuInput): MenuItemState[] {
  const tab = i.route.name === 'scenario' ? i.route.tab : null;
  return MENU_COMMANDS.map((id): MenuItemState => {
    if (id === 'palette' || id === 'go-back' || id === 'go-forward') return { id, enabled: true };
    if (id === 'go-welcome') return { id, enabled: i.route.name !== 'projects' };
    if (id === 'inspector') return { id, enabled: i.hasInspector, variant: i.hasInspector && i.inspectorShown ? 1 : 0 };
    if (isShellCommand(id)) return { id, enabled: i.runnable(id) };
    const mode = MODE_OF[id];
    if (mode) return { id, enabled: i.ctx !== null, checked: i.mode === mode };
    const view = (Object.keys(VIEW_COMMAND) as Array<keyof typeof VIEW_COMMAND>).find((k) => VIEW_COMMAND[k] === id);
    if (view) return { id, enabled: i.ctx !== null, checked: tab === view };
    if (isProjectPage(id)) return { id, enabled: i.slug !== null };
    if (isScenarioPage(id)) return { id, enabled: i.ctx !== null };
    return { id, enabled: true };
  });
}

/** How long a state settles before it is sent (a screen change sets several things at once). */
const SETTLE_MS = 60;

/** Sends the menu's state to the desktop app when it changes (nothing in a browser tab). */
export function useNativeMenu(inApp: boolean, input: Omit<MenuInput, 'runnable'>): void {
  const v = useSyncExternalStore(commandsWatch.subscribe, commandsWatch.version);
  const sent = useRef('');
  const state = JSON.stringify(menuItems({ ...input, runnable: commandEnabled }));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `v` (the command bus changed) is a trigger to read the runnable state again
  useEffect(() => {
    if (!inApp || state === sent.current) return;
    const t = window.setTimeout(() => {
      // Kept as sent once the shell has it (a state refused or capped is sent again with the next change).
      void bestEffort(
        desktopMenu({ items: JSON.parse(state) as MenuItemState[] }).then((r) => {
          if (r.sent) sent.current = state;
        }),
        'the menu follows the page: a state not sent leaves the last one',
      );
    }, SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [inApp, state, v]);
}
