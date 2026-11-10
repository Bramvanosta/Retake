/**
 * `@retake/review/checks`, the review without a file, a process or a renderer: every module it reaches (relative
 * imports, value and type, read from the sources) is one of the review's pure modules and imports no Node module and no
 * image or renderer package; the packages it reaches are the three domain entries listed here (a new one is a
 * decision, not a drift). The package root re-exports all of it. At run time (the built entry imported by a Node
 * process tracing every module it resolves) it loads no process, image or renderer module, none of the review's I/O
 * side, and the components only through their geometry entry.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as root from '@retake/review';
import * as entry from '@retake/review/checks';
// @ts-expect-error — a plain .mjs script without types
import * as rules from '../../../scripts/audit/lib.mjs';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const ENTRY = join(SRC, 'checks-entry.ts');
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');

/**
 * The review's pure modules: what the entry may reach. The ratchet's own list (scripts/audit/lib.mjs REVIEW_PURE, which
 * R7 and R12 hold file by file), not a copy: a module the walk accepts is a module those rules read.
 */
const PURE = (rules.REVIEW_PURE as string[]).map((n) => `${n}.ts`).sort();
/** The review's side that reads files, runs ffmpeg or draws images: never reached. */
const IO_SIDE = ['index.ts', 'pixels.ts', 'ffmpeg.ts', 'fonts.ts', 'report.ts', 'review.ts', 'load.ts', 'sheets.ts', 'still.ts', 'thumbs.ts'];
/** The packages the entry's modules import (each is a domain entry: pure). */
const PACKAGES = ['@retake/components/geometry', '@retake/core', '@retake/editor/plan'];

/** The value imports and re-exports of a module (type-only ones load nothing at run time). */
function valueSpecifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const c = st.importClause;
      const typeOnly = !!c && (c.isTypeOnly || (!c.name && !!c.namedBindings && ts.isNamedImports(c.namedBindings) && c.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) out.push((st.moduleSpecifier as import('typescript').StringLiteral).text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && !st.isTypeOnly) {
      out.push((st.moduleSpecifier as import('typescript').StringLiteral).text);
    }
  }
  return out;
}

/**
 * Every specifier of a module, type imports, `import()` and `require()` included: the ratchet's reader (the compiler's
 * pre-processor plus the declarations it does not list — `export * as ns from`).
 */
const allSpecifiers = (file: string): string[] => rules.specifiersOf(ts, file, readFileSync(file, 'utf8')) as string[];

/** The review modules reachable from `start` through the specifiers `of` reads, with every specifier each one names. */
function walk(start: string, of: (file: string) => string[]): { files: string[]; specs: Map<string, string[]> } {
  const seen = new Set<string>();
  const specs = new Map<string, string[]>();
  const queue = [start];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    specs.set(relative(SRC, file).split('\\').join('/'), allSpecifiers(file));
    for (const s of of(file)) {
      if (!s.startsWith('.')) continue;
      const base = resolve(dirname(file), s.replace(/\.js$/, ''));
      const found = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((f) => existsSync(f));
      if (!found) throw new Error(`${relative(SRC, file)}: cannot find ${s}`);
      queue.push(found);
    }
  }
  return { files: [...seen].map((f) => relative(SRC, f).split('\\').join('/')).sort(), specs };
}

