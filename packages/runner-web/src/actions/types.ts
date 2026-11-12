import type { ActionName, BBox, NormalizedArgsMap, PointSpec } from '@retake/core/model';
import type { StepContext } from '../runtime.js';

/** What an action reports for its timeline event. */
export interface ActionResult {
  target?: { desc: string; bbox?: BBox };
  point?: PointSpec;
  /** Capture time of the (first) mousedown / key press / drop. */
  t_click?: number;
  strategy?: string;
  popup_opened?: boolean;
  data?: unknown;
  /** The whole step is a hold (stillness the editor must not trim). */
  hold?: boolean;
  /** Kit ref of the element acted on (parking measures it; never written to the timeline). */
  ref?: string;
  /**
   * A plain click that showed no popup within after_click_ms: popups open then (wall-clock ms of the press), for the
   * next step to notice a popup that opens late on a slow or loaded machine (settleLatePopup).
   */
  pending_popup?: { before: number[]; wall: number };
}

export type ActionHandler<K extends ActionName> = (ctx: StepContext, args: NormalizedArgsMap[K]) => Promise<ActionResult>;

export type ActionTable = { [K in ActionName]: ActionHandler<K> };
