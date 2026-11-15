/**
 * The sheet — a confirmation that drops from under the title bar: a native `<dialog>` opened with `showModal`
 * (the top layer, the page behind inert, Escape cancels), `role="alertdialog"` when it confirms something destructive.
 * The default action holds the focus on open (Return chooses it) — but an action that loses work is NEVER the default:
 * a destructive default falls back to the cancel action. The focus goes back to where it was on close — at
 * once, never on the dialog's `close` event: that event is a task of its own, and under load it lands after the user
 * (or another sheet) has moved the focus on, which it would steal back. The sheet follows its `open` prop even when the
 * platform closes the dialog itself.
 * A sheet that asks for a value too (a copy's name, the Library's Create with Claude): its fields go in `content`,
 * under the text and outside the sheet's description (a screen reader reads the text, not every field, on open); an
 * action can be off (`disabled`: no prompt to copy yet) — the focus then starts on the first field.
 * The focus on open is the default action when it is on, else the first text field of `content`, else the
 * first action that is on — never a control that is not a tab stop (an unchecked chip); Return in a
 * one-line text field of the sheet chooses the default action when it is on (edit a copy's name, press
 * Return).
 * Return never activates a destructive action — on a focused destructive button it chooses
 * the default instead, as the native alert's Return does wherever the focus ring is (Space and a click still press it);
 * an action can be `busy` (its answer in flight: the kit Button's moving mark, disabled).
 * A long sheet whose default action sits below the fold may start the focus on its title
 * instead (`focusTitle`: the title is focusable, never a tab stop) — a first Return then chooses nothing; and Escape may
 * answer an action id of its own (`escapeAction`: closing without the choice its visible button records).
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
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
  /** A test id kept from an older dialog. */
  testId?: string;
  /** Off for now (nothing to act on yet). */
  disabled?: boolean;
  /** Chosen, its answer in flight (disabled, the moving mark). */
  busy?: boolean;
}

/** A sheet's one-line text fields (Return in one chooses the default action; the first takes the focus when it is off). */
const TEXT_FIELD = 'input:is([type="text"], [type="search"], [type="url"], [type="email"], :not([type])):not(:disabled):not([readonly])';

/** Where the focus starts: the default action when it is on, else the first text field, else the first action that is on. */
export function firstFocus(d: HTMLElement): HTMLElement | null {
  return (
    d.querySelector<HTMLElement>('[data-default="yes"]:not(:disabled)') ??
    d.querySelector<HTMLElement>(`.k-sheet-content :is(${TEXT_FIELD}, textarea:not(:disabled):not([readonly]))`) ??
    d.querySelector<HTMLElement>('.k-sheet-actions button:not(:disabled)')
  );
}

/** The action Return chooses: the one marked default unless it is destructive, else the cancel action. */
export function defaultAction(actions: SheetAction[]): SheetAction | undefined {
  return actions.find((a) => a.isDefault && a.variant !== 'destructive') ?? actions.find((a) => a.isCancel);
}

