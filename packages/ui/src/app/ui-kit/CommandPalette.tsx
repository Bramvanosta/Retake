/**
 * L5.9: the command palette (⌘K) — a modal `<dialog>` holding a combobox (`role="combobox"`, `aria-expanded`,
 * `aria-controls`, `aria-activedescendant`: the focus stays in the input) and a listbox of options in labelled groups.
 * Typing filters (case-folded: every word of the query in the label or hint, labels starting with it first); ↑ ↓ move the
 * active option (its cue: the selection fill and a 3 px bar, more than colour), Enter runs it, a click runs it, Escape
 * closes; the focus goes back to where it was (to the centre pane, `#main`, when that is gone) — at once when the palette
 * closes itself, never on its late `close` event (a task that, under load, lands after the focus has moved on).
 * L5.12b (R4-Palette): 640 px wide, "Search commands, scenes and themes", an icon per row (decorative: the label names
 * it), Esc's key cap beside the field, and a footer legend (↑ ↓ Move · Return Run · Esc Close, and the caller's
 * footnote: the desktop app's "Commands with a key are also in the menu bar").
 * L5.12b fixes: the legend is read too (review A-L8: the footnote is information, not decoration); `aria-expanded` is
 * false while no option is listed; an input method's composition-ending Enter is ignored by `isComposing` or its
 * keyCode 229 (WebKit — the desktop app's view — can end a composition with `isComposing` false: review A-L9).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Kbd } from './Button.js';
import { Icon } from './Icon.js';
import type { IconName } from './Icon.js';
import { Txt, shown } from '../bits.js';

export interface Command {
  id: string;
  label: string;
  group: string;
  hint?: string;
  kbd?: string[];
  /** L5.12b: the row's icon. */
  icon?: IconName;
  run: () => void;
}

/** The commands matching `query`, in their groups' order; within a group the ones whose label starts with the query first. */
export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const words = q.split(/\s+/);
  const hits = commands.filter((c) => {
    const hay = `${c.label} ${c.hint ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const groups = [...new Set(commands.map((c) => c.group))];
  const starts = (c: Command) => (c.label.toLowerCase().startsWith(q) ? 0 : c.label.toLowerCase().split(/\s+/).some((w) => w.startsWith(words[0])) ? 1 : 2);
  return groups.flatMap((g) => hits.filter((c) => c.group === g).sort((a, b) => starts(a) - starts(b)));
}

export function CommandPalette({ open, onClose, commands, placeholder = 'Search commands, scenes and themes', footnote }: { open: boolean; onClose: () => void; commands: Command[]; placeholder?: string; /** A last line in the footer legend. */ footnote?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const base = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // Closed, it holds no option (a hidden `[role=option][aria-selected]` would answer a screen's own queries).
  const hits = useMemo(() => (open ? filterCommands(commands, query) : []), [open, commands, query]);
  const optId = (c: Command) => `${base}-o-${c.id}`;
  // The `close` events still to come of closings the palette made itself (the focus went back when it closed).
  const ownCloses = useRef(0);
  const giveBack = () => {
    const back = opener.current;
    opener.current = null;
    // A "Go to" command often unmounts the opener: the focus goes to the centre pane then (review A-L6).
    (back && back.isConnected ? back : document.getElementById('main'))?.focus();
  };
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement as HTMLElement | null;
      setQuery('');
      setActive(0);
      d.showModal();
      input.current?.focus();
    } else if (!open && d.open) {
      ownCloses.current += 1;
      d.close();
      giveBack();
    }
  }, [open]);
  useEffect(() => {
    if (active >= hits.length) setActive(Math.max(0, hits.length - 1));
  }, [active, hits.length]);
  useEffect(() => {
    if (!open) return;
    const c = hits[active];
    if (c) document.getElementById(optId(c))?.scrollIntoView({ block: 'nearest' });
  });
  const runAt = (i: number) => {
    const c = hits[i];
    if (!c) return;
    onClose();
    c.run();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // An input method composing a word owns its keys (Enter confirms the word, not a command: review A-L9).
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (hits.length) setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % hits.length : (a - 1 + hits.length) % hits.length));
    } else if (e.key === 'Home' && e.altKey) setActive(0);
    else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(active);
    }
  };
  const onDialogClose = () => {
    if (ownCloses.current > 0) {
      ownCloses.current -= 1;
      return;
    }
    // The platform closed it (an Escape the page may not refuse). A close event of an earlier closing that lands after
    // the palette opened again is not this one's (it would take the opener away from the closing to come).
    if (ref.current?.open) return;
    giveBack();
  };
  const groups = [...new Set(hits.map((c) => c.group))];
  const current = hits[active];
  return (
    <dialog
      ref={ref}
      className="k-palette"
      aria-label="Command palette"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={onDialogClose}
    >
      <label className="k-sr" htmlFor={`${base}-input`}>
        Command
      </label>
      <div className="k-palette-field">
        <input
        ref={input}
        id={`${base}-input`}
        className="k-palette-input"
        role="combobox"
        aria-expanded={hits.length > 0}
        aria-controls={`${base}-list`}
        aria-autocomplete="list"
        aria-activedescendant={current ? optId(current) : undefined}
        placeholder={placeholder}
        value={query}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.currentTarget.value);
          setActive(0);
        }}
        onKeyDown={onKey}
      />
        <span className="k-palette-esc" aria-hidden="true">
          <Kbd keys={['Esc']} />
        </span>
      </div>
      {/* Never a tab stop of its own (a long list scrolls: Chromium would make the scroller focusable) — the combobox drives it. */}
      <div id={`${base}-list`} role="listbox" aria-label="Commands" className="k-palette-list" tabIndex={-1}>
        {groups.map((g, gi) => (
          <div key={g} role="group" aria-labelledby={`${base}-g${gi}`} className="k-palette-group">
            <div id={`${base}-g${gi}`} role="presentation" className="k-palette-heading">
              {shown(g)}
            </div>
            {hits
              .filter((c) => c.group === g)
              .map((c) => (
                <div key={c.id} id={optId(c)} role="option" aria-selected={c === current} className={c === current ? 'k-palette-option is-active' : 'k-palette-option'} onClick={() => runAt(hits.indexOf(c))}>
                  <span className="k-palette-icon" aria-hidden="true">
                    {c.icon && <Icon name={c.icon} />}
                  </span>
                  <span className="k-palette-label"><Txt text={c.label} /></span>
                  {c.hint && <span className="k-palette-hint"><Txt text={c.hint} /></span>}
                  {c.kbd && <Kbd keys={c.kbd} />}
                </div>
              ))}
          </div>
        ))}
      </div>
      <p className="k-palette-none" role="status">
        {open && hits.length === 0 ? 'Nothing matches' : ''}
      </p>
      <p className="k-palette-legend">
        <span className="k-palette-legend-item">
          <Kbd keys={['↑', '↓']} /> Move
        </span>
        <span className="k-palette-legend-item">
          <Kbd keys={['Return']} /> Run
        </span>
        <span className="k-palette-legend-item">
          <Kbd keys={['Esc']} /> Close
        </span>
        {footnote !== undefined && <span className="k-palette-legend-note">{shown(footnote)}</span>}
      </p>
    </dialog>
  );
}
