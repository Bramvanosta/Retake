/**
 * `template_update` (R-FLD-42): a theme this tool made through MCP, that nobody changed since, re-made with only the
 * inputs a patch names changed. Guard = the replace guard through MCP (create.ts replaceProblem with `update`): made
 * through MCP (`made_via` mcp — never a theme a person made with `retake theme create` or in the Studio, nor one whose
 * provenance predates `made_via`), every file as written, none added, and the inputs it merges from as written
 * (`inputs_sha256`). The patch is merged over those inputs (core mergeBrandPatch), the result checked as a whole by the
 * MCP brand schema, then the create pipeline runs with `replace` — the files the patch does not name taken from the
 * theme's own copies (read again here and hash-checked: the guard's read and this one are two reads), never from
 * their original references (a pruned site candidate, a moved brand file), and the base theme's licences from the
 * theme's own LICENSES.md when its base fonts are its own copies. No serialisation key (MCP operations declare none,
 * R-ARCH-29): the store's createFolder rechecks the guard before the swap, as for create.
 */
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { BrandPatchSchema, changedBrandKeys, mergeBrandPatch } from '@retake/core/theme';
import type { BrandPatch } from '@retake/core/theme';
import { EngineError } from '../errors.js';
import { sha256Hex } from '../storage.js';
import { checkNewThemeName } from '../templates.js';
import { openProjectBySlug } from '../projects.js';
import { checkProjectSlug } from '../refs.js';
import { projectThemeTarget, workspaceThemeTarget } from '../theme-target.js';
import type { ThemeTarget } from '../theme-target.js';
import type { OpenedWorkspace } from '../workspace.js';
import { checkedProvenance, createThemeFromBrand, readThemeFile } from './create.js';
import type { ThemeCreateOptions, ThemeCreated, ThemeReuse } from './create.js';
import type { ResolvedBrandFile } from './files.js';
import type { FontsourceLicence } from './fontsource-store.js';
import { citedFontsourceLicences } from './licences.js';

function parsePatch(raw: unknown): BrandPatch {
  const parsed = BrandPatchSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EngineError('invalid', `invalid update: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}`, {
      details: { issues: parsed.error.issues.map((i) => ({ severity: 'error', path: i.path, message: i.message })) },
    });
  }
  return parsed.data;
}

/** The references a patch names again: those files are read from their reference, never from the theme's copies. */
function namedRefs(p: BrandPatch): Set<string> {
  const out = new Set<string>();
  if (p.logo !== undefined) out.add(`logo:${p.logo}`);
  if (typeof p.wordmark === 'string') out.add(`wordmark:${p.wordmark}`);
  const font = (f: unknown) => out.add(`font:${typeof f === 'string' ? f : (f as { file: string }).file}`);
  if (p.fonts?.display) font(p.fonts.display);
  for (const f of p.fonts?.body ?? []) font(f);
  return out;
}

/**
 * The base theme's LICENSES.md as a theme's own LICENSES.md cites it (licences.ts licencesMarkdown: the last section,
 * its headings one level down), or undefined when the theme's file has no such section.
 */
export function citedBaseLicences(own: string, base: string): string | undefined {
  const lines = own.split('\n');
  const at = lines.indexOf(`## Fonts of the base theme \`${base}\``);
  if (at < 0) return undefined;
  // The heading, a blank line, two lines of text, a blank line — then the base's file as it was.
  const cited = lines.slice(at + 5).map((l) => (l.startsWith('###') ? l.slice(2) : l));
  return `${cited.join('\n').trimEnd()}\n`;
}

/**
 * Where template_update finds the theme: with a project, its own `templates/<name>/` when there (else the workspace's,
 * which it hides nowhere else); without one, templates_dir.
 */
async function updateTarget(ws: OpenedWorkspace, projectSlug: string | undefined, name: string): Promise<ThemeTarget> {
  if (projectSlug === undefined) return workspaceThemeTarget(ws, 'an updated theme');
  const project = await openProjectBySlug(ws, checkProjectSlug(projectSlug));
  const own = projectThemeTarget(ws, project, 'an updated theme');
  return (await readdir(own.dir).catch(() => [] as string[])).includes(name) ? own : workspaceThemeTarget(ws, 'an updated theme');
}

