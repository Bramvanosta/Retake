/**
 * The step's form in the inspector and the palette of new steps (L4.3 part 3, R-UI-12). Fields come from the scenario
 * language's schemas (scenario_forms: text, numbers, yes / no, a choice, a target's flat keys); what a form cannot show
 * stays in the YAML tab and is named. A save sends the changed fields only (`set_step`, each with the value the form
 * showed — critique B2), a new step its form values (`insert_step`); the server writes the file (a shorthand kept when
 * only its own value changes), validates it and refuses what agent trust refuses — a `{{env:…}}` or `{{keychain:…}}`
 * typed into a field, with the reason. The rules each field shows (a number, its bounds, a pattern) are checked here
 * before sending and again on the server (its issues come back at their fields).
 */
import { useEffect, useId, useMemo, useState } from 'react';
import type { ActionName, FormField, SceneBlock, StepBlock, StepForms } from '@demo-studio/core';
import { Notice, Txt } from './bits.js';
import { actionForm, fieldWords, fieldsOf, formChanges, groupLabel, inputsOf, isRequired, issueField, readInputs } from './forms.js';
import type { Inputs } from './forms.js';
import type { StepEditor } from './StepEditing.js';
import type { FieldValue } from './step-edit.js';

/** One field's input: a text box, a yes / no / not set choice, or a choice of its options. */
function FieldInput({
  f,
  value,
  onChange,
  required,
  error,
  disabled,
  locked,
  idBase,
}: {
  f: FormField;
  value: string;
  onChange: (v: string) => void;
  required: boolean;
  error?: string;
  disabled: boolean;
  locked?: string;
  idBase: string;
}) {
  const id = `${idBase}-${f.key.replace(/\./g, '-')}`;
  const errId = `${id}-err`;
  const label = f.group !== undefined ? f.key.slice(f.group.length + 1).replace(/_/g, ' ') : f.label;
  const common = {
    id,
    disabled: disabled || locked !== undefined,
    'aria-invalid': error !== undefined ? true : undefined,
    'aria-describedby': error !== undefined ? errId : locked !== undefined ? `${id}-locked` : undefined,
    'data-field': f.key,
    title: f.description,
  } as const;
  let input;
  if (f.kind === 'boolean' || f.kind === 'enum') {
    input = (
      <select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
        {!required && <option value="">not set</option>}
        {required && value === '' && <option value="">choose…</option>}
        {f.kind === 'boolean' ? (
          <>
            <option value="true">yes</option>
            <option value="false">no</option>
          </>
        ) : (
          (f.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))
        )}
      </select>
    );
  } else {
    input = (
      <input
        {...common}
        type="text"
        inputMode={f.kind === 'text' ? undefined : f.kind === 'integer' ? 'numeric' : 'decimal'}
        spellCheck={f.kind === 'text' ? undefined : false}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div className={`form-field${error !== undefined ? ' has-error' : ''}`}>
      <label htmlFor={id}>
        <span className="mono">{label}</span>
        {required && <span className="muted small"> (required)</span>}
      </label>
      {input}
      {locked !== undefined && (
        <p id={`${id}-locked`} className="muted small">
          <Txt text={locked} />
        </p>
      )}
      {error !== undefined && (
        <p id={errId} className="field-error small" data-testid="field-error">
          <Txt text={error} />
        </p>
      )}
    </div>
  );
}

/**
 * The fields of a form, a target's fields grouped (folded while empty), the modifiers after the arguments; in the
 * inspector the empty optional fields fold under "More: …" (a click has 17 fields, most of them unset).
 */
