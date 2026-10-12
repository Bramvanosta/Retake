import { z } from 'zod';
import { ACTION_NAMES } from '../types.js';
import type { ActionArgsMap, ActionName, OverlaySpec } from '../types.js';
import { keyedUnion } from './keyed.js';
import {
  CameraHintSchema,
  CaptionSpecSchema,
  ComponentParamsSchema,
  PointSchema,
  SlotsSchema,
  TargetObjectSchema,
  TargetSpecSchema,
  TutorialSwitchSchema,
  componentIdSchema,
  keyString,
  millis,
  nonEmpty,
  positiveSeconds,
  seconds,
  slugString,
  targetShape,
} from './primitives.js';

/** Edit-time playback speed: (0, 8]. */
export const speedSchema = () => z.number().gt(0).lte(8);

/** Longest overlay (seconds): an overlay is a short callout over a clip, not a card. */
export const OVERLAY_MAX_SECONDS = 30;

export const OverlaySpecSchema: z.ZodType<OverlaySpec> = z
  .strictObject({
    component: componentIdSchema('overlay component id').describe(
      'Overlay component "namespace/name", e.g. studio/overlay-callout or studio/overlay-lower-third.',
    ),
    slots: SlotsSchema.optional(),
    params: ComponentParamsSchema.optional(),
    duration: positiveSeconds()
      .max(OVERLAY_MAX_SECONDS)
      .describe(`Seconds on screen, at most ${OVERLAY_MAX_SECONDS} (default: the component's duration).`)
      .optional(),
    target: TargetSpecSchema.describe(
      'Element the overlay points at, measured at the end of the step after any scroll (default: the step target, else the cursor).',
    ).optional(),
  })
  .meta({
    id: 'Overlay',
    description:
      'Edit-time overlay (callout, lower third, badge…) shown over the clip from the end of this step; the runner records the target bbox.',
  });

export const stepCommonShape = {
  id: slugString('step id').describe('Step id, used in refs ("scene.step") and by --until.').optional(),
  caption: CaptionSpecSchema.describe("Caption shown from this step's start until the next caption or scene end.").optional(),
  speed: speedSchema().describe("Edit-time playback speed for this step's span (overrides the scene speed).").optional(),
  hold: seconds().describe('Seconds of stillness AFTER the step; never trimmed by the editor.').optional(),
  camera: CameraHintSchema.optional(),
  overlay: OverlaySpecSchema.optional(),
  tutorial: TutorialSwitchSchema.describe(
    "Tutorial overlays of this step, over the scene's and the scenario's, e.g. {spotlight: false}; false = none on this step.",
  ).optional(),
  mark: slugString('mark').describe('Named marker (editor: speed 1 around it; review: key frame).').optional(),
  timeout: positiveSeconds().describe('Seconds before the step fails (default 15).').optional(),
  optional: z.boolean().describe('A failure is logged but does not abort the run.').optional(),
  irreversible: z.boolean().describe('Not executed in dry-run: the runner hovers the target, screenshots and stops the scene.').optional(),
  note: z.string().describe('Free-form note (ignored).').optional(),
};

export const STEP_COMMON_KEYS = Object.keys(stepCommonShape);

const clickOptionsShape = {
  strategy: z
    .enum(['auto', 'real', 'dom', 'pointer'])
    .describe('auto = real input, then DOM click, then pointer-event sequence when an expected popup did not open.')
    .optional(),
  expect_popup: z.boolean().describe('Force popup detection on/off (default: inferred from aria attributes).').optional(),
  outside: z
    .union([z.boolean(), TargetSpecSchema])
    .describe('Click somewhere neutral to close the open popover: true = auto (dialog title / blank area), or a target.')
    .optional(),
  hover_ms: millis().describe('Hover pause before pressing (ms).').optional(),
  after_ms: millis().describe('Pause after the click (ms).').optional(),
  move_ms: millis().describe('Cursor travel duration (ms). Default: computed from distance.').optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
  offset: PointSchema.describe("Offset from the element's top-left in CSS px (default: centre).").optional(),
};

const ClickArgsSchema = z.union([
  nonEmpty(),
  z.strictObject({ ...targetShape, ...clickOptionsShape }).meta({ id: 'ClickArgs', description: 'Target + click options.' }),
]);

