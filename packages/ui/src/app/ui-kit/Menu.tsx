/**
 * L5.9: the menu button — a trigger (`aria-haspopup="menu"`, `aria-expanded`, `popoverTarget`: a click on the open
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
    const at = enabled.indexOf(i);
    let next = -1;
    if (e.key === 'ArrowDown') next = enabled[(at + 1) % enabled.length];
    else if (e.key === 'ArrowUp') next = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled.at(-1)!;
    else if (e.key === 'Tab' || e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      const order = [...enabled.slice(at + 1), ...enabled.slice(0, at + 1)];
      next = order.find((j) => entries[j].label.toLowerCase().startsWith(k)) ?? -1;
    }
    if (next >= 0) {
      e.preventDefault();
      focusAt(next);
    }
  };
  let n = -1;
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
        {items.map((item, k) => {
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
              onClick={() => {
                close();
                onSelect(item.id);
              }}
            >
              <span className="k-menu-label">
                <Txt text={item.label} />
              </span>
              {item.kbd && <Kbd keys={item.kbd} />}
            </button>
          );
        })}
      </div>
    </>
  );
}
