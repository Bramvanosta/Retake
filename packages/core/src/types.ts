/**
 * Retake — shared contracts.
 *
 * This file is the single source of truth for the data model shared by every package
 * (scenario language, project/template model, timeline emitted by runners, run records).
 * Zod schemas in `schema.ts` must accept exactly these shapes.
 *
 * Units: time in SECONDS (float) unless the field name ends in `_ms`.
 * Pixels: CSS pixels of the captured viewport unless stated otherwise
 * (multiply by `capture.scale` to get video pixels).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Targets
// ─────────────────────────────────────────────────────────────────────────────

/** A string is shorthand for `{ text: "<string>" }`. */
export type TargetSpec = string | TargetObject;

export interface TargetObject {
  /** Visible text, whitespace-normalised. Exact match first, then case-insensitive substring (unless `exact`). */
  text?: string;
  /** Element whose text contains ALL these strings; the innermost such element wins. */
  contains?: string | string[];
  /** ARIA role (explicit or implicit: button, link, textbox, combobox, checkbox, radio, option, menuitem, row, dialog, alertdialog, heading, tab, listbox, menu…). */
  role?: string;
  /** Accessible name used together with `role` (exact first, then substring). */
  name?: string;
  /** Form control whose label text matches (label[for], wrapping label, aria-labelledby). */
  label?: string;
  /** aria-label value (exact first, then substring). */
  aria?: string;
  /** placeholder attribute. */
  placeholder?: string;
  /** Raw CSS selector. */
  css?: string;
  /** data-testid value. */
  testid?: string;
  /** Restrict the search to a scope. */
  in?: ScopeSpec;
  /** 0-based index among visible matches (negative = from the end). */
  nth?: number;
  /** Pick the LAST visible match (e.g. the most recently mounted popover). */
  last_visible?: boolean;
  /** Disable the substring fallback of text/name/aria/label. */
  exact?: boolean;
}

/**
 * Scope keywords resolve to the TOPMOST visible container of that kind
 * (last visible in document order):
 *  - dialog  → [role=dialog], [role=alertdialog], dialog[open]
 *  - menu    → [role=menu]
 *  - listbox → [role=listbox]
 *  - popover → any open floating layer (menu, listbox, [data-radix-popper-content-wrapper], [popover]:popover-open, [data-state=open][role=dialog]…)
 *  - page    → the whole document (default)
 *  - { row: "Iceland" } → the row ([role=row], tr, [role=listitem], li) containing that text
 *  - TargetObject → the element designated by that target
 */
export type ScopeSpec = 'dialog' | 'menu' | 'listbox' | 'popover' | 'page' | { row: string } | TargetObject;

