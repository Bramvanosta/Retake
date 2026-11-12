/**
 * `@retake/runner-web/types` (L7.12), the capture's vocabulary as types only: every statement of the entry is an
 * `export type … from` a module of the package, so the built entry imports nothing and loads nothing (no Playwright, no
 * encoder, no kit) — what makes it a domain entry (scripts/audit/lib.mjs DOMAIN_ENTRIES: the engine's CaptureRunner port
 * and the shells may name it). Every name it exports, the package root exports too.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script without types
import * as rules from '../../../scripts/audit/lib.mjs';

const PKG = fileURLToPath(new URL('../', import.meta.url));
const ENTRY = join(PKG, 'src', 'types-entry.ts');
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');

const parse = (file: string, text = readFileSync(file, 'utf8')) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

/** The names a module's export declarations name (`export { a, type b } from`, `export type { c } from`). */
function exportedNames(file: string): { names: string[]; typeOnly: boolean[]; specs: string[] } {
  const out = { names: [] as string[], typeOnly: [] as boolean[], specs: [] as string[] };
  for (const st of parse(file).statements) {
    if (!ts.isExportDeclaration(st) || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
    for (const e of st.exportClause.elements) {
      out.names.push(e.name.text);
      out.typeOnly.push(st.isTypeOnly || e.isTypeOnly);
    }
    if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) out.specs.push(st.moduleSpecifier.text);
  }
  return out;
}

describe('the runner-web types entry', () => {
  it('is type-only re-exports of the package\'s own modules, and a domain entry', () => {
    const sf = parse(ENTRY);
    expect(sf.statements.length).toBeGreaterThan(0);
    for (const st of sf.statements) {
      expect(ts.isExportDeclaration(st), st.getText(sf)).toBe(true);
      const d = st as import('typescript').ExportDeclaration;
      expect(d.isTypeOnly, st.getText(sf)).toBe(true);
      expect(d.moduleSpecifier && ts.isStringLiteral(d.moduleSpecifier) && d.moduleSpecifier.text.startsWith('./'), st.getText(sf)).toBe(true);
    }
    expect(rules.DOMAIN_ENTRIES).toContain('@retake/runner-web/types');
    const exportsOf = (JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { exports: Record<string, { source: string }> }).exports;
    expect(exportsOf['./types']?.source).toBe('./src/types-entry.ts');
  });

  it('loads nothing: its module has no value, its built file imports nothing', async () => {
    const mod = (await import('@retake/runner-web/types')) as Record<string, unknown>;
    expect(Object.keys(mod)).toEqual([]);
    const built = join(PKG, 'dist', 'types-entry.js');
    expect(existsSync(built), 'pnpm build first').toBe(true);
    const sf = parse(built);
    const specs = rules.specifiersOf(ts, built, sf.text) as string[];
    expect(specs).toEqual([]);
    expect(sf.statements.filter((s) => !ts.isExportDeclaration(s) || s.exportClause === undefined || !ts.isNamedExports(s.exportClause) || s.exportClause.elements.length > 0).map((s) => s.getText(sf))).toEqual([]);
  });

  it('names only what the package root exports', () => {
    const entry = exportedNames(ENTRY);
    const root = exportedNames(join(PKG, 'src', 'index.ts'));
    expect(entry.names.length).toBeGreaterThan(10);
    expect(entry.typeOnly.every(Boolean)).toBe(true);
    expect(entry.names.filter((n) => !root.names.includes(n))).toEqual([]);
  });
});