const HoverArgsSchema = z.union([
  nonEmpty(),
  z.strictObject({
    ...targetShape,
    ms: millis().describe('How long to hover (ms).').optional(),
    move_ms: millis().describe('Cursor travel duration (ms).').optional(),
  }),
]);

const OpenArgsSchema = z.union([
  nonEmpty(),
  z.strictObject({
    url: nonEmpty().describe('Path (resolved against the page base URL) or absolute URL.'),
    page: keyString('page').describe('Environment page key to open in (default: current page).').optional(),
    wait_until: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
  }),
]);

const TypeArgsSchema = z.strictObject({
  into: TargetSpecSchema.describe('Field to click into first (omit to type into the focused element).').optional(),
  text: z.string().describe('Text to type, character by character.'),
  cps: z.number().gt(0).describe('Characters per second (default pacing.type_cps).').optional(),
  clear: z.boolean().describe('Select-all + delete before typing.').optional(),
  enter: z.boolean().describe('Press Enter afterwards.').optional(),
});

const PressArgsSchema = z.union([
  nonEmpty(),
  z.strictObject({
    key: nonEmpty().describe('Key in Playwright syntax: "Enter", "Escape", "Meta+A".'),
    times: z.number().int().min(1).optional(),
  }),
]);

const SelectArgsSchema = z.strictObject({
  combobox: TargetSpecSchema.describe('The select / combobox trigger.').optional(),
  field: nonEmpty().describe('Alternative to combobox: the field label.').optional(),
  option: nonEmpty().describe('Option text to choose.'),
  search: z.string().describe('Text typed into the listbox search input before choosing.').optional(),
});

const PickArgsSchema = z.strictObject({
  field: z.union([nonEmpty(), TargetObjectSchema]).describe('Field label, or an explicit trigger target.'),
  option: z.union([nonEmpty(), z.array(nonEmpty()).min(1)]).describe('Option(s) to tick.'),
  search: z.string().describe('Text typed into the popover search input first.').optional(),
  close: z.enum(['outside', 'escape', 'none']).describe("How to close the popover afterwards (default 'outside').").optional(),
});

const MenuArgsSchema = z.strictObject({
  row: z.union([nonEmpty(), TargetObjectSchema]).describe('Row (text it contains) whose action menu to open.').optional(),
  trigger: TargetSpecSchema.describe('Explicit menu trigger (overrides row-based discovery).').optional(),
  item: nonEmpty().describe('Menu item text.'),
  confirm: z
    .union([nonEmpty(), z.boolean()])
    .describe('Confirm button text in the confirmation dialog (true = first non-cancel button).')
    .optional(),
});

const ScrollArgsSchema = z.union([
  z.number().min(0).describe('Absolute scrollTop in px.'),
  z.strictObject({
    to: z
      .union([z.number().min(0), z.enum(['top', 'bottom']), TargetSpecSchema])
      .describe("Absolute scrollTop (px), a target, or 'top' / 'bottom'.")
      .optional(),
    by: z.number().describe('Relative scroll in px (alternative to `to`).').optional(),
    offset: z
      .number()
      .describe('With a target: final scrollTop = targetTop + offset (-140 ⇒ target ends 140 px below the top). Default -120.')
      .optional(),
    duration: seconds().describe('Seconds (default pacing.scroll_duration).').optional(),
    in: TargetSpecSchema.describe('Scroll container (default: nearest scrollable ancestor, else the main scroller).').optional(),
  }),
]);

const DragArgsSchema = z.strictObject({
  from: TargetSpecSchema.describe('Element to press on.'),
  to: z.union([PointSchema, TargetSpecSchema]).describe('Drop target element or viewport point.'),
  duration: positiveSeconds().optional(),
});

const DropFileArgsSchema = z.strictObject({
  zone: TargetSpecSchema.describe('Drop zone element.'),
  name: nonEmpty().describe('File name shown and dropped (required with fake).').optional(),
  path: nonEmpty().describe('Real file, relative to the project dir.').optional(),
  fake: z.boolean().describe('Generate a placeholder file named `name`.').optional(),
  mime: nonEmpty().optional(),
  size: z.number().int().gt(0).describe('Size in bytes for fake files (default 48 KiB).').optional(),
  input: TargetSpecSchema.describe('Explicit <input type=file> to set instead of dispatching drop events.').optional(),
  from: z.enum(['left', 'right', 'top', 'bottom']).describe("Where the dragged file ghost enters from (default 'right').").optional(),
});

