/**
 * Whether a component can take one use as the scenario writes it (L4.5, critique B7): the timeline offers a switch in
 * one click only when the result is what the click promised — not a planner fallback with a warning, nor an empty card.
 *
 * A component fits a use when it is registered and loads (kit API included), is usable as the use's kind, shows every
 * slot the use writes, gets every required slot (written, or filled by its `default_from`), takes the use's params as
 * they are (its params schema, defaults applied), and — for a layout — shows as many pages as the scene films. A use
 * that is a user file (`video` / `image` / `lottie`) takes no component: the file replaces it. Pure.
 */
import type { ComponentKind } from '@demo-studio/core';
import { isMultiPaneGeometry } from './geometry.js';
import { applyParamDefaults, validateParamValue } from './json-schema.js';
import type { JsonSchemaNode } from './json-schema.js';
import { usableAs } from './registry.js';
import type { ComponentRegistry } from './registry.js';

/** A use as the scenario writes it. */
export interface ComponentUse {
  kind: ComponentKind;
  /** Slot values written for the use (a card's `slots`). */
  slots?: Record<string, unknown>;
  /** Slot names the planner fills for this kind from the scenario (an interstitial's text and kicker). */
  named?: readonly string[];
  params?: Record<string, unknown>;
  /** The use is a user file (video, image or Lottie): the file replaces any component. */
  file?: boolean;
  /** Layouts: the pages the scene films (absent: not checked — the video's frame applies to every scene). */
  pages?: number;
}

export type ComponentFit = { ok: true } | { ok: false; why: string };

const no = (why: string): ComponentFit => ({ ok: false, why });

/** Whether component `id` fits `use` (see the module comment), with why not in one short sentence. */
export function componentFit(registry: ComponentRegistry, id: string, use: ComponentUse): ComponentFit {
  if (use.file) return no('a video, image or Lottie file replaces the component here');
  let manifest;
  try {
    manifest = registry.get(id).manifest;
  } catch (e) {
    return no((e as Error).message.split('\n')[0].slice(0, 200));
  }
  if (!usableAs(manifest, use.kind)) return no(`${id} is ${/^[aeiou]/.test(manifest.kind) ? 'an' : 'a'} ${manifest.kind} component, not ${/^[aeiou]/.test(use.kind) ? 'an' : 'a'} ${use.kind}`);
  if (use.kind === 'layout' && use.pages !== undefined) {
    const multi = isMultiPaneGeometry(manifest.geometry);
    if (use.pages > 1 && !multi) return no(`shows one page: this scene films ${use.pages}`);
    if (use.pages <= 1 && multi) return no('shows several pages: this scene films one');
  }
  const slots = manifest.slots ?? {};
  for (const [name, v] of Object.entries(use.slots ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (!slots[name]) return no(`does not show slots.${name}`);
  }
  const given = new Set([...Object.keys(use.slots ?? {}), ...(use.named ?? [])]);
  for (const [name, spec] of Object.entries(slots)) {
    // A `screen` slot is the capture the planner hands a layout, never a scenario value.
    if (spec.required && !spec.default_from && spec.type !== 'screen' && !given.has(name)) return no(`needs slots.${name}`);
  }
  const schema = (manifest.params as JsonSchemaNode | undefined) ?? { type: 'object', properties: {} };
  const issues = validateParamValue(schema, applyParamDefaults(schema, use.params ?? {}), ['params']);
  if (issues.length) {
    const i = issues[0];
    return no(`does not take ${i.path.join('.')} as written (${i.message})`);
  }
  return { ok: true };
}
