/**
 * L5.9: the shell's slots — a screen fills the inspector pane, the title bar's context control or the status bar's
 * actions by rendering `<ShellSlot name="…">` anywhere in its tree (a portal into the shell's pane). The inspector pane
 * shows only while a screen claims it: the legacy screens claim nothing and keep the whole centre.
 * L5.10a fixes (review B-M1): a slot the person hid (the inspector toggle, ⌥⌘I) is `hidden`; a screen whose inspector is
 * the only home of what it shows (`inline`: the Project screen's project facts, README, recent runs, a location's pages)
 * then renders it in place, in the centre pane, under a heading of its own.
 */
import { createContext, useContext, useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type SlotName = 'inspector' | 'context' | 'actions';

export interface SlotHost {
  targets: Partial<Record<SlotName, HTMLElement | null>>;
  /** Slots the person hid (their pane is not shown). */
  hidden?: Partial<Record<SlotName, boolean>>;
  /** Claims a slot while mounted; returns the release. */
  claim(name: SlotName): () => void;
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
