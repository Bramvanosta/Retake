import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { hasErrors } from '@retake/core';
import { checkComponentEntry } from './compile.js';
import { DEFAULT_ENTRY, MANIFEST_FILE, parseManifest } from './manifest.js';
import type { ComponentIssue, ComponentManifest } from './types.js';

export interface ValidateComponentOptions {
  /** Compile-check the entry with esbuild (default true). */
  compile?: boolean;
  /**
   * The id the folder must carry (default: "<parent folder>/<folder>", the layout of workspace components and of
   * the built-in library). `false` skips the check.
   */
  folderId?: string | false;
}

export interface ComponentValidation {
  /** Absolute component directory. */
  dir: string;
  /** Parsed manifest (when component.yaml has no error). */
  manifest?: ComponentManifest;
  /** Positioned issues, component.yaml first, then the implementation files. */
  issues: ComponentIssue[];
  /** True when there is no error-level issue. */
  ok: boolean;
}

/**
 * Validate a component folder: component.yaml (strict schema, semantic checks, params JSON Schema and defaults,
 * preview samples filling the required slots, layout geometry), id = "<namespace>/<name>" of the folder, entry file
 * present, and the entry compiled with esbuild importing only react, remotion and @retake/components/kit.
 */
export async function validateComponentDir(dir: string, opts: ValidateComponentOptions = {}): Promise<ComponentValidation> {
  const abs = resolve(dir);
  const issues: ComponentIssue[] = [];
  const done = (manifest?: ComponentManifest): ComponentValidation => ({ dir: abs, manifest, issues, ok: !hasErrors(issues) });
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    issues.push({ severity: 'error', path: [], message: `component folder not found: ${abs}`, file: '.' });
    return done();
  }
  const manifestFile = resolve(abs, MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(manifestFile, 'utf8');
  } catch {
    issues.push({ severity: 'error', path: [], message: `missing ${MANIFEST_FILE} (the manifest of the component)`, file: MANIFEST_FILE });
    return done();
  }
  const folderId = opts.folderId === false ? undefined : (opts.folderId ?? `${basename(dirname(abs))}/${basename(abs)}`);
  const parsed = parseManifest(text, MANIFEST_FILE, { folderId });
  issues.push(...parsed.issues);
  const manifest = parsed.manifest;
  if (!manifest) return done();

  const entryRel = manifest.entry ?? DEFAULT_ENTRY;
  const entry = resolve(abs, entryRel);
  if (!existsSync(entry)) {
    issues.push({
      severity: 'error',
      path: text.match(/^entry\s*:/m) ? ['entry'] : [],
      message: `entry file "${entryRel}" not found in the component folder`,
      file: MANIFEST_FILE,
      ...positionOfKey(text, 'entry'),
    });
    return done(manifest);
  }
  if (opts.compile !== false) {
    const check = await checkComponentEntry(abs, entry);
    issues.push(...check.issues);
  }
  return done(manifest);
}

/** Issues of a component folder (see `validateComponentDir`). */
export async function validateComponent(dir: string, opts: ValidateComponentOptions = {}): Promise<ComponentIssue[]> {
  return (await validateComponentDir(dir, opts)).issues;
}

function positionOfKey(text: string, key: string): { line?: number; col?: number } {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  return i >= 0 ? { line: i + 1, col: 1 } : { line: 1, col: 1 };
}
