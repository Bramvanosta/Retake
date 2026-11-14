/**
 * What the Node side and a render bundle agree on, written once: the ids of the compositions the root registers and
 * the input props each takes. Pure — no renderer library, no React, nothing of Node: ../render/*.ts builds the props
 * with `videoProps` / `previewProps`, ./Root.tsx reads them with `readVideoProps` / `readPreviewProps`.
 *
 * The version is insurance, not a mechanism: this file is one of the sources a bundle's key hashes
 * (../render/bundle.ts), so a Node side at another props version already builds another bundle. It only speaks for a
 * bundle kept by hand and served to another Node side. The root's default props carry no version (a composition
 * listed with no input has no payload to check); a payload with a missing or another version is refused.
 */
import type { EditPlan } from '../plan-types.js';
import type { ComponentPreviewSpec } from './preview-types.js';

/** Composition ids of the three video variants. */
export const VIDEO_COMPOSITIONS = { landscape: 'DemoVideo', vertical: 'DemoVertical', square: 'DemoSquare' } as const;
/** Composition id of component previews. */
export const PREVIEW_COMPOSITION = 'ComponentPreview';
/** Every composition the root registers. */
export const COMPOSITIONS = { ...VIDEO_COMPOSITIONS, preview: PREVIEW_COMPOSITION } as const;

/** Version of the input props below: bump it when a field changes meaning. */
export const PROPS_VERSION = 1;

/** Input props of the video compositions. */
export interface VideoProps extends Record<string, unknown> {
  v?: number;
  plan: EditPlan | null;
}

/** Input props of the preview composition. */
export interface PreviewProps extends Record<string, unknown> {
  v?: number;
  preview: ComponentPreviewSpec | null;
}

/** The props the Node side hands a video composition. */
export function videoProps(plan: EditPlan): VideoProps {
  return { v: PROPS_VERSION, plan };
}

/** The props the Node side hands the preview composition. */
export function previewProps(preview: ComponentPreviewSpec): PreviewProps {
  return { v: PROPS_VERSION, preview };
}

function payload<T>(props: unknown, key: 'plan' | 'preview'): T | null {
  if (!props || typeof props !== 'object') throw new Error(`render props must be an object ({ v, ${key} })`);
  const p = props as Record<string, unknown>;
  const value = p[key];
  if (value === null || value === undefined) return null;
  if (p.v !== PROPS_VERSION) {
    const got = p.v === undefined ? 'none' : typeof p.v === 'number' ? String(p.v) : typeof p.v;
    throw new Error(`render props version ${got} does not match this bundle (${PROPS_VERSION}): rebuild the bundle`);
  }
  return value as T;
}

/** The plan of a video composition's props: null with no payload (the root's defaults); a payload of another version is refused. */
export function readVideoProps(props: unknown): EditPlan | null {
  return payload<EditPlan>(props, 'plan');
}

/** The spec of the preview composition's props: null with no payload; a payload of another version is refused. */
export function readPreviewProps(props: unknown): ComponentPreviewSpec | null {
  return payload<ComponentPreviewSpec>(props, 'preview');
}
