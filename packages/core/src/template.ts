import type { z } from 'zod';
import { CheckContext } from './checks/context.js';
import { checkMediaFields } from './checks/media.js';
import { isTemplateMediaRef, resolveThemeComponents } from './components.js';
import { FORMAT_VERSIONS } from './formats.js';
import type { ThemeComponent } from './components.js';
import type { CheckFiles } from './file-facts.js';
import { hasErrors } from './issues.js';
import { TemplateFileSchema, TemplateSchema } from './schemas/template.js';
import { DEFAULT_TEMPLATE } from './template-defaults.js';
import type { ComponentKind, Template, ValidationIssue } from './types.js';
import { checkYamlDocument } from './validation/document.js';
import { finalizeIssues, issue } from './validation/located.js';
import type { LocatedIssue } from './validation/located.js';
import { zodIssues } from './validation/zod-issues.js';

export { DEFAULT_TEMPLATE } from './template-defaults.js';

export const TEMPLATE_FILE = 'template.yaml';

/** templates/<name>/template.yaml as written (every section optional). */
export type TemplateFile = z.infer<typeof TemplateFileSchema>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? structuredClone(base) : structuredClone(over);
  const out: Record<string, unknown> = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined) out[k] = deepMerge(base[k], v);
  }
  return out;
}

/** Merge a template file over a base template: objects merge recursively, arrays and scalars replace. */
export function mergeTemplate(base: Template, file: TemplateFile): Template {
  return deepMerge(base, file) as Template;
}

/** The default template without its name: the name of a template comes from its file or its directory. */
function nameless(): Template {
  const { name: _defaultName, ...defaults } = DEFAULT_TEMPLATE;
  return defaults;
}

/** Legacy template fields that select a default component when `components` does not (resolveThemeComponents). */
const LEGACY_FIELDS: Partial<Record<ComponentKind, { section: string; keys: string[] }>> = {
  layout: { section: 'frame', keys: ['style', 'width', 'radius', 'shadow'] },
  intro: { section: 'intro', keys: ['layout'] },
  outro: { section: 'outro', keys: ['layout'] },
  interstitial: { section: 'interstitial', keys: ['style'] },
  caption: { section: 'captions', keys: ['position'] },
  transition: { section: 'transitions', keys: ['between_scenes', 'duration'] },
};

/** JSON with object keys in locale order (`localeCompare`): a choice's params as a theme description shows and compares them. */
function localeSortedJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
}

function describeChoice(c: ThemeComponent | null): string {
  if (!c) return 'none';
  return Object.keys(c.params).length > 0 ? `${c.id} ${localeSortedJson(c.params)}` : c.id;
}

/** A `components` entry contradicting the legacy fields written next to it (checkTemplateFile, theme edits). */
export interface LegacyContradiction {
  kind: ComponentKind;
  /** The legacy fields written in the file for that kind ("frame.style", "transitions.duration"). */
  written: string[];
  message: string;
}

/**
 * The `components` entries of a parsed template file that disagree with a legacy field written in the same file (e.g.
 * `components.layout: studio/layout-browser` next to `frame: {style: card}`): the components entry wins, so the legacy
 * field changes nothing. `value` must be structurally valid. Used by checkTemplateFile (a warning each) and by the
 * Studio's theme edits (L4.7, critique B7: a component change removes the legacy fields it now contradicts).
 */
export function legacyContradictions(value: unknown): LegacyContradiction[] {
  if (!isPlainObject(value) || !isPlainObject(value.components)) return [];
  const file = value as TemplateFile;
  const merged = mergeTemplate(nameless(), file);
  const chosen = resolveThemeComponents(merged);
  const legacy = resolveThemeComponents({ ...merged, components: undefined });
  const out: LegacyContradiction[] = [];
  for (const [kind, fields] of Object.entries(LEGACY_FIELDS) as Array<[ComponentKind, { section: string; keys: string[] }]>) {
    if (file.components?.[kind] === undefined) continue;
    const section = (value as Record<string, unknown>)[fields.section];
    const written = isPlainObject(section) ? fields.keys.filter((k) => section[k] !== undefined) : [];
    if (written.length === 0) continue;
    const a = chosen[kind];
    const b = legacy[kind];
    const same = a === null || b === null ? a === b : a.id === b.id && localeSortedJson(a.params) === localeSortedJson(b.params);
    if (same) continue;
    out.push({
      kind,
      written: written.map((k) => `${fields.section}.${k}`),
      message:
        `components.${kind} (${describeChoice(a)}) takes precedence over ${written.map((k) => `${fields.section}.${k}`).join(', ')} ` +
        `(which ${written.length > 1 ? 'map' : 'maps'} to ${describeChoice(b)}): change components.${kind}, or remove it to use ${fields.section}`,
    });
  }
  return out;
}

/**
 * Semantic check of a template file: a `components` entry that disagrees with a legacy field written in the same
 * file (e.g. `components.layout: studio/layout-browser` next to `frame: {style: card}`) is a warning — the
 * components entry wins, so editing the legacy field would change nothing.
 */
function checkTemplateFile(value: unknown, structural: readonly LocatedIssue[]): LocatedIssue[] {
  if (hasErrors(structural)) return [];
  return legacyContradictions(value).map((c) => issue('warning', ['components', c.kind], c.message));
}

/**
 * The theme's own files (L2.12, `components.intro: {video: …}`): checked like a scenario's (container, existence,
 * codec, from / to) relative to the template folder `dir` — skipped without one.
 */
function checkTemplateMedia(value: unknown, structural: readonly LocatedIssue[], dir: string | undefined, files: CheckFiles | undefined): LocatedIssue[] {
  if (!dir || !isPlainObject(value) || !isPlainObject(value.components)) return [];
  const ctx = new CheckContext(structural, dir, 'the template folder', files);
  for (const [kind, ref] of Object.entries(value.components)) {
    if (isTemplateMediaRef(ref as never)) checkMediaFields(ref, ['components', kind], ctx);
  }
  return ctx.out;
}

/**
 * Validate template.yaml text and merge it over DEFAULT_TEMPLATE. `template` is returned only
 * when there is no error-level issue. With `dir` (the template folder), the theme's own files are checked too (through
 * `files`, and its VideoProber for a video file).
 */
export function parseTemplateYaml(text: string, opts: { dir?: string; files?: CheckFiles } = {}): { template?: Template; issues: ValidationIssue[] } {
  const { value, issues } = checkYamlDocument(text, TemplateFileSchema, (v, st) => [...checkTemplateFile(v, st), ...checkTemplateMedia(v, st, opts.dir, opts.files)], {}, {
    formatVersion: { file: TEMPLATE_FILE, supported: FORMAT_VERSIONS.template },
  });
  if (hasErrors(issues)) return { issues };
  // `version` is the file's format, not part of the template merged over the defaults.
  const { version: _version, ...file } = value as TemplateFile;
  const template = mergeTemplate(nameless(), file);
  const merged = finalizeIssues(zodIssues(TemplateSchema, template));
  if (hasErrors(merged)) return { issues: [...issues, ...merged] };
  return { template, issues };
}

export interface TemplateEntry {
  name: string;
  dir: string;
  /** workspace: in the workspace's templates_dir; starter: shipped with Retake (no workspace template has its name). */
  source: 'workspace' | 'starter';
}
