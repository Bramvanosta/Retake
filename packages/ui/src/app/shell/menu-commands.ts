/**
 * The shell's commands (AppShell.tsx): the desktop app's menu (File's New Scenario, View's palette, modes, views and
 * inspector, Go's pages and history, Scenario's runs, Help's Keyboard Shortcuts), or ⌘K / Ctrl+K in a browser tab, and
 * the palette's and the shortcuts sheet's open state.
 */
import { useCallback, useEffect, useState } from 'react';
import { hrefTo } from '../route.js';
import type { Route, ScenarioTab } from '../route.js';
import { COMMAND_EVENT, CONTEXT_MENUS, isContextMenu, isMenuCommand, modalOpen } from '../ui-kit/index.js';
import type { MenuCommand } from '../ui-kit/index.js';
import { isShellCommand, runShellCommand } from './command-bus.js';
import { installContextMenus, takeContextTarget } from './context-menu.js';
import { modeTarget } from './modes.js';
import { useNativeMenu } from './native-menu.js';
import { PROJECT_PAGE, SCENARIO_PAGE, VIEW_COMMAND } from './menu-table.js';
import type { Mode, ScenarioContext } from './modes.js';

const MODE_COMMAND: Record<Mode, MenuCommand> = { script: 'mode-script', shoot: 'mode-shoot', edit: 'mode-edit', review: 'mode-review' };
/** A Mac (its shortcuts use ⌘; Ctrl+K edits text there). */
export const MAC = typeof navigator !== 'undefined' && /^(?:mac|iphone|ipad)/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform);

/** A field that takes typed text (its own Ctrl+K, if any, stays its own). */
function inTextField(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.isContentEditable ||
      t.matches('textarea, select, input:not([type="button"], [type="checkbox"], [type="radio"], [type="submit"], [type="reset"], [type="image"], [type="color"], [type="file"], [type="range"])'))
  );
}

export interface CommandInput {
  ctx: ScenarioContext | null;
  /** The open project, or null (Welcome, the gallery). */
  slug: string | null;
  hasInspector: boolean;
  say: (s: string) => void;
  toggleInspector: () => void;
  inApp: boolean;
}

/** The palette's open state and the shell's commands: the desktop app's menu (and its state), or ⌘K / Ctrl+K in a browser tab. */
export function useMenuCommands({ ctx, slug, hasInspector, say, toggleInspector, inApp }: CommandInput, shown: { route: Route; mode: Mode | null; inspectorShown: boolean }) {
  const [palette, setPalette] = useState(false);
  // Help › Keyboard Shortcuts (ShortcutsSheet.tsx).
  const [shortcuts, setShortcuts] = useState(false);
  // In the app's window: WebKit's own menu only in text; the screens may ask for the shell's context menus.
  useEffect(() => installContextMenus(), []);
  // The desktop app's menu follows what this screen shows and can run (native-menu.ts).
  useNativeMenu(inApp, { route: shown.route, slug, ctx, mode: shown.mode, hasInspector, inspectorShown: shown.inspectorShown });

  const run = useCallback(
    (id: MenuCommand) => {
      if (modalOpen()) {
        // A modal waits for its answer; the palette's own ⌘K closes it. ⌘. always answers (a capture may be running
        // behind the sheet or the palette): the palette closes, then Stop's owner acts — it changes no page.
        if (id === 'palette' && palette) setPalette(false);
        if (id !== 'stop') return;
        if (palette) setPalette(false);
      }
      if (id === 'palette') setPalette(true);
      else if (id === 'help-shortcuts') setShortcuts(true);
      else if (isShellCommand(id)) {
        // Whoever owns it acts (the status bar's defaults are always there; they say why when they cannot).
        if (!runShellCommand(id)) say('Open a scenario first');
      } else if (id === 'inspector') {
        if (hasInspector) toggleInspector();
        else say('This screen has no inspector');
      } else if (id === 'go-back') history.back();
      else if (id === 'go-forward') history.forward();
      else if (id === 'go-welcome') location.hash = hrefTo({ name: 'projects' });
      else if (PROJECT_PAGE[id]) {
        if (slug) location.hash = hrefTo(PROJECT_PAGE[id](slug));
        else say('Open a project first');
      } else if (SCENARIO_PAGE[id]) {
        if (ctx) location.hash = hrefTo(SCENARIO_PAGE[id](ctx));
        else say('Open a scenario first');
      } else {
        const tab = (Object.keys(VIEW_COMMAND) as ScenarioTab[]).find((k) => VIEW_COMMAND[k] === id);
        if (tab) {
          if (ctx) location.hash = hrefTo({ name: 'scenario', slug: ctx.slug, scenario: ctx.scenario, tab });
          else say('Open a scenario first');
          return;
        }
        const m = (Object.keys(MODE_COMMAND) as Mode[]).find((k) => MODE_COMMAND[k] === id);
        if (!m) return;
        if (ctx) location.hash = hrefTo(modeTarget(m, ctx));
        else say('Open a scenario first');
      }
    },
    [ctx, slug, hasInspector, palette, say, toggleInspector],
  );

  // The desktop app's menu sends commands; a browser tab binds ⌘K / Ctrl+K only.
  const runOnTarget = useCallback((id: MenuCommand, target: ScenarioContext | null) => {
    if (!target || modalOpen()) return;
    const m = (Object.keys(MODE_COMMAND) as Mode[]).find((k) => MODE_COMMAND[k] === id);
    if (m) location.hash = hrefTo(modeTarget(m, target));
    else if (SCENARIO_PAGE[id]) location.hash = hrefTo(SCENARIO_PAGE[id](target));
  }, []);
  useEffect(() => {
    const onCommand = (e: Event) => {
      const d = (e as CustomEvent<{ id?: unknown; context?: unknown } | null>).detail;
      const id = d?.id;
      if (!isMenuCommand(id)) return;
      // A context menu's pick: on what was right-clicked (once, while fresh), never on the scenario in context.
      if (d && 'context' in d) {
        if (isContextMenu(d.context) && (CONTEXT_MENUS[d.context] as readonly string[]).includes(id)) runOnTarget(id, takeContextTarget(d.context));
        return;
      }
      run(id);
    };
    window.addEventListener(COMMAND_EVENT, onCommand);
    const onKey = (e: KeyboardEvent) => {
      if (inApp || e.isComposing || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
      // ⌘K on a Mac — never Ctrl+K there (a text field's "delete to the end of the line"); Ctrl+K elsewhere, outside a
      // text field.
      if (MAC ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey || inTextField(e.target)) return;
      // A modal waiting for its answer keeps the key (the browser's own ⌘K too), but the palette's own ⌘K closes it.
      if (modalOpen() && !document.querySelector('dialog.k-palette[open]')) return;
      e.preventDefault();
      run('palette');
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(COMMAND_EVENT, onCommand);
      window.removeEventListener('keydown', onKey);
    };
  }, [run, runOnTarget, inApp]);
  return { palette, setPalette, shortcuts, setShortcuts };
}
