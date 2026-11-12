import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyProjectDefaults } from '@retake/core';
import { loadProject, planNewProject } from '@retake/core/io';
import type { Confinement, CreateProjectInput, LoadedProject, ProjectConfig, ValidationIssue } from '@retake/core';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The Studio's confinement as the engine hands it down (engine caller.ts `CONFINEMENTS.studio`; engine test
 * caller.test.ts holds the two equal): the words of a refusal of work from the Studio, for tests of core and the
 * adapters, which do not import the engine.
 */
export const STUDIO_CONFINEMENT: Confinement = Object.freeze({ words: 'from the Studio', approval: ' and the Studio cannot approve hooks yet — run it in a terminal' });

/** The example scenario of docs/SPEC.md §6 (copied verbatim). */
export const SPEC_EXAMPLE = readFileSync(join(here, 'fixtures', 'catalogue.yaml'), 'utf8');

/** The hook files the SPEC example references (missing hook files are errors when a project is known). */
export const SPEC_HOOK_FILES: Record<string, string> = {
  'hooks/remove-registry-refs.sql': "DELETE FROM registry_refs WHERE product_slug = 'finca-quenaro';\n",
  'hooks/restore-registry-refs.sql': "INSERT INTO registry_refs (product_slug, ref) VALUES ('finca-quenaro', 'GCR-26-0412');\n",
};

/** A project directory (created once, synchronously) holding the SPEC example's hook files. */
export function specProjectDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'retake-spec-')), 'projects', 'northfield');
  for (const [rel, content] of Object.entries(SPEC_HOOK_FILES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

export const STAGING = {
  staging: {
    console: 'https://console.staging.example.com',
    shop: 'https://shop.staging.example.com',
  },
};

/** An in-memory project (its dir may not exist: file checks then report missing files). */
export function fakeProject(dir = '/nonexistent/northfield', extra: Partial<ProjectConfig> = {}): LoadedProject {
  return {
    slug: 'northfield',
    dir,
    root: dirname(dirname(dir)),
    file: join(dir, 'project.yaml'),
    readme: null,
    scenarios: [],
    config: applyProjectDefaults({ name: 'Northfield', environments: STAGING, ...extra }),
  };
}

export async function tempDir(prefix = 'retake-core-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

export const errors = (issues: ValidationIssue[]) => issues.filter((i) => i.severity === 'error');
export const warnings = (issues: ValidationIssue[]) => issues.filter((i) => i.severity === 'warning');

/** 1-based line of the first line containing `needle` in `text`. */
export function lineOf(text: string, needle: string, occurrence = 1): number {
  const lines = text.split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle) && ++seen === occurrence) return i + 1;
  }
  throw new Error(`"${needle}" not found`);
}

/** 1-based column of `needle` on its line. */
export function colOf(text: string, needle: string, occurrence = 1): number {
  const line = text.split('\n')[lineOf(text, needle, occurrence) - 1];
  return line.indexOf(needle) + 1;
}

/** A new project written as the engine's store would (core plans it, writes nothing): its plan's files, then loaded. */
export async function createProject(root: string, input: CreateProjectInput): Promise<LoadedProject> {
  const plan = await planNewProject(root, input);
  for (const f of plan.files) {
    await mkdir(dirname(join(plan.dir, f.ref)), { recursive: true });
    await writeFile(join(plan.dir, f.ref), f.text, { flag: 'wx' });
  }
  return loadProject(plan.dir, plan.wsRoot);
}