describe('@retake/review/checks (the pure entry)', () => {
  // What loads at run time, and what the compiler reads (type imports too): both stay inside the pure modules.
  const values = walk(ENTRY, valueSpecifiers);
  const all = walk(ENTRY, allSpecifiers);

  it('reaches the checks and their maths, and nothing that reads a file or runs a process', () => {
    for (const f of ['checks.ts', 'pixel-checks.ts', 'pixel-maths.ts', 'spans.ts', 'timeline.ts', 'diff.ts', 'anchor.ts', 'types.ts']) expect(values.files, f).toContain(f);
    expect(PURE.length).toBeGreaterThan(8);
    expect(values.files).toEqual(PURE);
    expect(all.files).toEqual(PURE);
    for (const f of IO_SIDE) {
      expect(existsSync(join(SRC, f)), f).toBe(true);
      expect(all.files, f).not.toContain(f);
    }
  });

  it('imports no Node module, no renderer, and only the packages it is meant to', () => {
    const packages = new Set<string>();
    const node: string[] = [];
    for (const [file, list] of all.specs) {
      for (const s of list) {
        if (s.startsWith('.')) continue;
        packages.add(s);
        if (s.startsWith('node:') || createRequire(import.meta.url)('node:module').isBuiltin(s)) node.push(`${file} → ${s}`);
      }
    }
    expect(node).toEqual([]);
    expect([...packages].sort()).toEqual(PACKAGES);
    // No loader that could reach a module unseen.
    for (const f of all.files) expect(readFileSync(join(SRC, f), 'utf8'), f).not.toMatch(/\bcreateRequire\b|\bgetBuiltinModule\b|\bimport\(|\brequire\(/);
  });

  it('is re-exported by the package root, value for value', () => {
    const names = Object.keys(entry);
    expect(names.length).toBeGreaterThan(50);
    for (const n of names) expect((root as Record<string, unknown>)[n], n).toBe((entry as Record<string, unknown>)[n]);
    for (const n of ['checkCaptions', 'checkPixels', 'regionStats', 'compareSignatures', 'bbox', 'frameAnchor', 'diffRecords', 'buildOutputTimeline', 'segmentSpans', 'fitCaption']) expect(n in entry, n).toBe(true);
    for (const n of ['readImage', 'reviewRender', 'extractFrames', 'fontFileMeasurer', 'reportMarkdown', 'extractStill']) {
      expect(n in root, n).toBe(true);
      expect(n in entry, n).toBe(false);
    }
  });
});

/** A resolved module of an image or renderer package (its own folder under node_modules, pnpm's store included). */
const HEAVY_URL = /\/node_modules\/(react|react-dom|remotion|@remotion\/[^/]+|esbuild|sharp|playwright|playwright-core)\//;
/**
 * The Node modules the entry loads today, measured: paths, addresses and hashes, no file, process or network use
 * (node:net is core's address helpers, which parse strings: R1's PURE_BINDINGS). An allow-list: one more is a decision.
 */
const NODE_LOADED = ['node:crypto', 'node:net', 'node:path', 'node:url', 'node:util'];
/** A specifier of a process, file, image or renderer module. */
const HEAVY_SPEC = /^(node:)?(child_process|fs|fs\/promises|worker_threads|http|https)$|^(react|react-dom|remotion|@remotion\/|esbuild|sharp|playwright|playwright-core)(\/|$)/;

/**
 * Every module a fresh Node process resolves while it imports `file`, as [specifier, url] (a resolve hook registered
 * before the import appends each one to a file).
 */
function loadTrace(file: string): Array<[string, string]> {
  const dir = mkdtempSync(join(tmpdir(), 'retake-checks-trace-'));
  try {
    const out = join(dir, 'trace.jsonl');
    const hooks = [
      "import { appendFileSync } from 'node:fs';",
      'let out;',
      'export function initialize(data) { out = data.out; }',
      'export async function resolve(spec, context, next) {',
      '  const r = await next(spec, context);',
      "  appendFileSync(out, JSON.stringify([spec, r.url]) + '\\n');",
      '  return r;',
      '}',
    ].join('\n');
    const main = [
      "import { register } from 'node:module';",
      "import { pathToFileURL } from 'node:url';",
      `register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)}, { data: { out: ${JSON.stringify(out)} } });`,
      `await import(pathToFileURL(${JSON.stringify(file)}).href);`,
    ].join('\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', main], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as [string, string]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('@retake/review/checks at run time (the built entry, every module it loads traced)', () => {
  const built = fileURLToPath(new URL('../dist/checks-entry.js', import.meta.url));

  it('loads no process, image or renderer module at run time, and the components only through their geometry entry', () => {
    expect(existsSync(built), 'packages/review/dist/checks-entry.js is missing: run pnpm build first').toBe(true);
    const trace = loadTrace(built);
    const urls = trace.map(([, url]) => url);
    // The trace works: it saw the entry's own modules and the components' geometry entry.
    expect(urls.some((u) => u.endsWith('/review/dist/checks.js'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/review/dist/pixel-maths.js'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/components/dist/geometry-entry.js'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/editor/dist/plan-entry.js'))).toBe(true);
    const bad = trace.filter(([spec, url]) => HEAVY_SPEC.test(spec) || HEAVY_URL.test(url)).map(([spec, url]) => `${spec} → ${url}`);
    expect(bad).toEqual([]);
    // Node's own modules: the listed ones, each still loaded (a stale name leaves the list).
    const isBuiltin = (createRequire(import.meta.url)('node:module') as typeof import('node:module')).isBuiltin;
    const node = [...new Set(trace.filter(([spec, url]) => url.startsWith('node:') || isBuiltin(spec)).map(([, url]) => url))].sort();
    expect(node).toEqual(NODE_LOADED);
    expect(urls.filter((u) => /\/review\/dist\/(index|pixels|ffmpeg|fonts|review|load|sheets|still|thumbs|report)\.js$/.test(u))).toEqual([]);
    expect(urls.filter((u) => /\/components\/dist\/(index|kit\/index|compile|registry)\.js$/.test(u))).toEqual([]);
    expect(urls.filter((u) => /\/editor\/dist\/(index\.js|render\/)/.test(u))).toEqual([]);
    expect(urls.filter((u) => /\/core\/dist\/io\//.test(u))).toEqual([]);
  });
});