/** Absolute viewport point in CSS px. */
export interface PointSpec {
  x: number;
  y: number;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component references (phase-2 contracts; docs/DESIGN-phase2.md §1)
// ─────────────────────────────────────────────────────────────────────────────

/** What a component renders. Every visual element of an edit is a component of one of these kinds. */
export type ComponentKind =
  | 'intro'
  | 'outro'
  /** Full-screen card inserted between scenes (title / chapter / quote card…). */
  | 'card'
  /** Full-screen "time passes" card (waiting screen), usually drawn over a dimmed last frame. */
  | 'interstitial'
  /** Renders the caption cues of a clip in the caption area of the layout. */
  | 'caption'
  /** Screen layout / frame: places the capture (card, browser chrome, laptop, phone, tablet, raw…). */
  | 'layout'
  /** Overlay shown over a clip for a while (lower third, callout, badge, highlight…). */
  | 'overlay'
  /** Transition between two segments. */
  | 'transition';

export const COMPONENT_KINDS: readonly ComponentKind[] = [
  'intro',
  'outro',
  'card',
  'interstitial',
  'caption',
  'layout',
  'overlay',
  'transition',
] as const;

/**
 * A component id: "namespace/name", lower-case letters, digits and "-" on each side (e.g. "studio/intro-stack").
 * Validated by `COMPONENT_ID_RE`. Resolution order: workspace `components/` → built-in library → (V2) marketplace.
 */
export type ComponentId = string;

/** Reference to a component from a theme or a scenario: an id, or an id with params. */
export type ComponentRef = ComponentId | { id: ComponentId; params?: Record<string, unknown> };

// ─────────────────────────────────────────────────────────────────────────────
// Scenario language
// ─────────────────────────────────────────────────────────────────────────────

/** A string is shorthand for `{ text }`. */
export type CaptionSpec = string | { kicker?: string; text: string };

export type EaseSpec = 'slow' | 'normal' | 'fast' | 'linear' | [number, number, number, number];

/** Edit-time camera hint. Static camera unless a step carries one. */
export interface CameraHint {
  /** Zoom factor (1 = no zoom). Clamped to template.motion.max_zoom. */
  zoom: number;
  /** What to centre on. Defaults to the step target, else the cursor. */
  target?: TargetSpec | 'cursor' | 'step' | PointSpec;
  ease?: EaseSpec;
  /** Duration of the zoom-in move in seconds (minimum 0.8). */
  duration?: number;
  /** How long the zoom stays: until the step ends, the scene ends, or N seconds. Default 'scene_end'. */
  until?: 'step_end' | 'scene_end' | number;
}

export type ClickStrategy = 'auto' | 'real' | 'dom' | 'pointer';

export interface ClickOptions {
  /** Click strategy. auto = real input → DOM click → pointer-event sequence when an expected popup did not open. */
  strategy?: ClickStrategy;
  /** Force popup detection on/off (default: inferred from aria-haspopup / aria-expanded / role=combobox). */
  expect_popup?: boolean;
  /** Click somewhere neutral to close the open popover. `true` = auto (dialog title / blank area); a target = click that element. */
  outside?: boolean | TargetSpec;
  /** Hover pause before pressing (ms). */
  hover_ms?: number;
  /** Pause after the click (ms). */
  after_ms?: number;
  /** Cursor travel duration (ms). Default: computed from distance. */
  move_ms?: number;
  button?: 'left' | 'right' | 'middle';
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
  /** Offset from the element's top-left in CSS px (default: centre). */
  offset?: PointSpec;
}

export type ClickArgs = TargetSpec | (TargetObject & ClickOptions);

export interface TypeArgs {
  /** Field to click into first (omit to type into the focused element). */
  into?: TargetSpec;
  text: string;
  /** Characters per second (default pacing.type_cps). */
  cps?: number;
  /** Select-all + delete before typing. */
  clear?: boolean;
  /** Press Enter afterwards. */
  enter?: boolean;
}

export interface PressArgs {
  key: string; // Playwright key syntax: "Enter", "Escape", "Meta+A"
  times?: number;
}

export interface SelectArgs {
  /** The combobox / select trigger (string = CSS selector if it starts with # . [ or contains a combinator, else visible text). */
  combobox?: TargetSpec;
  /** Alternative to combobox: the field label. */
  field?: string;
  option: string;
  /** Text typed into the listbox search input before choosing. */
  search?: string;
}

export interface PickArgs {
  /** Field label (string) or explicit trigger target. */
  field: string | TargetObject;
  option: string | string[];
  search?: string;
  /** How to close the popover afterwards. Default 'outside'. */
  close?: 'outside' | 'escape' | 'none';
}

export interface MenuArgs {
  /** Row (text it contains) whose action menu to open. */
  row?: string | TargetObject;
  /** Explicit menu trigger (overrides row-based discovery). */
  trigger?: TargetSpec;
  item: string;
  /** Confirm button text in the confirmation dialog (true = first non-cancel button). */
  confirm?: string | boolean;
}

/**
 * The date-picker helper (R-CHO-24). `day` is matched against each day cell's aria-label (or its date attribute): an
 * ISO date or an English long date ("10 January 2027", "January 10, 2027", with or without the weekday).
 */
export interface DateArgs {
  /** The date field (its label, or a target) whose calendar opens; omit for a calendar already on screen. */
  field?: string | TargetObject;
  /** Day(s) to click in order: one day, or a list (a range: its first and last day). */
  day: string | string[];
  /** Next-month button (default: the last visible next-month button of the calendar). */
  next?: TargetSpec;
  /** Previous-month button (default: the last visible previous-month button of the calendar). */
  previous?: TargetSpec;
  /**
   * After the last day: `auto` (default) waits for a calendar the step opened to close by itself, else clicks outside;
   * `outside`, `escape` or `none` as with `pick`.
   */
  close?: 'auto' | 'outside' | 'escape' | 'none';
}

export interface ScrollArgs {
  /** Absolute scrollTop (px), a target, or 'top'/'bottom'. */
  to?: number | TargetSpec | 'top' | 'bottom';
  /** Relative scroll in px (alternative to `to`). */
  by?: number;
  /** With a target: final scrollTop = targetTop + offset (offset -140 ⇒ target ends 140 px below the top). Default pacing.scroll_offset (-140). */
  offset?: number;
  /** Seconds (default pacing.scroll_duration). */
  duration?: number;
  /** Scroll container; default = nearest scrollable ancestor of the target, else the main scroller. */
  in?: TargetSpec;
}

export interface DragArgs {
  from: TargetSpec;
  to: TargetSpec | PointSpec;
  duration?: number;
}

export interface DropFileArgs {
  zone: TargetSpec;
  /** File name shown/dropped. Required with fake. */
  name?: string;
  /** Real file (relative to the project dir). */
  path?: string;
  /** Generate a placeholder file named `name`. */
  fake?: boolean;
  mime?: string;
  /** Size in bytes for fake files (default 48 KiB). */
  size?: number;
  /** Explicit <input type=file> to set instead of dispatching drop events. */
  input?: TargetSpec;
  /** Where the dragged file ghost enters from. Default 'right'. */
  from?: 'left' | 'right' | 'top' | 'bottom';
}

export interface WaitForArgs {
  text?: string;
  not_text?: string;
  /** Wait until visible. */
  target?: TargetSpec;
  /** Wait until no longer visible. */
  gone?: TargetSpec;
  /** URL substring or /regex/. */
  url?: string;
  network_idle?: boolean;
  /** Seconds (default 15). */
  timeout?: number;
}

export interface AssertArgs {
  text?: string;
  not_text?: string;
  target?: TargetSpec;
  gone?: TargetSpec;
  url?: string;
  title?: string;
  count?: { target: TargetSpec; equals: number };
}

export interface ScreenshotArgs {
  name: string;
  full_page?: boolean;
}

export interface NewTabArgs {
  /** Element to click (real click; falls back to following its href). */
  target?: TargetSpec;
  /** URL to open directly (relative URLs resolve against the current page). */
  href?: string;
  /** Page id for later switch_page. Default "tab<N>". */
  as?: string;
}

export interface SwitchPageArgs {
  /** Page id ("main", an environment page key, an `as` id) or "previous". */
  to: string;
  close_current?: boolean;
}

export interface EvalArgs {
  js?: string;
  /** JS file relative to the project dir. */
  file?: string;
  arg?: unknown;
}

export interface NotifyArgs {
  title?: string;
  message: string;
}

export interface EmitArgs {
  name: string;
  data?: unknown;
}

/**
 * `hook: <name>` (L5.8, R-FLD-31): run a named hook of the scenario's `hooks:` (else project.yaml's) during the take —
 * an action on the product that must happen at that moment without being filmed (mark a payment through its API, move a
 * period into the past in SQL, push a queue job). Approved like setup / teardown hooks; the edit cuts its span.
 */
export interface HookArgs {
  name: string;
}

/**
 * `wait_for_email`: poll the project's test mailbox (`project.mailbox`) until a NEW message matches (one that was not
 * in the mailbox when the run started), then capture it as the run artefact `as` (artefacts/emails/<as>.json + an
 * image of its HTML). `to` / `from` match a substring of the address or the name (case-insensitive), `subject` a
 * substring or a /regex/.
 */
export interface WaitForEmailArgs {
  /**
   * Recipient: a substring of the address or the name, or `persona:<name>` — that persona's `email` on the run's
   * environment, matched as the whole address (L5.6).
   */
  to?: string;
  from?: string;
  subject?: string;
  /** Seconds (default 30). */
  timeout?: number;
  /** Artefact name, referenced by components (`email: <as>`). */
  as: string;
}

/**
 * `download`: click a link / button (real click) and capture the file it produces — from the browser's download
 * event, or the document a new tab opens (fetched with the session's cookies, then the tab is closed) — as the run
 * artefact `as` (artefacts/documents/<as>.<ext>; PDFs are rasterised page by page into documents/<as>/page-<n>.png).
 */
export interface DownloadArgs {
  /** Element to click. */
  click: TargetSpec;
  /** Artefact name, referenced by components (`document: <as>`). */
  as: string;
  /** Seconds to wait for the file after the click (default 30). */
  timeout?: number;
}

/**
 * `capture_text` (L2.10): read the visible text of an element (whitespace collapsed) and keep it as the run artefact
 * `as` (artefacts/texts/<as>.json) — a figure a card shows later (`capture: <as>`), e.g. a total or a count. `pattern`
 * keeps only a part of it: a regular expression (`/…/flags` or plain source) whose first group (else the whole match)
 * is kept; no match fails the step.
 */
export interface CaptureTextArgs {
  target: TargetSpec;
  /** Artefact name, referenced by components (`capture: <as>`). */
  as: string;
  pattern?: string;
}

export type CursorArgs =
  | 'show'
  | 'hide'
  | {
      move?: TargetSpec | PointSpec;
      /** Teleport (no animation). */
      set?: PointSpec;
      duration?: number;
      show?: boolean;
    };

export interface OpenArgs {
  /** Path (resolved against the scene page base URL) or absolute URL. */
  url: string;
  /** Environment page key to open in (default: current page). */
  page?: string;
  wait_until?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
}

/** Modifiers accepted on every step. */
export interface StepCommon {
  id?: string;
  /** Caption shown from this step's start until the next caption or scene end. */
  caption?: CaptionSpec;
  /** Edit-time playback speed for this step's span (overrides scene speed). */
  speed?: number;
  /** Seconds of stillness AFTER the step; never trimmed by the editor. */
  hold?: number;
  camera?: CameraHint;
  /** Named marker (editor: speed 1 around it; review: key frame). */
  mark?: string;
  /** Seconds before the step fails (default: the scenario's or project's `defaults.timeout_s`, else 15). */
  timeout?: number;
  /** A failure is logged (and listed in run.json `optional_failures`) but does not abort the run. */
  optional?: boolean;
  /**
   * `click` / `double_click` (L5.6): a click that produced nothing within about a second (no request, DOM change,
   * navigation, dialog, new tab or download) is made once more; when the second one does nothing either, the step fails.
   * Without it such a click is only reported (a warning with a screenshot).
   */
  retry_click?: boolean;
  /** Not executed in dry-run (the runner hovers the target, screenshots, and stops the scene). */
  irreversible?: boolean;
  /** Edit-time overlay (callout, lower third, badge…) shown over this step; the runner records its target bbox. */
  overlay?: OverlaySpec;
  /**
   * Tutorial overlays of this step (L2.10): overrides the scene's and the scenario's switches, e.g.
   * `tutorial: {spotlight: false}`; `false` = none on this step. `progress` is a video-wide switch (scenario only).
   */
  tutorial?: TutorialSwitch;
  /**
   * Multi-page scenes (L2.11): the page this step acts on — a key of the scene's `pages` (default: the scene's first
   * page). Only that page's cursor moves; the others rest where they are.
   */
  on?: string;
  /**
   * Park the cursor after the step (R-CHO-18, R-CHO-21): after a scroll to a target, next to it and clear of its
   * text; after any other step, away from what changed on the page since the last action started (and from the
   * element it used). `true` then holds pacing.park_scroll_hold / park_hold seconds (or the step's `hold`); a number
   * holds that many seconds. On a `hold` step the cursor parks first, then the hold runs. Default: no parking.
   */
  park?: boolean | number;
  /** Free-form note (ignored). */
  note?: string;
}

// ── Tutorial overlays (L2.10) ────────────────────────────────────────────────

/**
 * One tutorial overlay switch: on / off, or on with another component (default: the built-in one) and params, e.g.
 * `shortcuts: {params: {platform: windows}}`.
 */
export type TutorialFeature = boolean | { component?: ComponentId; params?: Record<string, unknown> };

/** Which steps the spotlight follows: `steps` = every step with a target, over the whole step; `clicks` = around each click. */
export type SpotlightMode = 'steps' | 'clicks';
/** What the progress bar counts as chapters: every scene and card, or only cards (each card opens a chapter). */
export type ChapterMode = 'scenes' | 'cards';

/**
 * Automatic tutorial overlays fed by the timeline (L2.10). Each switch can be set on the scenario, a scene or a step;
 * the most specific one wins. `true` on a level turns every overlay on, `false` turns them all off.
 */
export interface TutorialSpec {
  /** Key caps of `press` steps, timed on the real key press (studio/overlay-shortcut). */
  shortcuts?: TutorialFeature;
  /** Dim the screen except the step's target (studio/overlay-spotlight); `true` = `steps`. */
  spotlight?: TutorialFeature | SpotlightMode | { on?: SpotlightMode; component?: ComponentId; params?: Record<string, unknown> };
  /** Numbered badges (1, 2, 3…) next to clicked targets (studio/overlay-steps). */
  steps?: TutorialFeature;
  /** A magnified view of the field during `type` steps (studio/overlay-loupe). */
  loupe?: TutorialFeature;
  /** Chapter progress bar across the video (studio/overlay-progress; scenario level only); `true` = `scenes`. */
  progress?: TutorialFeature | ChapterMode | { chapters?: ChapterMode; component?: ComponentId; params?: Record<string, unknown> };
}

/** `tutorial:` on a scenario, a scene or a step: the switches, or `true` (all on) / `false` (all off). */
export type TutorialSwitch = boolean | TutorialSpec;

/** The tutorial overlays, in their order of drawing (the spotlight dims the screen under the others). */
export const TUTORIAL_FEATURES = ['spotlight', 'steps', 'loupe', 'shortcuts', 'progress'] as const;
export type TutorialFeatureName = (typeof TUTORIAL_FEATURES)[number];

/** The built-in component of each tutorial overlay. */
export const TUTORIAL_COMPONENTS: Readonly<Record<TutorialFeatureName, ComponentId>> = {
  shortcuts: 'studio/overlay-shortcut',
  spotlight: 'studio/overlay-spotlight',
  steps: 'studio/overlay-steps',
  loupe: 'studio/overlay-loupe',
  progress: 'studio/overlay-progress',
};

// ── User media (L2.12, R-OWN-*) ──────────────────────────────────────────────

/** How a user file fills its frame (segments) or its box (overlays): `cover` = filled (cropped), `contain` = whole. */
export type MediaFit = 'cover' | 'contain';
export const MEDIA_FITS: readonly MediaFit[] = ['cover', 'contain'];

/** The kinds of user files a segment or an overlay can show instead of a component. */
export type MediaFileKind = 'video' | 'image' | 'lottie';
export const MEDIA_FILE_KINDS: readonly MediaFileKind[] = ['video', 'image', 'lottie'];

/**
 * A user file instead of a component (L2.12): exactly one of `video`, `image` or `lottie` — a path relative to the
 * project (a theme's own entries: relative to the template folder). The provided components are never mandatory: an
 * intro, an outro, a card, an interstitial or an overlay can be the user's own motion design.
 */
export interface MediaFileFields {
  /** A video file (.mp4, .mov, .webm, .m4v): H.264, HEVC, VP8, VP9, AV1 or ProRes; its own sound is kept. */
  video?: string;
  /** An image file (.png, .jpg, .jpeg, .webp, .svg). */
  image?: string;
  /** A Lottie animation (bodymovin JSON), played by studio/lottie. */
  lottie?: string;
  /** Video: the second of the file the part shown starts at (default 0). */
  from?: number;
  /** Video: the second of the file the part shown ends at (default: its end). */
  to?: number;
  /**
   * cover (fills the frame, cropped) or contain (whole, on `background`; default for overlays). Unset on a segment:
   * cover when the file has about the frame's shape (covering keeps ≥ 80 % of each side), else contain — a 16:9 intro
   * shows whole in the vertical variant.
   */
  fit?: MediaFit;
  /**
   * Segments: what shows around a `contain` file (and under a transparent one) — `theme` (the theme background,
   * default), a theme colour key (paper, dark, accent…), a CSS colour or `none` (transparent).
   */
  background?: string;
  /** Video: volume of the file's own sound, 0..1 (default 1; 0 = muted). A file without sound stays silent. */
  volume?: number;
}

/** Where a box-filling overlay (a user video, image or Lottie) goes over the capture. */
export const OVERLAY_ANCHORS = [
  'target',
  'cursor',
  'screen',
  'center',
  'top-left',
  'top',
  'top-right',
  'left',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
] as const;
export type OverlayAnchor = (typeof OVERLAY_ANCHORS)[number];

/**
 * When an overlay starts: at the end of its step (`end`, or `step`; the default), at its start (`start`), at its click
 * (`click`), at a mark (`mark:<name>`, a step of the same scene) or a number of seconds after the step starts.
 */
export type OverlayAt = 'start' | 'end' | 'step' | 'click' | `mark:${string}` | number;

/**
 * Step modifier `overlay`: a component drawn over the clip from the end of the step's action for `duration` seconds.
 * The runner measures the target at the END of the step (after any scroll) and records it on the event.
 *
 * L2.12: instead of a component, a user file — `video` (an alpha video: ProRes 4444 .mov or VP9 .webm with alpha),
 * `image` or `lottie` — composited over the capture in a box placed by `anchor` (target, cursor, screen or a position of
 * the screen) or `rect` (page CSS px), at its own size × `scale`; mapped through the layout, the camera and the reframe.
 */
export interface OverlaySpec extends Omit<MediaFileFields, 'background'> {
  /** Overlay component id, e.g. "studio/overlay-callout" (required unless the overlay is a video, image or lottie file). */
  component?: ComponentId;
  /** Slot values (text, kicker, title…), as the component declares them. */
  slots?: Record<string, string>;
  params?: Record<string, unknown>;
  /** Seconds on screen (0 < d ≤ 30; default: the component's duration — a file: its own length). */
  duration?: number;
  /** Element the overlay points at. Default: the step's own target, else the cursor position. */
  target?: TargetSpec;
  /** When it starts (default: the end of the step). */
  at?: OverlayAt;
  /** Box placement (files, or any box-filling component): default `target` when there is one, else `center`. */
  anchor?: OverlayAnchor;
  /** Box placement: a rect of the page in CSS px (instead of `anchor`). */
  rect?: BBox;
  /** Size factor of the file's own size (in page CSS px), default 1; ignored with `rect` and `anchor: screen`. */
  scale?: number;
  /** Replay the file for the whole `duration` (default false: a file plays once and holds its last frame). */
  loop?: boolean;
}

/** The built-in components that show user files (L2.12). */
export const MEDIA_COMPONENTS = { media: 'studio/media', lottie: 'studio/lottie' } as const;

export interface ActionArgsMap {
  open: string | OpenArgs;
  click: ClickArgs;
  double_click: ClickArgs;
  hover: TargetSpec | (TargetObject & { ms?: number; move_ms?: number });
  type: TypeArgs;
  press: string | PressArgs;
  select: SelectArgs;
  pick: PickArgs;
  menu: MenuArgs;
  date: string | DateArgs;
  scroll: number | ScrollArgs;
  drag: DragArgs;
  drop_file: DropFileArgs;
  wait: number;
  wait_for: string | WaitForArgs;
  hold: number;
  assert: string | AssertArgs;
  screenshot: string | ScreenshotArgs;
  new_tab: TargetSpec | NewTabArgs;
  switch_page: string | SwitchPageArgs;
  eval: string | EvalArgs;
  notify: string | NotifyArgs;
  emit: string | EmitArgs;
  cursor: CursorArgs;
  wait_for_email: WaitForEmailArgs;
  download: DownloadArgs;
  capture_text: CaptureTextArgs;
  hook: string | HookArgs;
}

export type ActionName = keyof ActionArgsMap;

export const ACTION_NAMES: readonly ActionName[] = [
  'open',
  'click',
  'double_click',
  'hover',
  'type',
  'press',
  'select',
  'pick',
  'menu',
  'date',
  'scroll',
  'drag',
  'drop_file',
  'wait',
  'wait_for',
  'hold',
  'assert',
  'screenshot',
  'new_tab',
  'switch_page',
  'eval',
  'notify',
  'emit',
  'cursor',
  'wait_for_email',
  'download',
  'capture_text',
  'hook',
] as const;

/** A step = exactly one action key + optional common modifiers. */
export type Step = StepCommon & { [K in ActionName]?: ActionArgsMap[K] };

/** A step after normalisation: shorthands expanded, action identified. */
export interface NormalizedStep<K extends ActionName = ActionName> extends StepCommon {
  action: K;
  /** Normalised args (object forms: strings expanded to the documented object). */
  args: NormalizedArgs[K];
  /** Index within the scene. */
  index: number;
  /** Original YAML step (for error messages). */
  raw: Step;
}

/** Normalised (object-form) arguments per action. */
export interface NormalizedArgsMap {
  open: OpenArgs;
  click: TargetObject & ClickOptions;
  double_click: TargetObject & ClickOptions;
  hover: TargetObject & { ms?: number; move_ms?: number };
  type: TypeArgs;
  press: PressArgs;
  select: SelectArgs;
  pick: PickArgs;
  menu: MenuArgs;
  date: DateArgs;
  scroll: ScrollArgs;
  drag: DragArgs;
  drop_file: DropFileArgs;
  wait: { seconds: number };
  wait_for: WaitForArgs;
  hold: { seconds: number };
  assert: AssertArgs;
  screenshot: ScreenshotArgs;
  new_tab: NewTabArgs;
  switch_page: SwitchPageArgs;
  eval: EvalArgs;
  notify: NotifyArgs;
  emit: EmitArgs;
  cursor: { mode: 'show' | 'hide' | 'move' | 'set'; to?: TargetSpec | PointSpec; duration?: number };
  wait_for_email: WaitForEmailArgs;
  download: Omit<DownloadArgs, 'click'> & { click: TargetObject & ClickOptions };
  capture_text: CaptureTextArgs;
  hook: HookArgs;
}
export type NormalizedArgs = NormalizedArgsMap;

export type FrameStyle = 'raw' | 'card' | 'browser' | 'laptop' | 'phone' | 'tablet';

/**
 * Layouts of a multi-page scene (L2.11): `split` ⇒ studio/layout-split (the pages side by side, stacked in vertical),
 * `pip` ⇒ studio/layout-pip (one page over the other, picture in picture).
 */
export type MultiPageFrame = 'split' | 'pip';

/**
 * How a capture is framed: a FrameStyle (`card` ⇒ studio/layout-card, `browser` ⇒ studio/layout-browser…), a
 * multi-page frame (`split`, `pip`) or the id of a layout component ("namespace/name").
 */
export type FrameSpec = FrameStyle | MultiPageFrame | ComponentId;

/** The built-in layout component of each multi-page frame (L2.11). */
export const MULTI_PAGE_LAYOUTS: Readonly<Record<MultiPageFrame, ComponentId>> = {
  split: 'studio/layout-split',
  pip: 'studio/layout-pip',
};

// ── Multi-page scenes (L2.11) ────────────────────────────────────────────────

/** Viewport presets of a page filmed in a multi-page scene; `desktop` is the capture size of the project. */
export type ViewportPreset = 'desktop' | 'laptop' | 'tablet' | 'mobile';

/** A page viewport in CSS px; `mobile` emulates a mobile device (meta viewport, overlay scrollbars), `touch` a touch screen. */
export interface ViewportSpec {
  width: number;
  height: number;
  mobile?: boolean;
  touch?: boolean;
}

/** The fixed presets (`desktop` = the capture size: `capture.width × capture.height`). */
export const VIEWPORT_PRESETS: Readonly<Record<Exclude<ViewportPreset, 'desktop'>, ViewportSpec>> = {
  laptop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180, mobile: true, touch: true },
  mobile: { width: 390, height: 844, mobile: true, touch: true },
};

