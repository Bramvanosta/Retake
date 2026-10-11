/**
 * Contract between the node-side runner and the in-page kit (`window.__demoStudio`).
 * Everything crossing the boundary is JSON-serialisable; elements are referred to by `ref` ids
 * that the kit keeps in a WeakRef map.
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
}

export interface RestPlan extends PointSpec {
  /** Which candidate was used: a side of the box, or 'fallback' (restPoint). */
  side: string;
}

export interface PointInfo extends PointSpec {
  bbox: BBox;
  /** elementFromPoint at (x, y) is the element or inside it. */
  hit: boolean;
}

export interface ScrollOp {
  /** Scroll container ref, or "" for the document scroller. */
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
  /** Top of `of` in the container's scroll coordinates (when asked). */
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
  popupState(): PopupEntry[];
  expanded(ref: string): string | null;
  outsidePlan(near: PointSpec, avoid: number[]): OutsidePlan | null;
  /** Neutral point to click to close the open popovers (dialog title, else blank area near the top). */
  blankPoint(near: PointSpec): PointSpec | null;
  /** Alias of `ghost` (DESIGN §3.2 name). */
  dragGhost: KitGhostApi;
  /** Neutral scene-start point at the right-centre of the viewport (not on an interactive element). */
  restPoint(): PointSpec;
  /**
   * Neutral scene-start point near `box` (the scene's first pointer target) whose drawn cursor never covers it,
   * inside the viewport, preferably over a non-interactive spot; `restPoint()` when no candidate fits.
   */
  restNear(box: BBox): RestPlan;
  hasText(text: string): boolean;
  snapshot(ref: string | null, max: number): string;
  domClick(ref: string, x: number, y: number): void;
  pointerSequence(ref: string, x: number, y: number): void;
  rowFor(text: string): string | null;
  menuTrigger(rowRef: string): string | null;
  fieldTrigger(label: string): string | null;
  confirmButton(text: string | null): string | null;
  fileInputFor(ref: string): string | null;
  selectNative(ref: string, option: string): { ok: boolean; label?: string; options: string[] };
  isTextInput(ref: string | null): boolean;
  describe(ref: string): string;
  info(ref: string): ElementInfo | null;
  textOf(ref: string): string;
}
