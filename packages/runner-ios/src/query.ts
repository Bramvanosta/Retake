/**
 * A scenario's target (core TargetSpec) as a query of the iOS driver (driver/RetakeDriverUITests/Query.swift): its
 * text (an element's label or value), label (`label`, `aria`, or `name` beside a role), accessibility identifier
 * (`testid`), element types (`role`), placeholder, index and exactness. The keys core's iOS checks refuse never reach
 * here; one that does is refused in words.
 */
import { describeTarget, normalizeTarget } from '@retake/core/language';
import type { TargetSpec } from '@retake/core/language';

/** What the driver's `find` / `tap` take as `query`. */
export interface DriverQuery {
  text?: string;
  label?: string;
  id?: string;
  /** XCUIElement types (the driver's names): one of them matches. */
  roles?: string[];
  placeholder?: string;
  exact?: boolean;
  nth?: number;
}

/** The element types of each role an iOS target may name (core IOS_TARGET_ROLES). */
export const ROLE_TYPES: Readonly<Record<string, readonly string[]>> = {
  button: ['button'],
  textbox: ['textField', 'secureTextField', 'searchField', 'textView'],
  checkbox: ['switch'],
  switch: ['switch'],
  heading: ['staticText'],
  text: ['staticText'],
  cell: ['cell'],
  row: ['cell'],
};

/** The element types a field typed into may be (a `type` step's `into` without a role). */
export const TEXT_INPUT_TYPES: readonly string[] = ROLE_TYPES.textbox;

/** The driver query of a target, or an Error saying which key the iOS driver does not read. Pure. */
export function driverQuery(target: TargetSpec): DriverQuery {
  const t = normalizeTarget(target);
  for (const key of ['css', 'contains', 'in', 'last_visible'] as const) {
    if (t[key] !== undefined) throw new Error(`target ${describeTarget(target)}: \`${key}\` is not available on iOS`);
  }
  const q: DriverQuery = {};
  if (t.text !== undefined) q.text = t.text;
  const label = t.label ?? t.aria ?? t.name;
  if (label !== undefined) q.label = label;
  if (t.testid !== undefined) q.id = t.testid;
  if (t.role !== undefined) {
    const types = ROLE_TYPES[t.role.trim().toLowerCase()];
    if (!types) throw new Error(`target ${describeTarget(target)}: role "${t.role}" is not available on iOS (roles: ${Object.keys(ROLE_TYPES).join(', ')})`);
    q.roles = [...types];
  }
  if (t.placeholder !== undefined) q.placeholder = t.placeholder;
  if (t.exact) q.exact = true;
  if (t.nth !== undefined) {
    if (!Number.isInteger(t.nth) || t.nth < 0) throw new Error(`target ${describeTarget(target)}: nth counts from 0 on iOS (no index from the end)`);
    q.nth = t.nth;
  }
  if (q.text === undefined && q.label === undefined && q.id === undefined && q.roles === undefined && q.placeholder === undefined) {
    throw new Error(`target ${describeTarget(target)} names nothing the iOS driver can look for (text, label, testid, role, placeholder)`);
  }
  return q;
}
