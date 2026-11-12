import { hasLocator, normalizeTarget, pickTarget } from '@retake/core/language';
import type { NormalizedStep, TargetSpec } from '@retake/core/model';
import { click, doubleClick, hover } from './click.js';
import { captureText, download, waitForEmail } from './artefacts.js';
import { date } from './calendar.js';
import { drag, dropFile } from './drag.js';
import { press, type } from './keyboard.js';
import { cursor, emit, evalStep, hook, notify, screenshot } from './misc.js';
import { newTab, open, switchPage } from './pages.js';
import { scroll } from './scroll.js';
import type { ActionTable } from './types.js';
import { assert, hold, wait, waitFor } from './waits.js';
import { menu, pick, select } from './widgets.js';

export type { ActionResult } from './types.js';

/** Every action of the scenario language (docs/DESIGN.md §3.3). */
export const ACTIONS: ActionTable = {
  open,
  click,
  double_click: doubleClick,
  hover,
  type,
  press,
  select,
  pick,
  menu,
  date,
  scroll,
  drag,
  drop_file: dropFile,
  wait,
  wait_for: waitFor,
  hold,
  assert,
  screenshot,
  new_tab: newTab,
  switch_page: switchPage,
  eval: evalStep,
  notify,
  emit,
  cursor,
  wait_for_email: waitForEmail,
  download,
  capture_text: captureText,
  hook,
};

/** The element a step acts on first (hovered instead of executed for irreversible steps in dry-run). */
export function primaryTarget(step: NormalizedStep): TargetSpec | null {
  const a = step.args as unknown as Record<string, unknown>;
  switch (step.action) {
    case 'click':
    case 'double_click':
    case 'hover': {
      const t = pickTarget(normalizeTarget(a as TargetSpec));
      return hasLocator(t) ? t : null;
    }
    case 'type':
      return (a.into as TargetSpec | undefined) ?? null;
    case 'select':
      return (a.combobox as TargetSpec | undefined) ?? (typeof a.field === 'string' ? { label: a.field } : null);
    case 'pick':
      return typeof a.field === 'string' ? { label: a.field } : ((a.field as TargetSpec | undefined) ?? null);
    case 'menu':
      return (a.trigger as TargetSpec | undefined) ?? (typeof a.row === 'string' ? { text: a.row } : ((a.row as TargetSpec | undefined) ?? null));
    case 'date':
      return typeof a.field === 'string' ? { label: a.field } : ((a.field as TargetSpec | undefined) ?? null);
    case 'drag':
      return (a.from as TargetSpec | undefined) ?? null;
    case 'drop_file':
      return (a.zone as TargetSpec | undefined) ?? null;
    case 'new_tab':
      return (a.target as TargetSpec | undefined) ?? null;
    case 'download':
      return (a.click as TargetSpec | undefined) ?? null;
    default:
      return null;
  }
}
