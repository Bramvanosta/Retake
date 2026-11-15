/**
 * The menu button — a trigger (`aria-haspopup="menu"`, `aria-expanded`, `popoverTarget`: a click on the open
 * trigger closes it, never re-opens it) and a `popover="auto"` list (`role="menu"`: the top layer, light dismiss and
 * Escape from the platform) of `role="menuitem"` buttons with one roving tab stop. Enter / Space / ↓ open it on the first
 * item, ↑ on the last; ↓ ↑ Home End move, a letter jumps to the next item starting with it; Enter / Space choose; Escape
 * and Tab close it; the focus goes back to the trigger.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Icon } from './Icon.js';
import type { IconName } from './Icon.js';
import { Kbd } from './Button.js';
import { followTrigger } from './popover.js';
import { Txt, shown } from '../bits.js';

export interface MenuEntry {
  id: string;
  label: string;
  kbd?: string[];
  disabled?: boolean;
  danger?: boolean;
}
export type MenuItemDef = MenuEntry | 'separator';

/** Where a key on the item at `at` (of the enabled ones) moves the focus: an item's index (-1: nowhere), or `close` (Tab, Escape). */
function itemKeyTarget(key: string, at: number, enabled: number[], entries: MenuEntry[]): number | 'close' {
  if (key === 'ArrowDown') return enabled[(at + 1) % enabled.length];
  if (key === 'ArrowUp') return enabled[(at - 1 + enabled.length) % enabled.length];
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled.at(-1)!;
  if (key === 'Tab' || key === 'Escape') return 'close';
  if (key.length === 1 && /\S/.test(key)) {
    const k = key.toLowerCase();
    const order = [...enabled.slice(at + 1), ...enabled.slice(0, at + 1)];
    return order.find((j) => entries[j].label.toLowerCase().startsWith(k)) ?? -1;
  }
  return -1;
}

export function Menu({ label, icon, text, items, onSelect }: { label: string; icon?: IconName; text?: ReactNode; items: MenuItemDef[]; onSelect: (id: string) => void }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const firstOnOpen = useRef<'first' | 'last'>('first');
  const entries = items.filter((i): i is MenuEntry => i !== 'separator');
  const enabled = entries.map((e, i) => (e.disabled ? -1 : i)).filter((i) => i >= 0);
  const enabledNow = useRef(enabled);
  enabledNow.current = enabled;

  useEffect(() => {
    const el = pop.current;
    if (!el) return;
    let unfollow: (() => void) | undefined;
    const onToggle = (e: Event) => {
      const now = (e as ToggleEvent).newState === 'open';
      setOpen(now);
      unfollow?.();
      unfollow = undefined;
      if (now && trigger.current) {
        unfollow = followTrigger(trigger.current, el);
        const start = firstOnOpen.current === 'last' ? enabledNow.current.at(-1) : enabledNow.current[0];
        firstOnOpen.current = 'first';
        if (start !== undefined) {
          setActive(start);
          el.querySelectorAll<HTMLElement>('[role="menuitem"]')[start]?.focus();
        }
      }
    };
    el.addEventListener('toggle', onToggle);
    return () => {
      el.removeEventListener('toggle', onToggle);
      unfollow?.();
    };
  }, []);

  const close = () => {
    pop.current?.hidePopover();
    trigger.current?.focus();
  };
  const focusAt = (i: number) => {
    setActive(i);
    pop.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[i]?.focus();
  };
  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
      e.preventDefault();
      firstOnOpen.current = e.key === 'ArrowUp' ? 'last' : 'first';
      pop.current?.showPopover();
    }
  };
  const onItemKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = itemKeyTarget(e.key, enabled.indexOf(i), enabled, entries);
    if (next === 'close') {
      e.preventDefault();
      close();
      return;
    }
    if (next >= 0) {
      e.preventDefault();
      focusAt(next);
    }
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={text ? 'k-btn k-btn-ghost k-btn-md' : 'k-iconbtn k-iconbtn-md'}
        aria-label={text ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
        onKeyDown={onTriggerKey}
      >
        {icon && <Icon name={icon} />}
        {text && <span className="k-btn-label">{shown(text)}</span>}
        {text && <Icon name="chevron-down" />}
      </button>
      <div ref={pop} id={id} popover="auto" role="menu" aria-label={label} className="k-menu">
        <MenuItems
          items={items}
          active={active}
          onItemKey={onItemKey}
          onChoose={(itemId) => {
            close();
            onSelect(itemId);
          }}
        />
      </div>
    </>
  );
}

/** The menu's items (one roving tab stop: the active one) and its separators. */
function MenuItems({
  items,
  active,
  onItemKey,
  onChoose,
}: {
  items: MenuItemDef[];
  active: number;
  onItemKey: (e: KeyboardEvent<HTMLButtonElement>, i: number) => void;
  onChoose: (id: string) => void;
}) {
  let n = -1;
  return (
    <>
      {items.map((item, k) => {
        // biome-ignore lint/suspicious/noArrayIndexKey: a separator has no identity but its place in the caller's fixed item list
        // biome-ignore lint/a11y/useSemanticElements: a menu's separator: <hr> brings its own margins and border, and role=separator is what a menu allows
        if (item === 'separator') return <div key={`sep-${k}`} role="separator" className="k-menu-sep" />;
        const i = ++n;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={item.danger ? 'k-menu-item is-danger' : 'k-menu-item'}
            tabIndex={i === active ? 0 : -1}
            disabled={item.disabled}
            onKeyDown={(e) => onItemKey(e, i)}
            onClick={() => onChoose(item.id)}
          >
            <span className="k-menu-label">
              <Txt text={item.label} />
            </span>
            {item.kbd && <Kbd keys={item.kbd} />}
          </button>
        );
      })}
    </>
  );
}
