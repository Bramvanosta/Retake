/**
 * The step's form in the inspector and the palette of new steps (R-UI-12; on the kit, B32's step
 * inspector). Fields come from the scenario language's schemas (scenario_forms: text, numbers, yes / no, a choice, a
 * target's flat keys) in the inspector's row layout; a target's empty ways to find it fold under "Other ways to find it
 * (n)" and the empty optional fields under "More: …"; the modifiers (caption, hold, speed, mark) are switches — on shows
 * their fields, off empties them (Save then sends their removal: the same `set_step` changes). What a form cannot show
 * stays in the YAML view and is named. A save sends the changed fields only (`set_step`, each with the value the form
 * showed), a new step its form values (`insert_step`); the server writes the file (a shorthand kept when
 * only its own value changes), validates it and refuses what agent trust refuses — a `{{env:…}}` or `{{keychain:…}}`
 * typed into a field, with the reason. The rules each field shows (a number, its bounds, a pattern) are checked here
 * before sending and again on the server (its issues come back at their fields).
 */
import { useEffect, useId, useMemo, useState } from 'react';
import type { ActionName } from '@retake/core/language';
import type { SceneBlock, StepBlock, StepForms } from '@retake/core/scenario';
import { Txt, shown } from '../bits.js';
import { useUnsavedMark } from '../drafts.js';
import { actionForm, fieldWords, fieldsOf, formChanges, inputsOf, issueField, readInputs } from './forms.js';
import type { Inputs } from './forms.js';
import type { StepEditor } from './StepEditing.js';
import type { FieldValue, StepEditOp } from './step-edit.js';
import { Button, Callout, Select } from '../ui-kit/index.js';
import { Fields } from './form-fields.js';

type InsertStep = Extract<StepEditOp, { kind: 'insert_step' }>;

/**
 * The selected step's form (inspector). Its values reset when the step changes on disk (its guard); a step changed
 * meanwhile while the form held changes is said, with what was typed (to copy).
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
  // Typed fields are unsaved text the desktop app's quit question names.
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
  const serverErrors = serverErrorsOf(ed, scene, step, fields);
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
      {changedOnDisk && <DroppedChanges lines={changedOnDisk} />}
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

/** The server's refusal of this step's form, at its field. */
function serverErrorsOf(ed: StepEditor, scene: SceneBlock, step: StepBlock, fields: ReturnType<typeof fieldsOf>): Record<string, string> {
  const refused = ed.error?.op?.kind === 'set_step' && ed.error.op.at.scene === scene.id && ed.error.op.at.index === step.index ? ed.error : null;
  const serverErrors: Record<string, string> = {};
  if (refused) {
    if (refused.field !== undefined) serverErrors[refused.field] = refused.message.replace(/^not saved: /, '');
    for (const i of refused.issues) {
      const k = issueField(i.path, scene.index, step.index, fields);
      if (k !== undefined && i.severity === 'error' && serverErrors[k] === undefined) serverErrors[k] = i.message;
    }
  }
  return serverErrors;
}

/** What was typed when the step changed on disk, said with the text (to copy). */
function DroppedChanges({ lines }: { lines: string[] }) {
  return (
    <Callout state="warn" role="alert" title="This step changed on disk">
      <p>The form now shows its new values; your changes were not saved:</p>
      <ul data-testid="form-dropped">
        {lines.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the dropped changes, fixed once said, text only: the index is the identity
          <li key={i}>
            <Txt text={t} />
          </li>
        ))}
      </ul>
    </Callout>
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
 * The palette: ≈ 15 actions; one chosen shows its form with the schema's defaults; Add inserts it.
 * A scene's "Add step" opens it placed at that scene's end (`at`).
 */
export function Palette({
  forms,
  scenes,
  selected,
  ed,
  onClose,
  at,
}: {
  forms: StepForms;
  scenes: SceneBlock[];
  selected: { scene: SceneBlock; step: StepBlock } | null;
  ed: StepEditor;
  onClose: () => void;
  at?: string;
}) {
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
    // The palette offers the palette's actions only (scenario_forms `palette`: core PALETTE_ACTIONS).
    ed.send({ kind: 'insert_step', to: { scene: where.scene, index: where.index }, after: where.after, action: form.action as InsertStep['action'], values: values as Record<string, FieldValue> });
  };
  const titleId = `${idBase}-palette`;
  return (
    <section className="sb-palette" aria-labelledby={titleId} data-testid="palette">
      <PaletteHead titleId={titleId} onClose={onClose} palette={forms.palette} chosen={action} onPick={pick} />
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
          <Select
            layout="row"
            label="Where"
            testId="palette-where"
            value={String(Math.min(place, places.length - 1))}
            options={places.map((p, i) => ({ value: String(i), label: p.label }))}
            onChange={(v) => setPlace(Number(v))}
          />
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

/** The palette's title and Close, and its row of actions (the one chosen pressed). */
function PaletteHead({
  titleId,
  onClose,
  palette,
  chosen,
  onPick,
}: {
  titleId: string;
  onClose: () => void;
  palette: StepForms['palette'];
  chosen: ActionName | null;
  onPick: (a: ActionName) => void;
}) {
  return (
    <>
      <div className="sb-palette-head">
        <h2 id={titleId} className="sc-h2">
          Add a step
        </h2>
        <Button size="sm" variant="ghost" icon="close" onClick={onClose}>
          Close
        </Button>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a row of palette buttons; <fieldset> would bring its own border, padding and min-width */}
      <div className="sb-palette-actions" role="group" aria-label="Actions">
        {palette.map((a) => (
          <Button key={a} size="sm" variant={chosen === a ? 'primary' : 'secondary'} aria-pressed={chosen === a} onClick={() => onPick(a)} data-palette={a}>
            {shown(a.replace(/_/g, ' '))}
          </Button>
        ))}
      </div>
    </>
  );
}