function Fields({
  fields,
  stepAction: action,
  inputs,
  setInput,
  errors,
  disabled,
  locked,
  idBase,
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
  idBase: string;
  /** Index of the first modifier field (a heading before it), or -1. */
  modifiersFrom: number;
  /**
   * The values on disk (the inspector): empty optional fields fold under "More: …" (a set target's empty keys under
   * "Other ways to find it"), decided by the file's values so a field never moves while it is typed in.
   */
  fold?: Inputs;
}) {
  const parts: Array<{ group?: string; fields: FormField[]; modifiers: boolean }> = [];
  fields.forEach((f, i) => {
    const modifiers = modifiersFrom >= 0 && i >= modifiersFrom;
    const last = parts[parts.length - 1];
    if (last && last.group === f.group && last.modifiers === modifiers) last.fields.push(f);
    else parts.push({ ...(f.group !== undefined ? { group: f.group } : {}), fields: [f], modifiers });
  });
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
      idBase={idBase}
    />
  );
  const onDisk = (f: FormField) => (fold?.[f.key] ?? '') !== '';
  /**
   * A part's fields: those shown, then the empty optional ones folded (two or more). The fold's open state is the
   * person's (never closed under a field being typed in).
   */
  const split = (fs: FormField[], group: string | undefined, key: string) => {
    if (!fold || (group !== undefined && !fs.some(onDisk))) return fs.map(one);
    const keep = (f: FormField) => onDisk(f) || locked[f.key] !== undefined || isRequired(f, fields, fold);
    const more = fs.filter((f) => !keep(f));
    if (more.length < 2) return fs.map(one);
    const target = group !== undefined && group !== 'caption';
    const words = more.map((f) => (f.group !== undefined ? f.key.slice(f.group.length + 1) : f.label).replace(/_/g, ' '));
    return [
      ...fs.filter(keep).map(one),
      <details key={`more-${key}`} className="form-more" data-testid="form-more">
        <summary className="small">{target ? `Other ways to find it (${more.length})` : `More: ${words.join(', ')}`}</summary>
        <div className={group !== undefined ? 'form-group-fields' : 'form-more-fields'}>{more.map(one)}</div>
      </details>,
    ];
  };
  let shownModifiers = false;
  return (
    <>
      {parts.map((p, i) => {
        const head = p.modifiers && !shownModifiers ? ((shownModifiers = true), <h4 key={`h-${i}`} className="form-sub">Modifiers</h4>) : null;
        if (p.group === undefined) return [head, ...split(p.fields, undefined, String(i))];
        const set = p.fields.some((f) => (inputs[f.key] ?? '') !== '' || errors[f.key] !== undefined || locked[f.key] !== undefined);
        return [
          head,
          <details key={`g-${p.group}`} className="form-group" open={set || p.group === action || p.group === 'caption' ? true : undefined}>
            <summary>
              <span className="mono">{groupLabel(p.group, action)}</span>
              {p.group !== action && p.group !== 'caption' && <span className="muted small"> (a target: fill one way to find it)</span>}
            </summary>
            <div className="form-group-fields">{split(p.fields, p.group, String(i))}</div>
          </details>,
        ];
      })}
    </>
  );
}

/**
 * The selected step's form (inspector). Its values reset when the step changes on disk (its guard); a step changed
 * meanwhile while the form held changes is said, with what was typed (to copy: review B).
 */
