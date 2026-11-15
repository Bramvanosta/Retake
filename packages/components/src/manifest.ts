/**
 * component.yaml: the manifest of a component (docs/DESIGN-phase2.md §1.1, SPEC §11).
 *
 * `ComponentManifestFileSchema` is strict (unknown keys are errors with a did-you-mean); `parseManifest` adds the
 * semantic checks (layout geometry inside the design space, duration bounds, slot sources, theme tokens, the params
 * JSON Schema and its defaults, preview samples) and returns positioned issues.
 */

import { brokenUnder, checkYamlDocument, didYouMean, errorMessage, hasErrors, locatedIssue } from '@retake/core/base';
import type { LocatedIssue } from '@retake/core/base';
import type { ComponentKind } from '@retake/core/model';
import { applyParamDefaults, checkParamsSchema, isPlainObject, paramDefaults, validateParamValue } from './json-schema.js';
import { ANCHOR_KEYS, GEOMETRY_BUILTINS, GEOMETRY_KEYS, anchorScope, evalAnchor, evalLayoutGeometry, expressionIdentifiers, geometryIsDynamic, paramEnums } from './geometry.js';
import type { JsonSchemaNode } from './json-schema.js';
import type { AnchorSpec, ComponentIssue, ComponentManifest, LayoutGeometry, LayoutGeometrySpec, Rect1920 } from './types.js';
import { CLIP_BOUND_KINDS, ComponentManifestFileSchema, DEFAULT_ENTRY, DESIGN_SPACE, MANIFEST_FILE, MULTI_USE_KINDS, SLOT_SOURCES, THEME_TOKENS } from './manifest-schema.js';
import type { ComponentManifestFile } from './manifest-schema.js';

export {
  AnchorSchema,
  ComponentManifestFileSchema,
  DEFAULT_ENTRY,
  DESIGN_SPACE,
  GeometryValueSchema,
  KIT_RANGE_RE,
  kitMajorOf,
  LayoutGeometrySchema,
  MANIFEST_FILE,
  MULTI_USE_KINDS,
  ParamsJsonSchemaSchema,
  RectSchema,
  SEMVER_RE,
  SLOT_SOURCES,
  SlotSpecSchema,
  THEME_TOKENS,
  VARIANTS,
} from './manifest-schema.js';
export type { ComponentManifestFile } from './manifest-schema.js';

function rectInside(r: { x: number; y: number; w: number; h: number }, space: { width: number; height: number }): boolean {
  const eps = 1e-6;
  return r.x >= -eps && r.y >= -eps && r.x + r.w <= space.width + eps && r.y + r.h <= space.height + eps;
}

const GEOMETRY_RECTS = ['screen', 'frame', 'chrome', 'caption', 'brandmark'] as const;
type GeometryKey = (typeof GEOMETRY_KEYS)[keyof typeof GEOMETRY_KEYS];
const ALL_GEOMETRY_KEYS = Object.values(GEOMETRY_KEYS) as GeometryKey[];

/**
 * Geometry checks: every expression parses and only names numeric/boolean params, earlier vars or `aspect`; the
 * geometry evaluated with the param defaults (capture aspect 16:9) has positive sizes and stays inside the design
 * space.
 */
