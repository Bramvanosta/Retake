/**
 * Compile check of a component implementation with esbuild (bundled in memory, JSX automatic runtime).
 *
 * A component may import only `react`, `remotion` and `@demo-studio/components/kit` (plus its own files inside its
 * folder). The kit is bundled from source, and `react` / `remotion` are replaced by stubs listing their real exports,
 * so a misspelt import (`useCurrentFrme`) is an error too. Sources are also scanned for non-deterministic or
 * networked APIs (Math.random, Date.now, fetch…): a component must render the same frame the same way every time.
 */
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import type { Message, Plugin } from 'esbuild';
import { didYouMean } from '@demo-studio/core';
import { KIT_MODULE, kitEntry } from './paths.js';
import type { ComponentIssue } from './types.js';

/** Bare imports a component may use. */
export const ALLOWED_IMPORTS = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'remotion', KIT_MODULE] as const;

/** Local files a component may import (inside its folder). */
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json']);

const STUB_NS = 'demo-studio-stub';
/** Packages the kit itself may use (left out of the compile check of a component). */
const KIT_EXTERNALS = ['@remotion/lottie', 'lottie-web'] as const;
const STUBBED = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'remotion'] as const;
const IDENT = /^[A-Za-z_$][\w$]*$/;

let stubCache: Promise<Map<string, string[] | null>> | undefined;

/** Export names of the real react / remotion modules (null when a module cannot be loaded here). */
function moduleExports(): Promise<Map<string, string[] | null>> {
  stubCache ??= (async () => {
    const out = new Map<string, string[] | null>();
    for (const name of STUBBED) {
      try {
        const mod = (await import(name)) as Record<string, unknown>;
        out.set(name, Object.keys(mod).filter((k) => k !== 'default' && IDENT.test(k)).sort());
      } catch {
        out.set(name, null);
      }
    }
    return out;
  })();
  return stubCache;
}

function stubSource(names: readonly string[]): string {
  return ['export default {};', ...names.map((n) => `export const ${n} = undefined;`)].join('\n');
}

