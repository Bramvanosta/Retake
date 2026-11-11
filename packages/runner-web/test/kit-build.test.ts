/**
 * The in-page kit is built from its modules (src/kit/page) into one page script: the modules import only each other
 * and types (no package, no Node module reaches the page), every module is part of the script, the graph has no
 * cycle, only the entry touches the page at load (every other module only declares: its top-level constants are
 * side-effect-free, but for a named few that read the environment or compute at load), and a build that would take anything from outside
 * the folder is refused.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { RunnerError } from '../src/errors.js';
import { KIT_PAGE_DIR, buildKitBundle, kitBundle, kitConfigFor, kitSource } from '../src/kit/source.js';

const MODULES = readdirSync(KIT_PAGE_DIR).filter((f) => f.endsWith('.ts')).sort();

interface ModuleInfo {
  /** Relative modules imported for their values (file names). */
  values: string[];
  /** Every import that is not a relative value import of the folder, nor `import type`. */
  foreign: string[];
  /** Top-level statements other than imports and declarations (the entry's only). */
  effects: string[];
  /** Top-level variables whose initializer may act or read the environment (not side-effect-free). */
  impure: string[];
}

/**
 * The top-level variables whose initializer is not side-effect-free by the rule (`pure`), by module, each with what it
 * does at load — all of them only read and compute: the browser's real timers and clocks (captured before a product
 * clock replaces them), the window and whether it is the top one, the configuration the page script is evaluated
 * with, the cursor's look computed from it, a set built from a module's own constant.
 */
const COMPUTED_AT_LOAD: Record<string, Record<string, string>> = {
  'clock.ts': { RT: "reads the window's timers, frames and clocks (and a product clock's saved Date)" },
  'config.ts': { config: 'reads the configuration the page script defines (source.ts kitSource)' },
  'cursor-look.ts': {
    S: 'the cursor size from the configuration (Math.max)',
    arrowSvg: "the arrow's markup (the module's svg helper)",
    handSvg: "the hand's markup (the module's svg helper)",
    ibeamSvg: "the I-beam's markup (the module's svg helper)",
  },
  'inventory.ts': { KNOWN_ROLES: "a set of roles, the implicit roles' names among them (Object.keys of roles.ts IMPLICIT)" },
  'lifecycle.ts': { w: 'the window', isTop: 'whether the window is the top one (window.top, which may throw)' },
};

/**
 * Side-effect-free at load: a literal, a regex, a function or an arrow (its body runs later), an object, array or
 * template literal of those, `new Map/Set/WeakMap/WeakSet(…)` of those, a reference to one of the module's own bindings
 * (its declarations and imports, never a global: `window`, `document`, `Math`…), a property of one, and operators over
 * them (no assignment). A call, a `new` of anything else, a global or an assignment is not.
 */
function pure(e: ts.Expression, own: Set<string>): boolean {
  const all = (list: readonly ts.Expression[]) => list.every((x) => pure(x, own));
  if (ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isBigIntLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isRegularExpressionLiteral(e)) return true;
  if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(e.kind)) return true;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
  if (ts.isIdentifier(e)) return e.text === 'undefined' || e.text === 'NaN' || e.text === 'Infinity' || own.has(e.text);
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)) return pure(e.expression, own);
  if (ts.isTemplateExpression(e)) return e.templateSpans.every((t) => pure(t.expression, own));
  if (ts.isArrayLiteralExpression(e)) return e.elements.every((x) => !ts.isSpreadElement(x) && !ts.isOmittedExpression(x) && pure(x, own));
  if (ts.isObjectLiteralExpression(e))
    return e.properties.every((p) => {
      if (p.name && ts.isComputedPropertyName(p.name) && !pure(p.name.expression, own)) return false;
      if (ts.isPropertyAssignment(p)) return pure(p.initializer, own);
      if (ts.isShorthandPropertyAssignment(p)) return own.has(p.name.text);
      return ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p);
    });
  if (ts.isNewExpression(e)) return ts.isIdentifier(e.expression) && ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(e.expression.text) && all(e.arguments ?? []);
  if (ts.isPropertyAccessExpression(e)) return pure(e.expression, own);
  if (ts.isElementAccessExpression(e)) return pure(e.expression, own) && pure(e.argumentExpression, own);
  if (ts.isConditionalExpression(e)) return all([e.condition, e.whenTrue, e.whenFalse]);
  if (ts.isPrefixUnaryExpression(e)) return [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.TildeToken].includes(e.operator) && pure(e.operand, own);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    const assigns = op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
    return !assigns && op !== ts.SyntaxKind.CommaToken && pure(e.left, own) && pure(e.right, own);
  }
  return false;
}