export function StepForm({ forms, scene, step, ed }: { forms: StepForms; scene: SceneBlock; step: StepBlock; ed: StepEditor }) {
  const idBase = useId().replace(/:/g, '');
  const form = step.form;
  const fields = useMemo(() => (form ? fieldsOf(forms, form.action) : []), [forms, form]);
  const shown = useMemo(() => (form ? inputsOf(fields, form.values) : {}), [fields, form]);
  const [inputs, setInputs] = useState<Inputs>(shown);
  const [base, setBase] = useState({ key: step.key, guard: step.guard });
  /** What was typed when the step changed on disk (field words and text), or null. */
  const [changedOnDisk, setChangedOnDisk] = useState<string[] | null>(null);
  const typed = fields.filter((f) => (inputs[f.key] ?? '') !== (shown[f.key] ?? ''));
  const dirty = typed.length > 0;
  // A new step selected, or this one changed on disk (our own save included): the form shows its values.
  useEffect(() => {
    if (base.key === step.key && base.guard === step.guard) return;
    setChangedOnDisk(base.key === step.key && dirty && !ed.busy ? typed.map((f) => `${fieldWords(f.key)}: ${inputs[f.key] === '' ? '(empty)' : inputs[f.key]}`) : null);
    setBase({ key: step.key, guard: step.guard });
    setInputs(shown);
  }, [step.key, step.guard, shown, base, dirty, ed.busy, typed, inputs]);
  if (!form) return null;
  const lockedSet = new Set(Object.keys(form.locked));
  const { values, errors } = readInputs(fields, inputs, lockedSet, form.values);
  const changes = formChanges(fields, form.values, values, lockedSet, { inputs, shown });
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
  const shownErrors = { ...serverErrors, ...Object.fromEntries(Object.entries(errors).filter(([k]) => (inputs[k] ?? '') !== (shown[k] ?? '') || serverErrors[k] === undefined)) };
  const canEdit = ed.enabled && !ed.busy && step.locked === undefined;
  const invalid = Object.keys(errors).length > 0;
  const save = () => {
    if (!canEdit || invalid || changes.length === 0 || step.guard === undefined) return;
    setChangedOnDisk(null);
    ed.send({ kind: 'set_step', at: { scene: scene.id, index: step.index, guard: step.guard }, changes });
  };
  return (
    <form
      className="step-form"
      data-testid="step-form"
      aria-labelledby={`${idBase}-h`}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <h3 id={`${idBase}-h`} className="inspector-sub">
        Edit this step
      </h3>
      {changedOnDisk && (
        <Notice tone="warning" role="alert" title="This step changed on disk">
          <p>The form now shows its new values; your changes were not saved:</p>
          <ul className="small" data-testid="form-dropped">
            {changedOnDisk.map((t, i) => (
              <li key={i}>
                <Txt text={t} />
              </li>
            ))}
          </ul>
        </Notice>
      )}
      <Fields
        fields={fields}
        stepAction={form.action}
        inputs={inputs}
        setInput={(k, v) => setInputs((cur) => ({ ...cur, [k]: v }))}
        errors={shownErrors}
        disabled={!canEdit}
        locked={form.locked}
        idBase={idBase}
        modifiersFrom={modifiersFrom}
        fold={shown}
      />
      {form.yaml_only.length > 0 && (
        <p className="muted small" data-testid="yaml-only">
          Also in this step, edited in the YAML tab: <Txt className="mono" text={form.yaml_only.join(', ')} />
        </p>
      )}
      <p className="form-actions">
        <button type="submit" className="button small primary" disabled={!canEdit || invalid || changes.length === 0} data-testid="form-save">
          {changes.length ? `Save ${changes.length === 1 ? fieldWords(changes[0].path.join('.')) : `${changes.length} changes`}` : 'Save'}
        </button>{' '}
        <button type="button" className="button small quiet" disabled={!dirty} onClick={() => setInputs(shown)}>
          Reset
        </button>
      </p>
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

/** The palette (critique C3): ≈ 15 actions; one chosen shows its form with the schema's defaults; Add inserts it. */
export function Palette({ forms, scenes, selected, ed, onClose }: { forms: StepForms; scenes: SceneBlock[]; selected: { scene: SceneBlock; step: StepBlock } | null; ed: StepEditor; onClose: () => void }) {
  const idBase = useId().replace(/:/g, '');
  const [action, setAction] = useState<ActionName | null>(null);
  const form = action ? actionForm(forms, action) : undefined;
  const fields = form?.fields ?? [];
  const [inputs, setInputs] = useState<Inputs>({});
  const places = placesOf(scenes, selected);
  const [place, setPlace] = useState(0);
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
    <section className="palette card" aria-labelledby={titleId} data-testid="palette">
      <div className="palette-head">
        <h2 id={titleId} className="card-title">
          Add a step
        </h2>
        <button type="button" className="button small quiet" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="palette-actions" role="group" aria-label="Actions">
        {forms.palette.map((a) => (
          <button key={a} type="button" className={`button small${action === a ? ' primary' : ''}`} aria-pressed={action === a} onClick={() => pick(a)} data-palette={a}>
            {a.replace(/_/g, ' ')}
          </button>
        ))}
      </div>
      {form && (
        <form
          className="step-form"
          data-testid="palette-form"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <p className="hint small">
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
            idBase={idBase}
            modifiersFrom={-1}
          />
          <label className="form-field palette-where">
            <span>Where</span>
            <select data-testid="palette-where" value={String(Math.min(place, places.length - 1))} onChange={(e) => setPlace(Number(e.target.value))}>
              {places.map((p, i) => (
                <option key={`${p.scene}-${p.index}-${i}`} value={i}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {touched && empty && <p className="field-error small">Fill at least one value.</p>}
          <p className="form-actions">
            <button type="submit" className="button small primary" disabled={!ed.enabled || ed.busy || !where} data-testid="palette-add">
              Add the {form.action.replace(/_/g, ' ')} step
            </button>
          </p>
        </form>
      )}
    </section>
  );
}