export const VIEWPORT_PRESET_NAMES: readonly ViewportPreset[] = ['desktop', 'laptop', 'tablet', 'mobile'];

/** Most pages a scene films at the same time (the built-in layouts show two: split screen, picture in picture). */
export const MAX_SCENE_PAGES = 2;

/**
 * One page of a multi-page scene (scene key `pages`). All its pages are recorded at the same time, each on its own
 * track; a step acts on one of them (`on:`).
 */
export interface ScenePageSpec {
  /**
   * Environment page key whose base URL a relative `open` resolves against. Default: the page id when it is an
   * environment key, else the key before ":" in `open` (`open: shop:/products`).
   */
  page?: string;
  /**
   * Opened at the scene start: a path (relative to the environment page), `<env page>:<path>` or an absolute URL.
   * Omit to continue the page as an earlier scene left it.
   */
  open?: string;
  /** A preset (desktop, laptop, tablet, mobile) or `{width, height, mobile?, touch?}` (default: desktop). */
  viewport?: ViewportPreset | ViewportSpec;
  /** Name a layout may show next to the page ("Buyer", "Supplier"). */
  label?: string;
  /** Where this page's cursor rests at the scene start (default 'auto'). */
  cursor?: SceneCursor;
  /** The persona this page is signed in as (L1.6; `none`: no persona). Default: the persona whose `pages` list its environment page. */
  persona?: string;
}

/**
 * `pages:` of a scene: a map page id → page, or a list of environment page keys / `{id?, page, open?, viewport?…}`
 * (default id: the environment key, plus `-<preset>` for a viewport other than desktop: `shop-mobile`).
 */
export type ScenePages = Record<string, ScenePageSpec | null> | Array<string | (ScenePageSpec & { id?: string })>;

/** The built-in layout component each FrameStyle stands for. */
export const FRAME_STYLE_LAYOUTS: Readonly<Record<FrameStyle, ComponentId>> = {
  card: 'studio/layout-card',
  browser: 'studio/layout-browser',
  laptop: 'studio/layout-laptop',
  phone: 'studio/layout-phone',
  tablet: 'studio/layout-tablet',
  raw: 'studio/layout-raw',
};

/**
 * Where the cursor rests at a scene's start (scene key `cursor`):
 *  - 'auto' (default): a neutral point near the scene's first pointer target, never covering it, inside the viewport
 *    (the previous position is kept on a scene that continues from the current state when it is already clear of the
 *    first target);
 *  - 'keep': stay where the previous scene left it;
 *  - a viewport point `{x, y}` (CSS px);
 *  - a target: rest on that element (as a hover would).
 * A scene that opens a page places the cursor while the page loads (cut by the editor); a scene that continues from
 * the current state glides there during its still, so the capture never shows a jump.
 */
export type SceneCursor = 'auto' | 'keep' | PointSpec | TargetSpec;
export type TransitionKind = 'crossfade' | 'cut' | 'fade-black';

/**
 * The transition INTO a scene or a card: a kind (crossfade, cut, fade-black: the theme's transition of that kind, else
 * the built-in one) or a transition component — its id ("studio/transition-tap-open") or `{component, params}`.
 */
export type SceneTransition = TransitionKind | ComponentId | { component: ComponentId; params?: Record<string, unknown> };

export interface Scene {
  id: string;
  caption?: CaptionSpec;
  /** Environment page key (e.g. admin, app). Default: previous scene's page, else the first key of the environment. */
  page?: string;
  /** Path or URL opened at scene start. Omit to continue from the previous scene's state. */
  open?: string;
  /**
   * Multi-page scene (L2.11): the pages filmed at the same time on one clock (instead of `page` / `open`), e.g. a buyer
   * and a supplier, or one site on desktop and mobile. Steps act on the first page unless they say `on: <page>`.
   */
  pages?: ScenePages;
  /**
   * The persona this scene's page is signed in as (L1.6; `none`: no persona). Default: the persona whose `pages` list the
   * environment page. A page keeps one persona for the whole run. Multi-page scenes bind each page: `pages.<id>.persona`.
   */
  persona?: string;
  steps: Step[];
  /** Edit-time speed for the whole scene. */
  speed?: number;
  /** Seconds of stillness at scene start (default pacing.scene_start_still). */
  still?: number;
  /** Where the cursor rests at the scene start (default 'auto'). */
  cursor?: SceneCursor;
  /** Transition INTO this scene: a kind or a transition component (default: the theme's transition). */
  transition?: SceneTransition;
  /** Frame of this scene: a FrameStyle or a layout component id (default: scenario frame, else project frame). */
  frame?: FrameSpec;
  /** Tutorial overlays of this scene's steps (overrides the scenario's switches; `progress` is scenario-only). */
  tutorial?: TutorialSwitch;
  irreversible?: boolean;
  /** Skip this scene entirely. */
  skip?: boolean;
  /**
   * Played during the take but left out of the video (L5.8, R-FLD-31): a scene that prepares what the next ones film
   * (a page reached, a form filled off camera). An edit value: a render on an existing take can toggle it.
   */
  offscreen?: boolean;
  note?: string;
}

export interface InterstitialSpec extends MediaFileFields {
  /** Card text (required unless the interstitial is a video, image or lottie file). */
  text?: string;
  kicker?: string;
  /** Seconds on screen (> 0). */
  duration?: number;
  /** Legacy template interstitial style override (ignored when `component` is set). */
  style?: string;
  /** Interstitial component id (default: the theme's). */
  component?: ComponentId;
  params?: Record<string, unknown>;
}

/** "Time passes" card between scenes; takes no capture time. */
export interface InterstitialScene {
  interstitial: InterstitialSpec;
  /** Default "interstitial-<index>". */
  id?: string;
}

export interface CardSpec extends MediaFileFields {
  /** Card component id (default: the theme's card component, studio/card-title). */
  component?: ComponentId;
  params?: Record<string, unknown>;
  /** Slot values (title, kicker, text…); a card needs `component`, `slots.title` or a video / image / lottie file. */
  slots?: Record<string, string>;
  /** Seconds on screen (> 0; default: the component's duration — a video or Lottie file: its own length). */
  duration?: number;
  /** Transition INTO this card: a kind or a transition component, e.g. studio/transition-tap-open (default: the theme's). */
  transition?: SceneTransition;
}

/** Generic full-screen card (title, chapter, quote…) between scenes; takes no capture time. */
export interface CardScene {
  card: CardSpec;
  /** Default "card-<index>". */
  id?: string;
}

export type SceneEntry = Scene | InterstitialScene | CardScene;

export function isInterstitial(s: SceneEntry): s is InterstitialScene {
  return (s as InterstitialScene).interstitial !== undefined;
}

export function isCard(s: SceneEntry): s is CardScene {
  return (s as CardScene).card !== undefined;
}

/** A captured scene (with steps), as opposed to a card or an interstitial (which take no capture time). */
export function isCaptureScene(s: SceneEntry): s is Scene {
  return !isInterstitial(s) && !isCard(s);
}

/** Scenario `intro` (or `false`): overrides of the theme's intro card — or the user's own file (L2.12). */
export interface IntroSpec extends MediaFileFields {
  /** Intro component id (default: the theme's). */
  component?: ComponentId;
  params?: Record<string, unknown>;
  /** Seconds (> 0; default template.intro.duration). */
  duration?: number;
}

