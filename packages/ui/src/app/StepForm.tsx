/**
 * The step's form in the inspector and the palette of new steps (L4.3 part 3, R-UI-12; L5.10b: on the kit, B32's step
 * inspector). Fields come from the scenario language's schemas (scenario_forms: text, numbers, yes / no, a choice, a
 * target's flat keys) in the inspector's row layout; a target's empty ways to find it fold under "Other ways to find it
 * (n)" and the empty optional fields under "More: …"; the modifiers (caption, hold, speed, mark) are switches — on shows
 * their fields, off empties them (Save then sends their removal: the same `set_step` changes). What a form cannot show
 * stays in the YAML view and is named. A save sends the changed fields only (`set_step`, each with the value the form
 * showed — critique B2), a new step its form values (`insert_step`); the server writes the file (a shorthand kept when
 * only its own value changes), validates it and refuses what agent trust refuses — a `{{env:…}}` or `{{keychain:…}}`
 * typed into a field, with the reason. The rules each field shows (a number, its bounds, a pattern) are checked here
 * before sending and again on the server (its issues come back at their fields).
 */
import { useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ActionName, FormField, SceneBlock, StepBlock, StepForms } from '@demo-studio/core';
import { Txt, shown, visibleControls } from './bits.js';
import { useUnsavedMark } from './drafts.js';
import { actionForm, fieldLabel, fieldWords, fieldsOf, formChanges, groupLabel, inputsOf, isRequired, issueField, readInputs } from './forms.js';
import type { Inputs } from './forms.js';
import type { StepEditor } from './StepEditing.js';
import type { FieldValue } from './step-edit.js';
import { Button, Callout, Disclosure, Select, Switch, TextField } from './ui-kit/index.js';

/** One field's input in the inspector's row: a text box, a yes / no / not set choice, or a choice of its options. */
function FieldInput({ f, value, onChange, required, error, disabled, locked }: { f: FormField; value: string; onChange: (v: string) => void; required: boolean; error?: string; disabled: boolean; locked?: string }) {
  const name = f.group !== undefined ? f.key.slice(f.group.length + 1).replace(/_/g, ' ') : f.label;
  const label = (
    <>
      {shown(fieldLabel(name))}
      {required && <span className="sc-quiet">{' (required)'}</span>}
    </>
  );
  // The error said in words at its field (the kit adds "Error:"); the test id kept from L4.3.
  const err = error !== undefined ? (
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
    return <Select layout="row" label={label} value={value} options={options} onChange={onChange} disabled={disabled || locked !== undefined} hint={hint} error={err} dataField={f.key} title={f.description} />;
  }
  return (
    <TextField
      layout="row"
      label={label}
      value={value}
      onChange={onChange}
      // The form owns its unsaved mark (StepForm's useUnsavedMark): the quit question never lists a field twice (critique M5).
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
function Fields({
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
            <Disclosure key={`g-${p.group}`} defaultOpen={set || p.group === action || p.group === 'caption'} summary={`${groupLabel(p.group, action)}${target ? ' (a target: fill one way to find it)' : ''}`}>
              <div className="sb-fields">{shown(split(p.fields, p.group, String(i)))}</div>
            </Disclosure>
          );
        })}
      </div>
      {byMod.size > 0 && (
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
      )}
    </>
  );
}

/**
 * The selected step's form (inspector). Its values reset when the step changes on disk (its guard); a step changed
 * meanwhile while the form held changes is said, with what was typed (to copy: review B).
 */
