/**
 * Which build of Retake a worker runs: the version plus a digest of the paths and modification times of the
 * modules it loads (the engine and the packages it runs: dist/ after `pnpm build`, src/ when run from the sources). A
 * long-lived worker compares it while idle and exits when the code changed (`pnpm build`, `git pull`), so the next job
 * runs the new code.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { RETAKE_VERSION } from '@retake/core/base';

/** The package.json of the folder of a module (its package's root: the first folder up that has one). */
function packageRoot(from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/** The @retake/* runtime dependencies declared by the package.json of `root`. */
function retakeDeps(root: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    return Object.keys(pkg.dependencies ?? {}).filter((n) => n.startsWith('@retake/'));
  } catch {
    return [];
  }
}

/**
 * The folders whose modules a worker runs: this package's own, and the resolved entry folder of every @retake/*
 * package it depends on at run time, transitively (core, hooks, runner-web, sandbox… — read from the package.json files,
 * so a new dependency is covered without a list to maintain).
 */
export function buildDirs(): string[] {
  const own = dirname(dirname(fileURLToPath(import.meta.url))); // …/engine/dist or …/engine/src
  const dirs = [own];
  const seen = new Set<string>();
  const queue: Array<{ name: string; from: string }> = [];
  const enqueue = (root: string | undefined, from: string) => {
    if (root) for (const name of retakeDeps(root)) if (!seen.has(name)) seen.add(name), queue.push({ name, from });
  };
  enqueue(packageRoot(own), import.meta.url);
  while (queue.length) {
    const { name, from } = queue.shift()!;
    let entryDir: string;
    try {
      entryDir = dirname(createRequire(from).resolve(name));
    } catch {
      continue; /* not resolvable from here (a bundler): the version still counts */
    }
    dirs.push(entryDir);
    const root = packageRoot(entryDir);
    enqueue(root, root ? join(root, 'package.json') : from);
  }
  return dirs;
}

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(p, out);
    } else if (/\.(m?js|ts|tsx|json)$/.test(e.name) && !e.name.endsWith('.tsbuildinfo')) {
      try {
        out.push(`${p}:${statSync(p).mtimeMs}`);
      } catch {
        /* removed meanwhile */
      }
    }
  }
}

/** A short digest of the code a worker runs (12 hex characters). */
export function buildStamp(dirs: readonly string[] = buildDirs()): string {
  const lines: string[] = [RETAKE_VERSION];
  for (const d of dirs) walk(d, lines);
  lines.sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12);
}
