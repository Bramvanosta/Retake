/**
 * Slot filling: the value of each slot of a component use, from what the scenario wrote, else its `default_from`
 * source (theme, scenario title/outro, scene caption, interstitial). Pure; used by the edit planner and previews.
 */
import type { CaptionSpec } from '@demo-studio/core';
import type { ComponentManifest, ThemeTokens } from './types.js';

/** Where `default_from` sources read. Every part is optional (a preview has a theme but no scenario). */
export interface SlotContext {
  theme?: ThemeTokens;
  /** The template's outro texts (theme.outro.tagline / theme.outro.url). */
  templateOutro?: { tagline?: string; url?: string };
  scenario?: {
    title?: { text: string; kicker?: string };
    outro?: { tagline?: string; url?: string } | false;
  };
  scene?: { caption?: CaptionSpec };
  interstitial?: { text: string; kicker?: string };
}

export interface FilledSlots {
  /** Slot values (declared slots only; undefined when nothing provides one). */
  slots: Record<string, string | undefined>;
  /** Where each value came from: "given" or the default_from source. */
  from: Record<string, string>;
  /** Required slots (other than screen slots) left empty. */
  missing: string[];
  /** Text / url slots longer than their max_chars. */
  tooLong: Array<{ slot: string; length: number; max: number }>;
  /** Given slot names the component does not declare. */
  unknown: string[];
}

function caption(spec: CaptionSpec | undefined): { text?: string; kicker?: string } {
  if (spec === undefined) return {};
  return typeof spec === 'string' ? { text: spec } : spec;
}

/** The value of a `default_from` source in a context (undefined when absent or unknown). */
export function slotSource(source: string, ctx: SlotContext): string | undefined {
  const outro = ctx.scenario?.outro === false ? undefined : ctx.scenario?.outro;
  switch (source) {
    case 'theme.logo':
      return ctx.theme?.logo?.url;
    case 'theme.wordmark':
      return ctx.theme?.wordmark?.url ?? ctx.theme?.wordmark?.text;
    case 'theme.brand.name':
      return ctx.theme?.brand.name;
    case 'theme.brand.url':
      return ctx.theme?.brand.url;
    case 'theme.outro.tagline':
      return ctx.templateOutro?.tagline;
    case 'theme.outro.url':
      return ctx.templateOutro?.url;
    case 'scenario.title.text':
      return ctx.scenario?.title?.text;
    case 'scenario.title.kicker':
      return ctx.scenario?.title?.kicker;
    case 'scenario.outro.tagline':
      return outro?.tagline;
    case 'scenario.outro.url':
      return outro?.url;
    case 'scene.caption.text':
      return caption(ctx.scene?.caption).text;
    case 'scene.caption.kicker':
      return caption(ctx.scene?.caption).kicker;
    case 'interstitial.text':
      return ctx.interstitial?.text;
    case 'interstitial.kicker':
      return ctx.interstitial?.kicker;
    default:
      return undefined;
  }
}

/** Fill the slots of a component use: given values first, then each slot's `default_from` source. */
export function fillSlots(manifest: Pick<ComponentManifest, 'slots'>, given: Record<string, string | undefined> = {}, ctx: SlotContext = {}): FilledSlots {
  const out: FilledSlots = { slots: {}, from: {}, missing: [], tooLong: [], unknown: [] };
  for (const [name, spec] of Object.entries(manifest.slots)) {
    let value = given[name];
    let from = 'given';
    if (value === undefined && spec.default_from) {
      value = slotSource(spec.default_from, ctx);
      from = spec.default_from;
    }
    out.slots[name] = value;
    if (value !== undefined) out.from[name] = from;
    if (value === undefined && spec.required && spec.type !== 'screen') out.missing.push(name);
    if (value !== undefined && spec.max_chars !== undefined && (spec.type === 'text' || spec.type === 'url')) {
      const length = [...value].length;
      if (length > spec.max_chars) out.tooLong.push({ slot: name, length, max: spec.max_chars });
    }
  }
  out.unknown = Object.keys(given).filter((k) => manifest.slots[k] === undefined);
  return out;
}
