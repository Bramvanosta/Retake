/**
 * The kinds of a scenario edit are one list: the `kind`s of the engine's `ScenarioEdit` union (scenarios.ts, read with
 * the TypeScript checker over the sources) are exactly core's `SCENARIO_EDIT_KINDS` (scenario-edit.ts, the rules every
 * kind obeys), so a kind added on one side only fails here.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCENARIO_EDIT_KINDS } from '@retake/core';

const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
const SCENARIOS = fileURLToPath(new URL('../src/scenarios.ts', import.meta.url));

/** The string literal `kind`s of the members of the type alias `name` exported by `file`. */
function unionKinds(file: string, name: string): string[] {
  const program = ts.createProgram([file], {
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    // The workspace packages' `source` export: their TypeScript sources, no build needed.
    customConditions: ['source'],
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(file)!;
  const alias = sf.statements.find((s): s is import('typescript').TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === name);
  if (!alias) throw new Error(`${name} is not a type alias of ${file}`);
  const type = checker.getTypeAtLocation(alias.name);
  const members = type.isUnion() ? type.types : [type];
  return members.map((m) => {
    const kind = checker.getPropertyOfType(m, 'kind');
    const t = kind && checker.getTypeOfSymbolAtLocation(kind, alias);
    if (!t || !t.isStringLiteral()) throw new Error(`a member of ${name} has no string literal kind: ${checker.typeToString(m)}`);
    return t.value;
  });
}

describe('the kinds of a scenario edit', () => {
  it('the engine’s ScenarioEdit union has exactly the kinds of core’s SCENARIO_EDIT_KINDS, each once', () => {
    const kinds = unionKinds(SCENARIOS, 'ScenarioEdit');
    expect(kinds.length).toBe(new Set(kinds).size);
    expect([...kinds].sort()).toEqual([...SCENARIO_EDIT_KINDS].sort());
  });
});
