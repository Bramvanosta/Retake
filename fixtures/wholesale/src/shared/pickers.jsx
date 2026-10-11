// Multi-select pickers: a trigger showing the selected values as chips and a popover with
// checkbox options (role=option, aria-selected) that STAYS OPEN for several picks.
// engine "base" = Base UI Popover (opens on click, portaled into the enclosing dialog and kept
// mounted while hidden, so several popovers coexist in the DOM); engine "radix" = Radix Popover.

import { Popover } from '@base-ui/react/popover';
import * as RPopover from '@radix-ui/react-popover';
import { useMemo, useState } from 'react';
import { useLayerContainer } from './dialog.jsx';
import { Icon } from './icons.jsx';

function fold(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function OptionList({ labelId, label, options, value, onChange, searchable, query, setQuery }) {
  const filtered = useMemo(() => (query ? options.filter((o) => fold(o).includes(fold(query))) : options), [options, query]);
  const toggle = (o) => onChange(value.includes(o) ? value.filter((x) => x !== o) : options.filter((x) => x === o || value.includes(x)));
  return (
    <>
      {searchable ? (
        <div className="picker-search">
          <div className="input-icon">
            <Icon name="search" size={16} />
            <input
              className="input"
              type="text"
              placeholder={`Search ${label.toLowerCase()}`}
              aria-label={`Search ${label.toLowerCase()}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>
      ) : null}
      <div className="picker-list" role="listbox" aria-multiselectable="true" aria-labelledby={labelId}>
        {filtered.map((o) => {
          const selected = value.includes(o);
          return (
            <div
              key={o}
              role="option"
              aria-selected={selected}
              tabIndex={-1}
              className="picker-option"
              onClick={() => toggle(o)}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  toggle(o);
                }
              }}
            >
              <span className="box">{selected ? <Icon name="check" size={13} strokeWidth={3} /> : null}</span>
              {o}
            </div>
          );
        })}
        {filtered.length === 0 ? <div className="picker-empty">No {label.toLowerCase()} match “{query}”</div> : null}
      </div>
      <div className="picker-footer">
        <span>{value.length} selected</span>
      </div>
    </>
  );
}

function TriggerContent({ value }) {
  const shown = value.slice(0, 4);
  return (
    <>
      <span className="value">
        {value.length === 0 ? <span className="placeholder">Select…</span> : null}
        {shown.map((v) => (
          <span key={v} className="chip chip-accent">
            {v}
          </span>
        ))}
        {value.length > shown.length ? <span className="chip">+{value.length - shown.length}</span> : null}
      </span>
      <Icon name="chevronDown" size={16} className="chevron" />
    </>
  );
}

/**
 * @param {{ id: string, label: string, options: string[], value: string[], onChange: (v: string[]) => void,
 *   searchable?: boolean, engine?: 'base'|'radix', hint?: string }} props
 */
export function MultiPicker({ id, label, options, value, onChange, searchable = false, engine = 'base', hint }) {
  const labelId = `${id}-label`;
  const [query, setQuery] = useState('');
  const container = useLayerContainer();
  const list = <OptionList {...{ labelId, label, options, value, onChange, searchable, query, setQuery }} />;
  const reset = (open) => {
    if (!open) setQuery('');
  };
  return (
    <div className="field picker-field" data-picker={engine}>
      <div className="field-label" id={labelId}>
        {label}
      </div>
      {engine === 'base' ? (
        <Popover.Root onOpenChange={reset}>
          <Popover.Trigger id={id} className="trigger" aria-labelledby={labelId}>
            <TriggerContent value={value} />
          </Popover.Trigger>
          <Popover.Portal container={container} keepMounted>
            <Popover.Positioner className="positioner" side="bottom" align="start" sideOffset={6} collisionPadding={12}>
              <Popover.Popup className="floating picker-pop" aria-labelledby={labelId}>
                {list}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ) : (
        <RPopover.Root onOpenChange={reset}>
          <RPopover.Trigger id={id} className="trigger" aria-labelledby={labelId}>
            <TriggerContent value={value} />
          </RPopover.Trigger>
          <RPopover.Portal>
            <RPopover.Content className="floating picker-pop" align="start" sideOffset={6} collisionPadding={12} aria-labelledby={labelId}>
              {list}
            </RPopover.Content>
          </RPopover.Portal>
        </RPopover.Root>
      )}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}
