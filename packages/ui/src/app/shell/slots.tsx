/**
 * L5.9: the shell's slots — a screen fills the inspector pane, the title bar's context control or the status bar's
 * actions by rendering `<ShellSlot name="…">` anywhere in its tree (a portal into the shell's pane). The inspector pane
 * shows only while a screen claims it: the legacy screens claim nothing and keep the whole centre.
 */
import { createContext, useContext, useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type SlotName = 'inspector' | 'context' | 'actions';

export interface SlotHost {
  targets: Partial<Record<SlotName, HTMLElement | null>>;
  /** Claims a slot while mounted; returns the release. */
  claim(name: SlotName): () => void;
}

export const SlotContext = createContext<SlotHost | null>(null);

export function ShellSlot({ name, children }: { name: SlotName; children: ReactNode }) {
  const host = useContext(SlotContext);
  useEffect(() => host?.claim(name), [host, name]);
  const target = host?.targets[name];
  return target ? createPortal(children, target) : null;
}
