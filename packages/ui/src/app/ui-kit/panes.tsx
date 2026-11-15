/**
 * The panes' pieces — `Toolbar` (one tab stop, the arrows / Home / End rove across its controls — never into a popover
 * or a menu, and never taking the keys a menu, a radio group or a field inside it handles), `StatusBar` (the state on
 * the left, information, the actions on the right; a labelled region), `SourceList` (the browser: a `nav` of headed
 * groups of links, the current one `aria-current="page"` with the selection fill and weight 600, nested items, a count
 * or a flag in words), `InspectorSection` (a titled section, collapsible as a native `<details>`), `Facts` (read-only
 * rows), `Disclosure` (a native `<details>`), `Callout` (a short note), `EmptyState`, `Blocker` (one line: what blocks,
 * and the one action that unblocks it — a button, or Copy with a visible "Copied"; `compact`, the status bar's form —
 * its command in a popover that shows it in full beside its Copy), `Checklist` (an ordered list of checks, each a state
 * column, a title, its body and its actions).
 */
import { useId, useLayoutEffect, useRef } from 'react';
import type { FocusEvent, KeyboardEvent, ReactNode } from 'react';
import { hrefTo } from '../route.js';
import type { Route } from '../route.js';
import { shown } from '../bits.js';
import { Icon } from './Icon.js';
import type { IconName } from './Icon.js';
import { Shape, StatusMark } from './marks.js';
import type { MarkState } from './marks.js';

export { Blocker, TerminalCommands } from './blocker.js';
export type { BlockerFix } from './blocker.js';

const ROVING = 'button:not(:disabled), a[href], select:not(:disabled), input:not(:disabled), textarea:not(:disabled)';
/** Where a control is not one of the toolbar's stops: a popover (a menu's items, open or not), a menu, hidden content. */
const NOT_A_STOP = '[popover], [role="menu"], [hidden], dialog, details:not([open]) > :not(summary)';
/** Fields that keep their own arrows (and Home / End): every text-entry input, a slider, a select, a text area. */
const OWN_KEYS =
  'select, textarea, [contenteditable=""], [contenteditable="true"], input:not([type="button"], [type="checkbox"], [type="radio"], [type="submit"], [type="reset"], [type="image"], [type="color"], [type="file"])';

/** The toolbar's stops in order: its visible controls outside popovers and menus; of a radio group, the checked radio (else its first). */
function stops(bar: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const groups = new Set<string>();
  for (const el of bar.querySelectorAll<HTMLElement>(ROVING)) {
    const off = el.closest(NOT_A_STOP);
    if (off && bar.contains(off)) continue;
    if (el instanceof HTMLInputElement && el.type === 'radio') {
      if (groups.has(el.name)) continue;
      groups.add(el.name);
      const peers = [...bar.querySelectorAll<HTMLInputElement>('input[type="radio"]:not(:disabled)')].filter((r) => r.name === el.name);
      out.push(peers.find((r) => r.checked) ?? peers[0]);
      continue;
    }
    out.push(el);
  }
  return out;
}

export function Toolbar({
  label,
  children,
  clickLeavesKeys,
}: {
  label: string;
  children: ReactNode;
  /**
   * A control focused by a click (Chromium focuses a clicked button) leaves the arrows, Home
   * and End to the page — Edit's transport, where they step the playhead; the toolbar roves once the focus came by the
   * keyboard (Tab, Shift+Tab, a script).
   */
  clickLeavesKeys?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const current = useRef(0);
  /** When a pointer last went down in it, and whether the focus came with it. */
  const pointerAt = useRef(-Infinity);
  const byPointer = useRef(false);
  const items = () => (ref.current ? stops(ref.current) : []);
  const sync = () => {
    const all = items();
    if (current.current >= all.length) current.current = Math.max(0, all.length - 1);
    // A radio that is not its group's stop is reached by the group's own arrows, never by Tab.
    for (const r of ref.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []) if (!all.includes(r)) r.tabIndex = -1;
    all.forEach((el, i) => (el.tabIndex = i === current.current ? 0 : -1));
  };
  useLayoutEffect(sync);
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    byPointer.current = performance.now() - pointerAt.current < 500;
    const i = items().indexOf(e.target as HTMLElement);
    if (i >= 0 && i !== current.current) {
      current.current = i;
      sync();
    }
  };
  const rove = (e: KeyboardEvent<HTMLDivElement>) => {
    // A control inside handled the key (a menu's trigger or items, a field): theirs.
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (clickLeavesKeys && byPointer.current) return;
    const t = e.target as HTMLElement;
    // A field keeps its arrows, Home and End; a radio group keeps its arrows (they move its choice).
    if (t.matches(OWN_KEYS)) return;
    const arrow = e.key.startsWith('Arrow');
    if (arrow && t instanceof HTMLInputElement && t.type === 'radio') return;
    const all = items();
    const i = all.indexOf(t);
    if (i < 0) return;
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? (i + 1) % all.length
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? (i - 1 + all.length) % all.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? all.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    current.current = next;
    sync();
    all[next].focus();
  };
  return (
    <div role="toolbar" aria-label={label} className="k-toolbar" ref={ref} onKeyDown={rove} onFocus={onFocus} onPointerDown={() => (pointerAt.current = performance.now())}>
      {shown(children)}
    </div>
  );
}

