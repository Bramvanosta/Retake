/**
 * L5.9: the sheet — a confirmation that drops from under the title bar: a native `<dialog>` opened with `showModal()`
 * (the top layer, the page behind inert, Escape cancels), `role="alertdialog"` when it confirms something destructive.
 * The default action holds the focus on open (Return chooses it) — but an action that loses work is NEVER the default
 * (L5.2b): a destructive default falls back to the cancel action. The focus goes back to where it was on close — at
 * once, never on the dialog's `close` event: that event is a task of its own, and under load it lands after the user
 * (or another sheet) has moved the focus on, which it would steal back. The sheet follows its `open` prop even when the
 * platform closes the dialog itself (review A-L1).
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button.js';
import type { ButtonVariant } from './Button.js';
import { shown } from '../bits.js';

export interface SheetAction {
  id: string;
  label: string;
  variant?: Exclude<ButtonVariant, 'record'> | 'record';
  /** Return chooses it (ignored on a destructive action). */
  isDefault?: boolean;
  /** Escape chooses it. */
  isCancel?: boolean;
}

/** The action Return chooses: the one marked default unless it is destructive, else the cancel action. */
export function defaultAction(actions: SheetAction[]): SheetAction | undefined {
  return actions.find((a) => a.isDefault && a.variant !== 'destructive') ?? actions.find((a) => a.isCancel);
}

export function Sheet({ open, title, children, actions, onAction, destructive }: { open: boolean; title: ReactNode; children?: ReactNode; actions: SheetAction[]; onAction: (id: string) => void; destructive?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const textId = useId();
  const def = defaultAction(actions);
  const cancel = actions.find((a) => a.isCancel);
  const openNow = useRef(open);
  openNow.current = open;
  // Bumped when the platform closes the dialog while its owner still holds it open (below).
  const [resync, setResync] = useState(0);
  // The `close` events still to come of closings this sheet made itself (already answered when it closed).
  const ownCloses = useRef(0);
  const giveBack = () => {
    const back = opener.current;
    opener.current = null;
    (back && back.isConnected ? back : document.getElementById('main'))?.focus();
  };
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (!opener.current) opener.current = document.activeElement as HTMLElement | null;
      d.showModal();
      d.querySelector<HTMLElement>('[data-default="yes"]')?.focus();
    } else if (!open && d.open) {
      ownCloses.current += 1;
      d.close();
      giveBack();
    } else if (!open && opener.current) giveBack();
  }, [open, resync]);
  const onClose = () => {
    // The late event of a closing of its own: the focus went back when it closed.
    if (ownCloses.current > 0) {
      ownCloses.current -= 1;
      return;
    }
    // A close event of an earlier closing that lands after the sheet opened again: not this one's.
    if (ref.current?.open) return;
    // Review A-L1: the platform may close a modal dialog by itself (Chromium's close watcher lets a page refuse Escape
    // once per user activation) while the owner still holds it open — that is the cancel action, and if the owner keeps
    // the sheet open (a busy one, or no cancel at all) it shows again rather than leaving the two out of step.
    if (openNow.current) {
      if (cancel) onAction(cancel.id);
      setResync((n) => n + 1);
      return;
    }
    giveBack();
  };
  return (
    <dialog
      ref={ref}
      className="k-sheet"
      role={destructive ? 'alertdialog' : undefined}
      aria-labelledby={titleId}
      aria-describedby={children ? textId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        // A cancel the page may not refuse closes the dialog next: onClose answers it, once.
        if (e.cancelable && cancel) onAction(cancel.id);
      }}
      onClose={onClose}
    >
      <h2 id={titleId} className="k-sheet-title">
        {shown(title)}
      </h2>
      {children && (
        <div id={textId} className="k-sheet-text">
          {shown(children)}
        </div>
      )}
      <div className="k-sheet-actions">
        {actions.map((a) => (
          <Button key={a.id} variant={a.variant ?? 'secondary'} data-default={a === def ? 'yes' : undefined} onClick={() => onAction(a.id)}>
            {shown(a.label)}
          </Button>
        ))}
      </div>
    </dialog>
  );
}
