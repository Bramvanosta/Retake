/** Typed RPC to the in-page kit of one page (BrowserSession.kit). */
import type { Page } from 'playwright-core';
import { RunnerError, StepError } from './errors.js';
import type {
  CalendarInfo,
  CursorState,
  DropOutcome,
  ElementInfo,
  FieldState,
  FileSpec,
  FindOptions,
  InventoryOptions,
  KitInventory,
  KitTargetChecks,
  MenuTrigger,
  OutsidePlan,
  PointInfo,
  PopupEntry,
  PositionalTrigger,
  ResolveResult,
  RestAt,
  RestPlan,
  ScrollInfo,
  ScrollOp,
} from './kit/types.js';
import type { BBox, PointSpec } from '@retake/core/model';
import type { NearElement } from '@retake/core/run';
import type { TargetObject } from '@retake/core/language';
import { errorMessage } from '@retake/core/base';

function isContextDestroyed(e: unknown): boolean {
  const m = errorMessage(e);
  return /Execution context was destroyed|Cannot find context with specified id|frame was detached|because of a navigation/i.test(m);
}

function cleanEvalError(e: unknown): string {
  const m = errorMessage(e);
  return m
    .replace(/^page\.evaluate: /, '')
    .replace(/^Error: /, '')
    .split('\n    at ')[0];
}

/** The page replaced its document during a kit call that must not be retried (`KitClient.callOnce`). */
export class DocumentChangedError extends StepError {
  constructor() {
    super('the page navigated during the inspection');
  }
}

/** Typed RPC to the in-page kit of one page. Re-installs the kit when a document lost it. */
export class KitClient {
  constructor(
    private readonly page: Page,
    private readonly source: string,
  ) {}

  async install(): Promise<void> {
    await this.page.evaluate(this.source);
  }

  async call<T>(path: string, ...args: unknown[]): Promise<T> {
    return this.callWith<T>(true, path, args);
  }

  /**
   * One call in the document the page shows now (an inspection): a document replaced during the call (a late
   * navigation) is an error, never retried in the new one — whatever that document holds is not what was asked for.
   * A document that has no kit when the call starts (its init script not run) gets it installed and the call runs
   * there: whichever document answers, the inventory and the target checks return its origin, which the inspection
   * checks.
   */
  callOnce<T>(path: string, ...args: unknown[]): Promise<T> {
    return this.callWith<T>(false, path, args);
  }

