/**
 * The in-page kit is built from its modules (src/kit/page) into one page script: the modules import only each other
 * and types (no package, no Node module reaches the page), every module is part of the script, the graph has no
 * cycle, only the entry touches the page at load (every other module only declares), and a build that would take
 * anything from outside the folder is refused.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { KIT_PAGE_DIR, buildKitBundle, kitBundle, kitConfigFor, kitSource } from '../src/kit/source.js';

const MODULES = readdirSync(KIT_PAGE_DIR).filter((f) => f.endsWith('.ts')).sort();

interface ModuleInfo {
  /** Relative modules imported for their values (file names). */
  values: string[];
  /** Every import that is not a relative value import of the folder, nor `import type`. */
  foreign: string[];
  /** Top-level statements other than imports and declarations (the entry's only). */
  effects: string[];
}

function moduleInfo(file: string): ModuleInfo {
  const text = readFileSync(join(KIT_PAGE_DIR, file), 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const info: ModuleInfo = { values: [], foreign: [], effects: [] };
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
    if (ts.isFunctionDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isVariableStatement(s)) continue;
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
    writeFileSync(join(dir, 'helper.ts'), 'export function helper(): void {}\n');
    expect(buildKitBundle(dir)).toContain('function helper()');
  });
});
