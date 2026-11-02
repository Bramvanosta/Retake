/**
 * L5.9: the shell's slots — a screen fills the inspector pane, the title bar's context control or the status bar's
 * actions by rendering `<ShellSlot name="…">` anywhere in its tree (a portal into the shell's pane). The inspector pane
 * shows only while a screen claims it: the legacy screens claim nothing and keep the whole centre.
 * L5.10a fixes (review B-M1): a slot the person hid (the inspector toggle, ⌥⌘I) is `hidden`; a screen whose inspector is
 * the only home of what it shows (`inline`: the Project screen's project facts, README, recent runs, a location's pages)
 * then renders it in place, in the centre pane, under a heading of its own.
 * L5.10b: `browser` — a screen replaces the browser's tree while it claims it (the scenario's scenes); the foot stays.
 * L5.12a: `BrowserCollapsed` — a screen hides the browser pane while it is mounted (Edit, the Review report: R4 gives the
 * preview and the report the width; the title bar's modes and ⌘K still go everywhere).
 */
import { createContext, useContext, useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type SlotName = 'inspector' | 'context' | 'actions' | 'browser';

export interface SlotHost {
  targets: Partial<Record<SlotName, HTMLElement | null>>;
  /** Slots the person hid (their pane is not shown). */
  hidden?: Partial<Record<SlotName, boolean>>;
  /** Claims a slot while mounted; returns the release. */
  claim(name: SlotName): () => void;
  /** L5.12a: hides the browser pane while held; returns the release. */
  collapseBrowser?(): () => void;
}

export const SlotContext = createContext<SlotHost | null>(null);

export function ShellSlot({ name, children, inline }: { name: SlotName; children: ReactNode; /** Shown in place (under this heading) while the person hides the slot. */ inline?: string }) {
  const host = useContext(SlotContext);
  useEffect(() => host?.claim(name), [host, name]);
  if (inline !== undefined && host?.hidden?.[name]) {
    return (
      <section className="sh-inline-slot" aria-label={inline} data-testid={`inline-${name}`}>
        {children}
      </section>
    );
  }
  const target = host?.targets[name];
  return target ? createPortal(children, target) : null;
}

/** L5.12a: the browser pane is hidden while this is mounted. */
export function BrowserCollapsed() {
  const host = useContext(SlotContext);
  useEffect(() => host?.collapseBrowser?.(), [host]);
  return null;
}
