/**
 * The timeline inspector's pure parts (L4.5 part D, R-UI-23; DESIGN §4g "Inspector"): what each switch offers as radio
 * buttons, the `set_field` edit a click sends, its words, and the same switch found again on a newer version (the 409
 * offer "Apply it to the new version"). Nothing here builds YAML: the server splices the file (core field-edits.ts).
 *
 * - The choices come from the view (`choices.video`, `choices.segments[<id>]`): each option `usable` or disabled with
 *   the engine's reason (critique B7). `value: null` is the theme's default: the edit is sent without `to` (the key
 *   removed). The intro / outro switch reads `true` when written as a map ("On, as written": it cannot be picked, it is
 *   what the file says); speeds get chips (1×, 1.25×, 1.5×, 2×) and a custom value; durations a number field.
 * - An edit carries `from` — what the inspector showed — so a value changed meanwhile is refused as stale, never
 *   overwritten (critique B2's rule for forms, kept for switches).
 * - Every switch is an edit value (core FIELD_PATHS): a render of the same take shows it, no new capture. L4.7
 *   (critique B1): the scenario's theme (`template`) is one too — its default is the project's theme.
 */
import type { TimelineView } from '@retake/engine';
import type { ScenarioEdit } from './data/scenarios.js';

export type Choice = TimelineView['choices']['video'][number];
export type SwitchValue = string | number | boolean;

/** The edit a switch sends (scenario_edit `set_field`). */
export type SwitchEdit = Extract<ScenarioEdit, { kind: 'set_field' }>;

/** One radio button of a switch. */
export interface SwitchOption {
  /** Stable within the group ("v:laptop", "default"). */
  key: string;
  /** null: the theme's default (sent without `to`); undefined: not pickable (what the file says, shown as checked). */
  value: SwitchValue | null | undefined;
  label: string;
  usable: true | { why: string };
  checked: boolean;
}

/** Speeds offered as chips (core FIELD_SPEED_MAX bounds the custom value). */
export const SPEED_CHIPS = [1.25, 1.5, 2] as const;

/** The kind of a switch, from its field (core fieldKindOf). */
export function switchKind(field: string): 'frame' | 'transition' | 'speed' | 'duration' | 'component' | 'switch' {
  const leaf = field.split('.').at(-1)!;
  if (field === 'intro' || field === 'outro') return 'switch';
  if (leaf === 'frame') return 'frame';
  if (leaf === 'transition') return 'transition';
  if (leaf === 'speed') return 'speed';
  if (leaf === 'duration') return 'duration';
  return 'component';
}

/** A switch's identity across versions: where (without the guard) and which field. */
export function choiceKey(c: Pick<Choice, 'at' | 'field'>): string {
  return c.at.entry === 'top' ? `top:${c.field}` : `${c.at.entry}:${c.at.id}:${c.field}`;
}

const speedWords = (n: number) => `${Number(n.toFixed(3))}×`;

/** The group's name ("Layout", "Caption component", "Transition into it"). */
export function switchLegend(c: Pick<Choice, 'at' | 'field'>): string {
  const top = c.at.entry === 'top';
  switch (c.field) {
    case 'caption_component':
      return 'Caption component (every caption)';
    case 'template':
      return 'Theme (this scenario)';
    case 'frame':
      return top ? 'Layout of every scene' : 'Layout';
    case 'transition':
    case 'card.transition':
      return 'Transition into it';
    case 'speed':
      return 'Speed between its steps';
    case 'card.component':
      return 'Card component';
    case 'interstitial.component':
      return 'Waiting screen component';
    case 'intro':
    case 'outro':
      return `${c.field === 'intro' ? 'Intro' : 'Outro'}`;
    case 'intro.component':
    case 'outro.component':
      return `${c.field.startsWith('intro') ? 'Intro' : 'Outro'} component`;
    default:
      return c.field.endsWith('duration') ? 'Duration (seconds)' : c.field;
  }
}

/** "the layout of scene a", "the transition into card c1", "the caption component" — an announcement's or a conflict's words. */
export function switchWhat(c: Pick<Choice, 'at' | 'field'>): string {
  const leaf = c.field.split('.').at(-1)!;
  if (c.at.entry === 'top') {
    if (c.field === 'caption_component') return 'the caption component';
    if (c.field === 'template') return "the scenario's theme";
    if (c.field === 'frame') return "the video's layout";
    if (c.field === 'intro' || c.field === 'outro') return `the ${c.field}`;
    return `the ${c.field.split('.')[0]} ${leaf}`;
  }
  const entity = `${c.at.entry === 'interstitial' ? 'waiting screen' : c.at.entry} ${c.at.id}`;
  if (leaf === 'transition') return `the transition into ${entity}`;
  return `the ${leaf === 'frame' ? 'layout' : leaf} of ${entity}`;
}