const conditionShape = {
  text: nonEmpty().describe('Visible text present.').optional(),
  not_text: nonEmpty().describe('Visible text absent.').optional(),
  target: TargetSpecSchema.describe('Element visible.').optional(),
  gone: TargetSpecSchema.describe('Element no longer visible.').optional(),
  url: nonEmpty().describe('URL substring or /regex/.').optional(),
};

const WaitForArgsSchema = z.union([
  nonEmpty(),
  z.strictObject({
    ...conditionShape,
    network_idle: z.boolean().optional(),
    timeout: positiveSeconds().describe('Seconds (default 15).').optional(),
  }),
]);

const AssertArgsSchema = z.union([
  nonEmpty(),
  z.strictObject({
    ...conditionShape,
    title: nonEmpty().describe('Document title contains.').optional(),
    count: z
      .strictObject({ target: TargetSpecSchema, equals: z.number().int().min(0) })
      .describe('Number of visible matches of a target.')
      .optional(),
  }),
]);

const ScreenshotArgsSchema = z.union([
  slugString('screenshot name'),
  z.strictObject({
    name: slugString('screenshot name').describe('File name (runs/<id>/screenshots/<name>.png).'),
    full_page: z.boolean().optional(),
  }),
]);

const NewTabArgsSchema = z.union([
  nonEmpty(),
  z.strictObject({
    target: TargetSpecSchema.describe('Element to click (real click; falls back to following its href).').optional(),
    href: nonEmpty().describe('URL to open directly (relative URLs resolve against the current page).').optional(),
    as: keyString('page id').describe('Page id for later switch_page (default "tab<N>").').optional(),
  }),
  TargetObjectSchema,
]);

const SwitchPageArgsSchema = z.union([
  nonEmpty(),
  z.strictObject({
    to: nonEmpty().describe('Page id ("main", an environment page key, a new_tab `as` id) or "previous".'),
    close_current: z.boolean().optional(),
  }),
]);

const EvalArgsSchema = z.union([
  nonEmpty(),
  z.strictObject({
    js: nonEmpty().describe('Function body evaluated in the page (may return / await).').optional(),
    file: nonEmpty().describe('JS file relative to the project dir.').optional(),
    arg: z.unknown().describe('Value passed as `arg`.').optional(),
  }),
]);

const NotifyArgsSchema = z.union([
  nonEmpty(),
  z.strictObject({ title: z.string().optional(), message: nonEmpty() }),
]);

const EmitArgsSchema = z.union([
  nonEmpty(),
  z.strictObject({ name: nonEmpty(), data: z.unknown().optional() }),
]);

const CursorArgsSchema = z.union([
  z.enum(['show', 'hide']),
  z.strictObject({
    move: z.union([PointSchema, TargetSpecSchema]).describe('Animate the cursor to a point or an element.').optional(),
    set: PointSchema.describe('Teleport (no animation).').optional(),
    duration: seconds().optional(),
    show: z.boolean().optional(),
  }),
]);

const WaitForEmailArgsSchema = z.strictObject({
  to: nonEmpty().describe('Recipient: a substring of the address or the name (case-insensitive).').optional(),
  from: nonEmpty().describe('Sender: a substring of the address or the name (case-insensitive).').optional(),
  subject: nonEmpty().describe('Subject: a substring (case-insensitive) or a /regex/.').optional(),
  timeout: positiveSeconds().describe('Seconds to wait for the message (default 30).').optional(),
  as: slugString('artefact name').describe('Artefact name, referenced by components as `email: <as>`.'),
});

const CaptureTextArgsSchema = z.strictObject({
  target: TargetSpecSchema.describe('Element whose visible text is read.'),
  as: slugString('artefact name').describe('Artefact name, referenced by components as `capture: <as>`.'),
  pattern: nonEmpty()
    .describe('Keep a part of the text: a regular expression (/…/flags or plain source); its first group, else the whole match.')
    .optional(),
});

const DownloadArgsSchema = z.strictObject({
  click: TargetSpecSchema.describe('Link or button to click (real click).'),
  as: slugString('artefact name').describe('Artefact name, referenced by components as `document: <as>`.'),
  timeout: positiveSeconds().describe('Seconds to wait for the file after the click (default 30).').optional(),
});

