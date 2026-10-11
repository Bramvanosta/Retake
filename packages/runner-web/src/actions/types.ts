import type { ActionName, BBox, NormalizedArgsMap, PointSpec } from '@demo-studio/core';
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
}

export type ActionHandler<K extends ActionName> = (ctx: StepContext, args: NormalizedArgsMap[K]) => Promise<ActionResult>;

export type ActionTable = { [K in ActionName]: ActionHandler<K> };
