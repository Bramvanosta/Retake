import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyProjectDefaults } from '@demo-studio/core';
import type { LoadedProject, ProjectConfig, ValidationIssue } from '@demo-studio/core';

const here = dirname(fileURLToPath(import.meta.url));

/** The example scenario of docs/SPEC.md §6 (copied verbatim). */
export const SPEC_EXAMPLE = readFileSync(join(here, 'fixtures', 'catalogue.yaml'), 'utf8');

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

export async function tempDir(prefix = 'demo-studio-core-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
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
