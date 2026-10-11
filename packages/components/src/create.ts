import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { COMPONENT_ID_RE, COMPONENT_KINDS, errorsOf, loadWorkspaceConfig, suggestion } from '@demo-studio/core';
import type { ComponentKind } from '@demo-studio/core';
import { ComponentError, formatComponentIssues } from './errors.js';
import { MANIFEST_FILE, parseManifest } from './manifest.js';
import { COMPONENT_SCHEMA_FILE, LIBRARY_DIR, scaffoldDir } from './paths.js';
import type { ComponentInfo, ComponentIssue } from './types.js';
import { validateComponentDir } from './validate.js';

export interface CreateComponentOptions {
  /** "namespace/name" (lower-case letters, digits and "-"). */
  id: string;
  kind: ComponentKind;
  /** One or two sentences (default: a placeholder to rewrite). */
  description?: string;
  /** Display name (default: from the name part of the id, "intro-split" → "Intro split"). */
  name?: string;
  /** Override the workspace components directory (default: studio.yaml `components_dir`, else <root>/components). */
  componentsDir?: string;
  /** Built-in library checked for an id clash (default: the package library; null = none). */
  builtinDir?: string | null;
}

export interface CreatedComponent extends ComponentInfo {
  /** Absolute paths of the files written. */
  files: string[];
  /** Validation issues of the new component (warnings only; an error aborts the creation). */
  issues: ComponentIssue[];
  /** Set when the id overrides a built-in component. */
  overrides?: string;
}

/** "intro-split" → "Intro split". */
export function componentDisplayName(id: string): string {
  const name = id.split('/').pop() ?? id;
  const words = name.split('-').filter(Boolean).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function posix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Scaffold `<components>/<namespace>/<name>/` from the kind's scaffold (component.yaml + index.tsx using the kit +
 * README.md) and validate it (schema, entry compile). Throws ComponentError on a bad id/kind, an existing folder, or
 * a scaffold that does not validate.
 */
export async function createComponent(root: string, opts: CreateComponentOptions): Promise<CreatedComponent> {
  const { id, kind } = opts;
  if (!COMPONENT_ID_RE.test(id)) {
    throw new ComponentError(`invalid component id "${id}": use "namespace/name" with lower-case letters, digits and "-" (e.g. acme/intro-split)`);
  }
  if (!(COMPONENT_KINDS as readonly string[]).includes(kind)) {
    throw new ComponentError(`unknown component kind "${kind}"${suggestion(kind, COMPONENT_KINDS)} (kinds: ${COMPONENT_KINDS.join(', ')})`);
  }
  const componentsDir = opts.componentsDir ? resolve(opts.componentsDir) : (await loadWorkspaceConfig(root)).componentsDir;
  const [ns, name] = id.split('/');
  const dir = join(componentsDir, ns, name);
  if (existsSync(dir)) throw new ComponentError(`${dir} already exists: pick another id or edit that component`);

  const source = scaffoldDir(kind);
  const builtinDir = opts.builtinDir === null ? undefined : resolve(opts.builtinDir ?? LIBRARY_DIR);
  const overrides = builtinDir && existsSync(join(builtinDir, ns, name, MANIFEST_FILE)) ? join(builtinDir, ns, name) : undefined;

  // component.yaml: the scaffold's, with id/name/description replaced (comments kept) and the schema path rewritten.
  const yamlText = await readFile(join(source, MANIFEST_FILE), 'utf8');
  const doc = parseDocument(yamlText);
  doc.set('id', id);
  doc.set('name', opts.name ?? componentDisplayName(id));
  doc.set('description', opts.description?.trim() || `TODO: describe what this ${kind} looks like and when to use it.`);
  const schemaRel = posix(relative(dir, COMPONENT_SCHEMA_FILE));
  const manifestText = String(doc).replace(/^# yaml-language-server: \$schema=.*$/m, `# yaml-language-server: $schema=${schemaRel}`);
  const check = parseManifest(manifestText, MANIFEST_FILE, { folderId: id });
  if (errorsOf(check.issues).length > 0) {
    throw new ComponentError(`the ${kind} scaffold is invalid with id ${id}:\n${formatComponentIssues(check.issues)}`, check.issues);
  }

  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  const write = async (file: string, text: string) => {
    const p = join(dir, file);
    await writeFile(p, text, 'utf8');
    files.push(p);
  };
  await write(MANIFEST_FILE, manifestText);
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || entry.name === MANIFEST_FILE || entry.name === 'README.md') continue;
    await write(entry.name, await readFile(join(source, entry.name), 'utf8'));
  }
  await write('README.md', readme(id, kind, opts.description));

  const validation = await validateComponentDir(dir);
  if (!validation.ok || !validation.manifest) {
    throw new ComponentError(
      `the new component ${id} does not validate (scaffold bug):\n${formatComponentIssues(validation.issues, dir)}`,
      validation.issues,
      dir,
    );
  }
  const out: CreatedComponent = {
    manifest: validation.manifest,
    dir,
    entry: resolve(dir, validation.manifest.entry ?? 'index.tsx'),
    source: 'workspace',
    files,
    issues: validation.issues,
  };
  if (overrides) out.overrides = overrides;
  return out;
}

function readme(id: string, kind: ComponentKind, description?: string): string {
  return `# ${id}

${description?.trim() || `A ${kind} component.`}

- \`component.yaml\` — the manifest: slots, params (JSON Schema with defaults), duration${kind === 'layout' ? ', geometry' : ''}, preview samples.
- \`index.tsx\` — the implementation: \`export default function (props: ComponentProps)\`. Read every colour, font and
  logo from \`props.theme\`, size everything with \`props.unit\`, animate from \`useCurrentFrame()\` only, and import only
  \`react\`, \`remotion\` and \`@demo-studio/components/kit\`.

Check it with \`studio components validate ${id}\`. Use it from a template (\`components: {${kind}: ${id}}\`) or a
scenario (see the README of Demo Studio, section "Components").
`;
}
