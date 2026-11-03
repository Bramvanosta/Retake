import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComponentKind } from '@retake/core';

/** packages/components (this module lives in src/ or dist/, one level below). */
export const PACKAGE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Built-in library: `library/<namespace>/<name>/component.yaml`. */
export const LIBRARY_DIR = join(PACKAGE_DIR, 'library');

/** Per-kind scaffolds used by `createComponent` (and as stand-ins by the render pipeline). */
export const SCAFFOLDS_DIR = join(PACKAGE_DIR, 'scaffolds');

/** JSON Schema of component.yaml (editor autocompletion). */
export const COMPONENT_SCHEMA_FILE = join(PACKAGE_DIR, 'schema', 'component.schema.json');

/**
 * The kit API this Retake provides (L4.5, the guard-rail "engines / kit-API version"): a component declares the
 * major it was written for in `engines.kit` ("1" or "^1"; absent = 1); a component that needs another one is not
 * loaded (a registry notice; its uses fall back with a warning, else render as `missing`).
 */
export const KIT_API_VERSION = 1;

/** The module components import shared helpers from. */
export const KIT_MODULE = '@retake/components/kit';

/** Source of the kit (bundled when a component entry is compile-checked); the built kit when sources are absent. */
export function kitEntry(): string | undefined {
  for (const p of [join(PACKAGE_DIR, 'src', 'kit', 'index.ts'), join(PACKAGE_DIR, 'dist', 'kit', 'index.js')]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** The scaffold folder of a kind (a valid component with id `scaffolds/<kind>`). */
export function scaffoldDir(kind: ComponentKind): string {
  return join(SCAFFOLDS_DIR, kind);
}
