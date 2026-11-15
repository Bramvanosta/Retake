/** The shell's commands (AppShell.tsx): the desktop app's menu, or ⌘K / Ctrl+K in a browser tab, and the palette's open state. */
import { useCallback, useEffect, useState } from 'react';
import { hrefTo } from '../route.js';
import { COMMAND_EVENT, isMenuCommand, modalOpen } from '../ui-kit/index.js';
import type { MenuCommand } from '../ui-kit/index.js';
import { isShellCommand, runShellCommand } from './command-bus.js';
import { modeTarget } from './modes.js';
import type { Mode, ScenarioContext } from './modes.js';

const MODE_COMMAND: Record<Mode, MenuCommand> = { script: 'mode-script', shoot: 'mode-shoot', edit: 'mode-edit', review: 'mode-review' };

/** A Mac (its shortcuts use ⌘; Ctrl+K edits text there). */
const MAC = typeof navigator !== 'undefined' && /^(?:mac|iphone|ipad)/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform);

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
  hasInspector: boolean;
  say: (s: string) => void;
  toggleInspector: () => void;
  inApp: boolean;
}

/** The palette's open state and the shell's commands: the desktop app's menu, or ⌘K / Ctrl+K in a browser tab. */
export function useMenuCommands({ ctx, hasInspector, say, toggleInspector, inApp }: CommandInput) {
  const [palette, setPalette] = useState(false);

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
      else if (isShellCommand(id)) {
        // Whoever owns it acts (the status bar's defaults are always there; they say why when they cannot).
        if (!runShellCommand(id)) say('Open a scenario first');
      } else if (id === 'inspector') {
        if (hasInspector) toggleInspector();
        else say('This screen has no inspector');
      } else {
        const m = (Object.keys(MODE_COMMAND) as Mode[]).find((k) => MODE_COMMAND[k] === id);
        if (!m) return;
        if (ctx) location.hash = hrefTo(modeTarget(m, ctx));
        else say('Open a scenario first');
      }
    },
    [ctx, hasInspector, palette, say, toggleInspector],
  );

  // The desktop app's menu sends commands; a browser tab binds ⌘K / Ctrl+K only.
  useEffect(() => {
    const onCommand = (e: Event) => {
      const id = (e as CustomEvent<{ id?: unknown } | null>).detail?.id;
      if (isMenuCommand(id)) run(id);
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
  }, [run, inApp]);
  return { palette, setPalette };
}