export function Sheet({
  open,
  title,
  children,
  actions,
  onAction,
  destructive,
  alert,
  testId,
  content,
  focusTitle,
  escapeAction,
}: {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  actions: SheetAction[];
  onAction: (id: string) => void;
  destructive?: boolean;
  /** `role="alertdialog"` without marking the sheet destructive (a warning that loses no work). */
  alert?: boolean;
  testId?: string;
  /** Fields under the text (not part of the sheet's description). */
  content?: ReactNode;
  /** The focus starts on the title (a long sheet: its top in view, Return chooses nothing). */
  focusTitle?: boolean;
  /** What Escape (or the platform closing the dialog) answers — default: the cancel action's id. */
  escapeAction?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const textId = useId();
  const def = defaultAction(actions);
  const cancel = actions.find((a) => a.isCancel);
  const escapeId = escapeAction ?? cancel?.id;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const onClose = useSheetDialog({ open, ref, opener, titleRef, focusTitle, escapeId, onAction });
  // Return in a one-line text field: the default action, when it is on (a text area keeps its Return). Return on a
  // focused destructive action never presses it: the default instead, when it is on — else nothing.
  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return;
    const t = e.target as HTMLElement;
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.k-sheet-actions > button') ?? [])];
    const on = buttons.indexOf(t as HTMLButtonElement);
    if (on >= 0 && actions[on]?.variant === 'destructive') {
      e.preventDefault();
      if (def && !def.disabled && !def.busy) onAction(def.id);
      return;
    }
    if (!(t instanceof HTMLInputElement) || !t.matches(TEXT_FIELD) || !def || def.disabled) return;
    e.preventDefault();
    onAction(def.id);
  };
  return (
    <dialog
      ref={ref}
      onKeyDown={onKeyDown}
      className="k-sheet"
      role={destructive || alert ? 'alertdialog' : undefined}
      data-testid={testId}
      aria-labelledby={titleId}
      aria-describedby={children ? textId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        // A cancel the page may not refuse closes the dialog next: onClose answers it, once.
        if (e.cancelable && escapeId) onAction(escapeId);
      }}
      onClose={onClose}
    >
      <h2 id={titleId} ref={titleRef} className="k-sheet-title" tabIndex={focusTitle ? -1 : undefined}>
        {shown(title)}
      </h2>
      {children && (
        <div id={textId} className="k-sheet-text">
          {shown(children)}
        </div>
      )}
      {content && <div className="k-sheet-content">{shown(content)}</div>}
      <div className="k-sheet-actions">
        {actions.map((a) => (
          <Button key={a.id} variant={a.variant ?? 'secondary'} disabled={a.disabled} busy={a.busy} data-default={a === def ? 'yes' : undefined} data-testid={a.testId} onClick={() => onAction(a.id)}>
            {shown(a.label)}
          </Button>
        ))}
      </div>
    </dialog>
  );
}

/** What the sheet's dialog reads: its open state, its refs (the dialog, the opener, the title), and the Escape answer. */
interface SheetDialog {
  open: boolean;
  ref: RefObject<HTMLDialogElement | null>;
  opener: RefObject<HTMLElement | null>;
  titleRef: RefObject<HTMLHeadingElement | null>;
  focusTitle: boolean | undefined;
  escapeId: string | undefined;
  onAction: (id: string) => void;
}

/**
 * The dialog shown modal while `open` (the focus on its first stop, or the title), closed when not — the focus given back
 * at once; the answer is the `close` handler, for a closing the platform made while the owner still holds it open.
 */
function useSheetDialog({ open, ref, opener, titleRef, focusTitle, escapeId, onAction }: SheetDialog): () => void {
  const openNow = useRef(open);
  openNow.current = open;
  // Bumped when the platform closes the dialog while its owner still holds it open (below).
  const [resync, setResync] = useState(0);
  // The `close` events still to come of closings this sheet made itself (already answered when it closed).
  const ownCloses = useRef(0);
  const giveBack = () => {
    const back = opener.current;
    opener.current = null;
    (back?.isConnected ? back : document.getElementById('main'))?.focus();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on open/close and on `resync` (the platform closed it) only; focusTitle is read at opening, giveBack only touches refs
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (!opener.current) opener.current = document.activeElement as HTMLElement | null;
      d.showModal();
      (focusTitle ? titleRef.current : firstFocus(d))?.focus();
    } else if (!open && d.open) {
      ownCloses.current += 1;
      d.close();
      giveBack();
    } else if (!open && opener.current) giveBack();
  }, [open, resync]);
  return () => {
    // The late event of a closing of its own: the focus went back when it closed.
    if (ownCloses.current > 0) {
      ownCloses.current -= 1;
      return;
    }
    // A close event of an earlier closing that lands after the sheet opened again: not this one's.
    if (ref.current?.open) return;
    // The platform may close a modal dialog by itself (Chromium's close watcher lets a page refuse Escape
    // once per user activation) while the owner still holds it open — that is the cancel action, and if the owner keeps
    // the sheet open (a busy one, or no cancel at all) it shows again rather than leaving the two out of step.
    if (openNow.current) {
      if (escapeId) onAction(escapeId);
      setResync((n) => n + 1);
      return;
    }
    giveBack();
  };
}