/** The names a module declares at its top level and imports for their values. */
function ownBindings(sf: ts.SourceFile): Set<string> {
  const own = new Set<string>();
  const bind = (n: ts.BindingName) => {
    if (ts.isIdentifier(n)) own.add(n.text);
    else for (const el of n.elements) if (!ts.isOmittedExpression(el)) bind(el.name);
  };
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && s.importClause && !s.importClause.isTypeOnly) {
      if (s.importClause.name) own.add(s.importClause.name.text);
      const nb = s.importClause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) own.add(nb.name.text);
      else if (nb) for (const el of nb.elements) if (!el.isTypeOnly) own.add(el.name.text);
    } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) own.add(s.name.text);
    // An ambient declaration (`declare const`) names what the page script's wrapper defines: not the module's own.
    else if (ts.isVariableStatement(s) && !s.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) for (const d of s.declarationList.declarations) bind(d.name);
  }
  return own;
}

function moduleInfo(file: string, text = readFileSync(join(KIT_PAGE_DIR, file), 'utf8')): ModuleInfo {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const info: ModuleInfo = { values: [], foreign: [], effects: [], impure: [] };
  const own = ownBindings(sf);
  const local = (spec: string) => /^\.\/[\w-]+\.js$/.test(spec);
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) || (ts.isExportDeclaration(s) && s.moduleSpecifier)) {
      const spec = (s.moduleSpecifier as ts.StringLiteral).text;
      const typeOnly = ts.isImportDeclaration(s) ? !!s.importClause?.isTypeOnly : s.isTypeOnly;
      if (typeOnly) continue;
      if (local(spec)) info.values.push(spec.slice(2, -3) + '.ts');
      else info.foreign.push(spec);
      continue;
    }
    if (ts.isFunctionDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) continue;
    if (ts.isVariableStatement(s)) {
      // An ambient declaration (`declare const`) has no initializer to run.
      if (s.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) continue;
      for (const d of s.declarationList.declarations) if (d.initializer && !pure(d.initializer, own)) info.impure.push(d.name.getText(sf));
      continue;
    }
    info.effects.push(s.getText(sf).split('\n')[0]);
  }
  // Nothing loads code at run time either: no import(), no require.
  (function visit(n: ts.Node) {
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) info.foreign.push(n.getText(sf));
    ts.forEachChild(n, visit);
  })(sf);
  return info;
}

const INFO = Object.fromEntries(MODULES.map((m) => [m, moduleInfo(m)]));

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

