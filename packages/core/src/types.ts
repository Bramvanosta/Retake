/**
 * Demo Studio — shared contracts.
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
  /** Screen layout / frame: places the capture (card, browser chrome, laptop, phone, raw…). */
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
  /** Seconds before the step fails (default 15). */
  timeout?: number;
  /** A failure is logged but does not abort the run. */
  optional?: boolean;
  /** Not executed in dry-run (the runner hovers the target, screenshots, and stops the scene). */
  irreversible?: boolean;
  /** Edit-time overlay (callout, lower third, badge…) shown over this step; the runner records its target bbox. */
  overlay?: OverlaySpec;
  /** Free-form note (ignored). */
  note?: string;
}

/**
 * Step modifier `overlay`: a component drawn over the clip from the end of the step's action for `duration` seconds.
 * The runner measures the target at the END of the step (after any scroll) and records it on the event.
 */
export interface OverlaySpec {
  /** Overlay component id, e.g. "studio/overlay-callout". */
  component: ComponentId;
  /** Slot values (text, kicker, title…), as the component declares them. */
  slots?: Record<string, string>;
  params?: Record<string, unknown>;
  /** Seconds on screen (0 < d ≤ 30; default: the component's duration). */
  duration?: number;
  /** Element the overlay points at. Default: the step's own target, else the cursor position. */
  target?: TargetSpec;
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
}
export type NormalizedArgs = NormalizedArgsMap;

export type FrameStyle = 'raw' | 'card' | 'browser' | 'laptop' | 'phone';

/**
 * How a capture is framed: a FrameStyle (`card` ⇒ studio/layout-card, `browser` ⇒ studio/layout-browser…) or the id of
 * a layout component ("namespace/name").
 */
export type FrameSpec = FrameStyle | ComponentId;