/** Update a theme from a patch of its brand inputs (see the module comment). Throws EngineError: invalid, refused, not_found. */
export async function updateThemeFromBrand(ws: OpenedWorkspace, raw: unknown, o: Omit<ThemeCreateOptions, 'trust' | 'reuse'>): Promise<ThemeCreated> {
  const patch = parsePatch(raw);
  const name = checkNewThemeName(patch.name);
  // The theme's own place: the project's templates/ when the patch names a project that holds it, else templates_dir.
  const target = await updateTarget(ws, patch.project, name);
  const templatesDir = target.dir;
  let entries: string[] = [];
  try {
    entries = await readdir(templatesDir);
  } catch {
    entries = [];
  }
  if (!entries.includes(name)) {
    const other = entries.find((e) => e.toLowerCase() === name.toLowerCase());
    if (other) throw new EngineError('refused', `"${other}" exists with another case than "${name}": it is not updated`);
    throw new EngineError(
      'not_found',
      `no theme ${name} in ${target.noun}: template_update changes a theme template_create_from_brand made (template_list names the themes)${patch.project === undefined ? ` — a project's own theme is named with its project: template_update {name: "${name}", project}` : ''}`,
    );
  }
  const dir = join(templatesDir, name);
  // The guard's own record: the one it checked, never a second read.
  const checked = await checkedProvenance(dir, 'mcp', { update: true });
  if ('why' in checked) {
    throw new EngineError('refused', `theme ${name} is not updated: ${checked.why} — a person's theme is never changed through MCP. Make a new one with template_create_from_brand (another name)`);
  }
  const prov = checked.prov;
  const inputs = prov.inputs as unknown as Record<string, unknown>;
  const merged = mergeBrandPatch(inputs, patch as unknown as Record<string, unknown>);
  const changed = changedBrandKeys(inputs, merged);
  if (changed.length === 0) throw new EngineError('invalid', `nothing to change: the patch gives theme ${name} the inputs it was made from (template_list {template: "${name}"} shows them)`);

  // The theme's own copies, read again (regular files of the folder the guard listed, size-capped) and checked against
  // the record (the guard read them once already).
  const named = namedRefs(patch);
  const copies = new Map<string, { file: string; bytes: Buffer }>();
  for (const [file, source] of Object.entries(prov.sources ?? {})) {
    if (named.has(source)) continue;
    const bytes = await readThemeFile(join(dir, ...file.split('/')));
    if (!bytes || sha256Hex(bytes) !== prov.files[file]) throw new EngineError('refused', `theme ${name} is not updated: ${file} was removed or changed meanwhile`);
    copies.set(source, { file, bytes });
  }
  let baseLicences: string | undefined;
  const own = await readThemeFile(join(dir, 'LICENSES.md'));
  let fontsource: Map<string, FontsourceLicence> | undefined;
  if (own && sha256Hex(own) === prov.files['LICENSES.md']) {
    baseLicences = citedBaseLicences(own.toString('utf8'), prov.base);
    // A reused fontsource font's licence: the theme's own citation (no font store needed for a font the patch keeps).
    fontsource = citedFontsourceLicences(own.toString('utf8'));
  }
  const reuse: ThemeReuse = {
    file(ref, kind): ResolvedBrandFile | undefined {
      const c = copies.get(`${kind}:${ref}`);
      return c ? { ref, path: join(dir, ...c.file.split('/')), ext: extname(c.file).toLowerCase(), bytes: c.bytes } : undefined;
    },
    base: (source) => copies.get(source)?.bytes,
    ...(baseLicences !== undefined ? { baseLicences } : {}),
    ...(fontsource?.size ? { fontsource } : {}),
    created_at: prov.created_at,
    changed,
    ...(prov.found_in ? { foundIn: prov.found_in } : {}),
    // An input it was made from is read again where it was found (none recorded — a workspace theme, one made before
    // projects had brand files, or adopted into a project — the workspace root); a reference the patch names is new.
    placeOf: (ref) => (named.has(`logo:${ref}`) || named.has(`wordmark:${ref}`) || named.has(`font:${ref}`) ? undefined : (prov.found_in?.[ref] ?? 'workspace')),
  };
  return createThemeFromBrand(ws, { ...merged, name, replace: true }, { ...o, trust: 'mcp', reuse, target });
}