describe('the in-page kit, built from modules', () => {
  it('its modules import only each other and types: no package, no Node module', () => {
    expect(MODULES.length).toBeGreaterThan(20);
    expect(Object.fromEntries(MODULES.map((m) => [m, INFO[m].foreign]))).toEqual(Object.fromEntries(MODULES.map((m) => [m, []])));
    for (const m of MODULES) for (const v of INFO[m].values) expect(MODULES, `${m} imports ${v}`).toContain(v);
  });

  it('every module is reached from the entry, and the graph has no cycle', () => {
    const seen = new Set<string>();
    const walk = (m: string) => {
      if (seen.has(m)) return;
      seen.add(m);
      for (const v of INFO[m].values) walk(v);
    };
    walk('main.ts');
    expect([...seen].sort()).toEqual(MODULES);
    const state = new Map<string, 'open' | 'done'>();
    const cycle = (m: string, path: string[]): string[] | null => {
      if (state.get(m) === 'done') return null;
      if (state.get(m) === 'open') return [...path, m];
      state.set(m, 'open');
      for (const v of INFO[m].values) {
        const c = cycle(v, [...path, m]);
        if (c) return c;
      }
      state.set(m, 'done');
      return null;
    };
    expect(cycle('main.ts', [])).toBeNull();
  });

  it('only the entry acts at load: every other module declares only', () => {
    const acting = MODULES.filter((m) => m !== 'main.ts' && INFO[m].effects.length > 0).map((m) => `${m}: ${INFO[m].effects.join(' | ')}`);
    expect(acting).toEqual([]);
    expect(INFO['main.ts'].effects).toEqual(['install();']);
  });

  it('a top-level constant is side-effect-free, but for the named few computed at load', () => {
    // Exactly the named ones: one that became side-effect-free leaves the list too.
    const named = Object.fromEntries(Object.entries(COMPUTED_AT_LOAD).map(([m, names]) => [m, Object.keys(names)]));
    expect(Object.fromEntries(MODULES.filter((m) => INFO[m].impure.length > 0).map((m) => [m, INFO[m].impure]))).toEqual(named);
  });

  it('the side-effect-free rule refuses a call, a global, an element created or an assignment at load', () => {
    const impure = (text: string) => moduleInfo('probe.ts', text).impure;
    expect(impure("const t = setInterval(() => {}, 1000);\nconst el = document.createElement('div');\nconst w = window;\nconst x = (() => 1)();\n")).toEqual(['t', 'el', 'w', 'x']);
    expect(impure("let n = 0;\nconst m = (n = 2);\nconst o = { a: f() };\nconst s = new Set([g()]);\nconst d = new Date();\nconst q = `${h()}`;\n")).toEqual(['m', 'o', 's', 'd', 'q']);
    // What the page script's wrapper defines is the environment too.
    expect(impure('declare const __outside: { a: number };\nconst c = __outside;\nconst k = [...Object.keys(c)];\n')).toEqual(['c', 'k']);
    expect(
      impure(
        "import { a } from './a.js';\nconst A = 'x';\nconst B = /y/i;\nconst C = [1, -2, 'z', null];\nconst D = { a, b: A + 'q', c: () => window, m() { return document; } };\nconst E = new WeakMap<object, string>();\nconst F = `${A}${B.source}`;\nconst G = a.b ? A : undefined;\nlet H: number;\nfunction f() {}\nconst I = f;\ndeclare const J: string;\n",
      ),
    ).toEqual([]);
  });

  it('the bundle holds exactly the modules of the folder, is built once per process, and runs as a plain script', () => {
    const b = kitBundle();
    expect(kitBundle()).toBe(b);
    expect(b.startsWith('(() => {')).toBe(true);
    expect(b).not.toMatch(/\brequire\(|\bimport\(|^import |^export /m);
    // Not a strict-mode script: the kit runs as it always ran, a plain (sloppy) script.
    expect(b).not.toContain('use strict');
    const src = kitSource(kitConfigFor());
    expect(() => new Function(src)).not.toThrow();
    expect(src).toContain('const __retakeKitConfig = {"cursor":{"style":"arrow-dark","size":26,"ripple_color":"rgba(0,0,0,.25)"},"storage_key":"retake:cursor"};');
  });

  it('a module that imports from outside the folder is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'retake-kit-build-'));
    const outer = mkdtempSync(join(tmpdir(), 'retake-kit-outer-'));
    scratch.push(dir, outer);
    // The module it imports exists (in another folder): only the folder rule refuses it.
    writeFileSync(join(outer, 'path.ts'), 'export function join(): void {}\n');
    writeFileSync(join(dir, 'main.ts'), "import { helper } from './helper.js';\nhelper();\n");
    writeFileSync(join(dir, 'helper.ts'), `import { join } from '${join(outer, 'path.js').replaceAll('\\', '/')}';\nexport function helper(): void {\n  join();\n}\n`);
    expect(() => buildKitBundle(dir)).toThrow(/^the in-page kit was not built: it imports \S*path\.ts \(its modules import only each other and types\)$/);
    expect(() => buildKitBundle(dir)).toThrow(RunnerError);
    writeFileSync(join(dir, 'helper.ts'), 'export function helper(): void {}\n');
    expect(buildKitBundle(dir)).toContain('function helper()');
  });

  it('a build that fails is a set-up error of the runner: the in-page kit was not built, and why', () => {
    const dir = mkdtempSync(join(tmpdir(), 'retake-kit-build-'));
    scratch.push(dir);
    writeFileSync(join(dir, 'main.ts'), "import { helper } from './helper.js';\nhelper();\n");
    writeFileSync(join(dir, 'helper.ts'), 'export function helper(: void {}\n');
    const failed = (() => {
      try {
        buildKitBundle(dir);
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(failed).toBeInstanceOf(RunnerError);
    expect(failed?.message).toMatch(/^the in-page kit was not built: Build failed with 1 error:\n.*helper\.ts:1:\d+: ERROR: /);
    // A missing module too.
    writeFileSync(join(dir, 'main.ts'), "import { gone } from './gone.js';\ngone();\n");
    expect(() => buildKitBundle(dir)).toThrow(/^the in-page kit was not built: Build failed with 1 error:\n.*Could not resolve "\.\/gone\.js"/);
  });
});