/** The path with symbolic links resolved, as esbuild reports it (macOS: /var → /private/var); unchanged when missing. */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isInside(file: string, dir: string): boolean {
  const rel = relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Blank out comments, keeping line/column positions (strings are kept: a URL in a string is not a comment). */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && n === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < src.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface ForbiddenApi {
  re: RegExp;
  severity: 'error' | 'warning';
  message: string;
}

/** APIs that make a frame depend on something else than (props, frame). */
export const FORBIDDEN_APIS: readonly ForbiddenApi[] = [
  { re: /\bMath\.random\s*\(/g, severity: 'error', message: 'Math.random() is not deterministic: use random(seed) from the kit' },
  // the kit's (remotion's) random: null is Math.random(), and no seed throws at render time
  { re: /(?<![\w$.])random\s*\(\s*(?:null|undefined)?\s*\)/g, severity: 'error', message: 'random() needs a seed: random(null) is Math.random(); pass a number or a string' },
  { re: /\bDate\.now\s*\(/g, severity: 'error', message: 'Date.now() is not deterministic: derive time from useCurrentFrame() / fps' },
  { re: /\bnew\s+Date\s*\(\s*\)/g, severity: 'error', message: 'new Date() is not deterministic: derive time from useCurrentFrame() / fps' },
  { re: /\bperformance\.now\s*\(/g, severity: 'error', message: 'performance.now() is not deterministic: derive time from useCurrentFrame() / fps' },
  { re: /\bfetch\s*\(/g, severity: 'error', message: 'components must not use the network (fetch): take data from slots, params and the theme' },
  { re: /\bXMLHttpRequest\b/g, severity: 'error', message: 'components must not use the network (XMLHttpRequest)' },
  { re: /\bWebSocket\b/g, severity: 'error', message: 'components must not use the network (WebSocket)' },
  { re: /\bEventSource\b/g, severity: 'error', message: 'components must not use the network (EventSource)' },
  { re: /\bsendBeacon\s*\(/g, severity: 'error', message: 'components must not use the network (sendBeacon)' },
  {
    re: /\b(?:setTimeout|setInterval|requestAnimationFrame)\s*\(/g,
    severity: 'warning',
    message: 'timers do not follow the rendered frame: animate from useCurrentFrame() instead',
  },
];

/** Positioned issues for forbidden APIs in one source file. */
export function scanSource(src: string, file: string): ComponentIssue[] {
  const text = stripComments(src);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const pos = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - lineStarts[lo] + 1 };
  };
  const out: ComponentIssue[] = [];
  for (const api of FORBIDDEN_APIS) {
    api.re.lastIndex = 0;
    for (let m = api.re.exec(text); m; m = api.re.exec(text)) {
      out.push({ severity: api.severity, path: [], message: api.message, file, ...pos(m.index) });
    }
  }
  return out.sort((a, b) => a.line! - b.line! || a.col! - b.col!);
}

/** Why a component may not import `spec` (from a file in `resolveDir`), or undefined when it may. */
export function importProblem(spec: string, resolveDir: string, componentDir: string): string | undefined {
  if (spec.startsWith('.') || isAbsolute(spec)) {
    const target = resolve(resolveDir, spec);
    if (!isInside(target, componentDir)) {
      return `import "${spec}" leaves the component folder: a component may only import its own files, react, remotion and ${KIT_MODULE}`;
    }
    const ext = extname(target);
    if (ext && !CODE_EXTENSIONS.has(ext)) {
      return `import "${spec}": only code files can be imported (pass images and fonts through slots and the theme)`;
    }
    return undefined;
  }
  if ((ALLOWED_IMPORTS as readonly string[]).includes(spec)) return undefined;
  const s = didYouMean(spec, ALLOWED_IMPORTS);
  return `import "${spec}" is not allowed${s ? ` (did you mean "${s}"?)` : ''}: a component may import only react, remotion and ${KIT_MODULE}`;
}

const IMPORT_PATTERNS: readonly RegExp[] = [
  // import x from 'm' / import {a} from 'm' / export {a} from 'm' / export * from 'm' (type-only forms are skipped)
  /\b(?:import|export)\s+(?!type\b)[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1/g,
  // import 'm'
  /\bimport\s*(['"])([^'"\n]+)\1/g,
  // import('m') / require('m')
  /\b(?:import|require)\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];

/**
 * Import problems found by reading the source (TypeScript drops unused imports before bundling, so the bundler alone
 * would not see an unused `import fs from 'node:fs'`). Positioned at the module specifier.
 */
export function scanImports(src: string, file: string, resolveDir: string, componentDir: string): ComponentIssue[] {
  const text = stripComments(src);
  const out: ComponentIssue[] = [];
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const problem = importProblem(m[2], resolveDir, componentDir);
      if (!problem) continue;
      const offset = m.index + m[0].lastIndexOf(m[1] + m[2]);
      out.push({ severity: 'error', path: [], message: problem, file, ...lineCol(text, offset) });
    }
  }
  return out;
}

function lineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      last = i;
    }
  }
  return { line, col: offset - last };
}

export interface EntryCheck {
  issues: ComponentIssue[];
  /** Bare modules the component imports (react, remotion, the kit…), sorted. */
  imports: string[];
  /** Files of the component folder that were compiled, relative to it. */
  files: string[];
}

function sortIssues(issues: ComponentIssue[]): ComponentIssue[] {
  return issues
    .map((issue, i) => ({ issue, i }))
    .sort(
      (a, b) =>
        a.issue.file.localeCompare(b.issue.file) ||
        (a.issue.line ?? Infinity) - (b.issue.line ?? Infinity) ||
        (a.issue.col ?? 0) - (b.issue.col ?? 0) ||
        a.i - b.i,
    )
    .map((x) => x.issue);
}

function displayFile(file: string, dir: string): string {
  const abs = isAbsolute(file) ? file : resolve(dir, file);
  if (isInside(abs, dir)) return relative(dir, abs).split(sep).join('/');
  return file;
}

let kitExportsCache: Promise<string[]> | undefined;

/** Export names of the kit (esbuild metafile of the kit entry; [] when unavailable). */
export function kitExports(): Promise<string[]> {
  kitExportsCache ??= (async () => {
    const kit = kitEntry();
    if (!kit) return [];
    try {
      const r = await build({
        entryPoints: [kit],
        bundle: true,
        write: false,
        metafile: true,
        format: 'esm',
        platform: 'browser',
        jsx: 'automatic',
        logLevel: 'silent',
        outdir: 'out',
        external: ['react', 'react/*', 'remotion', ...KIT_EXTERNALS],
      });
      return Object.values(r.metafile.outputs).flatMap((o) => o.exports ?? []).sort();
    } catch {
      return [];
    }
  })();
  return kitExportsCache;
}

/** esbuild's "No matching export" message, in the user's terms (module name + did you mean). */
function exportHint(text: string, absDir: string, exportsOf: Map<string, string[] | null>, kit: string | undefined, kitNames: readonly string[]): string {
  const m = /No matching export in "([^"]+)" for import "([^"]+)"/.exec(text);
  if (!m) return text;
  const [, where, name] = m;
  let mod: string;
  let names: readonly string[];
  if (where.startsWith(`${STUB_NS}:`)) {
    mod = where.slice(STUB_NS.length + 1);
    names = exportsOf.get(mod) ?? [];
  } else if (kit && resolve(absDir, where) === kit) {
    mod = KIT_MODULE;
    names = kitNames;
  } else {
    mod = displayFile(where, absDir);
    names = [];
  }
  // Among equally close names, prefer the one whose initial has the same case (fitTxt → fitText, not FitText).
  const upper = (x: string) => x.charAt(0) === x.charAt(0).toUpperCase();
  const ordered = [...names].sort((a, b) => Number(upper(a) !== upper(name)) - Number(upper(b) !== upper(name)));
  const s = didYouMean(name, ordered);
  return `"${mod}" has no export named "${name}"${s ? ` (did you mean "${s}"?)` : ''}`;
}

/**
 * Bundle `entry` (absolute, inside `dir`) in memory with esbuild and report: syntax/type-stripping errors, imports
 * other than react / remotion / the kit (or files outside the folder), missing named exports, and forbidden APIs.
 */
export async function checkComponentEntry(dir: string, entry: string): Promise<EntryCheck> {
  // Real paths throughout: esbuild resolves symbolic links in importers and resolve dirs.
  const absDir = realPath(resolve(dir));
  const rawEntry = resolve(resolve(dir), entry);
  const absEntry = realPath(join(realPath(dirname(rawEntry)), basename(rawEntry)));
  const exportsOf = await moduleExports();
  const kitFile = kitEntry();
  const kit = kitFile && realPath(kitFile);
  const kitNames = await kitExports();
  const kitDir = kit ? resolve(kit, '..') : undefined;
  const imports = new Set<string>();
  const seen: Array<{ importer: string; problem: string }> = [];
  const plugin: Plugin = {
    name: 'demo-studio-component-imports',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return undefined;
        const fromKit = kitDir !== undefined && isInside(args.importer, kitDir);
        const p = args.path;
        if (fromKit) {
          if (p.startsWith('.') || isAbsolute(p)) return undefined;
          if ((KIT_EXTERNALS as readonly string[]).includes(p)) return { path: p, external: true };
        } else {
          const problem = importProblem(p, args.resolveDir, absDir);
          if (problem) {
            // Reported by `scanImports` (positioned); kept external so that linking still reports missing exports.
            seen.push({ importer: args.importer, problem });
            return { path: p, external: true };
          }
          if (p.startsWith('.') || isAbsolute(p)) return undefined;
          imports.add(p);
        }
        if ((STUBBED as readonly string[]).includes(p)) {
          const names = exportsOf.get(p);
          if (names === null || names === undefined) return { path: p, external: true };
          return { path: p, namespace: STUB_NS };
        }
        if (p === KIT_MODULE) return kit ? { path: kit } : { path: p, external: true };
        return { errors: [{ text: `the kit imports "${p}", which components cannot use` }] };
      });
      b.onLoad({ filter: /.*/, namespace: STUB_NS }, (args) => ({
        contents: stubSource(exportsOf.get(args.path) ?? []),
        loader: 'js',
      }));
    },
  };

  const issues: ComponentIssue[] = [];
  const toIssue = (m: Message, severity: 'error' | 'warning'): ComponentIssue => {
    const loc = m.location;
    const file = loc ? displayFile(loc.file, absDir) : displayFile(absEntry, absDir);
    const out: ComponentIssue = { severity, path: [], message: exportHint(m.text, absDir, exportsOf, kit, kitNames), file };
    if (loc) {
      out.line = loc.line;
      out.col = loc.column + 1;
    }
    return out;
  };

  let inputs: string[] = [];
  try {
    const result = await build({
      entryPoints: [absEntry],
      absWorkingDir: absDir,
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      logLevel: 'silent',
      plugins: [plugin],
    });
    for (const w of result.warnings) issues.push(toIssue(w, 'warning'));
    inputs = Object.keys(result.metafile.inputs);
  } catch (e) {
    const failure = e as { errors?: Message[]; warnings?: Message[] };
    if (!Array.isArray(failure.errors)) throw e;
    for (const m of failure.errors) issues.push(toIssue(m, 'error'));
    for (const m of failure.warnings ?? []) issues.push(toIssue(m, 'warning'));
  }

  // Determinism / network scan of the component's own sources (the entry even when the bundle failed).
  const own = new Set<string>([absEntry]);
  for (const input of inputs) {
    if (input.startsWith(`${STUB_NS}:`)) continue;
    const abs = resolve(absDir, input);
    if (isInside(abs, absDir)) own.add(abs);
  }
  const files: string[] = [];
  for (const abs of [...own].sort()) {
    const rel = displayFile(abs, absDir);
    files.push(rel);
    let src: string;
    try {
      src = await readFile(abs, 'utf8');
    } catch {
      continue;
    }
    issues.push(...scanSource(src, rel));
    for (const i of scanImports(src, rel, dirname(abs), absDir)) {
      // The bundler reports the imports it saw at the same line: keep one issue per (file, line, message).
      if (!issues.some((x) => x.file === i.file && x.line === i.line && x.message === i.message)) issues.push(i);
    }
  }
  for (const { importer, problem } of seen) {
    const file = displayFile(importer, absDir);
    if (!issues.some((x) => x.file === file && x.message === problem)) issues.push({ severity: 'error', path: [], message: problem, file });
  }
  return { issues: sortIssues(issues), imports: [...imports].sort(), files };
}