export function StatusBar({ state, info, actions, label = 'Status' }: { state: ReactNode; info?: ReactNode; actions?: ReactNode; label?: string }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the status bar's markup is pinned as a div (kit-static); role=region names it as a landmark
    <div className="k-statusbar" role="region" aria-label={label}>
      <div className="k-statusbar-state">{shown(state)}</div>
      {info && <div className="k-statusbar-info">{shown(info)}</div>}
      <div className="k-statusbar-actions">{shown(actions)}</div>
    </div>
  );
}

export interface SourceItem {
  key: string;
  /** A place (a link) … */
  to?: Route;
  /** … or an action (a `<button>` row: the scenes browser selects an entry into the inspector). */
  onSelect?: () => void;
  label: ReactNode;
  current: boolean;
  /** A count (tabular figures) or a flag in words ("unsaved", "does not load"). */
  count?: number;
  flag?: ReactNode;
  children?: SourceItem[];
  /** The nested list's name ("Projects of the workspace"). */
  childrenLabel?: string;
  /** An icon before the label (decorative: the label names the row). */
  icon?: IconName;
  /** A value on the right in mono (a length, a count in words). */
  value?: string;
  /** A quieter row (text-3): a secondary entry. */
  quiet?: boolean;
  /** A lead column before the label (a number, mono). */
  lead?: string;
  /** A test id kept from an older screen (`library-link`). */
  testId?: string;
  /** A second line under the label that wraps (never cut: what tells two rows apart). */
  detail?: ReactNode;
  /** A 2 px bar under the row (0–1 of the longest: a scene's length; decorative, the value says it). */
  bar?: number;
}

/** A row: a link to its place, or a button that acts (the current one `aria-current`: "page" for a place, "true" for a pick). */
function SourceRow({ i, children }: { i: SourceItem; children: ReactNode }) {
  const cls = `k-source-item${i.current ? ' is-current' : ''}${i.quiet ? ' is-quiet' : ''}${i.bar !== undefined ? ' has-bar' : ''}`;
  if (i.onSelect || !i.to) {
    return (
      <button type="button" className={cls} aria-current={i.current ? 'true' : undefined} data-testid={i.testId} onClick={i.onSelect}>
        {shown(children)}
      </button>
    );
  }
  return (
    <a href={hrefTo(i.to)} className={cls} aria-current={i.current ? 'page' : undefined} data-testid={i.testId}>
      {shown(children)}
    </a>
  );
}

export interface SourceGroup {
  key: string;
  heading?: ReactNode;
  items: SourceItem[];
  label?: string;
}

function SourceItems({ items, label, depth }: { items: SourceItem[]; label?: string; depth: number }) {
  return (
    <ul className={`k-source-items k-source-depth-${depth}`} aria-label={label}>
      {items.map((i) => (
        <li key={i.key}>
          <SourceRow i={i}>
            {i.icon && <Icon name={i.icon} className="k-source-icon" />}
            {i.lead !== undefined && <span className="k-source-lead k-mono">{shown(i.lead)}</span>}
            {i.detail !== undefined ? (
              <span className="k-source-text">
                <span className="k-source-label">{shown(i.label)}</span>
                <span className="k-source-detail">{shown(i.detail)}</span>
              </span>
            ) : (
              <span className="k-source-label">{shown(i.label)}</span>
            )}
            {i.flag && <span className="k-source-flag">{shown(i.flag)}</span>}
            {i.value !== undefined && <span className="k-source-count k-mono">{shown(i.value)}</span>}
            {i.count !== undefined && <span className="k-source-count k-mono">{shown(i.count)}</span>}
            {i.bar !== undefined && (
              <span className="k-source-bar" aria-hidden="true">
                <span className="k-source-bar-fill" style={{ width: `${Math.round(Math.max(0.04, Math.min(1, i.bar)) * 100)}%` }} />
              </span>
            )}
          </SourceRow>
          {i.children && i.children.length > 0 && <SourceItems items={i.children} depth={depth + 1} {...(i.childrenLabel ? { label: i.childrenLabel } : {})} />}
        </li>
      ))}
    </ul>
  );
}

export function SourceList({ label, groups }: { label: string; groups: SourceGroup[] }) {
  return (
    <nav className="k-source" aria-label={label}>
      {groups.map((g) => (
        <div key={g.key} className="k-source-group">
          {g.heading && <h2 className="k-source-heading">{shown(g.heading)}</h2>}
          <SourceItems items={g.items} depth={0} {...(g.label ? { label: g.label } : {})} />
        </div>
      ))}
    </nav>
  );
}