  private async callWith<T>(retry: boolean, path: string, args: unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.page.evaluate(
          async ([p, a]): Promise<{ missing: boolean; value?: unknown }> => {
            const k = (window as unknown as { __retake?: Record<string, unknown> }).__retake;
            if (!k) return { missing: true };
            const parts = p.split('.');
            let owner = k;
            for (let i = 0; i < parts.length - 1; i++) owner = owner[parts[i]] as Record<string, unknown>;
            const fn = owner[parts[parts.length - 1]] as (...x: unknown[]) => unknown;
            return { missing: false, value: await fn.apply(owner, a) };
          },
          [path, args] as [string, unknown[]],
        );
        if (res.missing) {
          if (attempt >= 3) throw new RunnerError(`the in-page kit could not be installed in ${this.page.url()}`);
          await this.install();
          continue;
        }
        return res.value as T;
      } catch (e) {
        if (e instanceof RunnerError) throw e;
        if (isContextDestroyed(e) && !retry) throw new DocumentChangedError();
        if (isContextDestroyed(e) && attempt < 5) {
          await this.page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
          continue;
        }
        throw new StepError(cleanEvalError(e));
      }
    }
  }

  find(t: TargetObject, opts?: FindOptions): Promise<ResolveResult> {
    return this.call('find', t, opts ?? {});
  }
  point(ref: string, offset?: PointSpec | null): Promise<PointInfo | null> {
    return this.call('point', ref, offset ?? null);
  }
  visible(ref: string): Promise<boolean> {
    return this.call('visible', ref);
  }
  scrollPlan(ref: string, margin: number, centre = false): Promise<ScrollOp | null> {
    return centre ? this.call('scrollPlan', ref, margin, true) : this.call('scrollPlan', ref, margin);
  }
  scrollContainerFor(ref: string | null, fromParent = false): Promise<string> {
    return this.call('scrollContainerFor', ref, fromParent);
  }
  scrollInfo(container: string, of?: string | null): Promise<ScrollInfo> {
    return this.call('scrollInfo', container, of ?? null);
  }
  scrollAnimate(container: string, top: number, left: number, ms: number): Promise<{ top: number; left: number }> {
    return this.call('scrollAnimate', container, top, left, ms);
  }
  popupState(): Promise<PopupEntry[]> {
    return this.call('popupState');
  }
  expanded(ref: string): Promise<string | null> {
    return this.call('expanded', ref);
  }
  outsidePlan(near: PointSpec, avoid: number[]): Promise<OutsidePlan | null> {
    return this.call('outsidePlan', near, avoid);
  }
  restPoint(where?: 'side' | 'centre', avoid?: BBox[]): Promise<PointSpec> {
    if (avoid) return this.call('restPoint', where ?? 'side', avoid);
    return where ? this.call('restPoint', where) : this.call('restPoint');
  }
  watchChanges(): Promise<void> {
    return this.call('watchChanges');
  }
  changedBoxes(): Promise<{ watching: boolean; boxes: BBox[] }> {
    return this.call('changedBoxes');
  }
  textBox(ref: string): Promise<BBox | null> {
    return this.call('textBox', ref);
  }
  restNear(box: BBox, at?: RestAt): Promise<RestPlan> {
    return at ? this.call('restNear', box, at) : this.call('restNear', box);
  }
  hasText(text: string): Promise<boolean> {
    return this.call('hasText', text);
  }
  snapshot(ref: string | null, max: number): Promise<string> {
    return this.call('snapshot', ref, max);
  }
  domClick(ref: string, x: number, y: number): Promise<void> {
    return this.call('domClick', ref, x, y);
  }
  pointerSequence(ref: string, x: number, y: number): Promise<void> {
    return this.call('pointerSequence', ref, x, y);
  }
  rowFor(text: string): Promise<string | null> {
    return this.call('rowFor', text);
  }
  menuTrigger(rowRef: string, hovered = false): Promise<MenuTrigger> {
    return this.call('menuTrigger', rowRef, hovered);
  }
  positionalTrigger(rowRef: string): Promise<PositionalTrigger | null> {
    return this.call('positionalTrigger', rowRef);
  }
  confirmButton(text: string | null): Promise<string | null> {
    return this.call('confirmButton', text);
  }
  fileInputFor(ref: string): Promise<string | null> {
    return this.call('fileInputFor', ref);
  }
  selectNative(ref: string, option: string): Promise<{ ok: boolean; label?: string; options: string[] }> {
    return this.call('selectNative', ref, option);
  }
  isTextInput(ref: string | null): Promise<boolean> {
    return this.call('isTextInput', ref);
  }
  fieldState(ref: string | null): Promise<FieldState | null> {
    return this.call('fieldState', ref);
  }
  clearField(ref: string | null): Promise<'setter' | 'editor' | null> {
    return this.call('clearField', ref);
  }
  calendar(): Promise<CalendarInfo | null> {
    return this.call('calendar');
  }
  setNativeValue(ref: string, value: string): Promise<boolean> {
    return this.call('setNativeValue', ref, value);
  }
  describe(ref: string): Promise<string> {
    return this.call('describe', ref);
  }
  info(ref: string): Promise<ElementInfo | null> {
    return this.call('info', ref);
  }
  /** The element's rendered text (innerText, a field's value), whitespace collapsed (capture_text). */
  visibleText(ref: string): Promise<string> {
    return this.call('visibleText', ref);
  }
  /** The focused element (type steps without `into`: the field typed into; `input_type`: a password field or not). */
  focused(): Promise<{ desc: string; bbox: BBox; input_type: string } | null> {
    return this.call('focused');
  }
  /** Inspection: the visible interactive elements with verified suggested targets (one in-page call). */
  inventory(opts: InventoryOptions = {}): Promise<KitInventory> {
    return this.callOnce('inventory', opts);
  }
  /** Inspection: `find` for each (normalised) target. */
  checkTargets(targets: TargetObject[]): Promise<KitTargetChecks> {
    return this.callOnce('checkTargets', targets);
  }
  /** `find` for each target without acting, with the closest visible elements of those not found. */
  closest(targets: TargetObject[]): Promise<Array<{ count: number; near: NearElement[] }>> {
    return this.call('closest', targets);
  }
  /** Whether the focus is on `ref` (a `type` step's field) and what has it. */
  focusCheck(ref: string): Promise<{ ok: boolean; desc: string | null; field: string | null }> {
    return this.call('focusCheck', ref);
  }
  /** A field's value (input, textarea) or text (contenteditable); null for other elements. */
  fieldValue(ref: string | null): Promise<string | null> {
    return this.call('fieldValue', ref);
  }
  /** Start counting what a click changes on the page (dead-click detection). */
  effectWatch(): Promise<void> {
    return this.call('effectWatch');
  }
  effectSeen(): Promise<{ watching: boolean; dom: number; first: string; events: string[] }> {
    return this.call('effectSeen');
  }
  effectStop(): Promise<void> {
    return this.call('effectStop');
  }
  cursorSet(x: number, y: number, show?: boolean): Promise<void> {
    return this.call('cursor.set', x, y, show);
  }
  cursorShow(show: boolean): Promise<void> {
    return this.call(show ? 'cursor.show' : 'cursor.hide');
  }
  cursorState(): Promise<CursorState> {
    return this.call('cursor.state');
  }
  /** Draw the cursor of a document that has not painted content of its own (after the load the runner waited for). */
  cursorReveal(): Promise<void> {
    return this.call('cursor.reveal');
  }
  ripple(x: number, y: number): Promise<void> {
    return this.call('cursor.ripple', x, y);
  }
  ghostShow(name: string, detail: string): Promise<void> {
    return this.call('ghost.show', name, detail);
  }
  ghostHide(): Promise<void> {
    return this.call('ghost.hide');
  }
  fileDragBegin(spec: FileSpec): Promise<void> {
    return this.call('fileDrag.begin', spec);
  }
  fileDragDrop(x: number, y: number): Promise<DropOutcome> {
    return this.call('fileDrag.drop', x, y);
  }
  fileDragCancel(): Promise<void> {
    return this.call('fileDrag.cancel');
  }
}