export function StepForm({ slug, name, forms, scene, step, ed }: { slug: string; name: string; forms: StepForms; scene: SceneBlock; step: StepBlock; ed: StepEditor }) {
  const idBase = useId().replace(/:/g, '');
  const form = step.form;
  const fields = useMemo(() => (form ? fieldsOf(forms, form.action) : []), [forms, form]);
  const shownInputs = useMemo(() => (form ? inputsOf(fields, form.values) : {}), [fields, form]);
  const [inputs, setInputs] = useState<Inputs>(shownInputs);
  const [base, setBase] = useState({ key: step.key, guard: step.guard });
  /** What was typed when the step changed on disk (field words and text), or null. */
  const [changedOnDisk, setChangedOnDisk] = useState<string[] | null>(null);
  const typed = fields.filter((f) => (inputs[f.key] ?? '') !== (shownInputs[f.key] ?? ''));
  const dirty = typed.length > 0;
  // L5.2b: typed fields are unsaved text the desktop app's quit question names.
  useUnsavedMark(dirty ? { kind: 'step_form', project: slug, scenario: name } : null);
  // A new step selected, or this one changed on disk (our own save included): the form shows its values.
  useEffect(() => {
    if (base.key === step.key && base.guard === step.guard) return;
    setChangedOnDisk(base.key === step.key && dirty && !ed.busy ? typed.map((f) => `${fieldWords(f.key)}: ${inputs[f.key] === '' ? '(empty)' : inputs[f.key]}`) : null);
    setBase({ key: step.key, guard: step.guard });
    setInputs(shownInputs);
  }, [step.key, step.guard, shownInputs, base, dirty, ed.busy, typed, inputs]);
  if (!form) return null;
  const lockedSet = new Set(Object.keys(form.locked));
  const { values, errors } = readInputs(fields, inputs, lockedSet, form.values);
  const changes = formChanges(fields, form.values, values, lockedSet, { inputs, shown: shownInputs });
  // The modifiers follow the action's own fields (a hold step's `hold` is its argument, not the modifier).
  const own = actionForm(forms, form.action)?.fields.length ?? 0;
  const modifiersFrom = fields.length > own ? own : -1;
  // The server's refusal of this step's form, at its field.
  const refused = ed.error?.op?.kind === 'set_step' && ed.error.op.at.scene === scene.id && ed.error.op.at.index === step.index ? ed.error : null;
  const serverErrors: Record<string, string> = {};
  if (refused) {
    if (refused.field !== undefined) serverErrors[refused.field] = refused.message.replace(/^not saved: /, '');
    for (const i of refused.issues) {
      const k = issueField(i.path, scene.index, step.index, fields);
      if (k !== undefined && i.severity === 'error' && serverErrors[k] === undefined) serverErrors[k] = i.message;
    }
  }
  const shownErrors = { ...serverErrors, ...Object.fromEntries(Object.entries(errors).filter(([k]) => (inputs[k] ?? '') !== (shownInputs[k] ?? '') || serverErrors[k] === undefined)) };
  const canEdit = ed.enabled && !ed.busy && step.locked === undefined;
  const invalid = Object.keys(errors).length > 0;
  const save = () => {
    if (!canEdit || invalid || changes.length === 0 || step.guard === undefined) return;
    setChangedOnDisk(null);
    ed.send({ kind: 'set_step', at: { scene: scene.id, index: step.index, guard: step.guard }, changes });
  };
  return (
    <form
      className="sb-form"
      data-testid="step-form"
      aria-labelledby={`${idBase}-h`}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <h4 id={`${idBase}-h`} className="sb-h4">
        Action
      </h4>
      {changedOnDisk && (
        <Callout state="warn" role="alert" title="This step changed on disk">
          <p>The form now shows its new values; your changes were not saved:</p>
          <ul data-testid="form-dropped">
            {changedOnDisk.map((t, i) => (
              <li key={i}>
                <Txt text={t} />
              </li>
            ))}
          </ul>
        </Callout>
      )}
      {/* Keyed by the step: a modifier switched on for one step is not on for the next. */}
      <Fields
        key={step.key}
        fields={fields}
        stepAction={form.action}
        inputs={inputs}
        setInput={(k, v) => setInputs((cur) => ({ ...cur, [k]: v }))}
        errors={shownErrors}
        disabled={!canEdit}
        locked={form.locked}
        modifiersFrom={modifiersFrom}
        fold={shownInputs}
      />
      {form.yaml_only.length > 0 && (
        <p className="sc-quiet" data-testid="yaml-only">
          {'Also in this step, edited in the YAML view: '}
          <Txt className="k-mono" text={form.yaml_only.join(', ')} />
        </p>
      )}
      <div className="sb-actions">
        <Button submit size="sm" variant="primary" disabled={!canEdit || invalid || changes.length === 0} data-testid="form-save">
          {shown(changes.length ? `Save ${changes.length === 1 ? fieldWords(changes[0].path.join('.')) : `${changes.length} changes`}` : 'Save')}
        </Button>
        <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setInputs(shownInputs)}>
          Reset
        </Button>
      </div>
    </form>
  );
}

/** Where a new step can go: after the selected step, or at the start / end of a scene. */
interface Place {
  label: string;
  scene: string;
  index: number;
  after: string | null;
}