export function InspectorSection({
  title,
  children,
  collapsible,
  defaultOpen = true,
  testId,
}: {
  title: ReactNode;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  testId?: string;
}) {
  const id = useId();
  if (collapsible) {
    return (
      <details className="k-section" open={defaultOpen} data-testid={testId}>
        <summary className="k-section-title">{shown(title)}</summary>
        <div className="k-section-body">{shown(children)}</div>
      </details>
    );
  }
  return (
    <section className="k-section" aria-labelledby={id} data-testid={testId}>
      <h3 id={id} className="k-section-title">
        {shown(title)}
      </h3>
      <div className="k-section-body">{shown(children)}</div>
    </section>
  );
}

/** read-only facts — a `<dl>` of rows, the label in the 96 px right-aligned column (the inspector's look). */
export function Facts({ rows, label }: { rows: Array<{ key: string; label: ReactNode; value: ReactNode }>; label?: string }) {
  const list = (
    <dl className="k-facts">
      {rows.map((r) => (
        <div key={r.key} className="k-facts-row">
          <dt className="k-facts-label">{shown(r.label)}</dt>
          <dd className="k-facts-value">{shown(r.value)}</dd>
        </div>
      ))}
    </dl>
  );
  // A name goes on a group around the list (a `dl` has no role that takes one).
  return label ? (
    // biome-ignore lint/a11y/useSemanticElements: a named group of facts; <fieldset> would bring its own border, padding and min-width
    <div role="group" aria-label={label} className="k-facts-group">
      {shown(list)}
    </div>
  ) : (
    list
  );
}

/**
 * A disclosure — a native `<details>` with its summary (the platform's keyboard and state; closed by default).
 * The one place a collapsible lives outside the inspector (the ratchet bans `<details>` outside the kit).
 */
export function Disclosure({ summary, children, defaultOpen = false, testId }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; testId?: string }) {
  return (
    <details className="k-disclosure" open={defaultOpen} data-testid={testId}>
      <summary className="k-disclosure-summary">
        <Icon name="chevron-right" className="k-disclosure-chevron" />
        {shown(summary)}
      </summary>
      <div className="k-disclosure-body">{shown(children)}</div>
    </details>
  );
}

/** `level` 1 for a screen that is only this (the not-found screen's heading is the centre pane's h1). */
export function EmptyState({ title, children, actions, level = 2 }: { title: ReactNode; children?: ReactNode; actions?: ReactNode; level?: 1 | 2 | 3 }) {
  const id = useId();
  const H = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
  return (
    <section className="k-empty" aria-labelledby={id}>
      <H id={id} className="k-empty-title">
        {shown(title)}
      </H>
      {children && <div className="k-empty-text">{shown(children)}</div>}
      {actions && <div className="k-empty-action">{shown(actions)}</div>}
    </section>
  );
}

/**
 * A callout — a short note in a pane-tone well: its state as a shape AND its title (the title says the state:
 * "Unsaved YAML changes", "Not saved"), then its text. `role`: `status` (default), `alert` for what went wrong now,
 * `note` for a standing fact. It replaces the legacy Notice on the rebuilt screens.
 */
export function Callout({
  state = 'idle',
  title,
  children,
  role = 'status',
  testId,
}: {
  state?: MarkState;
  title: ReactNode;
  children?: ReactNode;
  role?: 'status' | 'alert' | 'note';
  testId?: string;
}) {
  return (
    <div className="k-callout" data-state={state} role={role} data-testid={testId}>
      <p className="k-callout-title">
        <StatusMark state={state} word={title} />
      </p>
      {children !== undefined && children !== null && children !== false && <div className="k-callout-body">{shown(children)}</div>}
    </div>
  );
}

/**
 * A checklist (R4-ShootPrep) — an ordered list of checks; each item a 28 px state column (a shape AND its word,
 * the word visible to assistive technology only beside the title that says the same), its title (h3), its body and its
 * actions; a hairline between items.
 */
export function Checklist({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ol className="k-checklist" aria-label={label}>
      {shown(children)}
    </ol>
  );
}

export function ChecklistItem({
  state,
  word,
  title,
  children,
  actions,
  testId,
  level = 3,
}: {
  state: MarkState;
  /** The state in words ("Ready", "Blocked: …"): visible on the title's line — a state word (the colour-only rule). */
  word: string;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  testId?: string;
  /** The title's heading level (2 under a page's h1). */
  level?: 2 | 3;
}) {
  const id = useId();
  const H = level === 2 ? 'h2' : 'h3';
  return (
    <li className="k-check" data-state={state} aria-labelledby={id} data-testid={testId}>
      <span className="k-check-mark k-mark" data-state={state}>
        <Shape state={state} />
      </span>
      <div className="k-check-main">
        <div className="k-check-head">
          <H id={id} className="k-check-title">
            {shown(title)}
          </H>
          <span className="k-check-word">{shown(word)}</span>
        </div>
        {children !== undefined && children !== null && children !== false && <div className="k-check-body">{shown(children)}</div>}
        {actions && <div className="k-check-actions">{shown(actions)}</div>}
      </div>
    </li>
  );
}