function checkGeometry(g: LayoutGeometrySpec, key: GeometryKey, paramTypes: ReadonlyMap<string, string>, out: LocatedIssue[], defaults: Record<string, unknown>): void {
  const space = key === 'geometry' ? DESIGN_SPACE.landscape : key === 'geometry_vertical' ? DESIGN_SPACE.vertical : DESIGN_SPACE.square;
  const known = new Set<string>([...GEOMETRY_BUILTINS, ...[...paramTypes].filter(([, t]) => t === 'number' || t === 'integer' || t === 'boolean').map(([n]) => n)]);
  let syntaxOk = true;
  const check = (path: Array<string | number>, v: unknown) => {
    if (typeof v !== 'string') return;
    let ids: string[];
    try {
      ids = expressionIdentifiers(v);
    } catch (e) {
      syntaxOk = false;
      out.push(locatedIssue('error', [key, ...path], `invalid expression "${v}": ${errorMessage(e)}`));
      return;
    }
    for (const id of ids) {
      if (known.has(id)) continue;
      syntaxOk = false;
      const type = paramTypes.get(id);
      const s = didYouMean(id, [...known]);
      out.push(
        locatedIssue(
          'error',
          [key, ...path],
          type
            ? `"${id}" is a ${type} param: expressions only use number, integer or boolean params`
            : `unknown name "${id}" in "${v}"${s ? ` (did you mean "${s}"?)` : ''}; known: ${[...known].join(', ')}`,
        ),
      );
    }
  };
  for (const [name, v] of Object.entries(g.vars ?? {})) {
    check(['vars', name], v);
    if (name === 'aspect' || name === 'aspect2') {
      syntaxOk = false;
      out.push(locatedIssue('error', [key, 'vars', name], `"${name}" is built in (the ${name === 'aspect' ? 'capture' : 'second page'}'s width / height)`));
    } else if (paramTypes.has(name)) {
      // A var may not shadow a param (it would silently change what the name means).
      syntaxOk = false;
      out.push(locatedIssue('error', [key, 'vars', name], `var "${name}" has the name of a param`));
    }
    known.add(name);
  }
  for (const name of GEOMETRY_RECTS) {
    const r = g[name];
    if (r) for (const k of ['x', 'y', 'w', 'h'] as const) check([name, k], r[k]);
  }
  check(['radius'], g.radius);
  (g.panes ?? []).forEach((r, i) => {
    for (const k of ['x', 'y', 'w', 'h'] as const) check(['panes', i, k], r[k]);
  });
  if (g.inset) for (const k of ['x', 'y', 'w', 'h'] as const) check(['inset', k], g.inset[k]);
  if (g.panes && g.inset) {
    syntaxOk = false;
    out.push(locatedIssue('error', [key, 'inset'], 'a layout shows its pages side by side (`panes`) or one over the other (`inset`), not both'));
  }
  if (!syntaxOk) return;
  let e: LayoutGeometry;
  try {
    e = evalLayoutGeometry(g, defaults);
  } catch (err) {
    out.push(locatedIssue('error', [key], `the geometry cannot be evaluated with the param defaults: ${errorMessage(err)}`));
    return;
  }
  const dynamic = geometryIsDynamic(g);
  const withDefaults = dynamic ? ' (with the param defaults, capture 16:9)' : '';
  for (const name of GEOMETRY_RECTS) {
    const r = e[name];
    if (!r) continue;
    let sized = true;
    for (const k of ['w', 'h'] as const) {
      if (r[k] <= 0) {
        sized = false;
        out.push(locatedIssue('error', [key, name, k], `must be > 0${typeof g[name]?.[k] === 'string' ? `, is ${r[k]}${withDefaults}` : ''}`));
      }
    }
    if (sized && !rectInside(r, space)) {
      out.push(locatedIssue('error', [key, name], `${name} rect {x: ${r.x}, y: ${r.y}, w: ${r.w}, h: ${r.h}}${withDefaults} leaves the ${space.width}×${space.height} design space`));
    }
  }
  if (e.radius !== undefined && e.radius < 0) out.push(locatedIssue('error', [key, 'radius'], `must be ≥ 0, is ${e.radius}${withDefaults}`));
  const extra: Array<{ path: Array<string | number>; r: Rect1920 }> = [...(e.panes ?? []).map((r, i) => ({ path: ['panes', i], r })), ...(e.inset ? [{ path: ['inset'], r: e.inset }] : [])];
  for (const { path, r } of extra) {
    if (r.w <= 0 || r.h <= 0) out.push(locatedIssue('error', [key, ...path], `must have a size > 0, is ${r.w}×${r.h}${withDefaults}`));
    else if (!rectInside(r, space))
      out.push(locatedIssue('error', [key, ...path], `rect {x: ${r.x}, y: ${r.y}, w: ${r.w}, h: ${r.h}}${withDefaults} leaves the ${space.width}×${space.height} design space`));
  }
}