function placesOf(scenes: SceneBlock[], selected: { scene: SceneBlock; step: StepBlock } | null): Place[] {
  const out: Place[] = [];
  if (selected && selected.step.guard !== undefined) {
    out.push({ label: `After step ${selected.step.index + 1} of ${selected.scene.id} (the selected step)`, scene: selected.scene.id, index: selected.step.index + 1, after: selected.step.guard });
  }
  for (const s of scenes) {
    if (s.steps_locked !== undefined) continue;
    const last = s.steps[s.steps.length - 1];
    out.push({ label: `At the end of ${s.id}`, scene: s.id, index: s.steps.length, after: last?.guard ?? null });
    if (s.steps.length > 0) out.push({ label: `At the start of ${s.id}`, scene: s.id, index: 0, after: null });
  }
  return out;
}

/**
 * The palette (critique C3): ≈ 15 actions; one chosen shows its form with the schema's defaults; Add inserts it. L5.10b:
 * a scene's "Add step" opens it placed at that scene's end (`at`).
 */
export function Palette({ forms, scenes, selected, ed, onClose, at }: { forms: StepForms; scenes: SceneBlock[]; selected: { scene: SceneBlock; step: StepBlock } | null; ed: StepEditor; onClose: () => void; at?: string }) {
  const idBase = useId().replace(/:/g, '');
  const [action, setAction] = useState<ActionName | null>(null);
  const form = action ? actionForm(forms, action) : undefined;
  const fields = form?.fields ?? [];
  const [inputs, setInputs] = useState<Inputs>({});
  const places = placesOf(scenes, selected);
  const [place, setPlace] = useState(() => Math.max(0, at === undefined ? 0 : places.findIndex((p) => p.scene === at && p.label.startsWith('At the end'))));
  const [touched, setTouched] = useState(false);
  const pick = (a: ActionName) => {
    const f = actionForm(forms, a);
    setAction(a);
    setTouched(false);
    setInputs(f ? Object.fromEntries(f.fields.map((x) => [x.key, f.defaults[x.key] === undefined ? '' : String(f.defaults[x.key])])) : {});
  };
  const { values, errors } = readInputs(fields, inputs);
  const empty = Object.keys(values).length === 0;
  const where = places[Math.min(place, places.length - 1)];
  const canAdd = ed.enabled && !ed.busy && !!form && !!where && Object.keys(errors).length === 0 && !empty;
  const refused = ed.error?.op?.kind === 'insert_step' ? ed.error : null;
  const serverErrors: Record<string, string> = refused?.field !== undefined ? { [refused.field]: refused.message.replace(/^not saved: /, '') } : {};
  const add = () => {
    setTouched(true);
    if (!canAdd || !form || !where) return;
    ed.send({ kind: 'insert_step', to: { scene: where.scene, index: where.index }, after: where.after, action: form.action, values: values as Record<string, FieldValue> });
  };
  const titleId = `${idBase}-palette`;
  return (
    <section className="sb-palette" aria-labelledby={titleId} data-testid="palette">
      <div className="sb-palette-head">
        <h2 id={titleId} className="sc-h2">
          Add a step
        </h2>
        <Button size="sm" variant="ghost" icon="close" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="sb-palette-actions" role="group" aria-label="Actions">
        {forms.palette.map((a) => (
          <Button key={a} size="sm" variant={action === a ? 'primary' : 'secondary'} aria-pressed={action === a} onClick={() => pick(a)} data-palette={a}>
            {shown(a.replace(/_/g, ' '))}
          </Button>
        ))}
      </div>
      {form && (
        <form
          className="sb-form"
          data-testid="palette-form"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <p className="sc-quiet">
            <Txt text={form.description} />
          </p>
          <Fields
            fields={fields}
            stepAction={form.action}
            inputs={inputs}
            setInput={(k, v) => setInputs((cur) => ({ ...cur, [k]: v }))}
            errors={{ ...(touched ? errors : Object.fromEntries(Object.entries(errors).filter(([k]) => (inputs[k] ?? '') !== ''))), ...serverErrors }}
            disabled={!ed.enabled || ed.busy}
            locked={{}}
            modifiersFrom={-1}
          />
          <Select layout="row" label="Where" testId="palette-where" value={String(Math.min(place, places.length - 1))} options={places.map((p, i) => ({ value: String(i), label: p.label }))} onChange={(v) => setPlace(Number(v))} />
          {touched && empty && (
            <p className="sb-error" role="alert">
              Fill at least one value.
            </p>
          )}
          <div className="sb-actions">
            <Button submit size="sm" variant="primary" disabled={!ed.enabled || ed.busy || !where} data-testid="palette-add">
              {shown(`Add the ${form.action.replace(/_/g, ' ')} step`)}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