/** The built-in layout component each FrameStyle stands for. */
export const FRAME_STYLE_LAYOUTS: Readonly<Record<FrameStyle, ComponentId>> = {
  card: 'studio/layout-card',
  browser: 'studio/layout-browser',
  laptop: 'studio/layout-laptop',
  phone: 'studio/layout-phone',
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

export interface Scene {
  id: string;
  caption?: CaptionSpec;
  /** Environment page key (e.g. admin, app). Default: previous scene's page, else the first key of the environment. */
  page?: string;
  /** Path or URL opened at scene start. Omit to continue from the previous scene's state. */
  open?: string;
  steps: Step[];
  /** Edit-time speed for the whole scene. */
  speed?: number;
  /** Seconds of stillness at scene start (default pacing.scene_start_still). */
  still?: number;
  /** Where the cursor rests at the scene start (default 'auto'). */
  cursor?: SceneCursor;
  /** Transition INTO this scene (default template.transitions.between_scenes). */
  transition?: TransitionKind;
  /** Frame of this scene: a FrameStyle or a layout component id (default: scenario frame, else project frame). */
  frame?: FrameSpec;
  irreversible?: boolean;
  /** Skip this scene entirely. */
  skip?: boolean;
  note?: string;
}

export interface InterstitialSpec {
  text: string;
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

export interface CardSpec {
  /** Card component id (default: the theme's card component, studio/card-title). */
  component?: ComponentId;
  params?: Record<string, unknown>;
  /** Slot values (title, kicker, text…); a card needs `component` or `slots.title`. */
  slots?: Record<string, string>;
  /** Seconds on screen (> 0; default: the component's duration). */
  duration?: number;
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

/** Scenario `intro` (or `false`): overrides of the theme's intro card. */
export interface IntroSpec {
  /** Intro component id (default: the theme's). */
  component?: ComponentId;
  params?: Record<string, unknown>;
  /** Seconds (> 0; default template.intro.duration). */
  duration?: number;
}

/** Scenario `outro` (or `false`): overrides of the theme's outro card. */
export interface OutroSpec {
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

export interface Scenario {
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
  capture?: Partial<CaptureSettings>;
  /** Frame of every scene (default: the project frame). */
  frame?: FrameSpec;
  template?: string;
  pacing?: Partial<Pacing>;
  music?: MusicSpec;
  scenes: SceneEntry[];
}

export interface MusicSpec {
  /** Audio file relative to the project dir. */
  file: string;
  volume?: number;
  /** Volume factor under footage. */
  duck?: number;
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
  /** JPEG quality (1-100). */
  quality: number;
  /** Keep runs/<id>/frames after encoding. */
  keep_frames: boolean;
  /** libx264 CRF of capture.mp4. */
  crf: number;
}

export const DEFAULT_CAPTURE: CaptureSettings = {
  width: 1920,
  height: 1080,
  scale: 1,
  fps: 30,
  format: 'jpeg',
  quality: 100,
  keep_frames: true,
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
  /** Typing speed, characters per second (9–24). */
  type_cps: number;
  /** Smooth scroll duration in seconds (1.5–2). */
  scroll_duration: number;
  /** Default `scroll.offset` with a target: final scrollTop = target top + offset (−140 ⇒ the target ends 140 px below the top). */
  scroll_offset: number;
  /** Deterministic ±fraction jitter applied to durations (0 = none). */
  jitter: number;
  /** After navigation: wait for network idle up to this many ms. */
  settle_ms: number;
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
};

export interface AuthConfig {
  /** Persistent, pre-authenticated Chromium profile directory (~ expanded). */
  profile?: string;
  /** Playwright storageState JSON (alternative to profile). */
  storage_state?: string;
}

export interface DatabaseConfig {
  /** Connection URL; may use {{env:VAR}} / {{keychain:service/account}} references. Never a clear-text password. */
  url: string;
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
}

export interface ProjectConfig {
  name: string;
  /** env name → page key → base URL. */
  environments: Record<string, Record<string, string>>;
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
  browser?: BrowserConfig;
  /** Hooks run by `env_reset`. */
  reset?: HookStep[];
  vars?: Record<string, string>;
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

export type TemplateComponents = Partial<Record<ComponentKind, ComponentRef | null>>;

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
  transition?: TransitionKind;
  /** Scene-level frame as written in the scenario (the scenario/project default is in `Timeline.video.frame`). */
  frame?: FrameSpec;
  interstitial?: InterstitialSpec;
  card?: CardSpec;
  status: 'ok' | 'failed' | 'skipped' | 'partial';
}

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
}

export interface TimelineEvent {
  scene: string;
  scene_index: number;
  /** Step index within the scene. */
  step: number;
  id?: string;
  action: ActionName | 'scene_open' | 'scene_still';
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
  mark?: string;
  caption?: { kicker?: string; text: string };
  speed?: number;
  /** Camera hint; `bbox` (target) / `point` measured at the end of the step, after any scroll. */
  camera?: CameraHint & { bbox?: BBox; point?: PointSpec };
  overlay?: TimelineOverlay;
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
    /** Wall-clock epoch ms of capture time 0. */
    t0_wall: number;
    frames: number;
  };
  /** Title, intro, outro, frame, template and music of the scenario (written by runners since L2.1). */
  video?: TimelineVideo;
  scenes: TimelineScene[];
  events: TimelineEvent[];
  markers: TimelineMarker[];
  pages: TimelinePageSegment[];
  cursor: CursorSample[];
  /** Intervals where the screen did not change at all (no screencast frame) for ≥ 0.5 s. */
  idle: Array<{ t_start: number; t_end: number }>;
  warnings: string[];
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
}

/** runs/<id>/run.json — written at start, updated during the run and at the end. */
export interface RunRecord {
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
  options: { until?: string; hooks: 'run' | 'skip'; headed: boolean };
  steps_total: number;
  steps_done: number;
  current?: { scene: string; step: number; action: string };
  capture?: string;
  timeline?: string;
  /** Dry-run: one screenshot per step. */
  screenshots: string[];
  hooks: { setup: 'ok' | 'failed' | 'skipped' | 'none'; teardown: 'ok' | 'failed' | 'skipped' | 'none' };
  warnings: string[];
  error?: RunError;
  /** Dry-run: reason the run stopped early (irreversible step, --until). */
  stopped_at?: { scene: string; step: number; reason: 'irreversible' | 'until' };
}

/** Progress events streamed by runners (CLI prints them, MCP stores them). */
export type RunProgress =
  | { type: 'run_start'; run: RunRecord }
  | { type: 'hook'; phase: 'setup' | 'teardown' | 'rollback'; name: string; status: 'start' | 'ok' | 'failed' | 'skipped'; message?: string }
  | { type: 'scene_start'; scene: string; index: number }
  | { type: 'step_start'; scene: string; step: number; action: string; desc: string }
  | { type: 'step_end'; scene: string; step: number; action: string; status: TimelineEvent['status']; ms: number; message?: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'encode'; status: 'start' | 'done'; message?: string }
  | { type: 'run_end'; run: RunRecord };

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
  browser?: BrowserConfig;
  /** ffmpeg binary (default: "ffmpeg" on PATH). */
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
  /** page key → base URL */
  pages: Record<string, string>;
}
