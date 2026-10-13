/**
 * Contract between the node-side runner and the in-page kit (`window.__demoStudio`).
 * Everything crossing the boundary is JSON-serialisable; elements are referred to by `ref` ids
 * that the kit keeps in a WeakRef map. A ref may designate an element inside an open shadow root or a same-origin
 * frame (R-ISS-07); every box and point crossing the boundary, both ways, is in top-level viewport CSS px (an element
 * in a frame is offset by the frames' positions).
 */
import type { BBox, PointSpec, TargetObject } from '@demo-studio/core';

export type CursorStyle = 'arrow-dark' | 'arrow-light' | 'debug';
export type CursorKind = 'arrow' | 'hand' | 'ibeam';

export interface KitConfig {
  cursor: {
    style: CursorStyle;
    /** Rendered size of the 24-unit cursor box in CSS px (the arrow itself is ~0.82 of it). */
    size: number;
    ripple_color: string;
    /**
     * Raw capture without the cursor (L2.13, `studio run --raw --cursor none|layer`): the cursor and its ripples are
     * not drawn; real input, icon, presses and ripples are still reported (binding `__demoStudioCursor`).
     */
    hidden?: boolean;
  };
  /** sessionStorage key holding the last cursor position (restored after a full navigation). */
  storage_key: string;
}

export interface FindOptions {
  /** Promote matches to their nearest interactive ancestor (default true). */
  promote?: boolean;
  /** Also match elements that are not visible (e.g. a hidden <input type=file>). */
  include_hidden?: boolean;
}

export interface ResolveFound {
  count: number;
  /** Index of the chosen match among the visible matches. */
  index: number;
  desc: string;
  ref: string;
  bbox: BBox;
  tag: string;
  role: string | null;
  /** Normalised visible text (trimmed to 120 chars). */
  text: string;
  href: string | null;
  /** aria-haspopup, aria-expanded="false", role=combobox. */
  popup_expected: boolean;
  /** Fully inside the viewport and every scroll container. */
  in_view: boolean;
}

export interface ResolveMissing {
  count: 0;
  /** Why nothing was chosen: nth out of range, or the cross-origin frames that could not be searched. */
  desc: string;
  /** Matches that exist but are not visible (hidden, zero-size, transparent, clipped). */
  hidden: number;
  /** False when the `in` scope itself was not found. */
  scope_found: boolean;
  /** Visible texts close to the query (for error messages). */
  near: string[];
}

export type ResolveResult = ResolveFound | ResolveMissing;

export interface ElementInfo {
  desc: string;
  tag: string;
  role: string | null;
  text: string;
  href: string | null;
  popup_expected: boolean;
  /** An <input>'s type (null for other elements). */
  input_type: string | null;
}

export interface RestPlan extends PointSpec {
  /** Which candidate was used: a side of the box, or 'fallback' (restPoint). */
  side: string;
}

/** Where the target of a rest point will be clicked, and its element (to stay inside the dialog holding it). */
export interface RestAt {
  point?: PointSpec;
  ref?: string;
  /** Boxes the drawn cursor must stay clear of too (parking: what changed, R-CHO-21). */
  avoid?: BBox[];
}

export interface MenuTrigger {
  ref: string | null;
  hover: boolean;
}

export interface PositionalTrigger {
  ref: string;
  /** Where it was found: 'right end' or 'top-right corner'. */
  where: string;
}

export type FieldKind = 'search' | 'multiline' | 'text';

/** A day cell of the calendar on screen (R-CHO-24). */
export interface CalendarDay {
  ref: string;
  /** Its aria-label, else its text. */
  label: string;
  /** The ISO date of its data-date / data-day / datetime / data-value attribute. */
  iso: string | null;
  disabled: boolean;
  /** Marked as a day of an adjacent month. */
  outside: boolean;
}

