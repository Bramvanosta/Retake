/**
 * What the package entries hold: a name is in an entry because another package imports it there. The engine's main
 * entry is its façade (createEngine, its errors, the types); the values a shell calls in process are
 * `@retake/engine/shell`; the values only other packages' tests import are `@retake/engine/testing`, which no product
 * source imports. The adapters' and the Studio's roots hold what another package names. Read from the entry files'
 * text (their `export { … } from` lines), so nothing is loaded.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from '@retake/test-support/repo';

/** The names an entry file re-exports, values and types apart (`export { a, type B } from`, `export type { C } from`). */
function entryNames(file: string): { values: string[]; types: string[]; stars: string[] } {
  const text = readFileSync(join(REPO, file), 'utf8');
  const values: string[] = [];
  const types: string[] = [];
  for (const m of text.matchAll(/export\s+(type\s+)?\{([^}]*)\}\s*from/g)) {
    for (const raw of m[2].split(',')) {
      const el = raw.trim();
      if (!el) continue;
      const isType = !!m[1] || el.startsWith('type ');
      const name = el
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()!
        .trim();
      (isType ? types : values).push(name);
    }
  }
  const stars = [...text.matchAll(/export\s+(?:type\s+)?\*\s+from\s+'([^']+)'/g)].map((m) => m[1]);
  return { values, types, stars };
}

/** Every source file of packages/<pkg>/<folder>, for each package, as repository-relative path and text. */
function sources(folder: 'src' | 'test'): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'dist' && e.name !== 'fixtures') walk(p);
      } else if (/\.(ts|tsx|mts)$/.test(e.name)) out.push({ rel: relative(REPO, p), text: readFileSync(p, 'utf8') });
    }
  };
  for (const pkg of readdirSync(join(REPO, 'packages'))) {
    try {
      walk(join(REPO, 'packages', pkg, folder));
    } catch {
      // a package without that folder
    }
  }
  return out;
}

// The tests' shared helpers (packages/test-support/src) are test code.
const SRC = sources('src').filter((f) => !f.rel.startsWith('packages/test-support/'));
const TESTS = [...sources('test'), ...sources('src').filter((f) => f.rel.startsWith('packages/test-support/'))];
const pkgOf = (rel: string) => rel.split('/')[1];
/** The files outside `pkg` that name `spec` and the identifier `name` (a word). */
const namedOutside = (files: Array<{ rel: string; text: string }>, pkg: string, spec: string, name: string) =>
  files.filter((f) => pkgOf(f.rel) !== pkg && f.text.includes(`'${spec}'`) && new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(f.text)).map((f) => f.rel);

describe("the engine's entries", () => {
  it('the main entry is the façade: createEngine, its version and trust, its errors — every other value is in another entry', () => {
    const main = entryNames('packages/engine/src/index.ts');
    expect(main.values.sort()).toEqual(['ENGINE_API_VERSION', 'ENGINE_ERROR_CODES', 'EngineError', 'agentTrust', 'createEngine', 'toEngineError']);
    expect(main.stars).toEqual([]);
    // A memory adapter (a test double) is in no production entry.
    for (const file of ['index.ts', 'shell-entry.ts']) {
      const { values, types } = entryNames(`packages/engine/src/${file}`);
      expect(
        [...values, ...types].filter((n) => /^Memory|^memory/.test(n)),
        file,
      ).toEqual([]);
    }
  });

  it('@retake/engine/shell holds values a shell source imports from it, and nothing else', () => {
    const { values, types, stars } = entryNames('packages/engine/src/shell-entry.ts');
    expect(stars).toEqual([]);
    expect(types).toEqual([]);
    const shells = SRC.filter((f) => ['cli', 'mcp', 'ui'].includes(pkgOf(f.rel)));
    const unused = values.filter((n) => namedOutside(shells, 'engine', '@retake/engine/shell', n).length === 0);
    expect(unused).toEqual([]);
    // The count only goes down: a shell's new in-process value is a reason to look for an operation first.
    expect(values.length).toBeLessThanOrEqual(150);
  });

  it('@retake/engine/testing holds values other packages’ tests import from it, and no product source imports a testing entry', () => {
    const { values, types, stars } = entryNames('packages/engine/src/testing.ts');
    expect(stars).toEqual([]);
    expect(types).toEqual([]);
    const unused = values.filter((n) => namedOutside(TESTS, 'engine', '@retake/engine/testing', n).length === 0);
    expect(unused).toEqual([]);
    // No product source imports a testing entry of any package (`@retake/engine/testing`, `@retake/ui/testing`, …) —
    // the testing entries' own files excepted, which re-export the files beside them.
    const testingEntries = SRC.filter((f) => /^packages\/[a-z-]+\/src\/testing\.ts$/.test(f.rel)).map((f) => f.rel);
    expect(testingEntries.sort()).toEqual(['packages/engine/src/testing.ts', 'packages/ui/src/testing.ts']);
    expect(SRC.filter((f) => /(?:from|import\()\s*['"]@retake\/[a-z-]+\/testing['"]/.test(f.text)).map((f) => f.rel)).toEqual([]);
    expect(values.length).toBeLessThanOrEqual(64);
  });
});

describe("the adapters' and the Studio's main entries", () => {
  // Each root holds the values another package names (its sources or its tests), and its domain entry whole (every name
  // of a domain entry is on the root too); the package's own tests import from the files themselves. The components'
  // root and kit are left out: a person's components import the kit.
  const ROOTS: Array<[string, string, string, string[]]> = [
    ['runner-web', '@retake/runner-web', 'packages/runner-web/src/index.ts', ['./types-entry.js']],
    ['review', '@retake/review', 'packages/review/src/index.ts', ['./checks-entry.js']],
    ['sandbox', '@retake/sandbox', 'packages/sandbox/src/index.ts', ['./types-entry.js']],
    ['editor', '@retake/editor', 'packages/editor/src/index.ts', ['./plan-entry.js']],
    ['hooks', '@retake/hooks', 'packages/hooks/src/index.ts', ['./describe-entry.js']],
    ['ui', '@retake/ui', 'packages/ui/src/index.ts', []],
  ];
  it.each(ROOTS)('%s: every name of its root is named by another package through it', (pkg, spec, file, domain) => {
    const { values, types, stars } = entryNames(file);
    expect(stars, 'a star re-export hides what the entry holds: only its domain entry is re-exported whole').toEqual(domain);
    // The engine reaches an adapter's root through its loader (engine/src/lazy.ts: `(await editor()).planRun`), so its
    // sources count whatever specifier they name.
    const users = [...SRC, ...TESTS].filter((f) => pkgOf(f.rel) !== pkg && (f.text.includes(`'${spec}'`) || f.rel.startsWith('packages/engine/src/')));
    const unused = [...values, ...types].filter((n) => !users.some((f) => new RegExp(`\\b${n}\\b`).test(f.text)));
    expect(unused).toEqual([]);
  });
});
