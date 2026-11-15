/**
 * A step form's fields (StepForm.tsx holds the inspector's form and the palette): each field's input in the inspector's
 * row, the arguments (a target's fields grouped, the empty optional ones folded) and the modifiers as switches.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ActionName } from '@retake/core/language';
import type { FormField } from '@retake/core/scenario';
import { Txt, shown, visibleControls } from '../bits.js';
import { fieldLabel, groupLabel, isRequired } from './forms.js';
import type { Inputs } from './forms.js';
import { Disclosure, Select, Switch, TextField } from '../ui-kit/index.js';

/** One field's input in the inspector's row: a text box, a yes / no / not set choice, or a choice of its options. */
function FieldInput({
  f,
  value,
  onChange,
  required,
  error,
  disabled,
  locked,
}: {
  f: FormField;
  value: string;
  onChange: (v: string) => void;
  required: boolean;
  error?: string;
  disabled: boolean;
  locked?: string;
}) {
  const name = f.group !== undefined ? f.key.slice(f.group.length + 1).replace(/_/g, ' ') : f.label;
  const label = (
    <>
      {shown(fieldLabel(name))}
      {required && <span className="sc-quiet">{' (required)'}</span>}
    </>
  );
  // The error said in words at its field (the kit adds "Error:").
  const err =
    error !== undefined ? (
      <span data-testid="field-error">
        <Txt text={error} />
      </span>
    ) : undefined;
  const hint = locked !== undefined ? <Txt text={locked} /> : undefined;
  if (f.kind === 'boolean' || f.kind === 'enum') {
    const options = [
      ...(!required ? [{ value: '', label: 'not set' }] : value === '' ? [{ value: '', label: 'choose…' }] : []),
      ...(f.kind === 'boolean'
        ? [
            { value: 'true', label: 'yes' },
            { value: 'false', label: 'no' },
          ]
        : (f.options ?? []).map((o) => ({ value: o, label: o }))),
    ];
    return (
      <Select
        layout="row"
        label={label}
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled || locked !== undefined}
        hint={hint}
        error={err}
        dataField={f.key}
        title={f.description}
      />
    );
  }
  return (
    <TextField
      layout="row"
      label={label}
      value={value}
      onChange={onChange}
      // The form owns its unsaved mark (StepForm's useUnsavedMark): the quit question never lists a field twice.
      unsaved={null}
      disabled={disabled || locked !== undefined}
      hint={hint}
      error={err}
      dataField={f.key}
      title={f.description}
      inputMode={f.kind === 'text' ? undefined : f.kind === 'integer' ? 'numeric' : 'decimal'}
      spellCheck={f.kind === 'text' ? undefined : false}
      autoComplete="off"
    />
  );
}

/** The modifiers a form edits (core MODIFIER_KEYS: the page imports no runtime code from core). */
const MODIFIERS = ['caption', 'hold', 'speed', 'mark'] as const;
type Modifier = (typeof MODIFIERS)[number];
const MODIFIER_LABEL: Record<Modifier, string> = { caption: 'Caption', hold: 'Hold', speed: 'Speed', mark: 'Mark' };
const MODIFIER_OFF: Record<Modifier, string> = { caption: 'No caption on this step', hold: 'No hold after it', speed: 'Normal speed', mark: 'No mark for the edit' };

/** The modifier a field belongs to ("caption.text" → caption), or undefined for an argument. */
function modifierOf(f: FormField): Modifier | undefined {
  const top = f.key.split('.')[0];
  return (MODIFIERS as readonly string[]).includes(top) ? (top as Modifier) : undefined;
}

/**
 * The fields of a form: the arguments (a target's fields grouped, folded while empty), then the modifiers as switches.
 * In the inspector (`fold`: the values on disk) the empty optional fields fold under "More: …" (a set target's empty
 * keys under "Other ways to find it"), decided by the file's values so a field never moves while it is typed in.
 */
