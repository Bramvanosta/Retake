/**
 * The language context's types (@retake/core/language): the scenario language's shapes: targets, steps and their
 * actions, captions and camera hints, tutorial switches, user media overlays, frames, viewports, multi-page scenes,
 * cards, interstitials, intro and outro, and the video's edit info.
 *
 * Units: time in SECONDS (float) unless the field name ends in `_ms`. Pixels: CSS pixels of the captured viewport unless
 * stated otherwise (multiply by `capture.scale` to get video pixels).
 */
import type { BBox, ComponentId, MediaFileFields, PointSpec } from './model.js';

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
  /** Hotfix v0.2.6 (field point 25): the value set at once, as a browser autofill (input and change events). */
  fill?: boolean;
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
  /** How fast the search is typed, characters per second (default: the search pace, at most 10). */
  search_cps?: number;
  /** The search is filled at once, as a paste (one input event): only the final list is filmed. */
  search_instant?: boolean;
}

export interface PickArgs {
  /** Field label (string) or explicit trigger target. */
  field: string | TargetObject;
  option: string | string[];
  search?: string;
  /** How fast the search is typed, characters per second (default: the search pace, at most 10). */
  search_cps?: number;
  /** The search is filled at once, as a paste (one input event): only the final list is filmed. */
  search_instant?: boolean;
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
 * `hook: <name>` (R-FLD-31): run a named hook of the scenario's `hooks:` (else project.yaml's) during the take —
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
   * environment, matched as the whole address.
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
 * `capture_text`: read the visible text of an element (whitespace collapsed) and keep it as the run artefact
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
   * `click` / `double_click`: a click that produced nothing within about a second (no request, DOM change,
   * navigation, dialog, new tab or download) is made once more; when the second one does nothing either, the step fails.
   * Without it such a click is only reported (a warning with a screenshot).
   */
  retry_click?: boolean;
  /** Not executed in dry-run (the runner hovers the target, screenshots, and stops the scene). */
  irreversible?: boolean;
  /** Edit-time overlay (callout, lower third, badge…) shown over this step; the runner records its target bbox. */
  overlay?: OverlaySpec;
  /**
   * Tutorial overlays of this step: overrides the scene's and the scenario's switches, e.g.
   * `tutorial: {spotlight: false}`; `false` = none on this step. `progress` is a video-wide switch (scenario only).
   */
  tutorial?: TutorialSwitch;
  /**
   * Multi-page scenes: the page this step acts on — a key of the scene's `pages` (default: the scene's first
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
 * Automatic tutorial overlays fed by the timeline. Each switch can be set on the scenario, a scene or a step;
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

/** Where a box-filling overlay (a user video, image or Lottie) goes over the capture. */
export const OVERLAY_ANCHORS = ['target', 'cursor', 'screen', 'center', 'top-left', 'top', 'top-right', 'left', 'right', 'bottom-left', 'bottom', 'bottom-right'] as const;

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
 * Instead of a component, a user file — `video` (an alpha video: ProRes 4444 .mov or VP9 .webm with alpha),
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
 * Layouts of a multi-page scene: `split` ⇒ studio/layout-split (the pages side by side, stacked in vertical),
 * `pip` ⇒ studio/layout-pip (one page over the other, picture in picture).
 */
export type MultiPageFrame = 'split' | 'pip';

/**
 * How a capture is framed: a FrameStyle (`card` ⇒ studio/layout-card, `browser` ⇒ studio/layout-browser…), a
 * multi-page frame (`split`, `pip`) or the id of a layout component ("namespace/name").
 */
export type FrameSpec = FrameStyle | MultiPageFrame | ComponentId;

/** The built-in layout component of each multi-page frame. */
export const MULTI_PAGE_LAYOUTS: Readonly<Record<MultiPageFrame, ComponentId>> = {
  split: 'studio/layout-split',
  pip: 'studio/layout-pip',
};

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
  /** The persona this page is signed in as (`none`: no persona). Default: the persona whose `pages` list its environment page. */
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
   * Multi-page scene: the pages filmed at the same time on one clock (instead of `page` / `open`), e.g. a buyer
   * and a supplier, or one site on desktop and mobile. Steps act on the first page unless they say `on: <page>`.
   */
  pages?: ScenePages;
  /**
   * The persona this scene's page is signed in as (`none`: no persona). Default: the persona whose `pages` list the
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
   * Played during the take but left out of the video (R-FLD-31): a scene that prepares what the next ones film
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

/** Scenario `intro` (or `false`): overrides of the theme's intro card — or the user's own file. */
export interface IntroSpec extends MediaFileFields {
  /** Intro component id (default: the theme's). */
  component?: ComponentId;
  params?: Record<string, unknown>;
  /** Seconds (> 0; default template.intro.duration). */
  duration?: number;
}

/** Scenario `outro` (or `false`): overrides of the theme's outro card — or the user's own file. */
export interface OutroSpec extends MediaFileFields {
  /** Outro component id (default: the theme's). */
  component?: ComponentId;
  params?: Record<string, unknown>;
  tagline?: string;
  url?: string;
  /** Seconds (> 0; default template.outro.duration). */
  duration?: number;
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

/** Edit info of the scenario carried into the timeline, so the editor does not re-read scenario.yaml. */
export interface TimelineVideo {
  title?: { kicker?: string; text: string };
  /** Scenario `intro` as written (`false` = no intro card; absent = theme intro). */
  intro?: false | IntroSpec;
  /** Scenario `outro` as written (`false` = no outro card; absent = theme outro). */
  outro?: false | OutroSpec;
  /** Effective default frame of the video: scenario `frame`, else the project `frame` (default 'card'). */
  frame?: FrameSpec;
  /**
   * A device's take whose scenario and project write no `frame` (the frame is the default): the edit frames it as a
   * phone. Absent when a frame was written, even `card`.
   */
  frame_default?: true;
  /** Template the run used (name or path). */
  template?: string;
  music?: MusicSpec;
  /** Scenario-level tutorial switches as written. */
  tutorial?: TutorialSwitch;
  /** The scenario's `target_length`. */
  target_length?: TargetLength;
  /** The scenario's `caption_component`. */
  caption_component?: ComponentId;
}

/** The length a video aims at, seconds (scenario `target_length`). */
export interface TargetLength {
  min_s: number;
  max_s: number;
}