/** An anchor's expressions only name numeric params, one-hot string values, vars and aspect; with the defaults it lies in the design space. */
function checkAnchor(spec: AnchorSpec, key: string, variant: 'landscape' | 'vertical' | 'square', schema: JsonSchemaNode | undefined): LocatedIssue[] {
  const out: LocatedIssue[] = [];
  const enums = paramEnums(schema);
  const defaults = schema ? paramDefaults(schema) : {};
  const frame = DESIGN_SPACE[variant];
  const known = new Set<string>(Object.keys(anchorScope(defaults, { enums, frame: { w: frame.width, h: frame.height } })));
  if (schema && isPlainObject(schema.properties)) {
    for (const [name, sch] of Object.entries(schema.properties as Record<string, unknown>)) {
      const t = isPlainObject(sch) ? sch.type : undefined;
      if (t === 'number' || t === 'integer' || t === 'boolean') known.add(name);
    }
  }
  let ok = true;
  const check = (path: Array<string | number>, v: unknown) => {
    if (typeof v !== 'string') return;
    let ids: string[];
    try {
      ids = expressionIdentifiers(v);
    } catch (e) {
      ok = false;
      out.push(locatedIssue('error', [key, ...path], `invalid expression "${v}": ${errorMessage(e)}`));
      return;
    }
    for (const id of ids) {
      if (known.has(id)) continue;
      ok = false;
      const s = didYouMean(id, [...known]);
      out.push(locatedIssue('error', [key, ...path], `unknown name "${id}" in "${v}"${s ? ` (did you mean "${s}"?)` : ''}`));
    }
  };
  for (const [name, v] of Object.entries(spec.vars ?? {})) {
    check(['vars', name], v);
    known.add(name);
  }
  for (const k of ['x', 'y', 'w', 'h'] as const) check([k], spec[k]);
  if (!ok) return out;
  try {
    const r = evalAnchor(spec, defaults, { enums, frame: { w: frame.width, h: frame.height } });
    const space = frame;
    if (r.w < 0 || r.h < 0) out.push(locatedIssue('error', [key], 'w and h must be ≥ 0 (with the param defaults)'));
    else if (!rectInside(r, space))
      out.push(locatedIssue('error', [key], `anchor {x: ${r.x}, y: ${r.y}, w: ${r.w}, h: ${r.h}} leaves the ${space.width}×${space.height} design space (param defaults)`));
  } catch (e) {
    out.push(locatedIssue('error', [key], `the anchor cannot be evaluated with the param defaults: ${errorMessage(e)}`));
  }
  return out;
}

/** A manifest under its semantic checks: its fields, which of them are structurally sound, and the issues found. */
interface ManifestCheck {
  m: Partial<ComponentManifestFile>;
  ok: (path: Array<string | number>) => boolean;
  kind: ComponentKind | undefined;
  slots: NonNullable<ComponentManifestFile['slots']>;
  out: LocatedIssue[];
}