/** Argument schema of every action. */
export const ACTION_ARG_SCHEMAS = {
  open: OpenArgsSchema,
  click: ClickArgsSchema,
  double_click: ClickArgsSchema,
  hover: HoverArgsSchema,
  type: TypeArgsSchema,
  press: PressArgsSchema,
  select: SelectArgsSchema,
  pick: PickArgsSchema,
  menu: MenuArgsSchema,
  scroll: ScrollArgsSchema,
  drag: DragArgsSchema,
  drop_file: DropFileArgsSchema,
  wait: seconds(),
  wait_for: WaitForArgsSchema,
  hold: seconds(),
  assert: AssertArgsSchema,
  screenshot: ScreenshotArgsSchema,
  new_tab: NewTabArgsSchema,
  switch_page: SwitchPageArgsSchema,
  eval: EvalArgsSchema,
  notify: NotifyArgsSchema,
  emit: EmitArgsSchema,
  cursor: CursorArgsSchema,
  wait_for_email: WaitForEmailArgsSchema,
  download: DownloadArgsSchema,
  capture_text: CaptureTextArgsSchema,
} satisfies { [K in ActionName]: z.ZodType<ActionArgsMap[K]> };

export const ACTION_DESCRIPTIONS: Record<ActionName, string> = {
  open: 'Navigate the current page (or `page`) to a path or URL.',
  click: 'Click an element: the cursor travels, hovers, presses; popup-aware fallback strategies.',
  double_click: 'Double-click an element.',
  hover: 'Move the cursor onto an element and rest there.',
  type: 'Type text character by character, optionally into a field first.',
  press: 'Press a key (Playwright syntax), optionally several times.',
  select: 'Choose an option in a native select or a combobox listbox.',
  pick: 'Tick one or more options in a multi-select popover field, then close it.',
  menu: "Open a row's action menu, choose an item and optionally confirm.",
  scroll: 'Animated in-page scroll to a position, an element, or by an amount.',
  drag: 'Press on an element, move with an eased path and release.',
  drop_file: 'Drag a file ghost onto a drop zone and drop a real or placeholder file.',
  wait: 'Sleep N seconds (not protected from trimming).',
  wait_for: 'Wait until a condition holds (text, element, URL, network idle).',
  hold: 'Stay still N seconds; the editor never trims a hold.',
  assert: 'Fail the run (with a screenshot) unless a condition holds.',
  screenshot: 'Save a screenshot of the page in runs/<id>/screenshots/.',
  new_tab: 'Follow a link into a new tab (real click, or open its href) and keep recording.',
  switch_page: 'Make another page the active (recorded) one.',
  eval: 'Escape hatch: evaluate JavaScript in the page.',
  notify: 'Desktop notification (macOS osascript, Linux notify-send).',
  emit: 'Custom event recorded in the timeline.',
  cursor: 'Show, hide, move or teleport the in-page cursor.',
  wait_for_email: "Wait for a new message in the project's test mailbox and capture it (from, to, subject, text, an image of its HTML) as an artefact.",
  download: 'Click a link or button and capture the file it produces (download, or a document opened in a new tab) as an artefact; PDFs are rasterised.',
  capture_text: 'Read the visible text of an element (optionally a part of it, by pattern) and keep it as an artefact for a card (`capture: <as>`).',
};

function stepBranch<K extends ActionName>(action: K) {
  const args = ACTION_ARG_SCHEMAS[action].describe(ACTION_DESCRIPTIONS[action]);
  // `hold` is both an action and a modifier: in the hold branch the action (required) wins.
  const common: Record<string, z.ZodType> = { ...stepCommonShape };
  delete common[action];
  return z
    .strictObject({ [action]: args, ...common } as { [P in K]: (typeof ACTION_ARG_SCHEMAS)[K] } & typeof stepCommonShape)
    .meta({ title: action, description: ACTION_DESCRIPTIONS[action] });
}

const STEP_BRANCHES = ACTION_NAMES.map((a) => stepBranch(a)) as unknown as [z.ZodObject, ...z.ZodObject[]];

/** One step: exactly one action key plus optional common modifiers. */
export const StepSchema = keyedUnion(
  STEP_BRANCHES,
  {
    noun: 'step',
    label: 'action',
    keys: ACTION_NAMES,
    common: STEP_COMMON_KEYS,
    example: 'e.g. "click: Save" or "hold: 2"',
  },
  {
    id: 'Step',
    description: `Exactly one action (${ACTION_NAMES.join(', ')}) plus optional modifiers (${STEP_COMMON_KEYS.join(', ')}).`,
  },
);