/** Scenario `outro` (or `false`): overrides of the theme's outro card — or the user's own file (L2.12). */
export interface OutroSpec extends MediaFileFields {
  /** Outro component id (default: the theme's). */
  component?: ComponentId;
  params?: Record<string, unknown>;
  tagline?: string;
  url?: string;
  /** Seconds (> 0; default template.outro.duration). */
  duration?: number;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export interface HttpHookSpec {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  url: string;
  headers?: Record<string, string>;
  /** JSON body. */
  json?: unknown;
  /** Raw body. */
  body?: string;
  /** Expected status code(s). Default: any 2xx. */
  expect?: number | number[];
  /** Store the response as `{{hooks.<save_as>.status|body|json.<path>}}` for later templating. */
  save_as?: string;
  /** Request that undoes this one (templated after the request, so it can use `{{response.json.id}}`). */
  rollback?: Omit<HttpHookSpec, 'rollback' | 'save_as'>;
}

export interface SqlHookSpec {
  /** SQL file relative to the project dir. */
  file?: string;
  /** Inline SQL. */
  query?: string;
  /** Database key from project.databases (default: the first one). */
  db?: string;
  /** SQL that undoes this hook: a file path (*.sql) or inline SQL. */
  rollback?: string | { file?: string; query?: string };
}

export interface ShellHookSpec {
  run: string;
  cwd?: string;
  env?: Record<string, string>;
  rollback?: string;
  timeout?: number;
}

export interface JsHookSpec {
  /** Inline JS evaluated in a page (function body; may `return` / `await`). */
  code?: string;
  /** JS file relative to the project dir. */
  file?: string;
  /** Environment page key whose page runs it (default: the first page). */
  page?: string;
  rollback?: string;
}

/** Common fields on any hook entry. */
export interface HookCommon {
  name?: string;
  /** Required for hooks detected/declared as destructive. */
  confirm?: boolean;
  /** Declare the hook destructive explicitly (also auto-detected). */
  destructive?: boolean;
  /** Continue even if this hook fails. */
  optional?: boolean;
  /**
   * Shell hooks only: `false` declares that the command only reads, so it may run on a read-only environment (L1.7).
   * http and sql hooks are classified from their request / SQL; js hooks are guarded in their tab.
   */
  writes?: boolean;
}

/** `sql: "hooks/x.sql"` (path when it ends with .sql, inline query otherwise); `shell: "cmd"`; `js: "code"`. */
export type HookStep = HookCommon &
  (
    | { http: HttpHookSpec }
    | { sql: string | SqlHookSpec }
    | { shell: string | ShellHookSpec }
    | { js: string | JsHookSpec }
  );

export type HookKind = 'http' | 'sql' | 'shell' | 'js';

/** `hooks:` of a scenario or project.yaml (L5.8): name → one hook entry, or a list run in order. */
export type NamedHooks = Record<string, HookStep | HookStep[]>;

export interface Scenario {
  /** Format version (optional: a file without it is version 1). */
  version?: 1;
  /** Video name (usually equals the file name). */
  video: string;
  title?: { kicker?: string; text: string };
  /** `false` disables the intro card. */
  intro?: false | IntroSpec;
  /** `false` disables the outro card. */
  outro?: false | OutroSpec;
  /** Environment name (default project.default_env, else the first environment). */
  env?: string;
  /** Free variables usable as {{vars.x}} (and {{x}} when not shadowed). */
  vars?: Record<string, string>;
  setup?: HookStep[];
  teardown?: HookStep[];
  /**
   * Named hooks a `hook: <name>` step runs during the take (L5.8): one hook entry or a list of them, run in order. A
   * name here wins over project.yaml's `hooks:`.
   */
  hooks?: NamedHooks;
  capture?: Partial<CaptureSettings>;
  /** Frame of every scene (default: the project frame). */
  frame?: FrameSpec;
  template?: string;
  pacing?: Partial<Pacing>;
  /** Step defaults (L5.6): win over the project's. */
  defaults?: RunDefaults;
  music?: MusicSpec;
  /** Automatic tutorial overlays fed by the timeline (shortcuts, spotlight, numbered steps, loupe, progress bar). */
  tutorial?: TutorialSwitch;
  /** The length the video aims at (L5.5): the review's length rule uses it instead of the reference 60–120 s. */
  target_length?: TargetLength;
  /**
   * The caption component of the whole video (L4.5): a caption component id, between a render override and the theme's
   * caption (`overrides.components.caption` → `caption_component` → theme → built-in). An edit value.
   */
  caption_component?: ComponentId;
  /** The product's clock at capture time 0 (L1.7; wins over the project's); `false` turns the project's clock off. */
  clock?: ClockSpec | false;
  /** Answers to writes stopped on read-only runs (L1.7), tried before the environment's `read_only.mocks`. */
  mocks?: WriteMockSpec[];
  scenes: SceneEntry[];
}

export interface MusicSpec {
  /** Audio file relative to the project dir. */
  file: string;
  /** Base volume 0..1 (intro, outro, cards and interstitials play at this level). */
  volume?: number;
  /** Volume factor under footage (0..1): the bed is ducked while product footage is on screen. */
  duck?: number;
  /** A track shorter than the video loops (default, with crossfaded seams); `false`: it plays once. */
  loop?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Project, pacing, capture
// ─────────────────────────────────────────────────────────────────────────────

export interface CaptureSettings {
  width: number;
  height: number;
  /** deviceScaleFactor: 1, or 2 for 4K from a 1920×1080 viewport. */
  scale: number;
  fps: number;
  /** Screencast frame format. */
  format: 'jpeg' | 'png';
  /** JPEG quality of the screencast frames (1-100; default 90 since L5.7: small text measured indistinguishable from 100). */
  quality: number;
  /**
   * Keep the screencast frames in runs/<id>/frames (their real timing, for the raw export at 60 fps). Default false
   * since L5.7: capture.mp4 is encoded during the take and nothing else is written.
   */
  keep_frames: boolean;
  /** libx264 CRF of capture.mp4 (when the encoder is libx264). */
  crf: number;
  /**
   * Encoder of capture.mp4, fed during the take (L5.7): `auto` (default) uses the Mac's hardware H.264 encoder
   * (VideoToolbox) when ffmpeg has it, else libx264 (preset veryfast, `crf`).
   */
  encoder?: CaptureEncoder;
  /**
   * Visit each page of the scenario once off camera before the take (L5.7, R-FLD-27): its code, fonts and images are
   * cached, so the first visit is not filmed cold. Default false.
   */
  prewarm?: boolean;
  /**
   * Keep one picture per step of a capture in runs/<id>/screenshots, as a dry run does (L5.6): the captured frame at
   * the end of each step (no screenshot taken during the take). Default false.
   */
  step_shots?: boolean;
}

/** `defaults` of a project or a scenario (L5.6; the scenario's win): values every step uses when it sets none. */
export interface RunDefaults {
  /**
   * Seconds every wait and action waits when it has no `timeout` of its own: targets, `wait_for`, `wait_for_email`,
   * `download` and the other actions (built-in defaults: 15, and 30 for wait_for_email / download).
   */
  timeout_s?: number;
}

export const CAPTURE_ENCODERS = ['auto', 'videotoolbox', 'libx264'] as const;
export type CaptureEncoder = (typeof CAPTURE_ENCODERS)[number];

export const DEFAULT_CAPTURE: CaptureSettings = {
  width: 1920,
  height: 1080,
  scale: 1,
  fps: 30,
  format: 'jpeg',
  quality: 90,
  keep_frames: false,
  crf: 16,
};

/** Deterministic pacing (field-tested defaults). */
export interface Pacing {
  /** Seconds still at scene start (1.5–2). */
  scene_start_still: number;
  /** Cursor travel: ms = clamp(move_base_ms + distance_px * move_ms_per_px, move_min_ms, move_max_ms) (field notes: clamp(0.9·d, 450, 1100)). */
  move_base_ms: number;
  move_ms_per_px: number;
  move_min_ms: number;
  move_max_ms: number;
  /** Moves shorter than this (px) are "nudges" (repeated clicks on almost the same spot): short travel and hover. */
  nudge_px: number;
  /** Travel time of a nudge of nudge_px; shorter nudges scale down to 60 % of it (≈150–250 ms). A zero-length move takes 0 ms. */
  nudge_ms: number;
  /** Hover pause before pressing after a nudge (≈120). */
  nudge_hover_ms: number;
  /** Hover pause before pressing (150–250). */
  hover_ms: number;
  /** mousedown → mouseup. */
  press_ms: number;
  /** Pause after an ordinary click. */
  after_click_ms: number;
  /** Pause after a click that opened a menu/popover/dialog (600–1000). */
  after_popup_ms: number;
  /** Minimum time between a click and the next step when the click navigated or changed the URL (1.5–2.8 s in the field notes). */
  after_navigation_ms: number;
  /**
   * How long a click gets to show that an expected popup opened (aria-expanded="true" or a new visible popup, polled
   * every 40 ms) before the next click strategy is tried.
   */
  popup_fallback_ms: number;
  /** How long the last click strategy waits for an expected popup before the step reports it missing. */
  popup_timeout_ms: number;
  /**
   * Typing speed, characters per second (field notes: ~14). A `type` step without `cps` adapts it (R-CHO-14): search
   * fields at most 10, long free text up to 24.
   */
  type_cps: number;
  /** Smooth scroll duration in seconds (1.5–2). */
  scroll_duration: number;
  /** Default `scroll.offset` with a target: final scrollTop = target top + offset (−140 ⇒ the target ends 140 px below the top). */
  scroll_offset: number;
  /** Deterministic ±fraction jitter applied to durations (0 = none). */
  jitter: number;
  /** After navigation: wait for network idle up to this many ms. */
  settle_ms: number;
  /**
   * Multi-page scenes (L2.11): pause when a step acts on another page than the previous step, before that page's cursor
   * starts to move (the viewer's eye moves to the other page; no cursor ever jumps).
   */
  page_switch_ms: number;
  /** Seconds a step's `park: true` holds the cursor still on the result (field notes 1.5–2.6). */
  park_hold: number;
  /** Seconds a scroll's `park: true` holds the cursor next to the target (field notes 3–3.5). */
  park_scroll_hold: number;
}

export const DEFAULT_PACING: Pacing = {
  scene_start_still: 1.6,
  move_base_ms: 0,
  move_ms_per_px: 0.9,
  move_min_ms: 450,
  move_max_ms: 1100,
  nudge_px: 60,
  nudge_ms: 250,
  nudge_hover_ms: 120,
  hover_ms: 200,
  press_ms: 90,
  after_click_ms: 350,
  after_popup_ms: 800,
  after_navigation_ms: 1500,
  popup_fallback_ms: 300,
  popup_timeout_ms: 700,
  type_cps: 14,
  scroll_duration: 1.6,
  scroll_offset: -140,
  jitter: 0.08,
  settle_ms: 3000,
  page_switch_ms: 500,
  park_hold: 2,
  park_scroll_hold: 3.2,
};

/**
 * What a sign-in page looks like (L1.6), matched against a page's origin + path (never its query or fragment): a path
 * prefix ("/sign-in" — also "/sign-in/…", not "/sign-in-help"), "<environment page>:<path>" (that page's origin and
 * path), an absolute URL prefix ("https://sso.example.com" — every page there), or {regex, flags?}.
 */
export type LoginPattern = string | { regex: string; flags?: string };

/** How the runner tells a persona is signed in (L1.6), off camera before every run. */
export interface PersonaCheck {
  /** "<env page>:/path", a path (on the persona's first page) or an absolute URL. Default: the first page's "/". */
  url?: string;
  /** Text visible only when signed in (e.g. the account name). Without it: signed in when the page loads off the sign-in page. */
  expect_text?: string;
  /** Pages the check must NOT end on (also sign-in pages for the run's guard). */
  expect_not_url?: LoginPattern | LoginPattern[];
  /** Seconds (default 10). */
  timeout?: number;
}

/**
 * One step of an automated login (L1.6): open, click, type, press, wait_for or wait (scenario syntax), run off camera in
 * a tab of its own. Typed secrets come from {{env:…}} / {{keychain:…}} references.
 */
export type LoginStep = (
  | { open: string | OpenArgs }
  | { click: TargetSpec }
  | { type: { into?: TargetSpec; text: string; enter?: boolean } }
  | { press: string | PressArgs }
  | { wait_for: string | WaitForArgs }
  | { wait: number }
) & {
  /** Seconds before the step fails (default 15). */
  timeout?: number;
  note?: string;
};

/**
 * One account the videos are filmed as (L1.6): its session lives outside the project, in
 * ~/.retake/profiles|sessions/<project>/<env>/<persona> (RETAKE_HOME moves it) — never a path here.
 */
export interface PersonaConfig {
  /** The persona's mail address (L5.6): `wait_for_email {to: persona:<name>}`, the mailbox label of a mail card. */
  email?: string;
  /** Environment pages this persona is signed into by default (a page is in at most one persona's list). */
  pages?: string[];
  /** profile (default): a Chromium profile kept by `retake login`, copied for each run; storage_state: cookies + localStorage only. */
  session?: 'profile' | 'storage_state';
  check?: PersonaCheck;
  /** Sign-in pages of this persona (with auth.login_url and check.expect_not_url). */
  login_url?: LoginPattern | LoginPattern[];
  /** Automated login, off camera: used when the saved session is missing or expired. */
  login?: LoginStep[];
}

export interface AuthConfig {
  /** Legacy single account: persistent, pre-authenticated Chromium profile directory (~ expanded). Prefer `personas`. */
  profile?: string;
  /** Legacy single account: Playwright storageState JSON (alternative to profile). Prefer `personas`. */
  storage_state?: string;
  /** Sign-in pages of every persona (and of pages without one): landing there during a run fails it. */
  login_url?: LoginPattern | LoginPattern[];
  /** Named accounts (L1.6). */
  personas?: Record<string, PersonaConfig>;
}

export interface DatabaseConfig {
  /** Connection URL; may use {{env:VAR}} / {{keychain:service/account}} references. Never a clear-text password. */
  url: string;
}

// ── Environments: display URLs, production and read-only access, clock (L1.7) ─────────────────────────────

/**
 * Access of an environment. `read-only`: hooks that write are refused and the browser's writes to the environment's
 * hosts are stopped (or answered by a mock); `read-write`: nothing is stopped.
 */
export const ENVIRONMENT_ACCESS = ['read-only', 'read-write'] as const;
export type EnvironmentAccess = (typeof ENVIRONMENT_ACCESS)[number];

/** A page of an environment as written in project.yaml: its base URL, or `{url, display}` (the URL the video shows). */
export type EnvironmentPageSpec = string | { url: string; display?: string };

/**
 * A write the read-only guard lets through: `"[METHOD ]<page>:/path"` (against that page's base URL) or
 * `"[METHOD ]/path"` (any guarded host); `*` matches within one path segment, `**` anything; the query is ignored.
 * `operation` narrows it to one GraphQL operation name.
 */
export type WriteRuleSpec = string | { request: string; operation?: string };

/** The answer to a write stopped on a read-only run (scenario `mocks:`, environment `read_only.mocks`). Literal. */
export interface WriteMockSpec {
  /** Same pattern as an allow entry: `"[METHOD ]<page>:/path"` or `"[METHOD ]/path"`. */
  request: string;
  /** GraphQL operation name. */
  operation?: string;
  /** 200–599, default 200. */
  status?: number;
  /** JSON body (content type application/json). Exactly one of `json` / `body` at most. */
  json?: unknown;
  /** Raw body (content type text/plain unless `content_type`). */
  body?: string;
  content_type?: string;
  headers?: Record<string, string>;
  /** Wait before answering (0–10 000 ms). */
  delay_ms?: number;
}

/** `read_only:` of an environment: used only when a run on it is read-only. */
export interface ReadOnlySettings {
  /** More hosts whose writes are stopped (allow_hosts syntax, `*.example.com`; `"*"` = every host). The pages' hosts always are. */
  hosts?: string[];
  /** Writes let through (a token refresh, a search sent as POST…). */
  allow?: WriteRuleSpec[];
  /** Answers to stopped writes, for every scenario on this environment (a scenario's own `mocks` come first). */
  mocks?: WriteMockSpec[];
}

/** The long form of an environment in project.yaml (the short form is the page map itself). */
export interface EnvironmentSpec {
  /** A production environment: read-only unless `access: read-write`, and then only with `--allow-writes`. */
  production?: boolean;
  /** Default: read-only in production, else read-write. */
  access?: EnvironmentAccess;
  pages: Record<string, EnvironmentPageSpec>;
  read_only?: ReadOnlySettings;
}

/**
 * What project.yaml says about an environment besides its page URLs (`ProjectConfig.environment_settings`, derived
 * by loadProject; only environments that say something are listed).
 */
export interface EnvironmentSettings {
  production?: boolean;
  /** As written (absent: read-only in production, else read-write — core environmentAccess). */
  access?: EnvironmentAccess;
  /** Page key → display base, normalised (`https://host[:port][/path]`, no trailing slash). */
  display?: Record<string, string>;
  read_only?: ReadOnlySettings;
  /** A sandbox environment (L1.8): its manifest and provider. A sandbox is never production and always read-write. */
  sandbox?: EnvironmentSandbox;
  /** The sandbox's own test mailbox (core mailboxFor: it replaces the project's `mailbox` on this environment). */
  mailbox?: MailboxConfig;
  /** The sandbox's databases (core databasesFor: merged over the project's `databases` on this environment). */
  databases?: Record<string, DatabaseConfig>;
}

// ── Sandbox mode (L1.8) ─────────────────────────────────────────────────────────

/** How a sandbox starts its services: `docker compose` on its compose files, or local processes. */
export const SANDBOX_PROVIDERS = ['docker-compose', 'process'] as const;
export type SandboxProvider = (typeof SANDBOX_PROVIDERS)[number];

/** How a sandbox goes back to its seed before a take: run the seed again, or restore a database snapshot. */
export const SANDBOX_RESET_STRATEGIES = ['reseed', 'snapshot'] as const;
export type SandboxResetStrategy = (typeof SANDBOX_RESET_STRATEGIES)[number];

/** The version of sandbox.yaml this Retake reads. */
export const SANDBOX_VERSION = 1;

/**
 * How a sandbox tells a service is up: an http(s) GET (`path` on the service's `url`, or an absolute local `url`; ok on
 * 200–399 or `status`, optionally containing `text`) or, for a process service, a TCP connect to `tcp`.
 */
export interface SandboxHealthSpec {
  path?: string;
  url?: string;
  /** A port on this machine (process services only: a port Docker publishes always accepts a connection). */
  tcp?: number;
  status?: number | number[];
  text?: string;
  /** Seconds before the service counts as not healthy. */
  timeout_s?: number;
  /** Delay between two tries (ms). */
  interval_ms?: number;
}

/** `false`: no health check; a string: a path on the service's `url` (or an absolute local URL). */
export type SandboxHealth = false | string | SandboxHealthSpec;

/** One service of a sandbox: a compose service (docker-compose) or a process to start (process). */
export interface SandboxService {
  /** Base URL on this machine (loopback only): the default health check GETs it. */
  url?: string;
  /** Environment pages it serves: page key → URL, or {url, display} (the URL the video shows). */
  pages?: Record<string, EnvironmentPageSpec>;
  health?: SandboxHealth;
  /** process only: argv (a first word `node` runs the CLI's own Node) or a string run by `sh -c`. */
  command?: string | string[];
  /** process only: working directory, relative to sandbox.yaml (default its folder). */
  cwd?: string;
  /** process only: extra environment variables ({{env:VAR}} references are expanded). */
  env?: Record<string, string>;
  /** process only: seconds between SIGTERM and SIGKILL when it stops (default 10). */
  stop_timeout_s?: number;
}

/** A seed step that runs a command inside a compose service (`docker compose exec`): docker-compose sandboxes only. */
export interface ExecStepSpec {
  service: string;
  command: string | string[];
  env?: Record<string, string>;
  /** Seconds (default 300). */
  timeout_s?: number;
}

/** One step of a sandbox seed: an http, sql or shell hook (no js: there is no browser), or `exec`. */
export type SeedStep = HookCommon &
  (
    | { http: HttpHookSpec }
    | { sql: string | SqlHookSpec }
    | { shell: string | ShellHookSpec }
    | { exec: ExecStepSpec }
  );

/** A demo account the seed creates, bound to the persona of the same name on the sandbox's environment. */
export interface SandboxAccount extends PersonaConfig {
  /** `{{account.username}}` in its login steps. */
  username?: string;
  /** `{{account.password}}` in its login steps: plain (every sandbox URL is local; redacted) or {{env:…}} / {{keychain:…}}. */
  password?: string;
}

/** The sandbox's test mailbox: the project mailbox's fields, and whether a reset empties it (default true). */
export interface SandboxMailbox extends MailboxConfig {
  clear?: boolean;
  /** The sandbox does not serve it, and it is the sandbox's alone: emptied at every reset all the same. */
  external?: boolean;
}

/** A database of sandbox.yaml. */
export interface SandboxDatabase extends DatabaseConfig {
  /** The sandbox does not start its server, and it is the sandbox's alone: sql seed steps may rewrite it. */
  external?: boolean;
}

/** sandbox.yaml (version 1, L1.8): how to start a disposable copy of the product, seed it and reset it before a take. */
export interface SandboxManifest {
  version: typeof SANDBOX_VERSION;
  provider: SandboxProvider;
  /**
   * docker-compose only: the compose files (relative to sandbox.yaml; default [compose.yaml]), the project name, and the
   * env file docker compose reads its `${VAR}` values from (L5.8: default `.env` next to the first compose file when there
   * is one; `false`: none).
   */
  compose?: { files?: string[]; project?: string; env_file?: string | false };
  services: Record<string, SandboxService>;
  /** The steps that build the demo data (paths relative to sandbox.yaml). */
  seed?: SeedStep[];
  reset?: {
    /** Default reseed. */
    strategy?: SandboxResetStrategy;
    /** snapshot: the Postgres database (a key of `databases`, default the first) snapshotted after seeding. */
    snapshot?: { database?: string };
    /** Services restarted after each reset (apps that do not survive a database swap). */
    restart?: string[];
  };
  databases?: Record<string, SandboxDatabase>;
  mailbox?: SandboxMailbox;
  /** Sign-in pages of every account (auth.login_url of the sandbox's environment). */
  login_url?: LoginPattern | LoginPattern[];
  accounts?: Record<string, SandboxAccount>;
}

/** Which sandbox an environment is (EnvironmentSettings / ResolvedEnvironment). */
export interface EnvironmentSandbox {
  /** Absolute path of its sandbox.yaml. */
  file: string;
  provider: SandboxProvider;
}

/** A sandbox as loadProject reads it (LoadedProject.sandboxes, keyed by its environment name). */
export interface LoadedSandbox {
  /** Its environment name (the key of project.yaml `sandboxes:`). */
  env: string;
  /** Absolute path of sandbox.yaml. */
  file: string;
  /** Its folder: every path of the manifest is relative to it. */
  dir: string;
  manifest: SandboxManifest;
  /** Warnings of sandbox.yaml. */
  issues: ValidationIssue[];
  /** The plain passwords of its accounts, by persona: registered as secret values when one signs in (never printed). */
  secrets: Record<string, string[]>;
}

/** The sandbox of a run (run.json and timeline.json `environment.sandbox`): the reset made before the take, if any. */
export interface RunSandbox {
  /** The sandbox's environment. */
  name: string;
  provider: SandboxProvider;
  /** Absent: no reset before this take (`--env <sandbox>` without `--sandbox`). */
  strategy?: SandboxResetStrategy;
  /** A snapshot was restored (rather than the seed run again). */
  restored?: boolean;
  reset_ms?: number;
  /** The seed's hash (12 characters). */
  seed_hash?: string;
  /** When the reset finished (ISO). */
  at?: string;
}

/**
 * `clock:` of a project or scenario: the date and time the product's browser clock reads when the capture starts
 * (ISO 8601; without an offset, wall time in the browser's time zone), or `{at, freeze}` (`freeze: true`: it never
 * moves).
 */
export type ClockSpec = string | { at: string; freeze?: boolean };

/** The clock of a run (core resolveClock). */
export interface ResolvedClock {
  /** As written. */
  at: string;
  /** The instant it names (epoch ms). */
  epoch_ms: number;
  /** The IANA zone a time without an offset was read in (`browser.timezone`, else the machine's); absent: an explicit offset. */
  timezone?: string;
  freeze?: true;
}

export interface BrowserConfig {
  executable?: string;
  /** 'chromium' = new headless (default); 'headless-shell' = old headless shell. */
  channel?: 'chromium' | 'headless-shell' | 'chrome';
  headless?: boolean;
  args?: string[];
  locale?: string;
  timezone?: string;
  color_scheme?: 'light' | 'dark';
  /**
   * false: run Chromium without its frame rate limiter (L1.3). It removes the ≈ 0.26 s capture stall after a dialog
   * whose overlay has a backdrop-filter closes, but requestAnimationFrame then runs at thousands of Hz while anything
   * animates (fixed-step animations play too fast) and the CPU climbs 2–6×. Default true (the limiter).
   */
  frame_rate_limit?: boolean;
}

/**
 * A test mailbox the runner reads with `wait_for_email`. `mailpit`: the Mailpit API (GET <url>/api/v1/messages and
 * <url>/api/v1/message/<ID>); `http`: the generic JSON shape documented in docs/guide/scenarios.md (GET <url>/messages and
 * <url>/messages/<id>). Its host must be allowed (localhost, an environment host or `allow_hosts`).
 */
export interface MailboxConfig {
  provider: 'mailpit' | 'http';
  /** Base URL, e.g. http://localhost:8025. */
  url: string;
  /** Polling interval in ms (default 500). */
  poll_ms?: number;
  /** Extra request headers (e.g. an API token: use {{env:VAR}}). */
  headers?: Record<string, string>;
}

export interface ProjectConfig {
  /** Format version of project.yaml (optional: a file without it is version 1). */
  version?: 1;
  name: string;
  /**
   * env name → page key → real base URL: both forms of project.yaml reduced to their page URLs (the long form's
   * `pages`, `{url, display}` → its url). Display URLs, production and access live in `environment_settings`.
   */
  environments: Record<string, Record<string, string>>;
  /** Derived by loadProject from the environments (never written in project.yaml): only those that say something (L1.7). */
  environment_settings?: Record<string, EnvironmentSettings>;
  /** The product's clock at capture time 0 for every scenario (a scenario's `clock` wins; L1.7). */
  clock?: ClockSpec;
  default_env?: string;
  /** Global auth, or per environment name. */
  auth?: AuthConfig | Record<string, AuthConfig>;
  capture: CaptureSettings;
  /** Default frame of every scenario: a FrameStyle or a layout component id (default 'card'). */
  frame: FrameSpec;
  template: string;
  locale?: string;
  /** Extra hosts hooks may target (environment hosts, localhost and 127.0.0.1 are always allowed). */
  allow_hosts?: string[];
  databases?: Record<string, DatabaseConfig>;
  pacing?: Partial<Pacing>;
  /** Step defaults of every scenario (L5.6; a scenario's `defaults` win). */
  defaults?: RunDefaults;
  browser?: BrowserConfig;
  /** Hooks run by `env_reset`. */
  reset?: HookStep[];
  /** Named hooks of every scenario (L5.8): what a `hook: <name>` step runs when the scenario has no hook of that name. */
  hooks?: NamedHooks;
  vars?: Record<string, string>;
  /** Test mailbox read by `wait_for_email`. */
  mailbox?: MailboxConfig;
  /** Defaults of the raw capture export for editors (`retake export-capture`, `retake run --raw`; L2.13). */
  raw?: RawSettings;
  /**
   * Sandbox environments (L1.8), as written: environment name → its sandbox.yaml, relative to the project dir. loadProject
   * adds each one to `environments` (its pages), `environment_settings` and `auth` (its accounts).
   */
  sandboxes?: Record<string, string>;
}

// ── Raw capture export for editors (L2.13) ────────────────────────────────────

/** Clip codecs of a raw export: H.264 high profile MP4, or ProRes 422 HQ (.mov). */
export const RAW_FORMATS = ['mp4', 'prores'] as const;
export type RawFormat = (typeof RAW_FORMATS)[number];
/** Frame rates of a raw export (CFR, from the capture's own frame timing — never interpolated). */
export const RAW_FPS = [30, 60] as const;
export type RawFps = (typeof RAW_FPS)[number];
/**
 * Cursor of a raw export: `baked` as captured; `none` captured without the in-page cursor (the cursor track and the
 * clicks are still exported as data); `layer` a separate transparent cursor + click-ripple video per clip.
 */
export const RAW_CURSOR_MODES = ['baked', 'none', 'layer'] as const;
export type RawCursorMode = (typeof RAW_CURSOR_MODES)[number];
/** Transparent cursor layers: ProRes 4444 (.mov) or VP9 with alpha (.webm). */
export const RAW_LAYER_FORMATS = ['prores', 'webm'] as const;
export type RawLayerFormat = (typeof RAW_LAYER_FORMATS)[number];

/** project.yaml `raw`: defaults of `retake export-capture` / `retake run --raw` (the CLI flags win). */
export interface RawSettings {
  format?: RawFormat;
  fps?: RawFps;
  cursor?: RawCursorMode;
  layer?: RawLayerFormat;
  /** Also write one continuous "selects" file of the clips (default false). */
  selects?: boolean;
  /** Cut the loading inside scenes (default true; page loads before a scene's still are never in a clip). */
  cuts?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Template (brand & motion style)
// ─────────────────────────────────────────────────────────────────────────────

export interface TextStyle {
  font: 'display' | 'body';
  weight?: number;
  size: number;
  uppercase?: boolean;
  color?: string; // colour key (accent/text/muted/paper) or CSS colour
  letter_spacing?: number;
}

export interface Template {
  name?: string;
  colors: { accent: string; text: string; muted: string; paper: string; [k: string]: string };
  /** Font files relative to the template dir (ttf/otf/woff2). */
  fonts: { display: string; body: string[] };
  /** Logo file relative to the template dir. */
  logo: string;
  /** Optional wordmark image (used by outro layouts). */
  wordmark?: string;
  background: { type: 'solid' | 'radial' | 'linear'; from?: string; to?: string; color?: string };
  frame: { style: FrameStyle; width: number; radius: number; shadow: 'none' | 'soft' | 'strong' };
  captions: {
    position: 'below' | 'above' | 'overlay' | 'none';
    kicker: TextStyle;
    line: TextStyle;
  };
  intro: { duration: number; layout: 'logo-kicker-title' | 'kicker-title' | 'logo-only' };
  outro: { duration: number; layout: 'logo-wordmark-tagline-url' | 'logo-tagline' | 'logo-only'; url?: string; tagline?: string };
  interstitial: { style: 'dark-clock' | 'paper' | 'dark'; duration?: number };
  transitions: { between_scenes: TransitionKind; duration: number };
  cursor: { style: 'arrow-dark' | 'arrow-light' | 'debug'; ripple_color: string; size?: number };
  motion: { default_zoom: 'none' | number; max_zoom: number; zoom_ease: [number, number, number, number] };
  style_bias: 'real' | 'balanced' | 'motion';
  brandmark?: { position: 'bottom-right' | 'bottom-left' | 'top-right' | 'none'; opacity?: number; size?: number };
  /** Brand name and URL (wordmark drawn as text, outro url). */
  brand?: TemplateBrand;
  /**
   * Default component per kind (an id, or {id, params}); `null` = none (e.g. `caption: null`: no captions).
   * A kind absent here is mapped from the legacy fields (frame.style, intro.layout, outro.layout, interstitial.style,
   * captions.position, transitions.between_scenes): see `resolveThemeComponents`.
   */
  components?: TemplateComponents;
}

export interface TemplateBrand {
  name?: string;
  /** Shown as written (e.g. "example.com"). */
  url?: string;
}

/**
 * A theme's own file for a full-frame kind (L2.12): `components: {intro: {video: assets/intro.mp4}}` — paths relative to
 * the template folder; `duration`, `params` (of studio/media or studio/lottie) as for a scenario entry.
 */
export interface TemplateMediaRef extends MediaFileFields {
  duration?: number;
  params?: Record<string, unknown>;
}

/** The kinds a theme may fill with a file instead of a component. */
export const TEMPLATE_MEDIA_KINDS = ['intro', 'outro', 'interstitial'] as const;

export type TemplateComponents = Partial<Record<ComponentKind, ComponentRef | TemplateMediaRef | null>>;

export interface LoadedTemplate {
  name: string;
  /** Absolute template directory. */
  dir: string;
  template: Template;
  /** Absolute paths of the assets. */
  assets: { logo: string; wordmark?: string; display: string; body: string[] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline (emitted by runners, consumed by editor & review)
// ─────────────────────────────────────────────────────────────────────────────

export interface TimelineScene {
  id: string;
  index: number;
  kind: 'scene' | 'interstitial' | 'card';
  /** Capture time. Interstitials and cards have t_start === t_end (they take no capture time). */
  t_start: number;
  t_end: number;
  /** Time the scene's "still" ends (actions begin). */
  t_actions?: number;
  page?: string;
  url?: string;
  caption?: { kicker?: string; text: string };
  speed?: number;
  transition?: SceneTransition;
  /** Scene-level frame as written in the scenario (the scenario/project default is in `Timeline.video.frame`). */
  frame?: FrameSpec;
  interstitial?: InterstitialSpec;
  card?: CardSpec;
  /** Scene-level tutorial switches as written (the scenario's are in `Timeline.video.tutorial`). */
  tutorial?: TutorialSwitch;
  /**
   * Multi-page scene (L2.11): the pages filmed at the same time, in the scenario's order; each one is recorded on its
   * own track (`Timeline.tracks`). Absent for a single-page scene (recorded in `capture`).
   */
  pages?: TimelineScenePage[];
  /** Played during the take but left out of the video (scene `offscreen: true`, L5.8): the edit shows nothing of it. */
  offscreen?: true;
  status: 'ok' | 'failed' | 'skipped' | 'partial';
}

/** A page of a multi-page scene as the run filmed it (L2.11). */
export interface TimelineScenePage {
  /** Page id (the key of the scene's `pages`). */
  id: string;
  /** Environment page key its URLs resolve against, when it has one. */
  page?: string;
  label?: string;
  /** Viewport in CSS px (`preset` when it came from one). */
  viewport: ViewportSpec & { preset?: ViewportPreset };
  /** URL at the end of the scene's still. */
  url?: string;
  /** Id of the track holding its video (`Timeline.tracks`). */
  track: string;
}

/**
 * A page recorded on its own (L2.11): every page of a multi-page scene gets one, on the same clock as `capture`
 * (frame n of every track is capture time n / fps: one frame grid). Outside the scenes that film it, a track holds its
 * last frame.
 */
export interface TimelineTrack {
  /** The page id. */
  id: string;
  /** CFR video, relative to the run directory (`capture-<id>.mp4`). */
  file: string;
  /** Frame index of the screencast (one {file, t} per line), relative to the run directory. */
  frames_file: string;
  /** Viewport in CSS px, device scale factor, mobile emulation. */
  width: number;
  height: number;
  scale: number;
  mobile?: boolean;
  touch?: boolean;
  preset?: ViewportPreset;
  fps: number;
  /** Screencast frames received. */
  frames: number;
  /** Capture-time intervals during which the page was recorded. */
  recording: Array<{ t_start: number; t_end: number }>;
  /** URL segments of the page while recorded (the browser chrome of a layout shows them). */
  pages: TimelinePageSegment[];
  /** This page's in-page cursor (each page has its own; only the acting page's moves). */
  cursor: CursorSample[];
  /** Icon changes, presses and click ripples of this page's cursor (L2.13). */
  cursor_effects?: CursorEffect[];
  /** Page loads this track did not show (R-ISS-08; absent when none). */
  loading?: TimelineLoading[];
}

/**
 * A full-page load the capture did not show (R-ISS-08, L1.2): from a new document's commit — or the recorder attaching
 * to a page that had painted nothing yet (a fresh tab, a page still loading) — the recorder kept the previous frame on
 * screen until the new document's first contentful paint. `t_end` is the first frame written after it (the moment
 * the hold ended when no frame came then): no frame of the capture (frames.jsonl) lies in [t_start, t_end).
 */
export interface TimelineLoading {
  t_start: number;
  t_end: number;
  /** Page id. */
  page?: string;
  /**
   * What ended it: the page's first contentful paint (`paint`); its load without one — no text, image or SVG, a PDF
   * viewer — once its network was idle, plus a grace (`load`: shown from then); the 10 s limit (`limit`: the page is
   * filmed as it is from then, with a run warning — also a fresh tab left blank); the recorder leaving the page — a page
   * switch, a multi-page scene's pause — (`left`); the end of the run (`end`).
   */
  until: 'paint' | 'load' | 'limit' | 'left' | 'end';
  /** Screencast frames not written. */
  held_frames: number;
}

/** A freeze of the capture (L5.7): no new frame from `t_start` (the last frame before the gap) to `t_end`. */
export interface TimelineStall {
  t_start: number;
  t_end: number;
  during: 'move' | 'ripple';
}

/** A wait the screen showed after the click at `click` (capture seconds): near-identical frames from `t_start` to `t_end`. */
export interface TimelineBusy {
  t_start: number;
  t_end: number;
  click: number;
}

/**
 * A pause of the take (L4.4, R-UI-19): the run waited before step `step` of `scene` for `ms` wall ms, which capture time
 * left out — the video goes on at `t` (capture seconds) from where it paused; what the page did meanwhile (timers,
 * animations, a running product clock) shows as a jump there.
 */
export interface TimelinePause {
  t: number;
  ms: number;
  scene: string;
  step: number;
}

/**
 * Held page loads (`TimelineLoading`) at least this long are cut by the edit and the raw export; a shorter freeze of
 * the previous frame is invisible (the same bound as the L1.3 capture stalls). The cut sits on the page change itself.
 */
export const LOADING_CUT_MIN_S = 0.15;

/** Step `overlay` as recorded by the runner: the spec plus the target measured at the END of the step. */
export interface TimelineOverlay {
  component: ComponentId;
  slots: Record<string, string>;
  params: Record<string, unknown>;
  /** Seconds, when the scenario sets it (else the component's default). */
  duration?: number;
  /** Description of the target that was measured. */
  target?: string;
  /** Target bbox at the end of the step (after any scroll), CSS px. */
  bbox?: BBox;
  /** Anchor point when there is no target bbox (cursor position at the end of the step). */
  point?: PointSpec;
  /** L2.12: when it starts, as written (default: the end of the step). */
  at?: OverlayAt;
  /** L2.12: a box-filling overlay (a user video, image or Lottie file): where its box goes. */
  box?: { anchor?: OverlayAnchor; rect?: BBox; scale?: number };
}

/** Edit info of the scenario carried into the timeline, so the editor does not re-read scenario.yaml. */
export interface TimelineVideo {
  title?: { kicker?: string; text: string };
  /** Scenario `intro` as written (`false` = no intro card; absent = theme intro). */
  intro?: false | IntroSpec;
  /** Scenario `outro` as written (`false` = no outro card; absent = theme outro). */
  outro?: false | OutroSpec;
  /** Effective default frame of the video: scenario `frame`, else the project `frame` (default 'card'). */
  frame?: FrameSpec;
  /** Template the run used (name or path). */
  template?: string;
  music?: MusicSpec;
  /** Scenario-level tutorial switches as written (L2.10). */
  tutorial?: TutorialSwitch;
  /** The scenario's `target_length` (L5.5). */
  target_length?: TargetLength;
  /** The scenario's `caption_component` (L4.5). */
  caption_component?: ComponentId;
}

/** The length a video aims at, seconds (scenario `target_length`, L5.5). */
export interface TargetLength {
  min_s: number;
  max_s: number;
}

export interface TimelineEvent {
  scene: string;
  scene_index: number;
  /** Step index within the scene. */
  step: number;
  id?: string;
  /**
   * `notification`: a web notification the product showed (Notification API or a service worker's showNotification),
   * captured by the in-page kit — `step` is -1 (it belongs to no step) and `data` = {name, title, body, icon?, tag?,
   * artefact}; the artefact is in `Timeline.artefacts`.
   */
  action: ActionName | 'scene_open' | 'scene_still' | 'notification';
  /** Capture time at which the action started (cursor starts moving, etc.). */
  t_start: number;
  /** Capture time at which the action itself completed (before any `hold`). */
  t_end: number;
  /** Stillness requested by the `hold` modifier: [t_end, t_end + hold]. */
  hold?: { t_start: number; t_end: number };
  /** The moment of the click/press (mousedown) for pointer actions. */
  t_click?: number;
  target?: { desc: string; bbox?: BBox };
  /** Cursor position at the click/end of the action. */
  point?: PointSpec;
  /**
   * Cursor position at the end of the step, before any park or hold (L5.5): what an overlay or a camera hint added to
   * the scenario after the capture anchors to when the step has no target box.
   */
  end_point?: PointSpec;
  mark?: string;
  caption?: { kicker?: string; text: string };
  speed?: number;
  /** Camera hint; `bbox` (target) / `point` measured at the end of the step, after any scroll. */
  camera?: CameraHint & { bbox?: BBox; point?: PointSpec };
  overlay?: TimelineOverlay;
  /** Step-level tutorial switches as written (L2.10). */
  tutorial?: TutorialSwitch;
  page?: string;
  url?: string;
  status: 'ok' | 'skipped' | 'failed' | 'dry';
  /** Click strategy that worked (real/dom/pointer). */
  strategy?: string;
  popup_opened?: boolean;
  error?: string;
  /** `emit` payload, screenshot path, etc. */
  data?: unknown;
}

export interface TimelineMarker {
  name: string;
  t: number;
  scene: string;
  step: number;
  /** Multi-page scenes: the page the marked step acts on. */
  page?: string;
}

export interface TimelinePageSegment {
  /** Page id (environment page key, "tab2", or `as`). */
  id: string;
  t_start: number;
  t_end: number;
  url?: string;
}

export interface CursorSample {
  t: number;
  x: number;
  y: number;
  visible: boolean;
  down?: boolean;
}

/** Icon the in-page cursor draws: arrow, pointing hand (links, buttons), text beam (fields). */
export const CURSOR_ICONS = ['arrow', 'hand', 'ibeam'] as const;
export type CursorIcon = (typeof CURSOR_ICONS)[number];

/**
 * What the in-page cursor showed besides its position (L2.13), reported by the kit as it drew it: `icon` (the icon
 * changed), `press` / `release` (the press scale), `ripple` (a click ripple centred at x, y, CSS px).
 */
export interface CursorEffect {
  t: number;
  type: 'icon' | 'press' | 'release' | 'ripple';
  icon?: CursorIcon;
  x?: number;
  y?: number;
}

// ── Artefacts (L2.9): captured emails, documents and web notifications ────────

/** Folder of a run holding the captured artefacts (emails/, documents/, notifications/). */
export const ARTEFACTS_DIR = 'artefacts';

export type ArtefactKind = 'email' | 'document' | 'notification' | 'text';

/** An image of an artefact (rendered email, PDF page, notification icon); `file` is relative to the run directory. */
export interface ArtefactImage {
  file: string;
  /** Pixels. */
  width: number;
  height: number;
}

interface ArtefactBase {
  kind: ArtefactKind;
  /** The step's `as` (emails, documents), or the notification name (its `tag`, else "notification-<n>"). */
  name: string;
  /** Capture time it was captured at. */
  t: number;
  /** Scene / step that captured it (a notification: the scene and step running when it showed). */
  scene?: string;
  step?: number;
}

export interface EmailArtefact extends ArtefactBase {
  kind: 'email';
  /** artefacts/emails/<name>.json: {from, to, subject, date, text, html} as captured. */
  file: string;
  from: string;
  /** Display name of the sender, when the message has one. */
  from_name?: string;
  to: string[];
  subject: string;
  /** ISO 8601. */
  date: string;
  /** The first characters of the text part (whitespace collapsed), for components. */
  preview: string;
  /** The HTML rendered at 600 px width, full height (absent when the message has no HTML part or rendering failed). */
  image?: ArtefactImage;
  /** The persona whose mailbox it was waited for in (`to: persona:<name>`, L5.6): mail cards label the mailbox after it. */
  persona?: string;
}

export interface DocumentPage extends ArtefactImage {
  /** Page size in PDF points (1/72 in). */
  width_pt: number;
  height_pt: number;
}

export interface DocumentArtefact extends ArtefactBase {
  kind: 'document';
  /** artefacts/documents/<name>.<ext>. */
  file: string;
  mime: string;
  /** File name the server suggested (download) or the URL's last segment. */
  file_name: string;
  /** How it was captured: the browser's download event, a document opened in a new tab, or a project file. */
  via: 'download' | 'tab' | 'project';
  url?: string;
  bytes: number;
  /** PDFs: every page rasterised at 2× (A4 → ≈ 1587 × 2245 px) into documents/<name>/page-<n>.png; images: the image. */
  pages: DocumentPage[];
}

export interface NotificationArtefact extends ArtefactBase {
  kind: 'notification';
  /** artefacts/notifications/<name>.json. */
  file: string;
  /** 1-based order of capture in the run. */
  index: number;
  title: string;
  body: string;
  tag?: string;
  /** The icon, fetched with the session (absent when the notification has none or it could not be fetched). */
  icon?: ArtefactImage;
  /** Icon URL as the page gave it (resolved against the page URL). */
  icon_url?: string;
  /** Origin of the page that showed it (the "app" a system notification names). */
  origin: string;
  /** Environment page key that showed it. */
  page?: string;
  via: 'Notification' | 'ServiceWorkerRegistration.showNotification';
  /** ISO 8601 wall time. */
  time: string;
}

/** A text read from the page by `capture_text` (L2.10): a figure for a card (`capture: <name>`). */
export interface TextArtefact extends ArtefactBase {
  kind: 'text';
  /** artefacts/texts/<name>.json: {value, text, target, pattern?}. */
  file: string;
  /** What the card shows: the pattern's first group (else its match), else the whole text. */
  value: string;
  /** The element's visible text, whitespace collapsed. */
  text: string;
  /** Description of the element read, and its box at that moment (CSS px). */
  target: string;
  bbox?: BBox;
  pattern?: string;
}

export type TimelineArtefact = EmailArtefact | DocumentArtefact | NotificationArtefact | TextArtefact;

export interface Timeline {
  version: 1;
  run_id: string;
  project: string;
  scenario: string;
  created_at: string;
  mode: 'capture' | 'dry';
  capture: {
    file: string;
    width: number;
    height: number;
    scale: number;
    fps: number;
    /** Seconds. */
    duration: number;
    /**
     * Wall-clock epoch ms of capture time 0. A take paused from the Studio (L4.4, `pauses`) does not film its pauses:
     * a later wall time converts with them applied — (wall − t0_wall) / 1000, less the `ms` / 1000 of every pause
     * before it (one that falls inside a pause is that pause's `t`).
     */
    t0_wall: number;
    frames: number;
    /**
     * `hidden`: captured without the in-page cursor (`retake run --raw --cursor none|layer`, L2.13) — real input,
     * cursor track and effects recorded as usual, nothing drawn. Absent: the cursor is in the pictures.
     */
    cursor?: 'hidden';
  };
  /** Title, intro, outro, frame, template and music of the scenario (written by runners since L2.1). */
  video?: TimelineVideo;
  scenes: TimelineScene[];
  events: TimelineEvent[];
  markers: TimelineMarker[];
  /** URL segments of `capture` (the recorded page of single-page scenes; per-page tracks keep their own). */
  pages: TimelinePageSegment[];
  /** The cursor of `capture` (per-page tracks keep their own: `tracks[].cursor`). */
  cursor: CursorSample[];
  /**
   * What the in-page cursor of `capture` showed besides its position (L2.13; absent in older runs): icon changes,
   * presses and click ripples, as the kit drew them (per-page tracks keep their own).
   */
  cursor_effects?: CursorEffect[];
  /**
   * Intervals where the screen did not change at all (no screencast frame) for ≥ 0.5 s — of any recorded page: with
   * tracks, a frame of any of them counts.
   */
  idle: Array<{ t_start: number; t_end: number }>;
  /** Page loads `capture` did not show (R-ISS-08, L1.2; absent when none — and in older runs). */
  loading?: TimelineLoading[];
  /**
   * Where `capture` froze while the cursor moved or a click ripple played (L5.7; absent when it never did): the frame
   * before the gap held from `t_start` to `t_end`. The edit cuts the frozen part (R-ISS-12, R-FLD-20).
   */
  stalls?: TimelineStall[];
  /**
   * Waits the screen showed after a click (L5.7, R-FLD-26; absent when none): near-identical frames — a skeleton, a
   * spinner, a blank panel — before the content the click asked for appeared. The edit shortens them.
   */
  busy?: TimelineBusy[];
  /** Where the take was paused between steps (L4.4; absent when it never was): capture time did not run meanwhile. */
  pauses?: TimelinePause[];
  /**
   * Emails, documents and web notifications (L2.9) and texts (`capture_text`, L2.10) captured by the run; files are
   * relative to the run directory.
   */
  artefacts?: TimelineArtefact[];
  /**
   * Multi-page scenes (L2.11): one track per page they film, recorded at the same time as each other on the capture
   * clock. Absent when every scene films one page (`capture` holds everything).
   */
  tracks?: TimelineTrack[];
  /** The environment the run filmed (L1.7; absent in older runs): access, display URLs, clock, writes stopped. */
  environment?: TimelineEnvironment;
  warnings: string[];
}

/**
 * The environment of a run (L1.7). URLs elsewhere in the timeline stay the real ones; `display` maps them to what the
 * video shows.
 */
export interface TimelineEnvironment {
  name: string;
  production?: true;
  /** The run's effective access. */
  access: EnvironmentAccess;
  /** The run was allowed to write to production (`--allow-writes` where project.yaml sets `access: read-write`). */
  allow_writes?: true;
  /** The display base of each page that declares one: `url` is its real base URL. */
  display?: Array<{ page: string; url: string; display: string }>;
  /** The product's clock (`clock:` of the scenario or the project). */
  clock?: ResolvedClock;
  /** Writes the read-only guard stopped, answered or let through, and writes that went to hosts it does not guard. */
  writes?: TimelineWrite[];
  /** A sandbox environment (L1.8): its provider and the reset made before the take. */
  sandbox?: RunSandbox;
}

/** A write request seen on a read-only run (L1.7). */
export interface TimelineWrite {
  /** Capture time; absent before capture time 0 (session preflight, setup hooks). */
  t?: number;
  method: string;
  /** The real URL (query included). */
  url: string;
  /** GraphQL operation name, when the request is GraphQL. */
  operation?: string;
  /**
   * blocked: stopped (the app saw a network error); mocked: answered by a mock; allowed: an allow entry let it through;
   * passed: not a guarded host; exempt: the automated sign-in's own write, sent from its sign-in page (never counted).
   */
  outcome: 'blocked' | 'mocked' | 'allowed' | 'passed' | 'exempt';
  /** The allow / mock entry that matched. */
  rule?: string;
  /** Status of the mock's answer. */
  status?: number;
  /** Who sent it: a capture page, a js hook tab, the automated sign-in tab. */
  via?: 'page' | 'hook' | 'sign-in';
  /** The other, read-only environment whose host it went to (guarded in every run, L1.7). */
  protected_by?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runs
// ─────────────────────────────────────────────────────────────────────────────

export type RunMode = 'capture' | 'dry';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RunError {
  message: string;
  scene?: string;
  step?: number;
  action?: string;
  screenshot?: string;
  dom?: string;
  /**
   * A target was not found (L5.6): the targets of the scene's later steps that do not resolve on the page either,
   * looked up without acting, with the visible elements closest to each — every renamed label of a scene in one take.
   */
  missing_targets?: MissingTarget[];
}

/** A visible element close to a target that was not found (role, accessible name, text). */
export interface NearElement {
  role?: string;
  name?: string;
  text?: string;
}

/** A step target that does not resolve on the page a run failed on (RunError.missing_targets). */
export interface MissingTarget {
  scene: string;
  step: number;
  action: string;
  /** Description of the target (`label="Quantity"`). */
  target: string;
  near: NearElement[];
}

/** An `optional` step that failed (run.json `optional_failures`, L5.6): the run went on. */
export interface OptionalFailure {
  scene: string;
  step: number;
  action: string;
  error: string;
  screenshot?: string;
}

/** What ran a capture (run.json `engine`, R-PRIN-13): explains a difference between two machines' takes. */
export interface RunEngine {
  /** Retake version. */
  retake: string;
  /** Node.js version. */
  node: string;
  /** The browser's version (absent when it did not open). */
  chromium?: string;
  /** Platform, release and architecture, e.g. "darwin 25.6.0 arm64". */
  os: string;
  /** The fonts installed on the machine: the number of font files and a digest (sha256, 12 hex) of their names. */
  fonts?: { files: number; digest: string };
}

/** runs/<id>/run.json — written at start, updated during the run and at the end. */
export interface RunRecord {
  /** Format version (1; absent in runs made before L1.4: read as 1). */
  version?: 1;
  id: string;
  project: string;
  scenario: string;
  mode: RunMode;
  status: RunStatus;
  started_at: string;
  finished_at?: string;
  /** Absolute run directory. */
  dir: string;
  env: string;
  /** `allow_writes`: `--allow-writes` was given and accepted (production with `access: read-write`). */
  options: { until?: string; hooks: 'run' | 'skip'; headed: boolean; cursor?: 'hidden'; allow_writes?: true };
  /**
   * The environment's safety (L1.7): production, the run's effective access, the product's clock (as written, the zone
   * a time without an offset is read in, frozen or not).
   */
  environment?: { production?: true; access: EnvironmentAccess; clock?: { at: string; timezone?: string; freeze?: true }; sandbox?: RunSandbox };
  steps_total: number;
  steps_done: number;
  current?: { scene: string; step: number; action: string };
  capture?: string;
  timeline?: string;
  /** One screenshot per step: a dry run's, or a capture's with `capture.step_shots` (L5.6). */
  screenshots: string[];
  hooks: {
    setup: 'ok' | 'failed' | 'skipped' | 'none';
    teardown: 'ok' | 'failed' | 'skipped' | 'none';
    /** `hook:` steps (L5.8; absent when the scenario has none): ok, a step's hook failed, or skipped with the hooks. */
    steps?: 'ok' | 'failed' | 'skipped';
  };
  warnings: string[];
  error?: RunError;
  /** The `optional` steps that failed, in order (L5.6; absent when none did). */
  optional_failures?: OptionalFailure[];
  /** Dry-run: reason the run stopped early (irreversible step, --until). */
  stopped_at?: { scene: string; step: number; reason: 'irreversible' | 'until' };
  /** What ran it (absent in runs made before L1.4). */
  engine?: RunEngine;
  /** What the take cost and how smoothly it was filmed (L5.7; captures only). */
  perf?: RunPerf;
  /** L4.4: the run is paused now (a run of a job, from the Studio), before this step; `since` ISO time. */
  paused?: { scene: string; step: number; since: string };
  /** L4.4: the pauses it had, in order (before which step, when, how long); absent when none. */
  pauses?: RunPause[];
}

/** run.json `perf` (L5.7, R-FLD-23): what a take cost and how smoothly it was filmed. */
export interface RunPerf {
  /** Seconds of the take (capture time 0 to its end; the pauses of a take paused from the Studio left out, L4.4). */
  seconds: number;
  /** CPU seconds per process group over the take, sampled from the system's process table (absent when it failed). */
  cpu?: RunPerfCpu;
  /** The machine during the take: logical CPUs and the 1-minute load average (mean and highest). */
  machine: { cpus: number; load_mean: number; load_max: number };
  /** Chromium's GPU status (its own feature report): hardware accelerated or not, and the features that fell back to software. */
  gpu?: { accelerated: boolean; renderer?: string; software?: string[] };
  /** Chromium's frame-rate limiter was on (browser.frame_rate_limit). */
  frame_rate_limit: boolean;
  /**
   * Screencast frames received, their mean rate over the take, the lowest rate of a cursor move, the frames dropped by
   * the size check, and the fresh frames asked for while a click ripple played (R-FLD-20).
   */
  frames: { received: number; fps: number; motion_fps_min?: number; dropped: number; kicked: number };
  /** Freezes of the capture while the cursor moved or a click ripple played (≥ 150 ms). */
  stalls: Array<{ t: number; ms: number; during: 'move' | 'ripple' }>;
  /** Click → stable content: the clicks measured and the slow ones (over 800 ms), slowest first. */
  transitions?: { measured: number; slow: PerfTransition[] };
  /**
   * L4.4: the Studio's live picture was watched during the take — the seconds its screencast ran and the frames it sent
   * (Chromium's browser process encoded them on top of the capture). Absent when nobody watched.
   */
  live_preview?: { seconds: number; frames_sent: number };
  /** The encoder fed during the take: codec, quality, the wait for its end after the take, frames that came too late for their tick. */
  encode?: { codec: string; quality: string; finish_ms: number; late_frames: number };
  /** The run folder (MB), whether its frames were kept, and the free space left on its disk (GB). */
  disk?: { run_mb: number; frames_kept: boolean; free_gb?: number };
}

/** CPU seconds per process group of a take (`RunPerf.cpu`). */
export interface RunPerfCpu {
  /** Chromium: its browser processes (the screencast's JPEG encoding happens there), GPU processes, page renderers, other helpers. */
  browser: number;
  gpu: number;
  renderer: number;
  chromium_other: number;
  /** Retake's own process (the runner). Run records written before L5.13a call it `studio` (perfSummary reads both). */
  retake: number;
  /** ffmpeg encoding capture.mp4. */
  encoder: number;
  /** The product's local servers (a sandbox's process services), when known. */
  product?: number;
  total: number;
  /** total / seconds: the cores the take kept busy on average. */
  cores: number;
  /**
   * Per browser (one per persona): CPU seconds of its processes, and of the time no recorder filmed it (R-FLD-25: what
   * a page nobody watches costs — its polling, its animations).
   */
  browsers?: Array<{ persona?: string; cpu: number; unfilmed?: { cpu: number; seconds: number } }>;
}

/** A click whose result took long to settle on screen (`RunPerf.transitions`). */
export interface PerfTransition {
  /** Capture time of the press. */
  t: number;
  /** Press → the last change of the screen before it stood still. */
  ms: number;
  scene: string;
  step: number;
  target?: string;
}

/** One pause of a run (L4.4): before step `step` of `scene`, from `at` (ISO), `ms` long. */
export interface RunPause {
  scene: string;
  step: number;
  at: string;
  ms: number;
}

/** One step a run executes, as its `outline` event lists it (L4.4): the step's own description, redacted. */
export interface RunOutlineStep {
  scene: string;
  /** 0-based step index in the scene. */
  step: number;
  action: string;
  desc: string;
  /** A step of an `offscreen: true` scene (L5.8): played, live and pausable like any other, left out of the video. */
  offscreen?: true;
}

/**
 * A persona's result in a run's preflight (L4.4): signed in, saved but not checked, no session (the single-account
 * form starts signed out), signed in automatically off camera, or failing (the run stops before anything is filmed).
 */
export type RunSessionStatus = 'valid' | 'unchecked' | 'none' | 'signed_in_auto' | 'failed';

/** Progress events streamed by runners (CLI prints them, MCP stores them). */
export type RunProgress =
  | { type: 'run_start'; run: RunRecord }
  /** L4.4: right after run_start, every step this run executes (`until` and skipped scenes honoured). */
  | { type: 'outline'; steps: RunOutlineStep[] }
  /** L4.4: one per persona, from the preflight (before any setup hook); `detail` may hold page text. */
  | { type: 'session'; persona: string; status: RunSessionStatus; detail?: string }
  /**
   * L4.4: a pause between steps: `paused` before step `step` of `scene` (`max_ms`: the longest it may last before the
   * run stops), `resumed` after `ms` (a capture does not film it). `refused` (with its `reason`) is no longer emitted:
   * runs of part A's lot wrote it for a capture.
   */
  | { type: 'pause'; state: 'paused' | 'resumed' | 'refused'; scene: string; step: number; ms?: number; max_ms?: number; reason?: string }
  | { type: 'hook'; phase: 'setup' | 'teardown' | 'rollback' | 'step'; name: string; status: 'start' | 'ok' | 'failed' | 'skipped'; message?: string }
  | { type: 'scene_start'; scene: string; index: number }
  | { type: 'step_start'; scene: string; step: number; action: string; desc: string }
  | { type: 'step_end'; scene: string; step: number; action: string; status: TimelineEvent['status']; ms: number; message?: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'encode'; status: 'start' | 'done'; message?: string }
  | { type: 'run_end'; run: RunRecord };

// ─────────────────────────────────────────────────────────────────────────────
// Frame comments (L3.6; the thread format, ids and schema: comments.ts — docs/DESIGN-phase2.md §4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a frame comment points in the edit, computed from the render's edit plan when the comment is made (review
 * `frameAnchor`). A frame belongs to the last step that started at or before its capture frame; a step shorter than one
 * capture frame (a satisfied wait) owns none; inside a marker window (`mark:` step, from its start to its `done` frame)
 * the anchor names the marked step.
 */
export interface FrameCommentAnchor {
  /** Edit plan segment id ("intro", a scene id, "interstitial-1", "card-2", a card's `id:`…). */
  segment: string;
  /** Segment kind: intro, outro, clip, card, interstitial. */
  kind: 'intro' | 'outro' | 'clip' | 'card' | 'interstitial';
  /**
   * Component id rendering the commented area: the segment's component (a clip's layout), or the clip's caption
   * component when the region's centre lies on the caption's box (the band over the screen for a caption drawn over
   * it) while a cue shows.
   */
  component?: ComponentId;
  /** With a region: where its centre lies (`card`: a full-screen segment — intro, outro, card, interstitial). */
  area?: 'screen' | 'caption' | 'brandmark' | 'card';
  scene?: string;
  /** 0-based step index in the scene. */
  step?: number;
  step_id?: string;
  /** "<scene>.<step_id|index>": the `--until` / `page_inspect {until}` syntax. */
  step_ref?: string;
  /**
   * The step's fingerprint in the run's scenario snapshot (core `stepFingerprint`: its action and arguments, modifiers
   * left out) and its occurrence among the scene's steps with that fingerprint (0-based): finds the step again once
   * steps were inserted or moved.
   */
  step_fp?: string;
  step_fp_n?: number;
  /** The step's action (`scene_still` / `scene_open`: the opening of the scene, no step). */
  action?: string;
  /** Multi-page clips: the acting page at the frame. */
  page?: string;
  /** Capture time (seconds) under the commented frame, for clips. */
  src_time_s?: number;
  /** The marker whose window holds the frame (its marked step is then the anchor's step). */
  marker?: string;
  /** Component ids of the overlays on screen at the frame (no hit-testing). */
  overlays?: ComponentId[];
  /** The transition covering the frame (segment ids on each side; the frame counts with the incoming segment). */
  transition?: { kind: 'crossfade' | 'fade-black'; from?: string; to?: string };
}

/** Folder of a project holding the frame comments: `comments/<scenario>/c_<ULID>.json`, one file per thread. */
export const COMMENTS_DIR = 'comments';

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationIssue {
  severity: 'error' | 'warning';
  /** Path into the document, e.g. ["scenes", 1, "steps", 3, "click"]. */
  path: Array<string | number>;
  message: string;
  /** 1-based line/column in the YAML source when known. */
  line?: number;
  col?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loaded entities (returned by core loaders)
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkspaceConfig {
  root: string;
  projectsDir: string;
  templatesDir: string;
  /** Workspace components (`<namespace>/<name>/component.yaml`), scanned before the built-in library. */
  componentsDir: string;
  browser?: BrowserConfig;
  /** ffmpeg binary (ffprobe is looked for beside it); default: $RETAKE_FFMPEG, the app's own, else "ffmpeg" on PATH. */
  ffmpeg?: string;
}

export interface LoadedProject {
  slug: string;
  /** Absolute project directory. */
  dir: string;
  /** Workspace root the project belongs to (for template resolution). */
  root: string;
  /** project.yaml with defaults applied (capture, frame, template). */
  config: ProjectConfig;
  readme: string | null;
  /** Scenario names (scenarios/<name>.yaml). */
  scenarios: string[];
  /** Absolute path of project.yaml. */
  file: string;
  /** Non-blocking issues (warnings) of project.yaml, set by loadProject. */
  issues?: ValidationIssue[];
  /** The sandboxes of project.yaml `sandboxes:` (L1.8), by environment name; absent when it declares none. */
  sandboxes?: Record<string, LoadedSandbox>;
}

export interface LoadedScenario {
  name: string;
  /** Absolute path of the YAML file. */
  file: string;
  text: string;
  scenario: Scenario;
  /** Non-blocking issues (warnings). */
  issues: ValidationIssue[];
}

export interface ResolvedEnvironment {
  name: string;
  /** page key → real base URL (what the runner and the hooks use). */
  pages: Record<string, string>;
  /** page key → display base (L1.7), for the pages that declare one. */
  display?: Record<string, string>;
  /** Absent: false. */
  production?: boolean;
  /** As written in project.yaml; absent: read-only in production, else read-write (core environmentAccess). */
  access?: EnvironmentAccess;
  read_only?: ReadOnlySettings;
  /** A sandbox environment (L1.8): never production, always read-write. */
  sandbox?: EnvironmentSandbox;
}