/** Slots: sources and limits. */
function checkSlots(c: ManifestCheck): void {
  const { ok, kind, slots, out } = c;
  // Slots: sources and limits.
  for (const [name, slot] of Object.entries(slots)) {
    if (!ok(['slots', name]) || !isPlainObject(slot)) continue;
    if (slot.default_from !== undefined && !(SLOT_SOURCES as readonly string[]).includes(slot.default_from)) {
      const s = didYouMean(slot.default_from, SLOT_SOURCES);
      out.push(locatedIssue('warning', ['slots', name, 'default_from'], `unknown slot source "${slot.default_from}"${s ? ` (did you mean "${s}"?)` : ''}; known: ${SLOT_SOURCES.join(', ')}`));
    }
    if (slot.max_chars !== undefined && slot.type !== 'text' && slot.type !== 'url') {
      out.push(locatedIssue('warning', ['slots', name, 'max_chars'], `max_chars only applies to text and url slots ("${name}" is ${slot.type})`));
    }
    if (slot.type === 'screen' && kind !== undefined && kind !== 'layout' && kind !== 'interstitial' && kind !== 'transition') {
      out.push(locatedIssue('warning', ['slots', name, 'type'], `screen slots are filled for layouts, interstitials and transitions only, not for ${kind} components`));
    }
  }
}

/** Other kinds. */
function checkKinds(c: ManifestCheck): void {
  const { m, ok, kind, out } = c;
  // Other kinds.
  if (Array.isArray(m.kinds) && ok(['kinds'])) {
    m.kinds.forEach((k, i) => {
      if (k === kind) out.push(locatedIssue('warning', ['kinds', i], `"${k}" is the component's own kind: no need to list it in kinds`));
      else if (m.kinds!.indexOf(k) !== i) out.push(locatedIssue('error', ['kinds', i], `"${k}" is listed twice`));
    });
    if (kind !== undefined && !(MULTI_USE_KINDS as readonly string[]).includes(kind)) {
      out.push(locatedIssue('error', ['kinds'], `only ${MULTI_USE_KINDS.join(', ')} components may be used as other kinds (this one is ${kind})`, { path: ['kinds'], key: true }));
    }
  }
}

/** Layout geometry. */
function checkLayoutGeometry(c: ManifestCheck): void {
  const { m, ok, kind, out } = c;
  // Layout geometry.
  if (kind === 'layout') {
    if (m.geometry === undefined) {
      out.push(
        locatedIssue('error', [], 'a layout component must declare "geometry" (screen rect, + caption/brandmark… in the 1920×1080 design space)', {
          path: ['kind'],
        }),
      );
    }
    for (const variant of ['vertical', 'square'] as const) {
      const declared = ok(['variants']) && Array.isArray(m.variants) && m.variants.includes(variant);
      const key = GEOMETRY_KEYS[variant];
      if (declared && m[key] === undefined) {
        const space = DESIGN_SPACE[variant];
        out.push(
          locatedIssue('error', [], `a layout with the ${variant} variant must declare "${key}" (${space.width}×${space.height} design space)`, {
            path: ['variants'],
          }),
        );
      }
    }
  } else if (kind !== undefined) {
    for (const key of ALL_GEOMETRY_KEYS) {
      if (m[key] !== undefined) out.push(locatedIssue('warning', [key], `${key} is only used by layout components (this one is ${kind})`, { path: [key], key: true }));
    }
  }
  if (ALL_GEOMETRY_KEYS.some((key) => m[key] !== undefined)) {
    const paramTypes = new Map<string, string>();
    let defaults: Record<string, unknown> = {};
    if (m.params !== undefined && ok(['params']) && !hasErrors(checkParamsSchema(m.params, ['params']))) {
      const props = isPlainObject((m.params as JsonSchemaNode).properties) ? ((m.params as JsonSchemaNode).properties as Record<string, unknown>) : {};
      for (const [name, sch] of Object.entries(props)) {
        const t = isPlainObject(sch) ? sch.type : undefined;
        paramTypes.set(name, typeof t === 'string' ? t : Array.isArray(t) ? t.join('|') : 'value');
      }
      defaults = paramDefaults(m.params as JsonSchemaNode);
    }
    for (const key of ALL_GEOMETRY_KEYS) {
      if (m[key] !== undefined && ok([key])) checkGeometry(m[key] as LayoutGeometrySpec, key, paramTypes, out, defaults);
    }
  }
}