/** The calendar on screen: its popup (when it is a floating popup), its last visible month buttons and its days. */
export interface CalendarInfo {
  popup: number | null;
  next: string | null;
  prev: string | null;
  days: CalendarDay[];
}

export interface FieldState {
  editable: boolean;
  empty: boolean;
  kind: FieldKind;
  /**
   * The kit reads it: a shown input or textarea, or edited text (contenteditable, a frame's designMode body). False for
   * an editor's hidden input (CodeMirror 5, Monaco, Ace: what the viewer sees is drawn elsewhere) and other elements.
   */
  known: boolean;
}

export interface PointInfo extends PointSpec {
  bbox: BBox;
  /** elementFromPoint at (x, y) is the element or inside it. */
  hit: boolean;
}

export interface ScrollOp {
  /** Scroll container ref, or "" for the top document's scroller (a frame document's scroller is a ref). */
  container: string;
  top: number;
  left: number;
  from_top: number;
  from_left: number;
}

export interface ScrollInfo {
  container: string;
  top: number;
  left: number;
  max_top: number;
  max_left: number;
  client_height: number;
  /** Top of `of` in the container's scroll coordinates (when asked), also for an element in a frame. */
  target_top?: number;
}

export interface PopupEntry {
  id: number;
  kind: string;
  bbox: BBox;
}

export interface OutsidePlan {
  kind: 'dialog-title' | 'blank';
  ref?: string;
  x: number;
  y: number;
  /** Popup ids containing the clicked point (they stay open, e.g. the dialog whose title is clicked). */
  keep: number[];
}

export interface FileSpec {
  name: string;
  mime: string;
  /** Base64 content (real file); omitted for a fake file of `size` bytes. */
  base64?: string;
  size: number;
}

export interface DropOutcome {
  /** A drop handler called preventDefault on dragover/drop (the page accepted the file). */
  accepted: boolean;
  /** Element that received the drop. */
  target: string;
}

/** What the kit reports to the runner about its cursor (binding `__demoStudioCursor`, L2.13). */
export interface CursorEffectPayload {
  type: 'icon' | 'press' | 'release' | 'ripple';
  /** Wall-clock epoch ms. */
  time: number;
  icon?: CursorKind;
  x?: number;
  y?: number;
}

export interface CursorState {
  x: number;
  y: number;
  visible: boolean;
  known: boolean;
  kind: CursorKind;
  pressed: boolean;
}

export interface KitCursorApi {
  set(x: number, y: number, show?: boolean): void;
  show(): void;
  hide(): void;
  ripple(x: number, y: number): void;
  press(down: boolean): void;
  state(): CursorState;
  /** Draw the cursor even though the document has not painted content of its own (R-ISS-08: the runner waited for its load). */
  reveal(): void;
}

export interface KitGhostApi {
  show(name: string, detail: string): void;
  hide(): void;
}

export interface KitFileDragApi {
  begin(spec: FileSpec): void;
  over(x: number, y: number): void;
  drop(x: number, y: number): DropOutcome;
  cancel(): void;
}