export function Fields({
  fields,
  stepAction: action,
  inputs,
  setInput,
  errors,
  disabled,
  locked,
  modifiersFrom,
  fold,
}: {
  fields: FormField[];
  stepAction: ActionName;
  inputs: Inputs;
  setInput: (k: string, v: string) => void;
  errors: Record<string, string>;
  disabled: boolean;
  locked: Record<string, string>;
  /** Index of the first modifier field, or -1 (the palette: no modifiers). */
  modifiersFrom: number;
  fold?: Inputs;
}) {
  // A modifier switched on with its fields still empty (shown until switched off; the form is keyed by its step).
  const [opened, setOpened] = useState<ReadonlySet<Modifier>>(new Set());
  const args = modifiersFrom >= 0 ? fields.slice(0, modifiersFrom) : fields;
  const mods = modifiersFrom >= 0 ? fields.slice(modifiersFrom) : [];
  const parts: Array<{ group?: string; fields: FormField[] }> = [];
  for (const f of args) {
    const last = parts[parts.length - 1];
    if (last && last.group === f.group) last.fields.push(f);
    else parts.push({ ...(f.group !== undefined ? { group: f.group } : {}), fields: [f] });
  }
  const one = (f: FormField) => (
    <FieldInput
      key={f.key}
      f={f}
      value={inputs[f.key] ?? ''}
      onChange={(v) => setInput(f.key, v)}
      required={isRequired(f, fields, inputs)}
      {...(errors[f.key] !== undefined ? { error: errors[f.key] } : {})}
      disabled={disabled}
      {...(locked[f.key] !== undefined ? { locked: locked[f.key] } : {})}
    />
  );
  const onDisk = (f: FormField) => (fold?.[f.key] ?? '') !== '';
  /** A part's fields: those shown, then the empty optional ones folded (two or more; the fold's state is the person's). */
  const split = (fs: FormField[], group: string | undefined, key: string): ReactNode[] => {
    if (!fold || (group !== undefined && !fs.some(onDisk))) return fs.map(one);
    const keep = (f: FormField) => onDisk(f) || locked[f.key] !== undefined || isRequired(f, fields, fold);
    const more = fs.filter((f) => !keep(f));
    if (more.length < 2) return fs.map(one);
    const words = more.map((f) => (f.group !== undefined ? f.key.slice(f.group.length + 1) : f.label).replace(/_/g, ' '));
    return [
      ...fs.filter(keep).map(one),
      <Disclosure key={`more-${key}`} testId="form-more" summary={group !== undefined ? `Other ways to find it (${more.length})` : `More: ${words.join(', ')}`}>
        <div className="sb-fields">{more.map(one)}</div>
      </Disclosure>,
    ];
  };
  const byMod = new Map<Modifier, FormField[]>();
  for (const f of mods) {
    const m = modifierOf(f);
    if (m) byMod.set(m, [...(byMod.get(m) ?? []), f]);
  }
  return (
    <>
      <div className="sb-fields">
        {parts.map((p, i) => {
          if (p.group === undefined) return split(p.fields, undefined, String(i));
          const set = p.fields.some((f) => (inputs[f.key] ?? '') !== '' || errors[f.key] !== undefined || locked[f.key] !== undefined);
          const target = p.group !== action && p.group !== 'caption';
          return (
            <Disclosure
              key={`g-${p.group}`}
              defaultOpen={set || p.group === action || p.group === 'caption'}
              summary={`${groupLabel(p.group, action)}${target ? ' (a target: fill one way to find it)' : ''}`}
            >
              <div className="sb-fields">{shown(split(p.fields, p.group, String(i)))}</div>
            </Disclosure>
          );
        })}
      </div>
      {byMod.size > 0 && <ModifierSwitches byMod={byMod} inputs={inputs} errors={errors} locked={locked} disabled={disabled} opened={opened} setOpened={setOpened} setInput={setInput} one={one} />}
    </>
  );
}

/** The modifiers as switches: on shows their fields (a switch turned on stays on while they are empty), off empties them. */
function ModifierSwitches({
  byMod,
  inputs,
  errors,
  locked,
  disabled,
  opened,
  setOpened,
  setInput,
  one,
}: {
  byMod: Map<Modifier, FormField[]>;
  inputs: Inputs;
  errors: Record<string, string>;
  locked: Record<string, string>;
  disabled: boolean;
  opened: ReadonlySet<Modifier>;
  setOpened: (f: (cur: ReadonlySet<Modifier>) => ReadonlySet<Modifier>) => void;
  setInput: (k: string, v: string) => void;
  one: (f: FormField) => ReactNode;
}) {
  return (
    <div className="sb-fields">
      <h4 className="sb-h4">Modifiers</h4>
      {[...byMod].map(([m, fs]) => {
        const filled = fs.some((f) => (inputs[f.key] ?? '') !== '');
        const on = filled || opened.has(m) || fs.some((f) => errors[f.key] !== undefined);
        const value = fs
          .map((f) => inputs[f.key] ?? '')
          .filter(Boolean)
          .join(' · ');
        return (
          <div key={m} className="sb-modifier">
            <Switch
              layout="row"
              label={MODIFIER_LABEL[m]}
              hint={on ? (value ? visibleControls(value) : 'On: fill its value below') : MODIFIER_OFF[m]}
              checked={on}
              disabled={disabled || fs.some((f) => locked[f.key] !== undefined)}
              dataField={m}
              onChange={(next) => {
                setOpened((cur) => {
                  const s = new Set(cur);
                  if (next) s.add(m);
                  else s.delete(m);
                  return s;
                });
                if (!next) for (const f of fs) setInput(f.key, '');
              }}
            />
            {on && <div className="sb-fields">{fs.map(one)}</div>}
          </div>
        );
      })}
    </div>
  );
}