/** Anchors, duration, variants, theme tokens, entry file. */
function checkManifestFields(c: ManifestCheck): void {
  const { m, ok, kind, out } = c;
  // Anchors (tap targets for tap-open transitions).
  for (const variant of ['landscape', 'vertical', 'square'] as const) {
    const key = ANCHOR_KEYS[variant];
    const spec = m[key] as AnchorSpec | undefined;
    if (spec === undefined || !ok([key])) continue;
    const schema = m.params !== undefined && ok(['params']) && !hasErrors(checkParamsSchema(m.params, ['params'])) ? (m.params as JsonSchemaNode) : undefined;
    out.push(...checkAnchor(spec, key, variant, schema));
  }

  // Duration.
  if (m.duration !== undefined && ok(['duration'])) {
    const d = m.duration;
    if (d.min !== undefined && d.max !== undefined && d.min > d.max) {
      out.push(locatedIssue('error', ['duration', 'min'], `min (${d.min} s) is greater than max (${d.max} s)`));
    } else {
      if (d.min !== undefined && d.default < d.min) out.push(locatedIssue('error', ['duration', 'default'], `default (${d.default} s) is below min (${d.min} s)`));
      if (d.max !== undefined && d.default > d.max) out.push(locatedIssue('error', ['duration', 'default'], `default (${d.default} s) is above max (${d.max} s)`));
    }
    if (kind !== undefined && CLIP_BOUND_KINDS.includes(kind)) {
      out.push(locatedIssue('warning', ['duration'], `duration is ignored for ${kind} components (they last as long as their clip)`, { path: ['duration'], key: true }));
    }
  }

  // Variants.
  if (Array.isArray(m.variants) && ok(['variants'])) {
    m.variants.forEach((v, i) => {
      if (m.variants!.indexOf(v) !== i) out.push(locatedIssue('error', ['variants', i], `"${v}" is listed twice`));
    });
  }

  // Theme tokens.
  if (Array.isArray(m.tokens) && ok(['tokens'])) {
    m.tokens.forEach((t, i) => {
      if ((THEME_TOKENS as readonly string[]).includes(t) || /^colors\.[A-Za-z0-9_-]+$/.test(t)) return;
      const s = didYouMean(t, THEME_TOKENS);
      out.push(locatedIssue('warning', ['tokens', i], `unknown theme token "${t}"${s ? ` (did you mean "${s}"?)` : ''}`));
    });
  }

  // Entry file.
  if (typeof m.entry === 'string' && ok(['entry'])) {
    const e = m.entry.replace(/\\/g, '/');
    if (e.startsWith('/') || /^[A-Za-z]:/.test(e) || e.split('/').includes('..')) {
      out.push(locatedIssue('error', ['entry'], `entry must be a path inside the component folder, got "${m.entry}"`));
    } else if (!/\.(tsx|ts|jsx|js)$/.test(e)) {
      out.push(locatedIssue('error', ['entry'], `entry must be a .tsx, .ts, .jsx or .js file, got "${m.entry}"`));
    }
  }
}