/** The words of a value of a switch (an option's label, else the value itself). */
export function valueWords(c: Pick<Choice, 'options' | 'field'>, value: SwitchValue | null | undefined): string {
  if (value === null || value === undefined) return c.field === 'intro' || c.field === 'outro' ? 'the theme’s default' : c.field === 'template' ? 'the project’s theme' : 'the default';
  if (value === false) return 'off';
  if (typeof value === 'number') return switchKind(c.field) === 'speed' ? speedWords(value) : `${value} s`;
  const o = c.options.find((x) => x.value === value);
  return o ? o.label : String(value);
}

/**
 * The radio buttons of a switch with options (frame, transition, component, the intro / outro switch, speed); none for
 * a duration (a number field). `inherited`: what an unset value falls back to when it is not the theme's (a scene's
 * layout without its own: the video's), named in the default's label.
 */
export function switchOptions(c: Choice, inherited?: string): SwitchOption[] {
  const kind = switchKind(c.field);
  const cur = c.current;
  if (kind === 'duration') return [];
  if (kind === 'switch') {
    const out: SwitchOption[] = [
      { key: 'default', value: null, label: 'Theme default', usable: true, checked: cur === undefined },
      { key: 'off', value: false, label: 'Off', usable: true, checked: cur === false },
    ];
    if (cur === true) out.push({ key: 'written', value: undefined, label: 'On, as written', usable: true, checked: true });
    return out;
  }
  if (kind === 'speed') {
    const out: SwitchOption[] = [{ key: 'default', value: null, label: 'Normal (1×)', usable: true, checked: cur === undefined }];
    for (const s of SPEED_CHIPS) out.push({ key: `v:${s}`, value: s, label: speedWords(s), usable: true, checked: cur === s });
    if (cur !== undefined && !SPEED_CHIPS.includes(cur as (typeof SPEED_CHIPS)[number])) out.push({ key: 'written', value: undefined, label: typeof cur === 'number' ? `${speedWords(cur)} (as written)` : `${String(cur)} (as written)`, usable: true, checked: true });
    return out;
  }
  const out: SwitchOption[] = c.options.map((o) => {
    const isDefault = o.value === null;
    const label = isDefault && inherited ? `As the video (${inherited})` : o.label;
    return { key: isDefault ? 'default' : `v:${String(o.value)}`, value: o.value, label, usable: o.usable, checked: isDefault ? cur === undefined : o.value === cur };
  });
  if (cur !== undefined && !out.some((o) => o.checked)) out.push({ key: 'written', value: undefined, label: `${String(cur)} (as written)`, usable: true, checked: true });
  return out;
}

/** The edit a pick sends: `from` what the inspector showed, `to` the value (none for the theme's default). */
export function switchEdit(c: Choice, value: SwitchValue | null): SwitchEdit {
  // The view's choices name fields of set_field only (core FIELD_PATHS; timeline_view types them as strings).
  return { kind: 'set_field', at: c.at, field: c.field as SwitchEdit['field'], ...(c.current !== undefined ? { from: c.current } : {}), ...(value !== null ? { to: value } : {}) };
}

/** Whether a value is in a number switch's range (speed, duration). */
export function inRange(c: Pick<Choice, 'range'>, n: number): boolean {
  return Number.isFinite(n) && (!c.range || (n > c.range.min_exclusive && n <= c.range.max));
}

/** "Set the layout of scene a to Laptop" — an edit in words before it is made (the conflict banner). */
export function switchEditWords(e: SwitchEdit, c?: Pick<Choice, 'options' | 'field'>): string {
  const what = switchWhat(e);
  if (e.to === undefined) return `Set ${what} to ${valueWords(c ?? { options: [], field: e.field }, null)}`;
  return `Set ${what} to ${valueWords(c ?? { options: [], field: e.field }, e.to)}`;
}

/** Every switch of a view, by choiceKey. */
export function choicesByKey(v: Pick<TimelineView, 'choices'>): Map<string, Choice> {
  const m = new Map<string, Choice>();
  for (const c of v.choices.video) m.set(choiceKey(c), c);
  for (const list of Object.values(v.choices.segments)) for (const c of list) m.set(choiceKey(c), c);
  return m;
}

/**
 * The same switch on a newer version (the 409 offer): its place with the new guard, the same `from` (a value changed
 * meanwhile is then refused as stale — never overwritten) and `to`; or why it cannot be applied there.
 */
export function switchAgain(e: SwitchEdit, v: Pick<TimelineView, 'choices' | 'editable'>): { edit: SwitchEdit } | { why: string } {
  if (v.editable !== true) return { why: v.editable.why };
  const c = choicesByKey(v).get(choiceKey(e));
  if (!c) return { why: `${switchWhat(e)} is not in the new version` };
  if (c.editable !== true) return { why: c.editable.why };
  return { edit: { ...e, at: c.at } };
}