export interface KitApi {
  version: string;
  /** False after document.open() erased the listeners or the overlay was lost: the runner re-installs. */
  healthy(): boolean;
  dispose(): void;
  config: KitConfig;
  cursor: KitCursorApi;
  /** The cursor overlay's stylesheet and markup (shadow root content), as drawn — the raw export's layer uses them. */
  cursorLook: { css: string; html: string };
  ghost: KitGhostApi;
  fileDrag: KitFileDragApi;
  find(target: TargetObject, opts?: FindOptions): ResolveResult;
  el(ref: string): Element | null;
  alive(ref: string): boolean;
  visible(ref: string): boolean;
  point(ref: string, offset?: PointSpec | null): PointInfo | null;
  scrollPlan(ref: string, margin: number): ScrollOp | null;
  scrollContainerFor(ref: string | null, fromParent?: boolean): string;
  scrollInfo(container: string, of?: string | null): ScrollInfo;
  scrollAnimate(container: string, top: number, left: number, ms: number): Promise<{ top: number; left: number }>;
  /**
   * Resolves after two real animation frames (at most 150 ms when the page does not render): the DOM state is on
   * screen. The kit's own frames and timers (captured when it started): real whatever the page did to its globals.
   */
  afterPaint(): Promise<void>;
  popupState(): PopupEntry[];
  expanded(ref: string): string | null;
  outsidePlan(near: PointSpec, avoid: number[]): OutsidePlan | null;
  /** Neutral point to click to close the open popovers (dialog title, else blank area near the top). */
  blankPoint(near: PointSpec): PointSpec | null;
  /** Alias of `ghost` (DESIGN §3.2 name). */
  dragGhost: KitGhostApi;
  /**
   * Neutral scene-start point (not on an interactive element): at the right-centre of the viewport, or near its centre
   * (`centre`: a page idle in a multi-page scene — a picture-in-picture inset sits in a corner, never there).
   */
  restPoint(where?: 'side' | 'centre', avoid?: BBox[]): PointSpec;
  /**
   * Neutral scene-start point near `box` (the scene's first pointer target) whose drawn cursor never covers it,
   * inside the viewport, preferably over a non-interactive spot; `restPoint()` when no candidate fits. With `at`: next
   * to the click point of a wide target (not its far corner) and inside the dialog that holds `at.ref`.
   */
  restNear(box: BBox, at?: RestAt): RestPlan;
  /** Start (or restart) recording what changes on the page (parking, R-CHO-21). */
  watchChanges(): void;
  /** Boxes of what changed since watchChanges (merged, at most 12, clipped to the viewport); watching false on a new document. */
  changedBoxes(): { watching: boolean; boxes: BBox[] };
  /** Box of an element's text (narrower than a block's box), or null. */
  textBox(ref: string): BBox | null;
  hasText(text: string): boolean;
  snapshot(ref: string | null, max: number): string;
  domClick(ref: string, x: number, y: number): void;
  pointerSequence(ref: string, x: number, y: number): void;
  rowFor(text: string): string | null;
  /**
   * A row's menu trigger (R-CHO-13). `hover`: the row's last button is laid out but hidden (shown on hover) — hover
   * the row, then ask again with `hovered`.
   */
  menuTrigger(rowRef: string, hovered?: boolean): MenuTrigger;
  /** Positional last resort: the clickable element at the row's right end, else its top-right corner (R-CHO-13). */
  positionalTrigger(rowRef: string): PositionalTrigger | null;
  fieldTrigger(label: string): string | null;
  confirmButton(text: string | null): string | null;
  fileInputFor(ref: string): string | null;
  selectNative(ref: string, option: string): { ok: boolean; label?: string; options: string[] };
  isTextInput(ref: string | null): boolean;
  /** The field (`ref`, else the focused element): editable, empty (never its value) and kind (R-CHO-14/15). */
  fieldState(ref: string | null): FieldState | null;
  /** Clear a field with its prototype's value setter + `input` (contenteditable: editing commands); R-CHO-15. */
  clearField(ref: string | null): 'setter' | 'editor' | null;
  /** The calendar on screen (R-CHO-24), or null. */
  calendar(): CalendarInfo | null;
  /** Set a native input's value in place (realm value setter + input + change); true when it took it. */
  setNativeValue(ref: string, value: string): boolean;
  describe(ref: string): string;
  info(ref: string): ElementInfo | null;
  textOf(ref: string): string;
  /** The element's rendered text (innerText; a field's value), whitespace collapsed, at most 2000 characters. */
  visibleText(ref: string): string;
  /**
   * The focused element (description, box and kind: an input's `type`, "textarea", "contenteditable" or the tag name),
   * or null when nothing visible has the focus. Focus inside a frame's body (an editor drawn in a frame): the frame.
   */
  focused(): { desc: string; bbox: BBox; input_type: string } | null;
}