/** Params JSON Schema, then the preview samples. */
function checkPreview(c: ManifestCheck): void {
  const { m, ok, slots, out } = c;
  // Params JSON Schema, then the preview samples.
  let paramsSchema: JsonSchemaNode | undefined;
  if (m.params !== undefined && ok(['params'])) {
    const issues = checkParamsSchema(m.params, ['params']);
    out.push(...issues);
    if (!hasErrors(issues)) paramsSchema = m.params as JsonSchemaNode;
  }
  const preview = ok(['preview']) && isPlainObject(m.preview) ? m.preview : undefined;
  const previewSlots = preview && isPlainObject(preview.slots) ? preview.slots : {};
  for (const name of Object.keys(previewSlots)) {
    if (slots[name] !== undefined || !ok(['slots'])) continue;
    const s = didYouMean(
      name,
      Object.keys(slots).filter((k) => previewSlots[k] === undefined),
    );
    out.push(
      locatedIssue('error', ['preview', 'slots'], `unknown slot "${name}"${s ? ` (did you mean "${s}"?)` : ''}: declare it under slots`, {
        path: ['preview', 'slots', name],
        key: true,
      }),
    );
  }
  if (ok(['slots'])) {
    const missing = Object.entries(slots)
      .filter(([name, slot]) => slot.required === true && slot.type !== 'screen' && !slot.default_from?.startsWith('theme.') && previewSlots[name] === undefined)
      .map(([name]) => name);
    if (missing.length > 0) {
      out.push(
        locatedIssue(
          'error',
          preview ? ['preview'] : [],
          `preview.slots must give a sample for the required slot${missing.length > 1 ? 's' : ''} ${missing.map((n) => `"${n}"`).join(', ')} ` +
            '(previews render with any theme but without a scenario)',
          preview ? { path: ['preview'], key: true } : undefined,
        ),
      );
    }
  }
  if (preview && preview.params !== undefined && (m.params === undefined || paramsSchema !== undefined)) {
    const schema = paramsSchema ?? { type: 'object', properties: {} };
    const merged = applyParamDefaults(schema, preview.params as Record<string, unknown>);
    out.push(...validateParamValue(schema, merged, ['preview', 'params']));
  }
}

/** Semantic checks of a structurally valid manifest. Exported for tests; use `parseManifest`. */
export function checkManifest(value: unknown, structural: readonly LocatedIssue[]): LocatedIssue[] {
  const out: LocatedIssue[] = [];
  if (!isPlainObject(value)) return out;
  const m = value as Partial<ComponentManifestFile>;
  const ok = (path: Array<string | number>) => !brokenUnder(structural, path);
  const kind = ok(['kind']) ? m.kind : undefined;
  const slots = ok(['slots']) && isPlainObject(m.slots) ? m.slots : {};

  const c: ManifestCheck = { m, ok, kind, slots, out };
  checkSlots(c);
  checkKinds(c);
  checkLayoutGeometry(c);
  checkManifestFields(c);
  checkPreview(c);
  return out;
}

/** The manifest with its defaults applied (entry, slots). */
export function normalizeManifest(file: ComponentManifestFile): ComponentManifest {
  const out = { ...structuredClone(file), entry: file.entry ?? DEFAULT_ENTRY, slots: structuredClone(file.slots ?? {}) } as ComponentManifest;
  return out;
}

export interface ParseManifestOptions {
  /** "<namespace>/<name>" of the folder holding the file: the manifest id must equal it. */
  folderId?: string;
}

export interface ParsedManifest {
  /** Set when there is no error-level issue. */
  manifest?: ComponentManifest;
  issues: ComponentIssue[];
}

/**
 * Parse and validate component.yaml text. Issues carry line/col and `file` (the name given, default
 * "component.yaml"); `manifest` is returned only when there is no error.
 */
export function parseManifest(text: string, file: string = MANIFEST_FILE, opts: ParseManifestOptions = {}): ParsedManifest {
  const semantic = (value: unknown, structural: readonly LocatedIssue[]): LocatedIssue[] => {
    const out = checkManifest(value, structural);
    const id = isPlainObject(value) ? value.id : undefined;
    if (opts.folderId !== undefined && typeof id === 'string' && !brokenUnder(structural, ['id']) && id !== opts.folderId) {
      out.push(
        locatedIssue(
          'error',
          ['id'],
          `id "${id}" does not match the folder path "${opts.folderId}": a component lives in <components>/<namespace>/<name>/ — ` + `rename the folder or set id: ${opts.folderId}`,
        ),
      );
    }
    return out;
  };
  const { value, issues } = checkYamlDocument(text, ComponentManifestFileSchema, semantic);
  const withFile = issues.map((i) => ({ ...i, file }));
  if (hasErrors(issues)) return { issues: withFile };
  return { manifest: normalizeManifest(value as ComponentManifestFile), issues: withFile };
}
