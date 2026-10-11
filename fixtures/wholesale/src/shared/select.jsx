// Radix Select (opens on pointerdown — one of the quirks the runner's click strategies handle).

import * as Select from '@radix-ui/react-select';
import { Icon } from './icons.jsx';

/**
 * @param {{ id: string, label: string, value: string|undefined, onValueChange: (v: string) => void,
 *   placeholder?: string, options: Array<{ value: string, label: string, sub?: string, leading?: any }>, hint?: string }} props
 */
export function SelectField({ id, label, value, onValueChange, placeholder = 'Select…', options, hint }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <Select.Root value={value} onValueChange={onValueChange}>
        <Select.Trigger id={id} className="trigger">
          <span className="value">
            <Select.Value placeholder={placeholder} />
          </span>
          <Select.Icon className="chevron">
            <Icon name="chevronDown" size={16} />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content className="floating select-content" position="popper" sideOffset={6} collisionPadding={12}>
            <Select.Viewport>
              {options.map((o) => (
                <Select.Item key={o.value} value={o.value} className="select-item">
                  {o.leading}
                  <Select.ItemText>{o.label}</Select.ItemText>
                  {o.sub ? <span className="select-sub">{o.sub}</span> : null}
                  <Select.ItemIndicator className="select-check">
                    <Icon name="check" size={16} strokeWidth={2.2} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}
